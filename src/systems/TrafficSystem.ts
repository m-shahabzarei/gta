import Phaser from 'phaser';
import { BaseSceneManager } from '@/core/BaseSceneManager';
import { ServiceLocator } from '@/core/ServiceLocator';
import { ServiceKeys } from '@/config/ServiceKeys';
import { EventKeys } from '@/config/EventKeys';
import { DepthLayers } from '@/config/DepthLayers';
import { TextureKeys } from '@/config/AssetKeys';
import { VEHICLE } from '@/config/Constants';
import { ENGINE_LIMITS } from '@/config/EngineLimits';
import { EngineDiagnostics } from '@/core/EngineDiagnostics';
import type { Vector2 } from '@/core/types';
import { getPlayerRef } from '@/gameplay/types';
import type { ITrafficQuery, IWorldQuery, MapData, VehicleKind } from '@/gameplay/types';
import {
  IntersectionReservationController,
  MajorBuildingServiceParking,
  ParkedVehicleManager,
  TrafficDebugOverlay,
  TrafficDriver,
  TrafficNetwork,
  TrafficPerceptionIndex,
  TrafficUpdateScheduler,
  TrafficValidator,
  type TemporaryTrafficObstacle,
  type TrafficDebugSnapshot,
  type TrafficLane,
  type TrafficLaneStopTarget,
  type TrafficRuntimeStats,
  type TrafficSimulationDetail,
  type TrafficValidationReport,
} from '@/gameplay/traffic';
import { sampleSpline, wrapAngle } from '@/gameplay/traffic/SplineMath';
import type { Vehicle } from '@/entities/Vehicle';
import { TrafficAIComponent } from '@/entities/components';
import type { VehicleSystem } from '@/systems/VehicleSystem';
import { EntityCategory, type EntityManager } from '@/systems/EntityManager';
import { CIVILIAN_VEHICLE_KINDS, VEHICLES } from '@/data';
import { Random } from '@/utils';
import { responseProfileForLevel } from '@/gameplay/police/PoliceResponseRules';
import type { TrafficRoutePreview } from '@/gameplay/transit';

interface IWorldRef extends IWorldQuery {
  readonly map: MapData;
  trafficDensityAt?(x: number, y: number): number;
  cityAt?(x: number, y: number): { id: string } | null;
}

interface TrafficLightSprite {
  readonly sprite: Phaser.GameObjects.Image;
  readonly northSouth: boolean;
  readonly intersectionId: number;
}

/** Projection noise tolerated before an exact same-lane stop requires a legal loop. */
const EXACT_LANE_STOP_BEHIND_EPSILON_PX = 2;

interface SpawnPose {
  readonly lane: TrafficLane;
  readonly distance: number;
  readonly point: Vector2;
  readonly heading: number;
}

interface VirtualTrafficRecord {
  readonly id: number;
  readonly kind: VehicleKind;
  readonly tint: number;
  readonly targetProvider: (() => Vector2 | null) | null;
  readonly stopRange: number;
  lane: TrafficLane;
  distance: number;
  speed: number;
}

const FIXED_STEP_MS = 50;
const MAX_STEPS_PER_FRAME = 5;
const LIGHT_STREAM_RADIUS = 1480;
const LIGHT_STREAM_CELL = 1024;
const AMBIENT_SPAWN_MIN_DISTANCE = 520;
const AMBIENT_SPAWN_MAX_DISTANCE = 940;
const DESPAWN_DISTANCE = 1480;
const VIRTUALIZE_DISTANCE = 1220;
const VIRTUAL_MATERIALIZE_DISTANCE = 1060;
const VIRTUAL_RETIRE_DISTANCE = 2300;
const VIRTUAL_STEP_MS = 250;
const SPAWN_INTERVAL_MS = 210;
const SPAWN_ATTEMPTS = 24;
const SPAWN_FRONT_CLEARANCE = 118;
const SPAWN_REAR_CLEARANCE = 70;
const INTERCITY_SERVICE_MS = 18000;
const LIGHT_GREEN = 0x4ade80;
const LIGHT_YELLOW = 0xfacc15;
const LIGHT_RED = 0xef4444;

const TRAFFIC_KINDS: readonly VehicleKind[] = [
  ...CIVILIAN_VEHICLE_KINDS,
  'taxi',
  'delivery',
  'bus',
  'motorcycle',
  'bicycle',
  'police',
  'ambulance',
  'fireTruck',
];

/** Central fixed-step owner for every autonomous road vehicle. */
export class TrafficSystem extends BaseSceneManager implements ITrafficQuery {
  public readonly key = ServiceKeys.Traffic;

  private readonly rng = new Random();
  private readonly trafficCars = new Set<Vehicle>();
  private readonly drivers = new Map<number, TrafficDriver>();
  private readonly blockedDriverIds = new Set<number>();
  private readonly lights: TrafficLightSprite[] = [];
  private readonly temporaryObstacles = new Map<string, TemporaryTrafficObstacle>();
  private readonly pendingDespawns = new Map<number, string>();
  /** Persistent bus/taxi recovery requests consumed by TransportationSystem. */
  private readonly pendingServiceRecoveries = new Map<number, string>();
  private readonly virtualTraffic = new Map<number, VirtualTrafficRecord>();
  private readonly virtualMaterializeQueue: VirtualTrafficRecord[] = [];
  private readonly perception = new TrafficPerceptionIndex();
  private readonly scheduler = new TrafficUpdateScheduler();
  private readonly statsValue: TrafficRuntimeStats = {
    activeDrivers: 0,
    parkedVehicles: 0,
    queuedVehicles: 0,
    routeCacheHits: 0,
    routeCacheMisses: 0,
    reservationsGranted: 0,
    reservationsDenied: 0,
    emergencyBrakes: 0,
    recoveries: 0,
    blockedDrivers: 0,
    safeSpawnRejects: 0,
    validationFailures: 0,
    trafficCpuMs: 0,
    navigationCpuMs: 0,
    steeringCpuMs: 0,
    collisionCpuMs: 0,
    simulatedVehicles: 0,
    virtualVehicles: 0,
    nearSimulationVehicles: 0,
    mediumSimulationVehicles: 0,
    farSimulationVehicles: 0,
    frozenSimulationVehicles: 0,
    averageAiUpdateHz: 0,
    schedulerLoad: 0,
    schedulerDeferredUpdates: 0,
    frameTimeMs: 0,
  };

