/**
 * Entity taxonomy and the damage contract used across gameplay.
 */
import type { DamageInfo, DamageResult, Faction } from './CombatTypes';

/** The concrete kinds of gameplay entity. */
export enum EntityKind {
  Player = 'player',
  Pedestrian = 'pedestrian',
  Police = 'police',
  Vehicle = 'vehicle',
  Projectile = 'projectile',
  Animal = 'animal',
  Helicopter = 'helicopter',
}

/**
 * The `setData`/`getData` key under which every gameplay sprite stores a
 * back-reference to its owning entity, so Arcade-physics collision callbacks
 * (which only receive the sprites) can reach the {@link IDamageable}.
 */
export const ENTITY_DATA_KEY = 'gameEntity';

/** Anything that can receive damage and die (characters, vehicles). */
export interface IDamageable {
  /** Unique, stable id of the owning entity. */
  readonly entityId: number;
  /** Which entity kind this is. */
  readonly entityKind: EntityKind;
  /** The damageable's allegiance. */
  readonly faction: Faction;
  /** Whether this entity has already died. */
  readonly isDead: boolean;
  /** Apply a hit; implementations handle death, effects and events. */
  applyDamage(info: DamageInfo): DamageResult;
  /** Current world position (for effects and AI). */
  readonly position: { x: number; y: number };
}

/** Runtime guard for {@link IDamageable}. */
export function isDamageable(value: unknown): value is IDamageable {
  const v = value as IDamageable | null;
  return (
    typeof v?.entityId === 'number' &&
    typeof v?.applyDamage === 'function' &&
    typeof v?.isDead === 'boolean'
  );
}
