/**
 * Weapon definitions. Weapons are pure data; the {@link WeaponComponent} and
 * combat system interpret these fields at runtime.
 */

/** Stable weapon identifiers. */
export type WeaponId =
  | 'fist'
  | 'knife'
  | 'bat'
  | 'pistol'
  | 'revolver'
  | 'smg'
  | 'shotgun'
  | 'rifle'
  | 'sniper'
  | 'rocket'
  | 'grenade'
  | 'molotov';

/** Broad weapon families (affects HUD grouping and audio). */
export enum WeaponCategory {
  Melee = 'melee',
  Pistol = 'pistol',
  SMG = 'smg',
  Shotgun = 'shotgun',
  Rifle = 'rifle',
  Sniper = 'sniper',
  Heavy = 'heavy',
  Thrown = 'thrown',
}

/** What leaves the muzzle when the weapon fires. */
export type ProjectileKind = 'none' | 'bullet' | 'rocket' | 'grenade' | 'molotov';

/** A complete weapon specification. */
export interface WeaponDef {
  id: WeaponId;
  name: string;
  category: WeaponCategory;
  /** What the weapon launches ('none' resolves as a melee sweep). */
  projectile: ProjectileKind;
  /** Damage per projectile (or per melee hit). */
  damage: number;
  /** Effective range in pixels. */
  range: number;
  /** Minimum milliseconds between shots. */
  fireRateMs: number;
  /** Rounds per magazine (0 for melee / unlimited). */
  magazine: number;
  /** Maximum reserve ammunition carried outside the magazine. */
  reserveMax: number;
  /** Milliseconds a full reload takes (0 = never reloads). */
  reloadMs: number;
  /** Projectiles fired per shot (>1 = spread, e.g. shotgun). */
  pellets: number;
  /** Accuracy cone half-angle in degrees. */
  spreadDeg: number;
  /** Extra spread (degrees) added per rapid consecutive shot (bloom). */
  bloomDeg: number;
  /** Camera-kick intensity per shot (0..1). */
  recoil: number;
  /** How many targets a single bullet can pass through (0 = stops on first). */
  penetration: number;
  /** Projectile speed in px/sec (ignored for melee). */
  bulletSpeed: number;
  /** Blast radius (px) for exploding projectiles; 0 for none. */
  explosionRadius: number;
  /** Fuse time (ms) for lobbed projectiles that detonate on a timer. */
  fuseMs: number;
  /** Whether holding fire keeps shooting. */
  automatic: boolean;
  /** Whether this is a melee weapon (no projectile). */
  isMelee: boolean;
  /** Whether ejected shell casings should be spawned per shot. */
  ejectsCasings: boolean;
  /** HUD icon texture key. */
  iconKey: string;
}
