/**
 * In-world enterable building support.
 *
 * Service interiors are stamped directly into the city tilemap by WorldManager.
 * This system draws the room props on top of those tiles, emits interior
 * ambience changes, seeds dynamic NPCs through the normal pedestrian system and
 * handles object interactions without pausing or launching a fake interior map.
 */
import Phaser from 'phaser';
import { BaseSceneManager } from '@/core/BaseSceneManager';
import { ServiceLocator } from '@/core/ServiceLocator';
import { ServiceKeys } from '@/config/ServiceKeys';
import { EventKeys } from '@/config/EventKeys';
import { DepthLayers } from '@/config/DepthLayers';
import { TextureKeys } from '@/config/AssetKeys';
import { PLAYER } from '@/config/Constants';
import { SERVICE_PED_PROFILES, VEHICLES, WEAPONS, WEAPON_ORDER } from '@/data';
import type {
  BuildingInterior,
  InteriorAmbienceKind,
  InteriorInteractionAction,
  InteriorObjectInfo,
  InteriorKind,
  VehicleKind,
  WeaponId,
} from '@/gameplay/types';
import type { Vector2 } from '@/core/types';
import { interiorNpcSpawnPosition } from '@/gameplay/world/InteriorNpcPlacement';
import type { Player } from '@/entities/Player';
import type { Pedestrian } from '@/entities/Pedestrian';
import type { SaveManager } from '@/managers/SaveManager';
import type { PlayerController } from '@/systems/PlayerController';
import type { WorldManager } from '@/systems/WorldManager';

interface PedestrianSpawner {
  spawnAt(x: number, y: number): Pedestrian | null;
  spawnProfileAt?(
    x: number,
    y: number,
    profile: (typeof SERVICE_PED_PROFILES)[keyof typeof SERVICE_PED_PROFILES],
  ): Pedestrian | null;
  removeById?(id: number): boolean;
  readonly pedestrians?: readonly Pedestrian[];
}

interface InteriorInteraction {
  prompt: string;
  action: InteriorInteractionAction;
  interior: BuildingInterior;
  object: InteriorObjectInfo;
  distanceSq: number;
}

interface WantedClearer {
  clearWanted?(): void;
}

/** Narrow visual seam owned by WorldManager's streamed architecture layer. */
interface InteriorRoofController {
  setInteriorRoofOpen?(interiorId: string | null): void;
}

const INTERACTION_RANGE = PLAYER.INTERACT_RANGE;
const NPC_SEED_INTERVAL_MS = 1600;
const ACTIVE_INTERIOR_RADIUS = 420;

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

export class WorldInteriorSystem extends BaseSceneManager {
  public readonly key = ServiceKeys.Interior;

  private readonly objects: Phaser.GameObjects.GameObject[] = [];
  private readonly visualsByInterior = new Map<string, Phaser.GameObjects.GameObject[]>();
  private readonly interiorVisibility = new Map<string, boolean>();
  private readonly doorRects: Array<{
    rect: Phaser.GameObjects.Rectangle;
    interiorId: string;
    x: number;
    y: number;
  }> = [];
  private readonly npcIdsByInterior = new Map<string, Set<number>>();
  private seedTimer = 0;
  private currentAmbience: InteriorAmbienceKind | null = null;
  private openRoofInteriorId: string | null = null;

  protected onInit(): void {
    this.subscribe(EventKeys.GameInteriorRequested, (payload) => {
      this.focusNearestInterior(payload.kind);
    });
  }

  protected onAttach(scene: Phaser.Scene): void {
    const world = this.resolveWorld();
    for (const interior of world?.map.buildingInteriors ?? []) {
      this.drawInterior(scene, interior);
    }
    this.seedTimer = 0;
  }

  protected override onDetach(_scene: Phaser.Scene): void {
    this.setOpenInteriorRoof(null);
    for (const object of this.objects) object.destroy();
    this.objects.length = 0;
    this.visualsByInterior.clear();
    this.interiorVisibility.clear();
    this.doorRects.length = 0;
    this.npcIdsByInterior.clear();
    this.setAmbience(null);
    this.seedTimer = 0;
  }

