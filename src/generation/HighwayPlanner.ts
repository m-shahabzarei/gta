/**
 * Deterministic national-highway planner.
 *
 * This module owns intercity alignment, divided carriageways, city ramps,
 * service-area access, structures, furniture, scenery and hard rejection.
 * It deliberately emits ordinary planner records only at its boundary so the
 * urban planner can consume highways without being allowed to reshape them.
 */
import { TILE_SIZE } from '@/config/Constants';
import type { Vector2 } from '@/core/types';
import type {
  CityId,
  HighwayCarriageway,
  HighwayCarriagewayDirection,
  HighwayFurnitureKind,
  HighwayFurnitureSite,
  HighwayMedianType,
  HighwayQualityReport,
  HighwayRoute,
  HighwaySceneryKind,
  HighwayScenerySite,
  HighwayServiceArea,
  HighwayServiceFacility,
  HighwayStructure,
  HighwayStructureKind,
  PlannedRoadSegment,
  PlannedTilePoint,
  WorldCity,
} from '@/gameplay/types';
import { HighwayTransitionPlanner } from './HighwayTransitionPlanner';

export interface HighwayPlanningResult {
  routes: HighwayRoute[];
  roads: PlannedRoadSegment[];
  quality: HighwayQualityReport;
}

type PortalSide = 'north' | 'east' | 'south' | 'west';

interface RouteProfile {
  id: string;
  name: string;
  from: CityId;
  to: CityId;
  fromPortal: { side: PortalSide; ratio: number };
  toPortal: { side: PortalSide; ratio: number };
  character: HighwayRoute['character'];
  medianType: HighwayMedianType;
  /** Selects the handcrafted cardinal dog-leg used between the city portals. */
  bendAxis: 'horizontal' | 'vertical';
}

interface AlignmentPoint {
  point: Vector2;
  tangent: Vector2;
  normal: Vector2;
  distance: number;
}

const ROUTES: readonly RouteProfile[] = [
  {
    id: 'national-1-alborz',
    name: 'National 1 / Alborz Expressway',
    from: 'tehran',
    to: 'gilan',
    fromPortal: { side: 'north', ratio: 0.49 },
    toPortal: { side: 'south', ratio: 0.93 },
    character: 'mountain',
    medianType: 'concrete-barrier',
    bendAxis: 'vertical',
  },
  {
    id: 'national-7-desert',
    name: 'National 7 / Central Desert Freeway',
    from: 'tehran',
    to: 'yazd',
    fromPortal: { side: 'east', ratio: 0.53 },
    toPortal: { side: 'west', ratio: 0.73 },
    character: 'desert',
    medianType: 'concrete-barrier',
    bendAxis: 'horizontal',
  },
  {
    id: 'national-22-caspian',
    name: 'National 22 / Caspian Eastern Motorway',
    from: 'gilan',
    to: 'yazd',
    fromPortal: { side: 'east', ratio: 0.43 },
    toPortal: { side: 'west', ratio: 0.29 },
    character: 'forest',
    medianType: 'concrete-barrier',
    bendAxis: 'horizontal',
  },
] as const;

const VISUAL_SAMPLE_SPACING = TILE_SIZE * 0.5;
const GRAPH_SAMPLE_SPACING = TILE_SIZE * 12;
const LANE_WIDTH = 24;
const SHOULDER_WIDTH = 10;
const CARRIAGEWAY_WIDTH = LANE_WIDTH * 3 + SHOULDER_WIDTH * 2;
const MEDIAN_WIDTH = 18;
const CARRIAGEWAY_OFFSET = MEDIAN_WIDTH * 0.5 + CARRIAGEWAY_WIDTH * 0.5;
const MINIMUM_CURVE_RADIUS = TILE_SIZE * 10;
const SUPPORTED_JUNCTION_KINDS = new Set(['t-junction', 'cross', 'priority-cross'] as const);

const CITY_SCENERY: Readonly<Record<CityId, readonly HighwaySceneryKind[]>> = {
  tehran: [
    'power-lines',
    'billboard',
    'construction',
    'sound-barrier',
    'concrete-wall',
    'solar-farm',
    'wind-turbines',
  ],
  yazd: [
    'sand-dunes',
    'rock-formations',
    'dry-river',
    'wind-turbines',
    'solar-farm',
    'caravan-ruins',
    'cactus',
    'dust',
  ],
  gilan: [
    'dense-forest',
    'rice-fields',
    'river',
    'fog-bank',
    'tea-farm',
    'wetlands',
    'lake',
    'dense-forest',
  ],
};

const CHARACTER_SCENERY: Readonly<
  Record<HighwayRoute['character'], readonly HighwaySceneryKind[]>
> = {
  urban: CITY_SCENERY.tehran,
  desert: CITY_SCENERY.yazd,
  mountain: [
    'rock-formations',
    'power-lines',
    'billboard',
    'dense-forest',
    'dry-river',
  ],
  forest: CITY_SCENERY.gilan,
  coastal: ['wetlands', 'lake', 'river', 'rice-fields', 'tea-farm', 'fog-bank'],
};

/** Build the complete divided national network and reject it as one unit. */
export class HighwayPlanner {
  private constructor(
    private readonly seed: number,
    private readonly cities: readonly WorldCity[],
    private readonly roadPeriod: number,
    private readonly roadMid: number,
  ) {}

