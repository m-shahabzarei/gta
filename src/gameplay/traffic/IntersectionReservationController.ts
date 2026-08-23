import { sampleSpline } from './SplineMath';
import type { TrafficNetwork } from './TrafficNetwork';

export type TrafficSignalPhase =
  | 'north-south-green'
  | 'north-south-yellow'
  | 'all-red-to-east-west'
  | 'east-west-green'
  | 'east-west-yellow'
  | 'all-red-to-north-south';

export interface ReservationRequest {
  readonly vehicleId: number;
  readonly intersectionId: number;
  readonly connectorLaneId: string;
  readonly incomingLaneId: string;
  readonly outgoingLaneId: string;
  readonly distanceToStopLine: number;
  readonly arrivalAt: number;
  readonly priority: number;
  readonly emergency: boolean;
  readonly recoveryAttempt: number;
  /** A vehicle already queued ahead on this physical approach blocks admission. */
  readonly approachClear: boolean;
  readonly downstreamClear: boolean;
}

interface QueuedRequest extends ReservationRequest {
  readonly queuedAt: number;
  lastSeenAt: number;
}

export interface IntersectionReservation {
  readonly id: string;
  readonly vehicleId: number;
  readonly intersectionId: number;
  readonly connectorLaneId: string;
  readonly incomingLaneId: string;
  readonly outgoingLaneId: string;
  readonly grantedAt: number;
  readonly expiresAt: number;
  entered: boolean;
}

export interface ReservationDecision {
  readonly granted: boolean;
  readonly reservation: IntersectionReservation | null;
  readonly queuePosition: number;
  readonly reason:
    | 'signal'
    | 'conflict'
    | 'approach-blocked'
    | 'exit-blocked'
    | 'queue'
    | 'granted';
}

export interface IntersectionStats {
  readonly granted: number;
  readonly denied: number;
  readonly active: number;
  readonly queued: number;
}

const NORTH_SOUTH_GREEN_MS = 5200;
const EAST_WEST_GREEN_MS = 5200;
const YELLOW_MS = 900;
const ALL_RED_MS = 650;
const CYCLE_MS = NORTH_SOUTH_GREEN_MS + EAST_WEST_GREEN_MS + YELLOW_MS * 2 + ALL_RED_MS * 2;
const QUEUE_STALE_MS = 700;
const RESERVATION_TIMEOUT_MS = 4200;
/**
 * Static priority expresses how quickly a vehicle should normally move, but
 * cannot be allowed to create an endless stream that starves an already
 * waiting compatible movement. One priority tier is earned per interval and
 * is capped so emergency and recovery policies keep their intended bounds.
 */
const QUEUE_PRIORITY_AGE_INTERVAL_MS = 900;
const MAX_QUEUE_PRIORITY_AGE_BONUS = 4;

/**
 * Centralized, spatial intersection controller. Drivers queue before the stop
 * line; only compatible connectors with clear downstream space are released.
 */
export class IntersectionReservationController {
  private readonly queuedByIntersection = new Map<number, Map<number, QueuedRequest>>();
  private readonly reservationsByIntersection = new Map<number, IntersectionReservation[]>();
  private readonly reservationByVehicle = new Map<number, IntersectionReservation>();
  private serial = 0;
  private nowValue = 0;
  private grantedValue = 0;
  private deniedValue = 0;

  constructor(private readonly network: TrafficNetwork) {}

  public get phase(): TrafficSignalPhase {
    return this.phaseFor(0, this.nowValue);
  }

  public get northSouthGreen(): boolean {
    const phase = this.phase;
    return phase === 'north-south-green' || phase === 'north-south-yellow';
  }

  public get stats(): IntersectionStats {
    let queued = 0;
    for (const queue of this.queuedByIntersection.values()) queued += queue.size;
    return {
      granted: this.grantedValue,
      denied: this.deniedValue,
      active: this.reservationByVehicle.size,
      queued,
    };
  }

