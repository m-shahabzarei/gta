/**
 * Base class for game-level managers that must operate on the currently active
 * scene (input, camera, particles, lighting, HUD).
 *
 * A single instance is created at bootstrap and lives for the whole game. The
 * active gameplay scene calls {@link attach} in `create()`; the manager binds
 * its scene-scoped objects there and tears them down in {@link detach}, which
 * also runs automatically on the scene's `SHUTDOWN` event. This gives every
 * scene a correctly-wired service without recreating the manager.
 */
import Phaser from 'phaser';
import { BaseManager } from '@/core/BaseManager';
import type { ISceneAttachable } from '@/core/interfaces';

export abstract class BaseSceneManager extends BaseManager implements ISceneAttachable {
  private currentScene: Phaser.Scene | null = null;

  /** The scene this manager is currently bound to, or `null`. */
  public get scene(): Phaser.Scene | null {
    return this.currentScene;
  }

  /** Bind to `scene`; detaches from any previous scene first. */
  public attach(scene: Phaser.Scene): void {
    if (this.currentScene === scene) return;
    if (this.currentScene) this.detach();

    this.currentScene = scene;
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, this.detach, this);
    scene.events.once(Phaser.Scenes.Events.DESTROY, this.detach, this);
    this.onAttach(scene);
    this.log.debug(`attached to scene "${scene.scene.key}"`);
  }

  /** Unbind from the current scene and release scene-scoped objects. */
  public detach(): void {
    const scene = this.currentScene;
    if (!scene) return;

    scene.events.off(Phaser.Scenes.Events.SHUTDOWN, this.detach, this);
    scene.events.off(Phaser.Scenes.Events.DESTROY, this.detach, this);
    this.onDetach(scene);
    this.currentScene = null;
    this.log.debug('detached');
  }

  /** Detaching is part of teardown for every scene-bound manager. */
  protected override onDestroy(): void {
    this.detach();
  }

  /**
   * Create scene-scoped objects (emitters, cameras, overlays, listeners).
   * Guaranteed to run with {@link scene} set.
   */
  protected abstract onAttach(scene: Phaser.Scene): void;

  /** Release scene-scoped objects. Default is a no-op. */
  protected onDetach(_scene: Phaser.Scene): void {}
}
