/**
 * Narrow service interfaces used to decouple entities/components from the
 * concrete gameplay systems.
 *
 * Components resolve these through the {@link ServiceLocator} and depend only on
 * the interface — never on the system class — so the entity/component layer
 * compiles and reasons independently of the systems that implement them.
 */
import type { Vector2 } from '@/core/types';
import type { PoliceDirective, WantedPhase } from './CrimeTypes';
import { ServiceLocator } from '@/core/ServiceLocator';
import { ServiceKeys } from '@/config/ServiceKeys';
import type { DamageAttribution, Faction } from './CombatTypes';
import type { WeaponId } from './WeaponTypes';
import type { WantedReductionResult } from './HousingPhase2Types';
import type {
  BenchSite,
  BusStopSite,
  CrossingInfo,
  SafePedestrianPlacementOptions,
} from './WorldTypes';
import type { NavAgentProfile, NavPathCallback, NeighbourInfo } from './NavigationTypes';

/** A request to fire a weapon, passed to the combat service. */
export interface WeaponFireRequest {
  /** Entity id of the shooter (so its own bullets never hit it). */
  shooterId: number;
  /** Shooter allegiance. */
  faction: Faction;
  /** Whether the shot ultimately came from the player. */
  fromPlayer: boolean;
  /** Full ownership chain attached to direct hits and spawned projectiles. */
  attribution: DamageAttribution;
  /** Which weapon is firing. */
  weaponId: WeaponId;
  /** Muzzle origin. */
  originX: number;
  originY: number;
  /** Aim angle in radians (0 = +x / east). */
  angle: number;
  /** Extra accuracy-bloom spread (degrees) accumulated by rapid fire. */
  extraSpreadDeg?: number;
}

/** Combat operations available to weapons/vehicles (implemented by CombatSystem). */
export interface ICombatService {
  /** Fire a weapon: spawns bullet(s) or resolves a melee hit and effects. */
  fireWeapon(request: WeaponFireRequest): void;
  /** Spawn an explosion that damages everything in radius. */
  spawnExplosion(
    x: number,
    y: number,
    radius: number,
    damage: number,
    fromPlayer: boolean,
    attribution?: DamageAttribution,
  ): void;
  /** Ignite a burning patch that damages anything standing in it. */
  spawnFireZone(
    x: number,
    y: number,
    radius: number,
    fromPlayer: boolean,
    attribution?: DamageAttribution,
  ): void;
}

/** Read-only world queries used by AI (implemented by WorldManager). */
export interface IWorldQuery {
  /** Whether the given world position is inside a solid tile. */
  isSolidAtWorld(x: number, y: number): boolean;
  /** Whether a complete pedestrian circle fits at this world position without touching solidity. */
  isPedestrianClearAtWorld(x: number, y: number, radius: number): boolean;
  /** Whether a complete pedestrian circle can sweep between two points without touching solidity. */
  isPedestrianSegmentClear(from: Vector2, to: Vector2, radius: number): boolean;
  /** Preserve a clear point or deterministically find its nearest clear replacement. */
  resolveSafePedestrianPosition(
    requested: Vector2,
    radius: number,
    options?: SafePedestrianPlacementOptions,
  ): Vector2 | null;
  /** Whether the given world position is inside an opaque tile. */
  blocksVisionAtWorld(x: number, y: number): boolean;
  /** Whether the given world position is on a drivable road tile. */
  isDrivableAtWorld(x: number, y: number): boolean;
  /** A random world position that lies on a sidewalk. */
  randomSidewalkPoint(): Vector2;
  /** A random world position that lies on a road. */
  randomRoadPoint(): Vector2;
  /** A random road point within `maxDist` px of `(x, y)`, or null if none is found nearby. */
  randomRoadPointNear?(x: number, y: number, maxDist: number): Vector2 | null;
  /** World pixel dimensions. */
  readonly widthPx: number;
  readonly heightPx: number;

  /** Whether pedestrians may occupy this world position (see {@link PEDESTRIAN_BLOCKED_TILE_TYPES}). */
  isPedestrianWalkableAtWorld(x: number, y: number): boolean;
  /** Relative pathing cost for a pedestrian crossing this tile (1 = preferred, higher = avoided when a cheaper route exists). */
  pedestrianTileCost(x: number, y: number): number;
  /** A random sidewalk point within `maxDist` px of `(x, y)`, or null if none is found nearby. */
  randomSidewalkPointNear(x: number, y: number, maxDist: number): Vector2 | null;
  /** The nearest road crossing within `maxDist` px of `(x, y)`, or null. */
  nearestCrossing(x: number, y: number, maxDist: number): CrossingInfo | null;
  /** The nearest unoccupied bench within `maxDist` px of `(x, y)`, or null. */
  nearestFreeBench(x: number, y: number, maxDist: number): BenchSite | null;
  /** Claim `bench` for `entityId`. Returns false if it's already occupied by someone else. */
  claimBench(bench: BenchSite, entityId: number): boolean;
  /** Release `bench` if it's currently held by `entityId` (no-op otherwise). */
  releaseBench(bench: BenchSite, entityId: number): void;
  /** The nearest stop with an available pedestrian waiting slot within range. */
  nearestFreeBusStop(x: number, y: number, maxDist: number): BusStopSite | null;
  /** Claim one bounded waiting slot. Returns false only when every slot is taken. */
  claimBusStop(busStop: BusStopSite, entityId: number): boolean;
  /** Release a waiting slot if held by `entityId` (no-op otherwise). */
  releaseBusStop(busStop: BusStopSite, entityId: number): void;
  /** Resolve the assigned waiting position for a claimed passenger. */
  busStopWaitingPosition(busStop: BusStopSite, entityId: number): Vector2;
}