  public update(_time: number, delta: number): void {
    const pos = this.resolveController()?.playerPosition ?? null;
    const activeInterior = pos ? this.interiorAt(pos.x, pos.y) : null;
    this.setAmbience(activeInterior?.ambient ?? null);
    this.setOpenInteriorRoof(activeInterior?.id ?? null);
    this.updateInteriorVisibility(pos);
    this.updateDoors(pos);

    this.seedTimer += delta;
    if (this.seedTimer < NPC_SEED_INTERVAL_MS) return;
    this.seedTimer = 0;
    if (pos) this.seedNearbyInteriorNpcs(pos);
  }

  /** Nearest actionable interior object for HUD prompts. */
  public nearestInteraction(pos: Vector2, range = INTERACTION_RANGE): InteriorInteraction | null {
    const rangeSq = range * range;
    let best: InteriorInteraction | null = null;
    for (const interior of this.resolveWorld()?.map.buildingInteriors ?? []) {
      if (!this.pointNearBounds(pos, interior.bounds, ACTIVE_INTERIOR_RADIUS)) continue;
      for (const object of interior.objects) {
        if (!object.action || !object.prompt) continue;
        const distanceSq = this.distanceToRectSq(pos, object);
        if (distanceSq > rangeSq) continue;
        if (!best || distanceSq < best.distanceSq) {
          best = { prompt: object.prompt, action: object.action, interior, object, distanceSq };
        }
      }
    }
    return best;
  }

  /** Handle an interact press. Returns true when an interior object consumed it. */
  public handleInteract(x: number, y: number): boolean {
    const interaction = this.nearestInteraction({ x, y });
    if (!interaction) return false;
    this.runAction(interaction.action);
    return true;
  }

  /** Interior containing a point, if any. */
  public interiorAt(x: number, y: number): BuildingInterior | null {
    for (const interior of this.resolveWorld()?.map.buildingInteriors ?? []) {
      const b = interior.bounds;
      if (x >= b.x && y >= b.y && x <= b.x + b.w && y <= b.y + b.h) return interior;
    }
    return null;
  }

  /** Tell the player where the nearest real interior entrance is. */
  public focusNearestInterior(kind: InteriorKind): void {
    const pos = this.resolveController()?.playerPosition ?? null;
    const world = this.resolveWorld();
    if (!pos || !world) return;
    let best: BuildingInterior | null = null;
    let bestSq = Infinity;
    for (const interior of world.map.buildingInteriors) {
      if (interior.kind !== kind) continue;
      const d = this.distanceSq(pos, interior.entrance);
      if (d < bestSq) {
        best = interior;
        bestSq = d;
      }
    }
    if (!best) return;
    this.bus.emit(EventKeys.WaypointChanged, { target: { ...best.entrance } });
    this.bus.emit(EventKeys.UIToast, { message: 'Entrance is open. Walk through the doorway.' });
  }

  private drawInterior(scene: Phaser.Scene, interior: BuildingInterior): void {
    const g = scene.add.graphics();
    g.setDepth(DepthLayers.GroundDetail + 8);
    const accent =
      interior.kind === 'hospital'
        ? 0x78b7bd
        : interior.kind === 'police'
          ? 0x587eaa
          : 0xb89362;
    for (const [index, room] of interior.rooms.entries()) {
      g.fillStyle(index % 2 === 0 ? accent : 0xffffff, index % 2 === 0 ? 0.055 : 0.025);
      g.fillRect(room.x + 2, room.y + 2, Math.max(1, room.w - 4), Math.max(1, room.h - 4));
      g.fillStyle(accent, 0.2);
      g.fillRect(room.x + 4, room.y + 4, Math.max(4, Math.min(room.w - 8, 28)), 2);
      g.lineStyle(1, 0xffffff, 0.08);
      g.strokeRect(room.x, room.y, room.w, room.h);
      if (room.w >= 68 && room.h >= 42) {
        const label = scene.add.text(room.x + 6, room.y + 8, this.roomLabel(room.name), {
          fontFamily: 'Courier New',
          fontSize: '7px',
          fontStyle: 'bold',
          color: '#dce4e6',
        });
        label.setAlpha(0.46);
        label.setResolution(2);
        label.setDepth(DepthLayers.GroundDetail + 9);
        this.trackVisual(interior.id, label);
      }
    }
    this.trackVisual(interior.id, g);

    for (const door of interior.doors) {
      const rect = scene.add.rectangle(
        door.x + door.w / 2,
        door.y + door.h / 2,
        door.w,
        door.h,
        door.open ? 0x8a5a33 : 0x2a1d14,
        0.86,
      );
      rect.setDepth(DepthLayers.Characters - 30);
      rect.setStrokeStyle(1, 0xe7c27a, 0.35);
      this.trackVisual(interior.id, rect);
      this.doorRects.push({
        rect,
        interiorId: interior.id,
        x: door.x + door.w / 2,
        y: door.y + door.h / 2,
      });
    }

    for (const object of interior.objects) {
      this.drawObject(scene, interior.id, object);
    }
    for (const visual of this.visualsByInterior.get(interior.id) ?? []) {
      (
        visual as Phaser.GameObjects.GameObject & { setVisible?: (value: boolean) => unknown }
      ).setVisible?.(false);
    }
    this.interiorVisibility.set(interior.id, false);
  }

