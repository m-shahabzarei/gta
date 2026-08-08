/**
 * Base game entity: a lightweight host that binds a Phaser sprite to a set of
 * behavioural {@link Component}s.
 *
 * Entities carry no gameplay logic themselves — all behaviour lives in
 * components, which can be mixed and matched. This base class only manages the
 * component collection and the sprite lifecycle.
 */
import type Phaser from 'phaser';
import type { IDestroyable, IUpdatable } from '@/core/interfaces';
import { ENTITY_DATA_KEY } from '@/gameplay/types';
import type { Component } from './Component';

/** Monotonic id source so every entity gets a unique, stable identifier. */
let nextEntityId = 1;

export abstract class Entity implements IUpdatable, IDestroyable {
  /** Unique, stable id assigned at construction. */
  public readonly id: number = nextEntityId++;

  /** The visual/physics body this entity controls. */
  public readonly sprite: Phaser.Physics.Arcade.Sprite;

  /** Attached components, keyed by {@link Component.name}. */
  private readonly components = new Map<string, Component>();

  constructor(sprite: Phaser.Physics.Arcade.Sprite) {
    this.sprite = sprite;
    // Back-reference so Arcade collision callbacks (which only receive sprites)
    // can reach the owning entity via sprite.getData(ENTITY_DATA_KEY).
    this.sprite.setData(ENTITY_DATA_KEY, this);
  }

  /** Current world position of the entity's sprite. */
  public get position(): { x: number; y: number } {
    return { x: this.sprite.x, y: this.sprite.y };
  }

  /** Add a component and bind it to this entity. Returns the component. */
  public addComponent<T extends Component>(component: T): T {
    if (this.components.has(component.name)) {
      throw new Error(`Entity already has a component named "${component.name}".`);
    }
    this.components.set(component.name, component);
    component.bind(this);
    return component;
  }

  /** Retrieve a component by name, or `undefined` if absent. */
  public getComponent<T extends Component>(name: string): T | undefined {
    return this.components.get(name) as T | undefined;
  }

  /** Whether a component with the given name is attached. */
  public hasComponent(name: string): boolean {
    return this.components.has(name);
  }

  /** Advance every attached component. */
  public update(time: number, delta: number): void {
    for (const component of this.components.values()) {
      component.update(time, delta);
    }
  }

  /**
   * Advance a selected component subset without allocating an intermediate
   * collection. The central scheduler uses this for movement-only AI LOD.
   */
  public updateComponents(time: number, delta: number, names: readonly string[]): void {
    for (const name of names) {
      this.components.get(name)?.update(time, delta);
    }
  }

  /** Destroy all components and the underlying sprite. */
  public destroy(): void {
    for (const component of this.components.values()) {
      component.destroy();
    }
    this.components.clear();
    this.sprite.destroy();
  }
}
