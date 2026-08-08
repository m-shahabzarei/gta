/**
 * Abstract base class for every engine manager.
 *
 * It standardises the manager lifecycle and removes boilerplate:
 *  - holds the {@link Phaser.Game} reference and a scoped {@link Logger};
 *  - tracks initialisation state and enforces idempotent `init`/`destroy`;
 *  - provides a `subscribe` helper that auto-unsubscribes on `destroy`, so a
 *    manager can never leak event listeners.
 *
 * Concrete managers implement {@link onInit} (and optionally {@link onDestroy}
 * / `update`) instead of overriding the public lifecycle methods.
 */
import type Phaser from 'phaser';
import type { ServiceKeys } from '@/config/ServiceKeys';
import type { IManager } from '@/core/interfaces';
import type { EventPayloadMap } from '@/core/types';
import type { Unsubscribe } from '@/core/types';
import { eventBus } from '@/core/EventBus';
import { Logger } from '@/utils/Logger';

export abstract class BaseManager implements IManager {
  /** The service-locator key; each concrete manager pins this. */
  public abstract readonly key: ServiceKeys;

  /** The running Phaser game instance. */
  protected readonly game: Phaser.Game;

  /** The shared, typed event bus. */
  protected readonly bus = eventBus;

  /** Manager-scoped logger. */
  protected readonly log: Logger;

  /** Live event subscriptions, torn down on {@link destroy}. */
  private readonly subscriptions: Unsubscribe[] = [];

  private initialised = false;

  constructor(game: Phaser.Game) {
    this.game = game;
    this.log = Logger.create(this.constructor.name);
  }

  /** Whether {@link init} has completed. */
  public get isInitialised(): boolean {
    return this.initialised;
  }

  /**
   * Public lifecycle entry point. Idempotent: calling twice is a no-op.
   * Delegates the real work to {@link onInit}.
   */
  public async init(): Promise<void> {
    if (this.initialised) return;
    await this.onInit();
    this.initialised = true;
    this.log.debug('initialised');
  }

  /**
   * Public teardown. Removes all tracked subscriptions, then delegates to
   * {@link onDestroy}. Safe to call more than once.
   */
  public destroy(): void {
    for (const unsub of this.subscriptions) unsub();
    this.subscriptions.length = 0;
    if (this.initialised) {
      this.onDestroy();
      this.initialised = false;
    }
  }

  /** Concrete managers acquire their resources here. */
  protected abstract onInit(): void | Promise<void>;

  /** Optional teardown hook; default is a no-op. */
  protected onDestroy(): void {}

  /**
   * Subscribe to a bus event for the lifetime of this manager. The listener is
   * removed automatically in {@link destroy}, so managers never leak handlers.
   */
  protected subscribe<K extends keyof EventPayloadMap>(
    event: K,
    handler: (payload: EventPayloadMap[K]) => void,
  ): void {
    this.subscriptions.push(eventBus.on(event, handler.bind(this)));
  }
}
