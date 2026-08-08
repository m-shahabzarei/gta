/**
 * Frame-name contracts shared by the character texture factories (producers)
 * and the {@link CharacterAnimatorComponent} (consumer).
 *
 * Every generated character sheet registers named frames; a rig groups those
 * names into animation clips with playback rates. Keeping the contract here —
 * pure data, no Phaser — means the art and the animator can never drift apart.
 */

/** One animation clip: an ordered frame-name list plus its playback rate. */
export interface AnimClip {
  frames: readonly string[];
  /** Frames per second. */
  fps: number;
  /** Whether the clip loops (one-shot clips hold their last frame). */
  loop: boolean;
}

/** The full set of clips a character sheet provides. */
export interface CharacterRig {
  idle: AnimClip;
  walk: AnimClip;
  run: AnimClip;
  /** Weapon-raised pose flashed when the entity fires. */
  shoot: AnimClip;
  /** Magazine-swap fumble looped while reloading. */
  reload: AnimClip;
  /** One-shot collapse; the final frame is the corpse pose. */
  death: AnimClip;
}

/** Rig for the humanoid sheets (player, civilians, police, SWAT). */
export const HUMAN_RIG: CharacterRig = {
  idle: { frames: ['idle0', 'idle1'], fps: 2, loop: true },
  walk: { frames: ['walk0', 'walk1', 'walk2', 'walk3'], fps: 7, loop: true },
  run: { frames: ['run0', 'run1', 'run2', 'run3'], fps: 11, loop: true },
  shoot: { frames: ['shoot0', 'aim0'], fps: 12, loop: false },
  reload: { frames: ['reload0', 'reload1'], fps: 5, loop: true },
  death: { frames: ['dead0', 'dead1', 'dead2'], fps: 9, loop: false },
};

/** Rig for the compact quadruped sheets (dogs, cats). */
export const ANIMAL_RIG: CharacterRig = {
  idle: { frames: ['idle0', 'idle0', 'walk0'], fps: 1.5, loop: true },
  walk: { frames: ['walk0', 'idle0', 'walk1', 'idle0'], fps: 8, loop: true },
  run: { frames: ['walk0', 'walk1'], fps: 12, loop: true },
  shoot: { frames: ['idle0'], fps: 1, loop: false },
  reload: { frames: ['idle0'], fps: 1, loop: true },
  death: { frames: ['dead0'], fps: 1, loop: false },
};

/** Every frame name a humanoid sheet must register, in strip order. */
export const HUMAN_FRAME_ORDER: readonly string[] = [
  'idle0',
  'idle1',
  'walk0',
  'walk1',
  'walk2',
  'walk3',
  'run0',
  'run1',
  'run2',
  'run3',
  'aim0',
  'shoot0',
  'reload0',
  'reload1',
  'dead0',
  'dead1',
  'dead2',
];

/** Every frame name an animal sheet must register, in strip order. */
export const ANIMAL_FRAME_ORDER: readonly string[] = ['idle0', 'walk0', 'walk1', 'dead0'];
