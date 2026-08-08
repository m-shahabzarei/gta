/**
 * CombatSystem — the authority for every hit, bullet, explosion and fire in
 * the world.
 *
 * It owns the recycled projectile pool and the physics group every live
 * projectile belongs to, resolves weapon fire (melee sweeps, bullet pellets,
 * rockets and thrown explosives), detonates explosions that damage everything
 * nearby, burns fire zones that cook anything standing in them, and paints the
 * impact feedback — muzzle flashes, shell casings, blood decals, sparks,
 * player hit-markers and camera recoil. Other systems reach it purely through
 * the narrow {@link ICombatService} interface, so weapons and vehicles trigger
 * combat without ever importing this class.
 *
 * Collision resolution lives here too: the gameplay scene wires its
 * projectile, world and run-over overlaps to the public `handle*` methods,
 * which read the {@link Projectile} / {@link IDamageable} back-references off
 * the colliding sprites and apply damage with the same hostility, self-hit and
 * penetration rules as direct fire.
 */
import Phaser from 'phaser';
import { BaseSceneManager } from '@/core/BaseSceneManager';
import { ServiceLocator } from '@/core/ServiceLocator';
import { ServiceKeys } from '@/config/ServiceKeys';
import { EventKeys } from '@/config/EventKeys';
import { TextureKeys } from '@/config/AssetKeys';
import { DepthLayers } from '@/config/DepthLayers';
import { COMBAT } from '@/config/Constants';
import { Pool, random } from '@/utils';
import { Projectile } from '@/entities/Projectile';
import type { ProjectileEndReason } from '@/entities/Projectile';
import { Vehicle } from '@/entities/Vehicle';
import { WEAPONS } from '@/data';
import type { ParticleManager } from '@/managers/ParticleManager';
import { EntityCategory, type EntityManager } from '@/systems/EntityManager';
import {
  ENTITY_DATA_KEY,
  damageAttribution,
  EntityKind,
  Faction,
  isDamageable,
  isHostile,
  isPlayerResponsible,
  type DamageAttribution,
  type CombatDebugSnapshot,
  type DamageInfo,
  type DamageResult,
  type ICombatService,
  type IDamageable,
  type WeaponDef,
  type WeaponFireRequest,
} from '@/gameplay/types';

/** `setData`/`getData` key a bullet sprite stores its {@link Projectile} under. */
const PROJECTILE_DATA_KEY = 'projectile';

/** Bullets pre-allocated when the pool is first built. */
const POOL_INITIAL = 16;

/** Frontal half-angle (radians) inside which a melee swing can connect. */
const MELEE_CONE_HALF_ANGLE = Phaser.Math.DegToRad(70);

/** Lifetime (ms) of the muzzle-flash sprite. */
const MUZZLE_FLASH_MS = 70;

/** Lifetime (ms) of the expanding explosion sprite. */
const EXPLOSION_TWEEN_MS = 420;

/** Lifetime (ms) of a wall-impact spark sprite. */
const SPARK_MS = 150;

/** Fraction of a blood decal's life after which it begins to fade out. */
const BLOOD_FADE_START = 0.65;

/** Minimum absolute vehicle speed (px/sec) that makes a run-over lethal. */
const RUN_OVER_MIN_SPEED = 90;

/** Hit-point damage a run-over inflicts on a pedestrian. */
const RUN_OVER_DAMAGE = 26;

/** Camera-shake parameters emitted when an explosion goes off. */
const EXPLOSION_SHAKE = { durationMs: 260, intensity: 0.012 } as const;

/** How long (ms) a spent casing lies around before fading away. */
const CASING_LIFETIME_MS = 5000;

/** Maximum live casing decals (oldest destroyed first). */
const MAX_CASINGS = 48;

/** Fire-zone burn duration (ms). */
const FIRE_ZONE_MS = 6500;

/** Interval (ms) between fire-zone damage ticks. */
const FIRE_TICK_MS = 420;

/** Damage per fire-zone tick. */
const FIRE_TICK_DAMAGE = 6;

/** A live blood decal tracked so it can be faded and reaped over time. */
interface BloodDecal {
  /** The decal image on the shadow layer. */
  image: Phaser.GameObjects.Image;
  /** Scene time (ms) at which the decal was spawned. */
  born: number;
}

/** A burning ground patch that damages anything standing in it. */
interface FireZone {
  x: number;
  y: number;
  radius: number;
  fromPlayer: boolean;
  attribution: DamageAttribution;
  /** Scene time (ms) at which the fire dies out. */
  expiresAt: number;
  /** Scene time (ms) of the next damage tick. */
  nextTickAt: number;
  /** Flame + glow images owned by the zone. */
  sprites: Phaser.GameObjects.Image[];
}

interface DamageDeliveryContext {
  readonly collision: string;
  readonly blood: boolean;
  readonly confirmPlayerHit: boolean;
}

export class CombatSystem extends BaseSceneManager implements ICombatService {
  /** Service-locator key for this system. */
  public readonly key = ServiceKeys.Combat;

