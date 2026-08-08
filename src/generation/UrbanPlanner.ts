/**
 * Deterministic urban planning pass.
 *
 * Roads are authored as a graph before a single road or building tile is
 * painted. Variable axis spacing creates short/long blocks; all omitted grid
 * links end at another road; degree-one branches carry an explicit terminal.
 */
import { TILE_SIZE } from '@/config/Constants';
import { District } from '@/gameplay/types';
import type {
  CityId,
  HighwayRoute,
  PlannedBlockProgram,
  PlannedIntersection,
  PlannedIntersectionDesign,
  PlannedLandUse,
  PlannedRoadHierarchy,
  PlannedRoadSegment,
  PlannedRoadTerminalKind,
  PlannedTilePoint,
  PlannedUrbanBlock,
  UrbanQualityReport,
  WorldCity,
} from '@/gameplay/types';

/**
 * Road-first handoff. Blocks contain zoning, density, form, bounds, and city
 * identity, but deliberately contain no implied building occupancy; the pure
 * architecture grammar is the only consumer allowed to turn them into lots.
 */
export interface RoadPlanningResult {
  roads: PlannedRoadSegment[];
  intersections: PlannedIntersection[];
  blocks: PlannedUrbanBlock[];
  quality: UrbanQualityReport;
}

interface Axis {
  tile: number;
  hierarchy: 'primary' | 'secondary' | 'residential';
  halfWidth: number;
}

interface CityGrid {
  city: WorldCity;
  xAxes: Axis[];
  yAxes: Axis[];
}

type BlockSide = 'top' | 'right' | 'bottom' | 'left';

interface GridLinkCandidate {
  segment: PlannedRoadSegment;
  adjacentCellKeys: string[];
}

interface ParcelCell {
  xi: number;
  yi: number;
  left: Axis;
  right: Axis;
  top: Axis;
  bottom: Axis;
}

const HIERARCHY_RANK: Record<PlannedRoadHierarchy, number> = {
  highway: 6,
  primary: 5,
  secondary: 4,
  residential: 3,
  alley: 2,
  access: 1,
};

const HIERARCHIES: readonly PlannedRoadHierarchy[] = [
  'highway',
  'primary',
  'secondary',
  'residential',
  'alley',
  'access',
];

/** Traffic routing ignores edges at or below 126 px (just under four tiles). */
const MIN_ROUTABLE_EDGE_TILES = 5;

export class UrbanPlanner {
  private readonly segments = new Map<string, PlannedRoadSegment>();
  private readonly grids: CityGrid[] = [];
  private readonly branchedBlocks = new Set<string>();
  private readonly mergedParcelCells = new Set<string>();
  private readonly highwayConnectionKeys: ReadonlySet<string>;
  private regeneratedBlocks = 0;

  private constructor(
    private readonly seed: number,
    private readonly cities: readonly WorldCity[],
    private readonly highways: readonly HighwayRoute[],
    private readonly highwayRoads: readonly PlannedRoadSegment[],
    private readonly period: number,
    private readonly roadMid: number,
    private readonly districtAt: (tx: number, ty: number) => District,
  ) {
    this.highwayConnectionKeys = new Set(
      highways.flatMap((highway) =>
        highway.interchanges.flatMap((interchange) =>
          interchange.cityConnections.map((connection) =>
            this.pointKey(this.worldToTile(connection)),
          ),
        ),
      ),
    );
  }

  public static generate(
    seed: number,
    cities: readonly WorldCity[],
    highways: readonly HighwayRoute[],
    highwayRoads: readonly PlannedRoadSegment[],
    period: number,
    roadMid: number,
    districtAt: (tx: number, ty: number) => District,
  ): RoadPlanningResult {
    return new UrbanPlanner(
      seed,
      cities,
      highways,
      highwayRoads,
      period,
      roadMid,
      districtAt,
    ).build();
  }

  private build(): RoadPlanningResult {
    const anchors = this.highwayAnchors();
    for (const city of this.cities) {
      const grid = this.planCityGrid(city, anchors.get(city.id) ?? []);
      this.grids.push(grid);
      this.addGridRoads(grid);
      this.addDesignedBranches(grid);
      this.addDiagonalConnectors(grid);
    }
    this.addHighwayPlan();
    this.pruneUnintentionalLocalStubs();

    const roads = Array.from(this.segments.values());
    const intersections = this.deriveIntersections(roads);
    // Finalize road-owned parcel bounds before architecture sees any block.
    // Keeping this pass building-free prevents sidewalks and access roads from
    // being retrofitted around already-rasterized structures.
    const blocks = this.deriveBlocks();
    const quality = this.validate(roads, intersections, blocks);
    return { roads, intersections, blocks, quality };
  }

  private highwayAnchors(): Map<CityId, PlannedTilePoint[]> {
    const result = new Map<CityId, PlannedTilePoint[]>();
    for (const highway of this.highways) {
      for (const interchange of highway.interchanges) {
        const list = result.get(interchange.cityId) ?? [];
        for (const connection of interchange.cityConnections) {
          list.push(this.worldToTile(connection));
        }
        result.set(interchange.cityId, list);
      }
    }
    return result;
  }

  private planCityGrid(city: WorldCity, anchors: readonly PlannedTilePoint[]): CityGrid {
    const bounds = {
      x: Math.floor(city.bounds.x / TILE_SIZE),
      y: Math.floor(city.bounds.y / TILE_SIZE),
      width: Math.floor(city.bounds.width / TILE_SIZE),
      height: Math.floor(city.bounds.height / TILE_SIZE),
    };
    const xAnchors = anchors.map((point) => point.x);
    const yAnchors = anchors.map((point) => point.y);
    const xAxes = this.makeAxes(city.id, 'x', bounds.x, bounds.x + bounds.width - 1, xAnchors);
    const yAxes = this.makeAxes(city.id, 'y', bounds.y, bounds.y + bounds.height - 1, yAnchors);
    return {
      city,
      xAxes,
      yAxes,
    };
  }

  private makeAxes(
    city: CityId,
    dimension: 'x' | 'y',
    minimum: number,
    maximum: number,
    anchorTiles: readonly number[],
  ): Axis[] {
    const minBand = Math.ceil((minimum - this.roadMid) / this.period);
    const maxBand = Math.floor((maximum - this.roadMid) / this.period);
    const bands = new Set<number>([minBand, maxBand]);
    for (const tile of anchorTiles) {
      const band = Math.round((tile - this.roadMid) / this.period);
      if (band >= minBand && band <= maxBand) bands.add(band);
    }

    let cursor = minBand;
    let ordinal = 0;
    while (cursor < maxBand) {
      const h = this.hash(
        cursor + (dimension === 'x' ? 71 : 193),
        ordinal + (city === 'tehran' ? 11 : city === 'gilan' ? 29 : 47),
        this.seed,
      );
      // One period is twelve tiles, so these distributions produce compact
      // walkable blocks without creating traffic edges below the routing limit.
      // Tehran is tightest; Gilan and Yazd retain slightly longer local rhythms.
      const step =
        city === 'tehran'
          ? h < 0.45
            ? 1
            : h < 0.9
              ? 2
              : 3
          : city === 'gilan'
            ? h < 0.3
              ? 1
              : h < 0.75
                ? 2
                : 3
            : h < 0.25
              ? 1
              : h < 0.65
                ? 2
                : 3;
      cursor = Math.min(maxBand, cursor + step);
      bands.add(cursor);
      ordinal++;
    }

    const anchorBands = new Set(
      anchorTiles.map((tile) => Math.round((tile - this.roadMid) / this.period)),
    );
    return Array.from(bands)
      .sort((a, b) => a - b)
      .map((band, index, all): Axis => {
        const boundary = index === 0 || index === all.length - 1;
        const hierarchy: Axis['hierarchy'] =
          anchorBands.has(band) || index % 7 === 3
            ? 'primary'
            : boundary || index % 3 === 0
              ? 'secondary'
              : 'residential';
        return {
          tile: band * this.period + this.roadMid,
          hierarchy,
          halfWidth: hierarchy === 'primary' ? 2 : 1,
        };
      });
  }

