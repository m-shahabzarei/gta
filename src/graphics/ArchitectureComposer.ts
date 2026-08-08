/**
 * Planned-building and public-realm renderer.
 *
 * The tile grid remains authoritative for collision, but it never determines
 * visual building ownership here. Every structure comes from one
 * {@link PlannedBuilding}; every open-space treatment comes from one
 * {@link PlannedUrbanSpace} and is clipped to residual site cells. Building
 * anchors ensure a plan is emitted by one streamed chunk only, so translucent
 * shadows and roof edges cannot double at chunk seams.
 */
import Phaser from 'phaser';
import { TILE_SIZE } from '@/config/Constants';
import { DepthLayers } from '@/config/DepthLayers';
import { TileType } from '@/gameplay/types';
import type {
  BuildingInterior,
  CityId,
  MapData,
  PlannedBuilding,
  PlannedBuildingMaterial,
  PlannedEntrance,
  PlannedGroundFeature,
  PlannedRoofAsset,
  PlannedUrbanSpace,
} from '@/gameplay/types';

/** Scene objects produced for one streamed chunk. */
export interface ArchitectureChunkArt {
  /** Every object the owning chunk must cull and destroy. */
  readonly objects: Phaser.GameObjects.GameObject[];
  /** Individually hideable roof shells, keyed by real interior id. */
  readonly enterableRoofs: ReadonlyMap<string, Phaser.GameObjects.Graphics>;
}

interface PixelPalette {
  foundation: number;
  foundationEdge: number;
  roof: number;
  roofAlt: number;
  roofLight: number;
  roofDark: number;
  wallSouth: number;
  wallEast: number;
  wallDark: number;
  glass: number;
  glassLight: number;
  accent: number;
  green: number;
  paving: number;
}

interface TileCell {
  x: number;
  y: number;
}

interface HorizontalSpan {
  x0: number;
  x1: number;
  y: number;
}

interface VerticalSpan {
  x: number;
  y0: number;
  y1: number;
}

interface CellGeometry {
  tiles: readonly TileCell[];
  occupied: ReadonlySet<string>;
  north: readonly HorizontalSpan[];
  south: readonly HorizontalSpan[];
  west: readonly VerticalSpan[];
  east: readonly VerticalSpan[];
}

interface RoofTierGeometry extends CellGeometry {
  /** Additional projected height above the main roof plane. */
  lift: number;
  level: number;
}

interface BuildingGeometry extends CellGeometry {
  /** Original grammar rectangles retained as readable roof modules. */
  modules: readonly CellGeometry[];
  /** Deterministic inset masses that break broad roofs into stepped volumes. */
  tiers: readonly RoofTierGeometry[];
  offsetX: number;
  offsetY: number;
  lift: number;
}

interface CellRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface UrbanSpaceGeometry {
  cells: readonly TileCell[];
  occupied: ReadonlySet<string>;
  largestRect: CellRect | null;
}

const TEHRAN: PixelPalette = {
  foundation: 0x8b9292,
  foundationEdge: 0x515d61,
  roof: 0x5d7079,
  roofAlt: 0x82969d,
  roofLight: 0xc1d0d0,
  roofDark: 0x273740,
  wallSouth: 0x50636b,
  wallEast: 0x3c5059,
  wallDark: 0x223139,
  glass: 0x2d5669,
  glassLight: 0x83b7c0,
  accent: 0xd69b3d,
  green: 0x47704a,
  paving: 0x999b96,
};

const YAZD: PixelPalette = {
  foundation: 0xb08158,
  foundationEdge: 0x704a34,
  roof: 0xb97846,
  roofAlt: 0xd49b60,
  roofLight: 0xf0c58a,
  roofDark: 0x653b27,
  wallSouth: 0x925a39,
  wallEast: 0x74442f,
  wallDark: 0x4f3023,
  glass: 0x2e626b,
  glassLight: 0x76b3b4,
  accent: 0x2c8c87,
  green: 0x66804b,
  paving: 0xc49b69,
};

const GILAN: PixelPalette = {
  foundation: 0x7d8777,
  foundationEdge: 0x4a584c,
  roof: 0x8f523f,
  roofAlt: 0xb66a4d,
  roofLight: 0xd39770,
  roofDark: 0x49352e,
  wallSouth: 0x776850,
  wallEast: 0x5d5a49,
  wallDark: 0x393d34,
  glass: 0x315d68,
  glassLight: 0x8ab9b9,
  accent: 0x4e7c52,
  green: 0x315d39,
  paving: 0x89958a,
};

const COMMERCIAL_USES = new Set([
  'restaurant',
  'coffee-shop',
  'market',
  'bank',
  'gym',
  'clinic',
  'bookstore',
  'pharmacy',
  'electronics',
  'supermarket',
  'office',
  'parking',
]);

/** Tile classes on which planned public-realm artwork may safely replace terrain. */
const PUBLIC_REALM_TILES: ReadonlySet<number> = new Set([
  TileType.Grass,
  TileType.Sand,
  TileType.Dirt,
  TileType.Concrete,
  TileType.UrbanFixture,
]);

/** One planned building is painted once, at the chunk containing its anchor. */
export class ArchitectureComposer {
  private readonly buildingOwners = new Map<string, PlannedBuilding[]>();
  private readonly geometryCache = new Map<string, BuildingGeometry>();
  private readonly spaceGeometryCache = new Map<string, UrbanSpaceGeometry>();
  private readonly footprintOwner = new Map<string, string>();
  private readonly interiorIdsByBuilding = new Map<string, string[]>();

  constructor(
    private readonly map: MapData,
    _period: number,
    _roadWidth: number,
    _sidewalkWidth: number,
    _highwayClearZoneAt?: (tx: number, ty: number) => boolean,
  ) {
    this.indexPlans();
    this.indexEnterableRoofs(map.buildingInteriors);
  }

  /**
   * Paint plans anchored inside this chunk. Geometry may extend outside the
   * chunk rectangle; the surrounding active-chunk ring keeps it resident while
   * visible and anchor ownership prevents duplicate alpha seams.
   */
  public paintChunk(
    scene: Phaser.Scene,
    tx0: number,
    ty0: number,
    width: number,
    height: number,
  ): ArchitectureChunkArt {
    const buildings = this.ownedPlans(this.buildingOwners, tx0, ty0, width, height);
    const spaces = this.intersectingSpaces(tx0, ty0, width, height);
    const objects: Phaser.GameObjects.GameObject[] = [];
    const enterableRoofs = new Map<string, Phaser.GameObjects.Graphics>();

    let foundations: Phaser.GameObjects.Graphics | null = null;
    let shadows: Phaser.GameObjects.Graphics | null = null;
    let walls: Phaser.GameObjects.Graphics | null = null;
    let sharedRoofs: Phaser.GameObjects.Graphics | null = null;

    if (buildings.length > 0) {
      foundations = scene.add.graphics().setDepth(DepthLayers.GroundDetail + 2);
      shadows = scene.add.graphics().setDepth(DepthLayers.Shadows);
      walls = scene.add.graphics().setDepth(DepthLayers.BuildingsLow);
      sharedRoofs = scene.add.graphics().setDepth(DepthLayers.BuildingsHigh);
      objects.push(foundations, shadows, walls, sharedRoofs);

      for (const building of buildings) {
        const geometry = this.geometry(building);
        const palette = this.palette(building.cityId, building.material, building.signature);
        this.paintFoundation(foundations, building, geometry, palette);
        this.paintShadow(shadows, geometry);
        this.paintWalls(walls, building, geometry, palette);

        const interiorIds = this.interiorIdsByBuilding.get(building.id) ?? [];
        if (interiorIds.length === 0) {
          this.paintRoof(sharedRoofs, building, geometry, palette);
          continue;
        }

        const roof = scene.add.graphics().setDepth(DepthLayers.BuildingsHigh);
        this.paintRoof(roof, building, geometry, palette);
        objects.push(roof);
        for (const interiorId of interiorIds) enterableRoofs.set(interiorId, roof);
      }
    }

    if (spaces.length > 0) {
      const surfaces = scene.add.graphics().setDepth(DepthLayers.GroundDetail);
      const fixtures = scene.add.graphics().setDepth(DepthLayers.GroundDetail + 6);
      const tallFixtures = scene.add.graphics().setDepth(DepthLayers.Foliage);
      objects.push(surfaces, fixtures, tallFixtures);
      const clip = { x: tx0, y: ty0, width, height };
      for (const space of spaces) {
        const palette = this.cityPalette(space.cityId);
        this.paintUrbanSpace(surfaces, fixtures, tallFixtures, space, palette, clip);
      }
    }

    return { objects, enterableRoofs };
  }

  private indexPlans(): void {
    for (const building of this.map.urbanPlan.buildings) {
      const anchor = this.buildingAnchor(building);
      this.pushOwned(this.buildingOwners, anchor.x, anchor.y, building);
      for (const part of building.footprint) {
        const x0 = Math.floor(part.x);
        const y0 = Math.floor(part.y);
        const x1 = Math.ceil(part.x + part.width);
        const y1 = Math.ceil(part.y + part.height);
        for (let ty = y0; ty < y1; ty++) {
          for (let tx = x0; tx < x1; tx++) this.footprintOwner.set(this.key(tx, ty), building.id);
        }
      }
    }
  }

  private indexEnterableRoofs(interiors: readonly BuildingInterior[]): void {
    for (const interior of interiors) {
      const ids = this.interiorIdsByBuilding.get(interior.buildingId) ?? [];
      ids.push(interior.id);
      this.interiorIdsByBuilding.set(interior.buildingId, ids);
    }
  }

  private pushOwned<T>(index: Map<string, T[]>, tx: number, ty: number, value: T): void {
    const key = this.key(tx, ty);
    const list = index.get(key) ?? [];
    list.push(value);
    index.set(key, list);
  }

  private ownedPlans<T>(
    index: ReadonlyMap<string, readonly T[]>,
    tx0: number,
    ty0: number,
    width: number,
    height: number,
  ): T[] {
    const result: T[] = [];
    for (let ty = ty0; ty < ty0 + height; ty++) {
      for (let tx = tx0; tx < tx0 + width; tx++) {
        result.push(...(index.get(this.key(tx, ty)) ?? []));
      }
    }
    return result;
  }

  private intersectingSpaces(
    tx0: number,
    ty0: number,
    width: number,
    height: number,
  ): PlannedUrbanSpace[] {
    const tx1 = tx0 + width;
    const ty1 = ty0 + height;
    return this.map.urbanPlan.spaces.filter(
      (space) =>
        space.bounds.x < tx1 &&
        space.bounds.y < ty1 &&
        space.bounds.x + space.bounds.width > tx0 &&
        space.bounds.y + space.bounds.height > ty0,
    );
  }

