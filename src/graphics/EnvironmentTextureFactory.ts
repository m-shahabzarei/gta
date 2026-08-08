/**
 * Handcrafted environment modules used by the streamed world art pass.
 *
 * These textures deliberately sit above the collision tiles instead of
 * replacing them.  That keeps navigation, driving, entrances and services
 * byte-for-byte compatible while giving each city a distinct architectural
 * and material language.  All shapes land on the native pixel grid.
 */
import Phaser from 'phaser';
import { TextureKeys } from '@/config/AssetKeys';
import { PALETTE, shade } from '@/graphics/palette';

type Painter = (g: Phaser.GameObjects.Graphics) => void;

export class EnvironmentTextureFactory {
  constructor(private readonly scene: Phaser.Scene) {}

  public generateAll(): void {
    this.roofs();
    this.surfaceDecals();
    this.foliage();
    this.streetAndRoofDetails();
  }

  private stamp(key: TextureKeys, width: number, height: number, draw: Painter): void {
    if (this.scene.textures.exists(key)) return;
    const g = this.scene.make.graphics({ x: 0, y: 0 }, false);
    draw(g);
    g.generateTexture(key, width, height);
    g.destroy();
  }

  /** A slightly angled roof slab with a shared south-east cast shadow. */
  private roofSlab(
    g: Phaser.GameObjects.Graphics,
    base: number,
    edge: number,
    trim: number,
  ): void {
    g.fillStyle(PALETTE.shadow, 0.3);
    g.fillRect(4, 5, 27, 26);
    g.fillStyle(edge, 1);
    g.fillRect(1, 1, 29, 28);
    g.fillStyle(base, 1);
    g.fillRect(2, 2, 26, 25);
    g.fillStyle(trim, 1);
    g.fillRect(2, 2, 26, 2);
    g.fillRect(2, 4, 2, 23);
    g.fillStyle(shade(base, 0.22), 1);
    g.fillRect(4, 25, 24, 2);
    g.fillRect(26, 4, 2, 21);
  }

