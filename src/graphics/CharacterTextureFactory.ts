/**
 * Generates the top-down character sprite SHEETS for gameplay.
 *
 * Every character is drawn TOP-DOWN facing UP (toward -Y) at 32×32 per frame:
 * visible shoulders, swinging arms with skin-tone hands, alternating feet, a
 * haired head with a face rim at the leading edge, and weapon-raised /
 * reloading / collapsing poses. A sprite at rotation 0 points up; movement
 * code rotates it by `heading + Math.PI/2` to face a travel angle.
 *
 * Each sheet is a horizontal strip whose frames are registered by name in
 * {@link HUMAN_FRAME_ORDER} order, matching the {@link HUMAN_RIG} the
 * {@link CharacterAnimatorComponent} plays:
 *   idle0 idle1 · walk0-3 · run0-3 · aim0 shoot0 · reload0 reload1 · dead0-2
 *
 * Generated sheets:
 * - {@link TextureKeys.CharPlayer}: leather jacket + jeans protagonist.
 * - {@link pedVariantKey}(0..N): civilians with individual skin tones, hair
 *   styles/colours and outfits, so the crowd reads as distinct people.
 * - {@link TextureKeys.CharPolice}: navy uniform, cap with gold badge.
 * - {@link TextureKeys.CharSwat}: black tactical gear with a blue visor.
 *
 * All randomness is seeded for deterministic, reproducible output. The
 * generated textures are never added to the display list.
 */
import Phaser from 'phaser';
import { PED_VARIANT_COUNT, TextureKeys, pedVariantKey } from '@/config/AssetKeys';
import { PALETTE, shade, tintUp } from '@/graphics/palette';
import { HUMAN_FRAME_ORDER } from '@/graphics/CharacterRig';

/** Square canvas size (px) for a single character frame. */
const FRAME = 32;

/** Horizontal centre of a frame. */
const CX = FRAME / 2;

/** Everything that gives one character its individual look. */
interface CharacterStyle {
  skin: number;
  hair: number;
  hairStyle: 'short' | 'long' | 'bald' | 'cap' | 'bun' | 'headscarf' | 'helmet';
  /** Cap colour when hairStyle is 'cap'. */
  cap?: number;
  /** Small accent dot on the cap (police badge). */
  capBadge?: number;
  shirt: number;
  shirtDark: number;
  pants: number;
  /** Extra chest detail: vertical zip/tie line colour. */
  chestLine?: number;
  /** Shoulder pads/patches colour (police/SWAT). */
  shoulderPatch?: number;
  /** Profession/equipment mark rendered as a readable two-to-four pixel cue. */
  detail?:
    | 'medical'
    | 'paramedic'
    | 'construction'
    | 'business'
    | 'taxi'
    | 'tourist'
    | 'student'
    | 'mechanic'
    | 'shopkeeper'
    | 'elder'
    | 'courier'
    | 'player';
  /** Pack visible around the trailing shoulders. */
  backpack?: number;
  /** Sidearm or equipment pouch visible at the right hip. */
  holster?: boolean;
  shoes?: number;
  /** Torso width in px (11 slim … 14 heavy). */
  build: number;
}

/** A single pose's limb offsets, all in pixels (y grows downward). */
interface Pose {
  /** Left/right foot offsets along the walk axis. */
  footL: number;
  footR: number;
  /** Left/right arm swing offsets. */
  armL: number;
  armR: number;
  /** Whether both arms are extended forward holding the weapon. */
  aiming: boolean;
  /** Weapon-recoil offset applied to the forward arms. */
  recoil: number;
  /** Hands pulled to the chest (reload fumble); 0/1/2 = variant. */
  reload: 0 | 1 | 2;
}

/** A neutral standing pose to build the others from. */
const REST: Pose = { footL: 0, footR: 0, armL: 0, armR: 0, aiming: false, recoil: 0, reload: 0 };

/**
 * Draws every character sprite sheet and registers its named frames.
 */
