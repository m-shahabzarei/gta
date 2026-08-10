/**
 * Public transit coordinator.
 *
 * Buses and taxis deliberately remain ordinary TrafficSystem vehicles. This
 * manager only owns service state, passenger intentions, fares, and player
 * interactions; routing, lane following, collision avoidance, intersection
 * reservations, LOD, and recovery remain in the shared traffic stack.
 */
import Phaser from 'phaser';
import { BaseSceneManager } from '@/core/BaseSceneManager';
import { ServiceLocator } from '@/core/ServiceLocator';
import { ServiceKeys } from '@/config/ServiceKeys';
import { EventKeys } from '@/config/EventKeys';
import { PLAYER, VEHICLE } from '@/config/Constants';
import type { ISerializable } from '@/core/interfaces';
import type { Json, Vector2 } from '@/core/types';
import {
  CITY_TRANSIT_CONFIG,
  calculateTaxiFare,
  type BusServiceSnapshot,
  type BusServiceState,
  type BusRouteConfig,
  type ResolvedBusRoute,
  type TaxiDestination,
  type TaxiFareQuote,
  type TaxiServiceSnapshot,
  type TaxiState,
  type TransitRideSnapshot,
  type TransportationDebugSnapshot,
} from '@/gameplay/transit';
import type { BusStopSite, CityId, VehicleOccupantRecord } from '@/gameplay/types';
import type { Vehicle } from '@/entities/Vehicle';
import type { Pedestrian } from '@/entities/Pedestrian';
import type { WorldManager } from '@/systems/WorldManager';
import type { TrafficSystem } from '@/systems/TrafficSystem';
import type { VehicleSystem } from '@/systems/VehicleSystem';
import type { VehicleOccupantSystem } from '@/systems/VehicleOccupantSystem';
import type { PedestrianSystem } from '@/systems/PedestrianSystem';
import type { PlayerController } from '@/systems/PlayerController';
import type { GameManager } from '@/managers/GameManager';

interface BusRuntime {
  cityId: CityId;
  route: ResolvedBusRoute;
  vehicle: Vehicle;
  state: BusServiceState;
  currentStopIndex: number;
  targetStopIndex: number;
  dwellRemainingMs: number;
  recoveryAttempts: number;
  nextRecoveryAt: number;
}

interface TaxiRuntime {
  cityId: CityId;
  vehicle: Vehicle;
  state: TaxiState;
  roamTarget: Vector2 | null;
  playerRequestPosition: Vector2 | null;
  destination: TaxiDestination | null;
  fare: TaxiFareQuote | null;
  farePaid: boolean;
  stateSince: number;
  recoveryAttempts: number;
  nextRecoveryAt: number;
  validLaneRoute: boolean;
}

interface PassengerPlan {
  pedestrianId: number;
  routeId: string;
  originStopId: string;
  destinationStopId: string;
  phase: 'waiting' | 'walking-to-door';
}

export interface TransitInteraction {
  prompt: string;
  kind: 'board-bus' | 'take-taxi' | 'call-taxi' | 'exit-transit' | 'view-bus-stop';
  distanceSq: number;
}

const SERVICE_TICK_MS = 200;
const PASSENGER_PLAN_TICK_MS = 900;
const SERVICE_RESPAWN_MS = 1800;
const TAXI_HAIL_TIMEOUT_MS = 12000;
const TAXI_BOARD_TIMEOUT_MS = 4500;
const TAXI_STOP_RANGE = 34;
const BUS_STOP_RANGE = 28;
const BUS_RECOVERY_DELAY_MS = 1400;
const TAXI_RECOVERY_DELAY_MS = 1200;
const MAX_RECOVERY_ATTEMPTS = 3;
const ROUTE_STOP_CANDIDATE_LIMIT = 8;
const BUS_INTERACTION_RANGE = 68;
const TAXI_INTERACTION_RANGE = VEHICLE.ENTER_RANGE + 10;
const STOP_INTERACTION_RANGE = Math.max(PLAYER.INTERACT_RANGE, 60);

/**
 * Scene-bound, save-compatible public transport system. Persistent service
 * sprites are protected from generic traffic retirement, while TrafficDriver's
 * existing near/medium/far/virtual scheduler continues to control their cost.
 */
export class TransportationSystem extends BaseSceneManager implements ISerializable {
  public readonly key = ServiceKeys.Transportation;
  public readonly saveId = 'transport';

  private world: WorldManager | null = null;
  private traffic: TrafficSystem | null = null;
  private vehicles: VehicleSystem | null = null;
  private occupants: VehicleOccupantSystem | null = null;
  private pedestrians: PedestrianSystem | null = null;
  private player: PlayerController | null = null;

  private readonly resolvedRoutes = new Map<CityId, ResolvedBusRoute[]>();
  private readonly buses = new Map<number, BusRuntime>();
  private readonly taxis = new Map<number, TaxiRuntime>();
  private readonly passengerPlans = new Map<number, PassengerPlan>();
  private readonly discoveredStopIds = new Set<string>();
  private runtimeReady = false;
  private serviceAccumulatorMs = 0;
  private passengerPlanAccumulatorMs = 0;
  private nextSpawnAttemptAt = 0;
  private taxiRoamOrdinal = 0;

  protected onInit(): void {
    this.subscribe(EventKeys.PlayerInteract, (position) => this.handlePlayerInteraction(position));
    this.subscribe(EventKeys.VehicleDestroyed, ({ vehicleId }) => this.removeDestroyedService(vehicleId));
    this.subscribe(EventKeys.VehicleRemoved, ({ vehicleId }) => this.removeDestroyedService(vehicleId));
  }

  protected onAttach(_scene: Phaser.Scene): void {
    this.resetRuntime();
    this.resolveServices();
    this.initializeRuntime();
  }

  protected override onDetach(_scene: Phaser.Scene): void {
    this.removeServiceVehicles();
    this.resetRuntime();
    this.world = null;
    this.traffic = null;
    this.vehicles = null;
    this.occupants = null;
    this.pedestrians = null;
    this.player = null;
  }

  public update(time: number, delta: number): void {
    this.resolveServices();
    this.initializeRuntime();
    if (!this.runtimeReady) return;

    this.serviceAccumulatorMs += Math.min(delta, SERVICE_TICK_MS * 4);
    this.passengerPlanAccumulatorMs += Math.min(delta, PASSENGER_PLAN_TICK_MS * 2);
    while (this.serviceAccumulatorMs >= SERVICE_TICK_MS) {
      this.serviceAccumulatorMs -= SERVICE_TICK_MS;
      this.updateServices(time, SERVICE_TICK_MS);
    }
    if (this.passengerPlanAccumulatorMs >= PASSENGER_PLAN_TICK_MS) {
      this.passengerPlanAccumulatorMs = 0;
      this.refreshPassengerPlans();
    }
  }

