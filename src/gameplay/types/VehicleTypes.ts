/**
 * Vehicle definitions. Vehicles are data-driven; the vehicle entity and the
 * vehicle-movement component read these fields.
 */

/** Stable vehicle kinds. */
export type VehicleKind =
  | 'sedan'
  | 'taxi'
  | 'police'
  | 'policeSuv'
  | 'ambulance'
  | 'fireTruck'
  | 'sports'
  | 'luxury'
  | 'classic'
  | 'muscle'
  | 'truck'
  | 'van'
  | 'pickup'
  | 'suv'
  | 'bus'
  | 'motorcycle'
  | 'scooter'
  | 'bicycle'
  | 'delivery'
  | 'construction';

/** Engine families — drive the procedural engine audio and handling feel. */
export type EngineKind = 'car' | 'sport' | 'heavy' | 'motorcycle' | 'none';

import type { VehiclePhysicsDef } from '@/gameplay/vehicle/VehicleDynamicsTypes';

/** A complete vehicle specification. */
export interface VehicleDef {
  kind: VehicleKind;
  name: string;
  /** Texture key (top-down sprite facing "north"; frame 0 pristine, 1 damaged). */
  textureKey: string;
  maxHealth: number;
  /** Top speed in px/sec. */
  maxSpeed: number;
  /** Acceleration in px/sec². */
  accel: number;
  /** Steering rate in radians/sec. */
  turnRate: number;
  /** Physics body width (px). */
  width: number;
  /** Physics body height (px). */
  height: number;
  /** Palette tints for colour variety (empty = use texture as-is). */
  tints: number[];
  /** Emergency vehicle (police/ambulance/fire) — affects AI and audio. */
  isEmergency: boolean;
  /** Engine family for audio/feel ('none' = human-powered). */
  engine: EngineKind;
  /** Two-wheeler flag: narrow body, rider visible, no roof lights. */
  twoWheeler: boolean;
  /** Deterministic collision, grip, mass and impact tuning. */
  physics: VehiclePhysicsDef;
}