  private addGridRoads(grid: CityGrid): void {
    const { city, xAxes, yAxes } = grid;
    const removable: GridLinkCandidate[] = [];
    for (let yi = 0; yi < yAxes.length; yi++) {
      const yAxis = yAxes[yi];
      if (!yAxis) continue;
      for (let xi = 1; xi < xAxes.length; xi++) {
        const left = xAxes[xi - 1];
        const right = xAxes[xi];
        if (!left || !right) continue;
        const profile = this.roadProfileFor(
          yAxis,
          this.districtAt(Math.floor((left.tile + right.tile) / 2), yAxis.tile),
          xi,
          yi,
          'horizontal',
        );
        const segment: PlannedRoadSegment = {
          id: `${city.id}:h:${yAxis.tile}:${left.tile}-${right.tile}`,
          from: { x: left.tile, y: yAxis.tile },
          to: { x: right.tile, y: yAxis.tile },
          hierarchy: profile.hierarchy,
          halfWidth: profile.halfWidth,
          cityId: city.id,
        };
        const adjacentCellKeys = this.adjacentParcelCellKeys(
          city.id,
          'horizontal',
          xi,
          yi,
          xAxes.length,
          yAxes.length,
        );
        if (this.crossesAuthoredHighway(segment)) {
          for (const cellKey of adjacentCellKeys) this.mergedParcelCells.add(cellKey);
          continue;
        }
        this.addSegment(segment);
        if (!this.keepGridLink(city.id, yAxis, left, right, xi, yi, 'horizontal')) {
          removable.push({ segment, adjacentCellKeys });
        }
      }
    }
    for (let xi = 0; xi < xAxes.length; xi++) {
      const xAxis = xAxes[xi];
      if (!xAxis) continue;
      for (let yi = 1; yi < yAxes.length; yi++) {
        const top = yAxes[yi - 1];
        const bottom = yAxes[yi];
        if (!top || !bottom) continue;
        const profile = this.roadProfileFor(
          xAxis,
          this.districtAt(xAxis.tile, Math.floor((top.tile + bottom.tile) / 2)),
          xi,
          yi,
          'vertical',
        );
        const segment: PlannedRoadSegment = {
          id: `${city.id}:v:${xAxis.tile}:${top.tile}-${bottom.tile}`,
          from: { x: xAxis.tile, y: top.tile },
          to: { x: xAxis.tile, y: bottom.tile },
          hierarchy: profile.hierarchy,
          halfWidth: profile.halfWidth,
          cityId: city.id,
        };
        const adjacentCellKeys = this.adjacentParcelCellKeys(
          city.id,
          'vertical',
          xi,
          yi,
          xAxes.length,
          yAxes.length,
        );
        if (this.crossesAuthoredHighway(segment)) {
          for (const cellKey of adjacentCellKeys) this.mergedParcelCells.add(cellKey);
          continue;
        }
        this.addSegment(segment);
        if (!this.keepGridLink(city.id, xAxis, top, bottom, xi, yi, 'vertical')) {
          removable.push({ segment, adjacentCellKeys });
        }
      }
    }

    // Begin with a complete road graph, then accept a merged-block opening
    // only when it cannot strand a node or disconnect the city's network.
    // This makes topology an invariant of generation rather than a validation
    // failure that is discovered after rasterisation.
    for (const candidate of removable) this.tryRemoveGridLink(candidate);
  }

  private tryRemoveGridLink(candidate: GridLinkCandidate): void {
    if (candidate.adjacentCellKeys.some((key) => this.mergedParcelCells.has(key))) return;

    const { segment } = candidate;
    const key = this.segmentKey(segment.from, segment.to);
    const accepted = this.segments.get(key);
    if (!accepted || accepted.id !== segment.id || !segment.cityId) return;

    const degrees = this.pointDegrees(segment.cityId);
    const fromDegree = degrees.get(this.pointKey(segment.from)) ?? 0;
    const toDegree = degrees.get(this.pointKey(segment.to)) ?? 0;
    if (fromDegree <= 2 || toDegree <= 2) return;

    this.segments.delete(key);
    if (!this.cityRoadsConnected(segment.cityId)) {
      this.segments.set(key, accepted);
      return;
    }
    for (const cellKey of candidate.adjacentCellKeys) this.mergedParcelCells.add(cellKey);
  }

  private adjacentParcelCellKeys(
    cityId: CityId,
    orientation: 'horizontal' | 'vertical',
    xi: number,
    yi: number,
    xAxisCount: number,
    yAxisCount: number,
  ): string[] {
    if (orientation === 'horizontal') {
      if (yi <= 0 || yi >= yAxisCount - 1) return [];
      return [`${cityId}:${xi}:${yi}`, `${cityId}:${xi}:${yi + 1}`];
    }
    if (xi <= 0 || xi >= xAxisCount - 1) return [];
    return [`${cityId}:${xi}:${yi}`, `${cityId}:${xi + 1}:${yi}`];
  }

  private pointDegrees(cityId: CityId): Map<string, number> {
    const degrees = new Map<string, number>();
    for (const road of this.segments.values()) {
      if (road.cityId !== cityId) continue;
      const from = this.pointKey(road.from);
      const to = this.pointKey(road.to);
      degrees.set(from, (degrees.get(from) ?? 0) + 1);
      degrees.set(to, (degrees.get(to) ?? 0) + 1);
    }
    return degrees;
  }

  private cityRoadsConnected(cityId: CityId): boolean {
    const roads = Array.from(this.segments.values()).filter((road) => road.cityId === cityId);
    if (roads.length === 0) return false;
    const nodeCount = new Set(
      roads.flatMap((road) => [this.pointKey(road.from), this.pointKey(road.to)]),
    ).size;
    return this.connectedPointCount(roads) === nodeCount;
  }

  private keepGridLink(
    city: CityId,
    line: Axis,
    first: Axis,
    second: Axis,
    xi: number,
    yi: number,
    orientation: 'horizontal' | 'vertical',
  ): boolean {
    if (line.hierarchy !== 'residential') return true;
    if (first.hierarchy === 'primary' || second.hierarchy === 'primary') return true;
    const citySalt = city === 'tehran' ? 0x17 : city === 'gilan' ? 0x37 : 0x59;
    const roll = this.hash(
      xi * 13 + citySalt,
      yi * 19 + (orientation === 'horizontal' ? 3 : 7),
      this.seed,
    );
    // A missing link merges two parcels. Both remaining ends meet perpendicular
    // roads, producing intentional T-junctions rather than orphan asphalt.
    return roll >= (city === 'tehran' ? 0.05 : city === 'gilan' ? 0.07 : 0.08);
  }

