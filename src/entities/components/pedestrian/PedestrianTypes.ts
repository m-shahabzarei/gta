/**
 * Shared state, capability flags and tuning constants for the pedestrian AI
 * state machine. No behaviour lives here — see `PedestrianNav.ts`,
 * `PedestrianIdleStates.ts` and `PedestrianReactiveStates.ts` for that; this
 * file only defines the blackboard the orchestrator (`PedestrianAIComponent`)
 * builds once and passes to whichever state-handler function runs each frame.
 */
import type Phaser from 'phaser';
import type { Vector2 } from '@/core/types';
import type {
  BenchSite,
  BusStopSite,
  IDamageable,
  INavigationService,
  InteriorNpcActivity,
  ITrafficQuery,
  IWorldQuery,
} from '@/gameplay/types';
import type { CharacterMovementComponent } from '../CharacterMovementComponent';
import type { HealthComponent } from '../HealthComponent';
import type { PedestrianNav } from './PedestrianNav';

/** Discrete pedestrian behaviour states. */
export type PedState =
  | 'wander'
  | 'idle'
  | 'look-around'
  | 'sit'
  | 'wait-bus'
  | 'talk'
  | 'talk-to-nearby-npc'
  | 'enter-building'
  | 'flee'
  | 'flee-vehicle'
  | 'crime-freeze'
  | 'crime-call'
  | 'crime-point'
  | 'crime-scream'
  | 'downed'
  | 'help-injured'
  | 'brawl';

/** The minimal, safe-after-destroy surface one pedestrian's AI exposes to another for pairing. */
export interface PedestrianPeer {
  readonly entityId: number;
  /** False once the underlying component has been destroyed (despawned/detached). */
  readonly isActive: boolean;
  /** Last-known world position; safe to read even after destroy. */
  readonly position: Vector2;
}

/** Which optional behaviours a pedestrian brain supports (animals disable the social ones). */
export interface PedestrianCapabilities {
  canSit: boolean;
  canConverse: boolean;
  canWitness: boolean;
}

export const DEFAULT_CAPABILITIES: PedestrianCapabilities = {
  canSit: true,
  canConverse: true,
  canWitness: true,
};

/** Mutable state + resolved service references shared by every state handler this frame. */
export interface PedestrianAIContext {
  readonly entityId: number;
  readonly capabilities: PedestrianCapabilities;

  readonly movement: CharacterMovementComponent;
  health: HealthComponent | null;
  readonly nav: PedestrianNav;

  world: IWorldQuery | null;
  traffic: ITrafficQuery | null;
  navService: INavigationService | null;
  /** Optional anchor used by interior/service NPCs to keep ordinary wandering local. */
  homeArea: { x: number; y: number; radius: number } | null;
  /** Authored indoor work loop; when present the NPC never samples outdoor sidewalks. */
  interiorRoutine: {
    activity: InteriorNpcActivity;
    anchors: Vector2[];
    nextIndex: number;
  } | null;

  state: PedState;
  stateTimer: number;

  /** Point being fled from (state 'flee'); recomputed distance-from each tick. */
  danger: Vector2;
  /** Precomputed instantaneous dodge direction (state 'flee-vehicle'). */
  dodgeDir: Vector2;
  /** Bench currently claimed, if any (state 'sit'). */
  bench: BenchSite | null;
  /** Bus stop currently claimed, if any (state 'wait-bus'). */
  busStop: BusStopSite | null;
  /** Brawl opponent, when a street fight is running. */
  brawlTarget: IDamageable | null;
  brawlSwingMs: number;
  /** Conversation partner for 'talk-to-nearby-npc'. */
  talkPartner: PedestrianPeer | null;
  /** Target being approached for 'help-injured'. */
  helpTarget: PedestrianPeer | null;

  /** Transient chatter bubble shown during Talk/TalkToNearbyNpc. */
  bubble: Phaser.GameObjects.Text | null;

  /** Set once the ped finished a despawn-triggering action (enter-building fade-out). */
  despawnRequested: boolean;

  /** Countdown (ms) until the next reflexive vehicle-danger scan (throttled, not per-frame). */
  vehicleDangerCheckMs: number;
}

// ── Tuning ─────────────────────────────────────────────────────────────────

/** Distance (px) at which a wander/travel target counts as reached. */
export const ARRIVE_RADIUS = 12;

/** Upper bound (ms) on a single wander leg before it's abandoned. */
export const WANDER_TIMEOUT_MS = 8000;

/** How far (px) from the current position a wander target may be sampled. */
export const WANDER_LOCAL_RADIUS = 260;

/** How long (ms) a solo chatter bubble lingers. */
export const TALK_DURATION_MS = 1600;

