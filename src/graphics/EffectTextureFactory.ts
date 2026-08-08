/**
 * Generates the small procedural effect textures used by combat and particles.
 *
 * Every combat / feedback effect (bullet tracers, muzzle flashes, blood decals,
 * explosions, smoke puffs and sparks) is drawn here at runtime under the
 * canonical {@link TextureKeys}, so consumers (ParticleManager, projectiles,
 * decal system) never touch raw graphics. All textures use transparent
 * backgrounds and share the single {@link PALETTE} for a coherent look.
 *
 * Randomness is seeded so splat/puff irregularity is deterministic and
 * reproducible across runs and tests.
 */
import Phaser from 'phaser';
import { TextureKeys } from '@/config/AssetKeys';
import { PALETTE, shade, tintUp } from '@/graphics/palette';
import { Random } from '@/utils';

/**
 * Factory that stamps single-frame effect textures into a scene's texture
 * manager. Construct with a live scene, then call {@link generateAll}.
 */
export class EffectTextureFactory {
  /** Seeded RNG for deterministic speckle / splat irregularity. */
  private readonly rng = new Random(0x0badf00d);

  /** @param scene A live scene whose texture manager receives the textures. */
  constructor(private readonly scene: Phaser.Scene) {}

  /** Generate every effect texture. Existing keys are left untouched. */
  public generateAll(): void {
    this.bullet();
    this.rocket();
    this.grenade();
    this.molotov();
    this.muzzle();
    this.blood();
    this.explosion();
    this.smoke();
    this.spark();
    this.casing();
    this.flame();
    this.glowSoft();
    this.headlightCone();
    this.skidMark();
    this.ring();
    this.snowflake();
    this.hitMarker();
  }

  /**
   * Draw with a throwaway Graphics object, then stamp it into a texture.
   * Skips generation entirely when the key already exists.
   *
   * @param key    Canonical texture key to register under.
   * @param width  Texture width in pixels.
   * @param height Texture height in pixels.
   * @param draw   Callback that renders into the temporary graphics.
   */
  private stamp(
    key: TextureKeys,
    width: number,
    height: number,
    draw: (g: Phaser.GameObjects.Graphics) => void,
  ): void {
    if (this.scene.textures.exists(key)) return;
    const g = this.scene.make.graphics({ x: 0, y: 0 }, false);
    draw(g);
    g.generateTexture(key, width, height);
    g.destroy();
  }

  /** Bright horizontal tracer: warm trail behind a hot core streak. */
  private bullet(): void {
    const w = 6;
    const h = 3;
    this.stamp(TextureKeys.Bullet, w, h, (g) => {
      // Warm trailing tail spanning the full length.
      g.fillStyle(PALETTE.bulletTrail, 0.85);
      g.fillRect(0, 1, w, 1);
      // Hot core streak at the leading edge.
      g.fillStyle(PALETTE.bulletCore, 1);
      g.fillRect(w - 3, 0, 3, h);
      g.fillStyle(tintUp(PALETTE.bulletCore, 0.4), 1);
      g.fillRect(w - 2, 1, 2, 1);
    });
  }

  /** Radial star / flash burst for the muzzle, hottest at the centre. */
  private muzzle(): void {
    const s = 16;
    const cx = s / 2;
    const cy = s / 2;
    this.stamp(TextureKeys.Muzzle, s, s, (g) => {
      // Outer four-point star spikes.
      g.fillStyle(PALETTE.muzzle, 0.9);
      const spikes: Array<[number, number, number, number]> = [
        [cx - 1, 0, 2, s],
        [0, cy - 1, s, 2],
      ];
      for (const [x, y, w, h] of spikes) {
        g.fillRect(x, y, w, h);
      }
      // Diagonal glow blob.
      g.fillStyle(PALETTE.muzzle, 0.85);
      g.fillCircle(cx, cy, 5);
      // Bright hot core.
      g.fillStyle(PALETTE.muzzleCore, 1);
      g.fillCircle(cx, cy, 3);
    });
  }

  /** Irregular ground blood splat with darker specks; transparent backdrop. */
  private blood(): void {
    const s = 22;
    const cx = s / 2;
    const cy = s / 2;
    this.stamp(TextureKeys.Blood, s, s, (g) => {
      // Core pool.
      g.fillStyle(PALETTE.blood, 1);
      g.fillCircle(cx, cy, 7);
      // Irregular satellite droplets around the pool.
      const drops = 9;
      for (let i = 0; i < drops; i++) {
        const ang = this.rng.range(0, Math.PI * 2);
        const dist = this.rng.range(5, 10);
        const r = this.rng.range(1.5, 3.5);
        g.fillStyle(PALETTE.blood, 1);
        g.fillCircle(cx + Math.cos(ang) * dist, cy + Math.sin(ang) * dist, r);
      }
      // Darker specks for depth.
      for (let i = 0; i < 14; i++) {
        const ang = this.rng.range(0, Math.PI * 2);
        const dist = this.rng.range(0, 8);
        g.fillStyle(PALETTE.bloodDark, 1);
        g.fillRect(
          Math.round(cx + Math.cos(ang) * dist),
          Math.round(cy + Math.sin(ang) * dist),
          1,
          1,
        );
      }
    });
  }