  private world: IWorldRef | null = null;
  private vehicleSystem: VehicleSystem | null = null;
  private entityManager: EntityManager | null = null;
  private network: TrafficNetwork | null = null;
  private intersections: IntersectionReservationController | null = null;
  private parking: ParkedVehicleManager | null = null;
  private serviceParking: MajorBuildingServiceParking | null = null;
  private validator: TrafficValidator | null = null;
  private debugOverlay: TrafficDebugOverlay | null = null;
  private lightsAnchor = '';
  private spawnElapsedMs = 0;
  private intercityElapsedMs = 0;
  private intercityIndex = 0;
  private accumulatorMs = 0;
  private simulationClockMs = 0;
  private virtualElapsedMs = 0;
  private nextVirtualTrafficId = 1;
  private cityAlertUrgency = 0;

  public get northSouthGreen(): boolean {
    return this.intersections?.northSouthGreen ?? true;
  }

  public get trafficStats(): Readonly<TrafficRuntimeStats> {
    return this.statsValue;
  }

  public get validationReport(): TrafficValidationReport {
    return this.validator?.report ?? { passed: true, checkedVehicles: 0, failures: [] };
  }

  /** Read-only access for systems that need to validate lane-backed authored data. */
  public get roadNetwork(): TrafficNetwork | null {
    return this.network;
  }

  /**
   * Summarise a legal cached lane route without creating a second navigator.
   * Transit, map quotes, and diagnostics all consume this same graph query.
   */
  public routePreview(from: Vector2, to: Vector2): TrafficRoutePreview | null {
    const network = this.network;
    if (!network) return null;
    const start = network.nearestLane(from, undefined, true);
    const goal = network.nearestLane(to, undefined, true);
    if (!start || !goal) return null;
    // Player fares, destination previews, and authored bus lines need a
    // complete route. Ambient drivers continue using their sliced replan API.
    const route = network.findCompleteRoute(start.id, goal.id);
    if (!route || route.length === 0) return null;

    const startDistance = network.projectPoint(from, start).distance;
    const goalDistance = network.projectPoint(to, goal).distance;
    let distancePx = 0;
    if (route.length === 1) {
      distancePx = Math.max(0, goalDistance - startDistance);
    } else {
      for (let index = 0; index < route.length; index++) {
        const lane = route[index];
        if (!lane) continue;
        if (index === 0) distancePx += Math.max(0, lane.spline.length - startDistance);
        else if (index === route.length - 1) distancePx += Math.max(0, goalDistance);
        else distancePx += lane.spline.length;
      }
    }
    return {
      laneIds: route.map((lane) => lane.id),
      distancePx,
      start: { x: from.x, y: from.y },
      end: { x: to.x, y: to.y },
    };
  }

  /**
   * Resolve a route to one exact directed lane arc. Service coordinators use
   * this when a curb has already been accepted and must not be rebound to a
   * visually nearby lane by a generic nearest-lane query.
   */
  public routePreviewToLaneStop(
    from: Vector2,
    target: TrafficLaneStopTarget,
  ): TrafficRoutePreview | null {
    const network = this.network;
    if (!network) return null;
    const start = network.nearestLane(from, undefined, true);
    return start
      ? this.routePreviewFromLaneToLaneStop(from, start.id, network.projectPoint(from, start).distance, target)
      : null;
  }

  /**
   * Exact-stop preview using a caller-provided directed lane pose. This is
   * used after a passenger boards, where the driver's actual lane is more
   * authoritative than a nearest-lane spatial query at an intersection.
   */
  public routePreviewFromLaneToLaneStop(
    from: Vector2,
    startLaneId: string,
    startLaneDistance: number,
    target: TrafficLaneStopTarget,
  ): TrafficRoutePreview | null {
    const network = this.network;
    if (!network) return null;
    const goal = network.lane(target.laneId);
    const start = network.lane(startLaneId);
    // Recovery can legitimately observe the vehicle on a connector between
    // two travel lanes. The authored route still starts at that exact lane;
    // only the final curb target must be a travel lane.
    if (!start || !goal || goal.kind !== 'travel') return null;
    let route = network.findCompleteRoute(start.id, goal.id);
    if (!route || route.length === 0) return null;
    const clampedStartDistance = Phaser.Math.Clamp(startLaneDistance, 0, start.spline.length);
    const goalDistance = Phaser.Math.Clamp(target.laneDistance, 0, goal.spline.length);

    // A zero-edge start->goal route is not drivable when the exact curb arc is
    // already behind a vehicle on the same directed lane. Build the shortest
    // legal cycle back to that lane instead; otherwise the service driver sees
    // a negative remaining distance and can stop forever without approaching
    // the stored pickup anchor.
    if (
      start.id === goal.id &&
      goalDistance < clampedStartDistance - EXACT_LANE_STOP_BEHIND_EPSILON_PX
    ) {
      let cycle: readonly TrafficLane[] | null = null;
      let cycleDistance = Infinity;
      for (const connectionId of start.connectionIds) {
        const returnRoute = network.findCompleteRoute(connectionId, goal.id);
        if (!returnRoute || returnRoute.length === 0) continue;
        const candidate = [start, ...returnRoute];
        let candidateDistance = Math.max(0, start.spline.length - clampedStartDistance);
        for (let index = 1; index < candidate.length; index += 1) {
          const lane = candidate[index];
          if (!lane) continue;
          candidateDistance += index === candidate.length - 1
            ? goalDistance
            : lane.spline.length;
        }
        if (candidateDistance < cycleDistance) {
          cycle = candidate;
          cycleDistance = candidateDistance;
        }
      }
      route = cycle;
      if (!route) return null;
    }
    let distancePx = 0;
    if (route.length === 1) {
      distancePx = Math.max(0, goalDistance - clampedStartDistance);
    } else {
      for (let index = 0; index < route.length; index += 1) {
        const lane = route[index];
        if (!lane) continue;
        if (index === 0) distancePx += Math.max(0, lane.spline.length - clampedStartDistance);
        else if (index === route.length - 1) distancePx += goalDistance;
        else distancePx += lane.spline.length;
      }
    }
    return {
      laneIds: route.map((lane) => lane.id),
      distancePx,
      start: { x: from.x, y: from.y },
      end: { ...target.position },
    };
  }

  protected override onInit(): void {
    this.subscribe(EventKeys.WantedChanged, ({ level }) => {
      this.cityAlertUrgency = responseProfileForLevel(level).trafficPanic;
      for (const driver of this.drivers.values()) driver.setCityAlert(this.cityAlertUrgency);
    });
  }

  protected override onAttach(scene: Phaser.Scene): void {
    this.resolveServices();
    this.ensureRuntime();
    this.simulationClockMs = scene.time.now;
    this.refreshLightSprites(scene);
    this.debugOverlay = new TrafficDebugOverlay(scene, this);
  }

