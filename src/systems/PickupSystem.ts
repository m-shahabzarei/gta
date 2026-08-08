/**
 * PickupSystem — world pickups: supplies, weapon drops and hidden collectibles.
 *
 * On attach it seeds:
 *  - the hidden collectible packages at the map's collectible spots (each with
 *    a stable id so "found" state persists across saves);
 *  - a scatter of free weapon pickups and supply crates around the world.
 *
 * At runtime it also drops loot: downed police leave ammo or armor behind. A
 * gentle bob/spin tween makes every pickup catch the eye. Collection is a
 * per-frame distance test against the player (the live pickup set is small and
 * bounded), applying the pickup's effect through the player entity and firing
 * {@link EventKeys.PickupCollected} / {@link EventKeys.CollectibleFound}.
 *
 * "Found" collectible ids persist through {@link ISerializable} so a 100%
 * completionist run survives save/load.
 */
import Phaser from 'phaser';
import { BaseSceneManager } from '@/core/BaseSceneManager';
import { ServiceLocator } from '@/core/ServiceLocator';
import { ServiceKeys } from '@/config/ServiceKeys';
import { EventKeys } from '@/config/EventKeys';
import { DepthLayers } from '@/config/DepthLayers';
import { TextureKeys } from '@/config/AssetKeys';
import type { ISerializable } from '@/core/interfaces';
import type { Json, Vector2 } from '@/core/types';
import { getPlayerRef, type PickupKind, type WeaponId } from '@/gameplay/types';
import type { WorldManager } from '@/systems/WorldManager';
import { Random } from '@/utils';

/** Radius (px) within which the player collects a pickup. */
const PICKUP_RADIUS = 22;

/** Squared collection radius. */
const PICKUP_RADIUS_SQ = PICKUP_RADIUS * PICKUP_RADIUS;

/** How long (ms) a dropped pickup lingers before it fades away. */
const DROP_LINGER_MS = 20000;

/** A live pickup tracked by the system. */
interface Pickup {
  kind: PickupKind;
  x: number;
  y: number;
  amount: number;
  weaponId?: WeaponId;
  persistentId?: string;
  sprite: Phaser.GameObjects.Image;
  /** Scene time (ms) after which a dropped pickup is removed (0 = permanent). */
  expiresAt: number;
}

/** Minimal view of the player entity for applying pickup effects. */
interface PlayerAccess {
  player?: {
    isAlive: boolean;
    giveHealth(n: number): void;
    giveArmor(n: number): void;
    inventory: {
      addMoney(n: number): void;
      addAmmo(id: WeaponId, n: number): boolean;
      giveWeapon(id: WeaponId, ammo: number): void;
      hasWeapon(id: WeaponId): boolean;
    };
  } | null;
}

/** Ranged weapons a free weapon pickup may grant. */
const WEAPON_DROPS: readonly WeaponId[] = [
  'pistol',
  'smg',
  'shotgun',
  'rifle',
  'revolver',
  'sniper',
];

export class PickupSystem extends BaseSceneManager implements ISerializable {
  /** Service-locator key for this system. */
  public readonly key = ServiceKeys.Pickup;

  /** Stable id under which collectible progress is saved. */
  public readonly saveId = 'pickups';

  /** Deterministic RNG for placement + drop rolls. */
  private readonly rng = new Random(0x91c4c9b);

  /** Live pickups in the world. */
  private readonly pickups: Pickup[] = [];

  /** Ids of collectibles already found (persisted). */
  private readonly foundCollectibles = new Set<string>();

  /** Latest scene time (ms), captured each update. */
  private elapsed = 0;

  /** Seed collectibles + supply scatter, and wire the police-loot drop. */
  protected onInit(): void {
    this.subscribe(EventKeys.EntityKilled, (p) => {
      if (p.kind === 'police' && p.byPlayer) {
        this.maybeDropLoot(p.position);
      }
    });
    this.subscribe(EventKeys.WeaponDropped, ({ weaponId, ammo, position }) => {
      this.dropWeapon(position, weaponId, ammo);
    });
  }

