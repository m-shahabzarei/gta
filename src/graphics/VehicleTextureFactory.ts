/**
 * Generates the top-down vehicle sprite sheets for gameplay.
 *
 * Every vehicle is drawn facing UP (front toward -Y), matching the engine-wide
 * facing convention: a sprite at rotation 0 points north, and the vehicle
 * systems rotate it to `heading + Math.PI / 2` to face a heading angle.
 *
 * Each sheet holds TWO frames side by side and registers them by name:
 *  - `ok`      — the pristine body;
 *  - `damaged` — the same body with dents, cracks, a shattered windshield and
 *                a smashed headlight (applied by the vehicle entity once its
 *                health drops below the damage threshold).
 *
 * Body dimensions track the {@link VEHICLES} catalogue so the generated
 * textures line up with each vehicle's physics footprint. Tintable kinds are
 * drawn with a LIGHT grey body so a runtime `setTint` yields distinct,
 * saturated car colours while wheels, glass and chrome stay neutral.
 *
 * The factory follows the shared art-factory pattern: it draws into a
 * throwaway {@link Phaser.GameObjects.Graphics}, stamps a texture, registers
 * the frames and destroys the graphics. Nothing is added to the display list,
 * and every speckle uses a seeded {@link Random} so output is deterministic.
 */
import Phaser from 'phaser';
import { TextureKeys } from '@/config/AssetKeys';
import { PALETTE, shade, tintUp } from '@/graphics/palette';
import { Random } from '@/utils/Random';

/** Light neutral body used by tintable kinds so `setTint` reads true. */
const TINTABLE_BODY = 0xd7d7db;

/** Wheel plate dimensions (drawn slightly proud of the body sides). */
const WHEEL_W = 4;
const WHEEL_H = 9;

/** A per-kind painter drawing one frame at the given x offset. */
type VehiclePainter = (g: Phaser.GameObjects.Graphics, ox: number, damaged: boolean) => void;

export class VehicleTextureFactory {
  private readonly rng = new Random(0x5eed_ca7);

  /** @param scene A live scene whose texture manager receives the textures. */
  constructor(private readonly scene: Phaser.Scene) {}

  /** Generate every vehicle sheet. Skips any key already present. */
  public generateAll(): void {
    this.sheet(TextureKeys.VehSedan, 20, 42, (g, ox, d) => this.sedan(g, ox, d));
    this.sheet(TextureKeys.VehTaxi, 20, 42, (g, ox, d) => this.taxi(g, ox, d));
    this.sheet(TextureKeys.VehPolice, 20, 44, (g, ox, d) => this.police(g, ox, d));
    this.sheet(TextureKeys.VehPoliceSuv, 24, 48, (g, ox, d) => this.policeSuv(g, ox, d));
    this.sheet(TextureKeys.VehAmbulance, 24, 50, (g, ox, d) => this.ambulance(g, ox, d));
    this.sheet(TextureKeys.VehFireTruck, 28, 64, (g, ox, d) => this.fireTruck(g, ox, d));
    this.sheet(TextureKeys.VehSports, 20, 40, (g, ox, d) => this.sports(g, ox, d));
    this.sheet(TextureKeys.VehLuxury, 22, 46, (g, ox, d) => this.luxury(g, ox, d));
    this.sheet(TextureKeys.VehClassic, 22, 46, (g, ox, d) => this.classic(g, ox, d));
    this.sheet(TextureKeys.VehMuscle, 22, 44, (g, ox, d) => this.muscle(g, ox, d));
    this.sheet(TextureKeys.VehTruck, 26, 58, (g, ox, d) => this.truck(g, ox, d));
    this.sheet(TextureKeys.VehVan, 24, 50, (g, ox, d) => this.van(g, ox, d));
    this.sheet(TextureKeys.VehPickup, 22, 48, (g, ox, d) => this.pickup(g, ox, d));
    this.sheet(TextureKeys.VehSuv, 24, 46, (g, ox, d) => this.suv(g, ox, d));
    this.sheet(TextureKeys.VehBus, 28, 72, (g, ox, d) => this.bus(g, ox, d));
    this.sheet(TextureKeys.VehMotorcycle, 12, 30, (g, ox, d) => this.motorcycle(g, ox, d));
    this.sheet(TextureKeys.VehScooter, 10, 24, (g, ox, d) => this.scooter(g, ox, d));
    this.sheet(TextureKeys.VehBicycle, 10, 26, (g, ox, d) => this.bicycle(g, ox, d));
    this.sheet(TextureKeys.VehDelivery, 24, 54, (g, ox, d) => this.delivery(g, ox, d));
    this.sheet(TextureKeys.VehConstruction, 30, 60, (g, ox, d) => this.construction(g, ox, d));
    this.helicopter();
  }

  /** Stamp a two-frame (ok/damaged) sheet and register its named frames. */
  private sheet(key: TextureKeys, w: number, h: number, painter: VehiclePainter): void {
    if (this.scene.textures.exists(key)) return;
    const g = this.scene.make.graphics({ x: 0, y: 0 }, false);
    painter(g, 0, false);
    painter(g, w, true);
    g.generateTexture(key, w * 2, h);
    g.destroy();
    const texture = this.scene.textures.get(key);
    texture.add('ok', 0, 0, 0, w, h);
    texture.add('damaged', 0, w, 0, w, h);
  }

  // ── Shared part painters ─────────────────────────────────────────────────────

