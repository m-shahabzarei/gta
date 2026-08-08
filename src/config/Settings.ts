/**
 * User-facing settings model and defaults.
 *
 * Owned at runtime by the SettingsManager, persisted via the save system, and
 * applied to the engine (audio volumes, display, graphics quality, weather).
 */

/** Graphics quality presets — gate particle/weather density and effects. */
export enum GraphicsQuality {
  Low = 'low',
  Medium = 'medium',
  High = 'high',
}

/** Weather modes the weather system can render. */
export enum WeatherMode {
  Clear = 'clear',
  Rain = 'rain',
  Storm = 'storm',
  Fog = 'fog',
  Snow = 'snow',
}

/** Supported UI languages. */
export enum Language {
  English = 'en',
  Spanish = 'es',
  French = 'fr',
}

/** The complete, serialisable settings state. */
export interface GameSettings {
  /** Master output volume (0..1). */
  masterVolume: number;
  /** Music channel volume (0..1). */
  musicVolume: number;
  /** SFX channel volume (0..1). */
  sfxVolume: number;
  /** Global mute. */
  muted: boolean;
  /** Graphics quality preset. */
  quality: GraphicsQuality;
  /** Weather mode. */
  weather: WeatherMode;
  /** Whether camera screen-shake is allowed. */
  screenShake: boolean;
  /** Request the browser fullscreen. */
  fullscreen: boolean;
  /** Cap the render to display refresh (Phaser uses rAF; advisory flag). */
  vsync: boolean;
  /** UI language. */
  language: Language;
  /** Mobile control surface opacity (0.3..0.9). */
  mobileControlOpacity: number;
  /** Mobile action-button size multiplier (0.8..1.25). */
  mobileControlScale: number;
  /** Mobile joystick size multiplier (0.8..1.25). */
  mobileJoystickScale: number;
  /** Mobile movement response multiplier (0.7..1.3). */
  mobileMoveSensitivity: number;
  /** Attack-drag aim response multiplier (0.7..1.5). */
  mobileAimSensitivity: number;
  /** Normalized joystick horizontal offset from its default anchor (-0.12..0.12). */
  mobileJoystickOffsetX: number;
  /** Normalized joystick vertical offset from its default anchor (-0.12..0.12). */
  mobileJoystickOffsetY: number;
  /** Whether supported mobile devices may provide short action haptics. */
  mobileVibration: boolean;
}

/** Factory-fresh default settings. */
export const DEFAULT_SETTINGS: GameSettings = {
  masterVolume: 1,
  musicVolume: 0.6,
  sfxVolume: 0.9,
  muted: false,
  quality: GraphicsQuality.High,
  weather: WeatherMode.Clear,
  screenShake: true,
  fullscreen: false,
  vsync: true,
  language: Language.English,
  mobileControlOpacity: 0.62,
  mobileControlScale: 1,
  mobileJoystickScale: 1,
  mobileMoveSensitivity: 1,
  mobileAimSensitivity: 1,
  mobileJoystickOffsetX: 0,
  mobileJoystickOffsetY: 0,
  mobileVibration: true,
};

/** Particle-density multiplier for each quality preset. */
export const QUALITY_PARTICLE_SCALE: Readonly<Record<GraphicsQuality, number>> = {
  [GraphicsQuality.Low]: 0.35,
  [GraphicsQuality.Medium]: 0.7,
  [GraphicsQuality.High]: 1,
};
