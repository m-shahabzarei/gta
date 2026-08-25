/** Stable contracts shared by the phone shell and future phone applications. */
import type Phaser from 'phaser';
import type { StringKey } from '@/config/Strings';
import type { Json } from '@/core/types';

/** In-game presentation modes owned by PhoneScene (never browser fullscreen). */
export type PhonePresentationMode = 'portrait' | 'landscape-fullscreen';

/** Context available while an app decides whether it should be shown. */
export interface PhoneAppAvailabilityContext {
  /** The current phone scene, when the registry is queried by the shell. */
  scene: Phaser.Scene;
}

/** Context shared by app lifecycle, view, and update callbacks. */
export interface PhoneAppContext extends PhoneAppAvailabilityContext {
  /** Return to the phone home screen. */
  navigateHome: () => void;
  /** Close the phone overlay. */
  closePhone: () => void;
  /** Refresh the installed-app grid after an installation change. */
  refreshInstalledApps: () => void;
  /** Return the current Store catalog for this phone scene. */
  listCatalogApps: () => PhoneAppDefinition[];
  /** Install one catalog app; returns false for unknown/already-installed ids. */
  installApp: (appId: string) => boolean;
  /** Reflow the existing Phone presentation without recreating the app view. */
  setPresentationMode: (mode: PhonePresentationMode) => void;
  /** Read the current in-game Phone presentation mode. */
  getPresentationMode: () => PhonePresentationMode;
  /** Return to the portrait Phone presentation. */
  exitExpandedMode: () => void;
}

/** Lifecycle context with the app definition that is being opened/closed. */
export interface PhoneAppLifecycleContext extends PhoneAppContext {
  app: PhoneAppDefinition;
}

/** Description of one installed or future catalog phone application. */
export interface PhoneAppDefinition {
  /** Stable machine-readable identifier used for navigation and save state. */
  readonly id: string;
  /** Human-readable title shown by the phone shell. */
  readonly title: string;
  /** Optional localisation key used when the title is rendered. */
  readonly titleKey?: StringKey;
  /** Optional texture key for a future app icon. */
  readonly iconKey?: string;
  /** Optional procedural icon renderer for a future app icon. */
  readonly renderIcon?: (graphics: Phaser.GameObjects.Graphics, size: number) => void;
  /** Stable ordering used by the home-screen app grid. */
  readonly sortOrder?: number;
  /** Built-in app that is installed for every phone and cannot be removed. */
  readonly systemApp?: boolean;
  /** Whether this definition may be installed from the Store catalog. */
  readonly installable?: boolean;
  /** Whether this app should pause gameplay when opened; defaults to true. */
  readonly pauseGameplay?: boolean;
  /** Optional availability gate evaluated before the app is shown. */
  readonly isAvailable?: (context: PhoneAppAvailabilityContext) => boolean;
  /** Called immediately before the app view is created. */
  readonly onOpen?: (context: PhoneAppLifecycleContext) => void;
  /** Creates the app's view inside the phone screen. */
  readonly createView?: (context: PhoneAppContext) => Phaser.GameObjects.GameObject | null;
  /** Optional per-frame app update while its view is active. */
  readonly update?: (context: PhoneAppContext, time: number, delta: number) => void;
  /** Called when leaving the app or returning to the home screen. */
  readonly onClose?: (context: PhoneAppLifecycleContext) => void;
  /** Optional JSON-safe state snapshot for a future save integration. */
  readonly serializeState?: () => Json;
  /** Optional restoration hook for a future save integration. */
  readonly deserializeState?: (state: Json) => void;
}
