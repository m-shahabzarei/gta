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
import { VEHICLES, WEAPONS, WEAPON_ORDER } from '@/data';
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
  private readonly doorRects: Array<{ rect: Phaser.GameObjects.Rectangle; x: number; y: number }> =
    [];
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
    g.setDepth(DepthLayers.GroundDetail);
    g.lineStyle(1, 0xffffff, 0.08);
    for (const room of interior.rooms) {
      g.strokeRect(room.x, room.y, room.w, room.h);
    }
    this.objects.push(g);

    for (const door of interior.doors) {
      const rect = scene.add.rectangle(
        door.x + door.w / 2,
        door.y + door.h / 2,
        door.w,
        door.h,
        door.open ? 0x8a5a33 : 0x2a1d14,
        0.86,
      );
      rect.setDepth(DepthLayers.GroundDetail + 1);
      rect.setStrokeStyle(1, 0xe7c27a, 0.35);
      this.objects.push(rect);
      this.doorRects.push({ rect, x: door.x + door.w / 2, y: door.y + door.h / 2 });
    }

    for (const object of interior.objects) {
      this.drawObject(scene, object);
    }
  }

  private drawObject(scene: Phaser.Scene, object: InteriorObjectInfo): void {
    const rect = scene.add.rectangle(
      object.x + object.w / 2,
      object.y + object.h / 2,
      object.w,
      object.h,
      object.color,
      0.96,
    );
    rect.setDepth(DepthLayers.GroundDetail + 2);
    rect.setStrokeStyle(1, 0xffffff, 0.14);
    this.objects.push(rect);

    if (object.kind === 'bed' || object.kind === 'stretcher') {
      const sheet = scene.add.rectangle(
        object.x + object.w / 2,
        object.y + 4,
        object.w - 6,
        4,
        0xffffff,
        0.72,
      );
      sheet.setDepth(DepthLayers.GroundDetail + 3);
      this.objects.push(sheet);
    } else if (object.kind === 'cell') {
      for (let x = object.x + 4; x < object.x + object.w; x += 6) {
        const bar = scene.add.rectangle(x, object.y + object.h / 2, 1, object.h, 0x9aa0a6, 0.65);
        bar.setDepth(DepthLayers.GroundDetail + 3);
        this.objects.push(bar);
      }
    } else if (object.kind === 'vehicle-display') {
      const car = scene.add.image(
        object.x + object.w / 2,
        object.y + object.h / 2,
        object.w > 34 ? TextureKeys.VehSports : TextureKeys.VehMotorcycle,
      );
      car.setDisplaySize(Math.min(28, object.w - 6), Math.min(44, object.h - 6));
      car.setDepth(DepthLayers.GroundDetail + 4);
      this.objects.push(car);
    } else if (object.kind === 'display') {
      const shine = scene.add.rectangle(
        object.x + object.w / 2,
        object.y + 3,
        object.w - 4,
        2,
        0xffffff,
        0.25,
      );
      shine.setDepth(DepthLayers.GroundDetail + 3);
      this.objects.push(shine);
    }
  }

  private seedNearbyInteriorNpcs(playerPos: Vector2): void {
    const spawner = this.resolvePedestrians();
    if (!spawner?.spawnAt) return;
    const live = spawner.pedestrians ?? [];

    for (const interior of this.resolveWorld()?.map.buildingInteriors ?? []) {
      if (!this.pointNearBounds(playerPos, interior.bounds, ACTIVE_INTERIOR_RADIUS)) continue;
      const ids = this.npcIdsByInterior.get(interior.id) ?? new Set<number>();
      for (const id of Array.from(ids)) {
        if (!live.some((ped) => ped.id === id && ped.isAlive)) ids.delete(id);
      }

      const target = interior.npcSpawns.reduce((sum, spawn) => sum + spawn.count, 0);
      if (ids.size >= target) {
        this.npcIdsByInterior.set(interior.id, ids);
        continue;
      }

      for (const spawn of interior.npcSpawns) {
        for (let i = 0; i < spawn.count && ids.size < target; i++) {
          const point = interiorNpcSpawnPosition(spawn, ids.size);
          const ped = spawner.spawnAt(point.x, point.y);
          if (!ped) continue;
          ped.sprite.setData('interiorId', interior.id);
          ped.sprite.setData('interiorRole', spawn.role);
          ped.ai.setHomeArea(
            interior.bounds.x + interior.bounds.w / 2,
            interior.bounds.y + interior.bounds.h / 2,
            Math.min(interior.bounds.w, interior.bounds.h) * 0.44,
          );
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
