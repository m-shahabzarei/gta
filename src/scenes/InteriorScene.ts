/**
 * Enterable building interiors.
 *
 * This scene runs above the paused city and supplies compact, navigable maps
 * for the hospital, police station, gun store and vehicle dealership. It uses
 * scene-local movement and collision so the outdoor gameplay architecture stays
 * intact.
 */
import Phaser from 'phaser';
import { SceneKeys } from '@/config/SceneKeys';
import { TextureKeys } from '@/config/AssetKeys';
import { ServiceLocator } from '@/core/ServiceLocator';
import { ServiceKeys } from '@/config/ServiceKeys';
import { COLORS, GAME_HEIGHT, GAME_WIDTH } from '@/config/Constants';
import { Button, Label, Panel } from '@/ui/components';
import { VEHICLES, WEAPONS } from '@/data';
import type { InteriorKind, VehicleKind, WeaponId } from '@/gameplay/types';
import type { HomeInteriorPayload } from '@/gameplay/types/HousingTypes';
import { createHomeLayout, type HomeLayoutSpec } from '@/gameplay/HomeLayoutRegistry';
import type { HousingSystem } from '@/systems/HousingSystem';
import type { HomeCustomizationSystem } from '@/systems/HomeCustomizationSystem';
import { FURNITURE_ITEMS } from '@/systems/HomeCustomizationSystem';
import type { GameManager } from '@/managers/GameManager';
import type { SaveManager } from '@/managers/SaveManager';
import type { PlayerController } from '@/systems/PlayerController';

interface InteriorSceneData {
  kind?: InteriorKind;
  home?: HomeInteriorPayload;
}

interface RectSpec {
  x: number;
  y: number;
  w: number;
  h: number;
  color: number;
  label?: string;
}

interface ZoneSpec {
  x: number;
  y: number;
  w: number;
  h: number;
  prompt: string;
  action: InteriorAction;
}

interface NpcSpec {
  x: number;
  y: number;
  texture: string;
  label: string;
  tint?: number;
}

interface InteriorLayout {
  title: string;
  subtitle: string;
  floor: number;
  walls: RectSpec[];
  furniture: RectSpec[];
  zones: ZoneSpec[];
  npcs: NpcSpec[];
  spawn: Phaser.Math.Vector2;
}

type InteriorAction = 'exit' | 'heal' | 'medkit' | 'save' | 'jail' | 'gunshop' | 'dealer';

interface KeySet {
  w: Phaser.Input.Keyboard.Key;
  a: Phaser.Input.Keyboard.Key;
  s: Phaser.Input.Keyboard.Key;
  d: Phaser.Input.Keyboard.Key;
  e: Phaser.Input.Keyboard.Key;
  esc: Phaser.Input.Keyboard.Key;
  space: Phaser.Input.Keyboard.Key;
}

const FLOOR = new Phaser.Geom.Rectangle(86, 72, 1108, 566);
const PLAYER_RADIUS = 11;
const PLAYER_SPEED = 172;
const SHOP_W = 880;
const SHOP_H = 560;

const WEAPON_PRICES: ReadonlyArray<{
  id: WeaponId;
  price: number;
  ammoPrice: number;
  ammoAmount: number;
}> = [
  { id: 'pistol', price: 240, ammoPrice: 55, ammoAmount: 36 },
  { id: 'shotgun', price: 650, ammoPrice: 90, ammoAmount: 24 },
  { id: 'smg', price: 890, ammoPrice: 120, ammoAmount: 90 },
  { id: 'rifle', price: 1350, ammoPrice: 160, ammoAmount: 72 },
  { id: 'sniper', price: 2200, ammoPrice: 220, ammoAmount: 15 },
  { id: 'rocket', price: 3600, ammoPrice: 480, ammoAmount: 3 },
  { id: 'grenade', price: 500, ammoPrice: 160, ammoAmount: 4 },
];

const VEHICLE_PRICES: ReadonlyArray<{ kind: VehicleKind; price: number }> = [
  { kind: 'sedan', price: 900 },
  { kind: 'motorcycle', price: 1200 },
  { kind: 'suv', price: 1700 },
  { kind: 'sports', price: 3200 },
  { kind: 'luxury', price: 4200 },
  { kind: 'van', price: 1500 },
];

