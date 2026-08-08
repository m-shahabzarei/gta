/**
 * Vehicle feedback-effects component (purely cosmetic).
 *
 * Reads the movement + health siblings each frame and renders the physical
 * "feel" of the car:
 *  - engine-damage smoke once health drops below the smoke threshold;
 *  - tire smoke puffs and fading skid-mark decals while the car skids;
 *  - a subtle suspension squash/stretch along the body under load;
 *  - a {@link EventKeys.TireSkidChanged} edge event for the player's vehicle so
 *    the audio system can gate its skid loop.
 */
import Phaser from 'phaser';
import { Component } from '@/entities/Component';
import { eventBus } from '@/core/EventBus';
import { EventKeys } from '@/config/EventKeys';
import { TextureKeys } from '@/config/AssetKeys';
import { DepthLayers } from '@/config/DepthLayers';
import { VEHICLE } from '@/config/Constants';
import { getPlayerRef, type VehicleDef } from '@/gameplay/types';
import type { HealthComponent } from './HealthComponent';
import type { VehicleMovementComponent } from './VehicleMovementComponent';
import { ServiceLocator } from '@/core/ServiceLocator';
import { ServiceKeys } from '@/config/ServiceKeys';
import type { ParticleManager } from '@/managers/ParticleManager';

/** Interval (ms) between engine-smoke puffs at low health. */
const SMOKE_INTERVAL_MS = 190;

/** Interval (ms) between skid-mark stamps while skidding. */
const SKID_MARK_INTERVAL_MS = 46;

/** Maximum live skid marks per vehicle (oldest fade out anyway). */
const MAX_MARKS = 26;

/** How long (ms) a skid mark lingers before it finishes fading. */
const MARK_LIFETIME_MS = 6500;

const EFFECT_RENDER_RADIUS_SQ = 780 * 780;

export class VehicleEffectsComponent extends Component {
  /** Component id within its host entity. */
  public readonly name = 'effects';

  private readonly def: VehicleDef;

  private movement: VehicleMovementComponent | null = null;
  private health: HealthComponent | null = null;
  private particles: ParticleManager | null = null;

  private smokeTimer = 0;
  private markTimer = 0;

  /** Live skid-mark images owned by this vehicle (FIFO-capped). */
  private readonly marks: Phaser.GameObjects.Image[] = [];

  /** Previous skid state, for edge-triggered audio events. */
  private wasSkidding = false;

  /** Smoothed suspension squash factor. */
  private squash = 0;

  /** Speed from the previous frame, for acceleration estimation. */
  private prevSpeed = 0;

  constructor(def: VehicleDef) {
    super();
    this.def = def;
  }

  /** Cache siblings. */
  protected override onAttach(): void {
    this.movement =
      this.entity.getComponent<VehicleMovementComponent>('movement') ?? null;
    this.health = this.entity.getComponent<HealthComponent>('health') ?? null;
    this.particles = ServiceLocator.tryResolve<ParticleManager>(ServiceKeys.Particle);
  }

  /** Advance smoke, skid marks, squash and the skid audio edge. */
  public override update(_time: number, delta: number): void {
    const movement = this.movement;
    const sprite = this.entity.sprite;
    if (!movement || !sprite.active) {
      return;
    }
    const destroyed =
      (this.entity as unknown as { isDestroyed?: boolean }).isDestroyed === true;

    if (!this.shouldRenderEffects(destroyed)) {
      if (this.wasSkidding) this.emitSkidEdge(false);
      this.prevSpeed = movement.speed;
      return;
    }

    this.updateSmoke(delta, destroyed);
    if (!destroyed) {
      this.updateSkid(movement, delta);
      this.updateSquash(movement, delta);
    } else if (this.wasSkidding) {
      this.emitSkidEdge(false);
    }
    this.prevSpeed = movement.speed;
  }

  private shouldRenderEffects(destroyed: boolean): boolean {
    if (this.entity.sprite.getData('playerDriven') === true) return true;
    const player = getPlayerRef()?.playerPosition;
    if (!player) return false;
    const dx = this.entity.sprite.x - player.x;
    const dy = this.entity.sprite.y - player.y;
    return destroyed || dx * dx + dy * dy <= EFFECT_RENDER_RADIUS_SQ;
  }

  /** Engine smoke below the health threshold (and heavier when destroyed). */
  private updateSmoke(delta: number, destroyed: boolean): void {
    const health = this.health;
    const sprite = this.entity.sprite;
    const ratio = health && health.maxHealth > 0 ? health.health / health.maxHealth : 1;
    const smoking = destroyed || ratio <= VEHICLE.SMOKE_RATIO;
    if (!smoking) {
      return;
    }
    this.smokeTimer += delta;
    const interval = destroyed ? SMOKE_INTERVAL_MS * 0.6 : SMOKE_INTERVAL_MS;
    if (this.smokeTimer < interval) {
      return;
    }
    this.smokeTimer = 0;

    const movement = this.movement;
    const heading = movement ? movement.heading : sprite.rotation - Math.PI / 2;
    const noseX = sprite.x + Math.cos(heading) * (this.def.height / 2 - 6);
    const noseY = sprite.y + Math.sin(heading) * (this.def.height / 2 - 6);

    const scene = sprite.scene;
    const puff = this.acquireImage(TextureKeys.Smoke, noseX, noseY, 1000);
    if (!puff) return;
    puff.setDepth(DepthLayers.Particles);
    puff.setAlpha(destroyed ? 0.8 : 0.55);
    puff.setScale(0.6);
    if (destroyed) puff.setTint(0x222222);
    scene.tweens.add({
      targets: puff,
      alpha: 0,
      scale: destroyed ? 1.7 : 1.2,
      x: noseX + Phaser.Math.Between(-6, 6),
      y: noseY - Phaser.Math.Between(8, 18),
      duration: 900,
      ease: 'Quad.easeOut',
      onComplete: () => this.releaseImage(puff),
    });
  }