  /** Durable transit discovery only; vehicle/AI state is intentionally regenerated. */
  public serialize(): Json {
    return { discoveredStopIds: Array.from(this.discoveredStopIds).sort() };
  }

  public deserialize(data: Json): void {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return;
    const ids = data.discoveredStopIds;
    if (!Array.isArray(ids)) return;
    this.discoveredStopIds.clear();
    for (const id of ids) {
      if (typeof id === 'string') this.discoveredStopIds.add(id);
    }
  }

  /** Read-only runtime snapshot for HUD, maps, smoke tests, and diagnostics. */
  public debugSnapshot(): TransportationDebugSnapshot {
    const routes = (cityId: CityId): readonly ResolvedBusRoute[] =>
      (this.resolvedRoutes.get(cityId) ?? []).map((route) => ({
        ...route,
        stops: route.stops.slice(),
      }));
    return {
      cityConfigs: {
        tehran: {
          routes: CITY_TRANSIT_CONFIG.tehran.busRoutes.length,
          taxis: CITY_TRANSIT_CONFIG.tehran.taxi.population,
        },
        yazd: {
          routes: CITY_TRANSIT_CONFIG.yazd.busRoutes.length,
          taxis: CITY_TRANSIT_CONFIG.yazd.taxi.population,
        },
        gilan: {
          routes: CITY_TRANSIT_CONFIG.gilan.busRoutes.length,
          taxis: CITY_TRANSIT_CONFIG.gilan.taxi.population,
        },
      },
      busRoutes: { tehran: routes('tehran'), yazd: routes('yazd'), gilan: routes('gilan') },
      buses: Array.from(this.buses.values(), (bus) => this.busSnapshot(bus)),
      taxis: Array.from(this.taxis.values(), (taxi) => this.taxiSnapshot(taxi)),
      playerRide: this.playerRideSnapshot(),
    };
  }

  /** Concrete city destinations offered by the taxi destination map. */
  public taxiDestinations(cityId?: CityId): TaxiDestination[] {
    const taxi = this.currentPlayerTaxi();
    const resolvedCityId = cityId ?? taxi?.cityId;
    const world = this.world;
    if (!resolvedCityId || !world) return [];
    const config = CITY_TRANSIT_CONFIG[resolvedCityId];
    const destinations: TaxiDestination[] = [];
    const seen = new Set<string>();
    for (const landmarkId of config.taxi.serviceLandmarkIds) {
      const landmark = world.map.landmarks.find(
        (candidate) => candidate.id === landmarkId && candidate.cityId === resolvedCityId,
      );
      if (!landmark || seen.has(landmark.id)) continue;
      seen.add(landmark.id);
      destinations.push({
        id: `landmark:${landmark.id}`,
        label: landmark.name,
        position: { ...landmark.position },
        cityId: resolvedCityId,
        source: 'landmark',
      });
    }
    for (const building of world.map.majorBuildings) {
      if (building.city !== resolvedCityId || seen.has(building.id)) continue;
      seen.add(building.id);
      destinations.push({
        id: `major:${building.id}`,
        label: building.name,
        position: { ...building.entrancePosition },
        cityId: resolvedCityId,
        source: 'landmark',
      });
    }
    for (const stop of world.map.busStops) {
      if (stop.cityId !== resolvedCityId || seen.has(stop.id)) continue;
      seen.add(stop.id);
      destinations.push({
        id: `bus-stop:${stop.id}`,
        label: `Bus stop ${stop.id.replace(/^bus-stop:[^:]+:/, '')}`,
        position: { ...stop.approachPosition },
        cityId: resolvedCityId,
        source: 'bus-stop',
      });
    }
    return destinations;
  }

  /** Select a map destination and produce a lane-route-based quote without charging the player. */
  public previewTaxiDestination(destination: TaxiDestination): TaxiFareQuote | null {
    const taxi = this.currentPlayerTaxi();
    const traffic = this.traffic;
    const world = this.world;
    if (
      !taxi ||
      taxi.state !== 'WAITING_FOR_PLAYER' ||
      destination.cityId !== taxi.cityId ||
      !traffic ||
      !world
    ) {
      return null;
    }
    const route = traffic.routePreview(
      { x: taxi.vehicle.sprite.x, y: taxi.vehicle.sprite.y },
      destination.position,
    );
    if (!route || route.laneIds.length === 0) return null;
    const quote = calculateTaxiFare(
      CITY_TRANSIT_CONFIG[taxi.cityId].taxi,
      route,
      world.trafficDensityAt(taxi.vehicle.sprite.x, taxi.vehicle.sprite.y),
    );
    taxi.destination = { ...destination, position: { ...destination.position } };
    taxi.fare = quote;
    taxi.validLaneRoute = true;
    return quote;
  }

  /** Quote a valid manual map selection inside the active taxi's city. */
  public previewTaxiMapPoint(position: Vector2, label = 'Map pin'): TaxiFareQuote | null {
    const taxi = this.currentPlayerTaxi();
    const world = this.world;
    if (!taxi || !world || world.cityAt(position.x, position.y)?.id !== taxi.cityId) return null;
    return this.previewTaxiDestination({
      id: `map:${Math.round(position.x)}:${Math.round(position.y)}`,
      label,
      position: { x: position.x, y: position.y },
      cityId: taxi.cityId,
      source: 'map',
    });
  }

  /** Charge a selected valid fare once, then hand the trip to the traffic driver. */
  public confirmTaxiFare(): 'paid' | 'insufficient-funds' | 'invalid-trip' | 'already-paid' {
    const taxi = this.currentPlayerTaxi();
    const player = this.player?.player;
    const traffic = this.traffic;
    if (!taxi || !player || !traffic || taxi.state !== 'WAITING_FOR_PLAYER' || !taxi.destination || !taxi.fare) {
      return 'invalid-trip';
    }
    if (taxi.farePaid) return 'already-paid';
    if (!player.inventory.spendMoney(taxi.fare.total)) {
      this.bus.emit(EventKeys.UIToast, { message: 'Insufficient funds for this taxi fare' });
      return 'insufficient-funds';
    }
    taxi.farePaid = true;
    taxi.state = 'IN_SERVICE';
    taxi.stateSince = this.now();
    taxi.validLaneRoute = true;
    traffic.configureDriver(taxi.vehicle, () => taxi.destination?.position ?? null, TAXI_STOP_RANGE, false);
    this.bus.emit(EventKeys.UIToast, {
      message: `Taxi fare paid: $${taxi.fare.total}`,
      durationMs: 1800,
    });
    return 'paid';
  }