export class InteriorScene extends Phaser.Scene {
  private kind: InteriorKind = 'hospital';
  private homePayload: HomeInteriorPayload | null = null;
  private layout: InteriorLayout | null = null;
  private playerMarker: Phaser.GameObjects.Sprite | null = null;
  private keys: KeySet | null = null;
  private promptLabel: Label | null = null;
  private statusLabel: Label | null = null;
  private shopPanel: Phaser.GameObjects.Container | null = null;
  /** Cached collision geometry; rebuilt once when a layout is created. */
  private readonly collisionRects: Phaser.Geom.Rectangle[] = [];
  /** Cached interaction zones; avoids allocating rectangles in the update loop. */
  private readonly zoneRects: Array<{ spec: ZoneSpec; rect: Phaser.Geom.Rectangle }> = [];
  /** Reusable movement/collision probes for the hot path. */
  private readonly movementAxis = new Phaser.Math.Vector2(0, 0);
  private readonly collisionProbe = new Phaser.Geom.Rectangle();
  private prevPadInteract = false;
  private prevPadBack = false;

  constructor() {
    super({ key: SceneKeys.Interior });
  }

  /** Build the requested interior. */
  public create(data?: InteriorSceneData): void {
    // Phaser can reuse this scene instance after a stop/start cycle. Clear all
    // scene-local caches and references before constructing the next layout.
    this.homePayload = data?.home ?? null;
    this.kind = data?.kind ?? 'hospital';
    this.playerMarker = null;
    this.keys = null;
    this.promptLabel = null;
    this.statusLabel = null;
    this.shopPanel = null;
    this.collisionRects.length = 0;
    this.zoneRects.length = 0;
    this.prevPadInteract = false;
    this.prevPadBack = false;
    this.enableMenuCursor();
    this.add.rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, 0x05070c, 1).setOrigin(0);
    this.layout = this.homePayload
      ? this.fromHomeLayout(createHomeLayout(this.homePayload.layoutId, this.homePayload.deterministicSeed))
      : this.makeLayout(this.kind);
    this.cacheCollisionGeometry(this.layout);
    this.drawLayout(this.layout);
    this.bindInput();

    this.playerMarker = this.add.sprite(
      this.layout.spawn.x,
      this.layout.spawn.y,
      TextureKeys.CharPlayer,
    );
    if (this.playerMarker.texture.has('idle0')) {
      this.playerMarker.setFrame('idle0');
    }
    this.playerMarker.setDepth(20);
    this.playerMarker.setScale(1.1);

    this.promptLabel = new Label(this, GAME_WIDTH / 2, GAME_HEIGHT - 64, '', {
      fontSize: '18px',
      color: this.hex(COLORS.ACCENT),
      backgroundColor: '#11131d',
      padding: { x: 10, y: 5 },
    });
    this.promptLabel.setVisible(false);

    this.statusLabel = new Label(this, GAME_WIDTH / 2, GAME_HEIGHT - 102, '', {
      fontSize: '16px',
      color: this.hex(COLORS.TEXT),
      backgroundColor: '#11131d',
      padding: { x: 10, y: 5 },
    });
    this.statusLabel.setVisible(false);