export class CharacterTextureFactory {
  /** @param scene A live scene whose texture manager receives the textures. */
  constructor(private readonly scene: Phaser.Scene) {}

  /** Generate every character sheet. Skips any key already registered. */
  public generateAll(): void {
    this.sheet(TextureKeys.CharPlayer, {
      skin: PALETTE.skin,
      hair: 0x241a10,
      hairStyle: 'short',
      shirt: PALETTE.playerShirt,
      shirtDark: PALETTE.playerShirtDark,
      pants: PALETTE.playerPants,
      chestLine: 0xd1b45e,
      detail: 'player',
      backpack: 0x8a633f,
      holster: true,
      shoes: 0x181d25,
      build: 13,
    });

    this.sheet(TextureKeys.CharPolice, {
      skin: PALETTE.skin,
      hair: PALETTE.policeCap,
      hairStyle: 'cap',
      cap: PALETTE.policeCap,
      capBadge: PALETTE.policeBadge,
      shirt: PALETTE.policeUniform,
      shirtDark: PALETTE.policeUniformDark,
      pants: PALETTE.policeUniformDark,
      shoulderPatch: PALETTE.policeBadge,
      build: 13,
    });

    this.sheet(TextureKeys.CharSwat, {
      skin: PALETTE.skin,
      hair: PALETTE.swatArmorDark,
      hairStyle: 'cap',
      cap: PALETTE.swatArmorDark,
      capBadge: PALETTE.swatVisor,
      shirt: PALETTE.swatArmor,
      shirtDark: PALETTE.swatArmorDark,
      pants: PALETTE.swatArmorDark,
      shoulderPatch: shade(PALETTE.swatArmor, 0.25),
      build: 14,
    });

    // Civilians: a deterministic wardrobe of distinct people.
    for (let i = 0; i < PED_VARIANT_COUNT; i++) {
      this.sheet(pedVariantKey(i), this.civilianStyle(i));
    }

    // Legacy single-frame key kept alive for any straggler consumer: alias the
    // first civilian variant so the key always resolves.
    if (!this.scene.textures.exists(TextureKeys.CharPed)) {
      this.sheet(TextureKeys.CharPed, this.civilianStyle(0));
    }
  }

