/**
 * WeatherSystem — a scene-bound engine system that renders dynamic weather as a
 * set of camera-pinned particle emitters and overlays sitting on the dedicated
 * {@link DepthLayers.Weather} layer.
 *
 * It reacts to two signals: {@link EventKeys.WeatherChanged} switches the active
 * {@link WeatherMode}, and {@link EventKeys.SettingsChanged} re-reads the graphics
 * quality (which gates particle density) alongside the persisted weather mode.
 * Each mode is a self-contained bundle of emitters/overlays that {@link rebuild}
 * tears down and recreates for the current mode and quality.
 *
 * Modes:
 *  - {@link WeatherMode.Rain} — a dense, high-velocity blue-grey streak emitter
 *    spawned across the top of the screen.
 *  - {@link WeatherMode.Fog} — several large, low-alpha drifting smoke puffs plus
 *    a faint full-screen tinted wash whose opacity breathes over time.
 *  - {@link WeatherMode.Clear} — no precipitation.
 *
 * A light ambient dust/leaf drift layer is always added on top (except on the
 * lowest quality preset, which disables it), and a constant horizontal wind is
 * baked into the drift of rain, dust and leaves. Nothing here darkens the scene
 * directly — that stays the {@link LightingSystem}'s job — so the emitters only
 * add colour and motion, never a fighting full-screen dim.
 */
import Phaser from 'phaser';
import { BaseSceneManager } from '@/core/BaseSceneManager';
import { ServiceLocator } from '@/core/ServiceLocator';
import { ServiceKeys } from '@/config/ServiceKeys';
import { EventKeys } from '@/config/EventKeys';
import { TextureKeys } from '@/config/AssetKeys';
import { DepthLayers } from '@/config/DepthLayers';
import { GAME_WIDTH, GAME_HEIGHT } from '@/config/Constants';
import { GraphicsQuality, WeatherMode, QUALITY_PARTICLE_SCALE } from '@/config/Settings';
import type { GameSettings } from '@/config/Settings';
import { getPlayerRef } from '@/gameplay/types';
import type { ParticleManager } from '@/managers/ParticleManager';

/** Shorthand for the concrete particle-emitter type returned by `add.particles`. */
type Emitter = Phaser.GameObjects.Particles.ParticleEmitter;

/** Horizontal wind drift (px/sec) applied to ambient dust and leaves. */
const WIND_AMBIENT_X = 26;

/** Horizontal wind drift (px/sec) that slants falling rain. */
const WIND_RAIN_X = 120;

/** Horizontal crawl speed (px/sec) of the big fog puffs. */
const FOG_SPEED_X = 22;

/** Blue-grey tint applied to rain streaks. */
const RAIN_TINT = 0x9fb4c8;

/** Warm dust/leaf tint for the always-on ambient drift. */
const DUST_TINT = 0xbfae7a;

/** Cool grey tint for the fog puffs and full-screen wash. */
const FOG_TINT = 0xb8c0c8;

/** Base opacity of the faint full-screen fog wash. */
const FOG_RECT_ALPHA = 0.12;

/** Rain particles emitted per pulse at full (High) quality. */
const RAIN_QUANTITY = 3;

/** Emission interval (ms) between rain pulses. */
const RAIN_FREQUENCY = 16;

/** Cool white-blue tint applied to falling snow. */
const SNOW_TINT = 0xe8f0ff;

/** Minimum / maximum gap (ms) between thunder strikes during a storm. */
const THUNDER_MIN_MS = 6000;
const THUNDER_MAX_MS = 15000;

/** Interval (ms) between rain/storm ground-splash bursts. */
const SPLASH_INTERVAL_MS = 90;
/** Time spent crossing a regional boundary before its climate fully takes hold. */
const REGION_TRANSITION_MS = 1800;

export class WeatherSystem extends BaseSceneManager {
  /** Service-locator key for this system. */
  public readonly key = ServiceKeys.Weather;

  /** Every live emitter for the current mode, torn down on rebuild/detach. */
  private readonly emitters: Emitter[] = [];

  /** Every live overlay rectangle, torn down on rebuild/detach. */
  private readonly overlays: Phaser.GameObjects.Rectangle[] = [];

  /** The full-screen fog wash whose alpha breathes each frame, when present. */
  private fogRect: Phaser.GameObjects.Rectangle | null = null;

  /** The weather currently being rendered. */
  private currentMode: WeatherMode = WeatherMode.Clear;

  /** The graphics-quality preset gating particle density. */
  private quality: GraphicsQuality = GraphicsQuality.High;