  protected override onDetach(_scene: Phaser.Scene): void {
    for (const light of this.lights) light.sprite.destroy();
    this.lights.length = 0;
    this.debugOverlay?.destroy();
    this.debugOverlay = null;
    for (const driver of this.drivers.values()) driver.destroy();
    this.drivers.clear();
    this.trafficCars.clear();
    this.blockedDriverIds.clear();
    this.temporaryObstacles.clear();
    this.pendingDespawns.clear();
    this.pendingServiceRecoveries.clear();
    this.virtualTraffic.clear();
    this.virtualMaterializeQueue.length = 0;
    this.perception.clear();
    this.scheduler.clear();
    this.parking?.destroy();
    this.parking = null;
    this.serviceParking?.destroy();
    this.serviceParking = null;
    this.validator?.clear();
    this.validator = null;
    this.intersections?.clear();
    this.intersections = null;
    this.network = null;
    this.world = null;
    this.vehicleSystem = null;
    this.entityManager = null;
    this.lightsAnchor = '';
    this.spawnElapsedMs = 0;
    this.intercityElapsedMs = 0;
    this.intercityIndex = 0;
    this.accumulatorMs = 0;
    this.simulationClockMs = 0;
    this.virtualElapsedMs = 0;
    this.nextVirtualTrafficId = 1;
    this.cityAlertUrgency = 0;
    this.resetStats();
  }

  public update(time: number, delta: number): void {
    const scene = this.scene;
    if (!scene) return;
    this.resolveServices();
    this.ensureRuntime();
    this.pruneExpiredObstacles(time);
    const player = getPlayerRef()?.playerPosition ?? null;
    this.maintainPopulation(player, delta);
    this.updateVirtualTraffic(player, delta);

    this.accumulatorMs += Math.min(delta, FIXED_STEP_MS * MAX_STEPS_PER_FRAME);
    let steps = 0;
    while (this.accumulatorMs >= FIXED_STEP_MS && steps < MAX_STEPS_PER_FRAME) {
      this.simulationClockMs += FIXED_STEP_MS;
      this.simulateFixedStep(this.simulationClockMs, FIXED_STEP_MS / 1000);
      this.accumulatorMs -= FIXED_STEP_MS;
      steps += 1;
    }
    const interpolation = this.accumulatorMs / FIXED_STEP_MS;
    for (const driver of this.drivers.values()) driver.render(interpolation);
    this.processPendingDespawns();
    this.parking?.update(player, delta);
    this.serviceParking?.update(player, delta);
    this.validator?.update(time, delta, this.drivers.values());
    this.refreshLightSprites(scene);
    this.refreshLightTints();
    this.collectRuntimeStats(delta);
    this.debugOverlay?.update(delta);
  }

  /** Advance only assigned Snapp traffic while the Phone modal is open. */
  public updateWhilePhoneOpen(time: number, delta: number): void {
    const scene = this.scene;
    if (!scene) return;
    this.resolveServices();
    this.ensureRuntime();
    this.accumulatorMs += Math.min(delta, FIXED_STEP_MS * MAX_STEPS_PER_FRAME);
    const snappOnly = (driver: TrafficDriver): boolean => {
      const vehicleId = driver.snapshot()?.vehicleId;
      return vehicleId !== undefined && this.vehicleSystem?.vehicles.some(
        (vehicle) => vehicle.id === vehicleId && typeof vehicle.sprite.getData('snappBookingId') === 'string',
      ) === true;
    };
    let steps = 0;
    while (this.accumulatorMs >= FIXED_STEP_MS && steps < MAX_STEPS_PER_FRAME) {
      this.simulationClockMs += FIXED_STEP_MS;
      this.simulateFixedStep(this.simulationClockMs, FIXED_STEP_MS / 1000, snappOnly);
      this.accumulatorMs -= FIXED_STEP_MS;
      steps += 1;
    }
    const interpolation = this.accumulatorMs / FIXED_STEP_MS;
    for (const driver of this.drivers.values()) {
      if (snappOnly(driver)) driver.render(interpolation);
    }
    // Process only the assigned Snapp driver's bounded despawn/recovery work
    // during the phone tick. Leaving this queue untouched until the phone
    // closes can otherwise turn a legitimate recovery request into a visible
    // frozen taxi on the next normal frame, while processing the full queue
    // here would advance unrelated transit services behind the modal.
    this.processPendingDespawns((vehicle) => typeof vehicle.sprite.getData('snappBookingId') === 'string');
    void time;
  }

  /** Legacy component endpoint now registers configuration; it never advances simulation. */
  public advanceDriver(
    vehicle: Vehicle,
    targetProvider: (() => Vector2 | null) | null,
    stopRange: number,
    stopped: boolean,
    _time: number,
    _delta: number,
    _detail: TrafficSimulationDetail,
  ): void {
    this.configureDriver(vehicle, targetProvider, stopRange, stopped);
  }

  public configureDriver(
    vehicle: Vehicle,
    targetProvider: (() => Vector2 | null) | null,
    stopRange: number,
    stopped = false,
  ): void {
    const driver = this.ensureDriver(vehicle, targetProvider, stopRange);
    if (!driver) return;
    driver.configureLaneStopTarget(null);
    driver.configure(targetProvider, stopRange);
    driver.setStopped(stopped);
  }

  /**
   * Route a service to a named directed lane and exact curb arc. Unlike the
   * generic target API, this never infers a goal lane from nearby coordinates.
   */
  public configureDriverAtLaneStop(
    vehicle: Vehicle,
    targetProvider: (() => Vector2 | null) | null,
    target: TrafficLaneStopTarget,
    stopRange: number,
    stopped = false,
    plannedLaneIds: readonly string[] | null = null,
  ): boolean {
    const driver = this.ensureDriver(vehicle, targetProvider, stopRange);
    if (!driver) return false;
    if (!this.validatePlannedLaneRoute(driver.debug.laneId, target.laneId, plannedLaneIds)) {
      return false;
    }
    driver.configure(targetProvider, stopRange);
    if (!driver.configureLaneStopTarget(target)) return false;
    if (!driver.configurePlannedRoute(plannedLaneIds)) return false;
    driver.setStopped(stopped);
    return true;
  }

  /** Validate an authored route before mutating the driver's target or state. */
  private validatePlannedLaneRoute(
    currentLaneId: string | null,
    targetLaneId: string,
    plannedLaneIds: readonly string[] | null,
  ): boolean {
    if (plannedLaneIds === null) return true;
    if (plannedLaneIds.length === 0 || currentLaneId === null || plannedLaneIds[0] !== currentLaneId) {
      return false;
    }
    if (plannedLaneIds[plannedLaneIds.length - 1] !== targetLaneId) return false;
    for (let index = 0; index < plannedLaneIds.length; index += 1) {
      const lane = this.network?.lane(plannedLaneIds[index] ?? '');
      if (!lane) return false;
      const nextId = plannedLaneIds[index + 1];
      if (nextId !== undefined && !lane.connectionIds.includes(nextId)) return false;
    }
    return true;
  }

