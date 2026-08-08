/**
 * Generates weapon HUD icon textures — small side-profile silhouettes.
 *
 * Each icon is drawn at ~26x14 on a transparent background in light chrome/window
 * tones so it reads clearly against the dark HUD panel. The silhouettes are
 * deliberately simple (fist, pistol, SMG, shotgun, rifle) yet distinguishable at
 * small sizes. Textures are registered under the canonical {@link TextureKeys}
 * so HUD consumers can reference them by weapon.
 *
 * Follows the standard art-factory pattern: construct with a live scene, then
 * call {@link generateAll}. Existing keys are skipped so regeneration is cheap.
 */
import Phaser from 'phaser';
import { TextureKeys } from '@/config/AssetKeys';
import { PALETTE, shade, tintUp } from '@/graphics/palette';

/** Nominal icon canvas dimensions (transparent margin included). */
const ICON_W = 26;
const ICON_H = 14;

/** Draws procedural weapon HUD icon silhouettes. */
export class IconTextureFactory {
  /** Primary light silhouette colour. */
  private readonly light = PALETTE.window;
  /** Secondary/darker accent (barrels, grips, magazines). */
  private readonly dark = shade(PALETTE.chrome, 0.35);
  /** Bright highlight for small details. */
  private readonly bright = tintUp(PALETTE.window, 0.3);

  /** @param scene A live scene whose texture manager receives the icons. */
  constructor(private readonly scene: Phaser.Scene) {}

  /** Generate every weapon HUD icon. Skips keys already present. */
  public generateAll(): void {
    this.fist();
    this.knife();
    this.bat();
    this.pistol();
    this.revolver();
    this.smg();
    this.shotgun();
    this.rifle();
    this.sniper();
    this.rocket();
    this.grenade();
    this.molotov();
  }

  /** A combat knife — blade with an edge glint and a wrapped grip. */
  private knife(): void {
    this.stamp(TextureKeys.IconKnife, (g) => {
      const y = 6;
      // Blade.
      g.fillStyle(this.light, 1);
      g.fillTriangle(10, y - 3, 24, y + 1, 10, y + 3);
      // Edge glint.
      g.fillStyle(this.bright, 1);
      g.fillRect(11, y - 1, 11, 1);
      // Guard + wrapped grip.
      g.fillStyle(this.dark, 1);
      g.fillRect(9, y - 4, 2, 8);
      g.fillRoundedRect(2, y - 2, 7, 4, 1);
      g.fillStyle(this.light, 1);
      g.fillRect(4, y - 2, 1, 4);
      g.fillRect(6, y - 2, 1, 4);
    });
  }

  /** A baseball bat — tapered barrel with a knobbed handle. */
  private bat(): void {
    this.stamp(TextureKeys.IconBat, (g) => {
      const y = 7;
      // Barrel (thick end to the right).
      g.fillStyle(this.light, 1);
      g.fillTriangle(6, y - 2, 24, y - 4, 24, y + 4);
      g.fillTriangle(6, y + 2, 6, y - 2, 24, y + 4);
      // Grain line.
      g.fillStyle(this.dark, 1);
      g.fillRect(10, y - 1, 12, 1);
      // Handle + knob.
      g.fillRect(3, y - 1, 4, 2);
      g.fillRoundedRect(1, y - 2, 2, 4, 1);
    });
  }

  /** A revolver — short barrel, prominent cylinder, curved grip. */
  private revolver(): void {
    this.stamp(TextureKeys.IconRevolver, (g) => {
      const y = 4;
      // Barrel.
      g.fillStyle(this.light, 1);
      g.fillRect(11, y, 10, 3);
      g.fillStyle(this.bright, 1);
      g.fillRect(20, y + 1, 2, 1);
      // Cylinder.
      g.fillStyle(this.dark, 1);
      g.fillRoundedRect(7, y - 1, 5, 5, 2);
      g.fillStyle(this.bright, 1);
      g.fillRect(9, y + 1, 1, 1);
      // Frame + curved grip.
      g.fillStyle(this.light, 1);
      g.fillRect(4, y, 4, 3);
      g.fillStyle(this.dark, 1);
      g.fillRoundedRect(2, y + 2, 4, 8, 2);
      // Hammer.
      g.fillRect(5, y - 2, 2, 2);
    });
  }

