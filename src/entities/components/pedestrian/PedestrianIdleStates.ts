/**
 * "Ordinary life" pedestrian states: wandering, idling, looking around,
 * sitting on a bench, chattering (solo or paired) and ducking into a
 * building. Reactive/danger states live in `PedestrianReactiveStates.ts`.
 */
import type Phaser from 'phaser';
import type { Vector2 } from '@/core/types';
import { ServiceLocator } from '@/core/ServiceLocator';
import { ServiceKeys } from '@/config/ServiceKeys';
import type { BenchSite } from '@/gameplay/types';
import {
  ARRIVE_RADIUS,
  BENCH_SEARCH_RADIUS,
  BUS_STOP_SEARCH_RADIUS,
  BUS_WAIT_MAX_MS,
  BUS_WAIT_MIN_MS,
  ENTER_BUILDING_CHANCE,
  ENTRANCE_SEARCH_RADIUS,
  LOOK_AROUND_CHANCE,
  LOOK_AROUND_DURATION_MS,
  LOOK_AROUND_SWEEP_MS,
  SIT_CHANCE,
  SIT_MAX_MS,
  SIT_MIN_MS,
  TALK_CHANCE,
  TALK_DURATION_MS,
  TALK_PAIRED_DURATION_MS,
  WAIT_BUS_CHANCE,
  WANDER_LOCAL_RADIUS,
} from './PedestrianTypes';
import type { PedestrianAIContext, PedestrianPeer } from './PedestrianTypes';
import { clearBubble, enterIdle, enterWander, resetTransient, spawnBubble } from './PedestrianShared';

/** Cardinal facings cycled through by the look-around sweep. */
const LOOK_AROUND_FACINGS = [0, Math.PI / 2, Math.PI, -Math.PI / 2] as const;

/** Structural view of the world manager exposing building entrances. */
interface EntranceProvider {
  readonly map?: { buildingEntrances?: ReadonlyArray<Vector2> };
}

// ── Wander ───────────────────────────────────────────────────────────────

export function updateWander(ctx: PedestrianAIContext, pos: Vector2, delta: number): void {
  if (!ctx.nav.hasDestination) {
    const anchor = ctx.homeArea ?? pos;
    const radius = ctx.homeArea?.radius ?? WANDER_LOCAL_RADIUS;
    const target = ctx.world?.randomSidewalkPointNear(anchor.x, anchor.y, radius) ?? null;
    if (!target) {
      enterIdle(ctx);
      return;
    }
    ctx.nav.beginTravel(pos, target, ctx.navService, 10);
  }

  ctx.stateTimer -= delta;
  const result = ctx.nav.tick(
    pos,
    ctx.movement.facingAngle,
    delta,
    ctx.world,
    ctx.traffic,
    ctx.navService,
    ARRIVE_RADIUS,
  );
  switch (result.status) {
    case 'travelling':
      if (result.moveDir) ctx.movement.setMoveVector(result.moveDir.x, result.moveDir.y, false);
      break;
    case 'arrived':
    case 'failed':
      enterIdle(ctx);
      return;
    default:
      ctx.movement.stop();
      break;
  }

  if (ctx.stateTimer <= 0) {
    enterIdle(ctx);
  }
}

// ── Idle (dice-rolls into every other "ordinary life" behaviour) ─────────

export function updateIdle(
  ctx: PedestrianAIContext,
  pos: Vector2,
  sprite: Phaser.GameObjects.Sprite,
  delta: number,
): void {
  ctx.movement.stop();
  ctx.stateTimer -= delta;
  if (ctx.stateTimer > 0) return;

  const roll = Math.random();
  let band = ctx.homeArea ? 0 : ENTER_BUILDING_CHANCE;
  if (roll < band) {
    if (!tryEnterBuilding(ctx, pos)) enterWander(ctx);
    return;
  }

  band += ctx.homeArea ? 0 : SIT_CHANCE;
  if (roll < band && ctx.capabilities.canSit) {
    if (!trySit(ctx, pos)) enterWander(ctx);
    return;
  }

  band += ctx.homeArea ? 0 : WAIT_BUS_CHANCE;
  if (roll < band) {
    if (!tryWaitBus(ctx, pos)) enterWander(ctx);
    return;
  }

  band += LOOK_AROUND_CHANCE;
  if (roll < band) {
    enterLookAround(ctx);
    return;
  }

  band += TALK_CHANCE;
  if (roll < band && ctx.capabilities.canConverse) {
    enterTalk(ctx, pos, sprite);
    return;
  }

  enterWander(ctx);
}

