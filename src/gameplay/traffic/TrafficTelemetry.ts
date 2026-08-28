import type {
  TrafficDriverState,
  TrafficIntention,
  TrafficObstacleKind,
} from './TrafficTypes';
import type { TrafficSimulationTier } from './TrafficUpdateScheduler';

export type TelemetryUnknown = 'unknown';
export type TelemetryValue<T> = T | TelemetryUnknown;

export type TrafficStopReason =
  | 'red-signal'
  | 'yellow-signal'
  | 'queue'
  | 'lead-vehicle'
  | 'yield'
  | 'downstream-blocked'
  | 'obstacle'
  | 'bus-stop'
  | 'taxi-stop'
  | 'collision-avoidance'
  | 'recovery'
  | 'unexplained-stop'
  | 'external-stop'
  | 'parking';

export type TrafficOwnershipClass =
  | 'ambient'
  | 'parked'
  | 'transit'
  | 'service'
  | 'emergency'
  | 'pursuit'
  | 'mission'
  | 'player'
  | 'unknown';

export interface TrafficReplayHeader {
  readonly schemaVersion: 1;
  readonly worldSeed: TelemetryValue<number>;
  readonly simulationSeed: TelemetryValue<number>;
  readonly scenarioId: string;
}

export interface TrafficReplaySample {
  readonly fixedStep: number;
  readonly simulationClockMs: number;
  readonly city: TelemetryValue<string>;
  readonly district: TelemetryValue<string>;
  readonly vehicleId: number;
  readonly driverId: number;
  readonly laneId: TelemetryValue<string>;
  readonly laneDistance: TelemetryValue<number>;
  readonly routeProgress: TelemetryValue<number>;
  readonly position: { readonly x: number; readonly y: number };
  readonly heading: number;
  readonly speed: number;
  readonly desiredSpeed: number;
  readonly simulationTier: TrafficSimulationTier;
  readonly state: TrafficDriverState;
  readonly intention: TrafficIntention;
  readonly stopReason: TrafficStopReason | null;
  readonly blockerId: number | string | null;
  readonly blockerType: TrafficObstacleKind | null;
  readonly reservationId: string | null;
  readonly queuePosition: TelemetryValue<number>;
  readonly recoveryPhase: string;
  readonly lastUpdateTimestamp: TelemetryValue<number>;
  readonly updateAgeMs: TelemetryValue<number>;
  readonly ownershipClass: TrafficOwnershipClass;
}

export interface TrafficStopEpisode {
  readonly vehicleId: number;
  readonly driverId: number;
  readonly startTimeMs: number;
  readonly endTimeMs: TelemetryValue<number>;
  readonly durationMs: TelemetryValue<number>;
  readonly laneId: TelemetryValue<string>;
  readonly intersectionId: TelemetryValue<number>;
  readonly stopReason: TrafficStopReason;
  readonly blockerId: number | string | null;
  readonly blockerType: TrafficObstacleKind | null;
  readonly desiredSpeedAtStop: number;
  readonly actualSpeedAtStop: number;
  readonly simulationTier: TrafficSimulationTier;
  readonly schedulerLastUpdateAgeMs: TelemetryValue<number>;
  readonly reservationState: string;
  readonly downstreamClear: TelemetryValue<boolean>;
  readonly beforeState: TrafficDriverState;
  readonly afterState: TrafficDriverState;
}

export interface TrafficSchedulerTelemetry {
  readonly fixedStep: number;
  readonly scheduledByTier: Readonly<Record<TrafficSimulationTier, number>>;
  readonly deferredByTier: Readonly<Record<TrafficSimulationTier, number>>;
  readonly queueBeforeByTier: Readonly<Record<TrafficSimulationTier, number>>;
  readonly queueAfterByTier: Readonly<Record<TrafficSimulationTier, number>>;
  readonly oldestDeferredVehicleId: number | null;
  readonly maximumUpdateAgeMs: number;
  readonly averageUpdateAgeMs: number;
  readonly p95UpdateAgeMs: number;
  readonly fairnessGapMs: number;
  readonly nearDriversDeferred: number;
  readonly catchUpDeltaMs: readonly number[];
  readonly catchUpDeltaHistogramMs: Readonly<Record<string, number>>;
  readonly executionMsByDriver: Readonly<Record<string, number>>;
  readonly trafficCpuMs: number;
  readonly navigationCpuMs: number;
  readonly steeringCpuMs: number;
  readonly collisionCpuMs: number;
}

