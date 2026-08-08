/**
 * Danger/social-reaction pedestrian states: fleeing gunfire or an explosion
 * (path-based, with a radial fallback), dodging an oncoming vehicle, being
 * downed and getting helped back up, street brawling, and reporting violence
 * witnessed nearby. "Ordinary life" states live in `PedestrianIdleStates.ts`.
 */
import type Phaser from 'phaser';
import type { Vector2 } from '@/core/types';
import { eventBus } from '@/core/EventBus';
import { EventKeys } from '@/config/EventKeys';
import type {
  IDamageable,
  INavigationService,
  NeighbourInfo,
  WitnessReaction,
} from '@/gameplay/types';
import { Faction } from '@/gameplay/types';
import {
  ARRIVE_RADIUS,
  BRAWL_DAMAGE,
  BRAWL_REACH,
  BRAWL_TIMEOUT_MS,
  DOWNED_HEALTH_RATIO,
  DOWNED_RECOVER_HEALTH_RATIO,
  DOWNED_RECOVER_MAX_MS,
  DOWNED_RECOVER_MIN_MS,
  FLEE_DURATION_MS,
  FLEE_SNAP_RADIUS,
  FLEE_TARGET_DIST,
  FLEE_VEHICLE_DURATION_MS,
  HELP_APPROACH_TIMEOUT_MS,
  HELP_ARRIVE_RADIUS,
  HELP_STAND_DURATION_MS,
  VEHICLE_DANGER_HORIZON_SEC,
  VEHICLE_DANGER_RADIUS,
  VEHICLE_DANGER_TRIGGER_DIST,
  VEHICLE_MIN_SPEED,
  VEHICLE_RADIUS_THRESHOLD,
} from './PedestrianTypes';
import type { PedestrianAIContext, PedestrianPeer } from './PedestrianTypes';
import { enterWander, resetTransient, spawnBubble } from './PedestrianShared';

// ── Flee (gunfire / explosion / any alarm) ─────────────────────────────────

export function enterFlee(
  ctx: PedestrianAIContext,
  pos: Vector2,
  dangerX: number,
  dangerY: number,
): void {
  resetTransient(ctx);
  ctx.danger.x = dangerX;
  ctx.danger.y = dangerY;
  ctx.state = 'flee';
  ctx.stateTimer = FLEE_DURATION_MS;

  const escapeDir = computeEscapeDirection(pos, dangerX, dangerY);
  const aim = {
    x: pos.x + escapeDir.x * FLEE_TARGET_DIST,
    y: pos.y + escapeDir.y * FLEE_TARGET_DIST,
  };
  const snapped = ctx.world?.randomSidewalkPointNear(aim.x, aim.y, FLEE_SNAP_RADIUS) ?? null;
  if (snapped) {
    ctx.nav.beginTravel(pos, snapped, ctx.navService, 0);
  }
  // Otherwise updateFlee() falls back to a straight-line radial run.

  // Witness reporting is NOT rolled here: every alarmed pedestrian would
  // otherwise independently roll for the exact same incident, multiplying
  // its heat contribution with crowd size. Instead the alarming system
  // (PedestrianSystem.alarmNear) picks a single witness per incident and
  // calls PedestrianAIComponent.tryReportWitnessedCrime() on it directly.
}

export function updateFlee(ctx: PedestrianAIContext, pos: Vector2, delta: number): void {
  ctx.stateTimer -= delta;
  if (ctx.stateTimer <= 0) {
    enterWander(ctx);
    return;
  }

  if (ctx.nav.hasDestination) {
    const result = ctx.nav.tick(
      pos,
      ctx.movement.facingAngle,
      delta,
      ctx.world,
      ctx.traffic,
      ctx.navService,
      ARRIVE_RADIUS,
    );
    if (result.status === 'travelling' && result.moveDir) {
      ctx.movement.setMoveVector(result.moveDir.x, result.moveDir.y, true);
      return;
    }
    if (result.status === 'arrived') {
      enterWander(ctx);
      return;
    }
    // 'pending' / 'holding' / 'failed' all fall through to the radial run
    // below — panic doesn't wait at a curb or freeze mid-explosion.
  }

  const escapeDir = computeEscapeDirection(pos, ctx.danger.x, ctx.danger.y);
  ctx.movement.setMoveVector(escapeDir.x, escapeDir.y, true);
}

function computeEscapeDirection(pos: Vector2, dangerX: number, dangerY: number): Vector2 {
  const dx = pos.x - dangerX;
  const dy = pos.y - dangerY;
  const len = Math.hypot(dx, dy);
  if (len < 1e-3) return { x: 1, y: 0 };
  return { x: dx / len, y: dy / len };
}

