import type { Vector2 } from '@/core/types';
import type { TrafficDriver, TrafficSimulationDetail } from './TrafficDriver';
import {
  emptySchedulerTelemetry,
  type TrafficSchedulerTelemetry,
} from './TrafficTelemetry';

export type TrafficSimulationTier = 'near' | 'medium' | 'far' | 'virtual';

export interface TrafficSchedulerStats {
  readonly cpuMs: number;
  readonly budgetMs: number;
  readonly navigationMs: number;
  readonly steeringMs: number;
  readonly collisionMs: number;
  readonly scheduledUpdates: number;
  readonly deferredUpdates: number;
  readonly activeDrivers: number;
  readonly virtualDrivers: number;
  readonly averageUpdateHz: number;
  readonly load: number;
  readonly nearDrivers: number;
  readonly mediumDrivers: number;
  readonly farDrivers: number;
}

export interface TrafficScheduleWork {
  readonly driver: TrafficDriver;
  readonly detail: TrafficSimulationDetail;
  readonly deltaSeconds: number;
  readonly tier: TrafficSimulationTier;
}

interface MutableTrafficScheduleWork {
  driver: TrafficDriver;
  detail: TrafficSimulationDetail;
  deltaSeconds: number;
  tier: TrafficSimulationTier;
}

interface DriverSchedule {
  tier: TrafficSimulationTier;
  lastUpdateAt: number;
  group: number;
}

const NEAR_DISTANCE = 420;
const MEDIUM_DISTANCE = 800;
const FAR_DISTANCE = 1200;
const MEDIUM_INTERVAL_MS = 100;
const FAR_INTERVAL_MS = 250;
const VIRTUAL_INTERVAL_MS = 1000;
const FRAME_BUDGET_MS = 3.5;
const MEDIUM_GROUPS = 2;
const FAR_GROUPS = 5;
const NEVER_FORCE_NEAR = (): boolean => false;
const HISTOGRAM_BUCKETS = ['0-50', '51-100', '101-250', '251-500', '501-1000', '1001-2000', '2001-plus'] as const;

/**
 * Central budget owner for autonomous traffic. It keeps near vehicles on the
 * 20 Hz simulation clock, distributes lower-priority updates over deterministic
 * groups, and leaves overdue work queued for the next fixed step.
 */
export class TrafficUpdateScheduler {
  private readonly schedules = new Map<number, DriverSchedule>();
  private readonly nearQueue: TrafficScheduleWork[] = [];
  private readonly mediumQueue: TrafficScheduleWork[] = [];
  private readonly farQueue: TrafficScheduleWork[] = [];
  private readonly virtualQueue: TrafficScheduleWork[] = [];
  private readonly statsValue: MutableTrafficSchedulerStats = emptyStats();
  private readonly workPool: MutableTrafficScheduleWork[] = [];
  private workCursor = 0;
  private readonly ageSamples: number[] = [];
  private readonly catchUpDeltaMs: number[] = [];
  private readonly executionMsByDriver: Record<string, number> = Object.create(null) as Record<string, number>;
  private readonly executionDriverIds: number[] = [];
  private readonly scheduledByTier = emptyTierCounts();
  private readonly deferredByTier = emptyTierCounts();
  private readonly queueBeforeByTier = emptyTierCounts();
  private readonly queueAfterByTier = emptyTierCounts();
  private readonly catchUpDeltaHistogram: Record<string, number> = emptyHistogram();
  private oldestDeferredVehicleIdValue: number | null = null;
  private oldestDeferredAge = -Infinity;
  private nearDriversDeferredValue = 0;
  private telemetryValue: TrafficSchedulerTelemetry = emptySchedulerTelemetry(0);
  private fixedStep = 0;

  public get stats(): Readonly<TrafficSchedulerStats> {
    return this.statsValue;
  }

  public get telemetry(): TrafficSchedulerTelemetry {
    return this.telemetryValue;
  }

