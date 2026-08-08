/**
 * Generates crisp, procedural pixel-art textures at runtime.
 *
 * Phase 1 ships no binary art assets, yet the framework must boot and render.
 * This factory draws simple, consistent placeholder swatches (tiles, entities,
 * props, UI chrome) under the canonical {@link TextureKeys}. Phase 2 replaces
 * these by loading real Aseprite/Tiled art under the *same keys*, so no consumer
 * code changes.
 *
 * All randomness is seeded for deterministic, reproducible output.
 */
import Phaser from 'phaser';
import { TextureKeys } from '@/config/AssetKeys';
import { COLORS, TILE_SIZE } from '@/config/Constants';
import { Random } from '@/utils/Random';

export class PlaceholderTextureFactory {
  private readonly rng = new Random(0xc0ffee);

  /** @param scene A live scene whose texture manager receives the textures. */
  constructor(private readonly scene: Phaser.Scene) {}

  /** Generate every placeholder texture. Skips keys already present. */
  public generateAll(): void {
    this.pixel();
    this.particle();
    this.uiPanel();
    this.uiButton();
    this.grass();
    this.road(false);
    this.road(true);
    this.sidewalk();
    this.water();
    this.building();
    this.player();
    this.car();
    this.tree();
    this.streetLight();
    this.logo();
  }

  /** Draw with a throwaway Graphics object, then stamp it into a texture. */
  private stamp(key: TextureKeys, width: number, height: number, draw: (g: Phaser.GameObjects.Graphics) => void): void {
    if (this.scene.textures.exists(key)) return;
    const g = this.scene.make.graphics({ x: 0, y: 0 }, false);
    draw(g);
    g.generateTexture(key, width, height);
    g.destroy();
  }

  /** Scatter small darker/lighter specks to fake pixel-art texture. */
  private speckle(g: Phaser.GameObjects.Graphics, w: number, h: number, tints: number[], count: number): void {
    for (let i = 0; i < count; i++) {
      const color = tints[this.rng.intRange(0, tints.length - 1)] ?? 0xffffff;
      g.fillStyle(color, 1);
      g.fillRect(this.rng.intRange(0, w - 1), this.rng.intRange(0, h - 1), 1, 1);
    }
  }

  private pixel(): void {
    this.stamp(TextureKeys.Pixel, 1, 1, (g) => {
      g.fillStyle(0xffffff, 1);
      g.fillRect(0, 0, 1, 1);
    });
  }

  private particle(): void {
    const r = 8;
    this.stamp(TextureKeys.Particle, r * 2, r * 2, (g) => {
      g.fillStyle(0xffffff, 1);
      g.fillCircle(r, r, r);
      g.fillStyle(0xffffff, 0.4);
      g.fillCircle(r, r, r);
    });
  }

  private uiPanel(): void {
    const s = 16;
    this.stamp(TextureKeys.UIPanel, s, s, (g) => {
      g.fillStyle(COLORS.UI_PANEL, 1);
      g.fillRect(0, 0, s, s);
      g.lineStyle(2, COLORS.UI_BORDER, 1);
      g.strokeRect(1, 1, s - 2, s - 2);
    });
  }

  private uiButton(): void {
    const w = 32;
    const h = 16;
    this.stamp(TextureKeys.UIButton, w, h, (g) => {
      g.fillStyle(COLORS.UI_BORDER, 1);
      g.fillRect(0, 0, w, h);
      g.fillStyle(COLORS.UI_PANEL, 1);
      g.fillRect(1, 1, w - 2, h - 2);
    });
  }

  private grass(): void {
    this.stamp(TextureKeys.TileGrass, TILE_SIZE, TILE_SIZE, (g) => {
      g.fillStyle(COLORS.GRASS, 1);
      g.fillRect(0, 0, TILE_SIZE, TILE_SIZE);
      this.speckle(g, TILE_SIZE, TILE_SIZE, [0x264d2b, 0x3a7040], 40);
    });
  }

  private road(withLine: boolean): void {
    const key = withLine ? TextureKeys.TileRoadLine : TextureKeys.TileRoad;
    this.stamp(key, TILE_SIZE, TILE_SIZE, (g) => {
      g.fillStyle(COLORS.ROAD, 1);
      g.fillRect(0, 0, TILE_SIZE, TILE_SIZE);
      this.speckle(g, TILE_SIZE, TILE_SIZE, [0x2f2f36, 0x45454e], 24);
      if (withLine) {
        g.fillStyle(COLORS.ROAD_LINE, 1);
        g.fillRect(TILE_SIZE / 2 - 2, 4, 4, TILE_SIZE - 8);
      }
    });
  }

  private sidewalk(): void {
    this.stamp(TextureKeys.TileSidewalk, TILE_SIZE, TILE_SIZE, (g) => {
      g.fillStyle(COLORS.SIDEWALK, 1);
      g.fillRect(0, 0, TILE_SIZE, TILE_SIZE);
      g.lineStyle(1, 0x7c8288, 1);
      g.strokeRect(0, 0, TILE_SIZE, TILE_SIZE);
      g.beginPath();
      g.moveTo(TILE_SIZE / 2, 0);
      g.lineTo(TILE_SIZE / 2, TILE_SIZE);
      g.strokePath();
    });
  }