export interface TrafficJunctionTelemetry {
  readonly junctionId: number;
  readonly currentPhase: string;
  readonly signalGroup: string;
  readonly phaseStartedAtMs: TelemetryValue<number>;
  readonly phaseEndsAtMs: TelemetryValue<number>;
  readonly queueLengthByIncomingLane: Readonly<Record<string, number>>;
  readonly oldestQueueAgeMs: number;
  readonly reservationsGranted: number;
  readonly reservationsDenied: number;
  readonly denialReasons: Readonly<Record<string, number>>;
  readonly reservationTimeouts: number;
  readonly activeReservations: number;
  readonly connectorOccupancy: number;
  readonly downstreamBlockedDurationMs: TelemetryValue<number>;
  readonly stopBoxOccupancy: number;
  readonly spillbackDepth: TelemetryValue<number>;
  readonly deadlockDurationMs: TelemetryValue<number>;
  readonly signalVisualLogicalDivergence: number;
}

export type TrafficLifecycleEventKind =
  | 'spawn-accepted'
  | 'spawn-rejected'
  | 'materialize-accepted'
  | 'materialize-rejected'
  | 'virtualize'
  | 'virtual-retire'
  | 'despawn'
  | 'protected-despawn-rejected'
  | 'pool-reuse'
  | 'orphan-detected';

export type TrafficSpawnRejectReason =
  | 'invalid-lane'
  | 'wrong-heading'
  | 'front-clearance'
  | 'rear-clearance'
  | 'vehicle-overlap'
  | 'player-distance'
  | 'npc-overlap'
  | 'solid-geometry'
  | 'temporary-obstacle'
  | 'intersection-proximity'
  | 'stop-line-proximity'
  | 'camera-visibility'
  | 'capacity-limit'
  | 'unknown';

export interface TrafficLifecycleEvent {
  readonly kind: TrafficLifecycleEventKind;
  readonly atMs: number;
  readonly vehicleId: number | null;
  readonly driverId: number | null;
  readonly reason: TrafficSpawnRejectReason | string | null;
  readonly ownershipClass: TrafficOwnershipClass;
  readonly state: TrafficDriverState | null;
  readonly metadataLost: readonly string[];
}

export interface TrafficTelemetryFrame {
  readonly frameId: number;
  readonly simulationClockMs: number;
  readonly simulationDeltaMs: number;
  readonly realWallClockMs: number;
}

export interface TrafficTelemetrySnapshot {
  readonly schemaVersion: 1;
  readonly replay: {
    readonly header: TrafficReplayHeader;
    readonly samples: readonly TrafficReplaySample[];
  };
  readonly frames: readonly TrafficTelemetryFrame[];
  readonly stopEpisodes: readonly TrafficStopEpisode[];
  readonly activeStops: readonly TrafficStopEpisode[];
  readonly scheduler: readonly TrafficSchedulerTelemetry[];
  readonly junctions: readonly TrafficJunctionTelemetry[];
  readonly lifecycle: readonly TrafficLifecycleEvent[];
  readonly counters: Readonly<Record<string, number>>;
  readonly percentiles: Readonly<Record<string, number | TelemetryUnknown>>;
}

export interface TrafficTelemetryOptions {
  readonly scenarioId?: string;
  readonly worldSeed?: number;
  readonly simulationSeed?: number;
  readonly maxSamples?: number;
  readonly maxEvents?: number;
  readonly maxFrames?: number;
}

interface MutableStop {
  readonly vehicleId: number;
  readonly driverId: number;
  readonly startTimeMs: number;
  readonly laneId: TelemetryValue<string>;
  readonly intersectionId: TelemetryValue<number>;
  readonly stopReason: TrafficStopReason;
  readonly blockerId: number | string | null;
  readonly blockerType: TrafficObstacleKind | null;
  readonly desiredSpeedAtStop: number;
  readonly actualSpeedAtStop: number;
  readonly simulationTier: TrafficSimulationTier;
  readonly schedulerLastUpdateAgeMs: TelemetryValue<number>;
  readonly reservationState: string;
  readonly downstreamClear: TelemetryValue<boolean>;
  readonly beforeState: TrafficDriverState;
}