  public static generate(
    seed: number,
    cities: readonly WorldCity[],
    roadPeriod: number,
    roadMid: number,
  ): HighwayPlanningResult {
    return new HighwayPlanner(seed, cities, roadPeriod, roadMid).build();
  }

  private build(): HighwayPlanningResult {
    const routes: HighwayRoute[] = [];
    const roads: PlannedRoadSegment[] = [];
    for (let index = 0; index < ROUTES.length; index++) {
      const profile = ROUTES[index];
      if (!profile) continue;
      const generated = this.buildRoute(profile, index);
      routes.push(generated.route);
      roads.push(...generated.roads);
    }
    const quality = this.combineQuality(routes);
    if (!quality.passed) {
      throw new Error(`Highway planning failed: ${quality.issues.join('; ')}`);
    }
    return { routes, roads, quality };
  }

  private buildRoute(
    profile: RouteProfile,
    routeIndex: number,
  ): { route: HighwayRoute; roads: PlannedRoadSegment[] } {
    const fromCity = this.requireCity(profile.from);
    const toCity = this.requireCity(profile.to);
    const fromGateway = this.gateway(fromCity, profile.fromPortal.side, profile.fromPortal.ratio);
    const toGateway = this.gateway(toCity, profile.toPortal.side, profile.toPortal.ratio);
    const denseCenter = this.alignment(profile, fromGateway, toGateway, routeIndex);
    const forwardVisual = this.offsetPolyline(
      denseCenter.map((sample) => sample.point),
      CARRIAGEWAY_OFFSET,
    );
    const reversePhysical = this.offsetPolyline(
      denseCenter.map((sample) => sample.point),
      -CARRIAGEWAY_OFFSET,
    );
    const reverseVisual = reversePhysical.slice().reverse();
    const forwardGraph = this.toTileChain(
      this.resamplePolyline(forwardVisual, GRAPH_SAMPLE_SPACING),
    );
    const reverseGraph = this.toTileChain(
      this.resamplePolyline(reverseVisual, GRAPH_SAMPLE_SPACING),
    );
    if (forwardGraph.length < 3 || reverseGraph.length < 3) {
      throw new Error(`${profile.id} did not produce viable carriageways`);
    }
    // Both directions meet the same normal city-road node. The static
    // intersection deck bridges the small visual carriageway offsets, while
    // the runtime graph gets one unambiguous at-grade junction instead of a
    // pair of short diagonal ramp edges.
    const fromJunctionTile = this.worldToTile(fromGateway);
    const toJunctionTile = this.worldToTile(toGateway);
    forwardGraph[0] = { ...fromJunctionTile };
    reverseGraph[reverseGraph.length - 1] = { ...fromJunctionTile };
    forwardGraph[forwardGraph.length - 1] = { ...toJunctionTile };
    reverseGraph[0] = { ...toJunctionTile };

    const roads: PlannedRoadSegment[] = [];
    const forwardIds = this.addCarriagewayRoads(profile.id, 'forward', forwardGraph, roads);
    const reverseIds = this.addCarriagewayRoads(profile.id, 'reverse', reverseGraph, roads);
    const fromForward = this.requireGraphPoint(profile.id, forwardGraph, 0);
    const fromReverse = this.requireGraphPoint(profile.id, reverseGraph, reverseGraph.length - 1);
    const toForward = this.requireGraphPoint(profile.id, forwardGraph, forwardGraph.length - 1);
    const toReverse = this.requireGraphPoint(profile.id, reverseGraph, 0);
    const fromTransition = HighwayTransitionPlanner.generate({
      seed: this.seed,
      routeId: profile.id,
      routeCharacter: profile.character,
      city: fromCity,
      gatewayWorld: fromGateway,
      approachHeading: Math.atan2(denseCenter[0]?.tangent.y ?? 0, denseCenter[0]?.tangent.x ?? 1),
      cityConnections: [this.tileToWorld(fromForward), this.tileToWorld(fromReverse)],
    });
    const toTransition = HighwayTransitionPlanner.generate({
      seed: this.seed,
      routeId: profile.id,
      routeCharacter: profile.character,
      city: toCity,
      gatewayWorld: toGateway,
      approachHeading: Math.atan2(
        denseCenter[denseCenter.length - 1]?.tangent.y ?? 0,
        denseCenter[denseCenter.length - 1]?.tangent.x ?? 1,
      ),
      cityConnections: [this.tileToWorld(toForward), this.tileToWorld(toReverse)],
    });

    const serviceAreas = this.addServiceAreas(
      profile,
      denseCenter,
      forwardGraph,
      reverseGraph,
      roads,
    );
    const structures = this.buildStructures(profile, denseCenter);
    const furniture = this.buildFurniture(profile, denseCenter);
    const scenery = this.buildScenery(profile, denseCenter);
    const forward: HighwayCarriageway = {
      id: `${profile.id}:forward`,
      direction: 'forward',
      points: forwardVisual,
      laneCount: 3,
      laneWidth: LANE_WIDTH,
      pavementWidth: CARRIAGEWAY_WIDTH,
      shoulderWidth: SHOULDER_WIDTH,
      roadSegmentIds: forwardIds,
    };
    const reverse: HighwayCarriageway = {
      id: `${profile.id}:reverse`,
      direction: 'reverse',
      points: reverseVisual,
      laneCount: 3,
      laneWidth: LANE_WIDTH,
      pavementWidth: CARRIAGEWAY_WIDTH,
      shoulderWidth: SHOULDER_WIDTH,
      roadSegmentIds: reverseIds,
    };
    const routeWithoutQuality = {
      id: profile.id,
      name: profile.name,
      from: profile.from,
      to: profile.to,
      points: denseCenter.map((sample) => sample.point),
      character: profile.character,
      medianType: profile.medianType,
      medianWidth: MEDIAN_WIDTH,
      carriageways: [forward, reverse] as [HighwayCarriageway, HighwayCarriageway],
      interchanges: [fromTransition.interchange, toTransition.interchange],
      serviceAreas,
      structures,
      furniture,
      scenery,
    };
    const quality = this.validateRoute(routeWithoutQuality, roads);
    const route: HighwayRoute = { ...routeWithoutQuality, quality };
    if (!quality.passed) {
      throw new Error(`${profile.id} rejected: ${quality.issues.join('; ')}`);
    }
    return { route, roads };
  }

