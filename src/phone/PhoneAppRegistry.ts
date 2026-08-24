import type { PhoneAppAvailabilityContext, PhoneAppDefinition } from './PhoneTypes';

/** Registry for future phone applications; intentionally empty in v1. */
export class PhoneAppRegistry {
  private readonly apps = new Map<string, PhoneAppDefinition>();

  /** Register one app. Duplicate or blank ids are rejected deterministically. */
  public register(app: PhoneAppDefinition): void {
    const id = app.id.trim();
    if (id.length === 0) throw new Error('Phone app id must not be empty');
    if (this.apps.has(id)) throw new Error(`Phone app already registered: ${id}`);
    this.apps.set(id, app);
  }

  /** Remove an app by id. */
  public unregister(id: string): boolean {
    return this.apps.delete(id);
  }

  /** Find one registered app by stable id. */
  public get(id: string): PhoneAppDefinition | null {
    return this.apps.get(id) ?? null;
  }

  /** Return all registered apps in deterministic home-screen order. */
  public list(): PhoneAppDefinition[] {
    return [...this.apps.values()].sort(PhoneAppRegistry.compareApps);
  }

  /** Return only currently available apps in deterministic order. */
  public listAvailable(context: PhoneAppAvailabilityContext): PhoneAppDefinition[] {
    return this.list().filter((app) => app.isAvailable?.(context) ?? true);
  }

  /** Number of registered apps (zero for the initial shell). */
  public get size(): number {
    return this.apps.size;
  }

  /** Remove every app during manager teardown. */
  public clear(): void {
    this.apps.clear();
  }

  private static compareApps(a: PhoneAppDefinition, b: PhoneAppDefinition): number {
    const order = (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
    return order !== 0 ? order : a.id.localeCompare(b.id);
  }
}