  /** Countdown (ms) to the next thunder strike (storm only). */
  private thunderMs = 0;

  /** Accumulator (ms) for the rain/storm splash cadence. */
  private splashMs = 0;

  /** Climate selected by the current city/biome, applied after a soft handoff. */
  private regionalTarget: WeatherMode | null = null;
  private regionalTransitionMs = 0;
  private particles: ParticleManager | null = null;

  /** The active weather mode. */
  public get mode(): WeatherMode {
    return this.currentMode;
  }

  /** Subscribe to weather and settings changes for the lifetime of the system. */
  protected onInit(): void {
    this.subscribe(EventKeys.WeatherChanged, (payload) => {
      this.setWeather(payload.weather);
    });
    this.subscribe(EventKeys.SettingsChanged, (payload) => {
      this.quality = payload.settings.quality;
      this.setWeather(payload.settings.weather);
    });
    this.log.debug('weather system ready');
  }

  /**
   * Read the persisted mode/quality from the SettingsManager (guarded) and build
   * the emitters for the attached scene.
   */
  protected onAttach(_scene: Phaser.Scene): void {
    this.particles = ServiceLocator.tryResolve<ParticleManager>(ServiceKeys.Particle);
    const settings = this.readSettings();
    this.quality = settings?.quality ?? GraphicsQuality.High;
    this.currentMode = settings?.weather ?? WeatherMode.Clear;
    this.rebuild();
  }

  /** Destroy every scene-scoped emitter and overlay on scene shutdown. */
  protected override onDetach(_scene: Phaser.Scene): void {
    this.teardown();
    this.particles = null;
  }

  /**
   * Switch the rendered weather. Stores the mode and, when attached, rebuilds the
   * emitters so the change is reflected immediately.
   * @param mode The weather mode to render.
   */
  public setWeather(mode: WeatherMode): void {
    this.currentMode = mode;
    if (this.scene) this.rebuild();
    this.log.debug(`weather -> ${mode} @ ${this.quality}`);
  }

  /**
   * Per-frame: breathe the fog wash, tick storm thunder, and spatter rain
   * splashes across the ground while it is raining.
   * @param time Absolute scene time in ms.
   * @param delta Elapsed time since the previous frame in ms.
   */
  public update(time: number, delta: number): void {
    this.updateRegionalClimate(delta);
    if (this.fogRect) {
      const pulse = 0.75 + 0.25 * Math.sin(time / 2600);
      this.fogRect.setAlpha(FOG_RECT_ALPHA * pulse);
    }

    if (this.currentMode === WeatherMode.Storm) {
      this.tickThunder(delta);
    }
    if (this.currentMode === WeatherMode.Rain || this.currentMode === WeatherMode.Storm) {
      this.tickSplashes(delta);
    }
  }

  /** Blend toward the climate of the city or biome the player is driving through. */
  private updateRegionalClimate(delta: number): void {
    const position = getPlayerRef()?.playerPosition ?? null;
    if (!position) return;
    const world = ServiceLocator.tryResolve(ServiceKeys.World) as {
      weatherAt?(x: number, y: number): WeatherMode;
    } | null;
    const target = world?.weatherAt?.(position.x, position.y) ?? WeatherMode.Clear;
    if (target !== this.regionalTarget) {
      this.regionalTarget = target;
      this.regionalTransitionMs = 0;
      return;
    }
    if (target === this.currentMode) return;
    this.regionalTransitionMs += delta;
    if (this.regionalTransitionMs < REGION_TRANSITION_MS) return;
    this.regionalTransitionMs = 0;
    this.bus.emit(EventKeys.WeatherChanged, { weather: target });
  }

  /**
   * Tear down the current effects and recreate them for {@link currentMode} at
   * the active {@link quality}. The ambient drift layer is added for every mode.
   */
  private rebuild(): void {
    const scene = this.scene;
    if (!scene) return;

    this.teardown();

    switch (this.currentMode) {
      case WeatherMode.Rain:
        this.buildRain(scene, false);
        break;
      case WeatherMode.Storm:
        this.buildRain(scene, true);
        this.armThunder();
        break;
      case WeatherMode.Fog:
        this.buildFog(scene);
        break;
      case WeatherMode.Snow:
        this.buildSnow(scene);
        break;
      case WeatherMode.Clear:
        break;
    }

    this.buildAmbient(scene);
  }

  /** Destroy and forget every emitter and overlay. */
  private teardown(): void {
    for (const emitter of this.emitters) emitter.destroy();
    this.emitters.length = 0;
    for (const overlay of this.overlays) overlay.destroy();
    this.overlays.length = 0;
    this.fogRect = null;
  }

