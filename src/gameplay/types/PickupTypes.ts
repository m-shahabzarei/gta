/**
 * Pickup taxonomy shared by the pickup system, HUD and audio.
 *
 * Pickups are small world items collected by walking over them: supplies
 * (health/armor/money/ammo), whole weapons, and the hidden collectible
 * packages scattered across the city.
 */
import type { WeaponId } from './WeaponTypes';

/** Every kind of collectible world item. */
export type PickupKind = 'health' | 'armor' | 'money' | 'ammo' | 'weapon' | 'collectible';

/** A pickup waiting in the world (runtime state owned by the pickup system). */
export interface PickupSpec {
  kind: PickupKind;
  /** World position in pixels. */
  x: number;
  y: number;
  /** Health/armor points, cash amount, or rounds granted (kind-dependent). */
  amount: number;
  /** Weapon granted / topped up for `weapon` and `ammo` pickups. */
  weaponId?: WeaponId;
  /** Stable id for persistent pickups (collectibles). */
  persistentId?: string;
}
