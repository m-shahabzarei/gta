/**
 * MainMenuScene — the game's title screen and top-level navigation.
 *
 * This Phase-1 front-end screen presents the logo/title and three primary
 * actions (New Game, Continue, Quit). It owns no gameplay logic; it merely
 * drives high-level state transitions through the {@link GameManager} and hands
 * control to {@link SceneKeys.Game}. Audio calls are best-effort and no-op
 * safely when Phase-1 ships without real sound files.
 */

import Phaser from 'phaser';
import { SceneKeys } from '@/config/SceneKeys';
import { ServiceLocator } from '@/core/ServiceLocator';
import { ServiceKeys } from '@/config/ServiceKeys';
import { GameState } from '@/core/types';
import { COLORS, GAME_WIDTH, GAME_HEIGHT } from '@/config/Constants';
import { TextureKeys, AudioKeys } from '@/config/AssetKeys';
import { Button, Label } from '@/ui/components';
import { t } from '@/config/Strings';
import { Logger } from '@/utils';
import type { GameManager } from '@/managers/GameManager';
import type { SaveManager } from '@/managers/SaveManager';
import type { MusicManager } from '@/managers/MusicManager';
import type { SoundManager } from '@/managers/SoundManager';
import type { MobilePlatform } from '@/platform';

/** Vertical spacing between stacked menu buttons, in pixels. */
const BUTTON_SPACING = 60;
/** Menu button dimensions. */
const BUTTON_WIDTH = 240;
const BUTTON_HEIGHT = 48;
/** Logo scale multiplier relative to its native placeholder size. */
const LOGO_SCALE = 3;
/** How long a transient status message stays on screen, in milliseconds. */
const TRANSIENT_MS = 2000;

/**
 * The title screen scene. Wires the primary menu actions to engine services and
 * transitions into the world scene when the player starts or continues a game.
 */
export class MainMenuScene extends Phaser.Scene {
  /** Scoped logger for menu-level diagnostics. */
  private readonly log = Logger.create('MainMenuScene');

  /** Currently displayed transient status label, if any. */
  private transient: Label | null = null;
  private viewportWidth = GAME_WIDTH;
  private viewportHeight = GAME_HEIGHT;
  private mobile = false;

  /** Construct the scene under its canonical key. */
  constructor() {
    super({ key: SceneKeys.MainMenu });
  }

  /**
   * Build the menu UI and register interaction handlers. Called by Phaser once
   * the scene becomes active.
   */
  public create(): void {
    const platform = ServiceLocator.tryResolve<MobilePlatform>(ServiceKeys.Platform);
    this.mobile = platform?.isMobile ?? false;
    if (platform?.isMobile) {
      const layout = platform.layout(this);
      this.viewportWidth = layout.width;
      this.viewportHeight = layout.height;
    }
    const game = ServiceLocator.resolve<GameManager>(ServiceKeys.Game);
    game.setState(GameState.Menu);

    this.buildBackground();
    this.buildTitle();
    this.buildButtons();

    this.startMenuMusic();

    this.input.keyboard?.once('keydown-ENTER', () => this.onNewGame());
  }

  /** Draw the full-screen background fill. */
  private buildBackground(): void {
    this.add
      .rectangle(0, 0, this.viewportWidth, this.viewportHeight, COLORS.BACKGROUND)
      .setOrigin(0, 0);
  }

  /** Add the logo image, title, and subtitle near the top of the screen. */
  private buildTitle(): void {
    const centerX = this.viewportWidth / 2;

    if (this.textures.exists(TextureKeys.Logo)) {
      this.add
        .image(centerX, this.viewportHeight * 0.2, TextureKeys.Logo)
        .setScale(LOGO_SCALE);
    }

    const title = new Label(this, 0, this.viewportHeight * 0.32, t('title'), {
      fontFamily: 'Courier New',
      fontSize: '48px',
      color: '#' + COLORS.ACCENT.toString(16).padStart(6, '0'),
      fontStyle: 'bold',
    });
    this.centerLabel(title);

    const subtitle = new Label(this, 0, this.viewportHeight * 0.32 + 56, t('subtitle'), {
      fontFamily: 'Courier New',
      fontSize: '20px',
      color: '#' + COLORS.TEXT.toString(16).padStart(6, '0'),
    });
    this.centerLabel(subtitle);
  }

