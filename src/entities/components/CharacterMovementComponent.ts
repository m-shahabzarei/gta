/**
 * Character locomotion component.
 *
 * Drives an on-foot character (player or pedestrian) by translating a desired
 * move vector into an Arcade body velocity. It owns the character's facing
 * angle but never touches the sprite transform — rotation and the walk bob are
 * the animator's job (see `CharacterAnimatorComponent`). Movement can be gated
 * off entirely (e.g. while the character is a passenger in a vehicle) via
 * {@link CharacterMovementComponent.setEnabled}.
 */
import type Phaser from 'phaser';
import { Component } from '@/entities/Component';
import type { Vector2 } from '@/core/types';

const IMPULSE_DURATION_MS = 180;

export class CharacterMovementComponent extends Component {
  /** Component id within its host entity. */
  public readonly name = 'movement';

  /** Walking speed in px/sec. */
  private readonly walkSpeed: number;

  /** Running speed in px/sec. */
  private readonly runSpeed: number;

  /** Normalised desired move direction (zero when idle). */
  private moveX = 0;
  private moveY = 0;

  /** Whether the current move request is a run. */
  private isRunning = false;

  /** Direction (radians, 0 = +x) the character is currently facing. */
  private facing = -Math.PI / 2;

  /** Set true when {@link setFacingAngle} was called during the current frame. */
  private facingSetThisFrame = false;

  /** Whether locomotion is active; when false the body is held at rest. */
  private enabled = true;
  private impulseX = 0;
  private impulseY = 0;
  private impulseRemainingMs = 0;

  /**
   * @param walkSpeed Ground speed while walking, in px/sec.
   * @param runSpeed Ground speed while running, in px/sec.
   */
  constructor(walkSpeed: number, runSpeed: number) {
    super();
    this.walkSpeed = walkSpeed;
    this.runSpeed = runSpeed;
  }

  /**
   * Request movement in a desired direction. The vector may be unnormalised;
   * it is stored normalised. A zero-length vector clears the request.
   * @param x Desired x direction component.
   * @param y Desired y direction component.
   * @param running Whether to move at run speed.
   */
  public setMoveVector(x: number, y: number, running: boolean): void {
    const len = Math.hypot(x, y);
    if (len > 1e-4) {
      this.moveX = x / len;
      this.moveY = y / len;
    } else {
      this.moveX = 0;
      this.moveY = 0;
    }
    this.isRunning = running;
  }

  /** Clear any pending movement request; the body will halt on next update. */
  public stop(): void {
    this.moveX = 0;
    this.moveY = 0;
    this.isRunning = false;
  }

  /**
   * Explicitly set the facing angle for this frame, overriding the direction
   * that would otherwise be derived from the move vector.
   * @param a Facing angle in radians (0 = +x / east).
   */
  public setFacingAngle(a: number): void {
    this.facing = a;
    this.facingSetThisFrame = true;
  }

  /** Current facing angle in radians (0 = +x / east). */
  public get facingAngle(): number {
    return this.facing;
  }

  /** Current speed magnitude in px/sec (0 when idle or disabled). */
  public get speed(): number {
    if (!this.enabled || (this.moveX === 0 && this.moveY === 0)) {
      return 0;
    }
    return this.isRunning ? this.runSpeed : this.walkSpeed;
  }

  /** Whether a non-zero move request is currently active. */
  public get isMoving(): boolean {
    return this.enabled && (this.moveX !== 0 || this.moveY !== 0);
  }

  /** Whether the active move request is a run. */
  public get running(): boolean {
    return this.isRunning;
  }

  /**
   * Enable or disable locomotion. While disabled the body is zeroed and move
   * requests are ignored until re-enabled.
   * @param enabled Whether locomotion is active.
   */
  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.clearImpulse();
  }

  public applyImpulse(impulse: Vector2): void {
    if (!this.enabled || !Number.isFinite(impulse.x) || !Number.isFinite(impulse.y)) return;
    this.impulseX = impulse.x;
    this.impulseY = impulse.y;
    this.impulseRemainingMs = IMPULSE_DURATION_MS;
  }

  /** Restore locomotion state when the owning character is reused from a pool. */
  public reset(facing = -Math.PI / 2): void {
    this.moveX = 0;
    this.moveY = 0;
    this.isRunning = false;
    this.facing = facing;
    this.facingSetThisFrame = false;
    this.enabled = true;
    this.clearImpulse();
    const body = this.entity.sprite.body as Phaser.Physics.Arcade.Body;
    body.setVelocity(0, 0);
  }

  /**
   * Per-frame tick: apply the desired velocity to the Arcade body and update
   * the derived facing angle. Does not rotate the sprite.
   */
  public override update(_time: number, delta: number): void {
    const body = this.entity.sprite.body as Phaser.Physics.Arcade.Body;

    if (!this.enabled) {
      body.setVelocity(0, 0);
      this.facingSetThisFrame = false;
      return;
    }

    const speed =
      this.moveX === 0 && this.moveY === 0 ? 0 : this.isRunning ? this.runSpeed : this.walkSpeed;
    const impulseFactor = Math.max(0, this.impulseRemainingMs / IMPULSE_DURATION_MS);
    body.setVelocity(
      this.moveX * speed + this.impulseX * impulseFactor,
      this.moveY * speed + this.impulseY * impulseFactor,
    );
    if (this.impulseRemainingMs > 0) {
      this.impulseRemainingMs = Math.max(0, this.impulseRemainingMs - delta);
      if (this.impulseRemainingMs === 0) this.clearImpulse();
    }

    // Face the direction of travel unless an explicit facing was set this frame.
    if (!this.facingSetThisFrame) {
      this.facing = Math.atan2(this.moveY, this.moveX);
    }
    this.facingSetThisFrame = false;
  }

  private clearImpulse(): void {
    this.impulseX = 0;
    this.impulseY = 0;
    this.impulseRemainingMs = 0;
  }
}
