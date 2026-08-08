/**
 * Generates procedural pixel-art textures for interactive world props.
 *
 * This factory follows the canonical art-factory pattern: it draws each texture
 * once with a throwaway {@link Phaser.GameObjects.Graphics}, stamps it into the
 * scene texture manager under a {@link TextureKeys} entry, and skips any key
 * that already exists. All textures are top-down and use transparent
 * backgrounds so they composite cleanly over the world.
 *
 * Props covered:
 * - {@link TextureKeys.TrafficLight}: a dark pole and housing with three stacked
 *   dim-grey lamps. The traffic system tints the active lamp at runtime, so the
 *   lamps are drawn as plain neutral circles here.
 * - {@link TextureKeys.MissionMarker}: a glowing upward chevron in the palette
 *   marker colour with a lighter core and a semi-transparent glow ring.
 * - {@link TextureKeys.Pickup}: a small crate/coin in the palette accent colour
 *   with a dark outline.
 *
 * All randomness is seeded via {@link Random} for deterministic output.
 */
import Phaser from 'phaser';
import { TextureKeys } from '@/config/AssetKeys';
import { PALETTE, shade, tintUp } from '@/graphics/palette';
import { Random } from '@/utils';

export class PropTextureFactory {
  /** Seeded RNG for deterministic speckle/detail placement. */
  private readonly rng = new Random(0x9d0b1e);

  /** @param scene A live scene whose texture manager receives the textures. */
  constructor(private readonly scene: Phaser.Scene) {}

  /** Generate every prop texture. Skips keys already present. */
  public generateAll(): void {
    this.trafficLight();
    this.missionMarker();
    this.pickup();
    this.supplyPickups();
    this.collectiblePackage();
    this.spikeStrip();
    this.roadBarrier();
    this.raceFlag();
    this.cactus();
    this.rock();
    this.crate();
    this.streetFixtures();
  }

  /** The four supply pickups + weapon crate, colour-coded and glyph-marked. */
  private supplyPickups(): void {
    const s = 12;
    const draw = (
      key: TextureKeys,
      color: number,
      glyph: (g: Phaser.GameObjects.Graphics, c: number) => void,
    ): void => {
      this.stamp(key, s, s, (g) => {
        const c = s / 2;
        // Soft glow so pickups read on any ground.
        g.fillStyle(color, 0.25);
        g.fillCircle(c, c, c);
        // Outlined puck.
        g.fillStyle(PALETTE.outline, 1);
        g.fillCircle(c, c, 4.6);
        g.fillStyle(color, 1);
        g.fillCircle(c, c, 3.8);
        glyph(g, c);
      });
    };

    draw(TextureKeys.PickupHealth, PALETTE.lightRed, (g, c) => {
      g.fillStyle(0xffffff, 1);
      g.fillRect(c - 0.5, c - 2.5, 1.5, 5.5);
      g.fillRect(c - 2.5, c - 0.5, 5.5, 1.5);
    });
    draw(TextureKeys.PickupArmor, 0x3a6cff, (g, c) => {
      g.fillStyle(0xffffff, 1);
      g.fillTriangle(c - 2.5, c - 2, c + 2.5, c - 2, c, c + 3);
    });
    draw(TextureKeys.PickupMoney, PALETTE.lightGreen, (g, c) => {
      g.fillStyle(0xffffff, 1);
      g.fillRect(c - 0.5, c - 3, 1.5, 6);
      g.fillRect(c - 2, c - 2, 4, 1);
      g.fillRect(c - 2, c + 1, 4, 1);
    });
    draw(TextureKeys.PickupAmmo, PALETTE.accent, (g, c) => {
      g.fillStyle(PALETTE.outline, 1);
      g.fillRect(c - 2.5, c - 2, 2, 4.5);
      g.fillRect(c + 0.5, c - 2, 2, 4.5);
    });
    draw(TextureKeys.PickupWeapon, 0x7a4ac2, (g, c) => {
      g.fillStyle(0xffffff, 1);
      g.fillRect(c - 3, c - 1, 6, 1.5);
      g.fillRect(c - 3, c + 0.5, 2, 2);
    });
  }