  public tierFor(vehicleId: number): TrafficSimulationTier | null {
    return this.schedules.get(vehicleId)?.tier ?? null;
  }

  public lastUpdateAt(vehicleId: number): number | null {
    return this.schedules.get(vehicleId)?.lastUpdateAt ?? null;
  }

  public remove(vehicleId: number): void {
    this.schedules.delete(vehicleId);
  }

  public clear(): void {
    this.schedules.clear();
    this.nearQueue.length = 0;
    this.mediumQueue.length = 0;
    this.farQueue.length = 0;
    this.virtualQueue.length = 0;
    this.workCursor = 0;
    this.ageSamples.length = 0;
    this.catchUpDeltaMs.length = 0;
    this.clearExecutionTimings();
    this.fixedStep = 0;
    this.telemetryValue = emptySchedulerTelemetry(0);
    assignStats(this.statsValue, emptyStats());
  }

  public schedule(
    now: number,
    fixedDeltaSeconds: number,
    player: Vector2 | null,
    drivers: Iterable<TrafficDriver>,
    execute: (work: TrafficScheduleWork) => void,
    forceNear: (driver: TrafficDriver) => boolean = NEVER_FORCE_NEAR,
  ): void {
    this.fixedStep += 1;
    this.nearQueue.length = 0;
    this.mediumQueue.length = 0;
    this.farQueue.length = 0;
    this.virtualQueue.length = 0;
    this.workCursor = 0;
    const stats = this.statsValue;
    resetFrameStats(stats);
    resetTierCounts(this.scheduledByTier);
    resetTierCounts(this.deferredByTier);
    resetTierCounts(this.queueBeforeByTier);
    resetTierCounts(this.queueAfterByTier);
    this.ageSamples.length = 0;
    this.catchUpDeltaMs.length = 0;
    this.clearExecutionTimings();
    this.oldestDeferredVehicleIdValue = null;
    this.oldestDeferredAge = -Infinity;
    this.nearDriversDeferredValue = 0;

    for (const driver of drivers) {
      const tier = forceNear(driver) ? 'near' : this.tierForPosition(driver, player);
      const schedule = this.scheduleFor(driver.id, tier, now);
      if (tier === 'near') stats.nearDrivers += 1;
      else if (tier === 'medium') stats.mediumDrivers += 1;
      else if (tier === 'far') stats.farDrivers += 1;
      else stats.virtualDrivers += 1;
      stats.activeDrivers += 1;

      if (!this.isDue(schedule, tier, now)) continue;
      const elapsedMs = Math.max(50, now - schedule.lastUpdateAt);
      const work = this.workPool[this.workCursor] ?? this.createWorkSlot();
      this.workCursor += 1;
      work.driver = driver;
      work.detail = detailFor(tier);
      work.deltaSeconds = tier === 'near' ? fixedDeltaSeconds : elapsedMs / 1000;
      work.tier = tier;
      this.ageSamples.push(elapsedMs);
      this.catchUpDeltaMs.push(work.deltaSeconds * 1000);
      this.queueBeforeByTier[tier] += 1;
      switch (tier) {
        case 'near':
          this.nearQueue.push(work);
          break;
        case 'medium':
          this.mediumQueue.push(work);
          break;
        case 'far':
          this.farQueue.push(work);
          break;
        case 'virtual':
          this.virtualQueue.push(work);
          break;
      }
    }

    // The budget may defer a portion of the visible traffic set. Processing
    // the insertion-order queue every frame makes the same tail vehicles miss
    // every deadline under load, leaving their physical bodies frozen in front
    // of live traffic. Oldest simulation first is bounded, deterministic, and
    // lets every due driver eventually update without raising the frame budget.
    this.orderByStaleness(this.nearQueue);
    this.orderByStaleness(this.mediumQueue);
    this.orderByStaleness(this.farQueue);
    this.orderByStaleness(this.virtualQueue);

    const startedAt = performance.now();
    this.executeQueue(
      this.nearQueue,
      now,
      startedAt,
      execute,
      this.scheduledByTier,
      this.deferredByTier,
      this.queueAfterByTier,
      this.executionMsByDriver,
    );
    this.executeQueue(
      this.mediumQueue,
      now,
      startedAt,
      execute,
      this.scheduledByTier,
      this.deferredByTier,
      this.queueAfterByTier,
      this.executionMsByDriver,
    );
    this.executeQueue(
      this.farQueue,
      now,
      startedAt,
      execute,
      this.scheduledByTier,
      this.deferredByTier,
      this.queueAfterByTier,
      this.executionMsByDriver,
    );
    this.executeQueue(
      this.virtualQueue,
      now,
      startedAt,
      execute,
      this.scheduledByTier,
      this.deferredByTier,
      this.queueAfterByTier,
      this.executionMsByDriver,
    );
    stats.cpuMs = performance.now() - startedAt;
    stats.load = Math.min(1, stats.cpuMs / stats.budgetMs);
    stats.averageUpdateHz =
      stats.activeDrivers > 0 ? (stats.scheduledUpdates * 20) / stats.activeDrivers : 0;
    let minimumAge = 0;
    let maximumAge = 0;
    let ageSum = 0;
    for (let index = 0; index < this.ageSamples.length; index += 1) {
      const age = this.ageSamples[index] ?? 0;
      if (index === 0 || age < minimumAge) minimumAge = age;
      if (index === 0 || age > maximumAge) maximumAge = age;
      ageSum += age;
    }
    const averageAge = this.ageSamples.length > 0
      ? ageSum / this.ageSamples.length
      : 0;
    const p95UpdateAgeMs = percentileInPlace(this.ageSamples, 0.95);
    resetHistogram(this.catchUpDeltaHistogram);
    accumulateHistogram(this.catchUpDeltaMs, this.catchUpDeltaHistogram);
    this.telemetryValue = {
      fixedStep: this.fixedStep,
      scheduledByTier: this.scheduledByTier,
      deferredByTier: this.deferredByTier,
      queueBeforeByTier: this.queueBeforeByTier,
      queueAfterByTier: this.queueAfterByTier,
      oldestDeferredVehicleId: this.oldestDeferredVehicleIdValue,
      maximumUpdateAgeMs: Math.max(maximumAge, this.oldestDeferredAge > 0 ? this.oldestDeferredAge : 0),
      averageUpdateAgeMs: averageAge,
      p95UpdateAgeMs,
      fairnessGapMs: Math.max(0, maximumAge - minimumAge),
      nearDriversDeferred: this.nearDriversDeferredValue,
      catchUpDeltaMs: this.catchUpDeltaMs,
      catchUpDeltaHistogramMs: this.catchUpDeltaHistogram,
      executionMsByDriver: this.executionMsByDriver,
      trafficCpuMs: stats.cpuMs,
      navigationCpuMs: stats.navigationMs,
      steeringCpuMs: stats.steeringMs,
      collisionCpuMs: stats.collisionMs,
    };
  }

