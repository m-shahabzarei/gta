/**
 * Police pursuit helicopter.
 *
 * An airborne {@link Entity} dispatched at high wanted levels. It circles the
 * player with a smooth orbital drift, sweeps a spotlight cone beneath itself,
 * spins its rotor sprite, drops a soft ground shadow, and pours suppressive
 * fire down through the combat service on a fixed cadence. Being airborne it
 * ignores world collision entirely (its body only exists so bullets can hit
 * it) — the wanted system flags the sprite with `aerial` data so ground-level
 * run-over checks skip it.
 *
 * The helicopter is damageable (helicopters can be shot down); on destruction
 * it explodes like a vehicle and reports through the standard kill events.
 */
import Phaser from 'phaser';
import { Entity } from '@/entities/Entity';
import { HealthComponent } from '@/entities/components';
import { TextureKeys } from '@/config/AssetKeys';
import { DepthLayers } from '@/config/DepthLayers';
import { EventKeys } from '@/config/EventKeys';
import { eventBus } from '@/core/EventBus';
import {
  EntityKind,
  Faction,
  damageAttribution,
  getCombatService,
  isPlayerResponsible,
  type DamageInfo,
  type DamageResult,
  type IDamageable,
} from '@/gameplay/types';

/** Hit points of the pursuit helicopter. */
const HELI_HEALTH = 160;

/** Cruise speed (px/s) while repositioning around the player. */
const HELI_SPEED = 210;

/** Orbit radius (px) held around the player. */
const ORBIT_RADIUS = 170;

/** How fast the orbit angle advances (rad/s). */
const ORBIT_RATE = 0.35;

/** Maximum ground distance at which the crew can identify the suspect. */
export const HELICOPTER_SIGHT_RANGE = 560;

export type HelicopterState = 'deploying' | 'tracking' | 'searching' | 'downed';

/** Milliseconds between bursts. */
const FIRE_INTERVAL_MS = 1300;

/** Rounds per burst. */
const BURST_ROUNDS = 3;

/** Milliseconds between rounds within a burst. */
const BURST_GAP_MS = 110;

/** Explosion parameters when the helicopter is downed. */
const HELI_EXPLOSION_RADIUS = 110;
const HELI_EXPLOSION_DAMAGE = 55;

export class Helicopter extends Entity implements IDamageable {
  /** Discriminator for the {@link IDamageable} contract. */
  public readonly entityKind: EntityKind = EntityKind.Helicopter;

  /** Helicopters belong to the police. */
  public readonly faction: Faction = Faction.Police;

  /** Hit points; shot down at zero. */
  private readonly health: HealthComponent;

  /** Spinning rotor sprite riding on the hull. */
  private readonly rotor: Phaser.GameObjects.Image;

  /** Soft ground shadow trailing beneath the hull. */
  private readonly shadow: Phaser.GameObjects.Image;

  /** Downward spotlight cone. */
  private readonly spotlight: Phaser.GameObjects.Image;

  /** Current orbital phase around the player (radians). */
  private orbitAngle = 0;

  /** Countdown (ms) to the next burst. */
  private fireTimer = FIRE_INTERVAL_MS;

  /** Rounds remaining in the active burst. */
  private burstLeft = 0;

  /** Countdown (ms) to the next round within the active burst. */
  private burstTimer = 0;

  /** True once the helicopter has been shot down. */
  private downed = false;

  private stateValue: HelicopterState = 'deploying';
  private visualTarget: { x: number; y: number } | null = null;
  private searchCenter: { x: number; y: number } | null = null;

  constructor(scene: Phaser.Scene, x: number, y: number) {
    super(scene.physics.add.sprite(x, y, TextureKeys.Helicopter));
    this.sprite.setDepth(DepthLayers.AirUnits);
    this.sprite.setData('aerial', true);
    const body = this.sprite.body as Phaser.Physics.Arcade.Body;
    body.setSize(30, 30);
    body.setAllowGravity(false);

    this.shadow = scene.add.image(x + 14, y + 18, TextureKeys.Helicopter);
    this.shadow.setTint(0x000000);
    this.shadow.setAlpha(0.25);
    this.shadow.setDepth(DepthLayers.Shadows);

    this.spotlight = scene.add.image(x, y, TextureKeys.GlowSoft);
    this.spotlight.setBlendMode(Phaser.BlendModes.ADD);
    this.spotlight.setTint(0xfff2c8);
    this.spotlight.setAlpha(0.28);
    this.spotlight.setScale(2.6);
    this.spotlight.setDepth(DepthLayers.VehicleLights);

    this.rotor = scene.add.image(x, y, TextureKeys.HeliRotor);
    this.rotor.setDepth(DepthLayers.AirUnits + 1);

    this.health = this.addComponent(new HealthComponent(HELI_HEALTH));
  }

  /** Unique id of the owning entity (satisfies {@link IDamageable}). */
  public get entityId(): number {
    return this.id;
  }

  /** Whether the helicopter has been shot down. */
  public get isDead(): boolean {
    return this.downed;
  }

  public get state(): HelicopterState {
    return this.stateValue;
  }

  public get hasVisualContact(): boolean {
    return this.visualTarget !== null;
  }

  /** Accept a position only after command has independently confirmed line of sight. */
  public reportVisualContact(position: { x: number; y: number }): void {
    if (this.downed) return;
    this.visualTarget = { ...position };
    this.searchCenter = { ...position };
    this.stateValue = 'tracking';
  }

