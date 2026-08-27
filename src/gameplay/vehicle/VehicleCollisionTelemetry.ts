import { VEHICLE_COLLISION } from '@/config/Constants';
import type {
  VehicleCollisionSeverity,
  VehicleCollisionType,
} from './VehicleDynamicsTypes';

export type VehicleCollisionLodTier = 'near' | 'medium';

export interface VehicleCollisionTelemetrySnapshot {
  readonly totalVehicleCollisions: number;
  readonly collisionsByType: Readonly<Record<VehicleCollisionType, number>>;
  readonly collisionsBySeverity: Readonly<Record<VehicleCollisionSeverity, number>>;
  readonly contactsByLod: Readonly<Record<VehicleCollisionLodTier, number>>;
  readonly averageRelativeSpeed: number;
  readonly p95RelativeSpeed: number;
  readonly averageImpulse: number;
  readonly p95Impulse: number;
  readonly maximumImpulse: number;
  readonly targetDisplacement: number;
  readonly playerSpeedLoss: number;
  readonly maximumAngularVelocity: number;
  readonly worldClampedImpacts: number;
  readonly blockedImpacts: number;
  readonly duplicatePairSuppressions: number;
  readonly collisionCooldownSuppressions: number;
  readonly collisionDamage: number;
  readonly averageImpactRecoverySeconds: number;
  readonly failedLaneRejoins: number;
  readonly collisionCpuMs: number;
  readonly maximumCollisionCpuMs: number;
  readonly broadphasePairs: number;
  readonly narrowphaseContacts: number;
  readonly droppedPairs: number;
}

export interface CollisionTelemetryInput {
  readonly type: Exclude<VehicleCollisionType, 'world'>;
  readonly severity: VehicleCollisionSeverity;
  readonly lod: VehicleCollisionLodTier;
  readonly relativeSpeed: number;
  readonly impulse: number;
  readonly targetDisplacement: number;
  readonly playerSpeedLoss: number;
  readonly angularVelocity: number;
  readonly damage: number;
}

const COLLISION_TYPES: readonly VehicleCollisionType[] = [
  'rear-end',
  'head-on',
  'side',
  'glancing',
  'world',
];

function typeCounters(): Record<VehicleCollisionType, number> {
  return { 'rear-end': 0, 'head-on': 0, side: 0, glancing: 0, world: 0 };
}

function severityCounters(): Record<VehicleCollisionSeverity, number> {
  return { light: 0, medium: 0, heavy: 0 };
}

function percentile(values: Float64Array, count: number, cursor: number, p: number): number {
  if (count <= 0) return 0;
  const ordered = new Array<number>(count);
  const start = count === values.length ? cursor : 0;
  for (let index = 0; index < count; index += 1) {
    ordered[index] = values[(start + index) % values.length] ?? 0;
  }
  ordered.sort((a, b) => a - b);
  return ordered[Math.min(count - 1, Math.max(0, Math.ceil(count * p) - 1))] ?? 0;
}

/** Collision-specific metrics. Traffic telemetry only consumes its aggregate snapshot. */
export class VehicleCollisionTelemetry {
  private total = 0;
  private readonly byType = typeCounters();
  private readonly bySeverity = severityCounters();
  private readonly byLod: Record<VehicleCollisionLodTier, number> = { near: 0, medium: 0 };
  private relativeSpeedSum = 0;
  private impulseSum = 0;
  private maximumImpulse = 0;
  private targetDisplacement = 0;
  private playerSpeedLoss = 0;
  private maximumAngularVelocity = 0;
  private worldClamps = 0;
  private blocked = 0;
  private duplicateSuppressions = 0;
  private cooldownSuppressions = 0;
  private damage = 0;
  private recoverySum = 0;
  private recoveryCount = 0;
  private failedRejoins = 0;
  private cpuMs = 0;
  private maximumCpuMs = 0;
  private broadphasePairs = 0;
  private narrowphaseContacts = 0;
  private droppedPairs = 0;
  private readonly relativeSamples = new Float64Array(
    VEHICLE_COLLISION.TELEMETRY_SAMPLE_CAPACITY,
  );
  private readonly impulseSamples = new Float64Array(
    VEHICLE_COLLISION.TELEMETRY_SAMPLE_CAPACITY,
  );
  private sampleCount = 0;
  private sampleCursor = 0;