  private executeQueue(
    queue: readonly TrafficScheduleWork[],
    now: number,
    startedAt: number,
    execute: (work: TrafficScheduleWork) => void,
    scheduledByTier: Record<TrafficSimulationTier, number>,
    deferredByTier: Record<TrafficSimulationTier, number>,
    queueAfterByTier: Record<TrafficSimulationTier, number>,
    executionMsByDriver: Record<string, number>,
  ): void {
    const stats = this.statsValue;
    for (const work of queue) {
      if (performance.now() - startedAt >= stats.budgetMs) {
        stats.deferredUpdates += 1;
        deferredByTier[work.tier] += 1;
        queueAfterByTier[work.tier] += 1;
        const ageMs = Math.max(50, now - (this.schedules.get(work.driver.id)?.lastUpdateAt ?? now));
        if (
          ageMs > this.oldestDeferredAge ||
          (ageMs === this.oldestDeferredAge && work.driver.id < (this.oldestDeferredVehicleIdValue ?? Infinity))
        ) {
          this.oldestDeferredAge = ageMs;
          this.oldestDeferredVehicleIdValue = work.driver.id;
        }
        if (work.tier === 'near') this.nearDriversDeferredValue += 1;
        continue;
      }
      const driverStartedAt = performance.now();
      execute(work);
      executionMsByDriver[work.driver.id] = performance.now() - driverStartedAt;
      this.executionDriverIds.push(work.driver.id);
      const schedule = this.schedules.get(work.driver.id);
      if (schedule) schedule.lastUpdateAt = now;
      scheduledByTier[work.tier] += 1;
      const cost = work.driver.updateMetrics;
      stats.navigationMs += cost.navigationMs;
      stats.steeringMs += cost.steeringMs;
      stats.collisionMs += cost.collisionMs;
      stats.scheduledUpdates += 1;
    }
  }

