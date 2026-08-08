/**
 * ResourceManager — the single source of truth for the game's asset pipeline.
 *
 * On initialisation it fetches the declarative asset manifest
 * (`assets/data/manifest.json`) and coerces it into a fully-populated
 * {@link AssetManifest} (missing lists default to empty). Scenes then call
 * {@link ResourceManager.loadInto} to enqueue every declared asset onto their
 * loader; the manager bridges Phaser's loader events onto the typed
 * {@link EventBus} so UI (loading screens) and other systems can react without
 * touching Phaser internals.
 *
 * Phase 1 ships no art or audio files, so an empty manifest is a fully-supported,
 * first-class case: {@link loadInto} still emits start/complete and resolves.
 */
import Phaser from 'phaser';
import { BaseManager } from '@/core/BaseManager';
import { ServiceKeys } from '@/config/ServiceKeys';
import { EventKeys } from '@/config/EventKeys';
import { EMPTY_MANIFEST } from '@/core/types';
import type { AssetManifest } from '@/core/types';

/**
 * Manages loading of external assets described by a JSON manifest and reports
 * loader progress on the shared event bus.
 */
export class ResourceManager extends BaseManager {
  public readonly key = ServiceKeys.Resource;

  /** The parsed manifest; defaults to a valid empty manifest until loaded. */
  private manifestData: AssetManifest = EMPTY_MANIFEST;
  private readonly references = new Map<string, number>();

  /**
   * Fetch and parse the asset manifest. Any failure (missing file, bad JSON) is
   * logged and leaves the safe {@link EMPTY_MANIFEST} in place so the game still
   * boots.
   */
  protected async onInit(): Promise<void> {
    try {
      const response = await fetch('assets/data/manifest.json');
      if (!response.ok) {
        this.log.warn(`manifest fetch failed: HTTP ${response.status}; using empty manifest`);
        return;
      }
      const raw = (await response.json()) as Partial<AssetManifest>;
      this.manifestData = { ...EMPTY_MANIFEST, ...raw };
      this.log.debug('manifest loaded');
    } catch (error) {
      this.log.warn(`manifest unavailable (${String(error)}); using empty manifest`);
    }
  }

  /** The current, fully-populated asset manifest. */
  public get manifest(): AssetManifest {
    return this.manifestData;
  }

  /**
   * Enqueue every manifest entry onto the given scene's loader, wire loader
   * events onto the typed bus, then start loading.
   * @returns a promise that resolves once loading completes (immediately for an
   *   empty queue).
   */
  public loadInto(scene: Phaser.Scene): Promise<void> {
    return new Promise<void>((resolve) => {
      const loader = scene.load;
      this.enqueueAll(loader);

      // Nothing to load: emit a synthetic start/complete pair on the next tick so
      // consumers observe a consistent lifecycle even for an empty manifest.
      if (loader.totalToLoad === 0) {
        scene.time.delayedCall(0, () => {
          this.bus.emit(EventKeys.ResourceLoadStart, { total: 0 });
          this.bus.emit(EventKeys.ResourceProgress, { progress: 1 });
          this.bus.emit(EventKeys.ResourceLoadComplete);
          resolve();
        });
        return;
      }

      const onStart = (): void => {
        this.bus.emit(EventKeys.ResourceLoadStart, { total: loader.totalToLoad });
      };
      const onProgress = (progress: number): void => {
        this.bus.emit(EventKeys.ResourceProgress, { progress });
      };
      const onFileComplete = (key: string, type: string): void => {
        this.bus.emit(EventKeys.ResourceFileComplete, { key, type });
      };
      const onLoadError = (file: Phaser.Loader.File): void => {
        this.log.warn(`failed to load asset '${file.key}'`);
        this.bus.emit(EventKeys.ResourceLoadError, { key: file.key });
      };
      const onComplete = (): void => {
        loader.off(Phaser.Loader.Events.START, onStart);
        loader.off(Phaser.Loader.Events.PROGRESS, onProgress);
        loader.off(Phaser.Loader.Events.FILE_COMPLETE, onFileComplete);
        loader.off(Phaser.Loader.Events.FILE_LOAD_ERROR, onLoadError);
        this.bus.emit(EventKeys.ResourceLoadComplete);
        resolve();
      };

      loader.on(Phaser.Loader.Events.START, onStart);
      loader.on(Phaser.Loader.Events.PROGRESS, onProgress);
      loader.on(Phaser.Loader.Events.FILE_COMPLETE, onFileComplete);
      loader.on(Phaser.Loader.Events.FILE_LOAD_ERROR, onLoadError);
      loader.once(Phaser.Loader.Events.COMPLETE, onComplete);

      loader.start();
    });
  }

