import type { IWorldQuery } from '@/gameplay/types';
import type { TrafficDriver } from './TrafficDriver';
import type { TrafficNetwork } from './TrafficNetwork';
import { wrapAngle } from './SplineMath';
import type { TrafficValidationFailure, TrafficValidationReport } from './TrafficTypes';

const VALIDATION_INTERVAL_MS = 500;
const INTERSECTION_STOP_LIMIT_MS = 1400;

/** Runtime invariant monitor used by developer mode and long observation tests. */
export class TrafficValidator {
  private elapsedMs = 0;
  private readonly intersectionStoppedMs = new Map<number, number>();
  private readonly mergeStoppedMs = new Map<number, number>();
  private failuresValue: TrafficValidationFailure[] = [];
  private checkedVehiclesValue = 0;

  constructor(
    private readonly network: TrafficNetwork,
    private readonly world: IWorldQuery,
  ) {}

  public get report(): TrafficValidationReport {
    return {
      passed: this.failuresValue.length === 0,
      checkedVehicles: this.checkedVehiclesValue,
      failures: this.failuresValue,
    };
  }

  public update(now: number, deltaMs: number, drivers: Iterable<TrafficDriver>): void {
    this.elapsedMs += deltaMs;
    if (this.elapsedMs < VALIDATION_INTERVAL_MS) return;
    const elapsed = this.elapsedMs;
    this.elapsedMs = 0;
    const failures: TrafficValidationFailure[] = [];
    let checked = 0;
    for (const driver of drivers) {
      const snapshot = driver.snapshot();
      if (!snapshot) continue;
      checked += 1;
      const debug = driver.debug;
      const lane = this.network.lane(snapshot.laneId);
      if (!lane) continue;
      const road = lane.roadSegmentId ? this.network.road(lane.roadSegmentId) : null;
      const projection = this.network.projectPoint(snapshot.position, lane);
      const headingError = Math.abs(wrapAngle(snapshot.heading - projection.heading));
      if (headingError > 0.48 && debug.state !== 'Reversing') {
        failures.push(
          this.failure(
            'wrong-direction',
            driver.id,
            now,
            `heading error ${headingError.toFixed(2)} rad`,
          ),
        );
      }
      const laneTolerance = lane.width * 0.62;
      if (
        projection.distanceSq > laneTolerance * laneTolerance &&
        debug.state !== 'Changing Lane'
      ) {
        failures.push(
          this.failure(
            'left-road',
            driver.id,
            now,
            `lane error ${Math.sqrt(projection.distanceSq).toFixed(1)} px`,
          ),
        );
      }
      if (this.world.isSolidAtWorld(snapshot.position.x, snapshot.position.y)) {
        failures.push(
          this.failure(
            'building-collision',
            driver.id,
            now,
            'vehicle center entered solid geometry',
          ),
        );
      }
      if (debug.state === 'Spawning' && headingError > 0.05) {
        failures.push(
          this.failure(
            'bad-spawn-orientation',
            driver.id,
            now,
            `spawn error ${headingError.toFixed(2)} rad`,
          ),
        );
      }
      if (
        road?.highwayComponent !== undefined &&
        (snapshot.speed < -0.1 || debug.state === 'Reversing')
      ) {
        failures.push(
          this.failure(
            'transition-reversal',
            driver.id,
            now,
            `${road.highwayComponent} attempted reverse recovery`,
          ),
        );
      }
      if (lane.kind === 'merge' && snapshot.speed < 1.2) {
        const stopped = (this.mergeStoppedMs.get(driver.id) ?? 0) + elapsed;
        this.mergeStoppedMs.set(driver.id, stopped);
        if (stopped > INTERSECTION_STOP_LIMIT_MS) {
          failures.push(
            this.failure('stopped-in-merge', driver.id, now, `${Math.round(stopped)} ms`),
          );
        }
      } else {
        this.mergeStoppedMs.delete(driver.id);
      }
      if (
        snapshot.speed < 1.2 &&
        debug.desiredSpeed > 14 &&
        debug.recovery.blockedSeconds > 8 &&
        debug.state !== 'Waiting' &&
        debug.state !== 'Yielding' &&
        debug.state !== 'Avoiding Obstacle'
      ) {
        failures.push(
          this.failure(
            'unexplained-stop',
            driver.id,
            now,
            `${debug.recovery.blockedSeconds.toFixed(1)} s`,
          ),
        );
      }
      if (lane.intersectionId !== null && snapshot.speed < 1.2) {
        const stopped = (this.intersectionStoppedMs.get(driver.id) ?? 0) + elapsed;
        this.intersectionStoppedMs.set(driver.id, stopped);
        if (stopped > INTERSECTION_STOP_LIMIT_MS) {
          failures.push(
            this.failure('blocked-intersection', driver.id, now, `${Math.round(stopped)} ms`),
          );
        }
      } else {
        this.intersectionStoppedMs.delete(driver.id);
      }
      if (debug.recovery.phase !== 'none' && debug.recovery.blockedSeconds > 24) {
        failures.push(
          this.failure('recovery-timeout', driver.id, now, debug.recovery.reason ?? 'unknown'),
        );
      }
    }
    this.checkedVehiclesValue = checked;
    this.failuresValue = failures;
  }

  public clear(): void {
    this.elapsedMs = 0;
    this.intersectionStoppedMs.clear();
    this.mergeStoppedMs.clear();
    this.failuresValue = [];
    this.checkedVehiclesValue = 0;
  }

  private failure(
    code: TrafficValidationFailure['code'],
    vehicleId: number,
    at: number,
    message: string,
  ): TrafficValidationFailure {
    return { code, vehicleId, at, message };
  }
}
