/**
 * Global animation registry.
 *
 * The {@link AnimationManager} turns data-driven {@link AnimationDefinition}
 * records into Phaser animations registered on the shared `game.anims` manager,
 * so every scene and entity can play them by key. It also supports Aseprite
 * frame-tag animations, which Phaser creates directly from the imported atlas.
 *
 * All registration is defensive: definitions whose key already exists are
 * skipped (idempotent re-registration), and definitions whose source texture is
 * missing are skipped with a warning instead of throwing. This keeps Phase 1
 * booting even though no real art ships yet.
 */
import type Phaser from 'phaser';
import type { AnimationDefinition } from '@/core/types';
import { BaseManager } from '@/core/BaseManager';
import { ServiceKeys } from '@/config/ServiceKeys';

export class AnimationManager extends BaseManager {
  /** Service-locator key for this manager. */
  public readonly key = ServiceKeys.Animation;

  /** Log readiness; animations are registered on demand via the public API. */
  protected onInit(): void {
    this.log.debug('ready');
  }

  /**
   * Register a batch of data-driven animation definitions on the global
   * animation manager. Definitions that already exist or whose texture is
   * missing are skipped; Aseprite definitions are delegated to
   * {@link registerAseprite}.
   */
  public registerDefinitions(defs: readonly AnimationDefinition[]): void {
    for (const def of defs) {
      if (this.game.anims.exists(def.key)) continue;

      if (!this.game.textures.exists(def.texture)) {
        this.log.warn(`skipping animation '${def.key}': texture '${def.texture}' is missing`);
        continue;
      }

      const source = def.frames;
      let frames: Phaser.Types.Animations.AnimationFrame[];

      switch (source.type) {
        case 'range':
          frames = this.game.anims.generateFrameNumbers(def.texture, {
            start: source.start,
            end: source.end,
          });
          break;
        case 'frames':
          frames = source.frames.map((frame) => ({ key: def.texture, frame }));
          break;
        case 'aseprite':
          // Aseprite tags create their own animations; do not call anims.create.
          this.registerAseprite(def.texture);
          continue;
      }

      this.game.anims.create({
        key: def.key,
        frames,
        frameRate: def.frameRate,
        repeat: def.repeat,
        yoyo: def.yoyo ?? false,
      });
    }
  }

  /**
   * Create every animation encoded as an Aseprite frame-tag on the given
   * texture. No-op (with a warning) when the texture has not been loaded.
   */
  public registerAseprite(textureKey: string): void {
    if (!this.game.textures.exists(textureKey)) {
      this.log.warn(`cannot create Aseprite animations: texture '${textureKey}' is missing`);
      return;
    }
    this.game.anims.createFromAseprite(textureKey);
  }

  /** Whether an animation with the given key is registered globally. */
  public has(key: string): boolean {
    return this.game.anims.exists(key);
  }
}