  /** Stable authored roster: each civilian variant communicates a profession. */
  private civilianStyle(index: number): CharacterStyle {
    const roster: readonly CharacterStyle[] = [
      {
        skin: 0xc98b5d,
        hair: 0x2b211c,
        hairStyle: 'bun',
        shirt: 0xd9ddd8,
        shirtDark: 0xaeb7b4,
        pants: 0x3f7475,
        detail: 'medical',
        build: 11,
      },
      {
        skin: 0xe0ad7c,
        hair: 0x38291f,
        hairStyle: 'short',
        shirt: 0x315d6f,
        shirtDark: 0x203e4c,
        pants: 0x263b49,
        detail: 'paramedic',
        shoulderPatch: 0xb4c94b,
        build: 13,
      },
      {
        skin: 0x9e6947,
        hair: 0x3a2a1a,
        hairStyle: 'helmet',
        cap: 0xe1ad37,
        shirt: 0xc96632,
        shirtDark: 0x844126,
        pants: 0x4b5960,
        detail: 'construction',
        shoes: 0x3d2b20,
        build: 14,
      },
      {
        skin: 0xf0c99d,
        hair: 0x1c1816,
        hairStyle: 'short',
        shirt: 0x3c485b,
        shirtDark: 0x252e3b,
        pants: 0x252c37,
        chestLine: 0xb14b4b,
        detail: 'business',
        shoes: 0x17191d,
        build: 12,
      },
      {
        skin: 0x70472f,
        hair: 0x241b17,
        hairStyle: 'cap',
        cap: 0x2f4856,
        shirt: 0xb68a3d,
        shirtDark: 0x775a2b,
        pants: 0x33444d,
        detail: 'taxi',
        build: 13,
      },
      {
        skin: 0xf0c99d,
        hair: 0x957044,
        hairStyle: 'long',
        shirt: 0xb95458,
        shirtDark: 0x77383e,
        pants: 0x55779a,
        detail: 'tourist',
        backpack: 0x397b7b,
        build: 11,
      },
      {
        skin: 0xe0ad7c,
        hair: 0x68472a,
        hairStyle: 'short',
        shirt: 0x4c7a58,
        shirtDark: 0x31513d,
        pants: 0x40516a,
        detail: 'student',
        backpack: 0x65517b,
        build: 10,
      },
      {
        skin: 0xc98b5d,
        hair: 0x29221d,
        hairStyle: 'bald',
        shirt: 0x43677a,
        shirtDark: 0x294654,
        pants: 0x355767,
        detail: 'mechanic',
        build: 14,
      },
      {
        skin: 0x9e6947,
        hair: 0x533b50,
        hairStyle: 'headscarf',
        cap: 0x6c526d,
        shirt: 0x9b5c4d,
        shirtDark: 0x673d35,
        pants: 0x463f4d,
        detail: 'shopkeeper',
        build: 12,
      },
      {
        skin: 0xe0ad7c,
        hair: 0xaaa39a,
        hairStyle: 'bald',
        shirt: 0x776b5c,
        shirtDark: 0x4d463d,
        pants: 0x4b5056,
        detail: 'elder',
        build: 12,
      },
      {
        skin: 0xc98b5d,
        hair: 0x2d211a,
        hairStyle: 'bun',
        shirt: 0x705a82,
        shirtDark: 0x493c57,
        pants: 0x3f4050,
        chestLine: 0xd9c9b8,
        detail: 'business',
        build: 11,
      },
      {
        skin: 0x70472f,
        hair: 0x23262d,
        hairStyle: 'helmet',
        cap: 0x304d66,
        shirt: 0x3b7289,
        shirtDark: 0x284d5d,
        pants: 0x2c3744,
        detail: 'courier',
        backpack: 0xb95c35,
        build: 13,
      },
      {
        skin: 0xf0c99d,
        hair: 0x743528,
        hairStyle: 'long',
        shirt: 0x6e8751,
        shirtDark: 0x475936,
        pants: 0x555d68,
        build: 15,
      },
      {
        skin: 0x9e6947,
        hair: 0x4d3542,
        hairStyle: 'headscarf',
        cap: 0x8a515d,
        shirt: 0xb18147,
        shirtDark: 0x74562f,
        pants: 0x3f5349,
        detail: 'shopkeeper',
        build: 13,
      },
    ];
    return roster[index % roster.length] ?? roster[0]!;
  }

  /**
   * Draw one full sheet for `style`, stamp it as `key` and register the
   * named frames. Skips generation when the key already exists.
   */
  private sheet(key: string, style: CharacterStyle): void {
    if (this.scene.textures.exists(key)) return;

    const g = this.scene.make.graphics({ x: 0, y: 0 }, false);
    const frames = HUMAN_FRAME_ORDER;

    frames.forEach((frameName, index) => {
      const ox = index * FRAME;
      this.drawFrame(g, ox, frameName, style);
    });

    g.generateTexture(key, FRAME * frames.length, FRAME);
    g.destroy();

    const texture = this.scene.textures.get(key);
    frames.forEach((frameName, index) => {
      texture.add(frameName, 0, index * FRAME, 0, FRAME, FRAME);
    });
  }