  /** Hidden collectible: a wrapped brown parcel with twine. */
  private collectiblePackage(): void {
    const s = 12;
    this.stamp(TextureKeys.Package, s, s, (g) => {
      g.fillStyle(PALETTE.outline, 1);
      g.fillRoundedRect(1, 2, s - 2, s - 4, 2);
      g.fillStyle(0x9a713f, 1);
      g.fillRoundedRect(2, 3, s - 4, s - 6, 1);
      // Twine cross.
      g.fillStyle(0xd8c8a0, 1);
      g.fillRect(2, s / 2 - 1, s - 4, 1);
      g.fillRect(s / 2 - 1, 3, 1, s - 6);
      // Glint.
      g.fillStyle(tintUp(0x9a713f, 0.4), 1);
      g.fillRect(3, 4, 2, 1);
    });
  }

  /** Police spike strip: a serrated dark band laid across the road. */
  private spikeStrip(): void {
    const w = 40;
    const h = 10;
    this.stamp(TextureKeys.SpikeStrip, w, h, (g) => {
      g.fillStyle(PALETTE.outline, 1);
      g.fillRoundedRect(0, 3, w, 4, 2);
      g.fillStyle(PALETTE.metalDark, 1);
      g.fillRect(1, 4, w - 2, 2);
      // Spikes.
      g.fillStyle(PALETTE.chrome, 1);
      for (let x = 3; x < w - 2; x += 5) {
        g.fillTriangle(x, 4, x + 3, 4, x + 1.5, 0);
        g.fillTriangle(x, 6, x + 3, 6, x + 1.5, 10);
      }
    });
  }

  /** Heavy concrete barricade used by strategic police roadblocks. */
  private roadBarrier(): void {
    const w = 34;
    const h = 12;
    this.stamp(TextureKeys.RoadBarrier, w, h, (g) => {
      g.fillStyle(PALETTE.outline, 1);
      g.fillRoundedRect(0, 2, w, h - 2, 2);
      g.fillStyle(0xb9bec3, 1);
      g.fillRoundedRect(1, 2, w - 2, h - 4, 1);
      g.fillStyle(0xe4e7e9, 1);
      g.fillRect(3, 3, w - 6, 2);
      g.fillStyle(0xc23c34, 1);
      for (let x = 4; x < w - 5; x += 10) g.fillRect(x, 5, 6, 3);
      g.fillStyle(0x7b8085, 1);
      g.fillRect(4, h - 2, 5, 2);
      g.fillRect(w - 9, h - 2, 5, 2);
    });
  }

