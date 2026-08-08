/**
 * Weapon component: owns the currently-equipped {@link WeaponDef} and turns fire
 * requests into calls on the {@link ICombatService}. It manages the per-shot
 * cooldown, spread bloom, the reload timer and a pair of optional gates;
 * ammunition bookkeeping, aiming and projectile simulation live elsewhere
 * (inventory, controllers, combat system).
 *
 * Two ammunition modes are supported:
 *  - **Gated** (the player): {@link setGates}/{@link setReloadGates} route ammo
 *    checks and reload transfers through the inventory component.
 *  - **Self-managed** (NPCs): with no gates installed the component tracks its
 *    own magazine from the weapon definition and automatically pauses to
 *    reload when it runs dry, so police fire in realistic bursts.
 *
 * The component is faction-aware so that the same code drives the player,
 * police and any armed civilian: it stamps every {@link WeaponFireRequest}
 * with the host entity id, faction and player-origin flag the combat system
 * needs to resolve hits and damage allegiance.
 */
import { Component } from '@/entities/Component';
import {
  damageAttribution,
  getCombatService,
  type Faction,
  type WeaponDef,
  type ICombatService,
} from '@/gameplay/types';
import { eventBus } from '@/core/EventBus';
import { EventKeys } from '@/config/EventKeys';
import type { CharacterAnimatorComponent } from './CharacterAnimatorComponent';

/** How quickly accumulated spread bloom decays, in degrees per second. */
const BLOOM_DECAY_DEG_PER_SEC = 6;

/** Maximum accumulated bloom, in degrees. */
const BLOOM_MAX_DEG = 7;

export class WeaponComponent extends Component {
  /** Component identifier used for sibling lookups. */
  public readonly name = 'weapon';

  /** Muzzle offset (px) ahead of the entity origin along the aim angle. */
  private static readonly MUZZLE_OFFSET = 14;

  private readonly faction: Faction;
  private readonly fromPlayer: boolean;

  private equipped: WeaponDef | null = null;
  private cooldownMs = 0;

  /** Remaining reload time (ms); > 0 means a reload is in progress. */
  private reloadRemainingMs = 0;

  /** Accumulated spread bloom in degrees (grows per shot, decays over time). */
  private bloom = 0;

  /** Self-managed magazine for NPC weapons (no external gates). */
  private internalMag = 0;

  private canFireGate: (() => boolean) | null = null;
  private onFiredGate: (() => void) | null = null;
  private canReloadGate: (() => boolean) | null = null;
  private onReloadCompleteGate: (() => void) | null = null;

  private combat: ICombatService | null = null;

  /**
   * @param faction Allegiance stamped onto every fire request from this weapon.
   * @param fromPlayer Whether shots ultimately originate from the player (used by
   *   the combat system for wanted level and friendly-fire rules).
   */
  constructor(faction: Faction, fromPlayer: boolean) {
    super();
    this.faction = faction;
    this.fromPlayer = fromPlayer;
  }

  /** The currently-equipped weapon, or `null` when unarmed. */
  public get weapon(): WeaponDef | null {
    return this.equipped;
  }

  /** Whether a reload is currently in progress. */
  public get isReloading(): boolean {
    return this.reloadRemainingMs > 0;
  }

  /** Reload completion in [0, 1] (1 when idle). */
  public get reloadProgress(): number {
    const def = this.equipped;
    if (!def || def.reloadMs <= 0 || this.reloadRemainingMs <= 0) return 1;
    return 1 - this.reloadRemainingMs / def.reloadMs;
  }

  /**
   * Equip a weapon definition. Equipping always clears any pending cooldown,
   * reload and bloom so the new weapon is immediately ready to fire.
   *
   * @param def Weapon to equip.
   */
  public equip(def: WeaponDef): void {
    const wasReloading = this.isReloading;
    this.equipped = def;
    this.cooldownMs = 0;
    this.reloadRemainingMs = 0;
    this.bloom = 0;
    this.internalMag = def.magazine;
    if (wasReloading) {
      this.animator()?.setReloading(false);
    }
  }

  /**
   * Install optional gates around firing.
   *
   * @param canFire Predicate consulted before each shot; when it returns `false`
   *   the shot is suppressed. Pass `null` to always allow firing.
   * @param onFired Callback invoked immediately after a successful shot (e.g. to
   *   consume ammunition). Pass `null` to clear it.
   */
  public setGates(canFire: (() => boolean) | null, onFired: (() => void) | null): void {
    this.canFireGate = canFire;
    this.onFiredGate = onFired;
  }

  /**
   * Install optional gates around reloading (the player's inventory transfer).
   *
   * @param canReload Predicate: whether a reload would move any rounds.
   * @param onComplete Callback invoked when the reload timer elapses.
   */
  public setReloadGates(canReload: (() => boolean) | null, onComplete: (() => void) | null): void {
    this.canReloadGate = canReload;
    this.onReloadCompleteGate = onComplete;
  }

