import type { Vector2 } from '@/core/types/Common';
import type { DamageAttribution } from './CombatTypes';

/** Player actions that can become known to law enforcement. */
export type CrimeType =
  | 'gunfire'
  | 'assault'
  | 'murder'
  | 'vehicle-theft'
  | 'hit-and-run'
  | 'police-assault'
  | 'explosion';

export type WitnessKind = 'civilian' | 'police-officer' | 'police-vehicle' | 'security';

export type WitnessReaction =
  | 'ignore'
  | 'run'
  | 'panic'
  | 'hide'
  | 'call-police'
  | 'scream'
  | 'point'
  | 'freeze'
  | 'help'
  | 'fight';

/** Stable traits carried by pedestrians and seated vehicle occupants. */
export interface NpcPersonality {
  bravery: number;
  lawfulness: number;
  panic: number;
  aggression: number;
  helpfulness: number;
  awareness: number;
}

/** Immutable record of an action before anybody has reported it. */
export interface CrimeIncident {
  id: number;
  crime: CrimeType;
  position: Vector2;
  occurredAt: number;
  attribution: DamageAttribution;
  suspectEntityId: number | null;
  suspectVehicleId: number | null;
}

/** A witness who genuinely perceived an incident. */
export interface CrimeObservation {
  incidentId: number;
  witnessId: number;
  witnessKind: WitnessKind;
  reaction: WitnessReaction;
  observedAt: number;
  reportDueAt: number | null;
}

/** Information law enforcement receives after a witness finishes reporting. */
export interface CrimeReport {
  incidentId: number;
  crime: CrimeType;
  position: Vector2;
  witnessId: number;
  witnessKind: WitnessKind;
  reportedAt: number;
  attribution: DamageAttribution;
  suspectEntityId: number | null;
  suspectVehicleId: number | null;
}

export type WantedPhase = 'clear' | 'responding' | 'pursuit' | 'searching' | 'cooldown';

export type PoliceDirectiveMode =
  'patrol' | 'investigate' | 'respond' | 'take-cover' | 'arrest' | 'engage' | 'search' | 'return';

/** Per-officer command derived only from police knowledge. */
export interface PoliceDirective {
  mode: PoliceDirectiveMode;
  target: Vector2 | null;
  cover: Vector2 | null;
  allowLethalForce: boolean;
  vehicleId: number | null;
}