  /** Physics group holding every projectile sprite; created per scene attach. */
  private bullets: Phaser.Physics.Arcade.Group | null = null;

  /** Recycling pool of projectile wrappers; created per scene attach. */
  private pool: Pool<Projectile> | null = null;

  /** Projectiles currently in flight, ticked each frame for range/lifespan. */
  private readonly activeBullets: Projectile[] = [];

  /** Every pooled projectile wrapper, including currently idle instances. */
  private readonly allProjectiles: Projectile[] = [];

  /** Fading blood decals, reaped once they exceed their lifespan. */
  private readonly bloodDecals: BloodDecal[] = [];

  /** Spent shell casings on the ground (FIFO-capped). */
  private readonly casings: Phaser.GameObjects.Image[] = [];

  /** Burning ground patches. */
  private readonly fireZones: FireZone[] = [];

  /** Optional particle manager for muzzle/blood/spark bursts. */
  private particles: ParticleManager | null = null;

  /** Latest scene time (ms), captured each update for decal ageing. */
  private elapsed = 0;

  private combatDebug: Omit<CombatDebugSnapshot, 'activeProjectiles'> = {
    incomingDamage: 0,
    appliedDamage: 0,
    absorbedByArmor: 0,
    lastDamageSource: 'none',
    lastTarget: 'none',
    policeBulletDamage: WEAPONS.pistol.damage,
    collisionResult: 'none',
  };

  /** No game-level resources: everything is scene-scoped. */
  protected onInit(): void {}

  /** Build the bullet group, projectile pool and resolve the particle manager. */
  protected onAttach(scene: Phaser.Scene): void {
    this.bullets = scene.physics.add.group();
    this.pool = new Pool<Projectile>(
      () => {
        const projectile = new Projectile(scene);
        this.allProjectiles.push(projectile);
        const update = (time: number, delta: number): void => projectile.update(time, delta);
        this.resolveEntityManager()?.register(projectile, {
          category: EntityCategory.Projectile,
          // Pooled projectiles are registered while parked at (0, 0). They must
          // enter the scheduler immediately after a distant launch so range,
          // fuse, physics, and recycling continue independently of stale LOD data.
          alwaysActive: true,
          updateFull: update,
          updateMovement: update,
          updateSimple: update,
          updateVeryFar: update,
          canRender: () => projectile.isActive,
          canSimulatePhysics: () => projectile.isActive,
        });
        return projectile;
      },
      (p) => p.deactivate(),
      POOL_INITIAL,
    );
    this.particles = ServiceLocator.tryResolve<ParticleManager>(ServiceKeys.Particle);
    this.elapsed = 0;
    this.resetDebugTelemetry();
  }

  /** Release every scene-scoped object when leaving the scene. */
  protected override onDetach(_scene: Phaser.Scene): void {
    for (const decal of this.bloodDecals) this.releaseEffectImage(decal.image);
    this.bloodDecals.length = 0;
    for (const casing of this.casings) this.releaseEffectImage(casing);
    this.casings.length = 0;
    for (const zone of this.fireZones) this.killFireZone(zone, true);
    this.fireZones.length = 0;
    this.activeBullets.length = 0;
    for (const projectile of this.allProjectiles) {
      this.resolveEntityManager()?.unregister(projectile);
    }
    this.allProjectiles.length = 0;
    this.pool = null;
    this.bullets?.destroy(true);
    this.bullets = null;
    this.particles = null;
    this.elapsed = 0;
    this.resetDebugTelemetry();
  }

  /** The physics group containing every live projectile sprite. */
  public get bulletGroup(): Phaser.Physics.Arcade.Group {
    if (!this.bullets) {
      throw new Error('CombatSystem.bulletGroup accessed before attach.');
    }
    return this.bullets;
  }

  public debugSnapshot(): CombatDebugSnapshot {
    return {
      ...this.combatDebug,
      activeProjectiles: this.activeBullets.reduce(
        (count, projectile) => count + (projectile.isActive ? 1 : 0),
        0,
      ),
    };
  }

  // ── ICombatService ───────────────────────────────────────────────────────────

  /**
   * Resolve a weapon fire request: a melee sweep, bullet pellets or a
   * rocket/thrown projectile, plus the muzzle/impact feedback. Always
   * announces the shot for audio and applies player recoil.
   * @param request Fully-specified fire request from a weapon component.
   */
  public fireWeapon(request: WeaponFireRequest): void {
    const weapon = WEAPONS[request.weaponId];
    if (!weapon) return;

    if (weapon.isMelee) {
      this.resolveMelee(request, weapon);
    } else {
      this.fireProjectiles(request, weapon);
    }

    if (request.fromPlayer && weapon.recoil > 0) {
      this.bus.emit(EventKeys.CameraShake, {
        durationMs: 50 + Math.round(90 * weapon.recoil),
        intensity: 0.002 + 0.007 * weapon.recoil,
      });
    }

    this.bus.emit(EventKeys.WeaponFired, {
      weaponId: request.weaponId,
      x: request.originX,
      y: request.originY,
      angle: request.angle,
      fromPlayer: request.fromPlayer,
      attribution: request.attribution,
    });
  }