  /** Add the three vertically stacked primary action buttons. */
  private buildButtons(): void {
    const centerX = this.viewportWidth / 2;
    const baseY = this.viewportHeight * (this.mobile ? 0.56 : 0.6);
    const spacing = this.mobile ? 96 : BUTTON_SPACING;
    const width = this.mobile ? 320 : BUTTON_WIDTH;
    const height = this.mobile ? 84 : BUTTON_HEIGHT;

    new Button(this, centerX, baseY, {
      text: t('newGame'),
      width,
      height,
      onClick: () => this.onNewGame(),
    });

    new Button(this, centerX, baseY + spacing, {
      text: t('continueGame'),
      width,
      height,
      onClick: () => this.onContinue(),
    });

    new Button(this, centerX, baseY + spacing * 2, {
      text: t('quit'),
      width,
      height,
      onClick: () => this.onQuit(),
    });
  }

  /** Start a brand-new game and enter the world scene. */
  private onNewGame(): void {
    this.playConfirm();
    const game = ServiceLocator.resolve<GameManager>(ServiceKeys.Game);
    game.startNewGame();
    this.scene.start(SceneKeys.Game);
  }

  /** Load slot 0 and enter the world, or report that no save exists. */
  private onContinue(): void {
    this.playConfirm();
    const save = ServiceLocator.resolve<SaveManager>(ServiceKeys.Save);
    if (save.exists(0)) {
      const game = ServiceLocator.resolve<GameManager>(ServiceKeys.Game);
      game.startNewGame();
      save.load(0);
      this.scene.start(SceneKeys.Game);
    } else {
      this.showTransient(t('noSave'));
    }
  }

  /**
   * Handle the Quit action. Browsers block programmatic `window.close()`, so we
   * simply acknowledge on screen and in the log rather than attempting to exit.
   */
  private onQuit(): void {
    this.showTransient('Thanks for playing!');
    this.log.info('Quit requested (window.close is blocked by browsers).');
  }

  /** Begin the looping menu music, if the audio subsystem is available. */
  private startMenuMusic(): void {
    const music = ServiceLocator.tryResolve<MusicManager>(ServiceKeys.Music);
    if (music !== null) {
      music.crossFade(AudioKeys.MusicMenu);
    }
  }

  /** Play the UI confirmation SFX, best-effort. */
  private playConfirm(): void {
    const sound = ServiceLocator.tryResolve<SoundManager>(ServiceKeys.Sound);
    if (sound !== null) {
      sound.play(AudioKeys.SfxUiConfirm);
    }
  }

  /**
   * Display a short-lived, horizontally-centered status message, replacing any
   * message already on screen.
   * @param message Text to display.
   */
  private showTransient(message: string): void {
    if (this.transient !== null) {
      this.transient.destroy();
      this.transient = null;
    }

    const label = new Label(this, 0, this.viewportHeight * 0.9, message, {
      fontFamily: 'Courier New',
      fontSize: '18px',
      color: '#' + COLORS.HEALTH.toString(16).padStart(6, '0'),
    });
    this.centerLabel(label);
    this.transient = label;

    this.time.delayedCall(TRANSIENT_MS, () => {
      if (this.transient === label) {
        this.transient = null;
      }
      label.destroy();
    });
  }

  /**
   * Horizontally center a {@link Label} whose wrapped text object is
   * left-anchored, by measuring its rendered width.
   * @param label The label to reposition.
   */
  private centerLabel(label: Label): void {
    label.setX((this.viewportWidth - label.getBounds().width) / 2);
  }
}