  private roofs(): void {
    this.stamp(TextureKeys.RoofModernA, 32, 32, (g) => {
      const base = 0x667380;
      this.roofSlab(g, base, 0x303a43, 0x9aa7b0);
      // Raised glass atrium.
      g.fillStyle(0x2a3c48, 1);
      g.fillRect(7, 7, 15, 11);
      g.fillStyle(0x4f7685, 1);
      g.fillRect(8, 8, 13, 8);
      g.fillStyle(0x8db6bd, 1);
      g.fillRect(9, 8, 5, 1);
      g.fillRect(8, 9, 1, 5);
      g.fillStyle(0x27343d, 1);
      g.fillRect(14, 8, 1, 8);
      g.fillRect(8, 12, 13, 1);
      // Roof plant and access hatch.
      g.fillStyle(0x353f47, 1);
      g.fillRect(20, 20, 5, 4);
      g.fillStyle(0x77848c, 1);
      g.fillRect(21, 20, 3, 1);
      g.fillStyle(0xb88045, 1);
      g.fillRect(6, 21, 7, 2);
    });

    this.stamp(TextureKeys.RoofModernB, 32, 32, (g) => {
      const base = 0x7b858d;
      this.roofSlab(g, base, 0x343b43, 0xb2bac0);
      // Solar panel pair.
      for (const x of [6, 16]) {
        g.fillStyle(0x192a38, 1);
        g.fillRect(x, 7, 8, 7);
        g.fillStyle(0x365d70, 1);
        g.fillRect(x + 1, 8, 6, 5);
        g.fillStyle(0x7194a0, 1);
        g.fillRect(x + 1, 8, 6, 1);
        g.fillStyle(0x18242c, 1);
        g.fillRect(x + 4, 8, 1, 5);
      }
      // Mechanical deck with ducting.
      g.fillStyle(0x414c55, 1);
      g.fillRect(6, 19, 13, 5);
      g.fillStyle(0x8f9aa0, 1);
      g.fillRect(7, 20, 8, 2);
      g.fillStyle(0x2e373d, 1);
      g.fillRect(18, 20, 6, 2);
      g.fillRect(22, 20, 2, 5);
    });

    this.stamp(TextureKeys.RoofResidential, 32, 32, (g) => {
      const base = 0xa98068;
      this.roofSlab(g, base, 0x59483f, 0xc6a98f);
      // Warm tile rows with staggered repairs.
      g.fillStyle(0x805f4e, 1);
      for (let y = 7; y < 25; y += 5) g.fillRect(4, y, 22, 1);
      g.fillStyle(0xbc9275, 1);
      g.fillRect(6, 5, 8, 2);
      g.fillRect(17, 16, 7, 2);
      // Water tank and short clothes line.
      g.fillStyle(0x384e56, 1);
      g.fillRoundedRect(18, 6, 7, 6, 2);
      g.fillStyle(0x6f8c90, 1);
      g.fillRect(19, 7, 5, 1);
      g.fillStyle(0x493b34, 1);
      g.fillRect(7, 18, 1, 6);
      g.fillRect(14, 18, 1, 6);
      g.fillRect(8, 19, 6, 1);
      g.fillStyle(0xd8c06b, 1);
      g.fillRect(9, 20, 2, 3);
      g.fillStyle(0x5e7895, 1);
      g.fillRect(12, 20, 2, 2);
    });

    this.stamp(TextureKeys.RoofLuxury, 32, 32, (g) => {
      const base = 0xb7b29d;
      this.roofSlab(g, base, 0x4e534f, 0xe2ddc8);
      // Roof garden and small reflecting pool.
      g.fillStyle(0x44634b, 1);
      g.fillRect(5, 6, 8, 16);
      g.fillStyle(0x6f8d62, 1);
      g.fillRect(6, 7, 6, 14);
      g.fillStyle(0x9bc179, 1);
      g.fillRect(7, 8, 2, 4);
      g.fillRect(9, 15, 2, 4);
      g.fillStyle(0x315e72, 1);
      g.fillRect(16, 7, 8, 12);
      g.fillStyle(0x62a2ae, 1);
      g.fillRect(17, 8, 6, 9);
      g.fillStyle(0xb7d7d4, 1);
      g.fillRect(18, 9, 4, 1);
      // Pergola slats.
      g.fillStyle(0x6d5039, 1);
      for (let x = 15; x < 25; x += 3) g.fillRect(x, 22, 2, 3);
    });

    this.stamp(TextureKeys.RoofCivic, 32, 32, (g) => {
      const base = 0x88929a;
      this.roofSlab(g, base, 0x384149, 0xc7d0d3);
      // Formal central skylight with symmetrical service blocks.
      g.fillStyle(0x304856, 1);
      g.fillRect(9, 7, 12, 12);
      g.fillStyle(0x5f8994, 1);
      g.fillRect(10, 8, 10, 9);
      g.fillStyle(0xb1d0d1, 1);
      g.fillRect(11, 8, 7, 1);
      g.fillStyle(0x2b3a42, 1);
      g.fillRect(14, 8, 1, 9);
      g.fillRect(10, 12, 10, 1);
      g.fillStyle(0x59636a, 1);
      g.fillRect(5, 21, 6, 3);
      g.fillRect(19, 21, 6, 3);
      g.fillStyle(0xb8c2c6, 1);
      g.fillRect(6, 21, 4, 1);
      g.fillRect(20, 21, 4, 1);
    });

    this.stamp(TextureKeys.RoofIndustrial, 32, 32, (g) => {
      const base = 0x56616a;
      this.roofSlab(g, base, 0x293039, 0x7e8a90);
      // Broad corrugated roof bands.
      for (let x = 5; x < 27; x += 4) {
        g.fillStyle(x % 8 === 1 ? 0x66727a : 0x46525b, 1);
        g.fillRect(x, 5, 2, 19);
      }
      // Rust and extractor vents.
      g.fillStyle(0x8b5940, 1);
      g.fillRect(7, 11, 5, 2);
      g.fillRect(18, 20, 6, 2);
      for (const x of [9, 21]) {
        g.fillStyle(0x263038, 1);
        g.fillCircle(x, 7, 3);
        g.fillStyle(0x94a0a3, 1);
        g.fillCircle(x - 1, 6, 1);
      }
    });

    this.stamp(TextureKeys.RoofAdobeA, 32, 32, (g) => {
      const base = 0xc78d58;
      this.roofSlab(g, base, 0x70472f, 0xe0ad72);
      // Uneven mud-brick patches and a windcatcher.
      g.fillStyle(0xac7047, 1);
      g.fillRect(5, 6, 7, 2);
      g.fillRect(18, 20, 7, 2);
      g.fillRect(6, 23, 5, 1);
      g.fillStyle(0x6d4936, 1);
      g.fillRect(16, 6, 8, 10);
      g.fillStyle(0xd5a06b, 1);
      g.fillRect(17, 7, 6, 8);
      g.fillStyle(0x775039, 1);
      g.fillRect(19, 7, 1, 8);
      g.fillRect(17, 10, 6, 1);
    });

    this.stamp(TextureKeys.RoofAdobeB, 32, 32, (g) => {
      const base = 0xb97f50;
      this.roofSlab(g, base, 0x68432f, 0xd9a06b);
      // Courtyard void, woven shade, jars.
      g.fillStyle(0x684735, 1);
      g.fillRect(8, 7, 14, 12);
      g.fillStyle(0x8e6244, 1);
      g.fillRect(9, 8, 12, 10);
      g.fillStyle(0xd2ae70, 1);
      for (let x = 9; x < 22; x += 3) g.fillRect(x, 8, 1, 10);
      g.fillStyle(0x6d3828, 1);
      g.fillCircle(7, 22, 2);
      g.fillCircle(12, 23, 2);
      g.fillStyle(0xc89358, 1);
      g.fillRect(6, 20, 2, 1);
      g.fillRect(11, 21, 2, 1);
    });

    this.stamp(TextureKeys.RoofWoodA, 32, 32, (g) => {
      // Gilan pitched red-brown roof viewed from above.
      g.fillStyle(PALETTE.shadow, 0.28);
      g.fillRect(4, 6, 27, 24);
      g.fillStyle(0x44362e, 1);
      g.fillRect(1, 3, 29, 25);
      g.fillStyle(0x8f513c, 1);
      g.fillRect(2, 4, 26, 22);
      g.fillStyle(0xbd7654, 1);
      g.fillRect(3, 4, 12, 21);
      g.fillStyle(0x5f3d34, 1);
      g.fillRect(15, 4, 2, 22);
      for (let y = 8; y < 25; y += 5) {
        g.fillStyle(0x6e4235, 1);
        g.fillRect(3, y, 24, 1);
      }
      g.fillStyle(0x3d4737, 1);
      g.fillRect(23, 18, 4, 6);
    });

    this.stamp(TextureKeys.RoofWoodB, 32, 32, (g) => {
      g.fillStyle(PALETTE.shadow, 0.3);
      g.fillRect(5, 5, 25, 26);
      g.fillStyle(0x34423a, 1);
      g.fillRect(2, 2, 27, 27);
      g.fillStyle(0x56705b, 1);
      g.fillRect(3, 3, 24, 24);
      g.fillStyle(0x789273, 1);
      g.fillRect(4, 3, 10, 23);
      g.fillStyle(0x354b3d, 1);
      g.fillRect(14, 3, 2, 24);
      for (let y = 7; y < 27; y += 4) {
        g.fillStyle(0x445d4b, 1);
        g.fillRect(4, y, 22, 1);
      }
      // Moss blooms.
      g.fillStyle(0x728b4f, 1);
      g.fillRect(6, 9, 4, 3);
      g.fillRect(19, 18, 5, 3);
    });

    this.stamp(TextureKeys.RoofBazaar, 32, 32, (g) => {
      const base = 0xb37b4e;
      this.roofSlab(g, base, 0x63432e, 0xd6a16c);
      // Patchwork fabric shades over a central lane.
      const cloth = [0x9e3e45, 0xd29b45, 0x3b7a73, 0x6c5c91];
      for (let row = 0; row < 2; row++) {
        for (let col = 0; col < 3; col++) {
          g.fillStyle(cloth[row * 2 + (col % 2)] ?? 0x9e3e45, 1);
          g.fillRect(5 + col * 7, 7 + row * 8, 6, 7);
          g.fillStyle(0xe2bd83, 0.65);
          g.fillRect(6 + col * 7, 8 + row * 8, 4, 1);
        }
      }
      g.fillStyle(0x5d3d2d, 1);
      g.fillRect(14, 5, 2, 20);
    });
  }

