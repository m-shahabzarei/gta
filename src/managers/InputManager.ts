/**
 * Scene-bound input manager.
 *
 * Translates physical keyboard keys into abstract, remappable {@link InputAction}
 * intents so gameplay code reacts to meaning (`MoveLeft`, `Attack`) rather than
 * hardware. Bindings default to {@link DEFAULT_KEY_BINDINGS} and can be changed at
 * runtime via {@link setBinding}. Each frame `update` diffs the merged keyboard /
 * gamepad state against the previous frame and emits edge-triggered
 * `input:action-down` / `input:action-up` events plus an
 * `input:axis-changed` event when the movement axis changes, so systems can
 * either poll (`isDown`) or react to events.
 */
import Phaser from 'phaser';
import { BaseSceneManager } from '@/core/BaseSceneManager';
import { ServiceKeys } from '@/config/ServiceKeys';
import { EventKeys } from '@/config/EventKeys';
import {
  InputAction,
  DEFAULT_KEY_BINDINGS,
  ALL_INPUT_ACTIONS,
} from '@/config/InputConfig';
import { detectMobileEnvironment } from '@/platform';

/** Deadzone applied to analog sticks before they count as movement or aim. */
const GAMEPAD_DEADZONE = 0.28;

/** Maps abstract input actions to physical keyboard keys for the active scene. */
export class InputManager extends BaseSceneManager {
  /** Service-locator key for this manager. */
  public readonly key = ServiceKeys.Input;

  /** Current action → key-code-name bindings. */
  private readonly bindings = new Map<InputAction, string[]>();

  /** Live Phaser keys per action, rebuilt on every scene attach. */
  private readonly keys = new Map<InputAction, Phaser.Input.Keyboard.Key[]>();

  /** Last-known down state per action, used for edge detection in `update`. */
  private readonly downState = new Map<InputAction, boolean>();

  /** Actions pressed on the current frame. */
  private readonly justDown = new Set<InputAction>();

  /** Actions held across a modal boundary; they must be released before firing again. */
  private readonly suppressedUntilUp = new Set<InputAction>();

  /** Last-emitted movement axis, used to suppress duplicate axis events. */
  private prevAxis = { x: 0, y: 0 };

  /** Stable touch-source state written by the mobile HUD. */
  private readonly touchActions = new Set<InputAction>();
  private readonly touchMoveAxis = { x: 0, y: 0 };
  private readonly touchAimAxis = { x: 0, y: 0 };
  private touchAimActive = false;
  private readonly touchEnabled = detectMobileEnvironment();

  /** Seed bindings from defaults and reset all action state to "up". */
  protected onInit(): void {
    for (const action of ALL_INPUT_ACTIONS) {
      const bound = DEFAULT_KEY_BINDINGS[action];
      this.bindings.set(action, [...bound]);
      this.downState.set(action, false);
    }
    this.prevAxis = { x: 0, y: 0 };
    this.log.debug(`initialised ${this.bindings.size} action bindings`);
  }

  /** Build the live Phaser key objects for every action on the attached scene. */
  protected override onAttach(scene: Phaser.Scene): void {
    const kb = scene.input.keyboard;
    if (kb) {
      for (const action of ALL_INPUT_ACTIONS) {
        this.keys.set(action, this.buildKeys(kb, action));
      }
    }
    if (scene.input.gamepad) {
      scene.input.gamepad.enabled = true;
    }
  }

  /** Remove all created keys and clear per-scene state. */
  protected override onDetach(scene: Phaser.Scene): void {
    const kb = scene.input.keyboard;
    for (const keyList of this.keys.values()) {
      for (const key of keyList) {
        kb?.removeKey(key);
      }
    }
    this.keys.clear();
    for (const action of ALL_INPUT_ACTIONS) {
      this.downState.set(action, false);
    }
    this.justDown.clear();
    this.suppressedUntilUp.clear();
    this.prevAxis = { x: 0, y: 0 };
    this.resetTouchInput();
  }

  /** Whether any key bound to `action` is currently held down. */
  public isDown(action: InputAction): boolean {
    return this.downState.get(action) ?? false;
  }

