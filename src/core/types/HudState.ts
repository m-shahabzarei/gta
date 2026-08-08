/**
 * Presentation-only snapshot of everything the HUD can display.
 *
 * This is a data-transfer object: it carries no behaviour and no gameplay
 * logic. Phase 2 systems push updates via {@link EventKeys.UIHudUpdate}; the
 * UI layer merely renders whatever values arrive.
 */
export interface HudState {
  /** Current player health. */
  health: number;
  /** Maximum player health (for the health-bar ratio). */
  maxHealth: number;
  /** On-hand cash. */
  money: number;
  /** Police awareness level, 0-5 stars. */
  wanted: number;
  /** Pre-formatted in-game clock, e.g. "08:42". */
  timeLabel: string;
  /** Name of the equipped weapon, or `null` when unarmed. */
  weaponLabel: string | null;
  /** Ammunition in the current magazine, or `null` when not applicable. */
  ammo: number | null;
}

/** The neutral HUD state used before any gameplay values exist. */
export const DEFAULT_HUD_STATE: HudState = {
  health: 100,
  maxHealth: 100,
  money: 0,
  wanted: 0,
  timeLabel: '08:00',
  weaponLabel: null,
  ammo: null,
};
