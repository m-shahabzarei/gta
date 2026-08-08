/**
 * DayNightSystem — the authoritative in-game clock and ambient-lighting driver.
 *
 * It advances a single normalised `dayFraction` (0..1 of a full day) while the
 * game is actively playing, converts that into an hour/minute plus a coarse
 * {@link DayPhase}, and broadcasts three events on the shared bus:
 *  - {@link EventKeys.TimeChanged} whenever the displayed minute rolls over;
 *  - {@link EventKeys.TimePhaseChanged} when the day phase transitions;
 *  - {@link EventKeys.LightingChanged} with an ambient colour + alpha that the
 *    {@link LightingSystem} renders as a screen overlay.
 *
 * The system is purely logical (no Phaser objects) and persists its clock via
 * {@link ISerializable} so save/load round-trips the world time.
 */
import type { ISerializable } from '@/core/interfaces';
import type { Json } from '@/core/types';
import { DayPhase, GameState, hourToPhase } from '@/core/types';
import { EventKeys } from '@/config/EventKeys';
import { ServiceKeys } from '@/config/ServiceKeys';
import { TIME } from '@/config/Constants';
import { ServiceLocator } from '@/core/ServiceLocator';
import { clamp, hexToRgb, lerp } from '@/utils';
import { BaseManager } from '@/core/BaseManager';

/** Ambient overlay colours (0xRRGGBB) that anchor the lighting curve. */
const NIGHT_COLOR = 0x172744;
const WARM_COLOR = 0x8a553d;

/** Overlay alpha at the deepest point of night. */
const NIGHT_ALPHA = 0.46;

/** Overlay alpha at the warm dawn/dusk peaks. */
const WARM_ALPHA = 0.2;

/** A resolved ambient overlay: a tint colour and its opacity. */
interface Ambient {
  color: number;
  alpha: number;
}

export class DayNightSystem extends BaseManager implements ISerializable {
  /** Service-locator key for this system. */
  public readonly key = ServiceKeys.DayNight;

  /** Save section id under which the clock is persisted. */
  public readonly saveId = 'time';

  /** Fraction of the current day elapsed, in the range [0, 1). */
  private dayFraction = TIME.START_HOUR / 24;

  /** When true, the clock is frozen regardless of game state. */
  private pausedFlag = false;

  /** Last minute value emitted, used to throttle {@link EventKeys.TimeChanged}. */
  private lastEmittedMinute = -1;

  /** Last phase emitted, used to throttle {@link EventKeys.TimePhaseChanged}. */
  private lastPhase: DayPhase | null = null;

  /** Last ambient colour/alpha emitted, used to throttle lighting updates. */
  private lastAmbientColor = -1;
  private lastAmbientAlpha = -1;

  /** Emit the initial time, phase and lighting so listeners start in sync. */
  protected onInit(): void {
    this.emitAll();
  }

  /** Current in-game hour (0–23), recomputed from {@link dayFraction}. */
  public get hour(): number {
    return Math.floor(this.dayFraction * 24);
  }

  /** Current in-game minute (0–59), recomputed from {@link dayFraction}. */
  public get minute(): number {
    const total = this.dayFraction * 24;
    return Math.floor((total - Math.floor(total)) * 60);
  }

  /** The coarse day phase for the current hour. */
  public get phase(): DayPhase {
    return hourToPhase(this.hour);
  }

  /** A zero-padded `HH:MM` label for HUD display. */
  public getTimeLabel(): string {
    const hh = this.hour.toString().padStart(2, '0');
    const mm = this.minute.toString().padStart(2, '0');
    return `${hh}:${mm}`;
  }

  /**
   * Jump the clock to a specific time, forcing a fresh emit of all events.
   * @param hour Target hour (wrapped into 0–24).
   * @param minute Target minute within the hour (default 0).
   */
  public setTime(hour: number, minute = 0): void {
    const wrappedHour = ((hour % 24) + 24) % 24;
    this.dayFraction = clamp((wrappedHour + minute / 60) / 24, 0, 1);
    this.lastEmittedMinute = -1;
    this.lastAmbientColor = -1;
    this.lastAmbientAlpha = -1;
    this.lastPhase = null;
    this.emitAll();
  }

  /** Freeze the clock; {@link update} becomes a no-op until {@link resume}. */
  public pause(): void {
    this.pausedFlag = true;
  }

  /** Resume advancing the clock. */
  public resume(): void {
    this.pausedFlag = false;
  }

