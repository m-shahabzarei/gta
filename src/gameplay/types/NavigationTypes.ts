/**
 * Data-only navigation types shared between the navigation service, AI
 * components and their world/traffic-query dependencies. No logic lives here
 * — see `systems/NavigationSystem.ts` for the service implementation and
 * `utils/AStar.ts` for the underlying search.
 */
import type { Vector2 } from '@/core/types';

/** The kind of agent a path/avoidance query is being made for. */
export type NavAgentProfile = 'pedestrian' | 'police';

/** The resolved outcome of a path request. */
export interface NavPathResult {
  /** Waypoints from start to goal (post-simplified), or null if none could be produced at all. */
  waypoints: Vector2[] | null;
  /** Whether `waypoints` actually reaches the requested destination. */
  complete: boolean;
}

/** Callback invoked once a queued path request is resolved. */
export type NavPathCallback = (result: NavPathResult) => void;

/** A nearby dynamic agent, exposed for local avoidance/separation steering. */
export interface NeighbourInfo {
  entityId: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
}