  /** Let local district character refine the global avenue lattice. */
  private roadProfileFor(
    axis: Axis,
    district: District,
    xi: number,
    yi: number,
    orientation: 'horizontal' | 'vertical',
  ): Pick<PlannedRoadSegment, 'hierarchy' | 'halfWidth'> {
    let hierarchy: PlannedRoadHierarchy = axis.hierarchy;
    const roll = this.hash(
      xi * 31 + (orientation === 'horizontal' ? 7 : 19),
      yi * 43 + district.length,
      this.seed ^ 0x5a17,
    );

    if (axis.hierarchy !== 'primary') {
      if (
        district === District.Downtown ||
        district === District.Commercial ||
        district === District.Government
      ) {
        hierarchy = axis.hierarchy === 'secondary' || roll < 0.34 ? 'secondary' : 'residential';
      } else if (
        district === District.Historic ||
        district === District.Bazaar ||
        district === District.OldTown ||
        district === District.Village
      ) {
        hierarchy = axis.hierarchy === 'secondary' ? 'residential' : 'alley';
      } else if (
        district === District.Industrial ||
        district === District.Mining ||
        district === District.Harbor ||
        district === District.Marina ||
        district === District.Airport
      ) {
        hierarchy = axis.hierarchy === 'secondary' ? 'secondary' : 'access';
      } else if (district === District.University && roll < 0.28) {
        hierarchy = 'secondary';
      }
    }

    return {
      hierarchy,
      halfWidth:
        hierarchy === 'primary' ? 2 : hierarchy === 'alley' || hierarchy === 'access' ? 0 : 1,
    };
  }

  private addDesignedBranches(grid: CityGrid): void {
    const { city, xAxes, yAxes } = grid;
    for (let yi = 1; yi < yAxes.length; yi++) {
      const top = yAxes[yi - 1];
      const bottom = yAxes[yi];
      if (!top || !bottom) continue;
      for (let xi = 1; xi < xAxes.length; xi++) {
        const left = xAxes[xi - 1];
        const right = xAxes[xi];
        if (!left || !right) continue;
        const width = right.tile - left.tile;
        const height = bottom.tile - top.tile;
        if (width < 18 || height < 18) continue;
        const roll = this.hash(xi + left.tile, yi + top.tile, this.seed ^ 0x71ac);
        if (roll > (city.id === 'tehran' ? 0.22 : 0.17)) continue;

        const district = this.districtAt(
          Math.floor((left.tile + right.tile) / 2),
          Math.floor((top.tile + bottom.tile) / 2),
        );
        const hierarchy: PlannedRoadHierarchy =
          district === District.Industrial || district === District.Mining ? 'access' : 'alley';
        const terminal = this.terminalFor(district, xi + yi);
        this.attachDesignedBranch(
          grid,
          xi,
          yi,
          left,
          right,
          top,
          bottom,
          hierarchy,
          terminal,
          roll,
        );
      }
    }
  }

  private attachDesignedBranch(
    grid: CityGrid,
    xi: number,
    yi: number,
    left: Axis,
    right: Axis,
    top: Axis,
    bottom: Axis,
    hierarchy: PlannedRoadHierarchy,
    terminal: PlannedRoadTerminalKind,
    roll: number,
  ): void {
    const width = right.tile - left.tile;
    const height = bottom.tile - top.tile;
    const preferred: BlockSide[] =
      width >= height ? ['top', 'bottom', 'left', 'right'] : ['left', 'right', 'top', 'bottom'];
    if ((this.hashInt(xi, yi, this.seed ^ 0xb12a) & 1) !== 0) {
      [preferred[0], preferred[1]] = [preferred[1] ?? preferred[0]!, preferred[0]!];
    }

    for (const side of preferred) {
      const attachment = this.branchAttachment(side, left, right, top, bottom, xi, yi);
      if (this.highwayConnectionKeys.has(this.pointKey(attachment))) continue;
      const boundary = this.findBoundarySegment(grid.city.id, side, attachment);
      if (!boundary) continue;

      const inwardSpan = side === 'top' || side === 'bottom' ? height : width;
      const reach = Math.max(6, Math.min(inwardSpan - 7, 11 + Math.floor(roll * 9)));
      const end: PlannedTilePoint =
        side === 'top'
          ? { x: attachment.x, y: attachment.y + reach }
          : side === 'bottom'
            ? { x: attachment.x, y: attachment.y - reach }
            : side === 'left'
              ? { x: attachment.x + reach, y: attachment.y }
              : { x: attachment.x - reach, y: attachment.y };
      const branch: PlannedRoadSegment = {
        id: `${grid.city.id}:branch:${xi}:${yi}`,
        from: attachment,
        to: end,
        hierarchy,
        halfWidth: 0,
        cityId: grid.city.id,
        endTerminal: terminal,
      };
      if (this.crossesAuthoredHighway(branch)) continue;

      this.splitSegmentAt(boundary, attachment);
      this.addSegment(branch);
      this.branchedBlocks.add(`${grid.city.id}:${xi}:${yi}`);
      return;
    }

    // The optional intervention has no valid attachment. It is discarded
    // before graph publication, so the already valid block needs no regeneration.
  }

  private branchAttachment(
    side: BlockSide,
    left: Axis,
    right: Axis,
    top: Axis,
    bottom: Axis,
    xi: number,
    yi: number,
  ): PlannedTilePoint {
    const horizontal = side === 'top' || side === 'bottom';
    const minimum = horizontal ? left.tile : top.tile;
    const maximum = horizontal ? right.tile : bottom.tile;
    const span = maximum - minimum;
    const jitter = this.hash(xi * 31 + (horizontal ? 7 : 19), yi * 37, this.seed ^ 0xa771);
    const along = Math.max(
      minimum + 5,
      Math.min(maximum - 5, minimum + Math.round(span * (0.38 + jitter * 0.24))),
    );
    if (side === 'top') return { x: along, y: top.tile };
    if (side === 'bottom') return { x: along, y: bottom.tile };
    if (side === 'left') return { x: left.tile, y: along };
    return { x: right.tile, y: along };
  }

  private findBoundarySegment(
    cityId: CityId,
    side: BlockSide,
    point: PlannedTilePoint,
  ): PlannedRoadSegment | undefined {
    const horizontal = side === 'top' || side === 'bottom';
    return Array.from(this.segments.values()).find((road) => {
      if (road.cityId !== cityId || road.hierarchy === 'alley' || road.hierarchy === 'access') {
        return false;
      }
      if (horizontal) {
        return (
          road.from.y === point.y &&
          road.to.y === point.y &&
          point.x > Math.min(road.from.x, road.to.x) &&
          point.x < Math.max(road.from.x, road.to.x) &&
          this.pointDistance(road.from, point) >= MIN_ROUTABLE_EDGE_TILES &&
          this.pointDistance(point, road.to) >= MIN_ROUTABLE_EDGE_TILES
        );
      }
      return (
        road.from.x === point.x &&
        road.to.x === point.x &&
        point.y > Math.min(road.from.y, road.to.y) &&
        point.y < Math.max(road.from.y, road.to.y) &&
        this.pointDistance(road.from, point) >= MIN_ROUTABLE_EDGE_TILES &&
        this.pointDistance(point, road.to) >= MIN_ROUTABLE_EDGE_TILES
      );
    });
  }

  private splitSegmentAt(segment: PlannedRoadSegment, point: PlannedTilePoint): void {
    this.segments.delete(this.segmentKey(segment.from, segment.to));
    const splitSuffix = `${point.x},${point.y}`;
    this.addSegment({
      ...segment,
      id: `${segment.id}:a@${splitSuffix}`,
      to: point,
      endTerminal: undefined,
    });
    this.addSegment({
      ...segment,
      id: `${segment.id}:b@${splitSuffix}`,
      from: point,
      startTerminal: undefined,
    });
  }