  /** Dispatch a named frame to its painter. */
  private drawFrame(
    g: Phaser.GameObjects.Graphics,
    ox: number,
    frameName: string,
    style: CharacterStyle,
  ): void {
    switch (frameName) {
      case 'idle0':
        this.body(g, ox, style, REST);
        break;
      case 'idle1':
        this.body(g, ox, style, { ...REST, armL: 1, armR: 1 });
        break;
      case 'walk0':
      case 'walk1':
      case 'walk2':
      case 'walk3': {
        const phase = (Number(frameName.slice(4)) / 4) * Math.PI * 2;
        const swing = Math.round(Math.sin(phase) * 3);
        this.body(g, ox, style, { ...REST, footL: swing, footR: -swing, armL: -swing, armR: swing });
        break;
      }
      case 'run0':
      case 'run1':
      case 'run2':
      case 'run3': {
        const phase = (Number(frameName.slice(3)) / 4) * Math.PI * 2;
        const swing = Math.round(Math.sin(phase) * 5);
        this.body(g, ox, style, {
          ...REST,
          footL: swing,
          footR: -swing,
          armL: -Math.round(swing * 0.8),
          armR: Math.round(swing * 0.8),
        });
        break;
      }
      case 'aim0':
        this.body(g, ox, style, { ...REST, aiming: true, recoil: 0 });
        break;
      case 'shoot0':
        this.body(g, ox, style, { ...REST, aiming: true, recoil: 2 });
        break;
      case 'reload0':
        this.body(g, ox, style, { ...REST, reload: 1 });
        break;
      case 'reload1':
        this.body(g, ox, style, { ...REST, reload: 2 });
        break;
      case 'dead0':
        this.corpse(g, ox, style, 0);
        break;
      case 'dead1':
        this.corpse(g, ox, style, 1);
        break;
      case 'dead2':
        this.corpse(g, ox, style, 2);
        break;
      default:
        this.body(g, ox, style, REST);
        break;
    }
  }