  /** Street-race start flag: checkered banner on a pole. */
  private raceFlag(): void {
    const w = 18;
    const h = 26;
    this.stamp(TextureKeys.RaceFlag, w, h, (g) => {
      // Pole.
      g.fillStyle(PALETTE.metalDark, 1);
      g.fillRect(2, 0, 2, h);
      g.fillStyle(PALETTE.chrome, 1);
      g.fillCircle(3, 1.5, 1.5);
      // Checkered banner.
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 4; col++) {
          const dark = (row + col) % 2 === 0;
          g.fillStyle(dark ? PALETTE.outline : 0xffffff, 1);
          g.fillRect(4 + col * 3, 2 + row * 3, 3, 3);
        }
      }
    });
  }

  /** Desert cactus: two-armed saguaro. */
  private cactus(): void {
    const w = 16;
    const h = 22;
    this.stamp(TextureKeys.Cactus, w, h, (g) => {
      const green = 0x3f7a3a;
      g.fillStyle(PALETTE.shadow, 0.2);
      g.fillEllipse(w / 2, h - 2, 10, 4);
      g.fillStyle(shade(green, 0.3), 1);
      g.fillRoundedRect(w / 2 - 3, 2, 6, h - 4, 3);
      g.fillStyle(green, 1);
      g.fillRoundedRect(w / 2 - 2, 3, 4, h - 6, 2);
      // Arms.
      g.fillStyle(green, 1);
      g.fillRoundedRect(1, 7, 4, 3, 1);
      g.fillRoundedRect(1, 4, 3, 6, 1);
      g.fillRoundedRect(w - 5, 10, 4, 3, 1);
      g.fillRoundedRect(w - 4, 7, 3, 6, 1);
      // Spine specks.
      g.fillStyle(tintUp(green, 0.4), 1);
      for (let i = 0; i < 5; i++) {
        g.fillRect(w / 2 - 1 + this.rng.intRange(0, 2), 4 + i * 3, 1, 1);
      }
    });
  }

  /** Mountain boulder: faceted grey rock. */
  private rock(): void {
    const s = 20;
    this.stamp(TextureKeys.Rock, s, s, (g) => {
      g.fillStyle(PALETTE.shadow, 0.2);
      g.fillEllipse(s / 2, s - 3, 14, 5);
      g.fillStyle(shade(PALETTE.rock, 0.35), 1);
      g.fillCircle(s / 2, s / 2, 7.5);
      g.fillStyle(PALETTE.rock, 1);
      g.fillCircle(s / 2 - 1, s / 2 - 1, 6.5);
      // Facets.
      g.fillStyle(tintUp(PALETTE.rock, 0.2), 1);
      g.fillTriangle(4, 8, 10, 4, 9, 9);
      g.fillStyle(shade(PALETTE.rock, 0.2), 1);
      g.fillTriangle(9, 12, 15, 9, 13, 15);
    });
  }

  /** Harbor cargo crate: slatted wooden box. */
  private crate(): void {
    const s = 18;
    this.stamp(TextureKeys.Crate, s, s, (g) => {
      g.fillStyle(PALETTE.outline, 1);
      g.fillRect(0, 0, s, s);
      g.fillStyle(PALETTE.dockWood, 1);
      g.fillRect(1, 1, s - 2, s - 2);
      g.fillStyle(PALETTE.dockWoodDark, 1);
      g.fillRect(1, s / 2 - 1, s - 2, 1);
      g.fillRect(s / 2 - 1, 1, 1, s - 2);
      // Corner braces.
      g.fillStyle(shade(PALETTE.dockWood, 0.35), 1);
      g.fillRect(1, 1, 4, 2);
      g.fillRect(s - 5, 1, 4, 2);
      g.fillRect(1, s - 3, 4, 2);
      g.fillRect(s - 5, s - 3, 4, 2);
    });
  }

  /** Small authored-looking street fixtures used by streamed city decoration. */
  private streetFixtures(): void {
    this.stamp(TextureKeys.Bench, 26, 14, (g) => {
      g.fillStyle(PALETTE.shadow, 0.25);
      g.fillEllipse(13, 12, 22, 4);
      g.fillStyle(0x2c2118, 1);
      g.fillRect(1, 3, 24, 7);
      g.fillStyle(0x805836, 1);
      g.fillRect(2, 3, 22, 5);
      g.fillStyle(0xb7804c, 1);
      g.fillRect(3, 4, 20, 1);
      g.fillStyle(PALETTE.metalDark, 1);
      g.fillRect(4, 10, 2, 4);
      g.fillRect(20, 10, 2, 4);
    });
    this.stamp(TextureKeys.TrashBin, 12, 16, (g) => {
      g.fillStyle(PALETTE.shadow, 0.25);
      g.fillEllipse(6, 14, 10, 3);
      g.fillStyle(0x17232a, 1);
      g.fillRoundedRect(1, 3, 10, 11, 2);
      g.fillStyle(0x3f6870, 1);
      g.fillRoundedRect(2, 4, 8, 9, 1);
      g.fillStyle(0x18242b, 1);
      g.fillRect(0, 2, 12, 2);
      g.fillStyle(0x7ca3a5, 1);
      g.fillRect(3, 5, 1, 6);
    });
    this.stamp(TextureKeys.Mailbox, 14, 16, (g) => {
      g.fillStyle(PALETTE.shadow, 0.22);
      g.fillEllipse(7, 14, 10, 3);
      g.fillStyle(0x1e4279, 1);
      g.fillRoundedRect(1, 3, 12, 8, 3);
      g.fillStyle(0x3975bc, 1);
      g.fillRoundedRect(2, 4, 10, 6, 2);
      g.fillStyle(0xd9e6ef, 0.85);
      g.fillRect(3, 7, 8, 1);
      g.fillStyle(PALETTE.metalDark, 1);
      g.fillRect(6, 11, 2, 5);
    });
    this.stamp(TextureKeys.FireHydrant, 12, 16, (g) => {
      g.fillStyle(PALETTE.shadow, 0.22);
      g.fillEllipse(6, 14, 10, 3);
      g.fillStyle(0x7d1d24, 1);
      g.fillRect(3, 5, 6, 9);
      g.fillCircle(6, 5, 4);
      g.fillStyle(0xe9484e, 1);
      g.fillRect(4, 5, 3, 8);
      g.fillStyle(0xf3c45d, 1);
      g.fillRect(2, 8, 2, 3);
      g.fillRect(8, 8, 2, 3);
      g.fillCircle(6, 3, 1.5);
    });
    this.stamp(TextureKeys.RoadSign, 14, 22, (g) => {
      g.fillStyle(PALETTE.shadow, 0.2);
      g.fillEllipse(7, 20, 6, 2);
      g.fillStyle(PALETTE.metalDark, 1);
      g.fillRect(6, 8, 2, 13);
      g.fillStyle(0xffffff, 1);
      g.fillRoundedRect(1, 1, 12, 8, 1);
      g.fillStyle(0x285ca8, 1);
      g.fillRoundedRect(2, 2, 10, 6, 1);
      g.fillStyle(0xffffff, 1);
      g.fillRect(4, 4, 6, 1);
    });
    this.stamp(TextureKeys.BikeRack, 24, 12, (g) => {
      g.fillStyle(PALETTE.shadow, 0.2);
      g.fillEllipse(12, 10, 22, 3);
      g.lineStyle(2, PALETTE.metalDark, 1);
      for (const x of [4, 10, 16, 22]) {
        g.beginPath();
        g.arc(x, 7, 4, Math.PI, 0, false);
        g.strokePath();
      }
    });
    this.stamp(TextureKeys.CafeTable, 18, 18, (g) => {
      g.fillStyle(PALETTE.shadow, 0.24);
      g.fillEllipse(9, 14, 14, 4);
      g.fillStyle(0x35271e, 1);
      g.fillCircle(9, 7, 7);
      g.fillStyle(0x9b653e, 1);
      g.fillCircle(9, 6, 6);
      g.fillStyle(0xe8c56a, 0.9);
      g.fillRect(8, 2, 2, 7);
      g.fillStyle(PALETTE.metalDark, 1);
      g.fillRect(8, 11, 2, 5);
    });
    this.stamp(TextureKeys.Planter, 18, 16, (g) => {
      g.fillStyle(PALETTE.shadow, 0.22);
      g.fillEllipse(9, 14, 14, 3);
      g.fillStyle(0x4f3629, 1);
      g.fillRoundedRect(2, 8, 14, 6, 2);
      g.fillStyle(0x8a5a3b, 1);
      g.fillRect(3, 9, 12, 3);
      g.fillStyle(0x2e6a3a, 1);
      g.fillCircle(5, 7, 4);
      g.fillCircle(10, 5, 5);
      g.fillCircle(14, 7, 4);
      g.fillStyle(0xffcc66, 1);
      g.fillRect(7, 4, 2, 2);
      g.fillRect(13, 7, 2, 2);
    });
    this.stamp(TextureKeys.UtilityBox, 14, 16, (g) => {
      g.fillStyle(PALETTE.shadow, 0.2);
      g.fillEllipse(7, 14, 11, 3);
      g.fillStyle(0x263442, 1);
      g.fillRoundedRect(1, 2, 12, 12, 1);
      g.fillStyle(0x587181, 1);
      g.fillRect(2, 3, 10, 9);
      g.fillStyle(0xffce54, 1);
      g.fillTriangle(7, 5, 4, 10, 10, 10);
    });
    this.stamp(TextureKeys.ParkingMeter, 10, 20, (g) => {
      g.fillStyle(PALETTE.shadow, 0.18);
      g.fillEllipse(5, 18, 7, 2);
      g.fillStyle(PALETTE.metalDark, 1);
      g.fillRect(4, 8, 2, 11);
      g.fillStyle(0x3c5563, 1);
      g.fillRoundedRect(2, 1, 6, 9, 2);
      g.fillStyle(0xa8d3dc, 1);
      g.fillCircle(5, 4, 1.5);
    });
    this.stamp(TextureKeys.TrafficCone, 10, 14, (g) => {
      g.fillStyle(PALETTE.shadow, 0.2);
      g.fillEllipse(5, 12, 9, 2);
      g.fillStyle(0xd85d27, 1);
      g.fillTriangle(5, 1, 1, 11, 9, 11);
      g.fillStyle(0xffffff, 0.9);
      g.fillRect(3, 7, 4, 2);
      g.fillStyle(0x3a2520, 1);
      g.fillRect(0, 11, 10, 2);
    });
    this.stamp(TextureKeys.ConstructionFence, 26, 18, (g) => {
      g.fillStyle(PALETTE.metalDark, 1);
      g.fillRect(1, 3, 24, 3);
      g.fillRect(1, 12, 24, 3);
      g.fillRect(3, 1, 2, 16);
      g.fillRect(21, 1, 2, 16);
      g.fillStyle(0xf1a92e, 1);
      for (let x = 6; x < 21; x += 7) {
        g.fillRect(x, 6, 4, 6);
      }
    });
    this.stamp(TextureKeys.StreetAd, 16, 24, (g) => {
      g.fillStyle(PALETTE.metalDark, 1);
      g.fillRect(7, 17, 2, 7);
      g.fillStyle(0x171b24, 1);
      g.fillRoundedRect(1, 1, 14, 17, 1);
      g.fillStyle(0xec4899, 1);
      g.fillRect(2, 2, 12, 7);
      g.fillStyle(0x55d9d1, 1);
      g.fillRect(2, 10, 12, 6);
      g.fillStyle(0xffffff, 0.8);
      g.fillRect(4, 4, 7, 1);
      g.fillRect(4, 12, 5, 1);
    });
  }

  /**
   * Draw with a throwaway Graphics object, then stamp it into a texture.
   *
   * @param key    Texture key to register under.
   * @param width  Texture width in pixels.
   * @param height Texture height in pixels.
   * @param draw   Callback that paints into the graphics object.
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

  /**
   * Traffic light: a dark vertical pole topped by a housing holding three
   * stacked dim-grey lamps. Lamps stay neutral so the traffic system can tint
   * the active one at runtime.
   */
  private trafficLight(): void {
    const w = 12;
    const h = 26;
    this.stamp(TextureKeys.TrafficLight, w, h, (g) => {
      const cx = w / 2;

      // Pole.
      g.fillStyle(PALETTE.outline, 1);
      g.fillRect(cx - 1, 14, 2, h - 14);
      g.fillStyle(PALETTE.metalDark, 1);
      g.fillRect(cx - 1, 14, 1, h - 14);

      // Base foot.
      g.fillStyle(shade(PALETTE.metalDark, 0.35), 1);
      g.fillRect(cx - 3, h - 2, 6, 2);

      // Housing.
      const boxW = 8;
      const boxH = 16;
      const boxX = cx - boxW / 2;
      g.fillStyle(PALETTE.outline, 1);
      g.fillRoundedRect(boxX - 1, 0, boxW + 2, boxH + 1, 2);
      g.fillStyle(PALETTE.metalDark, 1);
      g.fillRoundedRect(boxX, 1, boxW, boxH - 1, 2);

      // Three dim lamps (neutral grey; tinted at runtime).
      const lampR = 2;
      const lamp = shade(PALETTE.sidewalkDark, 0.35);
      const lampX = cx;
      for (let i = 0; i < 3; i++) {
        const lampY = 3 + i * 5;
        g.fillStyle(PALETTE.shadow, 1);
        g.fillCircle(lampX, lampY, lampR + 0.5);
        g.fillStyle(lamp, 1);
        g.fillCircle(lampX, lampY, lampR);
      }
    });
  }

  /**
   * Mission marker: an upward chevron in the marker colour with a lighter core,
   * wrapped in a soft semi-transparent glow ring to read as a beacon.
   */
  private missionMarker(): void {
    const s = 22;
    this.stamp(TextureKeys.MissionMarker, s, s, (g) => {
      const cx = s / 2;
      const cy = s / 2;

      // Soft glow ring (two translucent passes).
      g.fillStyle(PALETTE.marker, 0.18);
      g.fillCircle(cx, cy, 10);
      g.fillStyle(PALETTE.marker, 0.28);
      g.fillCircle(cx, cy, 7);

      // Upward chevron body.
      const drawChevron = (top: number, halfW: number, thickness: number, color: number): void => {
        const apexY = top;
        const baseY = top + halfW;
        g.fillStyle(color, 1);
        g.beginPath();
        g.moveTo(cx, apexY);
        g.lineTo(cx + halfW, baseY);
        g.lineTo(cx + halfW - thickness, baseY);
        g.lineTo(cx, apexY + thickness);
        g.lineTo(cx - halfW + thickness, baseY);
        g.lineTo(cx - halfW, baseY);
        g.closePath();
        g.fillPath();
      };

      // Two stacked chevrons pointing up.
      drawChevron(4, 8, 4, PALETTE.marker);
      drawChevron(10, 8, 4, PALETTE.marker);

      // Lighter core highlight on the upper chevron.
      drawChevron(5, 6, 2, tintUp(PALETTE.marker, 0.5));
    });
  }

  /**
   * Pickup: a small crate/coin swatch in the accent colour with a dark outline
   * and a couple of highlight specks to catch the eye on the ground.
   */
  private pickup(): void {
    const s = 14;
    this.stamp(TextureKeys.Pickup, s, s, (g) => {
      // Outlined body.
      g.fillStyle(PALETTE.outline, 1);
      g.fillRoundedRect(1, 1, s - 2, s - 2, 3);
      g.fillStyle(PALETTE.accent, 1);
      g.fillRoundedRect(2, 2, s - 4, s - 4, 2);

      // Crate cross-strapping.
      g.lineStyle(1, shade(PALETTE.accent, 0.35), 1);
      g.beginPath();
      g.moveTo(2, 2);
      g.lineTo(s - 2, s - 2);
      g.moveTo(s - 2, 2);
      g.lineTo(2, s - 2);
      g.strokePath();

      // Top highlight edge.
      g.fillStyle(tintUp(PALETTE.accent, 0.4), 1);
      g.fillRect(3, 3, s - 6, 1);

      // Deterministic sparkle specks.
      g.fillStyle(tintUp(PALETTE.accent, 0.7), 1);
      for (let i = 0; i < 3; i++) {
        const x = this.rng.intRange(3, s - 4);
        const y = this.rng.intRange(3, s - 4);
        g.fillRect(x, y, 1, 1);
      }
    });
  }
}
