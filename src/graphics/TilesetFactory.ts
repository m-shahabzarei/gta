/**
 * Generates the combined city tileset strip used by the Phaser tilemap.
 *
 * A single horizontal texture ({@link TextureKeys.CityTileset}) holds
 * {@link TILE_TYPE_COUNT} tiles of {@link TILE_SIZE}² pixels each, laid out
 * left-to-right in {@link TileType} index order so a tile's enum value doubles
 * as its frame index into the tileset. Consumers register this texture as a
 * tilemap tileset with `tileWidth = tileHeight = TILE_SIZE`.
 *
 * All speckle/ripple randomness flows through a seeded {@link Random} so the
 * generated art is byte-for-byte deterministic across runs.
 */
import Phaser from 'phaser';
import { TextureKeys } from '@/config/AssetKeys';
import { TILE_SIZE } from '@/config/Constants';
import { TILE_TYPE_COUNT, TileType } from '@/gameplay/types';
import { PALETTE, shade, tintUp } from '@/graphics/palette';
import { Random } from '@/utils/Random';

/** Draws the procedural city tileset strip into the scene's texture manager. */
export class TilesetFactory {
  /** Seeded RNG for deterministic speckle placement. */
  private readonly rng = new Random(0x7115e7);

  /** @param scene A live scene whose texture manager receives the tileset. */
  constructor(private readonly scene: Phaser.Scene) {}

  /**
   * Generate the {@link TextureKeys.CityTileset} strip. Skips generation if the
   * texture already exists (e.g. real art was loaded under the same key).
   */
  public generateAll(): void {
    if (this.scene.textures.exists(TextureKeys.CityTileset)) return;
    this.rng.setSeed(0x7115e7);
    const width = TILE_SIZE * TILE_TYPE_COUNT;
    const g = this.scene.make.graphics({ x: 0, y: 0 }, false);
    this.drawTile(g, TileType.Grass);
    this.drawTile(g, TileType.Road);
    this.drawTile(g, TileType.RoadLineH);
    this.drawTile(g, TileType.RoadLineV);
    this.drawTile(g, TileType.Sidewalk);
    this.drawTile(g, TileType.Water);
    this.drawTile(g, TileType.Building);
    this.drawTile(g, TileType.Crossing);
    this.drawTile(g, TileType.Sand);
    this.drawTile(g, TileType.Dirt);
    this.drawTile(g, TileType.Rock);
    this.drawTile(g, TileType.Concrete);
    this.drawTile(g, TileType.Runway);
    this.drawTile(g, TileType.BuildingRes);
    this.drawTile(g, TileType.BuildingInd);
    this.drawTile(g, TileType.Dock);
    this.drawTile(g, TileType.InteriorFloor);
    this.drawTile(g, TileType.InteriorWall);
    this.drawTile(g, TileType.InteriorDoor);
    this.drawTile(g, TileType.UrbanFixture);
    g.generateTexture(TextureKeys.CityTileset, width, TILE_SIZE);
    g.destroy();
  }

  /** Dispatch to the per-type painter, offsetting to the tile's strip cell. */
  private drawTile(g: Phaser.GameObjects.Graphics, type: TileType): void {
    const ox = type * TILE_SIZE;
    switch (type) {
      case TileType.Grass:
        this.grass(g, ox);
        break;
      case TileType.Road:
        this.road(g, ox);
        break;
      case TileType.RoadLineH:
        this.roadLineH(g, ox);
        break;
      case TileType.RoadLineV:
        this.roadLineV(g, ox);
        break;
      case TileType.Sidewalk:
        this.sidewalk(g, ox);
        break;
      case TileType.Water:
        this.water(g, ox);
        break;
      case TileType.Building:
        this.building(g, ox);
        break;
      case TileType.Crossing:
        this.crossing(g, ox);
        break;
      case TileType.Sand:
        this.sand(g, ox);
        break;
      case TileType.Dirt:
        this.dirt(g, ox);
        break;
      case TileType.Rock:
        this.rock(g, ox);
        break;
      case TileType.Concrete:
        this.concrete(g, ox);
        break;
      case TileType.Runway:
        this.runway(g, ox);
        break;
      case TileType.BuildingRes:
        this.buildingRes(g, ox);
        break;
      case TileType.BuildingInd:
        this.buildingInd(g, ox);
        break;
      case TileType.Dock:
        this.dock(g, ox);
        break;
      case TileType.InteriorFloor:
        this.interiorFloor(g, ox);
        break;
      case TileType.InteriorWall:
        this.interiorWall(g, ox);
        break;
      case TileType.InteriorDoor:
        this.interiorDoor(g, ox);
        break;
      case TileType.UrbanFixture:
        // Deliberately blank: ArchitectureComposer owns the visible fixture and ground art.
        break;
    }
  }

