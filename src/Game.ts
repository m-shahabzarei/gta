/**
 * Application bootstrap.
 *
 * Boot sequence (strict ordering so nothing runs before its dependencies):
 *   1. Create the Phaser.Game from {@link createGameConfig} (no scenes yet).
 *   2. Wait for the engine READY event.
 *   3. Create, register and initialise every manager via {@link ManagerRegistry}.
 *   4. Register the scenes and start the Boot scene.
 *
 * Because scenes are added only after step 3, no scene can ever execute before
 * the services it resolves from the ServiceLocator exist.
 */
import Phaser from 'phaser';
import { createGameConfig } from '@/config/GameConfig';
import { SceneKeys } from '@/config/SceneKeys';
import { ManagerRegistry } from '@/core/ManagerRegistry';
import {
  BootScene,
  PreloadScene,
  MainMenuScene,
  GameScene,
  UIScene,
  PauseScene,
  MapScene,
  SettingsScene,
  InventoryScene,
  PhoneScene,
  InteriorScene,
} from '@/scenes';
import { Logger } from '@/utils/Logger';

/** Scene registration table (key → class), in start order. */
const SCENE_TABLE: ReadonlyArray<readonly [SceneKeys, new () => Phaser.Scene]> = [
  [SceneKeys.Boot, BootScene],
  [SceneKeys.Preload, PreloadScene],
  [SceneKeys.MainMenu, MainMenuScene],
  [SceneKeys.Game, GameScene],
  [SceneKeys.UI, UIScene],
  [SceneKeys.Pause, PauseScene],
  [SceneKeys.Map, MapScene],
  [SceneKeys.Settings, SettingsScene],
  [SceneKeys.Inventory, InventoryScene],
  [SceneKeys.Phone, PhoneScene],
  [SceneKeys.Interior, InteriorScene],
];

/** Convenience wrapper bundling the Phaser game with its manager registry. */
export class Game {
  private readonly log = Logger.create('Game');

  private constructor(
    /** The underlying Phaser game instance. */
    public readonly phaser: Phaser.Game,
    /** The engine's manager registry. */
    public readonly registry: ManagerRegistry,
  ) {}

  /**
   * Create and fully boot the game. Resolves once managers are initialised and
   * the Boot scene has been started.
   */
  public static async boot(): Promise<Game> {
    const phaser = new Phaser.Game(createGameConfig());
    await Game.whenReady(phaser);

    const registry = new ManagerRegistry(phaser);
    await registry.initAll();

    Game.registerScenes(phaser);
    phaser.scene.start(SceneKeys.Boot);

    const game = new Game(phaser, registry);
    game.log.info('boot complete');
    game.installTeardown();
    return game;
  }

  /** Resolve once the Phaser core has finished booting. */
  private static whenReady(phaser: Phaser.Game): Promise<void> {
    return new Promise<void>((resolve) => {
      if (phaser.isBooted) {
        resolve();
        return;
      }
      phaser.events.once(Phaser.Core.Events.READY, () => resolve());
    });
  }

  /** Add every scene without auto-starting it. */
  private static registerScenes(phaser: Phaser.Game): void {
    for (const [key, SceneClass] of SCENE_TABLE) {
      phaser.scene.add(key, SceneClass, false);
    }
  }

  /** Clean up managers when the page unloads to avoid leaked listeners. */
  private installTeardown(): void {
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => this.registry.destroyAll(), {
        once: true,
      });
    }
  }
}