  private drawObject(
    scene: Phaser.Scene,
    interiorId: string,
    object: InteriorObjectInfo,
  ): void {
    const g = scene.add.graphics();
    g.setDepth(DepthLayers.Characters - 20);
    const x = Math.round(object.x);
    const y = Math.round(object.y);
    const w = Math.max(6, Math.round(object.w));
    const h = Math.max(6, Math.round(object.h));
    const dark = mixColor(object.color, 0x111820, 0.58);
    const light = mixColor(object.color, 0xffffff, 0.35);
    const mid = mixColor(object.color, 0x26323a, 0.22);
    g.fillStyle(0x0c1115, 0.35);
    g.fillRect(x + 2, y + 3, w, h);

    switch (object.kind) {
      case 'bed':
      case 'stretcher':
      case 'exam-table':
      case 'operating-table': {
        g.fillStyle(dark, 1);
        g.fillRect(x, y + 2, w, h - 2);
        g.fillStyle(object.color, 1);
        g.fillRect(x + 2, y, w - 4, h - 4);
        g.fillStyle(0xe6ece9, 0.92);
        g.fillRect(x + 4, y + 2, Math.max(4, w - 8), Math.max(3, h - 8));
        g.fillStyle(0xb8ced0, 1);
        g.fillRect(x + 4, y + 2, Math.max(4, Math.floor(w * 0.24)), Math.max(3, h - 8));
        g.fillStyle(dark, 1);
        g.fillRect(x + 2, y + h - 3, 3, 5);
        g.fillRect(x + w - 5, y + h - 3, 3, 5);
        if (object.kind === 'stretcher') {
          g.fillStyle(0xd8dde1, 1);
          g.fillRect(x - 2, y + 2, 2, h - 3);
          g.fillRect(x + w, y + 2, 2, h - 3);
        }
        if (object.kind === 'operating-table') {
          g.fillStyle(0x4b8f96, 1);
          g.fillRect(x + Math.floor(w / 2) - 1, y + 2, 2, h - 8);
        }
        break;
      }
      case 'counter':
      case 'desk':
      case 'evidence-table': {
        g.fillStyle(dark, 1);
        g.fillRect(x, y + 2, w, h - 2);
        g.fillStyle(light, 1);
        g.fillRect(x, y, w, 4);
        g.fillStyle(object.color, 1);
        g.fillRect(x + 2, y + 5, w - 4, h - 7);
        g.fillStyle(dark, 0.8);
        g.fillRect(x + 4, y + 7, Math.max(3, w - 8), 2);
        g.fillRect(x + Math.floor(w / 2), y + 6, 1, Math.max(2, h - 9));
        break;
      }
      case 'bench':
      case 'chair': {
        g.fillStyle(dark, 1);
        g.fillRect(x + 1, y, w - 2, 4);
        g.fillStyle(object.color, 1);
        g.fillRect(x + 2, y + 5, w - 4, Math.max(4, h - 9));
        g.fillStyle(light, 0.8);
        g.fillRect(x + 3, y + 5, Math.max(2, w - 6), 2);
        g.fillStyle(dark, 1);
        g.fillRect(x + 3, y + h - 4, 2, 4);
        g.fillRect(x + w - 5, y + h - 4, 2, 4);
        break;
      }
      case 'computer':
      case 'security-console': {
        g.fillStyle(dark, 1);
        g.fillRect(x, y + 2, w, h - 2);
        g.fillStyle(mid, 1);
        g.fillRect(x + 2, y, w - 4, Math.max(6, h - 5));
        g.fillStyle(0x75c9ce, 0.9);
        g.fillRect(x + 4, y + 2, Math.max(3, w - 8), Math.max(2, h - 9));
        g.fillStyle(light, 0.75);
        g.fillRect(x + Math.floor(w / 2) - 1, y + h - 5, 2, 3);
        if (object.kind === 'security-console') {
          g.fillStyle(0xdac959, 1);
          g.fillRect(x + 3, y + h - 3, 2, 2);
          g.fillStyle(0xc24848, 1);
          g.fillRect(x + 7, y + h - 3, 2, 2);
        }
        break;
      }
      case 'shelf':
      case 'cabinet':
      case 'locker':
      case 'filing-cabinet': {
        g.fillStyle(dark, 1);
        g.fillRect(x, y, w, h);
        g.fillStyle(object.color, 1);
        g.fillRect(x + 2, y + 1, w - 4, h - 3);
        g.fillStyle(light, 0.75);
        for (let row = y + 4; row < y + h - 2; row += 5) {
          g.fillRect(x + 3, row, w - 6, 1);
        }
        g.fillStyle(0xc7cbd0, 0.9);
        g.fillRect(x + w - 5, y + Math.floor(h / 2), 2, 2);
        break;
      }
      case 'medical-cart': {
        g.fillStyle(dark, 1);
        g.fillRect(x + 1, y + 2, w - 2, h - 4);
        g.fillStyle(0xd9e3e1, 1);
        g.fillRect(x + 2, y, w - 4, h - 5);
        g.fillStyle(0xb43b43, 1);
        g.fillRect(x + Math.floor(w / 2) - 3, y + 4, 6, 2);
        g.fillRect(x + Math.floor(w / 2) - 1, y + 2, 2, 6);
        g.fillStyle(dark, 1);
        g.fillRect(x + 2, y + h - 3, 3, 3);
        g.fillRect(x + w - 5, y + h - 3, 3, 3);
        break;
      }
      case 'privacy-screen': {
        g.fillStyle(dark, 1);
        g.fillRect(x, y + h - 3, w, 3);
        const panelWidth = Math.max(3, Math.floor((w - 4) / 3));
        for (let panel = 0; panel < 3; panel++) {
          g.fillStyle(panel % 2 === 0 ? object.color : light, 0.92);
          g.fillRect(x + 1 + panel * (panelWidth + 1), y, panelWidth, h - 4);
        }
        break;
      }
      case 'cell': {
        g.fillStyle(0x151a1e, 0.9);
        g.fillRect(x, y, w, h);
        g.fillStyle(0x9ca7ae, 1);
        for (let barX = x + 3; barX < x + w - 1; barX += 5) g.fillRect(barX, y, 2, h);
        g.fillRect(x, y + 3, w, 2);
        g.fillStyle(0xd1b45b, 1);
        g.fillRect(x + w - 6, y + Math.floor(h / 2), 3, 3);
        break;
      }
      case 'crate': {
        g.fillStyle(dark, 1);
        g.fillRect(x, y, w, h);
        g.fillStyle(object.color, 1);
        g.fillRect(x + 2, y + 2, w - 4, h - 4);
        g.fillStyle(light, 0.55);
        g.fillRect(x + 3, y + 3, 2, h - 6);
        g.fillRect(x + w - 5, y + 3, 2, h - 6);
        g.fillRect(x + 3, y + Math.floor(h / 2), w - 6, 2);
        break;
      }
      default: {
        g.fillStyle(dark, 1);
        g.fillRect(x, y, w, h);
        g.fillStyle(object.color, 1);
        g.fillRect(x + 2, y + 2, w - 4, h - 4);
        g.fillStyle(light, 0.6);
        g.fillRect(x + 3, y + 3, Math.max(2, w - 6), 2);
        break;
      }
    }
    this.trackVisual(interiorId, g);

    if (object.kind === 'vehicle-display') {
      const car = scene.add.image(
        object.x + object.w / 2,
        object.y + object.h / 2,
        object.w > 34 ? TextureKeys.VehSports : TextureKeys.VehMotorcycle,
      );
      car.setDisplaySize(Math.min(28, object.w - 6), Math.min(44, object.h - 6));
      car.setDepth(DepthLayers.Characters - 15);
      this.trackVisual(interiorId, car);
    }
  }

