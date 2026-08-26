/**
 * Vehicle locomotion component.
 *
 * Implements simple, robust arcade car physics for a top-down vehicle. It
 * translates a throttle (-1..1) and steer (-1..1) input into a heading and a
 * signed speed along that heading, then drives the Arcade body velocity and the
 * sprite rotation. The car accelerates along its heading, coasts to a halt under
 * friction, clamps forward/reverse speed, and only turns while it is actually
 * moving. Both the player controller and the traffic AI drive a vehicle through
 * this component; the sprite is drawn top-down facing up, so the sprite rotation
 * is `heading + PI/2`.
 *
 * On top of the base model this component also:
 *  - detects hard impacts (the Arcade body reports blocked/touching while the
 *    integrator still carries speed) and reports them through
 *    {@link VehicleMovementComponent.consumeCrash} so the vehicle entity can
 *    apply crash damage and audio;
 *  - tracks a skid state (hard steering at speed, or heavy braking) consumed by
 *    the effects component for tire smoke, marks and audio;
 *  - supports a tire-condition factor (spike strips) that caps the top speed.
 */
import Phaser from 'phaser';
import { Component } from '@/entities/Component';
import { VEHICLE } from '@/config/Constants';
import type { VehicleDef } from '@/gameplay/types';

/** Steering fraction above which hard cornering at speed produces a skid. */
const SKID_STEER_THRESHOLD = 0.72;

/** Fraction of top speed above which hard cornering produces a skid. */
const SKID_SPEED_RATIO = 0.55;

/** Fraction of top speed above which hard braking produces a skid. */
const BRAKE_SKID_SPEED_RATIO = 0.4;

export class VehicleMovementComponent extends Component {
  /** Component id within its host entity. */
  public readonly name = 'movement';

  /** Static tuning for this vehicle (speed, acceleration, steering). */
  private readonly def: VehicleDef;

  /** Current heading in radians (0 = +x / east). */
  private headingAngle = -Math.PI / 2;

  /** Signed speed (px/sec) along the heading; negative means reversing. */
  private signedSpeed = 0;

  /** Throttle request in [-1, 1]; positive accelerates forward. */
  private throttle = 0;

  /** Steering request in [-1, 1]; positive steers clockwise (to the right). */
  private steer = 0;

  /** Physical front-wheel steering angle used by the bicycle-model yaw update. */
  private steeringAngleValue = 0;

  /** True while the brake is being applied this frame. */
  private braking = false;

  /** Whether player/AI controls are active; when false the car coasts down. */
  private controlsEnabled = true;

  /** Traffic simulation owns the pose while enabled; the arcade integrator is bypassed. */
  private trafficAuthority = false;

  /** Tire condition in (0, 1]; spike strips lower it, capping top speed. */
  private tireFactor = 1;

  /** Whether the vehicle is currently skidding (drift/brake slide). */
  private skiddingFlag = false;

  /** Impact speed (px/s) recorded by the crash detector, 0 when none pending. */
  private pendingCrashSpeed = 0;

  /**
   * @param def The vehicle definition supplying speed/accel/turn tuning.
   */
  constructor(def: VehicleDef) {
    super();
    this.def = def;
  }

  /** Align the initial heading with the sprite's current rotation. */
  protected override onAttach(): void {
    this.headingAngle = this.entity.sprite.rotation - Math.PI / 2;
  }

  /**
   * Set the throttle input for the next update.
   * @param v Throttle in [-1, 1]; positive drives forward, negative reverses.
   */
  public setThrottle(v: number): void {
    this.throttle = Phaser.Math.Clamp(v, -1, 1);
  }

  /**
   * Set the steering input for the next update.
   * @param v Steering in [-1, 1]; positive turns right, negative turns left.
   */
  public setSteer(v: number): void {
    this.steer = Phaser.Math.Clamp(v, -1, 1);
  }

  /** Request a hard brake this frame (decelerates toward zero quickly). */
  public brake(): void {
    this.braking = true;
  }

  /** Instantly halt the vehicle, clearing speed and pending inputs. */
  public stopImmediately(): void {
    this.signedSpeed = 0;
    this.throttle = 0;
    this.steer = 0;
    this.braking = false;
    const body = this.entity.sprite.body as Phaser.Physics.Arcade.Body;
    body.setVelocity(0, 0);
  }

  /**
   * Enable or disable player/AI controls. While disabled the car ignores
   * throttle/steer input and coasts to a stop under friction.
   * @param enabled Whether controls are active.
   */
  public setControlsEnabled(enabled: boolean): void {
    this.controlsEnabled = enabled;
  }

  public setTrafficAuthority(enabled: boolean): void {
    this.trafficAuthority = enabled;
    this.controlsEnabled = !enabled;
    this.throttle = 0;
    this.steer = 0;
    this.braking = false;
    const body = this.entity.sprite.body as Phaser.Physics.Arcade.Body;
    body.setImmovable(enabled);
    body.setVelocity(0, 0);
  }