  private terminalFor(district: District, index: number): PlannedRoadTerminalKind {
    if (district === District.Industrial || district === District.Mining) {
      return 'industrial-yard';
    }
    if (district === District.Airport) {
      return index % 3 === 0 ? 'airport-entrance' : index % 3 === 1 ? 'checkpoint' : 'highway-ramp';
    }
    if (district === District.Harbor || district === District.Marina) return 'harbor-entrance';
    if (district === District.Forest) return 'forest-trail';
    if (district === District.Beach) return 'beach-access';
    if (district === District.Government || district === District.Park) return 'public-square';
    if (district === District.Luxury) return 'residential-court';
    const choices: readonly PlannedRoadTerminalKind[] = [
      'cul-de-sac',
      'parking-area',
      'dead-end-alley',
      'residential-court',
    ];
    return choices[this.mod(index, choices.length)] ?? 'cul-de-sac';
  }

  private addDiagonalConnectors(grid: CityGrid): void {
    const { city, xAxes, yAxes } = grid;
    for (let yi = 1; yi < yAxes.length; yi++) {
      const top = yAxes[yi - 1];
      const bottom = yAxes[yi];
      if (!top || !bottom) continue;
      for (let xi = 1; xi < xAxes.length; xi++) {
        const left = xAxes[xi - 1];
        const right = xAxes[xi];
        if (!left || !right) continue;
        // A diagonal and a terminating access street may visually cross inside
        // the same parcel. Since that crossing would not be a graph endpoint,
        // keep only one authored intervention in a block.
        if (this.branchedBlocks.has(`${city.id}:${xi}:${yi}`)) continue;
        const roll = this.hash(
          xi * 43 + city.center.x,
          yi * 61 + city.center.y,
          this.seed ^ 0xd1a6,
        );
        if (roll > (city.id === 'tehran' ? 0.045 : city.id === 'gilan' ? 0.065 : 0.055)) continue;
        const reverse = roll < 0.022;
        const diagonal: PlannedRoadSegment = {
          id: `${city.id}:diagonal:${xi}:${yi}`,
          from: reverse ? { x: right.tile, y: top.tile } : { x: left.tile, y: top.tile },
          to: reverse ? { x: left.tile, y: bottom.tile } : { x: right.tile, y: bottom.tile },
          hierarchy: 'secondary',
          halfWidth: 1,
          cityId: city.id,
        };
        if (
          this.highwayConnectionKeys.has(this.pointKey(diagonal.from)) ||
          this.highwayConnectionKeys.has(this.pointKey(diagonal.to))
        ) {
          continue;
        }
        if (this.crossesAuthoredHighway(diagonal)) continue;
        this.addSegment(diagonal);
      }
    }
  }

  private addHighwayPlan(): void {
    for (const road of this.highwayRoads) {
      this.addSegment({
        ...road,
        from: { ...road.from },
        to: { ...road.to },
      });
    }
  }

  /**
   * A forbidden highway crossing can remove two continuations at the same
   * grid node. Peel back the remaining non-terminal spur to the next real
   * junction instead of publishing a random dead end beside the corridor.
   */
  private pruneUnintentionalLocalStubs(): void {
    let shouldScan = true;
    while (shouldScan) {
      shouldScan = false;
      const incident = new Map<string, PlannedRoadSegment[]>();
      const intentionalTerminals = new Set<string>();
      for (const road of this.segments.values()) {
        for (const [point, terminal] of [
          [road.from, road.startTerminal],
          [road.to, road.endTerminal],
        ] as const) {
          const key = this.pointKey(point);
          const roads = incident.get(key) ?? [];
          roads.push(road);
          incident.set(key, roads);
          if (terminal) intentionalTerminals.add(key);
        }
      }

      let removed = false;
      for (const [point, roads] of incident) {
        if (roads.length !== 1 || intentionalTerminals.has(point)) continue;
        const road = roads[0];
        if (!road || road.hierarchy === 'highway') continue;
        this.segments.delete(this.segmentKey(road.from, road.to));
        removed = true;
        shouldScan = true;
        break;
      }
      if (!removed) return;
    }
  }

  private addSegment(segment: PlannedRoadSegment): void {
    if (this.samePoint(segment.from, segment.to)) return;
    const key = this.segmentKey(segment.from, segment.to);
    const existing = this.segments.get(key);
    if (!existing || HIERARCHY_RANK[segment.hierarchy] > HIERARCHY_RANK[existing.hierarchy]) {
      this.segments.set(key, segment);
    }
  }

  private deriveIntersections(roads: readonly PlannedRoadSegment[]): PlannedIntersection[] {
    const byPoint = new Map<string, PlannedRoadSegment[]>();
    const positions = new Map<string, PlannedTilePoint>();
    for (const road of roads) {
      for (const point of [road.from, road.to]) {
        const key = this.pointKey(point);
        const list = byPoint.get(key) ?? [];
        list.push(road);
        byPoint.set(key, list);
        positions.set(key, point);
      }
    }
    const intersections: PlannedIntersection[] = [];
    let index = 0;
    for (const [key, connected] of byPoint) {
      const point = positions.get(key);
      if (!point) continue;
      const cityId = this.cityAt(point);
      intersections.push({
        id: `junction:${index++}`,
        position: { x: point.x, y: point.y },
        design: this.intersectionDesign(point, connected),
        connectedRoadIds: connected.map((road) => road.id),
        cityId,
      });
    }
    return intersections;
  }

  private intersectionDesign(
    point: PlannedTilePoint,
    connected: readonly PlannedRoadSegment[],
  ): PlannedIntersectionDesign {
    if (connected.length <= 1) return 'terminal';
    const diagonal = connected.some(
      (road) => road.from.x !== road.to.x && road.from.y !== road.to.y,
    );
    if (connected.length === 2) return diagonal ? 'diagonal' : 'bend';
    const city = this.cityAt(point);
    const district = this.districtAt(point.x, point.y);
    if (connected.length === 3) {
      if (district === District.Industrial || district === District.Mining) {
        return 'industrial';
      }
      if (district === District.Residential || district === District.Luxury) {
        return 'residential';
      }
      return this.hash(point.x, point.y, this.seed ^ 0x0ff5) < 0.32 ? 'offset' : 't-junction';
    }
    const primaryCount = connected.filter(
      (road) => road.hierarchy === 'primary' || road.hierarchy === 'highway',
    ).length;
    if (primaryCount >= 2) return 'multi-lane';
    const roll = this.hash(point.x + (city === 'tehran' ? 3 : 17), point.y, this.seed ^ 0xc12c);
    if (roll < 0.16) return 'roundabout';
    if (roll < 0.27) return 'plaza';
    if (diagonal) return 'diagonal';
    return 'cross';
  }

