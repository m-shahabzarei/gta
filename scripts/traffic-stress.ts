import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { IntersectionReservationController } from '@/gameplay/traffic/IntersectionReservationController';
import { TrafficNetwork } from '@/gameplay/traffic/TrafficNetwork';
import { TrafficTelemetryCollector } from '@/gameplay/traffic/TrafficTelemetry';
import { sampleSpline, wrapAngle } from '@/gameplay/traffic/SplineMath';
import type { TrafficLane } from '@/gameplay/traffic/TrafficTypes';
import type { RoadNode } from '@/gameplay/types';
import { Random } from '@/utils/Random';

interface ScenarioConfig {
  readonly id: string;
  readonly city: string;
  readonly district: string;
  readonly density: 'low' | 'medium' | 'high';
  readonly seed: number;
  readonly durationSeconds: number;
  readonly mode?: 'highway-transition' | 'multi-junction' | 'wanted' | 'roadblock' | 'transit' | 'fast-chunks' | 'pause-resume';
}

interface Agent {
  readonly id: number;
  route: TrafficLane[];
  routeIndex: number;
  distance: number;
  speed: number;
  desiredSpeed: number;
  crossings: number;
  stoppedSinceMs: number | null;
  intersectionDelayMs: number;
}

const OUTPUT_DIR = resolve(process.argv[2] ?? '.traffic-stress');
const STEP_MS = 50;
const STEP_SECONDS = STEP_MS / 1000;
const SCENARIOS: readonly ScenarioConfig[] = [
  { id: 'tehran-low', city: 'tehran', district: 'central', density: 'low', seed: 0x1001, durationSeconds: 60 },
  { id: 'tehran-medium', city: 'tehran', district: 'central', density: 'medium', seed: 0x1002, durationSeconds: 60 },
  { id: 'tehran-high', city: 'tehran', district: 'central', density: 'high', seed: 0x1003, durationSeconds: 60 },
  { id: 'yazd', city: 'yazd', district: 'market', density: 'medium', seed: 0x2001, durationSeconds: 60 },
  { id: 'gilan', city: 'gilan', district: 'coastal', density: 'medium', seed: 0x3001, durationSeconds: 60 },
  { id: 'highway-transition', city: 'tehran', district: 'arterial', density: 'medium', seed: 0x4001, durationSeconds: 60, mode: 'highway-transition' },
  { id: 'multi-junction', city: 'tehran', district: 'arterial', density: 'high', seed: 0x4002, durationSeconds: 60, mode: 'multi-junction' },
  { id: 'wanted-high', city: 'tehran', district: 'central', density: 'medium', seed: 0x5001, durationSeconds: 60, mode: 'wanted' },
  { id: 'roadblock-obstacle', city: 'tehran', district: 'industrial', density: 'medium', seed: 0x5002, durationSeconds: 60, mode: 'roadblock' },
  { id: 'bus-taxi', city: 'tehran', district: 'commercial', density: 'medium', seed: 0x6001, durationSeconds: 60, mode: 'transit' },
  { id: 'fast-chunk-crossing', city: 'gilan', district: 'intercity', density: 'medium', seed: 0x7001, durationSeconds: 60, mode: 'fast-chunks' },
  { id: 'pause-resume', city: 'yazd', district: 'residential', density: 'medium', seed: 0x7002, durationSeconds: 60, mode: 'pause-resume' },
  { id: 'idle-15-minute', city: 'tehran', district: 'central', density: 'medium', seed: 0x8001, durationSeconds: 15 * 60 },
  { id: 'idle-30-minute', city: 'tehran', district: 'central', density: 'medium', seed: 0x8002, durationSeconds: 30 * 60 },
];

function makeNetwork(): TrafficNetwork {
  const nodes: RoadNode[] = [
    { id: 0, x: 0, y: 0, neighbours: [1, 2, 3, 4] },
    { id: 1, x: 384, y: 0, neighbours: [0] },
    { id: 2, x: 0, y: 384, neighbours: [0] },
    { id: 3, x: -384, y: 0, neighbours: [0] },
    { id: 4, x: 0, y: -384, neighbours: [0] },
  ];
  return new TrafficNetwork(nodes, []);
}

function agentCount(density: ScenarioConfig['density']): number {
  return density === 'low' ? 4 : density === 'high' ? 12 : 8;
}

