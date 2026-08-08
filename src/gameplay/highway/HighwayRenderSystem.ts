import type Phaser from 'phaser';
import { TILE_SIZE } from '@/config/Constants';
import { DepthLayers } from '@/config/DepthLayers';
import { paintHighwayCanvas } from './HighwayCanvasPainter';
import type { HighwayGeometryIndex } from './HighwayGeometry';
import type {
  HighwayChunkHandle,
  HighwayRenderLod,
  HighwayRenderStats,
} from './HighwayRenderTypes';

const TEXTURE_BLEED = 96;
const MAX_CACHED_TEXTURES = 18;
// Pixel art remains nearest-neighbour when enlarged; the smaller atlas cut
// keeps synchronous streamed-chunk rasterization inside the frame budget.
const RASTER_SCALE = 0.4;

interface CachedTexture {
  readonly key: string;
  readonly textureKey: string;
  readonly lod: HighwayRenderLod;
  references: number;
  lastUsed: number;
  details: number;
}

/** Rasterizes and owns static, one-image-per-chunk highway batches. */
export class HighwayRenderSystem {
  private readonly cache = new Map<string, CachedTexture>();
  private readonly handles = new Set<HighwayChunkHandle>();
  private clock = 0;
  private cacheHits = 0;
  private cacheMisses = 0;
  private lastBuildMs = 0;
  private maximumBuildMs = 0;
  private totalBuildMs = 0;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly geometry: HighwayGeometryIndex,
  ) {}

  public acquireChunk(key: string, lod: HighwayRenderLod): HighwayChunkHandle | null {
    const chunk = this.geometry.getChunk(key);
    if (!chunk) return null;
    const cacheKey = `${key}:${lod}`;
    let cached = this.cache.get(cacheKey);
    if (cached) {
      this.cacheHits++;
    } else {
      this.cacheMisses++;
      cached = this.rasterize(cacheKey, key, lod);
      this.cache.set(cacheKey, cached);
    }
    cached.references++;
    cached.lastUsed = ++this.clock;
    const [cxText, cyText] = key.split(',');
    const chunkPx = this.geometry.chunkTiles * TILE_SIZE;
    const image = this.scene.add.image(
      Number(cxText) * chunkPx - TEXTURE_BLEED,
      Number(cyText) * chunkPx - TEXTURE_BLEED,
      cached.textureKey,
    );
    image.setOrigin(0, 0);
    image.setScale(1 / RASTER_SCALE);
    image.setDepth(DepthLayers.RoadMarkings);
    const handle: HighwayChunkHandle = { key, lod, textureKey: cached.textureKey, image };
    this.handles.add(handle);
    this.evictUnused();
    return handle;
  }

  public releaseChunk(handle: HighwayChunkHandle | null): void {
    if (!handle || !this.handles.delete(handle)) return;
    handle.image.destroy();
    const cached = this.cache.get(`${handle.key}:${handle.lod}`);
    if (cached) {
      cached.references = Math.max(0, cached.references - 1);
      cached.lastUsed = ++this.clock;
    }
    this.evictUnused();
  }

  /** Prepare a neighboring LOD during spare frames so a later crossing is a cache hit. */
  public prewarmChunk(key: string, lod: HighwayRenderLod): boolean {
    const cacheKey = `${key}:${lod}`;
    if (this.cache.has(cacheKey) || !this.geometry.hasChunk(key)) return false;
    this.cacheMisses++;
    this.cache.set(cacheKey, this.rasterize(cacheKey, key, lod));
    this.evictUnused();
    return true;
  }

  public setVisible(handle: HighwayChunkHandle | null, visible: boolean): void {
    if (handle && handle.image.visible !== visible) handle.image.setVisible(visible);
  }

  public destroy(): void {
    for (const handle of Array.from(this.handles)) this.releaseChunk(handle);
    for (const cached of this.cache.values()) this.scene.textures.remove(cached.textureKey);
    this.cache.clear();
  }

  public get stats(): HighwayRenderStats {
    const geometry = this.geometry.stats;
    let visibleChunks = 0;
    let details = 0;
    for (const handle of this.handles) {
      if (handle.image.visible) visibleChunks++;
    }
    for (const cached of this.cache.values()) details += cached.details;
    return {
      ...geometry,
      residentChunks: this.handles.size,
      visibleChunks,
      cachedTextures: this.cache.size,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      rasterizedDetails: details,
      estimatedBatchedDraws: visibleChunks,
      lastBuildMs: this.lastBuildMs,
      maximumBuildMs: this.maximumBuildMs,
      totalBuildMs: this.totalBuildMs,
    };
  }

  private rasterize(cacheKey: string, key: string, lod: HighwayRenderLod): CachedTexture {
    const chunk = this.geometry.getChunk(key);
    if (!chunk) throw new Error(`missing indexed highway chunk ${key}`);
    const chunkPx = this.geometry.chunkTiles * TILE_SIZE;
    const worldSize = chunkPx + TEXTURE_BLEED * 2;
    const size = Math.ceil(worldSize * RASTER_SCALE);
    const textureKey = `highway:${cacheKey}:${this.cacheMisses}`;
    const startedAt = performance.now();
    const texture = this.scene.textures.createCanvas(textureKey, size, size);
    if (!texture) throw new Error(`failed to allocate highway canvas texture ${textureKey}`);
    const context = texture.getContext();
    const [cxText, cyText] = key.split(',');
    const result = paintHighwayCanvas(
      context,
      chunk,
      Number(cxText) * chunkPx,
      Number(cyText) * chunkPx,
      size,
      TEXTURE_BLEED,
      lod,
      RASTER_SCALE,
    );
    texture.refresh();
    this.lastBuildMs = performance.now() - startedAt;
    this.maximumBuildMs = Math.max(this.maximumBuildMs, this.lastBuildMs);
    this.totalBuildMs += this.lastBuildMs;
    return {
      key: cacheKey,
      textureKey,
      lod,
      references: 0,
      lastUsed: ++this.clock,
      details: result.details,
    };
  }

  private evictUnused(): void {
    while (this.cache.size > MAX_CACHED_TEXTURES) {
      let oldest: CachedTexture | null = null;
      for (const cached of this.cache.values()) {
        if (cached.references > 0) continue;
        if (!oldest || cached.lastUsed < oldest.lastUsed) oldest = cached;
      }
      if (!oldest) return;
      this.cache.delete(oldest.key);
      this.scene.textures.remove(oldest.textureKey);
    }
  }
}
