/**
 * Common transition helpers shared by every pedestrian state module: clearing
 * transient per-state resources (bubble, claimed bench, social partners, any
 * in-flight travel) and the two "resting" states every other state ultimately
 * falls back to.
 */
import type Phaser from 'phaser';
import type { Vector2 } from '@/core/types';
import { DepthLayers } from '@/config/DepthLayers';
import type { PedestrianAIContext } from './PedestrianTypes';
import { CHATTER, WANDER_TIMEOUT_MS } from './PedestrianTypes';

/** Release whatever the previous state was holding onto, so every transition starts clean. */
export function resetTransient(ctx: PedestrianAIContext): void {
  if (ctx.bench) {
    ctx.world?.releaseBench(ctx.bench, ctx.entityId);
    ctx.bench = null;
  }
  if (ctx.busStop) {
    ctx.world?.releaseBusStop(ctx.busStop, ctx.entityId);
    ctx.busStop = null;
  }
  clearBubble(ctx);
  ctx.talkPartner = null;
  ctx.helpTarget = null;
  ctx.brawlTarget = null;
  ctx.transitBoardingTarget = null;
  ctx.transitBoardingReady = false;
  ctx.nav.cancel(ctx.navService);
}

/** Enter (or re-enter) the default wandering state. */
export function enterWander(ctx: PedestrianAIContext): void {
  resetTransient(ctx);
  ctx.state = 'wander';
  ctx.stateTimer = WANDER_TIMEOUT_MS;
}

/** Enter a brief idle pause. */
export function enterIdle(ctx: PedestrianAIContext): void {
  resetTransient(ctx);
  ctx.state = 'idle';
  ctx.stateTimer = 700 + Math.random() * 1500;
  ctx.movement.stop();
}

/** Show a floating chatter glyph above the pedestrian's head. */
export function spawnBubble(
  ctx: PedestrianAIContext,
  pos: Vector2,
  sprite: Phaser.GameObjects.Sprite,
  text?: string,
): void {
  clearBubble(ctx);
  const glyph = text ?? CHATTER[Math.floor(Math.random() * CHATTER.length)] ?? '...';
  ctx.bubble = sprite.scene.add
    .text(pos.x, pos.y - 20, glyph, {
      fontFamily: 'monospace',
      fontSize: '10px',
      color: '#f4f4f8',
    })
    .setOrigin(0.5, 1)
    .setDepth(DepthLayers.Particles);
}

/** Destroy the chatter bubble if one is present. */
export function clearBubble(ctx: PedestrianAIContext): void {
  if (ctx.bubble) {
    ctx.bubble.destroy();
    ctx.bubble = null;
  }
}