  private water(): void {
    this.stamp(TextureKeys.TileWater, TILE_SIZE, TILE_SIZE, (g) => {
      g.fillStyle(COLORS.WATER, 1);
      g.fillRect(0, 0, TILE_SIZE, TILE_SIZE);
      g.fillStyle(0x3f86a6, 0.6);
      for (let y = 4; y < TILE_SIZE; y += 10) {
        g.fillRect(2, y, TILE_SIZE - 4, 2);
      }
    });
  }

  private building(): void {
    this.stamp(TextureKeys.TileBuilding, TILE_SIZE, TILE_SIZE, (g) => {
      g.fillStyle(COLORS.BUILDING, 1);
      g.fillRect(0, 0, TILE_SIZE, TILE_SIZE);
      g.lineStyle(1, 0x4c4f58, 1);
      g.strokeRect(0, 0, TILE_SIZE, TILE_SIZE);
      // Window grid.
      g.fillStyle(0xb9c4d0, 0.9);
      for (let y = 5; y < TILE_SIZE - 4; y += 9) {
        for (let x = 5; x < TILE_SIZE - 4; x += 9) {
          g.fillRect(x, y, 4, 5);
        }
      }
    });
  }

  private player(): void {
    const s = 24;
    this.stamp(TextureKeys.Player, s, s, (g) => {
      // Body (top-down): torso circle + facing notch pointing "up".
      g.fillStyle(0x2b3a67, 1);
      g.fillCircle(s / 2, s / 2, 8);
      g.fillStyle(0xe8b98a, 1); // head/skin
      g.fillCircle(s / 2, s / 2 - 2, 5);
      g.fillStyle(COLORS.ACCENT, 1); // facing indicator
      g.fillRect(s / 2 - 1, 2, 2, 5);
    });
  }

  private car(): void {
    const w = 48;
    const h = 24;
    this.stamp(TextureKeys.Car, w, h, (g) => {
      g.fillStyle(0xc23b3b, 1);
      g.fillRoundedRect(0, 2, w, h - 4, 5);
      g.fillStyle(0x1c1c24, 1); // windshield/roof
      g.fillRoundedRect(w * 0.55, 5, w * 0.3, h - 10, 3);
      g.fillStyle(0x101014, 1); // wheels
      g.fillRect(6, 0, 8, 3);
      g.fillRect(6, h - 3, 8, 3);
      g.fillRect(w - 16, 0, 8, 3);
      g.fillRect(w - 16, h - 3, 8, 3);
    });
  }

  private tree(): void {
    const w = 30;
    const h = 34;
    this.stamp(TextureKeys.Tree, w, h, (g) => {
      // Shared south-east shadow direction used by buildings, people and props.
      g.fillStyle(0x000000, 0.26);
      g.fillEllipse(18, 28, 23, 8);
      g.fillStyle(0x493425, 1);
      g.fillRect(13, 20, 4, 12);
      g.fillStyle(0x755337, 1);
      g.fillRect(13, 20, 2, 10);
      // Block-cluster foliage keeps the silhouette crisp at 2x-4x zoom.
      g.fillStyle(0x214b33, 1);
      g.fillCircle(7, 15, 7);
      g.fillCircle(15, 10, 10);
      g.fillCircle(23, 15, 7);
      g.fillStyle(0x39724a, 1);
      g.fillRect(5, 10, 7, 6);
      g.fillRect(12, 4, 8, 7);
      g.fillRect(19, 11, 6, 5);
      g.fillStyle(0x76a263, 1);
      g.fillRect(8, 9, 3, 2);
      g.fillRect(16, 5, 3, 2);
    });
  }

  private streetLight(): void {
    const w = 12;
    const h = 30;
    this.stamp(TextureKeys.StreetLight, w, h, (g) => {
      g.fillStyle(0x000000, 0.22);
      g.fillEllipse(8, 28, 8, 2);
      g.fillStyle(0x20262c, 1);
      g.fillRect(5, 7, 3, 21);
      g.fillStyle(0x697177, 1);
      g.fillRect(5, 8, 1, 18);
      g.fillStyle(0x20262c, 1);
      g.fillRect(2, 4, 8, 4);
      g.fillStyle(0xffd17d, 1);
      g.fillRect(3, 2, 6, 4);
      g.fillStyle(0xffedbd, 1);
      g.fillRect(4, 2, 3, 2);
      g.fillStyle(0x1a1e23, 1);
      g.fillRect(3, 0, 6, 2);
      g.fillRect(2, 27, 8, 2);
    });
  }

  private logo(): void {
    const w = 96;
    const h = 32;
    this.stamp(TextureKeys.Logo, w, h, (g) => {
      g.fillStyle(COLORS.ACCENT, 1);
      g.fillRoundedRect(0, 0, w, h, 4);
      g.fillStyle(COLORS.BACKGROUND, 1);
      g.fillRoundedRect(2, 2, w - 4, h - 4, 3);
      g.fillStyle(COLORS.ACCENT, 1);
      g.fillRect(6, h / 2 - 2, w - 12, 4);
    });
  }
}
