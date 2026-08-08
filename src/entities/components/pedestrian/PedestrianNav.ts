/**
 * Reusable "travel to a destination" routine for pedestrian AI states.
 *
 * Wraps a queued {@link INavigationService} path request, follows the
 * resolved waypoints with a seek + separation + short-range obstacle-avoidance
 * steering blend, holds at the curb for an unsafe crosswalk, and repaths once
 * on getting stuck before giving up gracefully. Every travel-based pedestrian
 * state (wander, enter-building, flee, help-injured, walking to a bench)
 * drives itself through one instance of this class rather than duplicating
 * path-follow logic per state.
 */
import type { Vector2 } from '@/core/types';
import type { CrossingInfo, INavigationService, ITrafficQuery, IWorldQuery } from '@/gameplay/types';
import { avoidAhead, blend, seek, separation, smoothDirection, StuckDetector } from '@/utils';

/** Outcome of one {@link PedestrianNav.tick} call. */
export type PedestrianNavStatus = 'idle' | 'pending' | 'holding' | 'travelling' | 'arrived' | 'failed';

export interface PedestrianNavTickResult {
  status: PedestrianNavStatus;
  /** Desired normalized move direction this frame, or null when not moving. */
  moveDir: Vector2 | null;
}

/** Distance (px) at which the final waypoint counts as reached, by default. */
const DEFAULT_ARRIVE_RADIUS_PX = 12;

/** Looser arrival tolerance for intermediate waypoints, so corners flow smoothly. */
const INTERMEDIATE_ARRIVE_RADIUS_PX = 18;

/** Radius (px) around a position within which a crossing gates movement. */
const CROSSING_HOLD_RADIUS_PX = 26;

/** Desired separation (px) from other nearby dynamic agents. */
const SEPARATION_RADIUS_PX = 26;

/** Lookahead (px) for the short-range obstacle-avoidance probe. */
const AVOID_LOOKAHEAD_PX = 22;

/** Turn-rate cap (radians/sec) applied when blending steering output frame to frame. */
const TURN_RATE_PER_SEC = 4.6;

/** Consecutive stuck reports tolerated before a destination is abandoned. */
const MAX_STUCK_REPATHS = 2;

export class PedestrianNav {
  private destination: Vector2 | null = null;
  private waypoints: Vector2[] = [];
  private waypointIndex = 0;
  private awaitingPath = false;
  private requestId: number | null = null;
  private stuckAttempts = 0;
  private readonly stuckDetector = new StuckDetector();
  private lastMoveDir: Vector2 = { x: 0, y: 0 };
  /** Whether the current `waypoints` actually reach `destination`, or are a truncated best-effort path. */
  private pathComplete = false;

  constructor(private readonly entityId: number) {}

  /** The active destination, or null when idle/arrived/failed. */
  public get currentDestination(): Vector2 | null {
    return this.destination;
  }

  /** Whether a destination is currently set (travelling, holding or awaiting a path). */
  public get hasDestination(): boolean {
    return this.destination !== null;
  }

  /** Current resolved waypoint list, for debug visualisation only. */
  public get debugWaypoints(): readonly Vector2[] {
    return this.waypoints;
  }

  /** Begin travelling from `from` to `to`, queuing a fresh path request. */
  public beginTravel(
    from: Vector2,
    to: Vector2,
    navService: INavigationService | null,
    priority = 10,
  ): void {
    this.destination = { x: to.x, y: to.y };
    this.stuckAttempts = 0;
    this.stuckDetector.reset();
    this.issueRequest(from, to, navService, priority);
  }

  /**
   * Repath toward the *existing* destination after a stuck report, without
   * resetting {@link stuckAttempts} — a second stuck event against the same
   * destination must still count toward giving up, or a pedestrian wedged
   * against unreachable geometry would repath forever instead of abandoning.
   */
  private repathInPlace(
    from: Vector2,
    to: Vector2,
    navService: INavigationService | null,
    priority: number,
  ): void {
    this.stuckDetector.reset();
    this.issueRequest(from, to, navService, priority);
  }

  /** Cancel any in-flight request and queue a fresh one, resolving into `waypoints`. */
  private issueRequest(
    from: Vector2,
    to: Vector2,
    navService: INavigationService | null,
    priority: number,
  ): void {
    this.cancelActiveRequest(navService);
    this.waypoints = [];
    this.waypointIndex = 0;
    this.lastMoveDir = { x: 0, y: 0 };
    this.awaitingPath = true;

    if (!navService) {
      this.awaitingPath = false;
      return;
    }
    this.requestId = navService.requestPath(
      from,
      to,
      'pedestrian',
      (result) => {
        this.awaitingPath = false;
        this.requestId = null;
        this.waypoints = result.waypoints ?? [];
        this.waypointIndex = 0;
        this.pathComplete = result.complete;
      },
      priority,
    );
  }