  /** Cancel a pre-payment taxi selection and let the player exit at the current safe curb. */
  public cancelTaxiDestination(): boolean {
    const taxi = this.currentPlayerTaxi();
    if (!taxi || taxi.state !== 'WAITING_FOR_PLAYER') return false;
    const exit = this.safeTransitExitPosition(taxi.vehicle, null);
    if (!exit || !this.player?.beginPassengerExit(exit)) return false;
    taxi.state = 'COMPLETED';
    taxi.stateSince = this.now();
    taxi.destination = null;
    taxi.fare = null;
    taxi.farePaid = false;
    return true;
  }

  /** Interaction query consumed before generic vehicle/npc targets. */
  public interactionAt(position: Vector2): TransitInteraction | null {
    const ride = this.playerRideSnapshot();
    if (ride?.canExit) {
      return { prompt: 'E  Exit transit', kind: 'exit-transit', distanceSq: 0 };
    }
    const taxi = this.nearestTaxi(position, TAXI_INTERACTION_RANGE, ['AVAILABLE', 'WAITING_FOR_PLAYER']);
    if (taxi) {
      return {
        prompt: taxi.state === 'WAITING_FOR_PLAYER' ? 'E  Take taxi' : 'E  Take taxi',
        kind: 'take-taxi',
        distanceSq: this.distanceSq(position, taxi.vehicle.sprite),
      };
    }
    const bus = this.nearestBoardableBus(position);
    if (bus) {
      return {
        prompt: `E  Board ${bus.route.config.id}`,
        kind: 'board-bus',
        distanceSq: this.distanceSq(position, bus.vehicle.sprite),
      };
    }
    const stop = this.nearestBusStop(position, STOP_INTERACTION_RANGE);
    if (stop) {
      return {
        prompt: 'E  View bus service',
        kind: 'view-bus-stop',
        distanceSq: this.distanceSq(position, stop),
      };
    }
    const city = this.world?.cityAt(position.x, position.y)?.id;
    if (city && this.nearestTaxiForCity(city)) {
      return { prompt: 'E  Call taxi', kind: 'call-taxi', distanceSq: 0 };
    }
    return null;
  }

  /** Transit map/highlight helpers. */
  public get discoveredBusStopIds(): ReadonlySet<string> {
    return this.discoveredStopIds;
  }

  /** Whether MapScene should operate as a fare-confirmation destination picker. */
  public get taxiDestinationSelectionActive(): boolean {
    const taxi = this.currentPlayerTaxi();
    return taxi?.state === 'WAITING_FOR_PLAYER' && this.player?.playerIsTransitPassenger === true;
  }

  public get pendingTaxiFare(): TaxiFareQuote | null {
    return this.currentPlayerTaxi()?.fare ?? null;
  }

  /** Live passenger status for the HUD without allocating a full debug snapshot every frame. */
  public get playerRide(): TransitRideSnapshot | null {
    return this.playerRideSnapshot();
  }

  /** Start a player boarding transition for a dwelling scheduled bus. */
  public requestBusBoarding(vehicleId: number): boolean {
    const bus = this.buses.get(vehicleId);
    return this.runtimeReady && bus ? this.beginBusBoarding(bus) : false;
  }

  /** Start a player boarding transition for an available or hailed taxi. */
  public requestTaxiBoarding(vehicleId: number): boolean {
    const taxi = this.taxis.get(vehicleId);
    return this.runtimeReady && taxi ? this.beginTaxiBoarding(taxi) : false;
  }

  /** Begin the player's door-mediated exit when the current transit service is stopped. */
  public exitPlayerTransit(): boolean {
    const player = this.player;
    const vehicle = player?.currentVehicle;
    if (!player?.playerIsTransitPassenger || !vehicle) return false;
    const bus = this.buses.get(vehicle.id);
    if (bus?.state === 'dwelling') {
      const exit = this.safeTransitExitPosition(vehicle, this.currentBusStop(bus));
      return exit ? player.beginPassengerExit(exit) : false;
    }
    const taxi = this.taxis.get(vehicle.id);
    if (taxi && (taxi.state === 'ARRIVING' || taxi.state === 'WAITING_FOR_PLAYER')) {
      const exit = this.safeTransitExitPosition(vehicle, null);
      if (!exit || !player.beginPassengerExit(exit)) return false;
      taxi.state = 'COMPLETED';
      taxi.stateSince = this.now();
      return true;
    }
    return false;
  }

  /** Iterate only visible service vehicle positions for compact minimap blips. */
  public forEachServiceBlip(visitor: (kind: 'bus' | 'taxi', position: Vector2) => void): void {
    for (const bus of this.buses.values()) {
      if (bus.vehicle.isDestroyed || !bus.vehicle.sprite.active) continue;
      visitor('bus', { x: bus.vehicle.sprite.x, y: bus.vehicle.sprite.y });
    }
    for (const taxi of this.taxis.values()) {
      if (taxi.vehicle.isDestroyed || !taxi.vehicle.sprite.active) continue;
      visitor('taxi', { x: taxi.vehicle.sprite.x, y: taxi.vehicle.sprite.y });
    }
  }

  private resolveServices(): void {
    this.world ??= ServiceLocator.tryResolve<WorldManager>(ServiceKeys.World);
    this.traffic ??= ServiceLocator.tryResolve<TrafficSystem>(ServiceKeys.Traffic);
    this.vehicles ??= ServiceLocator.tryResolve<VehicleSystem>(ServiceKeys.Vehicle);
    this.occupants ??= ServiceLocator.tryResolve<VehicleOccupantSystem>(ServiceKeys.Occupants);
    this.pedestrians ??= ServiceLocator.tryResolve<PedestrianSystem>(ServiceKeys.Pedestrian);
    this.player ??= ServiceLocator.tryResolve<PlayerController>(ServiceKeys.Player);
  }

  private initializeRuntime(): void {
    if (this.runtimeReady) return;
    if (!this.world || !this.traffic || !this.vehicles || !this.occupants || !this.pedestrians) return;
    if (!this.traffic.roadNetwork || this.world.map.busStops.length === 0) return;
    this.resolveConfiguredRoutes();
    this.runtimeReady = true;
    this.nextSpawnAttemptAt = 0;
  }

  private updateServices(time: number, delta: number): void {
    this.ensureServicePopulation(time);
    this.processCompletedPassengerExits();
    for (const bus of Array.from(this.buses.values())) this.updateBus(bus, time, delta);
    for (const taxi of Array.from(this.taxis.values())) this.updateTaxi(taxi, time);
    this.processPassengerBoardingWalks();
  }

