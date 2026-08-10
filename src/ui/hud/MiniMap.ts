/**
 * Radar-style minimap HUD component.
 *
 * `MiniMap` is a self-contained, data-driven widget pinned to the bottom-left
 * of the screen. It renders a downscaled, circular view of the city that stays
 * centred on a supplied world point (normally the player), with dynamic "blips"
 * (vehicles, peds, police, mission markers, …) painted on top each frame.
 *
 * It owns **no** gameplay systems: a Phase-2 HUD driver feeds it a static
 * {@link MapData} once via {@link MiniMap.setMap}, then pushes a fresh view
 * centre ({@link MiniMap.setViewCenter}) and blip list ({@link MiniMap.setBlips})
 * every frame. The static map is rasterised a single time into a cached
 * {@link Phaser.GameObjects.Graphics} and merely repositioned as the view moves,
 * so per-frame work is limited to redrawing the small blip layer.
 *
 * The map and blip layers are clipped to a circular window with a geometry
 * mask; the surrounding {@link Panel} supplies the radar frame. Everything is
 * pinned to the camera (`scrollFactor = 0`, depth {@link DepthLayers.HUD}).
 */

import Phaser from 'phaser';

import { COLORS, GAME_HEIGHT } from '@/config/Constants';
import { DepthLayers } from '@/config/DepthLayers';
import { TileType, type MapData } from '@/gameplay/types';
import { Panel } from '@/ui/components';
import { UIComponent } from '@/ui/UIComponent';
import { paintMajorBuildingIcon } from '@/ui/hud/MajorBuildingIconPainter';

/** A single dynamic marker rendered on the minimap, in world coordinates. */
export interface MiniMapBlip {
  /** World-space x position (pixels). */
  x: number;
  /** World-space y position (pixels). */
  y: number;
  /** Fill colour (`0xRRGGBB`). */
  color: number;
  /** Optional dot radius in minimap pixels; defaults to {@link BLIP_DEFAULT_SIZE}. */
  size?: number;
}

/** Screen-edge padding for the minimap, in pixels. */
const SCREEN_PAD = 16;

/** Inset of the circular map window inside the square panel frame, in pixels. */
const FRAME_PAD = 6;

/** Fixed world-to-minimap zoom factor (world pixels → minimap pixels). */
const MINIMAP_SCALE = 0.08;

/** Default blip dot radius, in minimap pixels. */
const BLIP_DEFAULT_SIZE = 2;

/** Player marker dot radius, in minimap pixels. */
const PLAYER_MARKER_SIZE = 3;

/**
 * Bottom-left radar minimap. Construct once per HUD scene, call
 * {@link MiniMap.setMap} with the generated city, then drive per-frame with
 * {@link MiniMap.setViewCenter} and {@link MiniMap.setBlips}.
 */
export class MiniMap extends UIComponent {
  /** Rounded panel supplying the radar frame/background. */
  private readonly frame: Panel;
  /** Cached static map raster (whole world drawn once at {@link MINIMAP_SCALE}). */
  private readonly mapGfx: Phaser.GameObjects.Graphics;
  /** Per-frame blip layer (redrawn on every {@link MiniMap.setBlips} call). */
  private readonly blipGfx: Phaser.GameObjects.Graphics;
  /** Off-display graphics whose filled circle acts as the clip stencil. */
  private readonly maskShape: Phaser.GameObjects.Graphics;
  /** Circular geometry mask shared by the map and blip layers. */
  private readonly clipMask: Phaser.Display.Masks.GeometryMask;

  /** Screen-space centre of the minimap (also the container-local centre). */
  private centerX: number;
  /** Screen-space centre of the minimap. */
  private centerY: number;
  /** Radius of the clipped circular view window, in minimap pixels. */
  private readonly innerRadius: number;

  /** World point currently centred in the view window. */
  private viewCenterX = 0;
  /** World point currently centred in the view window. */
  private viewCenterY = 0;
  /** Whether {@link MiniMap.setMap} has rasterised a map yet. */
  private hasMap = false;
  /** Number of static service POIs drawn from the authoritative map data. */
  private majorPoiCount = 0;

