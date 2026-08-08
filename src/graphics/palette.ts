/**
 * The single shared colour palette for all procedural gameplay art.
 *
 * Every art factory imports from here so characters, vehicles, tiles, props and
 * effects share one coherent, GTA-2-inspired top-down pixel look. This is pure
 * data (no Phaser dependency).
 */
export const PALETTE = {
  // Ink / shading
  outline: 0x171923,
  shadow: 0x000000,

  // Skin tones (light → deep) used by the character variant generator.
  skin: 0xe0ad7c,
  skinDark: 0xbd855f,
  skinTones: [0xf0c99d, 0xe0ad7c, 0xc98b5d, 0x9e6947, 0x70472f] as readonly number[],

  // Hair colours used by the character variant generator.
  hairTones: [0x1c1816, 0x38291f, 0x68472a, 0x957044, 0xaaa39a, 0x743528] as readonly number[],

  // Clothing colours civilians draw from.
  clothTones: [
    0xb94d4f, 0x466d9f, 0x4d7d59, 0xb78a3e, 0x735f98, 0x3f8384, 0xa9557d, 0x626977,
    0x8a6248, 0x374552, 0x829052, 0xaaa9a5,
  ] as readonly number[],

  // Player clothing
  playerShirt: 0x3f6f78,
  playerShirtDark: 0x284a54,
  playerPants: 0x303a49,
  playerHair: 0x3a2a1a,

  // Police
  policeUniform: 0x314661,
  policeUniformDark: 0x1c2a3f,
  policeCap: 0x172238,
  policeBadge: 0xe4b94f,

  // Materials
  glass: 0x1c2b35,
  glassLight: 0x477080,
  tire: 0x111319,
  chrome: 0xc4cbc9,
  metalDark: 0x30343a,

  // Effects
  blood: 0x9e1b1b,
  bloodDark: 0x6b0f0f,
  muzzle: 0xffe08a,
  muzzleCore: 0xfff6d0,
  fire: 0xff6a1e,
  fireCore: 0xffd23a,
  smoke: 0x3a3a42,
  smokeLight: 0x5a5a64,
  spark: 0xfff2b0,
  bulletCore: 0xfff2b0,
  bulletTrail: 0xffb03a,

  // World tiles
  grass: 0x356344,
  grassDark: 0x294f38,
  grassLight: 0x4c7853,
  road: 0x41444b,
  roadDark: 0x32353c,
  roadLight: 0x53565d,
  line: 0xd1b84e,
  sidewalk: 0x9a9993,
  sidewalkDark: 0x777872,
  water: 0x2c7182,
  waterLight: 0x4d92a0,
  building: 0x727982,
  buildingDark: 0x4b535c,
  buildingLight: 0x98a0a5,
  window: 0x9fb3bb,
  windowLit: 0xf2d58a,
  sand: 0xd2ad70,
  sandDark: 0xb98c58,
  dirt: 0x826044,
  dirtDark: 0x60452f,
  rock: 0x77716a,
  rockDark: 0x57534f,
  concrete: 0x91918c,
  concreteDark: 0x70726f,
  runway: 0x30333a,
  dockWood: 0x896546,
  dockWoodDark: 0x654832,
  brickRes: 0x9f7059,
  brickResDark: 0x765040,
  roofInd: 0x59656b,
  roofIndDark: 0x3f4a50,

  // SWAT gear
  swatArmor: 0x23262d,
  swatArmorDark: 0x15171c,
  swatVisor: 0x3a6cff,

  // Animals
  dogFur: 0x9a713f,
  catFur: 0x585a66,

  // Vehicle / night lighting
  headlight: 0xffe9b2,
  brakeLight: 0xff3b30,
  indicator: 0xffb03a,
  lampGlow: 0xffcf79,

  // Props / UI accents
  accent: 0xffcc33,
  marker: 0xffd23a,
  lightRed: 0xe4405f,
  lightYellow: 0xf4d03f,
  lightGreen: 0x53d769,
  panel: 0x14141c,
  panelBorder: 0x3a3a4a,
} as const;

/** Blend a colour toward black by `t` (0..1) — cheap shading helper (pure). */
export function shade(color: number, t: number): number {
  const r = Math.round(((color >> 16) & 0xff) * (1 - t));
  const g = Math.round(((color >> 8) & 0xff) * (1 - t));
  const b = Math.round((color & 0xff) * (1 - t));
  return (r << 16) | (g << 8) | b;
}

/** Blend a colour toward white by `t` (0..1) — cheap highlight helper (pure). */
export function tintUp(color: number, t: number): number {
  const r = Math.round(((color >> 16) & 0xff) + (255 - ((color >> 16) & 0xff)) * t);
  const g = Math.round(((color >> 8) & 0xff) + (255 - ((color >> 8) & 0xff)) * t);
  const b = Math.round((color & 0xff) + (255 - (color & 0xff)) * t);
  return (r << 16) | (g << 8) | b;
}
