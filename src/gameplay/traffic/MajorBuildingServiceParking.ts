import type { Vector2 } from '@/core/types';
import { VEHICLES } from '@/data';
import type { Vehicle } from '@/entities/Vehicle';
import type { MajorBuildingDefinition } from '@/gameplay/types';
import type { VehicleSystem } from '@/systems/VehicleSystem';
import type { Random } from '@/utils';

const STREAM_INTERVAL_MS = 560;
const ACTIVATE_DISTANCE = 1120;
const RETIRE_DISTANCE = 1480;
const SLOT_SPACING = 42;

interface ServiceParkingWorld {
  isSolidAtWorld(x: number, y: number): boolean;
}

/** Proximity-streamed, real pooled service vehicles for the eight required sites. */
export class MajorBuildingServiceParking {
  private readonly records = new Map<string, Vehicle[]>();
  private elapsedMs = 0;

  constructor(
    private readonly definitions: readonly MajorBuildingDefinition[],
    private readonly vehicles: VehicleSystem,
    private readonly world: ServiceParkingWorld,
    private readonly random: Random,
  ) {}

  public get count(): number {
    let total = 0;
    for (const vehicles of this.records.values()) total += vehicles.length;
    return total;
  }

  public update(player: Vector2 | null, deltaMs: number): void {
    this.prune(player);
    this.elapsedMs += deltaMs;
    if (!player || this.elapsedMs < STREAM_INTERVAL_MS) return;
    this.elapsedMs = 0;

    const activateSq = ACTIVATE_DISTANCE * ACTIVATE_DISTANCE;
    const nearby = this.definitions
      .map((definition) => ({
        definition,
        distanceSq: distanceSq(player, definition.parkingArea.position),
      }))
      .filter((entry) => entry.distanceSq <= activateSq)
      .sort((first, second) => first.distanceSq - second.distanceSq);
    for (const { definition } of nearby) {
      if ((this.records.get(definition.id)?.length ?? 0) > 0) continue;
      this.spawnSite(definition);
    }
  }

  public destroy(): void {
    for (const vehicles of this.records.values()) {
      for (const vehicle of vehicles) this.release(vehicle, !vehicle.isPlayerDriven);
    }
    this.records.clear();
    this.elapsedMs = 0;
  }

  private spawnSite(definition: MajorBuildingDefinition): void {
    const count = Math.min(
      definition.parkingArea.slots,
      definition.size === 'metropolitan' ? 2 : 1,
    );
    const spawned: Vehicle[] = [];
    for (let index = 0; index < count; index++) {
      const offset = (index - (count - 1) / 2) * SLOT_SPACING;
      const heading = definition.parkingArea.heading;
      const point = {
        x: definition.parkingArea.position.x - Math.sin(heading) * offset,
        y: definition.parkingArea.position.y + Math.cos(heading) * offset,
      };
      if (!this.isClear(point)) continue;
      const kind = definition.parkingArea.vehicleKind;
      const tint = this.random.pick(VEHICLES[kind].tints);
      const vehicle = this.vehicles.spawnVehicle(kind, point.x, point.y, heading, tint, 'standard');
      vehicle.sprite.setData('parked', true);
      vehicle.sprite.setData('majorBuildingId', definition.id);
      vehicle.sprite.setData('serviceParking', true);
      vehicle.movement.stopImmediately();
      vehicle.movement.setTrafficAuthority(true);
      spawned.push(vehicle);
    }
    if (spawned.length > 0) this.records.set(definition.id, spawned);
  }

  private prune(player: Vector2 | null): void {
    const retireSq = RETIRE_DISTANCE * RETIRE_DISTANCE;
    for (const [buildingId, vehicles] of this.records) {
      const kept: Vehicle[] = [];
      for (const vehicle of vehicles) {
        if (vehicle.isPlayerDriven) {
          this.release(vehicle, false);
          continue;
        }
        const retired =
          !vehicle.sprite.active ||
          vehicle.isDestroyed ||
          (player !== null && distanceSq(player, vehicle.position) > retireSq);
        if (retired) {
          this.release(vehicle, vehicle.sprite.active && !vehicle.isDestroyed);
          continue;
        }
        kept.push(vehicle);
      }
      if (kept.length > 0) this.records.set(buildingId, kept);
      else this.records.delete(buildingId);
    }
  }

  private release(vehicle: Vehicle, removeVehicle: boolean): void {
    vehicle.sprite.data?.remove('parked');
    vehicle.sprite.data?.remove('majorBuildingId');
    vehicle.sprite.data?.remove('serviceParking');
    if (removeVehicle) this.vehicles.removeVehicle(vehicle);
  }

  private isClear(point: Vector2): boolean {
    for (const sample of [
      point,
      { x: point.x - 12, y: point.y - 18 },
      { x: point.x + 12, y: point.y - 18 },
      { x: point.x - 12, y: point.y + 18 },
      { x: point.x + 12, y: point.y + 18 },
    ]) {
      if (this.world.isSolidAtWorld(sample.x, sample.y)) return false;
    }
    for (const vehicle of this.vehicles.vehicles) {
      if (!vehicle.sprite.active || vehicle.isDestroyed) continue;
      if (distanceSq(point, vehicle.position) < 46 * 46) return false;
    }
    return true;
  }
}

function distanceSq(first: Vector2, second: Vector2): number {
  const dx = first.x - second.x;
  const dy = first.y - second.y;
  return dx * dx + dy * dy;
}