  private deriveBlocks(): PlannedUrbanBlock[] {
    const blocks: PlannedUrbanBlock[] = [];
    const districtOrdinals = new Map<string, number>();
    let blockIndex = 0;
    for (const grid of this.grids) {
      const cells: ParcelCell[] = [];
      const cellIndex = new Map<string, number>();
      for (let yi = 1; yi < grid.yAxes.length; yi++) {
        const top = grid.yAxes[yi - 1];
        const bottom = grid.yAxes[yi];
        if (!top || !bottom) continue;
        for (let xi = 1; xi < grid.xAxes.length; xi++) {
          const left = grid.xAxes[xi - 1];
          const right = grid.xAxes[xi];
          if (!left || !right) continue;
          cellIndex.set(`${xi},${yi}`, cells.length);
          cells.push({ xi, yi, left, right, top, bottom });
        }
      }

      const parents = cells.map((_, index) => index);
      const find = (start: number): number => {
        let root = start;
        while ((parents[root] ?? root) !== root) root = parents[root] ?? root;
        let cursor = start;
        while (cursor !== root) {
          const next = parents[cursor] ?? root;
          parents[cursor] = root;
          cursor = next;
        }
        return root;
      };
      const union = (first: number, second: number): void => {
        const firstRoot = find(first);
        const secondRoot = find(second);
        if (firstRoot !== secondRoot) parents[secondRoot] = firstRoot;
      };

      // Missing internal grid links are open parcel seams, not fictional block
      // boundaries. Union the elementary cells on both sides before emitting a
      // single authoritative block record for the resulting parcel.
      for (let index = 0; index < cells.length; index++) {
        const cell = cells[index];
        if (!cell) continue;
        const rightIndex = cellIndex.get(`${cell.xi + 1},${cell.yi}`);
        if (
          rightIndex !== undefined &&
          !this.boundaryHasContinuousRoad(
            { x: cell.right.tile, y: cell.top.tile },
            { x: cell.right.tile, y: cell.bottom.tile },
          )
        ) {
          union(index, rightIndex);
        }
        const bottomIndex = cellIndex.get(`${cell.xi},${cell.yi + 1}`);
        if (
          bottomIndex !== undefined &&
          !this.boundaryHasContinuousRoad(
            { x: cell.left.tile, y: cell.bottom.tile },
            { x: cell.right.tile, y: cell.bottom.tile },
          )
        ) {
          union(index, bottomIndex);
        }
      }

      const parcels = new Map<number, ParcelCell[]>();
      for (let index = 0; index < cells.length; index++) {
        const cell = cells[index];
        if (!cell) continue;
        const root = find(index);
        const parcel = parcels.get(root) ?? [];
        parcel.push(cell);
        parcels.set(root, parcel);
      }

      for (const parcel of parcels.values()) {
        const parcelCells = new Set(parcel.map((cell) => `${cell.xi},${cell.yi}`));
        const footprint = parcel
          .map((cell) => {
            // A missing shared road is an open parcel seam. Extend both cells
            // exactly to the shared axis so their half-open rectangles meet
            // without gaps or overlap. Keep the full setback at a true road.
            const x = parcelCells.has(`${cell.xi - 1},${cell.yi}`)
              ? cell.left.tile
              : cell.left.tile + cell.left.halfWidth + 2;
            const y = parcelCells.has(`${cell.xi},${cell.yi - 1}`)
              ? cell.top.tile
              : cell.top.tile + cell.top.halfWidth + 2;
            const maxX = parcelCells.has(`${cell.xi + 1},${cell.yi}`)
              ? cell.right.tile
              : cell.right.tile - cell.right.halfWidth - 2;
            const maxY = parcelCells.has(`${cell.xi},${cell.yi + 1}`)
              ? cell.bottom.tile
              : cell.bottom.tile - cell.bottom.halfWidth - 2;
            return { x, y, width: maxX - x, height: maxY - y };
          })
          .filter((part) => part.width > 0 && part.height > 0);
        if (footprint.length === 0) {
          this.regeneratedBlocks++;
          continue;
        }
        const x = Math.min(...footprint.map((part) => part.x));
        const y = Math.min(...footprint.map((part) => part.y));
        const maxX = Math.max(...footprint.map((part) => part.x + part.width));
        const maxY = Math.max(...footprint.map((part) => part.y + part.height));
        const width = maxX - x;
        const height = maxY - y;
        // Four tiles still support a valid 2x2 micro-building plus frontage.
        // Reject only slivers that cannot contain the minimum legal footprint.
        if (width < 4 || height < 4) {
          this.regeneratedBlocks++;
          continue;
        }

        const districtCounts = new Map<District, number>();
        for (const cell of parcel) {
          const district = this.districtAt(
            Math.floor((cell.left.tile + cell.right.tile) / 2),
            Math.floor((cell.top.tile + cell.bottom.tile) / 2),
          );
          districtCounts.set(district, (districtCounts.get(district) ?? 0) + 1);
        }
        let district = this.districtAt(Math.floor(x + width / 2), Math.floor(y + height / 2));
        let districtVotes = -1;
        for (const [candidate, votes] of districtCounts) {
          if (votes <= districtVotes) continue;
          district = candidate;
          districtVotes = votes;
        }

        const minXi = Math.min(...parcel.map((cell) => cell.xi));
        const maxXi = Math.max(...parcel.map((cell) => cell.xi));
        const minYi = Math.min(...parcel.map((cell) => cell.yi));
        const maxYi = Math.max(...parcel.map((cell) => cell.yi));
        const rectangularCellCount = (maxXi - minXi + 1) * (maxYi - minYi + 1);
        const irregular = rectangularCellCount !== parcel.length;
        const ratio = width / height;
        const diagonal = Array.from(this.segments.values()).some(
          (road) =>
            road.cityId === grid.city.id &&
            road.from.x !== road.to.x &&
            road.from.y !== road.to.y &&
            this.segmentTouchesRect(road, x, y, width, height),
        );
        const form: PlannedUrbanBlock['form'] = irregular
          ? 'irregular'
          : diagonal
            ? 'diagonal'
            : ratio > 1.75 || ratio < 0.57
              ? 'long'
              : parcel.length > 1
                ? 'mixed'
                : width < 24 && height < 24
                  ? 'short'
                  : this.hash(x, y, this.seed) < 0.28
                    ? 'mixed'
                    : 'rectangular';
        const topologyHash = parcel.reduce(
          (value, cell) => value ^ this.hashInt(cell.xi, cell.yi, this.seed ^ 0x4b10c),
          0,
        );
        const districtKey = `${grid.city.id}:${district}`;
        const districtOrdinal = districtOrdinals.get(districtKey) ?? 0;
        districtOrdinals.set(districtKey, districtOrdinal + 1);
        const roll = this.hash(
          x + districtOrdinal * 17,
          y + parcel.length * 31,
          this.seed ^ 0x71d5,
        );
        const terminal = this.terminalInsideBlock(x, y, width, height, footprint);
        const footprintArea = footprint.reduce(
          (sum, part) => sum + part.width * part.height,
          0,
        );
        const program = this.programFor(
          grid.city.id,
          district,
          districtOrdinal,
          footprintArea,
          roll,
          terminal,
        );
        const landUse = this.landUseFor(program);
        const purposefulOpenSpace =
          this.programUsesPurposefulOpenSpace(program) ||
          terminal === 'cul-de-sac' ||
          terminal === 'residential-court' ||
          terminal === 'parking-area' ||
          terminal === 'roundabout';
        const densityTarget = this.densityTargetFor(grid.city.id, district, program, width, height);
        const landmark =
          districtOrdinal === 0 ||
          districtOrdinal % 7 === 3 ||
          [
            'financial-center',
            'government-complex',
            'hospital',
            'shopping-center',
            'public-plaza',
            'university-campus',
            'harbor-facility',
            'airport-facility',
            'stadium',
          ].includes(program);
        const signature = `${grid.city.id}:${district}:${landUse}:${program}:${form}:cells-${parcel.length}:${maxXi - minXi + 1}x${maxYi - minYi + 1}:${Math.round(width / 6)}x${Math.round(height / 6)}:${this.mod(topologyHash, 1_000_003)}`;
        blocks.push({
          id: `block:${grid.city.id}:${blockIndex++}`,
          cityId: grid.city.id,
          district,
          landUse,
          program,
          densityTarget,
          landmark,
          purposefulOpenSpace,
          footprint,
          bounds: { x, y, width, height },
          form,
          signature,
          generationAttempt: 0,
        });
      }
    }
    return blocks;
  }