  private trackVisual(interiorId: string, object: Phaser.GameObjects.GameObject): void {
    this.objects.push(object);
    const visuals = this.visualsByInterior.get(interiorId) ?? [];
    visuals.push(object);
    this.visualsByInterior.set(interiorId, visuals);
  }

  /** Toggle complete interior batches only when crossing the streaming band. */
  private updateInteriorVisibility(playerPos: Vector2 | null): void {
    for (const interior of this.resolveWorld()?.map.buildingInteriors ?? []) {
      const visible =
        playerPos !== null && this.pointNearBounds(playerPos, interior.bounds, ACTIVE_INTERIOR_RADIUS);
      if (this.interiorVisibility.get(interior.id) === visible) continue;
      this.interiorVisibility.set(interior.id, visible);
      for (const object of this.visualsByInterior.get(interior.id) ?? []) {
        (
          object as Phaser.GameObjects.GameObject & { setVisible?: (value: boolean) => unknown }
        ).setVisible?.(visible);
      }
    }
  }

  private roomLabel(name: string): string {
    const labels: Readonly<Record<string, string>> = {
      'Emergency and Examination': 'EMERGENCY / EXAM',
      'Pharmacy and Storage': 'PHARMACY / STORE',
      'Locker and Equipment': 'LOCKER / EQUIPMENT',
      'Interrogation Room': 'INTERROGATION',
      'Police Desks': 'DUTY DESKS',
      'Doctors Area': 'DOCTORS',
      'Procedure Room': 'PROCEDURE',
      'Nurses Station': 'NURSES',
      'Examination Rooms': 'EXAM ROOMS',
    };
    return labels[name] ?? name.toUpperCase();
  }

