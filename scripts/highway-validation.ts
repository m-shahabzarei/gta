import { TILE_SIZE } from '@/config/Constants';
import { HighwayPlanner } from '@/generation/HighwayPlanner';
import { SUPPORTED_INTERCHANGE_KINDS } from '@/generation/HighwayTransitionPlanner';
import {
  HighwayGeometryIndex,
  highwayRampWidthAt,
  offsetSpline,
  smoothSpline,
} from '@/gameplay/highway';
import type { CityId, MapData, PlannedRoadSegment, Vector2, WorldCity } from '@/gameplay/types';

const FIXED = {
  lanesPerDirection: 3,
  laneWidth: 24,
  shoulderWidth: 10,
  pavementWidth: 92,
  medianWidth: 18,
  carriagewaySeparation: 110,
} as const;

const cities: WorldCity[] = [
  city('tehran', 'TEHRAN', 120, 720, 1020, 620),
  city('yazd', 'YAZD', 1450, 500, 360, 390),
  city('gilan', 'GILAN', 100, 70, 520, 390),
];
const result = HighwayPlanner.generate(1337, cities, 12, 1);
const repeated = HighwayPlanner.generate(1337, cities, 12, 1);
const failures: string[] = [];
let assertions = 0;

check(result.quality.passed, 'national highway quality report must pass');
check(result.routes.length === 3, 'three national corridors must be generated');
check(result.quality.carriageways === 6, 'every route must have exactly two carriageways');
check(result.quality.interchanges === 6, 'every route must have two city junctions');
check(result.quality.serviceAreas >= 6, 'national routes must contain recurring rest areas');
check(new Set(result.roads.map((road) => road.id)).size === result.roads.length, 'road ids repeat');
check(
  JSON.stringify(result) === JSON.stringify(repeated),
  'the same seed does not reproduce the same highway network',
);
check(
  SUPPORTED_INTERCHANGE_KINDS.join(',') === 't-junction,cross,priority-cross',
  'the junction vocabulary contains a complex interchange',
);

const geometry = HighwayGeometryIndex.build(
  {
    widthTiles: 2000,
    heightTiles: 1500,
    highways: result.routes,
    urbanPlan: { roads: result.roads },
  } as unknown as MapData,
  32,
);
const stats = geometry.stats;
check(stats.indexedChunks > 60, 'highway chunk spatial index is unexpectedly sparse');
check(stats.mainlineSections >= 6, 'indexed mainline sections are missing');
check(stats.medianSections >= 3, 'indexed median sections are missing');
check(stats.rampSections >= result.quality.serviceAreas, 'rest-area branches are missing');
check(stats.goreSections === 0, 'forbidden gore geometry entered the render index');
check(stats.gateZones === 6, 'simple city junction context is missing');
check(stats.splineSamples > 5_000, 'render splines are under-sampled');
check(stats.corridorTiles > 7_500, 'highway corridor mask is incomplete');
check(stats.railCollisionTiles < stats.splineSamples, 'guard-rail collision is not simplified');

