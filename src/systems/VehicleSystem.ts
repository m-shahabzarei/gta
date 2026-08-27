/**
 * Vehicle system: the single registry and lifecycle owner for every vehicle in
 * the world.
 *
 * On attach it builds a physics group and seeds a handful of parked civilian
 * cars on the road network (sampled through the world query service) for the
 * player to steal. Other systems — traffic AI, the wanted system — spawn their
 * own vehicles through {@link spawnVehicle}, so every car in play lives in this
 * one registry and group. Each frame it ticks every vehicle, sweeps away wrecks
 * a few seconds after they explode, and despawns unoccupied cars that have
 * drifted far from the player to keep the active set bounded.
 */
import Phaser from 'phaser';
import { BaseSceneManager } from '@/core/BaseSceneManager';
import { ServiceLocator } from '@/core/ServiceLocator';
import { ServiceKeys } from '@/config/ServiceKeys';
import { ENGINE_LIMITS } from '@/config/EngineLimits';
import { EngineDiagnostics } from '@/core/EngineDiagnostics';
import { Vehicle } from '@/entities/Vehicle';
import { VEHICLES } from '@/data';
import { getPlayerRef, type VehicleKind } from '@/gameplay/types';
import { EntityCategory, type EntityManager } from '@/systems/EntityManager';
import type { TrafficAIComponent } from '@/entities/components';
import { EventKeys } from '@/config/EventKeys';
import {
  VehicleCollisionRuntime,
  type VehicleCollisionTelemetrySnapshot,
} from '@/gameplay/vehicle';

/** Delay (ms) after a vehicle explodes before its wreck is removed. */
const WRECK_REMOVE_DELAY_MS = 5000;

/** Distance (px) from the player beyond which idle vehicles are despawned. */
const DESPAWN_RADIUS = 1450;

/** Squared despawn radius, precomputed to avoid per-vehicle square roots. */
const DESPAWN_RADIUS_SQ = DESPAWN_RADIUS * DESPAWN_RADIUS;
const MAX_VEHICLE_REMOVALS_PER_FRAME = 6;
const VEHICLE_POOL_LIMIT = 160;

/** Ownership that may only be retired by its dedicated gameplay system. */
function hasProtectedVehicleOwnership(vehicle: Vehicle): boolean {
  const sprite = vehicle.sprite;
  return (
    vehicle.def.isEmergency ||
    sprite.getData('policeResponseActive') === true ||
    sprite.getData('persistentTransitService') === true ||
    sprite.getData('missionVehicle') === true ||
    sprite.getData('missionId') !== undefined ||
    sprite.getData('missionOwnerId') !== undefined ||
    typeof sprite.getData('snappBookingId') === 'string' ||
    sprite.getData('intercityService') === true
  );
}

export type VehiclePoolClass = 'standard' | 'traffic';
export type PersistentTransitServiceKind = 'bus' | 'taxi';

export class VehicleSystem extends BaseSceneManager {
  /** Service-locator key for this system. */
  public readonly key = ServiceKeys.Vehicle;

  /** Live registry of every vehicle this system owns. */
  private readonly registry: Vehicle[] = [];
  private readonly collisionRuntime = new VehicleCollisionRuntime(() => this.registry);
  private readonly vehiclePool = new Map<string, Vehicle[]>();
  private pooledVehicleCount = 0;

  /** Wall-clock time (ms) at which each destroyed vehicle first became a wreck. */
  private readonly wreckTimers = new Map<number, number>();

  /** Physics group holding every vehicle sprite; created per scene attach. */
  private vehicleGroup!: Phaser.Physics.Arcade.Group;

  /** The physics group containing every vehicle sprite. */
  public get group(): Phaser.Physics.Arcade.Group {
    return this.vehicleGroup;
  }

  /** Read-only live vehicle registry. Callers must not mutate it. */
  public get vehicles(): readonly Vehicle[] {
    return this.registry;
  }

  /** Iterate live registry without allocating a snapshot. */
  public forEachVehicle(visitor: (vehicle: Vehicle) => void): void {
    for (const vehicle of this.registry) visitor(vehicle);
  }