  public setDriverStopped(vehicle: Vehicle, stopped: boolean): void {
    this.drivers.get(vehicle.id)?.setStopped(stopped);
  }

  /** Consume one generic-driver failure that must be handled by a service state machine. */
  public consumeServiceRecovery(vehicleId: number): string | null {
    const reason = this.pendingServiceRecoveries.get(vehicleId) ?? null;
    if (reason !== null) this.pendingServiceRecoveries.delete(vehicleId);
    return reason;
  }

  /** Release a held service driver so its owner can install a fresh lane target/path. */
  public resumeServiceDriver(vehicle: Vehicle): void {
    this.drivers.get(vehicle.id)?.resumeFromServiceRecovery();
  }

  /**
   * A scheduled service may request a safe recovery lane change after a
   * confirmed stationary vehicle blocks its current leg. The driver retains
   * normal collision and lane-clearance validation; this only changes the
   * existing recovery policy from "wait forever" to a legal alternate lane.
   */
  public requestServiceRecoveryLaneChange(vehicle: Vehicle): boolean {
    return this.drivers.get(vehicle.id)?.requestServiceRecoveryLaneChange() ?? false;
  }

  public driverFor(vehicle: Vehicle): TrafficDriver | null {
    return this.drivers.get(vehicle.id) ?? null;
  }

  public releaseDriver(vehicleId: number): void {
    this.drivers.get(vehicleId)?.destroy();
    this.drivers.delete(vehicleId);
    this.blockedDriverIds.delete(vehicleId);
    this.pendingDespawns.delete(vehicleId);
    this.pendingServiceRecoveries.delete(vehicleId);
    this.perception.remove(vehicleId);
    this.scheduler.remove(vehicleId);
  }

  /** Public obstacle channel for road works, scripted incidents, and temporary closures. */
  public registerTemporaryObstacle(obstacle: TemporaryTrafficObstacle): void {
    this.temporaryObstacles.set(obstacle.id, obstacle);
  }

  public removeTemporaryObstacle(id: string): void {
    this.temporaryObstacles.delete(id);
  }

  /** Spawn service traffic on a legal lane with exact tangent alignment. */
  public spawnServiceVehicle(
    kind: VehicleKind,
    desiredPosition: Vector2,
    targetProvider: (() => Vector2 | null) | null,
    stopRange = 56,
  ): Vehicle | null {
    const network = this.network;
    const vehicles = this.vehicleSystem;
    if (!network || !vehicles) return null;
    const nearest = network.nearestLane(desiredPosition, undefined, true);
    if (!nearest) return null;
    const projection = network.projectPoint(desiredPosition, nearest);
    const distance = clampSpawnDistance(nearest, projection.distance);
    const pose = sampleSpline(nearest.spline, distance);
    const spawn: SpawnPose = { lane: nearest, distance, point: pose.point, heading: pose.heading };
    if (!this.isSpawnClear(spawn, null)) return null;
    return this.spawnServiceVehicleAtPose(kind, spawn, targetProvider, stopRange);
  }

  /** Spawn a service vehicle directly on its validated directional curb lane. */
  public spawnServiceVehicleAtLaneStop(
    kind: VehicleKind,
    target: TrafficLaneStopTarget,
    targetProvider: (() => Vector2 | null) | null,
    stopRange = 56,
  ): Vehicle | null {
    const network = this.network;
    if (!network) return null;
    const lane = network.lane(target.laneId);
    if (!lane || lane.kind !== 'travel') return null;
    const distance = clampSpawnDistance(lane, target.laneDistance);
    const pose = sampleSpline(lane.spline, distance);
    const spawn: SpawnPose = { lane, distance, point: pose.point, heading: pose.heading };
    if (!this.isSpawnClear(spawn, null)) return null;
    return this.spawnServiceVehicleAtPose(kind, spawn, targetProvider, stopRange);
  }

  /** Spawn a service unit on a legal off-screen route around an active incident. */
  public spawnServiceVehicleOnRoute(
    kind: VehicleKind,
    center: Vector2,
    targetProvider: (() => Vector2 | null) | null,
    stopRange = 56,
  ): Vehicle | null {
    const spawn = this.findSafeAmbientSpawn(center);
    if (!spawn) return null;
    return this.spawnServiceVehicleAtPose(kind, spawn, targetProvider, stopRange);
  }

  private spawnServiceVehicleAtPose(
    kind: VehicleKind,
    spawn: SpawnPose,
    targetProvider: (() => Vector2 | null) | null,
    stopRange: number,
  ): Vehicle | null {
    const vehicles = this.vehicleSystem;
    if (!vehicles) return null;
    const tint = this.rng.pick(VEHICLES[kind].tints);
    const vehicle = vehicles.spawnVehicle(
      kind,
      spawn.point.x,
      spawn.point.y,
      spawn.heading,
      tint,
      'traffic',
    );
    const driver = this.ensureDriver(
      vehicle,
      targetProvider,
      stopRange,
      spawn.lane,
      spawn.distance,
    );
    if (!driver) {
      vehicles.removeVehicle(vehicle);
      return null;
    }
    const ai = this.ensureTrafficAi(vehicle, targetProvider, stopRange);
    ai.setStopped(false);
    driver?.render(1);
    this.trafficCars.add(vehicle);
    return vehicle;
  }

  public trafficDebugSnapshot(): TrafficDebugSnapshot {
    const player = getPlayerRef()?.playerPosition ?? null;
    let selected: TrafficDriver | null = null;
    let closestSq = Infinity;
    if (player) {
      for (const [vehicleId, driver] of this.drivers) {
        const vehicle = this.vehicleSystem?.vehicles.find(
          (candidate) => candidate.id === vehicleId,
        );
        if (!vehicle || vehicle.isDestroyed) continue;
        const dx = vehicle.sprite.x - player.x;
        const dy = vehicle.sprite.y - player.y;
        const distanceSq = dx * dx + dy * dy;
        if (distanceSq < closestSq) {
          closestSq = distanceSq;
          selected = driver;
        }
      }
    }
    return {
      phase: this.intersections?.phase ?? 'offline',
      roads: this.network?.roadCount ?? 0,
      lanes: this.network?.laneCount ?? 0,
      intersections: this.network?.intersectionCount ?? 0,
      parkingSpaces: this.network?.parkingSpaceCount ?? 0,
      stats: this.statsValue,
      validation: this.validationReport,
      selected: selected?.debug ?? null,
    };
  }