  /** Fill the tile cell at `ox` with a flat base colour. */
  private base(g: Phaser.GameObjects.Graphics, ox: number, color: number): void {
    g.fillStyle(color, 1);
    g.fillRect(ox, 0, TILE_SIZE, TILE_SIZE);
  }

  /** Scatter deterministic single-pixel specks within the tile cell at `ox`. */
  private speckle(
    g: Phaser.GameObjects.Graphics,
    ox: number,
    tints: readonly number[],
    count: number,
  ): void {
    for (let i = 0; i < count; i++) {
      const color = tints[this.rng.intRange(0, tints.length - 1)] ?? 0xffffff;
      g.fillStyle(color, 1);
      g.fillRect(ox + this.rng.intRange(0, TILE_SIZE - 1), this.rng.intRange(0, TILE_SIZE - 1), 1, 1);
    }
  }

  /** Grass: restrained clusters and worn soil, never uniform television noise. */
  private grass(g: Phaser.GameObjects.Graphics, ox: number): void {
    this.base(g, ox, PALETTE.grass);
    g.fillStyle(PALETTE.grassDark, 0.7);
    g.fillRect(ox + 3, 7, 6, 3);
    g.fillRect(ox + 21, 22, 7, 3);
    g.fillStyle(PALETTE.grassLight, 0.85);
    const blades: readonly (readonly [number, number])[] = [
      [5, 5],
      [13, 18],
      [17, 7],
      [25, 16],
      [8, 26],
    ];
    for (const [x, y] of blades) {
      g.fillRect(ox + x, y, 1, 4);
      g.fillRect(ox + x + 1, y + 1, 1, 2);
    }
    this.speckle(g, ox, [shade(PALETTE.grass, 0.12), PALETTE.grassLight], 10);
  }

  /** Bare asphalt: broad aggregate patches plus sparse grit. */
  private road(g: Phaser.GameObjects.Graphics, ox: number): void {
    this.base(g, ox, PALETTE.road);
    g.fillStyle(PALETTE.roadDark, 0.35);
    g.fillRect(ox + 2, 5, 10, 4);
    g.fillRect(ox + 20, 20, 9, 5);
    g.fillStyle(PALETTE.roadLight, 0.28);
    g.fillRect(ox + 7, 25, 7, 3);
    g.fillRect(ox + 22, 7, 6, 3);
    this.speckle(g, ox, [PALETTE.roadDark, PALETTE.roadLight], 11);
  }

  /** Road with a dashed horizontal centre line running east–west. */
  private roadLineH(g: Phaser.GameObjects.Graphics, ox: number): void {
    this.road(g, ox);
    const y = TILE_SIZE / 2 - 1;
    const dash = 5;
    const gap = 4;
    g.fillStyle(PALETTE.line, 0.9);
    for (let x = 2; x < TILE_SIZE - 2; x += dash + gap) {
      const w = Math.min(dash, TILE_SIZE - 2 - x);
      g.fillRect(ox + x, y, w, 2);
    }
    g.fillStyle(shade(PALETTE.line, 0.25), 0.75);
    g.fillRect(ox + 11, y, 2, 2);
  }