/** Read-only view of the player used by AI (implemented by PlayerController). */
export interface IPlayerRef {
  /** Current player position, or null if no player is alive/spawned. */
  readonly playerPosition: Vector2 | null;
  /** Whether the player is currently driving. */
  readonly playerInVehicle: boolean;
  /** Whether the player is alive. */
  readonly playerAlive: boolean;
}

/** Wanted-level operations used by police AI (implemented by WantedSystem). */
export interface IWantedService {
  /** Current police-awareness level (0..5). */
  readonly level: number;
  readonly isSearching: boolean;
  /** Current wanted lifecycle phase, exposed for policy adapters. */
  readonly phase: WantedPhase;
  directiveForOfficer(officerId: number): PoliceDirective;
  reportOfficerSighting(officerId: number, position: Vector2): void;
  /** Arrest the player: clears wanted and triggers the bust flow. */
  bustPlayer(): void;
  /** Request a policy-controlled, time-based safehouse heat reduction. */
  requestSafehouseReduction(durationSeconds: number): WantedReductionResult;
}

/** Read-only traffic-light phase query used by pedestrian crosswalk gating (implemented by TrafficSystem). */
export interface ITrafficQuery {
  /** True while the north-south axis currently holds green (one phase, shared citywide). */
  readonly northSouthGreen: boolean;
}

/**
 * Pathfinding and local-avoidance operations used by AI (implemented by
 * NavigationSystem). Requests are queued and budgeted per frame rather than
 * resolved synchronously — see {@link NavigationSystem} for the request
 * queue's design.
 */
export interface INavigationService {
  /**
   * Queue a path request; `onResult` fires once it's processed (possibly
   * several frames later under load).
   * @param priority Lower runs first when the per-frame budget is contended (0 = most urgent).
   * @returns An id that can be passed to {@link cancelRequest}.
   */
  requestPath(
    from: Vector2,
    to: Vector2,
    profile: NavAgentProfile,
    onResult: NavPathCallback,
    priority?: number,
  ): number;
  /** Cancel a previously queued request; safe to call after it already resolved. */
  cancelRequest(requestId: number): void;
  /** Instant (unqueued) straight-line walkability check between two points. */
  isClearLine(from: Vector2, to: Vector2, profile: NavAgentProfile): boolean;
  /** Instant optical line-of-sight check, independent of movement rules. */
  hasLineOfSight(from: Vector2, to: Vector2): boolean;
  /** Nearby dynamic agents (peds/police/vehicles) for local avoidance/separation steering. */
  queryNearby(x: number, y: number, radius: number, excludeId?: number): NeighbourInfo[];
}

/**
 * Convenience resolvers that hide the (safe) cast from the generic
 * {@link ServiceLocator} to these narrow gameplay interfaces. Return `null`
 * when the implementing system has not been registered yet.
 */
export function getCombatService(): ICombatService | null {
  return (
    (ServiceLocator.tryResolve(ServiceKeys.Combat) as unknown as ICombatService | null) ?? null
  );
}

export function getWorldQuery(): IWorldQuery | null {
  return (ServiceLocator.tryResolve(ServiceKeys.World) as unknown as IWorldQuery | null) ?? null;
}

export function getPlayerRef(): IPlayerRef | null {
  return (ServiceLocator.tryResolve(ServiceKeys.Player) as unknown as IPlayerRef | null) ?? null;
}

export function getWantedService(): IWantedService | null {
  return (
    (ServiceLocator.tryResolve(ServiceKeys.Wanted) as unknown as IWantedService | null) ?? null
  );
}

export function getTrafficQuery(): ITrafficQuery | null {
  return (
    (ServiceLocator.tryResolve(ServiceKeys.Traffic) as unknown as ITrafficQuery | null) ?? null
  );
}

export function getNavigationService(): INavigationService | null {
  return (
    (ServiceLocator.tryResolve(ServiceKeys.Navigation) as unknown as INavigationService | null) ??
    null
  );
}
