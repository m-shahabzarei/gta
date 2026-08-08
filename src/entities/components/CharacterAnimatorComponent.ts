/**
 * Character animator component: turns the abstract movement state produced by
 * {@link CharacterMovementComponent} into on-screen motion for a top-down
 * character sprite.
 *
 * Responsibilities are purely cosmetic — it never touches the physics body:
 * - Rotates the sprite so it faces the movement facing angle (textures are
 *   authored facing UP, so `rotation = facingAngle + PI/2`).
 * - Steps a {@link CharacterRig} clip (idle/walk/run/shoot/reload/death) and
 *   applies the current frame name to the sprite each tick, so characters have
 *   real pixel-art walk cycles instead of a scale bob.
 * - Provides {@link CharacterAnimatorComponent.damageFlash},
 *   {@link CharacterAnimatorComponent.triggerShoot},
 *   {@link CharacterAnimatorComponent.setReloading} and
 *   {@link CharacterAnimatorComponent.playDeath} for combat feedback.
 *
 * All sprite mutations are guarded so the component degrades gracefully when
 * the movement sibling or the rig frames are missing (single-frame textures
 * simply never change frame).
 */
import { Component } from '@/entities/Component';
import type { AnimClip, CharacterRig } from '@/graphics/CharacterRig';
import { HUMAN_RIG } from '@/graphics/CharacterRig';
import type { CharacterMovementComponent } from '@/entities/components/CharacterMovementComponent';

/** Tint used for the damage flash. */
const FLASH_TINT = 0xff4040;
/** Duration of the damage flash in milliseconds. */
const FLASH_MS = 120;
/** How long (ms) the shoot pose is held after a shot before movement resumes. */
const SHOOT_POSE_MS = 140;

/** The high-level pose the animator is currently playing. */
type AnimState = 'idle' | 'walk' | 'run' | 'shoot' | 'reload' | 'dead';

export class CharacterAnimatorComponent extends Component {
  /** Component identifier used for sibling lookups. */
  public readonly name = 'animator';

  /** The rig describing this character's animation clips. */
  private readonly rig: CharacterRig;

  /** Cached movement sibling; drives facing and clip selection. */
  private movement: CharacterMovementComponent | null = null;

  /** Whether the sprite's texture actually provides the rig's named frames. */
  private hasFrames = false;

  /** Current high-level state. */
  private state: AnimState = 'idle';

  /** Clip playhead in frames (fractional; floor gives the frame index). */
  private playhead = 0;

  /** Remaining time (ms) the shoot pose overrides locomotion. */
  private shootPoseMs = 0;

  /** Whether a reload loop is currently requested by the weapon. */
  private reloading = false;

  /** Whether the death pose is active (suspends all other updates). */
  private dead = false;

  /** Whether a damage flash tint is currently showing. */
  private flashing = false;

  /** Optional persistent tint reapplied after damage flashes. */
  private baseTint: number | null = null;

  /** @param rig The animation rig to play; defaults to the humanoid rig. */
  constructor(rig: CharacterRig = HUMAN_RIG) {
    super();
    this.rig = rig;
  }

  /** Cache the movement sibling and detect whether the rig frames exist. */
  protected override onAttach(): void {
    this.movement =
      this.entity.getComponent<CharacterMovementComponent>('movement') ?? null;
    const texture = this.entity.sprite.texture;
    const first = this.rig.idle.frames[0];
    this.hasFrames = first !== undefined && texture.has(first);
    if (this.hasFrames && first) {
      this.entity.sprite.setFrame(first);
    }
  }

  /**
   * Per-frame cosmetic update: face the movement direction and advance the
   * active clip. Only the death clip keeps stepping once the character dies.
   *
   * @param _time Absolute scene time (unused).
   * @param delta Milliseconds since the previous frame.
   */
  public override update(_time: number, delta: number): void {
    const sprite = this.entity.sprite;
    const movement = this.movement;

    if (this.dead) {
      this.advanceClip(this.rig.death, delta);
      return;
    }
    if (!movement) {
      return;
    }

    sprite.rotation = movement.facingAngle + Math.PI / 2;

    if (this.shootPoseMs > 0) {
      this.shootPoseMs -= delta;
    }

    const next = this.pickState(movement);
    if (next !== this.state) {
      this.state = next;
      this.playhead = 0;
    }
    this.advanceClip(this.clipFor(next), delta);
  }

