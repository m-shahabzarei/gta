/**
 * NPC appearance/behaviour profiles.
 *
 * Civilians each reference one of the procedurally generated character sprite
 * sheets (skin tone, hair and outfit baked into the texture), so the crowd is
 * visually diverse without any runtime tinting. Animals get their own compact
 * profiles for the ambient dog/cat population.
 */

/** A civilian pedestrian appearance/behaviour profile. */
export interface PedProfile {
  id: string;
  /** Sprite-sheet texture key (one of the generated civilian variants). */
  textureKey: string;
  /** Walk speed in px/sec. */
  speed: number;
  /** Optional flat tint over the sheet (0xRRGGBB); omit for none. */
  tint?: number;
}

/** Ambient animal species. */
export type AnimalKind = 'dog' | 'cat';

/** An ambient animal profile. */
export interface AnimalProfile {
  id: string;
  kind: AnimalKind;
  /** Sprite-sheet texture key. */
  textureKey: string;
  /** Trot speed in px/sec. */
  speed: number;
  /** Hit points. */
  health: number;
}