  /** A sniper rifle — very long barrel with a scope on top. */
  private sniper(): void {
    this.stamp(TextureKeys.IconSniper, (g) => {
      const y = 6;
      // Stock.
      g.fillStyle(this.dark, 1);
      g.fillRoundedRect(0, y - 1, 5, 5, 1);
      // Receiver + long barrel.
      g.fillStyle(this.light, 1);
      g.fillRect(4, y, 12, 3);
      g.fillRect(16, y + 1, 9, 1);
      // Muzzle brake.
      g.fillStyle(this.bright, 1);
      g.fillRect(24, y, 2, 3);
      // Scope.
      g.fillStyle(this.dark, 1);
      g.fillRoundedRect(7, y - 4, 7, 3, 1);
      g.fillStyle(this.bright, 1);
      g.fillRect(13, y - 3, 1, 1);
      // Grip + magazine.
      g.fillStyle(this.dark, 1);
      g.fillRoundedRect(6, y + 3, 3, 4, 1);
      g.fillRoundedRect(11, y + 3, 3, 3, 1);
    });
  }

  /** A rocket launcher — fat tube with a protruding warhead. */
  private rocket(): void {
    this.stamp(TextureKeys.IconRocket, (g) => {
      const y = 5;
      // Tube.
      g.fillStyle(this.dark, 1);
      g.fillRoundedRect(3, y - 1, 17, 5, 2);
      g.fillStyle(this.light, 1);
      g.fillRect(4, y, 15, 1);
      // Warhead poking out.
      g.fillStyle(this.bright, 1);
      g.fillTriangle(20, y - 2, 20, y + 5, 25, y + 1.5);
      // Grip + shoulder rest.
      g.fillStyle(this.dark, 1);
      g.fillRoundedRect(8, y + 4, 3, 4, 1);
      g.fillRect(1, y, 2, 4);
    });
  }

  /** A grenade — round body, fuse cap and safety lever. */
  private grenade(): void {
    this.stamp(TextureKeys.IconGrenade, (g) => {
      const cx = 12;
      const cy = 8;
      // Body.
      g.fillStyle(this.light, 1);
      g.fillCircle(cx, cy, 5);
      // Fragmentation cross-hatch.
      g.fillStyle(this.dark, 1);
      g.fillRect(cx - 5, cy - 1, 10, 1);
      g.fillRect(cx - 1, cy - 4, 1, 8);
      // Fuse cap + lever.
      g.fillRoundedRect(cx - 2, cy - 8, 4, 3, 1);
      g.fillStyle(this.bright, 1);
      g.fillRect(cx + 2, cy - 7, 5, 1);
    });
  }

  /** A molotov — bottle silhouette with a burning rag. */
  private molotov(): void {
    this.stamp(TextureKeys.IconMolotov, (g) => {
      const cx = 13;
      // Flame.
      g.fillStyle(this.bright, 1);
      g.fillCircle(cx + 7, 3, 2);
      // Rag into the neck.
      g.fillStyle(this.light, 1);
      g.fillRect(cx + 4, 3, 4, 2);
      // Bottle tilted: neck then body.
      g.fillRect(cx + 1, 4, 4, 3);
      g.fillStyle(this.dark, 1);
      g.fillRoundedRect(cx - 8, 5, 10, 7, 3);
      // Liquid line.
      g.fillStyle(this.light, 1);
      g.fillRect(cx - 6, 8, 7, 1);
    });
  }

  /**
   * Draw with a throwaway Graphics object, then stamp it into a texture.
   *
   * @param key Texture key to register the result under.
   * @param draw Callback that renders into the graphics context.
   */
  private stamp(key: TextureKeys, draw: (g: Phaser.GameObjects.Graphics) => void): void {
    if (this.scene.textures.exists(key)) return;
    const g = this.scene.make.graphics({ x: 0, y: 0 }, false);
    draw(g);
    g.generateTexture(key, ICON_W, ICON_H);
    g.destroy();
  }

