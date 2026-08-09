import type { Vector2 } from '@/core/types';
import type { InteriorNpcSpawn } from '@/gameplay/types/WorldTypes';

/**
 * Materialize the deterministic runtime jitter used for authored interior NPC seeds.
 * Keeping this pure calculation shared lets generation validate every point the runtime can use.
 */
export function interiorNpcSpawnPosition(spawn: InteriorNpcSpawn, ordinal: number): Vector2 {
  const safeOrdinal = Math.max(0, Math.floor(ordinal));
  const jitter = spawn.anchors && spawn.anchors.length > 0 ? 0 : (safeOrdinal % 3) * 5 - 5;
  return {
    x: spawn.x + jitter,
    y: spawn.y + Math.sin(safeOrdinal) * 6,
  };
}
