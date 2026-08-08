import type { HighwayComponent, RoadEdge, RoadNode } from '@/gameplay/types';
import { IntersectionReservationController } from '@/gameplay/traffic/IntersectionReservationController';
import { TrafficNetwork } from '@/gameplay/traffic/TrafficNetwork';
import { projectOnSpline, sampleSpline, wrapAngle } from '@/gameplay/traffic/SplineMath';
import type { TrafficLane } from '@/gameplay/traffic/TrafficTypes';

interface HeadlessAgent {
  readonly id: number;
  route: TrafficLane[];
  routeIndex: number;
  distance: number;
  speed: number;
  stoppedSeconds: number;
  intersectionStoppedSeconds: number;
}

const failures: string[] = [];
let assertions = 0;

function check(condition: boolean, message: string): void {
  assertions += 1;
  if (!condition) failures.push(message);
}

const nodes: RoadNode[] = [
  { id: 0, x: 0, y: 0, neighbours: [1, 2, 3, 4] },
  { id: 1, x: 384, y: 0, neighbours: [0] },
  { id: 2, x: 0, y: 384, neighbours: [0] },
  { id: 3, x: -384, y: 0, neighbours: [0] },
  { id: 4, x: 0, y: -384, neighbours: [0] },
];
const network = new TrafficNetwork(nodes, []);

validateNetworkGeometry();
validateRouting();
validateReservations();
validateInterchangePolicy();
const simulated = simulateTenMinutes();

if (failures.length > 0) {
  console.error(`Traffic validation FAILED (${failures.length} failures / ${assertions} checks)`);
  for (const failure of failures.slice(0, 30)) console.error(` - ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Traffic validation PASSED`);
  console.log(`  ${assertions} invariant checks`);
  console.log(`  ${network.roadCount} road segments, ${network.laneCount} directed splines`);
  console.log(`  ${simulated.toLocaleString()} agent-steps (10 simulated minutes)`);
  console.log(
    '  direction, lane containment, spawn alignment, conflicts, downstream clearance, blocking, and recovery checks passed',
  );
}

function validateNetworkGeometry(): void {
  check(network.roadCount === 4, 'fixture should produce four physical road segments');
  check(network.intersectionCount === 5, 'fixture should produce five typed junctions');
  check(network.laneCount > 16, 'network must include explicit connector splines');
  for (const lane of network.lanes()) {
    check(lane.spline.length > 1, `${lane.id}: zero-length spline`);
    check(lane.width > 0, `${lane.id}: invalid lane width`);
    check(lane.connectionIds.length > 0, `${lane.id}: lane has no legal exit`);
    const start = sampleSpline(lane.spline, 0);
    const end = sampleSpline(lane.spline, lane.spline.length);
    check(
      Number.isFinite(start.heading) && Number.isFinite(end.heading),
      `${lane.id}: invalid heading`,
    );
    for (let distance = 0; distance <= lane.spline.length; distance += 8) {
      const pose = sampleSpline(lane.spline, distance);
      const projection = projectOnSpline(pose.point, lane.spline);
      check(
        projection.distanceSq < 1.5,
        `${lane.id}: spline inverse error ${Math.sqrt(projection.distanceSq).toFixed(2)} px`,
      );
      check(
        Math.abs(wrapAngle(pose.heading - projection.heading)) < 0.02,
        `${lane.id}: wrong travel direction`,
      );
      check(
        isDrivable(pose.point.x, pose.point.y),
        `${lane.id}: spline entered sidewalk/building space`,
      );
    }
    if (lane.kind === 'travel' && lane.spline.length > 150) {
      const spawnDistance = Math.min(
        lane.spline.length - 118,
        Math.max(42, lane.spline.length * 0.5),
      );
      const spawn = sampleSpline(lane.spline, spawnDistance);
      check(
        Math.abs(wrapAngle(spawn.heading - sampleSpline(lane.spline, spawnDistance + 1).heading)) <
          0.02,
        `${lane.id}: bad spawn orientation`,
      );
      check(
        lane.spline.length - spawnDistance >= 118,
        `${lane.id}: insufficient clear distance after spawn`,
      );
    }
  }
  for (const space of network.parkingSpaces()) {
    const lane = network.lane(space.adjacentLaneId);
    check(lane?.kind === 'travel', `${space.id}: parking space lacks adjacent travel lane`);
    check(
      isDrivable(space.position.x, space.position.y),
      `${space.id}: parking space is not on road shoulder`,
    );
    if (lane) {
      const laneHeading = sampleSpline(lane.spline, lane.spline.length * 0.5).heading;
      check(
        Math.abs(wrapAngle(space.heading - laneHeading)) < 0.02,
        `${space.id}: parked heading opposes traffic`,
      );
    }
  }
}

