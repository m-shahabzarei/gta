/**
 * Combat and allegiance types shared by entities, weapons and the combat system.
 */
import type { Vector2 } from '@/core/types';

/** Allegiance groups; used to decide who can damage whom. */
export enum Faction {
  Player = 'player',
  Civilian = 'civilian',
  Police = 'police',
  Neutral = 'neutral',
}

/** Categories of damage used for resistance and feedback. */
export type DamageType = 'generic' | 'bullet' | 'melee' | 'vehicle' | 'explosion' | 'fire' | 'fall';

/** Concrete mechanism that delivered the final damage. */
export type DamageSourceKind =
  'unknown' | 'weapon' | 'vehicle' | 'explosion' | 'fire' | 'collision';

/**
 * Forensic ownership chain carried with every damaging event.
 *
 * `fromPlayer` remains on {@link DamageInfo} for backwards-compatible UI
 * effects, but crime and police logic must use `playerResponsible` here. That
 * distinction prevents a nearby unrelated death from ever being credited to
 * the player.
 */
export interface DamageAttribution {
  source: DamageSourceKind;
  /** Entity that physically caused the hit, when one exists. */
  sourceId?: number;
  /** Ultimate owner of the weapon that fired/struck. */
  weaponOwnerId?: number;
  /** Vehicle involved in a collision or propagated vehicle explosion. */
  vehicleOwnerId?: number;
  /** Owner of the explosion/fire chain. */
  explosionOwnerId?: number;
  /** Driver / collider responsible for a vehicle impact. */
  collisionOwnerId?: number;
  /** Most recent entity in the damage chain that attacked the victim. */
  lastAttackerId?: number;
  /** Simulation timestamp (ms) at which the damage was dealt. */
  time: number;
  /** Whether this ownership chain is actually attributable to the player. */
  playerResponsible: boolean;
}

/** A single instance of damage delivered to an {@link IDamageable}. */
export interface DamageInfo {
  /** Hit-point damage to apply. */
  amount: number;
  /** Optional damage source category for resistance / feedback tuning. */
  type?: DamageType;
  /** Faction responsible for the damage. */
  sourceFaction: Faction;
  /** Whether the damage ultimately originated from the player. */
  fromPlayer: boolean;
  /** Full source/owner chain used for death records and crime attribution. */
  attribution?: DamageAttribution;
  /** Optional impulse to push the target (world units/sec). */
  knockback?: Vector2;
}

export type DamageIgnoreReason = 'dead' | 'invulnerable' | 'invalid' | 'resisted';

/** Exact result of one authoritative damage mutation. */
export interface DamageResult {
  readonly requested: number;
  readonly absorbedByArmor: number;
  readonly appliedToHealth: number;
  readonly health: number;
  readonly maxHealth: number;
  readonly armor: number;
  readonly maxArmor: number;
  readonly killed: boolean;
  readonly ignored: DamageIgnoreReason | null;
}

export interface PlayerVitalsSnapshot {
  readonly currentHP: number;
  readonly maxHP: number;
  readonly armor: number;
  readonly maxArmor: number;
  readonly dead: boolean;
}

/** Read-only combat telemetry for the developer overlay and runtime smoke tests. */
export interface CombatDebugSnapshot {
  readonly incomingDamage: number;
  readonly appliedDamage: number;
  readonly absorbedByArmor: number;
  readonly lastDamageSource: string;
  readonly lastTarget: string;
  readonly policeBulletDamage: number;
  readonly collisionResult: string;
  readonly activeProjectiles: number;
}

export type PlayerVitalsChangeReason =
  'spawn' | 'damage' | 'healing' | 'armor' | 'restore' | 'respawn';

/** Resolve player responsibility from the forensic record, with legacy fallback. */
export function isPlayerResponsible(info: Pick<DamageInfo, 'fromPlayer' | 'attribution'>): boolean {
  return info.attribution?.playerResponsible ?? info.fromPlayer;
}

/** Construct a defensively complete attribution record for one damage event. */
export function damageAttribution(
  source: DamageSourceKind,
  playerResponsible: boolean,
  fields: Omit<Partial<DamageAttribution>, 'source' | 'playerResponsible' | 'time'> = {},
): DamageAttribution {
  return {
    source,
    playerResponsible,
    time: Date.now(),
    ...fields,
  };
}

/**
 * Returns whether `source` is allowed to damage `target`.
 * Same-faction fire is ignored (except the neutral faction, which anyone hits).
 */
export function isHostile(source: Faction, target: Faction): boolean {
  if (source === target) return false;
  if (target === Faction.Neutral) return true;
  return true;
}