  /** Whether any key bound to `action` was pressed on this exact frame. */
  public isJustDown(action: InputAction): boolean {
    return this.justDown.has(action);
  }

  /** Normalised movement axis from the four directional actions (-1..1 each). */
  public getAxis(): { x: number; y: number } {
    const pad = this.activePad();
    const keyboardX =
      (this.keyboardDown(InputAction.MoveRight) ? 1 : 0) -
      (this.keyboardDown(InputAction.MoveLeft) ? 1 : 0);
    const keyboardY =
      (this.keyboardDown(InputAction.MoveDown) ? 1 : 0) -
      (this.keyboardDown(InputAction.MoveUp) ? 1 : 0);
    const padAxis = this.gamepadAxis(pad);
    const axis = {
      x: keyboardX + padAxis.x + this.touchMoveAxis.x,
      y: keyboardY + padAxis.y + this.touchMoveAxis.y,
    };
    if (this.suppressedUntilUp.has(InputAction.MoveLeft) || this.suppressedUntilUp.has(InputAction.MoveRight)) {
      axis.x = 0;
    }
    if (this.suppressedUntilUp.has(InputAction.MoveUp) || this.suppressedUntilUp.has(InputAction.MoveDown)) {
      axis.y = 0;
    }
    return this.clampAxis(axis);
  }

  /** Right-stick aim vector, or null when no controller aim is active. */
  public getAimVector(): { x: number; y: number } | null {
    if (this.suppressedUntilUp.has(InputAction.Attack)) return null;
    if (this.touchAimActive) {
      return this.clampAxis(this.touchAimAxis);
    }
    const pad = this.activePad();
    if (!pad) {
      return null;
    }
    const x = this.gamepadAimAxis(pad, 'x');
    const y = this.gamepadAimAxis(pad, 'y');
    const len = Math.hypot(x, y);
    if (len < GAMEPAD_DEADZONE) {
      return null;
    }
    return this.clampAxis({ x, y });
  }

  /** Set the mobile movement/vehicle axis without bypassing gameplay systems. */
  public setTouchMoveAxis(x: number, y: number): void {
    if (!this.touchEnabled) return;
    const axis = this.clampAxis({ x, y });
    this.touchMoveAxis.x = axis.x;
    this.touchMoveAxis.y = axis.y;
  }

  /** Set or clear the mobile aim vector. A zero vector disables touch aiming. */
  public setTouchAimAxis(x: number, y: number): void {
    if (!this.touchEnabled) return;
    const axis = this.clampAxis({ x, y });
    this.touchAimAxis.x = axis.x;
    this.touchAimAxis.y = axis.y;
    this.touchAimActive = Math.hypot(axis.x, axis.y) > 0.01;
  }

  /** Set a held semantic action from touch; edge events are diffed in update. */
  public setTouchAction(action: InputAction, down: boolean): void {
    if (!this.touchEnabled) return;
    if (down) this.touchActions.add(action);
    else this.touchActions.delete(action);
  }

  /** Emit a one-shot semantic action from a UI control without creating held state. */
  public triggerAction(action: InputAction): void {
    this.bus.emit(EventKeys.InputActionDown, { action });
  }

  /** Return every touch axis/action to neutral after cancellation or rotation. */
  public resetTouchInput(): void {
    this.touchActions.clear();
    this.touchMoveAxis.x = 0;
    this.touchMoveAxis.y = 0;
    this.touchAimAxis.x = 0;
    this.touchAimAxis.y = 0;
    this.touchAimActive = false;
  }

  /**
   * Clear every gameplay input source before a modal overlay takes ownership.
   * Phaser also resets scene keys when the gameplay scene pauses; doing it here
   * makes the transition deterministic even when the request came from touch
   * or a desktop UI button during the current frame.
   */
  public resetGameplayInput(): void {
    const pad = this.activePad();
    const held = new Set<InputAction>();
    for (const action of ALL_INPUT_ACTIONS) {
      if (this.readActionDown(action, pad)) held.add(action);
    }
    this.resetTouchInput();
    this.scene?.input.keyboard?.resetKeys();
    for (const keyList of this.keys.values()) {
      for (const key of keyList) key.reset();
    }
    for (const action of ALL_INPUT_ACTIONS) {
      this.downState.set(action, false);
    }
    this.justDown.clear();
    for (const action of held) this.suppressedUntilUp.add(action);
    this.prevAxis = { x: 0, y: 0 };
  }

