/** Owns in-game phone lifecycle and the registry of future phone apps. */
import { EventKeys } from '@/config/EventKeys';
import { InputAction } from '@/config/InputConfig';
import { GameState } from '@/core/types';
import { ServiceKeys } from '@/config/ServiceKeys';
import { ServiceLocator } from '@/core/ServiceLocator';
import { BaseManager } from '@/core/BaseManager';
import type { GameManager } from '@/managers/GameManager';
import type { InputManager } from '@/managers/InputManager';
import { PhoneAppRegistry, type PhoneAppRegistrationOptions } from '@/phone/PhoneAppRegistry';
import { STORE_APP_ID, StorePhoneApp } from '@/phone/StorePhoneApp';
import type { PhoneAppAvailabilityContext, PhoneAppDefinition } from '@/phone/PhoneTypes';
import type { ISerializable } from '@/core/interfaces';
import type { Json } from '@/core/types';
import { SnappPhoneApp } from '@/phone/SnappPhoneApp';

/** Central owner for opening/closing the phone overlay. */
export class PhoneManager extends BaseManager implements ISerializable {
  public readonly key = ServiceKeys.Phone;
  public readonly saveId = 'phone';

  /** Registry containing built-in system apps plus future application definitions. */
  public readonly registry = new PhoneAppRegistry();

  private phoneOpen = false;

  protected onInit(): void {
    if (!this.registry.get(STORE_APP_ID)) {
      this.registry.register(StorePhoneApp, { installed: true });
    }
    if (!this.registry.get(SnappPhoneApp.id)) {
      this.registry.register(SnappPhoneApp, { installed: false, catalog: true });
    }
    this.subscribe(EventKeys.InputActionDown, ({ action }) => {
      if (action === InputAction.OpenPhone) this.openPhone();
    });
    this.subscribe(EventKeys.GamePhoneRequested, () => {
      this.phoneOpen = true;
    });
    this.subscribe(EventKeys.GameResumed, () => {
      this.phoneOpen = false;
    });
    this.subscribe(EventKeys.GameQuitToMenu, () => {
      this.phoneOpen = false;
    });
  }

  /** Whether this manager currently owns the paused phone overlay. */
  public get isOpen(): boolean {
    return this.phoneOpen;
  }

  /** Open the phone only from active gameplay; returns false when rejected. */
  public openPhone(): boolean {
    if (this.phoneOpen) return false;
    const game = ServiceLocator.tryResolve<GameManager>(ServiceKeys.Game);
    if (!game || game.state !== GameState.Playing) return false;

    ServiceLocator.tryResolve<InputManager>(ServiceKeys.Input)?.resetGameplayInput();
    game.openPhone();
    return true;
  }

  /** Close the phone and resume only the pause owned by this manager. */
  public closePhone(): boolean {
    if (!this.phoneOpen) return false;
    const game = ServiceLocator.tryResolve<GameManager>(ServiceKeys.Game);
    if (!game || game.state !== GameState.Paused) {
      this.phoneOpen = false;
      return false;
    }
    // Consume the close key/touch release before the gameplay scene resumes so
    // Escape/N cannot leak into Pause or immediately reopen the phone.
    ServiceLocator.tryResolve<InputManager>(ServiceKeys.Input)?.resetGameplayInput();
    game.resumeGame();
    return true;
  }

  /** Register a future application without coupling it to gameplay systems. */
  public registerApp(app: PhoneAppDefinition, options?: PhoneAppRegistrationOptions): void {
    this.registry.register(app, options);
  }

  /** Remove a previously registered application. */
  public unregisterApp(id: string): boolean {
    return this.registry.unregister(id);
  }

  /** List currently available Store catalog definitions for a future Store UI. */
  public listCatalogApps(context?: PhoneAppAvailabilityContext): PhoneAppDefinition[] {
    return this.registry.listCatalogApps(context);
  }

  /** Future-facing installation guard for Store catalog definitions. */
  public canInstallApp(appId: string): boolean {
    return this.registry.canInstall(appId);
  }

  /** Idempotent install API for Store catalog definitions. */
  public installApp(appId: string): boolean {
    return this.registry.installApp(appId);
  }

  /** Install state is intentionally small and versioned for forward migration. */
  public serialize(): Json {
    return { version: 1, installed: this.registry.serializeInstalled() };
  }

  /** Best-effort restore; malformed or legacy data leaves Store available. */
  public deserialize(data: Json): void {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return;
    const installed = data['installed'];
    if (!Array.isArray(installed)) return;
    this.registry.restoreInstalled(installed.filter((id): id is string => typeof id === 'string'));
  }

  /** Future-facing uninstall API; built-in system apps remain protected. */
  public uninstallApp(appId: string): boolean {
    return this.registry.uninstallApp(appId);
  }

  protected override onDestroy(): void {
    this.phoneOpen = false;
    this.registry.clear();
  }
}