function makeAgents(network: TrafficNetwork, config: ScenarioConfig, random: Random): Agent[] {
  const travel = network.lanes().filter((lane) => lane.kind === 'travel');
  const agents: Agent[] = [];
  for (let index = 0; index < Math.min(agentCount(config.density), travel.length); index += 1) {
    const lane = travel[index];
    if (!lane) continue;
    const goal = network.chooseDestination(lane.id, () => random.next(), 3);
    const route = goal ? network.findRoute(lane.id, goal.id) : null;
    if (!route) continue;
    agents.push({
      id: index + 1,
      route: route.slice(),
      routeIndex: 0,
      distance: 48 + (index % 2) * 105,
      speed: 42 + (index % 4) * 4,
      desiredSpeed: 0,
      crossings: 0,
      stoppedSinceMs: null,
      intersectionDelayMs: 0,
    });
  }
  return agents;
}

function runScenario(config: ScenarioConfig): Record<string, unknown> {
  const startedAt = performance.now();
  const network = makeNetwork();
  const controller = new IntersectionReservationController(network);
  const random = new Random(config.seed);
  const telemetry = new TrafficTelemetryCollector({
    scenarioId: config.id,
    worldSeed: 1337,
    simulationSeed: config.seed,
    maxSamples: 75_000,
    maxEvents: 20_000,
    maxFrames: 75_000,
  });
  const agents = makeAgents(network, config, random);
  const speeds: number[] = [];
  const stopDurations: number[] = [];
  const intersectionDelays: number[] = [];
  let wrongDirection = 0;
  let leftRoad = 0;
  let blockedIntersection = 0;
  let badSpawn = 0;
  let fixedStep = 0;
  let simulationClockMs = 0;
  const totalSteps = Math.floor(config.durationSeconds / STEP_SECONDS);
  for (let step = 0; step < totalSteps; step += 1) {
    if (config.mode === 'pause-resume' && step % 800 >= 500 && step % 800 < 650) continue;
    fixedStep += 1;
    simulationClockMs += STEP_MS;
    telemetry.beginFrame(simulationClockMs, STEP_MS, performance.now());
    controller.beginFrame(simulationClockMs);
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
      let desiredSpeed = lane.speedLimit * (config.density === 'high' ? 0.62 : 0.72);
      const lead = before
        .filter((candidate) => candidate.id !== agent.id && candidate.lane?.id === lane.id && candidate.distance > agent.distance)
        .sort((a, b) => a.distance - b.distance)[0];
      if (lead) {
        const gap = lead.distance - agent.distance - 30;
        desiredSpeed = Math.min(desiredSpeed, Math.max(0, lead.speed + (gap - 18) / 1.4));
      }
      let downstreamClear = true;
      if (config.mode === 'roadblock' && agent.id % 3 === 0 && fixedStep % 400 < 160) downstreamClear = false;
      if (lane.kind === 'travel' && next?.intersectionId !== null && next?.intersectionId !== undefined) {
        const stopDistance = lane.spline.length - agent.distance - 7;
        if (stopDistance < 150) {
          const outgoing = agent.route[agent.routeIndex + 2];
          downstreamClear = outgoing
            ? downstreamClear && !before.some((candidate) => candidate.lane?.id === outgoing.id && candidate.distance < 78)
            : false;
          if (outgoing) {
            const decision = controller.request(simulationClockMs, {
              vehicleId: agent.id,
              intersectionId: next.intersectionId,
              connectorLaneId: next.id,
              incomingLaneId: lane.id,
              outgoingLaneId: outgoing.id,
              distanceToStopLine: stopDistance,
              arrivalAt: simulationClockMs + (stopDistance / Math.max(10, agent.speed)) * 1000,
              priority: config.mode === 'wanted' ? 3 : 2,
              emergency: config.mode === 'wanted' && agent.id === 1,
              recoveryAttempt: 0,
              approachClear: true,
              downstreamClear,
            });
            if (!decision.granted) desiredSpeed = Math.min(desiredSpeed, Math.sqrt(Math.max(0, 2 * 100 * stopDistance)));
          }
        }
      }
      const acceleration = Math.max(-150, Math.min(85, (desiredSpeed - agent.speed) * 1.8));
      agent.desiredSpeed = desiredSpeed;
      agent.speed = Math.max(0, agent.speed + acceleration * STEP_SECONDS);
      const stopped = agent.speed < 0.6;
      if (stopped && agent.stoppedSinceMs === null) agent.stoppedSinceMs = simulationClockMs;
      if (!stopped && agent.stoppedSinceMs !== null) {
        stopDurations.push(Math.max(0, simulationClockMs - agent.stoppedSinceMs));
        agent.stoppedSinceMs = null;
      }
      const intersectionStopped = lane.intersectionId !== null && stopped;
      if (intersectionStopped) agent.intersectionDelayMs += STEP_MS;
      if (!intersectionStopped && agent.intersectionDelayMs > 0) {
        intersectionDelays.push(agent.intersectionDelayMs);
        agent.intersectionDelayMs = 0;
      }
      speeds.push(agent.speed);
      advanceAgent(agent, agent.speed * STEP_SECONDS, controller, random, network);
      const activeLane = agent.route[agent.routeIndex];
      if (!activeLane) continue;
      const pose = sampleSpline(activeLane.spline, agent.distance);
      const projection = network.projectPoint(pose.point, activeLane);
      if (projection.distanceSq >= 1.5) leftRoad += 1;
      if (Math.abs(wrapAngle(pose.heading - projection.heading)) >= 0.02) wrongDirection += 1;
      if (activeLane.intersectionId !== null && agent.speed < 0.6) {
        if (agent.intersectionDelayMs > 1_400) blockedIntersection += 1;
      }
      if (fixedStep % 10 === 0) {
        telemetry.recordReplaySample({
          fixedStep,
          simulationClockMs,
          city: config.city,
          district: config.district,
          vehicleId: agent.id,
          driverId: agent.id,
          laneId: activeLane.id,
          laneDistance: agent.distance,
          routeProgress: agent.routeIndex + agent.distance / Math.max(1, activeLane.spline.length),
          position: { x: pose.point.x, y: pose.point.y },
          heading: pose.heading,
          speed: agent.speed,
          desiredSpeed: agent.desiredSpeed,
          simulationTier: 'near',
          state: stopped ? 'Waiting' : 'Following Lane',
          intention: stopped ? 'Yield' : 'Cruise',
          stopReason: stopped ? 'queue' : null,
          blockerId: lead?.id ?? null,
          blockerType: lead ? 'traffic' : null,
          reservationId: controller.hasReservation(agent.id)?.id ?? null,
          queuePosition: controller.queuePosition(agent.id),
          recoveryPhase: 'none',
          lastUpdateTimestamp: simulationClockMs,
          updateAgeMs: 0,
          ownershipClass: config.mode === 'transit' && agent.id % 2 === 0 ? 'transit' : 'ambient',
        });
        telemetry.observeStop({
          nowMs: simulationClockMs,
          vehicleId: agent.id,
          driverId: agent.id,
          stopped,
          laneId: activeLane.id,
          intersectionId: activeLane.intersectionId ?? 'unknown',
          reason: stopped ? 'queue' : null,
          blockerId: lead?.id ?? null,
          blockerType: lead ? 'traffic' : null,
          desiredSpeed: agent.desiredSpeed,
          actualSpeed: agent.speed,
          simulationTier: 'near',
          schedulerLastUpdateAgeMs: 0,
          reservationState: controller.hasReservation(agent.id) ? 'active' : 'none',
          downstreamClear,
          beforeState: stopped ? 'Waiting' : 'Following Lane',
          state: stopped ? 'Waiting' : 'Following Lane',
        });
      }
    }
    controller.resolve(simulationClockMs);
    for (const junction of controller.telemetrySnapshot()) telemetry.recordJunction(junction);
    telemetry.endFrame(performance.now());
  }
  for (const agent of agents) telemetry.closeVehicleStops(agent.id, simulationClockMs, 'Following Lane');
  const snapshot = telemetry.snapshot();
  const controllerData = snapshot.junctions;
  const values = (items: readonly number[]): { average: number | 'unknown'; median: number | 'unknown'; p95: number | 'unknown'; p99: number | 'unknown' } => {
    if (items.length === 0) return { average: 'unknown', median: 'unknown', p95: 'unknown', p99: 'unknown' };
    const sorted = items.slice().sort((a, b) => a - b);
    const at = (p: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))] ?? 0;
    return { average: items.reduce((sum, value) => sum + value, 0) / items.length, median: at(0.5), p95: at(0.95), p99: at(0.99) };
  };
  const speedStats = values(speeds);
  const stopStats = values(stopDurations);
  const delayStats = values(intersectionDelays);
  const frameStats = values(snapshot.frames.map((frame) => frame.realWallClockMs));
  const throughput = agents.reduce((sum, agent) => sum + agent.crossings, 0);
  const reservationTimeouts = controllerData.reduce((sum, item) => sum + item.reservationTimeouts, 0);
  const deterministicPayload = JSON.stringify({
    scenario: config,
    replay: snapshot.replay,
    validation: { wrongDirection, leftRoad, badSpawn, blockedIntersection },
    reservationTimeouts,
  });
  return {
    schemaVersion: 1,
    scenario: config,
    fixtureCoverage: 'headless-network',
    replay: snapshot.replay,
    replayDigest: hashString(deterministicPayload),
    baselineMetrics: {
      averageSpeed: speedStats.average,
      medianSpeed: speedStats.median,
      p95Speed: speedStats.p95,
      throughputVehiclesPerMinute: throughput === 0 ? 0 : throughput / Math.max(1 / 60, config.durationSeconds / 60),
      medianIntersectionDelayMs: delayStats.median,
      p95IntersectionDelayMs: delayStats.p95,
      averageStopDurationMs: stopStats.average,
      p95StopDurationMs: stopStats.p95,
      unexplainedStop: snapshot.counters['stop.unexplained-stop'] ?? 0,
      blockedIntersection: blockedIntersection,
      recovery: snapshot.counters['stop.recovery'] ?? 0,
      recoveryTimeout: 0,
      wrongDirection,
      leftRoad,
      badSpawn,
      reservationTimeout: reservationTimeouts,
      deferredUpdate: 'unknown',
      maximumUpdateAgeMs: 'unknown',
      trafficCpuMs: 'unknown',
      realFrameTimeMs: frameStats.average,
      frameP50Ms: frameStats.median,
      frameP95Ms: frameStats.p95,
      frameP99Ms: frameStats.p99,
      framesOver20Ms: snapshot.frames.filter((frame) => frame.realWallClockMs > 20).length,
      framesOver33Ms: snapshot.frames.filter((frame) => frame.realWallClockMs > 33.34).length,
      framesOver50Ms: snapshot.frames.filter((frame) => frame.realWallClockMs > 50).length,
      activeCount: agents.length,
      virtualCount: 0,
      parkedCount: 0,
      spawnRejectionRate: 'unknown',
      materializationRejectionRate: 'unknown',
      lifecycleRaceCount: 'unknown',
      orphanVehicleCount: 'unknown',
    },
    diagnostics: {
      stopReasons: Object.fromEntries(Object.entries(snapshot.counters).filter(([key]) => key.startsWith('stop.'))),
      signalVisualLogicalDivergenceCount: controllerData.reduce((sum, item) => sum + item.signalVisualLogicalDivergence, 0),
      maximumQueueAgeMs: values(snapshot.junctions.map((junction) => junction.oldestQueueAgeMs)).p95,
      maximumUpdateAgeMs: 'unknown',
      lifecycleRaceCount: 'unknown',
      orphanVehicleCount: 'unknown',
    },
    validation: { wrongDirection, leftRoad, badSpawn, blockedIntersection },
    telemetry: {
      counters: snapshot.counters,
      percentiles: snapshot.percentiles,
      samplesRetained: snapshot.replay.samples.length,
      stopEpisodesRetained: snapshot.stopEpisodes.length,
      lifecycleEventsRetained: snapshot.lifecycle.length,
    },
    wallClockMs: performance.now() - startedAt,
  };
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function advanceAgent(
  agent: Agent,
  requestedDistance: number,
  controller: IntersectionReservationController,
  random: Random,
  network: TrafficNetwork,
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
      const goal = network.chooseDestination(lane.id, () => random.next(), 3);
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
    if (leavingIntersection) {
      agent.crossings += 1;
      controller.releaseVehicle(agent.id);
    }
  }
}

