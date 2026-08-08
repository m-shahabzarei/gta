/**
 * SettingsManager — the single source of truth for user preferences.
 *
 * It owns a {@link GameSettings} record (audio, graphics quality, weather,
 * display and language) and is responsible for three things:
 *  - persisting the settings to its OWN `localStorage` key, independently of the
 *    game's save slots, so preferences survive across fresh games;
 *  - applying every setting to the live engine (audio volumes/mute, active UI
 *    language, weather mode and browser fullscreen);
 *  - broadcasting changes on the {@link EventBus} so the settings UI, weather
 *    system and audio managers stay in sync.
 *
 * It also implements {@link ISerializable} so the current preferences travel
 * inside a game save; `deserialize` merges the persisted snapshot over the
 * factory defaults and re-applies everything.
 */
import { BaseManager } from '@/core/BaseManager';
import { ServiceLocator } from '@/core/ServiceLocator';
import { ServiceKeys } from '@/config/ServiceKeys';
import { EventKeys } from '@/config/EventKeys';
import {
  DEFAULT_SETTINGS,
  GraphicsQuality,
  Language,
  WeatherMode,
} from '@/config/Settings';
import type { GameSettings } from '@/config/Settings';
import { setLanguage } from '@/config/Strings';
import { clamp } from '@/utils';
import type { ISerializable } from '@/core/interfaces';
import type { Json } from '@/core/types';
import type { SoundManager } from '@/managers/SoundManager';
import type { MusicManager } from '@/managers/MusicManager';

/**
 * Owns, persists and applies the user's {@link GameSettings}.
 */
export class SettingsManager extends BaseManager implements ISerializable {
  /** Service-locator identity for this manager. */
  public readonly key = ServiceKeys.Settings;

  /** Save-section id under which preferences are embedded in a game save. */
  public readonly saveId = 'settings';

  /** Dedicated `localStorage` key, kept separate from the save slots. */
  private static readonly STORAGE_KEY = 'pixel-city:settings';

  /** The live settings state; starts as a copy of the factory defaults. */
  private currentSettings: GameSettings = { ...DEFAULT_SETTINGS };

  /**
   * Load any persisted preferences over the defaults, then push every value
   * through to the engine so the game starts in the user's configured state.
   */
  protected onInit(): void {
    const persisted = this.loadPersisted();
    this.currentSettings = { ...DEFAULT_SETTINGS, ...persisted };
    this.applyAll();
  }

  /** The current settings as a read-only view. */
  public get settings(): Readonly<GameSettings> {
    return this.currentSettings;
  }

  /**
   * Merge a partial update into the current settings, persist it, apply every
   * value to the engine and broadcast {@link EventKeys.SettingsChanged}.
   */
  public change(partial: Partial<GameSettings>): void {
    this.currentSettings = { ...this.currentSettings, ...partial };
    this.persist();
    this.applyAll();
    this.bus.emit(EventKeys.SettingsChanged, { settings: this.currentSettings });
  }

  /** Set the master output volume (0..1). */
  public setMasterVolume(v: number): void {
    this.change({ masterVolume: clamp(v, 0, 1) });
  }

  /** Set the music channel volume (0..1). */
  public setMusicVolume(v: number): void {
    this.change({ musicVolume: clamp(v, 0, 1) });
  }

  /** Set the sound-effects channel volume (0..1). */
  public setSfxVolume(v: number): void {
    this.change({ sfxVolume: clamp(v, 0, 1) });
  }

  /** Flip the global mute flag. */
  public toggleMute(): void {
    this.change({ muted: !this.currentSettings.muted });
  }

  /** Select a graphics-quality preset. */
  public setQuality(q: GraphicsQuality): void {
    this.change({ quality: q });
  }

  /** Select the active weather mode. */
  public setWeather(w: WeatherMode): void {
    this.change({ weather: w });
  }

  /** Select the active UI language. */
  public setLanguage(l: Language): void {
    this.change({ language: l });
  }

  /** Toggle whether camera screen-shake is permitted. */
  public toggleScreenShake(): void {
    this.change({ screenShake: !this.currentSettings.screenShake });
  }

  /** Toggle the advisory vsync flag. */
  public toggleVsync(): void {
    this.change({ vsync: !this.currentSettings.vsync });
  }