  private terminalInsideBlock(
    x: number,
    y: number,
    width: number,
    height: number,
    footprint?: ReadonlyArray<{ x: number; y: number; width: number; height: number }>,
  ): PlannedRoadTerminalKind | undefined {
    for (const road of this.segments.values()) {
      for (const [point, terminal] of [
        [road.from, road.startTerminal],
        [road.to, road.endTerminal],
      ] as const) {
        const insideBounds =
          point.x >= x && point.y >= y && point.x < x + width && point.y < y + height;
        const insideFootprint =
          !footprint ||
          footprint.some(
            (part) =>
              point.x >= part.x &&
              point.y >= part.y &&
              point.x < part.x + part.width &&
              point.y < part.y + part.height,
          );
        if (terminal && insideBounds && insideFootprint) {
          return terminal;
        }
      }
    }
    return undefined;
  }

  private programFor(
    cityId: CityId,
    district: District,
    ordinal: number,
    area: number,
    roll: number,
    terminal?: PlannedRoadTerminalKind,
  ): PlannedBlockProgram {
    const terminalPrograms: Partial<Record<PlannedRoadTerminalKind, PlannedBlockProgram>> = {
      'cul-de-sac': 'housing',
      'parking-area': 'parking-garage',
      roundabout: 'public-plaza',
      'dead-end-alley': district === District.Bazaar ? 'market' : 'housing',
      'industrial-yard': 'industrial-yard',
      'residential-court': 'housing',
      'public-square': 'public-plaza',
      'harbor-entrance': 'harbor-facility',
      'airport-entrance': 'airport-facility',
      checkpoint: district === District.Airport ? 'airport-facility' : 'government-complex',
      'highway-ramp': district === District.Airport ? 'airport-facility' : 'parking-garage',
      'forest-trail': 'forest-park',
      'beach-access': 'beach-access',
    };
    if (terminal) return terminalPrograms[terminal] ?? 'utility-site';

    if (area > 2_400) {
      if (district === District.Airport) return 'airport-facility';
      if (district === District.Harbor || district === District.Marina) return 'harbor-facility';
      if (district === District.Forest) return 'forest-park';
      if (district === District.Industrial || district === District.Mining) {
        return 'industrial-yard';
      }
      return ordinal % 2 === 0 ? 'university-campus' : 'stadium';
    }

    let choices: readonly PlannedBlockProgram[];
    switch (district) {
      case District.Downtown:
        choices = [
          'financial-center',
          'office-complex',
          'continuous-retail',
          'apartments',
          'hotel',
          'shopping-center',
          'parking-garage',
          'public-plaza',
        ];
        break;
      case District.Commercial:
        choices = [
          'continuous-retail',
          'restaurant-row',
          'shopping-center',
          'market',
          'office-complex',
          'hotel',
          'parking-garage',
        ];
        break;
      case District.Government:
        choices = [
          'government-complex',
          'office-complex',
          'police-station',
          'fire-station',
          'hospital',
          'public-plaza',
        ];
        break;
      case District.University:
        choices = [
          'university-campus',
          'school',
          'apartments',
          'hospital',
          'sports-center',
          'public-plaza',
        ];
        break;
      case District.Industrial:
      case District.Mining:
        choices = [
          'factory',
          'warehouse',
          'industrial-yard',
          'utility-site',
          'construction-site',
          'parking-garage',
          'fire-station',
        ];
        break;
      case District.Harbor:
      case District.Marina:
        choices = [
          'harbor-facility',
          'warehouse',
          'market',
          'restaurant-row',
          'hotel',
          'parking-garage',
          'beach-access',
        ];
        break;
      case District.Airport:
        choices = [
          'airport-facility',
          'parking-garage',
          'hotel',
          'warehouse',
          'utility-site',
          'police-station',
        ];
        break;
      case District.Historic:
      case District.OldTown:
        choices = [
          'housing',
          'market',
          'continuous-retail',
          'restaurant-row',
          'school',
          'public-plaza',
          'hotel',
        ];
        break;
      case District.Bazaar:
        choices = [
          'market',
          'continuous-retail',
          'restaurant-row',
          'housing',
          'hotel',
          'public-plaza',
        ];
        break;
      case District.Village:
        choices = ['housing', 'farm-compound', 'school', 'market', 'playground', 'small-park'];
        break;
      case District.Luxury:
        choices = ['housing', 'apartments', 'hotel', 'small-park', 'sports-center', 'school'];
        break;
      case District.Park:
        choices = ['small-park', 'playground', 'sports-center', 'public-plaza'];
        break;
      case District.Forest:
        choices = ['forest-park', 'housing', 'farm-compound', 'small-park'];
        break;
      case District.Beach:
        choices = ['beach-access', 'hotel', 'restaurant-row', 'small-park'];
        break;
      case District.RiceFields:
      case District.TeaFarm:
      case District.Farmland:
        choices = ['farm-compound', 'housing', 'utility-site'];
        break;
      default:
        choices = [
          'housing',
          'apartments',
          'school',
          'market',
          'small-park',
          'playground',
          'hospital',
        ];
    }
    const cityOffset = cityId === 'tehran' ? 0 : cityId === 'gilan' ? 2 : 4;
    return (
      choices[this.mod(Math.floor(roll * 10_000) + ordinal + cityOffset, choices.length)] ??
      'housing'
    );
  }

  private landUseFor(program: PlannedBlockProgram): PlannedLandUse {
    if (['housing', 'apartments', 'farm-compound'].includes(program)) return 'residential';
    if (
      [
        'continuous-retail',
        'hotel',
        'market',
        'restaurant-row',
        'shopping-center',
        'parking-garage',
      ].includes(program)
    ) {
      return 'commercial';
    }
    if (program === 'office-complex' || program === 'financial-center') return 'office';
    if (['factory', 'warehouse', 'industrial-yard', 'construction-site'].includes(program)) {
      return 'industrial';
    }
    if (['school', 'hospital', 'university-campus', 'stadium'].includes(program)) {
      return 'institutional';
    }
    if (['police-station', 'fire-station', 'government-complex'].includes(program)) {
      return 'public-service';
    }
    if (
      ['public-plaza', 'playground', 'sports-center', 'small-park', 'forest-park'].includes(program)
    ) {
      return 'park';
    }
    if (
      [
        'harbor-facility',
        'airport-facility',
        'military-base',
        'rail-yard',
        'cemetery',
        'beach-access',
        'utility-site',
      ].includes(program)
    ) {
      return 'infrastructure';
    }
    return 'mixed-use';
  }

  private programUsesPurposefulOpenSpace(program: PlannedBlockProgram): boolean {
    return [
      'public-plaza',
      'playground',
      'sports-center',
      'small-park',
      'university-campus',
      'industrial-yard',
      'harbor-facility',
      'airport-facility',
      'military-base',
      'rail-yard',
      'cemetery',
      'stadium',
      'beach-access',
      'forest-park',
      'farm-compound',
      'construction-site',
    ].includes(program);
  }

  private densityTargetFor(
    cityId: CityId,
    district: District,
    program: PlannedBlockProgram,
    width: number,
    height: number,
  ): number {
    if (
      [
        'public-plaza',
        'playground',
        'small-park',
        'cemetery',
        'beach-access',
        'forest-park',
      ].includes(program)
    ) {
      return 0;
    }
    if (
      ['airport-facility', 'industrial-yard', 'construction-site', 'farm-compound'].includes(
        program,
      )
    ) {
      return 0.14;
    }
    if (
      [
        'university-campus',
        'harbor-facility',
        'military-base',
        'rail-yard',
        'stadium',
        'utility-site',
      ].includes(program)
    ) {
      return 0.2;
    }
    let target: number;
    if (program === 'housing') {
      target =
        district === District.Luxury
          ? 0.28
          : cityId === 'tehran'
            ? 0.42
            : cityId === 'yazd'
              ? 0.38
              : 0.34;
    } else if (program === 'apartments') target = district === District.Luxury ? 0.3 : 0.48;
    if (['continuous-retail', 'market', 'restaurant-row', 'shopping-center'].includes(program)) {
      return 0.58;
    }
    if (['office-complex', 'financial-center', 'parking-garage'].includes(program)) target = 0.52;
    else if (['factory', 'warehouse'].includes(program)) target = 0.46;
    else target ??= 0.38;

    // Most occupied programs retain at least a one-tile court/setback. Compact
    // blocks therefore receive the highest target their inner parcel can
    // physically satisfy instead of an impossible generic percentage.
    const innerWidth = Math.max(2, width - 2);
    const innerHeight = Math.max(2, height - 2);
    const geometricMaximum = (innerWidth * innerHeight) / Math.max(1, width * height);
    return Math.min(target, geometricMaximum);
  }

