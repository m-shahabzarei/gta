import type { Json, Vector2 } from '@/core/types';
import type { TaxiDestination, TaxiFareQuote } from './TransitTypes';
import type { CityId } from '@/gameplay/types';

/** Valid high-level states for one Snapp booking. */
export const SNAPP_BOOKING_STATES = [
  'IDLE',
  'SELECTING_DESTINATION',
  'QUOTE_READY',
  'PAYMENT_PENDING',
  'DRIVER_EN_ROUTE',
  'DRIVER_ARRIVED',
  'RIDING',
  'ARRIVED',
  'COMPLETED',
  'CANCELLED',
  'FAILED',
  'REFUNDED',
] as const;

export type SnappBookingState = (typeof SNAPP_BOOKING_STATES)[number];
export type SnappPaymentState = 'unpaid' | 'paid' | 'refunded';

export interface SnappQuote extends TaxiFareQuote {
  pickup: Vector2;
  destination: TaxiDestination;
  estimatedDurationMinutes: number;
  quoteVersion: number;
  createdAt: number;
}

export interface SnappBookingSnapshot {
  version: 1;
  id: string;
  transactionId: string;
  state: SnappBookingState;
  cityId: CityId;
  pickup: Vector2;
  destination: TaxiDestination | null;
  quote: SnappQuote | null;
  payment: SnappPaymentState;
  assignedVehicleId: number | null;
  createdAt: number;
  error: string | null;
}

export type SnappPaymentResult =
  | 'paid'
  | 'insufficient-funds'
  | 'invalid-quote'
  | 'already-paid'
  | 'active-booking';

export type SnappBookingResult =
  | 'started'
  | 'invalid'
  | 'unavailable'
  | 'already-active'
  | 'cancelled'
  | 'refunded';

/** Narrow JSON guard used when restoring a saved booking. */
export function isSnappBookingSnapshot(value: Json): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as { [key: string]: Json };
  const isVector = (candidate: Json | undefined): boolean =>
    typeof candidate === 'object' &&
    candidate !== null &&
    !Array.isArray(candidate) &&
    typeof candidate['x'] === 'number' &&
    Number.isFinite(candidate['x']) &&
    typeof candidate['y'] === 'number' &&
    Number.isFinite(candidate['y']);
  const isCity = (candidate: Json | undefined): boolean =>
    candidate === 'tehran' || candidate === 'yazd' || candidate === 'gilan';
  const isDestination = (candidate: Json | undefined): boolean => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return false;
    return (
      typeof candidate['id'] === 'string' &&
      typeof candidate['label'] === 'string' &&
      isVector(candidate['position']) &&
      isCity(candidate['cityId']) &&
      (candidate['source'] === 'landmark' || candidate['source'] === 'bus-stop' || candidate['source'] === 'map')
    );
  };
  const isRoute = (candidate: Json | undefined): boolean => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return false;
    const laneIds = candidate['laneIds'];
    return (
      Array.isArray(laneIds) &&
      laneIds.every((laneId) => typeof laneId === 'string') &&
      typeof candidate['distancePx'] === 'number' &&
      Number.isFinite(candidate['distancePx']) &&
      isVector(candidate['start']) &&
      isVector(candidate['end'])
    );
  };
  const quote = record['quote'];
  const isQuote = (): boolean => {
    if (quote === null) return true;
    if (typeof quote !== 'object' || Array.isArray(quote)) return false;
    return (
      typeof quote['baseFare'] === 'number' &&
      Number.isFinite(quote['baseFare']) &&
      typeof quote['distanceKm'] === 'number' &&
      Number.isFinite(quote['distanceKm']) &&
      typeof quote['distanceCost'] === 'number' &&
      Number.isFinite(quote['distanceCost']) &&
      typeof quote['trafficFactor'] === 'number' &&
      Number.isFinite(quote['trafficFactor']) &&
      typeof quote['waitingCost'] === 'number' &&
      Number.isFinite(quote['waitingCost']) &&
      typeof quote['total'] === 'number' &&
      Number.isFinite(quote['total']) &&
      isRoute(quote['route']) &&
      isVector(quote['pickup']) &&
      isDestination(quote['destination']) &&
      typeof quote['estimatedDurationMinutes'] === 'number' &&
      Number.isFinite(quote['estimatedDurationMinutes']) &&
      typeof quote['quoteVersion'] === 'number' &&
      Number.isFinite(quote['quoteVersion']) &&
      typeof quote['createdAt'] === 'number' &&
      Number.isFinite(quote['createdAt'])
    );
  };
  const assignedVehicleId = record['assignedVehicleId'];
  const state = record['state'];
  const payment = record['payment'];
  return (
    record['version'] === 1 &&
    typeof record['id'] === 'string' &&
    record['id'].length > 0 &&
    typeof record['transactionId'] === 'string' &&
    record['transactionId'].length > 0 &&
    typeof state === 'string' &&
    (SNAPP_BOOKING_STATES as readonly string[]).includes(state) &&
    isCity(record['cityId']) &&
    isVector(record['pickup']) &&
    (record['destination'] === null || isDestination(record['destination'])) &&
    isQuote() &&
    (payment === 'unpaid' || payment === 'paid' || payment === 'refunded') &&
    (assignedVehicleId === null || (typeof assignedVehicleId === 'number' && Number.isInteger(assignedVehicleId))) &&
    typeof record['createdAt'] === 'number' &&
    Number.isFinite(record['createdAt']) &&
    (record['error'] === null || typeof record['error'] === 'string')
  );
}
