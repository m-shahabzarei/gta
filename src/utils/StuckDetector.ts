/**
 * Detects when a moving agent has stopped making meaningful progress, so a
 * caller can trigger a repath instead of leaving it wedged against geometry.
 * Dependency-free and reusable by any per-frame-updated agent.
 */
import type { Vector2 } from '@/core/types';

export class StuckDetector {
  /** Accumulated time (ms) since the last displacement check. */
  private timerMs = 0;

  /** Position recorded at the last displacement check, or null before the first. */
  private lastCheckPos: Vector2 | null = null;

  /** Consecutive check windows with too little displacement. */
  private consecutiveFailures = 0;

  /**
   * @param checkIntervalMs How often (ms) to sample displacement.
   * @param minDisplacementPx Minimum movement expected per interval to count as progress.
   * @param requiredFailures Consecutive failed intervals before reporting "stuck".
   */
  constructor(
    private readonly checkIntervalMs = 500,
    private readonly minDisplacementPx = 6,
    private readonly requiredFailures = 2,
  ) {}

  /** Reset the detector's window, e.g. after starting a fresh path/destination. */
  public reset(): void {
    this.timerMs = 0;
    this.lastCheckPos = null;
    this.consecutiveFailures = 0;
  }

  /**
   * Advance the check window.
   * @returns True the moment the agent is deemed stuck (having failed to move
   *   far enough across `requiredFailures` consecutive windows). The failure
   *   count is cleared when it fires, so a caller that repaths and keeps
   *   calling `update` will only be told again after a fresh run of failures.
   */
  public update(pos: Vector2, deltaMs: number): boolean {
    this.timerMs += deltaMs;
    if (this.timerMs < this.checkIntervalMs) return false;
    this.timerMs = 0;

    if (this.lastCheckPos) {
      const dist = Math.hypot(pos.x - this.lastCheckPos.x, pos.y - this.lastCheckPos.y);
      this.consecutiveFailures = dist < this.minDisplacementPx ? this.consecutiveFailures + 1 : 0;
    }
    this.lastCheckPos = { x: pos.x, y: pos.y };

    if (this.consecutiveFailures >= this.requiredFailures) {
      this.consecutiveFailures = 0;
      return true;
    }
    return false;
  }
}