  /**
   * Builds the frame, map and blip layers and pins them to the camera.
   *
   * @param scene The owning (HUD) scene.
   * @param size Outer diameter/edge length of the square panel, in pixels.
   */
  constructor(scene: Phaser.Scene, size = 176) {
    super(scene, 0, 0);

    const radius = size / 2;
    this.centerX = SCREEN_PAD + radius;
    this.centerY = GAME_HEIGHT - SCREEN_PAD - radius;
    this.innerRadius = radius - FRAME_PAD;

    this.frame = new Panel(scene, this.centerX, this.centerY, size, size);
    this.mapGfx = scene.add.graphics();
    this.blipGfx = scene.add.graphics();
    this.blipGfx.setPosition(this.centerX, this.centerY);

    // Circular stencil shared by both dynamic layers. Kept off the display
    // list so it only ever acts as a mask, never renders directly.
    this.maskShape = scene.make.graphics({ x: 0, y: 0 }, false);
    this.maskShape.setScrollFactor(0);
    this.maskShape.fillStyle(0xffffff, 1);
    this.maskShape.fillCircle(this.centerX, this.centerY, this.innerRadius);
    this.clipMask = this.maskShape.createGeometryMask();
    this.mapGfx.setMask(this.clipMask);
    this.blipGfx.setMask(this.clipMask);

    this.add([this.frame, this.mapGfx, this.blipGfx]);
    this.setDepth(DepthLayers.HUD);
    this.setScrollFactor(0, 0, true);
  }

  /**
   * Rasterises the supplied city into the cached map layer exactly once.
   *
   * Tiles are collapsed into horizontal runs of a single colour per row to keep
   * the draw-call count low. The result is drawn in world-scaled coordinates
   * (world origin at the layer's local origin) so that later view re-centring is
   * a cheap reposition rather than a redraw.
   *
   * @param map The generated city description to render.
   */
  public setMap(map: MapData): void {
    const overview = map.overview;
    const tilePx = map.tileSize * overview.cellSizeTiles * MINIMAP_SCALE;
    this.mapGfx.clear();

    for (let y = 0; y < overview.height; y += 1) {
      const row = overview.tiles[y];
      if (row === undefined) {
        continue;
      }
      let x = 0;
      while (x < overview.width) {
        const runColor = MiniMap.colorForTile(row[x]);
        let runLen = 1;
        while (x + runLen < overview.width && MiniMap.colorForTile(row[x + runLen]) === runColor) {
          runLen += 1;
        }
        this.mapGfx.fillStyle(runColor, 1);
        this.mapGfx.fillRect(x * tilePx, y * tilePx, runLen * tilePx, tilePx);
        x += runLen;
      }
    }

    this.majorPoiCount = map.majorBuildings.length;
    for (const building of map.majorBuildings) {
      paintMajorBuildingIcon(
        this.mapGfx,
        building.minimapIcon,
        building.worldPosition.x * MINIMAP_SCALE,
        building.worldPosition.y * MINIMAP_SCALE,
        building.size === 'metropolitan' ? 6 : 5,
      );
    }
    // Transit stops remain tiny at radar scale but use a dedicated blue sign
    // glyph rather than being confused with service-building POIs.
    for (const stop of map.busStops) {
      const x = stop.x * MINIMAP_SCALE;
      const y = stop.y * MINIMAP_SCALE;
      this.mapGfx.fillStyle(0x38bdf8, 0.95);
      this.mapGfx.fillRect(x - 1.5, y - 3, 3, 6);
      this.mapGfx.fillStyle(0xe6f6ff, 0.95);
      this.mapGfx.fillRect(x - 0.5, y - 2, 1, 2);
    }

    this.hasMap = true;
    this.applyViewOffset();
  }

  /**
   * Sets the world point that sits at the centre of the view window and slides
   * the cached map beneath the circular mask accordingly.
   *
   * @param x World-space x to centre on (pixels).
   * @param y World-space y to centre on (pixels).
   */
  public setViewCenter(x: number, y: number): void {
    this.viewCenterX = x;
    this.viewCenterY = y;
    this.applyViewOffset();
  }