  /** Road with a dashed vertical centre line running north–south. */
  private roadLineV(g: Phaser.GameObjects.Graphics, ox: number): void {
    this.road(g, ox);
    const x = TILE_SIZE / 2 - 1;
    const dash = 5;
    const gap = 4;
    g.fillStyle(PALETTE.line, 0.9);
    for (let y = 2; y < TILE_SIZE - 2; y += dash + gap) {
      const h = Math.min(dash, TILE_SIZE - 2 - y);
      g.fillRect(ox + x, y, 2, h);
    }
    g.fillStyle(shade(PALETTE.line, 0.25), 0.75);
    g.fillRect(ox + x, 20, 2, 2);
  }

  /** Sidewalk: irregular staggered paving with small repaired chips. */
  private sidewalk(g: Phaser.GameObjects.Graphics, ox: number): void {
    this.base(g, ox, PALETTE.sidewalk);
    g.fillStyle(PALETTE.sidewalkDark, 0.62);
    for (let y = 7; y < TILE_SIZE; y += 8) g.fillRect(ox, y, TILE_SIZE, 1);
    for (let y = 0; y < TILE_SIZE; y += 8) {
      const offset = (Math.floor(y / 8) % 2) * 5;
      for (let x = 10 - offset; x < TILE_SIZE; x += 10) g.fillRect(ox + x, y, 1, 7);
    }
    g.fillStyle(tintUp(PALETTE.sidewalk, 0.12), 0.5);
    g.fillRect(ox + 2, 1, 6, 2);
    g.fillRect(ox + 18, 17, 8, 2);
    g.fillStyle(shade(PALETTE.sidewalk, 0.2), 0.55);
    g.fillRect(ox + 11, 25, 5, 3);
    g.lineStyle(1, shade(PALETTE.sidewalkDark, 0.12), 0.8);
    g.strokeRect(ox + 0.5, 0.5, TILE_SIZE - 1, TILE_SIZE - 1);
  }

  /** Water: deep blue base with horizontal highlight ripples. */
  private water(g: Phaser.GameObjects.Graphics, ox: number): void {
    this.base(g, ox, PALETTE.water);
    g.fillStyle(shade(PALETTE.water, 0.18), 0.55);
    g.fillRect(ox + 2, 9, 14, 2);
    g.fillRect(ox + 18, 24, 12, 2);
    g.fillStyle(PALETTE.waterLight, 0.72);
    g.fillRect(ox + 4, 5, 11, 2);
    g.fillRect(ox + 18, 5, 8, 2);
    g.fillRect(ox + 10, 17, 15, 2);
    g.fillRect(ox + 2, 27, 9, 1);
    g.fillStyle(tintUp(PALETTE.waterLight, 0.28), 0.45);
    g.fillRect(ox + 12, 16, 7, 1);
  }

  /**
   * Neutral structural pad for a generic building collision tile.
   *
   * Real roofs and walls are rendered exclusively by ArchitectureComposer.
   * Keeping this frame visually neutral lets the tile retain its authoritative
   * collision index without ever masquerading as a complete building.
   */
  private building(g: Phaser.GameObjects.Graphics, ox: number): void {
    this.foundation(g, ox, PALETTE.concrete, PALETTE.concreteDark);
  }

  /** Crossing: asphalt overlaid with white zebra stripes. */
  private crossing(g: Phaser.GameObjects.Graphics, ox: number): void {
    this.road(g, ox);
    g.fillStyle(0xe8e4d5, 0.88);
    const stripe = 3;
    const gap = 3;
    for (let x = 2; x + stripe <= TILE_SIZE - 2; x += stripe + gap) {
      g.fillRect(ox + x, 3, stripe, TILE_SIZE - 6);
    }
    // A couple of worn chips keep crossings from reading as a perfect barcode.
    g.fillStyle(PALETTE.road, 0.8);
    g.fillRect(ox + 8, 8, 2, 5);
    g.fillRect(ox + 20, 21, 3, 4);
  }

  /** Sand: warm base with rippled darker wind lines. */
  private sand(g: Phaser.GameObjects.Graphics, ox: number): void {
    this.base(g, ox, PALETTE.sand);
    this.speckle(g, ox, [PALETTE.sandDark, 0xe0c88a], 12);
    g.fillStyle(PALETTE.sandDark, 0.55);
    for (let y = 6; y < TILE_SIZE; y += 11) {
      const inset = this.rng.intRange(1, 6);
      g.fillRect(ox + inset, y, Math.max(7, TILE_SIZE - inset * 2 - y / 3), 1);
    }
  }