const indexedServiceRoads = new Set<string>();
for (const chunkKey of geometry.chunkKeys()) {
  const chunk = geometry.getChunk(chunkKey);
  check(Boolean(chunk), `${chunkKey}: indexed chunk cannot be read`);
  if (!chunk) continue;
  check(chunk.gores.length === 0, `${chunkKey}: contains forbidden gore art`);
  check(
    chunk.railCollisionTiles.length <= 32 * 32,
    `${chunkKey}: guard-rail collision exceeds one coarse tile mask`,
  );
  for (const mainline of chunk.mainlines) {
    check(mainline.laneCount === 3, `${mainline.id}: render section is not three-lane`);
    check(mainline.laneWidth === FIXED.laneWidth, `${mainline.id}: render lane width changed`);
    check(
      mainline.pavementWidth === FIXED.pavementWidth,
      `${mainline.id}: render pavement width changed`,
    );
    check(
      mainline.shoulderWidth === FIXED.shoulderWidth,
      `${mainline.id}: render shoulder width changed`,
    );
  }
  for (const median of chunk.medians) {
    check(median.medianType === 'concrete-barrier', `${median.id}: median style changed`);
    check(median.width === FIXED.medianWidth, `${median.id}: median width changed`);
  }
  for (const ramp of chunk.ramps) {
    indexedServiceRoads.add(ramp.id);
    check(ramp.kind === 'service-road', `${ramp.id}: city ramp entered the render index`);
    check(ramp.elevation === 'ground', `${ramp.id}: service branch is elevated`);
    check(ramp.laneCount === 1, `${ramp.id}: service branch is not single-lane`);
    check(ramp.points.length >= 2, `${ramp.id}: service branch has no spline`);
    check(ramp.length > TILE_SIZE * 5, `${ramp.id}: service branch is too short`);
    check(
      ramp.taperStartDistance >= 0 &&
        ramp.taperEndDistance > ramp.taperStartDistance &&
        ramp.taperEndDistance <= ramp.length + 0.01,
      `${ramp.id}: service taper interval is invalid`,
    );
    check(
      (ramp.middleWidth ?? 0) > ramp.startWidth && (ramp.middleWidth ?? 0) > ramp.endWidth,
      `${ramp.id}: service branch does not widen and narrow cleanly`,
    );
    check(
      highwayRampWidthAt(ramp, 0) > 0 && highwayRampWidthAt(ramp, ramp.length) > 0,
      `${ramp.id}: service branch collapses at an endpoint`,
    );
  }
}
check(
  indexedServiceRoads.size === result.quality.serviceAreas,
  'not every rest-area branch entered the render index exactly once',
);