  /**
   * Whether a key is already present in the texture, audio, or JSON caches.
   */
  public isCached(key: string): boolean {
    return (
      this.game.textures.exists(key) ||
      this.game.cache.audio.exists(key) ||
      this.game.cache.json.exists(key)
    );
  }

  /** Retain a streamed resource until its owning chunk/system releases it. */
  public retain(key: string): void {
    this.references.set(key, (this.references.get(key) ?? 0) + 1);
  }

  /** Release one resource owner. Actual cache eviction is explicit and batched. */
  public release(key: string): void {
    const next = (this.references.get(key) ?? 0) - 1;
    if (next > 0) this.references.set(key, next);
    else this.references.delete(key);
  }

  /** Evict unreferenced manifest assets after a streaming boundary or scene teardown. */
  public unloadUnused(keys: Iterable<string> = this.manifestKeys()): number {
    let removed = 0;
    for (const key of keys) {
      if ((this.references.get(key) ?? 0) > 0) continue;
      if (this.game.textures.exists(key)) {
        this.game.textures.remove(key);
        removed += 1;
      }
      for (const cache of [
        this.game.cache.audio,
        this.game.cache.json,
        this.game.cache.tilemap,
        this.game.cache.bitmapFont,
      ]) {
        if (!cache.exists(key)) continue;
        cache.remove(key);
        removed += 1;
      }
    }
    return removed;
  }

  protected override onDestroy(): void {
    this.references.clear();
  }

  private *manifestKeys(): Iterable<string> {
    const manifest = this.manifestData;
    for (const entry of manifest.images) yield entry.key;
    for (const entry of manifest.spritesheets) yield entry.key;
    for (const entry of manifest.atlases) yield entry.key;
    for (const entry of manifest.aseprite) yield entry.key;
    for (const entry of manifest.audio) yield entry.key;
    for (const entry of manifest.tilemaps) yield entry.key;
    for (const entry of manifest.bitmapFonts) yield entry.key;
  }

  /** Enqueue every manifest entry onto the loader with its type-correct call. */
  private enqueueAll(loader: Phaser.Loader.LoaderPlugin): void {
    const m = this.manifestData;

    for (const entry of m.images) {
      loader.image(entry.key, entry.url);
    }
    for (const entry of m.spritesheets) {
      loader.spritesheet(entry.key, entry.url, {
        frameWidth: entry.frameWidth,
        frameHeight: entry.frameHeight,
        margin: entry.margin,
        spacing: entry.spacing,
      });
    }
    for (const entry of m.atlases) {
      loader.atlas(entry.key, entry.textureURL, entry.atlasURL);
    }
    for (const entry of m.aseprite) {
      loader.aseprite(entry.key, entry.textureURL, entry.jsonURL);
    }
    for (const entry of m.audio) {
      loader.audio(entry.key, entry.urls);
    }
    for (const entry of m.tilemaps) {
      loader.tilemapTiledJSON(entry.key, entry.url);
    }
    for (const entry of m.bitmapFonts) {
      loader.bitmapFont(entry.key, entry.textureURL, entry.xmlURL);
    }
  }
}