  /** Roughly circular radial fireball: hot core -> fire -> smoke ring. */
  private explosion(): void {
    const s = 44;
    const cx = s / 2;
    const cy = s / 2;
    this.stamp(TextureKeys.Explosion, s, s, (g) => {
      // Outer smoke ring.
      g.fillStyle(PALETTE.smoke, 0.85);
      g.fillCircle(cx, cy, 21);
      g.fillStyle(PALETTE.smokeLight, 0.5);
      g.fillCircle(cx, cy, 18);
      // Mid fire band.
      g.fillStyle(PALETTE.fire, 0.95);
      g.fillCircle(cx, cy, 14);
      g.fillStyle(tintUp(PALETTE.fire, 0.25), 1);
      g.fillCircle(cx, cy, 10);
      // Hot core.
      g.fillStyle(PALETTE.fireCore, 1);
      g.fillCircle(cx, cy, 6);
      // Ragged flame tongues for a less perfect circle.
      for (let i = 0; i < 10; i++) {
        const ang = this.rng.range(0, Math.PI * 2);
        const dist = this.rng.range(14, 20);
        const r = this.rng.range(2, 4);
        g.fillStyle(PALETTE.fire, 0.8);
        g.fillCircle(cx + Math.cos(ang) * dist, cy + Math.sin(ang) * dist, r);
      }
    });
  }

  /** Soft, layered smoke puff with a lighter highlighted lobe. */
  private smoke(): void {
    const s = 18;
    const cx = s / 2;
    const cy = s / 2;
    this.stamp(TextureKeys.Smoke, s, s, (g) => {
      g.fillStyle(PALETTE.smoke, 0.7);
      g.fillCircle(cx, cy, 8);
      // A few overlapping lobes for a billowy silhouette.
      for (let i = 0; i < 5; i++) {
        const ang = this.rng.range(0, Math.PI * 2);
        const dist = this.rng.range(2, 5);
        const r = this.rng.range(4, 6);
        g.fillStyle(PALETTE.smoke, 0.55);
        g.fillCircle(cx + Math.cos(ang) * dist, cy + Math.sin(ang) * dist, r);
      }
      // Lighter highlight lobe toward the upper-left.
      g.fillStyle(PALETTE.smokeLight, 0.6);
      g.fillCircle(cx - 2, cy - 2, 4);
    });
  }

  /** Tiny bright spark point with a faint glow halo. */
  private spark(): void {
    const s = 4;
    const c = s / 2;
    this.stamp(TextureKeys.Spark, s, s, (g) => {
      g.fillStyle(shade(PALETTE.spark, 0.2), 0.6);
      g.fillCircle(c, c, 2);
      g.fillStyle(PALETTE.spark, 1);
      g.fillRect(1, 1, 2, 2);
    });
  }

  /** Finned rocket with a hot exhaust glow at the tail. */
  private rocket(): void {
    const w = 14;
    const h = 6;
    this.stamp(TextureKeys.Rocket, w, h, (g) => {
      // Exhaust glow (left = rear, rocket points +x like bullets).
      g.fillStyle(PALETTE.fireCore, 0.9);
      g.fillCircle(2, h / 2, 2);
      // Body tube.
      g.fillStyle(PALETTE.metalDark, 1);
      g.fillRect(3, 1, 8, h - 2);
      // Fins.
      g.fillStyle(shade(PALETTE.metalDark, 0.3), 1);
      g.fillTriangle(3, 0, 6, 0, 3, 2);
      g.fillTriangle(3, h, 6, h, 3, h - 2);
      // Warhead.
      g.fillStyle(PALETTE.lightRed, 1);
      g.fillTriangle(11, 0, 11, h, w, h / 2);
    });
  }

  /** Olive grenade with a glinting pin. */
  private grenade(): void {
    const s = 8;
    this.stamp(TextureKeys.GrenadeFx, s, s, (g) => {
      g.fillStyle(PALETTE.outline, 1);
      g.fillCircle(s / 2, s / 2 + 0.5, 3.4);
      g.fillStyle(0x4a5c34, 1);
      g.fillCircle(s / 2, s / 2 + 0.5, 2.8);
      g.fillStyle(tintUp(0x4a5c34, 0.3), 1);
      g.fillRect(2, 3, 2, 1);
      // Fuse cap + pin glint.
      g.fillStyle(PALETTE.chrome, 1);
      g.fillRect(s / 2 - 1, 0, 2, 2);
    });
  }

  /** Molotov bottle with a burning rag. */
  private molotov(): void {
    const w = 7;
    const h = 12;
    this.stamp(TextureKeys.MolotovFx, w, h, (g) => {
      // Flame at the rag end.
      g.fillStyle(PALETTE.fire, 0.95);
      g.fillCircle(w / 2, 2, 2);
      g.fillStyle(PALETTE.fireCore, 1);
      g.fillCircle(w / 2, 2, 1);
      // Neck + rag.
      g.fillStyle(0xd8d0b8, 1);
      g.fillRect(w / 2 - 1, 3, 2, 2);
      // Bottle body with amber liquid.
      g.fillStyle(0x6d8a4a, 0.9);
      g.fillRoundedRect(1, 5, w - 2, h - 5, 2);
      g.fillStyle(0xb8742a, 0.9);
      g.fillRoundedRect(2, 8, w - 4, h - 9, 1);
    });
  }