/** How long (ms) a paired conversation lasts. */
export const TALK_PAIRED_DURATION_MS = 2400;

/** How long (ms) a look-around pause lasts. */
export const LOOK_AROUND_DURATION_MS = 1800;

/** How often (ms), while looking around, the facing sweeps to a new heading. */
export const LOOK_AROUND_SWEEP_MS = 500;

/** How long (ms) a bench sit lasts once seated. */
export const SIT_MIN_MS = 5000;
export const SIT_MAX_MS = 9000;

/** How long (ms) a pedestrian waits at a bus stop once reached. */
export const BUS_WAIT_MIN_MS = 7000;
export const BUS_WAIT_MAX_MS = 13000;

/** How long (ms) a pedestrian keeps fleeing after being alarmed. */
export const FLEE_DURATION_MS = 4000;

/** How far (px) beyond the danger point a path-based escape point is aimed. */
export const FLEE_TARGET_DIST = 220;

/** How far (px) from that raw aim point a real sidewalk point may be snapped from. */
export const FLEE_SNAP_RADIUS = 160;

/** How long (ms) an instantaneous vehicle-dodge lasts before resuming normal life. */
export const FLEE_VEHICLE_DURATION_MS = 550;

/** Probability that an idle pause turns into a chatter. */
export const TALK_CHANCE = 0.16;

/** Probability that an idle pause becomes "walk into a nearby building". */
export const ENTER_BUILDING_CHANCE = 0.1;

/** Probability that an idle pause becomes a look-around beat. */
export const LOOK_AROUND_CHANCE = 0.14;

/** Probability that an idle pause becomes "walk to a free bench and sit". */
export const SIT_CHANCE = 0.12;

/** Probability that an idle pause becomes "walk to a bus stop and wait". */
export const WAIT_BUS_CHANCE = 0.08;

/** Search radius (px) for a building doorway to duck into. */
export const ENTRANCE_SEARCH_RADIUS = 110;

/** Search radius (px) for a free bench to sit on. */
export const BENCH_SEARCH_RADIUS = 220;

/** Search radius (px) for a free bus stop waiting point. */
export const BUS_STOP_SEARCH_RADIUS = 260;

/** Maximum duration (ms) of a street brawl before both give up. */
export const BRAWL_TIMEOUT_MS = 12000;

/** Melee reach (px) during a brawl. */
export const BRAWL_REACH = 22;

/** Damage per brawl swing. */
export const BRAWL_DAMAGE = 3;

/** Health ratio (of max) at or below which a pedestrian collapses instead of continuing. */
export const DOWNED_HEALTH_RATIO = 0.25;

/** How long (ms) a downed pedestrian takes to recover on its own. */
export const DOWNED_RECOVER_MIN_MS = 6000;
export const DOWNED_RECOVER_MAX_MS = 10000;

/** Health ratio a downed pedestrian recovers to when it gets back up. */
export const DOWNED_RECOVER_HEALTH_RATIO = 0.5;

/** How long (ms) a helper stands with a downed pedestrian before moving on. */
export const HELP_STAND_DURATION_MS = 3000;

/** Upper bound (ms) a helper will spend travelling before giving up. */
export const HELP_APPROACH_TIMEOUT_MS = 8000;

/** Distance (px) at which a helper counts as having reached the downed pedestrian. */
export const HELP_ARRIVE_RADIUS = 26;

/** Radius (px) within which an oncoming vehicle triggers a reflexive dodge. */
export const VEHICLE_DANGER_RADIUS = 130;

/** How far ahead (seconds) a vehicle's straight-line position is projected. */
export const VEHICLE_DANGER_HORIZON_SEC = 0.6;

/** Projected distance (px) inside which the vehicle counts as an imminent hit. */
export const VEHICLE_DANGER_TRIGGER_DIST = 34;

/** Minimum neighbour body radius (px) treated as "vehicle-sized" by the dodge heuristic. */
export const VEHICLE_RADIUS_THRESHOLD = 14;

/** Minimum neighbour speed (px/s) considered a moving hazard. */
export const VEHICLE_MIN_SPEED = 40;

/**
 * How often (ms) the vehicle-danger scan actually runs per pedestrian, rather
 * than every frame — it queries every nearby dynamic agent, and at realistic
 * populations that's meaningful allocation churn to pay for every single
 * pedestrian every single frame regardless of state (idle/sitting/talking
 * included). This interval is still well inside VEHICLE_DANGER_HORIZON_SEC,
 * so the reflex stays responsive.
 */
export const VEHICLE_DANGER_CHECK_INTERVAL_MS = 150;

/** The little things pedestrians say. */
export const CHATTER = ['...', '!', '?', '♪', 'hm?', 'ha!'] as const;
