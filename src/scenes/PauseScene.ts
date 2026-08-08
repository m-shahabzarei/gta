/**
 * PauseScene — a modal overlay launched on top of {@link SceneKeys.Game}.
 *
 * The scene dims the running game with a full-screen, click-blocking scrim and
 * presents a centered panel with the three core pause actions: Resume, Save
 * Game, and Quit to Menu. It intentionally owns none of the scene lifecycle for
 * the world itself — Resume/Quit delegate to {@link GameManager}, which lets
 * {@link SceneKeys.Game} perform the actual resume/stop/teardown so the pause
 * overlay stays a pure UI concern.
 */

import Phaser from 'phaser';
import { SceneKeys } from '@/config/SceneKeys';
import { ServiceLocator } from '@/core/ServiceLocator';
import { ServiceKeys } from '@/config/ServiceKeys';
import { COLORS, GAME_WIDTH, GAME_HEIGHT } from '@/config/Constants';
import { t } from '@/config/Strings';
import { Panel, Label, Button } from '@/ui/components';
import type { GameManager } from '@/managers/GameManager';
import type { SaveManager } from '@/managers/SaveManager';
import type { MobilePlatform } from '@/platform';

/** Width of the centered pause panel, in pixels. */
const PANEL_WIDTH = 360;

/** Height of the centered pause panel, in pixels. */
const PANEL_HEIGHT = 500;

/** Alpha applied to the full-screen dimming scrim. */
const SCRIM_ALPHA = 0.6;

/** Vertical spacing between stacked action buttons, in pixels. */
const BUTTON_SPACING = 60;

/** How long the transient "Saved!" confirmation stays visible, in ms. */
const SAVED_LABEL_MS = 1500;

/**
 * Modal pause menu scene. Runs concurrently above the paused game scene.
 */
export class PauseScene extends Phaser.Scene {
  /** Transient confirmation label shown after a manual save; null when hidden. */
  private savedLabel: Label | null = null;
  private centerX = GAME_WIDTH / 2;
  private centerY = GAME_HEIGHT / 2;
  private panelWidth = PANEL_WIDTH;
  private panelHeight = PANEL_HEIGHT;
  private mobile = false;

  constructor() {
    super({ key: SceneKeys.Pause });
  }