  /** Dirt: ploughed farmland with row furrows. */
  private dirt(g: Phaser.GameObjects.Graphics, ox: number): void {
    this.base(g, ox, PALETTE.dirt);
    g.fillStyle(PALETTE.dirtDark, 0.82);
    for (let x = 3; x < TILE_SIZE; x += 7) {
      g.fillRect(ox + x, 0, 2, TILE_SIZE);
    }
    g.fillStyle(0x9d7650, 0.7);
    for (let x = 5; x < TILE_SIZE; x += 7) g.fillRect(ox + x, 3, 1, TILE_SIZE - 6);
    this.speckle(g, ox, [PALETTE.dirtDark, 0xa37b52], 10);
  }

  /** Rock: impassable stone with faceted highlights (solid). */
  private rock(g: Phaser.GameObjects.Graphics, ox: number): void {
    this.base(g, ox, PALETTE.rock);
    g.fillStyle(PALETTE.rockDark, 1);
    g.fillTriangle(ox + 2, 10, ox + 12, 3, ox + 14, 14);
    g.fillTriangle(ox + 14, 24, ox + 26, 16, ox + 28, 29);
    g.fillStyle(shade(PALETTE.rockDark, 0.25), 1);
    g.fillTriangle(ox + 18, 4, ox + 28, 8, ox + 22, 13);
    g.fillStyle(0x84807c, 1);
    g.fillTriangle(ox + 4, 22, ox + 12, 18, ox + 10, 28);
    this.speckle(g, ox, [PALETTE.rockDark, 0x84807c], 20);
    // Dark seam edges so adjacent rock reads as one massif.
    g.fillStyle(PALETTE.rockDark, 0.6);
    g.fillRect(ox, 0, TILE_SIZE, 1);
    g.fillRect(ox, TILE_SIZE - 1, TILE_SIZE, 1);
  }

  /** Concrete: poured slabs with expansion seams (airport/harbor pads). */
  private concrete(g: Phaser.GameObjects.Graphics, ox: number): void {
    this.base(g, ox, PALETTE.concrete);
    this.speckle(g, ox, [PALETTE.concreteDark, 0xa7a7a0], 9);
    g.fillStyle(PALETTE.concreteDark, 0.45);
    g.fillRect(ox + 17, 0, 1, TILE_SIZE);
    g.fillRect(ox, 20, TILE_SIZE, 1);
    g.fillStyle(shade(PALETTE.concrete, 0.18), 0.45);
    g.fillRect(ox + 5, 6, 8, 3);
    g.lineStyle(1, PALETTE.concreteDark, 0.72);
    g.strokeRect(ox + 0.5, 0.5, TILE_SIZE - 1, TILE_SIZE - 1);
  }

  /** Runway: dark asphalt with a bold white centreline dash. */
  private runway(g: Phaser.GameObjects.Graphics, ox: number): void {
    this.base(g, ox, PALETTE.runway);
    this.speckle(g, ox, [shade(PALETTE.runway, 0.3), 0x454750], 9);
    g.fillStyle(0xe7e5d9, 0.88);
    g.fillRect(ox + TILE_SIZE / 2 - 2, 3, 4, 21);
    g.fillStyle(PALETTE.runway, 0.75);
    g.fillRect(ox + TILE_SIZE / 2 - 2, 12, 4, 5);
  }

  /** Neutral warm foundation pad for residential collision tiles. */
  private buildingRes(g: Phaser.GameObjects.Graphics, ox: number): void {
    this.foundation(g, ox, 0x978c7d, 0x71685e);
  }

  /** Neutral heavy-duty slab for industrial collision tiles. */
  private buildingInd(g: Phaser.GameObjects.Graphics, ox: number): void {
    this.foundation(g, ox, 0x686d6c, 0x4b504f);
    g.fillStyle(0xc69a38, 0.42);
    g.fillRect(ox + 3, 27, 6, 2);
    g.fillRect(ox + 13, 27, 6, 2);
    g.fillRect(ox + 23, 27, 6, 2);
  }