  private seedNearbyInteriorNpcs(playerPos: Vector2): void {
    const spawner = this.resolvePedestrians();
    if (!spawner?.spawnAt) return;

    for (const interior of this.resolveWorld()?.map.buildingInteriors ?? []) {
      const ids = this.npcIdsByInterior.get(interior.id) ?? new Set<number>();
      for (const id of Array.from(ids)) {
        if (!(spawner.pedestrians ?? []).some((ped) => ped.id === id && ped.isAlive)) ids.delete(id);
      }
      if (!this.pointNearBounds(playerPos, interior.bounds, ACTIVE_INTERIOR_RADIUS)) {
        for (const id of ids) spawner.removeById?.(id);
        ids.clear();
        this.npcIdsByInterior.delete(interior.id);
        continue;
      }

      for (const spawn of interior.npcSpawns) {
        const existing = (spawner.pedestrians ?? []).filter(
          (ped) => ids.has(ped.id) && ped.sprite.getData('interiorRole') === spawn.role,
        ).length;
        for (let i = existing; i < spawn.count; i++) {
          const point = interiorNpcSpawnPosition(spawn, i);
          const profile = SERVICE_PED_PROFILES[spawn.appearance ?? 'civilian'];
          const ped =
            spawner.spawnProfileAt?.(point.x, point.y, profile) ??
            spawner.spawnAt(point.x, point.y);
          if (!ped) continue;
          ped.sprite.setData('interiorId', interior.id);
          ped.sprite.setData('interiorRole', spawn.role);
          ped.sprite.setData('interiorActivity', spawn.activity ?? 'patrol');
          ped.ai.setHomeArea(
            interior.bounds.x + interior.bounds.w / 2,
            interior.bounds.y + interior.bounds.h / 2,
            Math.min(interior.bounds.w, interior.bounds.h) * 0.44,
          );
          if (spawn.anchors && spawn.anchors.length > 0) {
            ped.ai.setInteriorRoutine(spawn.activity ?? 'patrol', spawn.anchors);
          }
          ids.add(ped.id);
        }
      }
      this.npcIdsByInterior.set(interior.id, ids);
    }
  }

