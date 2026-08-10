import { CITY_TRANSIT_CONFIG, calculateTaxiFare, TRANSIT_PIXELS_PER_KILOMETER } from '@/gameplay/transit';
import { passengerSeatsFor } from '@/gameplay/occupants/OccupantRules';
import { TrafficNetwork } from '@/gameplay/traffic/TrafficNetwork';
import { sampleSpline } from '@/gameplay/traffic/SplineMath';
import type { BusStopSite, CityId, RoadEdge, RoadNode } from '@/gameplay/types';

const failures: string[] = [];
let assertions = 0;

function check(condition: boolean, message: string): void {
  assertions += 1;
  if (!condition) failures.push(message);
}

validateCityConfiguration();
validateFareCalculation();
validateTransitSeatPolicy();
validateLaneBackedStopsAndRoutes();

if (failures.length > 0) {
  console.error(`Transit validation FAILED (${failures.length} failures / ${assertions} checks)`);
  for (const failure of failures) console.error(` - ${failure}`);
  process.exitCode = 1;
} else {
  console.log('Transit validation PASSED');
  console.log(`  ${assertions} configuration, fare, seat, and lane-route invariants`);
  console.log('  city-specific routes, driver/passenger capacity, and legal curb-stop routing passed');
}

function validateCityConfiguration(): void {
  const cities = ['tehran', 'yazd', 'gilan'] as const satisfies readonly CityId[];
  check(CITY_TRANSIT_CONFIG.tehran.busRoutes.length === 4, 'Tehran must expose exactly four initial bus lines');
  check(CITY_TRANSIT_CONFIG.yazd.busRoutes.length >= 1, 'Yazd requires a smaller active bus network');
  check(CITY_TRANSIT_CONFIG.gilan.busRoutes.length >= 1, 'Gilan requires an active bus network');

  const routeIds = new Set<string>();
  for (const cityId of cities) {
    const config = CITY_TRANSIT_CONFIG[cityId];
    check(config.cityId === cityId, `${cityId}: city configuration id mismatch`);
    check(config.taxi.population > 0, `${cityId}: taxi population must be positive`);
    check(config.taxi.baseFare > 0, `${cityId}: taxi base fare must be positive`);
    check(config.taxi.perKilometerFare > 0, `${cityId}: taxi distance fare must be positive`);
    check(config.taxi.serviceLandmarkIds.length >= 3, `${cityId}: taxi service area is too small`);
    for (const route of config.busRoutes) {
      check(!routeIds.has(route.id), `${route.id}: route ids must be globally unique`);
      routeIds.add(route.id);
      check(route.active, `${route.id}: configured launch lines must be active`);
      check(route.anchors.length >= 3, `${route.id}: route must have at least three useful stops`);
      check(route.vehicles >= 1, `${route.id}: route requires at least one assigned bus`);
      check(route.stopDurationMs >= 4500 && route.stopDurationMs <= 6500, `${route.id}: dwell must remain believable`);
      check(
        route.passengerCapacity === passengerSeatsFor('bus').length,
        `${route.id}: configured capacity must match real bus passenger seats`,
      );
      const anchors = new Set(route.anchors.map((anchor) => anchor.id));
      check(anchors.size === route.anchors.length, `${route.id}: duplicate route anchor`);
      check(route.anchors.every((anchor) => anchor.landmarkIds.length > 0), `${route.id}: anchor lacks landmarks`);
    }
  }
  check(
    CITY_TRANSIT_CONFIG.tehran.taxi.population > CITY_TRANSIT_CONFIG.yazd.taxi.population &&
      CITY_TRANSIT_CONFIG.tehran.taxi.population > CITY_TRANSIT_CONFIG.gilan.taxi.population,
    'Tehran must retain the highest taxi density',
  );
  check(
    CITY_TRANSIT_CONFIG.tehran.taxi.baseFare !== CITY_TRANSIT_CONFIG.yazd.taxi.baseFare &&
      CITY_TRANSIT_CONFIG.yazd.taxi.baseFare !== CITY_TRANSIT_CONFIG.gilan.taxi.baseFare,
    'cities must not share an identical taxi fare configuration',
  );
}

function validateFareCalculation(): void {
  const route = {
    laneIds: ['fixture:a', 'fixture:b'],
    distancePx: 3.2 * TRANSIT_PIXELS_PER_KILOMETER,
    start: { x: 0, y: 0 },
    end: { x: 100, y: 100 },
  };
  const first = calculateTaxiFare(CITY_TRANSIT_CONFIG.tehran.taxi, route, 0);
  const second = calculateTaxiFare(CITY_TRANSIT_CONFIG.tehran.taxi, route, 0);
  check(first.baseFare === 20, 'Tehran base fare must remain data-driven at $20');
  check(first.distanceKm === 3.2, 'fare must use route distance, not a straight-line substitute');
  check(first.distanceCost === 36, '3.2 km Tehran route should charge $36 distance fare');
  check(first.total === 56, 'fare total must be base plus legal route distance cost');
  check(first.total === second.total, 'fare preview must be idempotent before payment');
  const congested = calculateTaxiFare(CITY_TRANSIT_CONFIG.tehran.taxi, route, 1);
  check(congested.total > first.total, 'traffic factor must increase a congested legal-route fare');
  const waiting = calculateTaxiFare(CITY_TRANSIT_CONFIG.yazd.taxi, route, 0, 2);
  check(waiting.waitingCost === 4, 'optional city waiting charge must be applied exactly once per quote');
}