// ── Look around ───────────────────────────────────────────────────────────

export function enterLookAround(ctx: PedestrianAIContext): void {
  resetTransient(ctx);
  ctx.state = 'look-around';
  ctx.stateTimer = LOOK_AROUND_DURATION_MS;
  ctx.movement.stop();
}

export function updateLookAround(ctx: PedestrianAIContext, delta: number): void {
  ctx.movement.stop();
  ctx.stateTimer -= delta;
  const idx = Math.abs(Math.floor(ctx.stateTimer / LOOK_AROUND_SWEEP_MS)) % LOOK_AROUND_FACINGS.length;
  ctx.movement.setFacingAngle(LOOK_AROUND_FACINGS[idx] ?? 0);
  if (ctx.stateTimer <= 0) enterIdle(ctx);
}

// ── Talk (solo) ────────────────────────────────────────────────────────────

export function enterTalk(ctx: PedestrianAIContext, pos: Vector2, sprite: Phaser.GameObjects.Sprite): void {
  resetTransient(ctx);
  ctx.state = 'talk';
  ctx.stateTimer = TALK_DURATION_MS;
  spawnBubble(ctx, pos, sprite);
}

export function updateTalk(ctx: PedestrianAIContext, pos: Vector2, delta: number): void {
  ctx.movement.stop();
  if (ctx.bubble) ctx.bubble.setPosition(pos.x, pos.y - 20);
  ctx.stateTimer -= delta;
  if (ctx.stateTimer <= 0) {
    clearBubble(ctx);
    enterIdle(ctx);
  }
}

// ── Talk (paired with a nearby NPC) ────────────────────────────────────────

export function enterTalkWith(
  ctx: PedestrianAIContext,
  pos: Vector2,
  sprite: Phaser.GameObjects.Sprite,
  partner: PedestrianPeer,
): void {
  resetTransient(ctx);
  ctx.state = 'talk-to-nearby-npc';
  ctx.stateTimer = TALK_PAIRED_DURATION_MS;
  ctx.talkPartner = partner;
  spawnBubble(ctx, pos, sprite);
}

export function updateTalkToNearbyNpc(ctx: PedestrianAIContext, pos: Vector2, delta: number): void {
  const partner = ctx.talkPartner;
  if (!partner || !partner.isActive) {
    enterIdle(ctx);
    return;
  }
  ctx.movement.stop();
  ctx.movement.setFacingAngle(Math.atan2(partner.position.y - pos.y, partner.position.x - pos.x));
  if (ctx.bubble) ctx.bubble.setPosition(pos.x, pos.y - 20);
  ctx.stateTimer -= delta;
  if (ctx.stateTimer <= 0) enterIdle(ctx);
}

// ── Enter building (fade out, request despawn) ─────────────────────────────

function tryEnterBuilding(ctx: PedestrianAIContext, pos: Vector2): boolean {
  const provider = ServiceLocator.tryResolve(ServiceKeys.World) as unknown as EntranceProvider | null;
  const entrances = provider?.map?.buildingEntrances;
  if (!entrances || entrances.length === 0) return false;

  const maxSq = ENTRANCE_SEARCH_RADIUS * ENTRANCE_SEARCH_RADIUS;
  let best: Vector2 | null = null;
  let bestSq = maxSq;
  for (const entrance of entrances) {
    const dx = entrance.x - pos.x;
    const dy = entrance.y - pos.y;
    const distSq = dx * dx + dy * dy;
    if (distSq < bestSq) {
      best = entrance;
      bestSq = distSq;
    }
  }
  if (!best) return false;

  resetTransient(ctx);
  ctx.state = 'enter-building';
  ctx.stateTimer = 6000;
  ctx.nav.beginTravel(pos, best, ctx.navService, 8);
  return true;
}