  /**
   * Detonate an explosion: an expanding visual, a camera shake and radial
   * damage to every damageable within `radius`.
   */
  public spawnExplosion(
    x: number,
    y: number,
    radius: number,
    damage: number,
    fromPlayer: boolean,
    attribution?: DamageAttribution,
  ): void {
    const chain = this.explosionAttribution(fromPlayer, attribution);
    this.spawnExplosionSprite(x, y, radius);

    this.bus.emit(EventKeys.CameraShake, {
      durationMs: EXPLOSION_SHAKE.durationMs,
      intensity: EXPLOSION_SHAKE.intensity,
    });
    this.bus.emit(EventKeys.ExplosionSpawned, { x, y, radius, attribution: chain });
    if (chain.playerResponsible) {
      this.bus.emit(EventKeys.CrimeCommitted, {
        crime: 'explosion',
        position: { x, y },
        attribution: chain,
      });
    }

    this.forEachTargetNear(x, y, radius, (target) => {
      if (target.isDead) return;
      const position = target.position;
      const dx = position.x - x;
      const dy = position.y - y;
      const length = Math.max(1, Math.hypot(dx, dy));
      this.deliverDamage(
        target,
        {
          amount: damage,
          type: 'explosion',
          sourceFaction: Faction.Neutral,
          fromPlayer: chain.playerResponsible,
          attribution: chain,
          knockback: { x: (dx / length) * 120, y: (dy / length) * 120 },
        },
        {
          collision: 'explosion-radius',
          blood: true,
          confirmPlayerHit: chain.playerResponsible,
        },
      );
    });
  }

  /**
   * Ignite a burning ground patch that ticks damage onto anything inside it.
   * @param x World x of the fire centre.
   * @param y World y of the fire centre.
   * @param radius Burn radius in pixels.
   * @param fromPlayer Whether kills in the fire credit the player.
   */
  public spawnFireZone(
    x: number,
    y: number,
    radius: number,
    fromPlayer: boolean,
    attribution?: DamageAttribution,
  ): void {
    const scene = this.scene;
    if (!scene) return;

    const sprites: Phaser.GameObjects.Image[] = [];
    const glow = this.acquireEffectImage(TextureKeys.GlowSoft, x, y);
    if (!glow) return;
    glow.setBlendMode(Phaser.BlendModes.ADD);
    glow.setTint(0xff7a2a);
    glow.setScale((radius * 2.4) / 32);
    glow.setDepth(DepthLayers.Particles);
    sprites.push(glow);

    const flameCount = Math.max(3, Math.round(radius / 16));
    for (let i = 0; i < flameCount; i++) {
      const fx = x + random.range(-radius * 0.7, radius * 0.7);
      const fy = y + random.range(-radius * 0.7, radius * 0.7);
      const flame = this.acquireEffectImage(TextureKeys.Flame, fx, fy);
      if (!flame) continue;
      flame.setOrigin(0.5, 1);
      flame.setDepth(DepthLayers.Particles);
      flame.setScale(random.range(0.8, 1.5));
      scene.tweens.add({
        targets: flame,
        scaleY: { from: flame.scaleY, to: flame.scaleY * 1.5 },
        alpha: { from: 1, to: 0.7 },
        duration: random.range(180, 300),
        yoyo: true,
        repeat: -1,
      });
      sprites.push(flame);
    }

    this.fireZones.push({
      x,
      y,
      radius,
      fromPlayer: isPlayerResponsible({ fromPlayer, attribution }),
      attribution: this.fireAttribution(fromPlayer, attribution),
      expiresAt: this.elapsed + FIRE_ZONE_MS,
      nextTickAt: this.elapsed,
      sprites,
    });
  }

  // ── Per-frame tick ─────────────────────────────────────────────────────────────

  /**
   * Advance projectile lifetimes, fire zones and blood decals.
   * @param time Absolute scene time in ms.
   * @param delta Elapsed time since the previous frame in ms.
   */
  public update(time: number, _delta: number): void {
    this.elapsed = time;

    for (let i = this.activeBullets.length - 1; i >= 0; i--) {
      const bullet = this.activeBullets[i];
      if (!bullet) continue;
      if (bullet.isActive) {
        this.resolveSweptBulletHit(bullet);
        bullet.commitMotionSample();
      }
      if (!bullet.isActive) {
        this.pool?.release(bullet);
        this.activeBullets.splice(i, 1);
      }
    }

    this.tickFireZones(time);
    this.fadeBloodDecals(time);
  }

