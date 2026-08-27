/**
 * Vehicle entity: a driveable, damageable car built on the {@link Entity} base.
 *
 * A vehicle binds an Arcade sprite to a {@link VehicleMovementComponent} (arcade
 * car physics), a {@link HealthComponent} (hit points), a
 * {@link VehicleLightsComponent} (head/brake/indicator lights) and a
 * {@link VehicleEffectsComponent} (damage smoke, skid marks, suspension squash).
 * It implements {@link IDamageable} so the combat system can damage it uniformly
 * with characters, and it manages its own destruction: once health reaches zero
 * it spawns an explosion through the combat service, swaps to its wrecked look,
 * and disables its controls. Both the player controller and the traffic AI drive
 * a vehicle by resolving its movement component; the entity itself only tracks
 * who (if anyone) is behind the wheel.
 *
 * Hard impacts detected by the movement component are translated here into
 * crash damage plus a {@link EventKeys.VehicleCollision} event for audio/shake.
 */
import type Phaser from 'phaser';
import { Entity } from '@/entities/Entity';
import {
  HealthComponent,
  VehicleEffectsComponent,
  VehicleLightsComponent,
  VehicleMovementComponent,
} from '@/entities/components';
import { DepthLayers } from '@/config/DepthLayers';
import { EventKeys } from '@/config/EventKeys';
import { VEHICLE } from '@/config/Constants';
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
  type VehicleDef,
} from '@/gameplay/types';

/** Frame names the vehicle texture factory registers on every vehicle sheet. */
const FRAME_OK = 'ok';
const FRAME_DAMAGED = 'damaged';
const CRASH_COOLDOWN_MS = 320;

export class Vehicle extends Entity implements IDamageable {
  /** Discriminator for the {@link IDamageable} contract. */
  public readonly entityKind: EntityKind = EntityKind.Vehicle;

  /** Vehicles are neutral: anyone may damage them. */
  public readonly faction: Faction = Faction.Neutral;

  /** Static specification (dimensions, speed, health) for this vehicle. */
  private readonly definition: VehicleDef;

  /** Locomotion component driving the Arcade body and sprite rotation. */
  private readonly movementComp: VehicleMovementComponent;

  /** Hit-point component; drives the destruction transition. */
  private readonly health: HealthComponent;

  /** True once the vehicle has exploded and become an inert wreck. */
  private destroyed = false;

  /** Whether the player is currently the driver. */
  private playerDriven = false;

  /** Entity id of the current driver, or `null` when unoccupied. */
  private currentDriverId: number | null = null;

  /** Whether the damaged body frame has been applied. */
  private showingDamage = false;

  /** Last scene time at which this vehicle processed crash damage/audio. */
  private lastCrashAt = -Infinity;

  private readonly lights: VehicleLightsComponent;
  private readonly effects: VehicleEffectsComponent;

  /**
   * @param scene Owning scene (supplies the Arcade physics factory).
   * @param x Initial world x in pixels.
   * @param y Initial world y in pixels.
   * @param def Vehicle definition (texture, dimensions, health, tuning).
   * @param tint Optional palette tint applied to the sprite.
   */
  constructor(scene: Phaser.Scene, x: number, y: number, def: VehicleDef, tint?: number) {
    super(scene.physics.add.sprite(x, y, def.textureKey));
    this.definition = def;

    this.sprite.setDepth(DepthLayers.Vehicles);
    this.sprite.setCollideWorldBounds(true);
    if (this.sprite.texture.has(FRAME_OK)) {
      this.sprite.setFrame(FRAME_OK);
    }
    const body = this.sprite.body as Phaser.Physics.Arcade.Body;
    body.setSize(def.width, def.height);
    if (tint !== undefined) {
      this.sprite.setTint(tint);
    }

    this.movementComp = this.addComponent(new VehicleMovementComponent(def));
    this.health = this.addComponent(new HealthComponent(def.maxHealth));
    this.lights = this.addComponent(new VehicleLightsComponent(def));
    this.effects = this.addComponent(new VehicleEffectsComponent(def));
  }

  /** Unique id of the owning entity (satisfies {@link IDamageable}). */
  public get entityId(): number {
    return this.id;
  }