  /** Read-only custom collision telemetry for traffic aggregation and debug tools. */
  public collisionTelemetrySnapshot(): VehicleCollisionTelemetrySnapshot {
    return this.collisionRuntime.snapshot();
  }

  public recordImpactRecovery(durationSeconds: number, failed: boolean): void {
    this.collisionRuntime.recordRecovery(durationSeconds, failed);
  }

  /**
   * Keep a route-owned bus or taxi registered while it is outside the camera.
   * Their traffic driver still uses distance-based simulation; this only keeps
   * the entity scheduler's spatial record synchronized so a player can meet
   * the actual vehicle instead of its obsolete off-screen pose.
   */
  public markPersistentTransitService(
    vehicle: Vehicle,
    serviceKind: PersistentTransitServiceKind,
  ): void {
    if (vehicle.isDestroyed || !vehicle.sprite.active) return;
    vehicle.sprite.setData('persistentTransitService', true);
    vehicle.sprite.setData('transitServiceKind', serviceKind);
    this.resolveEntityManager()?.setAlwaysActive(vehicle, true);
  }

  /** Game-level initialisation; all state is scene-scoped, so this is a no-op. */
  protected override onInit(): void {
    // Intentionally empty: vehicles are created on scene attach.
  }

  /**
   * Spawn a vehicle, register it, and add its sprite to the group.
   * @param kind Which vehicle definition to instantiate.
   * @param x Initial world x in pixels.
   * @param y Initial world y in pixels.
   * @param heading Facing angle in radians (0 = east).
   * @param tint Optional palette tint applied to the sprite.
   * @returns The newly created vehicle.
   */
  public spawnVehicle(
    kind: VehicleKind,
    x: number,
    y: number,
    heading: number,
    tint?: number,
    poolClass: VehiclePoolClass = 'standard',
  ): Vehicle {
    this.enforceVehicleLimitBeforeSpawn();
    const def = VEHICLES[kind];
    const poolKey = `${kind}:${poolClass}`;
    const bucket = this.vehiclePool.get(poolKey);
    const pooled = bucket?.pop();
    if (pooled) this.pooledVehicleCount -= 1;
    const vehicle = pooled ?? new Vehicle(this.scene as Phaser.Scene, x, y, def, tint);
    if (pooled) {
      vehicle.resetForReuse(x, y, heading, tint);
      (
        ServiceLocator.tryResolve(ServiceKeys.Traffic) as {
          recordExternalLifecycle?(kind: 'pool-reuse', vehicleId: number, reason?: string | null): void;
        } | null
      )?.recordExternalLifecycle?.('pool-reuse', vehicle.id, poolKey);
    }

    // Textures face up (toward -Y) at rotation 0, so add a quarter turn.
    vehicle.sprite.setRotation(heading + Math.PI / 2);
    // New entities attach their movement component before this spawn method
    // receives the lane/parking heading. Keeping the simulation heading in
    // sync with the rendered pose is essential for parked-body clearance and
    // traffic collision prediction; otherwise a correctly parked vehicle is
    // treated as if its long axis were rotated ninety degrees into the lane.
    vehicle.movement.reset(heading);
    vehicle.sprite.setData('poolClass', poolClass);

    this.vehicleGroup.add(vehicle.sprite);
    this.registry.push(vehicle);
    this.resolveEntityManager()?.register(vehicle, {
      category: EntityCategory.Vehicle,
      updateFull: (time, delta) => this.updateScheduledVehicle(vehicle, time, delta),
      updateMovement: (time, delta) => this.updateScheduledVehicle(vehicle, time, delta),
      updateSimple: (time, delta) => this.updateLightweightVehicle(vehicle, time, delta),
      updateVeryFar: (time, delta) => this.updateLightweightVehicle(vehicle, time, delta),
    });
    this.bus.emit(EventKeys.VehicleSpawned, { vehicleId: vehicle.id, kind });
    return vehicle;
  }

