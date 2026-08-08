/**
 * Mission definitions. Missions are a sequence of objectives; the mission
 * system tracks progress and pays out a reward on completion.
 */

/** The kinds of objective the mission system knows how to track. */
export enum ObjectiveKind {
  /** Reach a world position within a radius. */
  GoTo = 'go-to',
  /** Kill a number of targets. */
  Eliminate = 'eliminate',
  /** Steal (enter) any vehicle. */
  StealVehicle = 'steal-vehicle',
  /** Stay alive for a duration (ms). */
  Survive = 'survive',
  /** Destroy a number of vehicles. */
  DestroyVehicles = 'destroy-vehicles',
}

/** A single objective within a mission. */
export interface ObjectiveDef {
  kind: ObjectiveKind;
  /** Player-facing description, e.g. "Reach the docks". */
  description: string;
  /** Count target for Eliminate; duration ms for Survive. */
  target?: number;
  /** Destination for GoTo objectives. */
  x?: number;
  y?: number;
  /** Trigger radius for GoTo (px). */
  radius?: number;
}

/** A complete mission. */
export interface MissionDef {
  id: string;
  title: string;
  briefing: string;
  /** Cash reward on completion. */
  reward: number;
  /** Where the start marker sits in the world. */
  markerX: number;
  markerY: number;
  objectives: ObjectiveDef[];
  /** Optional overall time limit (ms); the run fails when it expires. */
  timeLimitMs?: number;
}
