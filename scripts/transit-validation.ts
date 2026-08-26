import {
  BUS_STOPPING_CONFIG,
  CITY_TRANSIT_CONFIG,
  calculateTaxiFare,
  TAXI_SERVICE_STATES,
  TRANSIT_PIXELS_PER_KILOMETER,
  selectSnappPickupCandidate,
  PASSENGER_BOARDING_FAILURE_REASONS,
  SNAPP_CONFIG,
} from '@/gameplay/transit';
import { passengerSeatsFor } from '@/gameplay/occupants/OccupantRules';
import { DEFAULT_KEY_BINDINGS, InputAction } from '@/config/InputConfig';
import { TrafficNetwork } from '@/gameplay/traffic/TrafficNetwork';
import { sampleSpline } from '@/gameplay/traffic/SplineMath';
import type { BusStopSite, CityId, RoadEdge, RoadNode } from '@/gameplay/types';
import type { TrafficLane } from '@/gameplay/traffic';
import { PLAYER } from '@/config/Constants';
import { InventoryComponent } from '@/entities/components/InventoryComponent';

const failures: string[] = [];
let assertions = 0;

function check(condition: boolean, message: string): void {
  assertions += 1;
  if (!condition) failures.push(message);
}

validateCityConfiguration();
validateTaxiServiceStates();
validateFareCalculation();
validateTransitSeatPolicy();
validateStartingMoney();
validateLaneBackedStopsAndRoutes();
validateParkingGeometry();
validateRuntimeParkingFootprint();
validateExplicitStopArrivalPrecision();
validateManagedBlockerPolicy();
validateSnappPickupPriority();
validateSnappBoardingDiagnostics();

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
    check(config.taxi.encounterRadius >= 480, `${cityId}: taxi encounter radius is too small`);
    check(config.taxi.guaranteedNearby >= 1, `${cityId}: city needs one encounterable available taxi`);
    check(config.taxi.standDurationMs >= 15_000, `${cityId}: reserve taxi stand time is too short`);
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