  private alignment(
    profile: RouteProfile,
    from: Vector2,
    to: Vector2,
    _routeIndex: number,
  ): AlignmentPoint[] {
    const bend =
      profile.bendAxis === 'horizontal'
        ? (from.x + to.x) * 0.5
        : (from.y + to.y) * 0.5;
    const controls: Vector2[] =
      profile.bendAxis === 'horizontal'
        ? [from, { x: bend, y: from.y }, { x: bend, y: to.y }, to]
        : [from, { x: from.x, y: bend }, { x: to.x, y: bend }, to];
    const raw = roundedCardinalPath(controls, MINIMUM_CURVE_RADIUS, VISUAL_SAMPLE_SPACING);
    const points = this.resamplePolyline(raw, VISUAL_SAMPLE_SPACING);
    const samples: AlignmentPoint[] = [];
    let distance = 0;
    for (let index = 0; index < points.length; index++) {
      const point = points[index];
      if (!point) continue;
      const previous = points[Math.max(0, index - 1)] ?? point;
      const next = points[Math.min(points.length - 1, index + 1)] ?? point;
      if (index > 0) distance += Math.hypot(point.x - previous.x, point.y - previous.y);
      const tangentLength = Math.max(1, Math.hypot(next.x - previous.x, next.y - previous.y));
      const tangent = {
        x: (next.x - previous.x) / tangentLength,
        y: (next.y - previous.y) / tangentLength,
      };
      samples.push({
        point,
        tangent,
        normal: { x: -tangent.y, y: tangent.x },
        distance,
      });
    }
    return samples;
  }

  private addCarriagewayRoads(
    highwayId: string,
    direction: HighwayCarriagewayDirection,
    points: readonly PlannedTilePoint[],
    roads: PlannedRoadSegment[],
  ): string[] {
    const ids: string[] = [];
    for (let index = 1; index < points.length; index++) {
      const from = points[index - 1];
      const to = points[index];
      if (!from || !to) continue;
      const id = `${highwayId}:${direction}:carriageway:${index - 1}`;
      ids.push(id);
      roads.push({
        id,
        from: { ...from },
        to: { ...to },
        hierarchy: 'highway',
        halfWidth: 1,
        highwayId,
        direction: 'forward',
        highwayComponent: 'carriageway',
        carriageway: direction,
        laneCount: 3,
        designSpeed: 220,
      });
    }
    return ids;
  }

