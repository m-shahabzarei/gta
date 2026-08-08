/**
 * Declarative description of every external asset the game loads.
 *
 * The {@link ResourceManager} reads a manifest (JSON matching this shape) and
 * enqueues each entry on a scene loader. Declaring assets as data — rather than
 * as imperative `load.image(...)` calls scattered across scenes — keeps the
 * asset pipeline single-sourced and lets Phase 2 add art without touching code.
 */

/** A plain image. */
export interface ImageAssetEntry {
  key: string;
  url: string;
}

/** A fixed-grid sprite sheet. */
export interface SpriteSheetAssetEntry {
  key: string;
  url: string;
  frameWidth: number;
  frameHeight: number;
  margin?: number;
  spacing?: number;
}

/** A texture-packer style atlas (texture + JSON hash/array). */
export interface AtlasAssetEntry {
  key: string;
  textureURL: string;
  atlasURL: string;
}

/** An Aseprite export (PNG + Aseprite JSON with frameTags for animations). */
export interface AsepriteAssetEntry {
  key: string;
  textureURL: string;
  jsonURL: string;
}

/** An audio clip with one or more source formats for browser fallback. */
export interface AudioAssetEntry {
  key: string;
  urls: string[];
}

/** A Tiled map exported as JSON (`.tmj`) or the Tiled JSON of a `.tmx`. */
export interface TilemapAssetEntry {
  key: string;
  url: string;
}

/** A bitmap font (texture + Angel Code XML). */
export interface BitmapFontAssetEntry {
  key: string;
  textureURL: string;
  xmlURL: string;
}

/** The full manifest. Every list defaults to empty. */
export interface AssetManifest {
  images: ImageAssetEntry[];
  spritesheets: SpriteSheetAssetEntry[];
  atlases: AtlasAssetEntry[];
  aseprite: AsepriteAssetEntry[];
  audio: AudioAssetEntry[];
  tilemaps: TilemapAssetEntry[];
  bitmapFonts: BitmapFontAssetEntry[];
}

/** An empty, valid manifest — the safe default when none is provided. */
export const EMPTY_MANIFEST: AssetManifest = {
  images: [],
  spritesheets: [],
  atlases: [],
  aseprite: [],
  audio: [],
  tilemaps: [],
  bitmapFonts: [],
};
