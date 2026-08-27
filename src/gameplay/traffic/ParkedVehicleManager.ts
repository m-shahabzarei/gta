import type { Vector2 } from '@/core/types';
import { CIVILIAN_VEHICLE_KINDS, VEHICLES } from '@/data';
import type { Vehicle } from '@/entities/Vehicle';
import type { IWorldQuery, VehicleKind } from '@/gameplay/types';
import type { VehicleSystem } from '@/systems/VehicleSystem';
import type { Random } from '@/utils';
import type { TrafficNetwork } from './TrafficNetwork';
import type { ParkingSpace } from './TrafficTypes';
import { ServiceLocator } from '@/core/ServiceLocator';
import { ServiceKeys } from '@/config/ServiceKeys';

const TARGET_PARKED = 18;
const STREAM_INTERVAL_MS = 520;
const MIN_PLAYER_DISTANCE = 380;
const MAX_PLAYER_DISTANCE = 1080;
const DESPAWN_DISTANCE = 1480;
/** A real impact may displace a parked car; beyond this offset the bay is released. */
const MAX_PARKED_POSITION_DRIFT = 3;

interface ParkedRecord {
  readonly vehicle: Vehicle;
  readonly space: ParkingSpace;
}

/** Owns legal parking bays and all ambient parked-vehicle lifecycle decisions. */
export class ParkedVehicleManager {
  private readonly records = new Map<number, ParkedRecord>();
  private readonly occupiedSpaceIds = new Set<string>();
  /** Static bay geometry is cached so streaming never rescans lane geometry every frame. */
  private readonly eligibleKindsBySpaceId = new Map<string, readonly VehicleKind[]>();
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
    this.elapsedMs += deltaMs;
    if (this.elapsedMs < STREAM_INTERVAL_MS) return;
    this.elapsedMs = 0;
    // There are at most eighteen parked props. Auditing only at the existing
    // streaming cadence keeps this exact directed-lane geometry check out of
    // the per-frame traffic hot path.
    this.prune(player);
    if (!player || this.records.size >= TARGET_PARKED) return;
    const choices = this.network
      .parkingSpacesNear(player, MIN_PLAYER_DISTANCE, MAX_PLAYER_DISTANCE)
      .filter(
        (space) =>
          !this.occupiedSpaceIds.has(space.id) && this.eligibleKindsForSpace(space).length > 0,
      );
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
    this.eligibleKindsBySpaceId.clear();
    this.elapsedMs = 0;
  }

  private spawn(space: ParkingSpace): void {
    const kind = this.random.pick(this.eligibleKindsForSpace(space));
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
    vehicle.movement.setParkedDynamic(space.position.x, space.position.y, space.heading);
    this.records.set(vehicle.id, { vehicle, space });
    this.occupiedSpaceIds.add(space.id);
    this.recordLifecycle('spawn-accepted', vehicle.id, 'parked', null);
  }

  /** A bay may never receive a vehicle wider/longer than its real footprint. */
  private eligibleKindsForSpace(space: ParkingSpace): readonly VehicleKind[] {
    const cached = this.eligibleKindsBySpaceId.get(space.id);
    if (cached) return cached;
    const eligible = CIVILIAN_VEHICLE_KINDS.filter((kind) => {
      const definition = VEHICLES[kind];
      return (
        definition.width <= space.width &&
        definition.height <= space.length &&
        this.network.parkingSpaceHasTravelClearance(space, definition.width, definition.height)
      );
    });
    this.eligibleKindsBySpaceId.set(space.id, eligible);
    return eligible;
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
      if (!vehicle.sprite.active || vehicle.isDestroyed) {
        this.release(vehicleId, false);
        continue;
      }
      if (!this.isAtLegalParkingPose(record)) {
        // The vehicle remains a live world entity; only bay ownership is released.
        this.release(vehicleId, false);
        continue;
      }
      if (player && dx * dx + dy * dy > maxSq) {
        this.release(vehicleId, true);
      }
    }
  }

  /** A parked vehicle keeps bay ownership only while its impact offset remains in the bay. */
  private isAtLegalParkingPose(record: ParkedRecord): boolean {
    const { vehicle, space } = record;
    const dx = vehicle.sprite.x - space.position.x;
    const dy = vehicle.sprite.y - space.position.y;
    if (dx * dx + dy * dy > MAX_PARKED_POSITION_DRIFT * MAX_PARKED_POSITION_DRIFT) {
      return false;
    }
    return this.network.vehicleFootprintHasTravelClearance(
      vehicle.position,
      vehicle.movement.collisionHeading,
      vehicle.def.width,
      vehicle.def.height,
    );
  }

  private release(vehicleId: number, removeVehicle: boolean): void {
    const record = this.records.get(vehicleId);
    if (!record) return;
    this.records.delete(vehicleId);
    this.occupiedSpaceIds.delete(record.space.id);
    record.vehicle.sprite.data?.remove('parked');
    record.vehicle.sprite.data?.remove('parkingSpaceId');
    if (!removeVehicle) record.vehicle.movement.releaseParkedDynamic();
    if (removeVehicle) {
      this.recordLifecycle('despawn', record.vehicle.id, 'parked-prune', 'Parking');
      this.vehicles.removeVehicle(record.vehicle);
    }
  }

  private recordLifecycle(
    kind: 'spawn-accepted' | 'despawn',
    vehicleId: number,
    reason: string,
    state: 'Parking' | null,
  ): void {
    (
      ServiceLocator.tryResolve(ServiceKeys.Traffic) as {
        recordExternalLifecycle?(kind: 'spawn-accepted' | 'despawn', vehicleId: number, reason?: string | null, ownershipClass?: string, state?: 'Parking' | null): void;
      } | null
    )?.recordExternalLifecycle?.(kind, vehicleId, reason, 'parked', state);
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
