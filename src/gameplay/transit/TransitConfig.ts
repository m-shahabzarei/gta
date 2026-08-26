import type { CityId } from '@/gameplay/types';
import type { Vector2 } from '@/core/types';
import type { CityTransitConfig, TaxiConfig, TaxiFareQuote, TrafficRoutePreview } from './TransitTypes';
import type { TaxiDestination } from './TransitTypes';

/** World scale used only for player-facing distance/fare presentation. */
export const TRANSIT_PIXELS_PER_KILOMETER = 4000;

/** Centralized Snapp service tuning and original turquoise service identity. */
export const SNAPP_CONFIG = {
  minFare: 20,
  maxFare: 900,
  averageSpeedPxPerSecond: 190,
  driverSearchTimeoutMs: 90000,
  pickupTimeoutMs: 90000,
  /** Time the driver waits after reaching the exact operational pickup curb. */
  passengerPickupWaitMs: 120_000,
  waitingForPassengerTimeoutMs: 120_000,
  turquoise: 0x13c8bc,
  marker: 0x13c8bc,
  /** Maximum walking distance from the request pose to a legal pickup curb. */
  preferredPickupDisplacementPx: 48,
  maximumPickupDisplacementPx: 88,
  pickupCandidateDistanceEpsilonPx: 3,
  pickupLaneSearchRadiusPx: 112,
  pickupIntersectionClearancePx: 32,
  boardingApproachSearchRadiusPx: 24,
  boardingDoorOutsidePx: 5,
  snappBoardingReachPx: 56,
  pickupArrivalWorldTolerancePx: 30,
  pickupArrivalLaneTolerancePx: 28,
  pickupArrivalHeadingToleranceRadians: 0.35,
  pickupStoppedSpeedPxPerSecond: 3.5,
  /** Pickup marker/route snapshots are refreshed at this cadence. */
  trackingUpdateMs: 200,
  /** Bounded diagnostics window after passenger entry; no unbounded logging. */
  postBoardingDiagnosticWindowMs: 5000,
} as const;

/** Shared curb-service tuning; deliberately small enough to reject adjacent lanes. */
export const BUS_STOPPING_CONFIG = {
  stoppingRadius: 28,
  approachDistance: 260,
  alignmentDistance: 76,
  headingToleranceRadians: 0.42,
  recoveryDelayMs: 1400,
  maxRecoveryAttempts: 3,
} as const;

const stop = (id: string, label: string, ...landmarkIds: string[]) => ({
  id,
  label,
  landmarkIds,
});

/**
 * Public transport is authored per city. Route anchors are landmark ids instead
 * of arbitrary coordinates, then bind to the closest valid generated stop.
 */