    this.tweens.add({
      targets: this.cameras.main,
      alpha: { from: 0, to: 1 },
      duration: 160,
      ease: 'Quad.easeOut',
    });
  }

  private fromHomeLayout(home: HomeLayoutSpec): InteriorLayout {
    const furniture = home.furniture.map((rect) => ({ ...rect }));
    const customization = this.homePayload
      ? ServiceLocator.tryResolve<HomeCustomizationSystem>(ServiceKeys.HomeCustomization)?.getCustomization(this.homePayload.propertyId)
      : null;
    const customizationSystem = ServiceLocator.tryResolve<HomeCustomizationSystem>(ServiceKeys.HomeCustomization);
    for (const placement of customization?.placements ?? []) {
      const item = FURNITURE_ITEMS.find((candidate) => candidate.id === placement.itemId);
      const slot = customizationSystem?.getSlots(this.homePayload?.propertyId ?? '').find((candidate) => candidate.id === placement.slotId);
      if (!item || !slot) continue;
      const rotated = placement.rotation === 90 || placement.rotation === 270;
      furniture.push({
        x: slot.anchor.x - (rotated ? item.height : item.width) / 2,
        y: slot.anchor.y - (rotated ? item.width : item.height) / 2,
        w: rotated ? item.height : item.width,
        h: rotated ? item.width : item.height,
        color: furnitureColor(item.category),
        label: placement.itemId.split(':')[0]?.toUpperCase(),
      });
    }
    return {
      title: home.title,
      subtitle: `${home.subtitle} · ${this.homePayload?.propertyId ?? 'home'}`,
      floor: home.floor,
      walls: home.walls.map((rect) => ({ ...rect })),
      furniture,
      zones: home.zones.map((zone) => ({ ...zone })),
      npcs: [],
      spawn: new Phaser.Math.Vector2(home.spawn.x, home.spawn.y),
    };
  }

  /** Move the local player marker and handle interaction keys. */
  public override update(_time: number, delta: number): void {
    if (!this.playerMarker) return;
    const axis = this.readAxis();
    if (!this.shopPanel) {
      this.move(axis, delta);
      this.updatePrompt();
    }

    if (this.justInteract()) {
      if (this.shopPanel) return;
      this.activateZone();
    }
    if (this.justBack()) {
      if (this.shopPanel) {
        this.closeShopPanel();
      } else {
        this.closeInterior();
      }
    }
  }

  /** Render floor, walls, furniture, zones and static NPCs. */
  private drawLayout(layout: InteriorLayout): void {
    const g = this.add.graphics();
    g.fillStyle(layout.floor, 1);
    g.fillRect(FLOOR.x, FLOOR.y, FLOOR.width, FLOOR.height);

    g.lineStyle(1, 0xffffff, 0.08);
    for (let x = FLOOR.x; x <= FLOOR.right; x += 32) {
      g.lineBetween(x, FLOOR.y, x, FLOOR.bottom);
    }
    for (let y = FLOOR.y; y <= FLOOR.bottom; y += 32) {
      g.lineBetween(FLOOR.x, y, FLOOR.right, y);
    }

    g.lineStyle(12, 0x05070c, 1);
    g.strokeRect(FLOOR.x, FLOOR.y, FLOOR.width, FLOOR.height);
    for (const wall of layout.walls) {
      this.drawRect(wall, true);
    }
    for (const item of layout.furniture) {
      this.drawRect(item, false);
    }
    for (const zone of layout.zones) {
      this.add
        .rectangle(zone.x + zone.w / 2, zone.y + zone.h / 2, zone.w, zone.h, COLORS.ACCENT, 0.12)
        .setStrokeStyle(1, COLORS.ACCENT, 0.45);
    }
    for (const npc of layout.npcs) {
      const sprite = this.add.sprite(npc.x, npc.y, npc.texture);
      if (sprite.texture.has('idle0')) sprite.setFrame('idle0');
      if (npc.tint !== undefined) sprite.setTint(npc.tint);
      sprite.setDepth(18);
      new Label(this, npc.x - 40, npc.y + 18, npc.label, {
        fontSize: '11px',
        color: this.hex(0xd8dde7),
        align: 'center',
        fixedWidth: 80,
      });
    }

    new Label(this, 28, 18, layout.title, {
      fontSize: '26px',
      fontStyle: 'bold',
      color: this.hex(COLORS.ACCENT),
    });
    new Label(this, 30, 48, layout.subtitle, {
      fontSize: '14px',
      color: this.hex(0x9aa0a6),
    });
    new Label(this, GAME_WIDTH - 196, 24, 'ESC / B  Exit', {
      fontSize: '14px',
      color: this.hex(0x9aa0a6),
      align: 'right',
      fixedWidth: 168,
    });
  }

  /** Draw a labelled blocking/furniture rectangle. */
  private drawRect(spec: RectSpec, wall: boolean): void {
    const rect = this.add.rectangle(spec.x + spec.w / 2, spec.y + spec.h / 2, spec.w, spec.h, spec.color, 1);
    rect.setDepth(wall ? 12 : 14);
    rect.setStrokeStyle(wall ? 0 : 1, wall ? spec.color : 0xffffff, wall ? 0 : 0.14);
    if (spec.label) {
      new Label(this, spec.x, spec.y + spec.h / 2 - 7, spec.label, {
        fontSize: '11px',
        color: '#ffffff',
        align: 'center',
        fixedWidth: spec.w,
      });
    }
  }

  /** Build one of the four interior layouts. */
  private makeLayout(kind: InteriorKind): InteriorLayout {
    switch (kind) {
      case 'police':
        return this.policeLayout();
      case 'gunstore':
        return this.gunStoreLayout();
      case 'dealership':
        return this.dealerLayout();
      case 'hospital':
      default:
        return this.hospitalLayout();
    }
  }

  private hospitalLayout(): InteriorLayout {
    return {
      title: 'HOSPITAL',
      subtitle: 'Reception, waiting room, offices, rooms and pharmacy',
      floor: 0x24303f,
      spawn: new Phaser.Math.Vector2(640, 594),
      walls: [
        { x: 86, y: 72, w: 1108, h: 12, color: 0x0b1018 },
        { x: 86, y: 626, w: 1108, h: 12, color: 0x0b1018 },
        { x: 86, y: 72, w: 12, h: 566, color: 0x0b1018 },
        { x: 1182, y: 72, w: 12, h: 566, color: 0x0b1018 },
        { x: 454, y: 86, w: 12, h: 220, color: 0x0b1018 },
        { x: 454, y: 390, w: 12, h: 236, color: 0x0b1018 },
        { x: 812, y: 86, w: 12, h: 540, color: 0x0b1018 },
      ],
      furniture: [
        { x: 132, y: 126, w: 252, h: 34, color: 0x56738a, label: 'RECEPTION' },
        { x: 140, y: 252, w: 58, h: 24, color: 0x486172, label: 'BENCH' },
        { x: 226, y: 252, w: 58, h: 24, color: 0x486172, label: 'BENCH' },
        { x: 312, y: 252, w: 58, h: 24, color: 0x486172, label: 'BENCH' },
        { x: 520, y: 126, w: 190, h: 34, color: 0x506988, label: 'DOCTOR' },
        { x: 526, y: 264, w: 96, h: 30, color: 0x88a2b0, label: 'BED' },
        { x: 650, y: 264, w: 96, h: 30, color: 0x88a2b0, label: 'BED' },
        { x: 880, y: 126, w: 228, h: 34, color: 0x4e7a65, label: 'PHARMACY' },
        { x: 888, y: 238, w: 64, h: 180, color: 0x40546b, label: 'SHELF' },
        { x: 990, y: 238, w: 64, h: 180, color: 0x40546b, label: 'SHELF' },
      ],
      zones: [
        { x: 150, y: 92, w: 210, h: 56, prompt: 'E  Restore health', action: 'heal' },
        { x: 872, y: 92, w: 250, h: 62, prompt: 'E  Buy medkit', action: 'medkit' },
        { x: 1030, y: 514, w: 92, h: 74, prompt: 'E  Save', action: 'save' },
        { x: 584, y: 584, w: 112, h: 42, prompt: 'E  Exit', action: 'exit' },
      ],
      npcs: [
        { x: 270, y: 188, texture: TextureKeys.CharPed, label: 'Nurse', tint: 0xbfe7ff },
        { x: 610, y: 190, texture: TextureKeys.CharPed, label: 'Doctor', tint: 0xffffff },
        { x: 244, y: 326, texture: TextureKeys.CharPed, label: 'Patient', tint: 0xd6b58f },
      ],
    };
  }

  private policeLayout(): InteriorLayout {
    return {
      title: 'POLICE STATION',
      subtitle: 'Reception, offices, jail cells, evidence and interrogation',
      floor: 0x252b37,
      spawn: new Phaser.Math.Vector2(640, 594),
      walls: [
        { x: 86, y: 72, w: 1108, h: 12, color: 0x0b1018 },
        { x: 86, y: 626, w: 1108, h: 12, color: 0x0b1018 },
        { x: 86, y: 72, w: 12, h: 566, color: 0x0b1018 },
        { x: 1182, y: 72, w: 12, h: 566, color: 0x0b1018 },
        { x: 420, y: 86, w: 12, h: 540, color: 0x0b1018 },
        { x: 818, y: 86, w: 12, h: 540, color: 0x0b1018 },
      ],
      furniture: [
        { x: 136, y: 128, w: 224, h: 34, color: 0x2c4776, label: 'RECEPTION' },
        { x: 492, y: 126, w: 116, h: 52, color: 0x465060, label: 'OFFICE' },
        { x: 650, y: 126, w: 116, h: 52, color: 0x465060, label: 'OFFICE' },
        { x: 888, y: 120, w: 214, h: 40, color: 0x334257, label: 'EVIDENCE' },
        { x: 888, y: 238, w: 90, h: 72, color: 0x1c2430, label: 'CELL' },
        { x: 1008, y: 238, w: 90, h: 72, color: 0x1c2430, label: 'CELL' },
        { x: 888, y: 360, w: 214, h: 40, color: 0x384250, label: 'INTERROGATION' },
        { x: 510, y: 390, w: 184, h: 42, color: 0x2f3948, label: 'LOCKER ROOM' },
      ],
      zones: [
        { x: 144, y: 94, w: 210, h: 62, prompt: 'E  Check in', action: 'jail' },
        { x: 888, y: 232, w: 214, h: 86, prompt: 'E  Jail cell', action: 'jail' },
        { x: 584, y: 584, w: 112, h: 42, prompt: 'E  Exit', action: 'exit' },
      ],
      npcs: [
        { x: 258, y: 196, texture: TextureKeys.CharPolice, label: 'Desk Sgt' },
        { x: 560, y: 240, texture: TextureKeys.CharPolice, label: 'Officer' },
        { x: 1024, y: 458, texture: TextureKeys.CharPolice, label: 'Guard' },
      ],
    };
  }

  private gunStoreLayout(): InteriorLayout {
    return {
      title: 'GUN STORE',
      subtitle: 'Displays, counter and ammunition shelves',
      floor: 0x2c261d,
      spawn: new Phaser.Math.Vector2(640, 594),
      walls: [
        { x: 86, y: 72, w: 1108, h: 12, color: 0x100b07 },
        { x: 86, y: 626, w: 1108, h: 12, color: 0x100b07 },
        { x: 86, y: 72, w: 12, h: 566, color: 0x100b07 },
        { x: 1182, y: 72, w: 12, h: 566, color: 0x100b07 },
      ],
      furniture: [
        { x: 146, y: 132, w: 308, h: 42, color: 0x554233, label: 'COUNTER' },
        { x: 560, y: 136, w: 108, h: 340, color: 0x3a2d23, label: 'PISTOLS' },
        { x: 704, y: 136, w: 108, h: 340, color: 0x3a2d23, label: 'LONG GUNS' },
        { x: 862, y: 136, w: 178, h: 74, color: 0x4b382b, label: 'AMMO' },
        { x: 862, y: 258, w: 178, h: 74, color: 0x4b382b, label: 'ARMOR' },
      ],
      zones: [
        { x: 150, y: 96, w: 300, h: 84, prompt: 'E  Open weapon shop', action: 'gunshop' },
        { x: 584, y: 584, w: 112, h: 42, prompt: 'E  Exit', action: 'exit' },
      ],
      npcs: [{ x: 280, y: 218, texture: TextureKeys.CharPed, label: 'Clerk', tint: 0xcaa46a }],
    };
  }

  private dealerLayout(): InteriorLayout {
    return {
      title: 'VEHICLE DEALERSHIP',
      subtitle: 'Showroom, reception and indoor vehicle displays',
      floor: 0x233037,
      spawn: new Phaser.Math.Vector2(640, 594),
      walls: [
        { x: 86, y: 72, w: 1108, h: 12, color: 0x081014 },
        { x: 86, y: 626, w: 1108, h: 12, color: 0x081014 },
        { x: 86, y: 72, w: 12, h: 566, color: 0x081014 },
        { x: 1182, y: 72, w: 12, h: 566, color: 0x081014 },
      ],
      furniture: [
        { x: 146, y: 116, w: 236, h: 42, color: 0x315666, label: 'RECEPTION' },
        { x: 520, y: 142, w: 180, h: 112, color: 0x18252c, label: 'SPORTS' },
        { x: 754, y: 142, w: 180, h: 112, color: 0x18252c, label: 'SUV' },
        { x: 520, y: 342, w: 180, h: 112, color: 0x18252c, label: 'MOTORCYCLE' },
        { x: 754, y: 342, w: 180, h: 112, color: 0x18252c, label: 'VAN' },
      ],
      zones: [
        { x: 146, y: 90, w: 238, h: 84, prompt: 'E  Open dealership', action: 'dealer' },
        { x: 584, y: 584, w: 112, h: 42, prompt: 'E  Exit', action: 'exit' },
      ],
      npcs: [{ x: 284, y: 208, texture: TextureKeys.CharPed, label: 'Sales', tint: 0x8fc7ff }],
    };
  }

  /** Bind local input. */
  private bindInput(): void {
    const kb = this.input.keyboard;
    if (kb) {
      this.keys = {
        w: kb.addKey('W'),
        a: kb.addKey('A'),
        s: kb.addKey('S'),
        d: kb.addKey('D'),
        e: kb.addKey('E'),
        esc: kb.addKey('ESC'),
        space: kb.addKey('SPACE'),
      };
      kb.once('keydown-ESC', () => this.closeInterior());
    }
    if (this.input.gamepad) {
      this.input.gamepad.enabled = true;
    }
  }

  /** Keyboard/gamepad movement axis. */
  private readAxis(): Phaser.Math.Vector2 {
    const axis = this.movementAxis.set(0, 0);
    const keys = this.keys;
    if (keys) {
      axis.x += (keys.d.isDown ? 1 : 0) - (keys.a.isDown ? 1 : 0);
      axis.y += (keys.s.isDown ? 1 : 0) - (keys.w.isDown ? 1 : 0);
    }
    const pad = this.activePad();
    if (pad) {
      axis.x += Math.abs(pad.leftStick.x) > 0.25 ? pad.leftStick.x : 0;
      axis.y += Math.abs(pad.leftStick.y) > 0.25 ? pad.leftStick.y : 0;
      axis.x += (pad.right ? 1 : 0) - (pad.left ? 1 : 0);
      axis.y += (pad.down ? 1 : 0) - (pad.up ? 1 : 0);
    }
    if (axis.lengthSq() > 1) axis.normalize();
    return axis;
  }

  /** Move with rectangle collision. */
  private move(axis: Phaser.Math.Vector2, delta: number): void {
    const marker = this.playerMarker;
    if (!marker || axis.lengthSq() <= 0) return;
    const dt = delta / 1000;
    const nx = marker.x + axis.x * PLAYER_SPEED * dt;
    const ny = marker.y + axis.y * PLAYER_SPEED * dt;
    if (!this.isBlocked(nx, marker.y)) marker.x = nx;
    if (!this.isBlocked(marker.x, ny)) marker.y = ny;
    if (axis.lengthSq() > 0) {
      marker.setRotation(Math.atan2(axis.y, axis.x) + Math.PI / 2);
    }
  }

  /** Whether the local player marker would collide at a point. */
  private isBlocked(x: number, y: number): boolean {
    const body = this.collisionProbe.setTo(
      x - PLAYER_RADIUS,
      y - PLAYER_RADIUS,
      PLAYER_RADIUS * 2,
      PLAYER_RADIUS * 2,
    );
    if (!FLOOR.contains(x, y)) return true;
    for (const rect of this.collisionRects) {
      if (Phaser.Geom.Intersects.RectangleToRectangle(body, rect)) return true;
    }
    return false;
  }

  /** Cache blocking rectangles and zone hitboxes once per scene layout. */
  private cacheCollisionGeometry(layout: InteriorLayout): void {
    this.collisionRects.push(
      ...layout.walls.map((rect) => new Phaser.Geom.Rectangle(rect.x, rect.y, rect.w, rect.h)),
      ...layout.furniture.map((rect) => new Phaser.Geom.Rectangle(rect.x, rect.y, rect.w, rect.h)),
    );
    this.zoneRects.push(
      ...layout.zones.map((zone) => ({
        spec: zone,
        rect: new Phaser.Geom.Rectangle(zone.x, zone.y, zone.w, zone.h),
      })),
    );
  }

  /** Update local prompt from nearby zones. */
  private updatePrompt(): void {
    const zone = this.currentZone();
    if (!this.promptLabel) return;
    if (!zone) {
      this.promptLabel.setVisible(false);
      return;
    }
    this.promptLabel.setText(zone.prompt);
    this.center(this.promptLabel);
    this.promptLabel.setVisible(true);
  }

  /** Activate current interaction zone. */
  private activateZone(): void {
    const zone = this.currentZone();
    if (!zone) return;
    switch (zone.action) {
      case 'exit':
        this.closeInterior();
        break;
      case 'heal':
        this.healPlayer();
        break;
      case 'medkit':
        this.buyMedkit();
        break;
      case 'save':
        this.saveGame();
        break;
      case 'jail':
        this.showStatus('Jail records updated. Wanted level is clear.');
        break;
      case 'gunshop':
        this.openWeaponShop();
        break;
      case 'dealer':
        this.openDealerShop();
        break;
      default:
        break;
    }
  }

  /** Current zone under or near the player marker. */
  private currentZone(): ZoneSpec | null {
    const marker = this.playerMarker;
    if (!marker) return null;
    return this.zoneRects.find(({ rect }) => rect.contains(marker.x, marker.y))?.spec ?? null;
  }

  private healPlayer(): void {
    const player = this.resolveController()?.player;
    if (!player) return;
    player.giveHealth(player.healthComp.maxHealth);
    this.showStatus('Health fully restored');
  }

  private buyMedkit(): void {
    const player = this.resolveController()?.player;
    if (!player) return;
    const cost = 75;
    if (player.inventory.money < cost) {
      this.showStatus(`Need $${cost} for a medkit`);
      return;
    }
    const stored = player.inventory.addItem('health:medkit', 1);
    if (stored <= 0) {
      this.showStatus('Inventory full');
      return;
    }
    player.inventory.spendMoney(cost);
    this.showStatus('Medkit added to inventory');
  }

  private saveGame(): void {
    const ok = ServiceLocator.tryResolve<SaveManager>(ServiceKeys.Save)?.save(0, 'Interior Save') ?? false;
    this.showStatus(ok ? 'Game saved' : 'Save failed');
  }

  /** Weapon shop modal. */
  private openWeaponShop(): void {
    this.closeShopPanel();
    const root = this.createShopPanel('GUN STORE');
    let y = -SHOP_H / 2 + 74;
    for (const entry of WEAPON_PRICES) {
      const weapon = WEAPONS[entry.id];
      this.addShopText(root, -SHOP_W / 2 + 44, y, weapon.name, COLORS.TEXT, 16);
      root.add(this.add.image(-SHOP_W / 2 + 20, y + 10, weapon.iconKey).setDisplaySize(24, 24));
      this.addShopText(
        root,
        -SHOP_W / 2 + 190,
        y,
        `DMG ${weapon.damage}  RATE ${weapon.fireRateMs}  ACC ${Math.max(0, 100 - weapon.spreadDeg * 5)}%`,
        0x9aa0a6,
        12,
      );
      root.add(
        new Button(this, SHOP_W / 2 - 198, y + 12, {
          text: `$${entry.price}`,
          width: 86,
          height: 28,
          onClick: () => this.buyWeapon(entry.id, entry.price),
        }),
      );
      root.add(
        new Button(this, SHOP_W / 2 - 92, y + 12, {
          text: `Ammo $${entry.ammoPrice}`,
          width: 112,
          height: 28,
          onClick: () => this.buyAmmo(entry.id, entry.ammoPrice, entry.ammoAmount),
        }),
      );
      y += 52;
    }
    root.add(
      new Button(this, -SHOP_W / 2 + 104, SHOP_H / 2 - 44, {
        text: 'Armor $180',
        width: 160,
        height: 34,
        onClick: () => this.buyArmor(),
      }),
    );
  }

  /** Vehicle dealership modal. */
  private openDealerShop(): void {
    this.closeShopPanel();
    const root = this.createShopPanel('DEALERSHIP');
    let y = -SHOP_H / 2 + 84;
    for (const entry of VEHICLE_PRICES) {
      const vehicle = VEHICLES[entry.kind];
      root.add(this.add.image(-SHOP_W / 2 + 32, y + 8, vehicle.textureKey).setDisplaySize(28, 40));
      this.addShopText(root, -SHOP_W / 2 + 70, y, vehicle.name, COLORS.TEXT, 16);
      this.addShopText(
        root,
        -SHOP_W / 2 + 246,
        y,
        `SPD ${vehicle.maxSpeed}  ACC ${vehicle.accel}  HDL ${vehicle.turnRate.toFixed(1)}  DUR ${vehicle.maxHealth}`,
        0x9aa0a6,
        12,
      );
      root.add(
        new Button(this, SHOP_W / 2 - 94, y + 12, {
          text: `$${entry.price}`,
          width: 112,
          height: 30,
          onClick: () => this.buyVehicle(entry.kind, entry.price),
        }),
      );
      y += 64;
    }
  }

  /** Create shared shop modal. */
  private createShopPanel(title: string): Phaser.GameObjects.Container {
    const root = this.add.container(GAME_WIDTH / 2, GAME_HEIGHT / 2).setDepth(100);
    root.add(this.add.rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, 0x000000, 0.58));
    root.add(new Panel(this, 0, 0, SHOP_W, SHOP_H, { fill: 0x11131d, border: COLORS.UI_BORDER, alpha: 0.98 }));
    this.addShopText(root, -SHOP_W / 2 + 28, -SHOP_H / 2 + 24, title, COLORS.ACCENT, 24);
    root.add(
      new Button(this, SHOP_W / 2 - 76, -SHOP_H / 2 + 38, {
        text: 'Close',
        width: 104,
        height: 34,
        onClick: () => this.closeShopPanel(),
      }),
    );
    this.shopPanel = root;
    return root;
  }

  private buyWeapon(id: WeaponId, price: number): void {
    const player = this.resolveController()?.player;
    if (!player) return;
    if (player.inventory.hasWeapon(id)) {
      this.showStatus('Weapon already owned');
      return;
    }
    if (!player.inventory.spendMoney(price)) {
      this.showStatus(`Need $${price}`);
      return;
    }
    player.inventory.giveWeapon(id, Math.max(WEAPONS[id].magazine * 2, 1));
    player.refreshEquippedWeapon();
    this.showStatus(`${WEAPONS[id].name} purchased`);
  }

  private buyAmmo(id: WeaponId, price: number, amount: number): void {
    const player = this.resolveController()?.player;
    if (!player) return;
    if (!player.inventory.hasWeapon(id)) {
      this.showStatus('Buy the weapon first');
      return;
    }
    if (!player.inventory.spendMoney(price)) {
      this.showStatus(`Need $${price}`);
      return;
    }
    player.inventory.addAmmo(id, amount);
    this.showStatus(`${WEAPONS[id].name} ammo purchased`);
  }

  private buyArmor(): void {
    const player = this.resolveController()?.player;
    if (!player) return;
    const cost = 180;
    if (player.inventory.money < cost) {
      this.showStatus(`Need $${cost}`);
      return;
    }
    const stored = player.inventory.addItem('armor:vest', 1);
    if (stored <= 0) {
      this.showStatus('Inventory full');
      return;
    }
    player.inventory.spendMoney(cost);
    this.showStatus('Armor vest added');
  }

  private buyVehicle(kind: VehicleKind, price: number): void {
    const player = this.resolveController()?.player;
    if (!player) return;
    if (player.inventory.hasVehicle(kind)) {
      this.showStatus('Vehicle already in garage');
      return;
    }
    if (!player.inventory.spendMoney(price)) {
      this.showStatus(`Need $${price}`);
      return;
    }
    player.inventory.addVehicle(kind);
    player.inventory.addItem('key:garage', 1);
    this.showStatus(`${VEHICLES[kind].name} stored in garage`);
  }

  private addShopText(
    root: Phaser.GameObjects.Container,
    x: number,
    y: number,
    text: string,
    color: number,
    size: number,
  ): Phaser.GameObjects.Text {
    const obj = this.add.text(x, y, text, {
      fontFamily: 'Courier New',
      fontSize: `${size}px`,
      color: this.hex(color),
    });
    root.add(obj);
    return obj;
  }

  private closeShopPanel(): void {
    this.shopPanel?.destroy();
    this.shopPanel = null;
  }

  private showStatus(message: string): void {
    const label = this.statusLabel;
    if (!label) return;
    label.setText(message);
    this.center(label);
    label.setAlpha(1);
    label.setVisible(true);
    this.tweens.killTweensOf(label);
    this.tweens.add({
      targets: label,
      alpha: 0,
      delay: 1600,
      duration: 400,
      onComplete: () => label.setVisible(false),
    });
  }

  private justInteract(): boolean {
    const keyboard = this.keys
      ? Phaser.Input.Keyboard.JustDown(this.keys.e) || Phaser.Input.Keyboard.JustDown(this.keys.space)
      : false;
    const pad = this.activePad();
    const padDown = pad ? pad.A || pad.buttons[0]?.pressed === true : false;
    const justPad = padDown && !this.prevPadInteract;
    this.prevPadInteract = padDown;
    return keyboard || justPad;
  }

  private justBack(): boolean {
    const keyboard = this.keys ? Phaser.Input.Keyboard.JustDown(this.keys.esc) : false;
    const pad = this.activePad();
    const padDown = pad ? pad.B || pad.buttons[1]?.pressed === true || pad.buttons[9]?.pressed === true : false;
    const justPad = padDown && !this.prevPadBack;
    this.prevPadBack = padDown;
    return keyboard || justPad;
  }

  private activePad(): Phaser.Input.Gamepad.Gamepad | null {
    const plugin = this.input.gamepad;
    if (!plugin || !plugin.enabled) return null;
    const pads = plugin.getAll();
    return pads.find((pad) => pad.connected) ?? null;
  }

  private closeInterior(): void {
    this.closeShopPanel();
    if (this.homePayload) {
      ServiceLocator.tryResolve<HousingSystem>(ServiceKeys.Housing)?.requestExitHome();
      return;
    }
    ServiceLocator.tryResolve<GameManager>(ServiceKeys.Game)?.resumeGame();
    this.scene.stop();
  }

  private resolveController(): PlayerController | null {
    return ServiceLocator.tryResolve<PlayerController>(ServiceKeys.Player);
  }

  private enableMenuCursor(): void {
    this.input.setDefaultCursor('default');
    this.input.mouse?.releasePointerLock();
    this.game.canvas.style.cursor = 'default';
  }

  private center(label: Label): void {
    label.setX(Math.round(GAME_WIDTH / 2 - label.getBounds().width / 2));
  }

  private hex(color: number): string {
    return '#' + color.toString(16).padStart(6, '0');
  }
}

function furnitureColor(category: string): number {
  switch (category) {
    case 'bed':
      return 0x7e8db4;
    case 'sofa':
      return 0x4d7187;
    case 'table':
      return 0x9b7352;
    case 'desk':
      return 0x586b84;
    case 'storage':
      return 0x8b654e;
    case 'kitchen':
      return 0x799b92;
    case 'lighting':
      return 0xd3b46f;
    case 'workshop':
      return 0x6c6b74;
    default:
      return 0x628a78;
  }
}
