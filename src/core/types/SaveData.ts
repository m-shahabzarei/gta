/**
 * Serialisation contracts for the save/load system.
 *
 * A save file is `SaveMeta` (human-facing metadata) plus a `sections` map,
 * where each key is the id of an {@link ISerializable} provider and the value
 * is that provider's opaque, JSON-safe snapshot. This keeps the SaveManager
 * ignorant of gameplay: it only orchestrates the providers.
 */

/** JSON-safe primitive/collection type. */
export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };

/** Human-facing metadata shown in the load menu. */
export interface SaveMeta {
  /** Save slot index (0-based). */
  slot: number;
  /** Display name for the save. */
  name: string;
  /** Schema version this file was written with (see `SAVE.SCHEMA_VERSION`). */
  version: number;
  /** Unix epoch (ms) the save was written. Supplied by the caller. */
  timestamp: number;
  /** Accumulated play time in seconds. */
  playtimeSeconds: number;
}

/** A complete save file. */
export interface SaveData {
  meta: SaveMeta;
  /** Provider-id → provider snapshot. */
  sections: Record<string, Json>;
}

/** Lightweight descriptor returned when listing existing saves. */
export interface SaveSlotInfo {
  slot: number;
  exists: boolean;
  meta: SaveMeta | null;
}
