import { TILE_SIZE } from '@/config/Constants';
import type { Vector2 } from '@/core/types';
import type {
  HighwayCarriageway,
  HighwayComponent,
  HighwayRoute,
  MapData,
  PlannedRoadSegment,
} from '@/gameplay/types';
import type {
  HighwayChunkGeometry,
  HighwayGeometryStats,
  HighwayMainlineSection,
  HighwayMedianSection,
  HighwayRampSection,
  HighwaySplineSample,
} from './HighwayRenderTypes';

const SPLINE_SPACING = 12;
const PATH_INDEX_MARGIN = 112;
const RAIL_SAMPLE_SPACING = TILE_SIZE * 0.75;
const RAMP_LANE_WIDTH = TILE_SIZE * 1.05;
const RAMP_CLEAR_ZONE = TILE_SIZE * 2.5;

interface MutableHighwayChunkGeometry {
  key: string;
  mainlines: HighwayMainlineSection[];
  medians: HighwayMedianSection[];
  ramps: HighwayRampSection[];
  gores: HighwayRoute['interchanges'][number]['goreAreas'];
  gateZones: HighwayRoute['interchanges'][number]['gateZone'][];
  furniture: HighwayRoute['furniture'];
  serviceAreas: HighwayRoute['serviceAreas'];
  structures: HighwayRoute['structures'];
  scenery: HighwayRoute['scenery'];
  railCollisionTiles: Set<number>;
}

/** Immutable spatial index shared by highway rendering, decoration and collision. */
export class HighwayGeometryIndex {
  private readonly chunks = new Map<string, HighwayChunkGeometry>();
  private readonly corridorTiles = new Set<number>();
  private statsValue: HighwayGeometryStats = emptyStats();

  constructor(
    private readonly mapWidthTiles: number,
    public readonly chunkTiles: number,
  ) {}

  public static build(map: MapData, chunkTiles: number): HighwayGeometryIndex {
    const index = new HighwayGeometryIndex(map.widthTiles, chunkTiles);
    index.populate(map);
    return index;
  }

  public get stats(): HighwayGeometryStats {
    return this.statsValue;
  }

  public getChunk(key: string): HighwayChunkGeometry | null {
    return this.chunks.get(key) ?? null;
  }

  public hasChunk(key: string): boolean {
    return this.chunks.has(key);
  }

  public chunkKeys(): readonly string[] {
    return Array.from(this.chunks.keys());
  }

  public ownsTile(tx: number, ty: number): boolean {
    return this.corridorTiles.has(ty * this.mapWidthTiles + tx);
  }