  /** Resolve which state should play this frame from the current inputs. */
  private pickState(movement: CharacterMovementComponent): AnimState {
    if (this.reloading) return 'reload';
    if (this.shootPoseMs > 0) return 'shoot';
    if (!movement.isMoving) return 'idle';
    return movement.running ? 'run' : 'walk';
  }

  /** The rig clip for a state. */
  private clipFor(state: AnimState): AnimClip {
    switch (state) {
      case 'walk':
        return this.rig.walk;
      case 'run':
        return this.rig.run;
      case 'shoot':
        return this.rig.shoot;
      case 'reload':
        return this.rig.reload;
      case 'dead':
        return this.rig.death;
      case 'idle':
      default:
        return this.rig.idle;
    }
  }

  /** Advance the playhead through `clip` and apply the resulting frame. */
  private advanceClip(clip: AnimClip, delta: number): void {
    if (!this.hasFrames || clip.frames.length === 0) {
      return;
    }
    this.playhead += (delta / 1000) * clip.fps;
    let index: number;
    if (clip.loop) {
      index = Math.floor(this.playhead) % clip.frames.length;
    } else {
      index = Math.min(clip.frames.length - 1, Math.floor(this.playhead));
    }
    const frame = clip.frames[index];
    if (frame !== undefined && this.entity.sprite.frame.name !== frame) {
      this.entity.sprite.setFrame(frame);
    }
  }

  /** Flash the weapon-raised pose for a beat (called on every shot). */
  public triggerShoot(): void {
    if (this.dead) return;
    if (this.state !== 'shoot') this.playhead = 0;
    this.shootPoseMs = SHOOT_POSE_MS;
  }

  /**
   * Enter or leave the reload fumble loop.
   * @param active Whether a reload is in progress.
   */
  public setReloading(active: boolean): void {
    if (this.dead) return;
    if (active && !this.reloading) this.playhead = 0;
    this.reloading = active;
  }

  /**
   * Briefly tint the sprite red to acknowledge a hit, then restore the base
   * tint (if any) after ~120ms.
   */
  public damageFlash(): void {
    const sprite = this.entity.sprite;
    this.flashing = true;
    sprite.setTint(FLASH_TINT);
    sprite.scene.time.delayedCall(FLASH_MS, () => {
      this.flashing = false;
      if (!sprite.active) return;
      if (this.baseTint === null) {
        sprite.clearTint();
      } else {
        sprite.setTint(this.baseTint);
      }
    });
  }

  /** Record a persistent tint (e.g. a civilian profile tint). */
  public setBaseTint(tint: number | null): void {
    this.baseTint = tint;
    if (!this.flashing) {
      if (tint === null) {
        this.entity.sprite.clearTint();
      } else {
        this.entity.sprite.setTint(tint);
      }
    }
  }

  /**
   * Enter the death pose: play the one-shot collapse clip and hold its final
   * corpse frame.
   */
  public playDeath(): void {
    if (this.dead) return;
    this.dead = true;
    this.reloading = false;
    this.shootPoseMs = 0;
    this.state = 'dead';
    this.playhead = 0;
    const first = this.rig.death.frames[0];
    if (this.hasFrames && first !== undefined) {
      this.entity.sprite.setFrame(first);
    }
  }

  /**
   * Clear all animator state (tint, pose, death) and resume normal animation.
   * Used when an entity is revived or recycled from a pool.
   */
  public reset(): void {
    this.dead = false;
    this.flashing = false;
    this.reloading = false;
    this.shootPoseMs = 0;
    this.state = 'idle';
    this.playhead = 0;
    const sprite = this.entity.sprite;
    sprite.clearTint();
    if (this.baseTint !== null) {
      sprite.setTint(this.baseTint);
    }
    const first = this.rig.idle.frames[0];
    if (this.hasFrames && first !== undefined) {
      sprite.setFrame(first);
    }
    sprite.rotation = this.movement
      ? this.movement.facingAngle + Math.PI / 2
      : sprite.rotation;
  }
}
