/**
 * Pure steering-behaviour math: seek, separation, short-range obstacle
 * avoidance and vector blending/smoothing. Operates only on {@link Vector2},
 * with no engine or gameplay-type dependencies, so it is reusable by any
 * moving agent (pedestrians today, vehicles later).
 */
import type { Vector2 } from '@/core/types';

/** A unit vector from `pos` toward `target`, or the zero vector if they coincide. */
export function seek(pos: Vector2, target: Vector2): Vector2 {
  const dx = target.x - pos.x;
  const dy = target.y - pos.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-4) return { x: 0, y: 0 };
  return { x: dx / len, y: dy / len };
}

/**
 * A soft repulsion vector away from every point in `others` closer than
 * `desiredSeparationPx`, weighted by how deep the overlap is. Zero vector when
 * nothing is close.
 */
export function separation(
  pos: Vector2,
  others: readonly Vector2[],
  desiredSeparationPx: number,
): Vector2 {
  let x = 0;
  let y = 0;
  for (const other of others) {
    const dx = pos.x - other.x;
    const dy = pos.y - other.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= 1e-4 || dist >= desiredSeparationPx) continue;
    const strength = (desiredSeparationPx - dist) / desiredSeparationPx;
    x += (dx / dist) * strength;
    y += (dy / dist) * strength;
  }
  const len = Math.hypot(x, y);
  if (len < 1e-4) return { x: 0, y: 0 };
  return { x: x / len, y: y / len };
}

/**
 * Casts a small fan of rays ahead of `headingRad` and, when the centre ray is
 * blocked, returns a unit vector nudging perpendicular toward the clearer
 * side. Returns null when the path directly ahead is clear.
 */
export function avoidAhead(
  pos: Vector2,
  headingRad: number,
  lookaheadPx: number,
  isBlocked: (x: number, y: number) => boolean,
  coneHalfAngleRad = Math.PI / 7,
): Vector2 | null {
  const centreX = pos.x + Math.cos(headingRad) * lookaheadPx;
  const centreY = pos.y + Math.sin(headingRad) * lookaheadPx;
  if (!isBlocked(centreX, centreY)) return null;

  const leftAngle = headingRad - coneHalfAngleRad;
  const rightAngle = headingRad + coneHalfAngleRad;
  const leftBlocked = isBlocked(
    pos.x + Math.cos(leftAngle) * lookaheadPx,
    pos.y + Math.sin(leftAngle) * lookaheadPx,
  );
  const rightBlocked = isBlocked(
    pos.x + Math.cos(rightAngle) * lookaheadPx,
    pos.y + Math.sin(rightAngle) * lookaheadPx,
  );

  // Nudge toward whichever side reads clearer; if both flanks are blocked too,
  // pick a stable (position-derived, not random) side so the dodge doesn't
  // flicker frame to frame.
  let turn: number;
  if (!leftBlocked && rightBlocked) {
    turn = -Math.PI / 2;
  } else if (leftBlocked && !rightBlocked) {
    turn = Math.PI / 2;
  } else {
    turn = pos.x + pos.y >= 0 ? Math.PI / 2 : -Math.PI / 2;
  }
  const avoidAngle = headingRad + turn;
  return { x: Math.cos(avoidAngle), y: Math.sin(avoidAngle) };
}

/** Weighted sum of direction vectors, renormalised to a unit vector (zero if they cancel). */
export function blend(vectors: ReadonlyArray<{ v: Vector2; weight: number }>): Vector2 {
  let x = 0;
  let y = 0;
  for (const { v, weight } of vectors) {
    x += v.x * weight;
    y += v.y * weight;
  }
  const len = Math.hypot(x, y);
  if (len < 1e-4) return { x: 0, y: 0 };
  return { x: x / len, y: y / len };
}

/**
 * Blend `current` toward `desired`, limiting the turn to `turnRatePerSec`
 * radians this frame. Inputs are treated as directions (magnitude ignored);
 * the result is always a unit vector, or the zero vector if `desired` is
 * itself zero-length (nothing to steer toward).
 */
export function smoothDirection(
  current: Vector2,
  desired: Vector2,
  turnRatePerSec: number,
  deltaMs: number,
): Vector2 {
  const desiredLen = Math.hypot(desired.x, desired.y);
  if (desiredLen < 1e-4) return { x: 0, y: 0 };
  const desiredAngle = Math.atan2(desired.y, desired.x);

  const currentLen = Math.hypot(current.x, current.y);
  if (currentLen < 1e-4) {
    return { x: Math.cos(desiredAngle), y: Math.sin(desiredAngle) };
  }
  const currentAngle = Math.atan2(current.y, current.x);

  // Shortest signed angular difference, wrapped into (-PI, PI].
  const diff = Math.atan2(Math.sin(desiredAngle - currentAngle), Math.cos(desiredAngle - currentAngle));

  const maxStep = turnRatePerSec * (deltaMs / 1000);
  const step = Math.abs(diff) <= maxStep ? diff : Math.sign(diff) * maxStep;
  const angle = currentAngle + step;
  return { x: Math.cos(angle), y: Math.sin(angle) };
}