  private surfaceDecals(): void {
    this.stamp(TextureKeys.RoadCrack, 20, 20, (g) => {
      g.lineStyle(1, 0x17191d, 0.8);
      g.beginPath();
      g.moveTo(2, 4);
      g.lineTo(8, 8);
      g.lineTo(6, 13);
      g.lineTo(13, 17);
      g.lineTo(17, 15);
      g.moveTo(8, 8);
      g.lineTo(14, 6);
      g.moveTo(6, 13);
      g.lineTo(2, 16);
      g.strokePath();
      g.fillStyle(0x64636a, 0.45);
      g.fillRect(8, 7, 3, 1);
    });

    this.stamp(TextureKeys.RoadPatch, 28, 20, (g) => {
      g.fillStyle(0x252a2d, 0.78);
      g.fillRect(2, 3, 23, 14);
      g.fillRect(0, 7, 2, 7);
      g.fillRect(25, 5, 2, 10);
      g.fillStyle(0x4a4b4e, 0.65);
      g.fillRect(3, 4, 20, 1);
      g.fillRect(4, 15, 17, 1);
      g.fillStyle(0x17191c, 0.6);
      g.fillRect(7, 8, 1, 5);
      g.fillRect(18, 6, 1, 7);
    });

    this.stamp(TextureKeys.OilStain, 20, 14, (g) => {
      g.fillStyle(0x11151a, 0.35);
      g.fillEllipse(10, 8, 18, 10);
      g.fillStyle(0x1b2225, 0.5);
      g.fillEllipse(7, 6, 9, 6);
      g.fillStyle(0x47514f, 0.35);
      g.fillRect(5, 5, 5, 1);
    });

    this.stamp(TextureKeys.Manhole, 16, 16, (g) => {
      g.fillStyle(0x171a1c, 0.45);
      g.fillEllipse(8, 9, 14, 10);
      g.fillStyle(0x2e3335, 1);
      g.fillCircle(8, 7, 6);
      g.lineStyle(1, 0x65696a, 0.9);
      g.strokeCircle(8, 7, 5);
      g.fillStyle(0x171a1c, 0.8);
      for (let y = 4; y < 11; y += 3) g.fillRect(5, y, 6, 1);
    });

    this.stamp(TextureKeys.StormDrain, 18, 10, (g) => {
      g.fillStyle(0x181b1d, 0.45);
      g.fillRect(1, 3, 16, 6);
      g.fillStyle(0x33383a, 1);
      g.fillRect(1, 1, 16, 6);
      g.fillStyle(0x151819, 1);
      for (let x = 3; x < 17; x += 3) g.fillRect(x, 2, 1, 4);
      g.fillStyle(0x727777, 0.65);
      g.fillRect(2, 1, 14, 1);
    });

    this.stamp(TextureKeys.RoadArrow, 18, 26, (g) => {
      g.fillStyle(0xe7e1c8, 0.75);
      g.fillRect(7, 9, 4, 15);
      g.fillTriangle(9, 1, 2, 11, 16, 11);
      g.fillStyle(0xbab7a8, 0.45);
      g.fillRect(8, 13, 1, 5);
      g.fillRect(5, 8, 2, 1);
    });

    this.stamp(TextureKeys.SpeedBump, 30, 12, (g) => {
      g.fillStyle(0x17191c, 0.35);
      g.fillRect(1, 5, 28, 6);
      for (let x = 1; x < 29; x += 6) {
        g.fillStyle(x % 12 === 1 ? 0xd6a82f : 0xd8d3bd, 0.9);
        g.fillRect(x, 3, 6, 5);
      }
      g.fillStyle(0x191b1d, 0.6);
      g.fillRect(1, 8, 28, 2);
    });

    this.stamp(TextureKeys.PavementCrack, 18, 16, (g) => {
      g.lineStyle(1, 0x555a5c, 0.72);
      g.beginPath();
      g.moveTo(1, 3);
      g.lineTo(7, 5);
      g.lineTo(9, 10);
      g.lineTo(16, 13);
      g.moveTo(7, 5);
      g.lineTo(13, 2);
      g.moveTo(9, 10);
      g.lineTo(4, 14);
      g.strokePath();
    });

    this.stamp(TextureKeys.Puddle, 24, 14, (g) => {
      g.fillStyle(0x244e61, 0.45);
      g.fillEllipse(12, 8, 22, 10);
      g.fillStyle(0x6aa0ad, 0.5);
      g.fillRect(5, 5, 10, 1);
      g.fillRect(10, 9, 8, 1);
      g.fillStyle(0xb9d1d2, 0.35);
      g.fillRect(7, 4, 5, 1);
    });

    this.stamp(TextureKeys.FallenLeaves, 20, 16, (g) => {
      const colors = [0x9b6540, 0xc0883f, 0x7c733d, 0xd0a64f];
      const pixels: readonly (readonly [number, number])[] = [
        [2, 7], [5, 3], [7, 10], [10, 5], [12, 12], [15, 7], [17, 3], [4, 13], [14, 2],
      ];
      pixels.forEach(([x, y], i) => {
        g.fillStyle(colors[i % colors.length] ?? 0x9b6540, 0.9);
        g.fillRect(x, y, i % 3 === 0 ? 3 : 2, 2);
      });
    });
  }

