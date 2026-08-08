/**
 * Allocation-conscious spatial hash for dynamic point objects.
 *
 * Each item occupies exactly one cell, which keeps insert/update/remove O(1)
 * on average. Radius queries visit only intersecting cells and can stream
 * results through a callback without allocating a result array.
 */
interface SpatialEntry<T> {
  readonly id: number;
  item: T;
  x: number;
  y: number;
  cellX: number;
  cellY: number;
}

export class SpatialHashGrid<T> {
  private readonly buckets = new Map<number, SpatialEntry<T>[]>();
  private readonly entries = new Map<number, SpatialEntry<T>>();

  constructor(private readonly cellSize: number) {
    if (!Number.isFinite(cellSize) || cellSize <= 0) {
      throw new Error('SpatialHashGrid cellSize must be greater than zero.');
    }
  }

  public insert(id: number, item: T, x: number, y: number): void {
    const existing = this.entries.get(id);
    if (existing) {
      existing.item = item;
      this.update(id, x, y);
      return;
    }

    const cellX = Math.floor(x / this.cellSize);
    const cellY = Math.floor(y / this.cellSize);
    const entry: SpatialEntry<T> = { id, item, x, y, cellX, cellY };
    this.entries.set(id, entry);
    this.bucket(cellX, cellY, true)?.push(entry);
  }

  public update(id: number, x: number, y: number): void {
    const entry = this.entries.get(id);
    if (!entry) return;

    const cellX = Math.floor(x / this.cellSize);
    const cellY = Math.floor(y / this.cellSize);
    entry.x = x;
    entry.y = y;
    if (cellX === entry.cellX && cellY === entry.cellY) return;

    this.removeFromBucket(entry);
    entry.cellX = cellX;
    entry.cellY = cellY;
    this.bucket(cellX, cellY, true)?.push(entry);
  }

  public remove(id: number): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.removeFromBucket(entry);
    this.entries.delete(id);
    return true;
  }

  public forEachInRadius(
    x: number,
    y: number,
    radius: number,
    visitor: (item: T, distanceSq: number) => void,
  ): void {
    const radiusSq = radius * radius;
    const minCellX = Math.floor((x - radius) / this.cellSize);
    const maxCellX = Math.floor((x + radius) / this.cellSize);
    const minCellY = Math.floor((y - radius) / this.cellSize);
    const maxCellY = Math.floor((y + radius) / this.cellSize);

    for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
      for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
        const bucket = this.bucket(cellX, cellY, false);
        if (!bucket) continue;
        for (const entry of bucket) {
          const dx = entry.x - x;
          const dy = entry.y - y;
          const distanceSq = dx * dx + dy * dy;
          if (distanceSq <= radiusSq) visitor(entry.item, distanceSq);
        }
      }
    }
  }

  public clear(): void {
    this.buckets.clear();
    this.entries.clear();
  }

  public get size(): number {
    return this.entries.size;
  }

  private bucket(cellX: number, cellY: number, create: boolean): SpatialEntry<T>[] | undefined {
    const key = this.cellKey(cellX, cellY);
    let bucket = this.buckets.get(key);
    if (!bucket && create) {
      bucket = [];
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  private removeFromBucket(entry: SpatialEntry<T>): void {
    const key = this.cellKey(entry.cellX, entry.cellY);
    const bucket = this.buckets.get(key);
    if (!bucket) return;
    const index = bucket.indexOf(entry);
    if (index !== -1) {
      const last = bucket.pop();
      if (last && index < bucket.length) bucket[index] = last;
    }
    if (bucket.length === 0) this.buckets.delete(key);
  }

  private cellKey(cellX: number, cellY: number): number {
    // World coordinates use only a few hundred cells per axis. This stride
    // remains collision-free while also supporting small negative coordinates.
    return cellX + cellY * 131_071;
  }
}