  /** Rebind `action` to `keys`; rebuilds live keys if a scene is attached. */
  public setBinding(action: InputAction, keys: readonly string[]): void {
    this.bindings.set(action, [...keys]);
    const scene = this.scene;
    const kb = scene?.input.keyboard;
    if (!scene || !kb) return;

    const existing = this.keys.get(action);
    if (existing) {
      for (const key of existing) kb.removeKey(key);
    }
    this.keys.set(action, this.buildKeys(kb, action));
    this.log.debug(`rebound ${action} to [${keys.join(', ')}]`);
  }

  /** Diff key state against the previous frame and emit input events. */
  public update(_time: number, _delta: number): void {
    if (!this.scene) return;
    const pad = this.activePad();
    this.justDown.clear();

    for (const action of ALL_INPUT_ACTIONS) {
      const current = this.readActionDown(action, pad);
      const previous = this.downState.get(action) ?? false;
      if (this.suppressedUntilUp.has(action)) {
        if (!current) {
          this.suppressedUntilUp.delete(action);
        } else {
          this.downState.set(action, true);
          continue;
        }
      }
      if (current === previous) continue;

      this.downState.set(action, current);
      if (current) {
        this.bus.emit(EventKeys.InputActionDown, { action });
        this.justDown.add(action);
      } else {
        this.bus.emit(EventKeys.InputActionUp, { action });
      }
    }

    const axis = this.getAxis();
    if (axis.x !== this.prevAxis.x || axis.y !== this.prevAxis.y) {
      this.prevAxis = axis;
      this.bus.emit(EventKeys.InputAxisChanged, { x: axis.x, y: axis.y });
    }
  }

  /** Resolve an action's bound key-code names into live Phaser keys. */
  private buildKeys(
    kb: Phaser.Input.Keyboard.KeyboardPlugin,
    action: InputAction,
  ): Phaser.Input.Keyboard.Key[] {
    const names = this.bindings.get(action) ?? [];
    const result: Phaser.Input.Keyboard.Key[] = [];
    for (const name of names) {
      result.push(kb.addKey(name));
    }
    return result;
  }

  /** Resolve the first connected gamepad, if any. */
  private activePad(): Phaser.Input.Gamepad.Gamepad | null {
    const plugin = this.scene?.input.gamepad;
    if (!plugin || !plugin.enabled) {
      return null;
    }
    const pads = plugin.getAll();
    return pads.find((pad) => pad.connected) ?? plugin.pad1 ?? plugin.pad2 ?? plugin.pad3 ?? plugin.pad4 ?? null;
  }

  /** Keyboard-only state for an action. */
  private keyboardDown(action: InputAction): boolean {
    const keyList = this.keys.get(action);
    if (!keyList) return false;
    for (const key of keyList) {
      if (key.isDown) return true;
    }
    return false;
  }

  /** Read the merged keyboard/gamepad down state for one action. */
  private readActionDown(action: InputAction, pad: Phaser.Input.Gamepad.Gamepad | null): boolean {
    return (
      this.keyboardDown(action) ||
      this.gamepadActionDown(action, pad) ||
      this.touchActionDown(action)
    );
  }

  private touchActionDown(action: InputAction): boolean {
    if (this.touchActions.has(action)) return true;
    switch (action) {
      case InputAction.MoveUp:
        return this.touchMoveAxis.y < -0.15;
      case InputAction.MoveDown:
        return this.touchMoveAxis.y > 0.15;
      case InputAction.MoveLeft:
        return this.touchMoveAxis.x < -0.15;
      case InputAction.MoveRight:
        return this.touchMoveAxis.x > 0.15;
      default:
        return false;
    }
  }