  public beginFrame(now: number): void {
    this.nowValue = now;
    for (const [vehicleId, reservation] of this.reservationByVehicle) {
      if (reservation.expiresAt < now) this.releaseVehicle(vehicleId);
    }
    for (const [intersectionId, queue] of this.queuedByIntersection) {
      for (const [vehicleId, request] of queue) {
        if (now - request.lastSeenAt > QUEUE_STALE_MS) queue.delete(vehicleId);
      }
      if (queue.size === 0) this.queuedByIntersection.delete(intersectionId);
    }
  }

  public request(now: number, request: ReservationRequest): ReservationDecision {
    const existing = this.reservationByVehicle.get(request.vehicleId);
    if (existing?.connectorLaneId === request.connectorLaneId && request.approachClear) {
      return { granted: true, reservation: existing, queuePosition: 0, reason: 'granted' };
    }
    if (existing) this.releaseVehicle(request.vehicleId);
    const queue =
      this.queuedByIntersection.get(request.intersectionId) ?? new Map<number, QueuedRequest>();
    const prior = queue.get(request.vehicleId);
    queue.set(request.vehicleId, {
      ...request,
      queuedAt: prior?.queuedAt ?? now,
      lastSeenAt: now,
    });
    this.queuedByIntersection.set(request.intersectionId, queue);
    const ordered = this.orderedQueue(queue);
    const queuePosition =
      ordered.findIndex((candidate) => candidate.vehicleId === request.vehicleId) + 1;
    const reason = !request.downstreamClear
      ? 'exit-blocked'
      : !request.approachClear
        ? 'approach-blocked'
      : !this.signalAllows(request.intersectionId, request.incomingLaneId, now)
        ? 'signal'
        : 'queue';
    this.deniedValue += 1;
    return { granted: false, reservation: null, queuePosition, reason };
  }

  /** Resolve all queues after every vehicle has submitted its current request. */
  public resolve(now: number): void {
    for (const [intersectionId, queue] of this.queuedByIntersection) {
      const active = this.reservationsByIntersection.get(intersectionId) ?? [];
      for (const request of this.orderedQueue(queue)) {
        if (
          !request.approachClear ||
          !request.downstreamClear ||
          !this.signalAllows(intersectionId, request.incomingLaneId, now)
        ) {
          continue;
        }
        if (
          active.some((reservation) =>
            this.conflicts(request.connectorLaneId, reservation.connectorLaneId),
          )
        ) {
          continue;
        }
        const reservation: IntersectionReservation = {
          id: `reservation:${intersectionId}:${request.vehicleId}:${this.serial++}`,
          vehicleId: request.vehicleId,
          intersectionId,
          connectorLaneId: request.connectorLaneId,
          incomingLaneId: request.incomingLaneId,
          outgoingLaneId: request.outgoingLaneId,
          grantedAt: now,
          expiresAt: now + RESERVATION_TIMEOUT_MS,
          entered: false,
        };
        active.push(reservation);
        this.reservationByVehicle.set(request.vehicleId, reservation);
        queue.delete(request.vehicleId);
        this.grantedValue += 1;
      }
      if (active.length > 0) this.reservationsByIntersection.set(intersectionId, active);
      if (queue.size === 0) this.queuedByIntersection.delete(intersectionId);
    }
  }

  public hasReservation(vehicleId: number): IntersectionReservation | null {
    return this.reservationByVehicle.get(vehicleId) ?? null;
  }

  public markEntered(vehicleId: number): void {
    const reservation = this.reservationByVehicle.get(vehicleId);
    if (reservation) reservation.entered = true;
  }

  public releaseVehicle(vehicleId: number): void {
    for (const [intersectionId, queue] of this.queuedByIntersection) {
      queue.delete(vehicleId);
      if (queue.size === 0) this.queuedByIntersection.delete(intersectionId);
    }
    const reservation = this.reservationByVehicle.get(vehicleId);
    if (!reservation) return;
    this.reservationByVehicle.delete(vehicleId);
    const active = this.reservationsByIntersection.get(reservation.intersectionId);
    if (!active) return;
    const index = active.indexOf(reservation);
    if (index >= 0) active.splice(index, 1);
    if (active.length === 0) this.reservationsByIntersection.delete(reservation.intersectionId);
  }