  /**
   * Toggle browser fullscreen. Safe to call directly from a click handler —
   * the underlying request needs a user gesture and is guarded by
   * {@link applyAll}'s try/catch.
   */
  public toggleFullscreen(): void {
    this.change({ fullscreen: !this.currentSettings.fullscreen });
  }

  /** Update bounded mobile control tuning without exposing raw settings mutation. */
  public setMobileControls(partial: Partial<Pick<GameSettings,
    | 'mobileControlOpacity'
    | 'mobileControlScale'
    | 'mobileJoystickScale'
    | 'mobileMoveSensitivity'
    | 'mobileAimSensitivity'
    | 'mobileJoystickOffsetX'
    | 'mobileJoystickOffsetY'
    | 'mobileVibration'
  >>): void {
    const next: Partial<GameSettings> = {};
    if (partial.mobileControlOpacity !== undefined) next.mobileControlOpacity = clamp(partial.mobileControlOpacity, 0.3, 0.9);
    if (partial.mobileControlScale !== undefined) next.mobileControlScale = clamp(partial.mobileControlScale, 0.8, 1.25);
    if (partial.mobileJoystickScale !== undefined) next.mobileJoystickScale = clamp(partial.mobileJoystickScale, 0.8, 1.25);
    if (partial.mobileMoveSensitivity !== undefined) next.mobileMoveSensitivity = clamp(partial.mobileMoveSensitivity, 0.7, 1.3);
    if (partial.mobileAimSensitivity !== undefined) next.mobileAimSensitivity = clamp(partial.mobileAimSensitivity, 0.7, 1.5);
    if (partial.mobileJoystickOffsetX !== undefined) next.mobileJoystickOffsetX = clamp(partial.mobileJoystickOffsetX, -0.12, 0.12);
    if (partial.mobileJoystickOffsetY !== undefined) next.mobileJoystickOffsetY = clamp(partial.mobileJoystickOffsetY, -0.12, 0.12);
    if (partial.mobileVibration !== undefined) next.mobileVibration = partial.mobileVibration;
    this.change(next);
  }

  /**
   * Push every setting through to the engine: audio volumes/mute, active UI
   * language, weather mode and browser fullscreen. Each side effect is guarded
   * so a missing service or a rejected fullscreen request never throws.
   */
  public applyAll(): void {
    const s = this.currentSettings;

    // ── Audio ────────────────────────────────────────────────────────────
    const sound = ServiceLocator.tryResolve<SoundManager>(ServiceKeys.Sound);
    if (sound) {
      sound.setVolume(s.sfxVolume * s.masterVolume);
      sound.setMuted(s.muted);
    }
    const music = ServiceLocator.tryResolve<MusicManager>(ServiceKeys.Music);
    if (music) {
      music.setVolume(s.musicVolume * s.masterVolume);
    }
    this.bus.emit(EventKeys.AudioVolumeChanged, {
      channel: 'master',
      volume: s.masterVolume,
    });
    this.bus.emit(EventKeys.AudioVolumeChanged, {
      channel: 'music',
      volume: s.musicVolume * s.masterVolume,
    });
    this.bus.emit(EventKeys.AudioVolumeChanged, {
      channel: 'sfx',
      volume: s.sfxVolume * s.masterVolume,
    });
    this.bus.emit(EventKeys.AudioMuteToggled, { muted: s.muted });

    // ── Language ─────────────────────────────────────────────────────────
    setLanguage(s.language);

    // ── Weather ──────────────────────────────────────────────────────────
    this.bus.emit(EventKeys.WeatherChanged, { weather: s.weather });

    // ── Display / fullscreen ─────────────────────────────────────────────
    this.applyFullscreen(s.fullscreen);
  }

  /** JSON-safe snapshot of the current preferences. */
  public serialize(): Json {
    return { ...this.currentSettings } as unknown as Json;
  }

  /**
   * Restore preferences from a save snapshot: merge the sanitised values over
   * the factory defaults, apply everything and notify listeners.
   */
  public deserialize(data: Json): void {
    this.currentSettings = { ...DEFAULT_SETTINGS, ...SettingsManager.sanitize(data) };
    this.applyAll();
    this.bus.emit(EventKeys.SettingsChanged, { settings: this.currentSettings });
  }