  /**
   * Build the driving rainstorm: fast, wind-slanted blue-grey streaks spawned
   * along the top edge with a short lifespan, at a density scaled by quality.
   * A storm doubles the density and drops a darker sky wash.
   * @param scene The attached scene.
   * @param storm Whether this is a full thunderstorm (heavier + darker).
   */
  private buildRain(scene: Phaser.Scene, storm: boolean): void {
    const scale = QUALITY_PARTICLE_SCALE[this.quality];
    const quantity = Math.max(1, Math.round(RAIN_QUANTITY * scale * (storm ? 2.2 : 1)));

    if (storm) {
      const wash = scene.add.rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, 0x1a2230, 1);
      wash.setOrigin(0, 0);
      wash.setScrollFactor(0);
      wash.setDepth(DepthLayers.Weather);
      wash.setAlpha(0.22);
      this.overlays.push(wash);
    }

    const rain = scene.add.particles(0, 0, TextureKeys.Spark, {
      x: { min: -60, max: GAME_WIDTH + 60 },
      y: -24,
      lifespan: storm ? 640 : 720,
      speedX: { min: WIND_RAIN_X * 0.6, max: WIND_RAIN_X * (storm ? 1.4 : 1) },
      speedY: { min: storm ? 1100 : 900, max: storm ? 1400 : 1180 },
      accelerationX: WIND_RAIN_X * 0.4,
      scaleX: 0.35,
      scaleY: { min: 2.2, max: storm ? 4.4 : 3.6 },
      alpha: { start: storm ? 0.7 : 0.55, end: 0.15 },
      tint: RAIN_TINT,
      quantity,
      frequency: RAIN_FREQUENCY,
      blendMode: Phaser.BlendModes.NORMAL,
    });
    this.registerEmitter(rain);
  }

  /**
   * Build a snowfall: slow, wind-drifted flakes tumbling from the top edge.
   * @param scene The attached scene.
   */
  private buildSnow(scene: Phaser.Scene): void {
    const scale = QUALITY_PARTICLE_SCALE[this.quality];
    const quantity = Math.max(1, Math.round(2 * scale));

    // A faint cool wash for the wintry cast.
    const wash = scene.add.rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, 0xdfe8f5, 1);
    wash.setOrigin(0, 0);
    wash.setScrollFactor(0);
    wash.setDepth(DepthLayers.Weather);
    wash.setAlpha(0.08);
    this.overlays.push(wash);

    const snow = scene.add.particles(0, 0, TextureKeys.Snowflake, {
      x: { min: -40, max: GAME_WIDTH + 40 },
      y: -16,
      lifespan: 6500,
      speedX: { min: -WIND_AMBIENT_X, max: WIND_AMBIENT_X * 2 },
      speedY: { min: 70, max: 150 },
      accelerationX: { min: -12, max: 12 },
      scale: { min: 0.5, max: 1.2 },
      alpha: { start: 0.9, end: 0.5 },
      tint: SNOW_TINT,
      rotate: { min: 0, max: 360 },
      quantity,
      frequency: 40,
      blendMode: Phaser.BlendModes.NORMAL,
    });
    this.registerEmitter(snow);
  }

  /**
   * Build the fog bank: a handful of large, very-low-alpha smoke puffs crawling
   * across the screen on the wind, plus a faint full-screen tinted wash.
   * @param scene The attached scene.
   */
  private buildFog(scene: Phaser.Scene): void {
    const scale = QUALITY_PARTICLE_SCALE[this.quality];

    const wash = scene.add.rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, FOG_TINT, 1);
    wash.setOrigin(0, 0);
    wash.setScrollFactor(0);
    wash.setDepth(DepthLayers.Weather);
    wash.setBlendMode(Phaser.BlendModes.NORMAL);
    wash.setAlpha(FOG_RECT_ALPHA);
    this.overlays.push(wash);
    this.fogRect = wash;

    const puffs = scene.add.particles(0, 0, TextureKeys.Smoke, {
      x: { min: -160, max: -60 },
      y: { min: -40, max: GAME_HEIGHT + 40 },
      lifespan: 16000,
      speedX: { min: FOG_SPEED_X * 0.6, max: FOG_SPEED_X + WIND_AMBIENT_X },
      speedY: { min: -6, max: 6 },
      scale: { min: 3.5, max: 6.5 },
      alpha: 0.1,
      tint: FOG_TINT,
      quantity: 1,
      frequency: Math.max(600, Math.round(1400 / scale)),
      blendMode: Phaser.BlendModes.NORMAL,
    });
    this.registerEmitter(puffs);
  }

  /**
   * Build the always-on ambient dust/leaf drift: a low-rate scatter of small,
   * warm-tinted motes carried on the wind across the whole screen. Disabled on
   * the lowest quality preset.
   * @param scene The attached scene.
   */
  private buildAmbient(scene: Phaser.Scene): void {
    if (this.quality === GraphicsQuality.Low) return;
    const scale = QUALITY_PARTICLE_SCALE[this.quality];

    const dust = scene.add.particles(0, 0, TextureKeys.Spark, {
      x: { min: -40, max: GAME_WIDTH },
      y: { min: 0, max: GAME_HEIGHT },
      lifespan: 7000,
      speedX: { min: WIND_AMBIENT_X * 0.5, max: WIND_AMBIENT_X * 1.5 },
      speedY: { min: -8, max: 16 },
      accelerationX: WIND_AMBIENT_X * 0.5,
      scale: { min: 0.14, max: 0.4 },
      alpha: { start: 0.35, end: 0 },
      tint: DUST_TINT,
      quantity: 1,
      frequency: Math.max(140, Math.round(520 / scale)),
      blendMode: Phaser.BlendModes.NORMAL,
    });
    this.registerEmitter(dust);
  }

  /** Pin an emitter to the camera at the weather depth and track it for teardown. */
  private registerEmitter(emitter: Emitter): void {
    emitter.setScrollFactor(0);
    emitter.setDepth(DepthLayers.Weather);
    this.emitters.push(emitter);
  }

  /** Arm the first thunder strike a few seconds after a storm begins. */
  private armThunder(): void {
    this.thunderMs = THUNDER_MIN_MS + Math.random() * (THUNDER_MAX_MS - THUNDER_MIN_MS);
  }

  /**
   * Count down to the next thunder strike; on strike, flash the sky via the
   * lighting system and announce {@link EventKeys.ThunderStrike} for audio.
   * @param delta Elapsed time since the previous frame in ms.
   */
  private tickThunder(delta: number): void {
    this.thunderMs -= delta;
    if (this.thunderMs > 0) return;
    this.armThunder();

    const intensity = 0.5 + Math.random() * 0.5;
    const lighting = ServiceLocator.tryResolve(ServiceKeys.Lighting) as unknown as {
      flash?(color: number, durationMs: number): void;
    } | null;
    lighting?.flash?.(0xdfe8ff, 180);
    // A quick double-flash for the biggest strikes.
    if (intensity > 0.8) {
      const scene = this.scene;
      scene?.time.delayedCall(140, () => lighting?.flash?.(0xdfe8ff, 120));
    }
    this.bus.emit(EventKeys.ThunderStrike, { intensity });
  }

  /**
   * Spatter a few expanding rain-splash rings at random screen positions while
   * it rains, so the ground reads as wet.
   * @param delta Elapsed time since the previous frame in ms.
   */
  private tickSplashes(delta: number): void {
    if (this.quality === GraphicsQuality.Low) return;
    const scene = this.scene;
    if (!scene) return;
    this.splashMs += delta;
    if (this.splashMs < SPLASH_INTERVAL_MS) return;
    this.splashMs = 0;

    const count = this.currentMode === WeatherMode.Storm ? 3 : 2;
    for (let i = 0; i < count; i++) {
      const x = Math.random() * GAME_WIDTH;
      const y = Math.random() * GAME_HEIGHT;
      const ring = this.particles?.acquireImage(TextureKeys.Ring, x, y, 400) ??
        scene.add.image(x, y, TextureKeys.Ring);
      ring.setScrollFactor(0);
      ring.setDepth(DepthLayers.Weather);
      ring.setTint(RAIN_TINT);
      ring.setScale(0.2);
      ring.setAlpha(0.5);
      scene.tweens.add({
        targets: ring,
        scale: 0.7,
        alpha: 0,
        duration: 300,
        onComplete: () => {
          if (this.particles) this.particles.releaseImage(ring);
          else ring.destroy();
        },
      });
    }
  }

  /**
   * Read the current settings from the registered SettingsManager without a hard
   * compile-time dependency on it (it is registered independently at bootstrap).
   * @returns The live settings, or `null` when the manager is unavailable.
   */
  private readSettings(): GameSettings | null {
    const service = ServiceLocator.tryResolve(ServiceKeys.Settings);
    return (service as unknown as { settings?: GameSettings } | null)?.settings ?? null;
  }
}