  private buildingAnchor(building: PlannedBuilding): TileCell {
    const firstPart = building.footprint[0];
    if (!firstPart) throw new Error(`planned building ${building.id} has no footprint`);
    const centerX = building.bounds.x + building.bounds.width * 0.5;
    const centerY = building.bounds.y + building.bounds.height * 0.5;
    let anchor: TileCell = { x: Math.floor(firstPart.x), y: Math.floor(firstPart.y) };
    let score = Infinity;
    for (const part of building.footprint) {
      const x0 = Math.floor(part.x);
      const y0 = Math.floor(part.y);
      const x1 = Math.ceil(part.x + part.width);
      const y1 = Math.ceil(part.y + part.height);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const candidateScore = (x + 0.5 - centerX) ** 2 + (y + 0.5 - centerY) ** 2;
          if (
            candidateScore < score ||
            (candidateScore === score && (y < anchor.y || (y === anchor.y && x < anchor.x)))
          ) {
            anchor = { x, y };
            score = candidateScore;
          }
        }
      }
    }
    return anchor;
  }

  private geometry(building: PlannedBuilding): BuildingGeometry {
    const cached = this.geometryCache.get(building.id);
    if (cached) return cached;

    const moduleOwnership = new Set<string>();
    const modules = building.footprint.map((part) => {
      const cells: TileCell[] = [];
      for (let ty = Math.floor(part.y); ty < Math.ceil(part.y + part.height); ty++) {
        for (let tx = Math.floor(part.x); tx < Math.ceil(part.x + part.width); tx++) {
          const key = this.key(tx, ty);
          if (moduleOwnership.has(key)) continue;
          moduleOwnership.add(key);
          cells.push({ x: tx, y: ty });
        }
      }
      return this.cellGeometry(cells);
    });
    const mass = this.cellGeometry(modules.flatMap((module) => module.tiles));
    if (mass.tiles.length === 0) {
      throw new Error(`planned building ${building.id} has no occupied cells`);
    }

    const lift = this.visualLift(building);
    const result: BuildingGeometry = {
      ...mass,
      modules,
      tiers: this.roofTiers(building, mass),
      offsetX: -Math.max(3, Math.floor(lift * 0.28)),
      offsetY: -lift,
      lift,
    };
    this.geometryCache.set(building.id, result);
    return result;
  }

  private cellGeometry(cells: readonly TileCell[]): CellGeometry {
    const occupied = new Set<string>();
    const tiles: TileCell[] = [];
    for (const cell of cells) {
      const key = this.key(cell.x, cell.y);
      if (occupied.has(key)) continue;
      occupied.add(key);
      tiles.push({ x: cell.x, y: cell.y });
    }
    tiles.sort((a, b) => a.y - b.y || a.x - b.x);
    return {
      tiles,
      occupied,
      north: this.horizontalEdges(tiles, occupied, 'north'),
      south: this.horizontalEdges(tiles, occupied, 'south'),
      west: this.verticalEdges(tiles, occupied, 'west'),
      east: this.verticalEdges(tiles, occupied, 'east'),
    };
  }

  private roofTiers(building: PlannedBuilding, mass: CellGeometry): RoofTierGeometry[] {
    const forced = building.kind === 'tower' || building.shape === 'podium-tower';
    if (!forced && building.size !== 'large' && building.size !== 'huge') return [];

    // Stadium stands need one low, legible seating rake rather than the generic
    // concentric roof erosion used by large civic buildings.
    if (building.kind === 'stadium') return [];

    const industrial =
      building.kind === 'factory' ||
      building.kind === 'warehouse' ||
      building.kind === 'sports-hall';
    const gilanPitched =
      building.cityId === 'gilan' &&
      (building.roofStyle === 'sloped' || building.material === 'wood');
    if (gilanPitched) return [];

    // A podium-tower is still one collision footprint, but it is rendered as
    // a low podium, a narrower occupied core and a compact crown. These lifts
    // are relative to the main roof plane, so the tallest Tehran buildings
    // remain clearly distinct without changing any world-space ownership.
    const lifts = forced
      ? building.cityId === 'yazd'
        ? [10, 22, 32]
        : building.cityId === 'gilan'
          ? [11, 24, 34]
          : [14, 30, 44]
      : building.cityId === 'yazd'
        ? building.size === 'huge'
          ? [5, 10]
          : [5]
        : building.cityId === 'gilan'
          ? building.size === 'huge'
            ? [6, 12]
            : [6]
          : industrial
            ? building.size === 'huge'
              ? [5, 10]
              : [5]
            : building.size === 'huge'
              ? [8, 17]
              : [8];

    const tiers: RoofTierGeometry[] = [];
    for (let level = 1; level <= lifts.length; level++) {
      const inset = this.insetGeometry(mass, level);
      const lift = lifts[level - 1];
      if (!lift || inset.tiles.length < 4 || inset.tiles.length >= mass.tiles.length) continue;
      tiers.push({ ...inset, lift, level });
    }
    return tiers;
  }

  private insetGeometry(source: CellGeometry, depth: number): CellGeometry {
    let occupied = new Set(source.occupied);
    let tiles = [...source.tiles];
    for (let step = 0; step < depth; step++) {
      tiles = tiles.filter(
        (cell) =>
          occupied.has(this.key(cell.x - 1, cell.y)) &&
          occupied.has(this.key(cell.x + 1, cell.y)) &&
          occupied.has(this.key(cell.x, cell.y - 1)) &&
          occupied.has(this.key(cell.x, cell.y + 1)),
      );
      occupied = new Set(tiles.map((cell) => this.key(cell.x, cell.y)));
      if (tiles.length === 0) break;
    }
    return this.cellGeometry(tiles);
  }

  private horizontalEdges(
    tiles: readonly TileCell[],
    occupied: ReadonlySet<string>,
    side: 'north' | 'south',
  ): HorizontalSpan[] {
    const rows = new Map<number, number[]>();
    for (const tile of tiles) {
      const neighbourY = tile.y + (side === 'north' ? -1 : 1);
      if (occupied.has(this.key(tile.x, neighbourY))) continue;
      const edgeY = tile.y + (side === 'south' ? 1 : 0);
      const xs = rows.get(edgeY) ?? [];
      xs.push(tile.x);
      rows.set(edgeY, xs);
    }
    const spans: HorizontalSpan[] = [];
    for (const [y, xs] of rows) {
      xs.sort((a, b) => a - b);
      let start = xs[0];
      let previous = xs[0];
      if (start === undefined || previous === undefined) continue;
      for (let index = 1; index <= xs.length; index++) {
        const value = xs[index];
        if (value === previous + 1) {
          previous = value;
          continue;
        }
        spans.push({ x0: start, x1: previous + 1, y });
        if (value !== undefined) {
          start = value;
          previous = value;
        }
      }
    }
    return spans;
  }

  private verticalEdges(
    tiles: readonly TileCell[],
    occupied: ReadonlySet<string>,
    side: 'west' | 'east',
  ): VerticalSpan[] {
    const columns = new Map<number, number[]>();
    for (const tile of tiles) {
      const neighbourX = tile.x + (side === 'west' ? -1 : 1);
      if (occupied.has(this.key(neighbourX, tile.y))) continue;
      const edgeX = tile.x + (side === 'east' ? 1 : 0);
      const ys = columns.get(edgeX) ?? [];
      ys.push(tile.y);
      columns.set(edgeX, ys);
    }
    const spans: VerticalSpan[] = [];
    for (const [x, ys] of columns) {
      ys.sort((a, b) => a - b);
      let start = ys[0];
      let previous = ys[0];
      if (start === undefined || previous === undefined) continue;
      for (let index = 1; index <= ys.length; index++) {
        const value = ys[index];
        if (value === previous + 1) {
          previous = value;
          continue;
        }
        spans.push({ x, y0: start, y1: previous + 1 });
        if (value !== undefined) {
          start = value;
          previous = value;
        }
      }
    }
    return spans;
  }

  /** Contiguous occupied runs used to paint one coherent roof plane per row. */
  private tileRows(tiles: readonly TileCell[]): HorizontalSpan[] {
    const rows = new Map<number, number[]>();
    for (const tile of tiles) {
      const xs = rows.get(tile.y) ?? [];
      xs.push(tile.x);
      rows.set(tile.y, xs);
    }
    const spans: HorizontalSpan[] = [];
    for (const [y, xs] of rows) {
      xs.sort((first, second) => first - second);
      let start = xs[0];
      let previous = xs[0];
      if (start === undefined || previous === undefined) continue;
      for (let index = 1; index <= xs.length; index++) {
        const value = xs[index];
        if (value === previous + 1) {
          previous = value;
          continue;
        }
        spans.push({ x0: start, x1: previous + 1, y });
        if (value !== undefined) {
          start = value;
          previous = value;
        }
      }
    }
    return spans;
  }

  private visualLift(building: PlannedBuilding): number {
    const sizeBase: Record<PlannedBuilding['size'], number> = {
      small: 7,
      medium: 13,
      large: 20,
      huge: 27,
    };
    if (building.kind === 'tower' || building.shape === 'podium-tower') {
      // The remaining apparent tower height comes from the explicit occupied
      // core/crown tiers above this deliberately low podium.
      return Phaser.Math.Clamp(
        15 + Math.round(Math.log2(Math.max(2, building.floors)) * 1.5),
        17,
        22,
      );
    }

    const floorBonus = Math.min(12, Math.max(0, building.floors - 1) * 2);
    let lift = sizeBase[building.size] + floorBonus;
    const kind = building.kind;
    if (building.cityId === 'tehran' && (building.size === 'large' || building.size === 'huge')) {
      lift += 2;
    }
    if (kind === 'factory' || kind === 'warehouse' || kind === 'sports-hall') {
      lift = Math.min(lift, building.size === 'huge' ? 19 : 16);
    }
    if (building.cityId === 'yazd' && kind !== 'terminal') {
      lift = Math.min(lift, 22);
    }
    if (building.cityId === 'gilan' && kind !== 'hotel') {
      lift = Math.min(lift, 24);
    }
    return Phaser.Math.Clamp(Math.round(lift), 8, 40);
  }

  private paintFoundation(
    g: Phaser.GameObjects.Graphics,
    building: PlannedBuilding,
    geometry: BuildingGeometry,
    palette: PixelPalette,
  ): void {
    g.fillStyle(palette.foundation, 1);
    for (const tile of geometry.tiles) {
      g.fillRect(tile.x * TILE_SIZE, tile.y * TILE_SIZE, TILE_SIZE, TILE_SIZE);
    }
    g.fillStyle(palette.foundationEdge, 1);
    for (const span of geometry.north) {
      g.fillRect(span.x0 * TILE_SIZE, span.y * TILE_SIZE, (span.x1 - span.x0) * TILE_SIZE, 2);
    }
    for (const span of geometry.west) {
      g.fillRect(span.x * TILE_SIZE, span.y0 * TILE_SIZE, 2, (span.y1 - span.y0) * TILE_SIZE);
    }
    g.fillStyle(this.shade(palette.foundationEdge, 0.22), 1);
    for (const span of geometry.south) {
      g.fillRect(span.x0 * TILE_SIZE, span.y * TILE_SIZE - 2, (span.x1 - span.x0) * TILE_SIZE, 2);
    }
    for (const span of geometry.east) {
      g.fillRect(span.x * TILE_SIZE - 2, span.y0 * TILE_SIZE, 2, (span.y1 - span.y0) * TILE_SIZE);
    }
    for (const entrance of building.entrances) this.paintEntranceApproach(g, entrance, palette);
  }

  private paintEntranceApproach(
    g: Phaser.GameObjects.Graphics,
    entrance: PlannedEntrance,
    palette: PixelPalette,
  ): void {
    const points = [entrance.apron, ...entrance.accessPath];
    g.fillStyle(this.mix(palette.paving, palette.roofLight, 0.18), 1);
    for (let index = 0; index < points.length; index++) {
      const point = points[index];
      if (!point) continue;
      const cx = point.x * TILE_SIZE + TILE_SIZE / 2;
      const cy = point.y * TILE_SIZE + TILE_SIZE / 2;
      g.fillRect(cx - 4, cy - 4, 8, 8);
      const next = points[index + 1];
      if (!next) continue;
      const nx = next.x * TILE_SIZE + TILE_SIZE / 2;
      const ny = next.y * TILE_SIZE + TILE_SIZE / 2;
      g.fillRect(
        Math.min(cx, nx) - 3,
        Math.min(cy, ny) - 3,
        Math.abs(nx - cx) + 6,
        Math.abs(ny - cy) + 6,
      );
    }
  }

  private paintShadow(g: Phaser.GameObjects.Graphics, geometry: BuildingGeometry): void {
    const topLift = geometry.tiers[geometry.tiers.length - 1]?.lift ?? 0;
    const scale = Math.max(1, Math.min(5, Math.floor((geometry.lift + topLift) / 10)));
    for (const [distance, alpha] of [
      [scale * 6, 0.06],
      [scale * 4, 0.1],
      [scale * 2, 0.16],
    ] as const) {
      g.fillStyle(0x10151a, alpha);
      for (const tile of geometry.tiles) {
        g.fillRect(
          tile.x * TILE_SIZE + distance,
          tile.y * TILE_SIZE + distance,
          TILE_SIZE,
          TILE_SIZE,
        );
      }
    }
    g.fillStyle(0x11171b, 0.22);
    for (const span of geometry.south) {
      g.fillRect(span.x0 * TILE_SIZE + 3, span.y * TILE_SIZE, (span.x1 - span.x0) * TILE_SIZE, 4);
    }
    for (const span of geometry.east) {
      g.fillRect(span.x * TILE_SIZE, span.y0 * TILE_SIZE + 3, 4, (span.y1 - span.y0) * TILE_SIZE);
    }
  }

  private paintWalls(
    g: Phaser.GameObjects.Graphics,
    building: PlannedBuilding,
    geometry: BuildingGeometry,
    palette: PixelPalette,
  ): void {
    for (const span of geometry.south) {
      const x0 = span.x0 * TILE_SIZE;
      const x1 = span.x1 * TILE_SIZE;
      const y = span.y * TILE_SIZE;
      g.fillStyle(palette.wallSouth, 1);
      g.fillPoints(
        [
          { x: x0 + geometry.offsetX, y: y + geometry.offsetY },
          { x: x1 + geometry.offsetX, y: y + geometry.offsetY },
          { x: x1, y },
          { x: x0, y },
        ],
        true,
      );
      g.fillStyle(this.mix(palette.wallSouth, palette.roofLight, 0.2), 1);
      g.fillRect(x0 + geometry.offsetX, y + geometry.offsetY, x1 - x0, 3);
      g.lineStyle(2, palette.wallDark, 0.84);
      g.lineBetween(x0 + geometry.offsetX, y + geometry.offsetY, x0, y);
      g.lineBetween(x1 + geometry.offsetX - 1, y + geometry.offsetY, x1 - 1, y);
      g.fillStyle(palette.wallDark, 1);
      g.fillRect(x0, y - 3, x1 - x0, 3);
      this.paintSouthFacade(g, building, geometry, palette, span);
    }

    for (const span of geometry.east) {
      const x = span.x * TILE_SIZE;
      const y0 = span.y0 * TILE_SIZE;
      const y1 = span.y1 * TILE_SIZE;
      g.fillStyle(palette.wallEast, 1);
      g.fillPoints(
        [
          { x: x + geometry.offsetX, y: y0 + geometry.offsetY },
          { x: x + geometry.offsetX, y: y1 + geometry.offsetY },
          { x, y: y1 },
          { x, y: y0 },
        ],
        true,
      );
      g.fillStyle(this.mix(palette.wallEast, palette.roofLight, 0.15), 1);
      g.fillRect(x + geometry.offsetX, y0 + geometry.offsetY, 3, y1 - y0);
      g.lineStyle(2, palette.wallDark, 0.84);
      g.lineBetween(x + geometry.offsetX, y0 + geometry.offsetY, x, y0);
      g.lineBetween(x + geometry.offsetX, y1 + geometry.offsetY - 1, x, y1 - 1);
      g.fillStyle(palette.wallDark, 1);
      g.fillRect(x - 3, y0, 3, y1 - y0);
      this.paintEastFacade(g, building, geometry, palette, span);
    }

    for (const entrance of building.entrances) {
      this.paintEntrance(g, entrance, palette);
    }
  }

  private paintSouthFacade(
    g: Phaser.GameObjects.Graphics,
    building: PlannedBuilding,
    geometry: BuildingGeometry,
    palette: PixelPalette,
    span: HorizontalSpan,
  ): void {
    const x0 = span.x0 * TILE_SIZE;
    const x1 = span.x1 * TILE_SIZE;
    const groundY = span.y * TILE_SIZE;
    const rows = geometry.lift >= 22 ? 3 : geometry.lift >= 13 ? 2 : 1;
    const step = building.kind === 'tower' || building.material === 'glass' ? 10 : 14;
    for (let row = 0; row < rows; row++) {
      const t = (row + 1) / (rows + 1);
      const y = Math.round(groundY + geometry.offsetY * (1 - t)) - 2;
      const xShift = Math.round(geometry.offsetX * (1 - t));
      for (let x = x0 + xShift + 6; x + 5 < x1 + xShift - 4; x += step) {
        g.fillStyle(palette.glass, 1);
        g.fillRect(x, y, step <= 10 ? 6 : 7, 4);
        g.fillStyle(palette.glassLight, 0.82);
        g.fillRect(x + 1, y, step <= 10 ? 4 : 5, 1);
      }
    }
    if (COMMERCIAL_USES.has(building.groundFloorUse)) {
      const bandY = groundY - Math.max(5, Math.floor(geometry.lift * 0.28));
      g.fillStyle(palette.glass, 0.95);
      g.fillRect(x0 + 4, bandY, Math.max(4, x1 - x0 - 8), 4);
      g.fillStyle(palette.accent, 1);
      g.fillRect(x0 + 4, bandY - 2, Math.max(4, x1 - x0 - 8), 2);
    }
    this.paintSouthFacadeCharacter(g, building, geometry, palette, span);
  }

  private paintEastFacade(
    g: Phaser.GameObjects.Graphics,
    building: PlannedBuilding,
    geometry: BuildingGeometry,
    palette: PixelPalette,
    span: VerticalSpan,
  ): void {
    if (building.floors < 2) {
      this.paintEastFacadeCharacter(g, building, geometry, palette, span);
      return;
    }
    const edgeX = span.x * TILE_SIZE;
    const y0 = span.y0 * TILE_SIZE;
    const y1 = span.y1 * TILE_SIZE;
    const x = edgeX + Math.round(geometry.offsetX * 0.48) - 2;
    for (let y = y0 + geometry.offsetY + 7; y + 5 < y1 - 4; y += 11) {
      g.fillStyle(palette.glass, 1);
      g.fillRect(x, y, 4, 6);
      g.fillStyle(palette.glassLight, 0.74);
      g.fillRect(x, y, 1, 4);
    }
    this.paintEastFacadeCharacter(g, building, geometry, palette, span);
  }

  private paintSouthFacadeCharacter(
    g: Phaser.GameObjects.Graphics,
    building: PlannedBuilding,
    geometry: BuildingGeometry,
    palette: PixelPalette,
    span: HorizontalSpan,
  ): void {
    const x0 = span.x0 * TILE_SIZE;
    const x1 = span.x1 * TILE_SIZE;
    const width = x1 - x0;
    const groundY = span.y * TILE_SIZE;
    if (width < 18) return;

    if (building.cityId === 'tehran') {
      const ribbon =
        building.material === 'glass' ||
        building.facadeStyle.includes('windows-ribbon') ||
        building.facadeStyle.includes('light-bands');
      if (ribbon && geometry.lift >= 14) {
        const bands = geometry.lift >= 25 ? 3 : 2;
        for (let row = 1; row <= bands; row++) {
          const t = row / (bands + 1);
          const y = Math.round(groundY + geometry.offsetY * (1 - t));
          const shift = Math.round(geometry.offsetX * (1 - t));
          g.fillStyle(palette.glass, 0.92);
          g.fillRect(x0 + shift + 5, y - 2, Math.max(5, width - 10), 4);
          g.fillStyle(palette.glassLight, 0.78);
          g.fillRect(x0 + shift + 6, y - 2, Math.max(3, width - 13), 1);
        }
      }

      const balcony =
        building.kind === 'apartment' ||
        building.kind === 'hotel' ||
        building.facadeStyle.includes('balcony-projecting') ||
        building.facadeStyle.includes('balcony-wraparound');
      if (balcony && geometry.lift >= 13) {
        const count = geometry.lift >= 25 ? 2 : 1;
        for (let index = 1; index <= count; index++) {
          const t = index / (count + 1);
          const y = Math.round(groundY + geometry.offsetY * (1 - t)) + 2;
          const shift = Math.round(geometry.offsetX * (1 - t));
          g.fillStyle(palette.wallDark, 0.92);
          g.fillRect(x0 + shift + 3, y, Math.max(8, width - 6), 3);
          g.fillStyle(palette.roofLight, 0.78);
          for (let x = x0 + shift + 6; x < x1 + shift - 4; x += 10) {
            g.fillRect(x, y - 4, 2, 4);
          }
        }
      }
      if (COMMERCIAL_USES.has(building.groundFloorUse) && width >= 28) {
        const awningY = groundY - 10;
        for (let x = x0 + 5; x < x1 - 8; x += 14) {
          g.fillStyle(((x - x0) / 14) % 2 < 1 ? palette.accent : palette.roofLight, 0.94);
          g.fillRect(x, awningY, Math.min(11, x1 - x - 4), 4);
        }
      }
    } else if (building.cityId === 'yazd') {
      const nicheY = groundY - Math.max(8, Math.floor(geometry.lift * 0.38));
      const step = building.facadeStyle.includes('windows-arched') ? 13 : 18;
      for (let x = x0 + 7; x + 7 < x1 - 4; x += step) {
        g.fillStyle(palette.wallDark, 0.92);
        g.fillRect(x, nicheY, 7, 7);
        g.fillCircle(x + 3, nicheY, 3);
        g.fillStyle(palette.roofLight, 0.5);
        g.fillRect(x + 1, nicheY + 2, 1, 4);
      }
      if (
        building.facadeStyle.includes('entrance-arcade') ||
        building.kind === 'government' ||
        building.kind === 'mosque'
      ) {
        g.fillStyle(palette.roofLight, 0.72);
        for (let x = x0 + 8; x < x1 - 5; x += 16) g.fillRect(x, groundY - 13, 3, 13);
      }
    } else {
      const veranda =
        building.kind === 'house' ||
        building.kind === 'villa' ||
        building.kind === 'hotel' ||
        building.facadeStyle.includes('balcony-wraparound') ||
        building.facadeStyle.includes('balcony-projecting');
      if (veranda) {
        const deckY = groundY - 8;
        g.fillStyle(0x554536, 1);
        g.fillRect(x0 + 2, deckY, width - 4, 7);
        g.fillStyle(palette.roofLight, 0.72);
        g.fillRect(x0 + 3, deckY, width - 6, 2);
        g.fillStyle(palette.wallDark, 0.92);
        for (let x = x0 + 6; x < x1 - 4; x += 13) g.fillRect(x, deckY - 6, 2, 6);
      }
    }

    const serviceBays =
      building.kind === 'fire-station' ||
      building.kind === 'parking-structure' ||
      building.kind === 'warehouse' ||
      building.kind === 'factory' ||
      building.kind === 'gas-station';
    if (!serviceBays || width < 30) return;
    const bayColor = building.kind === 'fire-station' ? 0x8f3935 : palette.wallDark;
    for (let x = x0 + 5; x + 14 < x1 - 3; x += 20) {
      g.fillStyle(bayColor, 1);
      g.fillRect(x, groundY - 10, 15, 10);
      g.fillStyle(palette.roofLight, 0.5);
      g.fillRect(x + 2, groundY - 8, 11, 2);
      g.fillRect(x + 2, groundY - 4, 11, 1);
    }
  }

  private paintEastFacadeCharacter(
    g: Phaser.GameObjects.Graphics,
    building: PlannedBuilding,
    geometry: BuildingGeometry,
    palette: PixelPalette,
    span: VerticalSpan,
  ): void {
    const edgeX = span.x * TILE_SIZE;
    const y0 = span.y0 * TILE_SIZE;
    const y1 = span.y1 * TILE_SIZE;
    const height = y1 - y0;
    if (height < 22) return;

    if (
      building.cityId === 'gilan' &&
      (building.kind === 'house' ||
        building.kind === 'villa' ||
        building.facadeStyle.includes('balcony-wraparound'))
    ) {
      const deckX = edgeX - 8;
      g.fillStyle(0x4f4435, 1);
      g.fillRect(deckX, y0 + 2, 7, height - 4);
      g.fillStyle(palette.roofLight, 0.68);
      g.fillRect(deckX, y0 + 3, 2, height - 6);
      g.fillStyle(palette.wallDark, 0.9);
      for (let y = y0 + 7; y < y1 - 3; y += 13) g.fillRect(deckX - 5, y, 5, 2);
    } else if (building.cityId === 'tehran' && building.material === 'glass') {
      const ribbonX = edgeX + Math.round(geometry.offsetX * 0.5) - 3;
      g.fillStyle(palette.glass, 0.9);
      g.fillRect(ribbonX, y0 + geometry.offsetY + 5, 5, Math.max(8, height - 10));
      g.fillStyle(palette.glassLight, 0.72);
      g.fillRect(ribbonX, y0 + geometry.offsetY + 6, 1, Math.max(5, height - 13));
    } else if (building.cityId === 'yazd' && building.facadeStyle.includes('stone-trim')) {
      const trimX = edgeX + Math.round(geometry.offsetX * 0.55) - 2;
      g.fillStyle(palette.roofLight, 0.55);
      for (let y = y0 + geometry.offsetY + 6; y < y1 - 5; y += 14) {
        g.fillRect(trimX, y, 3, 7);
      }
    }
  }

  private paintEntrance(
    g: Phaser.GameObjects.Graphics,
    entrance: PlannedEntrance,
    palette: PixelPalette,
  ): void {
    const cx = entrance.position.x * TILE_SIZE + TILE_SIZE / 2;
    const cy = entrance.position.y * TILE_SIZE + TILE_SIZE / 2;
    const wide =
      entrance.kind === 'vehicle' || entrance.kind === 'emergency' ? 14 : entrance.primary ? 10 : 7;
    const halfWide = Math.floor(wide / 2);
    g.fillStyle(palette.wallDark, 1);
    if (entrance.facing === 'south') {
      const left = cx - halfWide;
      g.fillRect(left, (entrance.position.y + 1) * TILE_SIZE - 8, wide, 8);
      g.fillStyle(palette.roofLight, 1);
      g.fillRect(left - 2, (entrance.position.y + 1) * TILE_SIZE - 10, wide + 4, 2);
    } else if (entrance.facing === 'east') {
      const top = cy - halfWide;
      g.fillRect((entrance.position.x + 1) * TILE_SIZE - 8, top, 8, wide);
      g.fillStyle(palette.roofLight, 1);
      g.fillRect((entrance.position.x + 1) * TILE_SIZE - 10, top - 2, 2, wide + 4);
    }
  }

  private paintRoof(
    g: Phaser.GameObjects.Graphics,
    building: PlannedBuilding,
    geometry: BuildingGeometry,
    palette: PixelPalette,
  ): void {
    this.paintRoofMaterial(g, building, geometry, geometry, palette, 0, 0);
    this.paintModuleSeams(g, geometry, palette);
    this.paintRoofEdges(g, building, geometry, geometry, palette, 0);
    if (building.roofStyle === 'sloped' || building.material === 'wood') {
      this.paintCoherentRidges(g, geometry, palette);
      if (building.cityId === 'gilan') this.paintGilanGables(g, geometry, palette);
    }

    let lowerLift = 0;
    for (const tier of geometry.tiers) {
      this.paintRaisedRoofTier(g, building, geometry, tier, lowerLift, palette);
      lowerLift = tier.lift;
    }

    for (const asset of building.roofAssets) {
      this.paintRoofAsset(g, asset, building, geometry, palette);
    }
    // Building-scale architectural cues take visual priority over incidental
    // equipment when deterministic roof-asset placement happens to coincide.
    this.paintProgramIdentity(g, building, geometry, palette);
    this.paintHighPlaneEntrances(g, building, geometry, palette);
  }

  private paintRoofMaterial(
    g: Phaser.GameObjects.Graphics,
    building: PlannedBuilding,
    surface: CellGeometry,
    geometry: BuildingGeometry,
    palette: PixelPalette,
    extraLift: number,
    level: number,
  ): void {
    const offset = this.roofOffset(geometry, extraLift);
    const sectionSpan =
      building.cityId === 'yazd'
        ? 5
        : building.material === 'steel' || building.kind === 'factory'
          ? 6
          : building.cityId === 'gilan'
            ? 4
            : 5;
    const seed = this.hashString(building.signature) ^ Math.imul(level + 1, 0x45d9f3b);
    const materialBase =
      building.material === 'glass'
        ? palette.glass
        : building.material === 'steel'
          ? this.mix(palette.roof, 0x6d797e, 0.48)
          : building.material === 'adobe'
            ? this.mix(palette.roof, 0xc9824b, 0.42)
            : building.material === 'wood'
              ? this.mix(palette.roof, 0x94513d, 0.48)
              : palette.roof;
    const tierBase = this.mix(materialBase, palette.roofLight, Math.min(0.18, level * 0.07));

    // Fill contiguous runs first. Broad roofs now read as one authored plane,
    // rather than as a grid of terrain-sized 32 px squares.
    for (const span of this.tileRows(surface.tiles)) {
      const sectionY = Math.floor((span.y - building.bounds.y) / sectionSpan);
      const sectionHash = this.hashInt(
        Math.floor((span.x0 - building.bounds.x) / sectionSpan),
        sectionY,
        seed,
      );
      const sectionTone = this.mod(sectionHash, 4);
      const color =
        sectionTone === 0
          ? this.mix(tierBase, palette.roofAlt, 0.08)
          : sectionTone === 1
            ? this.shade(tierBase, 0.035)
            : sectionTone === 2
              ? this.mix(tierBase, palette.roofLight, 0.04)
              : tierBase;
      const x = span.x0 * TILE_SIZE + offset.x;
      const y = span.y * TILE_SIZE + offset.y;
      const width = (span.x1 - span.x0) * TILE_SIZE;
      g.fillStyle(color, 1);
      g.fillRect(x, y, width, TILE_SIZE);

      if (this.mod(span.y - Math.floor(building.bounds.y), sectionSpan) === 0) {
        g.fillStyle(palette.roofDark, building.cityId === 'yazd' ? 0.14 : 0.2);
        g.fillRect(x + 3, y + 2, Math.max(2, width - 6), 1);
      }
      if (building.material === 'wood') {
        g.fillStyle(palette.roofDark, 0.36);
        for (let py = y + 6; py < y + TILE_SIZE; py += 7) {
          g.fillRect(x + 2, py, Math.max(2, width - 4), 1);
        }
      } else if (building.material === 'steel' || building.roofStyle === 'industrial') {
        g.fillStyle(palette.roofDark, 0.3);
        for (let px = x + 8; px < x + width - 3; px += 18) {
          g.fillRect(px, y + 2, 1, TILE_SIZE - 4);
        }
      }
    }

    // Sparse, sub-tile material cues preserve pixel detail without turning
    // every occupied cell into an identical stamped texture.
    for (const tile of surface.tiles) {
      const detailHash = this.hashInt(tile.x, tile.y, seed);
      if (this.mod(detailHash, building.cityId === 'yazd' ? 6 : 7) !== 0) continue;
      const x = tile.x * TILE_SIZE + offset.x;
      const y = tile.y * TILE_SIZE + offset.y;

      if (building.roofStyle === 'green' || building.roofStyle === 'roof-garden') {
        g.fillStyle(this.mix(palette.green, palette.roof, 0.22), 0.82);
        g.fillRect(x + 5, y + 7, 22, 15);
        g.fillStyle(this.mix(palette.green, palette.roofLight, 0.3), 0.9);
        g.fillRect(x + 8, y + 9, 5, 4);
        g.fillRect(x + 19, y + 16, 4, 3);
      } else if (building.roofStyle === 'solar') {
        g.fillStyle(0x172832, 0.95);
        g.fillRect(x + 5, y + 8, 22, 14);
        g.fillStyle(0x477b8c, 0.9);
        g.fillRect(x + 7, y + 10, 18, 10);
        g.fillStyle(0x9bc0c3, 0.74);
        g.fillRect(x + 8, y + 11, 16, 1);
        g.fillStyle(0x172832, 0.9);
        g.fillRect(x + 15, y + 10, 1, 10);
      } else if (building.material === 'glass') {
        g.fillStyle(palette.glassLight, 0.54);
        g.fillRect(x + 5, y + 5, 20, 2);
        g.fillStyle(palette.roofDark, 0.5);
        g.fillRect(x + 23, y + 7, 2, 17);
      } else if (building.material === 'adobe') {
        g.fillStyle(palette.roofAlt, 0.34);
        g.fillRect(x + 6, y + 8, 19, 11);
        g.fillStyle(palette.roofLight, 0.24);
        g.fillRect(x + 8, y + 9, 14, 2);
      } else if (building.material === 'brick' || building.material === 'stone') {
        g.fillStyle(palette.roofLight, 0.2);
        g.fillRect(x + 5, y + 9, 21, 2);
        g.fillRect(x + 9, y + 20, 14, 1);
      } else if (building.roofStyle === 'mechanical') {
        g.fillStyle(palette.roofDark, 0.38);
        g.fillRect(x + 8, y + 8, 16, 13);
        g.fillStyle(palette.roofLight, 0.42);
        for (let px = x + 10; px < x + 23; px += 4) g.fillRect(px, y + 10, 1, 8);
      } else {
        g.fillStyle(palette.roofAlt, 0.24);
        g.fillRect(x + 7, y + 9, 17, 10);
      }
    }
  }

  private paintModuleSeams(
    g: Phaser.GameObjects.Graphics,
    geometry: BuildingGeometry,
    palette: PixelPalette,
  ): void {
    if (geometry.modules.length < 2) return;
    const drawn = new Set<string>();
    for (const module of geometry.modules) {
      for (const tile of module.tiles) {
        const x = tile.x * TILE_SIZE + geometry.offsetX;
        const y = tile.y * TILE_SIZE + geometry.offsetY;
        for (const side of ['north', 'south', 'west', 'east'] as const) {
          const dx = side === 'west' ? -1 : side === 'east' ? 1 : 0;
          const dy = side === 'north' ? -1 : side === 'south' ? 1 : 0;
          const neighbourKey = this.key(tile.x + dx, tile.y + dy);
          if (module.occupied.has(neighbourKey) || !geometry.occupied.has(neighbourKey)) continue;
          const edgeKey = `${Math.min(tile.x, tile.x + dx)},${Math.min(tile.y, tile.y + dy)}:${side === 'north' || side === 'south' ? 'h' : 'v'}`;
          if (drawn.has(edgeKey)) continue;
          drawn.add(edgeKey);
          const light = side === 'north' || side === 'west';
          g.fillStyle(light ? palette.roofLight : palette.roofDark, light ? 0.72 : 0.82);
          if (side === 'north') g.fillRect(x + 2, y, TILE_SIZE - 4, 2);
          else if (side === 'south') g.fillRect(x + 2, y + TILE_SIZE - 3, TILE_SIZE - 4, 3);
          else if (side === 'west') g.fillRect(x, y + 2, 2, TILE_SIZE - 4);
          else g.fillRect(x + TILE_SIZE - 3, y + 2, 3, TILE_SIZE - 4);
        }
      }
    }
  }

  private paintRaisedRoofTier(
    g: Phaser.GameObjects.Graphics,
    building: PlannedBuilding,
    geometry: BuildingGeometry,
    tier: RoofTierGeometry,
    lowerLift: number,
    palette: PixelPalette,
  ): void {
    const lower = this.roofOffset(geometry, lowerLift);
    const upper = this.roofOffset(geometry, tier.lift);
    const shadowDistance = Math.max(3, Math.floor((tier.lift - lowerLift) * 0.6));
    g.fillStyle(palette.roofDark, 0.3);
    for (const tile of tier.tiles) {
      g.fillRect(
        tile.x * TILE_SIZE + lower.x + shadowDistance,
        tile.y * TILE_SIZE + lower.y + shadowDistance,
        TILE_SIZE,
        TILE_SIZE,
      );
    }

    for (const span of tier.south) {
      const x0 = span.x0 * TILE_SIZE;
      const x1 = span.x1 * TILE_SIZE;
      const y = span.y * TILE_SIZE;
      g.fillStyle(this.mix(palette.wallSouth, palette.roof, 0.24), 1);
      g.fillPoints(
        [
          { x: x0 + upper.x, y: y + upper.y },
          { x: x1 + upper.x, y: y + upper.y },
          { x: x1 + lower.x, y: y + lower.y },
          { x: x0 + lower.x, y: y + lower.y },
        ],
        true,
      );
    }
    for (const span of tier.east) {
      const x = span.x * TILE_SIZE;
      const y0 = span.y0 * TILE_SIZE;
      const y1 = span.y1 * TILE_SIZE;
      g.fillStyle(this.mix(palette.wallEast, palette.roof, 0.2), 1);
      g.fillPoints(
        [
          { x: x + upper.x, y: y0 + upper.y },
          { x: x + upper.x, y: y1 + upper.y },
          { x: x + lower.x, y: y1 + lower.y },
          { x: x + lower.x, y: y0 + lower.y },
        ],
        true,
      );
    }

    this.paintRoofMaterial(g, building, tier, geometry, palette, tier.lift, tier.level);
    this.paintRoofEdges(g, building, tier, geometry, palette, tier.lift);
  }

  private paintCoherentRidges(
    g: Phaser.GameObjects.Graphics,
    geometry: BuildingGeometry,
    palette: PixelPalette,
  ): void {
    for (const module of geometry.modules) {
      if (module.tiles.length === 0) continue;
      const minX = Math.min(...module.tiles.map((tile) => tile.x));
      const maxX = Math.max(...module.tiles.map((tile) => tile.x)) + 1;
      const minY = Math.min(...module.tiles.map((tile) => tile.y));
      const maxY = Math.max(...module.tiles.map((tile) => tile.y)) + 1;
      const horizontal = maxX - minX >= maxY - minY;
      const centerX = Math.floor((minX + maxX) * 0.5);
      const centerY = Math.floor((minY + maxY) * 0.5);
      g.fillStyle(palette.roofLight, 0.24);
      for (const tile of module.tiles) {
        const x = tile.x * TILE_SIZE + geometry.offsetX;
        const y = tile.y * TILE_SIZE + geometry.offsetY;
        if (horizontal && tile.y < centerY) g.fillRect(x + 2, y + 2, TILE_SIZE - 4, TILE_SIZE - 3);
        if (!horizontal && tile.x < centerX) g.fillRect(x + 2, y + 2, TILE_SIZE - 3, TILE_SIZE - 4);
      }
      g.fillStyle(palette.roofDark, 0.96);
      if (horizontal) {
        for (const tile of module.tiles) {
          if (tile.y !== centerY && tile.y !== centerY - 1) continue;
          g.fillRect(
            tile.x * TILE_SIZE + geometry.offsetX,
            centerY * TILE_SIZE + geometry.offsetY - 2,
            TILE_SIZE,
            4,
          );
        }
      } else {
        for (const tile of module.tiles) {
          if (tile.x !== centerX && tile.x !== centerX - 1) continue;
          g.fillRect(
            centerX * TILE_SIZE + geometry.offsetX - 2,
            tile.y * TILE_SIZE + geometry.offsetY,
            4,
            TILE_SIZE,
          );
        }
      }
    }
  }

  /** Stepped gable caps and generous eaves distinguish Caspian roof modules. */
  private paintGilanGables(
    g: Phaser.GameObjects.Graphics,
    geometry: BuildingGeometry,
    palette: PixelPalette,
  ): void {
    for (const module of geometry.modules) {
      if (module.tiles.length === 0) continue;
      const minX = Math.min(...module.tiles.map((tile) => tile.x)) * TILE_SIZE + geometry.offsetX;
      const maxX =
        (Math.max(...module.tiles.map((tile) => tile.x)) + 1) * TILE_SIZE + geometry.offsetX;
      const minY = Math.min(...module.tiles.map((tile) => tile.y)) * TILE_SIZE + geometry.offsetY;
      const maxY =
        (Math.max(...module.tiles.map((tile) => tile.y)) + 1) * TILE_SIZE + geometry.offsetY;
      const horizontal = maxX - minX >= maxY - minY;
      g.fillStyle(palette.roofDark, 0.72);
      if (horizontal) {
        const centerY = Math.floor((minY + maxY) / 2);
        g.fillTriangle(minX + 2, minY + 5, minX + 2, maxY - 5, minX + 11, centerY);
        g.fillTriangle(maxX - 2, minY + 5, maxX - 2, maxY - 5, maxX - 11, centerY);
        g.fillStyle(palette.roofLight, 0.82);
        g.fillRect(minX + 2, centerY - 1, 9, 2);
        g.fillRect(maxX - 11, centerY - 1, 9, 2);
      } else {
        const centerX = Math.floor((minX + maxX) / 2);
        g.fillTriangle(minX + 5, minY + 2, maxX - 5, minY + 2, centerX, minY + 11);
        g.fillTriangle(minX + 5, maxY - 2, maxX - 5, maxY - 2, centerX, maxY - 11);
        g.fillStyle(palette.roofLight, 0.82);
        g.fillRect(centerX - 1, minY + 2, 2, 9);
        g.fillRect(centerX - 1, maxY - 11, 2, 9);
      }
    }
  }

  private paintRoofEdges(
    g: Phaser.GameObjects.Graphics,
    building: PlannedBuilding,
    surface: CellGeometry,
    geometry: BuildingGeometry,
    palette: PixelPalette,
    extraLift: number,
  ): void {
    const offset = this.roofOffset(geometry, extraLift);
    const sloped = building.roofStyle === 'sloped' || building.material === 'wood';
    const gilanSloped = sloped && building.cityId === 'gilan';
    const lightWidth = sloped
      ? gilanSloped
        ? 4
        : 3
      : building.cityId === 'yazd'
        ? 4
        : building.cityId === 'gilan'
          ? 2
          : 3;
    const darkWidth = sloped
      ? gilanSloped
        ? 6
        : 5
      : building.cityId === 'yazd'
        ? 5
        : building.cityId === 'gilan'
          ? 3
          : 4;
    const inner = sloped ? 0 : 2;
    const overhang = sloped ? (gilanSloped ? 7 : 4) : 0;

    g.fillStyle(palette.roofLight, 1);
    for (const span of surface.north) {
      const x = span.x0 * TILE_SIZE + offset.x - overhang;
      const y = span.y * TILE_SIZE + offset.y - overhang;
      const width = (span.x1 - span.x0) * TILE_SIZE + overhang * 2;
      g.fillRect(x, y, width, lightWidth + overhang);
      if (inner > 0) {
        g.fillStyle(palette.roofDark, 0.62);
        g.fillRect(x + overhang, y + overhang + lightWidth, width - overhang * 2, inner);
        g.fillStyle(palette.roofLight, 1);
      }
      this.paintYazdMerlons(
        g,
        building,
        'horizontal',
        x + overhang,
        y + overhang,
        width - overhang * 2,
        palette,
      );
    }
    for (const span of surface.west) {
      const x = span.x * TILE_SIZE + offset.x - overhang;
      const y = span.y0 * TILE_SIZE + offset.y - overhang;
      const height = (span.y1 - span.y0) * TILE_SIZE + overhang * 2;
      g.fillRect(x, y, lightWidth + overhang, height);
      if (inner > 0) {
        g.fillStyle(palette.roofDark, 0.62);
        g.fillRect(x + overhang + lightWidth, y + overhang, inner, height - overhang * 2);
        g.fillStyle(palette.roofLight, 1);
      }
      this.paintYazdMerlons(
        g,
        building,
        'vertical',
        x + overhang,
        y + overhang,
        height - overhang * 2,
        palette,
      );
    }

    g.fillStyle(palette.roofDark, 1);
    for (const span of surface.south) {
      const x = span.x0 * TILE_SIZE + offset.x - overhang;
      const y = span.y * TILE_SIZE + offset.y - darkWidth;
      const width = (span.x1 - span.x0) * TILE_SIZE + overhang * 2;
      g.fillRect(x, y, width, darkWidth + overhang);
      if (inner > 0) {
        g.fillStyle(palette.roofLight, 0.72);
        g.fillRect(x + overhang, y - inner, width - overhang * 2, inner);
        g.fillStyle(palette.roofDark, 1);
      }
      this.paintYazdMerlons(
        g,
        building,
        'horizontal',
        x + overhang,
        y - 3,
        width - overhang * 2,
        palette,
      );
    }
    for (const span of surface.east) {
      const x = span.x * TILE_SIZE + offset.x - darkWidth;
      const y = span.y0 * TILE_SIZE + offset.y - overhang;
      const height = (span.y1 - span.y0) * TILE_SIZE + overhang * 2;
      g.fillRect(x, y, darkWidth + overhang, height);
      if (inner > 0) {
        g.fillStyle(palette.roofLight, 0.68);
        g.fillRect(x - inner, y + overhang, inner, height - overhang * 2);
        g.fillStyle(palette.roofDark, 1);
      }
      this.paintYazdMerlons(
        g,
        building,
        'vertical',
        x + darkWidth,
        y + overhang,
        height - overhang * 2,
        palette,
      );
    }
  }

  private paintYazdMerlons(
    g: Phaser.GameObjects.Graphics,
    building: PlannedBuilding,
    orientation: 'horizontal' | 'vertical',
    x: number,
    y: number,
    length: number,
    palette: PixelPalette,
  ): void {
    const civic =
      building.kind === 'mosque' ||
      building.kind === 'government' ||
      building.kind === 'school' ||
      building.kind === 'university';
    if (building.cityId !== 'yazd' || length < 16) return;
    const interval = civic ? 14 : 27;
    const capWidth = civic ? 6 : 4;
    const capDepth = civic ? 4 : 3;
    g.fillStyle(palette.roofLight, 1);
    for (let offset = 3; offset < length - capWidth; offset += interval) {
      if (orientation === 'horizontal') {
        g.fillRect(x + offset, y - capDepth + 1, capWidth, capDepth);
      } else {
        g.fillRect(x - capDepth + 1, y + offset, capDepth, capWidth);
      }
    }
  }

  private roofOffset(geometry: BuildingGeometry, extraLift: number): TileCell {
    return {
      x: geometry.offsetX - Math.max(0, Math.floor(extraLift * 0.25)),
      y: geometry.offsetY - extraLift,
    };
  }

  private roofLiftForBounds(
    bounds: { x: number; y: number; width: number; height: number },
    geometry: BuildingGeometry,
  ): number {
    const keys: string[] = [];
    for (let y = Math.floor(bounds.y); y < Math.ceil(bounds.y + bounds.height); y++) {
      for (let x = Math.floor(bounds.x); x < Math.ceil(bounds.x + bounds.width); x++) {
        keys.push(this.key(x, y));
      }
    }
    let lift = 0;
    for (const tier of geometry.tiers) {
      if (keys.length > 0 && keys.every((key) => tier.occupied.has(key))) lift = tier.lift;
    }
    return lift;
  }

  /**
   * Far-plane doors must live in the roof graphic: drawing them with the low
   * wall object lets the roof cover them. North and west receive different
   * edge-oriented canopies so their approach direction remains unambiguous.
   */
  private paintHighPlaneEntrances(
    g: Phaser.GameObjects.Graphics,
    building: PlannedBuilding,
    geometry: BuildingGeometry,
    palette: PixelPalette,
  ): void {
    for (const entrance of building.entrances) {
      if (entrance.facing !== 'north' && entrance.facing !== 'west') continue;
      const lift = this.roofLiftForBounds(
        { x: entrance.position.x, y: entrance.position.y, width: 1, height: 1 },
        geometry,
      );
      const offset = this.roofOffset(geometry, lift);
      const wide =
        entrance.kind === 'vehicle' || entrance.kind === 'emergency'
          ? 16
          : entrance.primary
            ? 12
            : 9;
      const half = Math.floor(wide / 2);
      const canopyColor =
        entrance.kind === 'emergency'
          ? 0xb64242
          : entrance.kind === 'campus'
            ? palette.glassLight
            : palette.accent;

      if (entrance.facing === 'north') {
        const cx = entrance.position.x * TILE_SIZE + TILE_SIZE / 2 + offset.x;
        const edgeY = entrance.position.y * TILE_SIZE + offset.y;
        g.fillStyle(palette.roofDark, 0.68);
        g.fillRect(cx - half + 3, edgeY - 5, wide, 7);
        g.fillStyle(canopyColor, 1);
        g.fillRect(cx - half, edgeY - 8, wide, 5);
        g.fillStyle(palette.roofLight, 0.92);
        g.fillRect(cx - half + 1, edgeY - 8, Math.max(3, wide - 2), 1);
        g.fillStyle(palette.wallDark, 1);
        g.fillRect(cx - half + 2, edgeY, Math.max(4, wide - 4), 3);
        if (entrance.primary) {
          g.fillStyle(palette.roofLight, 0.82);
          g.fillRect(cx - half, edgeY - 3, 2, 6);
          g.fillRect(cx + half - 2, edgeY - 3, 2, 6);
        }
      } else {
        const edgeX = entrance.position.x * TILE_SIZE + offset.x;
        const cy = entrance.position.y * TILE_SIZE + TILE_SIZE / 2 + offset.y;
        g.fillStyle(palette.roofDark, 0.68);
        g.fillRect(edgeX - 5, cy - half + 3, 7, wide);
        g.fillStyle(canopyColor, 1);
        g.fillRect(edgeX - 8, cy - half, 5, wide);
        g.fillStyle(palette.roofLight, 0.92);
        g.fillRect(edgeX - 8, cy - half + 1, 1, Math.max(3, wide - 2));
        g.fillStyle(palette.wallDark, 1);
        g.fillRect(edgeX, cy - half + 2, 3, Math.max(4, wide - 4));
        if (entrance.primary) {
          g.fillStyle(palette.roofLight, 0.82);
          g.fillRect(edgeX - 3, cy - half, 6, 2);
          g.fillRect(edgeX - 3, cy + half - 2, 6, 2);
        }
      }
    }
  }

  private paintProgramIdentity(
    g: Phaser.GameObjects.Graphics,
    building: PlannedBuilding,
    geometry: BuildingGeometry,
    palette: PixelPalette,
  ): void {
    // Mosque identity comes from its real dome/minaret modules. Painting a
    // second miniature dome here muddied the landmark silhouette.
    if (building.kind === 'mosque') return;
    if (building.kind === 'stadium') {
      this.paintStadiumStandRoof(g, geometry, palette);
      return;
    }

    const band = this.programRoofBand(building, geometry);
    if (!band) return;
    switch (building.kind) {
      case 'tower': {
        const crown = this.paintRaisedRoofBlock(g, { ...band, height: 13 }, palette, palette.glass);
        const cx = crown.x + Math.floor(crown.width / 2);
        g.fillStyle(palette.glassLight, 0.88);
        g.fillRect(crown.x + 4, crown.y + 3, Math.max(4, crown.width - 8), 2);
        g.fillStyle(palette.roofDark, 0.9);
        g.fillRect(cx - 2, crown.y + 2, 4, Math.max(5, crown.height - 3));
        g.fillStyle(palette.roofLight, 1);
        g.fillRect(cx - 1, crown.y - 8, 2, 10);
        break;
      }
      case 'hospital': {
        const markWidth = Math.min(28, band.width);
        const markHeight = Math.min(19, band.height);
        const x = band.x + Math.floor((band.width - markWidth) / 2);
        const y = band.y + Math.floor((band.height - markHeight) / 2);
        g.fillStyle(0xe5e5dc, 0.9);
        g.fillRect(x, y, markWidth, markHeight);
        const cx = x + Math.floor(markWidth / 2);
        const cy = y + Math.floor(markHeight / 2);
        g.fillStyle(0xb64242, 1);
        g.fillRect(cx - 8, cy - 2, 16, 4);
        g.fillRect(cx - 2, cy - 8, 4, 16);
        break;
      }
      case 'government':
      case 'police': {
        const pavilion = this.paintRaisedRoofBlock(
          g,
          band,
          palette,
          building.kind === 'police' ? this.mix(palette.glass, 0x315f82, 0.45) : palette.roofAlt,
        );
        g.fillStyle(palette.roofLight, 0.92);
        g.fillRect(pavilion.x + 3, pavilion.y + 3, Math.max(4, pavilion.width - 6), 3);
        for (let px = pavilion.x + 5; px < pavilion.x + pavilion.width - 4; px += 9) {
          g.fillRect(px, pavilion.y + 6, 3, Math.max(4, pavilion.height - 9));
        }
        if (building.kind === 'police') {
          g.fillStyle(0x73a9c2, 0.94);
          g.fillRect(
            pavilion.x + 3,
            pavilion.y + pavilion.height - 5,
            Math.max(4, pavilion.width - 6),
            2,
          );
        }
        break;
      }
      case 'school':
      case 'university': {
        const clerestory = this.paintRaisedRoofBlock(
          g,
          { ...band, height: 15 },
          palette,
          palette.glass,
        );
        for (let px = clerestory.x + 4; px < clerestory.x + clerestory.width - 4; px += 12) {
          g.fillStyle(palette.glassLight, 0.82);
          g.fillTriangle(px, clerestory.y + 3, px + 7, clerestory.y + 3, px + 7, clerestory.y + 9);
        }
        g.fillStyle(palette.accent, 0.86);
        g.fillRect(
          clerestory.x + 3,
          clerestory.y + clerestory.height - 5,
          Math.max(4, clerestory.width - 6),
          2,
        );
        break;
      }
      case 'factory':
      case 'warehouse': {
        g.fillStyle(palette.roofDark, 0.72);
        g.fillRect(band.x + 3, band.y + 3, Math.max(4, band.width - 6), band.height - 6);
        for (let px = band.x + 5; px < band.x + band.width - 5; px += 14) {
          g.fillStyle(palette.glass, 0.92);
          g.fillRect(px, band.y + 5, 8, Math.max(5, band.height - 10));
          g.fillStyle(palette.glassLight, 0.72);
          g.fillRect(px + 1, band.y + 6, 6, 1);
        }
        break;
      }
      case 'parking-structure': {
        g.fillStyle(0x676d6c, 0.9);
        g.fillRect(band.x, band.y, band.width, band.height);
        g.fillStyle(0xe8dfc8, 0.8);
        for (let px = band.x + 5; px < band.x + band.width - 4; px += 12) {
          g.fillRect(px, band.y + 3, 1, band.height - 6);
        }
        g.fillStyle(palette.accent, 0.9);
        g.fillRect(band.x + 3, band.y + Math.floor(band.height / 2), band.width - 6, 2);
        break;
      }
      case 'gas-station': {
        const canopy = this.paintRaisedRoofBlock(g, { ...band, height: 14 }, palette, 0x315f4a);
        g.fillStyle(0xe5e2cf, 0.94);
        g.fillRect(canopy.x + 3, canopy.y + 4, canopy.width - 6, 3);
        g.fillStyle(0xd5b849, 1);
        g.fillRect(canopy.x + 4, canopy.y + canopy.height - 5, canopy.width - 8, 2);
        break;
      }
      case 'fire-station': {
        const canopy = this.paintRaisedRoofBlock(g, { ...band, height: 15 }, palette, 0x9b3f39);
        g.fillStyle(0xd9d4c6, 0.92);
        for (let px = canopy.x + 4; px < canopy.x + canopy.width - 5; px += 13) {
          g.fillRect(px, canopy.y + 5, 9, Math.max(4, canopy.height - 8));
          g.fillStyle(0x9b3f39, 0.92);
          g.fillRect(px + 2, canopy.y + 8, 5, 2);
          g.fillStyle(0xd9d4c6, 0.92);
        }
        break;
      }
      case 'market':
      case 'retail': {
        const cloth = [0xa64248, 0xd1a342, 0x387c75, 0x655b91];
        g.fillStyle(palette.roofDark, 0.8);
        g.fillRect(band.x + 2, band.y + 3, band.width - 4, band.height - 6);
        for (let px = band.x + 4; px < band.x + band.width - 4; px += 9) {
          g.fillStyle(
            cloth[this.mod(Math.floor(px / 9) + this.hashString(building.id), cloth.length)] ??
              0xa64248,
            1,
          );
          g.fillRect(px, band.y + 5, Math.min(8, band.x + band.width - px - 3), band.height - 10);
          g.fillStyle(palette.roofLight, 0.76);
          g.fillRect(px, band.y + 5, Math.min(8, band.x + band.width - px - 3), 2);
        }
        break;
      }
      case 'terminal':
      case 'sports-hall': {
        const hall = this.paintRaisedRoofBlock(g, { ...band, height: 16 }, palette, palette.glass);
        g.fillStyle(palette.glassLight, 0.76);
        for (let px = hall.x + 4; px < hall.x + hall.width - 4; px += 15) {
          g.fillRect(px, hall.y + 4, 9, 3);
        }
        g.fillStyle(palette.roofDark, 0.68);
        g.fillRect(hall.x + 3, hall.y + hall.height - 6, hall.width - 6, 3);
        break;
      }
      default:
        break;
    }
  }

  /** Largest coherent high-plane strip, sized in proportion to the building. */
  private programRoofBand(building: PlannedBuilding, geometry: BuildingGeometry): CellRect | null {
    const tier = geometry.tiers[geometry.tiers.length - 1];
    const surface: CellGeometry = tier ?? geometry;
    const rows = this.tileRows(surface.tiles);
    if (rows.length === 0) return null;
    const centerY = building.bounds.y + building.bounds.height / 2;
    const row = rows.reduce((best, candidate) => {
      const bestLength = best.x1 - best.x0;
      const candidateLength = candidate.x1 - candidate.x0;
      if (candidateLength !== bestLength) return candidateLength > bestLength ? candidate : best;
      return Math.abs(candidate.y + 0.5 - centerY) < Math.abs(best.y + 0.5 - centerY)
        ? candidate
        : best;
    });
    const offset = this.roofOffset(geometry, tier?.lift ?? 0);
    const runX = row.x0 * TILE_SIZE + offset.x;
    const runWidth = (row.x1 - row.x0) * TILE_SIZE;
    const maximumWidth =
      (building.size === 'huge' ? 5 : building.size === 'large' ? 4 : 3) * TILE_SIZE;
    const width = Math.max(20, Math.min(runWidth - 10, maximumWidth));
    return {
      x: runX + Math.floor((runWidth - width) / 2),
      y: row.y * TILE_SIZE + offset.y + 7,
      width,
      height: 19,
    };
  }

  private paintRaisedRoofBlock(
    g: Phaser.GameObjects.Graphics,
    rect: CellRect,
    palette: PixelPalette,
    topColor: number,
  ): CellRect {
    g.fillStyle(palette.roofDark, 0.38);
    g.fillRect(rect.x + 4, rect.y + 4, Math.max(4, rect.width - 4), rect.height);
    g.fillStyle(palette.wallSouth, 1);
    g.fillRect(rect.x, rect.y + rect.height - 4, rect.width, 5);
    g.fillStyle(palette.wallEast, 1);
    g.fillRect(rect.x + rect.width - 4, rect.y, 4, rect.height + 1);
    g.fillStyle(topColor, 1);
    g.fillRect(rect.x, rect.y, rect.width - 4, rect.height - 4);
    g.fillStyle(palette.roofLight, 0.9);
    g.fillRect(rect.x + 1, rect.y + 1, Math.max(3, rect.width - 6), 2);
    return { x: rect.x, y: rect.y, width: rect.width - 4, height: rect.height - 4 };
  }

  private paintStadiumStandRoof(
    g: Phaser.GameObjects.Graphics,
    geometry: BuildingGeometry,
    palette: PixelPalette,
  ): void {
    const offset = this.roofOffset(geometry, 0);
    for (const module of geometry.modules) {
      if (module.tiles.length === 0) continue;
      const minX = Math.min(...module.tiles.map((tile) => tile.x)) * TILE_SIZE + offset.x;
      const maxX = (Math.max(...module.tiles.map((tile) => tile.x)) + 1) * TILE_SIZE + offset.x;
      const minY = Math.min(...module.tiles.map((tile) => tile.y)) * TILE_SIZE + offset.y;
      const maxY = (Math.max(...module.tiles.map((tile) => tile.y)) + 1) * TILE_SIZE + offset.y;
      const horizontal = maxX - minX >= maxY - minY;
      g.fillStyle(this.mix(palette.roof, 0x6d7476, 0.42), 0.94);
      g.fillRect(minX + 4, minY + 4, maxX - minX - 8, maxY - minY - 8);
      g.fillStyle(palette.roofLight, 0.72);
      if (horizontal) {
        for (let y = minY + 7; y < maxY - 6; y += 6) {
          g.fillRect(minX + 6, y, maxX - minX - 12, 2);
        }
        g.fillStyle(palette.roofDark, 0.78);
        for (let x = minX + 20; x < maxX - 10; x += 34) {
          g.fillRect(x, minY + 5, 3, maxY - minY - 10);
        }
      } else {
        for (let x = minX + 7; x < maxX - 6; x += 6) {
          g.fillRect(x, minY + 6, 2, maxY - minY - 12);
        }
        g.fillStyle(palette.roofDark, 0.78);
        for (let y = minY + 20; y < maxY - 10; y += 34) {
          g.fillRect(minX + 5, y, maxX - minX - 10, 3);
        }
      }
    }
  }

  private paintRoofAsset(
    g: Phaser.GameObjects.Graphics,
    asset: PlannedRoofAsset,
    building: PlannedBuilding,
    geometry: BuildingGeometry,
    palette: PixelPalette,
  ): void {
    const lift = this.roofLiftForBounds(asset.bounds, geometry);
    const offset = this.roofOffset(geometry, lift);
    const x = Math.round(asset.bounds.x * TILE_SIZE + offset.x);
    const y = Math.round(asset.bounds.y * TILE_SIZE + offset.y);
    const width = Math.max(8, Math.round(asset.bounds.width * TILE_SIZE));
    const height = Math.max(8, Math.round(asset.bounds.height * TILE_SIZE));
    const cx = x + Math.floor(width / 2);
    const cy = y + Math.floor(height / 2);
    const margin = building.size === 'large' || building.size === 'huge' ? 3 : 4;
    const raised =
      asset.kind !== 'solar-panels' && asset.kind !== 'skylight' && asset.kind !== 'helipad';
    if (raised) {
      g.fillStyle(palette.roofDark, 0.38);
      g.fillRect(
        x + margin + 3,
        y + margin + 3,
        Math.max(4, width - margin - 3),
        Math.max(4, height - margin - 3),
      );
    }
    switch (asset.kind) {
      case 'hvac':
      case 'air-conditioner': {
        const count = 1 + this.mod(asset.variant, 3);
        const gap = 2;
        const available = Math.max(8, width - 8 - gap * (count - 1));
        const unitWidth = Math.max(5, Math.floor(available / count));
        for (let index = 0; index < count; index++) {
          const unitX = x + 4 + index * (unitWidth + gap);
          const unitHeight = Math.max(8, height - 12 - (index & 1));
          g.fillStyle(0x27333a, 0.52);
          g.fillRect(unitX + 3, y + 8, unitWidth, unitHeight);
          g.fillStyle(0x303b42, 1);
          g.fillRect(unitX, y + 4, unitWidth, unitHeight);
          g.fillStyle(0x879395, 1);
          g.fillRect(unitX + 1, y + 5, Math.max(3, unitWidth - 2), 3);
          g.fillStyle(0x3c484e, 1);
          for (let px = unitX + 2; px < unitX + unitWidth - 1; px += 4) {
            g.fillRect(px, y + 10, 1, Math.max(3, unitHeight - 8));
          }
        }
        break;
      }
      case 'water-tank': {
        const count = 1 + (asset.variant & 1);
        const tankWidth =
          count === 1 ? Math.min(width - 8, 20) : Math.min(12, Math.floor((width - 8) / 2));
        const startX = count === 1 ? cx : cx - Math.floor(tankWidth / 2) - 4;
        for (let index = 0; index < count; index++) {
          const tankX = startX + index * (tankWidth + 3);
          g.fillStyle(0x24353b, 0.58);
          g.fillEllipse(tankX + 3, cy + 4, tankWidth, 14);
          g.fillStyle(0x30464d, 1);
          g.fillEllipse(tankX, cy, tankWidth, 15);
          g.fillStyle(0x7e999b, 1);
          g.fillEllipse(tankX - 2, cy - 3, Math.max(4, tankWidth - 7), 4);
          g.fillStyle(0x26343a, 1);
          g.fillRect(tankX - 4, cy + 5, 2, 6);
          g.fillRect(tankX + 3, cy + 5, 2, 6);
        }
        break;
      }
      case 'solar-panels': {
        const horizontal = asset.facing === 'north' || asset.facing === 'south';
        g.fillStyle(palette.roofDark, 0.36);
        g.fillRect(x + 5, y + 7, width - 8, height - 8);
        g.fillStyle(0x172832, 1);
        g.fillRect(x + 3, y + 4, width - 6, height - 8);
        g.fillStyle(0x356379, 1);
        g.fillRect(x + 4, y + 5, width - 8, height - 10);
        g.fillStyle(0x86b1b8, 0.8);
        g.fillRect(x + 5, y + 6, width - 10, 1);
        g.fillStyle(0x172832, 1);
        if (horizontal) {
          const rows = 2 + (asset.variant & 1);
          for (let row = 1; row < rows; row++) {
            const py = y + 5 + Math.floor(((height - 10) * row) / rows);
            g.fillRect(x + 4, py, width - 8, 1);
          }
          g.fillRect(cx, y + 5, 1, height - 10);
        } else {
          const columns = 2 + (asset.variant & 1);
          for (let column = 1; column < columns; column++) {
            const px = x + 4 + Math.floor(((width - 8) * column) / columns);
            g.fillRect(px, y + 5, 1, height - 10);
          }
          g.fillRect(x + 4, cy, width - 8, 1);
        }
        break;
      }
      case 'roof-access': {
        const boxX = x + 4;
        const boxY = y + 3;
        const boxWidth = Math.max(6, width - 10);
        const boxHeight = Math.max(7, height - 11);
        g.fillStyle(palette.wallSouth, 1);
        g.fillRect(boxX, boxY + boxHeight, boxWidth, 4);
        g.fillStyle(palette.wallEast, 1);
        g.fillRect(boxX + boxWidth - 3, boxY, 3, boxHeight + 4);
        g.fillStyle(palette.roofDark, 1);
        g.fillRect(boxX, boxY, boxWidth - 3, boxHeight);
        g.fillStyle(palette.roofLight, 1);
        g.fillRect(boxX + 1, boxY + 1, boxWidth - 5, 2);
        g.fillStyle(0xc79d48, 1);
        g.fillRect(boxX + boxWidth - 6, boxY + Math.floor(boxHeight / 2), 2, 2);
        break;
      }
      case 'chimney':
        g.fillStyle(0x49372f, 1);
        g.fillRect(cx - 4, cy - 6, 8, 13);
        g.fillStyle(0xb07050, 1);
        g.fillRect(cx - 3, cy - 6, 5, 10);
        g.fillStyle(0xd4d7cd, 0.6);
        g.fillRect(cx - 5, cy - 8, 10, 2);
        break;
      case 'vent':
        g.fillStyle(0x29363c, 1);
        g.fillCircle(cx, cy, Math.max(3, Math.round(Math.min(width, height) * 0.28)));
        g.fillStyle(0x9aa4a4, 1);
        g.fillCircle(cx - 1, cy - 1, Math.max(1, Math.round(Math.min(width, height) * 0.12)));
        break;
      case 'satellite-dish': {
        const facingX = asset.facing === 'east' ? 3 : asset.facing === 'west' ? -3 : 0;
        const facingY = asset.facing === 'south' ? 3 : asset.facing === 'north' ? -3 : 0;
        g.fillStyle(0x30444b, 1);
        g.fillCircle(cx, cy - 1, Math.max(4, Math.round(Math.min(width, height) * 0.3)));
        g.fillStyle(0x859a9b, 1);
        g.fillCircle(
          cx - 2 + facingX,
          cy - 3 + facingY,
          Math.max(2, Math.round(Math.min(width, height) * 0.17)),
        );
        g.fillStyle(0x27373d, 1);
        g.fillRect(cx, cy + 2, 2, Math.max(4, Math.round(height / 3)));
        break;
      }
      case 'billboard': {
        const horizontal = asset.facing === 'north' || asset.facing === 'south';
        const signWidth = horizontal ? width - 8 : Math.max(10, Math.floor(width * 0.48));
        const signHeight = horizontal ? Math.max(8, height - 14) : height - 10;
        const signX = x + Math.floor((width - signWidth) / 2);
        const signY = y + 3;
        g.fillStyle(0x28333a, 1);
        g.fillRect(signX, signY, signWidth, signHeight);
        g.fillStyle(palette.accent, 1);
        g.fillRect(signX + 2, signY + 2, signWidth - 4, 3);
        g.fillStyle(0xcfd6d2, 0.8);
        g.fillRect(signX + 2, signY + 7, Math.max(4, signWidth - 8), 2);
        g.fillStyle(0x313a40, 1);
        g.fillRect(signX + 3, signY + signHeight, 2, Math.max(4, y + height - signY - signHeight));
        g.fillRect(
          signX + signWidth - 5,
          signY + signHeight,
          2,
          Math.max(4, y + height - signY - signHeight),
        );
        break;
      }
      case 'skylight':
        g.fillStyle(palette.roofDark, 1);
        g.fillRect(x + 3, y + 3, width - 6, height - 6);
        g.fillStyle(palette.glass, 1);
        g.fillRect(x + 5, y + 5, width - 10, height - 10);
        g.fillStyle(palette.glassLight, 0.84);
        g.fillRect(x + 6, y + 6, width - 12, 2);
        break;
      case 'helipad':
        g.lineStyle(2, 0xe8e5d3, 0.88);
        g.strokeCircle(cx, cy, Math.max(6, Math.round(Math.min(width, height) * 0.38)));
        g.fillStyle(0xe8e5d3, 0.88);
        g.fillRect(cx - 7, cy - 2, 14, 4);
        g.fillRect(cx - 2, cy - 7, 4, 14);
        break;
      case 'windcatcher': {
        const towerX = x + 5;
        const towerY = y + 2;
        const towerWidth = Math.max(10, width - 12);
        const towerHeight = Math.max(12, height - 11);
        g.fillStyle(palette.wallSouth, 1);
        g.fillRect(towerX, towerY + towerHeight, towerWidth, 5);
        g.fillStyle(palette.wallEast, 1);
        g.fillRect(towerX + towerWidth - 4, towerY, 4, towerHeight + 5);
        g.fillStyle(palette.roofDark, 1);
        g.fillRect(towerX, towerY, towerWidth - 4, towerHeight);
        g.fillStyle(palette.roofLight, 1);
        g.fillRect(towerX + 2, towerY + 2, towerWidth - 8, towerHeight - 4);
        g.fillStyle(palette.roofDark, 0.88);
        g.fillRect(towerX + Math.floor((towerWidth - 4) / 2) - 1, towerY + 2, 2, towerHeight - 4);
        g.fillRect(towerX + 2, towerY + Math.floor(towerHeight / 2) - 1, towerWidth - 8, 2);
        g.fillStyle(palette.roofLight, 1);
        for (let px = towerX; px < towerX + towerWidth; px += 6) {
          g.fillRect(px, towerY - 3, 4, 3);
        }
        break;
      }
      case 'dome': {
        // A one-tile reservation describes collision-safe roof ownership, not
        // the apparent diameter of the dome. Landmark domes deliberately
        // project beyond that reservation so they remain legible at 1x zoom.
        const radius = building.landmark
          ? Math.max(17, Math.min(22, Math.round(Math.min(width, height) * 0.62)))
          : Math.max(7, Math.round(Math.min(width, height) * 0.4));
        g.fillStyle(palette.roofDark, 0.52);
        g.fillCircle(cx + 5, cy + 6, radius + 2);
        g.fillStyle(0x174f59, 1);
        g.fillCircle(cx, cy, radius);
        g.fillStyle(0x21868b, 1);
        g.fillCircle(cx - 1, cy - 2, radius - 3);
        g.fillStyle(0x69bbb3, 1);
        g.fillCircle(cx - Math.round(radius * 0.3), cy - Math.round(radius * 0.34), radius * 0.3);
        g.lineStyle(2, 0x123d46, 0.72);
        g.strokeCircle(cx, cy, radius - 1);
        g.fillStyle(0xd8bb58, 1);
        g.fillRect(cx - 1, cy - radius - 6, 3, 7);
        g.fillRect(cx - 3, cy - radius - 5, 7, 2);
        break;
      }
      case 'minaret': {
        // Project the shaft northward from its owned roof cell. The balcony,
        // turquoise cap and gold finial make vertical height readable from the
        // unchanged top-down camera without adding collision geometry.
        const shaftHeight = building.landmark ? 44 : Math.max(24, height + 8);
        const shaftTop = cy - shaftHeight;
        const shaftWidth = building.landmark ? 9 : 7;
        const shaftX = cx - Math.floor(shaftWidth / 2);
        g.fillStyle(palette.roofDark, 0.5);
        g.fillRect(shaftX + 5, shaftTop + 8, shaftWidth + 2, shaftHeight + 4);
        g.fillCircle(cx + 4, cy + 4, 9);
        g.fillStyle(0x9d693f, 1);
        g.fillCircle(cx, cy, 8);
        g.fillRect(shaftX, shaftTop + 8, shaftWidth, shaftHeight - 6);
        g.fillStyle(0xe4bb78, 1);
        g.fillRect(shaftX + 1, shaftTop + 9, 3, shaftHeight - 9);
        g.fillStyle(0x6c452f, 1);
        g.fillRect(shaftX + shaftWidth - 2, shaftTop + 9, 2, shaftHeight - 7);
        g.fillStyle(0xd8bb58, 1);
        g.fillRect(cx - 10, shaftTop + 10, 20, 5);
        g.fillStyle(0x6c4f2d, 1);
        g.fillRect(cx - 8, shaftTop + 15, 16, 2);
        g.fillStyle(0x21868b, 1);
        g.fillCircle(cx, shaftTop + 6, 8);
        g.fillStyle(0x6cc2ba, 1);
        g.fillCircle(cx - 2, shaftTop + 4, 3);
        g.fillStyle(0xd8bb58, 1);
        g.fillRect(cx - 1, shaftTop - 7, 3, 8);
        g.fillRect(cx - 3, shaftTop - 6, 7, 2);
        break;
      }
    }
  }

  private paintUrbanSpace(
    surfaces: Phaser.GameObjects.Graphics,
    fixtures: Phaser.GameObjects.Graphics,
    tallFixtures: Phaser.GameObjects.Graphics,
    space: PlannedUrbanSpace,
    palette: PixelPalette,
    clip: CellRect,
  ): void {
    const geometry = this.urbanSpaceGeometry(space);
    const visibleCells = geometry.cells.filter((cell) => this.cellInsideRect(cell, clip));
    if (visibleCells.length === 0) return;
    const color = this.spaceColor(space, palette);
    const seed = this.hashString(space.signature);
    for (const cell of visibleCells) {
      const variation = this.hashInt(cell.x, cell.y, seed) & 3;
      const tileColor =
        variation === 0
          ? this.mix(color, palette.roofLight, 0.05)
          : variation === 1
            ? this.shade(color, 0.045)
            : color;
      surfaces.fillStyle(tileColor, 0.98);
      surfaces.fillRect(cell.x * TILE_SIZE, cell.y * TILE_SIZE, TILE_SIZE, TILE_SIZE);
    }

    this.paintUrbanSpaceBoundary(
      surfaces,
      visibleCells,
      geometry.occupied,
      this.shade(color, 0.28),
    );
    this.paintUrbanSpacePattern(surfaces, space, geometry, visibleCells, palette, clip);

    for (const feature of space.features) {
      if (!this.featureFitsUrbanSpace(feature, geometry.occupied)) continue;
      if (!this.featureOwnedByChunk(feature, clip)) continue;
      this.paintGroundFeature(surfaces, fixtures, tallFixtures, feature, palette);
    }
  }

  private urbanSpaceGeometry(space: PlannedUrbanSpace): UrbanSpaceGeometry {
    const cached = this.spaceGeometryCache.get(space.id);
    if (cached) return cached;

    const x0 = Math.floor(space.bounds.x);
    const y0 = Math.floor(space.bounds.y);
    const x1 = Math.ceil(space.bounds.x + space.bounds.width);
    const y1 = Math.ceil(space.bounds.y + space.bounds.height);
    const occupied = new Set<string>();
    const cells: TileCell[] = [];
    for (const part of space.footprint) {
      const partX0 = Math.floor(part.x);
      const partY0 = Math.floor(part.y);
      const partX1 = Math.ceil(part.x + part.width);
      const partY1 = Math.ceil(part.y + part.height);
      for (let ty = partY0; ty < partY1; ty++) {
        for (let tx = partX0; tx < partX1; tx++) {
          const key = this.key(tx, ty);
          if (occupied.has(key) || this.footprintOwner.has(key)) continue;
          if (!PUBLIC_REALM_TILES.has(this.map.tiles[ty]?.[tx] ?? -1)) continue;
          occupied.add(key);
          cells.push({ x: tx, y: ty });
        }
      }
    }
    cells.sort((a, b) => a.y - b.y || a.x - b.x);

    const result: UrbanSpaceGeometry = {
      cells,
      occupied,
      largestRect: this.largestOccupiedRect(occupied, x0, y0, x1, y1),
    };
    this.spaceGeometryCache.set(space.id, result);
    return result;
  }

  private largestOccupiedRect(
    occupied: ReadonlySet<string>,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ): CellRect | null {
    const columnCount = Math.max(0, x1 - x0);
    if (columnCount === 0 || y1 <= y0) return null;
    const heights = new Array<number>(columnCount).fill(0);
    let best: CellRect | null = null;
    let bestArea = 0;

    for (let y = y0; y < y1; y++) {
      for (let column = 0; column < columnCount; column++) {
        heights[column] = occupied.has(this.key(x0 + column, y)) ? (heights[column] ?? 0) + 1 : 0;
      }
      const stack: number[] = [];
      for (let column = 0; column <= columnCount; column++) {
        const currentHeight = column === columnCount ? 0 : (heights[column] ?? 0);
        while (stack.length > 0) {
          const top = stack[stack.length - 1];
          if (top === undefined || (heights[top] ?? 0) <= currentHeight) break;
          const popped = stack.pop();
          if (popped === undefined) continue;
          const height = heights[popped] ?? 0;
          const left = (stack[stack.length - 1] ?? -1) + 1;
          const width = column - left;
          const area = width * height;
          const candidate: CellRect = { x: x0 + left, y: y - height + 1, width, height };
          if (
            area > bestArea ||
            (area === bestArea &&
              best !== null &&
              (candidate.y < best.y || (candidate.y === best.y && candidate.x < best.x)))
          ) {
            best = candidate;
            bestArea = area;
          }
        }
        if (column < columnCount) stack.push(column);
      }
    }
    return best;
  }

  private paintUrbanSpaceBoundary(
    g: Phaser.GameObjects.Graphics,
    cells: readonly TileCell[],
    occupied: ReadonlySet<string>,
    color: number,
  ): void {
    g.fillStyle(color, 0.84);
    for (const cell of cells) {
      const x = cell.x * TILE_SIZE;
      const y = cell.y * TILE_SIZE;
      if (!occupied.has(this.key(cell.x, cell.y - 1))) g.fillRect(x, y, TILE_SIZE, 1);
      if (!occupied.has(this.key(cell.x, cell.y + 1))) {
        g.fillRect(x, y + TILE_SIZE - 1, TILE_SIZE, 1);
      }
      if (!occupied.has(this.key(cell.x - 1, cell.y))) g.fillRect(x, y, 1, TILE_SIZE);
      if (!occupied.has(this.key(cell.x + 1, cell.y))) {
        g.fillRect(x + TILE_SIZE - 1, y, 1, TILE_SIZE);
      }
    }
  }

  private paintUrbanSpacePattern(
    g: Phaser.GameObjects.Graphics,
    space: PlannedUrbanSpace,
    geometry: UrbanSpaceGeometry,
    visibleCells: readonly TileCell[],
    palette: PixelPalette,
    clip: CellRect,
  ): void {
    switch (space.kind) {
      case 'football-field':
      case 'stadium-field':
        this.paintPitchPattern(g, geometry.largestRect, clip);
        break;
      case 'sports-court':
      case 'schoolyard':
        this.paintCourtPattern(g, geometry.largestRect, space.kind === 'schoolyard', clip);
        break;
      case 'playground':
        this.paintPlaygroundPattern(g, visibleCells, space.signature);
        break;
      case 'parking-lot':
      case 'police-yard':
      case 'hospital-approach':
        this.paintParkingPattern(g, visibleCells, space.kind, space.signature, palette);
        break;
      case 'garden':
      case 'park':
      case 'forest-pocket':
        this.paintParkPattern(
          g,
          geometry,
          visibleCells,
          space.kind,
          space.signature,
          palette,
          clip,
        );
        break;
      case 'loading-yard':
      case 'service-yard':
      case 'rail-yard':
      case 'construction-yard':
      case 'utility-yard':
        this.paintIndustrialYardPattern(g, visibleCells, space.kind, space.signature);
        break;
      case 'market-lane':
      case 'mosque-court':
      case 'public-plaza':
      case 'courtyard':
      case 'cemetery':
        this.paintPavingPattern(g, geometry, visibleCells, space.kind, palette, clip);
        break;
      case 'farmyard':
      case 'beach':
        this.paintLandPattern(g, visibleCells, space.kind, space.signature);
        break;
    }
  }

  private paintPitchPattern(
    g: Phaser.GameObjects.Graphics,
    rect: CellRect | null,
    clip: CellRect,
  ): void {
    if (!rect) return;
    const x = rect.x * TILE_SIZE;
    const y = rect.y * TILE_SIZE;
    const width = rect.width * TILE_SIZE;
    const height = rect.height * TILE_SIZE;
    const inset = Math.min(8, Math.max(3, Math.floor(Math.min(width, height) / 10)));
    const innerX = x + inset;
    const innerY = y + inset;
    const innerWidth = Math.max(8, width - inset * 2);
    const innerHeight = Math.max(8, height - inset * 2);
    this.paintOutlineRect(g, innerX, innerY, innerWidth, innerHeight, 2, 0xe8e7d2, 0.86, clip);
    const centerX = innerX + Math.floor(innerWidth / 2);
    this.paintClippedRect(g, centerX - 1, innerY, 2, innerHeight, 0xe8e7d2, 0.84, clip);
    const centerY = innerY + Math.floor(innerHeight / 2);
    if (this.pixelInsideCellRect(centerX, centerY, clip)) {
      g.lineStyle(2, 0xe8e7d2, 0.84);
      g.strokeCircle(centerX, centerY, Math.max(5, Math.min(18, Math.floor(innerHeight / 6))));
    }
    const boxWidth = Math.max(8, Math.floor(innerWidth / 7));
    const boxHeight = Math.max(12, Math.floor(innerHeight / 3));
    const boxY = innerY + Math.floor((innerHeight - boxHeight) / 2);
    this.paintOutlineRect(g, innerX, boxY, boxWidth, boxHeight, 2, 0xe8e7d2, 0.78, clip);
    this.paintOutlineRect(
      g,
      innerX + innerWidth - boxWidth,
      boxY,
      boxWidth,
      boxHeight,
      2,
      0xe8e7d2,
      0.78,
      clip,
    );
  }

  private paintCourtPattern(
    g: Phaser.GameObjects.Graphics,
    rect: CellRect | null,
    schoolyard: boolean,
    clip: CellRect,
  ): void {
    if (!rect) return;
    const x = rect.x * TILE_SIZE;
    const y = rect.y * TILE_SIZE;
    const width = rect.width * TILE_SIZE;
    const height = rect.height * TILE_SIZE;
    const inset = Math.min(7, Math.max(3, Math.floor(Math.min(width, height) / 12)));
    const courtX = x + inset;
    const courtY = y + inset;
    const courtWidth = Math.max(8, width - inset * 2);
    const courtHeight = Math.max(8, height - inset * 2);
    if (schoolyard) {
      this.paintClippedRect(g, courtX, courtY, courtWidth, courtHeight, 0x9b5b48, 0.72, clip);
    }
    this.paintOutlineRect(g, courtX, courtY, courtWidth, courtHeight, 2, 0xf0e8d4, 0.86, clip);
    const centerX = courtX + Math.floor(courtWidth / 2);
    const centerY = courtY + Math.floor(courtHeight / 2);
    this.paintClippedRect(g, centerX - 1, courtY, 2, courtHeight, 0xf0e8d4, 0.82, clip);
    if (this.pixelInsideCellRect(centerX, centerY, clip)) {
      g.lineStyle(2, 0xf0e8d4, 0.82);
      g.strokeCircle(
        centerX,
        centerY,
        Math.max(5, Math.min(15, Math.floor(Math.min(courtWidth, courtHeight) / 7))),
      );
    }
  }

  private paintPlaygroundPattern(
    g: Phaser.GameObjects.Graphics,
    cells: readonly TileCell[],
    signature: string,
  ): void {
    const seed = this.hashString(signature);
    const colors = [0xb94d46, 0xd49b3e, 0x397b91, 0x4f845b] as const;
    for (const cell of cells) {
      const x = cell.x * TILE_SIZE;
      const y = cell.y * TILE_SIZE;
      const index = this.mod(this.hashInt(cell.x, cell.y, seed), colors.length);
      g.fillStyle(colors[index] ?? colors[0], 0.58);
      g.fillRect(x + 3, y + 3, TILE_SIZE - 6, TILE_SIZE - 6);
      g.fillStyle(0xe7d8b6, 0.52);
      g.fillRect(x + 3, y + 15, TILE_SIZE - 6, 2);
    }
  }

  private paintParkingPattern(
    g: Phaser.GameObjects.Graphics,
    cells: readonly TileCell[],
    kind: 'parking-lot' | 'police-yard' | 'hospital-approach',
    signature: string,
    palette: PixelPalette,
  ): void {
    const seed = this.hashString(signature);
    const lineColor = kind === 'police-yard' ? 0x8cb3c7 : 0xe9e0c8;
    for (const cell of cells) {
      const x = cell.x * TILE_SIZE;
      const y = cell.y * TILE_SIZE;
      const hash = this.hashInt(cell.x, cell.y, seed);
      g.fillStyle(this.shade(palette.paving, 0.38), 0.28);
      g.fillRect(x, y, TILE_SIZE, 1);
      g.fillRect(x, y, 1, TILE_SIZE);
      if ((hash & 1) === 0) {
        g.fillStyle(lineColor, 0.86);
        g.fillRect(x + 3, y + 4, 1, TILE_SIZE - 8);
        g.fillRect(x + TILE_SIZE - 4, y + 4, 1, TILE_SIZE - 8);
        g.fillRect(x + 3, y + 4, TILE_SIZE - 6, 1);
        g.fillStyle(0x252b2e, 0.82);
        g.fillRect(x + 9, y + TILE_SIZE - 7, TILE_SIZE - 18, 3);
      }
      if (kind === 'hospital-approach' && this.mod(hash, 7) === 0) {
        g.fillStyle(0xe8e8df, 0.92);
        g.fillRect(x + 8, y + 14, 16, 4);
        g.fillRect(x + 14, y + 8, 4, 16);
      }
    }
  }

  private paintParkPattern(
    g: Phaser.GameObjects.Graphics,
    geometry: UrbanSpaceGeometry,
    visibleCells: readonly TileCell[],
    kind: 'garden' | 'park' | 'forest-pocket',
    signature: string,
    palette: PixelPalette,
    clip: CellRect,
  ): void {
    const seed = this.hashString(signature);
    for (const cell of visibleCells) {
      const x = cell.x * TILE_SIZE;
      const y = cell.y * TILE_SIZE;
      const hash = this.hashInt(cell.x, cell.y, seed);
      g.fillStyle(this.mix(palette.green, 0x9aae68, 0.3), kind === 'forest-pocket' ? 0.64 : 0.48);
      g.fillRect(x + 5 + this.mod(hash, 13), y + 5 + this.mod(hash >>> 5, 13), 4, 3);
      g.fillStyle(this.shade(palette.green, 0.24), 0.52);
      g.fillRect(x + 19 + this.mod(hash >>> 9, 6), y + 19 + this.mod(hash >>> 13, 6), 3, 4);
    }
    const rect = geometry.largestRect;
    if (!rect) return;
    const x = rect.x * TILE_SIZE;
    const y = rect.y * TILE_SIZE;
    const width = rect.width * TILE_SIZE;
    const height = rect.height * TILE_SIZE;
    const pathColor = this.mix(palette.paving, palette.roofLight, 0.12);
    if (width >= height || kind === 'forest-pocket') {
      this.paintClippedRect(g, x, y + Math.floor(height / 2) - 3, width, 6, pathColor, 0.9, clip);
    } else {
      this.paintClippedRect(g, x + Math.floor(width / 2) - 3, y, 6, height, pathColor, 0.9, clip);
    }
    if (kind !== 'forest-pocket' && width >= TILE_SIZE * 3 && height >= TILE_SIZE * 3) {
      this.paintClippedRect(g, x + Math.floor(width / 2) - 3, y, 6, height, pathColor, 0.9, clip);
      this.paintClippedRect(g, x, y + Math.floor(height / 2) - 3, width, 6, pathColor, 0.9, clip);
    }
  }

  private paintIndustrialYardPattern(
    g: Phaser.GameObjects.Graphics,
    cells: readonly TileCell[],
    kind: 'loading-yard' | 'service-yard' | 'rail-yard' | 'construction-yard' | 'utility-yard',
    signature: string,
  ): void {
    const seed = this.hashString(signature);
    for (const cell of cells) {
      const x = cell.x * TILE_SIZE;
      const y = cell.y * TILE_SIZE;
      const hash = this.hashInt(cell.x, cell.y, seed);
      g.fillStyle(0x34393a, 0.45);
      g.fillRect(x, y, TILE_SIZE, 1);
      g.fillRect(x, y, 1, TILE_SIZE);
      if (kind === 'rail-yard') {
        g.fillStyle(0x303638, 0.96);
        g.fillRect(x, y + 9, TILE_SIZE, 3);
        g.fillRect(x, y + 21, TILE_SIZE, 3);
        g.fillStyle(0x9a8060, 0.9);
        for (let px = x + 3; px < x + TILE_SIZE; px += 8) g.fillRect(px, y + 6, 2, 21);
      } else if (this.mod(hash, 3) === 0) {
        for (let px = x + 3; px < x + TILE_SIZE - 5; px += 8) {
          g.fillStyle(0xd4aa3f, 0.78);
          g.fillTriangle(px, y + 23, px + 5, y + 23, px + 8, y + 13);
        }
      }
    }
  }

  private paintPavingPattern(
    g: Phaser.GameObjects.Graphics,
    geometry: UrbanSpaceGeometry,
    visibleCells: readonly TileCell[],
    kind: 'market-lane' | 'mosque-court' | 'public-plaza' | 'courtyard' | 'cemetery',
    palette: PixelPalette,
    clip: CellRect,
  ): void {
    for (const cell of visibleCells) {
      const x = cell.x * TILE_SIZE;
      const y = cell.y * TILE_SIZE;
      g.fillStyle(this.shade(palette.paving, 0.2), 0.48);
      g.fillRect(x, y + 15, TILE_SIZE, 1);
      g.fillRect(x + 15, y, 1, TILE_SIZE);
      if (kind === 'market-lane') {
        g.fillStyle(((cell.x + cell.y) & 1) === 0 ? 0xa54a49 : 0xd3af67, 0.52);
        g.fillRect(x + 3, y + 3, TILE_SIZE - 6, 4);
      } else if (kind === 'cemetery') {
        g.fillStyle(0x665f54, 0.8);
        g.fillRect(x + 8, y + 7, 5, 13);
        g.fillRect(x + 20, y + 12, 5, 13);
      }
    }
    const rect = geometry.largestRect;
    if (!rect || (kind !== 'public-plaza' && kind !== 'mosque-court')) return;
    const centerX = rect.x * TILE_SIZE + Math.floor((rect.width * TILE_SIZE) / 2);
    const centerY = rect.y * TILE_SIZE + Math.floor((rect.height * TILE_SIZE) / 2);
    if (!this.pixelInsideCellRect(centerX, centerY, clip)) return;
    g.fillStyle(kind === 'mosque-court' ? 0x2d8582 : palette.accent, 0.76);
    g.fillRect(centerX - 13, centerY - 2, 26, 4);
    g.fillRect(centerX - 2, centerY - 13, 4, 26);
  }

  private paintLandPattern(
    g: Phaser.GameObjects.Graphics,
    cells: readonly TileCell[],
    kind: 'farmyard' | 'beach',
    signature: string,
  ): void {
    const seed = this.hashString(signature);
    for (const cell of cells) {
      const x = cell.x * TILE_SIZE;
      const y = cell.y * TILE_SIZE;
      const hash = this.hashInt(cell.x, cell.y, seed);
      if (kind === 'farmyard') {
        g.fillStyle(0x5d4933, 0.48);
        for (let py = y + 5; py < y + TILE_SIZE; py += 8) g.fillRect(x + 2, py, TILE_SIZE - 4, 2);
      } else {
        g.fillStyle(0xe4c88f, 0.38);
        g.fillRect(x + 3, y + 6 + this.mod(hash, 9), 18, 2);
        g.fillStyle(0xb59362, 0.42);
        g.fillRect(x + 12, y + 21 + this.mod(hash >>> 6, 5), 16, 1);
      }
    }
  }

  private paintOutlineRect(
    g: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    width: number,
    height: number,
    thickness: number,
    color: number,
    alpha: number,
    clip: CellRect,
  ): void {
    if (width <= 0 || height <= 0) return;
    const edge = Math.max(1, Math.min(thickness, Math.floor(Math.min(width, height) / 2)));
    this.paintClippedRect(g, x, y, width, edge, color, alpha, clip);
    this.paintClippedRect(g, x, y + height - edge, width, edge, color, alpha, clip);
    this.paintClippedRect(g, x, y, edge, height, color, alpha, clip);
    this.paintClippedRect(g, x + width - edge, y, edge, height, color, alpha, clip);
  }

  private paintClippedRect(
    g: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    width: number,
    height: number,
    color: number,
    alpha: number,
    clip: CellRect,
  ): void {
    const clipX0 = clip.x * TILE_SIZE;
    const clipY0 = clip.y * TILE_SIZE;
    const clipX1 = (clip.x + clip.width) * TILE_SIZE;
    const clipY1 = (clip.y + clip.height) * TILE_SIZE;
    const x0 = Math.max(x, clipX0);
    const y0 = Math.max(y, clipY0);
    const x1 = Math.min(x + width, clipX1);
    const y1 = Math.min(y + height, clipY1);
    if (x1 <= x0 || y1 <= y0) return;
    g.fillStyle(color, alpha);
    g.fillRect(x0, y0, x1 - x0, y1 - y0);
  }

  private cellInsideRect(cell: TileCell, rect: CellRect): boolean {
    return (
      cell.x >= rect.x &&
      cell.y >= rect.y &&
      cell.x < rect.x + rect.width &&
      cell.y < rect.y + rect.height
    );
  }

  private pixelInsideCellRect(x: number, y: number, rect: CellRect): boolean {
    return (
      x >= rect.x * TILE_SIZE &&
      y >= rect.y * TILE_SIZE &&
      x < (rect.x + rect.width) * TILE_SIZE &&
      y < (rect.y + rect.height) * TILE_SIZE
    );
  }

  private featureFitsUrbanSpace(
    feature: PlannedGroundFeature,
    occupied: ReadonlySet<string>,
  ): boolean {
    const x0 = Math.floor(feature.bounds.x);
    const y0 = Math.floor(feature.bounds.y);
    const x1 = Math.ceil(feature.bounds.x + feature.bounds.width);
    const y1 = Math.ceil(feature.bounds.y + feature.bounds.height);
    if (x1 <= x0 || y1 <= y0) return false;
    for (let ty = y0; ty < y1; ty++) {
      for (let tx = x0; tx < x1; tx++) {
        if (!occupied.has(this.key(tx, ty))) return false;
      }
    }
    return true;
  }

  private featureOwnedByChunk(feature: PlannedGroundFeature, clip: CellRect): boolean {
    const center = {
      x: Math.floor(feature.bounds.x + feature.bounds.width * 0.5),
      y: Math.floor(feature.bounds.y + feature.bounds.height * 0.5),
    };
    return this.cellInsideRect(center, clip);
  }

  private paintGroundFeature(
    ground: Phaser.GameObjects.Graphics,
    low: Phaser.GameObjects.Graphics,
    high: Phaser.GameObjects.Graphics,
    feature: PlannedGroundFeature,
    palette: PixelPalette,
  ): void {
    const x = Math.round(feature.bounds.x * TILE_SIZE);
    const y = Math.round(feature.bounds.y * TILE_SIZE);
    const width = Math.max(4, Math.round(feature.bounds.width * TILE_SIZE));
    const height = Math.max(4, Math.round(feature.bounds.height * TILE_SIZE));
    const cx = x + Math.floor(width / 2);
    const cy = y + Math.floor(height / 2);
    switch (feature.kind) {
      case 'path':
        ground.fillStyle(palette.paving, 1);
        ground.fillRect(x, y, width, height);
        ground.fillStyle(this.shade(palette.paving, 0.18), 0.5);
        ground.fillRect(x, y + Math.floor(height / 2), width, 1);
        break;
      case 'parking-bay':
      case 'loading-bay':
      case 'ambulance-bay':
      case 'police-parking':
      case 'service-marking':
        ground.lineStyle(2, feature.kind === 'ambulance-bay' ? 0xe8e8df : 0xe1d6b8, 0.85);
        ground.strokeRect(x + 2, y + 2, width - 4, height - 4);
        if (feature.kind === 'ambulance-bay') {
          ground.lineBetween(cx - 6, cy, cx + 6, cy);
          ground.lineBetween(cx, cy - 6, cx, cy + 6);
        }
        break;
      case 'fence':
      case 'wall':
      case 'gate':
        high.fillStyle(feature.kind === 'wall' ? palette.wallDark : 0x3d484b, 1);
        high.fillRect(x, y + Math.floor(height / 2) - 2, width, feature.kind === 'wall' ? 5 : 3);
        if (feature.kind !== 'wall') {
          for (let px = x + 2; px < x + width; px += 7) high.fillRect(px, y + 2, 2, height - 4);
        }
        break;
      case 'tree':
        high.fillStyle(0x48382b, 1);
        high.fillRect(cx - 2, cy, 4, Math.max(6, Math.round(height * 0.35)));
        high.fillStyle(palette.green, 1);
        high.fillCircle(cx, cy - 3, Math.max(7, Math.round(Math.min(width, height) * 0.36)));
        high.fillStyle(this.mix(palette.green, 0xa2bb72, 0.35), 1);
        high.fillCircle(cx - 4, cy - 7, Math.max(3, Math.round(Math.min(width, height) * 0.17)));
        break;
      case 'planter':
      case 'flower-bed':
        low.fillStyle(0x675a49, 1);
        low.fillRect(x + 2, y + 3, width - 4, height - 6);
        low.fillStyle(palette.green, 1);
        low.fillRect(x + 4, y + 5, width - 8, height - 10);
        low.fillStyle(0xd9a84b, 0.9);
        low.fillRect(cx - 2, cy - 2, 4, 3);
        break;
      case 'street-light':
        high.fillStyle(0x273238, 1);
        high.fillRect(cx - 1, y + 5, 3, height - 7);
        high.fillStyle(0xffd27c, 1);
        high.fillRect(cx - 5, y + 3, 10, 4);
        break;
      case 'bench':
        low.fillStyle(0x5f432f, 1);
        low.fillRect(x + 3, cy - 3, width - 6, 6);
        low.fillStyle(0x2d3438, 1);
        low.fillRect(x + 5, cy + 3, 2, 4);
        low.fillRect(x + width - 7, cy + 3, 2, 4);
        break;
      case 'trash-bin':
      case 'utility-box':
      case 'mailbox':
        low.fillStyle(
          feature.kind === 'mailbox'
            ? 0x315d82
            : feature.kind === 'trash-bin'
              ? 0x33474a
              : 0x5b6567,
          1,
        );
        {
          const boxWidth = Math.min(12, Math.round(width * 0.66));
          const boxHeight = Math.min(16, Math.round(height * 0.66));
          low.fillRect(
            cx - Math.floor(boxWidth / 2),
            cy - Math.floor(boxHeight / 2),
            boxWidth,
            boxHeight,
          );
        }
        low.fillStyle(0xaab4b2, 0.7);
        low.fillRect(cx - 4, cy - 5, 7, 1);
        break;
      case 'bike-rack':
        low.lineStyle(2, 0x465157, 1);
        for (let px = x + 5; px < x + width - 3; px += 7) low.strokeCircle(px, cy, 4);
        break;
      case 'road-sign':
        high.fillStyle(0x303b41, 1);
        high.fillRect(cx - 1, cy, 2, Math.floor(height / 2));
        high.fillStyle(0x356b86, 1);
        high.fillRect(cx - 7, y + 3, 14, 8);
        break;
      case 'fire-hydrant':
        low.fillStyle(0xb84337, 1);
        low.fillRect(cx - 4, cy - 5, 8, 11);
        low.fillRect(cx - 7, cy - 2, 14, 3);
        break;
      case 'market-stall':
        low.fillStyle(0x684532, 1);
        low.fillRect(x + 3, y + height - 5, width - 6, 4);
        for (let px = x + 2; px < x + width - 2; px += 7) {
          low.fillStyle((Math.floor(px / 7) & 1) === 0 ? 0xa64349 : 0xe0c68e, 1);
          low.fillRect(
            px,
            y + 3,
            Math.min(7, x + width - px - 2),
            Math.max(5, Math.round(height * 0.45)),
          );
        }
        break;
      case 'playground-equipment':
        low.fillStyle(0xd2a03f, 1);
        low.fillRect(cx - 7, cy - 9, 4, 18);
        low.fillStyle(0xb84b43, 1);
        low.fillTriangle(cx - 5, cy - 12, cx - 12, cy - 3, cx + 2, cy - 3);
        low.fillStyle(0x3d7390, 1);
        low.fillRect(cx + 2, cy + 3, 12, 3);
        break;
      case 'football-marking':
      case 'basketball-marking':
        ground.lineStyle(2, 0xe8e6d1, 0.84);
        ground.strokeRect(x + 2, y + 2, width - 4, height - 4);
        ground.strokeCircle(cx, cy, Math.max(4, Math.round(Math.min(width, height) * 0.22)));
        break;
      case 'plaza-fountain':
        low.fillStyle(0x354b55, 1);
        low.fillCircle(cx, cy, Math.max(7, Math.round(Math.min(width, height) * 0.4)));
        low.fillStyle(0x4d93a0, 1);
        low.fillCircle(cx, cy - 2, Math.max(4, Math.round(Math.min(width, height) * 0.3)));
        low.fillStyle(0xa4d3d2, 0.9);
        low.fillRect(cx - 2, cy - 9, 4, 9);
        break;
      case 'solar-array':
        low.fillStyle(0x172832, 1);
        low.fillRect(x + 3, y + 3, width - 6, height - 6);
        low.fillStyle(0x356379, 1);
        low.fillRect(x + 5, y + 5, width - 10, height - 10);
        low.fillStyle(0x87b1b7, 0.75);
        low.fillRect(x + 6, y + 6, width - 12, 2);
        break;
      case 'stadium-stand':
        high.fillStyle(0x555f65, 1);
        high.fillRect(x, y, width, height);
        for (let py = y + 4; py < y + height; py += 5) {
          high.fillStyle(0xa5afb0, 0.7);
          high.fillRect(x + 2, py, width - 4, 2);
        }
        break;
      case 'goal':
        low.lineStyle(2, 0xe8e6d7, 0.9);
        low.strokeRect(x + 2, y + 2, width - 4, height - 4);
        break;
    }
  }

  private spaceColor(space: PlannedUrbanSpace, palette: PixelPalette): number {
    switch (space.kind) {
      case 'garden':
      case 'park':
      case 'forest-pocket':
      case 'football-field':
      case 'stadium-field':
      case 'schoolyard':
        return palette.green;
      case 'beach':
      case 'farmyard':
        return space.cityId === 'yazd' ? 0xc89c66 : 0x8c704d;
      case 'sports-court':
      case 'playground':
        return 0xa8644b;
      case 'loading-yard':
      case 'service-yard':
      case 'rail-yard':
      case 'construction-yard':
      case 'utility-yard':
        return 0x6a6d68;
      case 'parking-lot':
      case 'police-yard':
      case 'hospital-approach':
        return 0x4b5053;
      case 'market-lane':
      case 'mosque-court':
      case 'public-plaza':
      case 'courtyard':
      case 'cemetery':
        return palette.paving;
    }
  }

  private palette(
    city: CityId,
    material: PlannedBuildingMaterial,
    signature: string,
  ): PixelPalette {
    const base = this.cityPalette(city);
    const variation = ((this.hashString(signature) >>> 0) % 13) / 100 - 0.06;
    const roof =
      variation >= 0
        ? this.mix(base.roof, base.roofLight, variation)
        : this.mix(base.roof, base.roofDark, -variation);
    if (material === 'glass') {
      return { ...base, roof: base.glass, roofAlt: base.glassLight, roofLight: base.glassLight };
    }
    if (material === 'steel') {
      return { ...base, roof: this.mix(roof, 0x69747a, 0.45), roofAlt: 0x879195 };
    }
    if (material === 'adobe') {
      return { ...base, roof: this.mix(roof, 0xc68b56, 0.66), roofAlt: 0xd6a36c };
    }
    if (material === 'wood') {
      return { ...base, roof: this.mix(roof, 0x8e523f, 0.64), roofAlt: 0xb46a4e };
    }
    return { ...base, roof };
  }

  private cityPalette(city: CityId): PixelPalette {
    return city === 'yazd' ? YAZD : city === 'gilan' ? GILAN : TEHRAN;
  }

  private mix(a: number, b: number, amount: number): number {
    const t = Phaser.Math.Clamp(amount, 0, 1);
    const ar = (a >> 16) & 0xff;
    const ag = (a >> 8) & 0xff;
    const ab = a & 0xff;
    const br = (b >> 16) & 0xff;
    const bg = (b >> 8) & 0xff;
    const bb = b & 0xff;
    return (
      (Math.round(ar + (br - ar) * t) << 16) |
      (Math.round(ag + (bg - ag) * t) << 8) |
      Math.round(ab + (bb - ab) * t)
    );
  }

  private shade(color: number, amount: number): number {
    return this.mix(color, 0x000000, amount);
  }

  private hashString(value: string): number {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index++) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return hash ^ (hash >>> 16);
  }

  private hashInt(x: number, y: number, seed: number): number {
    let hash = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ seed;
    hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
    return hash ^ (hash >>> 16);
  }

  private mod(value: number, modulus: number): number {
    return ((value % modulus) + modulus) % modulus;
  }

  private key(x: number, y: number): string {
    return `${x},${y}`;
  }
}