  /**
   * Request or release browser fullscreen through the Phaser scale manager.
   * Wrapped in try/catch because the browser only honours the request from a
   * genuine user gesture and rejects it otherwise.
   */
  private applyFullscreen(wantFullscreen: boolean): void {
    const scale = this.game.scale;
    try {
      if (wantFullscreen && !scale.isFullscreen) {
        scale.startFullscreen();
      } else if (!wantFullscreen && scale.isFullscreen) {
        scale.stopFullscreen();
      }
    } catch (error) {
      this.log.debug(`fullscreen toggle ignored: ${String(error)}`);
    }
  }

  /**
   * Read and sanitise the persisted preferences from `localStorage`. Any
   * failure (unavailable storage, malformed JSON) degrades to an empty patch
   * so the defaults are used instead of throwing.
   */
  private loadPersisted(): Partial<GameSettings> {
    try {
      const raw = globalThis.localStorage?.getItem(SettingsManager.STORAGE_KEY);
      if (raw === null || raw === undefined) return {};
      return SettingsManager.sanitize(JSON.parse(raw) as Json);
    } catch (error) {
      this.log.debug(`could not load persisted settings: ${String(error)}`);
      return {};
    }
  }

  /**
   * Write the current preferences to `localStorage`, guarding against
   * environments where storage is unavailable or quota-limited.
   */
  private persist(): void {
    try {
      globalThis.localStorage?.setItem(
        SettingsManager.STORAGE_KEY,
        JSON.stringify(this.currentSettings),
      );
    } catch (error) {
      this.log.debug(`could not persist settings: ${String(error)}`);
    }
  }

  /**
   * Coerce an untrusted JSON value into a validated partial settings patch:
   * only well-typed, in-range fields survive; everything else is dropped.
   */
  private static sanitize(raw: Json): Partial<GameSettings> {
    if (!SettingsManager.isRecord(raw)) return {};
    const out: Partial<GameSettings> = {};

    const master = SettingsManager.toUnit(raw.masterVolume);
    if (master !== undefined) out.masterVolume = master;
    const music = SettingsManager.toUnit(raw.musicVolume);
    if (music !== undefined) out.musicVolume = music;
    const sfx = SettingsManager.toUnit(raw.sfxVolume);
    if (sfx !== undefined) out.sfxVolume = sfx;

    if (typeof raw.muted === 'boolean') out.muted = raw.muted;
    if (typeof raw.screenShake === 'boolean') out.screenShake = raw.screenShake;
    if (typeof raw.fullscreen === 'boolean') out.fullscreen = raw.fullscreen;
    if (typeof raw.vsync === 'boolean') out.vsync = raw.vsync;
    if (typeof raw.mobileVibration === 'boolean') out.mobileVibration = raw.mobileVibration;

    const mobileRanges: Array<[keyof GameSettings, number, number]> = [
      ['mobileControlOpacity', 0.3, 0.9],
      ['mobileControlScale', 0.8, 1.25],
      ['mobileJoystickScale', 0.8, 1.25],
      ['mobileMoveSensitivity', 0.7, 1.3],
      ['mobileAimSensitivity', 0.7, 1.5],
      ['mobileJoystickOffsetX', -0.12, 0.12],
      ['mobileJoystickOffsetY', -0.12, 0.12],
    ];
    for (const [key, min, max] of mobileRanges) {
      const value = raw[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        (out as Record<string, unknown>)[key] = clamp(value, min, max);
      }
    }

    if (SettingsManager.isMember(raw.quality, GraphicsQuality)) {
      out.quality = raw.quality;
    }
    if (SettingsManager.isMember(raw.weather, WeatherMode)) {
      out.weather = raw.weather;
    }
    if (SettingsManager.isMember(raw.language, Language)) {
      out.language = raw.language;
    }

    return out;
  }

  /** Narrow a JSON value to a plain object (not `null`, not an array). */
  private static isRecord(value: Json): value is { [key: string]: Json } {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  /** Coerce a JSON value to a finite unit-range (0..1) number, or `undefined`. */
  private static toUnit(value: Json | undefined): number | undefined {
    return typeof value === 'number' && Number.isFinite(value)
      ? clamp(value, 0, 1)
      : undefined;
  }

  /**
   * Type-guard a JSON value against the string-valued members of an enum.
   * @param value The untrusted candidate value.
   * @param enumObject The enum whose values define the accepted set.
   */
  private static isMember<T extends string>(
    value: Json | undefined,
    enumObject: Record<string, T>,
  ): value is T {
    return (
      typeof value === 'string' &&
      (Object.values(enumObject) as string[]).includes(value)
    );
  }
}