  private addServiceAreas(
    profile: RouteProfile,
    alignment: readonly AlignmentPoint[],
    forward: readonly PlannedTilePoint[],
    reverse: readonly PlannedTilePoint[],
    roads: PlannedRoadSegment[],
  ): HighwayServiceArea[] {
    const total = alignment[alignment.length - 1]?.distance ?? 0;
    const count = Math.max(1, Math.ceil(total / 3600) - 1);
    const nominalSpacing = total / (count + 1);
    const result: HighwayServiceArea[] = [];
    for (let index = 0; index < count; index++) {
      const jitter = (this.hash(index + 83, this.seed ^ profile.id.length) - 0.5) * 0.1;
      const distance = nominalSpacing * (index + 1 + jitter);
      const sample = this.sampleAtDistance(alignment, distance);
      const side: HighwayCarriagewayDirection = index % 2 === 0 ? 'forward' : 'reverse';
      const chain = side === 'forward' ? forward : reverse;
      const chainIndex = this.nearestChainIndex(chain, sample.point);
      // Three mainline graph spans create a long parallel lay-by. This keeps
      // both connectors shallow and prevents the old U-shaped service loop.
      const startIndex = Math.max(0, Math.min(chain.length - 4, chainIndex - 1));
      const endIndex = startIndex + 3;
      const start = chain[startIndex];
      const end = chain[endIndex];
      if (!start || !end) continue;
      const startWorld = this.tileToWorld(start);
      const endWorld = this.tileToWorld(end);
      const legalTangent = normalized({
        x: endWorld.x - startWorld.x,
        y: endWorld.y - startWorld.y,
      });
      const outward = { x: legalTangent.y, y: -legalTangent.x };
      const apronOffset = TILE_SIZE * 3.5;
      const approach = this.worldToTile({
        x: startWorld.x + legalTangent.x * TILE_SIZE * 7 + outward.x * apronOffset,
        y: startWorld.y + legalTangent.y * TILE_SIZE * 7 + outward.y * apronOffset,
      });
      const departure = this.worldToTile({
        x: endWorld.x - legalTangent.x * TILE_SIZE * 7 + outward.x * apronOffset,
        y: endWorld.y - legalTangent.y * TILE_SIZE * 7 + outward.y * apronOffset,
      });
      const roadIds = [
        `${profile.id}:service:${index}:entry`,
        `${profile.id}:service:${index}:frontage`,
        `${profile.id}:service:${index}:exit`,
      ];
      roads.push(
        {
          id: roadIds[0] ?? '',
          from: { ...start },
          to: approach,
          hierarchy: 'access',
          halfWidth: 1,
          highwayId: profile.id,
          direction: 'forward',
          highwayComponent: 'service-road',
          carriageway: side,
          laneCount: 1,
          laneTransition: 'deceleration',
        },
        {
          id: roadIds[1] ?? '',
          from: approach,
          to: departure,
          hierarchy: 'access',
          halfWidth: 1,
          highwayId: profile.id,
          direction: 'forward',
          highwayComponent: 'service-road',
          carriageway: side,
          laneCount: 1,
        },
        {
          id: roadIds[2] ?? '',
          from: departure,
          to: { ...end },
          hierarchy: 'access',
          halfWidth: 1,
          highwayId: profile.id,
          direction: 'forward',
          highwayComponent: 'service-road',
          carriageway: side,
          laneCount: 1,
          laneTransition: 'acceleration',
        },
      );
      const center = {
        x: (this.tileToWorld(approach).x + this.tileToWorld(departure).x) / 2 + outward.x * 110,
        y: (this.tileToWorld(approach).y + this.tileToWorld(departure).y) / 2 + outward.y * 110,
      };
      const facilities = this.serviceFacilities(index);
      const lateral = { x: -legalTangent.y, y: legalTangent.x };
      result.push({
        id: `${profile.id}:service:${index}`,
        name: `${profile.name.split('/')[0]?.trim() ?? profile.name} Service ${index + 1}`,
        position: center,
        side,
        kilometer: Math.round(distance / 100) / 10,
        facilities,
        accessRoadIds: roadIds,
        parkingSpaces: Array.from(
          { length: facilities.includes('truck-parking') ? 9 : 6 },
          (_, slot) => ({
            x: center.x + legalTangent.x * ((slot - 3) * 34) + lateral.x * 42,
            y: center.y + legalTangent.y * ((slot - 3) * 34) + lateral.y * 42,
          }),
        ),
        visitorSpawns: Array.from({ length: 5 }, (_, visitor) => ({
          x: center.x + legalTangent.x * ((visitor - 2) * 24) - lateral.x * 28,
          y: center.y + legalTangent.y * ((visitor - 2) * 24) - lateral.y * 28,
        })),
      });
    }
    return result;
  }

  private serviceFacilities(_index: number): HighwayServiceFacility[] {
    // HighwayCanvasPainter owns only a ground plane. Until service buildings
    // are authored as PlannedBuilding records, expose only facilities that can
    // honestly exist as marked pavement, low pump/charger islands or open-air
    // public realm. Structural amenities must never be implied by fake roofs.
    return ['fuel', 'parking', 'truck-parking', 'rest-area', 'ev-charging', 'picnic'];
  }

  private buildStructures(
    profile: RouteProfile,
    alignment: readonly AlignmentPoint[],
  ): HighwayStructure[] {
    const total = alignment[alignment.length - 1]?.distance ?? 0;
    const definitions: Array<[HighwayStructureKind, number, number]> =
      profile.character === 'mountain'
        ? [
            ['retaining-wall', 0.22, 0.06],
            ['tunnel', 0.42, 0.08],
            ['bridge', 0.64, 0.06],
            ['mountain-cut', 0.79, 0.08],
          ]
        : profile.character === 'desert'
          ? [
              ['underpass', 0.3, 0.035],
              ['bridge', 0.54, 0.045],
              ['mountain-cut', 0.76, 0.055],
            ]
          : [
              ['bridge', 0.24, 0.055],
              ['causeway', 0.51, 0.07],
              ['bridge', 0.73, 0.04],
            ];
    return definitions.map(([kind, fraction, extent], index) => ({
      id: `${profile.id}:structure:${index}`,
      kind,
      startDistance: total * (fraction - extent / 2),
      endDistance: total * (fraction + extent / 2),
      position: this.sampleAtDistance(alignment, total * fraction).point,
    }));
  }

  private buildFurniture(
    profile: RouteProfile,
    alignment: readonly AlignmentPoint[],
  ): HighwayFurnitureSite[] {
    const total = alignment[alignment.length - 1]?.distance ?? 0;
    const result: HighwayFurnitureSite[] = [];
    const types: readonly HighwayFurnitureKind[] = [
      'direction-sign',
      'speed-limit',
      'warning',
      'emergency-phone',
      'traffic-camera',
      'distance-sign',
      'drainage',
      'variable-message-sign',
      'exit-lighting',
      'crash-cushion',
    ];
    let ordinal = 0;
    for (let distance = 420; distance < total - 320; distance += 560) {
      const sample = this.sampleAtDistance(alignment, distance);
      const side = ordinal % 2 === 0 ? 1 : -1;
      const kind = types[ordinal % types.length] ?? 'reflector';
      result.push({
        id: `${profile.id}:furniture:${ordinal}`,
        kind,
        position: {
          x: sample.point.x + sample.normal.x * CARRIAGEWAY_OFFSET * 1.62 * side,
          y: sample.point.y + sample.normal.y * CARRIAGEWAY_OFFSET * 1.62 * side,
        },
        heading: Math.atan2(sample.tangent.y, sample.tangent.x),
        label:
          kind === 'direction-sign' || kind === 'distance-sign'
            ? `${profile.to.toUpperCase()} ${Math.max(1, Math.round((total - distance) / 1000))} km`
            : kind === 'speed-limit'
              ? '120'
              : undefined,
      });
      ordinal++;
    }
    for (let distance = 96; distance < total; distance += 128) {
      const sample = this.sampleAtDistance(alignment, distance);
      result.push({
        id: `${profile.id}:reflector:${Math.round(distance)}`,
        kind: 'reflector',
        position: {
          x: sample.point.x + sample.normal.x * (CARRIAGEWAY_OFFSET + CARRIAGEWAY_WIDTH * 0.46),
          y: sample.point.y + sample.normal.y * (CARRIAGEWAY_OFFSET + CARRIAGEWAY_WIDTH * 0.46),
        },
        heading: Math.atan2(sample.tangent.y, sample.tangent.x),
      });
    }
    return result;
  }