  private resolveConfiguredRoutes(): void {
    const world = this.world;
    const traffic = this.traffic;
    if (!world || !traffic) return;
    this.resolvedRoutes.clear();
    for (const cityId of ['tehran', 'yazd', 'gilan'] as const) {
      const routes = CITY_TRANSIT_CONFIG[cityId].busRoutes.map((config) => {
        const resolvedStops = this.resolveRouteStops(cityId, config, traffic);
        const stops = resolvedStops ?? [];
        const valid = config.active && resolvedStops !== null && stops.length >= 3;
        return {
          config,
          stops,
          valid,
          issue: valid ? undefined : 'Unable to resolve a complete directed road route for all anchors',
        } satisfies ResolvedBusRoute;
      });
      this.resolvedRoutes.set(cityId, routes);
    }
  }

  /**
   * Bind semantic route anchors to a directed stop cycle. A landmark can have
   * curb platforms on both travel directions, so choosing the single nearest
   * platform can create an impossible loop even when a valid one is nearby.
   */
  private resolveRouteStops(
    cityId: CityId,
    config: BusRouteConfig,
    traffic: TrafficSystem,
  ): BusStopSite[] | null {
    const world = this.world;
    const network = traffic.roadNetwork;
    if (!world || !network) return null;
    const candidates = config.anchors.map((anchor) => {
      const landmark = anchor.landmarkIds
        .map((id) => world.map.landmarks.find((candidate) => candidate.id === id))
        .find((candidate) => candidate?.cityId === cityId);
      return landmark
        ? this.nearestStopsTo(landmark.position, cityId, new Set<string>(), ROUTE_STOP_CANDIDATE_LIMIT)
        : [];
    });
    if (candidates.some((entry) => entry.length === 0)) return null;

    // Pick one component represented near every landmark. Strong connectivity
    // proves the complete directed loop before any bus spawns, without a burst
    // of expensive A* searches while the game scene is starting.
    const commonComponents = new Set<number>();
    for (const stop of candidates[0] ?? []) {
      const component = network.strongComponentId(stop.laneId);
      if (component !== null) commonComponents.add(component);
    }
    for (let index = 1; index < candidates.length; index += 1) {
      for (const component of Array.from(commonComponents)) {
        if (!(candidates[index] ?? []).some((stop) => network.strongComponentId(stop.laneId) === component)) {
          commonComponents.delete(component);
        }
      }
    }
    for (const component of commonComponents) {
      const selected: BusStopSite[] = [];
      const used = new Set<string>();
      const selectDistinct = (index: number): boolean => {
        if (index >= candidates.length) return true;
        for (const stop of candidates[index] ?? []) {
          if (used.has(stop.id) || network.strongComponentId(stop.laneId) !== component) continue;
          selected.push(stop);
          used.add(stop.id);
          if (selectDistinct(index + 1)) return true;
          used.delete(stop.id);
          selected.pop();
        }
        return false;
      };
      if (selectDistinct(0)) return selected;
    }
    return null;
  }

  private ensureServicePopulation(time: number): void {
    if (time < this.nextSpawnAttemptAt) return;
    let needsAnotherAttempt = false;
    for (const cityId of ['tehran', 'yazd', 'gilan'] as const) {
      for (const route of this.resolvedRoutes.get(cityId) ?? []) {
        if (!route.valid) continue;
        const running = Array.from(this.buses.values()).filter(
          (bus) => bus.route.config.id === route.config.id && !bus.vehicle.isDestroyed,
        ).length;
        for (let count = running; count < route.config.vehicles; count++) {
          if (!this.spawnBus(cityId, route)) needsAnotherAttempt = true;
        }
      }
      const taxiCount = Array.from(this.taxis.values()).filter(
        (taxi) => taxi.cityId === cityId && !taxi.vehicle.isDestroyed,
      ).length;
      for (let count = taxiCount; count < CITY_TRANSIT_CONFIG[cityId].taxi.population; count++) {
        if (!this.spawnTaxi(cityId)) needsAnotherAttempt = true;
      }
    }
    this.nextSpawnAttemptAt = time + (needsAnotherAttempt ? SERVICE_RESPAWN_MS : SERVICE_RESPAWN_MS * 3);
  }

  private spawnBus(cityId: CityId, route: ResolvedBusRoute): boolean {
    const traffic = this.traffic;
    const occupants = this.occupants;
    if (!traffic || !occupants || route.stops.length < 2) return false;

    // Shared interchanges are useful transfer points, so two lines can name
    // the same first stop. Try each curb on this line rather than repeatedly
    // competing for one occupied platform; the selected index keeps the loop
    // sequence and passenger destination logic intact.
    for (let startIndex = 0; startIndex < route.stops.length; startIndex += 1) {
      const start = route.stops[startIndex];
      if (!start) continue;
      const vehicle = traffic.spawnServiceVehicle(
        'bus',
        start.approachPosition,
        null,
        BUS_STOP_RANGE,
      );
      if (!vehicle) continue;
      if (!this.hasServiceDriver(vehicle, 'bus-driver')) {
        traffic.releaseDriver(vehicle.id);
        this.vehicles?.removeVehicle(vehicle);
        return false;
      }
      vehicle.sprite.setData('persistentTransitService', true);
      vehicle.sprite.setData('transitServiceKind', 'bus');
      vehicle.sprite.setData('transitRouteId', route.config.id);
      const runtime: BusRuntime = {
        cityId,
        route,
        vehicle,
        // A route starts at a real curb stop, so riders can board immediately
        // instead of waiting for the bus to complete an arbitrary first loop.
        state: 'dwelling',
        currentStopIndex: startIndex,
        targetStopIndex: startIndex,
        dwellRemainingMs: route.config.stopDurationMs,
        recoveryAttempts: 0,
        nextRecoveryAt: 0,
      };
      this.buses.set(vehicle.id, runtime);
      traffic.setDriverStopped(vehicle, true);
      this.beginBusPassengerBoarding(runtime);
      return true;
    }
    return false;
  }

  private spawnTaxi(cityId: CityId): boolean {
    const traffic = this.traffic;
    const occupants = this.occupants;
    const start = this.nextTaxiRoadTarget(cityId);
    if (!traffic || !occupants || !start) return false;
    const vehicle = traffic.spawnServiceVehicle(
      'taxi',
      start,
      null,
      TAXI_STOP_RANGE,
    );
    if (!vehicle) return false;
    if (!this.hasServiceDriver(vehicle, 'taxi-driver')) {
      traffic.releaseDriver(vehicle.id);
      this.vehicles?.removeVehicle(vehicle);
      return false;
    }
    vehicle.sprite.setData('persistentTransitService', true);
    vehicle.sprite.setData('transitServiceKind', 'taxi');
    const runtime: TaxiRuntime = {
      cityId,
      vehicle,
      state: 'AVAILABLE',
      roamTarget: this.nextTaxiRoadTarget(cityId),
      playerRequestPosition: null,
      destination: null,
      fare: null,
      farePaid: false,
      stateSince: this.now(),
      recoveryAttempts: 0,
      nextRecoveryAt: 0,
      validLaneRoute: true,
    };
    this.taxis.set(vehicle.id, runtime);
    traffic.configureDriver(vehicle, () => this.taxiTarget(vehicle.id), TAXI_STOP_RANGE, false);
    return true;
  }

