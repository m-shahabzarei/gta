import type { ServiceKeys } from '@/config/ServiceKeys';
import type { IDestroyable } from './IDestroyable';

/**
 * The contract every engine service (manager or system) fulfils.
 *
 * Lifecycle:
 *   1. `constructor(game)` — cheap wiring only, no heavy work.
 *   2. `init()`           — acquire resources; may be async.
 *   3. `update()`         — optional per-frame tick (see {@link IUpdatable}).
 *   4. `destroy()`        — release everything.
 */
export interface IManager extends IDestroyable {
  /** The service-locator key this manager is registered under. */
  readonly key: ServiceKeys;

  /** Whether {@link init} has completed successfully. */
  readonly isInitialised: boolean;

  /** Acquire resources and wire up event listeners. */
  init(): void | Promise<void>;
}
