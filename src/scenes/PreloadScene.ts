/**
 * PreloadScene — the asset-loading front door of the game.
 *
 * Immediately after {@link BootScene} has prepared placeholder art, this scene
 * flips the {@link GameManager} into {@link GameState.Loading}, shows a small
 * centered loading UI (a {@link Panel} backing, a "LOADING" {@link Label} and a
 * {@link ProgressBar}) and delegates the actual asset loading to the
 * {@link ResourceManager}.
 *
 * The scene never enqueues manifest assets itself: `ResourceManager.loadInto`
 * owns the loader and reports progress on the typed event bus. This scene simply
 * mirrors {@link EventKeys.ResourceProgress} onto the progress bar, registers any
 * animation definitions once loading finishes (there are none in Phase 1), and
 * advances to the main menu. Loading failures are logged but still advance, so
 * the game can never get stuck on this screen.
 */

import Phaser from 'phaser';
import { SceneKeys } from '@/config/SceneKeys';
import { ServiceLocator } from '@/core/ServiceLocator';
import { ServiceKeys } from '@/config/ServiceKeys';
import { GameState } from '@/core/types';
import { eventBus } from '@/core/EventBus';
import { EventKeys } from '@/config/EventKeys';
import { GAME_WIDTH, GAME_HEIGHT, COLORS } from '@/config/Constants';
import { Panel, Label, ProgressBar } from '@/ui/components';
import { Logger } from '@/utils';
import type { GameManager } from '@/managers/GameManager';
import type { ResourceManager } from '@/managers/ResourceManager';
import type { AnimationManager } from '@/managers/AnimationManager';
import type { Unsubscribe } from '@/core/types';

/** Pixel width of the centered loading panel. */
const PANEL_WIDTH = 480;

/** Pixel height of the centered loading panel. */
const PANEL_HEIGHT = 160;

/** Pixel width of the progress bar inside the panel. */
const BAR_WIDTH = 400;

/** Pixel height of the progress bar inside the panel. */
const BAR_HEIGHT = 20;

/**
 * Displays a loading screen while the {@link ResourceManager} loads the asset
 * manifest, then transitions to {@link SceneKeys.MainMenu}.
 */
export class PreloadScene extends Phaser.Scene {
  /** Scoped logger for diagnostics. */
  private readonly log = new Logger('PreloadScene');

  /** The progress bar mirroring loader progress; created in {@link create}. */
  private progressBar: ProgressBar | null = null;

  /** Unsubscribe handle for the resource-progress subscription. */
  private unsubscribeProgress: Unsubscribe | null = null;

  constructor() {
    super({ key: SceneKeys.Preload });
  }

  /**
   * Build the loading UI, wire progress updates and kick off asset loading.
   */
  public create(): void {
    const game = ServiceLocator.resolve<GameManager>(ServiceKeys.Game);
    game.setState(GameState.Loading);

    this.buildLoadingUi();

    // Mirror loader progress onto the bar; store the unsubscribe for cleanup.
    this.unsubscribeProgress = eventBus.on(EventKeys.ResourceProgress, (payload) => {
      this.progressBar?.setValue(payload.progress);
    });

    // Ensure the subscription is released even if the scene is torn down early.
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.releaseProgress();
    });

    const resource = ServiceLocator.resolve<ResourceManager>(ServiceKeys.Resource);
    resource
      .loadInto(this)
      .then(() => {
        this.onLoadComplete();
      })
      .catch((error: unknown) => {
        this.log.error(`asset loading failed: ${String(error)}`);
        // Never leave the player stranded on the loading screen.
        this.onLoadComplete();
      });
  }

  /**
   * Construct the centered panel, label and progress bar that make up the
   * loading screen.
   */
  private buildLoadingUi(): void {
    const cx = GAME_WIDTH / 2;
    const cy = GAME_HEIGHT / 2;

    new Panel(this, cx, cy, PANEL_WIDTH, PANEL_HEIGHT);

    // Label wraps a top-left-origin text; nudge left so "LOADING" reads centered.
    new Label(this, cx - 58, cy - 48, 'LOADING', {
      fontSize: '28px',
      color: '#' + COLORS.ACCENT.toString(16).padStart(6, '0'),
    });

    this.progressBar = new ProgressBar(
      this,
      cx - BAR_WIDTH / 2,
      cy + 20,
      BAR_WIDTH,
      BAR_HEIGHT,
      { color: COLORS.ACCENT, background: COLORS.UI_BORDER },
    );
    this.progressBar.setValue(0);
  }

  /**
   * Finalise loading: register animation definitions (none in Phase 1), release
   * the progress subscription and advance to the main menu.
   */
  private onLoadComplete(): void {
    const animations = ServiceLocator.resolve<AnimationManager>(ServiceKeys.Animation);
    animations.registerDefinitions([]);

    this.releaseProgress();
    this.scene.start(SceneKeys.MainMenu);
  }

  /** Remove the resource-progress subscription if it is still active. */
  private releaseProgress(): void {
    if (this.unsubscribeProgress) {
      this.unsubscribeProgress();
      this.unsubscribeProgress = null;
    }
  }
}