  /**
   * Begin a reload if one is possible and none is already running.
   * @returns Whether a reload was started.
   */
  public startReload(): boolean {
    const def = this.equipped;
    if (!def || def.isMelee || def.reloadMs <= 0 || this.isReloading) {
      return false;
    }
    if (this.canReloadGate) {
      if (!this.canReloadGate()) return false;
    } else if (this.internalMag >= def.magazine) {
      return false;
    }
    this.reloadRemainingMs = def.reloadMs;
    this.animator()?.setReloading(true);
    if (this.fromPlayer) {
      eventBus.emit(EventKeys.WeaponReloadStarted, {
        weaponId: def.id,
        durationMs: def.reloadMs,
      });
    }
    return true;
  }

  /**
   * Attempt to fire along the given angle.
   *
   * Returns `false` — without side effects — when unarmed, still on cooldown,
   * reloading, or the {@link setGates} predicate rejects the shot (an empty
   * magazine also auto-starts a reload when possible). Otherwise the combat
   * service is asked to fire from a muzzle point just ahead of the entity, the
   * cooldown/bloom are armed and the on-fired gate is invoked.
   *
   * @param angle Aim angle in radians (0 = +x / east).
   * @returns Whether a shot was actually dispatched to the combat service.
   */
  public tryFire(angle: number): boolean {
    const def = this.equipped;
    if (!def || this.cooldownMs > 0 || this.isReloading) {
      return false;
    }

    if (this.canFireGate) {
      if (!this.canFireGate()) {
        // Player-style path: an empty magazine flows straight into a reload.
        this.startReload();
        return false;
      }
    } else if (!def.isMelee && def.magazine > 0 && this.internalMag <= 0) {
      // Self-managed path: pause to reload, then resume firing.
      this.startReload();
      return false;
    }

    const combat = this.resolveCombat();
    this.cooldownMs = def.fireRateMs;
    if (!combat) {
      return false;
    }

    const pos = this.entity.position;
    const originX = pos.x + Math.cos(angle) * WeaponComponent.MUZZLE_OFFSET;
    const originY = pos.y + Math.sin(angle) * WeaponComponent.MUZZLE_OFFSET;

    combat.fireWeapon({
      shooterId: this.entity.id,
      faction: this.faction,
      fromPlayer: this.fromPlayer,
      attribution: damageAttribution('weapon', this.fromPlayer, {
        sourceId: this.entity.id,
        weaponOwnerId: this.entity.id,
        lastAttackerId: this.entity.id,
      }),
      weaponId: def.id,
      originX,
      originY,
      angle,
      extraSpreadDeg: this.bloom,
    });

    this.bloom = Math.min(BLOOM_MAX_DEG, this.bloom + def.bloomDeg);
    if (!this.canFireGate && !def.isMelee && def.magazine > 0) {
      this.internalMag -= 1;
    }
    if (this.onFiredGate) {
      this.onFiredGate();
    }
    this.animator()?.triggerShoot();
    return true;
  }

  /**
   * Tick the fire cooldown, the reload timer and the bloom decay.
   *
   * @param _time Absolute scene time (unused).
   * @param delta Milliseconds since the previous frame.
   */
  public override update(_time: number, delta: number): void {
    if (this.cooldownMs > 0) {
      this.cooldownMs = Math.max(0, this.cooldownMs - delta);
    }
    if (this.bloom > 0) {
      this.bloom = Math.max(0, this.bloom - (delta / 1000) * BLOOM_DECAY_DEG_PER_SEC);
    }
    if (this.reloadRemainingMs > 0) {
      this.reloadRemainingMs -= delta;
      if (this.reloadRemainingMs <= 0) {
        this.reloadRemainingMs = 0;
        this.finishReload();
      }
    }
  }

  /** Complete a reload: transfer rounds and notify listeners. */
  private finishReload(): void {
    const def = this.equipped;
    if (!def) return;
    if (this.onReloadCompleteGate) {
      this.onReloadCompleteGate();
    } else {
      this.internalMag = def.magazine;
    }
    this.animator()?.setReloading(false);
    if (this.fromPlayer) {
      eventBus.emit(EventKeys.WeaponReloadFinished, { weaponId: def.id });
    }
  }

  /** Resolve and cache the combat service on first successful lookup. */
  private resolveCombat(): ICombatService | null {
    if (!this.combat) {
      this.combat = getCombatService();
    }
    return this.combat;
  }

  /** The sibling animator, if the host entity has one. */
  private animator(): CharacterAnimatorComponent | null {
    return this.entity.getComponent<CharacterAnimatorComponent>('animator') ?? null;
  }
}
