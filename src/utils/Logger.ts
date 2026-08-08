/**
 * A minimal, level-gated, scoped logger.
 *
 * Every manager owns a `Logger` tagged with its name so console output is easy
 * to trace and filter. In production builds (Vite `import.meta.env.DEV === false`)
 * the default level suppresses debug/info noise.
 */
import { IS_DEV } from '@/config/Constants';

/** Severity levels, ascending. Messages below {@link Logger.level} are dropped. */
export enum LogLevel {
  Debug = 0,
  Info = 1,
  Warn = 2,
  Error = 3,
  Silent = 4,
}

export class Logger {
  /** Global minimum level. Debug/info are silenced outside dev builds. */
  public static level: LogLevel = IS_DEV ? LogLevel.Debug : LogLevel.Warn;

  /** @param scope Short tag prefixed to every message, e.g. "SoundManager". */
  constructor(private readonly scope: string) {}

  /** Factory helper mirroring `new Logger(scope)`. */
  public static create(scope: string): Logger {
    return new Logger(scope);
  }

  public debug(...args: unknown[]): void {
    if (Logger.level <= LogLevel.Debug) console.debug(this.tag(), ...args);
  }

  public info(...args: unknown[]): void {
    if (Logger.level <= LogLevel.Info) console.info(this.tag(), ...args);
  }

  public warn(...args: unknown[]): void {
    if (Logger.level <= LogLevel.Warn) console.warn(this.tag(), ...args);
  }

  public error(...args: unknown[]): void {
    if (Logger.level <= LogLevel.Error) console.error(this.tag(), ...args);
  }

  /** Build the coloured `[scope]` prefix. */
  private tag(): string {
    return `[${this.scope}]`;
  }
}
