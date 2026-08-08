/**
 * Implemented by anything that owns resources (listeners, timers, textures)
 * which must be released deterministically to avoid leaks between scenes.
 */
export interface IDestroyable {
  /** Release all owned resources. Must be safe to call more than once. */
  destroy(): void;
}