const TIERS: readonly TrafficSimulationTier[] = ['near', 'medium', 'far', 'virtual'];

function emptyTierRecord(): Record<TrafficSimulationTier, number> {
  return { near: 0, medium: 0, far: 0, virtual: 0 };
}

function percentile(values: readonly number[], p: number): number | TelemetryUnknown {
  if (values.length === 0) return 'unknown';
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index] ?? 'unknown';
}

function cloneRecord<T extends Record<string, unknown>>(record: T): T {
  return { ...record };
}

/**
 * Bounded, deterministic, observational telemetry for the traffic runtime.
 * It never calls back into simulation owners and never mutates their state.
 */
export class TrafficTelemetryCollector {
  private readonly headerValue: TrafficReplayHeader;
  private readonly maxSamples: number;
  private readonly maxEvents: number;
  private readonly maxFrames: number;
  private readonly replaySamples: TrafficReplaySample[] = [];
  private readonly framesValue: TrafficTelemetryFrame[] = [];
  private readonly stopEpisodesValue: TrafficStopEpisode[] = [];
  private readonly activeStops = new Map<number, MutableStop>();
  private readonly schedulerSamples: TrafficSchedulerTelemetry[] = [];
  private readonly junctionSamples = new Map<number, TrafficJunctionTelemetry>();
  private readonly lifecycleEvents: TrafficLifecycleEvent[] = [];
  private readonly countersValue = new Map<string, number>();
  private readonly stopDurations: number[] = [];
  private readonly updateAges: number[] = [];
  private readonly queueAges: number[] = [];
  private frameIdValue = 0;
  private currentFrame: TrafficTelemetryFrame | null = null;

  constructor(options: TrafficTelemetryOptions = {}) {
    this.headerValue = {
      schemaVersion: 1,
      worldSeed: options.worldSeed ?? 'unknown',
      simulationSeed: options.simulationSeed ?? 'unknown',
      scenarioId: options.scenarioId ?? 'runtime',
    };
    this.maxSamples = Math.max(1, options.maxSamples ?? 200_000);
    this.maxEvents = Math.max(1, options.maxEvents ?? 50_000);
    this.maxFrames = Math.max(1, options.maxFrames ?? 20_000);
  }

  public get currentFrameId(): number {
    return this.frameIdValue;
  }

  public beginFrame(
    simulationClockMs: number,
    simulationDeltaMs: number,
    realWallClockStartMs: number,
  ): void {
    this.frameIdValue += 1;
    this.currentFrame = {
      frameId: this.frameIdValue,
      simulationClockMs,
      simulationDeltaMs,
      realWallClockMs: Math.max(0, realWallClockStartMs),
    };
  }

  public endFrame(realWallClockEndMs: number): void {
    const frame = this.currentFrame;
    if (!frame) return;
    const completed: TrafficTelemetryFrame = {
      ...frame,
      realWallClockMs: Math.max(0, realWallClockEndMs - frame.realWallClockMs),
    };
    this.pushBounded(this.framesValue, completed, this.maxFrames);
    this.currentFrame = null;
  }

  public recordReplaySample(sample: TrafficReplaySample): void {
    this.pushBounded(this.replaySamples, sample, this.maxSamples);
    if (sample.updateAgeMs !== 'unknown') this.updateAges.push(sample.updateAgeMs);
  }

  public observeStop(input: {
    readonly nowMs: number;
    readonly vehicleId: number;
    readonly driverId: number;
    readonly stopped: boolean;
    readonly laneId: TelemetryValue<string>;
    readonly intersectionId: TelemetryValue<number>;
    readonly reason: TrafficStopReason | null;
    readonly blockerId: number | string | null;
    readonly blockerType: TrafficObstacleKind | null;
    readonly desiredSpeed: number;
    readonly actualSpeed: number;
    readonly simulationTier: TrafficSimulationTier;
    readonly schedulerLastUpdateAgeMs: TelemetryValue<number>;
    readonly reservationState: string;
    readonly downstreamClear: TelemetryValue<boolean>;
    readonly beforeState: TrafficDriverState;
    readonly state: TrafficDriverState;
  }): void {
    const existing = this.activeStops.get(input.vehicleId);
    if (!input.stopped || input.reason === null) {
      if (existing) this.closeStop(existing, input.nowMs, input.state);
      return;
    }
    if (existing && existing.stopReason === input.reason) return;
    if (existing) this.closeStop(existing, input.nowMs, input.state);
    this.activeStops.set(input.vehicleId, {
      vehicleId: input.vehicleId,
      driverId: input.driverId,
      startTimeMs: input.nowMs,
      laneId: input.laneId,
      intersectionId: input.intersectionId,
      stopReason: input.reason,
      blockerId: input.blockerId,
      blockerType: input.blockerType,
      desiredSpeedAtStop: input.desiredSpeed,
      actualSpeedAtStop: input.actualSpeed,
      simulationTier: input.simulationTier,
      schedulerLastUpdateAgeMs: input.schedulerLastUpdateAgeMs,
      reservationState: input.reservationState,
      downstreamClear: input.downstreamClear,
      beforeState: input.beforeState,
    });
  }

