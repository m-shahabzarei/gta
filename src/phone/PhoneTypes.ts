/** Stable contracts shared by the phone shell and future phone applications. */
import type Phaser from 'phaser';
import type { Json } from '@/core/types';

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
}

/** Lifecycle context with the app definition that is being opened/closed. */
export interface PhoneAppLifecycleContext extends PhoneAppContext {
  app: PhoneAppDefinition;
}

/** Description of one future phone application. The v1 registry is empty. */
export interface PhoneAppDefinition {
  /** Stable machine-readable identifier used for navigation and save state. */
  readonly id: string;
  /** Human-readable title shown by the phone shell. */
  readonly title: string;
  /** Optional texture key for a future app icon. */
  readonly iconKey?: string;
  /** Optional procedural icon renderer for a future app icon. */
  readonly renderIcon?: (graphics: Phaser.GameObjects.Graphics, size: number) => void;
  /** Stable ordering used by the home-screen app grid. */
  readonly sortOrder?: number;
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