for (const route of result.routes) {
  const routeRoads = result.roads.filter((road) => road.highwayId === route.id);
  const mainlineRoads = routeRoads.filter((road) => road.highwayComponent === 'carriageway');
  const serviceRoads = routeRoads.filter((road) => road.highwayComponent === 'service-road');

  check(route.carriageways.length === 2, `${route.id}: route is not exactly two directions`);
  check(
    route.carriageways[0].direction === 'forward' &&
      route.carriageways[1].direction === 'reverse',
    `${route.id}: directions are not a symmetric forward/reverse pair`,
  );
  check(route.medianType === 'concrete-barrier', `${route.id}: median style is not fixed concrete`);
  check(route.medianWidth === FIXED.medianWidth, `${route.id}: median width is inconsistent`);
  check(mainlineRoads.length > 8, `${route.id}: mainline graph is under-segmented`);
  check(
    mainlineRoads.every(
      (road) =>
        road.direction === 'forward' &&
        road.laneCount === FIXED.lanesPerDirection &&
        road.highwayComponent === 'carriageway',
    ),
    `${route.id}: mainline graph violates legal three-lane direction`,
  );
  check(
    route.interchanges.every(
      (junction) =>
        junction.transitionPaths.length === 0 &&
        junction.goreAreas.length === 0 &&
        junction.entryRampIds.length === 0 &&
        junction.exitRampIds.length === 0 &&
        junction.circulatingRoadIds.length === 0,
    ),
    `${route.id}: complex city interchange geometry still exists`,
  );

  const physicalReverse = route.carriageways[1].points.slice().reverse();
  const pairedSamples = Math.min(route.carriageways[0].points.length, physicalReverse.length);
  for (let index = 0; index < pairedSamples; index += 8) {
    const directionA = route.carriageways[0].points[index];
    const directionB = physicalReverse[index];
    if (!directionA || !directionB) continue;
    check(
      Math.abs(distance(directionA, directionB) - FIXED.carriagewaySeparation) < 1.5,
      `${route.id}: carriageways lose symmetric spacing`,
    );
  }

  for (const carriageway of route.carriageways) {
    check(carriageway.laneCount === 3, `${carriageway.id}: lane count is not exactly three`);
    check(carriageway.laneWidth === FIXED.laneWidth, `${carriageway.id}: lane width changed`);
    check(
      carriageway.pavementWidth ===
        carriageway.laneCount * carriageway.laneWidth + carriageway.shoulderWidth * 2,
      `${carriageway.id}: cross-section is not the sum of equal lanes and shoulders`,
    );
    check(
      carriageway.pavementWidth === FIXED.pavementWidth &&
        carriageway.shoulderWidth === FIXED.shoulderWidth,
      `${carriageway.id}: fixed cross-section changed`,
    );
    const spline = smoothSpline(carriageway.points, 12);
    const leftEdge = offsetSpline(spline, -carriageway.pavementWidth * 0.5);
    const rightEdge = offsetSpline(spline, carriageway.pavementWidth * 0.5);
    check(spline.length > carriageway.points.length, `${carriageway.id}: spline is too coarse`);
    check(leftEdge.length === spline.length, `${carriageway.id}: left edge lost samples`);
    check(rightEdge.length === spline.length, `${carriageway.id}: right edge lost samples`);
    for (let index = 2; index < spline.length; index++) {
      const previous = spline[index - 1];
      const sample = spline[index];
      if (!previous || !sample) continue;
      check(
        Math.abs(
          wrapAngle(
            Math.atan2(sample.tangentY, sample.tangentX) -
              Math.atan2(previous.tangentY, previous.tangentX),
          ),
        ) < 0.12,
        `${carriageway.id}: curve contains a sharp or stair-step corner`,
      );
      check(
        leftEdge[index]?.distance === sample.distance &&
          rightEdge[index]?.distance === sample.distance,
        `${carriageway.id}: edges and lane markings lost shared arc distance`,
      );
    }
  }

  for (const junction of route.interchanges) {
    check(
      SUPPORTED_INTERCHANGE_KINDS.includes(junction.kind),
      `${junction.id}: unsupported city junction`,
    );
    check(junction.cityConnections.length === 2, `${junction.id}: carriageway anchors are missing`);
    check(junction.selectionReason.includes('at-grade'), `${junction.id}: not documented as at-grade`);
    check(
      junction.gateZone.sites.some((site) => site.kind === 'direction-sign'),
      `${junction.id}: roadside direction sign is missing`,
    );
    check(
      junction.gateZone.sites.some((site) =>
        ['tree-belt', 'bushes', 'decorative-rocks', 'fence'].includes(site.kind),
      ),
      `${junction.id}: roadside environment is empty`,
    );
    const terminalKeys = new Set(
      mainlineRoads.flatMap((road) => [key(road.from.x, road.from.y), key(road.to.x, road.to.y)]),
    );
    for (const connection of junction.cityConnections) {
      check(
        terminalKeys.has(key(Math.floor(connection.x / TILE_SIZE), Math.floor(connection.y / TILE_SIZE))),
        `${junction.id}: ordinary city-grid anchor misses a carriageway terminal`,
      );
    }
  }

  check(route.serviceAreas.length > 0, `${route.id}: has no rest area`);
  check(serviceRoads.length === route.serviceAreas.length * 3, `${route.id}: rest-area access is incomplete`);
  for (const area of route.serviceAreas) {
    for (const facility of [
      'fuel',
      'parking',
      'truck-parking',
      'rest-area',
      'ev-charging',
      'picnic',
    ] as const) {
      check(area.facilities.includes(facility), `${area.id}: missing ${facility}`);
    }
    for (const unplannedStructure of [
      'toilets',
      'restaurant',
      'repair',
      'coffee',
      'motel',
      'police',
      'ambulance',
      'mini-market',
    ] as const) {
      check(
        !area.facilities.includes(unplannedStructure),
        `${area.id}: advertises unplanned structural facility ${unplannedStructure}`,
      );
    }
    check(area.accessRoadIds.length === 3, `${area.id}: access is not entry/service/exit`);
    check(area.parkingSpaces.length >= 6, `${area.id}: parking is missing`);
    check(area.visitorSpawns.length >= 5, `${area.id}: pedestrian spawns are missing`);
    const access = area.accessRoadIds.flatMap((id) => routeRoads.filter((road) => road.id === id));
    check(access.length === 3, `${area.id}: graph does not own all access edges`);
    check(access.every((road) => road.direction === 'forward'), `${area.id}: access can reverse`);
    check(access[0]?.laneTransition === 'deceleration', `${area.id}: exit lane is not explicit`);
    check(access[2]?.laneTransition === 'acceleration', `${area.id}: merge lane is not explicit`);
  }
  const fakeArchitectureScenery = new Set([
    'industrial-buildings',
    'warehouses',
    'factory',
    'small-village',
  ]);
  check(
    route.scenery.every((site) => !fakeArchitectureScenery.has(site.kind)),
    `${route.id}: highway scenery contains unowned building silhouettes`,
  );

  const fromJunction = route.interchanges.find((junction) => junction.cityId === route.from);
  const toJunction = route.interchanges.find((junction) => junction.cityId === route.to);
  check(
    Boolean(
      fromJunction &&
        toJunction &&
        directedReachable(routeRoads, fromJunction.cityConnections[0], toJunction.cityConnections[0]) &&
        directedReachable(routeRoads, toJunction.cityConnections[1], fromJunction.cityConnections[1]),
    ),
    `${route.id}: the two legal directions do not connect both cities`,
  );
  check(route.structures.every((structure) => structure.kind !== 'overpass'), `${route.id}: contains a flyover`);
  check(route.furniture.length > 20, `${route.id}: road signs/furniture are too sparse`);
  check(route.scenery.length > 8, `${route.id}: roadside environment is too sparse`);
  check(route.quality.passed, `${route.id}: route quality report failed`);
}

