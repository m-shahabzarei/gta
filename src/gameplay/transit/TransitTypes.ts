import type { Vector2 } from '@/core/types';
import type { BusStopSite, CityId } from '@/gameplay/types';

/** A landmark-backed stop anchor. Keeping routes semantic survives deterministic world regeneration. */
export interface TransitRouteAnchor {
  id: string;
  label: string;
  landmarkIds: readonly string[];
}

/** Static definition of one public bus line before physical stops are resolved. */
export interface BusRouteConfig {
  id: string;
  name: string;
  color: number;
  anchors: readonly TransitRouteAnchor[];
  vehicles: number;
  stopDurationMs: number;
  passengerCapacity: number;
  active: boolean;
}

/** City-specific taxi supply, fare terms, and roaming route targets. */
export interface TaxiConfig {
  population: number;
  /** Radius in which an exploring player should be able to encounter an available taxi. */
  encounterRadius: number;
  /** Minimum number of ready taxis maintained around the active city's player. */
  guaranteedNearby: number;
  /** How long a newly materialized city-hub taxi waits before joining normal traffic. */
  standDurationMs: number;
  baseFare: number;
  perKilometerFare: number;
  trafficFareFactor: number;
  waitingFarePerMinute: number;
  serviceLandmarkIds: readonly string[];
}

export interface CityTransitConfig {
  cityId: CityId;
  busRoutes: readonly BusRouteConfig[];
  taxi: TaxiConfig;
}

/** A bus route resolved onto concrete, lane-backed world stop records. */
export interface ResolvedBusRoute {
  config: BusRouteConfig;
  stops: readonly BusStopSite[];
  segments: readonly BusRouteSegment[];
  validation: BusRouteValidation;
  valid: boolean;
  issue?: string;
}

/** Cached legal lane path between two ordered stops on an active bus line. */
export interface BusRouteSegment {
  fromStopId: string;
  toStopId: string;
  laneIds: readonly string[];
  valid: boolean;
  issue?: string;
}

/** Per-stop route-authoring result exposed to development tools and smoke tests. */
export interface BusRouteStopValidation {
  index: number;
  stopId: string;
  status: 'OK' | 'ERROR';
  issue?: string;
}

/** Route-level validation report, including every physical stop and lane segment. */
export interface BusRouteValidation {
  cityId: CityId;
  routeId: string;
  routeName: string;
  stops: readonly BusRouteStopValidation[];
  connectivity: 'VALID' | 'INVALID';
}

export type BusServiceState =
  | 'FOLLOWING_ROUTE'
  | 'APPROACHING_STOP'
  | 'ALIGNING_WITH_STOP'
  | 'STOPPED_AT_STOP'
  | 'BOARDING'
  | 'DEPARTING_STOP'
  | 'RECOVERING'
  | 'UNAVAILABLE';

export interface BusServiceSnapshot {
  vehicleId: number;
  cityId: CityId;
  routeId: string;
  routeName: string;
  routeColor: number;
  state: BusServiceState;
  currentStopId: string;
  nextStopId: string;
  dwellRemainingMs: number;
  boardingActive: boolean;
  position: Vector2;
  targetStopPosition: Vector2 | null;
  targetLaneId: string | null;
  targetLaneDistance: number | null;
  currentLaneId: string | null;
  currentLaneDistance: number | null;
  distanceToStop: number | null;
  headingErrorRadians: number | null;
  driverState: string | null;
  passengerCount: number;
  passengerCapacity: number;
  validLaneRoute: boolean;
}

/**
 * Taxi service phases are deliberately more specific than traffic-driver
 * states. The driver owns steering; transit owns the customer contract.
 */
export const TAXI_SERVICE_STATES = [
  'AVAILABLE',
  'APPROACHING_PICKUP',
  'WAITING_FOR_PASSENGER',
  'PASSENGER_BOARDING',
  'DESTINATION_SELECTION',
  'FARE_CONFIRMATION',
  'IN_SERVICE',
  'ARRIVING',
  'PASSENGER_EXITING',
  'RETURNING_TO_SERVICE',
  'UNAVAILABLE',
] as const;

export type TaxiState = (typeof TAXI_SERVICE_STATES)[number];

export interface TaxiDestination {
  id: string;
  label: string;
  position: Vector2;
  cityId: CityId;
  source: 'landmark' | 'bus-stop' | 'map';
}

export interface TrafficRoutePreview {
  laneIds: readonly string[];
  distancePx: number;
  start: Vector2;
  end: Vector2;
}

export interface TaxiFareQuote {
  baseFare: number;
  distanceKm: number;
  distanceCost: number;
  trafficFactor: number;
  waitingCost: number;
  total: number;
  route: TrafficRoutePreview;
}

export interface TaxiServiceSnapshot {
  vehicleId: number;
  cityId: CityId;
  state: TaxiState;
  /** Runtime-only diagnostics; never rendered directly to the player HUD. */
  position: Vector2;
  hasDriver: boolean;
  hasPassenger: boolean;
  driverState: string | null;
  distanceToPlayer: number | null;
  destination: TaxiDestination | null;
  fare: TaxiFareQuote | null;
  validLaneRoute: boolean;
}

export interface TransitRideSnapshot {
  kind: 'bus' | 'taxi';
  vehicleId: number;
  routeName?: string;
  currentStop?: string;
  nextStop?: string;
  upcomingStops?: readonly string[];
  destination?: string;
  status?: string;
  fareTotal?: number;
  canExit: boolean;
}

export interface TransportationDebugSnapshot {
  cityConfigs: Record<
    CityId,
    { routes: number; taxis: number; taxiEncounterRadius: number; guaranteedNearbyTaxis: number }
  >;
  busRoutes: Record<CityId, readonly ResolvedBusRoute[]>;
  buses: readonly BusServiceSnapshot[];
  taxis: readonly TaxiServiceSnapshot[];
  playerRide: TransitRideSnapshot | null;
}