  private boundaryHasContinuousRoad(from: PlannedTilePoint, to: PlannedTilePoint): boolean {
    const horizontal = from.y === to.y;
    const vertical = from.x === to.x;
    if (!horizontal && !vertical) return false;
    const minimum = horizontal ? Math.min(from.x, to.x) : Math.min(from.y, to.y);
    const maximum = horizontal ? Math.max(from.x, to.x) : Math.max(from.y, to.y);
    const intervals: Array<readonly [number, number]> = [];
    for (const road of this.segments.values()) {
      if (horizontal && road.from.y === from.y && road.to.y === from.y) {
        const start = Math.max(minimum, Math.min(road.from.x, road.to.x));
        const end = Math.min(maximum, Math.max(road.from.x, road.to.x));
        if (end > start) intervals.push([start, end]);
      } else if (vertical && road.from.x === from.x && road.to.x === from.x) {
        const start = Math.max(minimum, Math.min(road.from.y, road.to.y));
        const end = Math.min(maximum, Math.max(road.from.y, road.to.y));
        if (end > start) intervals.push([start, end]);
      }
    }
    intervals.sort((first, second) => first[0] - second[0]);
    let coveredTo = minimum;
    for (const [start, end] of intervals) {
      if (start > coveredTo + 1e-9) return false;
      coveredTo = Math.max(coveredTo, end);
      if (coveredTo >= maximum - 1e-9) return true;
    }
    return false;
  }

  private validate(
    roads: readonly PlannedRoadSegment[],
    intersections: readonly PlannedIntersection[],
    blocks: readonly PlannedUrbanBlock[],
  ): UrbanQualityReport {
    const issues: string[] = [];
    const hierarchyCounts = Object.fromEntries(HIERARCHIES.map((key) => [key, 0])) as Record<
      PlannedRoadHierarchy,
      number
    >;
    for (const road of roads) hierarchyCounts[road.hierarchy]++;
    const shortRoadSegments = roads.filter(
      (road) => this.pointDistance(road.from, road.to) < MIN_ROUTABLE_EDGE_TILES,
    ).length;
    if (shortRoadSegments > 0) {
      issues.push(
        `${shortRoadSegments} planned road segments are shorter than ${MIN_ROUTABLE_EDGE_TILES} tiles`,
      );
    }
    const unmodelledHighwayCrossings = this.countUnmodelledHighwayCrossings(roads);
    if (unmodelledHighwayCrossings > 0) {
      issues.push(
        `${unmodelledHighwayCrossings} highway/local-road crossings lack a shared graph endpoint`,
      );
    }
    const unmergedOpenBoundaries = this.countUnmergedOpenBoundaries(blocks);
    if (unmergedOpenBoundaries > 0) {
      issues.push(
        `${unmergedOpenBoundaries} missing road boundaries still separate planned urban blocks`,
      );
    }
    const footprintOwners = new Map<string, string>();
    let invalidBlockFootprints = 0;
    let overlappingBlockTiles = 0;
    for (const block of blocks) {
      const parts = block.footprint ?? [block.bounds];
      const ownCells = new Set<string>();
      for (const part of parts) {
        if (
          !Number.isInteger(part.x) ||
          !Number.isInteger(part.y) ||
          !Number.isInteger(part.width) ||
          !Number.isInteger(part.height) ||
          part.width <= 0 ||
          part.height <= 0 ||
          part.x < block.bounds.x ||
          part.y < block.bounds.y ||
          part.x + part.width > block.bounds.x + block.bounds.width ||
          part.y + part.height > block.bounds.y + block.bounds.height
        ) {
          invalidBlockFootprints++;
          continue;
        }
        for (let y = part.y; y < part.y + part.height; y++) {
          for (let x = part.x; x < part.x + part.width; x++) {
            const key = `${x},${y}`;
            if (ownCells.has(key)) {
              invalidBlockFootprints++;
              continue;
            }
            ownCells.add(key);
            const owner = footprintOwners.get(key);
            if (owner && owner !== block.id) overlappingBlockTiles++;
            else footprintOwners.set(key, block.id);
          }
        }
      }
      if (ownCells.size === 0) invalidBlockFootprints++;
    }
    if (invalidBlockFootprints > 0) {
      issues.push(`${invalidBlockFootprints} urban block footprints are invalid or self-overlapping`);
    }
    if (overlappingBlockTiles > 0) {
      issues.push(`${overlappingBlockTiles} urban parcel tiles have more than one block owner`);
    }
    const intersectionCounts: Partial<Record<PlannedIntersectionDesign, number>> = {};
    for (const intersection of intersections) {
      intersectionCounts[intersection.design] = (intersectionCounts[intersection.design] ?? 0) + 1;
    }

    const degree = new Map<string, number>();
    const terminalByPoint = new Map<string, PlannedRoadTerminalKind>();
    for (const road of roads) {
      const fromKey = this.pointKey(road.from);
      const toKey = this.pointKey(road.to);
      degree.set(fromKey, (degree.get(fromKey) ?? 0) + 1);
      degree.set(toKey, (degree.get(toKey) ?? 0) + 1);
      if (road.startTerminal) terminalByPoint.set(fromKey, road.startTerminal);
      if (road.endTerminal) terminalByPoint.set(toKey, road.endTerminal);
    }
    let invalidTerminals = 0;
    for (const [point, count] of degree) {
      const intentional = terminalByPoint.has(point);
      if ((count === 1 && !intentional) || (count !== 1 && intentional)) invalidTerminals++;
    }
    if (invalidTerminals > 0) {
      issues.push(`${invalidTerminals} road endpoints lack an intentional terminal`);
    }

    const connected = this.connectedPointCount(roads);
    if (connected !== degree.size) {
      issues.push(`${degree.size - connected} planned road nodes are disconnected`);
    }
    for (const hierarchy of ['highway', 'primary', 'secondary', 'residential'] as const) {
      if (hierarchyCounts[hierarchy] === 0) issues.push(`road hierarchy ${hierarchy} is empty`);
    }
    const signatureCounts = new Map<string, number>();
    for (const block of blocks) {
      signatureCounts.set(block.signature, (signatureCounts.get(block.signature) ?? 0) + 1);
    }
    const duplicateBlockSignatures = Array.from(signatureCounts.values()).reduce(
      (sum, count) => sum + Math.max(0, count - 3),
      0,
    );
    if (duplicateBlockSignatures > Math.max(4, blocks.length * 0.04)) {
      issues.push(`${duplicateBlockSignatures} block designs repeat beyond the planning threshold`);
    }

    return {
      passed: issues.length === 0,
      plannedRoadSegments: roads.length,
      hierarchyCounts,
      intersectionCounts,
      intentionalTerminals: terminalByPoint.size,
      invalidTerminals,
      interruptedRoadSegments: 0,
      roadBuildingOverlaps: 0,
      duplicateBlockSignatures,
      excessiveFacadeRepeats: 0,
      unrealisticBuildingProportions: 0,
      skylineAdjacencyViolations: 0,
      oversizedEmptyBlocks: 0,
      excessiveEmptyTerrainBlocks: 0,
      unprogrammedOpenSpaces: 0,
      meaninglessDeadEnds: 0,
      streetsLeadingToEmptyLand: 0,
      repetitiveDistricts: 0,
      landmarkCoverageViolations: 0,
      urbanizedBlockRatio: 0,
      regeneratedBlocks: this.regeneratedBlocks,
      unownedBuildingTiles: 0,
      footprintMismatches: 0,
      inaccessibleEntrances: 0,
      missingSiteContent: 0,
      cityStyleViolations: 0,
      issues,
    };
  }

