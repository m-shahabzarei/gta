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
import { t } from '@/config/Strings';
import type { ISerializable } from '@/core/interfaces';
import type { Json, Vector2 } from '@/core/types';
import {
  BUS_STOPPING_CONFIG,
  CITY_TRANSIT_CONFIG,
  calculateTaxiFare,
  type BusRouteSegment,
  type BusRouteStopValidation,
  type BusRouteValidation,
  type BusServiceSnapshot,
  type BusServiceState,
  type BusRouteConfig,
  type ResolvedBusRoute,
  type TaxiDestination,
  type TaxiFareQuote,
  type TaxiServiceSnapshot,
  type TaxiState,
  type TrafficRoutePreview,
  type TransitRideSnapshot,
  type TransportationDebugSnapshot,
  calculateSnappFare,
  SNAPP_CONFIG,
  TRANSIT_PIXELS_PER_KILOMETER,
  type SnappBookingSnapshot,
  type SnappBookingState,
  type SnappPickupAnchor,
  type SnappPaymentResult,
  type SnappQuote,
  type SnappTrackingSnapshot,
  type PassengerBoardingFailureReason,
  type PassengerBoardingResult,
  selectSnappPickupCandidate,
  isSnappBookingSnapshot,
} from '@/gameplay/transit';
import type { TrafficLane, TrafficLaneStopTarget } from '@/gameplay/traffic';
import type { BusStopSite, CityId, VehicleOccupantRecord, VehicleSeat } from '@/gameplay/types';
import type { Vehicle } from '@/entities/Vehicle';
import type { Pedestrian } from '@/entities/Pedestrian';
import type { WorldManager } from '@/systems/WorldManager';
import type { TrafficSystem } from '@/systems/TrafficSystem';
import type { VehicleSystem } from '@/systems/VehicleSystem';
import type { VehicleOccupantSystem } from '@/systems/VehicleOccupantSystem';
import type { PedestrianSystem } from '@/systems/PedestrianSystem';
import type { PlayerController } from '@/systems/PlayerController';
import type { GameManager } from '@/managers/GameManager';
import { VEHICLES } from '@/data/vehicles';

interface BusRuntime {
  cityId: CityId;
  route: ResolvedBusRoute;
  vehicle: Vehicle;
  state: BusServiceState;
  currentStopIndex: number;
  targetStopIndex: number;
  dwellRemainingMs: number;
  /** Boarding is enabled only while this exact bus is stopped at its assigned curb. */
  boardingActive: boolean;
  /** Keep the curb dwell open while the local player crosses a bus door. */
  playerBoardingInProgress: boolean;
  playerExitInProgress: boolean;
  playerTransitionDeadline: number;
  recoveryAttempts: number;
  nextRecoveryAt: number;
}

interface TaxiRuntime {
  cityId: CityId;
  vehicle: Vehicle;
  state: TaxiState;
  roamTarget: Vector2 | null;
  /** Newly spawned local reserve taxis hold briefly at a legal curb before roaming. */
  idleUntil: number;
  /** A rebalanced taxi waits at its reached local curb instead of immediately roaming away. */
  standAtNextTarget: boolean;
  /** Pedestrian-side reference point selected when the player hails this taxi. */
  playerRequestPosition: Vector2 | null;
  /** Legal lane point where the driver stops for pickup. */
  pickupPosition: Vector2 | null;
  /** Exact directed lane arc used by Snapp pickup validation. */
  pickupLaneStop: TrafficLaneStopTarget | null;
  /** Legal lane point where the driver stops near the selected destination. */
  dropoffPosition: Vector2 | null;
  /** Exact directed lane arc used by Snapp drop-off validation. */
  dropoffLaneStop: TrafficLaneStopTarget | null;
  destination: TaxiDestination | null;
  fare: TaxiFareQuote | null;
  farePaid: boolean;
  stateSince: number;
  recoveryAttempts: number;
  nextRecoveryAt: number;
  validLaneRoute: boolean;
  /** Set only while this existing taxi is assigned to a Snapp booking. */
  snappBookingId: string | null;
}

interface PassengerPlan {
  pedestrianId: number;
  routeId: string;
  originStopId: string;
  destinationStopId: string;
  phase: 'waiting' | 'walking-to-door';
}

interface TaxiRoadTarget {
  position: Vector2;
  route: TrafficRoutePreview;
  /** Present for targets selected from the authoritative lane graph. */
  laneStop?: TrafficLaneStopTarget;
}

interface SnappPickupRuntimeCandidate {
  laneId: string;
  roadSegmentId: string | null;
  laneRole: TrafficLane['role'];
  curbFacing: boolean;
  displacementPx: number;
  approachUsable: boolean;
  routeReachable: boolean;
  routeDistancePx: number;
  anchor: SnappPickupAnchor;
}

type SnappBoardingApproach =
  | { ok: true; door: Vector2; position: Vector2 }
  | {
      ok: false;
      reason: 'door-position-blocked' | 'boarding-approach-unavailable';
    };

/** One authored bus line awaiting its bounded startup resolution pass. */
interface RouteInitializationTask {
  cityId: CityId;
  config: BusRouteConfig;
}

export interface TransitInteraction {
  prompt: string;
  kind: 'board-bus' | 'call-taxi' | 'enter-taxi' | 'exit-transit';
  distanceSq: number;
}