  /** Four corner wheels just outside the body sides. */
  private wheels(g: Phaser.GameObjects.Graphics, ox: number, w: number, h: number): void {
    // Offset footprint shadow is part of every frame, so parked and moving
    // vehicles share the same light direction as buildings and pedestrians.
    g.fillStyle(PALETTE.shadow, 0.28);
    g.fillRoundedRect(ox + 3, 3, w - 3, h - 2, Math.max(3, Math.round(w * 0.18)));
    const frontY = Math.round(h * 0.16);
    const rearY = Math.round(h * 0.72);
    for (const y of [frontY, rearY]) {
      g.fillStyle(PALETTE.tire, 1);
      g.fillRect(ox, y, WHEEL_W, WHEEL_H);
      g.fillRect(ox + w - WHEEL_W, y, WHEEL_W, WHEEL_H);
      // Hub highlight so wheels read as cylinders, not black blobs.
      g.fillStyle(shade(PALETTE.chrome, 0.55), 1);
      g.fillRect(ox + 1, y + 3, 2, 3);
      g.fillRect(ox + w - 3, y + 3, 2, 3);
      // One-pixel tread breaks up the otherwise rectangular wheel plate.
      g.fillStyle(0x2b2d32, 1);
      g.fillRect(ox, y + 1, 1, 2);
      g.fillRect(ox + w - 1, y + 5, 1, 2);
    }
  }

  /** Outlined body shell with a subtle nose sheen. */
  private shell(
    g: Phaser.GameObjects.Graphics,
    ox: number,
    bx: number,
    bw: number,
    h: number,
    color: number,
    radius: number,
  ): void {
    g.fillStyle(PALETTE.outline, 1);
    g.fillRoundedRect(ox + bx - 1, 0, bw + 2, h, radius + 1);
    g.fillStyle(shade(color, 0.3), 1);
    g.fillRoundedRect(ox + bx, 1, bw, h - 2, radius);
    g.fillStyle(color, 1);
    g.fillRoundedRect(ox + bx + 1, 2, bw - 2, h - 4, Math.max(2, radius - 1));
    // Hood sheen strip near the nose.
    g.fillStyle(tintUp(color, 0.18), 1);
    g.fillRoundedRect(ox + bx + 2, 3, bw - 4, 2, 1);
    // Consistent left highlight / right occlusion planes sell the angled view.
    g.fillStyle(tintUp(color, 0.1), 0.9);
    g.fillRect(ox + bx + 1, 6, 1, Math.max(4, h - 12));
    g.fillStyle(shade(color, 0.32), 0.9);
    g.fillRect(ox + bx + bw - 2, 6, 1, Math.max(4, h - 12));
    // Pixel bumpers occupy the same physical canvas as the body.
    g.fillStyle(PALETTE.metalDark, 0.9);
    g.fillRect(ox + bx + 2, 0, Math.max(2, bw - 4), 1);
    g.fillRect(ox + bx + 2, h - 2, Math.max(2, bw - 4), 1);
  }

  /** Headlights at the nose + red taillights at the tail. */
  private lights(
    g: Phaser.GameObjects.Graphics,
    ox: number,
    bx: number,
    bw: number,
    h: number,
    damaged: boolean,
  ): void {
    const lampW = 3;
    g.fillStyle(tintUp(PALETTE.headlight, 0.1), 1);
    g.fillRect(ox + bx + 1, 1, lampW, 2);
    if (damaged) {
      // One smashed headlight.
      g.fillStyle(PALETTE.outline, 1);
      g.fillRect(ox + bx + bw - 1 - lampW, 1, lampW, 2);
    } else {
      g.fillRect(ox + bx + bw - 1 - lampW, 1, lampW, 2);
    }
    g.fillStyle(PALETTE.brakeLight, 1);
    g.fillRect(ox + bx + 1, h - 3, lampW, 2);
    g.fillRect(ox + bx + bw - 1 - lampW, h - 3, lampW, 2);
    g.fillStyle(PALETTE.indicator, 1);
    g.fillRect(ox + bx, 3, 2, 2);
    g.fillRect(ox + bx + bw - 2, 3, 2, 2);
  }

  /** Windshield (front) and optional rear window with an edge glint. */
  private cabinGlass(
    g: Phaser.GameObjects.Graphics,
    ox: number,
    bx: number,
    bw: number,
    frontY: number,
    frontH: number,
    rearY: number,
    rearH: number,
    damaged: boolean,
  ): void {
    g.fillStyle(PALETTE.glass, 1);
    g.fillRoundedRect(ox + bx + 2, frontY, bw - 4, frontH, 2);
    if (rearH > 0) {
      g.fillRoundedRect(ox + bx + 2, rearY, bw - 4, rearH, 2);
    }
    g.fillStyle(PALETTE.glassLight, 0.8);
    g.fillRect(ox + bx + 3, frontY + 1, bw - 6, 1);
    // Windshield split and diagonal reflected sky pixels.
    g.fillStyle(shade(PALETTE.glass, 0.2), 0.9);
    g.fillRect(ox + bx + Math.floor(bw / 2), frontY, 1, frontH);
    g.fillStyle(tintUp(PALETTE.glassLight, 0.25), 0.75);
    g.fillRect(ox + bx + 3, frontY + 2, Math.max(2, Math.floor(bw / 3)), 1);
    if (rearH > 0) {
      g.fillStyle(PALETTE.glassLight, 0.55);
      g.fillRect(ox + bx + 3, rearY + 1, Math.max(2, Math.floor(bw / 3)), 1);
    }
    if (damaged) {
      // Shattered windshield: pale crack speckle.
      g.fillStyle(tintUp(PALETTE.glassLight, 0.5), 0.9);
      for (let i = 0; i < 7; i++) {
        g.fillRect(
          ox + bx + 3 + this.rng.intRange(0, Math.max(1, bw - 7)),
          frontY + this.rng.intRange(0, Math.max(1, frontH - 1)),
          1,
          1,
        );
      }
    }
  }