  private populate(map: MapData): void {
    const mutable = new Map<string, MutableHighwayChunkGeometry>();
    let splineSamples = 0;
    let mainlineSections = 0;
    let medianSections = 0;
    let rampSections = 0;
    let goreSections = 0;
    let gateZones = 0;

    for (const route of map.highways) {
      const medianPoints = smoothSpline(route.points, SPLINE_SPACING);
      const routeRamps = buildRouteRamps(route, map.urbanPlan.roads);
      const railOpenings = routeRamps.flatMap((ramp) => {
        const first = ramp.points[0];
        const last = ramp.points[ramp.points.length - 1];
        return [first, last].filter((point): point is HighwaySplineSample => point !== undefined);
      });
      splineSamples += medianPoints.length;
      this.indexCorridor(route, medianPoints);
      medianSections += this.bucketPath(
        mutable,
        medianPoints,
        route.medianWidth * 0.5 + PATH_INDEX_MARGIN,
        (points) => ({
          id: `${route.id}:median`,
          routeId: route.id,
          medianType: route.medianType,
          width: route.medianWidth,
          points,
        }),
        'medians',
      );

      for (const carriageway of route.carriageways) {
        const points = extendSplineEnds(
          smoothSpline(carriageway.points, SPLINE_SPACING),
          0,
        );
        splineSamples += points.length;
        mainlineSections += this.bucketPath(
          mutable,
          points,
          carriageway.pavementWidth * 0.5 + PATH_INDEX_MARGIN,
          (sectionPoints) => ({
            id: carriageway.id,
            routeId: route.id,
            character: route.character,
            direction: carriageway.direction,
            laneCount: carriageway.laneCount,
            laneWidth: carriageway.laneWidth,
            pavementWidth: carriageway.pavementWidth,
            shoulderWidth: carriageway.shoulderWidth,
            points: sectionPoints,
          }),
          'mainlines',
        );
        this.indexRailCollision(mutable, carriageway, points, railOpenings);
      }

      for (const ramp of routeRamps) {
        splineSamples += ramp.points.length;
        const maximumWidth = Math.max(
          ramp.startWidth,
          ramp.middleWidth ?? 0,
          ramp.endWidth,
        );
        this.indexPathCorridor(
          ramp.points,
          maximumWidth * 0.5 + RAMP_CLEAR_ZONE,
        );
        rampSections += this.bucketPath(
          mutable,
          ramp.points,
          maximumWidth * 0.5 + PATH_INDEX_MARGIN,
          (points) => ({ ...ramp, points }),
          'ramps',
        );
      }

      for (const interchange of route.interchanges) {
        const circulating = interchange.transitionPaths.find(
          (path) => path.direction === 'circulating',
        );
        if (circulating && circulating.points.length > 3) {
          const uniquePoints = circulating.points.slice(0, -1);
          const center = uniquePoints.reduce(
            (sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }),
            { x: 0, y: 0 },
          );
          center.x /= uniquePoints.length;
          center.y /= uniquePoints.length;
          const islandRadius =
            Math.max(
              ...uniquePoints.map((point) =>
                Math.hypot(point.x - center.x, point.y - center.y),
              ),
            ) +
            TILE_SIZE * 1.8;
          this.indexPathCorridor(samplesFromPoints([center]), islandRadius);
        }
        for (const gore of interchange.goreAreas) {
          const center = {
            x: (gore.points[0].x + gore.points[1].x + gore.points[2].x) / 3,
            y: (gore.points[0].y + gore.points[1].y + gore.points[2].y) / 3,
          };
          this.bucketSite(mutable, center, gore.length + gore.width, 'gores', gore);
          goreSections++;
        }
        this.bucketSite(
          mutable,
          interchange.gateZone.center,
          interchange.gateZone.radius,
          'gateZones',
          interchange.gateZone,
        );
        gateZones++;
      }

      for (const site of route.furniture) {
        this.bucketSite(mutable, site.position, 48, 'furniture', site);
      }
      for (const area of route.serviceAreas) {
        this.bucketSite(mutable, area.position, 132, 'serviceAreas', area);
      }
      for (const structure of route.structures) {
        this.bucketSite(mutable, structure.position, 72, 'structures', structure);
      }
      for (const scenery of route.scenery) {
        this.bucketSite(mutable, scenery.position, 96 * scenery.scale, 'scenery', scenery);
      }
    }

