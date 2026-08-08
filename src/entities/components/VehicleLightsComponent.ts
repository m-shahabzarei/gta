/**
 * Vehicle running-lights component (purely cosmetic).
 *
 * Owns a small set of additive glow images that ride on the vehicle sprite:
 *  - two headlight glows + forward light cones, lit at dusk/night;
 *  - two brake-light glows, lit while the movement component reports braking;
 *  - amber turn indicators that blink on the steered side.
 *
 * All positions are recomputed each frame from the vehicle's heading, so the
 * lights stay glued to the body at any rotation. The component reads the day
 * phase from the {@link DayNightSystem} through the service locator and
 * degrades to headlights-off when that system is unavailable.
 */
import Phaser from 'phaser';
import { Component } from '@/entities/Component';
import { ServiceLocator } from '@/core/ServiceLocator';
import { ServiceKeys } from '@/config/ServiceKeys';
import { TextureKeys } from '@/config/AssetKeys';
import { DepthLayers } from '@/config/DepthLayers';
import { DayPhase } from '@/core/types';
import { PALETTE } from '@/graphics/palette';
import type { VehicleDef } from '@/gameplay/types';
import { getPlayerRef } from '@/gameplay/types';
import type { VehicleMovementComponent } from './VehicleMovementComponent';

/** Blink period (ms) for turn indicators. */
const INDICATOR_PERIOD_MS = 640;
const EMERGENCY_PERIOD_MS = 180;

/** Steering input above which the indicators start blinking. */
const INDICATOR_STEER_THRESHOLD = 0.45;
const NIGHT_LIGHT_RENDER_RADIUS_SQ = 950 * 950;
const DAY_LIGHT_RENDER_RADIUS_SQ = 420 * 420;

/** Structural view of the day/night system (avoids a hard system import). */
interface DayPhaseProvider {
  readonly phase?: DayPhase;
}

export class VehicleLightsComponent extends Component {
  /** Component id within its host entity. */
  public readonly name = 'lights';

  private readonly def: VehicleDef;

  private movement: VehicleMovementComponent | null = null;

  private headGlows: Phaser.GameObjects.Image[] = [];
  private headCones: Phaser.GameObjects.Image[] = [];
  private brakeGlows: Phaser.GameObjects.Image[] = [];
  private indicators: Phaser.GameObjects.Image[] = [];
  private emergencyGlows: Phaser.GameObjects.Image[] = [];

  /** Elapsed ms accumulator driving the indicator blink. */
  private blinkClock = 0;

  constructor(def: VehicleDef) {
    super();
    this.def = def;
  }

  /** Cache siblings; light images are created lazily only when visible. */
  protected override onAttach(): void {
    this.movement = this.entity.getComponent<VehicleMovementComponent>('movement') ?? null;
  }

  private ensureLights(): void {
    if (this.headGlows.length > 0) return;
    const scene = this.entity.sprite.scene;

    const makeGlow = (tint: number, scale: number): Phaser.GameObjects.Image => {
      const img = scene.add.image(0, 0, TextureKeys.GlowSoft);
      img.setBlendMode(Phaser.BlendModes.ADD);
      img.setDepth(DepthLayers.VehicleLights);
      img.setTint(tint);
      img.setScale(scale);
      img.setVisible(false);
      return img;
    };

    if (!this.def.twoWheeler) {
      this.headGlows = [makeGlow(PALETTE.headlight, 0.5), makeGlow(PALETTE.headlight, 0.5)];
      this.brakeGlows = [makeGlow(PALETTE.brakeLight, 0.45), makeGlow(PALETTE.brakeLight, 0.45)];
      this.indicators = [makeGlow(PALETTE.indicator, 0.32), makeGlow(PALETTE.indicator, 0.32)];
      if (this.def.isEmergency) {
        this.emergencyGlows = [makeGlow(0xff3048, 0.46), makeGlow(0x3185ff, 0.46)];
      }
    } else {
      this.headGlows = [makeGlow(PALETTE.headlight, 0.4)];
      this.brakeGlows = [makeGlow(PALETTE.brakeLight, 0.35)];
      this.indicators = [];
    }

    for (let i = 0; i < this.headGlows.length; i++) {
      const cone = scene.add.image(0, 0, TextureKeys.HeadlightCone);
      cone.setBlendMode(Phaser.BlendModes.ADD);
      cone.setDepth(DepthLayers.VehicleLights);
      cone.setAlpha(0.22);
      cone.setVisible(false);
      this.headCones.push(cone);
    }
  }

