import type { PhoneAppAvailabilityContext, PhoneAppDefinition } from './PhoneTypes';

/** Registration flags used to keep installed apps separate from the catalog. */
export interface PhoneAppRegistrationOptions {
  /** Add the app to the current phone's installed set (default: true). */
  installed?: boolean;
  /** Expose the app in the Store catalog when it is installable. */
  catalog?: boolean;
}

/** Registry for phone definitions, installed apps, and future Store entries. */
export class PhoneAppRegistry {
  private readonly apps = new Map<string, PhoneAppDefinition>();
  private readonly installed = new Set<string>();
  private readonly catalog = new Set<string>();

  /** Register one app. Duplicate or blank ids are rejected deterministically. */
  public register(app: PhoneAppDefinition, options: PhoneAppRegistrationOptions = {}): void {
    const id = app.id.trim();
    if (id.length === 0) throw new Error('Phone app id must not be empty');
    if (this.apps.has(id)) throw new Error(`Phone app already registered: ${id}`);
    this.apps.set(id, app);
    if (app.systemApp === true || options.installed !== false) this.installed.add(id);
    if (options.catalog === true && app.systemApp !== true && app.installable === true) {
      this.catalog.add(id);
    }
  }

  /** Remove an app by id. */
  public unregister(id: string): boolean {
    const normalized = id.trim();
    const app = this.apps.get(normalized);
    if (app?.systemApp === true) return false;
    this.installed.delete(normalized);
    this.catalog.delete(normalized);
    return this.apps.delete(normalized);
  }

  /** Find one registered app by stable id. */
  public get(id: string): PhoneAppDefinition | null {
    return this.apps.get(id.trim()) ?? null;
  }

  /** Return all registered apps in deterministic home-screen order. */
  public list(): PhoneAppDefinition[] {
    return [...this.apps.values()].sort(PhoneAppRegistry.compareApps);
  }

  /** Return only currently available apps in deterministic order. */
  public listAvailable(context: PhoneAppAvailabilityContext): PhoneAppDefinition[] {
    return this.listInstalled(context);
  }

  /** Return currently installed apps in deterministic home-screen order. */
  public listInstalled(context: PhoneAppAvailabilityContext): PhoneAppDefinition[] {
    return this.list().filter(
      (app) => this.installed.has(app.id.trim()) && (app.isAvailable?.(context) ?? true),
    );
  }

  /** Return installable catalog entries; the Store itself is never a catalog item. */
  public listCatalogApps(context?: PhoneAppAvailabilityContext): PhoneAppDefinition[] {
    return this.list().filter(
      (app) =>
        this.catalog.has(app.id.trim()) &&
        !this.installed.has(app.id.trim()) &&
        app.systemApp !== true &&
        app.installable === true &&
        (context ? app.isAvailable?.(context) ?? true : true),
    );
  }

  /** Whether an app is currently installed on this phone. */
  public isInstalled(appId: string): boolean {
    return this.installed.has(appId.trim());
  }

  /** Whether a catalog definition can be installed now. */
  public canInstall(appId: string): boolean {
    const app = this.get(appId);
    return app !== null && app.systemApp !== true && app.installable === true &&
      this.catalog.has(app.id.trim()) && !this.installed.has(app.id.trim());
  }

  /** Install a catalog app, returning false for unknown or protected ids. */
  public installApp(appId: string): boolean {
    const app = this.get(appId);
    if (!app || !this.canInstall(appId)) return false;
    this.installed.add(app.id.trim());
    return true;
  }

  /** Uninstall a non-system app, returning false for protected or unknown ids. */
  public uninstallApp(appId: string): boolean {
    const app = this.get(appId);
    if (!app || app.systemApp === true || !app.installable || !this.installed.has(app.id.trim())) return false;
    this.installed.delete(app.id.trim());
    return true;
  }

  /** Number of registered definitions, including the built-in Store. */
  public get size(): number {
    return this.apps.size;
  }

  /** Remove every app during manager teardown. */
  public clear(): void {
    this.apps.clear();
    this.installed.clear();
    this.catalog.clear();
  }

  /** JSON-safe installed ids used by PhoneManager save state. */
  public serializeInstalled(): string[] {
    return [...this.installed].sort();
  }

  /** Restore only known, installable ids; system apps are always re-seeded. */
  public restoreInstalled(ids: readonly string[]): void {
    for (const id of this.apps.keys()) {
      const app = this.apps.get(id);
      if (app?.systemApp !== true) this.installed.delete(id);
    }
    for (const id of ids) {
      const app = this.get(id);
      if (app && app.systemApp !== true) {
        this.installed.add(app.id);
      }
    }
    for (const [id, app] of this.apps) {
      if (app.systemApp === true) this.installed.add(id);
    }
  }

  private static compareApps(a: PhoneAppDefinition, b: PhoneAppDefinition): number {
    const order = (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
    return order !== 0 ? order : a.id.localeCompare(b.id);
  }
}