const SERVICE_TICK_MS = 200;
const PASSENGER_PLAN_TICK_MS = 900;
const SERVICE_RESPAWN_MS = 1800;
const TAXI_PICKUP_TIMEOUT_MS = 90000;
const TAXI_WAITING_FOR_PASSENGER_TIMEOUT_MS = 30000;
const TAXI_BOARD_TIMEOUT_MS = 4500;
const TAXI_STOP_RANGE = 26;
const BUS_STOP_RANGE = BUS_STOPPING_CONFIG.stoppingRadius;
const BUS_RECOVERY_DELAY_MS = BUS_STOPPING_CONFIG.recoveryDelayMs;
const TAXI_RECOVERY_DELAY_MS = 1200;
const MAX_RECOVERY_ATTEMPTS = BUS_STOPPING_CONFIG.maxRecoveryAttempts;
const ROUTE_STOP_CANDIDATE_LIMIT = 8;
/** Keep the cheap geometric cycle selection local to each landmark's nearby curbs. */
const ROUTE_CYCLE_CANDIDATE_LIMIT = 5;
const BUS_INTERACTION_RANGE = 68;
const BUS_PLAYER_TRANSITION_GRACE_MS = 1200;
const BUS_STATIONARY_BLOCKER_RECOVERY_MS = 7000;
const TAXI_INTERACTION_RANGE = VEHICLE.ENTER_RANGE + 10;
const TAXI_PICKUP_SEARCH_RADIUS = 148;
const TAXI_PICKUP_JUNCTION_CLEARANCE = 92;
const TAXI_PICKUP_CLEARANCE = 54;
const TAXI_PICKUP_ARRIVAL_RANGE = 44;
const TAXI_DROPOFF_ARRIVAL_RANGE = 48;
/** Exact lane-arc tolerance applied after TrafficDriver reports arrival. */
const TAXI_LANE_STOP_TOLERANCE = TAXI_STOP_RANGE + 4;
const TAXI_LANE_HEADING_TOLERANCE = 0.35;
const TAXI_EXACT_TARGET_TOLERANCE = 12;
const SERVICE_STOP_SPEED = 3.5;
const TAXI_ENCOUNTER_MIN_SPAWN_DISTANCE = 168;
const TAXI_ENCOUNTER_PREFERRED_SPAWN_DISTANCE = 360;
const TAXI_ENCOUNTER_LANE_LIMIT = 18;
const TAXI_SERVICE_TARGET_LIMIT = 18;

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
  /** Route authoring can require exact graph searches, so it is scheduled one line per frame. */
  private readonly routeInitializationQueue: RouteInitializationTask[] = [];
  private runtimeReady = false;
  /**
   * Monotonic transport clock; never sourced from a paused Scene clock.
   * The old path wrote stateSince from scene.time.now but compared it with
   * ManagerRegistry STEP time, so resuming after Phone pause could expire
   * APPROACHING_PICKUP/WAITING_FOR_PASSENGER immediately.
   */
  private serviceClockMs = 0;
  private serviceAccumulatorMs = 0;
  private passengerPlanAccumulatorMs = 0;
  private nextSpawnAttemptAt = 0;
  private readonly taxiRoamOrdinals: Record<CityId, number> = {
    tehran: 0,
    yazd: 0,
    gilan: 0,
  };
  private snappBookingValue: SnappBookingSnapshot | null = null;
  private snappTrackingValue: SnappTrackingSnapshot | null = null;
  private snappTrackingAccumulatorMs = 0;
  private snappTrackingSequence = 0;
  private snappSelectionErrorValue: string | null = null;
  private snappSequence = 1;
  private snappRecoveryChecked = false;

  protected onInit(): void {
    this.subscribe(EventKeys.PlayerInteract, (position) => this.handlePlayerInteraction(position));
    this.subscribe(EventKeys.PlayerEnteredVehicle, (entry) => this.handlePlayerEnteredVehicle(entry));
    this.subscribe(EventKeys.VehicleDestroyed, ({ vehicleId }) => this.removeDestroyedService(vehicleId));
    this.subscribe(EventKeys.VehicleRemoved, ({ vehicleId }) => this.removeDestroyedService(vehicleId));
    this.subscribe(EventKeys.PlayerDied, () => this.failSnappBooking('Player died before the ride completed'));
    this.subscribe(EventKeys.PlayerBusted, () => this.failSnappBooking('Ride cancelled after arrest'));
    this.subscribe(EventKeys.GameNew, () => {
      for (const taxi of this.taxis.values()) {
        if (taxi.snappBookingId) this.returnTaxiToService(taxi);
      }
      this.snappBookingValue = null;
      this.snappTrackingValue = null;
      this.snappTrackingAccumulatorMs = 0;
      this.snappSelectionErrorValue = null;
      this.snappRecoveryChecked = false;
    });
  }

  protected onAttach(_scene: Phaser.Scene): void {
    this.resetRuntime();
    this.resolveServices();
    // Queueing is intentionally cheap. Exact lane-route authoring is performed
    // one configured line per later frame so this scene transition can paint.
    this.initializeRuntime();
  }

  protected override onDetach(_scene: Phaser.Scene): void {
    if (this.snappBookingValue && !this.isSnappTerminal(this.snappBookingValue.state)) {
      this.failSnappBooking('Transit service was closed before the ride completed');
    }
    this.removeServiceVehicles();
    this.resetRuntime();
    this.world = null;
    this.traffic = null;
    this.vehicles = null;
    this.occupants = null;
    this.pedestrians = null;
    this.player = null;
  }

  public update(_time: number, delta: number): void {
    this.advanceServiceClock(delta);
    this.resolveServices();
    this.initializeRuntime();
    this.processRouteInitialization();
    if (!this.runtimeReady) return;

    this.serviceAccumulatorMs += Math.min(delta, SERVICE_TICK_MS * 4);
    this.snappTrackingAccumulatorMs += Math.max(0, Math.min(1000, delta));
    this.passengerPlanAccumulatorMs += Math.min(delta, PASSENGER_PLAN_TICK_MS * 2);
    while (this.serviceAccumulatorMs >= SERVICE_TICK_MS) {
      this.serviceAccumulatorMs -= SERVICE_TICK_MS;
      this.updateServices(this.serviceClockMs, SERVICE_TICK_MS);
    }
    if (this.passengerPlanAccumulatorMs >= PASSENGER_PLAN_TICK_MS) {
      this.passengerPlanAccumulatorMs = 0;
      this.refreshPassengerPlans();
    }
    this.refreshSnappTracking(this.serviceClockMs);
  }

  /**
   * Phone policy: the modal freezes the world, but an active paid Snapp taxi
   * is allowed to advance through the existing TrafficSystem while the phone
   * is open. No player, pedestrian, mission, economy, or ambient traffic loop
   * is ticked by this path.
   */
  public updateWhilePhoneOpen(_time: number, delta: number): void {
    this.advanceServiceClock(delta);
    this.resolveServices();
    this.initializeRuntime();
    this.processRouteInitialization();
    if (!this.runtimeReady) return;
    const booking = this.snappBookingValue;
    const taxi = booking?.assignedVehicleId === null || booking?.assignedVehicleId === undefined
      ? null
      : this.taxis.get(booking.assignedVehicleId) ?? null;
    if (!booking || !taxi || this.isSnappTerminal(booking.state)) return;
    this.snappTrackingAccumulatorMs += Math.max(0, Math.min(1000, delta));
    this.updateTaxi(taxi, this.serviceClockMs);
    this.refreshSnappTracking(this.serviceClockMs);
  }

  /** Durable transit discovery only; vehicle/AI state is intentionally regenerated. */
  public serialize(): Json {
    return {
      version: 2,
      serviceClockMs: this.serviceClockMs,
      discoveredStopIds: Array.from(this.discoveredStopIds).sort(),
      snapp: this.snappBookingValue as unknown as Json,
    };
  }

  public deserialize(data: Json): void {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return;
    const savedClock = data['serviceClockMs'];
    if (typeof savedClock === 'number' && Number.isFinite(savedClock) && savedClock >= 0) {
      this.serviceClockMs = savedClock;
    }
    const ids = data.discoveredStopIds;
    if (Array.isArray(ids)) {
      this.discoveredStopIds.clear();
      for (const id of ids) {
        if (typeof id === 'string') this.discoveredStopIds.add(id);
      }
    }
    const snapp = data['snapp'];
    if (snapp !== undefined && snapp !== null && isSnappBookingSnapshot(snapp)) {
      this.snappBookingValue = this.normalizeSnappBooking(snapp as unknown as SnappBookingSnapshot);
      this.snappRecoveryChecked = false;
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
          taxiEncounterRadius: CITY_TRANSIT_CONFIG.tehran.taxi.encounterRadius,
          guaranteedNearbyTaxis: CITY_TRANSIT_CONFIG.tehran.taxi.guaranteedNearby,
        },
        yazd: {
          routes: CITY_TRANSIT_CONFIG.yazd.busRoutes.length,
          taxis: CITY_TRANSIT_CONFIG.yazd.taxi.population,
          taxiEncounterRadius: CITY_TRANSIT_CONFIG.yazd.taxi.encounterRadius,
          guaranteedNearbyTaxis: CITY_TRANSIT_CONFIG.yazd.taxi.guaranteedNearby,
        },
        gilan: {
          routes: CITY_TRANSIT_CONFIG.gilan.busRoutes.length,
          taxis: CITY_TRANSIT_CONFIG.gilan.taxi.population,
          taxiEncounterRadius: CITY_TRANSIT_CONFIG.gilan.taxi.encounterRadius,
          guaranteedNearbyTaxis: CITY_TRANSIT_CONFIG.gilan.taxi.guaranteedNearby,
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

  /** Current live Snapp booking, copied so Phone views cannot mutate gameplay state. */
  public get snappBooking(): SnappBookingSnapshot | null {
    return this.snappBookingValue ? this.cloneSnappBooking(this.snappBookingValue) : null;
  }

  /** Read-only live pose/route data for the Phone map and HUD. */
  public get snappTracking(): SnappTrackingSnapshot | null {
    return this.snappTrackingValue ? this.cloneSnappTracking(this.snappTrackingValue) : null;
  }

  /** Last request-time validation message, suitable for the Phone UI. */
  public get snappError(): string | null {
    return this.snappSelectionErrorValue;
  }

  /** Authoritative destinations available to Snapp in the player's current city. */
  public snappDestinations(cityId?: CityId): TaxiDestination[] {
    const position = this.player?.playerPosition;
    const resolvedCity = cityId ?? (position ? this.world?.cityAt(position.x, position.y)?.id : undefined);
    return resolvedCity ? this.taxiDestinations(resolvedCity) : [];
  }

  /** Begin a new destination selection; a second active booking is rejected. */
  public beginSnappSelection(): boolean {
    this.snappSelectionErrorValue = null;
    const existing = this.snappBookingValue;
    if (existing && !this.isSnappTerminal(existing.state)) return false;
    const player = this.player;
    const position = player?.playerPosition;
    const city = position ? this.world?.cityAt(position.x, position.y)?.id : undefined;
    if (!player?.player || !position || !city || player.playerInVehicle) {
      this.snappSelectionErrorValue = 'Snapp pickup is only available while you are on foot inside a city.';
      return false;
    }
    const pickupStop = this.resolveSnappPickupAnchor(position, city);
    if (!pickupStop) {
      this.snappSelectionErrorValue ??=
        'No safe Snapp pickup is available on your current street. Move closer to the curb and try again.';
      return false;
    }
    this.snappBookingValue = {
      version: 3,
      id: this.nextSnappId('booking'),
      transactionId: this.nextSnappId('tx'),
      state: 'SELECTING_DESTINATION',
      cityId: city,
      pickup: { ...position },
      pickupRotation: this.playerEntityRotation(),
      pickupAnchor: { ...pickupStop.position },
      pickupStop: this.cloneSnappPickupAnchor(pickupStop),
      pickupWalkingDistancePx: pickupStop.displacementPx,
      pickupAnchorLabel: this.pickupAnchorLabel(city),
      destination: null,
      dropoffPosition: null,
      quote: null,
      payment: 'unpaid',
      assignedVehicleId: null,
      driverArrivedAtServiceMs: null,
      pickupDeadlineServiceMs: null,
      createdAt: Date.now(),
      error: null,
    };
    this.snappRecoveryChecked = true;
    return true;
  }

  /** Select a real destination and create a legal-route quote without charging. */
  public previewSnappDestination(destination: TaxiDestination): SnappQuote | null {
    const player = this.player;
    const world = this.world;
    const position = player?.playerPosition;
    if (!player?.player || !world || !position || player.playerInVehicle) return null;
    const city = world.cityAt(position.x, position.y)?.id;
    if (!city || destination.cityId !== city) return null;
    const canonical = this.snappDestinations(city).find((candidate) => candidate.id === destination.id);
    if (!canonical) return null;
    if (!this.snappBookingValue || this.isSnappTerminal(this.snappBookingValue.state)) {
      if (!this.beginSnappSelection()) return null;
    }
    const booking = this.snappBookingValue;
    if (!booking || !this.isSnappSelectionState(booking.state)) return null;
    const geometryTaxi = this.findSnappGeometryTaxi(city);
    if (!geometryTaxi) {
      booking.error = 'No Snapp vehicle is available right now.';
      return null;
    }
    const pickupStop = this.ensureBookingPickupStop(booking);
    if (!pickupStop) {
      booking.error = 'No safe Snapp pickup is available on your current street. Move closer to the curb and try again.';
      return null;
    }
    const dropoff = this.resolveTaxiRoadTarget(geometryTaxi, canonical.position, false);
    if (!dropoff) {
      booking.error = 'This destination is not reachable by road.';
      return null;
    }
    const route = this.traffic?.routePreview(pickupStop.position, dropoff.position) ?? null;
    if (!route || route.laneIds.length === 0) {
      booking.error = 'This destination is not reachable by road.';
      return null;
    }
    const quote = calculateSnappFare(
      CITY_TRANSIT_CONFIG[city].taxi,
      route,
      booking.pickup,
      canonical,
      world.trafficDensityAt(booking.pickup.x, booking.pickup.y),
      Date.now(),
      pickupStop.position,
      booking.pickupAnchorLabel ?? this.pickupAnchorLabel(city),
      dropoff.position,
    );
    booking.cityId = city;
    booking.pickupAnchor = { ...pickupStop.position };
    booking.pickupStop = this.cloneSnappPickupAnchor(pickupStop);
    booking.pickupWalkingDistancePx = pickupStop.displacementPx;
    booking.pickupAnchorLabel = booking.pickupAnchorLabel ?? this.pickupAnchorLabel(city);
    booking.destination = { ...canonical, position: { ...canonical.position } };
    booking.dropoffPosition = { ...dropoff.position };
    booking.quote = quote;
    booking.state = 'QUOTE_READY';
    booking.error = null;
    this.bus.emit(EventKeys.SnappDestinationSelected, {
      bookingId: booking.id,
      destinationId: canonical.id,
    });
    this.bus.emit(EventKeys.SnappQuoteCreated, { bookingId: booking.id, quote });
    return { ...quote, pickup: { ...quote.pickup }, destination: { ...quote.destination, position: { ...quote.destination.position } } };
  }

  /** Select an authoritative world-map point, snapping it to a legal drop-off. */
  public previewSnappMapPoint(position: Vector2, label = 'Map pin'): SnappQuote | null {
    const world = this.world;
    const player = this.player;
    if (!world || !player?.player || player.playerInVehicle || !Number.isFinite(position.x) || !Number.isFinite(position.y)) {
      return null;
    }
    const city = world.cityAt(position.x, position.y)?.id;
    if (!city) {
      if (this.snappBookingValue) this.snappBookingValue.error = 'Choose a point inside a city service area.';
      return null;
    }
    const geometryTaxi = this.findSnappGeometryTaxi(city);
    if (!geometryTaxi) {
      if (this.snappBookingValue) this.snappBookingValue.error = 'No Snapp vehicle is available right now.';
      return null;
    }
    if (!this.snappBookingValue || this.isSnappTerminal(this.snappBookingValue.state)) {
      if (!this.beginSnappSelection()) return null;
    }
    const booking = this.snappBookingValue;
    if (!booking || !this.isSnappSelectionState(booking.state)) return null;
    const pickupStop = this.ensureBookingPickupStop(booking);
    if (!pickupStop) return null;
    const dropoff = this.resolveTaxiRoadTarget(geometryTaxi, position, false);
    if (!dropoff) {
      booking.error = 'This map point has no legal road drop-off.';
      return null;
    }
    const route = this.traffic?.routePreview(pickupStop.position, dropoff.position) ?? null;
    if (!route || route.laneIds.length === 0) {
      booking.error = 'This destination is not reachable by road.';
      return null;
    }
    const destination: TaxiDestination = {
      id: `map:${Math.round(position.x)}:${Math.round(position.y)}`,
      label,
      position: { x: position.x, y: position.y },
      cityId: city,
      source: 'map',
    };
    const quote = calculateSnappFare(
      CITY_TRANSIT_CONFIG[city].taxi,
      route,
      booking.pickup,
      destination,
      world.trafficDensityAt(booking.pickup.x, booking.pickup.y),
      Date.now(),
      pickupStop.position,
      booking.pickupAnchorLabel ?? this.pickupAnchorLabel(city),
      dropoff.position,
    );
    booking.cityId = city;
    booking.destination = destination;
    booking.dropoffPosition = { ...dropoff.position };
    booking.quote = quote;
    booking.state = 'QUOTE_READY';
    booking.error = null;
    this.bus.emit(EventKeys.SnappDestinationSelected, { bookingId: booking.id, destinationId: destination.id });
    this.bus.emit(EventKeys.SnappQuoteCreated, { bookingId: booking.id, quote });
    return { ...quote, pickup: { ...quote.pickup }, destination: { ...quote.destination, position: { ...quote.destination.position } } };
  }

  /** Pay the exact quote once, then dispatch an existing legal taxi as Snapp. */
  public confirmSnappBooking(): SnappPaymentResult {
    const booking = this.snappBookingValue;
    const player = this.player?.player;
    if (!booking || booking.state !== 'QUOTE_READY' || !booking.quote || !booking.destination || !player) {
      return booking?.payment === 'paid' ? 'already-paid' : 'invalid-quote';
    }
    if (booking.payment === 'paid') return 'already-paid';
    const candidate = this.findSnappDispatchCandidate(booking);
    if (!candidate) {
      booking.state = 'FAILED';
      booking.error = 'No Snapp vehicle is available right now.';
      this.bus.emit(EventKeys.SnappPaymentFailed, { bookingId: booking.id, reason: booking.error });
      this.bus.emit(EventKeys.SnappBookingFailed, { bookingId: booking.id, reason: booking.error, refunded: false });
      return 'invalid-quote';
    }
    booking.state = 'PAYMENT_PENDING';
    if (!player.inventory.spendMoney(booking.quote.total)) {
      booking.state = 'QUOTE_READY';
      booking.error = 'Not enough money for this ride.';
      this.bus.emit(EventKeys.SnappPaymentFailed, { bookingId: booking.id, reason: booking.error });
      return 'insufficient-funds';
    }
    booking.payment = 'paid';
    booking.state = 'DRIVER_EN_ROUTE';
    booking.assignedVehicleId = candidate.taxi.vehicle.id;
    booking.error = null;
    const taxi = candidate.taxi;
    taxi.snappBookingId = booking.id;
    taxi.playerRequestPosition = { ...booking.pickup };
    taxi.pickupPosition = { ...candidate.pickup.position };
    taxi.pickupLaneStop = candidate.pickup.laneStop ?? null;
    taxi.dropoffPosition = { ...candidate.dropoff.position };
    taxi.dropoffLaneStop = candidate.dropoff.laneStop ?? null;
    taxi.destination = { ...booking.destination, position: { ...booking.destination.position } };
    taxi.fare = { ...booking.quote, route: booking.quote.route };
    taxi.farePaid = true;
    taxi.validLaneRoute = true;
    taxi.idleUntil = 0;
    taxi.standAtNextTarget = false;
    taxi.recoveryAttempts = 0;
    taxi.vehicle.sprite.setData('snappBookingId', booking.id);
    taxi.vehicle.sprite.setData('serviceLivery', 'snapp');
    taxi.vehicle.sprite.setTint(SNAPP_CONFIG.turquoise);
    this.setTaxiState(taxi, 'APPROACHING_PICKUP');
    const configured = taxi.pickupLaneStop
      ? this.traffic?.configureDriverAtLaneStop(
        taxi.vehicle,
        () => this.taxiTarget(taxi.vehicle.id),
        taxi.pickupLaneStop,
        TAXI_STOP_RANGE,
        false,
        candidate.pickup.route.laneIds,
      )
      : this.traffic?.configureDriver(taxi.vehicle, () => this.taxiTarget(taxi.vehicle.id), TAXI_STOP_RANGE, false);
    if (configured === false) {
      this.failSnappBooking('Snapp pickup route became unavailable');
      return 'invalid-quote';
    }
    this.bus.emit(EventKeys.SnappPaymentCompleted, {
      bookingId: booking.id,
      transactionId: booking.transactionId,
      amount: booking.quote.total,
    });
    this.bus.emit(EventKeys.SnappDriverAssigned, { bookingId: booking.id, vehicleId: taxi.vehicle.id });
    this.bus.emit(EventKeys.SnappDriverEnRoute, { bookingId: booking.id, vehicleId: taxi.vehicle.id });
    return 'paid';
  }

  /** Cancel before boarding and refund exactly once; riding cancellation is not offered in the MVP. */
  public cancelSnappBooking(reason = 'Ride cancelled'): boolean {
    const booking = this.snappBookingValue;
    if (!booking || !['DRIVER_EN_ROUTE', 'DRIVER_ARRIVED'].includes(booking.state)) return false;
    const taxi = booking.assignedVehicleId === null ? null : this.taxis.get(booking.assignedVehicleId) ?? null;
    if (taxi && taxi.state !== 'APPROACHING_PICKUP' && taxi.state !== 'WAITING_FOR_PASSENGER') return false;
    if (taxi) this.returnTaxiToService(taxi);
    this.log.info(`Snapp ${booking.id} cancelled: ${reason}`);
    booking.state = 'CANCELLED';
    const refunded = this.refundSnappBooking(reason);
    this.bus.emit(EventKeys.SnappBookingCancelled, { bookingId: booking.id, refunded });
    if (reason === t('phoneSnappNoShow')) {
      this.bus.emit(EventKeys.UIToast, { message: reason, durationMs: 4200 });
    }
    return true;
  }

  /** Board a waiting Snapp taxi through the existing player/occupant transition. */
  public requestSnappBoarding(vehicleId: number): PassengerBoardingResult {
    const booking = this.snappBookingValue;
    if (!booking) return this.rejectSnappBoarding('wrong-booking');
    if (booking.assignedVehicleId !== vehicleId) return this.rejectSnappBoarding('wrong-vehicle');
    if (booking.state !== 'DRIVER_ARRIVED') {
      return this.rejectSnappBoarding('driver-not-arrived');
    }
    const player = this.player;
    if (!player?.player || player.player.isDead) {
      return this.rejectSnappBoarding('player-unavailable');
    }
    if (player.playerInVehicle) return this.rejectSnappBoarding('player-already-in-vehicle');
    const taxi = this.taxis.get(vehicleId);
    if (!taxi || taxi.snappBookingId !== booking.id) {
      return this.rejectSnappBoarding('wrong-booking');
    }
    if (taxi.vehicle.isDestroyed || !taxi.vehicle.sprite.active) {
      return this.rejectSnappBoarding('vehicle-destroyed');
    }
    if (taxi.state !== 'WAITING_FOR_PASSENGER' || !this.isVehicleStoppedAt(
      taxi.vehicle,
      taxi.pickupPosition,
      SNAPP_CONFIG.pickupArrivalWorldTolerancePx,
      false,
    )) {
      return this.rejectSnappBoarding('driver-not-arrived');
    }
    if (Math.abs(taxi.vehicle.movement.speed) > SNAPP_CONFIG.pickupStoppedSpeedPxPerSecond) {
      return this.rejectSnappBoarding('vehicle-moving');
    }
    const approach = this.resolveActualSnappBoardingApproach(taxi);
    if (!approach.ok) return this.rejectSnappBoarding(approach.reason);
    const playerPosition = player.playerPosition;
    if (!playerPosition) return this.rejectSnappBoarding('player-unavailable');
    const distancePx = Math.hypot(
      playerPosition.x - approach.position.x,
      playerPosition.y - approach.position.y,
    );
    if (distancePx > SNAPP_CONFIG.snappBoardingReachPx) {
      return this.rejectSnappBoarding(
        'too-far-from-door',
        distancePx - SNAPP_CONFIG.snappBoardingReachPx,
      );
    }
    const result = this.beginTaxiBoarding(taxi, approach.position);
    if (!result.ok) return this.rejectSnappBoarding(result.reason, result.distanceRemainingPx);
    this.snappSelectionErrorValue = null;
    return result;
  }

  /** Keep failed interaction feedback visible without changing the paid booking. */
  private rejectSnappBoarding(
    reason: PassengerBoardingFailureReason,
    distanceRemainingPx?: number,
  ): PassengerBoardingResult {
    const message = this.snappBoardingFailureMessage(reason, distanceRemainingPx);
    this.snappSelectionErrorValue = message;
    this.bus.emit(EventKeys.UIToast, { message, durationMs: 2400 });
    const booking = this.snappBookingValue;
    this.log.debug(
      `Snapp boarding rejected booking=${booking?.id ?? 'none'} vehicle=${booking?.assignedVehicleId ?? 'none'} ` +
        `reason=${reason}${distanceRemainingPx === undefined ? '' : ` remaining=${distanceRemainingPx.toFixed(1)}px`}`,
    );
    return distanceRemainingPx === undefined
      ? { ok: false, reason }
      : { ok: false, reason, distanceRemainingPx };
  }

  /** Select a map destination and produce a lane-route-based quote without charging the player. */
  public previewTaxiDestination(destination: TaxiDestination): TaxiFareQuote | null {
    const taxi = this.currentPlayerTaxi();
    const world = this.world;
    if (
      !taxi ||
      !this.isTaxiDestinationSelectionState(taxi.state) ||
      destination.cityId !== taxi.cityId ||
      !world
    ) {
      return null;
    }
    const target = this.resolveTaxiRoadTarget(taxi, destination.position, false);
    if (!target || target.route.laneIds.length === 0) return null;
    const quote = calculateTaxiFare(
      CITY_TRANSIT_CONFIG[taxi.cityId].taxi,
      target.route,
      world.trafficDensityAt(taxi.vehicle.sprite.x, taxi.vehicle.sprite.y),
    );
    taxi.destination = { ...destination, position: { ...destination.position } };
    taxi.dropoffPosition = { ...target.position };
    taxi.fare = quote;
    taxi.validLaneRoute = true;
    this.setTaxiState(taxi, 'FARE_CONFIRMATION');
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
    if (
      !taxi ||
      !player ||
      !traffic ||
      taxi.state !== 'FARE_CONFIRMATION' ||
      !taxi.destination ||
      !taxi.dropoffPosition ||
      !taxi.fare
    ) {
      return 'invalid-trip';
    }
    if (taxi.farePaid) return 'already-paid';
    if (!player.inventory.spendMoney(taxi.fare.total)) {
      this.bus.emit(EventKeys.UIToast, { message: 'Insufficient funds for this taxi fare' });
      return 'insufficient-funds';
    }
    taxi.farePaid = true;
    this.setTaxiState(taxi, 'IN_SERVICE');
    taxi.validLaneRoute = true;
    traffic.configureDriver(taxi.vehicle, () => this.taxiTarget(taxi.vehicle.id), TAXI_STOP_RANGE, false);
    this.bus.emit(EventKeys.UIToast, {
      message: `Taxi fare paid: $${taxi.fare.total}`,
      durationMs: 1800,
    });
    return 'paid';
  }

  /** Cancel a pre-payment taxi selection and let the player exit at the current safe curb. */
  public cancelTaxiDestination(): boolean {
    const taxi = this.currentPlayerTaxi();
    if (!taxi || !this.isTaxiDestinationSelectionState(taxi.state)) return false;
    const exit = this.safeTransitExitPosition(taxi.vehicle, null, taxi.playerRequestPosition);
    if (!exit || !this.player?.beginPassengerExit(exit)) return false;
    this.traffic?.setDriverStopped(taxi.vehicle, true);
    this.setTaxiState(taxi, 'PASSENGER_EXITING');
    taxi.destination = null;
    taxi.dropoffPosition = null;
    taxi.fare = null;
    taxi.farePaid = false;
    return true;
  }

  /** Interaction query consumed before generic vehicle/npc targets. */
  public interactionAt(position: Vector2): TransitInteraction | null {
    const ride = this.playerRideSnapshot();
    if (ride) {
      if (ride.canExit) {
        return {
          prompt: ride.kind === 'bus' ? 'EXIT BUS  E' : 'EXIT TAXI  E',
          kind: 'exit-transit',
          distanceSq: 0,
        };
      }
      // A passenger cannot hail, enter, or hijack another service vehicle.
      return null;
    }
    // A player driving another vehicle must exit it first. Returning a Snapp
    // boarding prompt here was misleading because passenger boarding correctly
    // rejects an existing driver seat and PlayerController routes F to exit.
    if (this.player?.playerInVehicle) return null;
    const snappBooking = this.snappBookingValue;
    if (snappBooking?.state === 'DRIVER_ARRIVED' && snappBooking.assignedVehicleId !== null) {
      const snappTaxi = this.taxis.get(snappBooking.assignedVehicleId) ?? null;
      const approach = snappTaxi ? this.resolveActualSnappBoardingApproach(snappTaxi) : null;
      if (
        snappTaxi &&
        approach?.ok === true &&
        snappTaxi.snappBookingId === snappBooking.id &&
        this.distanceSq(position, approach.position) <=
          SNAPP_CONFIG.snappBoardingReachPx * SNAPP_CONFIG.snappBoardingReachPx &&
        this.taxiCanBoard(snappTaxi)
      ) {
        return {
          prompt: t('phoneSnappEnterSnapp'),
          kind: 'enter-taxi',
          distanceSq: this.distanceSq(position, approach.position),
        };
      }
    }
    const pickupTaxi = this.nearestTaxi(
      position,
      TAXI_INTERACTION_RANGE,
      ['WAITING_FOR_PASSENGER'],
      (candidate) => candidate.snappBookingId === null && this.taxiCanBoard(candidate),
    );
    if (pickupTaxi) {
      return {
        prompt: 'ENTER TAXI  E',
        kind: 'enter-taxi',
        distanceSq: this.distanceSq(position, pickupTaxi.vehicle.sprite),
      };
    }
    const availableTaxi = this.nearestTaxi(
      position,
      TAXI_INTERACTION_RANGE,
      ['AVAILABLE'],
      (candidate) => this.isTaxiHireable(candidate),
    );
    if (availableTaxi) {
      return {
        prompt: 'CALL TAXI  E',
        kind: 'call-taxi',
        distanceSq: this.distanceSq(position, availableTaxi.vehicle.sprite),
      };
    }
    const bus = this.nearestBoardableBus(position);
    if (bus) {
      return {
        prompt: 'BOARD BUS  E',
        kind: 'board-bus',
        distanceSq: this.distanceSq(position, bus.vehicle.sprite),
      };
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
    return Boolean(
      taxi &&
        this.isTaxiDestinationSelectionState(taxi.state) &&
        this.player?.playerIsTransitPassenger === true,
    );
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

  /** Start a player boarding transition only after the hailed taxi has stopped at its pickup curb. */
  public requestTaxiBoarding(vehicleId: number): boolean {
    const taxi = this.taxis.get(vehicleId);
    return this.runtimeReady && taxi ? this.beginTaxiBoarding(taxi).ok : false;
  }

  /** Begin the player's door-mediated exit when the current transit service is stopped. */
  public exitPlayerTransit(): boolean {
    const player = this.player;
    const vehicle = player?.currentVehicle;
    if (!player?.playerIsTransitPassenger || !vehicle) return false;
    const bus = this.buses.get(vehicle.id);
    if (bus?.state === 'STOPPED_AT_STOP' && bus.boardingActive && this.busIsAtCurrentStop(bus)) {
      const exit = this.safeTransitExitPosition(vehicle, this.currentBusStop(bus));
      if (!exit || !player.beginPassengerExit(exit)) return false;
      bus.playerExitInProgress = true;
      bus.dwellRemainingMs = Math.max(bus.dwellRemainingMs, BUS_PLAYER_TRANSITION_GRACE_MS);
      return true;
    }
    const taxi = this.taxis.get(vehicle.id);
    if (taxi && taxi.state === 'ARRIVING' && this.taxiIsAtDropoff(taxi)) {
      const exit = this.safeTransitExitPosition(taxi.vehicle, null, taxi.destination?.position);
      if (!exit || !player.beginPassengerExit(exit)) return false;
      this.traffic?.setDriverStopped(taxi.vehicle, true);
      this.setTaxiState(taxi, 'PASSENGER_EXITING');
      return true;
    }
    return false;
  }

  /** Iterate only visible service vehicle positions for compact minimap blips. */
  public forEachServiceBlip(visitor: (kind: 'bus' | 'taxi' | 'snapp', position: Vector2) => void): void {
    for (const bus of this.buses.values()) {
      if (bus.vehicle.isDestroyed || !bus.vehicle.sprite.active) continue;
      visitor('bus', { x: bus.vehicle.sprite.x, y: bus.vehicle.sprite.y });
    }
    for (const taxi of this.taxis.values()) {
      if (taxi.vehicle.isDestroyed || !taxi.vehicle.sprite.active) continue;
      visitor(taxi.snappBookingId ? 'snapp' : 'taxi', { x: taxi.vehicle.sprite.x, y: taxi.vehicle.sprite.y });
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
    if (this.runtimeReady || this.routeInitializationQueue.length > 0) return;
    if (!this.world || !this.traffic || !this.vehicles || !this.occupants || !this.pedestrians) return;
    if (!this.traffic.roadNetwork || this.world.map.busStops.length === 0) return;
    this.resolvedRoutes.clear();
    for (const stop of this.world.map.busStops) stop.routeIds.length = 0;
    for (const cityId of ['tehran', 'yazd', 'gilan'] as const) {
      for (const config of CITY_TRANSIT_CONFIG[cityId].busRoutes) {
        this.routeInitializationQueue.push({ cityId, config });
      }
    }
    if (this.routeInitializationQueue.length === 0) this.finishRouteInitialization();
  }

  /** Resolve one configured line after a frame boundary, preserving authored config order. */
  private processRouteInitialization(): void {
    if (this.runtimeReady || this.routeInitializationQueue.length === 0) return;
    const task = this.routeInitializationQueue.shift();
    const traffic = this.traffic;
    if (!task || !traffic) return;

    const resolvedStops = this.resolveRouteStops(task.cityId, task.config, traffic);
    const route = this.buildResolvedBusRoute(task.cityId, task.config, resolvedStops);
    if (route.valid) {
      for (const stop of route.stops) {
        if (!stop.routeIds.includes(task.config.id)) stop.routeIds.push(task.config.id);
      }
    }
    const routes = this.resolvedRoutes.get(task.cityId) ?? [];
    routes.push(route);
    this.resolvedRoutes.set(task.cityId, routes);
    this.logRouteValidation(route);

    if (this.routeInitializationQueue.length === 0) this.finishRouteInitialization();
  }

  /** Enable service spawning only after every configured route has a diagnostic result. */
  private finishRouteInitialization(): void {
    this.runtimeReady = true;
    this.nextSpawnAttemptAt = 0;
  }

  private updateServices(time: number, delta: number): void {
    this.ensureServicePopulation(time);
    this.validateRestoredSnappBooking();
    this.processCompletedPassengerExits();
    for (const bus of Array.from(this.buses.values())) this.updateBus(bus, time, delta);
    for (const taxi of Array.from(this.taxis.values())) this.updateTaxi(taxi, time);
    this.processPassengerBoardingWalks();
  }

  /** Expose deterministic per-stop diagnostics to development tooling. */
  public validateBusRoutes(): readonly BusRouteValidation[] {
    return (['tehran', 'yazd', 'gilan'] as const).flatMap((cityId) =>
      (this.resolvedRoutes.get(cityId) ?? []).map((route) => route.validation),
    );
  }

  private buildResolvedBusRoute(
    cityId: CityId,
    config: BusRouteConfig,
    resolvedStops: BusStopSite[] | null,
  ): ResolvedBusRoute {
    const stops = resolvedStops ?? [];
    if (!config.active) {
      return {
        config,
        stops,
        segments: [],
        validation: {
          cityId,
          routeId: config.id,
          routeName: config.name,
          stops: [],
          connectivity: 'INVALID',
        },
        valid: false,
        issue: 'Route is disabled',
      };
    }
    if (stops.length < 3) {
      return {
        config,
        stops,
        segments: [],
        validation: {
          cityId,
          routeId: config.id,
          routeName: config.name,
          stops: config.anchors.map((anchor, index) => ({
            index,
            stopId: anchor.id,
            status: 'ERROR',
            issue: 'No valid directional road-connected stop resolved for anchor',
          })),
          connectivity: 'INVALID',
        },
        valid: false,
        issue: 'Unable to resolve a complete directed road route for all anchors',
      };
    }

    const { segments, validation } = this.validateResolvedBusRoute(cityId, config, stops);
    const issue =
      validation.connectivity === 'VALID'
        ? undefined
        : validation.stops.find((stop) => stop.status === 'ERROR')?.issue ??
          'No valid road connection between ordered stops';
    return {
      config,
      stops,
      segments,
      validation,
      valid: validation.connectivity === 'VALID',
      issue,
    };
  }

  /**
   * Validate the exact generated curb records and cache every complete directed
   * lane segment. This runs when routes are authored/resolved, never per frame.
   */
  private validateResolvedBusRoute(
    cityId: CityId,
    config: BusRouteConfig,
    stops: readonly BusStopSite[],
  ): { segments: readonly BusRouteSegment[]; validation: BusRouteValidation } {
    const network = this.traffic?.roadNetwork;
    const stopReports: BusRouteStopValidation[] = stops.map((stop, index) => ({
      index,
      stopId: stop.id,
      status: 'OK',
    }));
    const markInvalid = (index: number, issue: string): void => {
      const report = stopReports[index];
      if (!report || report.status === 'ERROR') return;
      report.status = 'ERROR';
      report.issue = issue;
    };
    if (!network) {
      for (let index = 0; index < stops.length; index += 1) {
        markInvalid(index, 'Traffic road graph is unavailable');
      }
      return {
        segments: [],
        validation: {
          cityId,
          routeId: config.id,
          routeName: config.name,
          stops: stopReports,
          connectivity: 'INVALID',
        },
      };
    }

    for (let index = 0; index < stops.length; index += 1) {
      const stop = stops[index];
      if (!stop) continue;
      if (
        !Number.isFinite(stop.x) ||
        !Number.isFinite(stop.y) ||
        !Number.isFinite(stop.stopPosition.x) ||
        !Number.isFinite(stop.stopPosition.y)
      ) {
        markInvalid(index, 'Invalid world or stopping position');
        continue;
      }
      const lane = network.lane(stop.laneId);
      if (!lane || lane.kind !== 'travel') {
        markInvalid(index, 'No valid road connection');
        continue;
      }
      if (lane.fromNodeId !== stop.roadNodeId || lane.toNodeId !== stop.resumeNodeId) {
        markInvalid(index, 'Road-node direction does not match stop lane');
        continue;
      }
      if (stop.laneDistance <= 0 || stop.laneDistance >= lane.spline.length) {
        markInvalid(index, 'Stopping distance is outside its road lane');
        continue;
      }
      const pose = network.pointAt(lane, stop.laneDistance);
      if (this.distanceSq(stop.stopPosition, pose.point) > 2 * 2) {
        markInvalid(index, 'Stopping position is not attached to its road lane');
        continue;
      }
      const directionDot =
        stop.approachDirection.x * pose.tangent.x + stop.approachDirection.y * pose.tangent.y;
      if (directionDot < 0.98) {
        markInvalid(index, 'Approach direction does not match its road lane');
      }
    }

    const segments: BusRouteSegment[] = [];
    for (let index = 0; index < stops.length; index += 1) {
      const from = stops[index];
      const to = stops[(index + 1) % stops.length];
      if (!from || !to) continue;
      const route = network.findCompleteRoute(from.laneId, to.laneId);
      if (!route || route.length === 0) {
        const issue = 'No valid road connection from previous stop';
        segments.push({ fromStopId: from.id, toStopId: to.id, laneIds: [], valid: false, issue });
        markInvalid((index + 1) % stops.length, issue);
        continue;
      }
      segments.push({
        fromStopId: from.id,
        toStopId: to.id,
        laneIds: route.map((lane) => lane.id),
        valid: true,
      });
    }
    const connectivity =
      stopReports.every((stop) => stop.status === 'OK') && segments.every((segment) => segment.valid)
        ? 'VALID'
        : 'INVALID';
    return {
      segments,
      validation: {
        cityId,
        routeId: config.id,
        routeName: config.name,
        stops: stopReports,
        connectivity,
      },
    };
  }

  private logRouteValidation(route: ResolvedBusRoute): void {
    const summary = route.validation.stops
      .map((stop) => `${String(stop.index + 1).padStart(2, '0')}:${stop.status}`)
      .join(' ');
    if (route.validation.connectivity === 'VALID') {
      this.log.debug(`${route.config.name} ${summary} Route connectivity: VALID`);
      return;
    }
    const issue = route.validation.stops.find((stop) => stop.status === 'ERROR')?.issue ?? route.issue;
    this.log.warn(`${route.config.name} route connectivity INVALID: ${issue ?? 'unknown route error'}`);
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
    const landmarks = config.anchors.map((anchor) =>
      anchor.landmarkIds
        .map((id) => world.map.landmarks.find((candidate) => candidate.id === id))
        .find((candidate) => candidate?.cityId === cityId) ?? null,
    );
    if (landmarks.some((landmark) => landmark === null)) return null;
    const anchoredCandidates = landmarks.map((landmark) => {
      if (!landmark) return [];
      return this.nearestStopsTo(
        landmark.position,
        cityId,
        new Set<string>(),
        ROUTE_STOP_CANDIDATE_LIMIT,
      );
    });
    if (anchoredCandidates.some((entry) => entry.length === 0)) return null;

    // Every selected curb must share a directed SCC so the cycle is possible
    // in both directions. Pick the smallest geographic loop from the nearby
    // candidates first; exact lane routes are then resolved and validated once
    // for that chosen loop. Running every candidate pair through full A* here
    // could perform hundreds of country-scale searches in the New Game click.
    const commonComponents = new Set<number>();
    for (const stop of anchoredCandidates[0] ?? []) {
      const component = network.strongComponentId(stop.laneId);
      if (component !== null) commonComponents.add(component);
    }
    for (let index = 1; index < anchoredCandidates.length; index += 1) {
      for (const component of Array.from(commonComponents)) {
        if (!(anchoredCandidates[index] ?? []).some((stop) => network.strongComponentId(stop.laneId) === component)) {
          commonComponents.delete(component);
        }
      }
    }

    let selected: { stops: BusStopSite[]; score: number } | null = null;
    for (const component of commonComponents) {
      const layers = anchoredCandidates.map((candidates) =>
        candidates
          .filter((stop) => network.strongComponentId(stop.laneId) === component)
          .slice(0, ROUTE_CYCLE_CANDIDATE_LIMIT),
      );
      if (layers.some((layer) => layer.length === 0)) continue;
      const cycle = this.lowestCostDirectedStopCycle(layers);
      if (cycle && (!selected || cycle.score < selected.score)) selected = cycle;
    }
    return selected?.stops ?? null;
  }

  /**
   * Resolve a small authored stop cycle using local geographic cost only. The
   * selected directed curb lanes have already passed the same-SCC test, and the
   * exact graph routes are built by `validateResolvedBusRoute` immediately
   * afterward. Keeping candidate scoring geometry-only bounds New Game work.
   */
  private lowestCostDirectedStopCycle(
    layers: readonly (readonly BusStopSite[])[],
  ): { stops: BusStopSite[]; score: number } | null {
    const pairCosts = new Map<string, number>();
    const routeCost = (from: BusStopSite, to: BusStopSite): number | null => {
      if (from.id === to.id) return null;
      const key = `${from.id}|${to.id}`;
      const cached = pairCosts.get(key);
      if (cached !== undefined) return cached;
      const distance = Math.hypot(from.stopPosition.x - to.stopPosition.x, from.stopPosition.y - to.stopPosition.y);
      pairCosts.set(key, distance);
      return distance;
    };

    let best: { stops: BusStopSite[]; score: number } | null = null;
    const selected: BusStopSite[] = [];
    const used = new Set<string>();
    const visit = (index: number, travelDistance: number): void => {
      if (best && travelDistance >= best.score) return;
      if (index >= layers.length) {
        const first = selected[0];
        const last = selected[selected.length - 1];
        if (!first || !last) return;
        const closingDistance = routeCost(last, first);
        if (closingDistance === null) return;
        const score = travelDistance + closingDistance;
        if (!best || score < best.score) {
          best = { stops: selected.slice(), score };
        }
        return;
      }
      for (const stop of layers[index] ?? []) {
        if (used.has(stop.id)) continue;
        const previous = selected[selected.length - 1];
        const legDistance = previous ? routeCost(previous, stop) : 0;
        if (legDistance === null) continue;
        selected.push(stop);
        used.add(stop.id);
        visit(index + 1, travelDistance + legDistance);
        used.delete(stop.id);
        selected.pop();
      }
    };
    visit(0, 0);
    return best;
  }

  private ensureServicePopulation(time: number): void {
    if (time < this.nextSpawnAttemptAt) return;
    let needsAnotherAttempt = false;
    const playerPosition = this.player?.playerPosition ?? null;
    const playerCity = playerPosition ? (this.world?.cityAt(playerPosition.x, playerPosition.y)?.id ?? null) : null;
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
      let taxiCount = Array.from(this.taxis.values()).filter(
        (taxi) => taxi.cityId === cityId && !taxi.vehicle.isDestroyed,
      ).length;
      const config = CITY_TRANSIT_CONFIG[cityId].taxi;
      let nearbyAvailable =
        playerCity === cityId && playerPosition
          ? this.nearbyAvailableTaxiCount(cityId, playerPosition, config.encounterRadius)
          : 0;
      for (let count = taxiCount; count < CITY_TRANSIT_CONFIG[cityId].taxi.population; count++) {
        const reserveLocalTaxi =
          playerCity === cityId &&
          playerPosition !== null &&
          nearbyAvailable < config.guaranteedNearby;
        if (!this.spawnTaxi(cityId, reserveLocalTaxi ? playerPosition : null, reserveLocalTaxi)) {
          needsAnotherAttempt = true;
          continue;
        }
        taxiCount += 1;
        if (reserveLocalTaxi) nearbyAvailable += 1;
      }
      if (
        playerCity === cityId &&
        playerPosition &&
        nearbyAvailable < config.guaranteedNearby &&
        !this.retargetAvailableTaxiForEncounter(cityId, playerPosition)
      ) {
        // A normal service taxi may be on the far side of a large city. It is
        // never teleported: this starts an ordinary legal drive toward a local
        // curb target so the next encounter is a real world vehicle.
        needsAnotherAttempt = true;
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
      const vehicle = traffic.spawnServiceVehicleAtLaneStop(
        'bus',
        this.busLaneStopTarget(start),
        null,
        BUS_STOP_RANGE,
      );
      if (!vehicle) continue;
      if (!this.hasServiceDriver(vehicle, 'bus-driver')) {
        traffic.releaseDriver(vehicle.id);
        this.vehicles?.removeVehicle(vehicle);
        return false;
      }
      this.vehicles?.markPersistentTransitService(vehicle, 'bus');
      vehicle.sprite.setData('transitRouteId', route.config.id);
      const runtime: BusRuntime = {
        cityId,
        route,
        vehicle,
        // A route starts at its exact legal curb target, so riders can board
        // immediately instead of waiting for an arbitrary first loop.
        state: 'BOARDING',
        currentStopIndex: startIndex,
        targetStopIndex: startIndex,
        dwellRemainingMs: route.config.stopDurationMs,
        boardingActive: false,
        playerBoardingInProgress: false,
        playerExitInProgress: false,
        playerTransitionDeadline: 0,
        recoveryAttempts: 0,
        nextRecoveryAt: 0,
      };
      this.buses.set(vehicle.id, runtime);
      if (!this.configureBusDriver(runtime, true)) {
        this.buses.delete(vehicle.id);
        traffic.releaseDriver(vehicle.id);
        this.vehicles?.removeVehicle(vehicle);
        continue;
      }
      return true;
    }
    return false;
  }

  private spawnTaxi(
    cityId: CityId,
    preferredPosition: Vector2 | null = null,
    holdForPlayer = false,
  ): boolean {
    const traffic = this.traffic;
    const occupants = this.occupants;
    if (!traffic || !occupants) return false;
    for (const start of this.taxiSpawnTargets(cityId, preferredPosition)) {
      const vehicle = traffic.spawnServiceVehicle('taxi', start, null, TAXI_STOP_RANGE);
      if (!vehicle) continue;
      if (!this.hasServiceDriver(vehicle, 'taxi-driver')) {
        traffic.releaseDriver(vehicle.id);
        this.vehicles?.removeVehicle(vehicle);
        continue;
      }
      this.vehicles?.markPersistentTransitService(vehicle, 'taxi');
      const runtime: TaxiRuntime = {
        cityId,
        vehicle,
        state: 'AVAILABLE',
        roamTarget: this.nextTaxiRoadTarget(cityId),
        idleUntil: holdForPlayer ? this.now() + CITY_TRANSIT_CONFIG[cityId].taxi.standDurationMs : 0,
        standAtNextTarget: false,
        playerRequestPosition: null,
        pickupPosition: null,
        pickupLaneStop: null,
        dropoffPosition: null,
        dropoffLaneStop: null,
        destination: null,
        fare: null,
        farePaid: false,
        stateSince: this.now(),
        recoveryAttempts: 0,
        nextRecoveryAt: 0,
        validLaneRoute: true,
        snappBookingId: null,
      };
      this.taxis.set(vehicle.id, runtime);
      traffic.configureDriver(vehicle, () => this.taxiTarget(vehicle.id), TAXI_STOP_RANGE, false);
      if (runtime.idleUntil > 0) traffic.setDriverStopped(vehicle, true);
      return true;
    }
    return false;
  }

  private updateBus(bus: BusRuntime, time: number, delta: number): void {
    if (bus.vehicle.isDestroyed || !bus.vehicle.sprite.active) {
      this.buses.delete(bus.vehicle.id);
      return;
    }
    const traffic = this.traffic;
    const driver = traffic?.driverFor(bus.vehicle) ?? null;
    if (!traffic || !driver) return;

    const serviceRecoveryReason = traffic.consumeServiceRecovery(bus.vehicle.id);
    if (serviceRecoveryReason !== null) {
      this.beginBusRecovery(bus, `Traffic driver escalation: ${serviceRecoveryReason}`);
    }

    if (bus.state === 'BOARDING') {
      if (!this.busIsAtCurrentStop(bus)) {
        this.beginBusRecovery(bus, 'Bus lost its assigned stop before boarding');
        return;
      }
      bus.boardingActive = true;
      this.beginBusPassengerBoarding(bus);
      bus.state = 'STOPPED_AT_STOP';
      return;
    }

    if (bus.state === 'STOPPED_AT_STOP') {
      if (bus.playerBoardingInProgress) {
        if (this.player?.playerIsTransitPassenger && this.player.currentVehicle?.id === bus.vehicle.id) {
          bus.playerBoardingInProgress = false;
        } else if (time < bus.playerTransitionDeadline) {
          bus.dwellRemainingMs = Math.max(bus.dwellRemainingMs, BUS_PLAYER_TRANSITION_GRACE_MS);
          return;
        } else {
          bus.playerBoardingInProgress = false;
        }
      }
      if (bus.playerExitInProgress) {
        if (this.player?.currentVehicle?.id === bus.vehicle.id) {
          bus.dwellRemainingMs = Math.max(bus.dwellRemainingMs, BUS_PLAYER_TRANSITION_GRACE_MS);
          return;
        }
        bus.playerExitInProgress = false;
      }
      bus.dwellRemainingMs = Math.max(0, bus.dwellRemainingMs - delta);
      if (bus.dwellRemainingMs > 0) return;
      bus.boardingActive = false;
      this.cancelOutstandingBoarders(bus);
      bus.state = 'DEPARTING_STOP';
      bus.targetStopIndex = this.nextStopIndex(bus.route, bus.currentStopIndex);
      if (!this.configureBusDriver(bus, false)) {
        this.beginBusRecovery(bus, 'Next stop has no valid directional lane target');
      }
      return;
    }

    if (bus.state === 'DEPARTING_STOP') {
      if (!driver.arrived) bus.state = 'FOLLOWING_ROUTE';
      return;
    }

    if (driver.arrived && this.busIsAtTargetStop(bus)) {
      this.arriveAtBusStop(bus);
      return;
    }

    const blocker = driver.debug.collisionPrediction;
    if (
      blocker?.kind === 'stopped-traffic' &&
      blocker.distance <= 42 &&
      driver.debug.recovery.blockedSeconds >= BUS_STATIONARY_BLOCKER_RECOVERY_MS / 1000
    ) {
      const blockerVehicle =
        blocker.entityId === null
          ? null
          : this.vehicles?.vehicles.find((candidate) => candidate.id === blocker.entityId) ?? null;
      const blockerDriver = blockerVehicle ? traffic.driverFor(blockerVehicle) : null;
      // A managed road vehicle already owns a bounded wait/reverse/replan/
      // despawn recovery sequence. Treating its normal signal queue as an
      // unreachable bus leg makes the service repeatedly discard its cached
      // segment even though the obstruction is about to resolve lawfully.
      // Bus recovery remains for genuinely unmanaged or invalid blockers.
      if (blockerDriver) return;
      if (traffic.requestServiceRecoveryLaneChange(bus.vehicle)) {
        this.log.debug(`${bus.route.config.id}: changing to a clear adjacent lane around stationary vehicle ${blocker.entityId ?? 'unknown'}`);
      } else {
        this.beginBusRecovery(bus, `Stationary traffic blocks current lane (${blocker.entityId ?? 'unknown'})`);
      }
      return;
    }

    // A successful replan changes the traffic driver out of Recovering. Keep
    // the service state in sync so it does not keep retrying and eventually
    // skip a reachable stop after motion has already resumed.
    if (
      bus.state === 'RECOVERING' &&
      bus.recoveryAttempts > 0 &&
      driver.state !== 'Recovering'
    ) {
      bus.state = 'FOLLOWING_ROUTE';
      bus.recoveryAttempts = 0;
      bus.nextRecoveryAt = 0;
      return;
    }

    if (driver.state === 'Recovering' || bus.state === 'RECOVERING') {
      this.recoverBus(bus, time, driver);
      return;
    }

    if (bus.state === 'FOLLOWING_ROUTE' && this.busShouldBeginApproach(bus)) {
      bus.state = 'APPROACHING_STOP';
      return;
    }
    if (bus.state === 'APPROACHING_STOP' && this.busShouldAlignWithStop(bus)) {
      bus.state = 'ALIGNING_WITH_STOP';
      return;
    }
    if (bus.state === 'ALIGNING_WITH_STOP' && !this.busHasTargetDirection(bus)) {
      this.beginBusRecovery(bus, 'Bus is no longer aligned with its directional stop lane');
    }
  }

  private arriveAtBusStop(bus: BusRuntime): void {
    const traffic = this.traffic;
    bus.currentStopIndex = bus.targetStopIndex;
    // Enter the explicit boarding phase on every arrival. Previously only a
    // newly spawned bus passed through BOARDING; later curb arrivals disabled
    // boarding and remained at the stop with no boardable passenger phase.
    bus.state = 'BOARDING';
    bus.boardingActive = false;
    bus.dwellRemainingMs = bus.route.config.stopDurationMs;
    bus.recoveryAttempts = 0;
    traffic?.setDriverStopped(bus.vehicle, true);
    this.disembarkBusPassengers(bus);
  }

  private beginBusRecovery(bus: BusRuntime, reason: string): void {
    if (bus.state !== 'RECOVERING') {
      bus.state = 'RECOVERING';
      bus.nextRecoveryAt = 0;
      bus.boardingActive = false;
      this.cancelOutstandingBoarders(bus);
      this.traffic?.resumeServiceDriver(bus.vehicle);
      this.traffic?.setDriverStopped(bus.vehicle, false);
      this.log.warn(`${bus.route.config.id}: recovering before ${this.targetBusStop(bus)?.id ?? 'unknown stop'} (${reason})`);
    }
  }

  /** Recover a genuinely blocked target, only skipping it after bounded legal replans fail. */
  private recoverBus(bus: BusRuntime, time: number, driver: { forceReplan(): void }): void {
    if (time < bus.nextRecoveryAt) return;
    bus.nextRecoveryAt = time + BUS_RECOVERY_DELAY_MS;
    bus.recoveryAttempts += 1;
    if (bus.recoveryAttempts <= MAX_RECOVERY_ATTEMPTS) {
      // Reinstall the cached segment (or an exact recovery segment from the
      // current lane) rather than leaving a persistent bus in the generic
      // driver's despawn/replan loop.
      if (!this.configureBusDriver(bus, false)) driver.forceReplan();
      return;
    }

    const skipped = this.targetBusStop(bus);
    this.log.warn(
      `${bus.route.config.id}: skipping stop ${skipped?.id ?? 'unknown'} after ${MAX_RECOVERY_ATTEMPTS} failed route recoveries`,
    );
    bus.targetStopIndex = this.nextStopIndex(bus.route, bus.targetStopIndex);
    bus.recoveryAttempts = 0;
    bus.state = 'FOLLOWING_ROUTE';
    if (!this.configureBusDriver(bus, false)) {
      bus.state = 'UNAVAILABLE';
      this.log.warn(`${bus.route.config.id}: next stop target is invalid; bus service is unavailable`);
    }
  }

  /** Configure one cached, named lane target. No nearest-lane inference is permitted for buses. */
  private configureBusDriver(bus: BusRuntime, stopped: boolean): boolean {
    const traffic = this.traffic;
    const stop = this.targetBusStop(bus);
    if (!traffic || !stop) return false;
    return traffic.configureDriverAtLaneStop(
      bus.vehicle,
      () => this.busTarget(bus.vehicle.id),
      this.busLaneStopTarget(stop),
      BUS_STOP_RANGE,
      stopped,
      stopped ? null : this.plannedBusSegment(bus),
    );
  }

  /**
   * Normal departures consume the exact segment cached during route
   * validation. Recovery and intentionally skipped stops fall back to the
   * shared driver's bounded replanning because they are no longer on the
   * authored source-to-target edge.
   */
  private plannedBusSegment(bus: BusRuntime): readonly string[] | null {
    if (bus.targetStopIndex !== this.nextStopIndex(bus.route, bus.currentStopIndex)) return null;
    const segment = bus.route.segments[bus.currentStopIndex] ?? null;
    const current = this.currentBusStop(bus);
    const target = this.targetBusStop(bus);
    if (
      !segment ||
      !segment.valid ||
      !current ||
      !target ||
      segment.fromStopId !== current.id ||
      segment.toStopId !== target.id ||
      segment.laneIds.length === 0
    ) {
      return null;
    }
    const currentLaneId = this.traffic?.driverFor(bus.vehicle)?.debug?.laneId ?? null;
    if (currentLaneId && !segment.laneIds.includes(currentLaneId)) {
      // This only runs after a genuine recovery request. It is an exact,
      // cached road-graph search, never a per-frame query, and gives the bus a
      // safe alternate approach if it has been displaced from its normal leg.
      const recoverySegment = this.traffic?.roadNetwork?.findCompleteRoute(currentLaneId, target.laneId) ?? null;
      if (recoverySegment && recoverySegment.length > 0) return recoverySegment.map((lane) => lane.id);
      return null;
    }
    return segment.laneIds;
  }

  private busLaneStopTarget(stop: BusStopSite): TrafficLaneStopTarget {
    return {
      laneId: stop.laneId,
      laneDistance: stop.laneDistance,
      position: { ...stop.stopPosition },
      heading: stop.heading,
    };
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
      if (taxi.idleUntil > time) return;
      if (taxi.idleUntil !== 0) {
        taxi.idleUntil = 0;
        traffic.setDriverStopped(taxi.vehicle, false);
      }
      if (driver.arrived) {
        if (taxi.standAtNextTarget) {
          taxi.standAtNextTarget = false;
          taxi.idleUntil = time + CITY_TRANSIT_CONFIG[taxi.cityId].taxi.standDurationMs;
          traffic.setDriverStopped(taxi.vehicle, true);
          return;
        }
        taxi.roamTarget = this.nextTaxiRoadTarget(taxi.cityId);
        traffic.configureDriver(taxi.vehicle, () => this.taxiTarget(taxi.vehicle.id), TAXI_STOP_RANGE, false);
      }
    } else if (taxi.state === 'APPROACHING_PICKUP') {
      if (!taxi.playerRequestPosition || !taxi.pickupPosition || time - taxi.stateSince > TAXI_PICKUP_TIMEOUT_MS) {
        if (taxi.snappBookingId) this.failSnappBooking('Driver could not reach the pickup point');
        else this.returnTaxiToService(taxi);
      } else if (this.taxiIsAtPickup(taxi)) {
        this.setTaxiState(taxi, 'WAITING_FOR_PASSENGER');
        taxi.recoveryAttempts = 0;
        traffic.setDriverStopped(taxi.vehicle, true);
        const booking = this.snappBookingValue;
        if (taxi.snappBookingId && booking?.id === taxi.snappBookingId) {
          booking.state = 'DRIVER_ARRIVED';
          booking.driverArrivedAtServiceMs = this.serviceClockMs;
          booking.pickupDeadlineServiceMs = this.serviceClockMs + SNAPP_CONFIG.passengerPickupWaitMs;
          this.bus.emit(EventKeys.SnappDriverArrived, {
            bookingId: booking.id,
            vehicleId: taxi.vehicle.id,
            pickupPosition: { ...booking.pickup },
            pickupAnchor: { ...booking.pickupAnchor ?? taxi.pickupPosition },
            walkingDistancePx: booking.pickupWalkingDistancePx,
            pickupAnchorLabel: booking.pickupAnchorLabel ?? 'Nearest legal curb',
          });
        }
      }
    } else if (taxi.state === 'WAITING_FOR_PASSENGER') {
      const booking = this.snappBookingValue;
      if (taxi.snappBookingId && booking?.id === taxi.snappBookingId) {
        const deadline = booking.pickupDeadlineServiceMs;
        if (deadline !== null && this.serviceClockMs >= deadline) {
          this.cancelSnappBooking(t('phoneSnappNoShow'));
        }
      } else if (time - taxi.stateSince >= TAXI_WAITING_FOR_PASSENGER_TIMEOUT_MS) {
        this.returnTaxiToService(taxi);
      }
    } else if (taxi.state === 'PASSENGER_BOARDING') {
      // Successful Snapp boarding is committed synchronously by the exact
      // PlayerEnteredVehicle passenger event. This branch only guards a lost
      // or interrupted transition and never infers ride start by polling.
      if (time - taxi.stateSince > TAXI_BOARD_TIMEOUT_MS) {
        this.occupants?.releasePlayerPassengerSeat(taxi.vehicle);
        if (taxi.snappBookingId) {
          const booking = this.snappBookingValue;
          if (booking?.id === taxi.snappBookingId && booking.state === 'PASSENGER_BOARDING') {
            booking.state = 'DRIVER_ARRIVED';
            booking.error = 'Boarding was interrupted. Try the rear passenger door again.';
            this.setTaxiState(taxi, 'WAITING_FOR_PASSENGER');
            traffic.setDriverStopped(taxi.vehicle, true);
          }
        } else {
          this.returnTaxiToService(taxi);
        }
      }
    } else if (taxi.state === 'IN_SERVICE') {
      if (this.taxiIsAtDropoff(taxi)) {
        this.setTaxiState(taxi, 'ARRIVING');
        taxi.recoveryAttempts = 0;
        traffic.setDriverStopped(taxi.vehicle, true);
        const booking = this.snappBookingValue;
        if (taxi.snappBookingId && booking?.id === taxi.snappBookingId) {
          booking.state = 'ARRIVED';
          this.bus.emit(EventKeys.SnappRideArrived, { bookingId: booking.id, vehicleId: taxi.vehicle.id });
        }
      }
    } else if (taxi.state === 'ARRIVING') {
      if (this.player?.currentVehicle?.id !== taxi.vehicle.id) {
        if (taxi.snappBookingId) this.completeSnappRide(taxi);
        else this.returnTaxiToService(taxi);
      }
    } else if (taxi.state === 'PASSENGER_EXITING') {
      if (this.player?.currentVehicle?.id !== taxi.vehicle.id) {
        if (taxi.snappBookingId) this.completeSnappRide(taxi);
        else this.returnTaxiToService(taxi);
      }
    } else if (taxi.state === 'RETURNING_TO_SERVICE') {
      this.setTaxiState(taxi, 'AVAILABLE');
    }

    if (
      (taxi.state === 'AVAILABLE' || taxi.state === 'APPROACHING_PICKUP' || taxi.state === 'IN_SERVICE') &&
      driver.state === 'Recovering' &&
      time >= taxi.nextRecoveryAt
    ) {
      taxi.nextRecoveryAt = time + TAXI_RECOVERY_DELAY_MS;
      taxi.recoveryAttempts += 1;
      if (taxi.recoveryAttempts <= MAX_RECOVERY_ATTEMPTS) driver.forceReplan();
      else {
        taxi.recoveryAttempts = 0;
        if (taxi.snappBookingId) {
          this.failSnappBooking('Driver route became unavailable');
          return;
        }
        if (taxi.state === 'IN_SERVICE' && taxi.dropoffPosition) {
          traffic.configureDriver(taxi.vehicle, () => this.taxiTarget(taxi.vehicle.id), TAXI_STOP_RANGE, false);
        } else if (taxi.state === 'APPROACHING_PICKUP' && taxi.pickupPosition) {
          traffic.configureDriver(taxi.vehicle, () => this.taxiTarget(taxi.vehicle.id), TAXI_STOP_RANGE, false);
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
    if (!bus.boardingActive || !stop || !occupants) return;
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
        (candidate) =>
          candidate.route.config.id === plan.routeId &&
          candidate.state === 'STOPPED_AT_STOP' &&
          candidate.boardingActive &&
          this.busIsAtCurrentStop(candidate),
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
    const activeSnapp = this.snappBookingValue;
    if (activeSnapp?.state === 'DRIVER_ARRIVED' && activeSnapp.assignedVehicleId !== null) {
      const assigned = this.taxis.get(activeSnapp.assignedVehicleId) ?? null;
      const approach = assigned ? this.resolveActualSnappBoardingApproach(assigned) : null;
      if (
        assigned &&
        approach?.ok === true &&
        this.distanceSq(position, approach.position) <=
          SNAPP_CONFIG.snappBoardingReachPx * SNAPP_CONFIG.snappBoardingReachPx
      ) {
        this.requestSnappBoarding(assigned.vehicle.id);
        return;
      }
    }
    const interaction = this.interactionAt(position);
    if (!interaction) return;
    if (interaction.kind === 'exit-transit') {
      this.exitPlayerTransit();
      return;
    }
    if (interaction.kind === 'enter-taxi') {
      const booking = this.snappBookingValue;
      if (booking?.state === 'DRIVER_ARRIVED' && booking.assignedVehicleId !== null) {
        const assigned = this.taxis.get(booking.assignedVehicleId) ?? null;
        if (assigned && this.taxiCanBoard(assigned)) {
          this.requestSnappBoarding(assigned.vehicle.id);
        }
        return;
      }
      const taxi = this.nearestTaxi(
        position,
        TAXI_INTERACTION_RANGE,
        ['WAITING_FOR_PASSENGER'],
        (candidate) => this.taxiCanBoard(candidate),
      );
      if (taxi) this.requestTaxiBoarding(taxi.vehicle.id);
      return;
    }
    if (interaction.kind === 'board-bus') {
      const bus = this.nearestBoardableBus(position);
      if (bus) this.requestBusBoarding(bus.vehicle.id);
      return;
    }
    if (interaction.kind === 'call-taxi') {
      const taxi = this.nearestTaxi(
        position,
        TAXI_INTERACTION_RANGE,
        ['AVAILABLE'],
        (candidate) => this.isTaxiHireable(candidate),
      );
      if (taxi) this.requestTaxi(taxi, position);
    }
  }

  private beginBusBoarding(bus: BusRuntime): boolean {
    const occupants = this.occupants;
    const player = this.player;
    if (!occupants || !player || !this.busCanBoard(bus)) return false;
    const seat = occupants.reservePlayerPassengerSeat(bus.vehicle);
    if (!seat) {
      this.bus.emit(EventKeys.UIToast, { message: 'Bus is full' });
      return false;
    }
    if (!player.beginPassengerBoarding(bus.vehicle, seat).ok) {
      occupants.releasePlayerPassengerSeat(bus.vehicle);
      return false;
    }
    bus.playerBoardingInProgress = true;
    bus.playerTransitionDeadline = this.now() + BUS_PLAYER_TRANSITION_GRACE_MS;
    bus.dwellRemainingMs = Math.max(bus.dwellRemainingMs, BUS_PLAYER_TRANSITION_GRACE_MS);
    return true;
  }

  private beginTaxiBoarding(
    taxi: TaxiRuntime,
    boardingApproach?: Vector2,
  ): PassengerBoardingResult {
    const occupants = this.occupants;
    const player = this.player;
    const traffic = this.traffic;
    if (
      !occupants ||
      !player ||
      !traffic ||
      !this.taxiCanBoard(taxi)
    ) {
      return { ok: false, reason: 'driver-not-arrived' };
    }
    if (!occupants.availablePassengerSeats(taxi.vehicle).includes('rear-right')) {
      return { ok: false, reason: 'seat-unavailable' };
    }
    const seat = occupants.reservePlayerPassengerSeat(taxi.vehicle);
    if (seat !== 'rear-right') {
      if (seat) occupants.releasePlayerPassengerSeat(taxi.vehicle);
      return { ok: false, reason: 'seat-unavailable' };
    }
    traffic.setDriverStopped(taxi.vehicle, true);
    const transition = player.beginPassengerBoarding(taxi.vehicle, seat, boardingApproach);
    if (!transition.ok) {
      occupants.releasePlayerPassengerSeat(taxi.vehicle);
      // Validation and seat reservation are transactional: an unaccepted
      // PlayerController transition leaves both service state machines and the
      // existing pickup deadline untouched.
      traffic.setDriverStopped(taxi.vehicle, true);
      return transition;
    }
    this.setTaxiState(taxi, 'PASSENGER_BOARDING');
    if (taxi.snappBookingId) {
      const booking = this.snappBookingValue;
      if (booking?.id === taxi.snappBookingId) {
        booking.state = 'PASSENGER_BOARDING';
        this.bus.emit(EventKeys.SnappBoardingStarted, { bookingId: booking.id, vehicleId: taxi.vehicle.id });
      }
    }
    return { ok: true };
  }

  /** Start the paid ride only after the existing PlayerController confirms the exact passenger entry. */
  private handlePlayerEnteredVehicle(entry: {
    vehicleId: number;
    seat: VehicleSeat;
    mode: 'driver' | 'passenger';
  }): void {
    if (entry.mode !== 'passenger' || entry.seat !== 'rear-right') return;
    const enteredTaxi = this.taxis.get(entry.vehicleId) ?? null;
    if (
      enteredTaxi &&
      enteredTaxi.state === 'PASSENGER_BOARDING' &&
      enteredTaxi.snappBookingId === null
    ) {
      this.setTaxiState(enteredTaxi, 'DESTINATION_SELECTION');
      ServiceLocator.tryResolve<GameManager>(ServiceKeys.Game)?.openMap();
      return;
    }
    const booking = this.snappBookingValue;
    if (
      !booking ||
      booking.state !== 'PASSENGER_BOARDING' ||
      booking.assignedVehicleId !== entry.vehicleId
    ) {
      return;
    }
    const taxi = enteredTaxi;
    if (
      !taxi ||
      taxi.snappBookingId !== booking.id ||
      taxi.state !== 'PASSENGER_BOARDING' ||
      this.player?.currentVehicle?.id !== entry.vehicleId ||
      this.player.currentPassengerSeat !== 'rear-right'
    ) {
      this.log.debug(
        `Snapp ride start ignored booking=${booking.id} vehicle=${entry.vehicleId} reason=entry-confirmation-mismatch`,
      );
      return;
    }
    const traffic = this.traffic;
    if (!traffic) return;
    const configured = taxi.dropoffLaneStop
      ? traffic.configureDriverAtLaneStop(
          taxi.vehicle,
          () => this.taxiTarget(taxi.vehicle.id),
          taxi.dropoffLaneStop,
          TAXI_STOP_RANGE,
          false,
        )
      : (traffic.configureDriver(
          taxi.vehicle,
          () => this.taxiTarget(taxi.vehicle.id),
          TAXI_STOP_RANGE,
          false,
        ), true);
    if (!configured) {
      this.failSnappBooking('Snapp destination route became unavailable');
      return;
    }
    this.setTaxiState(taxi, 'IN_SERVICE');
    booking.state = 'RIDING';
    booking.error = null;
    this.bus.emit(EventKeys.SnappRideStarted, {
      bookingId: booking.id,
      vehicleId: taxi.vehicle.id,
    });
  }

  private resolveActualSnappBoardingApproach(taxi: TaxiRuntime): SnappBoardingApproach {
    const occupants = this.occupants;
    const world = this.world;
    if (!occupants || !world) return { ok: false, reason: 'boarding-approach-unavailable' };
    const door = occupants.doorWorldPosition(
      taxi.vehicle,
      'rear-right',
      SNAPP_CONFIG.boardingDoorOutsidePx,
    );
    const directClear = world.isPedestrianClearAtWorld(door.x, door.y, PLAYER.RADIUS);
    const position = directClear
      ? door
      : world.resolveSafePedestrianPosition(door, PLAYER.RADIUS, {
          maxDistance: SNAPP_CONFIG.boardingApproachSearchRadiusPx,
        });
    if (!position) return { ok: false, reason: 'door-position-blocked' };
    if (
      Math.hypot(position.x - door.x, position.y - door.y) >
      SNAPP_CONFIG.boardingApproachSearchRadiusPx
    ) {
      return { ok: false, reason: 'boarding-approach-unavailable' };
    }
    const outwardX = Math.cos(taxi.vehicle.sprite.rotation);
    const outwardY = Math.sin(taxi.vehicle.sprite.rotation);
    const outwardDistance =
      (position.x - taxi.vehicle.sprite.x) * outwardX +
      (position.y - taxi.vehicle.sprite.y) * outwardY;
    if (outwardDistance < taxi.vehicle.def.width * 0.5 + PLAYER.RADIUS - 1) {
      return { ok: false, reason: 'boarding-approach-unavailable' };
    }
    return {
      ok: true,
      door: { ...door },
      position: { x: position.x, y: position.y },
    };
  }

  private snappBoardingFailureMessage(
    reason: PassengerBoardingFailureReason,
    distanceRemainingPx?: number,
  ): string {
    switch (reason) {
      case 'player-unavailable':
        return t('phoneSnappPlayerUnavailable');
      case 'player-already-in-vehicle':
        return t('phoneSnappExitVehicleFirst');
      case 'transition-in-progress':
        return t('phoneSnappTransitionInProgress');
      case 'vehicle-destroyed':
        return t('phoneSnappVehicleUnavailable');
      case 'vehicle-moving':
        return t('phoneSnappVehicleMoving');
      case 'wrong-booking':
      case 'wrong-vehicle':
        return t('phoneSnappWrongRide');
      case 'driver-not-arrived':
        return t('phoneSnappDriverNotReady');
      case 'too-far-from-door': {
        const metres = Math.max(
          1,
          Math.ceil((distanceRemainingPx ?? 0) / (TRANSIT_PIXELS_PER_KILOMETER / 1000)),
        );
        return t('phoneSnappMoveCloserDoor').replace('{distance}', String(metres));
      }
      case 'seat-unavailable':
        return t('phoneSnappSeatUnavailable');
      case 'door-position-blocked':
        return t('phoneSnappBoardingBlocked');
      case 'path-to-door-blocked':
        return t('phoneSnappPathToDoorBlocked');
      case 'boarding-approach-unavailable':
        return t('phoneSnappApproachUnavailable');
    }
  }

  private requestTaxi(taxi: TaxiRuntime, position: Vector2): void {
    const traffic = this.traffic;
    if (!traffic || !this.isTaxiHireable(taxi)) return;
    const pickup = this.resolveTaxiRoadTarget(taxi, position, true);
    if (!pickup) {
      this.bus.emit(EventKeys.UIToast, { message: 'No safe taxi pickup is available here', durationMs: 1800 });
      return;
    }
    taxi.playerRequestPosition = { x: position.x, y: position.y };
    taxi.pickupPosition = { ...pickup.position };
    taxi.pickupLaneStop = null;
    taxi.dropoffPosition = null;
    taxi.dropoffLaneStop = null;
    taxi.destination = null;
    taxi.fare = null;
    taxi.farePaid = false;
    taxi.validLaneRoute = true;
    taxi.recoveryAttempts = 0;
    taxi.idleUntil = 0;
    taxi.standAtNextTarget = false;
    this.setTaxiState(taxi, 'APPROACHING_PICKUP');
    traffic.configureDriver(taxi.vehicle, () => this.taxiTarget(taxi.vehicle.id), TAXI_STOP_RANGE, false);
  }

  private returnTaxiToService(taxi: TaxiRuntime): void {
    const traffic = this.traffic;
    this.setTaxiState(taxi, 'RETURNING_TO_SERVICE');
    taxi.vehicle.sprite.clearTint();
    taxi.vehicle.sprite.data?.remove('snappBookingId');
    taxi.vehicle.sprite.data?.remove('serviceLivery');
    taxi.snappBookingId = null;
    taxi.playerRequestPosition = null;
    taxi.pickupPosition = null;
    taxi.pickupLaneStop = null;
    taxi.dropoffPosition = null;
    taxi.dropoffLaneStop = null;
    taxi.destination = null;
    taxi.fare = null;
    taxi.farePaid = false;
    taxi.recoveryAttempts = 0;
    taxi.idleUntil = 0;
    taxi.standAtNextTarget = false;
    taxi.roamTarget = this.nextTaxiRoadTarget(taxi.cityId);
    taxi.validLaneRoute = true;
    if (traffic) {
      traffic.configureDriver(taxi.vehicle, () => this.taxiTarget(taxi.vehicle.id), TAXI_STOP_RANGE, false);
    }
  }

  private busTarget(vehicleId: number): Vector2 | null {
    const bus = this.buses.get(vehicleId);
    const target = bus ? this.targetBusStop(bus) : null;
    return target ? target.stopPosition : null;
  }

  private taxiTarget(vehicleId: number): Vector2 | null {
    const taxi = this.taxis.get(vehicleId);
    if (!taxi) return null;
    if (
      taxi.state === 'APPROACHING_PICKUP' ||
      taxi.state === 'WAITING_FOR_PASSENGER' ||
      taxi.state === 'PASSENGER_BOARDING' ||
      taxi.state === 'DESTINATION_SELECTION' ||
      taxi.state === 'FARE_CONFIRMATION'
    ) {
      return taxi.pickupPosition;
    }
    if (
      taxi.state === 'IN_SERVICE' ||
      taxi.state === 'ARRIVING' ||
      taxi.state === 'PASSENGER_EXITING'
    ) {
      return taxi.dropoffPosition;
    }
    return taxi.roamTarget;
  }

  private setTaxiState(taxi: TaxiRuntime, state: TaxiState): void {
    if (taxi.state !== state && taxi.snappBookingId) {
      this.log.debug(`Snapp ${taxi.snappBookingId}: ${taxi.state} -> ${state} at ${this.serviceClockMs}ms`);
    }
    taxi.state = state;
    taxi.stateSince = this.serviceClockMs;
  }

  private isTaxiDestinationSelectionState(state: TaxiState): boolean {
    return state === 'DESTINATION_SELECTION' || state === 'FARE_CONFIRMATION';
  }

  /** A parked service vehicle must be both near its curb target and genuinely stopped. */
  private isVehicleStoppedAt(
    vehicle: Vehicle,
    target: Vector2 | null,
    range: number,
    requireDriverArrival = false,
  ): boolean {
    if (!target || vehicle.isDestroyed || !vehicle.sprite.active) return false;
    if (this.distanceSq({ x: vehicle.sprite.x, y: vehicle.sprite.y }, target) > range * range) {
      return false;
    }
    if (Math.abs(vehicle.movement.speed) > SERVICE_STOP_SPEED) return false;
    return !requireDriverArrival || this.traffic?.driverFor(vehicle)?.arrived === true;
  }

  private busIsAtCurrentStop(bus: BusRuntime): boolean {
    const stop = this.currentBusStop(bus);
    return this.busIsStoppedAt(bus, stop, false);
  }

  private busIsAtTargetStop(bus: BusRuntime): boolean {
    return this.busIsStoppedAt(bus, this.targetBusStop(bus), true);
  }

  private busCanBoard(bus: BusRuntime): boolean {
    return Boolean(
      bus.state === 'STOPPED_AT_STOP' &&
        bus.boardingActive &&
        bus.dwellRemainingMs > 0 &&
        this.busIsAtCurrentStop(bus) &&
        this.hasServiceDriver(bus.vehicle, 'bus-driver') &&
        this.occupants?.availablePassengerSeats(bus.vehicle).length,
    );
  }

  private taxiHasDriverAndPassengerSeat(taxi: TaxiRuntime): boolean {
    return Boolean(
      taxi.vehicle.def.kind === 'taxi' &&
        !taxi.vehicle.isDestroyed &&
        taxi.vehicle.sprite.active &&
        this.hasServiceDriver(taxi.vehicle, 'taxi-driver') &&
        this.occupants?.availablePassengerSeats(taxi.vehicle).includes('rear-right'),
    );
  }

  private isTaxiHireable(taxi: TaxiRuntime): boolean {
    return taxi.state === 'AVAILABLE' && this.taxiHasDriverAndPassengerSeat(taxi);
  }

  private taxiIsAtPickup(taxi: TaxiRuntime): boolean {
    if (taxi.snappBookingId) return this.snappTaxiIsAtPickup(taxi);
    if (!this.isVehicleStoppedAt(
      taxi.vehicle,
      taxi.pickupPosition,
      TAXI_PICKUP_ARRIVAL_RANGE,
      true,
    )) return false;
    return this.taxiIsAtExactLaneStop(taxi, taxi.pickupLaneStop);
  }

  private snappTaxiIsAtPickup(taxi: TaxiRuntime): boolean {
    const booking = this.snappBookingValue;
    const stop = booking?.pickupStop ?? null;
    if (
      !booking ||
      !stop ||
      booking.id !== taxi.snappBookingId ||
      booking.assignedVehicleId !== taxi.vehicle.id ||
      taxi.pickupLaneStop?.laneId !== stop.laneId
    ) {
      return false;
    }
    const driver = this.traffic?.driverFor(taxi.vehicle) ?? null;
    if (!driver?.arrived) return false;
    const debug = driver.debug;
    const actualLane = this.traffic?.roadNetwork?.lane(debug.laneId);
    const taxiPosition = { x: taxi.vehicle.sprite.x, y: taxi.vehicle.sprite.y };
    const worldError = Math.hypot(
      taxiPosition.x - stop.position.x,
      taxiPosition.y - stop.position.y,
    );
    const laneDistanceError = Math.abs(debug.laneDistance - stop.laneDistance);
    const headingError = Math.abs(
      Phaser.Math.Angle.Wrap(taxi.vehicle.movement.heading - stop.heading),
    );
    const speed = Math.abs(taxi.vehicle.movement.speed);
    const boardingApproach = this.resolveActualSnappBoardingApproach(taxi);
    const accepted =
      actualLane?.roadSegmentId === stop.roadSegmentId &&
      debug.laneId === stop.laneId &&
      laneDistanceError <= SNAPP_CONFIG.pickupArrivalLaneTolerancePx &&
      worldError <= SNAPP_CONFIG.pickupArrivalWorldTolerancePx &&
      headingError <= SNAPP_CONFIG.pickupArrivalHeadingToleranceRadians &&
      speed <= SNAPP_CONFIG.pickupStoppedSpeedPxPerSecond &&
      boardingApproach.ok;
    this.log.debug(
      `Snapp pickup arrival booking=${booking.id} vehicle=${taxi.vehicle.id} ` +
        `requestToAnchor=${stop.displacementPx.toFixed(1)}px taxiToAnchor=${worldError.toFixed(1)}px ` +
        `expectedLane=${stop.laneId} actualLane=${debug.laneId ?? 'none'} ` +
        `expectedLaneDistance=${stop.laneDistance.toFixed(1)} actualLaneDistance=${debug.laneDistance.toFixed(1)} ` +
        `headingError=${headingError.toFixed(3)} speed=${speed.toFixed(2)} ` +
        `boardingApproach=${boardingApproach.ok ? 'usable' : boardingApproach.reason} accepted=${accepted}`,
    );
    return accepted;
  }

  private taxiCanBoard(taxi: TaxiRuntime): boolean {
    return (
      taxi.state === 'WAITING_FOR_PASSENGER' &&
      this.taxiHasDriverAndPassengerSeat(taxi) &&
      // Exact lane/heading arrival is authoritative when APPROACHING_PICKUP
      // transitions into WAITING_FOR_PASSENGER. Do not re-read the traffic
      // driver's transient `arrived` flag afterwards: a route refresh can clear
      // it even though the booked vehicle is still stopped at the validated curb.
      this.isVehicleStoppedAt(taxi.vehicle, taxi.pickupPosition, TAXI_PICKUP_ARRIVAL_RANGE, false)
    );
  }

  private taxiIsAtDropoff(taxi: TaxiRuntime): boolean {
    if (!this.isVehicleStoppedAt(
      taxi.vehicle,
      taxi.dropoffPosition,
      TAXI_DROPOFF_ARRIVAL_RANGE,
      true,
    )) return false;
    return this.taxiIsAtExactLaneStop(taxi, taxi.dropoffLaneStop);
  }

  /** Final service-side guard against a generic driver's approximate radius. */
  private taxiIsAtExactLaneStop(
    taxi: TaxiRuntime,
    target: TrafficLaneStopTarget | null,
  ): boolean {
    if (!target) return true;
    const debug = this.traffic?.driverFor(taxi.vehicle)?.debug;
    if (!debug || debug.laneId !== target.laneId) return false;
    if (Math.abs((debug.laneDistance ?? target.laneDistance) - target.laneDistance) > TAXI_LANE_STOP_TOLERANCE) return false;
    return Math.abs(Phaser.Math.Angle.Wrap(taxi.vehicle.movement.heading - target.heading)) <= TAXI_LANE_HEADING_TOLERANCE;
  }

  /**
   * Resolve the passenger's curb before considering which taxi will serve it.
   * The nearest physical road segment is a hard boundary; a driver route may
   * only break a tie between otherwise equivalent stops on that same road.
   */
  private resolveSnappPickupAnchor(
    requested: Vector2,
    cityId: CityId,
  ): SnappPickupAnchor | null {
    const traffic = this.traffic;
    const network = traffic?.roadNetwork;
    const world = this.world;
    if (!traffic || !network || !world) return null;
    const nearestLane = network.nearestLane(requested, undefined, true);
    const nearestRoadSegmentId = nearestLane?.roadSegmentId ?? null;
    const road = network.road(nearestRoadSegmentId);
    if (!nearestLane || !nearestRoadSegmentId || !road) {
      this.log.debug(`Snapp pickup rejected at ${requested.x.toFixed(1)},${requested.y.toFixed(1)}: no nearest road segment`);
      return null;
    }
    const nearestProjection = network.projectPoint(requested, nearestLane);
    if (
      Math.sqrt(nearestProjection.distanceSq) >
      SNAPP_CONFIG.pickupLaneSearchRadiusPx
    ) {
      this.log.debug(
        `Snapp pickup rejected road=${nearestRoadSegmentId}: nearest lane exceeds ` +
          `${SNAPP_CONFIG.pickupLaneSearchRadiusPx}px search radius`,
      );
      return null;
    }

    const lanes = road.laneIds
      .map((laneId) => network.lane(laneId))
      .filter((lane): lane is TrafficLane => lane?.kind === 'travel');
    const taxis = Array.from(this.taxis.values()).filter(
      (taxi) =>
        taxi.cityId === cityId &&
        !taxi.vehicle.isDestroyed &&
        taxi.vehicle.sprite.active &&
        this.hasServiceDriver(taxi.vehicle, 'taxi-driver'),
    );
    const candidates: SnappPickupRuntimeCandidate[] = [];
    const offsets = this.snappPickupDistanceOffsets();
    for (const lane of lanes) {
      if (lane.roadSegmentId !== nearestRoadSegmentId) {
        this.logSnappPickupRejection(lane, null, 'different-road-segment');
        continue;
      }
      if (lane.role !== 'outer') {
        this.logSnappPickupRejection(lane, null, 'not-curb-facing-outer-lane');
        continue;
      }
      const minimumLaneDistance = SNAPP_CONFIG.pickupIntersectionClearancePx;
      if (lane.spline.length <= minimumLaneDistance * 2) {
        this.logSnappPickupRejection(lane, null, 'insufficient-intersection-clearance');
        continue;
      }
      const projection = network.projectPoint(requested, lane);
      const baseDistance = Phaser.Math.Clamp(
        projection.distance,
        minimumLaneDistance,
        lane.spline.length - minimumLaneDistance,
      );
      const seen = new Set<number>();
      for (const offset of offsets) {
        const laneDistance = Phaser.Math.Clamp(
          baseDistance + offset,
          minimumLaneDistance,
          lane.spline.length - minimumLaneDistance,
        );
        const key = Math.round(laneDistance * 10);
        if (seen.has(key)) continue;
        seen.add(key);
        const pose = network.pointAt(lane, laneDistance);
        const position = { ...pose.point };
        const displacementPx = Math.hypot(position.x - requested.x, position.y - requested.y);
        if (world.cityAt(position.x, position.y)?.id !== cityId) {
          this.logSnappPickupRejection(lane, laneDistance, 'outside-city');
          continue;
        }
        if (displacementPx > SNAPP_CONFIG.maximumPickupDisplacementPx) {
          this.logSnappPickupRejection(
            lane,
            laneDistance,
            `excessive-displacement:${displacementPx.toFixed(1)}px`,
          );
          continue;
        }

        const idealDoor = this.snappDoorPositionAtPose(position, pose.heading, 1);
        const oppositeDoor = this.snappDoorPositionAtPose(position, pose.heading, -1);
        const curbFacing =
          Math.hypot(idealDoor.x - requested.x, idealDoor.y - requested.y) <=
          Math.hypot(oppositeDoor.x - requested.x, oppositeDoor.y - requested.y) +
            SNAPP_CONFIG.pickupCandidateDistanceEpsilonPx;
        if (!curbFacing) {
          this.logSnappPickupRejection(lane, laneDistance, 'rear-right-door-faces-away-from-player');
          continue;
        }
        if (!this.isSnappCurbClear(position)) {
          this.logSnappPickupRejection(lane, laneDistance, 'vehicle-clearance-blocked');
          continue;
        }
        const boardingApproach = this.resolveSnappApproachAtPose(
          position,
          pose.heading,
          requested,
        );
        if (!boardingApproach) {
          this.logSnappPickupRejection(lane, laneDistance, 'boarding-approach-or-path-blocked');
          continue;
        }

        const laneStop: TrafficLaneStopTarget = {
          laneId: lane.id,
          laneDistance,
          position,
          heading: pose.heading,
        };
        const routes = taxis
          .map((taxi) =>
            traffic.routePreviewToLaneStop(
              { x: taxi.vehicle.sprite.x, y: taxi.vehicle.sprite.y },
              laneStop,
            ),
          )
          .filter((route): route is TrafficRoutePreview => route !== null && route.laneIds.length > 0);
        if (routes.length === 0) {
          this.logSnappPickupRejection(lane, laneDistance, 'route-unreachable');
          continue;
        }
        const routeDistancePx = Math.min(...routes.map((route) => route.distancePx));
        candidates.push({
          laneId: lane.id,
          roadSegmentId: lane.roadSegmentId,
          laneRole: lane.role,
          curbFacing,
          displacementPx,
          approachUsable: true,
          routeReachable: true,
          routeDistancePx,
          anchor: {
            roadSegmentId: nearestRoadSegmentId,
            laneId: lane.id,
            laneDistance,
            position,
            heading: pose.heading,
            displacementPx,
            curbSide: 'rear-right',
            boardingApproach,
          },
        });
      }
    }

    const selected = selectSnappPickupCandidate(
      candidates,
      nearestRoadSegmentId,
      SNAPP_CONFIG.maximumPickupDisplacementPx,
      SNAPP_CONFIG.pickupCandidateDistanceEpsilonPx,
    );
    if (!selected) {
      this.snappSelectionErrorValue =
        'No safe Snapp pickup is available on your current street. Move closer to the curb and try again.';
      return null;
    }
    this.log.debug(
      `Snapp pickup accepted road=${selected.anchor.roadSegmentId} lane=${selected.anchor.laneId} ` +
        `laneDistance=${selected.anchor.laneDistance.toFixed(1)} displacement=${selected.anchor.displacementPx.toFixed(1)}px`,
    );
    return this.cloneSnappPickupAnchor(selected.anchor);
  }

  private snappPickupDistanceOffsets(): readonly number[] {
    const offsets = [0];
    const step = 16;
    for (
      let distance = step;
      distance <= SNAPP_CONFIG.preferredPickupDisplacementPx;
      distance += step
    ) {
      offsets.push(-distance, distance);
    }
    for (
      let distance = SNAPP_CONFIG.preferredPickupDisplacementPx + step;
      distance <= SNAPP_CONFIG.maximumPickupDisplacementPx;
      distance += step
    ) {
      offsets.push(-distance, distance);
    }
    return offsets;
  }

  /** Predict VehicleOccupantSystem's rear-door transform at a lane pose. */
  private snappDoorPositionAtPose(position: Vector2, heading: number, side: 1 | -1): Vector2 {
    const definition = VEHICLES.taxi;
    const rotation = heading + Math.PI / 2;
    const localX = side * (definition.width * 0.5 + 5 + SNAPP_CONFIG.boardingDoorOutsidePx);
    const localY = definition.height * 0.16;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    return {
      x: position.x + localX * cos - localY * sin,
      y: position.y + localX * sin + localY * cos,
    };
  }

  private resolveSnappApproachAtPose(
    vehiclePosition: Vector2,
    heading: number,
    requestPosition: Vector2,
  ): Vector2 | null {
    const world = this.world;
    if (!world) return null;
    const door = this.snappDoorPositionAtPose(vehiclePosition, heading, 1);
    const directClear = world.isPedestrianClearAtWorld(door.x, door.y, PLAYER.RADIUS);
    const resolved = directClear
      ? door
      : world.resolveSafePedestrianPosition(door, PLAYER.RADIUS, {
          maxDistance: SNAPP_CONFIG.boardingApproachSearchRadiusPx,
        });
    if (!resolved) return null;
    if (
      Math.hypot(resolved.x - door.x, resolved.y - door.y) >
      SNAPP_CONFIG.boardingApproachSearchRadiusPx
    ) {
      return null;
    }
    const outwardRotation = heading + Math.PI / 2;
    const outwardDistance =
      (resolved.x - vehiclePosition.x) * Math.cos(outwardRotation) +
      (resolved.y - vehiclePosition.y) * Math.sin(outwardRotation);
    if (outwardDistance < VEHICLES.taxi.width * 0.5 + PLAYER.RADIUS - 1) return null;
    if (!world.isPedestrianSegmentClear(requestPosition, resolved, PLAYER.RADIUS)) return null;
    return { x: resolved.x, y: resolved.y };
  }

  private logSnappPickupRejection(
    lane: TrafficLane,
    laneDistance: number | null,
    reason: string,
  ): void {
    this.log.debug(
      `Snapp pickup candidate rejected lane=${lane.id} road=${lane.roadSegmentId ?? 'none'} ` +
        `laneDistance=${laneDistance === null ? 'n/a' : laneDistance.toFixed(1)} reason=${reason}`,
    );
  }

  /**
   * Pick a reachable travel-lane point near a pedestrian/world destination.
   * This runs only when a taxi is hailed or a map pin is selected, and uses
   * the road network's spatial lane index instead of a per-frame world scan.
   */
  private resolveTaxiRoadTarget(
    taxi: TaxiRuntime,
    requested: Vector2,
    requireClearCurb: boolean,
  ): TaxiRoadTarget | null {
    const traffic = this.traffic;
    const world = this.world;
    const network = traffic?.roadNetwork;
    if (!traffic || !world || !network) return null;
    let selected: TaxiRoadTarget | null = null;
    let selectedScore = Infinity;
    for (const lane of network.nearbyTravelLanes(requested, TAXI_PICKUP_SEARCH_RADIUS)) {
      const projection = network.projectPoint(requested, lane);
      const clearance = Math.min(
        TAXI_PICKUP_JUNCTION_CLEARANCE,
        Math.max(52, Math.floor(lane.spline.length * 0.22)),
      );
      if (lane.spline.length <= clearance * 2 + TAXI_STOP_RANGE * 2) continue;
      const distance = Phaser.Math.Clamp(
        projection.distance,
        clearance,
        lane.spline.length - clearance,
      );
      const pose = network.pointAt(lane, distance);
      const position = pose.point;
      if (world.cityAt(position.x, position.y)?.id !== taxi.cityId) continue;
      if (requireClearCurb && !this.isTaxiCurbClear(taxi.vehicle, position)) continue;
      const route = traffic.routePreview(
        { x: taxi.vehicle.sprite.x, y: taxi.vehicle.sprite.y },
        position,
      );
      if (!route || route.laneIds.length === 0) continue;
      const score = Math.hypot(position.x - requested.x, position.y - requested.y) +
        Math.min(route.distancePx * 0.025, 120);
      if (score < selectedScore) {
        selected = {
          position: { x: position.x, y: position.y },
          route,
          laneStop: {
            laneId: lane.id,
            laneDistance: distance,
            position: { x: position.x, y: position.y },
            heading: pose.heading,
          },
        };
        selectedScore = score;
      }
    }
    return selected;
  }

  /**
   * Rebind a persisted/selected point to the exact directed lane arc that
   * authored it. Snapp uses this instead of silently picking a nearby lane,
   * keeping its arrival state tied to the stored operational anchor.
   */
  private resolveExactTaxiRoadTarget(
    taxi: TaxiRuntime,
    requested: Vector2,
    requireClearCurb: boolean,
  ): TaxiRoadTarget | null {
    const traffic = this.traffic;
    const world = this.world;
    const network = traffic?.roadNetwork;
    if (!traffic || !world || !network) return null;
    let selected: TaxiRoadTarget | null = null;
    let selectedDistance = Infinity;
    for (const lane of network.nearbyTravelLanes(requested, TAXI_PICKUP_SEARCH_RADIUS)) {
      const projection = network.projectPoint(requested, lane);
      const clearance = Math.min(
        TAXI_PICKUP_JUNCTION_CLEARANCE,
        Math.max(52, Math.floor(lane.spline.length * 0.22)),
      );
      if (lane.spline.length <= clearance * 2 + TAXI_STOP_RANGE * 2) continue;
      const distance = Phaser.Math.Clamp(
        projection.distance,
        clearance,
        lane.spline.length - clearance,
      );
      const pose = network.pointAt(lane, distance);
      const position = pose.point;
      const error = Math.hypot(position.x - requested.x, position.y - requested.y);
      if (error > TAXI_EXACT_TARGET_TOLERANCE) continue;
      if (world.cityAt(position.x, position.y)?.id !== taxi.cityId) continue;
      if (requireClearCurb && !this.isTaxiCurbClear(taxi.vehicle, position)) continue;
      const route = traffic.routePreview(
        { x: taxi.vehicle.sprite.x, y: taxi.vehicle.sprite.y },
        position,
      );
      if (!route || route.laneIds.length === 0 || error >= selectedDistance) continue;
      selectedDistance = error;
      selected = {
        position: { x: position.x, y: position.y },
        route,
        laneStop: {
          laneId: lane.id,
          laneDistance: distance,
          position: { x: position.x, y: position.y },
          heading: pose.heading,
        },
      };
    }
    return selected;
  }

  /** One request-time clearance test avoids selecting a stopping point already occupied by a vehicle. */
  private isTaxiCurbClear(taxi: Vehicle, position: Vector2): boolean {
    return this.isSnappCurbClear(position, taxi.id);
  }

  private isSnappCurbClear(position: Vector2, excludedVehicleId: number | null = null): boolean {
    const minimumSq = TAXI_PICKUP_CLEARANCE * TAXI_PICKUP_CLEARANCE;
    for (const vehicle of this.vehicles?.vehicles ?? []) {
      if (vehicle.id === excludedVehicleId || vehicle.isDestroyed || !vehicle.sprite.active) continue;
      if (this.distanceSq(position, vehicle.sprite) < minimumSq) return false;
    }
    return true;
  }

  private currentBusStop(bus: BusRuntime): BusStopSite | null {
    return bus.route.stops[bus.currentStopIndex] ?? null;
  }

  private targetBusStop(bus: BusRuntime): BusStopSite | null {
    return bus.route.stops[bus.targetStopIndex] ?? null;
  }

  /** The bus must be at its named road lane, at a small curb radius, moving slowly, and aligned. */
  private busIsStoppedAt(
    bus: BusRuntime,
    stop: BusStopSite | null,
    requireDriverArrival: boolean,
  ): boolean {
    if (!stop || !this.isVehicleStoppedAt(bus.vehicle, stop.stopPosition, BUS_STOP_RANGE, requireDriverArrival)) {
      return false;
    }
    const driver = this.traffic?.driverFor(bus.vehicle) ?? null;
    const debug = driver?.debug ?? null;
    if (debug?.laneId !== stop.laneId) return false;
    return Math.abs(Phaser.Math.Angle.Wrap(bus.vehicle.movement.heading - stop.heading)) <= BUS_STOPPING_CONFIG.headingToleranceRadians;
  }

  private busHasTargetDirection(bus: BusRuntime): boolean {
    const stop = this.targetBusStop(bus);
    const debug = this.traffic?.driverFor(bus.vehicle)?.debug ?? null;
    if (!stop || !debug || debug.laneId !== stop.laneId) return false;
    return Math.abs(Phaser.Math.Angle.Wrap(bus.vehicle.movement.heading - stop.heading)) <= BUS_STOPPING_CONFIG.headingToleranceRadians;
  }

  private busDistanceAlongTargetLane(bus: BusRuntime): number | null {
    const stop = this.targetBusStop(bus);
    const debug = this.traffic?.driverFor(bus.vehicle)?.debug ?? null;
    if (!stop || !debug || debug.laneId !== stop.laneId) return null;
    return stop.laneDistance - debug.laneDistance;
  }

  private busShouldBeginApproach(bus: BusRuntime): boolean {
    const remaining = this.busDistanceAlongTargetLane(bus);
    return remaining !== null && remaining <= BUS_STOPPING_CONFIG.approachDistance && remaining >= -BUS_STOP_RANGE;
  }

  private busShouldAlignWithStop(bus: BusRuntime): boolean {
    const remaining = this.busDistanceAlongTargetLane(bus);
    return (
      remaining !== null &&
      remaining <= BUS_STOPPING_CONFIG.alignmentDistance &&
      remaining >= -BUS_STOP_RANGE &&
      this.busHasTargetDirection(bus)
    );
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

  /**
   * Return city service targets with the central, physically generated bus
   * stops first. This makes an available taxi discoverable near a city arrival
   * point instead of scattering every initial service vehicle across a map that
   * is several kilometres wide.
   */
  private taxiServiceTargets(cityId: CityId): Vector2[] {
    const world = this.world;
    if (!world) return [];
    const city = world.map.cities.find((candidate) => candidate.id === cityId) ?? null;
    const stops = world.map.busStops
      .filter((stop) => stop.cityId === cityId)
      .sort((left, right) => {
        const leftDistance = city ? this.distanceSq(left.approachPosition, city.center) : 0;
        const rightDistance = city ? this.distanceSq(right.approachPosition, city.center) : 0;
        return leftDistance - rightDistance || left.id.localeCompare(right.id);
      });
    const landmarks = CITY_TRANSIT_CONFIG[cityId].taxi.serviceLandmarkIds
      .map((id) => world.map.landmarks.find((candidate) => candidate.id === id && candidate.cityId === cityId))
      .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));
    const targets: Vector2[] = [];
    const seen = new Set<string>();
    const add = (point: Vector2): void => {
      const key = `${Math.round(point.x)},${Math.round(point.y)}`;
      if (seen.has(key)) return;
      seen.add(key);
      targets.push({ x: point.x, y: point.y });
    };

    // Interleave central stop coverage and commercial landmarks so the local
    // reserve is easy to find while the remaining fleet still covers the city.
    const maximum = Math.max(stops.length, landmarks.length);
    for (let index = 0; index < maximum; index += 1) {
      const stop = stops[index];
      const landmark = landmarks[index];
      if (stop) add(stop.approachPosition);
      if (landmark) add(landmark.position);
    }
    return targets;
  }

  /** Candidate road targets for one real taxi materialization, ordered locally first when needed. */
  private taxiSpawnTargets(cityId: CityId, preferredPosition: Vector2 | null): Vector2[] {
    const serviceTargets = this.taxiServiceTargets(cityId);
    if (serviceTargets.length === 0) return [];
    const targets: Vector2[] = [];
    const seen = new Set<string>();
    const add = (point: Vector2): void => {
      const key = `${Math.round(point.x)},${Math.round(point.y)}`;
      if (seen.has(key)) return;
      seen.add(key);
      targets.push({ x: point.x, y: point.y });
    };

    if (preferredPosition) {
      for (const point of this.localTaxiSpawnTargets(cityId, preferredPosition)) add(point);
    }

    const offset = this.taxiRoamOrdinals[cityId] % serviceTargets.length;
    this.taxiRoamOrdinals[cityId] = (offset + 1) % serviceTargets.length;
    for (let index = 0; index < serviceTargets.length && targets.length < TAXI_SERVICE_TARGET_LIMIT; index += 1) {
      const point = serviceTargets[(offset + index) % serviceTargets.length];
      if (point) add(point);
    }
    return targets;
  }

  /**
   * Find legal lane points around an active player without scanning the entire
   * city. The normal service-vehicle spawner performs the final occupancy and
   * lane-clearance validation before it creates anything.
   */
  private localTaxiSpawnTargets(cityId: CityId, position: Vector2): Vector2[] {
    const network = this.traffic?.roadNetwork;
    const world = this.world;
    const config = CITY_TRANSIT_CONFIG[cityId].taxi;
    if (!network || !world) return [];
    const candidates: Array<{ point: Vector2; score: number }> = [];
    const seen = new Set<string>();
    for (const lane of network.nearbyTravelLanes(position, config.encounterRadius, TAXI_ENCOUNTER_LANE_LIMIT)) {
      const projection = network.projectPoint(position, lane);
      const clearance = Math.min(
        TAXI_PICKUP_JUNCTION_CLEARANCE,
        Math.max(52, Math.floor(lane.spline.length * 0.22)),
      );
      if (lane.spline.length <= clearance * 2 + TAXI_STOP_RANGE * 2) continue;
      for (const offset of [-TAXI_ENCOUNTER_PREFERRED_SPAWN_DISTANCE, TAXI_ENCOUNTER_PREFERRED_SPAWN_DISTANCE]) {
        const laneDistance = Phaser.Math.Clamp(
          projection.distance + offset,
          clearance,
          lane.spline.length - clearance,
        );
        const point = network.pointAt(lane, laneDistance).point;
        if (world.cityAt(point.x, point.y)?.id !== cityId) continue;
        const distance = Math.hypot(point.x - position.x, point.y - position.y);
        if (distance < TAXI_ENCOUNTER_MIN_SPAWN_DISTANCE || distance > config.encounterRadius) continue;
        const key = `${Math.round(point.x)},${Math.round(point.y)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({ point: { x: point.x, y: point.y }, score: Math.abs(distance - TAXI_ENCOUNTER_PREFERRED_SPAWN_DISTANCE) });
      }
    }
    candidates.sort((left, right) => left.score - right.score);
    return candidates.map((candidate) => candidate.point);
  }

  private nextTaxiRoadTarget(cityId: CityId): Vector2 | null {
    const points = this.taxiServiceTargets(cityId);
    if (points.length === 0) return null;
    const ordinal = this.taxiRoamOrdinals[cityId] % points.length;
    this.taxiRoamOrdinals[cityId] = (ordinal + 1) % points.length;
    const point = points[ordinal];
    return point ? { x: point.x, y: point.y } : null;
  }

  private nearbyAvailableTaxiCount(cityId: CityId, position: Vector2, radius: number): number {
    const maximumSq = radius * radius;
    let count = 0;
    for (const taxi of this.taxis.values()) {
      if (taxi.cityId !== cityId || !this.isTaxiHireable(taxi)) continue;
      if (this.distanceSq(position, taxi.vehicle.sprite) <= maximumSq) count += 1;
    }
    return count;
  }

  /** Retarget a real, unoccupied taxi through the normal traffic driver; it is never teleported. */
  private retargetAvailableTaxiForEncounter(cityId: CityId, position: Vector2): boolean {
    const traffic = this.traffic;
    const target = this.localTaxiSpawnTargets(cityId, position)[0] ?? null;
    if (!traffic || !target) return false;
    const radiusSq = CITY_TRANSIT_CONFIG[cityId].taxi.encounterRadius ** 2;
    const candidate = Array.from(this.taxis.values())
      .filter(
        (taxi) =>
          taxi.cityId === cityId &&
          !taxi.standAtNextTarget &&
          taxi.idleUntil === 0 &&
          this.isTaxiHireable(taxi) &&
          this.distanceSq(position, taxi.vehicle.sprite) > radiusSq,
      )
      .sort(
        (left, right) =>
          this.distanceSq(position, left.vehicle.sprite) - this.distanceSq(position, right.vehicle.sprite),
      )[0];
    if (!candidate) return false;
    candidate.roamTarget = target;
    candidate.standAtNextTarget = true;
    candidate.recoveryAttempts = 0;
    traffic.configureDriver(candidate.vehicle, () => this.taxiTarget(candidate.vehicle.id), TAXI_STOP_RANGE, false);
    return true;
  }

  private nearestTaxi(
    position: Vector2,
    range: number,
    states: readonly TaxiState[],
    predicate: (taxi: TaxiRuntime) => boolean = () => true,
  ): TaxiRuntime | null {
    const maxSq = range * range;
    let selected: TaxiRuntime | null = null;
    let selectedSq = maxSq;
    for (const taxi of this.taxis.values()) {
      if (!states.includes(taxi.state) || !predicate(taxi)) continue;
      const distanceSq = this.distanceSq(position, taxi.vehicle.sprite);
      if (distanceSq <= selectedSq) {
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
      if (!this.busCanBoard(bus)) {
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

  private isSnappTerminal(state: SnappBookingState): boolean {
    return state === 'COMPLETED' || state === 'CANCELLED' || state === 'FAILED' || state === 'REFUNDED';
  }

  private refreshSnappTracking(time: number): void {
    if (this.snappTrackingAccumulatorMs < SNAPP_CONFIG.trackingUpdateMs && this.snappTrackingValue) return;
    this.snappTrackingAccumulatorMs = 0;
    const booking = this.snappBookingValue;
    const taxi = booking?.assignedVehicleId === null || booking?.assignedVehicleId === undefined
      ? null
      : this.taxis.get(booking.assignedVehicleId) ?? null;
    if (!booking || !taxi || !booking.destination || !booking.pickupAnchor || this.isSnappTerminal(booking.state)) {
      this.snappTrackingValue = null;
      return;
    }
    const driverPosition = { x: taxi.vehicle.sprite.x, y: taxi.vehicle.sprite.y };
    const destinationPosition = booking.dropoffPosition ?? booking.destination.position;
    const isDriverPhase = booking.state === 'DRIVER_EN_ROUTE' || booking.state === 'DRIVER_ARRIVED';
    const driverRoute = isDriverPhase
      ? this.traffic?.routePreview(driverPosition, booking.pickupAnchor) ?? null
      : null;
    const passengerRoute = booking.state === 'PASSENGER_BOARDING' || booking.state === 'RIDING' || booking.state === 'ARRIVED'
      ? this.traffic?.routePreview(driverPosition, destinationPosition) ?? booking.quote?.route ?? null
      : booking.quote?.route ?? null;
    const routeDistance = isDriverPhase
      ? driverRoute?.distancePx ?? 0
      : passengerRoute?.distancePx ?? 0;
    const initialDistance = booking.quote?.route.distancePx ?? Math.max(1, routeDistance);
    const remainingDistancePx = Math.max(0, routeDistance);
    const progressRatio = Phaser.Math.Clamp(1 - remainingDistancePx / Math.max(1, initialDistance), 0, 1);
    const waitingForPassenger = booking.state === 'DRIVER_ARRIVED';
    const pickupWaitRemainingMs = waitingForPassenger && booking.pickupDeadlineServiceMs !== null
      ? Math.max(0, booking.pickupDeadlineServiceMs - this.serviceClockMs)
      : 0;
    const snapshot: SnappTrackingSnapshot = {
      bookingId: booking.id,
      vehicleId: taxi.vehicle.id,
      driverPosition,
      playerPosition: this.player?.playerPosition ? { ...this.player.playerPosition } : null,
      pickupPosition: { ...booking.pickup },
      pickupAnchor: { ...booking.pickupAnchor },
      destinationPosition: { ...destinationPosition },
      state: booking.state,
      driverRoute,
      passengerRoute,
      remainingDistancePx,
      estimatedTimeOfArrivalMs: Math.round((remainingDistancePx / SNAPP_CONFIG.averageSpeedPxPerSecond) * 1000),
      progressRatio,
      driverArrivedAtServiceMs: booking.driverArrivedAtServiceMs,
      pickupDeadlineServiceMs: booking.pickupDeadlineServiceMs,
      pickupWaitRemainingMs,
      vehicleHeading: taxi.vehicle.movement.heading,
      timestamp: time,
      updateSequence: this.snappTrackingSequence + 1,
    };
    this.snappTrackingSequence = snapshot.updateSequence;
    this.snappTrackingValue = snapshot;
    this.bus.emit(EventKeys.SnappTrackingUpdated, this.cloneSnappTracking(snapshot));
  }

  private playerEntityRotation(): number {
    return this.player?.player?.sprite.rotation ?? 0;
  }

  private pickupAnchorLabel(cityId: CityId): string {
    return `${CITY_TRANSIT_CONFIG[cityId].cityId.toUpperCase()} curb`;
  }

  private isSnappSelectionState(state: SnappBookingState): boolean {
    return state === 'SELECTING_DESTINATION' || state === 'QUOTE_READY';
  }

  private nextSnappId(prefix: string): string {
    const id = `snapp-${prefix}-${Date.now().toString(36)}-${this.snappSequence}`;
    this.snappSequence += 1;
    return id;
  }

  /** Pick a real taxi for route geometry; no vehicle is reserved during quoting. */
  private findSnappGeometryTaxi(cityId: CityId): TaxiRuntime | null {
    return (
      Array.from(this.taxis.values()).find(
        (taxi) => taxi.cityId === cityId && !taxi.vehicle.isDestroyed && taxi.vehicle.sprite.active && this.taxiHasDriverAndPassengerSeat(taxi),
      ) ??
      Array.from(this.taxis.values()).find(
        (taxi) => taxi.cityId === cityId && !taxi.vehicle.isDestroyed && taxi.vehicle.sprite.active,
      ) ??
      null
    );
  }

  private findSnappDispatchCandidate(
    booking: SnappBookingSnapshot,
  ): { taxi: TaxiRuntime; pickup: TaxiRoadTarget; dropoff: TaxiRoadTarget } | null {
    const destination = booking.destination;
    if (!destination) return null;
    const pickupStop = this.ensureBookingPickupStop(booking);
    if (!pickupStop) return null;
    const destinationPosition = booking.dropoffPosition ?? destination.position;
    const candidates = Array.from(this.taxis.values())
      .filter((taxi) => taxi.cityId === booking.cityId && this.isTaxiHireable(taxi));
    let selected: { taxi: TaxiRuntime; pickup: TaxiRoadTarget; dropoff: TaxiRoadTarget } | null = null;
    let selectedRouteDistance = Infinity;
    for (const taxi of candidates) {
      const pickup = this.snappPickupRoadTargetForTaxi(taxi, pickupStop, true);
      const dropoff = booking.dropoffPosition
        ? this.resolveExactTaxiRoadTarget(taxi, booking.dropoffPosition, false)
        : this.resolveTaxiRoadTarget(taxi, destinationPosition, false);
      if (!pickup || !dropoff) continue;
      const route = this.traffic?.routePreview(pickup.position, dropoff.position);
      if (!route || route.laneIds.length === 0) continue;
      const routeDistance = pickup.route.distancePx;
      if (
        routeDistance < selectedRouteDistance ||
        (routeDistance === selectedRouteDistance && taxi.vehicle.id < (selected?.taxi.vehicle.id ?? Infinity))
      ) {
        selected = { taxi, pickup, dropoff };
        selectedRouteDistance = routeDistance;
      }
    }
    return selected;
  }

  private snappPickupRoadTargetForTaxi(
    taxi: TaxiRuntime,
    stop: SnappPickupAnchor,
    requireClearCurb: boolean,
  ): TaxiRoadTarget | null {
    const traffic = this.traffic;
    const network = traffic?.roadNetwork;
    const lane = network?.lane(stop.laneId) ?? null;
    if (
      !traffic ||
      !network ||
      !lane ||
      lane.kind !== 'travel' ||
      lane.roadSegmentId !== stop.roadSegmentId ||
      this.world?.cityAt(stop.position.x, stop.position.y)?.id !== taxi.cityId
    ) {
      return null;
    }
    const pose = network.pointAt(lane, stop.laneDistance);
    if (
      Math.hypot(pose.point.x - stop.position.x, pose.point.y - stop.position.y) >
        TAXI_EXACT_TARGET_TOLERANCE ||
      Math.abs(Phaser.Math.Angle.Wrap(pose.heading - stop.heading)) >
        SNAPP_CONFIG.pickupArrivalHeadingToleranceRadians ||
      (requireClearCurb && !this.isTaxiCurbClear(taxi.vehicle, stop.position))
    ) {
      return null;
    }
    const laneStop: TrafficLaneStopTarget = {
      laneId: stop.laneId,
      laneDistance: stop.laneDistance,
      position: { ...stop.position },
      heading: stop.heading,
    };
    const route = traffic.routePreviewToLaneStop(
      { x: taxi.vehicle.sprite.x, y: taxi.vehicle.sprite.y },
      laneStop,
    );
    if (
      !route ||
      route.laneIds.length === 0 ||
      route.laneIds[route.laneIds.length - 1] !== stop.laneId
    ) return null;
    return { position: { ...stop.position }, route, laneStop };
  }

  private refundSnappBooking(reason: string): boolean {
    const booking = this.snappBookingValue;
    const amount = booking?.quote?.total ?? 0;
    if (!booking || booking.payment !== 'paid' || amount <= 0) return false;
    const player = this.player?.player;
    if (!player) return false;
    player.inventory.addMoney(amount);
    booking.payment = 'refunded';
    booking.state = 'REFUNDED';
    booking.error = reason;
    this.bus.emit(EventKeys.SnappRefundIssued, {
      bookingId: booking.id,
      transactionId: booking.transactionId,
      amount,
      state: booking.state,
    });
    return true;
  }

  private failSnappBooking(reason: string): void {
    const booking = this.snappBookingValue;
    if (!booking || this.isSnappTerminal(booking.state) || booking.state === 'QUOTE_READY' || booking.state === 'SELECTING_DESTINATION') return;
    this.log.warn(`Snapp ${booking.id} failed from ${booking.state}: ${reason}`);
    const taxi = booking.assignedVehicleId === null ? null : this.taxis.get(booking.assignedVehicleId) ?? null;
    if (taxi) {
      if (taxi.state === 'PASSENGER_BOARDING') this.occupants?.releasePlayerPassengerSeat(taxi.vehicle);
      this.returnTaxiToService(taxi);
    }
    booking.state = 'FAILED';
    booking.error = reason;
    const refunded = this.refundSnappBooking(reason);
    this.bus.emit(EventKeys.SnappBookingFailed, { bookingId: booking.id, reason, refunded });
  }

  private completeSnappRide(taxi: TaxiRuntime): void {
    const booking = this.snappBookingValue;
    if (!taxi.snappBookingId || booking?.id !== taxi.snappBookingId) {
      this.returnTaxiToService(taxi);
      return;
    }
    booking.state = 'COMPLETED';
    booking.error = null;
    this.bus.emit(EventKeys.SnappRideCompleted, { bookingId: booking.id, vehicleId: taxi.vehicle.id });
    this.returnTaxiToService(taxi);
  }

  private validateRestoredSnappBooking(): void {
    if (this.snappRecoveryChecked || !this.snappBookingValue) return;
    const booking = this.snappBookingValue;
    if (this.isSnappTerminal(booking.state) || booking.payment !== 'paid') {
      if (booking.state === 'PAYMENT_PENDING') {
        booking.state = 'QUOTE_READY';
        booking.error = 'Payment was interrupted before dispatch.';
      }
      this.snappRecoveryChecked = true;
      return;
    }
    if (booking.assignedVehicleId === null) {
      this.failSnappBooking('Saved Snapp vehicle is no longer available');
      this.snappRecoveryChecked = true;
      return;
    }
    const taxi = this.taxis.get(booking.assignedVehicleId) ?? null;
    if (!taxi || taxi.snappBookingId !== booking.id || !booking.destination || !booking.quote) {
      this.failSnappBooking('Saved Snapp vehicle is no longer available');
      this.snappRecoveryChecked = true;
      return;
    }
    const pickupStop = this.ensureBookingPickupStop(booking);
    const pickup = pickupStop
      ? this.snappPickupRoadTargetForTaxi(taxi, pickupStop, false)
      : null;
    const destinationPosition = booking.dropoffPosition ?? booking.destination.position;
    const dropoff = booking.dropoffPosition
      ? this.resolveExactTaxiRoadTarget(taxi, booking.dropoffPosition, false)
      : this.resolveTaxiRoadTarget(taxi, destinationPosition, false);
    if (!pickup || !dropoff) {
      this.failSnappBooking('Saved Snapp route is no longer reachable');
      this.snappRecoveryChecked = true;
      return;
    }
    taxi.snappBookingId = booking.id;
    taxi.playerRequestPosition = { ...booking.pickup };
    taxi.pickupPosition = { ...pickup.position };
    taxi.pickupLaneStop = pickup.laneStop ?? null;
    taxi.dropoffPosition = { ...dropoff.position };
    taxi.dropoffLaneStop = dropoff.laneStop ?? null;
    taxi.destination = { ...booking.destination, position: { ...booking.destination.position } };
    taxi.fare = { ...booking.quote, route: booking.quote.route };
    taxi.farePaid = true;
    taxi.vehicle.sprite.setData('snappBookingId', booking.id);
    taxi.vehicle.sprite.setData('serviceLivery', 'snapp');
    taxi.vehicle.sprite.setTint(SNAPP_CONFIG.turquoise);
    if (booking.state === 'DRIVER_ARRIVED') {
      booking.driverArrivedAtServiceMs ??= this.serviceClockMs;
      booking.pickupDeadlineServiceMs ??= this.serviceClockMs + SNAPP_CONFIG.passengerPickupWaitMs;
      this.setTaxiState(taxi, 'WAITING_FOR_PASSENGER');
      this.traffic?.setDriverStopped(taxi.vehicle, true);
    } else if (booking.state === 'PASSENGER_BOARDING') {
      this.setTaxiState(taxi, 'PASSENGER_BOARDING');
      this.traffic?.setDriverStopped(taxi.vehicle, true);
    } else if (booking.state === 'RIDING' || booking.state === 'ARRIVED') {
      this.setTaxiState(taxi, booking.state === 'ARRIVED' ? 'ARRIVING' : 'IN_SERVICE');
    } else {
      this.setTaxiState(taxi, 'APPROACHING_PICKUP');
    }
    const pickupPhase = booking.state === 'DRIVER_EN_ROUTE' || booking.state === 'DRIVER_ARRIVED' || booking.state === 'PASSENGER_BOARDING';
    const restoredTarget = pickupPhase ? taxi.pickupLaneStop : taxi.dropoffLaneStop;
    const restoredStopped = booking.state === 'DRIVER_ARRIVED' || booking.state === 'PASSENGER_BOARDING' || booking.state === 'ARRIVED';
    if (restoredTarget) {
      this.traffic?.configureDriverAtLaneStop(
        taxi.vehicle,
        () => this.taxiTarget(taxi.vehicle.id),
        restoredTarget,
        TAXI_STOP_RANGE,
        restoredStopped,
      );
    } else {
      this.traffic?.configureDriver(taxi.vehicle, () => this.taxiTarget(taxi.vehicle.id), TAXI_STOP_RANGE, false);
    }
    this.snappRecoveryChecked = true;
  }

  /** Consume v3 metadata verbatim; legacy saves are rebound once during migration only. */
  private ensureBookingPickupStop(booking: SnappBookingSnapshot): SnappPickupAnchor | null {
    const network = this.traffic?.roadNetwork;
    if (!network) return null;
    const stored = booking.pickupStop;
    if (stored) {
      const lane = network.lane(stored.laneId);
      if (!lane || lane.roadSegmentId !== stored.roadSegmentId || lane.kind !== 'travel') return null;
      const pose = network.pointAt(lane, stored.laneDistance);
      const positionError = Math.hypot(
        pose.point.x - stored.position.x,
        pose.point.y - stored.position.y,
      );
      const headingError = Math.abs(Phaser.Math.Angle.Wrap(pose.heading - stored.heading));
      if (
        positionError > TAXI_EXACT_TARGET_TOLERANCE ||
        headingError > SNAPP_CONFIG.pickupArrivalHeadingToleranceRadians
      ) {
        return null;
      }
      return this.cloneSnappPickupAnchor(stored);
    }
    if (booking.version === 3) return null;

    // v1/v2 did not persist a lane id. Bind their already-saved curb coordinate
    // once, then immediately upgrade; subsequent quote/dispatch/restore paths
    // consume the exact target and never repeat this nearest-lane lookup.
    const legacyPosition = booking.pickupAnchor ?? booking.quote?.pickupAnchor ?? booking.pickup;
    const lane = network.nearestLane(legacyPosition, undefined, true);
    if (!lane?.roadSegmentId || lane.role !== 'outer') return null;
    const projection = network.projectPoint(legacyPosition, lane);
    const laneDistance = Phaser.Math.Clamp(
      projection.distance,
      SNAPP_CONFIG.pickupIntersectionClearancePx,
      lane.spline.length - SNAPP_CONFIG.pickupIntersectionClearancePx,
    );
    const pose = network.pointAt(lane, laneDistance);
    if (
      Math.hypot(pose.point.x - legacyPosition.x, pose.point.y - legacyPosition.y) >
      TAXI_EXACT_TARGET_TOLERANCE
    ) {
      return null;
    }
    const approach = this.resolveSnappApproachAtPose(pose.point, pose.heading, booking.pickup);
    if (!approach) return null;
    const migrated: SnappPickupAnchor = {
      roadSegmentId: lane.roadSegmentId,
      laneId: lane.id,
      laneDistance,
      position: { ...pose.point },
      heading: pose.heading,
      displacementPx: Math.hypot(pose.point.x - booking.pickup.x, pose.point.y - booking.pickup.y),
      curbSide: 'rear-right',
      boardingApproach: approach,
    };
    booking.version = 3;
    booking.pickupStop = this.cloneSnappPickupAnchor(migrated);
    booking.pickupAnchor = { ...migrated.position };
    booking.pickupWalkingDistancePx = migrated.displacementPx;
    return migrated;
  }

  private cloneSnappPickupAnchor(anchor: SnappPickupAnchor): SnappPickupAnchor {
    return {
      ...anchor,
      position: { ...anchor.position },
      boardingApproach: { ...anchor.boardingApproach },
    };
  }

  private cloneSnappBooking(booking: SnappBookingSnapshot): SnappBookingSnapshot {
    return {
      ...booking,
      version: booking.version,
      pickup: { ...booking.pickup },
      pickupRotation: booking.pickupRotation ?? 0,
      pickupAnchor: booking.pickupAnchor ? { ...booking.pickupAnchor } : null,
      pickupStop: booking.pickupStop ? this.cloneSnappPickupAnchor(booking.pickupStop) : null,
      pickupWalkingDistancePx: booking.pickupWalkingDistancePx ?? 0,
      pickupAnchorLabel: booking.pickupAnchorLabel ?? null,
      destination: booking.destination
        ? { ...booking.destination, position: { ...booking.destination.position } }
        : null,
      dropoffPosition: booking.dropoffPosition ? { ...booking.dropoffPosition } : null,
      driverArrivedAtServiceMs: booking.driverArrivedAtServiceMs ?? null,
      pickupDeadlineServiceMs: booking.pickupDeadlineServiceMs ?? null,
      quote: booking.quote
        ? {
            ...booking.quote,
            pickup: { ...booking.quote.pickup },
            destination: { ...booking.quote.destination, position: { ...booking.quote.destination.position } },
            pickupAnchor: { ...booking.quote.pickupAnchor },
            dropoffPosition: { ...booking.quote.dropoffPosition },
            route: {
              ...booking.quote.route,
              start: { ...booking.quote.route.start },
              end: { ...booking.quote.route.end },
              laneIds: booking.quote.route.laneIds.slice(),
            },
          }
        : null,
    };
  }

  /** Migrate a version-one save without changing the transport save root. */
  private normalizeSnappBooking(booking: SnappBookingSnapshot): SnappBookingSnapshot {
    const quote = booking.quote;
    const pickupAnchor = booking.pickupAnchor ?? quote?.pickupAnchor ?? quote?.route.start ?? booking.pickup;
    const dropoffPosition = booking.dropoffPosition ?? quote?.dropoffPosition ?? quote?.route.end ?? null;
    return this.cloneSnappBooking({
      ...booking,
      version: booking.version,
      pickupStop: booking.pickupStop ?? null,
      pickupRotation: booking.pickupRotation ?? 0,
      pickupAnchor,
      pickupWalkingDistancePx: booking.pickupWalkingDistancePx ?? Math.hypot(pickupAnchor.x - booking.pickup.x, pickupAnchor.y - booking.pickup.y),
      pickupAnchorLabel: booking.pickupAnchorLabel ?? 'Nearest legal curb',
      driverArrivedAtServiceMs: booking.driverArrivedAtServiceMs ?? null,
      pickupDeadlineServiceMs: booking.pickupDeadlineServiceMs ?? null,
      dropoffPosition,
      quote: quote
        ? {
            ...quote,
            pickupAnchor: quote.pickupAnchor ?? pickupAnchor,
            pickupWalkingDistancePx: quote.pickupWalkingDistancePx ?? Math.hypot(pickupAnchor.x - quote.pickup.x, pickupAnchor.y - quote.pickup.y),
            pickupAnchorLabel: quote.pickupAnchorLabel ?? 'Nearest legal curb',
            dropoffPosition: quote.dropoffPosition ?? dropoffPosition ?? quote.route.end,
            dropoffSnapDistancePx: quote.dropoffSnapDistancePx ?? Math.hypot(quote.destination.position.x - (quote.dropoffPosition ?? quote.route.end).x, quote.destination.position.y - (quote.dropoffPosition ?? quote.route.end).y),
          }
        : null,
    });
  }

  private cloneSnappTracking(snapshot: SnappTrackingSnapshot): SnappTrackingSnapshot {
    return {
      ...snapshot,
      driverPosition: { ...snapshot.driverPosition },
      playerPosition: snapshot.playerPosition ? { ...snapshot.playerPosition } : null,
      pickupPosition: { ...snapshot.pickupPosition },
      pickupAnchor: { ...snapshot.pickupAnchor },
      destinationPosition: { ...snapshot.destinationPosition },
      driverRoute: snapshot.driverRoute
        ? { ...snapshot.driverRoute, start: { ...snapshot.driverRoute.start }, end: { ...snapshot.driverRoute.end }, laneIds: snapshot.driverRoute.laneIds.slice() }
        : null,
      passengerRoute: snapshot.passengerRoute
        ? { ...snapshot.passengerRoute, start: { ...snapshot.passengerRoute.start }, end: { ...snapshot.passengerRoute.end }, laneIds: snapshot.passengerRoute.laneIds.slice() }
        : null,
    };
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
        status: bus.state === 'STOPPED_AT_STOP' ? 'At stop' : 'In service',
        canExit: bus.state === 'STOPPED_AT_STOP' && bus.boardingActive && this.busIsAtCurrentStop(bus),
      };
    }
    const taxi = this.taxis.get(vehicle.id);
    if (!taxi) return null;
    return {
      kind: 'taxi',
      vehicleId: vehicle.id,
      destination: taxi.destination?.label,
      status:
        taxi.state === 'DESTINATION_SELECTION'
          ? 'Choose destination'
          : taxi.state === 'FARE_CONFIRMATION'
            ? 'Confirm fare'
          : taxi.state === 'ARRIVING'
            ? 'Arrived'
            : taxi.state === 'IN_SERVICE'
              ? 'En route'
              : 'Boarding',
      fareTotal: taxi.fare?.total,
      canExit: taxi.state === 'ARRIVING' && this.taxiIsAtDropoff(taxi),
    };
  }

  private safeTransitExitPosition(
    vehicle: Vehicle,
    stop: BusStopSite | null,
    preferred: Vector2 | null = null,
  ): Vector2 | null {
    const requested = stop?.waitingPositions[0] ?? preferred;
    if (requested) {
      const safe = this.world?.resolveSafePedestrianPosition(requested, PLAYER.RADIUS, {
        maxDistance: 96,
        segmentStart: { x: vehicle.sprite.x, y: vehicle.sprite.y },
      });
      if (safe) return safe;
    }
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
    const driverDebug = this.traffic?.driverFor(bus.vehicle)?.debug ?? null;
    const distanceToStop = target
      ? Math.hypot(bus.vehicle.sprite.x - target.stopPosition.x, bus.vehicle.sprite.y - target.stopPosition.y)
      : null;
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
      boardingActive: bus.boardingActive,
      position: { x: bus.vehicle.sprite.x, y: bus.vehicle.sprite.y },
      targetStopPosition: target ? { ...target.stopPosition } : null,
      targetLaneId: target?.laneId ?? null,
      targetLaneDistance: target?.laneDistance ?? null,
      currentLaneId: driverDebug?.laneId ?? null,
      currentLaneDistance: driverDebug?.laneDistance ?? null,
      distanceToStop,
      headingErrorRadians: target
        ? Math.abs(Phaser.Math.Angle.Wrap(bus.vehicle.movement.heading - target.heading))
        : null,
      driverState: driverDebug?.state ?? null,
      passengerCount,
      passengerCapacity: bus.route.config.passengerCapacity,
      validLaneRoute: Boolean(
        target &&
          bus.route.segments.every((segment) => segment.valid) &&
          this.traffic?.roadNetwork?.lane(target.laneId)?.kind === 'travel',
      ),
    };
  }

  private taxiSnapshot(taxi: TaxiRuntime): TaxiServiceSnapshot {
    const occupants = this.occupants?.occupantsFor(taxi.vehicle) ?? [];
    const driver = this.traffic?.driverFor(taxi.vehicle) ?? null;
    const playerPosition = this.player?.playerPosition ?? null;
    return {
      vehicleId: taxi.vehicle.id,
      cityId: taxi.cityId,
      state: taxi.state,
      position: { x: taxi.vehicle.sprite.x, y: taxi.vehicle.sprite.y },
      hasDriver: occupants.some(
        (occupant) => occupant.seat === 'driver' && occupant.role === 'taxi-driver',
      ),
      hasPassenger: occupants.some((occupant) => occupant.seat !== 'driver'),
      driverState: driver?.state ?? null,
      distanceToPlayer: playerPosition
        ? Math.hypot(taxi.vehicle.sprite.x - playerPosition.x, taxi.vehicle.sprite.y - playerPosition.y)
        : null,
      destination: taxi.destination,
      fare: taxi.fare,
      validLaneRoute: taxi.validLaneRoute,
    };
  }

  private removeDestroyedService(vehicleId: number): void {
    const taxi = this.taxis.get(vehicleId);
    if (taxi?.snappBookingId) this.failSnappBooking('Assigned Snapp vehicle was destroyed');
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
    this.taxiRoamOrdinals.tehran = 0;
    this.taxiRoamOrdinals.yazd = 0;
    this.taxiRoamOrdinals.gilan = 0;
    this.resolvedRoutes.clear();
    this.routeInitializationQueue.length = 0;
    this.buses.clear();
    this.taxis.clear();
    this.passengerPlans.clear();
    this.snappRecoveryChecked = false;
    this.snappTrackingValue = null;
    this.snappTrackingAccumulatorMs = 0;
    this.snappSelectionErrorValue = null;
  }

  private distanceSq(first: Vector2, second: { x: number; y: number }): number {
    const dx = first.x - second.x;
    const dy = first.y - second.y;
    return dx * dx + dy * dy;
  }

  private now(): number {
    return this.serviceClockMs;
  }

  /** Advance exactly once from the bounded ManagerRegistry delta. */
  private advanceServiceClock(delta: number): void {
    const boundedDelta = Math.max(0, Math.min(100, Number.isFinite(delta) ? delta : 0));
    this.serviceClockMs += boundedDelta;
  }
}