  private buildScenery(
    profile: RouteProfile,
    alignment: readonly AlignmentPoint[],
  ): HighwayScenerySite[] {
    const total = alignment[alignment.length - 1]?.distance ?? 0;
    const result: HighwayScenerySite[] = [];
    let ordinal = 0;
    for (let distance = 520; distance < total - 400; distance += 720) {
      const t = distance / total;
      const palette =
        t < 0.2
          ? CITY_SCENERY[profile.from]
          : t > 0.8
            ? CITY_SCENERY[profile.to]
            : CHARACTER_SCENERY[profile.character];
      const sample = this.sampleAtDistance(alignment, distance);
      const side = this.hash(ordinal + 211, this.seed ^ profile.id.length) > 0.5 ? 1 : -1;
      const kind = palette[ordinal % palette.length] ?? 'billboard';
      const offset = TILE_SIZE * (15 + this.hash(ordinal + 97, this.seed) * 12);
      result.push({
        id: `${profile.id}:scenery:${ordinal}`,
        kind,
        position: {
          x: sample.point.x + sample.normal.x * offset * side,
          y: sample.point.y + sample.normal.y * offset * side,
        },
        heading: Math.atan2(sample.tangent.y, sample.tangent.x),
        scale: 0.8 + this.hash(ordinal + 331, this.seed) * 0.7,
      });
      ordinal++;
    }
    return result;
  }