  /** Abandon the current destination/path, cancelling any in-flight request. */
  public cancel(navService: INavigationService | null): void {
    this.cancelActiveRequest(navService);
    this.destination = null;
    this.waypoints = [];
    this.waypointIndex = 0;
    this.awaitingPath = false;
    this.pathComplete = false;
  }

  /**
   * Advance travel by one frame: gates on an unsafe crossing, advances through
   * reached waypoints, repaths once on getting stuck, and otherwise returns a
   * steered move direction blending seek + separation + short-range avoidance.
   */
  public tick(
    pos: Vector2,
    facingRad: number,
    deltaMs: number,
    world: IWorldQuery | null,
    traffic: ITrafficQuery | null,
    navService: INavigationService | null,
    arriveRadiusPx = DEFAULT_ARRIVE_RADIUS_PX,
  ): PedestrianNavTickResult {
    if (!this.destination) return { status: 'idle', moveDir: null };
    if (this.awaitingPath) return { status: 'pending', moveDir: null };
    if (this.waypoints.length === 0) {
      this.destination = null;
      return { status: 'failed', moveDir: null };
    }

    if (world) {
      const crossing = world.nearestCrossing(pos.x, pos.y, CROSSING_HOLD_RADIUS_PX);
      if (crossing && !isSafeToCross(crossing, traffic)) {
        return { status: 'holding', moveDir: null };
      }
    }

    // Advance through any waypoints already reached (may reach the end).
    for (;;) {
      const target = this.waypoints[this.waypointIndex];
      if (!target) {
        this.destination = null;
        this.waypoints = [];
        return { status: 'failed', moveDir: null };
      }
      const isLast = this.waypointIndex === this.waypoints.length - 1;
      const dist = Math.hypot(target.x - pos.x, target.y - pos.y);
      if (dist > (isLast ? arriveRadiusPx : INTERMEDIATE_ARRIVE_RADIUS_PX)) break;
      if (isLast) {
        if (this.pathComplete) {
          this.destination = null;
          this.waypoints = [];
          return { status: 'arrived', moveDir: null };
        }
        // The path was truncated at the search-window edge (destination lies
        // further away than the bounded search reached) — this is progress,
        // not arrival: continue from here toward the same destination rather
        // than reporting success early.
        const destination = this.destination;
        if (!destination) {
          this.waypoints = [];
          return { status: 'failed', moveDir: null };
        }
        this.issueRequest(pos, destination, navService, 0);
        return { status: 'pending', moveDir: null };
      }
      this.waypointIndex++;
    }

    if (this.stuckDetector.update(pos, deltaMs)) {
      this.stuckAttempts++;
      const destination = this.destination;
      if (this.stuckAttempts > MAX_STUCK_REPATHS || !navService || !destination) {
        this.destination = null;
        this.waypoints = [];
        return { status: 'failed', moveDir: null };
      }
      this.repathInPlace(pos, destination, navService, 0);
      return { status: 'pending', moveDir: null };
    }

    const target = this.waypoints[this.waypointIndex];
    if (!target) {
      this.destination = null;
      return { status: 'failed', moveDir: null };
    }

    const seekVec = seek(pos, target);
    const neighbours = navService
      ? navService.queryNearby(pos.x, pos.y, SEPARATION_RADIUS_PX, this.entityId)
      : [];
    const sepVec = separation(pos, neighbours, SEPARATION_RADIUS_PX);
    const avoidVec = world
      ? avoidAhead(pos, facingRad, AVOID_LOOKAHEAD_PX, (x, y) => !world.isPedestrianWalkableAtWorld(x, y))
      : null;

    const blendInputs: Array<{ v: Vector2; weight: number }> = [
      { v: seekVec, weight: 1 },
      { v: sepVec, weight: 0.6 },
    ];
    if (avoidVec) blendInputs.push({ v: avoidVec, weight: 1.3 });

    const desired = blend(blendInputs);
    const smoothed = smoothDirection(this.lastMoveDir, desired, TURN_RATE_PER_SEC, deltaMs);
    this.lastMoveDir = smoothed;
    return { status: 'travelling', moveDir: smoothed };
  }

  private cancelActiveRequest(navService: INavigationService | null): void {
    if (this.requestId !== null) {
      navService?.cancelRequest(this.requestId);
      this.requestId = null;
    }
  }
}

/**
 * Whether a pedestrian may safely cross: crossings with no real enforcing
 * traffic light nearby (most of them — lights are thinned to a subset of
 * intersections) are always safe to cross, since no vehicle there is ever
 * told to stop for a phase anyway; only a light-backed crossing gates on the
 * current light phase for its axis.
 */
function isSafeToCross(crossing: CrossingInfo, traffic: ITrafficQuery | null): boolean {
  if (!crossing.hasLight || !traffic) return true;
  return crossing.axis === 'ew' ? traffic.northSouthGreen : !traffic.northSouthGreen;
}