  private runAction(action: InteriorInteractionAction): void {
    switch (action) {
      case 'hospital-heal':
        this.healPlayer();
        break;
      case 'hospital-medkit':
        this.buyMedkit();
        break;
      case 'hospital-save':
        this.saveGame();
        break;
      case 'police-clear':
        this.clearWanted();
        break;
      case 'gun-buy-weapon':
        if (!this.ensureBusinessOpen('gunstore')) return;
        this.buyNextWeapon();
        break;
      case 'gun-buy-ammo':
        if (!this.ensureBusinessOpen('gunstore')) return;
        this.buyAmmo();
        break;
      case 'gun-buy-armor':
        if (!this.ensureBusinessOpen('gunstore')) return;
        this.buyArmor();
        break;
      case 'dealer-buy-vehicle':
        if (!this.ensureBusinessOpen('dealership')) return;
        this.buyNextVehicle();
        break;
      case 'dealer-service':
        if (!this.ensureBusinessOpen('dealership')) return;
        this.toast('Service desk: use a garage key to retrieve purchased vehicles.');
        break;
      default:
        break;
    }
  }

  private healPlayer(): void {
    const player = this.resolvePlayer();
    if (!player) return;
    player.giveHealth(player.healthComp.maxHealth);
    this.toast('Hospital staff restored your health.');
  }

  private buyMedkit(): void {
    const player = this.resolvePlayer();
    if (!player) return;
    const cost = 75;
    if (!player.inventory.spendMoney(cost)) {
      this.toast(`Need $${cost} for a medkit.`);
      return;
    }
    const stored = player.inventory.addItem('health:medkit', 1);
    if (stored <= 0) {
      player.inventory.addMoney(cost);
      this.toast('Inventory full.');
      return;
    }
    this.toast('Medkit added.');
  }

  private saveGame(): void {
    const ok =
      ServiceLocator.tryResolve<SaveManager>(ServiceKeys.Save)?.save(0, 'Hospital') ?? false;
    this.toast(ok ? 'Game saved.' : 'Save failed.');
  }

  private clearWanted(): void {
    const wanted = ServiceLocator.tryResolve(ServiceKeys.Wanted) as WantedClearer | null;
    wanted?.clearWanted?.();
    this.toast('Police records updated.');
  }

  private buyNextWeapon(): void {
    const player = this.resolvePlayer();
    if (!player) return;
    const next = WEAPON_PRICES.find((entry) => !player.inventory.hasWeapon(entry.id));
    if (!next) {
      this.toast('All display weapons owned. Use ammo shelves to restock.');
      return;
    }
    if (!player.inventory.spendMoney(next.price)) {
      this.toast(`Need $${next.price} for ${WEAPONS[next.id].name}.`);
      return;
    }
    player.inventory.giveWeapon(next.id, Math.max(WEAPONS[next.id].magazine * 2, 1));
    player.refreshEquippedWeapon();
    this.toast(`${WEAPONS[next.id].name} purchased.`);
  }

  private buyAmmo(): void {
    const player = this.resolvePlayer();
    if (!player) return;
    const current = player.inventory.currentWeaponId;
    const entry = WEAPON_PRICES.find((price) => price.id === current) ?? WEAPON_PRICES[0];
    if (!entry || current === WEAPON_ORDER[0]) {
      this.toast('Equip a firearm before buying ammo.');
      return;
    }
    if (!player.inventory.spendMoney(entry.ammoPrice)) {
      this.toast(`Need $${entry.ammoPrice} for ammo.`);
      return;
    }
    if (!player.inventory.addAmmo(current, entry.ammoAmount)) {
      player.inventory.addMoney(entry.ammoPrice);
      this.toast('Ammo is already full.');
      return;
    }
    this.toast(`${WEAPONS[current].name} ammo restocked.`);
  }

  private buyArmor(): void {
    const player = this.resolvePlayer();
    if (!player) return;
    const cost = 180;
    if (!player.inventory.spendMoney(cost)) {
      this.toast(`Need $${cost} for armor.`);
      return;
    }
    const stored = player.inventory.addItem('armor:vest', 1);
    if (stored <= 0) {
      player.inventory.addMoney(cost);
      this.toast('Inventory full.');
      return;
    }
    this.toast('Armor vest added.');
  }

