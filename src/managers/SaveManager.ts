/**
 * Persistence manager for the engine.
 *
 * The SaveManager orchestrates save/load without knowing anything about
 * gameplay. It gathers every {@link ISerializable} provider (the registered
 * managers/systems plus any manually-registered gameplay providers), snapshots
 * each under its stable `saveId`, and writes the aggregate {@link SaveData} to
 * `localStorage`. Loading walks the same providers and restores their sections.
 *
 * All `localStorage` access is guarded: in environments where it is missing or
 * throws (SSR, privacy modes), the manager degrades to a logged no-op rather
 * than crashing the game.
 */
import { SAVE } from '@/config/Constants';
import { EventKeys } from '@/config/EventKeys';
import { ServiceKeys } from '@/config/ServiceKeys';
import type { ISerializable } from '@/core/interfaces';
import { isSerializable } from '@/core/interfaces';
import { ServiceLocator } from '@/core/ServiceLocator';
import type { Json, SaveData, SaveMeta, SaveSlotInfo } from '@/core/types';
import { BaseManager } from '@/core/BaseManager';

export class SaveManager extends BaseManager {
  /** Service-locator key for this manager. */
  public readonly key = ServiceKeys.Save;

  /** Gameplay providers registered manually (keyed by their `saveId`). */
  private readonly extraProviders = new Map<string, ISerializable>();

  /** No resources to acquire — persistence is stateless between calls. */
  protected onInit(): void {
    // Intentionally empty: the manager holds no long-lived state.
  }

  /**
   * Register a gameplay provider so its state is included in future saves.
   * Re-registering the same `saveId` replaces the previous provider.
   */
  public registerProvider(p: ISerializable): void {
    this.extraProviders.set(p.saveId, p);
  }

  /** Remove a previously-registered provider by its `saveId`. */
  public unregisterProvider(saveId: string): void {
    this.extraProviders.delete(saveId);
  }

  /**
   * Write a snapshot of every provider to the given slot.
   * @returns `true` on success, `false` if persistence failed.
   */
  public save(slot: number, name?: string): boolean {
    try {
      const providers = this.collectProviders();
      const sections: Record<string, Json> = {};
      for (const p of providers) sections[p.saveId] = p.serialize();

      const gm = ServiceLocator.tryResolve(ServiceKeys.Game) as
        | { playtimeSeconds?: number }
        | null;
      const meta: SaveMeta = {
        slot,
        name: name ?? `Save ${slot + 1}`,
        version: SAVE.SCHEMA_VERSION,
        timestamp: Date.now(),
        playtimeSeconds: Math.floor(gm?.playtimeSeconds ?? 0),
      };
      const data: SaveData = { meta, sections };

      const store = this.getStorage();
      if (!store) {
        this.log.debug('localStorage unavailable; save skipped');
        this.bus.emit(EventKeys.SaveError, { message: 'localStorage unavailable' });
        return false;
      }
      store.setItem(this.storageKey(slot), JSON.stringify(data));
      this.bus.emit(EventKeys.SaveCompleted, { slot });
      return true;
    } catch (err) {
      this.log.error(err);
      this.bus.emit(EventKeys.SaveError, { message: String(err) });
      return false;
    }
  }

  /**
   * Restore state from the given slot into every matching provider.
   * @returns `true` if a save was found and applied, `false` otherwise.
   */
  public load(slot: number): boolean {
    try {
      const store = this.getStorage();
      if (!store) {
        this.log.debug('localStorage unavailable; load skipped');
        return false;
      }
      const raw = store.getItem(this.storageKey(slot));
      if (!raw) return false;

      const data = JSON.parse(raw) as SaveData;
      if (data.meta.version !== SAVE.SCHEMA_VERSION) {
        this.log.warn(
          `Save version mismatch (file=${data.meta.version}, ` +
            `expected=${SAVE.SCHEMA_VERSION}); loading best-effort`,
        );
      }

      const providers = this.collectProviders();
      for (const p of providers) {
        const section = data.sections[p.saveId];
        if (section !== undefined) p.deserialize(section);
      }
      this.bus.emit(EventKeys.SaveLoadCompleted, { slot });
      return true;
    } catch (err) {
      this.log.error(err);
      this.bus.emit(EventKeys.SaveError, { message: String(err) });
      return false;
    }
  }

  /** Delete the save in the given slot, if any. */
  public delete(slot: number): void {
    const store = this.getStorage();
    if (!store) {
      this.log.debug('localStorage unavailable; delete skipped');
      return;
    }
    store.removeItem(this.storageKey(slot));
    this.bus.emit(EventKeys.SaveDeleted, { slot });
  }

  /** Whether a save exists in the given slot. */
  public exists(slot: number): boolean {
    const store = this.getStorage();
    if (!store) return false;
    return store.getItem(this.storageKey(slot)) !== null;
  }

  /**
   * Describe every save slot (existence + parsed metadata) for a load menu.
   * Corrupt entries are reported as existing with `meta: null`.
   */
  public listSlots(): SaveSlotInfo[] {
    const store = this.getStorage();
    const slots: SaveSlotInfo[] = [];
    for (let slot = 0; slot < SAVE.SLOT_COUNT; slot++) {
      const raw = store ? store.getItem(this.storageKey(slot)) : null;
      if (raw === null) {
        slots.push({ slot, exists: false, meta: null });
        continue;
      }
      let meta: SaveMeta | null = null;
      try {
        meta = (JSON.parse(raw) as SaveData).meta;
      } catch (err) {
        this.log.warn(`Corrupt save in slot ${slot}: ${String(err)}`);
      }
      slots.push({ slot, exists: true, meta });
    }
    return slots;
  }

  /** Build the `localStorage` key for a slot. */
  private storageKey(slot: number): string {
    return `${SAVE.STORAGE_PREFIX}:${slot}`;
  }

  /**
   * Gather all serializable providers — every registered service plus the
   * manually-registered gameplay providers — de-duplicated by `saveId`.
   */
  private collectProviders(): ISerializable[] {
    const byId = new Map<string, ISerializable>();
    for (const service of ServiceLocator.all()) {
      if (isSerializable(service)) byId.set(service.saveId, service);
    }
    for (const provider of this.extraProviders.values()) {
      byId.set(provider.saveId, provider);
    }
    return Array.from(byId.values());
  }

  /**
   * Resolve the `localStorage` object, or `null` when it is unavailable or
   * unusable in the current environment.
   */
  private getStorage(): Storage | null {
    try {
      if (typeof localStorage === 'undefined') return null;
      return localStorage;
    } catch {
      return null;
    }
  }
}
