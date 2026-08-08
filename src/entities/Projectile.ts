/**
 * A pooled projectile: bullets, rockets and thrown explosives.
 *
 * Unlike gameplay actors, a {@link Projectile} deliberately does NOT extend
 * {@link Entity}: projectiles are short-lived, spawned in large numbers, and
 * are recycled by the combat system's object pool rather than owning a
 * component graph. Each instance wraps a single Arcade-physics sprite that is
 * activated on {@link fire} and returned to the pool on {@link deactivate}.
 *
 * Behaviour varies by {@link ProjectileKind}:
 *  - `bullet`: flies straight and expires at max range (or on impact).
 *  - `rocket`: like a bullet but reports `range`/`hit` endings so the combat
 *    system can detonate it; trails smoke.
 *  - `grenade`: decelerates under drag (a lobbed slide), spins, and reports a
 *    `fuse` ending when its timer pops.
 *  - `molotov`: decelerates and reports a `stopped`/`hit` ending, at which
 *    point the combat system ignites a fire zone.
 */
import Phaser from 'phaser';
import { Entity } from '@/entities/Entity';
import { TextureKeys } from '@/config/AssetKeys';
import { DepthLayers } from '@/config/DepthLayers';
import { Faction, type DamageAttribution, type ProjectileKind } from '@/gameplay/types';

/** `setData`/`getData` key under which a bullet sprite references its owner. */
const PROJECTILE_DATA_KEY = 'projectile';

/** Drag (px/s²) applied to thrown projectiles so they slide to a stop. */
const THROWN_DRAG = 340;

/** Spin rate (rad/s) for tumbling thrown projectiles. */
const THROWN_SPIN = 9;

/** Why a projectile's flight ended (consumed by the combat system). */
export type ProjectileEndReason = 'range' | 'fuse' | 'stopped' | 'hit';

/** Callback invoked exactly once when a live projectile's flight ends. */
export type ProjectileEndHandler = (projectile: Projectile, reason: ProjectileEndReason) => void;

/** Everything needed to launch one projectile. */
export interface ProjectileLaunch {
  x: number;
  y: number;
  /** Travel direction in radians (0 = east). */
  angle: number;
  /** Initial flight speed in px/sec. */
  speed: number;
  /** Hit-point damage delivered on direct impact. */
  damage: number;
  /** Maximum travel distance in px before expiry. */
  range: number;
  /** Shooter's allegiance. */
  faction: Faction;
  /** Whether the shot originated from the player. */
  fromPlayer: boolean;
  /** Full ownership chain retained through flight, explosion and fire. */
  attribution: DamageAttribution;
  /** Entity id of the shooter. */
  shooterId: number;
  /** Flight/impact behaviour family. */
  kind: Exclude<ProjectileKind, 'none'>;
  /** How many targets the projectile may pass through (bullets only). */
  pierce: number;
  /** Fuse (ms) for timer-detonated projectiles; 0 disables the fuse. */
  fuseMs: number;
  /** Invoked once when the flight ends (range/fuse/stopped/hit). */
  onEnd?: ProjectileEndHandler;
}

export class Projectile extends Entity {
  private _faction: Faction = Faction.Neutral;
  private _damage = 0;
  private _fromPlayer = false;
  private _shooterId = -1;
  private _range = 0;
  private _traveled = 0;
  private _speed = 0;
  private _angle = 0;
  private _previousX = 0;
  private _previousY = 0;
  private _kind: Exclude<ProjectileKind, 'none'> = 'bullet';
  private _pierce = 0;
  private _fuseMs = 0;
  private _onEnd: ProjectileEndHandler | null = null;
  private _attribution: DamageAttribution = {
    source: 'unknown',
    time: 0,
    playerResponsible: false,
  };

  /** Ids of entities this projectile has already pierced this flight. */
  private readonly _piercedIds = new Set<number>();

  constructor(scene: Phaser.Scene) {
    super(scene.physics.add.sprite(0, 0, TextureKeys.Bullet));
    this.sprite.setActive(false);
    this.sprite.setVisible(false);
    this.sprite.setDepth(DepthLayers.Projectiles);
    this.sprite.setData(PROJECTILE_DATA_KEY, this);

    const body = this.sprite.body as Phaser.Physics.Arcade.Body;
    body.enable = false;
  }

  /** Whether this projectile is currently live. */
  public get isActive(): boolean {
    return this.sprite.active;
  }

  /** Faction of the shooter. */
  public get faction(): Faction {
    return this._faction;
  }

  /** Damage dealt on impact. */
  public get damage(): number {
    return this._damage;
  }

  /** Whether the shot originated from the player. */
  public get fromPlayer(): boolean {
    return this._fromPlayer;
  }

  /** Entity id of the shooter. */
  public get shooterId(): number {
    return this._shooterId;
  }

  /** Ownership chain copied from the weapon launch request. */
  public get attribution(): DamageAttribution {
    return this._attribution;
  }

  /** Flight/impact behaviour family. */
  public get kind(): Exclude<ProjectileKind, 'none'> {
    return this._kind;
  }

