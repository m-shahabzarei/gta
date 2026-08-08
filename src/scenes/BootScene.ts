/**
 * The very first scene Phaser runs.
 *
 * {@link BootScene} performs the minimal, synchronous bootstrap required before
 * any real asset loading can begin. Because Phase 1 ships no binary art, it
 * generates the full set of procedural placeholder textures via
 * {@link PlaceholderTextureFactory} so that every downstream scene has valid
 * texture keys to render. It then announces readiness on the global event bus
 * and immediately hands control to {@link SceneKeys.Preload}.
 *
 * It contains no gameplay, no asset file loading, and no persistent state.
 */
import Phaser from 'phaser';
import { SceneKeys } from '@/config/SceneKeys';
import { EventKeys } from '@/config/EventKeys';
import { eventBus } from '@/core/EventBus';
import { PlaceholderTextureFactory } from '@/graphics/PlaceholderTextureFactory';
import { GameArtFactory } from '@/graphics/GameArtFactory';

/**
 * Bootstraps the game: builds placeholder textures, signals readiness, then
 * transitions to the preload scene.
 */
export class BootScene extends Phaser.Scene {
  constructor() {
    super({ key: SceneKeys.Boot });
  }

  /**
   * Generate every placeholder texture, broadcast that this scene is ready,
   * and start the preload scene. Runs once when the scene is created.
   */
  public create(): void {
    new PlaceholderTextureFactory(this).generateAll();
    new GameArtFactory(this).generateAll();

    eventBus.emit(EventKeys.SceneReady, { key: SceneKeys.Boot });

    this.scene.start(SceneKeys.Preload);
  }
}