  private updateBus(bus: BusRuntime, time: number, delta: number): void {
    if (bus.vehicle.isDestroyed || !bus.vehicle.sprite.active) {
      this.buses.delete(bus.vehicle.id);
      return;
    }
    const traffic = this.traffic;
    const driver = traffic?.driverFor(bus.vehicle) ?? null;
    if (!traffic || !driver) return;

    if (bus.state === 'dwelling') {
      bus.dwellRemainingMs = Math.max(0, bus.dwellRemainingMs - delta);
      if (bus.dwellRemainingMs > 0) return;
      this.cancelOutstandingBoarders(bus);
      bus.state = 'approaching';
      bus.targetStopIndex = this.nextStopIndex(bus.route, bus.currentStopIndex);
      traffic.configureDriver(bus.vehicle, () => this.busTarget(bus.vehicle.id), BUS_STOP_RANGE, false);
      return;
    }
    if (driver.arrived) {
      bus.currentStopIndex = bus.targetStopIndex;
      bus.state = 'dwelling';
      bus.dwellRemainingMs = bus.route.config.stopDurationMs;
      bus.recoveryAttempts = 0;
      traffic.setDriverStopped(bus.vehicle, true);
      this.disembarkBusPassengers(bus);
      this.beginBusPassengerBoarding(bus);
      return;
    }
    if (driver.state === 'Recovering' && time >= bus.nextRecoveryAt) {
      bus.nextRecoveryAt = time + BUS_RECOVERY_DELAY_MS;
      bus.recoveryAttempts += 1;
      if (bus.recoveryAttempts <= MAX_RECOVERY_ATTEMPTS) {
        driver.forceReplan();
      } else {
        // Skip only the unreachable stop. The bus remains on its legal current lane.
        bus.targetStopIndex = this.nextStopIndex(bus.route, bus.targetStopIndex);
        bus.recoveryAttempts = 0;
        traffic.configureDriver(bus.vehicle, () => this.busTarget(bus.vehicle.id), BUS_STOP_RANGE, false);
      }
    }
  }

  private updateTaxi(taxi: TaxiRuntime, time: number): void {
    if (taxi.vehicle.isDestroyed || !taxi.vehicle.sprite.active) {
      this.taxis.delete(taxi.vehicle.id);
      return;
    }
    const traffic = this.traffic;
    const driver = traffic?.driverFor(taxi.vehicle) ?? null;
    if (!traffic || !driver) return;

    if (taxi.state === 'AVAILABLE') {
      if (driver.arrived) {
        taxi.roamTarget = this.nextTaxiRoadTarget(taxi.cityId);
        traffic.configureDriver(taxi.vehicle, () => this.taxiTarget(taxi.vehicle.id), TAXI_STOP_RANGE, false);
      }
    } else if (taxi.state === 'APPROACHING_PLAYER') {
      const playerPosition = this.player?.playerPosition;
      if (!playerPosition || time - taxi.stateSince > TAXI_HAIL_TIMEOUT_MS) {
        this.returnTaxiToService(taxi);
      } else if (driver.arrived) {
        taxi.state = 'WAITING_FOR_PLAYER';
        taxi.stateSince = time;
        traffic.setDriverStopped(taxi.vehicle, true);
      }
    } else if (taxi.state === 'PASSENGER_BOARDING') {
      if (this.player?.playerIsTransitPassenger && this.player.currentVehicle?.id === taxi.vehicle.id) {
        taxi.state = 'WAITING_FOR_PLAYER';
        taxi.stateSince = time;
        traffic.setDriverStopped(taxi.vehicle, true);
        this.bus.emit(EventKeys.UIToast, { message: 'Choose a taxi destination on the map' });
        ServiceLocator.tryResolve<GameManager>(ServiceKeys.Game)?.openMap();
      } else if (time - taxi.stateSince > TAXI_BOARD_TIMEOUT_MS) {
        this.occupants?.releasePlayerPassengerSeat(taxi.vehicle);
        this.returnTaxiToService(taxi);
      }
    } else if (taxi.state === 'IN_SERVICE') {
      if (driver.arrived) {
        taxi.state = 'ARRIVING';
        taxi.stateSince = time;
        traffic.setDriverStopped(taxi.vehicle, true);
        this.bus.emit(EventKeys.UIToast, { message: 'Taxi has arrived. Press E to exit.' });
      }
    } else if (taxi.state === 'ARRIVING' || taxi.state === 'COMPLETED') {
      if (this.player?.currentVehicle?.id !== taxi.vehicle.id) this.returnTaxiToService(taxi);
    }

    if (
      (taxi.state === 'AVAILABLE' || taxi.state === 'APPROACHING_PLAYER' || taxi.state === 'IN_SERVICE') &&
      driver.state === 'Recovering' &&
      time >= taxi.nextRecoveryAt
    ) {
      taxi.nextRecoveryAt = time + TAXI_RECOVERY_DELAY_MS;
      taxi.recoveryAttempts += 1;
      if (taxi.recoveryAttempts <= MAX_RECOVERY_ATTEMPTS) driver.forceReplan();
      else {
        taxi.recoveryAttempts = 0;
        if (taxi.state === 'IN_SERVICE' && taxi.destination) {
          traffic.configureDriver(taxi.vehicle, () => taxi.destination?.position ?? null, TAXI_STOP_RANGE, false);
        } else {
          taxi.roamTarget = this.nextTaxiRoadTarget(taxi.cityId);
          traffic.configureDriver(taxi.vehicle, () => this.taxiTarget(taxi.vehicle.id), TAXI_STOP_RANGE, false);
        }
      }
    }
  }

  private refreshPassengerPlans(): void {
    const pedestrians = this.pedestrians?.pedestrians ?? [];
    const live = new Set<number>();
    for (const pedestrian of pedestrians) {
      const stop = pedestrian.ai.waitingBusStop;
      if (!stop) continue;
      live.add(pedestrian.id);
      if (!this.passengerPlans.has(pedestrian.id)) this.assignPassengerPlan(pedestrian, stop);
    }
    for (const [id, plan] of this.passengerPlans) {
      if (!live.has(id) && plan.phase === 'waiting') this.passengerPlans.delete(id);
    }
  }

