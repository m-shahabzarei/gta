/**
 * Button UI component.
 *
 * A reusable, self-contained clickable button built on {@link UIComponent}.
 * It renders a rounded-rectangle background via {@link Phaser.GameObjects.Graphics}
 * and a centered {@link Label}. The button reacts to pointer hover/selection by
 * brightening its border, and invokes an optional click callback on pointer-up.
 *
 * This is a Phase-1 engine primitive: it carries no gameplay logic, only the
 * reusable interaction + rendering behaviour that gameplay screens sit on.
 */

import Phaser from 'phaser';
import { UIComponent } from '@/ui/UIComponent';
import { Label } from '@/ui/components/Label';
import { COLORS } from '@/config/Constants';

/** Construction options for a {@link Button}. */
export interface ButtonConfig {
  /** Caption text rendered on the button. */
  text: string;
  /** Button width in pixels (default 200). */
  width?: number;
  /** Button height in pixels (default 44). */
  height?: number;
  /** Callback invoked on a completed click (pointer-up). */
  onClick?: () => void;
}

/** Default button dimensions. */
const DEFAULT_WIDTH = 200;
const DEFAULT_HEIGHT = 44;
/** Corner radius for the rounded-rectangle background. */
const CORNER_RADIUS = 8;
/** Border stroke width. */
const BORDER_WIDTH = 2;

/**
 * A clickable, hover-aware button with a rounded background and centered label.
 */
export class Button extends UIComponent {
  private readonly bg: Phaser.GameObjects.Graphics;
  private readonly label: Label;
  /** Button width in pixels (named to avoid clashing with Container sizing). */
  private readonly btnWidth: number;
  /** Button height in pixels. */
  private readonly btnHeight: number;

  private hovered = false;
  private selected = false;
  private pressed = false;
  private onClick?: () => void;

  /**
   * @param scene  Owning scene.
   * @param x      Container x position.
   * @param y      Container y position.
   * @param config Button caption, size, and click handler.
   */
  constructor(scene: Phaser.Scene, x: number, y: number, config: ButtonConfig) {
    super(scene, x, y);

    this.btnWidth = config.width ?? DEFAULT_WIDTH;
    this.btnHeight = config.height ?? DEFAULT_HEIGHT;
    this.onClick = config.onClick;

    this.bg = this.uiScene.add.graphics();
    this.add(this.bg);

    // Horizontally centre the caption across the button width; the vertical
    // offset approximately centres the default 16px font within the height.
    this.label = new Label(this.uiScene, -this.btnWidth / 2, -8, config.text, {
      color: '#' + COLORS.TEXT.toString(16).padStart(6, '0'),
      align: 'center',
      fixedWidth: this.btnWidth,
    });
    this.add(this.label);

    this.redraw();

    this.setInteractive(
      new Phaser.Geom.Rectangle(-this.btnWidth / 2, -this.btnHeight / 2, this.btnWidth, this.btnHeight),
      Phaser.Geom.Rectangle.Contains,
    );

    this.on('pointerover', this.handlePointerOver, this);
    this.on('pointerout', this.handlePointerOut, this);
    this.on('pointerdown', this.handlePointerDown, this);
    this.on('pointerup', this.handlePointerUp, this);
    this.on('pointerupoutside', this.handlePointerOut, this);
  }

  /**
   * Update the button caption.
   * @param text New caption text.
   */
  public setText(text: string): this {
    this.label.setText(text);
    return this;
  }

  /**
   * Replace the click callback.
   * @param cb Handler invoked on pointer-up.
   */
  public setOnClick(cb: () => void): this {
    this.onClick = cb;
    return this;
  }

  /**
   * Toggle the selected (highlighted) state and redraw.
   * @param sel Whether the button is selected.
   */
  public setSelected(sel: boolean): this {
    this.selected = sel;
    this.redraw();
    return this;
  }

  /** Pointer entered the button — brighten and redraw. */
  private handlePointerOver(): void {
    this.hovered = true;
    this.redraw();
  }

  /** Pointer left the button — restore and redraw. */
  private handlePointerOut(): void {
    this.hovered = false;
    this.pressed = false;
    this.redraw();
  }

  /** Pointer pressed — keep the visual feedback inside the hit target. */
  private handlePointerDown(
    _pointer: Phaser.Input.Pointer,
    _localX: number,
    _localY: number,
    event: Phaser.Types.Input.EventData,
  ): void {
    event.stopPropagation();
    this.pressed = true;
    this.redraw();
  }

  /** Pointer released over the button — fire the click callback if present. */
  private handlePointerUp(
    _pointer: Phaser.Input.Pointer,
    _localX: number,
    _localY: number,
    event: Phaser.Types.Input.EventData,
  ): void {
    event.stopPropagation();
    const wasPressed = this.pressed;
    this.pressed = false;
    this.redraw();
    if (wasPressed && this.onClick !== undefined) {
      this.onClick();
    }
  }

  /** Redraw the background using the current hover/selected state. */
  private redraw(): void {
    const highlighted = this.hovered || this.selected || this.pressed;
    const borderColor = highlighted ? COLORS.ACCENT : COLORS.UI_BORDER;
    const halfW = this.btnWidth / 2;
    const halfH = this.btnHeight / 2;

    this.bg.clear();
    this.bg.fillStyle(this.pressed ? COLORS.UI_BORDER : COLORS.UI_PANEL, 1);
    this.bg.fillRoundedRect(-halfW, -halfH, this.btnWidth, this.btnHeight, CORNER_RADIUS);
    this.bg.lineStyle(BORDER_WIDTH, borderColor, 1);
    this.bg.strokeRoundedRect(-halfW, -halfH, this.btnWidth, this.btnHeight, CORNER_RADIUS);
  }
}