  /** Stop tracking exact coordinates and orbit the last confirmed position. */
  public loseVisualContact(): void {
    if (this.downed || !this.visualTarget) return;
    this.visualTarget = null;
    this.stateValue = 'searching';
    this.burstLeft = 0;
  }

  public setSearchCenter(position: { x: number; y: number } | null): void {
    if (this.downed || this.visualTarget) return;
    this.searchCenter = position ? { ...position } : null;
    this.stateValue = position ? 'searching' : 'deploying';
  }

  /** Apply a hit; shot down at zero health. */
  public applyDamage(info: DamageInfo): DamageResult {
    if (this.downed) {
      return this.health.applyDamage(info);
    }
    const result = this.health.applyDamage(info);
    if (result.ignored !== null) return result;
    this.sprite.setTintFill(0xff4040);
    this.sprite.scene.time.delayedCall(90, () => {
      if (this.sprite.active) this.sprite.clearTint();
    });
    if (this.health.isDead) {
      this.shootDown(info);
    }
    return result;
  }

  /** Orbit confirmed/search intelligence without reading the player service. */
  public override update(time: number, delta: number): void {
    super.update(time, delta);
    if (this.downed) {
      return;
    }
    const dt = delta / 1000;
    const target = this.visualTarget ?? this.searchCenter;

    if (target) {
      this.orbitAngle += ORBIT_RATE * dt;
      const desiredX = target.x + Math.cos(this.orbitAngle) * ORBIT_RADIUS;
      const desiredY = target.y + Math.sin(this.orbitAngle) * ORBIT_RADIUS;
      const dx = desiredX - this.sprite.x;
      const dy = desiredY - this.sprite.y;
      const dist = Math.hypot(dx, dy);
      const body = this.sprite.body as Phaser.Physics.Arcade.Body;
      if (dist > 6) {
        const speed = Math.min(HELI_SPEED, dist * 2.4);
        body.setVelocity((dx / dist) * speed, (dy / dist) * speed);
      } else {
        body.setVelocity(0, 0);
      }
      // Nose toward the player.
      this.sprite.rotation =
        Math.atan2(target.y - this.sprite.y, target.x - this.sprite.x) + Math.PI / 2;

      if (this.visualTarget) this.updateFire(delta, target.x, target.y);
    } else {
      (this.sprite.body as Phaser.Physics.Arcade.Body).setVelocity(0, 0);
    }

    // Rotor spin + attachments follow the hull.
    this.rotor.setPosition(this.sprite.x, this.sprite.y);
    this.rotor.rotation += 22 * dt;
    this.shadow.setPosition(this.sprite.x + 14, this.sprite.y + 20);
    this.shadow.rotation = this.sprite.rotation;
    this.spotlight.setPosition(this.sprite.x + 6, this.sprite.y + 10);
  }

  /** Advance the burst-fire cadence. */
  private updateFire(delta: number, tx: number, ty: number): void {
    if (this.burstLeft > 0) {
      this.burstTimer -= delta;
      if (this.burstTimer <= 0) {
        this.burstTimer = BURST_GAP_MS;
        this.burstLeft -= 1;
        this.fireRound(tx, ty);
      }
      return;
    }
    this.fireTimer -= delta;
    if (this.fireTimer <= 0) {
      this.fireTimer = FIRE_INTERVAL_MS;
      this.burstLeft = BURST_ROUNDS;
      this.burstTimer = 0;
    }
  }

  /** Fire a single suppressive round at the player through the combat service. */
  private fireRound(tx: number, ty: number): void {
    const combat = getCombatService();
    if (!combat) {
      return;
    }
    const angle = Math.atan2(ty - this.sprite.y, tx - this.sprite.x);
    combat.fireWeapon({
      shooterId: this.id,
      faction: Faction.Police,
      fromPlayer: false,
      attribution: damageAttribution('weapon', false, {
        sourceId: this.id,
        weaponOwnerId: this.id,
        lastAttackerId: this.id,
      }),
      weaponId: 'smg',
      originX: this.sprite.x + Math.cos(angle) * 20,
      originY: this.sprite.y + Math.sin(angle) * 20,
      angle,
      extraSpreadDeg: 4,
    });
  }

  /** Shot down: explode, announce the kill and become inert falling wreckage. */
  private shootDown(info: DamageInfo): void {
    this.downed = true;
    this.stateValue = 'downed';
    this.visualTarget = null;
    (this.sprite.body as Phaser.Physics.Arcade.Body).setVelocity(0, 0);
    getCombatService()?.spawnExplosion(
      this.sprite.x,
      this.sprite.y,
      HELI_EXPLOSION_RADIUS,
      HELI_EXPLOSION_DAMAGE,
      isPlayerResponsible(info),
      this.health.lastDamage?.attribution ?? info.attribution,
    );
    eventBus.emit(EventKeys.EntityKilled, {
      targetId: this.id,
      kind: 'helicopter',
      position: this.position,
      byPlayer: isPlayerResponsible(info),
      attribution:
        this.health.lastDamage?.attribution ??
        info.attribution ??
        damageAttribution('unknown', isPlayerResponsible(info)),
    });
  }

  /** Destroy the hull plus every attachment sprite. */
  public override destroy(): void {
    this.rotor.destroy();
    this.shadow.destroy();
    this.spotlight.destroy();
    super.destroy();
  }
}
