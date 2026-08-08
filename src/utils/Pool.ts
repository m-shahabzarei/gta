/**
 * A generic object pool.
 *
 * Reusing objects (bullets, particles, NPCs) instead of allocating and garbage-
 * collecting them every frame is critical for a smooth 60 FPS open world. Phase
 * 2 systems build their spawners on top of this.
 */
export class Pool<T> {
  private readonly free: T[] = [];
  private readonly active = new Set<T>();
  private readonly all = new Set<T>();

  /**
   * @param factory  Creates a brand-new instance when the pool is empty.
   * @param reset    Resets an instance to a clean state before reuse.
   * @param initial  How many instances to pre-allocate up front.
   */
  constructor(
    private readonly factory: () => T,
    private readonly reset: (item: T) => void = () => {},
    initial = 0,
  ) {
    for (let i = 0; i < initial; i++) {
      const item = this.factory();
      this.all.add(item);
      this.free.push(item);
    }
  }

  /** Acquire an instance, creating one if the pool is exhausted. */
  public acquire(): T {
    let item = this.free.pop();
    if (!item) {
      item = this.factory();
      this.all.add(item);
    }
    this.active.add(item);
    return item;
  }

  /** Return an instance to the pool and reset it for reuse. */
  public release(item: T): void {
    if (!this.active.delete(item)) return; // ignore double/foreign releases
    this.reset(item);
    this.free.push(item);
  }

  /** Release every currently-active instance. */
  public releaseAll(): void {
    for (const item of Array.from(this.active)) {
      this.release(item);
    }
  }

  /** Number of instances currently checked out. */
  public get activeCount(): number {
    return this.active.size;
  }

  /** Number of instances idle and available for reuse. */
  public get freeCount(): number {
    return this.free.length;
  }

  public get totalCount(): number {
    return this.all.size;
  }

  /** Permanently release every pooled allocation during owner teardown. */
  public destroy(destroyItem: (item: T) => void): void {
    for (const item of this.all) destroyItem(item);
    this.active.clear();
    this.free.length = 0;
    this.all.clear();
  }
}