  /** Whether the vehicle has been destroyed (satisfies {@link IDamageable}). */
  public get isDead(): boolean {
    return this.destroyed;
  }

  /** The vehicle's static definition. */
  public get def(): VehicleDef {
    return this.definition;
  }

  /** Locomotion component (throttle/steer/brake). */
  public get movement(): VehicleMovementComponent {
    return this.movementComp;
  }

  /** Health component (for HUD ratio and repair services). */
  public get healthComp(): HealthComponent {
    return this.health;
  }

  /** Whether the vehicle has exploded and become a wreck. */
  public get isDestroyed(): boolean {
    return this.destroyed;
  }

  /** Whether the player is currently driving this vehicle. */
  public get isPlayerDriven(): boolean {
    return this.playerDriven;
  }

  /** Entity id of the current driver, or `null` when unoccupied. */
  public get driverId(): number | null {
    return this.currentDriverId;
  }

  /** Spawn generation qualifies collision pair identity across pool reuse. */
  public get poolGeneration(): number {
    return this.movementComp.dynamics.poolGeneration;
  }

  /**
   * Apply a hit. Ignored once destroyed. Emits a damage event, updates the
   * damage frame, and on the transition to zero health triggers {@link explode}.
   * @param info Damage payload.
   */
  public applyDamage(info: DamageInfo): DamageResult {
    if (this.destroyed) {
      return this.health.applyDamage(info);
    }
    const result = this.health.applyDamage(info);
    if (result.ignored !== null) return result;
    eventBus.emit(EventKeys.VehicleDamaged, {
      vehicleId: this.id,
      health: this.health.health,
      maxHealth: this.health.maxHealth,
    });
    this.refreshDamageFrame();
    if (this.health.isDead) {
      this.explode(info);
    }
    return result;
  }

  /**
   * Puncture the tires (spike strip): top speed is capped until repaired.
   */
  public punctureTires(): void {
    this.movementComp.setTireFactor(0.45);
  }

  /**
   * Full mechanical repair (gas-station service): restores health, tires and
   * the pristine body frame. Wrecks cannot be repaired.
   * @returns Whether the repair was applied.
   */
  public repair(): boolean {
    if (this.destroyed) {
      return false;
    }
    this.health.reset();
    this.movementComp.setTireFactor(1);
    this.showingDamage = false;
    if (this.sprite.texture.has(FRAME_OK)) {
      this.sprite.setFrame(FRAME_OK);
    }
    eventBus.emit(EventKeys.VehicleDamaged, {
      vehicleId: this.id,
      health: this.health.health,
      maxHealth: this.health.maxHealth,
    });
    return true;
  }

  /**
   * Flag the vehicle as player-driven and update its controls accordingly.
   * Destroyed wrecks never re-enable their controls.
   * @param driven Whether the player is now behind the wheel.
   */
  public setPlayerDriven(driven: boolean): void {
    this.playerDriven = driven;
    this.sprite.setData('playerDriven', driven);
    if (driven) this.movementComp.setTrafficAuthority(false);
    this.movementComp.setPlayerDynamic(driven);
    this.movementComp.setControlsEnabled(driven && !this.destroyed);
  }

  /**
   * Record the current driver's entity id (or clear it when unoccupied).
   * @param id Driver entity id, or `null` when the vehicle is empty.
   */
  public setDriverId(id: number | null): void {
    this.currentDriverId = id;
  }

  public resetForReuse(x: number, y: number, heading: number, tint?: number): void {
    this.destroyed = false;
    this.playerDriven = false;
    this.currentDriverId = null;
    this.showingDamage = false;
    this.lastCrashAt = -Infinity;
    const sprite = this.sprite;
    sprite
      .setPosition(x, y)
      .setActive(true)
      .setVisible(true)
      .setAlpha(1)
      .setScale(1)
      .setRotation(heading + Math.PI / 2)
      .clearTint();
    if (tint !== undefined) sprite.setTint(tint);
    if (sprite.texture.has(FRAME_OK)) sprite.setFrame(FRAME_OK);
    this.clearLifecycleMetadata();
    sprite.setData('playerDriven', false);
    this.health.reset();
    this.movementComp.reset(heading, true);
    this.lights.reset();
    this.effects.reset();
    const body = sprite.body as Phaser.Physics.Arcade.Body;
    body.enable = true;
    body.reset(x, y);
  }

