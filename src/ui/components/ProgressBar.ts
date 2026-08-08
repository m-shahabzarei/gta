/**
 * ProgressBar UI component.
 *
 * A horizontal, left-aligned bar consisting of a static background rectangle
 * and a foreground fill rectangle whose width represents a 0..1 ratio. Used by
 * the HUD (health) and any other progress-style readouts. Extends
 * {@link UIComponent} so it is a self-managed Phaser container.
 */

import Phaser from 'phaser';
import { UIComponent } from '@/ui/UIComponent';
import { COLORS } from '@/config/Constants';
import { clamp } from '@/utils';

/** Optional visual configuration for a {@link ProgressBar}. */
export interface ProgressBarConfig {
  /** Fill colour (0xRRGGBB). Defaults to {@link COLORS.HEALTH}. */
  color?: number;
  /** Background colour (0xRRGGBB). Defaults to black. */
  background?: number;
}

/**
 * A clamped 0..1 progress bar with a coloured fill over a dim background.
 */
export class ProgressBar extends UIComponent {
  /** Configured full width of the bar, in pixels. */
  private readonly barWidth: number;
  /** Static background rectangle. */
  private readonly background: Phaser.GameObjects.Rectangle;
  /** Foreground fill rectangle whose width tracks the current ratio. */
  private readonly fill: Phaser.GameObjects.Rectangle;

  /**
   * @param scene  Owning scene.
   * @param x      Container x position.
   * @param y      Container y position.
   * @param width  Full pixel width of the bar at ratio 1.
   * @param height Pixel height of the bar.
   * @param config Optional fill/background colours.
   */
  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    width: number,
    height: number,
    config: ProgressBarConfig = {},
  ) {
    super(scene, x, y);

    this.barWidth = width;

    const backgroundColor = config.background ?? 0x000000;
    const fillColor = config.color ?? COLORS.HEALTH;

    this.background = this.uiScene.add
      .rectangle(0, 0, width, height, backgroundColor, 0.6)
      .setOrigin(0, 0.5);

    this.fill = this.uiScene.add
      .rectangle(0, 0, width, height, fillColor, 1)
      .setOrigin(0, 0.5);

    this.add([this.background, this.fill]);
  }

  /**
   * Set the fill ratio. Values are clamped to the inclusive range 0..1 and the
   * fill width is updated to `width * ratio`.
   *
   * @param ratio Progress ratio in the range 0..1.
   * @returns this, for chaining.
   */
  public setValue(ratio: number): this {
    const clamped = clamp(ratio, 0, 1);
    this.fill.width = this.barWidth * clamped;
    return this;
  }

  /**
   * Update the fill colour.
   *
   * @param color New fill colour (0xRRGGBB).
   * @returns this, for chaining.
   */
  public setColor(color: number): this {
    this.fill.setFillStyle(color, 1);
    return this;
  }
}
