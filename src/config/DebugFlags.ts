/**
 * Runtime-toggleable debug-draw flags, flipped by dev hotkeys.
 *
 * Kept as a plain mutable object (rather than routed through the event bus or
 * a manager) so any layer — systems or entity components alike — can cheaply
 * read the current state every frame without a service lookup.
 */
export const DebugFlags = {
  /** Draw pathfinding/steering debug overlays (nav markers, NPC paths). Toggled with F6. */
  navigation: false,
};
