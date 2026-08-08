/**
 * Panel — a reusable filled, bordered, rounded-rectangle UI surface.
 *
 * Panels are the visual backing for menus, dialogs and HUD groupings. The
 * rectangle is drawn centered on the container origin (from -w/2,-h/2) so the
 * panel positions by its center, matching the convention of the other UI
 * components. Drawing is done with a single {@link Phaser.GameObjects.Graphics}
 * added into the container.
 */

import Phaser from 'phaser';
import { UIComponent } from '@/ui/UIComponent';
import { COLORS } from '@/config/Constants';

/** Optional appearance overrides for a {@link Panel}. */
export interface PanelConfig {
  /** Fill colour (0xRRGGBB). Defaults to {@link COLORS.UI_PANEL}. */
  fill?: number;
  /** Border colour (0xRRGGBB). Defaults to {@link COLORS.UI_BORDER}. */
  border?: number;
  /** Fill alpha (0..1). Defaults to 0.92. */
  alpha?: number;
}

/** Corner radius (pixels) applied to the panel's rounded rectangle. */
const CORNER_RADIUS = 8;

/** Border thickness (pixels). */
const BORDER_WIDTH = 2;

/** Default fill opacity when none is supplied. */
const DEFAULT_ALPHA = 0.92;

/**
 * A rounded, bordered rectangle drawn centered on its container origin.
 */
export class Panel extends UIComponent {
  private readonly graphics: Phaser.GameObjects.Graphics;
  private panelWidth: number;
  private panelHeight: number;
  private readonly fillColor: number;
  private readonly borderColor: number;
  private readonly fillAlpha: number;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    width: number,
    height: number,
    config?: PanelConfig,
  ) {
    super(scene, x, y);
    this.panelWidth = width;
    this.panelHeight = height;
    this.fillColor = config?.fill ?? COLORS.UI_PANEL;
    this.borderColor = config?.border ?? COLORS.UI_BORDER;
    this.fillAlpha = config?.alpha ?? DEFAULT_ALPHA;
    this.graphics = this.uiScene.add.graphics();
    this.add(this.graphics);
    this.redraw();
  }

  /**
   * Resize the panel and redraw it in place.
   *
   * @param width New width in pixels.
   * @param height New height in pixels.
   * @returns This instance for chaining.
   */
  public resize(width: number, height: number): this {
    this.panelWidth = width;
    this.panelHeight = height;
    this.redraw();
    return this;
  }

  /** Repaint the graphics from the current size and style. */
  private redraw(): void {
    const halfW = this.panelWidth / 2;
    const halfH = this.panelHeight / 2;
    this.graphics.clear();
    this.graphics.fillStyle(this.fillColor, this.fillAlpha);
    this.graphics.fillRoundedRect(
      -halfW,
      -halfH,
      this.panelWidth,
      this.panelHeight,
      CORNER_RADIUS,
    );
    this.graphics.lineStyle(BORDER_WIDTH, this.borderColor, 1);
    this.graphics.strokeRoundedRect(
      -halfW,
      -halfH,
      this.panelWidth,
      this.panelHeight,
      CORNER_RADIUS,
    );
  }
}
