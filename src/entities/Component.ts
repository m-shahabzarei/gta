/**
 * Base class for a reusable, composable piece of entity behaviour.
 *
 * The game uses composition over inheritance: an {@link Entity} is a thin host
 * that owns a Phaser sprite and a set of `Component`s (movement, health,
 * ai, weapon, …). Each component is self-contained and reusable across entity
 * types. Phase 2 gameplay is built almost entirely from concrete components.
 */
import type { Entity } from './Entity';

export abstract class Component {
  /** Unique component id within its host entity. */
  public abstract readonly name: string;

  private host: Entity | null = null;

  /** The entity this component belongs to. */
  protected get entity(): Entity {
    if (!this.host) {
      throw new Error(`Component "${this.name}" is not attached to an entity.`);
    }
    return this.host;
  }

  /**
   * Bind the component to its host. Called by {@link Entity.addComponent};
   * not intended to be called directly.
   */
  public bind(entity: Entity): void {
    this.host = entity;
    this.onAttach();
  }

  /** Hook invoked once the component is bound to its host. */
  protected onAttach(): void {}

  /** Per-frame update; overridden by components that need to tick. */
  public update(_time: number, _delta: number): void {}

  /** Release any resources held by the component. */
  public destroy(): void {
    this.host = null;
  }
}