  /**
   * Draw a living pose: shadow, feet, torso, arms (or aim pose), head + hair.
   */
  private body(
    g: Phaser.GameObjects.Graphics,
    ox: number,
    s: CharacterStyle,
    pose: Pose,
  ): void {
    const cx = ox + CX;
    const half = s.build / 2;

    // Ground shadow.
    g.fillStyle(PALETTE.shadow, 0.24);
    g.fillEllipse(cx + 2, 20, s.build + 6, 8);

    // Packs sit behind the body and remain visible around the shoulders/hips.
    if (s.backpack !== undefined) {
      g.fillStyle(PALETTE.outline, 0.9);
      g.fillRoundedRect(cx - half + 1, 12, s.build - 2, 13, 4);
      g.fillStyle(shade(s.backpack, 0.25), 1);
      g.fillRoundedRect(cx - half + 2, 13, s.build - 4, 11, 3);
      g.fillStyle(tintUp(s.backpack, 0.18), 1);
      g.fillRect(cx - half + 3, 14, 2, 7);
    }

    // Feet (behind the torso, i.e. toward +Y).
    const shoe = s.shoes ?? shade(s.pants, 0.38);
    g.fillStyle(shoe, 1);
    g.fillRoundedRect(cx - 4, 18 - pose.footL, 3, 6, 1);
    g.fillRoundedRect(cx + 1, 18 - pose.footR, 3, 6, 1);

    // Torso: outlined shoulder block with pants across the hips.
    g.fillStyle(PALETTE.outline, 0.9);
    g.fillRoundedRect(cx - half - 1, 9, s.build + 2, 13, 5);
    g.fillStyle(s.shirt, 1);
    g.fillRoundedRect(cx - half, 10, s.build, 11, 4);
    // Shoulder shading and a one-pixel key-light plane establish the angle.
    g.fillStyle(s.shirtDark, 1);
    g.fillRect(cx - half + 1, 11, s.build - 2, 2);
    g.fillStyle(tintUp(s.shirt, 0.16), 0.9);
    g.fillRect(cx - half + 1, 10, Math.max(3, s.build / 2 - 1), 1);
    // Hips / belt.
    g.fillStyle(s.pants, 1);
    g.fillRoundedRect(cx - half + 1, 18, s.build - 2, 4, 2);
    // Optional chest line (zip / tie / vest seam).
    if (s.chestLine !== undefined) {
      g.fillStyle(s.chestLine, 0.9);
      g.fillRect(cx - 1, 12, 1, 7);
    }
    // Optional shoulder patches.
    if (s.shoulderPatch !== undefined) {
      g.fillStyle(s.shoulderPatch, 1);
      g.fillRect(cx - half, 11, 2, 2);
      g.fillRect(cx + half - 2, 11, 2, 2);
    }
    this.professionDetail(g, cx, half, s);

    if (s.holster) {
      g.fillStyle(0x171a20, 1);
      g.fillRect(cx + half - 1, 18, 3, 5);
      g.fillStyle(PALETTE.chrome, 0.8);
      g.fillRect(cx + half - 1, 18, 2, 1);
    }

    // Arms.
    if (pose.reload > 0) {
      // Hands pulled to the chest, elbows out.
      g.fillStyle(s.shirtDark, 1);
      g.fillRoundedRect(cx - half - 2, 12, 3, 6, 1);
      g.fillRoundedRect(cx + half - 1, 12, 3, 6, 1);
      g.fillStyle(s.skin, 1);
      const spread = pose.reload === 1 ? 1 : 3;
      g.fillRect(cx - spread - 1, 10, 2, 2);
      g.fillRect(cx + spread - 1, 10, 2, 2);
      // The weapon held across the chest.
      g.fillStyle(PALETTE.metalDark, 1);
      g.fillRect(cx - 4, 9, 8, 2);
    } else if (pose.aiming) {
      // Both arms thrust forward gripping the weapon.
      const rise = 4 + pose.recoil;
      g.fillStyle(s.shirtDark, 1);
      g.fillRoundedRect(cx - 4, rise, 3, 8, 1);
      g.fillRoundedRect(cx + 1, rise, 3, 8, 1);
      // Hands meeting on the grip.
      g.fillStyle(s.skin, 1);
      g.fillRect(cx - 2, rise, 4, 2);
      // The weapon barrel pointing up.
      g.fillStyle(PALETTE.metalDark, 1);
      g.fillRect(cx - 1, Math.max(0, rise - 6), 2, 6);
    } else {
      // Relaxed arms swinging with the stride.
      g.fillStyle(s.shirtDark, 1);
      g.fillRoundedRect(cx - half - 3, 11 - pose.armL, 3, 8, 1);
      g.fillRoundedRect(cx + half, 11 - pose.armR, 3, 8, 1);
      // Skin-tone hands at the arm tips.
      g.fillStyle(s.skin, 1);
      g.fillRect(cx - half - 3, 18 - pose.armL, 2, 2);
      g.fillRect(cx + half + 1, 18 - pose.armR, 2, 2);
      if (s.detail === 'elder') {
        g.fillStyle(0x6f5133, 1);
        g.fillRect(cx + half + 3, 16 - pose.armR, 1, 10);
        g.fillRect(cx + half + 2, 25 - pose.armR, 3, 1);
      } else if (s.detail === 'business') {
        g.fillStyle(0x2a211c, 1);
        g.fillRect(cx + half + 2, 18 - pose.armR, 5, 5);
        g.fillStyle(0x8e7049, 1);
        g.fillRect(cx + half + 3, 19 - pose.armR, 3, 1);
      }
    }

    this.head(g, cx, 9, s);
  }