  public recordCollision(input: CollisionTelemetryInput): void {
    this.total += 1;
    this.byType[input.type] += 1;
    this.bySeverity[input.severity] += 1;
    this.byLod[input.lod] += 1;
    this.relativeSpeedSum += input.relativeSpeed;
    this.impulseSum += input.impulse;
    this.maximumImpulse = Math.max(this.maximumImpulse, input.impulse);
    this.targetDisplacement += input.targetDisplacement;
    this.playerSpeedLoss += input.playerSpeedLoss;
    this.maximumAngularVelocity = Math.max(
      this.maximumAngularVelocity,
      Math.abs(input.angularVelocity),
    );
    this.damage += input.damage;
    this.relativeSamples[this.sampleCursor] = input.relativeSpeed;
    this.impulseSamples[this.sampleCursor] = input.impulse;
    this.sampleCursor = (this.sampleCursor + 1) % this.relativeSamples.length;
    this.sampleCount = Math.min(this.sampleCount + 1, this.relativeSamples.length);
  }

  public recordWorldClamp(blocked = true): void {
    this.worldClamps += 1;
    if (blocked) this.blocked += 1;
  }

  public recordDuplicateSuppression(): void {
    this.duplicateSuppressions += 1;
  }

  public recordCooldownSuppression(): void {
    this.cooldownSuppressions += 1;
  }

  public recordRecovery(durationSeconds: number, failed: boolean): void {
    if (durationSeconds > 0) {
      this.recoverySum += durationSeconds;
      this.recoveryCount += 1;
    }
    if (failed) this.failedRejoins += 1;
  }

  public recordStep(cpuMs: number, broadphasePairs: number, contacts: number, dropped: number): void {
    this.cpuMs = Math.max(0, cpuMs);
    this.maximumCpuMs = Math.max(this.maximumCpuMs, this.cpuMs);
    this.broadphasePairs += broadphasePairs;
    this.narrowphaseContacts += contacts;
    this.droppedPairs += dropped;
  }

  public snapshot(): VehicleCollisionTelemetrySnapshot {
    const byType = typeCounters();
    for (const type of COLLISION_TYPES) byType[type] = this.byType[type];
    return {
      totalVehicleCollisions: this.total,
      collisionsByType: byType,
      collisionsBySeverity: { ...this.bySeverity },
      contactsByLod: { ...this.byLod },
      averageRelativeSpeed: this.total > 0 ? this.relativeSpeedSum / this.total : 0,
      p95RelativeSpeed: percentile(
        this.relativeSamples,
        this.sampleCount,
        this.sampleCursor,
        0.95,
      ),
      averageImpulse: this.total > 0 ? this.impulseSum / this.total : 0,
      p95Impulse: percentile(this.impulseSamples, this.sampleCount, this.sampleCursor, 0.95),
      maximumImpulse: this.maximumImpulse,
      targetDisplacement: this.targetDisplacement,
      playerSpeedLoss: this.playerSpeedLoss,
      maximumAngularVelocity: this.maximumAngularVelocity,
      worldClampedImpacts: this.worldClamps,
      blockedImpacts: this.blocked,
      duplicatePairSuppressions: this.duplicateSuppressions,
      collisionCooldownSuppressions: this.cooldownSuppressions,
      collisionDamage: this.damage,
      averageImpactRecoverySeconds:
        this.recoveryCount > 0 ? this.recoverySum / this.recoveryCount : 0,
      failedLaneRejoins: this.failedRejoins,
      collisionCpuMs: this.cpuMs,
      maximumCollisionCpuMs: this.maximumCpuMs,
      broadphasePairs: this.broadphasePairs,
      narrowphaseContacts: this.narrowphaseContacts,
      droppedPairs: this.droppedPairs,
    };
  }

  public reset(): void {
    this.total = 0;
    Object.assign(this.byType, typeCounters());
    Object.assign(this.bySeverity, severityCounters());
    this.byLod.near = 0;
    this.byLod.medium = 0;
    this.relativeSpeedSum = 0;
    this.impulseSum = 0;
    this.maximumImpulse = 0;
    this.targetDisplacement = 0;
    this.playerSpeedLoss = 0;
    this.maximumAngularVelocity = 0;
    this.worldClamps = 0;
    this.blocked = 0;
    this.duplicateSuppressions = 0;
    this.cooldownSuppressions = 0;
    this.damage = 0;
    this.recoverySum = 0;
    this.recoveryCount = 0;
    this.failedRejoins = 0;
    this.cpuMs = 0;
    this.maximumCpuMs = 0;
    this.broadphasePairs = 0;
    this.narrowphaseContacts = 0;
    this.droppedPairs = 0;
    this.relativeSamples.fill(0);
    this.impulseSamples.fill(0);
    this.sampleCount = 0;
    this.sampleCursor = 0;
  }
}