export const CITY_TRANSIT_CONFIG: Record<CityId, CityTransitConfig> = {
  tehran: {
    cityId: 'tehran',
    busRoutes: [
      {
        id: 'T1',
        name: 'T1 Airport - Government - Central Station',
        color: 0x38bdf8,
        anchors: [
          stop('airport', 'Airport', 'tehran-airport'),
          stop('government', 'Government Complex', 'tehran-government'),
          stop('financial', 'Financial Towers', 'tehran-financial'),
          stop('station', 'Central Station', 'tehran-station'),
        ],
        vehicles: 1,
        stopDurationMs: 5000,
        passengerCapacity: 5,
        active: true,
      },
      {
        id: 'T2',
        name: 'T2 University - Old Town - River - Stadium',
        color: 0xf59e0b,
        anchors: [
          stop('university', 'University District', 'tehran-university'),
          stop('old-town', 'Old Town Metro', 'tehran-metro-old-town'),
          stop('river', 'Capital River Park', 'tehran-river-park'),
          stop('stadium', 'Azadi Stadium', 'tehran-stadium'),
        ],
        vehicles: 1,
        stopDurationMs: 5000,
        passengerCapacity: 5,
        active: true,
      },
      {
        id: 'T3',
        name: 'T3 Station - River - Logistics - Airport',
        color: 0x34d399,
        anchors: [
          stop('station', 'Central Station', 'tehran-station'),
          stop('river', 'Capital River Park', 'tehran-river-park'),
          stop('logistics', 'South Logistics', 'tehran-logistics'),
          stop('airport', 'Airport', 'tehran-airport'),
        ],
        vehicles: 1,
        stopDurationMs: 5000,
        passengerCapacity: 5,
        active: true,
      },
      {
        id: 'T4',
        name: 'T4 Government - Financial - Tower - Stadium',
        color: 0xf472b6,
        anchors: [
          stop('government', 'Government Complex', 'tehran-government'),
          stop('financial', 'Financial Towers', 'tehran-financial'),
          stop('tower', 'Milad TV Tower', 'tehran-tv-tower'),
          stop('stadium', 'Azadi Stadium', 'tehran-stadium'),
        ],
        vehicles: 1,
        stopDurationMs: 5000,
        passengerCapacity: 5,
        active: true,
      },
    ],
    taxi: {
      population: 9,
      encounterRadius: 720,
      guaranteedNearby: 1,
      standDurationMs: 30000,
      baseFare: 20,
      perKilometerFare: 11,
      trafficFareFactor: 0.18,
      waitingFarePerMinute: 3,
      serviceLandmarkIds: [
        'tehran-airport',
        'tehran-government',
        'tehran-financial',
        'tehran-station',
        'tehran-university',
        'tehran-stadium',
        'tehran-shopping',
      ],
    },
  },
  yazd: {
    cityId: 'yazd',
    busRoutes: [
      {
        id: 'Y1',
        name: 'Y1 Heritage Loop',
        color: 0xfbbf24,
        anchors: [
          stop('mosque', 'Sun Courtyard Mosque', 'yazd-mosque'),
          stop('bazaar', 'Covered Bazaar', 'yazd-bazaar'),
          stop('fort', 'Historic Fortress', 'yazd-fort'),
          stop('windcatchers', 'Windcatcher District', 'yazd-windcatchers'),
        ],
        vehicles: 1,
        stopDurationMs: 5200,
        passengerCapacity: 5,
        active: true,
      },
      {
        id: 'Y2',
        name: 'Y2 Caravanserai - Bazaar - Airfield',
        color: 0xfb7185,
        anchors: [
          stop('caravanserai', 'Ancient Caravanserai', 'yazd-caravanserai'),
          stop('bazaar', 'Covered Bazaar', 'yazd-bazaar'),
          stop('airfield', 'Desert Airport', 'yazd-airfield'),
          stop('mine', 'Salt Ridge Mining Works', 'yazd-mine'),
        ],
        vehicles: 1,
        stopDurationMs: 5200,
        passengerCapacity: 5,
        active: true,
      },
    ],
    taxi: {
      population: 3,
      encounterRadius: 640,
      guaranteedNearby: 1,
      standDurationMs: 30000,
      baseFare: 14,
      perKilometerFare: 8,
      trafficFareFactor: 0.07,
      waitingFarePerMinute: 2,
      serviceLandmarkIds: [
        'yazd-mosque',
        'yazd-bazaar',
        'yazd-fort',
        'yazd-windcatchers',
        'yazd-airfield',
        'yazd-caravanserai',
      ],
    },
  },
  gilan: {
    cityId: 'gilan',
    busRoutes: [
      {
        id: 'G1',
        name: 'G1 Coastal Harbor Loop',
        color: 0x2dd4bf,
        anchors: [
          stop('harbor', 'Fishing Harbor', 'gilan-harbor'),
          stop('marina', 'Caspian Marina', 'gilan-marina'),
          stop('port', 'Caspian Commercial Port', 'gilan-port'),
          stop('bridge', 'Sefid Wooden Bridge', 'gilan-wooden-bridge'),
        ],
        vehicles: 1,
        stopDurationMs: 5400,
        passengerCapacity: 5,
        active: true,
      },
      {
        id: 'G2',
        name: 'G2 Harbor - Rice Fields - Tea Hills',
        color: 0x84cc16,
        anchors: [
          stop('harbor', 'Fishing Harbor', 'gilan-harbor'),
          stop('rice', 'Sefid Rice Fields', 'gilan-rice'),
          stop('tea', 'Lahijan Tea Hills', 'gilan-tea'),
          stop('park', 'Hyrcanian National Forest', 'gilan-national-park'),
        ],
        vehicles: 1,
        stopDurationMs: 5400,
        passengerCapacity: 5,
        active: true,
      },
    ],
    taxi: {
      population: 4,
      encounterRadius: 640,
      guaranteedNearby: 1,
      standDurationMs: 30000,
      baseFare: 16,
      perKilometerFare: 9,
      trafficFareFactor: 0.1,
      waitingFarePerMinute: 2,
      serviceLandmarkIds: [
        'gilan-harbor',
        'gilan-marina',
        'gilan-cabins',
        'gilan-port',
        'gilan-rice',
        'gilan-tea',
        'gilan-national-park',
        'gilan-wooden-bridge',
      ],
    },
  },
};

/** Calculate an up-front fare from a legal road-route distance, never a straight line. */
export function calculateTaxiFare(
  config: TaxiConfig,
  route: TrafficRoutePreview,
  trafficDensity = 0,
  waitingMinutes = 0,
): TaxiFareQuote {
  const distanceKm = route.distancePx / TRANSIT_PIXELS_PER_KILOMETER;
  const trafficFactor = 1 + Math.max(0, trafficDensity) * config.trafficFareFactor;
  const distanceCost = Math.ceil(distanceKm * config.perKilometerFare * trafficFactor);
  const waitingCost = Math.ceil(Math.max(0, waitingMinutes) * config.waitingFarePerMinute);
  return {
    baseFare: config.baseFare,
    distanceKm,
    distanceCost,
    trafficFactor,
    waitingCost,
    total: config.baseFare + distanceCost + waitingCost,
    route,
  };
}

/** Route-based Snapp quote with deterministic duration and safety cap. */
export function calculateSnappFare(
  config: TaxiConfig,
  route: TrafficRoutePreview,
  pickup: Vector2,
  destination: TaxiDestination,
  trafficDensity = 0,
  now = 0,
  pickupAnchor: Vector2 = route.start,
  pickupAnchorLabel = 'Nearest legal curb',
  dropoffPosition: Vector2 = route.end,
): import('./SnappTypes').SnappQuote {
  const base = calculateTaxiFare(config, route, trafficDensity);
  const total = Math.min(SNAPP_CONFIG.maxFare, Math.max(SNAPP_CONFIG.minFare, base.total));
  return {
    ...base,
    total,
    pickup: { ...pickup },
    pickupAnchor: { ...pickupAnchor },
    pickupWalkingDistancePx: Math.hypot(pickup.x - pickupAnchor.x, pickup.y - pickupAnchor.y),
    pickupAnchorLabel,
    destination: { ...destination, position: { ...destination.position } },
    dropoffPosition: { ...dropoffPosition },
    dropoffSnapDistancePx: Math.hypot(destination.position.x - dropoffPosition.x, destination.position.y - dropoffPosition.y),
    estimatedDurationMinutes: Math.max(1, Math.ceil(route.distancePx / SNAPP_CONFIG.averageSpeedPxPerSecond / 60)),
    quoteVersion: 1,
    createdAt: now,
  };
}