  /**
   * Build the overlay: a click-blocking scrim, a centered panel, the title, and
   * the three action buttons. Also binds ESC as a shortcut for Resume.
   */
  public create(): void {
    const platform = ServiceLocator.tryResolve<MobilePlatform>(ServiceKeys.Platform);
    this.mobile = platform?.isMobile ?? false;
    let viewWidth = GAME_WIDTH;
    let viewHeight = GAME_HEIGHT;
    if (platform?.isMobile) {
      const layout = platform.layout(this);
      viewWidth = layout.width;
      viewHeight = layout.height;
      this.panelWidth = Math.min(940, viewWidth - layout.safe.left - layout.safe.right - 48);
      this.panelHeight = Math.min(590, viewHeight - layout.safe.top - layout.safe.bottom - 36);
    }
    this.centerX = viewWidth / 2;
    this.centerY = viewHeight / 2;
    const centerX = this.centerX;
    const centerY = this.centerY;

    // Full-screen dimming scrim. Made interactive so pointer events do not fall
    // through to the paused game scene beneath this overlay.
    this.add
      .rectangle(centerX, centerY, viewWidth, viewHeight, 0x000000, SCRIM_ALPHA)
      .setInteractive();

    // Centered backing panel.
    new Panel(this, centerX, centerY, this.panelWidth, this.panelHeight);

    // Title, horizontally centered within the panel.
    new Label(this, centerX, centerY - this.panelHeight / 2 + 30, t('paused'), {
      fontSize: '32px',
      color: '#' + COLORS.ACCENT.toString(16).padStart(6, '0'),
      align: 'center',
      fixedWidth: this.panelWidth,
    }).setPosition(centerX - this.panelWidth / 2, centerY - this.panelHeight / 2 + 30);

    const actions: Array<{ text: string; onClick: () => void }> = [
      { text: t('resume'), onClick: (): void => this.onResume() },
      { text: t('map'), onClick: (): void => this.onMap() },
      { text: t('inventory'), onClick: (): void => this.openOverlay(SceneKeys.Inventory, { resumeOnClose: false }) },
      { text: t('settings'), onClick: (): void => this.openOverlay(SceneKeys.Settings) },
      { text: t('save'), onClick: (): void => this.onSave() },
      { text: t('quitToMenu'), onClick: (): void => this.onQuit() },
    ];
    if (this.mobile) {
      const columnGap = Math.min(360, this.panelWidth * 0.42);
      const firstY = centerY - 112;
      actions.forEach((action, i) => {
        const column = i % 2;
        const row = Math.floor(i / 2);
        new Button(this, centerX + (column === 0 ? -columnGap / 2 : columnGap / 2), firstY + row * 116, {
          text: action.text,
          width: Math.min(330, this.panelWidth * 0.38),
          height: 84,
          onClick: action.onClick,
        });
      });
    } else {
      const firstButtonY = centerY - ((actions.length - 1) * BUTTON_SPACING) / 2 + 10;
      actions.forEach((action, i) => {
        new Button(this, centerX, firstButtonY + BUTTON_SPACING * i, {
          text: action.text,
          onClick: action.onClick,
        });
      });
    }

    this.input.keyboard?.once('keydown-ESC', () => this.onResume());
    this.input.keyboard?.once('keydown-M', () => this.onMap());
  }

  /** Resume the game via {@link GameManager}; GameScene handles scene resume. */
  private onResume(): void {
    const game = ServiceLocator.tryResolve<GameManager>(ServiceKeys.Game);
    game?.resumeGame();
  }

  /** Persist to the manual save slot and briefly confirm success on screen. */
  private onSave(): void {
    const saves = ServiceLocator.tryResolve<SaveManager>(ServiceKeys.Save);
    const ok = saves?.save(0, 'Manual Save') ?? false;
    this.showSavedLabel(ok ? 'Saved!' : 'Save failed');
  }

  /** Open the world map overlay. */
  private onMap(): void {
    const game = ServiceLocator.tryResolve<GameManager>(ServiceKeys.Game);
    game?.openMap();
  }

  /** Quit to the main menu via {@link GameManager}; GameScene tears down. */
  private onQuit(): void {
    const game = ServiceLocator.tryResolve<GameManager>(ServiceKeys.Game);
    game?.quitToMenu();
  }

  /**
   * Launch a modal overlay scene (settings/inventory) on top of the pause menu.
   * The overlay closes itself with `scene.stop()`, returning here.
   * @param key The overlay scene key to launch.
   */
  private openOverlay(key: SceneKeys, data?: object): void {
    this.scene.launch(key, data);
    this.scene.bringToTop(key);
  }

  /**
   * Display a short-lived confirmation label near the bottom of the panel,
   * replacing any label already showing.
   * @param message Text to flash to the player.
   */
  private showSavedLabel(message: string): void {
    if (this.savedLabel !== null) {
      this.savedLabel.destroy();
      this.savedLabel = null;
    }

    const centerX = this.centerX;
    const y = this.centerY + this.panelHeight / 2 - 32;

    const label = new Label(this, centerX - this.panelWidth / 2, y, message, {
      fontSize: '18px',
      color: '#' + COLORS.MONEY.toString(16).padStart(6, '0'),
      align: 'center',
      fixedWidth: this.panelWidth,
    });
    this.savedLabel = label;

    this.time.delayedCall(SAVED_LABEL_MS, () => {
      if (this.savedLabel === label) {
        this.savedLabel = null;
      }
      label.destroy();
    });
  }
}