  private simulateFixedStep(
    now: number,
    deltaSeconds: number,
    filter: ((driver: TrafficDriver) => boolean) | null = null,
  ): void {
    const intersections = this.intersections;
    if (!intersections) return;
    intersections.beginFrame(now);
    this.perception.beginFrame(this.temporaryObstacles.values());
    for (const driver of this.drivers.values()) {
      const snapshot = driver.snapshot();
      if (snapshot) this.perception.upsert(snapshot);
    }
    const player = getPlayerRef()?.playerPosition ?? null;
    const isSnappDriver = (driver: TrafficDriver): boolean => {
      const vehicleId = driver.snapshot()?.vehicleId;
      return vehicleId !== undefined && this.vehicleSystem?.vehicles.some(
        (vehicle) => vehicle.id === vehicleId && typeof vehicle.sprite.getData('snappBookingId') === 'string',
      ) === true;
    };
    this.scheduler.schedule(now, deltaSeconds, player, this.drivers.values(), (work) => {
      work.driver.fixedUpdate(now, work.deltaSeconds, this.perception, work.detail);
    }, filter ? (driver) => filter(driver) : isSnappDriver);
    intersections.resolve(now);
  }

  private resolveServices(): void {
    if (!this.world) this.world = ServiceLocator.tryResolve(ServiceKeys.World) as IWorldRef | null;
    if (!this.vehicleSystem) {
      this.vehicleSystem = ServiceLocator.tryResolve<VehicleSystem>(ServiceKeys.Vehicle);
    }
    if (!this.entityManager) {
      this.entityManager = ServiceLocator.tryResolve<EntityManager>(ServiceKeys.Entity);
    }
  }

  private ensureRuntime(): void {
    if (!this.world || !this.vehicleSystem || this.network) return;
    this.network = new TrafficNetwork(
      this.world.map.roadNodes,
      this.world.map.trafficLights,
      this.world.map.roadEdges,
      this.world.map.highways.flatMap((highway) =>
        highway.serviceAreas.flatMap((area) => area.parkingSpaces),
      ),
      this.world.map.busStops,
    );
    if (
      !this.network.positionsAreMutuallyReachable(this.world.map.cities.map((city) => city.center))
    ) {
      throw new Error(
        'Generated traffic lane graph does not connect every city in both directions',
      );
    }
    this.intersections = new IntersectionReservationController(this.network);
    this.parking = new ParkedVehicleManager(this.network, this.vehicleSystem, this.world, this.rng);
    this.serviceParking = new MajorBuildingServiceParking(
      this.world.map.majorBuildings,
      this.vehicleSystem,
      this.world,
      this.rng,
    );
    this.validator = new TrafficValidator(this.network, this.world);
  }

  private ensureDriver(
    vehicle: Vehicle,
    targetProvider: (() => Vector2 | null) | null,
    stopRange: number,
    initialLane: TrafficLane | null = null,
    initialDistance: number | null = null,
  ): TrafficDriver | null {
    const existing = this.drivers.get(vehicle.id);
    if (existing) return existing;
    const world = this.world;
    const network = this.network;
    const intersections = this.intersections;
    if (!world || !network || !intersections) return null;
    if (this.drivers.size >= ENGINE_LIMITS.MAX_TRAFFIC_DRIVERS) {
      EngineDiagnostics.recordLimitExceeded(
        'MAX_TRAFFIC_DRIVERS',
        this.drivers.size + 1,
        ENGINE_LIMITS.MAX_TRAFFIC_DRIVERS,
        'rejected-traffic-driver',
        `vehicle:${vehicle.id}`,
      );
      return null;
    }
    const driver = new TrafficDriver(
      vehicle,
      {
        network,
        intersections,
        world,
        entities: this.entityManager,
        random: () => this.rng.next(),
        requestDespawn: (blockedDriver, reason) => {
          this.pendingDespawns.set(blockedDriver.id, reason);
        },
        onEmergencyBrake: () => {
          this.statsValue.emergencyBrakes += 1;
        },
        onRecovery: () => {
          this.statsValue.recoveries += 1;
        },
        onBlocked: (blocked) => {
          if (blocked) this.blockedDriverIds.add(vehicle.id);
          else this.blockedDriverIds.delete(vehicle.id);
        },
      },
      targetProvider,
      stopRange,
      initialLane,
      initialDistance,
    );
    driver.setCityAlert(this.cityAlertUrgency);
    this.drivers.set(vehicle.id, driver);
    return driver;
  }

  private ensureTrafficAi(
    vehicle: Vehicle,
    targetProvider: (() => Vector2 | null) | null,
    stopRange: number,
  ): TrafficAIComponent {
    const existing = vehicle.getComponent<TrafficAIComponent>('ai');
    if (existing instanceof TrafficAIComponent) {
      existing.configure(targetProvider, stopRange);
      return existing;
    }
    if (existing) {
      const error = new Error(`vehicle ${vehicle.id} has non-traffic ai component`);
      EngineDiagnostics.recordError(error, 'traffic-ai-configure', this.key);
      throw error;
    }
    return vehicle.addComponent(new TrafficAIComponent(targetProvider, stopRange));
  }

  private maintainPopulation(player: Vector2 | null, delta: number): void {
    this.pruneTraffic(player);
    this.intercityElapsedMs += delta;
    this.spawnElapsedMs += delta;
    if (
      !player ||
      this.spawnElapsedMs < SPAWN_INTERVAL_MS ||
      this.trafficCars.size + this.virtualTraffic.size >= this.activeTrafficCap()
    ) {
      return;
    }
    this.spawnElapsedMs = 0;
    const spawn = this.findSafeAmbientSpawn(player);
    if (!spawn || !this.vehicleSystem) return;
    const kind = this.nextIntercityKind() ?? this.rng.pick(this.trafficPool(spawn.point));
    if (!kind) return;
    const destination = this.intercityDestination(spawn.point, kind);
    const targetProvider = destination ? () => destination : null;
    const tint = this.rng.pick(VEHICLES[kind].tints);
    const car = this.vehicleSystem.spawnVehicle(
      kind,
      spawn.point.x,
      spawn.point.y,
      spawn.heading,
      tint,
      'traffic',
    );
    const driver = this.ensureDriver(car, targetProvider, 56, spawn.lane, spawn.distance);
    if (!driver) {
      this.vehicleSystem.removeVehicle(car);
      return;
    }
    this.ensureTrafficAi(car, targetProvider, 56).setStopped(false);
    car.sprite.setData('intercityService', destination !== null);
    this.trafficCars.add(car);
  }

  private findSafeAmbientSpawn(player: Vector2): SpawnPose | null {
    const network = this.network;
    if (!network) return null;
    for (let attempt = 0; attempt < SPAWN_ATTEMPTS; attempt++) {
      const lane = network.randomTravelLaneNear(
        player,
        AMBIENT_SPAWN_MIN_DISTANCE,
        AMBIENT_SPAWN_MAX_DISTANCE,
        () => this.rng.next(),
      );
      if (!lane) continue;
      const distance = clampSpawnDistance(
        lane,
        this.rng.range(45, Math.max(46, lane.spline.length - 75)),
      );
      const pose = sampleSpline(lane.spline, distance);
      const spawn: SpawnPose = { lane, distance, point: pose.point, heading: pose.heading };
      if (!this.isSpawnClear(spawn, player)) {
        this.statsValue.safeSpawnRejects += 1;
        continue;
      }
      return spawn;
    }
    return null;
  }

