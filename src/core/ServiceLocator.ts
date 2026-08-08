/**
 * A tiny, type-safe service registry (a pragmatic form of dependency
 * injection).
 *
 * Managers are registered once at bootstrap under their {@link ServiceKeys}
 * value and resolved on demand elsewhere. This avoids both global singletons
 * scattered across modules and the ceremony of a full DI container.
 *
 * Usage:
 * ```ts
 * ServiceLocator.register(soundManager);
 * const sound = ServiceLocator.resolve<SoundManager>(ServiceKeys.Sound);
 * ```
 */
import type { ServiceKeys } from '@/config/ServiceKeys';
import type { IManager } from '@/core/interfaces';

export class ServiceLocator {
  /** Backing store — key → manager instance. */
  private static readonly services = new Map<ServiceKeys, IManager>();

  /** Prevent instantiation; the locator is a static utility. */
  private constructor() {}

  /**
   * Register a manager under its own {@link IManager.key}.
   * @throws if a manager is already registered under that key.
   */
  public static register(manager: IManager): void {
    if (this.services.has(manager.key)) {
      throw new Error(
        `[ServiceLocator] A service is already registered for key "${manager.key}".`,
      );
    }
    this.services.set(manager.key, manager);
  }

  /**
   * Resolve a required service.
   * @throws if nothing is registered under `key`.
   */
  public static resolve<T extends IManager>(key: ServiceKeys): T {
    const service = this.services.get(key);
    if (!service) {
      throw new Error(
        `[ServiceLocator] No service registered for key "${key}". ` +
          `Did you forget to register it during bootstrap?`,
      );
    }
    return service as T;
  }

  /** Resolve an optional service, returning `null` when absent. */
  public static tryResolve<T extends IManager>(key: ServiceKeys): T | null {
    return (this.services.get(key) as T | undefined) ?? null;
  }

  /** Whether a service is registered under `key`. */
  public static has(key: ServiceKeys): boolean {
    return this.services.has(key);
  }

  /** Remove a single service from the registry. */
  public static unregister(key: ServiceKeys): void {
    this.services.delete(key);
  }

  /** A snapshot of every registered service (registration order). */
  public static all(): readonly IManager[] {
    return Array.from(this.services.values());
  }

  /** Remove every registered service. Primarily for teardown/tests. */
  public static clear(): void {
    this.services.clear();
  }
}