  /** Dents, scratches and a crumpled-nose smudge for the damaged frame. */
  private damageOverlay(
    g: Phaser.GameObjects.Graphics,
    ox: number,
    bx: number,
    bw: number,
    h: number,
  ): void {
    // Dented panels: darker blotches along the sides.
    g.fillStyle(PALETTE.shadow, 0.28);
    for (let i = 0; i < 4; i++) {
      const side = i % 2 === 0 ? bx + 1 : bx + bw - 4;
      g.fillRoundedRect(ox + side, this.rng.intRange(6, h - 10), 3, this.rng.intRange(3, 6), 1);
    }
    // Scratches: thin dark streaks.
    g.fillStyle(PALETTE.outline, 0.5);
    for (let i = 0; i < 3; i++) {
      g.fillRect(
        ox + bx + this.rng.intRange(2, Math.max(3, bw - 6)),
        this.rng.intRange(4, h - 8),
        1,
        this.rng.intRange(3, 7),
      );
    }
    // Crumpled nose smudge.
    g.fillStyle(PALETTE.shadow, 0.32);
    g.fillRoundedRect(ox + bx + 2, 2, bw - 4, 3, 1);
    // Exposed metal pixels and a hanging bumper corner.
    g.fillStyle(shade(PALETTE.chrome, 0.28), 0.9);
    g.fillRect(ox + bx + 2, 3, 3, 2);
    g.fillRect(ox + bx + bw - 4, 5, 2, 1);
    g.fillStyle(PALETTE.outline, 0.9);
    g.fillRect(ox + bx + bw - 2, 1, 1, 5);
  }

  /** Faint grime specks for a hand-painted feel. */
  private grime(
    g: Phaser.GameObjects.Graphics,
    ox: number,
    x: number,
    y: number,
    w: number,
    h: number,
  ): void {
    g.fillStyle(PALETTE.shadow, 0.12);
    for (let i = 0; i < 6; i++) {
      g.fillRect(
        ox + x + this.rng.intRange(0, Math.max(0, w - 1)),
        y + this.rng.intRange(0, Math.max(0, h - 1)),
        1,
        1,
      );
    }
  }

  // ── Cars ─────────────────────────────────────────────────────────────────────

  /** Tintable four-door sedan: light body, dark glass, plain roof panel. */
  private sedan(g: Phaser.GameObjects.Graphics, ox: number, damaged: boolean): void {
    const w = 20;
    const h = 42;
    this.wheels(g, ox, w, h);
    const bx = 2;
    const bw = w - 4;
    this.shell(g, ox, bx, bw, h, TINTABLE_BODY, 5);
    this.cabinGlass(g, ox, bx, bw, 6, 7, h - 14, 6, damaged);
    g.fillStyle(shade(TINTABLE_BODY, 0.08), 1);
    g.fillRoundedRect(ox + bx + 2, 14, bw - 4, h - 28, 2);
    // Door seams.
    g.fillStyle(shade(TINTABLE_BODY, 0.35), 1);
    g.fillRect(ox + bx, Math.round(h * 0.42), bw, 1);
    this.grime(g, ox, bx + 2, 14, bw - 4, h - 28);
    this.lights(g, ox, bx, bw, h, damaged);
    if (damaged) this.damageOverlay(g, ox, bx, bw, h);
  }

  /** Yellow taxi: checker band and a roof TAXI sign. */
  private taxi(g: Phaser.GameObjects.Graphics, ox: number, damaged: boolean): void {
    const w = 20;
    const h = 42;
    this.wheels(g, ox, w, h);
    const bx = 2;
    const bw = w - 4;
    this.shell(g, ox, bx, bw, h, PALETTE.accent, 5);
    this.cabinGlass(g, ox, bx, bw, 6, 7, h - 14, 6, damaged);
    g.fillStyle(shade(PALETTE.accent, 0.1), 1);
    g.fillRoundedRect(ox + bx + 2, 14, bw - 4, h - 28, 2);
    // Checker band across the roof panel.
    const cy = Math.round(h * 0.5) - 2;
    for (let cx = bx + 2; cx < bx + bw - 2; cx += 4) {
      const dark = ((cx - bx) / 4) % 2 < 1;
      g.fillStyle(dark ? PALETTE.outline : PALETTE.window, 1);
      g.fillRect(ox + cx, cy, 3, 3);
    }
    // Roof TAXI sign.
    g.fillStyle(PALETTE.window, 1);
    g.fillRect(ox + Math.round(w / 2) - 3, cy + 6, 6, 4);
    g.fillStyle(PALETTE.outline, 1);
    g.fillRect(ox + Math.round(w / 2) - 2, cy + 7, 4, 2);
    this.lights(g, ox, bx, bw, h, damaged);
    if (damaged) this.damageOverlay(g, ox, bx, bw, h);
  }

  /** Police cruiser: white body, black doors, red/blue roof light bar. */
  private police(g: Phaser.GameObjects.Graphics, ox: number, damaged: boolean): void {
    const w = 20;
    const h = 44;
    this.wheels(g, ox, w, h);
    const bx = 2;
    const bw = w - 4;
    this.shell(g, ox, bx, bw, h, tintUp(PALETTE.window, 0.6), 5);
    // Black door panels down each side.
    g.fillStyle(PALETTE.outline, 1);
    g.fillRect(ox + bx + 1, 15, 3, h - 30);
    g.fillRect(ox + bx + bw - 4, 15, 3, h - 30);
    this.cabinGlass(g, ox, bx, bw, 6, 7, h - 14, 6, damaged);
    g.fillStyle(tintUp(PALETTE.window, 0.35), 1);
    g.fillRoundedRect(ox + bx + 2, 14, bw - 4, h - 28, 2);
    // Red/blue light bar across the roof.
    const barY = Math.round(h * 0.5) - 2;
    const half = Math.floor((bw - 4) / 2);
    g.fillStyle(PALETTE.lightRed, 1);
    g.fillRect(ox + bx + 2, barY, half, 4);
    g.fillStyle(0x3a6cff, 1);
    g.fillRect(ox + bx + 2 + half, barY, bw - 4 - half, 4);
    g.fillStyle(PALETTE.outline, 1);
    g.fillRect(ox + Math.round(w / 2) - 1, barY, 2, 4);
    this.lights(g, ox, bx, bw, h, damaged);
    if (damaged) this.damageOverlay(g, ox, bx, bw, h);
  }

