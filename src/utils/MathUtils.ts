/**
 * Pure mathematical helpers with no engine dependencies.
 * Kept side-effect free so they are trivially unit-testable.
 */
import type { Vector2 } from '@/core/types';

/** Clamp `value` into the inclusive range [`min`, `max`]. */
export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Linear interpolation from `a` to `b` by factor `t` (0..1, unclamped). */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Inverse lerp: the position of `value` within [`a`, `b`] as a 0..1 factor. */
export function inverseLerp(a: number, b: number, value: number): number {
  return a === b ? 0 : clamp((value - a) / (b - a), 0, 1);
}

/** Remap `value` from the [`inMin`,`inMax`] range to [`outMin`,`outMax`]. */
export function mapRange(
  value: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
): number {
  return lerp(outMin, outMax, inverseLerp(inMin, inMax, value));
}

/** Euclidean distance between two points. */
export function distance(a: Vector2, b: Vector2): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Squared distance — cheaper when only comparisons are needed. */
export function distanceSquared(a: Vector2, b: Vector2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return dx * dx + dy * dy;
}

/** Angle in radians from `a` to `b`. */
export function angleBetween(a: Vector2, b: Vector2): number {
  return Math.atan2(b.y - a.y, b.x - a.x);
}

/** Wrap `value` into [0, `max`), handling negatives correctly. */
export function wrap(value: number, max: number): number {
  return ((value % max) + max) % max;
}

/** Degrees → radians. */
export function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Radians → degrees. */
export function radToDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

/** Convert a 24-bit `0xRRGGBB` integer into its channels. */
export function hexToRgb(hex: number): { r: number; g: number; b: number } {
  return {
    r: (hex >> 16) & 0xff,
    g: (hex >> 8) & 0xff,
    b: hex & 0xff,
  };
}

/** Combine 0–255 channels back into a `0xRRGGBB` integer. */
export function rgbToHex(r: number, g: number, b: number): number {
  return ((clamp(r, 0, 255) & 0xff) << 16) | ((clamp(g, 0, 255) & 0xff) << 8) | (clamp(b, 0, 255) & 0xff);
}