  public deactivateForPool(): void {
    this.movementComp.reset(this.movementComp.heading);
    this.movementComp.setPhysicalMode('Disabled');
    this.lights.reset();
    this.effects.reset();
    this.clearLifecycleMetadata();
    const body = this.sprite.body as Phaser.Physics.Arcade.Body;
    body.enable = false;
    this.sprite.setActive(false).setVisible(false);
  }

  /** Advance the vehicle's components, then translate impacts into damage. */
  public override update(time: number, delta: number): void {
    super.update(time, delta);

    const impact = this.movementComp.consumeCrash();
    if (impact > 0 && !this.destroyed && time - this.lastCrashAt >= CRASH_COOLDOWN_MS) {
      this.lastCrashAt = time;
      const damage = (impact - VEHICLE.CRASH_MIN_SPEED * 0.6) * VEHICLE.CRASH_DAMAGE_SCALE;
      eventBus.emit(EventKeys.VehicleCollision, {
        x: this.sprite.x,
        y: this.sprite.y,
        intensity: Math.min(1, impact / 500),
        byPlayer: this.playerDriven,
        vehicleId: this.id,
        relativeSpeed: impact,
        collisionType: 'world',
        playerResponsible: this.playerDriven,
        solverSource: 'arcade-world',
      });
      if (damage > 0) {
        this.applyDamage({
          amount: damage,
          type: 'vehicle',
          sourceFaction: Faction.Neutral,
          fromPlayer: this.playerDriven,
          attribution: damageAttribution('collision', this.playerDriven, {
            sourceId: this.id,
            vehicleOwnerId: this.id,
            collisionOwnerId: this.currentDriverId ?? this.id,
            lastAttackerId: this.currentDriverId ?? this.id,
          }),
        });
      }
    }
  }

  /** Swap to the damaged body frame once health drops far enough. */
  private refreshDamageFrame(): void {
    if (this.showingDamage || this.health.maxHealth <= 0) {
      return;
    }
    const ratio = this.health.health / this.health.maxHealth;
    if (ratio <= VEHICLE.DAMAGED_FRAME_RATIO && this.sprite.texture.has(FRAME_DAMAGED)) {
      this.sprite.setFrame(FRAME_DAMAGED);
      this.showingDamage = true;
    }
  }

  /**
   * Destroy the vehicle: spawn a damaging explosion, announce the wreck, char
   * the sprite, and cut its controls.
   *
   * The `destroyed` flag is set FIRST so the explosion's own radial damage
   * (which reaches this very vehicle) can never re-enter this method.
   * @param info The destroying damage's full source/ownership chain.
   */
  private explode(info: DamageInfo): void {
    this.destroyed = true;
    if (this.sprite.texture.has(FRAME_DAMAGED)) {
      this.sprite.setFrame(FRAME_DAMAGED);
    }
    this.sprite.setTint(0x333333);
    this.movementComp.setControlsEnabled(false);
    this.movementComp.setPhysicalMode('Disabled');

    getCombatService()?.spawnExplosion(
      this.sprite.x,
      this.sprite.y,
      VEHICLE.EXPLOSION_RADIUS,
      VEHICLE.EXPLOSION_DAMAGE,
      isPlayerResponsible(info),
      this.health.lastDamage?.attribution ?? info.attribution,
    );
    eventBus.emit(EventKeys.VehicleDestroyed, {
      vehicleId: this.id,
      position: { x: this.sprite.x, y: this.sprite.y },
      byPlayer: isPlayerResponsible(info),
    });
  }

  /** Clear every ownership key that may outlive an entity when its sprite is pooled. */
  private clearLifecycleMetadata(): void {
    const data = this.sprite.data;
    if (!data) return;
    for (const key of [
      'parked',
      'parkingSpaceId',
      'majorBuildingId',
      'serviceParking',
      'persistentTransitService',
      'transitServiceKind',
      'transitRouteId',
      'intercityService',
      'policeResponseActive',
      'snappBookingId',
      'serviceLivery',
      'stolenByPlayer',
      'missionId',
      'missionVehicle',
      'missionOwnerId',
      'bookingId',
      'physicalOwnerId',
      'poolClass',
    ]) {
      data.remove(key);
    }
  }
}
