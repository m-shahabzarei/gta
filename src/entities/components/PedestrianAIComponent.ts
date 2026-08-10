/**
 * Pedestrian behaviour driver.
 *
 * A thin orchestrator over the pedestrian state machine implemented in
 * `./pedestrian/`: it owns the shared {@link PedestrianAIContext} blackboard,
 * resolves the world/traffic/navigation services once per frame, runs the
 * two per-frame hazard checks that can pre-empt anything (collapsing from
 * damage, dodging an oncoming vehicle), then dispatches to whichever state
 * handler is active. Movement is grid-pathed and steered (see
 * `PedestrianNav`) rather than a blind straight-line walk, so pedestrians
 * route around buildings, use crosswalks, and recover from getting stuck
 * instead of humping a wall forever.
 *
 * Shared by both {@link Pedestrian} (full capabilities) and {@link Animal}
 * (wander/idle/flee only — no sitting, conversing or witness reporting).
 */
import type { Vector2 } from '@/core/types';
import type { BusStopSite, IDamageable, InteriorNpcActivity, WitnessReaction } from '@/gameplay/types';
import { getNavigationService, getTrafficQuery, getWorldQuery } from '@/gameplay/types';
import { Component } from '@/entities/Component';
import type { CharacterMovementComponent } from './CharacterMovementComponent';
import type { HealthComponent } from './HealthComponent';
import { PedestrianNav } from './pedestrian/PedestrianNav';
import type {
  PedestrianAIContext,
  PedestrianCapabilities,
  PedestrianPeer,
} from './pedestrian/PedestrianTypes';
import {
  DEFAULT_CAPABILITIES,
  VEHICLE_DANGER_CHECK_INTERVAL_MS,
} from './pedestrian/PedestrianTypes';
import { enterWander, resetTransient } from './pedestrian/PedestrianShared';
import {
  enterTalkWith,
  updateEnterBuilding,
  updateIdle,
  updateLookAround,
  updateSit,
  updateTalk,
  updateTalkToNearbyNpc,
  updateTransitBoarding,
  updateWaitBus,
  updateWander,
} from './pedestrian/PedestrianIdleStates';
import {
  detectVehicleDanger,
  enterBrawl,
  enterDowned,
  enterFlee,
  enterFleeVehicle,
  enterHelpInjured,
  enterCrimeReaction,
  shouldGoDowned,
  updateBrawl,
  updateDowned,
  updateFlee,
  updateFleeVehicle,
  updateHelpInjured,
  updateCrimeReaction,
} from './pedestrian/PedestrianReactiveStates';

export class PedestrianAIComponent extends Component implements PedestrianPeer {
  /** Component id within its host entity. */
  public readonly name = 'ai';

  /** Built once the movement sibling is confirmed present; null until then and after destroy. */
  private ctx: PedestrianAIContext | null = null;

  /** False once destroyed, so a lingering peer reference (talk/help partner) can check safely. */
  private destroyed = false;

  /** Last-known world position; safe to read even after destroy (unlike `this.entity.position`). */
  private cachedPosition: Vector2 = { x: 0, y: 0 };

  /**
   * @param capabilityOverrides Partial capability overrides layered onto
   *   {@link DEFAULT_CAPABILITIES} (e.g. animals disable the social ones).
   */
  constructor(private readonly capabilityOverrides: Partial<PedestrianCapabilities> = {}) {
    super();
  }

  // ── PedestrianPeer ─────────────────────────────────────────────────────

  public get entityId(): number {
    return this.ctx?.entityId ?? -1;
  }

  public get isActive(): boolean {
    return !this.destroyed;
  }

  public get position(): Vector2 {
    return this.cachedPosition;
  }

  // ── Public state queries ────────────────────────────────────────────────

  /** Whether this pedestrian finished entering a building and can be removed. */
  public get wantsDespawn(): boolean {
    return this.ctx?.despawnRequested ?? false;
  }

  /** Whether this pedestrian has collapsed from damage (ignores alarm/brawl while true). */
  public get isDowned(): boolean {
    return this.ctx?.state === 'downed';
  }

  /** Whether this pedestrian is free to be paired into a conversation or a help errand. */
  public get isIdleAvailable(): boolean {
    return this.ctx?.state === 'idle';
  }

  /** Current resolved travel waypoints, for debug visualisation only. */
  public get debugPath(): readonly Vector2[] {
    return this.ctx?.nav.debugWaypoints ?? [];
  }

  /** The platform this pedestrian is actively waiting at, if any. */
  public get waitingBusStop(): BusStopSite | null {
    const ctx = this.ctx;
    return ctx?.state === 'wait-bus' ? ctx.busStop : null;
  }

