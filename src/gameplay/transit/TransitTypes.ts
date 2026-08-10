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
  valid: boolean;
  issue?: string;
}

export type BusServiceState = 'approaching' | 'dwelling' | 'recovering' | 'unavailable';

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
  passengerCount: number;
  passengerCapacity: number;
  validLaneRoute: boolean;
}

export type TaxiState =
  | 'AVAILABLE'
  | 'APPROACHING_PLAYER'
  | 'WAITING_FOR_PLAYER'
  | 'PASSENGER_BOARDING'
  | 'IN_SERVICE'
  | 'ARRIVING'
  | 'COMPLETED'
  | 'UNAVAILABLE';

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
  hasDriver: boolean;
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
  cityConfigs: Record<CityId, { routes: number; taxis: number }>;
  busRoutes: Record<CityId, readonly ResolvedBusRoute[]>;
  buses: readonly BusServiceSnapshot[];
  taxis: readonly TaxiServiceSnapshot[];
  playerRide: TransitRideSnapshot | null;
}