  /** Tiny authored cues that remain legible without labels at gameplay zoom. */
  private professionDetail(
    g: Phaser.GameObjects.Graphics,
    cx: number,
    half: number,
    s: CharacterStyle,
  ): void {
    switch (s.detail) {
      case 'medical':
        g.fillStyle(0xb8494d, 1);
        g.fillRect(cx - 1, 13, 2, 6);
        g.fillRect(cx - 3, 15, 6, 2);
        break;
      case 'paramedic':
        g.fillStyle(0xb8cf58, 1);
        g.fillRect(cx - half + 1, 14, s.build - 2, 2);
        g.fillRect(cx - 1, 12, 2, 7);
        break;
      case 'construction':
        g.fillStyle(0xf0d068, 1);
        g.fillRect(cx - half + 1, 14, 2, 6);
        g.fillRect(cx + half - 3, 14, 2, 6);
        g.fillRect(cx - half + 2, 17, s.build - 4, 1);
        break;
      case 'business':
        g.fillStyle(0xd6d0c2, 1);
        g.fillRect(cx - 2, 12, 4, 2);
        break;
      case 'taxi':
        g.fillStyle(0xe7d7a0, 1);
        g.fillRect(cx - half + 2, 13, 3, 3);
        g.fillStyle(0x263842, 1);
        g.fillRect(cx - half + 3, 14, 1, 1);
        break;
      case 'tourist':
        g.fillStyle(0x272b32, 1);
        g.fillRect(cx - 3, 14, 6, 5);
        g.fillStyle(0x7e9ea5, 1);
        g.fillCircle(cx, 16, 1.5);
        break;
      case 'student':
        g.fillStyle(tintUp(s.shirt, 0.3), 1);
        g.fillRect(cx - 1, 12, 2, 7);
        break;
      case 'mechanic':
        g.fillStyle(0xd2aa45, 1);
        g.fillRect(cx - half + 1, 18, s.build - 2, 2);
        g.fillStyle(0x9da7a9, 1);
        g.fillRect(cx + 2, 17, 2, 4);
        break;
      case 'shopkeeper':
        g.fillStyle(0xd8b478, 1);
        g.fillRect(cx - half + 2, 14, s.build - 4, 7);
        g.fillStyle(0x8d6847, 1);
        g.fillRect(cx - half + 3, 14, s.build - 6, 1);
        break;
      case 'courier':
        g.fillStyle(0xdce2d8, 1);
        g.fillRect(cx - half + 1, 15, s.build - 2, 2);
        break;
      case 'player':
        // Golden scarf, belt pouches and holster make the player identifiable.
        g.fillStyle(0xd1b45e, 1);
        g.fillRect(cx - half + 2, 12, s.build - 4, 2);
        g.fillStyle(0x272c34, 1);
        g.fillRect(cx - half + 2, 18, s.build - 4, 2);
        g.fillStyle(0x9b6d3f, 1);
        g.fillRect(cx - half + 2, 19, 3, 3);
        break;
      default:
        break;
    }
  }

  /** Draw the head: face rim at the leading edge, hair/cap over the crown. */
  private head(g: Phaser.GameObjects.Graphics, cx: number, cy: number, s: CharacterStyle): void {
    // Head base (skin) with a thin outline.
    g.fillStyle(PALETTE.outline, 0.8);
    g.fillCircle(cx, cy, 5);
    g.fillStyle(s.skin, 1);
    g.fillCircle(cx, cy, 4.4);

    if (s.hairStyle === 'bald') {
      // A subtle crown highlight instead of hair.
      g.fillStyle(tintUp(s.skin, 0.18), 1);
      g.fillCircle(cx - 1, cy, 2);
      return;
    }

    if ((s.hairStyle === 'cap' || s.hairStyle === 'helmet') && s.cap !== undefined) {
      // Cap dome + brim toward the facing direction.
      g.fillStyle(s.cap, 1);
      g.fillCircle(cx, cy + 0.5, s.hairStyle === 'helmet' ? 4.6 : 4);
      g.fillStyle(shade(s.cap, 0.25), 1);
      g.fillRect(cx - 4, cy - 5, 8, s.hairStyle === 'helmet' ? 4 : 3);
      if (s.hairStyle === 'helmet') {
        g.fillStyle(tintUp(s.cap, 0.3), 1);
        g.fillRect(cx - 2, cy - 5, 3, 1);
      }
      if (s.capBadge !== undefined) {
        g.fillStyle(s.capBadge, 1);
        g.fillRect(cx - 1, cy - 4, 2, 2);
      }
      return;
    }

    if (s.hairStyle === 'headscarf') {
      const scarf = s.cap ?? s.hair;
      g.fillStyle(shade(scarf, 0.28), 1);
      g.fillCircle(cx, cy + 1, 5);
      g.fillRoundedRect(cx - 5, cy + 2, 10, 8, 3);
      g.fillStyle(scarf, 1);
      g.fillCircle(cx, cy, 4.2);
      // Keep a small face crescent visible at the forward edge.
      g.fillStyle(s.skin, 1);
      g.fillRect(cx - 2, cy - 4, 4, 2);
      g.fillStyle(tintUp(scarf, 0.18), 1);
      g.fillRect(cx - 3, cy - 2, 2, 5);
      return;
    }

    // Hair covers the crown; the face rim stays visible at the top (front).
    g.fillStyle(s.hair, 1);
    g.beginPath();
    g.arc(cx, cy, 4.2, Math.PI * 0.05, Math.PI * 0.95, false);
    g.closePath();
    g.fillPath();
    g.fillCircle(cx, cy + 1.4, 3.4);

    if (s.hairStyle === 'long') {
      // Locks trailing behind the shoulders.
      g.fillRoundedRect(cx - 6, cy + 2, 3, 8, 1);
      g.fillRoundedRect(cx + 3, cy + 2, 3, 8, 1);
    } else if (s.hairStyle === 'bun') {
      g.fillCircle(cx, cy + 5, 3);
      g.fillStyle(tintUp(s.hair, 0.12), 1);
      g.fillRect(cx - 2, cy - 2, 3, 1);
    }
  }

