/**
 * Health component: tracks hit points, death and temporary invulnerability for
 * any {@link Entity}. Damage is applied through {@link DamageInfo} so that the
 * combat system can drive players, pedestrians and police uniformly.
 *
 * The component is deliberately passive: it does not know how the entity dies
 * visually (the animator handles corpses) — it only owns the numbers and fires
 * the {@link HealthComponent.onDeath} callback exactly once.
 */
import { Component } from '@/entities/Component';
import {
  damageAttribution,
  isPlayerResponsible,
  type DamageAttribution,
  type DamageInfo,
  type DamageResult,
  type DamageType,
} from '@/gameplay/types';

/** Immutable forensic snapshot retained by a damaged entity. */
export interface DamageRecord {
  amount: number;
  type: DamageType;
  sourceFaction: DamageInfo['sourceFaction'];
  attribution: DamageAttribution;
}

export class HealthComponent extends Component {
  /** Component identifier used for sibling lookups. */
  public readonly name = 'health';

  /**
   * Invoked once, the first time health reaches zero. Owners assign this to
   * trigger death handling (ragdoll, loot, respawn, wanted level, …).
   */
  public onDeath: (() => void) | null = null;

  private currentHealth: number;
  private maximumHealth: number;
  private currentArmor = 0;
  private maximumArmor = 0;
  private readonly resistances = new Map<DamageType, number>();
  private dead = false;
  private invulnerableMs = 0;
  /** Last damage that actually penetrated armour/resistance, retained for death investigation. */
  private lastDamageRecord: DamageRecord | null = null;

  /**
   * @param maxHealth Starting and maximum hit points; also the value used by
   *   {@link HealthComponent.reset} when no explicit maximum is supplied.
   */
  constructor(maxHealth: number) {
    super();
    this.maximumHealth = maxHealth;
    this.currentHealth = maxHealth;
  }

  /** Current hit points (0 when dead). */
  public get health(): number {
    return this.currentHealth;
  }

  /** Maximum hit points. */
  public get maxHealth(): number {
    return this.maximumHealth;
  }

  /** Current armor points (absorb damage before health). */
  public get armor(): number {
    return this.currentArmor;
  }

  /** Maximum armor points (0 for entities that never wear armor). */
  public get maxArmor(): number {
    return this.maximumArmor;
  }

  /** Whether the entity has died. */
  public get isDead(): boolean {
    return this.dead;
  }

  /** Full source/owner record for the most recent effective damage. */
  public get lastDamage(): DamageRecord | null {
    return this.lastDamageRecord
      ? { ...this.lastDamageRecord, attribution: { ...this.lastDamageRecord.attribution } }
      : null;
  }

  /** Whether damage is currently being ignored due to invulnerability. */
  public get isInvulnerable(): boolean {
    return this.invulnerableMs > 0;
  }

  /** Current health as a fraction of maximum health. */
  public get healthRatio(): number {
    return this.maximumHealth > 0 ? this.currentHealth / this.maximumHealth : 0;
  }

  /**
   * Apply a damage instance. Ignored while dead or invulnerable. On the first
   * transition to zero health the entity is marked dead and {@link onDeath} is
   * called exactly once.
   *
   * @param info Damage payload; only `amount` affects hit points here.
   */
  public applyDamage(info: DamageInfo): DamageResult {
    const requested = Number.isFinite(info.amount) ? Math.max(0, info.amount) : 0;
    if (requested <= 0) return this.damageResult(0, 0, 0, 'invalid');
    if (this.dead) return this.damageResult(requested, 0, 0, 'dead');
    if (this.invulnerableMs > 0) {
      return this.damageResult(requested, 0, 0, 'invulnerable');
    }
    const type = info.type ?? 'generic';
    // Armor soaks damage first; whatever it cannot absorb reaches health.
    let amount = requested;
    let absorbedByArmor = 0;
    if (this.currentArmor > 0) {
      const absorbed = Math.min(this.currentArmor, amount);
      this.currentArmor -= absorbed;
      amount -= absorbed;
      absorbedByArmor = absorbed;
    }
    if (amount <= 0) {
      return this.damageResult(requested, absorbedByArmor, 0, null);
    }
    const resistance = this.clampResistance(this.resistances.get(type) ?? 0);
    amount *= 1 - resistance;
    if (amount <= 0) {
      return this.damageResult(
        requested,
        absorbedByArmor,
        0,
        absorbedByArmor > 0 ? null : 'resisted',
      );
    }
    const appliedToHealth = Math.min(this.currentHealth, amount);
    this.lastDamageRecord = {
      amount: appliedToHealth,
      type,
      sourceFaction: info.sourceFaction,
      attribution: {
        ...(info.attribution ?? damageAttribution('unknown', isPlayerResponsible(info))),
      },
    };
    this.currentHealth -= amount;
    if (this.currentHealth <= 0) {
      this.currentHealth = 0;
      this.dead = true;
      const cb = this.onDeath;
      if (cb) {
        cb();
      }
    }
    return this.damageResult(requested, absorbedByArmor, appliedToHealth, null);
  }