  public closeVehicleStops(vehicleId: number, nowMs: number, afterState: TrafficDriverState): void {
    const existing = this.activeStops.get(vehicleId);
    if (existing) this.closeStop(existing, nowMs, afterState);
  }

  public recordScheduler(sample: TrafficSchedulerTelemetry): void {
    // The scheduler reuses its bounded work buffers between fixed steps. Take
    // an observational copy here so historical telemetry remains immutable
    // while the hot path avoids allocating per-driver records.
    this.pushBounded(this.schedulerSamples, cloneSchedulerTelemetry(sample), this.maxFrames);
    for (const tier of TIERS) {
      this.increment(`scheduler.scheduled.${tier}`, sample.scheduledByTier[tier] ?? 0);
      this.increment(`scheduler.deferred.${tier}`, sample.deferredByTier[tier] ?? 0);
    }
    this.updateAges.push(sample.maximumUpdateAgeMs, sample.averageUpdateAgeMs, sample.p95UpdateAgeMs);
  }

  public recordJunction(sample: TrafficJunctionTelemetry): void {
    this.junctionSamples.set(sample.junctionId, sample);
    this.queueAges.push(sample.oldestQueueAgeMs);
  }

  public recordLifecycle(event: TrafficLifecycleEvent): void {
    this.pushBounded(this.lifecycleEvents, event, this.maxEvents);
    this.increment(`lifecycle.${event.kind}`);
    if (event.reason) this.increment(`lifecycle.reason.${event.reason}`);
    this.increment(`lifecycle.ownership.${event.ownershipClass}`);
  }

  public increment(counter: string, amount = 1): void {
    if (!Number.isFinite(amount)) return;
    this.countersValue.set(counter, (this.countersValue.get(counter) ?? 0) + amount);
  }

  public snapshot(): TrafficTelemetrySnapshot {
    const activeStops = Array.from(this.activeStops.values())
      .sort((a, b) => a.vehicleId - b.vehicleId)
      .map((stop) => this.toEpisode(stop, 'unknown', stop.beforeState));
    const counters: Record<string, number> = {};
    for (const [key, value] of Array.from(this.countersValue.entries()).sort(([a], [b]) => a.localeCompare(b))) {
      counters[key] = value;
    }
    const percentiles: Record<string, number | TelemetryUnknown> = {
      stopDurationP50Ms: percentile(this.stopDurations, 0.5),
      stopDurationP95Ms: percentile(this.stopDurations, 0.95),
      updateAgeP50Ms: percentile(this.updateAges, 0.5),
      updateAgeP95Ms: percentile(this.updateAges, 0.95),
      queueAgeP50Ms: percentile(this.queueAges, 0.5),
      queueAgeP95Ms: percentile(this.queueAges, 0.95),
    };
    return {
      schemaVersion: 1,
      replay: {
        header: this.headerValue,
        samples: this.replaySamples.slice().sort((a, b) => a.fixedStep - b.fixedStep || a.driverId - b.driverId),
      },
      frames: this.framesValue.slice(),
      stopEpisodes: this.stopEpisodesValue.slice(),
      activeStops,
      scheduler: this.schedulerSamples.slice(),
      junctions: Array.from(this.junctionSamples.values()).sort((a, b) => a.junctionId - b.junctionId),
      lifecycle: this.lifecycleEvents.slice(),
      counters,
      percentiles,
    };
  }

