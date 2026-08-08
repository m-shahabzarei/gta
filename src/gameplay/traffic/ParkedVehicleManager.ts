import type { Vector2 } from '@/core/types';
import { CIVILIAN_VEHICLE_KINDS, VEHICLES } from '@/data';
import type { Vehicle } from '@/entities/Vehicle';
import type { IWorldQuery, VehicleKind } from '@/gameplay/types';
import type { VehicleSystem } from '@/systems/VehicleSystem';
import type { Random } from '@/utils';
import type { TrafficNetwork } from './TrafficNetwork';
import type { ParkingSpace } from './TrafficTypes';

const TARGET_PARKED = 18;
const STREAM_INTERVAL_MS = 520;
const MIN_PLAYER_DISTANCE = 380;
const MAX_PLAYER_DISTANCE = 1080;
const DESPAWN_DISTANCE = 1480;

interface ParkedRecord {
  readonly vehicle: Vehicle;
  readonly space: ParkingSpace;
}

/** Owns curb spaces and all ambient parked-vehicle lifecycle decisions. */
export class ParkedVehicleManager {
  private readonly records = new Map<number, ParkedRecord>();
  private readonly occupiedSpaceIds = new Set<string>();
  private elapsedMs = 0;

  constructor(
    private readonly network: TrafficNetwork,
    private readonly vehicles: VehicleSystem,
    private readonly world: IWorldQuery,
    private readonly random: Random,
  ) {}

  public get count(): number {
    return this.records.size;
  }

  public update(player: Vector2 | null, deltaMs: number): void {
    this.prune(player);
    this.elapsedMs += deltaMs;
    if (!player || this.elapsedMs < STREAM_INTERVAL_MS || this.records.size >= TARGET_PARKED) {
      return;
    }
    this.elapsedMs = 0;
    const choices = this.network
      .parkingSpacesNear(player, MIN_PLAYER_DISTANCE, MAX_PLAYER_DISTANCE)
      .filter((space) => !this.occupiedSpaceIds.has(space.id));
    for (let attempt = 0; attempt < Math.min(16, choices.length); attempt++) {
      const space = choices[Math.floor(this.random.next() * choices.length)];
      if (!space || !this.isLegalAndClear(space)) continue;
      this.spawn(space);
      return;
    }
  }

  public destroy(): void {
    this.records.clear();
    this.occupiedSpaceIds.clear();
    this.elapsedMs = 0;
  }

  private spawn(space: ParkingSpace): void {
    const kind = this.random.pick(CIVILIAN_VEHICLE_KINDS) as VehicleKind | undefined;
    if (!kind) return;
    const definition = VEHICLES[kind];
    const tint = this.random.pick(definition.tints);
    const vehicle = this.vehicles.spawnVehicle(
      kind,
      space.position.x,
      space.position.y,
      space.heading,
      tint,
      'standard',
    );
    vehicle.sprite.setData('parked', true);
    vehicle.sprite.setData('parkingSpaceId', space.id);
    vehicle.movement.stopImmediately();
    vehicle.movement.setTrafficAuthority(true);
    this.records.set(vehicle.id, { vehicle, space });
    this.occupiedSpaceIds.add(space.id);
  }

  private prune(player: Vector2 | null): void {
    const maxSq = DESPAWN_DISTANCE * DESPAWN_DISTANCE;
    for (const [vehicleId, record] of this.records) {
      const vehicle = record.vehicle;
      if (vehicle.isPlayerDriven) {
        vehicle.sprite.data?.remove('parked');
        vehicle.sprite.data?.remove('parkingSpaceId');
        this.release(vehicleId, false);
        continue;
      }
      const dx = player ? vehicle.sprite.x - player.x : 0;
      const dy = player ? vehicle.sprite.y - player.y : 0;
      if (!vehicle.sprite.active || vehicle.isDestroyed || (player && dx * dx + dy * dy > maxSq)) {
        this.release(vehicleId, vehicle.sprite.active && !vehicle.isDestroyed);
      }
    }
  }

  private release(vehicleId: number, removeVehicle: boolean): void {
    const record = this.records.get(vehicleId);
    if (!record) return;
    this.records.delete(vehicleId);
    this.occupiedSpaceIds.delete(record.space.id);
    if (removeVehicle) this.vehicles.removeVehicle(record.vehicle);
  }

  private isLegalAndClear(space: ParkingSpace): boolean {
    const forward = {
      x: space.position.x + Math.cos(space.heading) * space.length * 0.35,
      y: space.position.y + Math.sin(space.heading) * space.length * 0.35,
    };
    const rear = {
      x: space.position.x - Math.cos(space.heading) * space.length * 0.35,
      y: space.position.y - Math.sin(space.heading) * space.length * 0.35,
    };
    if (
      !this.world.isDrivableAtWorld(space.position.x, space.position.y) ||
      !this.world.isDrivableAtWorld(forward.x, forward.y) ||
      !this.world.isDrivableAtWorld(rear.x, rear.y)
    ) {
      return false;
    }
    for (const vehicle of this.vehicles.vehicles) {
      if (!vehicle.sprite.active || vehicle.isDestroyed) continue;
      const dx = vehicle.sprite.x - space.position.x;
      const dy = vehicle.sprite.y - space.position.y;
      if (dx * dx + dy * dy < 58 * 58) return false;
    }
    return true;
  }
}
