import type { Vector2 } from '@/core/types';
import type { SafePedestrianPlacementOptions } from '@/gameplay/types/WorldTypes';

/** Immutable solid-tile view consumed by the pure actor-placement algorithms. */
export interface SolidTileGrid {
  readonly tileSize: number;
  readonly widthTiles: number;
  readonly heightTiles: number;
  isSolidTile(tx: number, ty: number): boolean;
}

/** Backwards-compatible pure-grid name for the public world-query placement options. */
export type CirclePlacementOptions = SafePedestrianPlacementOptions;

const DISTANCE_EPSILON = 1e-6;

/** Whether a complete actor circle fits inside the world without touching a solid tile. */
export function isCircleClearOnGrid(
  grid: SolidTileGrid,
  position: Vector2,
  radius: number,
): boolean {
  if (!validGrid(grid) || !validPosition(position) || !Number.isFinite(radius) || radius < 0) {
    return false;
  }

  const widthPx = grid.widthTiles * grid.tileSize;
  const heightPx = grid.heightTiles * grid.tileSize;
  if (
    position.x - radius < 0 ||
    position.y - radius < 0 ||
    position.x + radius > widthPx ||
    position.y + radius > heightPx
  ) {
    return false;
  }

  const minTx = Math.max(0, Math.floor((position.x - radius) / grid.tileSize));
  const maxTx = Math.min(grid.widthTiles - 1, Math.floor((position.x + radius) / grid.tileSize));
  const minTy = Math.max(0, Math.floor((position.y - radius) / grid.tileSize));
  const maxTy = Math.min(grid.heightTiles - 1, Math.floor((position.y + radius) / grid.tileSize));
  const radiusSq = radius * radius;

  for (let ty = minTy; ty <= maxTy; ty += 1) {
    for (let tx = minTx; tx <= maxTx; tx += 1) {
      if (!grid.isSolidTile(tx, ty)) continue;
      const left = tx * grid.tileSize;
      const top = ty * grid.tileSize;
      const nearestX = clamp(position.x, left, left + grid.tileSize);
      const nearestY = clamp(position.y, top, top + grid.tileSize);
      const dx = position.x - nearestX;
      const dy = position.y - nearestY;
      if (radius === 0 ? dx === 0 && dy === 0 : dx * dx + dy * dy < radiusSq) return false;
    }
  }
  return true;
}

/** Whether a swept actor circle can move between two points without crossing a solid tile. */
export function isCircleSegmentClearOnGrid(
  grid: SolidTileGrid,
  from: Vector2,
  to: Vector2,
  radius: number,
): boolean {
  if (!validPosition(from) || !validPosition(to)) return false;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  const sampleSpacing = Math.max(1, Math.min(grid.tileSize * 0.25, Math.max(1, radius * 0.5)));
  const steps = Math.max(1, Math.ceil(distance / sampleSpacing));
  for (let index = 0; index <= steps; index += 1) {
    const amount = index / steps;
    if (!isCircleClearOnGrid(grid, { x: from.x + dx * amount, y: from.y + dy * amount }, radius)) {
      return false;
    }
  }
  return true;
}

/**
 * Preserve a valid requested point or relocate it to the nearest clear tile center.
 * Candidate ties are stable (`y`, then `x`) so identical maps always produce the same result.
 */
export function resolveCirclePositionOnGrid(
  grid: SolidTileGrid,
  requested: Vector2,
  radius: number,
  options: CirclePlacementOptions = {},
): Vector2 | null {
  if (!validGrid(grid) || !validPosition(requested) || !Number.isFinite(radius) || radius < 0) {
    return null;
  }
  const maxDistance = options.maxDistance ?? Infinity;
  if (Number.isNaN(maxDistance) || maxDistance < 0) return null;
  const segmentClear = (candidate: Vector2): boolean =>
    options.segmentStart === undefined ||
    isCircleSegmentClearOnGrid(grid, options.segmentStart, candidate, radius);

  if (isCircleClearOnGrid(grid, requested, radius) && segmentClear(requested)) {
    return { x: requested.x, y: requested.y };
  }

  const finiteSearch = Number.isFinite(maxDistance);
  const minTx = finiteSearch
    ? Math.max(0, Math.floor((requested.x - maxDistance) / grid.tileSize))
    : 0;
  const maxTx = finiteSearch
    ? Math.min(grid.widthTiles - 1, Math.floor((requested.x + maxDistance) / grid.tileSize))
    : grid.widthTiles - 1;
  const minTy = finiteSearch
    ? Math.max(0, Math.floor((requested.y - maxDistance) / grid.tileSize))
    : 0;
  const maxTy = finiteSearch
    ? Math.min(grid.heightTiles - 1, Math.floor((requested.y + maxDistance) / grid.tileSize))
    : grid.heightTiles - 1;
  const maxDistanceSq = maxDistance * maxDistance;
  let best: Vector2 | null = null;
  let bestDistanceSq = Infinity;

  for (let ty = minTy; ty <= maxTy; ty += 1) {
    for (let tx = minTx; tx <= maxTx; tx += 1) {
      const candidate = {
        x: tx * grid.tileSize + grid.tileSize * 0.5,
        y: ty * grid.tileSize + grid.tileSize * 0.5,
      };
      const dx = candidate.x - requested.x;
      const dy = candidate.y - requested.y;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq > maxDistanceSq + DISTANCE_EPSILON) continue;
      if (distanceSq > bestDistanceSq + DISTANCE_EPSILON) continue;
      if (!isCircleClearOnGrid(grid, candidate, radius) || !segmentClear(candidate)) continue;
      if (
        best === null ||
        distanceSq < bestDistanceSq - DISTANCE_EPSILON ||
        (Math.abs(distanceSq - bestDistanceSq) <= DISTANCE_EPSILON &&
          (candidate.y < best.y || (candidate.y === best.y && candidate.x < best.x)))
      ) {
        best = candidate;
        bestDistanceSq = distanceSq;
      }
    }
  }
  return best;
}

function validGrid(grid: SolidTileGrid): boolean {
  return (
    Number.isFinite(grid.tileSize) &&
    grid.tileSize > 0 &&
    Number.isInteger(grid.widthTiles) &&
    grid.widthTiles > 0 &&
    Number.isInteger(grid.heightTiles) &&
    grid.heightTiles > 0
  );
}

function validPosition(position: Vector2): boolean {
  return Number.isFinite(position.x) && Number.isFinite(position.y);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