  /** SWAT enforcer SUV: black armored box with a white plate + light bar. */
  private policeSuv(g: Phaser.GameObjects.Graphics, ox: number, damaged: boolean): void {
    const w = 24;
    const h = 48;
    this.wheels(g, ox, w, h);
    const bx = 2;
    const bw = w - 4;
    this.shell(g, ox, bx, bw, h, PALETTE.swatArmor, 4);
    this.cabinGlass(g, ox, bx, bw, 7, 7, -1, 0, damaged);
    // Armored boxy roof.
    g.fillStyle(shade(PALETTE.swatArmor, 0.12), 1);
    g.fillRoundedRect(ox + bx + 2, 16, bw - 4, h - 24, 2);
    // White plate on the roof.
    g.fillStyle(PALETTE.window, 1);
    g.fillRect(ox + bx + 3, Math.round(h * 0.55), bw - 6, 4);
    // Light bar.
    const barY = 14;
    const half = Math.floor((bw - 6) / 2);
    g.fillStyle(PALETTE.lightRed, 1);
    g.fillRect(ox + bx + 3, barY, half, 3);
    g.fillStyle(0x3a6cff, 1);
    g.fillRect(ox + bx + 3 + half, barY, bw - 6 - half, 3);
    // Bull bar at the nose.
    g.fillStyle(PALETTE.metalDark, 1);
    g.fillRect(ox + bx, 0, bw, 2);
    this.lights(g, ox, bx, bw, h, damaged);
    if (damaged) this.damageOverlay(g, ox, bx, bw, h);
  }

  /** Ambulance: boxy white body, red cross + stripe, rear doors. */
  private ambulance(g: Phaser.GameObjects.Graphics, ox: number, damaged: boolean): void {
    const w = 24;
    const h = 50;
    this.wheels(g, ox, w, h);
    const bx = 2;
    const bw = w - 4;
    this.shell(g, ox, bx, bw, h, tintUp(PALETTE.window, 0.7), 4);
    this.cabinGlass(g, ox, bx, bw, 6, 8, -1, 0, damaged);
    // Long boxy cargo roof.
    g.fillStyle(tintUp(PALETTE.window, 0.4), 1);
    g.fillRoundedRect(ox + bx + 2, 16, bw - 4, h - 24, 2);
    // Red side stripe.
    g.fillStyle(PALETTE.lightRed, 1);
    g.fillRect(ox + bx + 1, Math.round(h * 0.5) - 1, bw - 2, 3);
    // Red cross on the roof.
    const cx = ox + Math.round(w / 2);
    const cy = Math.round(h * 0.62);
    g.fillStyle(PALETTE.lightRed, 1);
    g.fillRect(cx - 1, cy - 4, 3, 9);
    g.fillRect(cx - 4, cy - 1, 9, 3);
    // Rear door seam.
    g.fillStyle(shade(PALETTE.window, 0.4), 1);
    g.fillRect(cx - 1, h - 8, 1, 6);
    this.grime(g, ox, bx + 2, 16, bw - 4, h - 24);
    this.lights(g, ox, bx, bw, h, damaged);
    if (damaged) this.damageOverlay(g, ox, bx, bw, h);
  }

  /** Fire truck: long red body, ladder down the spine, chrome details. */
  private fireTruck(g: Phaser.GameObjects.Graphics, ox: number, damaged: boolean): void {
    const w = 28;
    const h = 64;
    this.wheels(g, ox, w, h);
    // Extra middle axle for the long chassis.
    g.fillStyle(PALETTE.tire, 1);
    g.fillRect(ox, Math.round(h * 0.46), WHEEL_W, WHEEL_H);
    g.fillRect(ox + w - WHEEL_W, Math.round(h * 0.46), WHEEL_W, WHEEL_H);
    const bx = 2;
    const bw = w - 4;
    const red = 0xc0281e;
    this.shell(g, ox, bx, bw, h, red, 4);
    this.cabinGlass(g, ox, bx, bw, 6, 8, -1, 0, damaged);
    // Cab / body seam + roof deck.
    g.fillStyle(shade(red, 0.18), 1);
    g.fillRoundedRect(ox + bx + 2, 17, bw - 4, h - 24, 2);
    // Silver ladder running down the spine.
    const lx = ox + Math.round(w / 2) - 3;
    g.fillStyle(PALETTE.chrome, 1);
    g.fillRect(lx, 20, 2, h - 28);
    g.fillRect(lx + 5, 20, 2, h - 28);
    g.fillStyle(shade(PALETTE.chrome, 0.25), 1);
    for (let y = 22; y < h - 10; y += 5) {
      g.fillRect(lx + 2, y, 3, 1);
    }
    // Emergency lights on the cab roof.
    g.fillStyle(PALETTE.lightRed, 1);
    g.fillRect(ox + bx + 2, 15, 4, 3);
    g.fillRect(ox + bx + bw - 6, 15, 4, 3);
    this.lights(g, ox, bx, bw, h, damaged);
    if (damaged) this.damageOverlay(g, ox, bx, bw, h);
  }

  /** Tintable sports car: sleek low body, wraparound glass, racing stripe. */
  private sports(g: Phaser.GameObjects.Graphics, ox: number, damaged: boolean): void {
    const w = 20;
    const h = 40;
    this.wheels(g, ox, w, h);
    const bx = 3;
    const bw = w - 6;
    this.shell(g, ox, bx, bw, h, TINTABLE_BODY, 6);
    this.cabinGlass(g, ox, bx, bw, 8, 9, -1, 0, damaged);
    g.fillStyle(shade(TINTABLE_BODY, 0.12), 1);
    g.fillRoundedRect(ox + bx + 2, 18, bw - 4, h - 30, 2);
    // Central racing stripe nose to tail.
    g.fillStyle(shade(TINTABLE_BODY, 0.5), 1);
    g.fillRect(ox + Math.round(w / 2) - 2, 2, 4, h - 4);
    // Rear spoiler.
    g.fillStyle(shade(TINTABLE_BODY, 0.4), 1);
    g.fillRoundedRect(ox + bx - 1, h - 6, bw + 2, 3, 1);
    this.grime(g, ox, bx + 2, 18, bw - 4, h - 30);
    this.lights(g, ox, bx, bw, h, damaged);
    if (damaged) this.damageOverlay(g, ox, bx, bw, h);
  }