for (const road of result.roads) {
  check(distance(road.from, road.to) >= 5, `${road.id}: edge is below runtime lane length`);
  check(road.direction === 'forward', `${road.id}: highway-owned edge can reverse`);
  check(road.halfWidth <= 1, `${road.id}: hidden raster road protrudes beyond the clean highway art`);
}

if (failures.length > 0) {
  console.error(`Highway validation FAILED (${failures.length} failures / ${assertions} checks)`);
  for (const failure of failures) console.error(` - ${failure}`);
  process.exitCode = 1;
} else {
  console.log('Highway validation PASSED');
  console.log(`  ${assertions} invariant checks`);
  console.log(
    `  ${result.routes.length} routes, ${result.quality.carriageways} three-lane carriageways, ` +
      `${result.roads.length} directed graph edges`,
  );
  console.log(
    `  ${result.quality.interchanges} simple city junctions, ${result.quality.serviceAreas} rest areas, ` +
      `0 ramps, 0 gores, 0 flyovers`,
  );
}

function check(condition: boolean, message: string): void {
  assertions++;
  if (!condition) failures.push(message);
}

function directedReachable(
  roads: readonly PlannedRoadSegment[],
  origin: Vector2,
  target: Vector2,
): boolean {
  const adjacency = new Map<string, Set<string>>();
  for (const road of roads) {
    const from = key(road.from.x, road.from.y);
    const to = key(road.to.x, road.to.y);
    const outgoing = adjacency.get(from) ?? new Set<string>();
    outgoing.add(to);
    adjacency.set(from, outgoing);
  }
  const start = key(Math.floor(origin.x / TILE_SIZE), Math.floor(origin.y / TILE_SIZE));
  const end = key(Math.floor(target.x / TILE_SIZE), Math.floor(target.y / TILE_SIZE));
  const visited = new Set<string>([start]);
  const queue = [start];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const point = queue[cursor];
    if (!point) continue;
    if (point === end) return true;
    for (const next of adjacency.get(point) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      queue.push(next);
    }
  }
  return false;
}

function distance(first: Vector2, second: Vector2): number {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

function key(x: number, y: number): string {
  return `${x},${y}`;
}

function wrapAngle(angle: number): number {
  let wrapped = angle;
  while (wrapped > Math.PI) wrapped -= Math.PI * 2;
  while (wrapped < -Math.PI) wrapped += Math.PI * 2;
  return wrapped;
}

function city(
  id: CityId,
  name: WorldCity['name'],
  x: number,
  y: number,
  width: number,
  height: number,
): WorldCity {
  const bounds = {
    x: x * TILE_SIZE,
    y: y * TILE_SIZE,
    width: width * TILE_SIZE,
    height: height * TILE_SIZE,
  };
  return {
    id,
    name,
    center: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
    bounds,
    color: 0xffffff,
    theme: 'validation fixture',
    pedestrianDensity: 1,
    trafficDensity: id === 'tehran' ? 1.4 : 1,
    weather: 'clear',
    atmosphere: {
      lightingTint: 0xffffff,
      architecture: 'fixture',
      roadMaterial: 'fixture',
      vegetation: 'fixture',
      ambientSound: 'fixture',
      signStyle: 'fixture',
      vehicleProfile: 'fixture',
      weatherWeights: { clear: 1, rain: 0, storm: 0, fog: 0 },
    },
  };
}
