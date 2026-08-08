/**
 * A small, seedable pseudo-random number generator (Mulberry32).
 *
 * A deterministic RNG is essential for reproducible worlds, tests and
 * (eventually) networked play, so the engine never calls `Math.random()`
 * directly — it goes through an instance of this class.
 */
export class Random {
  private state: number;

  /** @param seed 32-bit unsigned seed. Defaults to a fixed value. */
  constructor(seed = 0x9e3779b9) {
    this.state = seed >>> 0;
  }

  /** Re-seed the generator, resetting its sequence. */
  public setSeed(seed: number): void {
    this.state = seed >>> 0;
  }

  /** Next float in [0, 1). */
  public next(): number {
    // Mulberry32.
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Float in [min, max). */
  public range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Integer in [min, max] (inclusive). */
  public intRange(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  /** `true` with the given probability (0..1). */
  public chance(probability: number): boolean {
    return this.next() < probability;
  }

  /** Pick a uniformly random element, or `undefined` for an empty array. */
  public pick<T>(items: readonly T[]): T | undefined {
    if (items.length === 0) return undefined;
    return items[this.intRange(0, items.length - 1)];
  }

  /** Return a shuffled copy of `items` (Fisher–Yates); input is not mutated. */
  public shuffle<T>(items: readonly T[]): T[] {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.intRange(0, i);
      [out[i], out[j]] = [out[j] as T, out[i] as T];
    }
    return out;
  }
}

/** Shared default RNG instance for casual, non-deterministic-critical use. */
export const random = new Random();