  /** Burn everything inside each fire zone; retire expired zones. */
  private tickFireZones(time: number): void {
    for (let i = this.fireZones.length - 1; i >= 0; i--) {
      const zone = this.fireZones[i];
      if (!zone) continue;
      if (time >= zone.expiresAt) {
        this.killFireZone(zone);
        this.fireZones.splice(i, 1);
        continue;
      }
      if (time < zone.nextTickAt) continue;
      zone.nextTickAt = time + FIRE_TICK_MS;

      this.forEachTargetNear(zone.x, zone.y, zone.radius, (target) => {
        if (target.isDead) return;
        this.deliverDamage(
          target,
          {
            amount: FIRE_TICK_DAMAGE,
            type: 'fire',
            sourceFaction: Faction.Neutral,
            fromPlayer: zone.fromPlayer,
            attribution: zone.attribution,
          },
          {
            collision: 'fire-zone',
            blood: true,
            confirmPlayerHit: false,
          },
        );
      });
    }
  }

  /** Fade out and destroy one fire zone's visuals. */
  private killFireZone(zone: FireZone, immediate = false): void {
    const scene = this.scene;
    for (const sprite of zone.sprites) {
      if (scene && !immediate) {
        scene.tweens.killTweensOf(sprite);
        scene.tweens.add({
          targets: sprite,
          alpha: 0,
          duration: 500,
          onComplete: () => this.releaseEffectImage(sprite),
        });
      } else {
        this.releaseEffectImage(sprite);
      }
    }
    zone.sprites.length = 0;
  }

  /** Preserve ownership while recording that the final hit was an explosion. */
  private explosionAttribution(
    fromPlayer: boolean,
    attribution?: DamageAttribution,
  ): DamageAttribution {
    const base = attribution ?? damageAttribution('explosion', fromPlayer);
    const owner =
      base.explosionOwnerId ?? base.lastAttackerId ?? base.weaponOwnerId ?? base.sourceId;
    return {
      ...base,
      source: 'explosion',
      explosionOwnerId: owner,
      time: this.elapsed || base.time,
      playerResponsible: isPlayerResponsible({ fromPlayer, attribution: base }),
    };
  }

  /** Fire retains the origin chain of the incendiary weapon that created it. */
  private fireAttribution(fromPlayer: boolean, attribution?: DamageAttribution): DamageAttribution {
    const base = attribution ?? damageAttribution('fire', fromPlayer);
    return {
      ...base,
      source: 'fire',
      explosionOwnerId:
        base.explosionOwnerId ?? base.lastAttackerId ?? base.weaponOwnerId ?? base.sourceId,
      time: this.elapsed || base.time,
      playerResponsible: isPlayerResponsible({ fromPlayer, attribution: base }),
    };
  }

  // ── Overlap handlers (wired by the gameplay scene) ─────────────────────────────

  /**
   * Resolve a projectile-vs-target overlap: damage a hostile, non-shooter
   * target, honour penetration, and retire or detonate the projectile.
   */
  public handleBulletHit(
    bulletObj: Phaser.GameObjects.GameObject,
    targetObj: Phaser.GameObjects.GameObject,
  ): void {
    const projectile = bulletObj.getData(PROJECTILE_DATA_KEY);
    if (!(projectile instanceof Projectile) || !projectile.isActive) {
      this.recordCollision('rejected:inactive-projectile');
      return;
    }

    const target = targetObj.getData(ENTITY_DATA_KEY);
    if (!isDamageable(target)) {
      this.recordCollision('rejected:no-damage-receiver');
      return;
    }
    if (target.isDead) {
      this.recordCollision('rejected:dead-target', projectile, target);
      return;
    }
    if (target.entityId === projectile.shooterId) {
      this.recordCollision('rejected:self-hit', projectile, target);
      return;
    }
    if (!isHostile(projectile.faction, target.faction)) {
      this.recordCollision('rejected:friendly-fire', projectile, target);
      return;
    }
    if (projectile.hasHit(target.entityId)) {
      this.recordCollision('rejected:duplicate-overlap', projectile, target);
      return;
    }

    // Explosive payloads detonate on contact instead of dealing point damage.
    if (projectile.kind === 'rocket') {
      projectile.end('hit');
      return;
    }
    if (projectile.kind === 'molotov') {
      projectile.end('hit');
      return;
    }
    if (projectile.kind === 'grenade') {
      // Grenades bounce off bodies and keep cooking.
      projectile.haltSliding();
      return;
    }

    // Bullets: penetration-aware point damage. registerPierce returns false
    // once the round has spent its budget (and dedupes repeat overlaps).
    const keepFlying = projectile.registerPierce(target.entityId);

    const body = projectile.sprite.body as Phaser.Physics.Arcade.Body;
    const velocityLength = Math.max(1, Math.hypot(body.velocity.x, body.velocity.y));
    const result = this.deliverDamage(
      target,
      {
        amount: projectile.damage,
        type: 'bullet',
        sourceFaction: projectile.faction,
        fromPlayer: projectile.fromPlayer,
        attribution: projectile.attribution,
        knockback: {
          x: (body.velocity.x / velocityLength) * 38,
          y: (body.velocity.y / velocityLength) * 38,
        },
      },
      {
        collision: 'projectile-overlap',
        blood: true,
        confirmPlayerHit: projectile.fromPlayer,
      },
    );

    if (!keepFlying || result.ignored !== null) {
      projectile.end('hit');
    }
  }