  /** Tintable luxury sedan: long hood, low roofline and chrome trim. */
  private luxury(g: Phaser.GameObjects.Graphics, ox: number, damaged: boolean): void {
    const w = 22;
    const h = 46;
    this.wheels(g, ox, w, h);
    const bx = 2;
    const bw = w - 4;
    this.shell(g, ox, bx, bw, h, TINTABLE_BODY, 5);
    this.cabinGlass(g, ox, bx, bw, 7, 8, h - 15, 5, damaged);
    g.fillStyle(shade(TINTABLE_BODY, 0.1), 1);
    g.fillRoundedRect(ox + bx + 2, 16, bw - 4, h - 28, 2);
    // Chrome shoulder line and grille.
    g.fillStyle(PALETTE.chrome, 1);
    g.fillRect(ox + bx + 1, 14, bw - 2, 1);
    g.fillRect(ox + bx + 3, 2, bw - 6, 2);
    g.fillStyle(shade(PALETTE.chrome, 0.35), 1);
    g.fillRect(ox + bx + 2, h - 5, bw - 4, 2);
    this.grime(g, ox, bx + 2, 16, bw - 4, h - 28);
    this.lights(g, ox, bx, bw, h, damaged);
    if (damaged) this.damageOverlay(g, ox, bx, bw, h);
  }

  /** Tintable classic coupe: rounded roof, chromed fins and whitewall feel. */
  private classic(g: Phaser.GameObjects.Graphics, ox: number, damaged: boolean): void {
    const w = 22;
    const h = 46;
    this.wheels(g, ox, w, h);
    const bx = 2;
    const bw = w - 4;
    this.shell(g, ox, bx, bw, h, TINTABLE_BODY, 6);
    this.cabinGlass(g, ox, bx, bw, 6, 8, h - 14, 5, damaged);
    g.fillStyle(shade(TINTABLE_BODY, 0.16), 1);
    g.fillRoundedRect(ox + bx + 2, 14, bw - 4, h - 26, 3);
    // Chrome bumper and tail fins.
    g.fillStyle(PALETTE.chrome, 1);
    g.fillRect(ox + bx + 1, 2, bw - 2, 2);
    g.fillRect(ox + bx + 1, h - 4, bw - 2, 2);
    g.fillStyle(shade(PALETTE.chrome, 0.25), 1);
    g.fillRect(ox + bx, 12, 2, 10);
    g.fillRect(ox + bx + bw - 2, 12, 2, 10);
    this.lights(g, ox, bx, bw, h, damaged);
    if (damaged) this.damageOverlay(g, ox, bx, bw, h);
  }

  /** Tintable muscle car: wide stance, hood scoop, twin trunk stripes. */
  private muscle(g: Phaser.GameObjects.Graphics, ox: number, damaged: boolean): void {
    const w = 22;
    const h = 44;
    this.wheels(g, ox, w, h);
    const bx = 2;
    const bw = w - 4;
    this.shell(g, ox, bx, bw, h, TINTABLE_BODY, 4);
    this.cabinGlass(g, ox, bx, bw, 9, 8, h - 14, 5, damaged);
    // Long hood with a dark scoop.
    g.fillStyle(shade(TINTABLE_BODY, 0.45), 1);
    g.fillRoundedRect(ox + Math.round(w / 2) - 3, 3, 6, 5, 1);
    // Roof.
    g.fillStyle(shade(TINTABLE_BODY, 0.1), 1);
    g.fillRoundedRect(ox + bx + 2, 18, bw - 4, h - 32, 2);
    // Twin stripes over the trunk.
    g.fillStyle(shade(TINTABLE_BODY, 0.5), 1);
    g.fillRect(ox + Math.round(w / 2) - 3, h - 12, 2, 9);
    g.fillRect(ox + Math.round(w / 2) + 1, h - 12, 2, 9);
    this.grime(g, ox, bx + 2, 18, bw - 4, h - 32);
    this.lights(g, ox, bx, bw, h, damaged);
    if (damaged) this.damageOverlay(g, ox, bx, bw, h);
  }

  /** Tintable box truck: long light-grey cargo box with a darker cab. */
  private truck(g: Phaser.GameObjects.Graphics, ox: number, damaged: boolean): void {
    const w = 26;
    const h = 58;
    this.wheels(g, ox, w, h);
    const bx = 2;
    const bw = w - 4;
    this.shell(g, ox, bx, bw, h, TINTABLE_BODY, 3);
    // Darker cab over the front.
    const cabH = Math.round(h * 0.32);
    g.fillStyle(PALETTE.metalDark, 1);
    g.fillRoundedRect(ox + bx + 1, 2, bw - 2, cabH, 3);
    this.cabinGlass(g, ox, bx, bw, 6, 7, -1, 0, damaged);
    // Seam between cab and cargo box.
    g.fillStyle(shade(TINTABLE_BODY, 0.45), 1);
    g.fillRect(ox + bx + 1, cabH + 2, bw - 2, 2);
    // Cargo ribs.
    g.fillStyle(shade(TINTABLE_BODY, 0.14), 1);
    for (let y = cabH + 8; y < h - 5; y += 8) {
      g.fillRect(ox + bx + 3, y, bw - 6, 2);
    }
    this.grime(g, ox, bx + 2, cabH + 4, bw - 4, h - cabH - 8);
    this.lights(g, ox, bx, bw, h, damaged);
    if (damaged) this.damageOverlay(g, ox, bx, bw, h);
  }

