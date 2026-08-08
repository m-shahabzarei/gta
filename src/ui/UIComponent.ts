/**
 * Abstract base class for every UI widget in the engine.
 *
 * A `UIComponent` is a thin, opinionated wrapper around a
 * {@link Phaser.GameObjects.Container}: subclasses (labels, buttons, panels,
 * progress bars, the HUD, …) build their visuals as child game objects and add
 * them to `this`. The base class handles the boilerplate that every widget
 * shares — registering itself with the scene's display list and providing a
 * uniform enabled/disabled toggle that hides the widget and suspends its
 * pointer input.
 */

import Phaser from 'phaser';

/**
 * Base class for all composite UI widgets. Extends
 * {@link Phaser.GameObjects.Container} so child game objects are positioned
 * relative to the component and can be moved/scaled/depth-sorted as a unit.
 */
export abstract class UIComponent extends Phaser.GameObjects.Container {
  /** The scene this component lives in (stored for subclass convenience). */
  protected readonly uiScene: Phaser.Scene;

  /**
   * @param scene The owning scene; the component adds itself to its display list.
   * @param x Container x position, in scene coordinates.
   * @param y Container y position, in scene coordinates.
   */
  constructor(scene: Phaser.Scene, x = 0, y = 0) {
    super(scene, x, y);
    this.uiScene = scene;
    scene.add.existing(this);
  }

  /**
   * Show/hide the widget and enable/disable its pointer input in one call.
   *
   * Visibility and the active flag are toggled on the container, and, when the
   * container itself has been made interactive, its input is disabled so it no
   * longer responds to the pointer while hidden.
   *
   * @param enabled `true` to show and re-enable input, `false` to hide/disable.
   * @returns This component, for chaining.
   */
  public setEnabled(enabled: boolean): this {
    this.setVisible(enabled);
    this.setActive(enabled);
    if (this.input) {
      this.input.enabled = enabled;
    }
    return this;
  }

  /**
   * Convenience helper for subclasses: add one or more child game objects to
   * this container and return the component for fluent construction.
   *
   * @param children The game object(s) to parent under this component.
   * @returns This component, for chaining.
   */
  protected addChildren(children: Phaser.GameObjects.GameObject | Phaser.GameObjects.GameObject[]): this {
    this.add(children);
    return this;
  }
}