  private isSpawnClear(spawn: SpawnPose, ambientPlayer: Vector2 | null): boolean {
    const network = this.network;
    const world = this.world;
    if (!network || !world || spawn.lane.kind !== 'travel') return false;
    if (
      spawn.distance < 38 ||
      spawn.lane.spline.length - spawn.distance < SPAWN_FRONT_CLEARANCE ||
      Math.abs(wrapAngle(sampleSpline(spawn.lane.spline, spawn.distance).heading - spawn.heading)) >
        0.015
    ) {
      return false;
    }
    if (ambientPlayer) {
      const dx = spawn.point.x - ambientPlayer.x;
      const dy = spawn.point.y - ambientPlayer.y;
      if (dx * dx + dy * dy < AMBIENT_SPAWN_MIN_DISTANCE ** 2) return false;
    }
    for (const lookAhead of [0, 24, 58, 96]) {
      const point = sampleSpline(spawn.lane.spline, spawn.distance + lookAhead).point;
      if (!world.isDrivableAtWorld(point.x, point.y) || world.isSolidAtWorld(point.x, point.y)) {
        return false;
      }
    }
    for (const driver of this.drivers.values()) {
      const snapshot = driver.snapshot();
      if (!snapshot || snapshot.laneId !== spawn.lane.id) continue;
      const relative = snapshot.laneDistance - spawn.distance;
      if (relative > -SPAWN_REAR_CLEARANCE && relative < SPAWN_FRONT_CLEARANCE) return false;
    }
    for (const vehicle of this.vehicleSystem?.vehicles ?? []) {
      if (!vehicle.sprite.active || vehicle.isDestroyed) continue;
      const dx = vehicle.sprite.x - spawn.point.x;
      const dy = vehicle.sprite.y - spawn.point.y;
      if (dx * dx + dy * dy < 68 * 68) return false;
    }
    let occupied = false;
    this.entityManager?.forEachNearby(
      spawn.point.x,
      spawn.point.y,
      62,
      () => {
        occupied = true;
      },
      EntityCategory.Npc,
    );
    return !occupied;
  }