  public signalColor(intersectionId: number, northSouth: boolean): 'green' | 'yellow' | 'red' {
    const phase = this.phaseFor(intersectionId, this.nowValue);
    if (northSouth) {
      if (phase === 'north-south-green') return 'green';
      if (phase === 'north-south-yellow') return 'yellow';
      return 'red';
    }
    if (phase === 'east-west-green') return 'green';
    if (phase === 'east-west-yellow') return 'yellow';
    return 'red';
  }

  public clear(): void {
    this.queuedByIntersection.clear();
    this.reservationsByIntersection.clear();
    this.reservationByVehicle.clear();
    this.serial = 0;
    this.nowValue = 0;
    this.grantedValue = 0;
    this.deniedValue = 0;
  }

  private orderedQueue(queue: ReadonlyMap<number, QueuedRequest>): QueuedRequest[] {
    return Array.from(queue.values()).sort((first, second) => {
      if (first.emergency !== second.emergency) return first.emergency ? -1 : 1;
      if (first.recoveryAttempt !== second.recoveryAttempt) {
        return second.recoveryAttempt - first.recoveryAttempt;
      }
      const firstPriority = this.effectivePriority(first);
      const secondPriority = this.effectivePriority(second);
      if (firstPriority !== secondPriority) return secondPriority - firstPriority;
      if (first.queuedAt !== second.queuedAt) return first.queuedAt - second.queuedAt;
      if (first.arrivalAt !== second.arrivalAt) return first.arrivalAt - second.arrivalAt;
      return first.distanceToStopLine - second.distanceToStopLine;
    });
  }

  private effectivePriority(request: QueuedRequest): number {
    const waitedMs = Math.max(0, this.nowValue - request.queuedAt);
    const ageBonus = Math.min(
      MAX_QUEUE_PRIORITY_AGE_BONUS,
      Math.floor(waitedMs / QUEUE_PRIORITY_AGE_INTERVAL_MS),
    );
    return request.priority + ageBonus;
  }

  private conflicts(candidateId: string, activeId: string): boolean {
    if (candidateId === activeId) return true;
    const candidate = this.network.lane(candidateId);
    return candidate?.conflictLaneIds.includes(activeId) ?? true;
  }

  private signalAllows(intersectionId: number, incomingLaneId: string, now: number): boolean {
    const junction = this.network.junction(intersectionId);
    if (!junction || junction.control !== 'signal') return true;
    const incoming = this.network.lane(incomingLaneId);
    if (!incoming) return false;
    const heading = sampleSpline(incoming.spline, incoming.spline.length).heading;
    const northSouth = Math.abs(Math.sin(heading)) >= Math.abs(Math.cos(heading));
    const phase = this.phaseFor(intersectionId, now);
    return northSouth ? phase === 'north-south-green' : phase === 'east-west-green';
  }

  private phaseFor(intersectionId: number, now: number): TrafficSignalPhase {
    const offset = Math.abs((intersectionId * 2654435761) % CYCLE_MS);
    let elapsed = (now + offset) % CYCLE_MS;
    if (elapsed < NORTH_SOUTH_GREEN_MS) return 'north-south-green';
    elapsed -= NORTH_SOUTH_GREEN_MS;
    if (elapsed < YELLOW_MS) return 'north-south-yellow';
    elapsed -= YELLOW_MS;
    if (elapsed < ALL_RED_MS) return 'all-red-to-east-west';
    elapsed -= ALL_RED_MS;
    if (elapsed < EAST_WEST_GREEN_MS) return 'east-west-green';
    elapsed -= EAST_WEST_GREEN_MS;
    if (elapsed < YELLOW_MS) return 'east-west-yellow';
    return 'all-red-to-north-south';
  }
}
