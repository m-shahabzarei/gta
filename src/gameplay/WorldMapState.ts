/**
 * Small session-level state shared by the HUD and the world map overlay.
 *
 * The world map scene is launched only when gameplay is paused, so it cannot
 * rely on a fresh mission-target event firing while it is open. This module
 * keeps the latest mission/waypoint positions available without creating a
 * full manager.
 */
import { EventKeys } from '@/config/EventKeys';
import { eventBus } from '@/core/EventBus';
import type { Vector2 } from '@/core/types';

let objectiveTarget: Vector2 | null = null;
let waypoint: Vector2 | null = null;

function copy(point: Vector2 | null): Vector2 | null {
  return point ? { x: point.x, y: point.y } : null;
}

export function getObjectiveTarget(): Vector2 | null {
  return copy(objectiveTarget);
}

export function setObjectiveTarget(next: Vector2 | null): void {
  objectiveTarget = copy(next);
}

export function getWaypoint(): Vector2 | null {
  return copy(waypoint);
}

export function setWaypoint(next: Vector2 | null): void {
  waypoint = copy(next);
  eventBus.emit(EventKeys.WaypointChanged, { target: copy(waypoint) });
}

export function clearMapState(): void {
  objectiveTarget = null;
  setWaypoint(null);
}
