/**
 * Canonical identifiers used to register and resolve engine services through
 * the {@link ServiceLocator}.
 *
 * Every manager/system exposes its key as its `readonly key` property, so the
 * registry and the locator can never drift apart.
 */
export enum ServiceKeys {
  /** Cached mobile/touch detection, safe-area and orientation state. */
  Platform = 'MobilePlatform',
  Game = 'GameManager',
  Resource = 'ResourceManager',
  Input = 'InputManager',
  Animation = 'AnimationManager',
  Sound = 'SoundManager',
  Music = 'MusicManager',
  UI = 'UIManager',
  Particle = 'ParticleManager',
  Save = 'SaveManager',
  Camera = 'CameraManager',
  Lighting = 'LightingSystem',
  DayNight = 'DayNightSystem',
  /** Central lifecycle, LOD, visibility and physics scheduler for all entities. */
  Entity = 'EntityManager',
  /** F3 developer overlay and low-overhead engine telemetry. */
  Profiler = 'ProfilerSystem',

  // ── Phase 2 gameplay systems ─────────────────────────────────────────────
  /** Owns the procedural city map, tilemap collision and spawn metadata. */
  World = 'WorldManager',
  /** Draws and drives real enterable building interiors inside the city map. */
  Interior = 'WorldInteriorSystem',
  /** Pathfinding + local-avoidance queries for AI (grid-based, request-queued). */
  Navigation = 'NavigationSystem',
  /** Ambulance / paramedic dispatch for downed or killed civilians. */
  Emergency = 'EmergencyResponseSystem',
  /** Owns the player entity, camera follow, vehicle entry/exit and respawn. */
  Player = 'PlayerController',
  /** Spawns and updates ambient pedestrians around the player. */
  Pedestrian = 'PedestrianSystem',
  /** Spawns and updates AI traffic and drives the traffic lights. */
  Traffic = 'TrafficSystem',
  /** City-specific bus, taxi, passenger, fare and transit-map coordination. */
  Transportation = 'TransportationSystem',
  /** Registry of all vehicles; handles damage, explosions and occupancy. */
  Vehicle = 'VehicleSystem',
  /** Persistent people seated in vehicles and their door/exit transitions. */
  Occupants = 'VehicleOccupantSystem',
  /** Bullet pool, hit resolution, blood/explosion effects and damage. */
  Combat = 'CombatSystem',
  /** Raw incidents, perception, witness reactions and delayed police reports. */
  Crime = 'CrimeSystem',
  /** Tracks the police wanted level and spawns/commands the police. */
  Wanted = 'WantedSystem',
  /** Drives mission markers, objectives, rewards and progression. */
  Mission = 'MissionSystem',
  /** Procedurally synthesises gameplay sound effects (no audio files). */
  GameAudio = 'GameAudioSystem',
  /** Persistent user settings (graphics/audio/controls/language/display). */
  Settings = 'SettingsManager',
  /** Dynamic weather: rain, fog and wind particle effects. */
  Weather = 'WeatherSystem',
  /** Ambient city life: animals, random events, patrols, crowd flavour. */
  CityLife = 'CityLifeSystem',
  /** World pickups: supplies, weapon drops and hidden collectibles. */
  Pickup = 'PickupSystem',
  /** Contextual interaction prompts and generic E-key interactions. */
  Interaction = 'InteractionSystem',
  /** Interactable services: gun shops, hospitals and gas stations. */
  Shop = 'ShopSystem',
  /** Vehicle side gigs: taxi fares, vigilante, delivery and street races. */
  SideGig = 'SideGigSystem',
}

/** Union of every valid service key string. */
export type ServiceKey = `${ServiceKeys}`;
