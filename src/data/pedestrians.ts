/**
 * Pedestrian + animal profile catalogues.
 *
 * Each civilian profile references one of the {@link PED_VARIANT_COUNT}
 * procedurally generated sprite-sheet variants (skin tone, hair and outfit are
 * baked into the sheet), so the crowd reads as genuinely diverse people rather
 * than one recoloured silhouette.
 */
import type { AnimalProfile, InteriorNpcAppearance, PedProfile } from '@/gameplay/types';
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

/** Dedicated service appearances kept out of the ambient crowd catalogue. */
export const SERVICE_PED_PROFILES: Readonly<Record<InteriorNpcAppearance, PedProfile>> = {
  'police-uniform': {
    id: 'service-police-uniform',
    textureKey: TextureKeys.CharPolice,
    speed: 52,
  },
  'police-detective': {
    id: 'service-police-detective',
    textureKey: pedVariantKey(8),
    speed: 50,
    tint: 0xb8aa96,
  },
  'hospital-doctor': {
    id: 'service-hospital-doctor',
    textureKey: TextureKeys.CharPed,
    speed: 50,
    tint: 0xf1f3ec,
  },
  'hospital-nurse': {
    id: 'service-hospital-nurse',
    textureKey: TextureKeys.CharPed,
    speed: 54,
    tint: 0xb9e4e6,
  },
  'hospital-paramedic': {
    id: 'service-hospital-paramedic',
    textureKey: TextureKeys.CharPed,
    speed: 58,
    tint: 0xe7ddd0,
  },
  'hospital-patient': {
    id: 'service-hospital-patient',
    textureKey: pedVariantKey(4),
    speed: 39,
    tint: 0xd7c0a8,
  },
  'hospital-reception': {
    id: 'service-hospital-reception',
    textureKey: pedVariantKey(10),
    speed: 48,
    tint: 0xaed5d8,
  },
  'hospital-security': {
    id: 'service-hospital-security',
    textureKey: TextureKeys.CharPolice,
    speed: 50,
    tint: 0x7e9a98,
  },
  civilian: {
    id: 'service-civilian',
    textureKey: pedVariantKey(2),
    speed: 49,
  },
};

/** The ambient animal population. */
export const ANIMAL_PROFILES: readonly AnimalProfile[] = [
  { id: 'dog-a', kind: 'dog', textureKey: TextureKeys.AnimalDog, speed: 66, health: 20 },
  { id: 'cat-a', kind: 'cat', textureKey: TextureKeys.AnimalCat, speed: 58, health: 12 },
];