  /**
   * Advance the clock. Only runs while unpaused and the game is actively
   * playing, so time does not pass in menus or while the world is paused.
   * @param _time Absolute timestamp (unused).
   * @param delta Milliseconds since the previous frame.
   */
  public update(_time: number, delta: number): void {
    if (this.pausedFlag) return;
    const gm = ServiceLocator.tryResolve(ServiceKeys.Game) as { state?: GameState } | null;
    if (gm && gm.state !== GameState.Playing) return;
    this.dayFraction = (this.dayFraction + delta / 1000 / TIME.SECONDS_PER_DAY) % 1;
    this.emitAll();
  }

  /** Snapshot the clock for persistence. */
  public serialize(): Json {
    return { dayFraction: this.dayFraction };
  }

  /**
   * Restore the clock from a snapshot and re-emit derived state.
   * @param data A value previously produced by {@link serialize}.
   */
  public deserialize(data: Json): void {
    if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
      const raw = data.dayFraction;
      if (typeof raw === 'number' && Number.isFinite(raw)) {
        this.dayFraction = clamp(raw, 0, 1);
      }
    }
    this.lastEmittedMinute = -1;
    this.lastAmbientColor = -1;
    this.lastAmbientAlpha = -1;
    this.lastPhase = null;
    this.emitAll();
  }

  /** Recompute derived state and broadcast any values that changed. */
  private emitAll(): void {
    const total = this.dayFraction * 24;
    const hour = Math.floor(total);
    const minute = Math.floor((total - hour) * 60);

    if (minute !== this.lastEmittedMinute) {
      this.bus.emit(EventKeys.TimeChanged, {
        hour,
        minute,
        normalized: this.dayFraction,
      });
      this.lastEmittedMinute = minute;
    }

    const phase = hourToPhase(hour);
    if (phase !== this.lastPhase) {
      this.bus.emit(EventKeys.TimePhaseChanged, { phase });
      this.lastPhase = phase;
    }

    // Only emit lighting when the ambient meaningfully changes, so the overlay
    // is not restyled ~60 times per second.
    const ambient = this.computeAmbient(total);
    if (
      ambient.color !== this.lastAmbientColor ||
      Math.abs(ambient.alpha - this.lastAmbientAlpha) > 0.004
    ) {
      this.lastAmbientColor = ambient.color;
      this.lastAmbientAlpha = ambient.alpha;
      this.bus.emit(EventKeys.LightingChanged, {
        ambient: ambient.color,
        tint: ambient.alpha,
      });
    }
  }

  /**
   * Map a continuous hour (0–24) to an ambient overlay via a piecewise curve:
   * deep, cool night around midnight; a warm dawn ramp; a fully transparent
   * daytime band; a warm dusk ramp; then back into night.
   * @param hour Continuous hour in the [0, 24) range.
   */
  private computeAmbient(hour: number): Ambient {
    // Deep night before dawn.
    if (hour < 4) return { color: NIGHT_COLOR, alpha: NIGHT_ALPHA };

    // Dawn: night → warm.
    if (hour < 6.5) {
      const t = (hour - 4) / (6.5 - 4);
      return {
        color: this.lerpColor(NIGHT_COLOR, WARM_COLOR, t),
        alpha: lerp(NIGHT_ALPHA, WARM_ALPHA, t),
      };
    }

    // Dawn: warm → clear daylight.
    if (hour < 9) {
      const t = (hour - 6.5) / (9 - 6.5);
      return { color: WARM_COLOR, alpha: lerp(WARM_ALPHA, 0, t) };
    }

    // Full daylight — no overlay.
    if (hour < 16) return { color: WARM_COLOR, alpha: 0 };

    // Dusk: clear → warm.
    if (hour < 18.5) {
      const t = (hour - 16) / (18.5 - 16);
      return { color: WARM_COLOR, alpha: lerp(0, WARM_ALPHA, t) };
    }

    // Dusk: warm → night.
    if (hour < 21) {
      const t = (hour - 18.5) / (21 - 18.5);
      return {
        color: this.lerpColor(WARM_COLOR, NIGHT_COLOR, t),
        alpha: lerp(WARM_ALPHA, NIGHT_ALPHA, t),
      };
    }

    // Deep night after dusk.
    return { color: NIGHT_COLOR, alpha: NIGHT_ALPHA };
  }

  /**
   * Linearly interpolate between two packed 0xRRGGBB colours.
   * @param from Start colour.
   * @param to End colour.
   * @param t Blend factor in [0, 1].
   */
  private lerpColor(from: number, to: number, t: number): number {
    const a = hexToRgb(from);
    const b = hexToRgb(to);
    const r = Math.round(lerp(a.r, b.r, t)) & 0xff;
    const g = Math.round(lerp(a.g, b.g, t)) & 0xff;
    const blue = Math.round(lerp(a.b, b.b, t)) & 0xff;
    return (r << 16) | (g << 8) | blue;
  }
}