  /** Tintable panel van: tall single volume with a sliding-door seam. */
  private van(g: Phaser.GameObjects.Graphics, ox: number, damaged: boolean): void {
    const w = 24;
    const h = 50;
    this.wheels(g, ox, w, h);
    const bx = 2;
    const bw = w - 4;
    this.shell(g, ox, bx, bw, h, TINTABLE_BODY, 4);
    this.cabinGlass(g, ox, bx, bw, 6, 7, -1, 0, damaged);
    // One long roof panel.
    g.fillStyle(shade(TINTABLE_BODY, 0.08), 1);
    g.fillRoundedRect(ox + bx + 2, 15, bw - 4, h - 22, 2);
    // Sliding-door seams.
    g.fillStyle(shade(TINTABLE_BODY, 0.4), 1);
    g.fillRect(ox + bx + bw - 3, 18, 1, 14);
    g.fillRect(ox + bx + 2, 18, 1, 14);
    // Roof ribs.
    g.fillStyle(shade(TINTABLE_BODY, 0.16), 1);
    for (let y = 20; y < h - 8; y += 9) {
      g.fillRect(ox + bx + 4, y, bw - 8, 1);
    }
    this.grime(g, ox, bx + 2, 15, bw - 4, h - 22);
    this.lights(g, ox, bx, bw, h, damaged);
    if (damaged) this.damageOverlay(g, ox, bx, bw, h);
  }

  /** Tintable pickup: cab up front, open cargo bed behind. */
  private pickup(g: Phaser.GameObjects.Graphics, ox: number, damaged: boolean): void {
    const w = 22;
    const h = 48;
    this.wheels(g, ox, w, h);
    const bx = 2;
    const bw = w - 4;
    this.shell(g, ox, bx, bw, h, TINTABLE_BODY, 4);
    this.cabinGlass(g, ox, bx, bw, 6, 7, -1, 0, damaged);
    // Cab roof.
    g.fillStyle(shade(TINTABLE_BODY, 0.1), 1);
    g.fillRoundedRect(ox + bx + 2, 14, bw - 4, 9, 2);
    // Open cargo bed: dark liner with rails.
    const bedY = 26;
    g.fillStyle(PALETTE.metalDark, 1);
    g.fillRoundedRect(ox + bx + 2, bedY, bw - 4, h - bedY - 4, 2);
    g.fillStyle(shade(PALETTE.metalDark, 0.4), 1);
    for (let y = bedY + 3; y < h - 6; y += 5) {
      g.fillRect(ox + bx + 3, y, bw - 6, 1);
    }
    this.lights(g, ox, bx, bw, h, damaged);
    if (damaged) this.damageOverlay(g, ox, bx, bw, h);
  }

  /** Tintable SUV: tall wagon with roof rails and a tail-mounted spare. */
  private suv(g: Phaser.GameObjects.Graphics, ox: number, damaged: boolean): void {
    const w = 24;
    const h = 46;
    this.wheels(g, ox, w, h);
    const bx = 2;
    const bw = w - 4;
    this.shell(g, ox, bx, bw, h, TINTABLE_BODY, 4);
    this.cabinGlass(g, ox, bx, bw, 6, 7, h - 13, 5, damaged);
    // Long roof with rails.
    g.fillStyle(shade(TINTABLE_BODY, 0.08), 1);
    g.fillRoundedRect(ox + bx + 2, 14, bw - 4, h - 28, 2);
    g.fillStyle(shade(TINTABLE_BODY, 0.4), 1);
    g.fillRect(ox + bx + 2, 15, 1, h - 30);
    g.fillRect(ox + bx + bw - 3, 15, 1, h - 30);
    // Tail-mounted spare wheel.
    g.fillStyle(PALETTE.tire, 1);
    g.fillCircle(ox + Math.round(w / 2), h - 5, 3);
    g.fillStyle(shade(PALETTE.chrome, 0.5), 1);
    g.fillCircle(ox + Math.round(w / 2), h - 5, 1);
    this.grime(g, ox, bx + 2, 14, bw - 4, h - 28);
    this.lights(g, ox, bx, bw, h, damaged);
    if (damaged) this.damageOverlay(g, ox, bx, bw, h);
  }

  /** City bus: long livery body, repeated passenger windows, door and three axles. */
  private bus(g: Phaser.GameObjects.Graphics, ox: number, damaged: boolean): void {
    const w = 28;
    const h = 72;
    this.wheels(g, ox, w, h);
    // Middle axle.
    g.fillStyle(PALETTE.tire, 1);
    g.fillRect(ox, Math.round(h * 0.44), WHEEL_W, WHEEL_H);
    g.fillRect(ox + w - WHEEL_W, Math.round(h * 0.44), WHEEL_W, WHEEL_H);
    const bx = 2;
    const bw = w - 4;
    const teal = 0x1f7a8c;
    this.shell(g, ox, bx, bw, h, teal, 3);
    this.cabinGlass(g, ox, bx, bw, 4, 8, h - 12, 5, damaged);
    // Long roof deck framed by the cream body, with a high-contrast route
    // strip so it cannot be mistaken for a sedan at normal gameplay zoom.
    g.fillStyle(0xe9ece9, 1);
    g.fillRoundedRect(ox + bx + 2, 14, bw - 4, h - 27, 2);
    g.fillStyle(shade(teal, 0.1), 1);
    g.fillRoundedRect(ox + bx + 3, 17, bw - 6, h - 33, 2);
    g.fillStyle(0xf4c85a, 1);
    g.fillRect(ox + bx + 1, 13, bw - 2, 3);
    g.fillStyle(0x16303d, 1);
    g.fillRect(ox + bx + 5, 8, bw - 10, 3);
    g.fillStyle(0xe6f6ff, 0.9);
    g.fillRect(ox + bx + 7, 9, bw - 14, 1);

    // Repeated passenger windows create a clear bus silhouette in the
    // top-down view. They sit on both side walls, not in a generic car cabin.
    for (const y of [19, 28, 37, 46]) {
      g.fillStyle(PALETTE.glass, 1);
      g.fillRect(ox + bx + 1, y, 3, 6);
      g.fillRect(ox + bx + bw - 4, y, 3, 6);
      g.fillStyle(PALETTE.glassLight, 0.72);
      g.fillRect(ox + bx + 2, y + 1, 1, 3);
      g.fillRect(ox + bx + bw - 3, y + 1, 1, 3);
    }
    // Twin rear doors on the curb side and a lower livery stripe.
    g.fillStyle(0x152431, 1);
    g.fillRect(ox + bx + bw - 4, 53, 3, 11);
    g.fillStyle(0x92c7dc, 0.9);
    g.fillRect(ox + bx + bw - 3, 54, 1, 9);
    g.fillStyle(0xf4c85a, 1);
    g.fillRect(ox + bx + 1, 56, bw - 2, 2);

    // Roof hatches and rear ventilation panel.
    g.fillStyle(shade(teal, 0.3), 1);
    g.fillRoundedRect(ox + Math.round(w / 2) - 4, 22, 8, 6, 1);
    g.fillRoundedRect(ox + Math.round(w / 2) - 4, 40, 8, 6, 1);
    g.fillStyle(0x1b3542, 1);
    g.fillRect(ox + bx + 5, h - 9, bw - 10, 2);
    this.lights(g, ox, bx, bw, h, damaged);
    if (damaged) this.damageOverlay(g, ox, bx, bw, h);
  }

