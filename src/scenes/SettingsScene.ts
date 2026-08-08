/**
 * SettingsScene — a modal settings overlay launched on top of the pause menu or
 * main menu.
 *
 * The scene dims whatever is underneath with a full-screen, click-blocking scrim
 * and presents a centered panel of grouped rows: audio volumes with -/+ steppers
 * and a mute toggle, graphics quality/weather/screen-shake, display
 * fullscreen/vsync, and a language cycle. Every control reads its current value
 * from the {@link ISettingsManagerLike} live settings and mutates it through the
 * manager's convenience setters, then refreshes its own readout in place.
 * Changing the language re-renders every localised label through {@link t}. The
 * Back button simply stops this scene, revealing whatever was underneath.
 *
 * The scene owns no persistence or engine-application logic — that is the
 * manager's job; this file is a pure UI concern.
 */

import Phaser from 'phaser';
import { SceneKeys } from '@/config/SceneKeys';
import { ServiceLocator } from '@/core/ServiceLocator';
import { ServiceKeys } from '@/config/ServiceKeys';
import { COLORS, GAME_WIDTH, GAME_HEIGHT } from '@/config/Constants';
import { Panel, Label, Button } from '@/ui/components';
import { t } from '@/config/Strings';
import { GraphicsQuality, WeatherMode, Language } from '@/config/Settings';
import type { GameSettings } from '@/config/Settings';
import type { IManager } from '@/core/interfaces';
import type { MobilePlatform } from '@/platform';

/**
 * Structural view of the SettingsManager this scene depends on.
 *
 * Declared locally (rather than importing the concrete class) so the overlay is
 * decoupled from the manager's internals: it needs only a live settings snapshot
 * plus the convenience mutators enumerated below.
 */
interface ISettingsManagerLike extends IManager {
  /** Live, read-only view of the current settings state. */
  readonly settings: Readonly<GameSettings>;
  /** Set the master output volume, clamped to 0..1. */
  setMasterVolume(value: number): void;
  /** Set the music channel volume, clamped to 0..1. */
  setMusicVolume(value: number): void;
  /** Set the SFX channel volume, clamped to 0..1. */
  setSfxVolume(value: number): void;
  /** Toggle the global mute flag. */
  toggleMute(): void;
  /** Set the graphics quality preset. */
  setQuality(quality: GraphicsQuality): void;
  /** Set the weather mode. */
  setWeather(weather: WeatherMode): void;
  /** Toggle whether camera screen-shake is allowed. */
  toggleScreenShake(): void;
  /** Toggle the browser fullscreen request. */
  toggleFullscreen(): void;
  /** Toggle the advisory vsync flag. */
  toggleVsync(): void;
  /** Set the UI language and update the active localisation table. */
  setLanguage(language: Language): void;
  /** Update bounded mobile control tuning. */
  setMobileControls(partial: Partial<Pick<GameSettings,
    | 'mobileControlOpacity'
    | 'mobileControlScale'
    | 'mobileJoystickScale'
    | 'mobileMoveSensitivity'
    | 'mobileAimSensitivity'
    | 'mobileVibration'
  >>): void;
}

/** Width of the centered settings panel, in pixels. */
const PANEL_WIDTH = 560;

/** Height of the centered settings panel, in pixels. */
const PANEL_HEIGHT = 600;

/** Alpha applied to the full-screen dimming scrim. */
const SCRIM_ALPHA = 0.72;

/** Vertical gap between consecutive rows, in pixels. */
const ROW_HEIGHT = 40;

/** Left/right inset of row content from the panel edge, in pixels. */
const INSET = 40;

/** Width reserved for the control cluster on the right of each row. */
const CONTROL_WIDTH = 200;

/** Width of a small stepper (-/+) button. */
const STEP_BUTTON_WIDTH = 34;

/** Height shared by every row control. */
const CONTROL_HEIGHT = 30;

/** Step applied by the volume -/+ buttons. */
const VOLUME_STEP = 0.1;

/** Ordered quality presets for the cycle button. */
const QUALITY_ORDER: readonly GraphicsQuality[] = [
  GraphicsQuality.Low,
  GraphicsQuality.Medium,
  GraphicsQuality.High,
];

