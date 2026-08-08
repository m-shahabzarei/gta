/**
 * Generates the compact top-down animal sprite sheets (dog, cat, bird).
 *
 * Dogs and cats follow the {@link ANIMAL_FRAME_ORDER} contract played by the
 * quadruped {@link ANIMAL_RIG}: `idle0 · walk0 · walk1 · dead0`, drawn facing
 * UP like every other character. Birds get a two-frame `fly0/fly1` flap used
 * directly by the city-life system (they are scenery, not characters).
 *
 * Follows the standard art-factory pattern: throwaway Graphics → stamped
 * texture → named frames; existing keys are skipped.
 */
import Phaser from 'phaser';
import { TextureKeys } from '@/config/AssetKeys';
import { PALETTE, shade, tintUp } from '@/graphics/palette';
import { ANIMAL_FRAME_ORDER } from '@/graphics/CharacterRig';

/** Frame size (px) for the quadruped sheets. */
const FRAME = 20;

export class AnimalTextureFactory {
  /** @param scene A live scene whose texture manager receives the textures. */
  constructor(private readonly scene: Phaser.Scene) {}

  /** Generate every animal sheet. Skips keys already present. */
  public generateAll(): void {
    this.quadruped(TextureKeys.AnimalDog, PALETTE.dogFur, true);
    this.quadruped(TextureKeys.AnimalCat, PALETTE.catFur, false);
    this.bird();
  }

  /**
   * Stamp one quadruped sheet.
   * @param key Texture key to register.
   * @param fur Base fur colour.
   * @param floppy Dog-style ears/tail when true; pointy cat style when false.
   */
  private quadruped(key: TextureKeys, fur: number, floppy: boolean): void {
    if (this.scene.textures.exists(key)) return;
    const g = this.scene.make.graphics({ x: 0, y: 0 }, false);

    ANIMAL_FRAME_ORDER.forEach((frameName, index) => {
      const ox = index * FRAME;
      if (frameName === 'dead0') {
        this.quadCorpse(g, ox, fur);
      } else {
        const phase = frameName === 'walk0' ? 1 : frameName === 'walk1' ? -1 : 0;
        this.quadPose(g, ox, fur, floppy, phase);
      }
    });

    g.generateTexture(key, FRAME * ANIMAL_FRAME_ORDER.length, FRAME);
    g.destroy();
    const texture = this.scene.textures.get(key);
    ANIMAL_FRAME_ORDER.forEach((frameName, index) => {
      texture.add(frameName, 0, index * FRAME, 0, FRAME, FRAME);
    });
  }

  /** Draw one living quadruped pose (facing up, legs offset by `phase`). */
  private quadPose(
    g: Phaser.GameObjects.Graphics,
    ox: number,
    fur: number,
    floppy: boolean,
    phase: number,
  ): void {
    const cx = ox + FRAME / 2;
    const dark = shade(fur, 0.3);

    // Shadow.
    g.fillStyle(PALETTE.shadow, 0.18);
    g.fillEllipse(cx, 12, 10, 6);

    // Legs: four paw dots offset by the stride phase.
    g.fillStyle(dark, 1);
    g.fillRect(cx - 4, 7 - phase, 2, 3);
    g.fillRect(cx + 2, 7 + phase, 2, 3);
    g.fillRect(cx - 4, 14 + phase, 2, 3);
    g.fillRect(cx + 2, 14 - phase, 2, 3);

    // Body: long ellipse along the travel axis.
    g.fillStyle(PALETTE.outline, 0.8);
    g.fillEllipse(cx, 11, 8.5, 12.5);
    g.fillStyle(fur, 1);
    g.fillEllipse(cx, 11, 7, 11);
    // Back stripe.
    g.fillStyle(dark, 0.8);
    g.fillRect(cx - 1, 7, 2, 8);

    // Tail behind.
    g.fillStyle(dark, 1);
    if (floppy) {
      g.fillRoundedRect(cx - 1, 16, 2, 4, 1);
    } else {
      g.fillRoundedRect(cx + 1 + phase, 16, 1.5, 5, 1);
    }

    // Head at the front with ears.
    g.fillStyle(fur, 1);
    g.fillCircle(cx, 5, 3.4);
    g.fillStyle(dark, 1);
    if (floppy) {
      g.fillEllipse(cx - 3, 5, 2.4, 4);
      g.fillEllipse(cx + 3, 5, 2.4, 4);
    } else {
      g.fillTriangle(cx - 3.5, 4, cx - 1, 2, cx - 2.5, 6);
      g.fillTriangle(cx + 3.5, 4, cx + 1, 2, cx + 2.5, 6);
    }
    // Nose tip.
    g.fillStyle(PALETTE.outline, 1);
    g.fillRect(cx - 0.5, 1.5, 1.5, 1.5);
  }

  /** Draw the quadruped corpse frame (on its side). */
  private quadCorpse(g: Phaser.GameObjects.Graphics, ox: number, fur: number): void {
    const cx = ox + FRAME / 2;
    const dark = shade(fur, 0.3);
    g.fillStyle(PALETTE.blood, 0.55);
    g.fillEllipse(cx + 1, 12, 12, 6);
    g.fillStyle(fur, 1);
    g.fillEllipse(cx, 10, 12, 7);
    g.fillStyle(dark, 1);
    g.fillRect(cx - 5, 9, 10, 2);
    // Head flopped to the side + stiff legs.
    g.fillCircle(cx - 7, 8, 3);
    g.fillRect(cx + 2, 5, 2, 3);
    g.fillRect(cx + 5, 6, 2, 3);
  }

  /** Small songbird with two flap frames + a ground hop frame. */
  private bird(): void {
    if (this.scene.textures.exists(TextureKeys.AnimalBird)) return;
    const s = 12;
    const g = this.scene.make.graphics({ x: 0, y: 0 }, false);

    const drawBird = (ox: number, wingsUp: boolean): void => {
      const cx = ox + s / 2;
      const body = 0x5a6270;
      // Wings.
      g.fillStyle(shade(body, 0.25), 1);
      if (wingsUp) {
        g.fillTriangle(cx - 5, 6, cx, 4, cx - 1, 7);
        g.fillTriangle(cx + 5, 6, cx, 4, cx + 1, 7);
      } else {
        g.fillTriangle(cx - 6, 8, cx, 5, cx - 1, 8);
        g.fillTriangle(cx + 6, 8, cx, 5, cx + 1, 8);
      }
      // Body + head.
      g.fillStyle(body, 1);
      g.fillEllipse(cx, 6, 4, 6);
      g.fillStyle(tintUp(body, 0.2), 1);
      g.fillCircle(cx, 3.5, 1.8);
      // Beak.
      g.fillStyle(PALETTE.accent, 1);
      g.fillRect(cx - 0.5, 1.5, 1, 1.5);
    };

    drawBird(0, false);
    drawBird(s, true);
    g.generateTexture(TextureKeys.AnimalBird, s * 2, s);
    g.destroy();
    const texture = this.scene.textures.get(TextureKeys.AnimalBird);
    texture.add('fly0', 0, 0, 0, s, s);
    texture.add('fly1', 0, s, 0, s, s);
  }
}