export function updateEnterBuilding(
  ctx: PedestrianAIContext,
  pos: Vector2,
  sprite: Phaser.GameObjects.Sprite,
  delta: number,
): void {
  ctx.stateTimer -= delta;
  const result = ctx.nav.tick(
    pos,
    ctx.movement.facingAngle,
    delta,
    ctx.world,
    ctx.traffic,
    ctx.navService,
    ARRIVE_RADIUS,
  );
  switch (result.status) {
    case 'travelling':
      if (result.moveDir) ctx.movement.setMoveVector(result.moveDir.x, result.moveDir.y, false);
      return;
    case 'arrived':
      ctx.movement.stop();
      sprite.scene.tweens.add({
        targets: sprite,
        alpha: 0,
        duration: 450,
        onComplete: () => {
          ctx.despawnRequested = true;
        },
      });
      // Fading out; the crowd system reaps the despawn request shortly.
      ctx.state = 'idle';
      ctx.stateTimer = 10000;
      return;
    case 'failed':
      enterWander(ctx);
      return;
    default:
      ctx.movement.stop();
      break;
  }
  if (ctx.stateTimer <= 0) enterWander(ctx);
}

// ── Sit on a bench ─────────────────────────────────────────────────────────

function trySit(ctx: PedestrianAIContext, pos: Vector2): boolean {
  const world = ctx.world;
  if (!world) return false;
  const bench = world.nearestFreeBench(pos.x, pos.y, BENCH_SEARCH_RADIUS);
  if (!bench || !world.claimBench(bench, ctx.entityId)) return false;

  resetTransient(ctx);
  ctx.bench = bench;
  ctx.state = 'sit';
  ctx.stateTimer = 0;
  ctx.nav.beginTravel(pos, bench, ctx.navService, 8);
  return true;
}

export function updateSit(ctx: PedestrianAIContext, pos: Vector2, delta: number): void {
  if (ctx.nav.hasDestination) {
    const result = ctx.nav.tick(pos, ctx.movement.facingAngle, delta, ctx.world, ctx.traffic, ctx.navService, 10);
    switch (result.status) {
      case 'travelling':
        if (result.moveDir) ctx.movement.setMoveVector(result.moveDir.x, result.moveDir.y, false);
        return;
      case 'arrived':
        ctx.movement.stop();
        sitDown(ctx);
        return;
      case 'failed':
        enterWander(ctx);
        return;
      default:
        ctx.movement.stop();
        return;
    }
  }

  // Seated: hold the pose for the countdown, then get up.
  ctx.movement.stop();
  if (ctx.bench) ctx.movement.setFacingAngle(ctx.bench.facing);
  ctx.stateTimer -= delta;
  if (ctx.stateTimer <= 0) enterIdle(ctx);
}

function sitDown(ctx: PedestrianAIContext): void {
  const bench = ctx.bench as BenchSite | null;
  if (bench) ctx.movement.setFacingAngle(bench.facing);
  ctx.stateTimer = SIT_MIN_MS + Math.random() * (SIT_MAX_MS - SIT_MIN_MS);
}

// Wait for bus

function tryWaitBus(ctx: PedestrianAIContext, pos: Vector2): boolean {
  const world = ctx.world;
  if (!world) return false;
  const stop = world.nearestFreeBusStop(pos.x, pos.y, BUS_STOP_SEARCH_RADIUS);
  if (!stop || !world.claimBusStop(stop, ctx.entityId)) return false;

  resetTransient(ctx);
  ctx.busStop = stop;
  ctx.state = 'wait-bus';
  ctx.stateTimer = 0;
  ctx.nav.beginTravel(pos, stop, ctx.navService, 8);
  return true;
}

export function updateWaitBus(ctx: PedestrianAIContext, pos: Vector2, delta: number): void {
  if (ctx.nav.hasDestination) {
    const result = ctx.nav.tick(pos, ctx.movement.facingAngle, delta, ctx.world, ctx.traffic, ctx.navService, 10);
    switch (result.status) {
      case 'travelling':
        if (result.moveDir) ctx.movement.setMoveVector(result.moveDir.x, result.moveDir.y, false);
        return;
      case 'arrived':
        ctx.movement.stop();
        waitAtStop(ctx);
        return;
      case 'failed':
        enterWander(ctx);
        return;
      default:
        ctx.movement.stop();
        return;
    }
  }

  ctx.movement.stop();
  if (ctx.busStop) ctx.movement.setFacingAngle(ctx.busStop.facing);
  ctx.stateTimer -= delta;
  if (ctx.stateTimer <= 0) enterIdle(ctx);
}

function waitAtStop(ctx: PedestrianAIContext): void {
  if (ctx.busStop) ctx.movement.setFacingAngle(ctx.busStop.facing);
  ctx.stateTimer = BUS_WAIT_MIN_MS + Math.random() * (BUS_WAIT_MAX_MS - BUS_WAIT_MIN_MS);
}