  /**
   * Restore hit points, clamped to {@link maxHealth}. No effect while dead.
   *
   * @param amount Hit points to add (negative values are ignored).
   */
  public heal(amount: number): void {
    if (this.dead || !Number.isFinite(amount) || amount <= 0) {
      return;
    }
    this.currentHealth = Math.min(this.maximumHealth, this.currentHealth + amount);
  }

  /**
   * Grant temporary invulnerability. Extends (does not shorten) any existing
   * window so overlapping grants behave intuitively.
   *
   * @param ms Duration in milliseconds.
   */
  public setInvulnerable(ms: number): void {
    if (ms > this.invulnerableMs) {
      this.invulnerableMs = ms;
    }
  }

  /**
   * Configure the armor pool. Raises the cap when needed and clamps the
   * current value into [0, maxArmor]. No effect while dead.
   *
   * @param amount Armor points to set.
   * @param maxArmor Optional new maximum; defaults to the larger of the
   *   current maximum and `amount`.
   */
  public setArmor(amount: number, maxArmor?: number): void {
    if (this.dead) {
      return;
    }
    const safeAmount = Number.isFinite(amount) ? amount : 0;
    const safeMaximum = Number.isFinite(maxArmor)
      ? (maxArmor as number)
      : Math.max(this.maximumArmor, safeAmount);
    this.maximumArmor = Math.max(0, safeMaximum);
    this.currentArmor = Math.max(0, Math.min(this.maximumArmor, safeAmount));
  }

  /**
   * Add armor points, clamped to the maximum.
   * @param amount Armor points to add (negative values are ignored).
   */
  public addArmor(amount: number): void {
    if (this.dead || !Number.isFinite(amount) || amount <= 0) {
      return;
    }
    this.currentArmor = Math.min(this.maximumArmor, this.currentArmor + amount);
  }

  /** Set a resistance value for one damage type. */
  public setResistance(type: DamageType, amount: number): void {
    this.resistances.set(type, this.clampResistance(amount));
  }

  /** Clear all resistances or one specific damage type. */
  public clearResistance(type?: DamageType): void {
    if (type === undefined) {
      this.resistances.clear();
    } else {
      this.resistances.delete(type);
    }
  }

  /**
   * Revive and refill the entity, clearing death and invulnerability state.
   *
   * @param maxHealth Optional new maximum; defaults to the current maximum.
   */
  public reset(maxHealth?: number): void {
    if (maxHealth !== undefined && Number.isFinite(maxHealth) && maxHealth > 0) {
      this.maximumHealth = maxHealth;
    }
    this.currentHealth = this.maximumHealth;
    this.currentArmor = 0;
    this.dead = false;
    this.invulnerableMs = 0;
    this.lastDamageRecord = null;
  }

  /** Restore a persisted health/armor snapshot without synthesizing damage. */
  public restore(health: number, armor = 0): void {
    const safeHealth = Number.isFinite(health) ? health : this.maximumHealth;
    const safeArmor = Number.isFinite(armor) ? armor : 0;
    this.currentHealth = Math.max(0, Math.min(this.maximumHealth, safeHealth));
    this.currentArmor = Math.max(0, Math.min(this.maximumArmor, safeArmor));
    this.dead = this.currentHealth <= 0;
    this.invulnerableMs = 0;
    this.lastDamageRecord = null;
  }

  /**
   * Tick the invulnerability timer down.
   *
   * @param _time Absolute scene time (unused).
   * @param delta Milliseconds since the previous frame.
   */
  public override update(_time: number, delta: number): void {
    if (this.invulnerableMs > 0) {
      this.invulnerableMs -= delta;
      if (this.invulnerableMs < 0) {
        this.invulnerableMs = 0;
      }
    }
  }

  /** Clamp resistance to a sane, non-immune range. */
  private clampResistance(amount: number): number {
    if (!Number.isFinite(amount)) return 0;
    return Math.max(0, Math.min(0.85, amount));
  }

  private damageResult(
    requested: number,
    absorbedByArmor: number,
    appliedToHealth: number,
    ignored: DamageResult['ignored'],
  ): DamageResult {
    return {
      requested,
      absorbedByArmor,
      appliedToHealth,
      health: this.currentHealth,
      maxHealth: this.maximumHealth,
      armor: this.currentArmor,
      maxArmor: this.maximumArmor,
      killed: this.dead,
      ignored,
    };
  }
}