  /** Delivery van: boxier van with panel graphics and rear cargo doors. */
  private delivery(g: Phaser.GameObjects.Graphics, ox: number, damaged: boolean): void {
    const w = 24;
    const h = 54;
    this.wheels(g, ox, w, h);
    const bx = 2;
    const bw = w - 4;
    this.shell(g, ox, bx, bw, h, TINTABLE_BODY, 4);
    this.cabinGlass(g, ox, bx, bw, 6, 7, -1, 0, damaged);
    g.fillStyle(shade(TINTABLE_BODY, 0.12), 1);
    g.fillRoundedRect(ox + bx + 2, 15, bw - 4, h - 23, 2);
    g.fillStyle(PALETTE.accent, 1);
    g.fillRect(ox + bx + 1, 24, bw - 2, 3);
    g.fillStyle(shade(PALETTE.accent, 0.4), 1);
    g.fillRect(ox + bx + 3, 32, bw - 6, 7);
    g.fillStyle(PALETTE.window, 1);
    g.fillRect(ox + bx + 4, 34, 5, 3);
    g.fillRect(ox + bx + bw - 9, 34, 5, 3);
    this.grime(g, ox, bx + 2, 15, bw - 4, h - 23);
    this.lights(g, ox, bx, bw, h, damaged);
    if (damaged) this.damageOverlay(g, ox, bx, bw, h);
  }

  /** Construction truck: heavy cab, hazard striping and open rear bed. */
  private construction(g: Phaser.GameObjects.Graphics, ox: number, damaged: boolean): void {
    const w = 30;
    const h = 60;
    this.wheels(g, ox, w, h);
    // Rear axle pair.
    g.fillStyle(PALETTE.tire, 1);
    g.fillRect(ox + 2, Math.round(h * 0.52), 4, 9);
    g.fillRect(ox + w - 6, Math.round(h * 0.52), 4, 9);
    const bx = 2;
    const bw = w - 4;
    const body = 0xf4b63a;
    this.shell(g, ox, bx, bw, h, body, 4);
    this.cabinGlass(g, ox, bx, bw, 6, 7, -1, 0, damaged);
    // Open dump bed with dark liner.
    g.fillStyle(PALETTE.metalDark, 1);
    g.fillRoundedRect(ox + bx + 2, 21, bw - 4, 20, 2);
    g.fillStyle(shade(PALETTE.metalDark, 0.35), 1);
    g.fillRect(ox + bx + 3, 24, bw - 6, 2);
    g.fillStyle(PALETTE.chrome, 1);
    g.fillRect(ox + bx + 2, 15, bw - 4, 2);
    // Hazard stripes on the cab.
    g.fillStyle(PALETTE.outline, 1);
    g.fillRect(ox + bx + 3, 18, 2, 8);
    g.fillRect(ox + bx + 8, 18, 2, 8);
    g.fillRect(ox + bx + 13, 18, 2, 8);
    g.fillRect(ox + bx + 18, 18, 2, 8);
    // Side work lights.
    g.fillStyle(PALETTE.lightYellow, 1);
    g.fillRect(ox + bx + 1, 6, 3, 2);
    g.fillRect(ox + bx + bw - 4, 6, 3, 2);
    this.grime(g, ox, bx + 2, 16, bw - 4, h - 26);
    this.lights(g, ox, bx, bw, h, damaged);
    if (damaged) this.damageOverlay(g, ox, bx, bw, h);
  }

  /** Scooter: tiny step-through with tiny rider and open frame. */
  private scooter(g: Phaser.GameObjects.Graphics, ox: number, damaged: boolean): void {
    const w = 10;
    const h = 24;
    const cx = ox + w / 2;
    g.fillStyle(PALETTE.shadow, 0.24);
    g.fillEllipse(cx + 2, h / 2 + 2, 7, h - 4);
    g.fillStyle(PALETTE.tire, 1);
    g.fillRoundedRect(cx - 2, 0, 4, 5, 1);
    g.fillRoundedRect(cx - 2, h - 5, 4, 5, 1);
    g.fillStyle(PALETTE.outline, 1);
    g.fillRect(cx - 1, 4, 2, 14);
    g.fillStyle(damaged ? shade(0xf4d03f, 0.3) : 0xf4d03f, 1);
    g.fillRoundedRect(cx - 3, 7, 6, 8, 2);
    g.fillStyle(PALETTE.chrome, 1);
    g.fillRect(cx - 4, 8, 8, 1);
    // Rider.
    g.fillStyle(0x2a2f3a, 1);
    g.fillRoundedRect(cx - 3, 10, 6, 6, 2);
    g.fillStyle(PALETTE.skin, 1);
    g.fillCircle(cx, 11, 2);
    g.fillStyle(PALETTE.metalDark, 1);
    g.fillRect(cx + 1, 6, 3, 1);
    g.fillStyle(PALETTE.headlight, 1);
    g.fillRect(cx - 1, 0, 2, 2);
    if (damaged) {
      g.fillStyle(PALETTE.shadow, 0.35);
      g.fillRoundedRect(cx - 2, 7, 3, 5, 1);
    }
  }