function validateTransitSeatPolicy(): void {
  check(passengerSeatsFor('bus').length === 5, 'bus must expose five dynamic passenger seats');
  check(passengerSeatsFor('taxi').length === 1, 'taxi must expose its dedicated rider seat independently of its driver');
  check(
    !passengerSeatsFor('bus').includes('driver') && !passengerSeatsFor('taxi').includes('driver'),
    'service drivers must never be claimable passenger seats',
  );
}

function validateLaneBackedStopsAndRoutes(): void {
  const network = new TrafficNetwork(fixtureNodes(), [], fixtureEdges());
  const travelLanes = network.lanes().filter((lane) => lane.kind === 'travel');
  check(travelLanes.length >= 8, 'fixture must expose directed travel lanes');
  const lane = travelLanes.find((candidate) => candidate.spline.length > 260) ?? null;
  check(lane !== null, 'fixture must expose a lane long enough for a legal curb stop');
  if (!lane) return;

  const stop = fixtureStop(lane.id, lane.spline.length);
  const resolvedLane = network.lane(stop.laneId);
  check(resolvedLane?.kind === 'travel', 'bus stop must be attached to a directed travel lane');
  check(stop.laneDistance > 80, 'bus stop must clear the incoming junction');
  check(stop.laneDistance < stop.laneLength - 80, 'bus stop must clear the outgoing junction');
  check(stop.waitingPositions.length === stop.capacity, 'every bus stop capacity needs a distinct queue slot');
  check(
    new Set(stop.waitingPositions.map((position) => `${position.x},${position.y}`)).size === stop.capacity,
    'waiting positions must not stack passengers',
  );
  const pose = sampleSpline(lane.spline, stop.laneDistance);
  check(Number.isFinite(pose.point.x) && Number.isFinite(pose.heading), 'stop approach must be sampleable on its lane');

  const origin = travelLanes[0];
  const destination = travelLanes.find(
    (candidate) => candidate.id !== origin?.id && network.findCompleteRoute(origin?.id ?? '', candidate.id),
  );
  check(origin !== undefined && destination !== undefined, 'fixture must contain a connected directed lane pair');
  if (!origin || !destination) return;
  const route = network.findCompleteRoute(origin.id, destination.id);
  check(route !== null && route.length >= 1, 'bus/taxi route must resolve through the shared lane graph');
  if (!route) return;
  check(route[0]?.id === origin.id, 'legal route must start on requested traffic lane');
  check(route[route.length - 1]?.id === destination.id, 'legal route must end on requested traffic lane');
  for (let index = 0; index < route.length - 1; index += 1) {
    const current = route[index];
    const next = route[index + 1];
    check(Boolean(current && next && current.connectionIds.includes(next.id)), `route step ${index} is not a legal turn`);
  }
}

function fixtureStop(laneId: string, laneLength: number): BusStopSite {
  return {
    id: 'bus-stop:tehran:fixture',
    cityId: 'tehran',
    x: 332,
    y: 44,
    facing: 0,
    laneId,
    approachPosition: { x: 320, y: 0 },
    laneDistance: laneLength / 2,
    laneLength,
    heading: 0,
    capacity: 3,
    waitingEntityIds: [],
    waitingPositions: [
      { x: 332, y: 44 },
      { x: 348, y: 44 },
      { x: 364, y: 44 },
    ],
  };
}

function fixtureNodes(): RoadNode[] {
  return [
    { id: 0, x: -480, y: 0, neighbours: [1] },
    { id: 1, x: 0, y: 0, neighbours: [0, 2, 3, 4] },
    { id: 2, x: 480, y: 0, neighbours: [1] },
    { id: 3, x: 0, y: -480, neighbours: [1] },
    { id: 4, x: 0, y: 480, neighbours: [1] },
  ];
}

function fixtureEdges(): RoadEdge[] {
  return [
    edge('west', 0, 1),
    edge('east', 1, 2),
    edge('north', 1, 3),
    edge('south', 1, 4),
  ];
}

function edge(id: string, fromNodeId: number, toNodeId: number): RoadEdge {
  return {
    id,
    fromNodeId,
    toNodeId,
    roadClass: 'arterial',
    laneCount: 2,
    speedLimit: 110,
    direction: 'both',
    priority: 3,
    surface: 'urban-asphalt',
    navigationAllowed: true,
    trafficAllowed: true,
    pedestrianAllowed: true,
    emergencyAllowed: true,
    shoulder: false,
    lighting: true,
    turnRestrictions: ['u-turn'],
  };
}