    let railCollisionTiles = 0;
    for (const [key, chunk] of mutable) {
      const collision = Array.from(chunk.railCollisionTiles).sort((a, b) => a - b);
      railCollisionTiles += collision.length;
      this.chunks.set(key, {
        key,
        mainlines: chunk.mainlines,
        medians: chunk.medians,
        ramps: chunk.ramps,
        gores: chunk.gores,
        gateZones: chunk.gateZones,
        furniture: chunk.furniture,
        serviceAreas: chunk.serviceAreas,
        structures: chunk.structures,
        scenery: chunk.scenery,
        railCollisionTiles: collision,
      });
    }
    this.statsValue = {
      indexedChunks: this.chunks.size,
      mainlineSections,
      medianSections,
      rampSections,
      goreSections,
      gateZones,
      splineSamples,
      corridorTiles: this.corridorTiles.size,
      railCollisionTiles,
    };
  }

  private indexCorridor(route: HighwayRoute, points: readonly HighwaySplineSample[]): void {
    const pavement = route.carriageways[0]?.pavementWidth ?? TILE_SIZE * 4.5;
    const radius = route.medianWidth * 0.5 + pavement + TILE_SIZE * 1.25;
    this.indexPathCorridor(points, radius);
  }

  private indexPathCorridor(points: readonly HighwaySplineSample[], radius: number): void {
    const radiusTiles = Math.ceil(radius / TILE_SIZE);
    const radiusSq = radius * radius;
    for (let index = 0; index < points.length; index += 2) {
      const point = points[index];
      if (!point) continue;
      const centerTx = Math.floor(point.x / TILE_SIZE);
      const centerTy = Math.floor(point.y / TILE_SIZE);
      for (let dy = -radiusTiles; dy <= radiusTiles; dy++) {
        for (let dx = -radiusTiles; dx <= radiusTiles; dx++) {
          const x = (centerTx + dx + 0.5) * TILE_SIZE;
          const y = (centerTy + dy + 0.5) * TILE_SIZE;
          if ((x - point.x) ** 2 + (y - point.y) ** 2 > radiusSq) continue;
          this.corridorTiles.add((centerTy + dy) * this.mapWidthTiles + centerTx + dx);
        }
      }
    }
  }

  private indexRailCollision(
    chunks: Map<string, MutableHighwayChunkGeometry>,
    carriageway: HighwayCarriageway,
    points: readonly HighwaySplineSample[],
    openings: readonly HighwaySplineSample[],
  ): void {
    const rail = offsetSpline(points, carriageway.pavementWidth * 0.5 + 7);
    let nextDistance = 0;
    for (const point of rail) {
      if (point.distance + 0.001 < nextDistance) continue;
      nextDistance = point.distance + RAIL_SAMPLE_SPACING;
      if (
        point.distance < TILE_SIZE * 1.4 ||
        (rail[rail.length - 1]?.distance ?? 0) - point.distance < TILE_SIZE * 1.4 ||
        openings.some(
          (opening) => Math.hypot(point.x - opening.x, point.y - opening.y) < TILE_SIZE * 2.2,
        )
      ) {
        continue;
      }
      const tx = Math.floor(point.x / TILE_SIZE);
      const ty = Math.floor(point.y / TILE_SIZE);
      const cx = Math.floor(tx / this.chunkTiles);
      const cy = Math.floor(ty / this.chunkTiles);
      const localX = tx - cx * this.chunkTiles;
      const localY = ty - cy * this.chunkTiles;
      if (localX < 0 || localY < 0 || localX >= this.chunkTiles || localY >= this.chunkTiles) {
        continue;
      }
      this.chunkFor(chunks, `${cx},${cy}`).railCollisionTiles.add(
        localY * this.chunkTiles + localX,
      );
    }
  }

  private bucketPath<T extends 'mainlines' | 'medians' | 'ramps'>(
    chunks: Map<string, MutableHighwayChunkGeometry>,
    points: readonly HighwaySplineSample[],
    margin: number,
    create: (
      section: HighwaySplineSample[],
    ) => MutableHighwayChunkGeometry[T] extends Array<infer Item> ? Item : never,
    target: T,
  ): number {
    const buckets = new Map<string, HighwaySplineSample[]>();
    const chunkPx = this.chunkTiles * TILE_SIZE;
    for (let index = 1; index < points.length; index++) {
      const previous = points[index - 1];
      const point = points[index];
      if (!previous || !point) continue;
      const minCx = Math.floor((Math.min(previous.x, point.x) - margin) / chunkPx);
      const maxCx = Math.floor((Math.max(previous.x, point.x) + margin) / chunkPx);
      const minCy = Math.floor((Math.min(previous.y, point.y) - margin) / chunkPx);
      const maxCy = Math.floor((Math.max(previous.y, point.y) + margin) / chunkPx);
      for (let cy = minCy; cy <= maxCy; cy++) {
        for (let cx = minCx; cx <= maxCx; cx++) {
          const key = `${cx},${cy}`;
          let section = buckets.get(key);
          if (!section) {
            section = [];
            buckets.set(key, section);
          }
          const last = section[section.length - 1];
          if (!last || last.distance !== previous.distance) section.push(previous);
          section.push(point);
        }
      }
    }
    for (const [key, section] of buckets) {
      const chunk = this.chunkFor(chunks, key);
      (chunk[target] as Array<ReturnType<typeof create>>).push(create(section));
    }
    return buckets.size;
  }

  private bucketSite<
    T extends 'furniture' | 'serviceAreas' | 'structures' | 'scenery' | 'gores' | 'gateZones',
  >(
    chunks: Map<string, MutableHighwayChunkGeometry>,
    position: Vector2,
    radius: number,
    target: T,
    site: MutableHighwayChunkGeometry[T][number],
  ): void {
    const chunkPx = this.chunkTiles * TILE_SIZE;
    const minCx = Math.floor((position.x - radius) / chunkPx);
    const maxCx = Math.floor((position.x + radius) / chunkPx);
    const minCy = Math.floor((position.y - radius) / chunkPx);
    const maxCy = Math.floor((position.y + radius) / chunkPx);
    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const chunk = this.chunkFor(chunks, `${cx},${cy}`);
        (chunk[target] as Array<typeof site>).push(site);
      }
    }
  }

  private chunkFor(
    chunks: Map<string, MutableHighwayChunkGeometry>,
    key: string,
  ): MutableHighwayChunkGeometry {
    const existing = chunks.get(key);
    if (existing) return existing;
    const chunk: MutableHighwayChunkGeometry = {
      key,
      mainlines: [],
      medians: [],
      ramps: [],
      gores: [],
      gateZones: [],
      furniture: [],
      serviceAreas: [],
      structures: [],
      scenery: [],
      railCollisionTiles: new Set(),
    };
    chunks.set(key, chunk);
    return chunk;
  }
}

