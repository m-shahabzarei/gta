import type { Vector2 } from '@/core/types';
import type { LaneSpline } from './TrafficTypes';

export interface SplinePose {
  readonly point: Vector2;
  readonly tangent: Vector2;
  readonly heading: number;
  readonly curvature: number;
}

export interface SplineProjection extends SplinePose {
  readonly distance: number;
  readonly distanceSq: number;
  readonly t: number;
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export function lerp(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

export function wrapAngle(angle: number): number {
  let wrapped = angle % (Math.PI * 2);
  if (wrapped > Math.PI) wrapped -= Math.PI * 2;
  if (wrapped < -Math.PI) wrapped += Math.PI * 2;
  return wrapped;
}

export function lerpAngle(from: number, to: number, amount: number): number {
  return wrapAngle(from + wrapAngle(to - from) * clamp(amount, 0, 1));
}

export function smoothstep(value: number): number {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

export function createLaneSpline(
  id: string,
  p0: Vector2,
  p1: Vector2,
  p2: Vector2,
  p3: Vector2,
  sampleCount = 28,
): LaneSpline {
  const controlPoints = [{ ...p0 }, { ...p1 }, { ...p2 }, { ...p3 }] as const;
  const arcTable: Array<{ t: number; distance: number; point: Vector2 }> = [];
  let distance = 0;
  let previous = cubicPoint(controlPoints, 0);
  arcTable.push({ t: 0, distance: 0, point: previous });
  for (let index = 1; index <= sampleCount; index++) {
    const t = index / sampleCount;
    const point = cubicPoint(controlPoints, t);
    distance += Math.hypot(point.x - previous.x, point.y - previous.y);
    arcTable.push({ t, distance, point });
    previous = point;
  }
  return { id, controlPoints, arcTable, length: distance };
}

export function sampleSpline(spline: LaneSpline, distance: number): SplinePose {
  const target = clamp(distance, 0, spline.length);
  const samples = spline.arcTable;
  let low = 0;
  let high = samples.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const sample = samples[middle];
    if (sample && sample.distance < target) low = middle + 1;
    else high = middle;
  }
  const upper = samples[low] ?? samples[samples.length - 1];
  const lower = samples[Math.max(0, low - 1)] ?? upper;
  if (!upper || !lower) {
    return { point: { x: 0, y: 0 }, tangent: { x: 1, y: 0 }, heading: 0, curvature: 0 };
  }
  const span = Math.max(0.0001, upper.distance - lower.distance);
  const t = lerp(lower.t, upper.t, (target - lower.distance) / span);
  return poseAtT(spline, t);
}

export function projectOnSpline(position: Vector2, spline: LaneSpline): SplineProjection {
  const samples = spline.arcTable;
  let bestIndex = 0;
  let bestSq = Infinity;
  for (let index = 0; index < samples.length; index++) {
    const point = samples[index]?.point;
    if (!point) continue;
    const distanceSq = squaredDistance(position, point);
    if (distanceSq < bestSq) {
      bestSq = distanceSq;
      bestIndex = index;
    }
  }
  const center = samples[bestIndex];
  if (!center) {
    const pose = sampleSpline(spline, 0);
    return { ...pose, distance: 0, distanceSq: squaredDistance(position, pose.point), t: 0 };
  }
  const step = 1 / Math.max(1, samples.length - 1);
  let left = Math.max(0, center.t - step);
  let right = Math.min(1, center.t + step);
  for (let pass = 0; pass < 7; pass++) {
    const first = left + (right - left) / 3;
    const second = right - (right - left) / 3;
    if (
      squaredDistance(position, cubicPoint(spline.controlPoints, first)) <
      squaredDistance(position, cubicPoint(spline.controlPoints, second))
    ) {
      right = second;
    } else {
      left = first;
    }
  }
  const t = (left + right) * 0.5;
  const pose = poseAtT(spline, t);
  return {
    ...pose,
    distance: distanceAtT(spline, t),
    distanceSq: squaredDistance(position, pose.point),
    t,
  };
}

export function cubicPoint(
  points: readonly [Vector2, Vector2, Vector2, Vector2],
  t: number,
): Vector2 {
  const inverse = 1 - t;
  const a = inverse * inverse * inverse;
  const b = 3 * inverse * inverse * t;
  const c = 3 * inverse * t * t;
  const d = t * t * t;
  return {
    x: points[0].x * a + points[1].x * b + points[2].x * c + points[3].x * d,
    y: points[0].y * a + points[1].y * b + points[2].y * c + points[3].y * d,
  };
}

function poseAtT(spline: LaneSpline, t: number): SplinePose {
  const tangentRaw = cubicDerivative(spline.controlPoints, t);
  const magnitude = Math.max(0.0001, Math.hypot(tangentRaw.x, tangentRaw.y));
  const tangent = { x: tangentRaw.x / magnitude, y: tangentRaw.y / magnitude };
  const second = cubicSecondDerivative(spline.controlPoints, t);
  const curvature =
    (tangentRaw.x * second.y - tangentRaw.y * second.x) / Math.max(0.0001, magnitude ** 3);
  return {
    point: cubicPoint(spline.controlPoints, t),
    tangent,
    heading: Math.atan2(tangent.y, tangent.x),
    curvature,
  };
}

function cubicDerivative(
  points: readonly [Vector2, Vector2, Vector2, Vector2],
  t: number,
): Vector2 {
  const inverse = 1 - t;
  return {
    x:
      3 * inverse * inverse * (points[1].x - points[0].x) +
      6 * inverse * t * (points[2].x - points[1].x) +
      3 * t * t * (points[3].x - points[2].x),
    y:
      3 * inverse * inverse * (points[1].y - points[0].y) +
      6 * inverse * t * (points[2].y - points[1].y) +
      3 * t * t * (points[3].y - points[2].y),
  };
}

function cubicSecondDerivative(
  points: readonly [Vector2, Vector2, Vector2, Vector2],
  t: number,
): Vector2 {
  return {
    x:
      6 * (1 - t) * (points[2].x - 2 * points[1].x + points[0].x) +
      6 * t * (points[3].x - 2 * points[2].x + points[1].x),
    y:
      6 * (1 - t) * (points[2].y - 2 * points[1].y + points[0].y) +
      6 * t * (points[3].y - 2 * points[2].y + points[1].y),
  };
}

function distanceAtT(spline: LaneSpline, t: number): number {
  const samples = spline.arcTable;
  for (let index = 1; index < samples.length; index++) {
    const upper = samples[index];
    const lower = samples[index - 1];
    if (!upper || !lower || upper.t < t) continue;
    const span = Math.max(0.0001, upper.t - lower.t);
    return lerp(lower.distance, upper.distance, (t - lower.t) / span);
  }
  return spline.length;
}

function squaredDistance(a: Vector2, b: Vector2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}
