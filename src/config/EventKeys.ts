/**
 * The complete catalogue of global event names emitted on the {@link EventBus}.
 *
 * Keeping the names here (rather than as inline strings) makes the event graph
 * discoverable and rename-safe. Each key is paired with a strongly-typed payload
 * in `core/types/EventTypes.ts` (see {@link EventPayloadMap}).
 *
 * Naming convention: `domain:verb` — e.g. `game:paused`, `resource:progress`.
 */
export enum EventKeys {
  // ── Game lifecycle ────────────────────────────────────────────────────────
  GameBooted = 'game:booted',
  GameStateChanged = 'game:state-changed',
  GamePaused = 'game:paused',
  GameResumed = 'game:resumed',
  GameMapRequested = 'game:map-requested',
  GameInventoryRequested = 'game:inventory-requested',
  GameInteriorRequested = 'game:interior-requested',
  GameNew = 'game:new',
  GameQuitToMenu = 'game:quit-to-menu',

  // ── Scene flow ────────────────────────────────────────────────────────────
  SceneReady = 'scene:ready',
  SceneShutdown = 'scene:shutdown',
  SceneTransition = 'scene:transition',

  // ── Resource loading ──────────────────────────────────────────────────────
  ResourceLoadStart = 'resource:load-start',
  ResourceProgress = 'resource:progress',
  ResourceFileComplete = 'resource:file-complete',
  ResourceLoadComplete = 'resource:load-complete',
  ResourceLoadError = 'resource:load-error',

  // ── Save / load ───────────────────────────────────────────────────────────
  SaveRequested = 'save:requested',
  SaveCompleted = 'save:completed',
  SaveLoadRequested = 'save:load-requested',
  SaveLoadCompleted = 'save:load-completed',
  SaveDeleted = 'save:deleted',
  SaveError = 'save:error',

  // ── Input ─────────────────────────────────────────────────────────────────
  InputActionDown = 'input:action-down',
  InputActionUp = 'input:action-up',
  InputAxisChanged = 'input:axis-changed',

  // ── Audio ─────────────────────────────────────────────────────────────────
  AudioPlaySound = 'audio:play-sound',
  AudioPlayMusic = 'audio:play-music',
  AudioStopMusic = 'audio:stop-music',
  AudioMusicChanged = 'audio:music-changed',
  AudioVolumeChanged = 'audio:volume-changed',
  AudioMuteToggled = 'audio:mute-toggled',

  // ── UI / HUD ──────────────────────────────────────────────────────────────
  UIShowHud = 'ui:show-hud',
  UIHideHud = 'ui:hide-hud',
  UIToast = 'ui:toast',
  UIHudUpdate = 'ui:hud-update',
  InteractionPromptChanged = 'ui:interaction-prompt-changed',
  InteractionContextChanged = 'ui:interaction-context-changed',
  WaypointChanged = 'ui:waypoint-changed',

  // ── Day / night & lighting ───────────────────────────────────────────────
  TimeChanged = 'time:changed',
  TimePhaseChanged = 'time:phase-changed',
  LightingChanged = 'lighting:changed',

  // ── Camera ────────────────────────────────────────────────────────────────
  CameraShake = 'camera:shake',
  CameraFlash = 'camera:flash',
  CameraFollow = 'camera:follow',
  CameraZoom = 'camera:zoom',

  // ── World ─────────────────────────────────────────────────────────────────
  WorldReady = 'world:ready',
  /** Active terrain/collision chunks were rebuilt around the player. */
  WorldStreamChanged = 'world:stream-changed',
  InteriorAmbienceChanged = 'interior:ambience-changed',

  // ── Player ────────────────────────────────────────────────────────────────
  PlayerSpawned = 'player:spawned',
  PlayerDamaged = 'player:damaged',
  PlayerDied = 'player:died',
  PlayerRespawned = 'player:respawned',
  PlayerHealthChanged = 'player:health-changed',
  PlayerVitalsChanged = 'player:vitals-changed',
  PlayerEnteredVehicle = 'player:entered-vehicle',
  PlayerExitedVehicle = 'player:exited-vehicle',
  PlayerInteract = 'player:interact',

  // ── Economy / inventory ───────────────────────────────────────────────────
  MoneyChanged = 'money:changed',
  WeaponSwitched = 'weapon:switched',
  WeaponAmmoChanged = 'weapon:ammo-changed',
  WeaponFired = 'weapon:fired',
  WeaponDropped = 'weapon:dropped',
  WeaponReloadStarted = 'weapon:reload-started',
  WeaponReloadFinished = 'weapon:reload-finished',
  PlayerArmorChanged = 'player:armor-changed',

  // ── Combat ────────────────────────────────────────────────────────────────
  EntityDamaged = 'combat:entity-damaged',
  EntityKilled = 'combat:entity-killed',
  BloodSpill = 'combat:blood-spill',
  ExplosionSpawned = 'combat:explosion',
  /** A player-originated shot connected with a hostile target. */
  HitConfirmed = 'combat:hit-confirmed',

  // ── Pedestrian AI ─────────────────────────────────────────────────────────
  /** A pedestrian took enough damage to collapse (downed, not dead). */
  PedestrianDowned = 'ped:downed',

  // ── Vehicles ──────────────────────────────────────────────────────────────
  VehicleDamaged = 'vehicle:damaged',
  VehicleDestroyed = 'vehicle:destroyed',
  VehicleEntered = 'vehicle:entered',
  VehicleExited = 'vehicle:exited',
  /** A vehicle slammed into geometry or another vehicle at speed. */
  VehicleCollision = 'vehicle:collision',
  /** The player's vehicle started or stopped skidding. */
  TireSkidChanged = 'vehicle:tire-skid',
  HornSounded = 'vehicle:horn',
  VehicleDoor = 'vehicle:door',
  VehicleSpawned = 'vehicle:spawned',
  VehicleRemoved = 'vehicle:removed',
  VehicleOccupancyChanged = 'vehicle:occupancy-changed',

  // ── Crime & wanted ────────────────────────────────────────────────────────
  CrimeCommitted = 'crime:committed',
  CrimeCreated = 'crime:created',
  CrimeObserved = 'crime:observed',
  CrimeReported = 'crime:reported',
  WantedChanged = 'wanted:changed',
  /** The police lost (or regained) sight of the player. */
  WantedSearchChanged = 'wanted:search-changed',
  PlayerBusted = 'wanted:busted',

  // ── Missions ──────────────────────────────────────────────────────────────
  MissionOffered = 'mission:offered',
  MissionStarted = 'mission:started',
  MissionObjectiveChanged = 'mission:objective-changed',
  MissionCompleted = 'mission:completed',
  MissionFailed = 'mission:failed',
  /** The world position the HUD compass/minimap should point at (or null). */
  MissionTargetChanged = 'mission:target-changed',

  // ── Pickups & collectibles ────────────────────────────────────────────────
  PickupCollected = 'pickup:collected',
  CollectibleFound = 'pickup:collectible-found',

  // ── Ambient audio cues ────────────────────────────────────────────────────
  Footstep = 'audio:footstep',
  EngineStateChanged = 'audio:engine-state',

  // ── Settings & weather ────────────────────────────────────────────────────
  SettingsChanged = 'settings:changed',
  WeatherChanged = 'weather:changed',
  /** A lightning strike during a storm (drives thunder audio + flash). */
  ThunderStrike = 'weather:thunder',
}