  /**
   * Resolve a projectile-vs-world overlap: spark/detonate and retire the
   * projectile (grenades simply stop sliding and keep cooking).
   */
  public handleBulletWorld(
    bulletObj: Phaser.GameObjects.GameObject,
    _tile: Phaser.GameObjects.GameObject | Phaser.Tilemaps.Tile,
  ): void {
    const projectile = bulletObj.getData(PROJECTILE_DATA_KEY);
    if (!(projectile instanceof Projectile) || !projectile.isActive) return;

    if (projectile.kind === 'grenade') {
      projectile.haltSliding();
      return;
    }
    if (projectile.kind === 'rocket' || projectile.kind === 'molotov') {
      projectile.end('hit');
      return;
    }
    this.resolveSweptBulletHit(projectile);
    if (!projectile.isActive) return;
    const sprite = projectile.sprite;
    this.spawnSpark(sprite.x, sprite.y);
    projectile.end('hit');
  }

  /**
   * Sweep a fast round across the distance travelled since the previous frame.
   * Arcade overlap remains the broad collision path; this closes its tunnelling
   * gap and still delegates the selected hit to the canonical overlap handler.
   */
  private resolveSweptBulletHit(projectile: Projectile): boolean {
    if (!projectile.isActive || projectile.kind !== 'bullet') return false;
    const segment = projectile.motionSegment;
    const dx = segment.to.x - segment.from.x;
    const dy = segment.to.y - segment.from.y;
    const lengthSq = dx * dx + dy * dy;
    if (lengthSq < 0.25) return false;

    const length = Math.sqrt(lengthSq);
    const midpoint = {
      x: segment.from.x + dx * 0.5,
      y: segment.from.y + dy * 0.5,
    };
    let nearest: { target: IDamageable; sprite: Phaser.Physics.Arcade.Sprite; t: number } | null =
      null;
    this.forEachTargetNear(midpoint.x, midpoint.y, length * 0.5 + 48, (target) => {
      if (
        target.isDead ||
        target.entityId === projectile.shooterId ||
        !isHostile(projectile.faction, target.faction) ||
        projectile.hasHit(target.entityId)
      ) {
        return;
      }
      const sprite = (target as unknown as { sprite?: Phaser.Physics.Arcade.Sprite }).sprite;
      const body = sprite?.body as Phaser.Physics.Arcade.Body | null | undefined;
      if (!sprite?.active || !body?.enable) return;
      const t = Phaser.Math.Clamp(
        ((target.position.x - segment.from.x) * dx + (target.position.y - segment.from.y) * dy) /
          lengthSq,
        0,
        1,
      );
      const closestX = segment.from.x + dx * t;
      const closestY = segment.from.y + dy * t;
      const targetRadius = Math.max(body.halfWidth, body.halfHeight) + 2;
      const targetDx = target.position.x - closestX;
      const targetDy = target.position.y - closestY;
      if (targetDx * targetDx + targetDy * targetDy > targetRadius * targetRadius) return;
      if (!nearest || t < nearest.t) nearest = { target, sprite, t };
    });

    const hit = nearest as { sprite: Phaser.Physics.Arcade.Sprite; t: number } | null;
    if (!hit) return false;
    this.handleBulletHit(projectile.sprite, hit.sprite);
    return true;
  }

  /**
   * Resolve a vehicle-vs-character overlap: at speed, injure the character and
   * flag a hit-and-run when the driver is the player. Airborne units are
   * never run over.
   */
  public handleRunOver(
    vehicleObj: Phaser.GameObjects.GameObject,
    charObj: Phaser.GameObjects.GameObject,
  ): void {
    const vehicle = vehicleObj.getData(ENTITY_DATA_KEY);
    if (!(vehicle instanceof Vehicle) || vehicle.isDestroyed) return;
    if (Math.abs(vehicle.movement.speed) < RUN_OVER_MIN_SPEED) return;
    if (charObj.getData('aerial') === true) return;

    const victim = charObj.getData(ENTITY_DATA_KEY);
    if (!isDamageable(victim) || victim.isDead) return;
    if (victim.entityId === vehicle.driverId) return;

    const pos = victim.position;
    this.deliverDamage(
      victim,
      {
        amount: RUN_OVER_DAMAGE,
        type: 'vehicle',
        sourceFaction: Faction.Neutral,
        fromPlayer: vehicle.isPlayerDriven,
        attribution: damageAttribution('collision', vehicle.isPlayerDriven, {
          sourceId: vehicle.id,
          vehicleOwnerId: vehicle.id,
          collisionOwnerId: vehicle.driverId ?? vehicle.id,
          lastAttackerId: vehicle.driverId ?? vehicle.id,
        }),
        knockback: {
          x: Math.cos(vehicle.movement.heading) * 130,
          y: Math.sin(vehicle.movement.heading) * 130,
        },
      },
      {
        collision: 'vehicle-overlap',
        blood: true,
        confirmPlayerHit: vehicle.isPlayerDriven,
      },
    );

    if (vehicle.isPlayerDriven) {
      this.bus.emit(EventKeys.CrimeCommitted, {
        crime: 'hit-and-run',
        position: { x: pos.x, y: pos.y },
        attribution: damageAttribution('collision', true, {
          sourceId: vehicle.id,
          vehicleOwnerId: vehicle.id,
          collisionOwnerId: vehicle.driverId ?? vehicle.id,
          lastAttackerId: vehicle.driverId ?? vehicle.id,
        }),
      });
    }
  }