  /**
   * Draw a collapse frame. Stage 0 = crumpling, 1 = down, 2 = flat with a
   * spreading blood pool (the held corpse frame).
   */
  private corpse(
    g: Phaser.GameObjects.Graphics,
    ox: number,
    s: CharacterStyle,
    stage: 0 | 1 | 2,
  ): void {
    const cx = ox + CX;
    const cy = 16;

    if (stage >= 1) {
      // Blood pool grows beneath the settled body.
      g.fillStyle(PALETTE.blood, stage === 1 ? 0.5 : 0.75);
      g.fillEllipse(cx + 2, cy + 3, 10 + stage * 6, 7 + stage * 3);
    }

    if (stage === 0) {
      // Knees buckling: body low, head tipping sideways.
      g.fillStyle(PALETTE.shadow, 0.2);
      g.fillEllipse(cx, cy + 3, s.build + 6, 9);
      g.fillStyle(s.shirt, 1);
      g.fillRoundedRect(cx - s.build / 2, cy - 4, s.build, 10, 4);
      g.fillStyle(s.pants, 1);
      g.fillRoundedRect(cx - s.build / 2 + 1, cy + 3, s.build - 2, 4, 2);
      g.fillStyle(s.skin, 1);
      g.fillCircle(cx - 3, cy - 6, 4);
      g.fillStyle(s.hair, 1);
      g.fillCircle(cx - 4, cy - 6, 3);
      return;
    }

    // Sprawled flat: torso lying across the frame, limbs splayed.
    const spread = stage === 2 ? 2 : 0;
    g.fillStyle(s.shirt, 1);
    g.fillRoundedRect(cx - 8, cy - 3, 14, 8, 3);
    g.fillStyle(s.shirtDark, 1);
    g.fillRect(cx - 7, cy - 2, 12, 2);
    // Legs trailing.
    g.fillStyle(s.pants, 1);
    g.fillRoundedRect(cx + 3, cy - 2 - spread, 8, 3, 1);
    g.fillRoundedRect(cx + 2, cy + 2 + spread, 8, 3, 1);
    // Arms flung out.
    g.fillStyle(s.shirtDark, 1);
    g.fillRoundedRect(cx - 7, cy - 7 - spread, 3, 6, 1);
    g.fillRoundedRect(cx - 4, cy + 4 + spread, 6, 3, 1);
    g.fillStyle(s.skin, 1);
    g.fillRect(cx - 7, cy - 8 - spread, 2, 2);
    g.fillRect(cx + 1, cy + 5 + spread, 2, 2);
    // Head resting sideways.
    g.fillStyle(s.skin, 1);
    g.fillCircle(cx - 9, cy + 1, 4);
    g.fillStyle(s.hair, 1);
    g.fillCircle(cx - 10, cy + 1.5, 3.2);
  }
}