  private connectedPointCount(roads: readonly PlannedRoadSegment[]): number {
    const adjacency = new Map<string, Set<string>>();
    for (const road of roads) {
      const from = this.pointKey(road.from);
      const to = this.pointKey(road.to);
      const fromList = adjacency.get(from) ?? new Set<string>();
      const toList = adjacency.get(to) ?? new Set<string>();
      fromList.add(to);
      toList.add(from);
      adjacency.set(from, fromList);
      adjacency.set(to, toList);
    }
    const origin = adjacency.keys().next().value as string | undefined;
    if (!origin) return 0;
    const visited = new Set<string>([origin]);
    const queue = [origin];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const key = queue[cursor];
      if (!key) continue;
      for (const next of adjacency.get(key) ?? []) {
        if (visited.has(next)) continue;
        visited.add(next);
        queue.push(next);
      }
    }
    return visited.size;
  }

  private cityAt(point: PlannedTilePoint): CityId | undefined {
    const px = point.x * TILE_SIZE + TILE_SIZE / 2;
    const py = point.y * TILE_SIZE + TILE_SIZE / 2;
    for (const city of this.cities) {
      const bounds = city.bounds;
      if (
        px >= bounds.x &&
        py >= bounds.y &&
        px < bounds.x + bounds.width &&
        py < bounds.y + bounds.height
      ) {
        return city.id;
      }
    }
    return undefined;
  }

  private segmentTouchesRect(
    road: PlannedRoadSegment,
    x: number,
    y: number,
    width: number,
    height: number,
  ): boolean {
    const minX = Math.min(road.from.x, road.to.x);
    const maxX = Math.max(road.from.x, road.to.x);
    const minY = Math.min(road.from.y, road.to.y);
    const maxY = Math.max(road.from.y, road.to.y);
    return maxX >= x && minX < x + width && maxY >= y && minY < y + height;
  }

  private worldToTile(point: { x: number; y: number }): PlannedTilePoint {
    return { x: Math.floor(point.x / TILE_SIZE), y: Math.floor(point.y / TILE_SIZE) };
  }

  private pointKey(point: PlannedTilePoint): string {
    return `${point.x},${point.y}`;
  }

  private segmentKey(first: PlannedTilePoint, second: PlannedTilePoint): string {
    const a = this.pointKey(first);
    const b = this.pointKey(second);
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }

  private samePoint(first: PlannedTilePoint, second: PlannedTilePoint): boolean {
    return first.x === second.x && first.y === second.y;
  }

  private pointDistance(first: PlannedTilePoint, second: PlannedTilePoint): number {
    return Math.hypot(second.x - first.x, second.y - first.y);
  }

  private blockOwnsTile(block: PlannedUrbanBlock, x: number, y: number): boolean {
    return (block.footprint ?? [block.bounds]).some(
      (part) =>
        x >= part.x && y >= part.y && x < part.x + part.width && y < part.y + part.height,
    );
  }

  private crossesAuthoredHighway(road: PlannedRoadSegment): boolean {
    for (const highwayRoad of this.highwayRoads) {
      if (this.segmentsStrictlyCross(road, highwayRoad)) return true;
    }
    return false;
  }

  private countUnmodelledHighwayCrossings(roads: readonly PlannedRoadSegment[]): number {
    const highways = roads.filter((road) => road.hierarchy === 'highway');
    const localRoads = roads.filter((road) => road.hierarchy !== 'highway');
    let crossings = 0;
    for (const highway of highways) {
      for (const localRoad of localRoads) {
        if (this.segmentsStrictlyCross(highway, localRoad)) crossings++;
      }
    }
    return crossings;
  }

  private countUnmergedOpenBoundaries(blocks: readonly PlannedUrbanBlock[]): number {
    let violations = 0;
    for (const grid of this.grids) {
      const cityBlocks = blocks.filter((block) => block.cityId === grid.city.id);
      const ownersAt = (x: number, y: number): Set<string> =>
        new Set(
          cityBlocks
            .filter(
              (block) => this.blockOwnsTile(block, x, y),
            )
            .map((block) => block.id),
        );
      const separated = (first: Set<string>, second: Set<string>): boolean => {
        if (first.size === 0 || second.size === 0) return false;
        return !Array.from(first).some((id) => second.has(id));
      };

      for (let yi = 1; yi < grid.yAxes.length; yi++) {
        const top = grid.yAxes[yi - 1];
        const bottom = grid.yAxes[yi];
        if (!top || !bottom) continue;
        for (let xi = 1; xi < grid.xAxes.length; xi++) {
          const left = grid.xAxes[xi - 1];
          const right = grid.xAxes[xi];
          if (!left || !right) continue;
          const centerX = (left.tile + right.tile) / 2;
          const centerY = (top.tile + bottom.tile) / 2;

          const nextRight = grid.xAxes[xi + 1];
          if (
            nextRight &&
            !this.boundaryHasContinuousRoad(
              { x: right.tile, y: top.tile },
              { x: right.tile, y: bottom.tile },
            ) &&
            separated(
              ownersAt(centerX, centerY),
              ownersAt((right.tile + nextRight.tile) / 2, centerY),
            )
          ) {
            violations++;
          }

          const nextBottom = grid.yAxes[yi + 1];
          if (
            nextBottom &&
            !this.boundaryHasContinuousRoad(
              { x: left.tile, y: bottom.tile },
              { x: right.tile, y: bottom.tile },
            ) &&
            separated(
              ownersAt(centerX, centerY),
              ownersAt(centerX, (bottom.tile + nextBottom.tile) / 2),
            )
          ) {
            violations++;
          }
        }
      }
    }
    return violations;
  }

  private segmentsStrictlyCross(first: PlannedRoadSegment, second: PlannedRoadSegment): boolean {
    const firstDx = first.to.x - first.from.x;
    const firstDy = first.to.y - first.from.y;
    const secondDx = second.to.x - second.from.x;
    const secondDy = second.to.y - second.from.y;
    const denominator = firstDx * secondDy - firstDy * secondDx;
    if (Math.abs(denominator) < 1e-9) return false;

    const offsetX = second.from.x - first.from.x;
    const offsetY = second.from.y - first.from.y;
    const firstT = (offsetX * secondDy - offsetY * secondDx) / denominator;
    const secondT = (offsetX * firstDy - offsetY * firstDx) / denominator;
    const epsilon = 1e-9;
    return firstT > epsilon && firstT < 1 - epsilon && secondT > epsilon && secondT < 1 - epsilon;
  }

  private hash(x: number, y: number, seed: number): number {
    return (this.hashInt(x, y, seed) >>> 0) / 4294967296;
  }

  private hashInt(x: number, y: number, seed: number): number {
    let h = Math.imul(Math.floor(x), 374761393) ^ Math.imul(Math.floor(y), 668265263) ^ seed;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return h ^ (h >>> 16);
  }

  private mod(value: number, modulus: number): number {
    return ((value % modulus) + modulus) % modulus;
  }
}
