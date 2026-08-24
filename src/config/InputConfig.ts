/**
 * Semantic input actions and their default key bindings.
 *
 * The {@link InputManager} maps physical keys to these abstract actions, so all
 * gameplay code reacts to intent (`Attack`) rather than hardware (`SPACE`).
 * Bindings are expressed as Phaser key-code *names* (see
 * `Phaser.Input.Keyboard.KeyCodes`) and resolved to numeric codes at runtime.
 */

/** Abstract, remappable player intents. */
export enum InputAction {
  MoveUp = 'move-up',
  MoveDown = 'move-down',
  MoveLeft = 'move-left',
  MoveRight = 'move-right',
  Run = 'run',
  Interact = 'interact',
  Attack = 'attack',
  Pause = 'pause',
  Confirm = 'confirm',
  Cancel = 'cancel',
  ToggleMap = 'toggle-map',
  /** Enter the nearest vehicle, or exit the current one. */
  EnterVehicle = 'enter-vehicle',
  /** Cycle to the next weapon in the inventory. */
  NextWeapon = 'next-weapon',
  /** Cycle to the previous weapon in the inventory. */
  PrevWeapon = 'prev-weapon',
  /** Open/close the inventory overlay. */
  Inventory = 'inventory',
  /** Open the in-game phone overlay. */
  OpenPhone = 'open-phone',
  /** Reload the current weapon's magazine. */
  Reload = 'reload',
  /** Sound the horn while driving. */
  Horn = 'horn',
  /** Apply the vehicle hard brake / handbrake. */
  Handbrake = 'handbrake',
}

/**
 * Default bindings: each action maps to one or more Phaser key-code names.
 * Multiple entries mean "any of these keys triggers the action".
 */
export const DEFAULT_KEY_BINDINGS: Readonly<Record<InputAction, readonly string[]>> = {
  [InputAction.MoveUp]: ['W', 'UP'],
  [InputAction.MoveDown]: ['S', 'DOWN'],
  [InputAction.MoveLeft]: ['A', 'LEFT'],
  [InputAction.MoveRight]: ['D', 'RIGHT'],
  [InputAction.Run]: ['SHIFT'],
  [InputAction.Interact]: ['E'],
  [InputAction.Attack]: ['SPACE'],
  [InputAction.Pause]: ['P', 'ESC'],
  [InputAction.Confirm]: ['ENTER', 'SPACE'],
  [InputAction.Cancel]: ['ESC', 'BACKSPACE'],
  [InputAction.ToggleMap]: ['M', 'TAB'],
  [InputAction.EnterVehicle]: ['F', 'ENTER'],
  [InputAction.NextWeapon]: ['X'],
  [InputAction.PrevWeapon]: ['Z', 'Q'],
  [InputAction.Inventory]: ['I'],
  [InputAction.OpenPhone]: ['N'],
  [InputAction.Reload]: ['R'],
  [InputAction.Horn]: ['H'],
  [InputAction.Handbrake]: ['SPACE'],
} as const;

/** Every action, in a stable iteration order. */
export const ALL_INPUT_ACTIONS: readonly InputAction[] = Object.values(InputAction);