  private buyNextVehicle(): void {
    const player = this.resolvePlayer();
    if (!player) return;
    const next = VEHICLE_PRICES.find((entry) => !player.inventory.hasVehicle(entry.kind));
    if (!next) {
      this.toast('All showroom vehicles already owned.');
      return;
    }
    if (!player.inventory.spendMoney(next.price)) {
      this.toast(`Need $${next.price} for ${VEHICLES[next.kind].name}.`);
      return;
    }
    player.inventory.addVehicle(next.kind);
    player.inventory.addItem('key:garage', 1);
    this.toast(`${VEHICLES[next.kind].name} stored in your garage.`);
  }

  private setAmbience(kind: InteriorAmbienceKind | null): void {
    if (kind === this.currentAmbience) return;
    this.currentAmbience = kind;
    this.bus.emit(EventKeys.InteriorAmbienceChanged, { kind });
  }

  /** Open only the roof above the player; all other streamed roofs stay closed. */
  private setOpenInteriorRoof(interiorId: string | null): void {
    if (interiorId === this.openRoofInteriorId) return;
    this.openRoofInteriorId = interiorId;
    const world = this.resolveWorld() as (WorldManager & InteriorRoofController) | null;
    world?.setInteriorRoofOpen?.(interiorId);
  }

  private updateDoors(pos: Vector2 | null): void {
    for (const door of this.doorRects) {
      if (!this.interiorVisibility.get(door.interiorId)) continue;
      if (!pos) {
        door.rect.setAlpha(0.86);
        door.rect.setScale(1, 1);
        continue;
      }
      const nearby = this.distanceSq(pos, door) < 42 * 42;
      door.rect.setAlpha(nearby ? 0.28 : 0.86);
      door.rect.setScale(nearby ? 0.62 : 1, 1);
    }
  }

  private ensureBusinessOpen(kind: 'gunstore' | 'dealership'): boolean {
    const clock = ServiceLocator.tryResolve(ServiceKeys.DayNight) as { hour?: number } | null;
    const hour = clock?.hour ?? 12;
    const open = kind === 'gunstore' ? hour >= 9 && hour < 22 : hour >= 8 && hour < 20;
    if (open) return true;
    this.toast(
      kind === 'gunstore'
        ? 'Gun store is closed until 09:00.'
        : 'Dealership is closed until 08:00.',
    );
    return false;
  }

  private distanceToRectSq(
    pos: Vector2,
    rect: { x: number; y: number; w: number; h: number },
  ): number {
    const cx = Phaser.Math.Clamp(pos.x, rect.x, rect.x + rect.w);
    const cy = Phaser.Math.Clamp(pos.y, rect.y, rect.y + rect.h);
    return this.distanceSq(pos, { x: cx, y: cy });
  }

  private pointNearBounds(
    pos: Vector2,
    bounds: { x: number; y: number; w: number; h: number },
    range: number,
  ): boolean {
    return this.distanceToRectSq(pos, bounds) <= range * range;
  }

  private distanceSq(a: Vector2, b: Vector2): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy;
  }

  private toast(message: string): void {
    this.bus.emit(EventKeys.UIToast, { message });
  }

  private resolveWorld(): WorldManager | null {
    return ServiceLocator.tryResolve<WorldManager>(ServiceKeys.World);
  }

  private resolvePedestrians(): PedestrianSpawner | null {
    return (
      (ServiceLocator.tryResolve(ServiceKeys.Pedestrian) as unknown as PedestrianSpawner | null) ??
      null
    );
  }

  private resolveController(): PlayerController | null {
    return ServiceLocator.tryResolve<PlayerController>(ServiceKeys.Player);
  }

  private resolvePlayer(): Player | null {
    return this.resolveController()?.player ?? null;
  }
}

function mixColor(first: number, second: number, amount: number): number {
  const t = Phaser.Math.Clamp(amount, 0, 1);
  const r = Math.round(((first >> 16) & 0xff) * (1 - t) + ((second >> 16) & 0xff) * t);
  const g = Math.round(((first >> 8) & 0xff) * (1 - t) + ((second >> 8) & 0xff) * t);
  const b = Math.round((first & 0xff) * (1 - t) + (second & 0xff) * t);
  return (r << 16) | (g << 8) | b;
}