// ── Flee vehicle (instantaneous reflexive dodge) ───────────────────────────

export function enterFleeVehicle(ctx: PedestrianAIContext, dodgeDir: Vector2): void {
  resetTransient(ctx);
  ctx.state = 'flee-vehicle';
  ctx.stateTimer = FLEE_VEHICLE_DURATION_MS;
  ctx.dodgeDir = dodgeDir;
}

export function updateFleeVehicle(ctx: PedestrianAIContext, delta: number): void {
  ctx.movement.setMoveVector(ctx.dodgeDir.x, ctx.dodgeDir.y, true);
  ctx.stateTimer -= delta;
  if (ctx.stateTimer <= 0) enterWander(ctx);
}

/**
 * Per-frame hazard scan (cheap: reuses the existing nearby-agent query) for a
 * fast-closing vehicle-sized neighbour on an imminent collision course.
 * Returns a perpendicular dodge direction, or null when nothing is dangerous.
 */
export function detectVehicleDanger(
  pos: Vector2,
  navService: INavigationService | null,
  entityId: number,
): Vector2 | null {
  if (!navService) return null;
  const neighbours = navService.queryNearby(pos.x, pos.y, VEHICLE_DANGER_RADIUS, entityId);
  for (const neighbour of neighbours) {
    const dodge = evaluateVehicleThreat(pos, neighbour);
    if (dodge) return dodge;
  }
  return null;
}

function evaluateVehicleThreat(pos: Vector2, neighbour: NeighbourInfo): Vector2 | null {
  if (neighbour.radius < VEHICLE_RADIUS_THRESHOLD) return null;
  const speed = Math.hypot(neighbour.vx, neighbour.vy);
  if (speed < VEHICLE_MIN_SPEED) return null;

  const futureX = neighbour.x + neighbour.vx * VEHICLE_DANGER_HORIZON_SEC;
  const futureY = neighbour.y + neighbour.vy * VEHICLE_DANGER_HORIZON_SEC;
  if (Math.hypot(futureX - pos.x, futureY - pos.y) > VEHICLE_DANGER_TRIGGER_DIST) return null;

  const heading = Math.atan2(neighbour.vy, neighbour.vx);
  const perpA = heading + Math.PI / 2;
  const perpB = heading - Math.PI / 2;
  const toPedX = pos.x - neighbour.x;
  const toPedY = pos.y - neighbour.y;
  const dotA = Math.cos(perpA) * toPedX + Math.sin(perpA) * toPedY;
  const dotB = Math.cos(perpB) * toPedX + Math.sin(perpB) * toPedY;
  const chosen = dotA >= dotB ? perpA : perpB;
  return { x: Math.cos(chosen), y: Math.sin(chosen) };
}

// ── Downed / help-injured ───────────────────────────────────────────────────

/** Whether this pedestrian's health has dropped low enough to collapse instead of continuing. */
export function shouldGoDowned(ctx: PedestrianAIContext): boolean {
  const health = ctx.health;
  if (!health || health.isDead || health.maxHealth <= 0) return false;
  return health.health / health.maxHealth <= DOWNED_HEALTH_RATIO;
}

export function enterDowned(ctx: PedestrianAIContext, pos: Vector2): void {
  resetTransient(ctx);
  ctx.state = 'downed';
  ctx.stateTimer =
    DOWNED_RECOVER_MIN_MS + Math.random() * (DOWNED_RECOVER_MAX_MS - DOWNED_RECOVER_MIN_MS);
  eventBus.emit(EventKeys.PedestrianDowned, {
    entityId: ctx.entityId,
    position: { x: pos.x, y: pos.y },
  });
}

export function updateDowned(ctx: PedestrianAIContext, delta: number): void {
  ctx.movement.stop();
  const health = ctx.health;
  if (!health || health.isDead) return; // Died of its wounds; now an ordinary corpse.

  ctx.stateTimer -= delta;
  if (ctx.stateTimer <= 0) {
    const target = health.maxHealth * DOWNED_RECOVER_HEALTH_RATIO;
    const need = target - health.health;
    if (need > 0) health.heal(need);
    enterWander(ctx);
  }
}

export function enterHelpInjured(
  ctx: PedestrianAIContext,
  pos: Vector2,
  target: PedestrianPeer,
): void {
  resetTransient(ctx);
  ctx.state = 'help-injured';
  ctx.stateTimer = HELP_APPROACH_TIMEOUT_MS;
  ctx.helpTarget = target;
  ctx.nav.beginTravel(pos, target.position, ctx.navService, 6);
}