  /**
   * Register a pierced victim. Returns `true` while the projectile still has
   * penetration budget left (it keeps flying), `false` when it should stop.
   * Repeat hits against the same entity never consume budget.
   * @param entityId The victim's entity id.
   */
  public registerPierce(entityId: number): boolean {
    this._piercedIds.add(entityId);
    if (this._pierce <= 0) {
      return false;
    }
    this._pierce -= 1;
    return true;
  }

  /** Whether this projectile already delivered damage to an entity this flight. */
  public hasHit(entityId: number): boolean {
    return this._piercedIds.has(entityId);
  }

  /** Physics movement since the combat system's previous collision sweep. */
  public get motionSegment(): { from: { x: number; y: number }; to: { x: number; y: number } } {
    return {
      from: { x: this._previousX, y: this._previousY },
      to: { x: this.sprite.x, y: this.sprite.y },
    };
  }

  /** Advance the start of the next swept-collision segment to the live body position. */
  public commitMotionSample(): void {
    this._previousX = this.sprite.x;
    this._previousY = this.sprite.y;
  }

  /** Launch this projectile from the pool. */
  public fire(launch: ProjectileLaunch): void {
    this._faction = launch.faction;
    this._damage = launch.damage;
    this._fromPlayer = launch.fromPlayer;
    this._shooterId = launch.shooterId;
    this._attribution = { ...launch.attribution };
    this._range = launch.range;
    this._speed = launch.speed;
    this._angle = launch.angle;
    this._previousX = launch.x;
    this._previousY = launch.y;
    this._traveled = 0;
    this._kind = launch.kind;
    this._pierce = launch.pierce;
    this._fuseMs = launch.fuseMs;
    this._onEnd = launch.onEnd ?? null;
    this._piercedIds.clear();

    this.sprite.setTexture(this.textureFor(launch.kind));
    this.sprite.setPosition(launch.x, launch.y);
    this.sprite.setRotation(launch.angle);
    this.sprite.setActive(true);
    this.sprite.setVisible(true);

    const body = this.sprite.body as Phaser.Physics.Arcade.Body;
    body.enable = true;
    body.reset(launch.x, launch.y);
    this.sprite.setVelocity(
      Math.cos(launch.angle) * launch.speed,
      Math.sin(launch.angle) * launch.speed,
    );
  }

  /** Kill a thrown projectile's slide (e.g. a grenade bumping a wall). */
  public haltSliding(): void {
    this._speed = 0;
    const body = this.sprite.body as Phaser.Physics.Arcade.Body;
    body.setVelocity(0, 0);
  }

  /**
   * End the flight: notify the combat system once, then hide and disable.
   * @param reason Why the flight ended; `hit` when a target/world was struck.
   */
  public end(reason: ProjectileEndReason): void {
    if (!this.sprite.active) return;
    const handler = this._onEnd;
    this._onEnd = null;
    this.deactivate();
    if (handler) {
      handler(this, reason);
    }
  }

  /** Return this projectile to the pool: hide it and disable its body. */
  public deactivate(): void {
    this.sprite.setActive(false);
    this.sprite.setVisible(false);
    this._onEnd = null;

    const body = this.sprite.body as Phaser.Physics.Arcade.Body;
    body.stop();
    body.enable = false;
  }

  /**
   * Advance the projectile's lifetime: fuse timers, thrown-drag, spin and
   * range expiry.
   *
   * @param delta Elapsed time since the previous frame, in milliseconds.
   */
  public override update(_time: number, delta: number): void {
    if (!this.sprite.active) return;
    const dt = delta / 1000;

    // Fuse (grenades): pops regardless of motion.
    if (this._fuseMs > 0) {
      this._fuseMs -= delta;
      if (this._fuseMs <= 0) {
        this.end('fuse');
        return;
      }
    }

    // Thrown projectiles slide to a stop under drag and tumble as they go.
    if (this._kind === 'grenade' || this._kind === 'molotov') {
      this.sprite.rotation += THROWN_SPIN * dt;
      this._speed = Math.max(0, this._speed - THROWN_DRAG * dt);
      const body = this.sprite.body as Phaser.Physics.Arcade.Body;
      body.setVelocity(Math.cos(this._angle) * this._speed, Math.sin(this._angle) * this._speed);
      if (this._speed <= 4 && this._kind === 'molotov') {
        this.end('stopped');
        return;
      }
    }

    this._traveled += (this._speed * delta) / 1000;
    if (this._traveled >= this._range) {
      this.end('range');
    }
  }

  /** Resolve the texture for a projectile kind. */
  private textureFor(kind: Exclude<ProjectileKind, 'none'>): string {
    switch (kind) {
      case 'rocket':
        return TextureKeys.Rocket;
      case 'grenade':
        return TextureKeys.GrenadeFx;
      case 'molotov':
        return TextureKeys.MolotovFx;
      case 'bullet':
      default:
        return TextureKeys.Bullet;
    }
  }
}