  private createWorkSlot(): MutableTrafficScheduleWork {
    const work = {
      driver: null as unknown as TrafficDriver,
      detail: 'frozen' as TrafficSimulationDetail,
      deltaSeconds: 0,
      tier: 'virtual' as TrafficSimulationTier,
    };
    this.workPool.push(work);
    return work;
  }

  private clearExecutionTimings(): void {
    for (const vehicleId of this.executionDriverIds) delete this.executionMsByDriver[vehicleId];
    this.executionDriverIds.length = 0;
  }

  private orderByStaleness(queue: TrafficScheduleWork[]): void {
    queue.sort((first, second) => {
      const firstUpdatedAt = this.schedules.get(first.driver.id)?.lastUpdateAt ?? -Infinity;
      const secondUpdatedAt = this.schedules.get(second.driver.id)?.lastUpdateAt ?? -Infinity;
      if (firstUpdatedAt !== secondUpdatedAt) return firstUpdatedAt - secondUpdatedAt;
      return first.driver.id - second.driver.id;
    });
  }

  private scheduleFor(vehicleId: number, tier: TrafficSimulationTier, now: number): DriverSchedule {
    const existing = this.schedules.get(vehicleId);
    if (existing) {
      existing.tier = tier;
      return existing;
    }
    const groupModulo = tier === 'medium' ? MEDIUM_GROUPS : tier === 'far' ? FAR_GROUPS : 1;
    const schedule: DriverSchedule = {
      tier,
      // New drivers update immediately. Existing drivers retain their cadence while changing tiers.
      lastUpdateAt: now - intervalFor(tier),
      group: Math.abs(vehicleId) % groupModulo,
    };
    this.schedules.set(vehicleId, schedule);
    return schedule;
  }

  private isDue(schedule: DriverSchedule, tier: TrafficSimulationTier, now: number): boolean {
    if (tier === 'near') return true;
    const interval = intervalFor(tier);
    if (now - schedule.lastUpdateAt < interval) return false;
    const groups = tier === 'medium' ? MEDIUM_GROUPS : tier === 'far' ? FAR_GROUPS : 1;
    return groups === 1 || (this.fixedStep + schedule.group) % groups === 0;
  }

  private tierForPosition(driver: TrafficDriver, player: Vector2 | null): TrafficSimulationTier {
    if (!player) return 'virtual';
    const position = driver.position;
    const dx = position.x - player.x;
    const dy = position.y - player.y;
    const distanceSq = dx * dx + dy * dy;
    if (distanceSq <= NEAR_DISTANCE * NEAR_DISTANCE) return 'near';
    if (distanceSq <= MEDIUM_DISTANCE * MEDIUM_DISTANCE) return 'medium';
    if (distanceSq <= FAR_DISTANCE * FAR_DISTANCE) return 'far';
    return 'virtual';
  }
}

function emptyTierCounts(): Record<TrafficSimulationTier, number> {
  return { near: 0, medium: 0, far: 0, virtual: 0 };
}

function percentileInPlace(values: number[], p: number): number {
  if (values.length === 0) return 0;
  values.sort((a, b) => a - b);
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * p) - 1));
  return values[index] ?? 0;
}