  /**
   * Find the nearest non-destroyed vehicle within `range`, excluding the one the
   * player is currently driving.
   * @param x Query world x in pixels.
   * @param y Query world y in pixels.
   * @param range Maximum search distance in pixels.
   * @returns The closest candidate vehicle, or `null` when none qualify.
   */
  public nearestVehicle(x: number, y: number, range: number): Vehicle | null {
    const rangeSq = range * range;
    let best: Vehicle | null = null;
    let bestSq = rangeSq;

    const entities = this.resolveEntityManager();
    if (entities) {
      entities.forEachNearby(
        x,
        y,
        range,
        (entity, distanceSq) => {
          if (!(entity instanceof Vehicle) || entity.isDestroyed || entity.isPlayerDriven) return;
          if (distanceSq <= bestSq) {
            best = entity;
            bestSq = distanceSq;
          }
        },
        EntityCategory.Vehicle,
      );
      return best;
    }

    for (const vehicle of this.registry) {
      if (vehicle.isDestroyed || vehicle.isPlayerDriven) {
        continue;
      }
      const dx = vehicle.sprite.x - x;
      const dy = vehicle.sprite.y - y;
      const distSq = dx * dx + dy * dy;
      if (distSq <= bestSq) {
        best = vehicle;
        bestSq = distSq;
      }
    }
    return best;
  }

  /**
   * Remove a vehicle from the registry and group and destroy it.
   * @param vehicle The vehicle to remove.
   */
  public removeVehicle(vehicle: Vehicle): void {
    const index = this.registry.indexOf(vehicle);
    if (index === -1) {
      return;
    }
    this.collisionRuntime.forgetVehicle(vehicle);
    const last = this.registry.pop();
    if (last && index < this.registry.length) this.registry[index] = last;
    this.wreckTimers.delete(vehicle.id);
    this.bus.emit(EventKeys.VehicleRemoved, { vehicleId: vehicle.id });
    this.resolveEntityManager()?.unregister(vehicle);
    (
      ServiceLocator.tryResolve(ServiceKeys.Traffic) as {
        noteVehicleSystemRemoval?(vehicleId: number): void;
      } | null
    )?.noteVehicleSystemRemoval?.(vehicle.id);
    (
      ServiceLocator.tryResolve(ServiceKeys.Traffic) as {
        releaseDriver?(vehicleId: number): void;
      } | null
    )?.releaseDriver?.(vehicle.id);
    this.vehicleGroup.remove(vehicle.sprite, false, false);
    this.recycleVehicle(vehicle);
  }

  /**
   * Per-frame tick: advance every vehicle, then remove wrecks whose linger time
   * has elapsed and despawn idle vehicles that have strayed far from the player.
   * @param time Total elapsed time in ms.
   * @param delta Frame delta in ms.
   */
  public update(time: number, delta: number): void {
    // This is the pre-Arcade pose capture. Resolution occurs only at WORLD_STEP.
    this.collisionRuntime.capturePreviousPoses();
    const playerPos = getPlayerRef()?.playerPosition ?? null;

    const stale: Vehicle[] = [];

    for (const vehicle of this.registry) {
      if (vehicle.isDestroyed) {
        const since = this.wreckTimers.get(vehicle.id);
        if (since === undefined) {
          this.wreckTimers.set(vehicle.id, time);
        } else if (time - since >= WRECK_REMOVE_DELAY_MS) {
          stale.push(vehicle);
        }
        continue;
      }

      // Scheduled buses and taxis own route, passenger, and paid-trip state.
      // TrafficSystem already applies its regular distance-based driver LOD;
      // generic vehicle cleanup must not erase that service state.
      if (
        hasProtectedVehicleOwnership(vehicle) ||
        vehicle.movement.dynamics.impactState !== 'None'
      ) {
        continue;
      }

      if (playerPos && !vehicle.isPlayerDriven) {
        const dx = vehicle.sprite.x - playerPos.x;
        const dy = vehicle.sprite.y - playerPos.y;
        if (dx * dx + dy * dy > DESPAWN_RADIUS_SQ) {
          stale.push(vehicle);
        }
      }
    }

    for (const vehicle of stale.slice(0, MAX_VEHICLE_REMOVALS_PER_FRAME)) {
      this.removeVehicle(vehicle);
    }

    void delta;
  }