  private foliage(): void {
    this.stamp(TextureKeys.GrassTuft, 14, 12, (g) => {
      g.fillStyle(0x193c29, 0.32);
      g.fillEllipse(7, 10, 12, 3);
      g.lineStyle(2, 0x3c7a4c, 1);
      for (const x of [3, 6, 9, 12]) {
        g.beginPath();
        g.moveTo(x, 10);
        g.lineTo(x + (x % 2 === 0 ? 2 : -1), 3 + (x % 3));
        g.strokePath();
      }
      g.fillStyle(0x79a65d, 1);
      g.fillRect(6, 4, 1, 3);
    });

    this.stamp(TextureKeys.FlowerPatch, 20, 14, (g) => {
      g.fillStyle(0x204a31, 0.32);
      g.fillEllipse(10, 11, 18, 4);
      const flowers = [0xf0bd5b, 0xe47a92, 0xf3e0c2, 0x8ab7d3];
      for (let i = 0; i < 8; i++) {
        const x = 2 + ((i * 7) % 16);
        const y = 3 + ((i * 5) % 7);
        g.fillStyle(0x397149, 1);
        g.fillRect(x, y + 1, 1, 5);
        g.fillStyle(flowers[i % flowers.length] ?? 0xf0bd5b, 1);
        g.fillRect(x - 1, y, 3, 2);
      }
    });

    this.stamp(TextureKeys.Bush, 24, 20, (g) => {
      g.fillStyle(PALETTE.shadow, 0.24);
      g.fillEllipse(13, 17, 20, 5);
      g.fillStyle(0x1e4930, 1);
      g.fillCircle(6, 11, 6);
      g.fillCircle(12, 8, 8);
      g.fillCircle(19, 11, 6);
      g.fillStyle(0x3f7950, 1);
      g.fillRect(5, 7, 5, 4);
      g.fillRect(11, 3, 6, 5);
      g.fillRect(16, 8, 4, 3);
      g.fillStyle(0x6d9b61, 1);
      g.fillRect(8, 6, 2, 2);
      g.fillRect(15, 5, 2, 2);
    });

    this.stamp(TextureKeys.TreePlane, 30, 34, (g) => {
      g.fillStyle(PALETTE.shadow, 0.27);
      g.fillEllipse(18, 27, 23, 9);
      g.fillStyle(0x4b3829, 1);
      g.fillRect(13, 19, 4, 13);
      g.fillStyle(0x6d5032, 1);
      g.fillRect(13, 19, 2, 11);
      g.fillStyle(0x234f35, 1);
      g.fillCircle(8, 14, 7);
      g.fillCircle(15, 10, 10);
      g.fillCircle(23, 15, 7);
      g.fillStyle(0x39724a, 1);
      g.fillRect(5, 9, 7, 6);
      g.fillRect(12, 3, 8, 7);
      g.fillRect(19, 11, 6, 5);
      g.fillStyle(0x71a267, 1);
      g.fillRect(9, 8, 3, 2);
      g.fillRect(16, 5, 3, 2);
    });

    this.stamp(TextureKeys.TreeCypress, 20, 38, (g) => {
      g.fillStyle(PALETTE.shadow, 0.25);
      g.fillEllipse(12, 34, 15, 5);
      g.fillStyle(0x4c3827, 1);
      g.fillRect(9, 28, 3, 8);
      g.fillStyle(0x153f2f, 1);
      g.fillTriangle(10, 1, 2, 31, 18, 31);
      g.fillStyle(0x286047, 1);
      g.fillTriangle(9, 4, 5, 25, 12, 25);
      g.fillStyle(0x4b8260, 1);
      g.fillRect(8, 7, 2, 15);
    });

    this.stamp(TextureKeys.TreePalm, 34, 38, (g) => {
      g.fillStyle(PALETTE.shadow, 0.24);
      g.fillEllipse(20, 33, 22, 6);
      g.fillStyle(0x765139, 1);
      g.fillRect(16, 13, 4, 23);
      g.fillStyle(0xb18753, 1);
      for (let y = 15; y < 34; y += 5) g.fillRect(16, y, 3, 2);
      g.fillStyle(0x285c3d, 1);
      g.fillTriangle(17, 13, 1, 5, 14, 15);
      g.fillTriangle(17, 13, 33, 5, 20, 15);
      g.fillTriangle(17, 12, 7, 0, 16, 14);
      g.fillTriangle(18, 12, 27, 0, 19, 14);
      g.fillTriangle(17, 13, 3, 18, 15, 15);
      g.fillTriangle(18, 13, 31, 19, 20, 15);
      g.fillStyle(0x4f8b54, 1);
      g.fillRect(7, 5, 10, 2);
      g.fillRect(18, 5, 9, 2);
    });

    this.stamp(TextureKeys.TreeGilan, 34, 34, (g) => {
      g.fillStyle(PALETTE.shadow, 0.3);
      g.fillEllipse(20, 29, 25, 8);
      g.fillStyle(0x493a2a, 1);
      g.fillRect(15, 20, 4, 12);
      g.fillStyle(0x183f2d, 1);
      g.fillCircle(7, 15, 7);
      g.fillCircle(14, 9, 9);
      g.fillCircle(23, 10, 9);
      g.fillCircle(28, 17, 6);
      g.fillStyle(0x2f6a43, 1);
      g.fillRect(4, 11, 8, 6);
      g.fillRect(11, 4, 8, 7);
      g.fillRect(20, 5, 8, 7);
      g.fillStyle(0x6f9a5d, 1);
      g.fillRect(9, 9, 3, 2);
      g.fillRect(20, 6, 3, 2);
      // Wet specular leaf pixels.
      g.fillStyle(0x9fc08a, 0.9);
      g.fillRect(6, 13, 2, 1);
      g.fillRect(25, 11, 2, 1);
    });
  }