  // ── Fire resolution ─────────────────────────────────────────────────────────────

  /**
   * Resolve a melee swing: damage the nearest hostile target inside the
   * frontal cone and within the weapon's reach.
   */
  private resolveMelee(request: WeaponFireRequest, weapon: WeaponDef): void {
    let best: IDamageable | null = null;
    let bestSq = weapon.range * weapon.range;

    this.forEachTargetNear(request.originX, request.originY, weapon.range, (target) => {
      if (target.entityId === request.shooterId || target.isDead) return;
      if (!isHostile(request.faction, target.faction)) return;

      const pos = target.position;
      const dx = pos.x - request.originX;
      const dy = pos.y - request.originY;
      const distSq = dx * dx + dy * dy;
      if (distSq > bestSq) return;

      const angleTo = Math.atan2(dy, dx);
      const diff = Math.abs(Phaser.Math.Angle.Wrap(angleTo - request.angle));
      if (diff > MELEE_CONE_HALF_ANGLE) return;

      best = target;
      bestSq = distSq;
    });

    const selected = best as IDamageable | null;
    if (!selected) return;
    this.deliverDamage(
      selected,
      {
        amount: weapon.damage,
        type: 'melee',
        sourceFaction: request.faction,
        fromPlayer: request.fromPlayer,
        attribution: request.attribution,
        knockback: { x: Math.cos(request.angle) * 55, y: Math.sin(request.angle) * 55 },
      },
      {
        collision: 'melee-cone',
        blood: true,
        confirmPlayerHit: request.fromPlayer,
      },
    );
  }

  /** The sole health-mutation boundary for every combat delivery mechanism. */
  private deliverDamage(
    target: IDamageable,
    info: DamageInfo,
    context: DamageDeliveryContext,
  ): DamageResult {
    const result = target.applyDamage(info);
    const applied = result.absorbedByArmor + result.appliedToHealth;
    if (context.blood && result.appliedToHealth > 0) {
      const pos = target.position;
      this.spawnBlood(pos.x, pos.y);
    }
    if (context.confirmPlayerHit && info.fromPlayer && applied > 0) {
      const pos = target.position;
      this.bus.emit(EventKeys.HitConfirmed, { x: pos.x, y: pos.y, fatal: target.isDead });
    }
    if (target.entityKind === EntityKind.Player) {
      const appliedHit = applied > 0;
      this.combatDebug = {
        incomingDamage: result.requested,
        appliedDamage: appliedHit ? result.appliedToHealth : this.combatDebug.appliedDamage,
        absorbedByArmor: appliedHit ? result.absorbedByArmor : this.combatDebug.absorbedByArmor,
        lastDamageSource: appliedHit
          ? this.describeDamageSource(info)
          : this.combatDebug.lastDamageSource,
        lastTarget: target.entityKind,
        policeBulletDamage:
          info.sourceFaction === Faction.Police && info.type === 'bullet'
            ? result.requested
            : this.combatDebug.policeBulletDamage,
        collisionResult:
          result.ignored === null
            ? `applied:${context.collision}`
            : `ignored:${result.ignored}:${context.collision}`,
      };
    }
    return result;
  }

  private recordCollision(result: string, _projectile?: Projectile, target?: IDamageable): void {
    this.combatDebug = {
      ...this.combatDebug,
      lastTarget: target?.entityKind ?? this.combatDebug.lastTarget,
      collisionResult: result,
    };
  }

  private describeDamageSource(info: DamageInfo): string {
    const owner =
      info.attribution?.weaponOwnerId ??
      info.attribution?.collisionOwnerId ??
      info.attribution?.explosionOwnerId ??
      info.attribution?.sourceId;
    return `${info.sourceFaction}:${info.type ?? 'generic'}${owner === undefined ? '' : `#${owner}`}`;
  }

  private resetDebugTelemetry(): void {
    this.combatDebug = {
      incomingDamage: 0,
      appliedDamage: 0,
      absorbedByArmor: 0,
      lastDamageSource: 'none',
      lastTarget: 'none',
      policeBulletDamage: WEAPONS.pistol.damage,
      collisionResult: 'none',
    };
  }