function validateRouting(): void {
  const starts = network
    .lanes()
    .filter((lane) => lane.kind === 'travel')
    .slice(0, 8);
  for (let index = 0; index < starts.length; index++) {
    const start = starts[index];
    const goal = starts[(index + 5) % starts.length];
    if (!start || !goal) continue;
    const route = network.findRoute(start.id, goal.id);
    check(route !== null && route.length >= 1, `${start.id}: no route to ${goal.id}`);
    if (!route) continue;
    check(route[0]?.id === start.id, 'route does not start on requested lane');
    check(route[route.length - 1]?.id === goal.id, 'route does not end on requested lane');
    for (let step = 0; step < route.length - 1; step++) {
      const lane = route[step];
      const next = route[step + 1];
      check(
        Boolean(lane && next && lane.connectionIds.includes(next.id)),
        `illegal route transition at step ${step}`,
      );
    }
  }
}

function validateInterchangePolicy(): void {
  const transitionNodes: RoadNode[] = [
    { id: 18, x: -384, y: 1000, neighbours: [20] },
    { id: 20, x: 0, y: 1000, neighbours: [18, 21] },
    { id: 21, x: 384, y: 1000, neighbours: [20, 22, 23] },
    { id: 22, x: 768, y: 1000, neighbours: [21, 24, 25] },
    { id: 23, x: 384, y: 1224, neighbours: [21, 24] },
    { id: 24, x: 768, y: 1224, neighbours: [23, 22] },
    { id: 25, x: 1152, y: 1000, neighbours: [22] },
  ];
  const edges: RoadEdge[] = [
    cityEdge('city-road', 18, 20),
    transitionEdge('mainline-a', 20, 21, 'carriageway', 220),
    transitionEdge('mainline-b', 21, 22, 'carriageway', 220),
    transitionEdge('mainline-c', 22, 25, 'carriageway', 220),
    transitionEdge('service-exit', 21, 23, 'service-road', 92, 'deceleration'),
    transitionEdge('service-frontage', 23, 24, 'service-road', 78),
    transitionEdge('service-entry', 24, 22, 'service-road', 104, 'acceleration'),
  ];
  const interchange = new TrafficNetwork(transitionNodes, [], edges);
  const mainlineLanes = interchange
    .lanes()
    .filter(
      (lane) =>
        lane.fromNodeId === 20 && lane.toNodeId === 21 && lane.kind === 'travel',
    )
    .sort((first, second) => first.laneIndex - second.laneIndex);
  const serviceExitLane = interchange
    .lanes()
    .find((lane) => lane.fromNodeId === 21 && lane.toNodeId === 23 && lane.kind === 'travel');
  const serviceEntryLane = interchange
    .lanes()
    .find((lane) => lane.fromNodeId === 24 && lane.toNodeId === 22 && lane.kind === 'travel');
  const mainline = interchange.road(mainlineLanes[0]?.roadSegmentId);
  const serviceExit = interchange.road(serviceExitLane?.roadSegmentId);
  const serviceEntry = interchange.road(serviceEntryLane?.roadSegmentId);
  check(mainlineLanes.length === 3, 'mainline did not preserve all three lanes');
  check(mainline?.speedLimit === 220, 'mainline design speed was discarded');
  check(serviceExit?.speedLimit === 92, 'short exit-lane speed was discarded');
  check(serviceEntry?.speedLimit === 104, 'short merge-lane speed was discarded');
  check(mainlineLanes.length === 3, 'three independent mainline splines were not generated');
  check(
    mainlineLanes.every((lane, index) => lane.laneIndex === index),
    'three-lane ordering is unstable',
  );
  check(
    mainlineLanes[0]?.role === 'inner' &&
      mainlineLanes[1]?.role === 'inner' &&
      mainlineLanes[2]?.role === 'outer',
    'passing and outer-lane roles are wrong',
  );
  const exitJunction = interchange.junction(21);
  const exitConnector = exitJunction?.connectorLaneIds
    .map((id) => interchange.lane(id))
    .find((lane) => lane?.kind === 'exit');
  check(exitConnector?.intersectionId === null, 'service exit stops on the mainline');
  const mergeJunction = interchange.junction(22);
  const mergeConnector = mergeJunction?.connectorLaneIds
    .map((id) => interchange.lane(id))
    .find((lane) => lane?.kind === 'merge' && lane.fromNodeId === 24);
  check(mergeConnector?.intersectionId === 22, 'service entry does not yield to mainline traffic');
  check((mergeConnector?.speedLimit ?? Infinity) <= 110, 'entry merge retains highway speed');
  const cityJunction = interchange.junction(20);
  check(cityJunction?.kind !== 'roundabout', 'city connection became a roundabout');
  check(cityJunction?.control !== 'roundabout', 'city connection uses interchange control');
}

