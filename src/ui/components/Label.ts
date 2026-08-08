/**
 * Label — a lightweight text UI component.
 *
 * Wraps a single {@link Phaser.GameObjects.Text} object inside a
 * {@link UIComponent} container, applying the engine's pixel-friendly text
 * defaults (Courier New, 16px, {@link COLORS.TEXT}) which callers may override
 * via the optional style argument. Used everywhere the HUD and menus need a
 * simple, updatable string.
 */

import type Phaser from 'phaser';
import { UIComponent } from '@/ui/UIComponent';
import { COLORS } from '@/config/Constants';

/** Default text styling shared by every Label unless explicitly overridden. */
const DEFAULT_TEXT_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontFamily: 'Courier New',
  fontSize: '16px',
  color: '#' + COLORS.TEXT.toString(16).padStart(6, '0'),
};

/**
 * A container-wrapped text object with a convenient get/set text API.
 */
export class Label extends UIComponent {
  /** The underlying Phaser text object rendered by this label. */
  private readonly textObject: Phaser.GameObjects.Text;

  /**
   * @param scene Owning scene.
   * @param x Container x position.
   * @param y Container y position.
   * @param text Initial text content.
   * @param style Optional style overrides merged over the pixel defaults.
   */
  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    text: string,
    style?: Phaser.Types.GameObjects.Text.TextStyle,
  ) {
    super(scene, x, y);
    const merged: Phaser.Types.GameObjects.Text.TextStyle = { ...DEFAULT_TEXT_STYLE, ...style };
    this.textObject = this.uiScene.add.text(0, 0, text, merged);
    this.add(this.textObject);
  }

  /**
   * Replaces the rendered text.
   * @param text New text content.
   * @returns This label for chaining.
   */
  public setText(text: string): this {
    this.textObject.setText(text);
    return this;
  }

  /** Update the text tint while preserving the label container contract. */
  public setColor(color: string): this {
    this.textObject.setColor(color);
    return this;
  }

  /** @returns The current text content. */
  public getText(): string {
    return this.textObject.text;
  }
}