  /** Materialize a bounded weapon pickup from a player or NPC death. */
  public dropWeapon(position: Vector2, weaponId: WeaponId, ammo: number): void {
    this.spawnPickup({
      kind: 'weapon',
      x: position.x,
      y: position.y,
      amount: Math.max(0, Math.floor(ammo)),
      weaponId,
      expiresAt: this.elapsed + DROP_LINGER_MS,
    });
  }

  /** Place all persistent pickups for the attached scene. */
  protected onAttach(_scene: Phaser.Scene): void {
    this.elapsed = 0;
    this.placeCollectibles();
    this.placeSupplyScatter();
  }

  /** Destroy every pickup sprite on scene teardown. */
  protected override onDetach(_scene: Phaser.Scene): void {
    for (const pickup of this.pickups) pickup.sprite.destroy();
    this.pickups.length = 0;
  }

  /** Per-frame: age dropped pickups and test player collection. */
  public update(time: number, _delta: number): void {
    this.elapsed = time;
    const playerPos = getPlayerRef()?.playerPosition ?? null;

    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const pickup = this.pickups[i];
      if (!pickup) continue;

      if (pickup.expiresAt > 0 && time >= pickup.expiresAt) {
        pickup.sprite.destroy();
        this.pickups.splice(i, 1);
        continue;
      }

      if (!playerPos) continue;
      if (
        Phaser.Math.Distance.Squared(playerPos.x, playerPos.y, pickup.x, pickup.y) <=
        PICKUP_RADIUS_SQ
      ) {
        if (this.collect(pickup)) {
          pickup.sprite.destroy();
          this.pickups.splice(i, 1);
        }
      }
    }
  }

  // ── Placement ──────────────────────────────────────────────────────────────

  /** Place the hidden collectible packages that have not yet been found. */
  private placeCollectibles(): void {
    const world = this.resolveWorld();
    const spots = world?.map.collectibles ?? [];
    spots.forEach((spot, index) => {
      const id = `col-${index}`;
      if (this.foundCollectibles.has(id)) return;
      this.spawnPickup({
        kind: 'collectible',
        x: spot.x,
        y: spot.y,
        amount: 250,
        persistentId: id,
        expiresAt: 0,
      });
    });
  }

  /** Scatter a handful of free weapon + supply pickups around the world. */
  private placeSupplyScatter(): void {
    const world = this.resolveWorld();
    if (!world) return;

    // Free weapons near gun shops so the armoury is reachable without cash.
    for (const shop of world.map.gunShops) {
      const id = this.rng.pick(WEAPON_DROPS) ?? 'pistol';
      this.spawnPickup({
        kind: 'weapon',
        x: shop.x + this.rng.range(-24, 24),
        y: shop.y + 36,
        amount: 60,
        weaponId: id,
        expiresAt: 0,
      });
    }

    // Supply crates on sidewalks across the map.
    for (let i = 0; i < 22; i++) {
      const point = world.randomSidewalkPoint();
      const roll = this.rng.next();
      const kind: PickupKind =
        roll < 0.4 ? 'money' : roll < 0.7 ? 'health' : roll < 0.9 ? 'armor' : 'ammo';
      this.spawnPickup({
        kind,
        x: point.x,
        y: point.y,
        amount: this.amountFor(kind),
        weaponId: kind === 'ammo' ? 'pistol' : undefined,
        expiresAt: 0,
      });
    }
  }

  /** Chance to drop ammo/armor where an officer fell. */
  private maybeDropLoot(pos: Vector2): void {
    if (!this.rng.chance(0.5)) return;
    const armor = this.rng.chance(0.3);
    this.spawnPickup({
      kind: armor ? 'armor' : 'ammo',
      x: pos.x,
      y: pos.y,
      amount: armor ? 25 : 30,
      weaponId: armor ? undefined : 'pistol',
      expiresAt: this.elapsed + DROP_LINGER_MS,
    });
  }

  /** Default amount for a supply pickup kind. */
  private amountFor(kind: PickupKind): number {
    switch (kind) {
      case 'health':
        return 25;
      case 'armor':
        return 25;
      case 'money':
        return this.rng.intRange(20, 120);
      case 'ammo':
        return 40;
      default:
        return 0;
    }
  }

  /** Create a pickup sprite with a bob/spin tween and track it. */
  private spawnPickup(spec: Omit<Pickup, 'sprite'>): void {
    const scene = this.scene;
    if (!scene) return;
    const sprite = scene.add.image(spec.x, spec.y, this.textureFor(spec.kind));
    sprite.setDepth(DepthLayers.GroundDetail);
    scene.tweens.add({
      targets: sprite,
      y: spec.y - 4,
      duration: 700,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
    if (spec.kind === 'collectible') {
      scene.tweens.add({ targets: sprite, angle: 360, duration: 2600, repeat: -1 });
    }
    this.pickups.push({ ...spec, sprite });
  }

  /** Texture for a pickup kind. */
  private textureFor(kind: PickupKind): string {
    switch (kind) {
      case 'health':
        return TextureKeys.PickupHealth;
      case 'armor':
        return TextureKeys.PickupArmor;
      case 'money':
        return TextureKeys.PickupMoney;
      case 'ammo':
        return TextureKeys.PickupAmmo;
      case 'weapon':
        return TextureKeys.PickupWeapon;
      case 'collectible':
      default:
        return TextureKeys.Package;
    }
  }

  // ── Collection ─────────────────────────────────────────────────────────────

  /** Apply a pickup's effect to the player. Returns whether it was consumed. */
  private collect(pickup: Pickup): boolean {
    const player = this.resolvePlayer();
    if (!player || !player.isAlive) return false;

    switch (pickup.kind) {
      case 'health':
        player.giveHealth(pickup.amount);
        break;
      case 'armor':
        player.giveArmor(pickup.amount);
        break;
      case 'money':
        player.inventory.addMoney(pickup.amount);
        break;
      case 'ammo':
        player.inventory.addAmmo(pickup.weaponId ?? 'pistol', pickup.amount);
        break;
      case 'weapon':
        if (pickup.weaponId) {
          player.inventory.giveWeapon(pickup.weaponId, pickup.amount);
        }
        break;
      case 'collectible':
        if (pickup.persistentId) {
          this.foundCollectibles.add(pickup.persistentId);
          player.inventory.addMoney(pickup.amount);
          const total = this.resolveWorld()?.map.collectibles.length ?? 0;
          this.bus.emit(EventKeys.CollectibleFound, {
            found: this.foundCollectibles.size,
            total,
          });
          this.bus.emit(EventKeys.UIToast, {
            message: `Collectible ${this.foundCollectibles.size}/${total} found!`,
          });
        }
        break;
      default:
        break;
    }

    this.bus.emit(EventKeys.PickupCollected, { kind: pickup.kind, x: pickup.x, y: pickup.y });
    return true;
  }

  // ── ISerializable ──────────────────────────────────────────────────────────

  /** Snapshot the found collectibles. */
  public serialize(): Json {
    return { found: Array.from(this.foundCollectibles) };
  }

  /** Restore found collectibles from a snapshot. */
  public deserialize(data: Json): void {
    this.foundCollectibles.clear();
    if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
      const found = (data as { found?: Json }).found;
      if (Array.isArray(found)) {
        for (const id of found) {
          if (typeof id === 'string') this.foundCollectibles.add(id);
        }
      }
    }
  }

  // ── Resolution ─────────────────────────────────────────────────────────────

  /** Resolve the player entity for applying effects, or `null`. */
  private resolvePlayer(): NonNullable<PlayerAccess['player']> | null {
    const service = ServiceLocator.tryResolve(ServiceKeys.Player) as unknown as PlayerAccess | null;
    return service?.player ?? null;
  }

  /** Resolve the world manager, or `null`. */
  private resolveWorld(): WorldManager | null {
    return ServiceLocator.tryResolve<WorldManager>(ServiceKeys.World);
  }
}