export function smoothSpline(points: readonly Vector2[], spacing: number): HighwaySplineSample[] {
  if (points.length < 2) return samplesFromPoints(points);
  const dense: Vector2[] = [];
  for (let index = 0; index < points.length - 1; index++) {
    const p0 = points[Math.max(0, index - 1)] ?? points[0];
    const p1 = points[index];
    const p2 = points[index + 1];
    const p3 = points[Math.min(points.length - 1, index + 2)] ?? p2;
    if (!p0 || !p1 || !p2 || !p3) continue;
    const length = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const steps = Math.max(2, Math.ceil(length / Math.max(2, spacing * 0.45)));
    for (let step = 0; step < steps; step++) {
      dense.push(catmullRom(p0, p1, p2, p3, step / steps));
    }
  }
  const last = points[points.length - 1];
  if (last) dense.push({ ...last });
  return samplesFromPoints(resamplePolyline(dense, spacing));
}

export function offsetSpline(
  points: readonly HighwaySplineSample[],
  offset: number,
): HighwaySplineSample[] {
  return points.map((point) => ({
    ...point,
    x: point.x + point.normalX * offset,
    y: point.y + point.normalY * offset,
  }));
}

function extendSplineEnds(
  points: readonly HighwaySplineSample[],
  extension: number,
): HighwaySplineSample[] {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last || points.length < 2) return Array.from(points);
  const extended: Vector2[] = [];
  for (let distance = extension; distance > 0; distance -= SPLINE_SPACING) {
    extended.push({
      x: first.x - first.tangentX * distance,
      y: first.y - first.tangentY * distance,
    });
  }
  for (const point of points) extended.push({ x: point.x, y: point.y });
  for (let distance = SPLINE_SPACING; distance <= extension; distance += SPLINE_SPACING) {
    extended.push({
      x: last.x + last.tangentX * distance,
      y: last.y + last.tangentY * distance,
    });
  }
  return samplesFromPoints(extended);
}

