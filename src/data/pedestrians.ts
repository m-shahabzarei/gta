/**
 * Pedestrian + animal profile catalogues.
 *
 * Each civilian profile references one of the {@link PED_VARIANT_COUNT}
 * procedurally generated sprite-sheet variants (skin tone, hair and outfit are
 * baked into the sheet), so the crowd reads as genuinely diverse people rather
 * than one recoloured silhouette.
 */
import type { AnimalProfile, PedProfile } from '@/gameplay/types';
import { PED_VARIANT_COUNT, TextureKeys, pedVariantKey } from '@/config/AssetKeys';

/** Deterministic walk speeds cycled across the variant sheets. */
const SPEEDS = [52, 48, 56, 50, 54, 46, 58, 51, 49, 55, 47, 53, 57, 50] as const;

/** The pool of pedestrian appearances used by the pedestrian system. */
export const PED_PROFILES: readonly PedProfile[] = Array.from(
  { length: PED_VARIANT_COUNT },
  (_, i) => ({
    id: `ped-${i}`,
    textureKey: pedVariantKey(i),
    speed: SPEEDS[i % SPEEDS.length] ?? 52,
  }),
);

/** The ambient animal population. */
export const ANIMAL_PROFILES: readonly AnimalProfile[] = [
  { id: 'dog-a', kind: 'dog', textureKey: TextureKeys.AnimalDog, speed: 66, health: 20 },
  { id: 'cat-a', kind: 'cat', textureKey: TextureKeys.AnimalCat, speed: 58, health: 12 },
];