/** Ordered weather modes for the cycle button. */
const WEATHER_ORDER: readonly WeatherMode[] = [
  WeatherMode.Clear,
  WeatherMode.Rain,
  WeatherMode.Storm,
  WeatherMode.Fog,
  WeatherMode.Snow,
];

/** Ordered languages for the cycle button. */
const LANGUAGE_ORDER: readonly Language[] = [
  Language.English,
  Language.Spanish,
  Language.French,
];

/** Clamp a number into the inclusive 0..1 range. */
function clamp01(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

/**
 * Advance to the next entry in a cyclic ordering, wrapping at the end and
 * defaulting to the first entry when the current value is unknown or the
 * ordering is empty.
 *
 * @param order    The cyclic ordering to step through.
 * @param current  The current value.
 * @param fallback Value returned when no next entry can be resolved.
 * @returns The next value in the cycle.
 */
function nextInCycle<T>(order: readonly T[], current: T, fallback: T): T {
  const index = order.indexOf(current);
  const next = order[(index + 1) % order.length];
  return next ?? fallback;
}

/**
 * Format a 0..1 volume as an integer percentage string (e.g. `70%`).
 * @param value Volume in the 0..1 range.
 * @returns Percentage label.
 */
function formatPercent(value: number): string {
  return `${Math.round(clamp01(value) * 100)}%`;
}

/**
 * Format a boolean flag as a `Label: On/Off` toggle caption.
 * @param label Localised control label.
 * @param on    Current flag state.
 * @returns Toggle caption.
 */
function formatToggle(label: string, on: boolean): string {
  return `${label}: ${on ? 'On' : 'Off'}`;
}

/**
 * Inert settings view used only if a control callback fires without a manager
 * (unreachable in normal flow); every field mirrors a neutral readout.
 */
const EMPTY_SETTINGS: Readonly<GameSettings> = {
  masterVolume: 0,
  musicVolume: 0,
  sfxVolume: 0,
  muted: false,
  quality: GraphicsQuality.High,
  weather: WeatherMode.Clear,
  screenShake: false,
  fullscreen: false,
  vsync: false,
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

/**
 * Modal settings overlay. Runs concurrently above the pause or main menu scene.
 */
export class SettingsScene extends Phaser.Scene {
  /** Resolved settings manager, or null when unavailable. */
  private manager: ISettingsManagerLike | null = null;

  /** Running Y cursor used while stacking rows during {@link create}. */
  private rowCursorY = 0;

  /**
   * Idempotent refreshers that re-render every localised/dynamic caption from
   * current state. Invoked wholesale after a language change; each control's own
   * click handler additionally refreshes just its caption for responsiveness.
   */
  private readonly refreshers: (() => void)[] = [];

  constructor() {
    super({ key: SceneKeys.Settings });
  }

  /**
   * Build the overlay: scrim, panel, title, grouped rows and a Back button. When
   * the settings manager cannot be resolved, only the scrim, panel, title and a
   * Back button are shown so the player is never trapped.
   */
  public create(): void {
    this.manager = ServiceLocator.tryResolve<ISettingsManagerLike>(
      ServiceKeys.Settings,
    );

    const platform = ServiceLocator.tryResolve<MobilePlatform>(ServiceKeys.Platform);
    if (platform?.isMobile) {
      const layout = platform.layout(this);
      this.buildMobileSettings(
        layout.width / 2,
        layout.height / 2,
        layout.width,
        layout.height,
      );
      this.input.keyboard?.once('keydown-ESC', () => this.scene.stop());
      return;
    }

    const centerX = GAME_WIDTH / 2;
    const centerY = GAME_HEIGHT / 2;

    // Full-screen dimming scrim; interactive so pointer events do not fall
    // through to the scene beneath this overlay.
    this.add
      .rectangle(centerX, centerY, GAME_WIDTH, GAME_HEIGHT, 0x000000, SCRIM_ALPHA)
      .setInteractive();

    new Panel(this, centerX, centerY, PANEL_WIDTH, PANEL_HEIGHT);

    const top = centerY - PANEL_HEIGHT / 2;

    // Title, horizontally centred within the panel.
    const title = new Label(this, centerX - PANEL_WIDTH / 2, top + 24, t('settings'), {
      fontSize: '28px',
      color: '#' + COLORS.ACCENT.toString(16).padStart(6, '0'),
      align: 'center',
      fixedWidth: PANEL_WIDTH,
    });
    this.refreshers.push((): void => {
      title.setText(t('settings'));
    });

    this.rowCursorY = top + 84;

    if (this.manager !== null) {
      this.buildRows(centerX);
    }

    this.addBackButton(centerX);
    this.input.keyboard?.once('keydown-ESC', () => this.scene.stop());
  }

  /** Dedicated two-column landscape settings surface with thumb-sized controls. */
  private buildMobileSettings(centerX: number, centerY: number, width: number, height: number): void {
    const panelWidth = Math.min(1200, width - 48);
    const panelHeight = Math.min(690, height - 24);
    this.add.rectangle(centerX, centerY, width, height, 0x000000, SCRIM_ALPHA).setInteractive();
    new Panel(this, centerX, centerY, panelWidth, panelHeight);
    new Label(this, centerX - panelWidth / 2, centerY - panelHeight / 2 + 24, 'SETTINGS', {
      fontSize: '28px',
      color: '#' + COLORS.ACCENT.toString(16).padStart(6, '0'),
      align: 'center',
      fixedWidth: panelWidth,
    });

    const columnOffset = panelWidth * 0.25;
    const firstY = centerY - 205;
    const rowGap = 100;
    const left = centerX - columnOffset;
    const right = centerX + columnOffset;

    this.addMobileStepper(left, firstY, 'MASTER', () => this.settings().masterVolume, (value) => this.manager?.setMasterVolume(value), 0, 1, 0.1);
    this.addMobileStepper(left, firstY + rowGap, 'MUSIC', () => this.settings().musicVolume, (value) => this.manager?.setMusicVolume(value), 0, 1, 0.1);
    this.addMobileStepper(left, firstY + rowGap * 2, 'SFX', () => this.settings().sfxVolume, (value) => this.manager?.setSfxVolume(value), 0, 1, 0.1);
    this.addMobileAction(left, firstY + rowGap * 3, 'QUALITY', () => this.settings().quality.toUpperCase(), () => {
      this.manager?.setQuality(nextInCycle(QUALITY_ORDER, this.settings().quality, GraphicsQuality.Low));
    });
    this.addMobileAction(left, firstY + rowGap * 4, 'SCREEN SHAKE', () => this.settings().screenShake ? 'ON' : 'OFF', () => this.manager?.toggleScreenShake());

    this.addMobileStepper(right, firstY, 'OPACITY', () => this.settings().mobileControlOpacity, (value) => this.manager?.setMobileControls({ mobileControlOpacity: value }), 0.3, 0.9, 0.1);
    this.addMobileStepper(right, firstY + rowGap, 'BUTTON SIZE', () => this.settings().mobileControlScale, (value) => this.manager?.setMobileControls({ mobileControlScale: value }), 0.8, 1.25, 0.1);
    this.addMobileStepper(right, firstY + rowGap * 2, 'JOYSTICK SIZE', () => this.settings().mobileJoystickScale, (value) => this.manager?.setMobileControls({ mobileJoystickScale: value }), 0.8, 1.25, 0.1);
    this.addMobileStepper(right, firstY + rowGap * 3, 'SENSITIVITY', () => this.settings().mobileMoveSensitivity, (value) => this.manager?.setMobileControls({ mobileMoveSensitivity: value, mobileAimSensitivity: value }), 0.7, 1.3, 0.1);
    this.addMobileAction(right, firstY + rowGap * 4, 'VIBRATION', () => this.settings().mobileVibration ? 'ON' : 'OFF', () => this.manager?.setMobileControls({ mobileVibration: !this.settings().mobileVibration }));

    new Button(this, centerX, centerY + panelHeight / 2 - 50, {
      text: t('back'),
      width: 300,
      height: 84,
      onClick: () => this.scene.stop(),
    });
  }

  private addMobileStepper(
    centerX: number,
    y: number,
    labelText: string,
    getValue: () => number,
    setValue: (value: number) => void,
    min: number,
    max: number,
    step: number,
  ): void {
    new Label(this, centerX - 260, y - 10, labelText, { fontSize: '16px' });
    const readout = new Label(this, centerX + 20, y - 10, `${Math.round(getValue() * 100)}%`, {
      fontSize: '16px',
      align: 'center',
      fixedWidth: 120,
    });
    const change = (delta: number): void => {
      setValue(Phaser.Math.Clamp(getValue() + delta, min, max));
      readout.setText(`${Math.round(getValue() * 100)}%`);
    };
    new Button(this, centerX - 45, y, { text: '-', width: 84, height: 84, onClick: () => change(-step) });
    new Button(this, centerX + 205, y, { text: '+', width: 84, height: 84, onClick: () => change(step) });
  }

  private addMobileAction(
    centerX: number,
    y: number,
    labelText: string,
    caption: () => string,
    mutate: () => void,
  ): void {
    new Label(this, centerX - 260, y - 10, labelText, { fontSize: '16px' });
    const button = new Button(this, centerX + 110, y, {
      text: caption(),
      width: 280,
      height: 84,
      onClick: () => {
        mutate();
        button.setText(caption());
      },
    });
  }

  /**
   * Populate every settings row in order. Assumes {@link manager} is non-null.
   * @param centerX Horizontal centre of the panel.
   */
  private buildRows(centerX: number): void {
    // ── Audio ──────────────────────────────────────────────────────────────────
    this.addVolumeRow(
      centerX,
      (): string => t('master'),
      (): number => this.settings().masterVolume,
      (v): void => this.manager?.setMasterVolume(v),
    );
    this.addVolumeRow(
      centerX,
      (): string => t('music'),
      (): number => this.settings().musicVolume,
      (v): void => this.manager?.setMusicVolume(v),
    );
    this.addVolumeRow(
      centerX,
      (): string => t('sfx'),
      (): number => this.settings().sfxVolume,
      (v): void => this.manager?.setSfxVolume(v),
    );
    this.addActionRow(
      centerX,
      (): string => t('audio'),
      (): string => formatToggle('Mute', this.settings().muted),
      (): void => this.manager?.toggleMute(),
    );

    // ── Graphics ───────────────────────────────────────────────────────────────
    this.addActionRow(
      centerX,
      (): string => t('quality'),
      (): string => this.settings().quality,
      (): void =>
        this.manager?.setQuality(
          nextInCycle(QUALITY_ORDER, this.settings().quality, GraphicsQuality.Low),
        ),
    );
    this.addActionRow(
      centerX,
      (): string => t('weather'),
      (): string => this.settings().weather,
      (): void =>
        this.manager?.setWeather(
          nextInCycle(WEATHER_ORDER, this.settings().weather, WeatherMode.Clear),
        ),
    );
    this.addActionRow(
      centerX,
      (): string => t('screenShake'),
      (): string => formatToggle(t('screenShake'), this.settings().screenShake),
      (): void => this.manager?.toggleScreenShake(),
    );

    // ── Display ────────────────────────────────────────────────────────────────
    this.addActionRow(
      centerX,
      (): string => t('fullscreen'),
      (): string => formatToggle(t('fullscreen'), this.settings().fullscreen),
      (): void => this.manager?.toggleFullscreen(),
    );
    this.addActionRow(
      centerX,
      (): string => t('vsync'),
      (): string => formatToggle(t('vsync'), this.settings().vsync),
      (): void => this.manager?.toggleVsync(),
    );

    // ── Language ───────────────────────────────────────────────────────────────
    this.addActionRow(
      centerX,
      (): string => t('language'),
      (): string => this.settings().language,
      (): void =>
        this.manager?.setLanguage(
          nextInCycle(LANGUAGE_ORDER, this.settings().language, Language.English),
        ),
      // Re-render every localised caption after the language switches.
      (): void => this.relocalise(),
    );
  }

  /**
   * Add a single volume row: a localised label on the left plus a `-`,
   * percentage readout, and `+` cluster on the right. The stepper buttons apply
   * a clamped delta through the manager and refresh the readout in place.
   *
   * @param centerX   Horizontal centre of the panel.
   * @param labelText Supplier of the localised row label.
   * @param getValue  Supplier of the current 0..1 value.
   * @param setValue  Applies a new clamped value through the manager.
   */
  private addVolumeRow(
    centerX: number,
    labelText: () => string,
    getValue: () => number,
    setValue: (value: number) => void,
  ): void {
    const y = this.rowCursorY;
    this.rowCursorY += ROW_HEIGHT;

    this.addRowLabel(centerX, y, labelText);

    const controlLeft = centerX + PANEL_WIDTH / 2 - INSET - CONTROL_WIDTH;
    const readout = new Label(
      this,
      controlLeft + STEP_BUTTON_WIDTH + 8,
      y - 8,
      formatPercent(getValue()),
      {
        fontSize: '16px',
        align: 'center',
        fixedWidth: CONTROL_WIDTH - STEP_BUTTON_WIDTH * 2 - 16,
      },
    );

    const step = (delta: number): void => {
      setValue(clamp01(getValue() + delta));
      readout.setText(formatPercent(getValue()));
    };

    new Button(this, controlLeft + STEP_BUTTON_WIDTH / 2, y, {
      text: '-',
      width: STEP_BUTTON_WIDTH,
      height: CONTROL_HEIGHT,
      onClick: (): void => step(-VOLUME_STEP),
    });
    new Button(this, controlLeft + CONTROL_WIDTH - STEP_BUTTON_WIDTH / 2, y, {
      text: '+',
      width: STEP_BUTTON_WIDTH,
      height: CONTROL_HEIGHT,
      onClick: (): void => step(VOLUME_STEP),
    });

    // Percentages are language-independent, but keep the readout truthful after
    // any wholesale refresh.
    this.refreshers.push((): void => {
      readout.setText(formatPercent(getValue()));
    });
  }

  /**
   * Add a single action row: a localised label on the left and one wide button
   * on the right whose caption reflects the current value. Clicking runs the
   * mutator, refreshes the caption, then runs the optional post-mutate hook.
   *
   * @param centerX    Horizontal centre of the panel.
   * @param labelText  Supplier of the localised row label.
   * @param caption    Supplier of the button caption from current state.
   * @param mutate     Applies the state change through the manager.
   * @param postMutate Optional hook run after the caption refresh (e.g. a
   *                   wholesale re-localise on a language change).
   */
  private addActionRow(
    centerX: number,
    labelText: () => string,
    caption: () => string,
    mutate: () => void,
    postMutate?: () => void,
  ): void {
    const y = this.rowCursorY;
    this.rowCursorY += ROW_HEIGHT;

    this.addRowLabel(centerX, y, labelText);

    const controlLeft = centerX + PANEL_WIDTH / 2 - INSET - CONTROL_WIDTH;
    const button = new Button(this, controlLeft + CONTROL_WIDTH / 2, y, {
      text: caption(),
      width: CONTROL_WIDTH,
      height: CONTROL_HEIGHT,
      onClick: (): void => {
        mutate();
        button.setText(caption());
        postMutate?.();
      },
    });

    this.refreshers.push((): void => {
      button.setText(caption());
    });
  }

  /**
   * Add a left-aligned, localised row label and register it for re-rendering on
   * a language change.
   *
   * @param centerX   Horizontal centre of the panel.
   * @param y         Row centre Y.
   * @param labelText Supplier of the localised label text.
   */
  private addRowLabel(centerX: number, y: number, labelText: () => string): void {
    const label = new Label(this, centerX - PANEL_WIDTH / 2 + INSET, y - 8, labelText(), {
      fontSize: '16px',
    });
    this.refreshers.push((): void => {
      label.setText(labelText());
    });
  }

  /**
   * Add the bottom-centred Back button that stops this scene, revealing whatever
   * was underneath.
   * @param centerX Horizontal centre of the panel.
   */
  private addBackButton(centerX: number): void {
    const y = GAME_HEIGHT / 2 + PANEL_HEIGHT / 2 - 40;
    const button = new Button(this, centerX, y, {
      text: t('back'),
      onClick: (): void => {
        this.scene.stop();
      },
    });
    this.refreshers.push((): void => {
      button.setText(t('back'));
    });
  }

  /** Re-render every registered localised/dynamic caption from current state. */
  private relocalise(): void {
    for (const refresh of this.refreshers) {
      refresh();
    }
  }

  /**
   * Read the live settings snapshot, falling back to a benign default view when
   * the manager is unexpectedly absent (only reachable from guarded callbacks).
   * @returns The current settings.
   */
  private settings(): Readonly<GameSettings> {
    return this.manager?.settings ?? EMPTY_SETTINGS;
  }
}
