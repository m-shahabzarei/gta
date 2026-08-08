/**
 * Centralised rendering depth (z-order) constants.
 *
 * Phaser sorts game objects within a scene by their `depth` value. Declaring
 * every layer here — instead of sprinkling magic numbers across the codebase —
 * keeps the visual stack coherent as new object types are added in Phase 2.
 *
 * Values are spaced by 100 so intermediate layers can be inserted later.
 */
export enum DepthLayers {
  Background = 0,
  Ground = 100,
  Roads = 200,
  RoadMarkings = 250,
  Sidewalks = 300,
  GroundDetail = 350,
  Water = 400,
  /** Tire skid-mark decals — above ground detail, below blood/shadows. */
  SkidMarks = 460,
  Shadows = 500,
  Vehicles = 600,
  /** Headlight cones, brake glow and indicators riding on vehicles. */
  VehicleLights = 620,
  Characters = 700,
  Projectiles = 800,
  BuildingsLow = 900,
  BuildingsHigh = 1000,
  Foliage = 1100,
  /** Airborne units (police helicopter) and their rotor. */
  AirUnits = 1150,
  Particles = 1200,
  Weather = 1300,
  Lighting = 1400,
  DayNightOverlay = 1500,
  HUD = 2000,
  UI = 2100,
  Overlay = 2200,
  DebugDraw = 9000,
}