  /** Read the current controller state for one action. */
  private gamepadActionDown(action: InputAction, pad: Phaser.Input.Gamepad.Gamepad | null): boolean {
    if (!pad) {
      return false;
    }

    switch (action) {
      case InputAction.MoveUp:
        return this.gamepadStickAxis(pad, 'y') < -GAMEPAD_DEADZONE || pad.up;
      case InputAction.MoveDown:
        return this.gamepadStickAxis(pad, 'y') > GAMEPAD_DEADZONE || pad.down;
      case InputAction.MoveLeft:
        return this.gamepadStickAxis(pad, 'x') < -GAMEPAD_DEADZONE || pad.left;
      case InputAction.MoveRight:
        return this.gamepadStickAxis(pad, 'x') > GAMEPAD_DEADZONE || pad.right;
      case InputAction.Run:
        return pad.L2 > 0.25 || this.gamepadButtonDown(pad, 6);
      case InputAction.Interact:
      case InputAction.Confirm:
        return pad.A || this.gamepadButtonDown(pad, 0);
      case InputAction.Cancel:
      case InputAction.Inventory:
        return pad.B || this.gamepadButtonDown(pad, 1);
      case InputAction.OpenPhone:
        // Right-stick press is deliberately unused by the gameplay actions.
        return this.gamepadButtonDown(pad, 11);
      case InputAction.Attack:
        return pad.R2 > 0.25 || this.gamepadButtonDown(pad, 7);
      case InputAction.Pause:
        return this.gamepadButtonDown(pad, 9);
      case InputAction.ToggleMap:
        return this.gamepadButtonDown(pad, 8);
      case InputAction.EnterVehicle:
        return pad.Y || this.gamepadButtonDown(pad, 3);
      case InputAction.NextWeapon:
        return pad.R1 > 0.25 || this.gamepadButtonDown(pad, 5);
      case InputAction.PrevWeapon:
        return pad.L1 > 0.25 || this.gamepadButtonDown(pad, 4);
      case InputAction.Reload:
        return pad.X || this.gamepadButtonDown(pad, 2);
      case InputAction.Horn:
        return this.gamepadButtonDown(pad, 10);
      case InputAction.Handbrake:
        return pad.X || this.gamepadButtonDown(pad, 2);
      default:
        return false;
    }
  }

  /** Read the merged movement axis from keyboard, d-pad and the left stick. */
  private gamepadAxis(pad: Phaser.Input.Gamepad.Gamepad | null): { x: number; y: number } {
    if (!pad) {
      return { x: 0, y: 0 };
    }
    const stickX = this.gamepadStickAxis(pad, 'x');
    const stickY = this.gamepadStickAxis(pad, 'y');
    const dpadX = (pad.right ? 1 : 0) - (pad.left ? 1 : 0);
    const dpadY = (pad.down ? 1 : 0) - (pad.up ? 1 : 0);
    return this.clampAxis({ x: stickX + dpadX, y: stickY + dpadY });
  }

  /** The selected left-stick axis after deadzone filtering. */
  private gamepadStickAxis(
    pad: Phaser.Input.Gamepad.Gamepad,
    axis: 'x' | 'y',
  ): number {
    const value = axis === 'x' ? pad.leftStick.x : pad.leftStick.y;
    return Math.abs(value) >= GAMEPAD_DEADZONE ? value : 0;
  }

  /** The selected right-stick axis after deadzone filtering. */
  private gamepadAimAxis(
    pad: Phaser.Input.Gamepad.Gamepad,
    axis: 'x' | 'y',
  ): number {
    const value = axis === 'x' ? pad.rightStick.x : pad.rightStick.y;
    return Math.abs(value) >= GAMEPAD_DEADZONE ? value : 0;
  }

  /** Safe button lookup for optional controller buttons. */
  private gamepadButtonDown(pad: Phaser.Input.Gamepad.Gamepad, index: number): boolean {
    return index < pad.getButtonTotal() && pad.isButtonDown(index);
  }

  /** Keep a vector within the [-1, 1] range and preserve diagonals. */
  private clampAxis(axis: { x: number; y: number }): { x: number; y: number } {
    const len = Math.hypot(axis.x, axis.y);
    if (len <= 1) {
      return axis;
    }
    return { x: axis.x / len, y: axis.y / len };
  }
}