  /** Spent brass casing (small, tumbling). */
  private casing(): void {
    const w = 4;
    const h = 2;
    this.stamp(TextureKeys.Casing, w, h, (g) => {
      g.fillStyle(0xc8a23a, 1);
      g.fillRect(0, 0, w - 1, h);
      g.fillStyle(tintUp(0xc8a23a, 0.4), 1);
      g.fillRect(w - 1, 0, 1, h);
    });
  }

  /** Licking flame tongue for fire zones (animated by scale/alpha tweens). */
  private flame(): void {
    const w = 10;
    const h = 14;
    this.stamp(TextureKeys.Flame, w, h, (g) => {
      g.fillStyle(PALETTE.fire, 0.9);
      g.fillTriangle(1, h, w - 1, h, w / 2, 1);
      g.fillStyle(tintUp(PALETTE.fire, 0.25), 1);
      g.fillTriangle(3, h, w - 3, h, w / 2, 4);
      g.fillStyle(PALETTE.fireCore, 1);
      g.fillTriangle(4, h, w - 4, h, w / 2, 7);
    });
  }

  /** Soft radial glow used for lamps, headlights and brake lights. */
  private glowSoft(): void {
    const s = 32;
    const c = s / 2;
    this.stamp(TextureKeys.GlowSoft, s, s, (g) => {
      for (let r = c; r >= 2; r -= 2) {
        const alpha = 0.055 * (1 - r / c) + 0.02;
        g.fillStyle(0xffffff, alpha);
        g.fillCircle(c, c, r);
      }
      g.fillStyle(0xffffff, 0.5);
      g.fillCircle(c, c, 2);
    });
  }

  /** Forward headlight cone (drawn pointing up, widening away). */
  private headlightCone(): void {
    const w = 26;
    const h = 40;
    this.stamp(TextureKeys.HeadlightCone, w, h, (g) => {
      // Layered translucent trapezoids fake a soft-edged cone.
      const steps = 5;
      for (let i = 0; i < steps; i++) {
        const t = i / (steps - 1);
        const halfTop = 2 + t * 2;
        const halfBottom = 4 + t * (w / 2 - 4);
        g.fillStyle(PALETTE.headlight, 0.10 * (1 - t) + 0.03);
        g.fillTriangle(
          w / 2 - halfTop,
          h,
          w / 2 + halfTop,
          h,
          w / 2,
          h - h * (0.5 + t * 0.5),
        );
        g.fillTriangle(
          w / 2 - halfBottom,
          0,
          w / 2 + halfBottom,
          0,
          w / 2,
          h * (0.45 + (1 - t) * 0.2),
        );
      }
    });
  }

  /** Short dark rubber streak stamped as a skid mark. */
  private skidMark(): void {
    const w = 3;
    const h = 10;
    this.stamp(TextureKeys.SkidMark, w, h, (g) => {
      g.fillStyle(0x0c0c10, 0.85);
      g.fillRoundedRect(0, 0, w, h, 1);
      g.fillStyle(0x1c1c22, 0.9);
      g.fillRect(1, 1, 1, h - 2);
    });
  }

  /** Thin expanding ring (rain splashes, shockwaves). */
  private ring(): void {
    const s = 12;
    const c = s / 2;
    this.stamp(TextureKeys.Ring, s, s, (g) => {
      g.lineStyle(1.5, 0xffffff, 0.8);
      g.strokeCircle(c, c, c - 1.5);
    });
  }

  /** Chunky snowflake mote. */
  private snowflake(): void {
    const s = 5;
    this.stamp(TextureKeys.Snowflake, s, s, (g) => {
      g.fillStyle(0xffffff, 0.95);
      g.fillRect(2, 0, 1, s);
      g.fillRect(0, 2, s, 1);
      g.fillStyle(0xffffff, 0.7);
      g.fillRect(1, 1, 1, 1);
      g.fillRect(3, 3, 1, 1);
      g.fillRect(3, 1, 1, 1);
      g.fillRect(1, 3, 1, 1);
    });
  }

  /** Hit-confirm marker: a small open X flashed at the crosshair. */
  private hitMarker(): void {
    const s = 12;
    this.stamp(TextureKeys.HitMarker, s, s, (g) => {
      g.lineStyle(2, 0xffffff, 1);
      g.beginPath();
      g.moveTo(1, 1);
      g.lineTo(4, 4);
      g.moveTo(s - 1, 1);
      g.lineTo(s - 4, 4);
      g.moveTo(1, s - 1);
      g.lineTo(4, s - 4);
      g.moveTo(s - 1, s - 1);
      g.lineTo(s - 4, s - 4);
      g.strokePath();
    });
  }
}
