/**
 * Implemented by anything that needs to advance on the game loop.
 * Managers that implement this are ticked centrally from Phaser's game step.
 */
export interface IUpdatable {
  /**
   * Advance one frame.
   * @param time  Total elapsed time in milliseconds since the game started.
   * @param delta Milliseconds elapsed since the previous frame.
   */
  update(time: number, delta: number): void;
}

/** Runtime type-guard for {@link IUpdatable}. */
export function isUpdatable(value: unknown): value is IUpdatable {
  return typeof (value as IUpdatable | null)?.update === 'function';
}
