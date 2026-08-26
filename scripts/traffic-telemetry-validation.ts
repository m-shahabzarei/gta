import { IntersectionReservationController } from '@/gameplay/traffic/IntersectionReservationController';
import {
  TrafficTelemetryCollector,
  emptySchedulerTelemetry,
  type TrafficReplaySample,
} from '@/gameplay/traffic/TrafficTelemetry';
import { TrafficNetwork } from '@/gameplay/traffic/TrafficNetwork';
import type { TrafficLane } from '@/gameplay/traffic/TrafficTypes';
import type { RoadNode } from '@/gameplay/types';

let assertions = 0;
const failures: string[] = [];
function check(condition: boolean, message: string): void {
  assertions += 1;
  if (!condition) failures.push(message);
}

function sample(step: number): TrafficReplaySample {
  return {
    fixedStep: step,
    simulationClockMs: step * 50,
    city: 'tehran',
    district: 'central',
    vehicleId: 1,
    driverId: 1,
    laneId: 'lane:test',
    laneDistance: 42,
    routeProgress: 0.5,
    position: { x: 0, y: 0 },
    heading: 0,
    speed: 20,
    desiredSpeed: 22,
    simulationTier: 'near',
    state: 'Following Lane',
    intention: 'Cruise',
    stopReason: null,
    blockerId: null,
    blockerType: null,
    reservationId: null,
    queuePosition: 'unknown',
    recoveryPhase: 'none',
    lastUpdateTimestamp: step * 50,
    updateAgeMs: 0,
    ownershipClass: 'ambient',
  };
}

function networkFixture(): TrafficNetwork {
  const nodes: RoadNode[] = [
    { id: 0, x: 0, y: 0, neighbours: [1, 2, 3, 4] },
    { id: 1, x: 384, y: 0, neighbours: [0] },
    { id: 2, x: 0, y: 384, neighbours: [0] },
    { id: 3, x: -384, y: 0, neighbours: [0] },
    { id: 4, x: 0, y: -384, neighbours: [0] },
  ];
  return new TrafficNetwork(nodes, []);
}

const collector = new TrafficTelemetryCollector({
  scenarioId: 'telemetry-validation',
  worldSeed: 1337,
  simulationSeed: 99173,
  maxSamples: 2,
  maxEvents: 2,
  maxFrames: 2,
});
collector.beginFrame(50, 50, 100);
collector.endFrame(120);
collector.recordReplaySample(sample(1));
collector.recordReplaySample(sample(2));
collector.recordReplaySample(sample(3));
collector.observeStop({
  nowMs: 100,
  vehicleId: 1,
  driverId: 1,
  stopped: true,
  laneId: 'lane:test',
  intersectionId: 0,
  reason: 'lead-vehicle',
  blockerId: 7,
  blockerType: 'stopped-traffic',
  desiredSpeed: 30,
  actualSpeed: 0,
  simulationTier: 'near',
  schedulerLastUpdateAgeMs: 50,
  reservationState: 'none',
  downstreamClear: true,
  beforeState: 'Following Lane',
  state: 'Avoiding Obstacle',
});
collector.observeStop({
  nowMs: 200,
  vehicleId: 1,
  driverId: 1,
  stopped: false,
  laneId: 'lane:test',
  intersectionId: 0,
  reason: null,
  blockerId: null,
  blockerType: null,
  desiredSpeed: 20,
  actualSpeed: 20,
  simulationTier: 'near',
  schedulerLastUpdateAgeMs: 0,
  reservationState: 'none',
  downstreamClear: true,
  beforeState: 'Avoiding Obstacle',
  state: 'Following Lane',
});
const scheduler = emptySchedulerTelemetry(1);
collector.recordScheduler(scheduler);
collector.recordLifecycle({
  kind: 'spawn-rejected',
  atMs: 50,
  vehicleId: null,
  driverId: null,
  reason: 'front-clearance',
  ownershipClass: 'ambient',
  state: null,
  metadataLost: [],
});
collector.recordLifecycle({
  kind: 'spawn-rejected',
  atMs: 100,
  vehicleId: null,
  driverId: null,
  reason: 'rear-clearance',
  ownershipClass: 'ambient',
  state: null,
  metadataLost: [],
});
collector.recordLifecycle({
  kind: 'spawn-rejected',
  atMs: 150,
  vehicleId: null,
  driverId: null,
  reason: 'vehicle-overlap',
  ownershipClass: 'ambient',
  state: null,
  metadataLost: [],
});
const snapshot = collector.snapshot();
check(snapshot.replay.samples.length === 2, 'replay sample bound was not enforced');
check(snapshot.frames[0]?.realWallClockMs === 20, 'real wall-clock frame duration was not captured');
check(snapshot.stopEpisodes[0]?.durationMs === 100, 'stop episode duration is incorrect');
check(snapshot.stopEpisodes[0]?.beforeState === 'Following Lane', 'stop episode before-state was not captured');
check(snapshot.stopEpisodes[0]?.afterState === 'Following Lane', 'stop episode after-state was not captured');
check(snapshot.counters['stop.lead-vehicle'] === 1, 'stop reason counter missing');
check(snapshot.lifecycle.length === 2, 'lifecycle event bound was not enforced');
check(JSON.stringify(snapshot) === JSON.stringify(collector.snapshot()), 'snapshot serialization is unstable');

const network = networkFixture();
const junction = network.junction(0);
const connector = junction?.connectorLaneIds
  .map((id) => network.lane(id))
  .find((lane): lane is TrafficLane => lane !== null);
check(connector !== undefined, 'telemetry reservation fixture has no connector');
if (connector && connector.intersectionId !== null) {
  const controller = new IntersectionReservationController(network);
  controller.beginFrame(0);
  const incoming = network.lanes().find((lane) => lane.connectionIds.includes(connector.id));
  const outgoing = connector.connectionIds[0];
  check(incoming !== undefined && outgoing !== undefined, 'reservation telemetry fixture is incomplete');
  if (incoming && outgoing) {
    controller.request(0, {
      vehicleId: 10,
      intersectionId: connector.intersectionId,
      connectorLaneId: connector.id,
      incomingLaneId: incoming.id,
      outgoingLaneId: outgoing,
      distanceToStopLine: 40,
      arrivalAt: 0,
      priority: 1,
      emergency: false,
      recoveryAttempt: 0,
      approachClear: true,
      downstreamClear: false,
    });
    const junctionTelemetry = controller.telemetrySnapshot().find((item) => item.junctionId === connector.intersectionId);
    check(junctionTelemetry?.denialReasons['exit-blocked'] === 1, 'reservation denial reason was not recorded');
  }
}

if (failures.length > 0) {
  console.error(`Traffic telemetry validation FAILED (${failures.length} failures / ${assertions} checks)`);
  for (const failure of failures) console.error(` - ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Traffic telemetry validation PASSED (${assertions} checks)`);
}
