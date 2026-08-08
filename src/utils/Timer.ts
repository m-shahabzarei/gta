/**
 * A frame-driven countdown/interval timer decoupled from Phaser's clock.
 *
 * Advanced manually via {@link update} with the frame delta, so managers can
 * schedule work without allocating Phaser `TimerEvent`s and without being tied
 * to a specific scene's lifetime.
 */
import { ENGINE_LIMITS } from '@/config/EngineLimits';
import { EngineDiagnostics } from '@/core/EngineDiagnostics';

export class Timer {
  private elapsed = 0;
  private running = false;

  /**
   * @param durationMs How long (ms) until the timer fires.
   * @param onComplete Invoked each time the duration elapses.
   * @param loop       When true, the timer restarts automatically.
   */
  constructor(
    private durationMs: number,
    private readonly onComplete: () => void,
    private readonly loop = false,
  ) {}

  /** Start (or restart) the timer from zero. */
  public start(): void {
    this.elapsed = 0;
    this.running = true;
  }

  /** Pause without resetting elapsed time. */
  public pause(): void {
    this.running = false;
  }

  /** Resume after a {@link pause}. */
  public resume(): void {
    this.running = true;
  }

  /** Stop and reset. */
  public stop(): void {
    this.running = false;
    this.elapsed = 0;
  }

  /** Change the duration; takes effect on the next completion. */
  public setDuration(durationMs: number): void {
    this.durationMs = durationMs;
  }

  /** Progress toward completion as a 0..1 factor. */
  public get progress(): number {
    return this.durationMs <= 0 ? 1 : Math.min(this.elapsed / this.durationMs, 1);
  }

  /** Whether the timer is currently counting. */
  public get isRunning(): boolean {
    return this.running;
  }

  /**
   * Advance the timer.
   * @param delta Milliseconds elapsed since the previous frame.
   */
  public update(delta: number): void {
    if (!this.running) return;
    if (this.durationMs <= 0) {
      EngineDiagnostics.recordLimitExceeded(
        'TIMER_MAX_FIRES_PER_UPDATE',
        1,
        ENGINE_LIMITS.TIMER_MAX_FIRES_PER_UPDATE,
        'stopped-invalid-duration-timer',
        `duration:${this.durationMs}`,
      );
      this.onComplete();
      this.running = false;
      this.elapsed = 0;
      return;
    }
    this.elapsed += delta;
    let fires = 0;
    while (this.elapsed >= this.durationMs) {
      this.elapsed -= this.durationMs;
      this.onComplete();
      fires += 1;
      if (!this.loop) {
        this.running = false;
        this.elapsed = 0;
        break;
      }
      if (fires >= ENGINE_LIMITS.TIMER_MAX_FIRES_PER_UPDATE) {
        EngineDiagnostics.recordLimitExceeded(
          'TIMER_MAX_FIRES_PER_UPDATE',
          fires + 1,
          ENGINE_LIMITS.TIMER_MAX_FIRES_PER_UPDATE,
          'deferred-looping-timer',
          `duration:${this.durationMs}`,
        );
        this.elapsed = Math.min(this.elapsed, this.durationMs);
        break;
      }
    }
  }
}