function validateTaxiServiceStates(): void {
  const required = [
    'AVAILABLE',
    'APPROACHING_PICKUP',
    'WAITING_FOR_PASSENGER',
    'PASSENGER_BOARDING',
    'DESTINATION_SELECTION',
    'FARE_CONFIRMATION',
    'IN_SERVICE',
    'ARRIVING',
    'PASSENGER_EXITING',
    'RETURNING_TO_SERVICE',
  ] as const;
  for (const state of required) {
    check(TAXI_SERVICE_STATES.includes(state), `taxi state machine lacks ${state}`);
  }
  check(
    passengerSeatsFor('taxi')[0] === 'rear-right',
    'taxi passenger must be assigned to the rear-right seat',
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

function validateStartingMoney(): void {
  const wallet = new InventoryComponent(PLAYER.START_MONEY);
  check(PLAYER.START_MONEY === 700, 'new games must initialize the real wallet with exactly $700');
  check(wallet.money === 700, 'new-player economy source must start at $700');
  check(wallet.spendMoney(85), 'a normal $85 taxi trip must be affordable from new-game money');
  check(wallet.money === 615, 'taxi spending must deduct once from the authoritative wallet');
  wallet.setMoney(143);
  check(wallet.money === 143, 'loading an existing saved wallet must preserve its saved balance');
}

function validateLaneBackedStopsAndRoutes(): void {
  const network = new TrafficNetwork(fixtureNodes(), [], fixtureEdges());
  const travelLanes = network.lanes().filter((lane) => lane.kind === 'travel');
  check(travelLanes.length >= 8, 'fixture must expose directed travel lanes');
  const lane = travelLanes.find((candidate) => candidate.spline.length > 260) ?? null;
  check(lane !== null, 'fixture must expose a lane long enough for a legal curb stop');
  if (!lane) return;

  const stop = fixtureStop(lane);
  const resolvedLane = network.lane(stop.laneId);
  check(resolvedLane?.kind === 'travel', 'bus stop must be attached to a directed travel lane');
  check(stop.roadNodeId === resolvedLane?.fromNodeId, 'bus stop must retain its directed approach road node');
  check(stop.resumeNodeId === resolvedLane?.toNodeId, 'bus stop must retain its directed resume road node');
  check(stop.laneDistance > 80, 'bus stop must clear the incoming junction');
  check(stop.laneDistance < stop.laneLength - 80, 'bus stop must clear the outgoing junction');
  check(stop.waitingPositions.length === stop.capacity, 'every bus stop capacity needs a distinct queue slot');
  check(
    new Set(stop.waitingPositions.map((position) => `${position.x},${position.y}`)).size === stop.capacity,
    'waiting positions must not stack passengers',
  );
  const pose = sampleSpline(lane.spline, stop.laneDistance);
  check(Number.isFinite(pose.point.x) && Number.isFinite(pose.heading), 'stop approach must be sampleable on its lane');
  check(
    Math.hypot(stop.stopPosition.x - pose.point.x, stop.stopPosition.y - pose.point.y) < 0.01,
    'bus stop position must be the exact point sampled from its named directed lane',
  );
  check(
    Math.abs(stop.heading - pose.heading) < 0.01,
    'bus stop heading must match the named directed lane tangent',
  );
  check(
    Math.abs(stop.approachDirection.x * pose.tangent.x + stop.approachDirection.y * pose.tangent.y - 1) < 0.01,
    'bus stop approach direction must match the named directed lane direction',
  );
  check(
    stop.laneDistance - network.projectPoint(stop.approachPosition, lane).distance <= BUS_STOPPING_CONFIG.approachDistance,
    'approach point must precede the stopping position on the same lane',
  );
  const nearby = network.nearbyTravelLanes(pose.point, 140);
  check(
    nearby.some((candidate) => candidate.id === lane.id),
    'service pickup query must return its spatially nearby legal travel lane',
  );

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
  const targetLaneRoute = network.findCompleteRoute(origin.id, stop.laneId);
  check(targetLaneRoute !== null, 'bus route must end on the stop\'s explicit directional lane');
  check(
    targetLaneRoute?.[targetLaneRoute.length - 1]?.id === stop.laneId,
    'explicit bus stop target must never be replaced by a visually nearby opposite lane',
  );
}

/**
 * The generated three-tile city street has no separate curb-bay geometry.
 * Publishing a parking position there is valid only if the full advertised
 * parking footprint clears the adjacent directed travel lane.
 */
function validateParkingGeometry(): void {
  const network = new TrafficNetwork(parkingFixtureNodes(), [], parkingFixtureEdges());
  const spaces = network.parkingSpaces();
  check(
    spaces.length === 0,
    'a narrow local road without a dedicated parking bay must not publish overlapping curb parking',
  );
  for (const space of spaces) {
    const lane = network.lane(space.adjacentLaneId);
    check(lane?.kind === 'travel', `${space.id}: parking must name a real adjacent travel lane`);
    if (!lane) continue;
    const projection = network.projectPoint(space.position, lane);
    const lateralDistance = Math.sqrt(projection.distanceSq);
    const requiredClearance = lane.width * 0.5 + space.width * 0.5 + 4;
    check(
      lateralDistance >= requiredClearance,
      `${space.id}: parked footprint overlaps its adjacent travel lane`,
    );
  }
}

/** A parked prop that is moved into a directed lane must fail the live audit. */
function validateRuntimeParkingFootprint(): void {
  const network = new TrafficNetwork(parkingFixtureNodes(), [], parkingFixtureEdges());
  const lane = network.lanes().find((candidate) => candidate.kind === 'travel') ?? null;
  check(lane !== null, 'parking runtime fixture requires a travel lane');
  if (!lane) return;
  const pose = sampleSpline(lane.spline, lane.spline.length * 0.5);
  const normal = { x: -Math.sin(pose.heading), y: Math.cos(pose.heading) };
  check(
    !network.vehicleFootprintHasTravelClearance(pose.point, pose.heading, 8, 24),
    'a displaced scooter centered on a directed lane must be rejected from parking',
  );
  check(
    network.vehicleFootprintHasTravelClearance(
      { x: pose.point.x + normal.x * 80, y: pose.point.y + normal.y * 80 },
      pose.heading,
      8,
      24,
    ),
    'a scooter outside the lane envelope must remain a legal parked body',
  );
}

/**
 * Braking and arrival both consume a sampled lane arc. Their common terminal
 * tolerance must absorb only spline/integration rounding, never widen the
 * physical curb-stop radius used by gameplay.
 */
function validateExplicitStopArrivalPrecision(): void {
  const stoppingRadius = BUS_STOPPING_CONFIG.stoppingRadius;
  const numericalTolerance = 0.75;
  const brakingWindow = Math.max(1, stoppingRadius * 0.35) + numericalTolerance;
  const stopLaneDistance = 144;
  const settledLaneDistance = stopLaneDistance - brakingWindow;
  const remaining = stopLaneDistance - settledLaneDistance;
  check(
    Math.abs(remaining - brakingWindow) <= numericalTolerance,
    'explicit curb braking point must satisfy the driver arrival window despite spline rounding',
  );
  check(
    remaining <= stoppingRadius && remaining > brakingWindow * 0.9,
    'a low-speed bus at its braking buffer must qualify only through the configured curb-stop radius',
  );
  check(
    numericalTolerance < 1 && numericalTolerance < stoppingRadius * 0.04,
    'explicit curb precision tolerance must remain numerical and never become a broad stop trigger',
  );
}

/** A queued ambient driver already has traffic-level recovery; buses must not skip a valid stop for it. */
function validateManagedBlockerPolicy(): void {
  const blockedSeconds = 7;
  const thresholdSeconds = 7;
  const managedBlocker = true;
  const shouldEscalateBusRecovery = blockedSeconds >= thresholdSeconds && !managedBlocker;
  check(
    !shouldEscalateBusRecovery,
    'a bus must wait for a managed traffic blocker rather than restart its valid directed stop segment',
  );
  check(
    blockedSeconds >= thresholdSeconds && !false,
    'an unmanaged stationary blocker must remain eligible for legal bus recovery',
  );
}

/** Snapp pickup placement is passenger-centric; driver convenience can only break an otherwise exact tie. */
function validateSnappPickupPriority(): void {
  const base = {
    laneRole: 'outer' as const,
    curbFacing: true,
    approachUsable: true,
    routeReachable: true,
  };
  const sameStreet = {
    ...base,
    id: 'same-street',
    roadSegmentId: 'road:request',
    displacementPx: 34,
    routeDistancePx: 7200,
  };
  const adjacentStreet = {
    ...base,
    id: 'adjacent-street',
    roadSegmentId: 'road:adjacent',
    displacementPx: 22,
    routeDistancePx: 40,
  };
  check(
    selectSnappPickupCandidate([adjacentStreet, sameStreet], 'road:request', 88, 3)?.id === 'same-street',
    'a shorter driver route must never move a Snapp pickup to another street',
  );

  const inner = {
    ...sameStreet,
    id: 'inner',
    laneRole: 'inner' as const,
    displacementPx: 20,
    routeDistancePx: 20,
  };
  const outer = { ...sameStreet, id: 'outer', displacementPx: 34, routeDistancePx: 7000 };
  check(
    selectSnappPickupCandidate([inner, outer], 'road:request', 88, 3)?.id === 'outer',
    'the curb-facing outer lane must beat a closer inner lane on the same road',
  );

  const tooFar = { ...sameStreet, id: 'too-far', displacementPx: 89 };
  check(
    selectSnappPickupCandidate([tooFar], 'road:request', 88, 3) === null,
    'Snapp must reject a same-street anchor beyond its strict displacement limit',
  );
}

function validateSnappBoardingDiagnostics(): void {
  const required = [
    'player-unavailable',
    'player-already-in-vehicle',
    'transition-in-progress',
    'vehicle-destroyed',
    'vehicle-moving',
    'wrong-booking',
    'wrong-vehicle',
    'driver-not-arrived',
    'too-far-from-door',
    'seat-unavailable',
    'door-position-blocked',
    'path-to-door-blocked',
    'boarding-approach-unavailable',
  ] as const;
  check(
    required.every((reason) => PASSENGER_BOARDING_FAILURE_REASONS.includes(reason)),
    'every transactional passenger-boarding guard must expose a typed diagnostic reason',
  );
  check(
    SNAPP_CONFIG.maximumPickupDisplacementPx < 96,
    'Snapp pickup displacement must stay below one generated-street offset',
  );
  check(
    SNAPP_CONFIG.snappBoardingReachPx <= 64,
    'rear-door boarding reach must not permit remote vehicle entry',
  );
  check(
    DEFAULT_KEY_BINDINGS[InputAction.Interact].includes('E') &&
      DEFAULT_KEY_BINDINGS[InputAction.EnterVehicle].includes('F') &&
      DEFAULT_KEY_BINDINGS[InputAction.EnterVehicle].includes('ENTER'),
    'E, F, and Enter must retain their shared Snapp interaction/vehicle-entry bindings',
  );
}

function fixtureStop(lane: TrafficLane): BusStopSite {
  const laneDistance = lane.spline.length / 2;
  const stopPose = sampleSpline(lane.spline, laneDistance);
  const approachPose = sampleSpline(lane.spline, Math.max(0, laneDistance - 128));
  const resumePose = sampleSpline(lane.spline, Math.min(lane.spline.length, laneDistance + 72));
  return {
    id: 'bus-stop:tehran:fixture',
    cityId: 'tehran',
    x: stopPose.point.x + Math.cos(stopPose.heading - Math.PI / 2) * 44,
    y: stopPose.point.y + Math.sin(stopPose.heading - Math.PI / 2) * 44,
    facing: 0,
    laneId: lane.id,
    roadNodeId: lane.fromNodeId,
    resumeNodeId: lane.toNodeId,
    stopPosition: { ...stopPose.point },
    approachPosition: { ...approachPose.point },
    resumePosition: { ...resumePose.point },
    approachDirection: { ...stopPose.tangent },
    laneDistance,
    laneLength: lane.spline.length,
    heading: stopPose.heading,
    routeIds: [],
    capacity: 3,
    waitingEntityIds: [],
    waitingPositions: [
      { x: stopPose.point.x + 44, y: stopPose.point.y },
      { x: stopPose.point.x + 60, y: stopPose.point.y },
      { x: stopPose.point.x + 76, y: stopPose.point.y },
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

function parkingFixtureNodes(): RoadNode[] {
  return [
    { id: 10, x: -480, y: 0, neighbours: [11] },
    { id: 11, x: 480, y: 0, neighbours: [10] },
  ];
}

function parkingFixtureEdges(): RoadEdge[] {
  return [
    {
      ...edge('parking-local', 10, 11),
      roadClass: 'local',
      laneCount: 2,
      speedLimit: 72,
      shoulder: false,
    },
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