export function updateHelpInjured(ctx: PedestrianAIContext, pos: Vector2, delta: number): void {
  const target = ctx.helpTarget;
  if (!target || !target.isActive) {
    enterWander(ctx);
    return;
  }

  if (ctx.nav.hasDestination) {
    ctx.stateTimer -= delta;
    if (ctx.stateTimer <= 0) {
      enterWander(ctx);
      return;
    }
    const result = ctx.nav.tick(
      pos,
      ctx.movement.facingAngle,
      delta,
      ctx.world,
      ctx.traffic,
      ctx.navService,
      HELP_ARRIVE_RADIUS,
    );
    switch (result.status) {
      case 'travelling':
        if (result.moveDir) ctx.movement.setMoveVector(result.moveDir.x, result.moveDir.y, false);
        return;
      case 'arrived':
        ctx.movement.stop();
        ctx.stateTimer = HELP_STAND_DURATION_MS;
        return;
      case 'failed':
        enterWander(ctx);
        return;
      default:
        ctx.movement.stop();
        return;
    }
  }

  // Standing with the downed pedestrian.
  ctx.movement.stop();
  ctx.movement.setFacingAngle(Math.atan2(target.position.y - pos.y, target.position.x - pos.x));
  ctx.stateTimer -= delta;
  if (ctx.stateTimer <= 0) enterWander(ctx);
}

// ── Brawl ────────────────────────────────────────────────────────────────

export function enterBrawl(ctx: PedestrianAIContext, opponent: IDamageable): void {
  resetTransient(ctx);
  ctx.state = 'brawl';
  ctx.stateTimer = BRAWL_TIMEOUT_MS;
  ctx.brawlTarget = opponent;
  ctx.brawlSwingMs = 350 + Math.random() * 400;
}

export function updateBrawl(ctx: PedestrianAIContext, pos: Vector2, delta: number): void {
  const opponent = ctx.brawlTarget;
  ctx.stateTimer -= delta;
  if (!opponent || opponent.isDead || ctx.stateTimer <= 0) {
    enterWander(ctx);
    return;
  }

  const oPos = opponent.position;
  const dx = oPos.x - pos.x;
  const dy = oPos.y - pos.y;
  const dist = Math.hypot(dx, dy);
  ctx.movement.setFacingAngle(Math.atan2(dy, dx));

  if (dist > BRAWL_REACH) {
    ctx.movement.setMoveVector(dx, dy, false);
    return;
  }
  ctx.movement.stop();
  ctx.brawlSwingMs -= delta;
  if (ctx.brawlSwingMs <= 0) {
    ctx.brawlSwingMs = 500 + Math.random() * 450;
    opponent.applyDamage({
      amount: BRAWL_DAMAGE,
      sourceFaction: Faction.Civilian,
      fromPlayer: false,
    });
  }
}

// ── Witness reports ─────────────────────────────────────────────────────────

/** Tick the per-pedestrian witness-report cooldown down; called every frame regardless of state. */
export function enterCrimeReaction(
  ctx: PedestrianAIContext,
  pos: Vector2,
  sprite: Phaser.GameObjects.Sprite,
  reaction: WitnessReaction,
  danger: Vector2,
): void {
  resetTransient(ctx);
  ctx.danger = { ...danger };
  ctx.movement.stop();
  ctx.movement.setFacingAngle(Math.atan2(danger.y - pos.y, danger.x - pos.x));
  switch (reaction) {
    case 'call-police':
      ctx.state = 'crime-call';
      ctx.stateTimer = 2300;
      spawnBubble(ctx, pos, sprite, 'CALL');
      break;
    case 'point':
    case 'help':
      ctx.state = 'crime-point';
      ctx.stateTimer = 1700;
      spawnBubble(ctx, pos, sprite, '!');
      break;
    case 'scream':
      ctx.state = 'crime-scream';
      ctx.stateTimer = 1200;
      spawnBubble(ctx, pos, sprite, '!');
      break;
    default:
      ctx.state = 'crime-freeze';
      ctx.stateTimer = 1400 + (ctx.entityId % 8) * 100;
      break;
  }
}

export function updateCrimeReaction(ctx: PedestrianAIContext, delta: number): void {
  ctx.movement.stop();
  ctx.stateTimer -= delta;
  if (ctx.stateTimer <= 0) enterWander(ctx);
}