function transitionEdge(
  id: string,
  fromNodeId: number,
  toNodeId: number,
  highwayComponent: HighwayComponent,
  speedLimit: number,
  laneTransition?: RoadEdge['laneTransition'],
): RoadEdge {
  return {
    id,
    fromNodeId,
    toNodeId,
    roadClass: highwayComponent === 'service-road' ? 'service' : 'highway',
    laneCount: highwayComponent === 'carriageway' ? 3 : 1,
    speedLimit,
    direction: 'forward',
    priority: highwayComponent === 'carriageway' ? 5 : 4,
    surface: 'urban-asphalt',
    highwayId: 'fixture-highway',
    highwayComponent,
    laneTransition,
    transitionPathId: highwayComponent === 'service-road' ? 'fixture:service-area' : undefined,
    interchangeId: highwayComponent === 'service-road' ? 'fixture:service-area' : undefined,
    carriageway: highwayComponent === 'carriageway' ? 'forward' : undefined,
    navigationAllowed: true,
    trafficAllowed: true,
    pedestrianAllowed: false,
    emergencyAllowed: true,
    shoulder: true,
    lighting: true,
    turnRestrictions: ['u-turn'],
  };
}

function cityEdge(id: string, fromNodeId: number, toNodeId: number): RoadEdge {
  return {
    id,
    fromNodeId,
    toNodeId,
    roadClass: 'arterial',
    laneCount: 2,
    speedLimit: 120,
    direction: 'both',
    priority: 4,
    surface: 'urban-asphalt',
    navigationAllowed: true,
    trafficAllowed: true,
    pedestrianAllowed: false,
    emergencyAllowed: true,
    shoulder: true,
    lighting: true,
    turnRestrictions: ['u-turn'],
  };
}