  /**
   * Fire the weapon's projectile(s): acquire pooled projectiles, launch each
   * along a spread-jittered angle, eject casings and flash the muzzle.
   */
  private fireProjectiles(request: WeaponFireRequest, weapon: WeaponDef): void {
    const group = this.bullets;
    const pool = this.pool;
    if (!group || !pool) return;

    const totalSpreadDeg = weapon.spreadDeg + (request.extraSpreadDeg ?? 0);
    const spreadRad = Phaser.Math.DegToRad(totalSpreadDeg);
    const pellets = Math.max(1, weapon.pellets);

    const onEnd =
      weapon.projectile === 'rocket' || weapon.projectile === 'grenade'
        ? (p: Projectile, _reason: ProjectileEndReason): void => {
            this.spawnExplosion(
              p.sprite.x,
              p.sprite.y,
              weapon.explosionRadius,
              weapon.damage,
              p.fromPlayer,
              p.attribution,
            );
          }
        : weapon.projectile === 'molotov'
          ? (p: Projectile, _reason: ProjectileEndReason): void => {
              this.spawnFireZone(
                p.sprite.x,
                p.sprite.y,
                weapon.explosionRadius,
                p.fromPlayer,
                p.attribution,
              );
            }
          : undefined;

    for (let i = 0; i < pellets; i++) {
      if (pool.activeCount >= COMBAT.MAX_BULLETS) break;

      const angle = request.angle + (spreadRad > 0 ? random.range(-spreadRad, spreadRad) : 0);
      const projectile = pool.acquire();
      if (!group.contains(projectile.sprite)) {
        group.add(projectile.sprite);
      }
      projectile.fire({
        x: request.originX,
        y: request.originY,
        angle,
        speed: weapon.bulletSpeed,
        damage: weapon.damage,
        range: weapon.range,
        faction: request.faction,
        fromPlayer: request.fromPlayer,
        attribution: request.attribution,
        shooterId: request.shooterId,
        kind: weapon.projectile === 'none' ? 'bullet' : weapon.projectile,
        pierce: weapon.penetration,
        fuseMs: weapon.fuseMs,
        onEnd,
      });
      this.activeBullets.push(projectile);
    }

    if (weapon.ejectsCasings) {
      this.spawnCasing(request.originX, request.originY, request.angle);
    }
    if (weapon.projectile === 'bullet' || weapon.projectile === 'rocket') {
      this.spawnMuzzle(request.originX, request.originY, request.angle);
    }
  }

  // ── Target discovery ─────────────────────────────────────────────────────────

  /**
   * Collect every damageable in play — pedestrians, police, vehicles, animals
   * and the player — by reading entity back-references off each system's
   * sprite group.
   */
  private forEachTargetNear(
    x: number,
    y: number,
    radius: number,
    visitor: (target: IDamageable) => void,
  ): void {
    const entities = this.resolveEntityManager();
    if (entities) {
      entities.forEachNearby(x, y, radius, (entity) => {
        if (isDamageable(entity)) visitor(entity);
      });
      return;
    }

    const radiusSq = radius * radius;
    const groupKeys = [
      ServiceKeys.Pedestrian,
      ServiceKeys.Wanted,
      ServiceKeys.Vehicle,
      ServiceKeys.CityLife,
    ];
    for (const key of groupKeys) {
      const service = ServiceLocator.tryResolve(key);
      const group = (service as unknown as { group?: Phaser.Physics.Arcade.Group } | null)?.group;
      if (!group) continue;
      for (const child of group.getChildren()) {
        const target = child.getData(ENTITY_DATA_KEY);
        if (!isDamageable(target)) continue;
        const pos = target.position;
        const dx = pos.x - x;
        const dy = pos.y - y;
        if (dx * dx + dy * dy <= radiusSq) visitor(target);
      }
    }

    const player = this.resolvePlayerTarget();
    if (!player) return;
    const pos = player.position;
    const dx = pos.x - x;
    const dy = pos.y - y;
    if (dx * dx + dy * dy <= radiusSq) visitor(player);
  }

  /** Resolve the player entity as an {@link IDamageable}, or `null`. */
  private resolvePlayerTarget(): IDamageable | null {
    const service = ServiceLocator.tryResolve(ServiceKeys.Player);
    const player = (service as unknown as { player?: unknown } | null)?.player;
    return isDamageable(player) ? player : null;
  }

  private resolveEntityManager(): EntityManager | null {
    return ServiceLocator.tryResolve<EntityManager>(ServiceKeys.Entity);
  }

  // ── Visual feedback ─────────────────────────────────────────────────────────

  /**
   * Add a fading blood decal at a world position and announce the spill.
   */
  private spawnBlood(x: number, y: number): void {
    const scene = this.scene;
    if (!scene) return;

    const blood = this.acquireEffectImage(TextureKeys.Blood, x, y);
    if (!blood) return;
    blood.setDepth(DepthLayers.Shadows);
    blood.setRotation(random.range(0, Math.PI * 2));
    this.bloodDecals.push({ image: blood, born: this.elapsed });
    while (this.bloodDecals.length > COMBAT.MAX_BLOOD_DECALS) {
      const expired = this.bloodDecals.shift();
      if (expired) this.releaseEffectImage(expired.image);
    }

    this.particles?.burst(x, y, 6);
    this.bus.emit(EventKeys.BloodSpill, { x, y });
  }