  private streetAndRoofDetails(): void {
    this.stamp(TextureKeys.Pallet, 20, 16, (g) => {
      g.fillStyle(PALETTE.shadow, 0.22);
      g.fillRect(3, 4, 17, 12);
      g.fillStyle(0x6b4a31, 1);
      g.fillRect(1, 2, 17, 12);
      g.fillStyle(0xa17043, 1);
      for (let y = 3; y < 14; y += 4) g.fillRect(2, y, 15, 2);
      g.fillStyle(0x493322, 1);
      g.fillRect(4, 2, 2, 12);
      g.fillRect(13, 2, 2, 12);
    });

    this.stamp(TextureKeys.Barrel, 14, 18, (g) => {
      g.fillStyle(PALETTE.shadow, 0.23);
      g.fillEllipse(8, 16, 12, 4);
      g.fillStyle(0x243b46, 1);
      g.fillRoundedRect(2, 2, 10, 14, 3);
      g.fillStyle(0x467080, 1);
      g.fillRect(3, 4, 8, 9);
      g.fillStyle(0x182a32, 1);
      g.fillRect(2, 5, 10, 2);
      g.fillRect(2, 12, 10, 2);
      g.fillStyle(0x7fa0a5, 1);
      g.fillRect(4, 3, 3, 1);
    });

    this.stamp(TextureKeys.AcUnit, 18, 14, (g) => {
      g.fillStyle(PALETTE.shadow, 0.22);
      g.fillRect(3, 4, 15, 10);
      g.fillStyle(0x39454c, 1);
      g.fillRect(1, 1, 15, 11);
      g.fillStyle(0x7d898c, 1);
      g.fillRect(2, 2, 13, 8);
      g.fillStyle(0x2c353a, 1);
      for (let x = 4; x < 14; x += 3) g.fillRect(x, 3, 1, 6);
      g.fillStyle(0xb0b8b7, 1);
      g.fillRect(3, 2, 9, 1);
    });

    this.stamp(TextureKeys.SatelliteDish, 18, 18, (g) => {
      g.fillStyle(PALETTE.shadow, 0.22);
      g.fillEllipse(11, 15, 12, 3);
      g.fillStyle(0x30383d, 1);
      g.fillRect(8, 9, 2, 7);
      g.fillStyle(0x8e999c, 1);
      g.fillCircle(7, 7, 6);
      g.fillStyle(0xc2c9c8, 1);
      g.fillCircle(5, 5, 4);
      g.fillStyle(0x3b474e, 1);
      g.fillRect(7, 6, 5, 2);
      g.fillCircle(12, 7, 1.5);
    });

    this.stamp(TextureKeys.WaterTank, 18, 20, (g) => {
      g.fillStyle(PALETTE.shadow, 0.22);
      g.fillEllipse(10, 18, 14, 4);
      g.fillStyle(0x25383f, 1);
      g.fillRoundedRect(2, 2, 14, 14, 4);
      g.fillStyle(0x4f7379, 1);
      g.fillRoundedRect(3, 3, 12, 11, 3);
      g.fillStyle(0x82a2a3, 1);
      g.fillRect(5, 4, 6, 2);
      g.fillStyle(0x28363a, 1);
      g.fillRect(4, 15, 2, 4);
      g.fillRect(12, 15, 2, 4);
    });

    this.stamp(TextureKeys.MarketAwning, 28, 18, (g) => {
      g.fillStyle(PALETTE.shadow, 0.2);
      g.fillRect(3, 5, 25, 12);
      const stripes = [0x9d3b43, 0xe5cf9c];
      for (let x = 1; x < 27; x += 5) {
        g.fillStyle(stripes[Math.floor(x / 5) % 2] ?? 0x9d3b43, 1);
        g.fillRect(x, 2, 5, 12);
      }
      g.fillStyle(0x613b32, 1);
      g.fillRect(1, 13, 26, 2);
      for (let x = 1; x < 27; x += 5) g.fillRect(x, 15, 3, 2);
    });

    this.stamp(TextureKeys.Graffiti, 24, 10, (g) => {
      const colors = [0xe05c78, 0x5bc5b9, 0xe2b84f];
      g.lineStyle(2, colors[0] ?? 0xe05c78, 0.85);
      g.beginPath();
      g.moveTo(1, 8);
      g.lineTo(5, 2);
      g.lineTo(8, 8);
      g.lineTo(12, 3);
      g.lineTo(15, 8);
      g.strokePath();
      g.fillStyle(colors[1] ?? 0x5bc5b9, 0.9);
      g.fillRect(9, 1, 7, 2);
      g.fillStyle(colors[2] ?? 0xe2b84f, 0.9);
      g.fillRect(17, 5, 6, 3);
      g.fillRect(20, 2, 2, 3);
    });
  }
}