  /** Reposition and toggle every light for this frame. */
  public override update(_time: number, delta: number): void {
    const movement = this.movement;
    const sprite = this.entity.sprite;
    if (!movement || !sprite.active) {
      this.hideAll();
      return;
    }
    const destroyed = (this.entity as unknown as { isDestroyed?: boolean }).isDestroyed === true;
    if (destroyed) {
      this.hideAll();
      return;
    }

    const night = this.isNight();
    const braking = movement.isBraking;
    const moving = Math.abs(movement.speed) > 4;
    const steering = movement.steerInput;
    const responseActive = sprite.getData('policeResponseActive') === true;
    if (!this.shouldRenderLights(night, braking, moving, steering, responseActive)) {
      this.hideAll();
      return;
    }
    this.ensureLights();
    this.blinkClock += delta;

    const heading = movement.heading;
    const fx = Math.cos(heading);
    const fy = Math.sin(heading);
    const rx = -fy;
    const ry = fx;

    const halfLen = this.def.height / 2 - 3;
    const halfWid = Math.max(2, this.def.width / 2 - 3);

    const blinkOn = this.blinkClock % INDICATOR_PERIOD_MS < INDICATOR_PERIOD_MS / 2;
    const emergencySide = Math.floor(this.blinkClock / EMERGENCY_PERIOD_MS) % 2;

    // Headlights + cones at the nose.
    for (let i = 0; i < this.headGlows.length; i++) {
      const glow = this.headGlows[i];
      const cone = this.headCones[i];
      if (!glow || !cone) continue;
      const side = this.headGlows.length === 1 ? 0 : i === 0 ? -1 : 1;
      const x = sprite.x + fx * halfLen + rx * halfWid * side;
      const y = sprite.y + fy * halfLen + ry * halfWid * side;
      glow.setPosition(x, y);
      glow.setVisible(night);
      cone.setPosition(x + fx * 22, y + fy * 22);
      cone.setRotation(heading + Math.PI / 2);
      cone.setVisible(night && moving);
    }

    // Brake lights at the tail.
    for (let i = 0; i < this.brakeGlows.length; i++) {
      const glow = this.brakeGlows[i];
      if (!glow) continue;
      const side = this.brakeGlows.length === 1 ? 0 : i === 0 ? -1 : 1;
      glow.setPosition(
        sprite.x - fx * halfLen + rx * halfWid * side,
        sprite.y - fy * halfLen + ry * halfWid * side,
      );
      glow.setVisible(braking || (night && !moving));
      glow.setAlpha(braking ? 1 : 0.55);
    }

    // Turn indicators: front + rear on the steered side.
    if (this.indicators.length === 2) {
      const active = Math.abs(steering) >= INDICATOR_STEER_THRESHOLD && moving;
      const side = steering >= 0 ? 1 : -1;
      const front = this.indicators[0];
      const rear = this.indicators[1];
      if (front && rear) {
        front.setPosition(
          sprite.x + fx * halfLen + rx * halfWid * side,
          sprite.y + fy * halfLen + ry * halfWid * side,
        );
        rear.setPosition(
          sprite.x - fx * halfLen + rx * halfWid * side,
          sprite.y - fy * halfLen + ry * halfWid * side,
        );
        const visible = active && blinkOn;
        front.setVisible(visible);
        rear.setVisible(visible);
      }
    }

    if (this.emergencyGlows.length === 2) {
      const left = this.emergencyGlows[0];
      const right = this.emergencyGlows[1];
      if (left && right) {
        left.setPosition(sprite.x - rx * halfWid * 0.48, sprite.y - ry * halfWid * 0.48);
        right.setPosition(sprite.x + rx * halfWid * 0.48, sprite.y + ry * halfWid * 0.48);
        left.setVisible(responseActive && emergencySide === 0);
        right.setVisible(responseActive && emergencySide === 1);
      }
    }
  }

  private shouldRenderLights(
    night: boolean,
    braking: boolean,
    moving: boolean,
    steering: number,
    responseActive: boolean,
  ): boolean {
    if (this.entity.sprite.getData('playerDriven') === true) return true;
    const player = getPlayerRef()?.playerPosition;
    if (!player) return false;
    const dx = this.entity.sprite.x - player.x;
    const dy = this.entity.sprite.y - player.y;
    const distSq = dx * dx + dy * dy;
    if (responseActive) return distSq <= NIGHT_LIGHT_RENDER_RADIUS_SQ;
    if (night) return distSq <= NIGHT_LIGHT_RENDER_RADIUS_SQ;
    const activeDaySignal = braking || (moving && Math.abs(steering) >= INDICATOR_STEER_THRESHOLD);
    return activeDaySignal && distSq <= DAY_LIGHT_RENDER_RADIUS_SQ;
  }

  /** Hide every owned light image. */
  private hideAll(): void {
    for (const img of this.headGlows) img.setVisible(false);
    for (const img of this.headCones) img.setVisible(false);
    for (const img of this.brakeGlows) img.setVisible(false);
    for (const img of this.indicators) img.setVisible(false);
    for (const img of this.emergencyGlows) img.setVisible(false);
  }

  public reset(): void {
    this.hideAll();
  }

  /** Whether ambient light calls for headlights (dusk or night). */
  private isNight(): boolean {
    const dayNight = ServiceLocator.tryResolve(
      ServiceKeys.DayNight,
    ) as unknown as DayPhaseProvider | null;
    const phase = dayNight?.phase;
    return phase === DayPhase.Night || phase === DayPhase.Dusk;
  }

  /** Destroy every owned image alongside the component. */
  public override destroy(): void {
    for (const img of this.headGlows) img.destroy();
    for (const img of this.headCones) img.destroy();
    for (const img of this.brakeGlows) img.destroy();
    for (const img of this.indicators) img.destroy();
    for (const img of this.emergencyGlows) img.destroy();
    this.headGlows = [];
    this.headCones = [];
    this.brakeGlows = [];
    this.indicators = [];
    this.emergencyGlows = [];
    this.movement = null;
    super.destroy();
  }
}