  private assignPassengerPlan(pedestrian: Pedestrian, stop: BusStopSite): void {
    const choices = (this.resolvedRoutes.get(stop.cityId) ?? []).filter(
      (route) => route.valid && route.stops.some((candidate) => candidate.id === stop.id),
    );
    if (choices.length === 0) return;
    const route = choices[Math.abs(pedestrian.id) % choices.length];
    if (!route) return;
    const origin = route.stops.findIndex((candidate) => candidate.id === stop.id);
    if (origin < 0 || route.stops.length < 2) return;
    const offset = 1 + (Math.abs(pedestrian.id * 7) % (route.stops.length - 1));
    const destination = route.stops[(origin + offset) % route.stops.length];
    if (!destination) return;
    this.passengerPlans.set(pedestrian.id, {
      pedestrianId: pedestrian.id,
      routeId: route.config.id,
      originStopId: stop.id,
      destinationStopId: destination.id,
      phase: 'waiting',
    });
  }

  private beginBusPassengerBoarding(bus: BusRuntime): void {
    const stop = this.currentBusStop(bus);
    const pedestrians = this.pedestrians?.pedestrians ?? [];
    const occupants = this.occupants;
    if (!stop || !occupants) return;
    for (const pedestrian of pedestrians) {
      const plan = this.passengerPlans.get(pedestrian.id);
      if (
        !plan ||
        plan.phase !== 'waiting' ||
        plan.routeId !== bus.route.config.id ||
        plan.originStopId !== stop.id ||
        occupants.availablePassengerSeats(bus.vehicle).length === 0
      ) {
        continue;
      }
      // The curb platform is the pedestrian-reachable side of the door. The
      // occupant system then renders the short platform-to-seat door motion.
      if (pedestrian.ai.beginTransitBoarding({ x: stop.x, y: stop.y })) {
        plan.phase = 'walking-to-door';
      }
    }
  }

  private processPassengerBoardingWalks(): void {
    const pedestrians = this.pedestrians;
    const occupants = this.occupants;
    if (!pedestrians || !occupants) return;
    for (const pedestrian of pedestrians.pedestrians) {
      const plan = this.passengerPlans.get(pedestrian.id);
      if (!plan || plan.phase !== 'walking-to-door' || !pedestrian.ai.transitBoardingReady) continue;
      const bus = Array.from(this.buses.values()).find(
        (candidate) => candidate.route.config.id === plan.routeId && candidate.state === 'dwelling',
      );
      if (!bus) {
        pedestrian.ai.cancelTransitBoarding();
        this.passengerPlans.delete(pedestrian.id);
        continue;
      }
      const passenger = occupants.claimTransitPassenger(
        bus.vehicle,
        pedestrian.personality,
        plan.destinationStopId,
      );
      if (!passenger || !occupants.beginBoarding(bus.vehicle, passenger, pedestrian.position)) {
        pedestrian.ai.cancelTransitBoarding();
        this.passengerPlans.delete(pedestrian.id);
        continue;
      }
      pedestrians.removeById(pedestrian.id);
      this.passengerPlans.delete(pedestrian.id);
    }
  }

  private disembarkBusPassengers(bus: BusRuntime): void {
    const stop = this.currentBusStop(bus);
    const occupants = this.occupants;
    if (!stop || !occupants) return;
    for (const occupant of occupants.occupantsFor(bus.vehicle)) {
      if (
        occupant.role === 'passenger' &&
        occupant.state === 'seated' &&
        occupant.transitDestinationStopId === stop.id
      ) {
        occupants.beginTransitExit(bus.vehicle, occupant);
      }
    }
  }

  private processCompletedPassengerExits(): void {
    const exits = this.occupants?.drainCompletedExits('transit-exit') ?? [];
    for (const exit of exits) {
      const vehicle = this.vehicles?.vehicles.find((candidate) => candidate.id === exit.vehicleId) ?? null;
      const requested = { x: exit.x, y: exit.y };
      const safe = this.world?.resolveSafePedestrianPosition(requested, PLAYER.RADIUS, {
        maxDistance: 80,
        segmentStart: vehicle ? { x: vehicle.sprite.x, y: vehicle.sprite.y } : undefined,
      });
      if (!safe) continue;
      const pedestrian = this.pedestrians?.spawnFromVehicleOccupant(exit.occupant, safe.x, safe.y);
      const stop = this.stopForPassengerExit(exit.vehicleId, exit.occupant);
      if (pedestrian && stop) pedestrian.ai.setHomeArea(stop.x, stop.y, 220);
    }
  }

  private stopForPassengerExit(vehicleId: number, occupant: VehicleOccupantRecord): BusStopSite | null {
    const bus = this.buses.get(vehicleId);
    if (!bus || !occupant.transitDestinationStopId) return null;
    return bus.route.stops.find((stop) => stop.id === occupant.transitDestinationStopId) ?? null;
  }

  private cancelOutstandingBoarders(bus: BusRuntime): void {
    for (const [pedestrianId, plan] of this.passengerPlans) {
      if (plan.routeId !== bus.route.config.id || plan.phase !== 'walking-to-door') continue;
      const pedestrian = this.pedestrians?.pedestrians.find((candidate) => candidate.id === pedestrianId);
      pedestrian?.ai.cancelTransitBoarding();
      this.passengerPlans.delete(pedestrianId);
    }
  }

  private handlePlayerInteraction(position: Vector2): void {
    if (!this.runtimeReady) return;
    const interaction = this.interactionAt(position);
    if (!interaction) return;
    if (interaction.kind === 'exit-transit') {
      this.exitPlayerTransit();
      return;
    }
    if (interaction.kind === 'take-taxi') {
      const taxi = this.nearestTaxi(position, TAXI_INTERACTION_RANGE, ['AVAILABLE', 'WAITING_FOR_PLAYER']);
      if (taxi) this.requestTaxiBoarding(taxi.vehicle.id);
      return;
    }
    if (interaction.kind === 'board-bus') {
      const bus = this.nearestBoardableBus(position);
      if (bus) this.requestBusBoarding(bus.vehicle.id);
      return;
    }
    if (interaction.kind === 'view-bus-stop') {
      const stop = this.nearestBusStop(position, STOP_INTERACTION_RANGE);
      if (stop) {
        this.discoveredStopIds.add(stop.id);
        const names = (this.resolvedRoutes.get(stop.cityId) ?? [])
          .filter((route) => route.stops.some((candidate) => candidate.id === stop.id))
          .map((route) => route.config.id)
          .join(', ');
        this.bus.emit(EventKeys.UIToast, {
          message: names ? `Bus service: ${names}` : 'No bus service is currently assigned here',
        });
      }
      return;
    }
    if (interaction.kind === 'call-taxi') {
      this.requestTaxi(position);
    }
  }