function emptyHistogram(): Record<string, number> {
  const result: Record<string, number> = {};
  for (const bucket of HISTOGRAM_BUCKETS) result[bucket] = 0;
  return result;
}

function resetHistogram(result: Record<string, number>): void {
  for (const bucket of HISTOGRAM_BUCKETS) result[bucket] = 0;
}

function accumulateHistogram(values: readonly number[], result: Record<string, number>): void {
  for (const value of values) {
    const bucket = value <= 50
      ? '0-50'
      : value <= 100
        ? '51-100'
        : value <= 250
          ? '101-250'
          : value <= 500
            ? '251-500'
            : value <= 1000
              ? '501-1000'
              : value <= 2000
                ? '1001-2000'
                : '2001-plus';
    result[bucket] = (result[bucket] ?? 0) + 1;
  }
}

interface MutableTrafficSchedulerStats {
  cpuMs: number;
  budgetMs: number;
  navigationMs: number;
  steeringMs: number;
  collisionMs: number;
  scheduledUpdates: number;
  deferredUpdates: number;
  activeDrivers: number;
  virtualDrivers: number;
  averageUpdateHz: number;
  load: number;
  nearDrivers: number;
  mediumDrivers: number;
  farDrivers: number;
}

function intervalFor(tier: TrafficSimulationTier): number {
  switch (tier) {
    case 'near':
      return 50;
    case 'medium':
      return MEDIUM_INTERVAL_MS;
    case 'far':
      return FAR_INTERVAL_MS;
    case 'virtual':
    default:
      return VIRTUAL_INTERVAL_MS;
  }
}

function detailFor(tier: TrafficSimulationTier): TrafficSimulationDetail {
  return tier === 'near' || tier === 'medium' ? 'full' : tier === 'far' ? 'coarse' : 'frozen';
}

function emptyStats(): MutableTrafficSchedulerStats {
  return {
    cpuMs: 0,
    budgetMs: FRAME_BUDGET_MS,
    navigationMs: 0,
    steeringMs: 0,
    collisionMs: 0,
    scheduledUpdates: 0,
    deferredUpdates: 0,
    activeDrivers: 0,
    virtualDrivers: 0,
    averageUpdateHz: 0,
    load: 0,
    nearDrivers: 0,
    mediumDrivers: 0,
    farDrivers: 0,
  };
}

function resetFrameStats(stats: MutableTrafficSchedulerStats): void {
  stats.cpuMs = 0;
  stats.navigationMs = 0;
  stats.steeringMs = 0;
  stats.collisionMs = 0;
  stats.scheduledUpdates = 0;
  stats.deferredUpdates = 0;
  stats.activeDrivers = 0;
  stats.virtualDrivers = 0;
  stats.averageUpdateHz = 0;
  stats.load = 0;
  stats.nearDrivers = 0;
  stats.mediumDrivers = 0;
  stats.farDrivers = 0;
}

function resetTierCounts(counts: Record<TrafficSimulationTier, number>): void {
  counts.near = 0;
  counts.medium = 0;
  counts.far = 0;
  counts.virtual = 0;
}

function assignStats(
  target: MutableTrafficSchedulerStats,
  source: MutableTrafficSchedulerStats,
): void {
  target.cpuMs = source.cpuMs;
  target.budgetMs = source.budgetMs;
  target.navigationMs = source.navigationMs;
  target.steeringMs = source.steeringMs;
  target.collisionMs = source.collisionMs;
  target.scheduledUpdates = source.scheduledUpdates;
  target.deferredUpdates = source.deferredUpdates;
  target.activeDrivers = source.activeDrivers;
  target.virtualDrivers = source.virtualDrivers;
  target.averageUpdateHz = source.averageUpdateHz;
  target.load = source.load;
  target.nearDrivers = source.nearDrivers;
  target.mediumDrivers = source.mediumDrivers;
  target.farDrivers = source.farDrivers;
}