  /** True while the shared TrafficDriver owns this vehicle's pose. */
  public get trafficControlled(): boolean {
    return this.trafficAuthority;
  }

  /**
   * Degrade (or restore) the tires. The factor caps the vehicle's top speed,
   * so a spiked car limps rather than stops.
   * @param factor Tire condition in (0, 1].
   */
  public setTireFactor(factor: number): void {
    this.tireFactor = Phaser.Math.Clamp(factor, 0.15, 1);
  }

  /** Current tire condition in (0, 1]. */
  public get tires(): number {
    return this.tireFactor;
  }

  /** Signed speed along the heading in px/sec (negative = reversing). */
  public get speed(): number {
    return this.signedSpeed;
  }

  /** Current heading in radians (0 = +x / east). */
  public get heading(): number {
    return this.headingAngle;
  }

  /** The effective top speed after tire condition. */
  public get effectiveMaxSpeed(): number {
    return this.def.maxSpeed * this.tireFactor;
  }

  /** Whether the last update left the vehicle in a skid. */
  public get isSkidding(): boolean {
    return this.skiddingFlag;
  }

  /** The current steering input in [-1, 1] (for brake/indicator lights). */
  public get steerInput(): number {
    return this.steer;
  }

  /** Current front-wheel steering angle in radians, useful to traffic telemetry. */
  public get steeringAngle(): number {
    return this.steeringAngleValue;
  }

  /** The current throttle input in [-1, 1] (for brake lights). */
  public get throttleInput(): number {
    return this.throttle;
  }

  /** Whether the vehicle decelerated (brake/counter-throttle) last frame. */
  public get isBraking(): boolean {
    return this.lastBraking;
  }

  /** Persisted braking state from the most recent update (for lights). */
  private lastBraking = false;

  /** Restore all integrator and control state for scene-local vehicle reuse. */
  public reset(heading: number): void {
    this.headingAngle = Phaser.Math.Angle.Wrap(heading);
    this.signedSpeed = 0;
    this.throttle = 0;
    this.steer = 0;
    this.steeringAngleValue = 0;
    this.braking = false;
    this.controlsEnabled = true;
    this.trafficAuthority = false;
    this.tireFactor = 1;
    this.skiddingFlag = false;
    this.pendingCrashSpeed = 0;
    this.lastBraking = false;
    const body = this.entity.sprite.body as Phaser.Physics.Arcade.Body;
    body.setImmovable(false);
    body.setVelocity(0, 0);
  }

  /**
   * Retrieve and clear the pending crash impact speed. The vehicle entity
   * polls this once per frame to translate impacts into damage + events.
   * @returns Impact speed in px/s, or 0 when no crash happened.
   */
  public consumeCrash(): number {
    const impact = this.pendingCrashSpeed;
    this.pendingCrashSpeed = 0;
    return impact;
  }

  /**
   * Apply coarse traffic simulation without waking Arcade physics. This is only
   * used by the central traffic LOD scheduler for far vehicles; player controls
   * and nearby traffic continue through the normal integrator.
   */
  public applyTrafficKinematic(heading: number, speed: number): void {
    this.headingAngle = Phaser.Math.Angle.Wrap(heading);
    this.signedSpeed = speed;
    this.steeringAngleValue = 0;
    const body = this.entity.sprite.body as Phaser.Physics.Arcade.Body;
    body.setVelocity(0, 0);
    this.entity.sprite.rotation = this.headingAngle + Math.PI / 2;
  }

  /** Synchronize a centrally simulated traffic pose into the render and collision body. */
  public applyTrafficPose(
    x: number,
    y: number,
    heading: number,
    speed: number,
    steeringAngle: number,
    braking: boolean,
  ): void {
    this.trafficAuthority = true;
    this.controlsEnabled = false;
    this.headingAngle = Phaser.Math.Angle.Wrap(heading);
    this.signedSpeed = speed;
    this.steeringAngleValue = steeringAngle;
    this.lastBraking = braking;
    this.skiddingFlag = false;
    const sprite = this.entity.sprite;
    sprite.setPosition(x, y);
    sprite.rotation = this.headingAngle + Math.PI / 2;
    const body = sprite.body as Phaser.Physics.Arcade.Body;
    body.reset(x, y);
    body.setImmovable(true);
    body.setVelocity(0, 0);
  }

