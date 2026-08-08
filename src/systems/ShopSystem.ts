/**
 * ShopSystem — the interactable city services.
 *
 * When the player presses interact ({@link EventKeys.PlayerInteract}) near a
 * service marker it runs the matching transaction:
 *  - **Gun shop** ($): buy an armor plate and top up the ammo of every owned
 *    ranged weapon.
 *  - **Hospital** (H): patch up to full health for a flat fee.
 *  - **Gas station** (G): fully repair the vehicle the player is driving.
 *
 * All money and effects flow through the player entity; the system owns no
 * gameplay state of its own and never mutates the world, so it degrades to a
 * harmless no-op whenever the player or world service is unavailable.
 */
import { BaseSceneManager } from '@/core/BaseSceneManager';
import { ServiceLocator } from '@/core/ServiceLocator';
import { ServiceKeys } from '@/config/ServiceKeys';
import { EventKeys } from '@/config/EventKeys';
import type Phaser from 'phaser';
import type { Vector2 } from '@/core/types';
import type { InteriorKind } from '@/gameplay/types';
import type { WorldManager } from '@/systems/WorldManager';
import type { Player } from '@/entities/Player';
import type { Vehicle } from '@/entities/Vehicle';

/** Interaction range (px) to a service marker. */
const SERVICE_RANGE = 46;

/** Squared service range. */
const SERVICE_RANGE_SQ = SERVICE_RANGE * SERVICE_RANGE;

/** Cost to fully repair a vehicle at a gas station. */
const REPAIR_COST = 80;

/** Minimal view of the player controller for shops. */
interface PlayerControllerAccess {
  player?: Player | null;
  currentVehicle?: Vehicle | null;
}

interface InteriorService {
  handleInteract(x: number, y: number): boolean;
  focusNearestInterior(kind: InteriorKind): void;
}

export class ShopSystem extends BaseSceneManager {
  /** Service-locator key for this system. */
  public readonly key = ServiceKeys.Shop;

  /** Wire the interact handler. */
  protected onInit(): void {
    this.subscribe(EventKeys.PlayerInteract, (p) => this.onInteract(p.x, p.y));
  }

  /** No scene-scoped objects to build. */
  protected onAttach(_scene: Phaser.Scene): void {}

  /**
   * Resolve which service (if any) the interaction lands on and run it.
   * @param x World x of the interaction.
   * @param y World y of the interaction.
   */
  private onInteract(x: number, y: number): void {
    const world = this.resolveWorld();
    const player = this.resolvePlayer();
    if (!world || !player) return;

    const interiors = this.resolveInteriors();
    if (interiors?.handleInteract(x, y)) return;

    const point: Vector2 = { x, y };
    if (this.near(point, world.map.hospitals)) {
      this.focusInterior('hospital');
    } else if (this.near(point, world.map.policeStations)) {
      this.focusInterior('police');
    } else if (this.near(point, world.map.gunShops)) {
      this.focusInterior('gunstore');
    } else if (this.near(point, world.map.garages)) {
      this.focusInterior('dealership');
    } else if (this.near(point, world.map.gasStations)) {
      this.gasStation();
    }
  }

  /** Point the player at the actual doorway instead of opening a modal map. */
  private focusInterior(kind: InteriorKind): void {
    const interiors = this.resolveInteriors();
    if (!interiors) {
      this.toast('The entrance is open.');
      return;
    }
    interiors.focusNearestInterior(kind);
  }

  /** Fully repair the vehicle the player is driving. */
  private gasStation(): void {
    const controller = this.resolveController();
    const player = controller?.player;
    const vehicle = controller?.currentVehicle ?? null;
    if (!player) return;
    if (!vehicle) {
      this.toast('Gas station: drive a vehicle in to repair it');
      return;
    }
    if (vehicle.healthComp.health >= vehicle.healthComp.maxHealth && vehicle.movement.tires >= 1) {
      this.toast('Gas station: vehicle already in good shape');
      return;
    }
    if (player.inventory.spendMoney(REPAIR_COST)) {
      vehicle.repair();
      this.toast(`Vehicle repaired for $${REPAIR_COST}`);
    } else {
      this.toast(`Gas station: need $${REPAIR_COST} to repair`);
    }
  }

  /** Whether `point` is within service range of any location. */
  private near(point: Vector2, locations: readonly Vector2[]): boolean {
    for (const loc of locations) {
      const dx = loc.x - point.x;
      const dy = loc.y - point.y;
      if (dx * dx + dy * dy <= SERVICE_RANGE_SQ) return true;
    }
    return false;
  }

  /** Emit a HUD toast. */
  private toast(message: string): void {
    this.bus.emit(EventKeys.UIToast, { message });
  }

  /** Resolve the world manager, or `null`. */
  private resolveWorld(): WorldManager | null {
    return ServiceLocator.tryResolve<WorldManager>(ServiceKeys.World);
  }

  private resolveInteriors(): InteriorService | null {
    return (ServiceLocator.tryResolve(ServiceKeys.Interior) as unknown as InteriorService | null) ?? null;
  }

  /** Resolve the player entity, or `null`. */
  private resolvePlayer(): Player | null {
    return this.resolveController()?.player ?? null;
  }

  /** Resolve the player controller structurally, or `null`. */
  private resolveController(): PlayerControllerAccess | null {
    return (
      (ServiceLocator.tryResolve(ServiceKeys.Player) as unknown as PlayerControllerAccess | null) ??
      null
    );
  }
}