  private pruneTraffic(player: Vector2 | null): void {
    const maxSq = DESPAWN_DISTANCE * DESPAWN_DISTANCE;
    for (const car of Array.from(this.trafficCars)) {
      if (car.isDestroyed || !car.sprite.active) {
        this.trafficCars.delete(car);
        this.releaseDriver(car.id);
        continue;
      }
      if (!player || car.isPlayerDriven) continue;
      if (car.sprite.getData('policeResponseActive') === true) continue;
      // Scheduled transit owns passenger/service state that cannot survive a
      // generic visual retirement. It still receives the normal driver LOD.
      if (car.sprite.getData('persistentTransitService') === true) continue;
      const dx = car.sprite.x - player.x;
      const dy = car.sprite.y - player.y;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq > VIRTUALIZE_DISTANCE * VIRTUALIZE_DISTANCE) {
        const driver = this.drivers.get(car.id);
        if (driver && this.dematerializeTraffic(car, driver)) continue;
      }
      if (distanceSq <= maxSq) continue;
      this.trafficCars.delete(car);
      this.releaseDriver(car.id);
      this.vehicleSystem?.removeVehicle(car);
    }
  }

  private processPendingDespawns(filter: ((vehicle: Vehicle) => boolean) | null = null): void {
    let processed = 0;
    for (const [vehicleId, reason] of this.pendingDespawns) {
      if (processed >= ENGINE_LIMITS.MAX_TRAFFIC_DESPAWNS_PER_FRAME) {
        EngineDiagnostics.recordLimitExceeded(
          'MAX_TRAFFIC_DESPAWNS_PER_FRAME',
          this.pendingDespawns.size,
          ENGINE_LIMITS.MAX_TRAFFIC_DESPAWNS_PER_FRAME,
          'deferred-traffic-despawn',
          'TrafficSystem',
        );
        break;
      }
      const vehicle = this.vehicleSystem?.vehicles.find((candidate) => candidate.id === vehicleId);
      if (filter && vehicle && !filter(vehicle)) continue;
      this.pendingDespawns.delete(vehicleId);
      if (!vehicle || vehicle.isPlayerDriven) continue;
      if (
        vehicle.sprite.getData('policeResponseActive') === true ||
        vehicle.sprite.getData('persistentTransitService') === true
      ) {
        if (vehicle.sprite.getData('persistentTransitService') === true) {
          const recoveryReason = reason ?? 'generic traffic recovery requested despawn';
          this.pendingServiceRecoveries.set(vehicleId, recoveryReason);
          const driver = this.drivers.get(vehicleId);
          driver?.holdForServiceRecovery(recoveryReason);
          if (typeof vehicle.sprite.getData('snappBookingId') === 'string') {
            this.log.warn(
              `Snapp traffic driver held for recovery booking=${String(vehicle.sprite.getData('snappBookingId'))} ` +
                `vehicle=${vehicleId} reason=${recoveryReason}`,
            );
          }
        } else {
          this.drivers.get(vehicleId)?.forceReplan();
        }
        continue;
      }
      this.trafficCars.delete(vehicle);
      this.releaseDriver(vehicleId);
      this.vehicleSystem?.removeVehicle(vehicle);
      processed += 1;
    }
  }

  /**
   * Converts a hidden-distance car into a lane-only record. The record follows
   * the same directed road graph but owns no sprite, body, components, or AI
   * object until it returns to the activation ring.
   */
  private dematerializeTraffic(vehicle: Vehicle, driver: TrafficDriver): boolean {
    if (vehicle.sprite.getData('policeResponseActive') === true) return false;
    const snapshot = driver.snapshot();
    const lane = snapshot ? this.network?.lane(snapshot.laneId) : null;
    if (!snapshot || !lane || vehicle.isPlayerDriven || vehicle.isDestroyed) return false;
    if (this.virtualTraffic.size >= ENGINE_LIMITS.MAX_VIRTUAL_TRAFFIC) {
      EngineDiagnostics.recordLimitExceeded(
        'MAX_VIRTUAL_TRAFFIC',
        this.virtualTraffic.size + 1,
        ENGINE_LIMITS.MAX_VIRTUAL_TRAFFIC,
        'retired-overflow-virtual-traffic',
        `vehicle:${vehicle.id}`,
      );
      this.trafficCars.delete(vehicle);
      this.releaseDriver(vehicle.id);
      this.vehicleSystem?.removeVehicle(vehicle);
      return true;
    }
    this.virtualTraffic.set(this.nextVirtualTrafficId, {
      id: this.nextVirtualTrafficId,
      kind: vehicle.def.kind,
      tint: vehicle.sprite.tintTopLeft,
      targetProvider: driver.streamingTargetProvider,
      stopRange: driver.streamingStopRange,
      lane,
      distance: snapshot.laneDistance,
      speed: snapshot.speed,
    });
    this.nextVirtualTrafficId += 1;
    this.trafficCars.delete(vehicle);
    this.releaseDriver(vehicle.id);
    this.vehicleSystem?.removeVehicle(vehicle);
    return true;
  }

  private updateVirtualTraffic(player: Vector2 | null, delta: number): void {
    if (!player || this.virtualTraffic.size === 0) return;
    this.virtualElapsedMs += Math.min(delta, VIRTUAL_STEP_MS * 4);
    if (this.virtualElapsedMs < VIRTUAL_STEP_MS) return;
    const deltaSeconds = this.virtualElapsedMs / 1000;
    this.virtualElapsedMs = 0;
    this.virtualMaterializeQueue.length = 0;
    const retireSq = VIRTUAL_RETIRE_DISTANCE * VIRTUAL_RETIRE_DISTANCE;
    const materializeSq = VIRTUAL_MATERIALIZE_DISTANCE * VIRTUAL_MATERIALIZE_DISTANCE;
    for (const record of this.virtualTraffic.values()) {
      if (!this.advanceVirtualTraffic(record, deltaSeconds)) {
        this.virtualTraffic.delete(record.id);
        continue;
      }
      const pose = sampleSpline(record.lane.spline, record.distance);
      const dx = pose.point.x - player.x;
      const dy = pose.point.y - player.y;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq <= materializeSq) this.virtualMaterializeQueue.push(record);
      else if (distanceSq > retireSq) this.virtualTraffic.delete(record.id);
    }
    if (this.virtualMaterializeQueue.length > ENGINE_LIMITS.MAX_VIRTUAL_MATERIALIZE_PER_FRAME) {
      EngineDiagnostics.recordLimitExceeded(
        'MAX_VIRTUAL_MATERIALIZE_PER_FRAME',
        this.virtualMaterializeQueue.length,
        ENGINE_LIMITS.MAX_VIRTUAL_MATERIALIZE_PER_FRAME,
        'deferred-virtual-materialization',
        'TrafficSystem',
      );
    }
    for (const record of this.virtualMaterializeQueue.slice(
      0,
      ENGINE_LIMITS.MAX_VIRTUAL_MATERIALIZE_PER_FRAME,
    )) {
      this.materializeTraffic(record);
    }
    this.virtualMaterializeQueue.length = 0;
  }

  private advanceVirtualTraffic(record: VirtualTrafficRecord, deltaSeconds: number): boolean {
    const targetSpeed = record.lane.speedLimit * 0.7;
    const acceleration = targetSpeed > record.speed ? 68 : -115;
    record.speed = Phaser.Math.Clamp(record.speed + acceleration * deltaSeconds, 0, targetSpeed);
    let remaining = record.speed * deltaSeconds;
    for (
      let advances = 0;
      remaining > 0 && advances < ENGINE_LIMITS.MAX_VIRTUAL_LANE_ADVANCES_PER_STEP;
      advances += 1
    ) {
      if (!Number.isFinite(remaining) || !Number.isFinite(record.distance)) {
        EngineDiagnostics.recordLimitExceeded(
          'MAX_VIRTUAL_LANE_ADVANCES_PER_STEP',
          advances,
          ENGINE_LIMITS.MAX_VIRTUAL_LANE_ADVANCES_PER_STEP,
          'retired-invalid-virtual-traffic',
          `record:${record.id}`,
        );
        return false;
      }
      const available = record.lane.spline.length - record.distance;
      if (!Number.isFinite(available) || !Number.isFinite(record.lane.spline.length)) {
        EngineDiagnostics.recordLimitExceeded(
          'MAX_VIRTUAL_LANE_ADVANCES_PER_STEP',
          advances,
          ENGINE_LIMITS.MAX_VIRTUAL_LANE_ADVANCES_PER_STEP,
          'retired-invalid-virtual-lane',
          record.lane.id,
        );
        return false;
      }
      if (remaining < available) {
        record.distance += remaining;
        return true;
      }
      remaining -= Math.max(0, available);
      const next = this.nextVirtualLane(record.lane);
      if (!next) {
        record.distance = Math.max(0, record.lane.spline.length - 1);
        record.speed = 0;
        return true;
      }
      record.lane = next;
      record.distance = 0;
    }
    if (remaining > 0) {
      EngineDiagnostics.recordLimitExceeded(
        'MAX_VIRTUAL_LANE_ADVANCES_PER_STEP',
        ENGINE_LIMITS.MAX_VIRTUAL_LANE_ADVANCES_PER_STEP + 1,
        ENGINE_LIMITS.MAX_VIRTUAL_LANE_ADVANCES_PER_STEP,
        'retired-runaway-virtual-traffic',
        `record:${record.id}`,
      );
      return false;
    }
    return true;
  }

  private nextVirtualLane(lane: TrafficLane): TrafficLane | null {
    let selected: TrafficLane | null = null;
    let count = 0;
    for (const laneId of lane.connectionIds) {
      const candidate = this.network?.lane(laneId);
      if (!candidate) continue;
      count += 1;
      if (this.rng.next() <= 1 / count) selected = candidate;
    }
    return selected;
  }

  private materializeTraffic(record: VirtualTrafficRecord): void {
    const vehicles = this.vehicleSystem;
    if (!vehicles || !this.virtualTraffic.delete(record.id)) return;
    const pose = sampleSpline(record.lane.spline, record.distance);
    const vehicle = vehicles.spawnVehicle(
      record.kind,
      pose.point.x,
      pose.point.y,
      pose.heading,
      record.tint,
      'traffic',
    );
    const driver = this.ensureDriver(
      vehicle,
      record.targetProvider,
      record.stopRange,
      record.lane,
      record.distance,
    );
    if (!driver) {
      vehicles.removeVehicle(vehicle);
      return;
    }
    this.ensureTrafficAi(vehicle, record.targetProvider, record.stopRange).setStopped(false);
    driver?.restoreVirtualSpeed(record.speed);
    driver?.render(1);
    this.trafficCars.add(vehicle);
  }

  private refreshLightSprites(scene: Phaser.Scene): void {
    const world = this.world;
    const network = this.network;
    if (!world || !network) return;
    const player = getPlayerRef()?.playerPosition ?? world.map.playerStart;
    const anchor = `${Math.floor(player.x / LIGHT_STREAM_CELL)},${Math.floor(player.y / LIGHT_STREAM_CELL)}`;
    if (anchor === this.lightsAnchor) return;
    for (const light of this.lights) light.sprite.destroy();
    this.lights.length = 0;
    const radiusSq = LIGHT_STREAM_RADIUS * LIGHT_STREAM_RADIUS;
    for (const light of world.map.trafficLights) {
      const dx = light.x - player.x;
      const dy = light.y - player.y;
      if (dx * dx + dy * dy > radiusSq) continue;
      const junction = network.nearestJunction(light, 90);
      if (!junction) continue;
      const sprite = scene.add
        .image(light.x, light.y, TextureKeys.TrafficLight)
        .setDepth(DepthLayers.GroundDetail);
      this.lights.push({ sprite, northSouth: light.northSouth, intersectionId: junction.id });
    }
    this.lightsAnchor = anchor;
  }

  private refreshLightTints(): void {
    const intersections = this.intersections;
    if (!intersections) return;
    for (const light of this.lights) {
      const color = intersections.signalColor(light.intersectionId, light.northSouth);
      light.sprite.setTint(
        color === 'green' ? LIGHT_GREEN : color === 'yellow' ? LIGHT_YELLOW : LIGHT_RED,
      );
    }
  }

  private activeTrafficCap(): number {
    const hour =
      (ServiceLocator.tryResolve(ServiceKeys.DayNight) as { hour?: number } | null)?.hour ?? 12;
    const hourFactor =
      hour >= 7 && hour <= 9
        ? 1.2
        : hour >= 16 && hour <= 19
          ? 1.25
          : hour >= 22 || hour < 5
            ? 0.45
            : 0.8;
    const player = getPlayerRef()?.playerPosition;
    const density =
      player && this.world?.trafficDensityAt ? this.world.trafficDensityAt(player.x, player.y) : 1;
    const weather = (ServiceLocator.tryResolve(ServiceKeys.Weather) as { mode?: string } | null)
      ?.mode;
    const weatherFactor =
      weather === 'storm'
        ? 0.5
        : weather === 'rain'
          ? 0.75
          : weather === 'fog' || weather === 'snow'
            ? 0.65
            : 1;
    return Phaser.Math.Clamp(
      Math.floor(VEHICLE.MAX_TRAFFIC * hourFactor * density * weatherFactor),
      density < 0.4 ? 8 : 16,
      Math.min(96, ENGINE_LIMITS.MAX_TRAFFIC_DRIVERS),
    );
  }

  private nextIntercityKind(): VehicleKind | null {
    if (this.intercityElapsedMs < INTERCITY_SERVICE_MS) return null;
    this.intercityElapsedMs = 0;
    const sequence: readonly VehicleKind[] = ['bus', 'truck', 'delivery', 'bus', 'construction'];
    const kind = sequence[this.intercityIndex % sequence.length] ?? 'bus';
    this.intercityIndex += 1;
    return kind;
  }

  private intercityDestination(point: Vector2, kind: VehicleKind): Vector2 | null {
    const force =
      kind === 'bus' || kind === 'truck' || kind === 'delivery' || kind === 'construction';
    if (!force && !this.rng.chance(0.08)) return null;
    const cityId = this.world?.cityAt?.(point.x, point.y)?.id;
    const choices = this.world?.map.cities.filter((city) => city.id !== cityId) ?? [];
    const city = this.rng.pick(choices);
    return city ? { x: city.center.x, y: city.center.y } : null;
  }

  private trafficPool(point: Vector2): readonly VehicleKind[] {
    const city = this.world?.cityAt?.(point.x, point.y)?.id;
    if (city === 'tehran') {
      return [
        'sedan',
        'sedan',
        'taxi',
        'taxi',
        'luxury',
        'sports',
        'bus',
        'delivery',
        'truck',
        'motorcycle',
        'police',
      ];
    }
    if (city === 'yazd') {
      return [
        'pickup',
        'pickup',
        'truck',
        'van',
        'delivery',
        'scooter',
        'motorcycle',
        'taxi',
        'bus',
      ];
    }
    if (city === 'gilan') {
      return ['pickup', 'van', 'delivery', 'bicycle', 'bicycle', 'scooter', 'taxi', 'bus', 'truck'];
    }
    return TRAFFIC_KINDS;
  }

  private pruneExpiredObstacles(now: number): void {
    for (const [id, obstacle] of this.temporaryObstacles) {
      if (obstacle.expiresAt !== null && obstacle.expiresAt <= now) {
        this.temporaryObstacles.delete(id);
      }
    }
  }

  private collectRuntimeStats(frameDelta: number): void {
    const reservations = this.intersections?.stats;
    const scheduler = this.scheduler.stats;
    this.statsValue.activeDrivers = this.drivers.size;
    this.statsValue.parkedVehicles =
      (this.parking?.count ?? 0) + (this.serviceParking?.count ?? 0);
    this.statsValue.queuedVehicles = reservations?.queued ?? 0;
    this.statsValue.blockedDrivers = this.blockedDriverIds.size;
    this.statsValue.routeCacheHits = this.network?.routeCacheHits ?? 0;
    this.statsValue.routeCacheMisses = this.network?.routeCacheMisses ?? 0;
    this.statsValue.reservationsGranted = reservations?.granted ?? 0;
    this.statsValue.reservationsDenied = reservations?.denied ?? 0;
    this.statsValue.validationFailures = this.validationReport.failures.length;
    this.statsValue.trafficCpuMs = scheduler.cpuMs;
    this.statsValue.navigationCpuMs = scheduler.navigationMs;
    this.statsValue.steeringCpuMs = scheduler.steeringMs;
    this.statsValue.collisionCpuMs = scheduler.collisionMs;
    this.statsValue.simulatedVehicles = this.drivers.size;
    this.statsValue.virtualVehicles = this.virtualTraffic.size;
    this.statsValue.nearSimulationVehicles = scheduler.nearDrivers;
    this.statsValue.mediumSimulationVehicles = scheduler.mediumDrivers;
    this.statsValue.farSimulationVehicles = scheduler.farDrivers;
    this.statsValue.frozenSimulationVehicles = scheduler.virtualDrivers;
    this.statsValue.averageAiUpdateHz = scheduler.averageUpdateHz;
    this.statsValue.schedulerLoad = scheduler.load;
    this.statsValue.schedulerDeferredUpdates = scheduler.deferredUpdates;
    this.statsValue.frameTimeMs = frameDelta;
  }

  private resetStats(): void {
    for (const key of Object.keys(this.statsValue) as Array<keyof TrafficRuntimeStats>) {
      this.statsValue[key] = 0;
    }
  }
}

function clampSpawnDistance(lane: TrafficLane, distance: number): number {
  return Math.max(42, Math.min(lane.spline.length - SPAWN_FRONT_CLEARANCE, distance));
}
