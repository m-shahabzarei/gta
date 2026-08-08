/** Small bounded LRU cache with deterministic eviction and no timer ownership. */
export class LruCache<TKey, TValue> {
  private readonly values = new Map<TKey, TValue>();

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error('LruCache capacity must be a positive integer.');
    }
  }

  public get(key: TKey): TValue | undefined {
    const value = this.values.get(key);
    if (value === undefined) return undefined;
    this.values.delete(key);
    this.values.set(key, value);
    return value;
  }

  public peek(key: TKey): TValue | undefined {
    return this.values.get(key);
  }

  public has(key: TKey): boolean {
    return this.values.has(key);
  }

  public set(key: TKey, value: TValue): void {
    if (this.values.has(key)) this.values.delete(key);
    this.values.set(key, value);
    while (this.values.size > this.capacity) {
      const oldest = this.values.keys().next().value as TKey | undefined;
      if (oldest === undefined) break;
      this.values.delete(oldest);
    }
  }

  public clear(): void {
    this.values.clear();
  }

  public get size(): number {
    return this.values.size;
  }
}