function buildRouteRamps(
  route: HighwayRoute,
  allRoads: readonly PlannedRoadSegment[],
): HighwayRampSection[] {
  const roads = new Map(
    allRoads
      .filter((road) => road.highwayId === route.id && road.highwayComponent !== 'carriageway')
      .map((road) => [road.id, road]),
  );
  const ramps: HighwayRampSection[] = route.interchanges.flatMap((interchange) =>
    interchange.transitionPaths.map((path) => authoredTransitionPath(route, path)),
  );
  for (const area of route.serviceAreas) {
    const chain = area.accessRoadIds.flatMap((id) => {
      const road = roads.get(id);
      return road ? [road] : [];
    });
    if (chain.length === 0) continue;
    const worldPoints: Vector2[] = [tileCenter(chain[0]?.from)];
    for (const road of chain) worldPoints.push(tileCenter(road.to));
    const points = smoothSpline(worldPoints, SPLINE_SPACING);
    const length = points[points.length - 1]?.distance ?? 0;
    ramps.push({
      id: `${area.id}:access`,
      routeId: route.id,
      character: route.character,
      kind: 'service-road',
      laneCount: 1,
      laneWidth: RAMP_LANE_WIDTH,
      shoulderWidth: TILE_SIZE * 0.3,
      elevation: 'ground',
      length,
      startWidth: 18,
      middleWidth: 58,
      endWidth: 18,
      taperStartDistance: 0,
      taperEndDistance: length,
      points,
    });
  }
  return ramps;
}

function authoredTransitionPath(
  route: HighwayRoute,
  path: HighwayRoute['interchanges'][number]['transitionPaths'][number],
): HighwayRampSection {
  const points = samplesFromPoints(resamplePolyline(path.points, SPLINE_SPACING));
  const length = points[points.length - 1]?.distance ?? 0;
  const pavementWidth = path.laneCount * path.laneWidth + path.shoulderWidth * 2;
  const mainlineWidth = route.carriageways[0]?.pavementWidth ?? TILE_SIZE * 4.5;
  const acceleration = path.merge?.kind === 'acceleration';
  const deceleration = path.merge?.kind === 'deceleration';
  const taperLength = path.merge?.taperLength ?? 0;
  const laneStartDistance = Math.max(0, Math.min(length, path.merge?.startDistance ?? 0));
  const laneEndDistance = Math.max(
    laneStartDistance,
    Math.min(length, path.merge?.endDistance ?? length),
  );
  const taperStartDistance = acceleration
    ? Math.max(0, length - taperLength)
    : deceleration
      ? 0
      : 0;
  const taperEndDistance = acceleration
    ? length
    : deceleration
      ? Math.min(length, taperLength)
      : length;
  return {
    id: path.id,
    routeId: route.id,
    character: route.character,
    kind: path.kind,
    direction: path.direction,
    laneCount: path.laneCount,
    laneWidth: path.laneWidth,
    shoulderWidth: path.shoulderWidth,
    mergeKind: path.merge?.kind,
    elevation: path.elevation,
    length,
    startWidth: acceleration ? pavementWidth : deceleration ? mainlineWidth : pavementWidth,
    endWidth: acceleration ? mainlineWidth : pavementWidth,
    taperStartDistance,
    taperEndDistance,
    laneStartDistance: path.merge ? laneStartDistance : undefined,
    laneEndDistance: path.merge ? laneEndDistance : undefined,
    mergeSide: acceleration || deceleration ? path.merge?.side : undefined,
    arrowDistance:
      path.merge === undefined
        ? undefined
        : laneStartDistance +
          (laneEndDistance - laneStartDistance) * (acceleration ? 0.42 : 0.58),
    points,
  };
}

function samplesFromPoints(points: readonly Vector2[]): HighwaySplineSample[] {
  const samples: HighwaySplineSample[] = [];
  let distance = 0;
  for (let index = 0; index < points.length; index++) {
    const point = points[index];
    if (!point) continue;
    const previous = points[Math.max(0, index - 1)] ?? point;
    const next = points[Math.min(points.length - 1, index + 1)] ?? point;
    if (index > 0) distance += Math.hypot(point.x - previous.x, point.y - previous.y);
    const tangent = normalize({ x: next.x - previous.x, y: next.y - previous.y });
    samples.push({
      x: point.x,
      y: point.y,
      tangentX: tangent.x,
      tangentY: tangent.y,
      normalX: -tangent.y,
      normalY: tangent.x,
      distance,
    });
  }
  return samples;
}