  /** True after this pedestrian has walked to a selected service vehicle door. */
  public get transitBoardingReady(): boolean {
    const ctx = this.ctx;
    return ctx?.state === 'transit-boarding' && ctx.transitBoardingReady;
  }

  /**
   * Leave the waiting queue and use normal pedestrian navigation to reach the
   * service vehicle door. The transportation system converts the NPC to an
   * occupant only after this reports ready.
   */
  public beginTransitBoarding(door: Vector2): boolean {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'wait-bus' || !ctx.busStop) return false;
    const pos = this.cachedPosition;
    resetTransient(ctx);
    ctx.state = 'transit-boarding';
    ctx.stateTimer = 0;
    ctx.transitBoardingTarget = { x: door.x, y: door.y };
    ctx.transitBoardingReady = false;
    ctx.nav.beginTravel(pos, ctx.transitBoardingTarget, ctx.navService, 8);
    return true;
  }

  /** Cancel an interrupted boarding walk (for example when the bus dwell expires). */
  public cancelTransitBoarding(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'transit-boarding') return;
    enterWander(ctx);
  }

  /** Keep this pedestrian's ordinary wandering near an anchor, used for real interiors. */
  public setHomeArea(x: number, y: number, radius: number): void {
    if (!this.ctx) return;
    this.ctx.homeArea = { x, y, radius };
  }

  /** Assign a bounded indoor activity loop while retaining shared navigation and reactions. */
  public setInteriorRoutine(activity: InteriorNpcActivity, anchors: readonly Vector2[]): void {
    const ctx = this.ctx;
    if (!ctx || anchors.length === 0) return;
    // spawn() gives every ordinary pedestrian an initial sidewalk intent.
    // Service NPCs receive their authored routine immediately afterward, so
    // discard that first request before it can carry them through the entrance.
    ctx.nav.cancel(ctx.navService);
    ctx.movement.stop();
    ctx.state = 'wander';
    ctx.stateTimer = 0;
    ctx.interiorRoutine = {
      activity,
      anchors: anchors.map((anchor) => ({ ...anchor })),
      nextIndex: this.entity.id % anchors.length,
    };
  }

  /** Cache the locomotion/health siblings and seed the initial wander leg. */
  protected override onAttach(): void {
    const movement = this.entity.getComponent<CharacterMovementComponent>('movement') ?? null;
    if (!movement) return;
    const health = this.entity.getComponent<HealthComponent>('health') ?? null;
    this.cachedPosition = { x: this.entity.position.x, y: this.entity.position.y };

    const ctx: PedestrianAIContext = {
      entityId: this.entity.id,
      capabilities: { ...DEFAULT_CAPABILITIES, ...this.capabilityOverrides },
      movement,
      health,
      nav: new PedestrianNav(this.entity.id),
      world: null,
      traffic: null,
      navService: null,
      homeArea: null,
      interiorRoutine: null,
      state: 'wander',
      stateTimer: 0,
      danger: { x: 0, y: 0 },
      dodgeDir: { x: 0, y: 0 },
      bench: null,
      busStop: null,
      transitBoardingTarget: null,
      transitBoardingReady: false,
      brawlTarget: null,
      brawlSwingMs: 0,
      talkPartner: null,
      helpTarget: null,
      bubble: null,
      despawnRequested: false,
      // Stagger the first check per pedestrian so the whole crowd doesn't
      // scan for vehicle danger on the exact same frame.
      vehicleDangerCheckMs: Math.random() * VEHICLE_DANGER_CHECK_INTERVAL_MS,
    };
    this.ctx = ctx;
    enterWander(ctx);
  }

  /**
   * React to nearby danger by fleeing away from the given point (path-based,
   * with a radial fallback). Safe to call repeatedly; each call refreshes the
   * flee timer and target. No-ops while downed.
   * @param x World x of the danger source.
   * @param y World y of the danger source.
   */
  public alarm(x: number, y: number): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'downed') return;
    enterFlee(ctx, this.cachedPosition, x, y);
  }

  /**
   * Join a street brawl against `opponent` until one side drops or the fight
   * times out. No-ops while downed; {@link alarm} always overrides a brawl.
   * @param opponent The damageable to trade swings with.
   */
  public brawlWith(opponent: IDamageable): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'downed') return;
    enterBrawl(ctx, opponent);
  }

  /**
   * Start a paired conversation with a nearby idle pedestrian. Called
   * symmetrically on both participants by the orchestrating system (mirrors
   * {@link brawlWith}'s external-pairing pattern).
   */
  public talkWith(partner: PedestrianPeer): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'downed' || !ctx.capabilities.canConverse) return;
    enterTalkWith(ctx, this.cachedPosition, this.entity.sprite, partner);
  }

  /** Walk over to a downed pedestrian and stand with them for a while. */
  public helpInjured(target: PedestrianPeer): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'downed') return;
    enterHelpInjured(ctx, this.cachedPosition, target);
  }

  /**
   * Try to report violence this pedestrian witnessed nearby. Intended to be
   * called on at most one candidate per incident by the alarming system
   * (e.g. {@link PedestrianSystem.alarmNear}) — never per-pedestrian, or a
   * single incident witnessed by a crowd would multiply its wanted-heat
   * contribution by crowd size.
   * @returns Whether a report was actually made (capability/cooldown/chance gated).
   */
  public reactToCrime(
    reaction: WitnessReaction,
    danger: Vector2,
    suspect?: IDamageable | null,
  ): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'downed' || reaction === 'ignore') return;
    if (reaction === 'run' || reaction === 'panic' || reaction === 'hide') {
      enterFlee(ctx, this.cachedPosition, danger.x, danger.y);
      return;
    }
    if (reaction === 'fight' && suspect) {
      enterBrawl(ctx, suspect);
      return;
    }
    enterCrimeReaction(ctx, this.cachedPosition, this.entity.sprite, reaction, danger);
  }

  /** Clear transient state and restart ordinary wandering after pool reuse. */
  public reset(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.destroyed = false;
    resetTransient(ctx);
    ctx.homeArea = null;
    ctx.interiorRoutine = null;
    ctx.stateTimer = 0;
    ctx.danger = { x: 0, y: 0 };
    ctx.dodgeDir = { x: 0, y: 0 };
    ctx.brawlSwingMs = 0;
    ctx.despawnRequested = false;
    ctx.transitBoardingTarget = null;
    ctx.transitBoardingReady = false;
    ctx.vehicleDangerCheckMs = Math.random() * VEHICLE_DANGER_CHECK_INTERVAL_MS;
    this.cachedPosition = { x: this.entity.sprite.x, y: this.entity.sprite.y };
    enterWander(ctx);
  }

  /**
   * Advance the state machine: refresh cached services, run the two hazard
   * pre-empts (downed / vehicle dodge), then dispatch to the active state.
   */
  public override update(_time: number, delta: number): void {
    const ctx = this.ctx;
    if (!ctx) return;

    this.cachedPosition = { x: this.entity.position.x, y: this.entity.position.y };
    const pos = this.cachedPosition;

    if (!ctx.world) ctx.world = getWorldQuery();
    if (!ctx.traffic) ctx.traffic = getTrafficQuery();
    if (!ctx.navService) ctx.navService = getNavigationService();

    ctx.vehicleDangerCheckMs -= delta;

    if (ctx.state !== 'downed' && shouldGoDowned(ctx)) {
      enterDowned(ctx, pos);
    } else if (
      ctx.state !== 'downed' &&
      ctx.state !== 'flee-vehicle' &&
      ctx.vehicleDangerCheckMs <= 0
    ) {
      ctx.vehicleDangerCheckMs = VEHICLE_DANGER_CHECK_INTERVAL_MS;
      const dodge = detectVehicleDanger(pos, ctx.navService, ctx.entityId);
      if (dodge) enterFleeVehicle(ctx, dodge);
    }

    switch (ctx.state) {
      case 'wander':
        updateWander(ctx, pos, delta);
        break;
      case 'idle':
        updateIdle(ctx, pos, this.entity.sprite, delta);
        break;
      case 'look-around':
        updateLookAround(ctx, delta);
        break;
      case 'sit':
        updateSit(ctx, pos, delta);
        break;
      case 'wait-bus':
        updateWaitBus(ctx, pos, delta);
        break;
      case 'transit-boarding':
        updateTransitBoarding(ctx, pos, delta);
        break;
      case 'talk':
        updateTalk(ctx, pos, delta);
        break;
      case 'talk-to-nearby-npc':
        updateTalkToNearbyNpc(ctx, pos, delta);
        break;
      case 'enter-building':
        updateEnterBuilding(ctx, pos, this.entity.sprite, delta);
        break;
      case 'flee':
        updateFlee(ctx, pos, delta);
        break;
      case 'flee-vehicle':
        updateFleeVehicle(ctx, delta);
        break;
      case 'crime-freeze':
      case 'crime-call':
      case 'crime-point':
      case 'crime-scream':
        updateCrimeReaction(ctx, delta);
        break;
      case 'downed':
        updateDowned(ctx, delta);
        break;
      case 'help-injured':
        updateHelpInjured(ctx, pos, delta);
        break;
      case 'brawl':
        updateBrawl(ctx, pos, delta);
        break;
      default:
        break;
    }
  }

  /** Tear down transient resources (bubble, claimed bench, in-flight path request). */
  public override destroy(): void {
    this.destroyed = true;
    const ctx = this.ctx;
    if (ctx) {
      resetTransient(ctx);
      this.ctx = null;
    }
    super.destroy();
  }
}
