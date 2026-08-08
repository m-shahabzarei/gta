/**
 * Coarse phases of the day/night cycle, derived from the current in-game hour
 * by the {@link DayNightSystem}. Used to drive ambient lighting and (later)
 * gameplay behaviour such as street-light activation.
 */
export enum DayPhase {
  Dawn = 'dawn',
  Day = 'day',
  Dusk = 'dusk',
  Night = 'night',
}

/**
 * Map an in-game hour (0–24) to its {@link DayPhase}.
 * @param hour Hour of day in the 0–24 range.
 */
export function hourToPhase(hour: number): DayPhase {
  const h = ((hour % 24) + 24) % 24;
  if (h >= 5 && h < 8) return DayPhase.Dawn;
  if (h >= 8 && h < 18) return DayPhase.Day;
  if (h >= 18 && h < 21) return DayPhase.Dusk;
  return DayPhase.Night;
}
