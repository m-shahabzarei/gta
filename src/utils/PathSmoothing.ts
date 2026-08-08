/**
 * Grid-path post-processing: turns a raw cell-by-cell A* path into a short
 * list of waypoints by "string-pulling" — greedily skipping to the farthest
 * point still in a straight, unobstructed line of sight. Removes the
 * staircase look of grid movement without a full funnel algorithm.
 */
import type { Vector2 } from '@/core/types';

/** World-space sampling step (px) used when testing a candidate line of sight. */
const DEFAULT_SAMPLE_STEP_PX = 8;

/**
 * Simplify a dense grid path down to the waypoints where a direction change is
 * actually required.
 * @param points Raw path in order, start to goal.
 * @param isWalkable Predicate for a world position; false = blocked.
 * @param sampleStepPx Distance between line-of-sight samples along a candidate segment.
 */
export function simplifyWaypoints(
  points: readonly Vector2[],
  isWalkable: (x: number, y: number) => boolean,
  sampleStepPx = DEFAULT_SAMPLE_STEP_PX,
): Vector2[] {
  if (points.length <= 2) {
    return points.slice();
  }

  const first = points[0];
  if (!first) return [];

  const result: Vector2[] = [first];
  let anchorIndex = 0;

  while (anchorIndex < points.length - 1) {
    const anchor = points[anchorIndex];
    if (!anchor) break;

    let farthest = anchorIndex + 1;
    for (let candidate = points.length - 1; candidate > anchorIndex + 1; candidate--) {
      const point = points[candidate];
      if (point && hasLineOfSight(anchor, point, isWalkable, sampleStepPx)) {
        farthest = candidate;
        break;
      }
    }

    const next = points[farthest];
    if (!next) break;
    result.push(next);
    anchorIndex = farthest;
  }

  return result;
}

/** Whether every sampled point along the segment `a` → `b` is walkable. */
function hasLineOfSight(
  a: Vector2,
  b: Vector2,
  isWalkable: (x: number, y: number) => boolean,
  sampleStepPx: number,
): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-3) return true;

  const steps = Math.max(1, Math.ceil(dist / sampleStepPx));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (!isWalkable(a.x + dx * t, a.y + dy * t)) return false;
  }
  return true;
}
