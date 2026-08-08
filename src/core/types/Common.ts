/**
 * Small, framework-agnostic value types shared across the engine.
 * These deliberately mirror (but do not depend on) Phaser's geometry types so
 * that pure logic can be unit-tested without a running game instance.
 */

/** A 2D point / vector. */
export interface Vector2 {
  x: number;
  y: number;
}

/** A width/height pair. */
export interface Size {
  width: number;
  height: number;
}

/** An axis-aligned rectangle. */
export interface Rect extends Vector2, Size {}

/** An RGB colour expressed as separate 0–255 channels. */
export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** A function that receives no arguments and returns nothing. */
export type Callback = () => void;

/** A generic disposer returned by subscription-style APIs. */
export type Unsubscribe = () => void;
