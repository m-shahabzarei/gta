import type { Json } from '@/core/types';

/**
 * Implemented by any system that contributes state to a save file.
 *
 * Providers register themselves with the SaveManager, which collects each
 * `serialize()` snapshot under the provider's `saveId` and restores it later by
 * calling `deserialize()`. The SaveManager never needs to know what the data
 * means — this keeps persistence fully decoupled from gameplay.
 */
export interface ISerializable {
  /** Stable, unique id under which this provider's data is stored. */
  readonly saveId: string;

  /** Produce a JSON-safe snapshot of the current state. */
  serialize(): Json;

  /**
   * Restore state from a previously produced snapshot.
   * @param data The value previously returned by {@link serialize}.
   */
  deserialize(data: Json): void;
}

/** Runtime type-guard for {@link ISerializable}. */
export function isSerializable(value: unknown): value is ISerializable {
  const v = value as ISerializable | null;
  return (
    typeof v?.saveId === 'string' &&
    typeof v?.serialize === 'function' &&
    typeof v?.deserialize === 'function'
  );
}