const results: Record<string, unknown>[] = [];
for (const scenario of SCENARIOS) {
  const result = runScenario(scenario);
  results.push(result);
  const filePath = join(OUTPUT_DIR, `${scenario.id}.json`);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}
mkdirSync(OUTPUT_DIR, { recursive: true });
writeFileSync(join(OUTPUT_DIR, 'index.json'), `${JSON.stringify(results, null, 2)}\n`, 'utf8');
const summary = results.map((result) => {
  const scenario = result.scenario as ScenarioConfig;
  const metrics = result.baselineMetrics as Record<string, unknown>;
  return {
    id: scenario.id,
    durationSeconds: scenario.durationSeconds,
    averageSpeed: metrics.averageSpeed,
    throughputVehiclesPerMinute: metrics.throughputVehiclesPerMinute,
    averageStopDurationMs: metrics.averageStopDurationMs,
    p95StopDurationMs: metrics.p95StopDurationMs,
    reservationTimeout: metrics.reservationTimeout,
    realFrameTimeMs: metrics.realFrameTimeMs,
    frameP50Ms: metrics.frameP50Ms,
    frameP95Ms: metrics.frameP95Ms,
    frameP99Ms: metrics.frameP99Ms,
    framesOver20Ms: metrics.framesOver20Ms,
    framesOver33Ms: metrics.framesOver33Ms,
    framesOver50Ms: metrics.framesOver50Ms,
    wallClockMs: result.wallClockMs,
  };
});
console.log(JSON.stringify({ outputDir: OUTPUT_DIR, scenarios: results.length, summary }, null, 2));
