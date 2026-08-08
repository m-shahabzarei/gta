import type { EngineLimitKey } from '@/config/EngineLimits';
import type { ServiceKeys } from '@/config/ServiceKeys';

export type EngineRunState = 'booting' | 'running' | 'degraded' | 'recovering';

export interface EngineErrorRecord {
  readonly time: number;
  readonly phase: string;
  readonly system: string | null;
  readonly message: string;
  readonly stack: string | null;
}

export interface EngineLimitRecord {
  readonly time: number;
  readonly limit: EngineLimitKey | string;
  readonly value: number;
  readonly max: number;
  readonly action: string;
  readonly detail: string | null;
}

export interface EngineDiagnosticsSnapshot {
  readonly engineState: EngineRunState;
  readonly frame: number;
  readonly currentUpdatePhase: string;
  readonly currentSystem: string | null;
  readonly lastCompletedSystem: string | null;
  readonly blockingSystem: string | null;
  readonly frameTimeMs: number;
  readonly currentFrameElapsedMs: number;
  readonly longestSystem: { key: string; ms: number } | null;
  readonly lastError: EngineErrorRecord | null;
  readonly recentErrors: readonly EngineErrorRecord[];
  readonly recentLimits: readonly EngineLimitRecord[];
  readonly eventBus: {
    readonly activeEvent: string | null;
    readonly depth: number;
    readonly dispatches: number;
    readonly droppedEvents: number;
    readonly listenerErrors: number;
  };
}

interface MutableEventStats {
  activeEvent: string | null;
  depth: number;
  dispatches: number;
  droppedEvents: number;
  listenerErrors: number;
}

const RECENT_LIMIT = 24;

class EngineDiagnosticsStore {
  private stateValue: EngineRunState = 'booting';
  private frameValue = 0;
  private currentUpdatePhaseValue = 'boot';
  private currentSystemValue: string | null = null;
  private lastCompletedSystemValue: string | null = null;
  private blockingSystemValue: string | null = null;
  private frameStartedAt = performanceNow();
  private frameTimeMsValue = 0;
  private longestSystemValue: { key: string; ms: number } | null = null;
  private readonly recentErrorsValue: EngineErrorRecord[] = [];
  private readonly recentLimitsValue: EngineLimitRecord[] = [];
  private readonly eventStats: MutableEventStats = {
    activeEvent: null,
    depth: 0,
    dispatches: 0,
    droppedEvents: 0,
    listenerErrors: 0,
  };

  public beginFrame(_time: number, delta: number): void {
    this.frameValue += 1;
    this.frameStartedAt = performanceNow();
    this.frameTimeMsValue = delta;
    this.currentUpdatePhaseValue = 'frame';
    this.currentSystemValue = null;
    this.longestSystemValue = null;
    if (this.stateValue === 'booting' || this.stateValue === 'recovering') {
      this.stateValue = 'running';
    }
  }

  public endFrame(): void {
    this.currentUpdatePhaseValue = 'idle';
    this.currentSystemValue = null;
  }

  public beginSystem(key: ServiceKeys | string): void {
    this.currentSystemValue = String(key);
    this.currentUpdatePhaseValue = `update:${String(key)}`;
  }

  public endSystem(key: ServiceKeys | string, elapsedMs: number): void {
    const system = String(key);
    this.lastCompletedSystemValue = system;
    if (!this.longestSystemValue || elapsedMs > this.longestSystemValue.ms) {
      this.longestSystemValue = { key: system, ms: elapsedMs };
    }
    if (this.currentSystemValue === system) this.currentSystemValue = null;
    this.currentUpdatePhaseValue = 'frame';
  }

  public recordSlowSystem(key: ServiceKeys | string, elapsedMs: number, budgetMs: number): void {
    this.blockingSystemValue = String(key);
    this.stateValue = 'degraded';
    this.recordLimitExceeded(
      'MANAGER_RECOVERY_MS',
      elapsedMs,
      budgetMs,
      'continued-frame-after-watchdog',
      String(key),
    );
  }

  public recordError(error: unknown, phase: string, system: ServiceKeys | string | null): void {
    const record: EngineErrorRecord = {
      time: performanceNow(),
      phase,
      system: system === null ? null : String(system),
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? (error.stack ?? null) : null,
    };
    this.stateValue = 'degraded';
    this.blockingSystemValue = record.system;
    pushRecent(this.recentErrorsValue, record);
  }

  public recordRecovery(system: ServiceKeys | string, action: string): void {
    this.stateValue = 'recovering';
    this.recordLimitExceeded('recovery', 1, 1, action, String(system));
  }

  public recordLimitExceeded(
    limit: EngineLimitKey | string,
    value: number,
    max: number,
    action: string,
    detail: string | null = null,
  ): void {
    pushRecent(this.recentLimitsValue, {
      time: performanceNow(),
      limit,
      value,
      max,
      action,
      detail,
    });
  }

  public beginEvent(event: string, depth: number): void {
    this.eventStats.activeEvent = event;
    this.eventStats.depth = depth;
    this.eventStats.dispatches += 1;
  }

  public endEvent(depth: number): void {
    this.eventStats.depth = depth;
    if (depth <= 0) this.eventStats.activeEvent = null;
  }

  public recordDroppedEvent(event: string, reason: string): void {
    this.eventStats.droppedEvents += 1;
    this.recordLimitExceeded('MAX_ACTIVE_EVENTS', this.eventStats.dispatches, 0, reason, event);
  }

  public recordEventListenerError(event: string, error: unknown): void {
    this.eventStats.listenerErrors += 1;
    this.recordError(error, `event:${event}`, null);
  }

  public get snapshot(): EngineDiagnosticsSnapshot {
    return {
      engineState: this.stateValue,
      frame: this.frameValue,
      currentUpdatePhase: this.currentUpdatePhaseValue,
      currentSystem: this.currentSystemValue,
      lastCompletedSystem: this.lastCompletedSystemValue,
      blockingSystem: this.blockingSystemValue,
      frameTimeMs: this.frameTimeMsValue,
      currentFrameElapsedMs: Math.max(0, performanceNow() - this.frameStartedAt),
      longestSystem: this.longestSystemValue,
      lastError: this.recentErrorsValue[this.recentErrorsValue.length - 1] ?? null,
      recentErrors: this.recentErrorsValue.slice(),
      recentLimits: this.recentLimitsValue.slice(),
      eventBus: { ...this.eventStats },
    };
  }
}

export const EngineDiagnostics = new EngineDiagnosticsStore();

const globalTarget = globalThis as typeof globalThis & {
  __engineDiagnostics?: () => EngineDiagnosticsSnapshot;
};
globalTarget.__engineDiagnostics = () => EngineDiagnostics.snapshot;

function pushRecent<T>(records: T[], record: T): void {
  records.push(record);
  if (records.length > RECENT_LIMIT) records.shift();
}

function performanceNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
