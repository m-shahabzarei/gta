/**
 * A single, strongly-typed, global publish/subscribe hub.
 *
 * Managers and systems communicate exclusively through this bus rather than
 * holding references to one another. That keeps the engine decoupled: any
 * producer can emit an event without knowing (or caring) who consumes it.
 *
 * Type safety comes from {@link EventPayloadMap}: `emit`/`on`/`once` are checked
 * against the declared payload for each {@link EventKeys} value, so a mismatched
 * payload or handler signature is a compile-time error.
 *
 * The implementation is a small, self-contained emitter (no Phaser dependency)
 * so it can be unit-tested in isolation and used before the game boots.
 */
import type { EventPayloadMap } from '@/core/types';
import type { Unsubscribe } from '@/core/types';
import { ENGINE_LIMITS } from '@/config/EngineLimits';
import { EngineDiagnostics } from '@/core/EngineDiagnostics';

/** Any key of the event map. */
type EventKey = keyof EventPayloadMap;

/** Handler type for a given event key. */
type Handler<K extends EventKey> = (payload: EventPayloadMap[K]) => void;

/**
 * Conditional argument tuple: void-payload events are emitted with no argument,
 * everything else requires its payload.
 */
type EmitArgs<K extends EventKey> = EventPayloadMap[K] extends void
  ? []
  : [payload: EventPayloadMap[K]];

/** Internal record of a single subscription. */
interface Listener {
  fn: (payload: unknown) => void;
  context: unknown;
  once: boolean;
}

/**
 * The typed event bus. Prefer the shared {@link eventBus} singleton; the class
 * is exported for tests that need an isolated instance.
 */
export class EventBus {
  /** event name → ordered list of listeners. */
  private readonly listeners = new Map<EventKey, Listener[]>();
  private dispatchDepth = 0;
  private topLevelDispatches = 0;

  /**
   * Subscribe to an event.
   * @returns an unsubscribe function that removes exactly this listener.
   */
  public on<K extends EventKey>(event: K, fn: Handler<K>, context?: unknown): Unsubscribe {
    return this.addListener(event, fn as Listener['fn'], context, false);
  }

  /** Subscribe to the next occurrence of an event only. */
  public once<K extends EventKey>(event: K, fn: Handler<K>, context?: unknown): Unsubscribe {
    return this.addListener(event, fn as Listener['fn'], context, true);
  }

  /**
   * Remove a previously registered listener. When `context` was supplied to
   * {@link on}/{@link once}, the same `context` must be passed here.
   */
  public off<K extends EventKey>(event: K, fn: Handler<K>, context?: unknown): void {
    const bucket = this.listeners.get(event);
    if (!bucket) return;
    const remaining = bucket.filter(
      (l) => l.fn !== (fn as Listener['fn']) || l.context !== context,
    );
    if (remaining.length > 0) {
      this.listeners.set(event, remaining);
    } else {
      this.listeners.delete(event);
    }
  }

  /**
   * Emit an event. Void-payload events take no second argument; all others
   * require their typed payload.
   */
  public emit<K extends EventKey>(event: K, ...args: EmitArgs<K>): void {
    const bucket = this.listeners.get(event);
    if (!bucket || bucket.length === 0) return;
    if (this.dispatchDepth >= ENGINE_LIMITS.MAX_EVENT_DISPATCH_DEPTH) {
      EngineDiagnostics.recordDroppedEvent(String(event), 'event-dispatch-depth-limit');
      return;
    }
    if (this.dispatchDepth === 0) this.topLevelDispatches = 0;
    this.topLevelDispatches += 1;
    if (this.topLevelDispatches > ENGINE_LIMITS.MAX_ACTIVE_EVENTS) {
      EngineDiagnostics.recordDroppedEvent(String(event), 'event-dispatch-count-limit');
      return;
    }
    if (bucket.length > ENGINE_LIMITS.MAX_EVENT_LISTENERS) {
      EngineDiagnostics.recordLimitExceeded(
        'MAX_EVENT_LISTENERS',
        bucket.length,
        ENGINE_LIMITS.MAX_EVENT_LISTENERS,
        'capped-listener-snapshot',
        String(event),
      );
    }

    const payload = args[0] as unknown;
    // Iterate a snapshot so handlers may safely (un)subscribe during dispatch.
    const snapshot = bucket.slice(0, ENGINE_LIMITS.MAX_EVENT_LISTENERS);
    this.dispatchDepth += 1;
    EngineDiagnostics.beginEvent(String(event), this.dispatchDepth);
    try {
      for (const listener of snapshot) {
        if (listener.once) {
          this.off(event, listener.fn as Handler<K>, listener.context);
        }
        try {
          if (listener.context !== undefined) {
            listener.fn.call(listener.context, payload);
          } else {
            listener.fn(payload);
          }
        } catch (error) {
          EngineDiagnostics.recordEventListenerError(String(event), error);
          console.error(`[EventBus] listener failed for ${String(event)}`, error);
        }
      }
    } finally {
      this.dispatchDepth = Math.max(0, this.dispatchDepth - 1);
      EngineDiagnostics.endEvent(this.dispatchDepth);
    }
  }

  /** Remove every listener for one event, or all events when omitted. */
  public removeAll(event?: EventKey): void {
    if (event === undefined) {
      this.listeners.clear();
    } else {
      this.listeners.delete(event);
    }
  }

  /** Number of listeners currently registered for an event. */
  public listenerCount(event: EventKey): number {
    return this.listeners.get(event)?.length ?? 0;
  }

  /** Shared registration path for {@link on} and {@link once}. */
  private addListener(
    event: EventKey,
    fn: Listener['fn'],
    context: unknown,
    once: boolean,
  ): Unsubscribe {
    const bucket = this.listeners.get(event) ?? [];
    const listener: Listener = { fn, context, once };
    bucket.push(listener);
    this.listeners.set(event, bucket);
    return () => {
      const current = this.listeners.get(event);
      if (!current) return;
      const idx = current.indexOf(listener);
      if (idx !== -1) current.splice(idx, 1);
      if (current.length === 0) this.listeners.delete(event);
    };
  }
}

/**
 * The process-wide event bus. Import this everywhere:
 * `import { eventBus } from '@/core/EventBus';`
 */
export const eventBus = new EventBus();