  /**
   * Create the vehicle group and seed the world with parked civilian cars.
   * @param scene The scene this system is binding to.
   */
  protected override onAttach(scene: Phaser.Scene): void {
    this.vehicleGroup = scene.physics.add.group();
    this.collisionRuntime.attach(scene);
  }

  /** Destroy every registered vehicle and clear scene-scoped state. */
  protected override onDetach(_scene: Phaser.Scene): void {
    this.collisionRuntime.detach();
    for (const vehicle of this.registry) {
      this.resolveEntityManager()?.unregister(vehicle);
      vehicle.destroy();
    }
    this.registry.length = 0;
    for (const bucket of this.vehiclePool.values()) {
      for (const vehicle of bucket) vehicle.destroy();
    }
    this.vehiclePool.clear();
    this.pooledVehicleCount = 0;
    this.wreckTimers.clear();
  }

  /** Far traffic keeps its coarse trajectory without AI, physics or avoidance. */
  private updateLightweightVehicle(vehicle: Vehicle, time: number, delta: number): void {
    vehicle.updateComponents(time, delta, ['health']);
    if (vehicle.isDestroyed || vehicle.isPlayerDriven) return;
    const trafficAi = vehicle.getComponent<TrafficAIComponent>('ai');
    if (trafficAi) {
      trafficAi.updateCoarse(time, delta);
      return;
    }
    const speed = vehicle.movement.speed;
    if (Math.abs(speed) < 0.01) return;
    const dt = Math.min(1, delta / 1000);
    const heading = vehicle.movement.heading;
    vehicle.sprite.setPosition(
      vehicle.sprite.x + Math.cos(heading) * speed * dt,
      vehicle.sprite.y + Math.sin(heading) * speed * dt,
    );
    vehicle.sprite.rotation = heading + Math.PI / 2;
  }

  /** Near and medium traffic keep normal movement/animation while the entity scheduler sets cadence. */
  private updateScheduledVehicle(vehicle: Vehicle, time: number, delta: number): void {
    vehicle.update(time, delta);
  }

  private resolveEntityManager(): EntityManager | null {
    return ServiceLocator.tryResolve<EntityManager>(ServiceKeys.Entity);
  }

  private enforceVehicleLimitBeforeSpawn(): void {
    if (this.registry.length < ENGINE_LIMITS.MAX_ACTIVE_VEHICLES) return;
    const victim = this.registry.find((vehicle) => !vehicle.isPlayerDriven);
    if (!victim) {
      EngineDiagnostics.recordLimitExceeded(
        'MAX_ACTIVE_VEHICLES',
        this.registry.length + 1,
        ENGINE_LIMITS.MAX_ACTIVE_VEHICLES,
        'vehicle-spawn-over-limit-no-recoverable-victim',
        'VehicleSystem',
      );
      return;
    }
    EngineDiagnostics.recordLimitExceeded(
      'MAX_ACTIVE_VEHICLES',
      this.registry.length + 1,
      ENGINE_LIMITS.MAX_ACTIVE_VEHICLES,
      'retired-old-vehicle-before-spawn',
      `vehicle:${victim.id}`,
    );
    this.removeVehicle(victim);
  }

  private recycleVehicle(vehicle: Vehicle): void {
    const poolClass = vehicle.sprite.getData('poolClass') as VehiclePoolClass | undefined;
    const canPool =
      poolClass === 'traffic' || (poolClass === 'standard' && !vehicle.hasComponent('ai'));
    if (!canPool || this.pooledVehicleCount >= VEHICLE_POOL_LIMIT) {
      vehicle.destroy();
      return;
    }
    const key = `${vehicle.def.kind}:${poolClass}`;
    vehicle.deactivateForPool();
    let bucket = this.vehiclePool.get(key);
    if (!bucket) {
      bucket = [];
      this.vehiclePool.set(key, bucket);
    }
    bucket.push(vehicle);
    this.pooledVehicleCount += 1;
  }
}
