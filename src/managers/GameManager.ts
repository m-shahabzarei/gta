/**
 * Owns the top-level game finite-state machine and the running playtime clock.
 *
 * The GameManager is the authority for {@link GameState}: it performs guarded
 * transitions, emits the matching lifecycle events on the shared bus, and
 * accumulates elapsed play time while the world is running. It also reacts to
 * the {@link InputAction.Pause} action to toggle between the Playing and Paused
 * states, and persists its playtime through {@link ISerializable}.
 *
 * All cross-manager communication happens via events; this manager holds no
 * references to other services.
 */
import { ServiceKeys } from '@/config/ServiceKeys';
import { EventKeys } from '@/config/EventKeys';
import { InputAction } from '@/config/InputConfig';
import { GameState } from '@/core/types';
import type { Json } from '@/core/types';
import type { ISerializable } from '@/core/interfaces';
import type { InteriorKind } from '@/gameplay/types';
import { BaseManager } from '@/core/BaseManager';

/**
 * Central lifecycle manager: tracks the current {@link GameState} and playtime,
 * and drives valid state transitions in response to gameplay events.
 */
export class GameManager extends BaseManager implements ISerializable {
  /** Service-locator key for this manager. */
  public readonly key = ServiceKeys.Game;

  /** Stable save id under which playtime is persisted. */
  public readonly saveId = 'game';

  /** Current high-level game state. */
  private stateValue: GameState = GameState.Boot;

  /** Accumulated play time, in seconds, advanced only while Playing. */
  private playtime = 0;

  /**
   * Announce that the engine has booted and wire up the pause toggle. Managers
   * acquire other services lazily, so nothing is resolved here.
   */
  protected onInit(): void {
    this.bus.emit(EventKeys.GameBooted);
    this.subscribe(EventKeys.InputActionDown, (payload) => {
      if (payload.action === InputAction.ToggleMap) {
        if (this.stateValue === GameState.Playing) {
          this.openMap();
        }
        return;
      }
      if (payload.action === InputAction.Inventory) {
        if (this.stateValue === GameState.Playing) {
          this.openInventory();
        }
        return;
      }
      if (payload.action !== InputAction.Pause) return;
      if (this.stateValue === GameState.Playing) {
        this.pauseGame();
      } else if (this.stateValue === GameState.Paused) {
        this.resumeGame();
      }
    });
  }

  /** The current high-level game state. */
  public get state(): GameState {
    return this.stateValue;
  }

  /**
   * Transition to a new state. No-op when already in that state; otherwise
   * emits {@link EventKeys.GameStateChanged} with the previous and current
   * values.
   */
  public setState(next: GameState): void {
    if (next === this.stateValue) return;
    const previous = this.stateValue;
    this.stateValue = next;
    this.bus.emit(EventKeys.GameStateChanged, { previous, current: next });
  }

  /** Reset playtime and begin a fresh session in the Playing state. */
  public startNewGame(): void {
    this.playtime = 0;
    this.setState(GameState.Playing);
    this.bus.emit(EventKeys.GameNew);
  }

  /** Freeze the running world; only valid from the Playing state. */
  public pauseGame(): void {
    if (this.stateValue !== GameState.Playing) return;
    this.setState(GameState.Paused);
    this.bus.emit(EventKeys.GamePaused);
  }

  /** Resume the frozen world; only valid from the Paused state. */
  public resumeGame(): void {
    if (this.stateValue !== GameState.Paused) return;
    this.setState(GameState.Playing);
    this.bus.emit(EventKeys.GameResumed);
  }

  /** Freeze gameplay and request the world-map overlay. */
  public openMap(): void {
    if (this.stateValue === GameState.Playing) {
      this.setState(GameState.Paused);
    }
    if (this.stateValue === GameState.Paused) {
      this.bus.emit(EventKeys.GameMapRequested);
    }
  }

  /** Freeze gameplay and request the inventory overlay. */
  public openInventory(): void {
    if (this.stateValue === GameState.Playing) {
      this.setState(GameState.Paused);
    }
    if (this.stateValue === GameState.Paused) {
      this.bus.emit(EventKeys.GameInventoryRequested);
    }
  }

  /** Request the nearest in-world enterable building without pausing gameplay. */
  public openInterior(kind: InteriorKind): void {
    if (this.stateValue === GameState.Playing) {
      this.bus.emit(EventKeys.GameInteriorRequested, { kind });
    }
  }

  /** Leave gameplay and return to the front-end menu. */
  public quitToMenu(): void {
    this.setState(GameState.Menu);
    this.bus.emit(EventKeys.GameQuitToMenu);
  }

  /** Total accumulated play time, in seconds. */
  public get playtimeSeconds(): number {
    return this.playtime;
  }

  /**
   * Per-frame tick. Advances the playtime clock only while the world is
   * actively Playing.
   */
  public update(_time: number, delta: number): void {
    if (this.stateValue === GameState.Playing) {
      this.playtime += delta / 1000;
    }
  }

  /** Produce a JSON-safe snapshot of persistable game state. */
  public serialize(): Json {
    return { playtimeSeconds: this.playtime };
  }

  /**
   * Restore game state from a snapshot. Types are validated because `data` is
   * opaque {@link Json}; anything unexpected leaves playtime untouched.
   */
  public deserialize(data: Json): void {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return;
    const value = data['playtimeSeconds'];
    if (typeof value === 'number' && Number.isFinite(value)) {
      this.playtime = value;
    }
  }
}