  /** Eject a spent brass casing perpendicular to the firing direction. */
  private spawnCasing(x: number, y: number, angle: number): void {
    const scene = this.scene;
    if (!scene) return;

    const side = angle + Math.PI / 2 + random.range(-0.5, 0.5);
    const dist = random.range(8, 16);
    const casing = this.acquireEffectImage(TextureKeys.Casing, x, y, CASING_LIFETIME_MS + 700);
    if (!casing) return;
    casing.setDepth(DepthLayers.Shadows);
    casing.setRotation(random.range(0, Math.PI * 2));
    this.casings.push(casing);
    while (this.casings.length > MAX_CASINGS) {
      const expired = this.casings.shift();
      if (expired) this.releaseEffectImage(expired);
    }

    scene.tweens.add({
      targets: casing,
      x: x + Math.cos(side) * dist,
      y: y + Math.sin(side) * dist,
      rotation: casing.rotation + random.range(2, 5),
      duration: 260,
      ease: 'Quad.easeOut',
    });
    scene.tweens.add({
      targets: casing,
      alpha: 0,
      delay: CASING_LIFETIME_MS,
      duration: 600,
      onComplete: () => {
        this.releaseEffectImage(casing);
        const idx = this.casings.indexOf(casing);
        if (idx !== -1) this.casings.splice(idx, 1);
      },
    });
  }

  /**
   * Draw a short-lived muzzle flash at the barrel.
   */
  private spawnMuzzle(x: number, y: number, angle: number): void {
    const scene = this.scene;
    if (!scene) return;

    const flash = this.acquireEffectImage(TextureKeys.Muzzle, x, y, MUZZLE_FLASH_MS + 50);
    if (!flash) return;
    flash.setDepth(DepthLayers.Projectiles);
    flash.setRotation(angle);
    scene.tweens.add({
      targets: flash,
      alpha: { from: 1, to: 0 },
      scale: { from: 0.9, to: 1.4 },
      duration: MUZZLE_FLASH_MS,
      onComplete: () => this.releaseEffectImage(flash),
    });

    this.particles?.burst(x, y, 4);
  }

  /**
   * Draw a brief spark where a bullet strikes solid geometry.
   */
  private spawnSpark(x: number, y: number): void {
    const scene = this.scene;
    if (!scene) return;

    const spark = this.acquireEffectImage(TextureKeys.Spark, x, y, SPARK_MS + 50);
    if (!spark) return;
    spark.setDepth(DepthLayers.Projectiles);
    spark.setRotation(random.range(0, Math.PI * 2));
    scene.tweens.add({
      targets: spark,
      alpha: { from: 1, to: 0 },
      scale: { from: 0.8, to: 0.2 },
      duration: SPARK_MS,
      onComplete: () => this.releaseEffectImage(spark),
    });

    this.particles?.burst(x, y, 5);
  }

  /**
   * Grow and fade an explosion sprite scaled to the blast radius.
   */
  private spawnExplosionSprite(x: number, y: number, radius: number): void {
    const scene = this.scene;
    if (!scene) return;

    const blast = this.acquireEffectImage(TextureKeys.Explosion, x, y, EXPLOSION_TWEEN_MS + 80);
    if (!blast) return;
    blast.setDepth(DepthLayers.Particles);
    const targetScale = blast.width > 0 ? (radius * 2) / blast.width : 1;
    blast.setScale(targetScale * 0.25);
    blast.setAlpha(0.95);
    scene.tweens.add({
      targets: blast,
      scale: targetScale,
      alpha: { from: 0.95, to: 0 },
      duration: EXPLOSION_TWEEN_MS,
      ease: 'Quad.easeOut',
      onComplete: () => this.releaseEffectImage(blast),
    });

    this.particles?.burst(x, y, 24);
  }

  /**
   * Fade blood decals toward the end of their life and destroy the expired
   * ones.
   */
  private fadeBloodDecals(time: number): void {
    const lifespan = COMBAT.BLOOD_LIFESPAN_MS;
    const fadeStart = lifespan * BLOOD_FADE_START;

    for (let i = this.bloodDecals.length - 1; i >= 0; i--) {
      const decal = this.bloodDecals[i];
      if (!decal) continue;
      const age = time - decal.born;
      if (age >= lifespan) {
        this.releaseEffectImage(decal.image);
        this.bloodDecals.splice(i, 1);
        continue;
      }
      if (age > fadeStart) {
        const t = (age - fadeStart) / (lifespan - fadeStart);
        decal.image.setAlpha(1 - t);
      }
    }
  }

  private acquireEffectImage(
    texture: string,
    x: number,
    y: number,
    lifetimeMs = 0,
  ): Phaser.GameObjects.Image | null {
    return (
      this.particles?.acquireImage(texture, x, y, lifetimeMs) ??
      this.scene?.add.image(x, y, texture) ??
      null
    );
  }

  private releaseEffectImage(image: Phaser.GameObjects.Image): void {
    if (this.particles) this.particles.releaseImage(image);
    else image.destroy();
  }
}