  /** A clenched fist / knuckles silhouette for the unarmed slot. */
  private fist(): void {
    this.stamp(TextureKeys.IconFist, (g) => {
      const cx = 11;
      const cy = 7;
      // Forearm.
      g.fillStyle(this.dark, 1);
      g.fillRoundedRect(cx + 4, cy - 2, 10, 5, 2);
      // Fist mass.
      g.fillStyle(this.light, 1);
      g.fillRoundedRect(cx - 5, cy - 4, 9, 9, 3);
      // Knuckle ridges.
      g.fillStyle(this.bright, 1);
      for (let i = 0; i < 4; i++) {
        g.fillRect(cx - 4 + i * 2, cy - 4, 1, 3);
      }
      // Thumb.
      g.fillStyle(this.light, 1);
      g.fillRoundedRect(cx - 6, cy, 3, 4, 1);
    });
  }

  /** A small handgun profile — grip, trigger guard, short barrel. */
  private pistol(): void {
    this.stamp(TextureKeys.IconPistol, (g) => {
      const y = 4;
      // Slide / barrel.
      g.fillStyle(this.light, 1);
      g.fillRect(4, y, 15, 4);
      // Muzzle tip.
      g.fillStyle(this.bright, 1);
      g.fillRect(18, y + 1, 2, 2);
      // Grip (angled block).
      g.fillStyle(this.dark, 1);
      g.fillRoundedRect(4, y + 3, 5, 8, 1);
      // Trigger guard.
      g.lineStyle(1, this.light, 1);
      g.strokeRect(8, y + 4, 4, 4);
    });
  }

  /** A compact SMG — short body, stubby barrel, magazine, small stock. */
  private smg(): void {
    this.stamp(TextureKeys.IconSmg, (g) => {
      const y = 4;
      // Receiver body.
      g.fillStyle(this.light, 1);
      g.fillRoundedRect(4, y, 16, 5, 1);
      // Barrel.
      g.fillStyle(this.bright, 1);
      g.fillRect(19, y + 1, 4, 2);
      // Magazine (curved-ish, points down).
      g.fillStyle(this.dark, 1);
      g.fillRoundedRect(9, y + 4, 4, 7, 1);
      // Grip.
      g.fillRoundedRect(5, y + 4, 3, 5, 1);
      // Short folding stock.
      g.fillStyle(this.light, 1);
      g.fillRect(1, y + 1, 3, 3);
    });
  }

  /** A long two-tone shotgun — full-length barrel over a wooden fore-stock. */
  private shotgun(): void {
    this.stamp(TextureKeys.IconShotgun, (g) => {
      const y = 5;
      // Barrel (upper, light).
      g.fillStyle(this.light, 1);
      g.fillRect(3, y, 20, 3);
      // Muzzle.
      g.fillStyle(this.bright, 1);
      g.fillRect(22, y, 2, 3);
      // Fore-stock / pump (lower, darker tone).
      g.fillStyle(this.dark, 1);
      g.fillRect(6, y + 3, 12, 2);
      // Rear stock.
      g.fillStyle(this.dark, 1);
      g.fillRoundedRect(0, y - 1, 5, 6, 1);
      // Trigger.
      g.fillStyle(this.light, 1);
      g.fillRect(5, y + 5, 2, 2);
    });
  }

  /** An assault-rifle profile — long barrel, receiver, angled magazine, stock. */
  private rifle(): void {
    this.stamp(TextureKeys.IconRifle, (g) => {
      const y = 4;
      // Rear stock.
      g.fillStyle(this.dark, 1);
      g.fillRoundedRect(0, y, 5, 5, 1);
      // Receiver body.
      g.fillStyle(this.light, 1);
      g.fillRect(4, y, 14, 4);
      // Long barrel.
      g.fillRect(18, y + 1, 7, 2);
      // Muzzle tip.
      g.fillStyle(this.bright, 1);
      g.fillRect(24, y + 1, 1, 2);
      // Angled magazine (points down-forward).
      g.fillStyle(this.dark, 1);
      g.fillTriangle(8, y + 4, 13, y + 4, 9, y + 11);
      g.fillRoundedRect(8, y + 4, 4, 6, 1);
      // Pistol grip.
      g.fillRoundedRect(5, y + 4, 3, 4, 1);
      // Front sight.
      g.fillStyle(this.light, 1);
      g.fillRect(17, y - 2, 1, 3);
    });
  }
}