function validateReservations(): void {
  const junction = network.junction(0);
  check(junction !== null, 'central junction missing');
  if (!junction) return;
  const connectors = junction.connectorLaneIds
    .map((id) => network.lane(id))
    .filter((lane): lane is TrafficLane => lane !== null);
  let pair: [TrafficLane, TrafficLane] | null = null;
  for (const first of connectors) {
    const second = connectors.find((candidate) => first.conflictLaneIds.includes(candidate.id));
    if (second) {
      pair = [first, second];
      break;
    }
  }
  check(pair !== null, 'no conflicting connector pair found');
  if (!pair) return;
  const controller = new IntersectionReservationController(network);
  controller.beginFrame(0);
  controller.request(0, reservationRequest(101, pair[0], true));
  controller.request(0, reservationRequest(102, pair[1], true));
  controller.resolve(0);
  const first = controller.hasReservation(101);
  const second = controller.hasReservation(102);
  check(
    Number(Boolean(first)) + Number(Boolean(second)) === 1,
    'conflicting movements were reserved together',
  );
  controller.releaseVehicle(first ? 101 : 102);
  controller.beginFrame(50);
  const waitingId = first ? 102 : 101;
  const waitingLane = first ? pair[1] : pair[0];
  controller.request(50, reservationRequest(waitingId, waitingLane, true));
  controller.resolve(50);
  check(
    controller.hasReservation(waitingId) !== null,
    'queued movement did not progress after conflict cleared',
  );
  controller.clear();
  controller.beginFrame(100);
  controller.request(100, reservationRequest(103, pair[0], false));
  controller.resolve(100);
  check(
    controller.hasReservation(103) === null,
    'vehicle entered without downstream exit capacity',
  );
}

function simulateTenMinutes(): number {
  const controller = new IntersectionReservationController(network);
  const travel = network.lanes().filter((lane) => lane.kind === 'travel');
  const random = lcg(99173);
  const agents: HeadlessAgent[] = [];
  for (let index = 0; index < Math.min(12, travel.length); index++) {
    const lane = travel[index];
    if (!lane) continue;
    const goal = network.chooseDestination(lane.id, random, 3);
    const route = goal ? network.findRoute(lane.id, goal.id) : null;
    if (!route) continue;
    agents.push({
      id: index + 1,
      route: route.slice(),
      routeIndex: 0,
      distance: 48 + (index % 2) * 105,
      speed: 42 + (index % 4) * 4,
      stoppedSeconds: 0,
      intersectionStoppedSeconds: 0,
    });
  }
  const stepSeconds = 0.05;
  const totalSteps = Math.floor(600 / stepSeconds);
  for (let step = 0; step < totalSteps; step++) {
    const now = step * stepSeconds * 1000;
    controller.beginFrame(now);
    const before = agents.map((agent) => ({
      id: agent.id,
      lane: agent.route[agent.routeIndex],
      distance: agent.distance,
      speed: agent.speed,
    }));
    for (const agent of agents) {
      const lane = agent.route[agent.routeIndex];
      if (!lane) continue;
      const next = agent.route[agent.routeIndex + 1];
      let desiredSpeed = lane.speedLimit * 0.72;
      const lead = before
        .filter(
          (candidate) =>
            candidate.id !== agent.id &&
            candidate.lane?.id === lane.id &&
            candidate.distance > agent.distance,
        )
        .sort((a, b) => a.distance - b.distance)[0];
      if (lead) {
        const gap = lead.distance - agent.distance - 30;
        desiredSpeed = Math.min(desiredSpeed, Math.max(0, lead.speed + (gap - 18) / 1.4));
      }
      if (
        lane.kind === 'travel' &&
        next?.intersectionId !== null &&
        next?.intersectionId !== undefined
      ) {
        const stopDistance = lane.spline.length - agent.distance - 7;
        if (stopDistance < 150) {
          const outgoing = agent.route[agent.routeIndex + 2];
          const downstreamClear = outgoing
            ? !before.some(
                (candidate) => candidate.lane?.id === outgoing.id && candidate.distance < 78,
              )
            : false;
          if (outgoing) {
            const decision = controller.request(now, {
              vehicleId: agent.id,
              intersectionId: next.intersectionId,
              connectorLaneId: next.id,
              incomingLaneId: lane.id,
              outgoingLaneId: outgoing.id,
              distanceToStopLine: stopDistance,
              arrivalAt: now + (stopDistance / Math.max(10, agent.speed)) * 1000,
              priority: 2,
              emergency: false,
              recoveryAttempt: 0,
              downstreamClear,
            });
            if (!decision.granted)
              desiredSpeed = Math.min(desiredSpeed, Math.sqrt(Math.max(0, 2 * 100 * stopDistance)));
          }
        }
      }
      const acceleration = Math.max(-150, Math.min(85, (desiredSpeed - agent.speed) * 1.8));
      agent.speed = Math.max(0, agent.speed + acceleration * stepSeconds);
      advanceAgent(agent, agent.speed * stepSeconds, controller, random);
      const activeLane = agent.route[agent.routeIndex];
      if (!activeLane) continue;
      const pose = sampleSpline(activeLane.spline, agent.distance);
      const projection = projectOnSpline(pose.point, activeLane.spline);
      check(
        projection.distanceSq < 1.5,
        `agent ${agent.id}: left lane during long run (${Math.sqrt(projection.distanceSq).toFixed(2)} px)`,
      );
      check(
        Math.abs(wrapAngle(pose.heading - projection.heading)) < 0.02,
        `agent ${agent.id}: faced wrong direction during long run`,
      );
      check(
        isDrivable(pose.point.x, pose.point.y),
        `agent ${agent.id}: hit building/sidewalk during long run`,
      );
      agent.stoppedSeconds = agent.speed < 0.6 ? agent.stoppedSeconds + stepSeconds : 0;
      agent.intersectionStoppedSeconds =
        activeLane.intersectionId !== null && agent.speed < 0.6
          ? agent.intersectionStoppedSeconds + stepSeconds
          : 0;
      check(agent.stoppedSeconds < 24, `agent ${agent.id}: stopped too long without recovery`);
      check(agent.intersectionStoppedSeconds < 1.5, `agent ${agent.id}: blocked intersection`);
    }
    controller.resolve(now);
  }
  return agents.length * totalSteps;
}