  private validateRoute(
    route: Omit<HighwayRoute, 'quality'>,
    allRoads: readonly PlannedRoadSegment[],
  ): HighwayQualityReport {
    const issues: string[] = [];
    let jaggedEdgeViolations = 0;
    for (const carriageway of route.carriageways) {
      for (let index = 2; index < carriageway.points.length; index++) {
        const a = carriageway.points[index - 2];
        const b = carriageway.points[index - 1];
        const c = carriageway.points[index];
        if (!a || !b || !c) continue;
        const first = Math.atan2(b.y - a.y, b.x - a.x);
        const second = Math.atan2(c.y - b.y, c.x - b.x);
        if (Math.abs(wrapAngle(second - first)) > 0.12) jaggedEdgeViolations++;
      }
    }
    const brokenGuardRails = route.carriageways.reduce(
      (count, carriageway) =>
        count + Number(!this.polylineContinuous(carriageway.points, TILE_SIZE * 1.6)),
      0,
    );
    const medianDiscontinuities = Number(!this.polylineContinuous(route.points, TILE_SIZE * 1.6));
    let opposingPavementOverlaps = 0;
    const forward = route.carriageways[0];
    const reverse = route.carriageways[1].points.slice().reverse();
    const checks = Math.min(forward.points.length, reverse.length);
    for (let index = 0; index < checks; index += 4) {
      const first = forward.points[index];
      const second = reverse[index];
      if (!first || !second) continue;
      const separation = Math.hypot(second.x - first.x, second.y - first.y);
      if (separation < forward.pavementWidth + route.medianWidth * 0.85) {
        opposingPavementOverlaps++;
      }
    }
    const brokenLaneMarkings = brokenGuardRails;
    const firstCrossSection = route.carriageways[0];
    const unexpectedLaneWidthChanges = route.carriageways.some(
      (carriageway) =>
        carriageway.laneCount !== 3 ||
        carriageway.laneWidth !== LANE_WIDTH ||
        carriageway.pavementWidth !== CARRIAGEWAY_WIDTH ||
        carriageway.shoulderWidth !== SHOULDER_WIDTH ||
        carriageway.pavementWidth !== carriageway.laneWidth * 3 + carriageway.shoulderWidth * 2 ||
        carriageway.pavementWidth !== firstCrossSection.pavementWidth,
    )
      ? 1
      : 0;
    const routeRoads = allRoads.filter((road) => road.highwayId === route.id);
    const roadIds = new Set(routeRoads.map((road) => road.id));
    const invalidRamps = route.interchanges.reduce(
      (count, interchange) =>
        count +
        interchange.entryRampIds.length +
        interchange.exitRampIds.length +
        interchange.circulatingRoadIds.length +
        interchange.transitionPaths.length +
        interchange.goreAreas.length,
      0,
    );
    const highwayDeadEnds = route.carriageways.reduce(
      (count, carriageway) =>
        count +
        Number(
          carriageway.roadSegmentIds.length < 2 ||
            carriageway.roadSegmentIds.some((id) => !roadIds.has(id)),
        ),
      0,
    );
    const totalLength = polylineLength(route.points);
    const serviceDistances = [
      0,
      ...route.serviceAreas.map((area) => area.kilometer * 1000).sort((a, b) => a - b),
      totalLength,
    ];
    let serviceSpacingViolations = 0;
    for (let index = 1; index < serviceDistances.length; index++) {
      const gap = (serviceDistances[index] ?? 0) - (serviceDistances[index - 1] ?? 0);
      if (gap < 2000 || gap > 4000) serviceSpacingViolations++;
    }
    const rampCurvatureViolations = 0;
    const overlappingMarkings = route.interchanges.reduce(
      (count, interchange) => count + interchange.metrics.markingOverlaps,
      0,
    );
    const shortMergeLanes = 0;
    const directLocalConnections = route.interchanges.filter(
      (junction) => !SUPPORTED_JUNCTION_KINDS.has(junction.kind),
    ).length;
    const oversizedGores = route.interchanges.reduce(
      (count, interchange) => count + interchange.goreAreas.length,
      0,
    );
    const roadEdgeIntersections = route.interchanges.reduce(
      (count, interchange) => count + interchange.metrics.edgeIntersections,
      0,
    );
    const terminalKeys = new Set(
      routeRoads
        .filter((road) => road.highwayComponent === 'carriageway')
        .flatMap((road) => [`${road.from.x},${road.from.y}`, `${road.to.x},${road.to.y}`]),
    );
    const missingHierarchyLinks = route.interchanges.reduce(
      (count, interchange) =>
        count +
        interchange.cityConnections.filter((connection) => {
          const tile = this.worldToTile(connection);
          return !terminalKeys.has(`${tile.x},${tile.y}`);
        }).length,
      0,
    );
    const missingCityGateZones = route.interchanges.filter(
      (interchange) =>
        interchange.gateZone.sites.length < 3 ||
        !interchange.gateZone.sites.some((site) => site.kind === 'direction-sign') ||
        !interchange.gateZone.sites.some((site) =>
          ['tree-belt', 'bushes', 'decorative-rocks', 'fence'].includes(site.kind),
        ),
    ).length;
    if (route.medianType !== 'concrete-barrier' || route.medianWidth !== MEDIAN_WIDTH) {
      issues.push('route does not use the fixed concrete median');
    }
    if (jaggedEdgeViolations > 0) issues.push(`${jaggedEdgeViolations} abrupt alignment changes`);
    if (brokenGuardRails > 0) issues.push(`${brokenGuardRails} discontinuous guard-rail runs`);
    if (medianDiscontinuities > 0) issues.push('median alignment is discontinuous');
    if (opposingPavementOverlaps > 0) issues.push('opposing carriageway pavement overlaps');
    if (brokenLaneMarkings > 0) issues.push('lane-marking source geometry is discontinuous');
    if (unexpectedLaneWidthChanges > 0) issues.push('an unmodelled lane-width transition exists');
    if (highwayDeadEnds > 0) issues.push('a main carriageway is incomplete');
    if (invalidRamps > 0) issues.push(`${invalidRamps} forbidden interchange elements were generated`);
    if (serviceSpacingViolations > 0) {
      issues.push(`${serviceSpacingViolations} service-area intervals fall outside 2-4 km`);
    }
    if (rampCurvatureViolations > 0) issues.push(`${rampCurvatureViolations} ramp violations`);
    if (overlappingMarkings > 0) issues.push(`${overlappingMarkings} junction markings overlap`);
    if (shortMergeLanes > 0) issues.push(`${shortMergeLanes} merge lanes are too short`);
    if (directLocalConnections > 0) issues.push(`${directLocalConnections} unsupported city junctions`);
    if (oversizedGores > 0) issues.push(`${oversizedGores} forbidden gore areas were generated`);
    if (roadEdgeIntersections > 0) issues.push(`${roadEdgeIntersections} junction road edges intersect`);
    if (missingHierarchyLinks > 0) issues.push(`${missingHierarchyLinks} carriageway terminals miss the city grid`);
    if (missingCityGateZones > 0) issues.push(`${missingCityGateZones} city junctions lack roadside context`);
    return {
      passed: issues.length === 0,
      routes: 1,
      carriageways: route.carriageways.length,
      interchanges: route.interchanges.length,
      serviceAreas: route.serviceAreas.length,
      structures: route.structures.length,
      furnitureSites: route.furniture.length,
      scenerySites: route.scenery.length,
      jaggedEdgeViolations,
      brokenGuardRails,
      medianDiscontinuities,
      opposingPavementOverlaps,
      brokenLaneMarkings,
      unexpectedLaneWidthChanges,
      highwayDeadEnds,
      invalidRamps,
      serviceSpacingViolations,
      rampCurvatureViolations,
      overlappingMarkings,
      shortMergeLanes,
      directLocalConnections,
      oversizedGores,
      roadEdgeIntersections,
      missingHierarchyLinks,
      missingCityGateZones,
      issues,
    };
  }