function resamplePolyline(points: readonly Vector2[], spacing: number): Vector2[] {
  const result: Vector2[] = [];
  const first = points[0];
  if (!first) return result;
  result.push({ ...first });
  let carried = 0;
  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1];
    const point = points[index];
    if (!previous || !point) continue;
    let cursor: Vector2 = previous;
    let segmentLength = Math.hypot(point.x - cursor.x, point.y - cursor.y);
    while (carried + segmentLength >= spacing && segmentLength > 0.001) {
      const amount = (spacing - carried) / segmentLength;
      const sample: Vector2 = {
        x: cursor.x + (point.x - cursor.x) * amount,
        y: cursor.y + (point.y - cursor.y) * amount,
      };
      result.push(sample);
      cursor = sample;
      segmentLength = Math.hypot(point.x - cursor.x, point.y - cursor.y);
      carried = 0;
    }
    carried += segmentLength;
  }
  const last = points[points.length - 1];
  const tail = result[result.length - 1];
  if (last && (!tail || Math.hypot(last.x - tail.x, last.y - tail.y) > 1)) result.push({ ...last });
  return result;
}

function catmullRom(a: Vector2, b: Vector2, c: Vector2, d: Vector2, t: number): Vector2 {
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x:
      0.5 *
      (2 * b.x +
        (-a.x + c.x) * t +
        (2 * a.x - 5 * b.x + 4 * c.x - d.x) * t2 +
        (-a.x + 3 * b.x - 3 * c.x + d.x) * t3),
    y:
      0.5 *
      (2 * b.y +
        (-a.y + c.y) * t +
        (2 * a.y - 5 * b.y + 4 * c.y - d.y) * t2 +
        (-a.y + 3 * b.y - 3 * c.y + d.y) * t3),
  };
}

function tileCenter(point: { x: number; y: number } | undefined): Vector2 {
  return point
    ? { x: point.x * TILE_SIZE + TILE_SIZE / 2, y: point.y * TILE_SIZE + TILE_SIZE / 2 }
    : { x: 0, y: 0 };
}

/** Width at full-ramp arc distance; stable even when a ramp is bucketed by chunk. */
export function highwayRampWidthAt(ramp: HighwayRampSection, distance: number): number {
  const clampedDistance = Math.max(0, Math.min(ramp.length, distance));
  if (ramp.middleWidth !== undefined) {
    const amount = ramp.length <= 0 ? 0 : clampedDistance / ramp.length;
    return amount <= 0.5
      ? lerp(ramp.startWidth, ramp.middleWidth, smoothstep01(amount * 2))
      : lerp(ramp.middleWidth, ramp.endWidth, smoothstep01((amount - 0.5) * 2));
  }
  if (clampedDistance <= ramp.taperStartDistance) return ramp.startWidth;
  if (clampedDistance >= ramp.taperEndDistance) return ramp.endWidth;
  const amount =
    (clampedDistance - ramp.taperStartDistance) /
    Math.max(0.001, ramp.taperEndDistance - ramp.taperStartDistance);
  return lerp(ramp.startWidth, ramp.endWidth, smoothstep01(amount));
}

function normalize(point: Vector2): Vector2 {
  const length = Math.max(0.001, Math.hypot(point.x, point.y));
  return { x: point.x / length, y: point.y / length };
}

function lerp(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

function smoothstep01(amount: number): number {
  const clamped = Math.max(0, Math.min(1, amount));
  return clamped * clamped * (3 - 2 * clamped);
}

function emptyStats(): HighwayGeometryStats {
  return {
    indexedChunks: 0,
    mainlineSections: 0,
    medianSections: 0,
    rampSections: 0,
    goreSections: 0,
    gateZones: 0,
    splineSamples: 0,
    corridorTiles: 0,
    railCollisionTiles: 0,
  };
}

export function isHighwayComponent(value: HighwayComponent | undefined): value is HighwayComponent {
  return value !== undefined;
}