  public reset(): void {
    this.replaySamples.length = 0;
    this.framesValue.length = 0;
    this.stopEpisodesValue.length = 0;
    this.activeStops.clear();
    this.schedulerSamples.length = 0;
    this.junctionSamples.clear();
    this.lifecycleEvents.length = 0;
    this.countersValue.clear();
    this.stopDurations.length = 0;
    this.updateAges.length = 0;
    this.queueAges.length = 0;
    this.frameIdValue = 0;
    this.currentFrame = null;
  }

  private closeStop(stop: MutableStop, nowMs: number, afterState: TrafficDriverState): void {
    this.activeStops.delete(stop.vehicleId);
    const episode = this.toEpisode(stop, nowMs, afterState);
    this.pushBounded(this.stopEpisodesValue, episode, this.maxEvents);
    if (episode.durationMs !== 'unknown') this.stopDurations.push(episode.durationMs);
    this.increment(`stop.${episode.stopReason}`);
  }

  private toEpisode(
    stop: MutableStop,
    endTimeMs: TelemetryValue<number>,
    afterState: TrafficDriverState,
  ): TrafficStopEpisode {
    return {
      vehicleId: stop.vehicleId,
      driverId: stop.driverId,
      startTimeMs: stop.startTimeMs,
      endTimeMs,
      durationMs:
        endTimeMs === 'unknown' ? 'unknown' : Math.max(0, endTimeMs - stop.startTimeMs),
      laneId: stop.laneId,
      intersectionId: stop.intersectionId,
      stopReason: stop.stopReason,
      blockerId: stop.blockerId,
      blockerType: stop.blockerType,
      desiredSpeedAtStop: stop.desiredSpeedAtStop,
      actualSpeedAtStop: stop.actualSpeedAtStop,
      simulationTier: stop.simulationTier,
      schedulerLastUpdateAgeMs: stop.schedulerLastUpdateAgeMs,
      reservationState: stop.reservationState,
      downstreamClear: stop.downstreamClear,
      beforeState: stop.beforeState,
      afterState,
    };
  }

  private pushBounded<T>(target: T[], value: T, maxLength: number): void {
    target.push(value);
    if (target.length > maxLength) target.splice(0, target.length - maxLength);
  }
}

function cloneSchedulerTelemetry(sample: TrafficSchedulerTelemetry): TrafficSchedulerTelemetry {
  return {
    fixedStep: sample.fixedStep,
    scheduledByTier: { ...sample.scheduledByTier },
    deferredByTier: { ...sample.deferredByTier },
    queueBeforeByTier: { ...sample.queueBeforeByTier },
    queueAfterByTier: { ...sample.queueAfterByTier },
    oldestDeferredVehicleId: sample.oldestDeferredVehicleId,
    maximumUpdateAgeMs: sample.maximumUpdateAgeMs,
    averageUpdateAgeMs: sample.averageUpdateAgeMs,
    p95UpdateAgeMs: sample.p95UpdateAgeMs,
    fairnessGapMs: sample.fairnessGapMs,
    nearDriversDeferred: sample.nearDriversDeferred,
    catchUpDeltaMs: sample.catchUpDeltaMs.slice(),
    catchUpDeltaHistogramMs: { ...sample.catchUpDeltaHistogramMs },
    executionMsByDriver: { ...sample.executionMsByDriver },
    trafficCpuMs: sample.trafficCpuMs,
    navigationCpuMs: sample.navigationCpuMs,
    steeringCpuMs: sample.steeringCpuMs,
    collisionCpuMs: sample.collisionCpuMs,
  };
}

export function emptySchedulerTelemetry(fixedStep: number): TrafficSchedulerTelemetry {
  const empty = emptyTierRecord();
  return {
    fixedStep,
    scheduledByTier: cloneRecord(empty),
    deferredByTier: cloneRecord(empty),
    queueBeforeByTier: cloneRecord(empty),
    queueAfterByTier: cloneRecord(empty),
    oldestDeferredVehicleId: null,
    maximumUpdateAgeMs: 0,
    averageUpdateAgeMs: 0,
    p95UpdateAgeMs: 0,
    fairnessGapMs: 0,
    nearDriversDeferred: 0,
    catchUpDeltaMs: [],
    catchUpDeltaHistogramMs: {},
    executionMsByDriver: {},
    trafficCpuMs: 0,
    navigationCpuMs: 0,
    steeringCpuMs: 0,
    collisionCpuMs: 0,
  };
}
