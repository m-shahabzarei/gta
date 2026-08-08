/**
 * High-level finite states owned by the {@link GameManager}.
 * The manager guarantees only valid transitions between these values and emits
 * {@link EventKeys.GameStateChanged} on every change.
 */
export enum GameState {
  /** Engine is starting up; managers are being created. */
  Boot = 'boot',
  /** Assets are being loaded. */
  Loading = 'loading',
  /** Front-end menus are active. */
  Menu = 'menu',
  /** The world is running and accepting gameplay input. */
  Playing = 'playing',
  /** The world is frozen behind a modal overlay. */
  Paused = 'paused',
}