  private beginBusBoarding(bus: BusRuntime): boolean {
    const occupants = this.occupants;
    const player = this.player;
    if (!occupants || !player || bus.state !== 'dwelling') return false;
    const seat = occupants.reservePlayerPassengerSeat(bus.vehicle);
    if (!seat) {
      this.bus.emit(EventKeys.UIToast, { message: 'Bus is full' });
      return false;
    }
    if (!player.beginPassengerBoarding(bus.vehicle, seat)) {
      occupants.releasePlayerPassengerSeat(bus.vehicle);
      return false;
    }
    return true;
  }

  private beginTaxiBoarding(taxi: TaxiRuntime): boolean {
    const occupants = this.occupants;
    const player = this.player;
    const traffic = this.traffic;
    if (
      !occupants ||
      !player ||
      !traffic ||
      (taxi.state !== 'AVAILABLE' && taxi.state !== 'WAITING_FOR_PLAYER')
    ) {
      return false;
    }
    const seat = occupants.reservePlayerPassengerSeat(taxi.vehicle);
    if (!seat) {
      this.bus.emit(EventKeys.UIToast, { message: 'Taxi is occupied' });
      return false;
    }
    traffic.setDriverStopped(taxi.vehicle, true);
    taxi.state = 'PASSENGER_BOARDING';
    taxi.stateSince = this.now();
    taxi.playerRequestPosition = null;
    if (!player.beginPassengerBoarding(taxi.vehicle, seat)) {
      occupants.releasePlayerPassengerSeat(taxi.vehicle);
      this.returnTaxiToService(taxi);
      return false;
    }
    return true;
  }

  private requestTaxi(position: Vector2): void {
    const cityId = this.world?.cityAt(position.x, position.y)?.id;
    const taxi = cityId ? this.nearestTaxiForCity(cityId) : null;
    const traffic = this.traffic;
    if (!taxi || !traffic) return;
    taxi.state = 'APPROACHING_PLAYER';
    taxi.stateSince = this.now();
    taxi.playerRequestPosition = { x: position.x, y: position.y };
    traffic.configureDriver(taxi.vehicle, () => this.taxiTarget(taxi.vehicle.id), TAXI_STOP_RANGE, false);
    this.bus.emit(EventKeys.UIToast, { message: 'Taxi is approaching through traffic' });
  }

  private returnTaxiToService(taxi: TaxiRuntime): void {
    const traffic = this.traffic;
    taxi.state = 'AVAILABLE';
    taxi.stateSince = this.now();
    taxi.playerRequestPosition = null;
    taxi.destination = null;
    taxi.fare = null;
    taxi.farePaid = false;
    taxi.recoveryAttempts = 0;
    taxi.roamTarget = this.nextTaxiRoadTarget(taxi.cityId);
    taxi.validLaneRoute = true;
    if (traffic) {
      traffic.configureDriver(taxi.vehicle, () => this.taxiTarget(taxi.vehicle.id), TAXI_STOP_RANGE, false);
    }
  }

  private busTarget(vehicleId: number): Vector2 | null {
    const bus = this.buses.get(vehicleId);
    const target = bus?.route.stops[bus.targetStopIndex];
    return target ? target.approachPosition : null;
  }

  private taxiTarget(vehicleId: number): Vector2 | null {
    const taxi = this.taxis.get(vehicleId);
    if (!taxi) return null;
    if (taxi.state === 'APPROACHING_PLAYER') return taxi.playerRequestPosition;
    if (taxi.state === 'IN_SERVICE') return taxi.destination?.position ?? null;
    return taxi.roamTarget;
  }

  private currentBusStop(bus: BusRuntime): BusStopSite | null {
    return bus.route.stops[bus.currentStopIndex] ?? null;
  }

  private nextStopIndex(route: ResolvedBusRoute, index: number): number {
    return route.stops.length > 0 ? (index + 1) % route.stops.length : 0;
  }

  /** Ordered curb candidates used to find a directed route cycle near an anchor. */
  private nearestStopsTo(
    position: Vector2,
    cityId: CityId,
    excluded: ReadonlySet<string>,
    limit: number,
  ): BusStopSite[] {
    const candidates: Array<{ stop: BusStopSite; distanceSq: number }> = [];
    for (const stop of this.world?.map.busStops ?? []) {
      if (stop.cityId !== cityId || excluded.has(stop.id)) continue;
      candidates.push({ stop, distanceSq: this.distanceSq(position, stop) });
    }
    candidates.sort((left, right) => left.distanceSq - right.distanceSq || left.stop.id.localeCompare(right.stop.id));
    return candidates.slice(0, Math.max(1, limit)).map((candidate) => candidate.stop);
  }

  private nextTaxiRoadTarget(cityId: CityId): Vector2 | null {
    const world = this.world;
    if (!world) return null;
    const config = CITY_TRANSIT_CONFIG[cityId];
    const points: Vector2[] = [];
    for (const landmarkId of config.taxi.serviceLandmarkIds) {
      const landmark = world.map.landmarks.find(
        (candidate) => candidate.id === landmarkId && candidate.cityId === cityId,
      );
      if (landmark) points.push(landmark.position);
    }
    for (const stop of world.map.busStops) {
      if (stop.cityId === cityId) points.push(stop.approachPosition);
    }
    if (points.length === 0) return null;
    const point = points[this.taxiRoamOrdinal++ % points.length];
    return point ? { x: point.x, y: point.y } : null;
  }

  private nearestTaxi(
    position: Vector2,
    range: number,
    states: readonly TaxiState[],
  ): TaxiRuntime | null {
    const maxSq = range * range;
    let selected: TaxiRuntime | null = null;
    let selectedSq = maxSq;
    for (const taxi of this.taxis.values()) {
      if (!states.includes(taxi.state)) continue;
      const distanceSq = this.distanceSq(position, taxi.vehicle.sprite);
      if (distanceSq <= selectedSq) {
        selected = taxi;
        selectedSq = distanceSq;
      }
    }
    return selected;
  }

  private nearestTaxiForCity(cityId: CityId): TaxiRuntime | null {
    let selected: TaxiRuntime | null = null;
    let selectedSq = Infinity;
    const playerPosition = this.player?.playerPosition;
    for (const taxi of this.taxis.values()) {
      if (taxi.cityId !== cityId || taxi.state !== 'AVAILABLE') continue;
      const distanceSq = playerPosition ? this.distanceSq(playerPosition, taxi.vehicle.sprite) : 0;
      if (distanceSq < selectedSq) {
        selected = taxi;
        selectedSq = distanceSq;
      }
    }
    return selected;
  }