  /** Skid marks + tire smoke + the player skid audio edge. */
  private updateSkid(movement: VehicleMovementComponent, delta: number): void {
    const skidding = movement.isSkidding && this.def.engine !== 'none';
    if (skidding !== this.wasSkidding) {
      this.emitSkidEdge(skidding);
    }
    if (!skidding) {
      return;
    }

    this.markTimer += delta;
    if (this.markTimer < SKID_MARK_INTERVAL_MS) {
      return;
    }
    this.markTimer = 0;

    const sprite = this.entity.sprite;
    const scene = sprite.scene;
    const heading = movement.heading;
    const fx = Math.cos(heading);
    const fy = Math.sin(heading);
    const rx = -fy;
    const ry = fx;
    const rearLen = this.def.height / 2 - 6;
    const halfWid = Math.max(2, this.def.width / 2 - 2);

    const sides = this.def.twoWheeler ? [0] : [-1, 1];
    for (const side of sides) {
      const mark = this.acquireImage(
        TextureKeys.SkidMark,
        sprite.x - fx * rearLen + rx * halfWid * side,
        sprite.y - fy * rearLen + ry * halfWid * side,
        MARK_LIFETIME_MS + 100,
      );
      if (!mark) continue;
      mark.setDepth(DepthLayers.SkidMarks);
      mark.setRotation(heading + Math.PI / 2);
      mark.setAlpha(0.5);
      scene.tweens.add({
        targets: mark,
        alpha: 0,
        duration: MARK_LIFETIME_MS,
        ease: 'Quad.easeIn',
        onComplete: () => {
          this.releaseImage(mark);
          const idx = this.marks.indexOf(mark);
          if (idx !== -1) this.marks.splice(idx, 1);
        },
      });
      this.marks.push(mark);
      while (this.marks.length > MAX_MARKS) {
        const expired = this.marks.shift();
        if (expired) this.releaseImage(expired);
      }

      // A short-lived tire smoke wisp above the mark.
      const wisp = this.acquireImage(TextureKeys.Smoke, mark.x, mark.y, 500);
      if (!wisp) continue;
      wisp.setDepth(DepthLayers.Particles);
      wisp.setAlpha(0.3);
      wisp.setScale(0.4);
      scene.tweens.add({
        targets: wisp,
        alpha: 0,
        scale: 0.9,
        duration: 420,
        onComplete: () => this.releaseImage(wisp),
      });
    }
  }

  /** Subtle squash/stretch along the body under acceleration and braking. */
  private updateSquash(movement: VehicleMovementComponent, delta: number): void {
    const dt = Math.max(0.001, delta / 1000);
    const accel = (movement.speed - this.prevSpeed) / dt;
    const target = Phaser.Math.Clamp(accel / this.def.accel, -1, 1) * 0.035;
    this.squash = Phaser.Math.Linear(this.squash, target, Math.min(1, dt * 10));
    this.entity.sprite.scaleY = 1 + this.squash;
    this.entity.sprite.scaleX = 1 - this.squash * 0.5;
  }

  /** Emit the skid edge event, but only for the player's vehicle. */
  private emitSkidEdge(active: boolean): void {
    this.wasSkidding = active;
    if (this.entity.sprite.getData('playerDriven') === true || !active) {
      eventBus.emit(EventKeys.TireSkidChanged, { active });
    }
  }

  public reset(): void {
    for (const mark of this.marks) this.releaseImage(mark);
    this.marks.length = 0;
    this.smokeTimer = 0;
    this.markTimer = 0;
    this.wasSkidding = false;
    this.squash = 0;
    this.prevSpeed = 0;
    this.entity.sprite.setScale(1);
  }

  /** Destroy remaining decals alongside the component. */
  public override destroy(): void {
    this.reset();
    this.movement = null;
    this.health = null;
    this.particles = null;
    super.destroy();
  }

  private acquireImage(
    texture: string,
    x: number,
    y: number,
    lifetimeMs = 0,
  ): Phaser.GameObjects.Image | null {
    return this.particles?.acquireImage(texture, x, y, lifetimeMs) ??
      this.entity.sprite.scene.add.image(x, y, texture);
  }

  private releaseImage(image: Phaser.GameObjects.Image): void {
    if (this.particles) this.particles.releaseImage(image);
    else image.destroy();
  }
}