  /**
   * Foundation-only art shared by all solid building tile families. It has no
   * parapet, roof ridge, wall face, cast shadow or rooftop equipment, so it can
   * never read as a painted building when an architectural module is absent.
   */
  private foundation(
    g: Phaser.GameObjects.Graphics,
    ox: number,
    baseColor: number,
    seamColor: number,
  ): void {
    this.base(g, ox, baseColor);
    g.fillStyle(seamColor, 0.5);
    g.fillRect(ox, 0, TILE_SIZE, 1);
    g.fillRect(ox, TILE_SIZE - 1, TILE_SIZE, 1);
    g.fillStyle(tintUp(baseColor, 0.1), 0.34);
    g.fillRect(ox + 2, 2, TILE_SIZE - 4, 1);
    g.fillStyle(seamColor, 0.24);
    g.fillRect(ox + 15, 1, 1, TILE_SIZE - 2);
    g.fillRect(ox + 1, 15, TILE_SIZE - 2, 1);
  }

  /** Dock: weathered wooden planks over the harbor water. */
  private dock(g: Phaser.GameObjects.Graphics, ox: number): void {
    this.base(g, ox, PALETTE.dockWood);
    g.fillStyle(PALETTE.dockWoodDark, 1);
    for (let y = 0; y < TILE_SIZE; y += 6) {
      g.fillRect(ox, y, TILE_SIZE, 1);
    }
    // Plank ends staggered.
    for (let y = 0; y < TILE_SIZE; y += 6) {
      const px = this.rng.intRange(6, TILE_SIZE - 6);
      g.fillRect(ox + px, y + 1, 1, 5);
    }
    g.fillStyle(0x30241b, 0.8);
    for (let y = 3; y < TILE_SIZE; y += 12) {
      g.fillRect(ox + 3, y, 1, 1);
      g.fillRect(ox + 27, y + 5, 1, 1);
    }
    this.speckle(g, ox, [PALETTE.dockWoodDark, shade(PALETTE.dockWood, 0.15)], 7);
  }

  /** Interior floor: muted terrazzo slabs that match the city pixel style. */
  private interiorFloor(g: Phaser.GameObjects.Graphics, ox: number): void {
    const base = 0x59626d;
    this.base(g, ox, base);
    this.speckle(g, ox, [0x4d5661, 0x6b7480, 0x77818d], 10);
    g.lineStyle(1, 0x444c56, 0.75);
    g.strokeRect(ox + 0.5, 0.5, TILE_SIZE - 1, TILE_SIZE - 1);
    g.fillStyle(0xffffff, 0.05);
    g.fillRect(ox + 2, 2, TILE_SIZE - 4, 1);
  }

  /** Interior wall: dark structural wall with a slight top-edge highlight. */
  private interiorWall(g: Phaser.GameObjects.Graphics, ox: number): void {
    this.base(g, ox, 0x171c25);
    g.fillStyle(0x0b0f16, 1);
    g.fillRect(ox, TILE_SIZE - 4, TILE_SIZE, 4);
    g.fillStyle(0x2f3744, 1);
    g.fillRect(ox + 2, 2, TILE_SIZE - 4, 2);
    this.speckle(g, ox, [0x232b36, 0x0f141c], 12);
  }

  /** Door threshold: walkable but visibly different from floor. */
  private interiorDoor(g: Phaser.GameObjects.Graphics, ox: number): void {
    this.interiorFloor(g, ox);
    g.fillStyle(0x3d2a1c, 1);
    g.fillRect(ox + 5, 4, TILE_SIZE - 10, TILE_SIZE - 8);
    g.fillStyle(0x8a5a33, 1);
    g.fillRect(ox + 7, 5, TILE_SIZE - 14, TILE_SIZE - 10);
    g.fillStyle(0xe8c56a, 1);
    g.fillCircle(ox + TILE_SIZE - 10, TILE_SIZE / 2, 1.5);
  }
}