  private nearestBoardableBus(position: Vector2): BusRuntime | null {
    let selected: BusRuntime | null = null;
    let selectedSq = BUS_INTERACTION_RANGE * BUS_INTERACTION_RANGE;
    for (const bus of this.buses.values()) {
      if (bus.state !== 'dwelling' || this.occupants?.availablePassengerSeats(bus.vehicle).length === 0) {
        continue;
      }
      const distanceSq = this.distanceSq(position, bus.vehicle.sprite);
      if (distanceSq <= selectedSq) {
        selected = bus;
        selectedSq = distanceSq;
      }
    }
    return selected;
  }

  private nearestBusStop(position: Vector2, range: number): BusStopSite | null {
    let selected: BusStopSite | null = null;
    let selectedSq = range * range;
    for (const stop of this.world?.map.busStops ?? []) {
      const distanceSq = this.distanceSq(position, stop);
      if (distanceSq <= selectedSq) {
        selected = stop;
        selectedSq = distanceSq;
      }
    }
    return selected;
  }

  /** A service vehicle is only usable after its real seated driver has been materialised. */
  private hasServiceDriver(vehicle: Vehicle, role: 'bus-driver' | 'taxi-driver'): boolean {
    return this.occupants?.occupantsFor(vehicle).some(
      (occupant) => occupant.seat === 'driver' && occupant.role === role && occupant.state === 'seated',
    ) ?? false;
  }

  private currentPlayerTaxi(): TaxiRuntime | null {
    const vehicle = this.player?.currentVehicle;
    return vehicle ? (this.taxis.get(vehicle.id) ?? null) : null;
  }

  private playerRideSnapshot(): TransitRideSnapshot | null {
    const player = this.player;
    const vehicle = player?.currentVehicle;
    if (!player?.playerIsTransitPassenger || !vehicle) return null;
    const bus = this.buses.get(vehicle.id);
    if (bus) {
      const current = this.currentBusStop(bus);
      const next = bus.route.stops[this.nextStopIndex(bus.route, bus.currentStopIndex)] ?? null;
      const labelFor = (index: number, stop: BusStopSite | null): string =>
        bus.route.config.anchors[index]?.label ?? stop?.id ?? '';
      return {
        kind: 'bus',
        vehicleId: vehicle.id,
        routeName: bus.route.config.name,
        currentStop: labelFor(bus.currentStopIndex, current),
        nextStop: labelFor(this.nextStopIndex(bus.route, bus.currentStopIndex), next),
        upcomingStops: bus.route.stops.map((stop, index) => labelFor(index, stop)),
        status: bus.state === 'dwelling' ? 'At stop' : 'In service',
        canExit: bus.state === 'dwelling',
      };
    }
    const taxi = this.taxis.get(vehicle.id);
    if (!taxi) return null;
    return {
      kind: 'taxi',
      vehicleId: vehicle.id,
      destination: taxi.destination?.label,
      status:
        taxi.state === 'WAITING_FOR_PLAYER'
          ? 'Choose destination'
          : taxi.state === 'ARRIVING'
            ? 'Arrived'
            : taxi.state === 'IN_SERVICE'
              ? 'En route'
              : 'Boarding',
      fareTotal: taxi.fare?.total,
      canExit: taxi.state === 'ARRIVING' || taxi.state === 'WAITING_FOR_PLAYER',
    };
  }

  private safeTransitExitPosition(vehicle: Vehicle, stop: BusStopSite | null): Vector2 | null {
    const requested = stop?.waitingPositions[0] ?? null;
    if (requested) return { x: requested.x, y: requested.y };
    const heading = vehicle.sprite.rotation + Math.PI / 2;
    const distance = vehicle.def.width * 0.5 + PLAYER.RADIUS + 8;
    return {
      x: vehicle.sprite.x + Math.cos(heading) * distance,
      y: vehicle.sprite.y + Math.sin(heading) * distance,
    };
  }

  private busSnapshot(bus: BusRuntime): BusServiceSnapshot {
    const current = this.currentBusStop(bus);
    const next = bus.route.stops[this.nextStopIndex(bus.route, bus.currentStopIndex)];
    const passengerCount = (this.occupants?.occupantsFor(bus.vehicle) ?? []).filter(
      (occupant) => occupant.role === 'passenger',
    ).length +
      Number(this.player?.playerIsTransitPassenger && this.player.currentVehicle?.id === bus.vehicle.id);
    const target = bus.route.stops[bus.targetStopIndex];
    return {
      vehicleId: bus.vehicle.id,
      cityId: bus.cityId,
      routeId: bus.route.config.id,
      routeName: bus.route.config.name,
      routeColor: bus.route.config.color,
      state: bus.state,
      currentStopId: current?.id ?? '',
      nextStopId: next?.id ?? '',
      dwellRemainingMs: bus.dwellRemainingMs,
      passengerCount,
      passengerCapacity: bus.route.config.passengerCapacity,
      validLaneRoute: Boolean(target && this.traffic?.routePreview(bus.vehicle.position, target.approachPosition)),
    };
  }

  private taxiSnapshot(taxi: TaxiRuntime): TaxiServiceSnapshot {
    return {
      vehicleId: taxi.vehicle.id,
      cityId: taxi.cityId,
      state: taxi.state,
      hasDriver: (this.occupants?.occupantsFor(taxi.vehicle) ?? []).some(
        (occupant) => occupant.seat === 'driver' && occupant.role === 'taxi-driver',
      ),
      destination: taxi.destination,
      fare: taxi.fare,
      validLaneRoute: taxi.validLaneRoute,
    };
  }

  private removeDestroyedService(vehicleId: number): void {
    this.buses.delete(vehicleId);
    this.taxis.delete(vehicleId);
  }

  private removeServiceVehicles(): void {
    const traffic = this.traffic;
    const vehicles = this.vehicles;
    if (!vehicles) return;
    for (const bus of this.buses.values()) {
      traffic?.releaseDriver(bus.vehicle.id);
      vehicles.removeVehicle(bus.vehicle);
    }
    for (const taxi of this.taxis.values()) {
      traffic?.releaseDriver(taxi.vehicle.id);
      vehicles.removeVehicle(taxi.vehicle);
    }
  }

  private resetRuntime(): void {
    this.runtimeReady = false;
    this.serviceAccumulatorMs = 0;
    this.passengerPlanAccumulatorMs = 0;
    this.nextSpawnAttemptAt = 0;
    this.taxiRoamOrdinal = 0;
    this.resolvedRoutes.clear();
    this.buses.clear();
    this.taxis.clear();
    this.passengerPlans.clear();
  }

  private distanceSq(first: Vector2, second: { x: number; y: number }): number {
    const dx = first.x - second.x;
    const dy = first.y - second.y;
    return dx * dx + dy * dy;
  }

  private now(): number {
    return this.scene?.time.now ?? 0;
  }
}