function advanceAgent(
  agent: HeadlessAgent,
  requestedDistance: number,
  controller: IntersectionReservationController,
  random: () => number,
): void {
  let remaining = requestedDistance;
  while (remaining > 0) {
    const lane = agent.route[agent.routeIndex];
    if (!lane) return;
    const available = lane.spline.length - agent.distance;
    if (remaining < available) {
      agent.distance += remaining;
      return;
    }
    const next = agent.route[agent.routeIndex + 1];
    if (!next) {
      const goal = network.chooseDestination(lane.id, random, 3);
      const route = goal ? network.findRoute(lane.id, goal.id) : null;
      if (!route) {
        agent.speed = 0;
        return;
      }
      agent.route = route.slice();
      agent.routeIndex = 0;
      agent.distance = Math.min(lane.spline.length - 1, agent.distance);
      return;
    }
    if (next.intersectionId !== null && !controller.hasReservation(agent.id)) {
      agent.distance = Math.max(0, lane.spline.length - 7);
      agent.speed = 0;
      return;
    }
    remaining -= Math.max(0, available);
    const leavingIntersection = lane.intersectionId !== null;
    agent.routeIndex += 1;
    agent.distance = 0;
    if (leavingIntersection) controller.releaseVehicle(agent.id);
  }
}

function reservationRequest(vehicleId: number, connector: TrafficLane, downstreamClear: boolean) {
  const incoming = network.lanes().find((lane) => lane.connectionIds.includes(connector.id));
  const outgoingId = connector.connectionIds[0];
  if (!incoming || !outgoingId || connector.intersectionId === null)
    throw new Error('invalid connector fixture');
  return {
    vehicleId,
    intersectionId: connector.intersectionId,
    connectorLaneId: connector.id,
    incomingLaneId: incoming.id,
    outgoingLaneId: outgoingId,
    distanceToStopLine: 40,
    arrivalAt: 0,
    priority: 2,
    emergency: false,
    recoveryAttempt: 0,
    downstreamClear,
  };
}

function isDrivable(x: number, y: number): boolean {
  const withinWorld = Math.abs(x) <= 384 && Math.abs(y) <= 384;
  return withinWorld && (Math.abs(x) <= 48 || Math.abs(y) <= 48);
}

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}
