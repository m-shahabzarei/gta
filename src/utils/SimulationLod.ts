/**
 * Shared simulation LOD helpers.
 *
 * These functions keep expensive AI/cosmetic work proportional to distance from
 * the player. They intentionally return frame intervals rather than timers so
 * large crowds naturally stagger across frames by entity id.
 */
import type Phaser from 'phaser';
import type { Vector2 } from '@/core/types';

export const NPC_LOD = {
  nearSq: 300 * 300,
  midSq: 700 * 700,
  farSq: 1200 * 1200,
  freezeSq: 1600 * 1600,
} as const;

export const VEHICLE_LOD = {
  nearSq: 420 * 420,
  midSq: 800 * 800,
  farSq: 1200 * 1200,
  freezeSq: 1550 * 1550,
} as const;

export function distanceSqTo(point: Vector2, x: number, y: number): number {
  const dx = x - point.x;
  const dy = y - point.y;
  return dx * dx + dy * dy;
}

export function npcUpdateInterval(distanceSq: number): number {
  if (distanceSq <= NPC_LOD.nearSq) return 1;
  if (distanceSq <= NPC_LOD.midSq) return 3;
  if (distanceSq <= NPC_LOD.farSq) return 8;
  if (distanceSq <= NPC_LOD.freezeSq) return 20;
  return 0;
}

export function vehicleUpdateInterval(distanceSq: number): number {
  if (distanceSq <= VEHICLE_LOD.nearSq) return 1;
  if (distanceSq <= VEHICLE_LOD.midSq) return 3;
  if (distanceSq <= VEHICLE_LOD.farSq) return 8;
  if (distanceSq <= VEHICLE_LOD.freezeSq) return 20;
  return 0;
}

export function shouldUpdateFrame(frame: number, id: number, interval: number): boolean {
  return interval <= 1 || (frame + id) % interval === 0;
}

export function inCameraView(
  scene: Phaser.Scene | null,
  x: number,
  y: number,
  margin: number,
): boolean {
  const view = scene?.cameras?.main?.worldView;
  if (!view) return true;
  return (
    x >= view.x - margin &&
    x <= view.right + margin &&
    y >= view.y - margin &&
    y <= view.bottom + margin
  );
}

export function setBodySimulation(
  sprite: Phaser.Physics.Arcade.Sprite,
  simulate: boolean,
  visible: boolean,
): void {
  if (sprite.visible !== visible) sprite.setVisible(visible);
  const body = sprite.body as Phaser.Physics.Arcade.Body | null;
  if (!body) return;
  if (body.enable === simulate) return;
  if (!simulate) body.setVelocity(0, 0);
  body.enable = simulate;
}
