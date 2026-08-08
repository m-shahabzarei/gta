/**
 * Data-driven animation definitions consumed by the {@link AnimationManager}.
 *
 * Animations are declared as data so they can be authored in JSON (or derived
 * from Aseprite frame-tags) and registered once, globally, on `game.anims`.
 * This keeps animation setup out of individual entities.
 */
import type { Direction } from './Direction';

/** How to select frames for an animation. */
export type AnimationFrames =
  | { readonly type: 'range'; readonly start: number; readonly end: number }
  | { readonly type: 'frames'; readonly frames: ReadonlyArray<string | number> }
  | { readonly type: 'aseprite'; readonly tag: string };

/** A single animation definition. */
export interface AnimationDefinition {
  /** Global animation key. */
  readonly key: string;
  /** Texture (atlas / sprite sheet / aseprite) the frames come from. */
  readonly texture: string;
  /** Frame selection strategy. */
  readonly frames: AnimationFrames;
  /** Playback speed in frames per second. */
  readonly frameRate: number;
  /** Repeat count; `-1` loops forever, `0` plays once. */
  readonly repeat: number;
  /** Whether the animation reverses on completion. */
  readonly yoyo?: boolean;
}

/**
 * A named set of eight directional animations (one per {@link Direction}) — the
 * common case for top-down walk/run/idle cycles.
 */
export interface DirectionalAnimationSet {
  /** Logical name, e.g. "player-walk". */
  readonly name: string;
  /** Animation key per direction. */
  readonly byDirection: Readonly<Record<Direction, string>>;
}