  // ── Two-wheelers ─────────────────────────────────────────────────────────────

  /** Motorcycle: slim tank + seat with a leathered rider on top. */
  private motorcycle(g: Phaser.GameObjects.Graphics, ox: number, damaged: boolean): void {
    const w = 12;
    const h = 30;
    const cx = ox + w / 2;
    g.fillStyle(PALETTE.shadow, 0.26);
    g.fillEllipse(cx + 2, h / 2 + 2, 8, h - 4);
    // Wheels: front and rear stubs on the centreline.
    g.fillStyle(PALETTE.tire, 1);
    g.fillRoundedRect(cx - 2, 0, 4, 8, 2);
    g.fillRoundedRect(cx - 2, h - 8, 4, 8, 2);
    // Frame + tank.
    const body = damaged ? shade(TINTABLE_BODY, 0.3) : TINTABLE_BODY;
    g.fillStyle(PALETTE.outline, 1);
    g.fillRoundedRect(cx - 3, 6, 6, h - 12, 3);
    g.fillStyle(body, 1);
    g.fillRoundedRect(cx - 2, 7, 4, h - 14, 2);
    // Handlebars.
    g.fillStyle(PALETTE.metalDark, 1);
    g.fillRect(cx - 5, 8, 10, 2);
    // Rider: shoulders + helmet.
    g.fillStyle(0x23262d, 1);
    g.fillRoundedRect(cx - 4, 12, 8, 9, 3);
    g.fillStyle(0x101014, 1);
    g.fillCircle(cx, 14, 3);
    g.fillStyle(PALETTE.glassLight, 1);
    g.fillRect(cx - 2, 11, 4, 1);
    // Headlight / taillight.
    g.fillStyle(tintUp(PALETTE.headlight, 0.1), 1);
    g.fillRect(cx - 1, 0, 2, 2);
    g.fillStyle(PALETTE.brakeLight, 1);
    g.fillRect(cx - 1, h - 2, 2, 2);
    if (damaged) {
      g.fillStyle(PALETTE.shadow, 0.35);
      g.fillRoundedRect(cx - 3, 7, 3, 6, 1);
    }
  }

  /** Bicycle: thin frame, pedalling rider, no lights. */
  private bicycle(g: Phaser.GameObjects.Graphics, ox: number, damaged: boolean): void {
    const w = 10;
    const h = 26;
    const cx = ox + w / 2;
    g.fillStyle(PALETTE.shadow, 0.2);
    g.fillEllipse(cx + 2, h / 2 + 2, 6, h - 4);
    g.fillStyle(PALETTE.tire, 1);
    g.fillRoundedRect(cx - 1, 0, 2, 7, 1);
    g.fillRoundedRect(cx - 1, h - 7, 2, 7, 1);
    const frame = damaged ? shade(0x2f8a4a, 0.35) : 0x2f8a4a;
    g.fillStyle(frame, 1);
    g.fillRect(cx - 1, 6, 2, h - 12);
    // Handlebars.
    g.fillStyle(PALETTE.metalDark, 1);
    g.fillRect(cx - 4, 7, 8, 1);
    // Rider.
    g.fillStyle(0x5c6270, 1);
    g.fillRoundedRect(cx - 3, 11, 6, 8, 2);
    g.fillStyle(PALETTE.skin, 1);
    g.fillCircle(cx, 13, 2.4);
    g.fillStyle(0x3a2a1a, 1);
    g.fillCircle(cx, 13.8, 2);
  }

  // ── Aircraft ─────────────────────────────────────────────────────────────────

  /** Police helicopter hull + a separate spinning rotor texture. */
  private helicopter(): void {
    if (!this.scene.textures.exists(TextureKeys.Helicopter)) {
      const w = 34;
      const h = 46;
      const g = this.scene.make.graphics({ x: 0, y: 0 }, false);
      const cx = w / 2;
      // Tail boom.
      g.fillStyle(PALETTE.swatArmorDark, 1);
      g.fillRoundedRect(cx - 2, 22, 4, 20, 2);
      // Tail rotor.
      g.fillStyle(PALETTE.metalDark, 1);
      g.fillRect(cx - 6, h - 5, 12, 2);
      // Cabin.
      g.fillStyle(PALETTE.outline, 1);
      g.fillEllipse(cx, 14, 22, 26);
      g.fillStyle(PALETTE.swatArmor, 1);
      g.fillEllipse(cx, 14, 19, 23);
      // Canopy glass at the nose.
      g.fillStyle(PALETTE.glass, 1);
      g.fillEllipse(cx, 8, 13, 10);
      g.fillStyle(PALETTE.glassLight, 0.9);
      g.fillEllipse(cx - 2, 7, 5, 4);
      // White belly band.
      g.fillStyle(PALETTE.window, 1);
      g.fillRect(cx - 8, 17, 16, 3);
      // Skids.
      g.fillStyle(PALETTE.metalDark, 1);
      g.fillRect(cx - 11, 6, 2, 18);
      g.fillRect(cx + 9, 6, 2, 18);
      g.generateTexture(TextureKeys.Helicopter, w, h);
      g.destroy();
    }

    if (!this.scene.textures.exists(TextureKeys.HeliRotor)) {
      const s = 44;
      const g = this.scene.make.graphics({ x: 0, y: 0 }, false);
      const c = s / 2;
      g.fillStyle(PALETTE.outline, 0.85);
      g.fillRect(0, c - 1, s, 2);
      g.fillRect(c - 1, 0, 2, s);
      g.fillStyle(PALETTE.chrome, 1);
      g.fillCircle(c, c, 2);
      g.generateTexture(TextureKeys.HeliRotor, s, s);
      g.destroy();
    }
  }
}