  private combineQuality(routes: readonly HighwayRoute[]): HighwayQualityReport {
    const reports = routes.map((route) => route.quality);
    const sum = (select: (report: HighwayQualityReport) => number): number =>
      reports.reduce((total, report) => total + select(report), 0);
    const issues = reports.flatMap((report) => report.issues);
    return {
      passed: routes.length === ROUTES.length && issues.length === 0,
      routes: routes.length,
      carriageways: sum((report) => report.carriageways),
      interchanges: sum((report) => report.interchanges),
      serviceAreas: sum((report) => report.serviceAreas),
      structures: sum((report) => report.structures),
      furnitureSites: sum((report) => report.furnitureSites),
      scenerySites: sum((report) => report.scenerySites),
      jaggedEdgeViolations: sum((report) => report.jaggedEdgeViolations),
      brokenGuardRails: sum((report) => report.brokenGuardRails),
      medianDiscontinuities: sum((report) => report.medianDiscontinuities),
      opposingPavementOverlaps: sum((report) => report.opposingPavementOverlaps),
      brokenLaneMarkings: sum((report) => report.brokenLaneMarkings),
      unexpectedLaneWidthChanges: sum((report) => report.unexpectedLaneWidthChanges),
      highwayDeadEnds: sum((report) => report.highwayDeadEnds),
      invalidRamps: sum((report) => report.invalidRamps),
      serviceSpacingViolations: sum((report) => report.serviceSpacingViolations),
      rampCurvatureViolations: sum((report) => report.rampCurvatureViolations),
      overlappingMarkings: sum((report) => report.overlappingMarkings),
      shortMergeLanes: sum((report) => report.shortMergeLanes),
      directLocalConnections: sum((report) => report.directLocalConnections),
      oversizedGores: sum((report) => report.oversizedGores),
      roadEdgeIntersections: sum((report) => report.roadEdgeIntersections),
      missingHierarchyLinks: sum((report) => report.missingHierarchyLinks),
      missingCityGateZones: sum((report) => report.missingCityGateZones),
      issues,
    };
  }

  private gateway(city: WorldCity, side: PortalSide, ratio: number): Vector2 {
    const minX = Math.floor(city.bounds.x / TILE_SIZE);
    const minY = Math.floor(city.bounds.y / TILE_SIZE);
    const maxX = Math.floor((city.bounds.x + city.bounds.width - 1) / TILE_SIZE);
    const maxY = Math.floor((city.bounds.y + city.bounds.height - 1) / TILE_SIZE);
    const x = this.snapRoad(minX + (maxX - minX) * ratio, minX, maxX);
    const y = this.snapRoad(minY + (maxY - minY) * ratio, minY, maxY);
    if (side === 'north') return this.tileToWorld({ x, y: this.snapRoad(minY, minY, maxY) });
    if (side === 'south') return this.tileToWorld({ x, y: this.snapRoad(maxY, minY, maxY) });
    if (side === 'west') return this.tileToWorld({ x: this.snapRoad(minX, minX, maxX), y });
    return this.tileToWorld({ x: this.snapRoad(maxX, minX, maxX), y });
  }

  private requireGraphPoint(
    routeId: string,
    points: readonly PlannedTilePoint[],
    index: number,
  ): PlannedTilePoint {
    const point = points[index];
    if (!point) throw new Error(`${routeId} lacks transition graph clearance at ${index}`);
    return point;
  }

  private snapRoad(value: number, minimum: number, maximum: number): number {
    const minimumBand = Math.ceil((minimum - this.roadMid) / this.roadPeriod);
    const maximumBand = Math.floor((maximum - this.roadMid) / this.roadPeriod);
    const band = Math.max(
      minimumBand,
      Math.min(maximumBand, Math.round((value - this.roadMid) / this.roadPeriod)),
    );
    return band * this.roadPeriod + this.roadMid;
  }

  private offsetPolyline(points: readonly Vector2[], offset: number): Vector2[] {
    return points.map((point, index) => {
      const previous = points[Math.max(0, index - 1)] ?? point;
      const next = points[Math.min(points.length - 1, index + 1)] ?? point;
      const tangent = normalized({ x: next.x - previous.x, y: next.y - previous.y });
      const right = { x: tangent.y, y: -tangent.x };
      return { x: point.x + right.x * offset, y: point.y + right.y * offset };
    });
  }

  private resamplePolyline(points: readonly Vector2[], spacing: number): Vector2[] {
    const total = polylineLength(points);
    if (points.length < 2 || total <= 0) return points.slice();
    const result: Vector2[] = [];
    for (let distance = 0; distance < total; distance += spacing) {
      result.push(pointAtPolylineDistance(points, distance));
    }
    const last = points[points.length - 1];
    if (last) result.push({ ...last });
    return result;
  }

  private toTileChain(points: readonly Vector2[]): PlannedTilePoint[] {
    const result: PlannedTilePoint[] = [];
    for (const point of points) {
      const tile = this.worldToTile(point);
      const previous = result[result.length - 1];
      if (!previous || Math.hypot(tile.x - previous.x, tile.y - previous.y) >= 5) {
        result.push(tile);
      }
    }
    return result;
  }

  private nearestChainIndex(points: readonly PlannedTilePoint[], target: Vector2): number {
    let bestIndex = 0;
    let bestDistance = Infinity;
    for (let index = 0; index < points.length; index++) {
      const point = points[index];
      if (!point) continue;
      const world = this.tileToWorld(point);
      const distance = (world.x - target.x) ** 2 + (world.y - target.y) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
    return bestIndex;
  }

  private sampleAtDistance(alignment: readonly AlignmentPoint[], distance: number): AlignmentPoint {
    const fallback = alignment[alignment.length - 1];
    if (!fallback) {
      return {
        point: { x: 0, y: 0 },
        tangent: { x: 1, y: 0 },
        normal: { x: 0, y: 1 },
        distance: 0,
      };
    }
    let low = 0;
    let high = alignment.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if ((alignment[middle]?.distance ?? Infinity) < distance) low = middle + 1;
      else high = middle;
    }
    return alignment[low] ?? fallback;
  }