  /**
   * Redraws the blip layer from scratch. World coordinates are translated
   * relative to the current view centre, scaled, and clipped to the circular
   * window; blips falling outside the radius are skipped. A player marker is
   * always drawn at the centre.
   *
   * @param blips The markers to render this frame.
   */
  public setBlips(blips: ReadonlyArray<MiniMapBlip>): void {
    this.blipGfx.clear();

    for (const blip of blips) {
      const mx = (blip.x - this.viewCenterX) * MINIMAP_SCALE;
      const my = (blip.y - this.viewCenterY) * MINIMAP_SCALE;
      const dotSize = blip.size ?? BLIP_DEFAULT_SIZE;
      if (Math.hypot(mx, my) > this.innerRadius - dotSize) {
        continue;
      }
      this.blipGfx.fillStyle(blip.color, 1);
      this.blipGfx.fillCircle(mx, my, dotSize);
    }

    // Player is implicitly at the view centre.
    this.blipGfx.fillStyle(COLORS.ACCENT, 1);
    this.blipGfx.fillCircle(0, 0, PLAYER_MARKER_SIZE);
  }

  public debugSnapshot(): {
    hasMap: boolean;
    majorPoiCount: number;
    scale: number;
    viewCenter: { x: number; y: number };
  } {
    return {
      hasMap: this.hasMap,
      majorPoiCount: this.majorPoiCount,
      scale: MINIMAP_SCALE,
      viewCenter: { x: this.viewCenterX, y: this.viewCenterY },
    };
  }

  /** Move the already-built minimap to a safe screen-space location. */
  public setScreenPosition(centerX: number, centerY: number): void {
    this.centerX = Math.round(centerX);
    this.centerY = Math.round(centerY);
    this.frame.setPosition(this.centerX, this.centerY);
    this.blipGfx.setPosition(this.centerX, this.centerY);
    this.maskShape.clear();
    this.maskShape.fillStyle(0xffffff, 1);
    this.maskShape.fillCircle(this.centerX, this.centerY, this.innerRadius);
    this.applyViewOffset();
  }

  /**
   * Repositions the cached map so the current view centre lands at the middle
   * of the mask window. No-op until a map has been rasterised.
   */
  private applyViewOffset(): void {
    if (!this.hasMap) {
      return;
    }
    this.mapGfx.setPosition(
      this.centerX - this.viewCenterX * MINIMAP_SCALE,
      this.centerY - this.viewCenterY * MINIMAP_SCALE,
    );
  }

  /**
   * Maps a raw tile value to its minimap fill colour, grouping the road-family
   * tiles together and treating any unknown value as grass.
   *
   * @param tile A {@link TileType} value (or `undefined` from a sparse row).
   * @returns The `0xRRGGBB` colour to paint the tile.
   */
  private static colorForTile(tile: number | undefined): number {
    switch (tile) {
      case TileType.Water:
        return COLORS.WATER;
      case TileType.Road:
      case TileType.RoadLineH:
      case TileType.RoadLineV:
      case TileType.Crossing:
        return COLORS.ROAD;
      case TileType.Sidewalk:
        return COLORS.SIDEWALK;
      case TileType.Building:
        return COLORS.BUILDING;
      case TileType.BuildingRes:
        return 0x8c6b58;
      case TileType.BuildingInd:
        return 0x59636d;
      case TileType.Sand:
        return 0xd7b96a;
      case TileType.Dirt:
        return 0x8a6840;
      case TileType.Rock:
        return 0x4d5561;
      case TileType.Concrete:
        return 0x7d858f;
      case TileType.Runway:
        return 0x262a32;
      case TileType.Dock:
        return 0x7b5435;
      default:
        return COLORS.GRASS;
    }
  }

  /**
   * Releases the mask resources before tearing down the container and its
   * child game objects.
   */
  public override destroy(fromScene?: boolean): void {
    this.mapGfx.clearMask();
    this.blipGfx.clearMask();
    this.clipMask.destroy();
    this.maskShape.destroy();
    super.destroy(fromScene);
  }
}
