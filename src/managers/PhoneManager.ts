/** Owns in-game phone lifecycle and the registry of future phone apps. */
import { EventKeys } from '@/config/EventKeys';
import { InputAction } from '@/config/InputConfig';
import { GameState } from '@/core/types';
import { ServiceKeys } from '@/config/ServiceKeys';
import { ServiceLocator } from '@/core/ServiceLocator';
import { BaseManager } from '@/core/BaseManager';
import type { GameManager } from '@/managers/GameManager';
import type { InputManager } from '@/managers/InputManager';
import { PhoneAppRegistry } from '@/phone/PhoneAppRegistry';
import type { PhoneAppDefinition } from '@/phone/PhoneTypes';

/** Central owner for opening/closing the phone overlay. */
export class PhoneManager extends BaseManager {
  public readonly key = ServiceKeys.Phone;

  /** Future app registration point; intentionally empty in the first version. */
  public readonly registry = new PhoneAppRegistry();

  private phoneOpen = false;

  protected onInit(): void {
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
  public registerApp(app: PhoneAppDefinition): void {
    this.registry.register(app);
  }

  /** Remove a previously registered application. */
  public unregisterApp(id: string): boolean {
    return this.registry.unregister(id);
  }

  protected override onDestroy(): void {
    this.phoneOpen = false;
    this.registry.clear();
  }
}
