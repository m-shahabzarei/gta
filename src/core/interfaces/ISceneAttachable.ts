import type Phaser from 'phaser';

/**
 * Implemented by game-level services that must operate on whichever scene is
 * currently active (input, camera, particles, lighting, HUD).
 *
 * A single instance lives for the whole game; the active gameplay scene calls
 * `attach(this)` in its `create()` and `detach()` in its `shutdown`, so the
 * service always targets the right scene without being recreated.
 */
export interface ISceneAttachable {
  /** Bind this service to the given scene and (re)create scene-bound objects. */
  attach(scene: Phaser.Scene): void;

  /** Unbind from the current scene and destroy any scene-bound objects. */
  detach(): void;

  /** The scene this service is currently attached to, or `null`. */
  readonly scene: Phaser.Scene | null;
}