  private polylineContinuous(points: readonly Vector2[], maximumGap: number): boolean {
    if (points.length < 2) return false;
    for (let index = 1; index < points.length; index++) {
      const previous = points[index - 1];
      const point = points[index];
      if (
        !previous ||
        !point ||
        Math.hypot(point.x - previous.x, point.y - previous.y) > maximumGap
      ) {
        return false;
      }
    }
    return true;
  }

  private requireCity(id: CityId): WorldCity {
    const city = this.cities.find((candidate) => candidate.id === id);
    if (!city) throw new Error(`Highway planner cannot find city ${id}`);
    return city;
  }

  private worldToTile(point: Vector2): PlannedTilePoint {
    return { x: Math.floor(point.x / TILE_SIZE), y: Math.floor(point.y / TILE_SIZE) };
  }

  private tileToWorld(point: PlannedTilePoint): Vector2 {
    return { x: point.x * TILE_SIZE + TILE_SIZE / 2, y: point.y * TILE_SIZE + TILE_SIZE / 2 };
  }

  private hash(value: number, seed: number): number {
    let state = (value * 374761393 + seed * 668265263) | 0;
    state = (state ^ (state >>> 13)) * 1274126177;
    return ((state ^ (state >>> 16)) >>> 0) / 4294967296;
  }
}

/** Build only cardinal straights joined by explicitly sampled large-radius bends. */
function roundedCardinalPath(
  controls: readonly Vector2[],
  requestedRadius: number,
  spacing: number,
): Vector2[] {
  const first = controls[0];
  if (!first) return [];
  const result: Vector2[] = [{ ...first }];
  for (let index = 1; index < controls.length - 1; index++) {
    const previous = controls[index - 1];
    const corner = controls[index];
    const next = controls[index + 1];
    if (!previous || !corner || !next) continue;
    const incoming = normalized({ x: corner.x - previous.x, y: corner.y - previous.y });
    const outgoing = normalized({ x: next.x - corner.x, y: next.y - corner.y });
    const incomingLength = Math.hypot(corner.x - previous.x, corner.y - previous.y);
    const outgoingLength = Math.hypot(next.x - corner.x, next.y - corner.y);
    const radius = Math.min(requestedRadius, incomingLength * 0.42, outgoingLength * 0.42);
    const start = {
      x: corner.x - incoming.x * radius,
      y: corner.y - incoming.y * radius,
    };
    const end = {
      x: corner.x + outgoing.x * radius,
      y: corner.y + outgoing.y * radius,
    };
    appendLinearSamples(result, start, spacing);
    const curveSteps = Math.max(8, Math.ceil((Math.PI * radius * 0.5) / spacing));
    for (let step = 1; step <= curveSteps; step++) {
      const amount = step / curveSteps;
      const inverse = 1 - amount;
      result.push({
        x: inverse * inverse * start.x + 2 * inverse * amount * corner.x + amount * amount * end.x,
        y: inverse * inverse * start.y + 2 * inverse * amount * corner.y + amount * amount * end.y,
      });
    }
  }
  const last = controls[controls.length - 1];
  if (last) appendLinearSamples(result, last, spacing);
  return result;
}

function appendLinearSamples(points: Vector2[], target: Vector2, spacing: number): void {
  const origin = points[points.length - 1];
  if (!origin) {
    points.push({ ...target });
    return;
  }
  const length = Math.hypot(target.x - origin.x, target.y - origin.y);
  const steps = Math.max(1, Math.ceil(length / spacing));
  for (let step = 1; step <= steps; step++) {
    const amount = step / steps;
    points.push({
      x: origin.x + (target.x - origin.x) * amount,
      y: origin.y + (target.y - origin.y) * amount,
    });
  }
}

function normalized(vector: Vector2): Vector2 {
  const length = Math.max(1, Math.hypot(vector.x, vector.y));
  return { x: vector.x / length, y: vector.y / length };
}

function polylineLength(points: readonly Vector2[]): number {
  let length = 0;
  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1];
    const point = points[index];
    if (previous && point) length += Math.hypot(point.x - previous.x, point.y - previous.y);
  }
  return length;
}

function pointAtPolylineDistance(points: readonly Vector2[], distance: number): Vector2 {
  const first = points[0] ?? { x: 0, y: 0 };
  if (distance <= 0) return { ...first };
  let travelled = 0;
  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1];
    const point = points[index];
    if (!previous || !point) continue;
    const length = Math.hypot(point.x - previous.x, point.y - previous.y);
    if (travelled + length >= distance) {
      const amount = length <= 0 ? 0 : (distance - travelled) / length;
      return {
        x: previous.x + (point.x - previous.x) * amount,
        y: previous.y + (point.y - previous.y) * amount,
      };
    }
    travelled += length;
  }
  const last = points[points.length - 1] ?? first;
  return { ...last };
}

function wrapAngle(angle: number): number {
  let result = angle;
  while (result > Math.PI) result -= Math.PI * 2;
  while (result < -Math.PI) result += Math.PI * 2;
  return result;
}