  /**
   * Per-frame tick: detect impacts from the previous physics step, integrate
   * acceleration/friction into the signed speed, steer the heading, and apply
   * the resulting velocity and sprite rotation.
   */
  public override update(_time: number, delta: number): void {
    const dt = delta / 1000;
    const body = this.entity.sprite.body as Phaser.Physics.Arcade.Body;

    if (this.trafficAuthority) {
      body.setVelocity(0, 0);
      this.throttle = 0;
      this.steer = 0;
      this.braking = false;
      return;
    }

    this.detectCrash(body);

    const throttleInput = this.controlsEnabled ? this.throttle : 0;
    const steerInput = this.controlsEnabled ? this.steer : 0;

    if (this.braking) {
      this.applyFriction(dt, VEHICLE.FRICTION * 3);
    } else if (throttleInput !== 0) {
      this.signedSpeed += throttleInput * this.def.accel * dt;
    } else {
      this.applyFriction(dt, VEHICLE.FRICTION);
    }

    // Clamp forward and reverse speeds to their (tire-limited) caps.
    const maxForward = this.effectiveMaxSpeed;
    this.signedSpeed = Phaser.Math.Clamp(
      this.signedSpeed,
      -Math.min(VEHICLE.REVERSE_SPEED, maxForward),
      maxForward,
    );

    // Wheelbase-based bicycle model: controls request a front-wheel angle, then
    // yaw is integrated from v / wheelbase * tan(angle). This prevents the
    // instantaneous heading snaps that made AI turns look prototype-like.
    const speedRatio = Phaser.Math.Clamp(Math.abs(this.signedSpeed) / this.def.maxSpeed, 0, 1);
    const maxSteeringAngle = this.def.twoWheeler ? 0.7 : 0.54;
    const desiredSteeringAngle = steerInput * maxSteeringAngle;
    const steeringRate = Math.max(2.4, this.def.turnRate * 1.25);
    const steeringStep = steeringRate * dt;
    this.steeringAngleValue = Phaser.Math.Linear(
      this.steeringAngleValue,
      desiredSteeringAngle,
      Phaser.Math.Clamp(
        steeringStep / Math.max(Math.abs(desiredSteeringAngle - this.steeringAngleValue), 0.001),
        0,
        1,
      ),
    );
    if (speedRatio > 0.02) {
      const wheelbase = Math.max(18, Math.hypot(this.def.width, this.def.height) * 1.5);
      const yawRate = Phaser.Math.Clamp(
        (this.signedSpeed / wheelbase) * Math.tan(this.steeringAngleValue),
        -this.def.turnRate,
        this.def.turnRate,
      );
      this.headingAngle = Phaser.Math.Angle.Wrap(this.headingAngle + yawRate * dt);
    }

    // Skid: hard cornering at speed, or heavy braking from speed.
    this.skiddingFlag =
      (Math.abs(steerInput) >= SKID_STEER_THRESHOLD && speedRatio >= SKID_SPEED_RATIO) ||
      (this.braking && speedRatio >= BRAKE_SKID_SPEED_RATIO);

    body.setVelocity(
      Math.cos(this.headingAngle) * this.signedSpeed,
      Math.sin(this.headingAngle) * this.signedSpeed,
    );

    // Textures face up (toward -Y) at rotation 0, so add a quarter turn.
    this.entity.sprite.rotation = this.headingAngle + Math.PI / 2;

    // Brake lights: an explicit brake, or throttle opposing forward motion.
    this.lastBraking = this.braking || (throttleInput < 0 && this.signedSpeed > 12);

    // Inputs are consumed each frame; controllers re-assert them next tick.
    this.braking = false;
  }

  /**
   * Compare the speed the integrator believes it has against what the physics
   * body actually achieved last step. A large shortfall while the body reports
   * a blocked/touching edge means the car slammed into something.
   * @param body The vehicle's Arcade body (post-physics state).
   */
  private detectCrash(body: Phaser.Physics.Arcade.Body): void {
    const expected = Math.abs(this.signedSpeed);
    if (expected < VEHICLE.CRASH_MIN_SPEED) {
      return;
    }
    const blocked = body.blocked.left || body.blocked.right || body.blocked.up || body.blocked.down;
    const touching =
      body.touching.left || body.touching.right || body.touching.up || body.touching.down;
    if (!blocked && !touching) {
      return;
    }
    const actual = body.velocity.length();
    const lost = expected - actual;
    if (lost >= VEHICLE.CRASH_MIN_SPEED) {
      this.pendingCrashSpeed = lost;
      // Absorb the impact: rebound slightly instead of grinding at full power.
      this.signedSpeed *= -0.18;
    }
  }

  /**
   * Decay the signed speed toward zero by a friction magnitude, without
   * overshooting past zero.
   * @param dt Frame delta in seconds.
   * @param friction Deceleration magnitude in px/sec².
   */
  private applyFriction(dt: number, friction: number): void {
    const drop = friction * dt;
    if (Math.abs(this.signedSpeed) <= drop) {
      this.signedSpeed = 0;
    } else {
      this.signedSpeed -= Math.sign(this.signedSpeed) * drop;
    }
  }
}
