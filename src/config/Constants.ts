/**
 * Global, engine-wide constants.
 *
 * These are compile-time tunables that are not tied to any single manager.
 * Gameplay-balance numbers (weapon damage, NPC counts, …) intentionally live
 * with their Phase 2 systems, not here.
 */

/** Native rendering resolution. The canvas is scaled up to fit the window. */
export const GAME_WIDTH = 1280;
export const GAME_HEIGHT = 720;

/** Base tile size (pixels) shared by the Tiled maps and placeholder textures. */
export const TILE_SIZE = 32;

/**
 * Logical world size in tiles.  The world is deliberately much larger than a
 * single city: Tehran occupies the southern metro, Yazd sits beyond the eastern
 * desert corridor, and Gilan lives on the wet northern coast.  Rendered tiles
 * are streamed in chunks by WorldManager, so this does not mean all geometry is
 * resident at once.
 */
export const WORLD_TILES_X = 1920;
export const WORLD_TILES_Y = 1408;

/** World bounds in pixels, derived from the tile grid. */
export const WORLD_WIDTH = WORLD_TILES_X * TILE_SIZE;
export const WORLD_HEIGHT = WORLD_TILES_Y * TILE_SIZE;

/** Fixed simulation constants for Arcade Physics. */
export const PHYSICS = {
  /** Top-down game — no global gravity. */
  GRAVITY_X: 0,
  GRAVITY_Y: 0,
  /** Enable the debug draw only when explicitly toggled. */
  DEBUG: false,
} as const;

/** Camera defaults. */
export const CAMERA = {
  DEFAULT_ZOOM: 2,
  MIN_ZOOM: 1,
  MAX_ZOOM: 4,
  /** Linear interpolation factor for smooth follow (0..1). */
  LERP: 0.1,
} as const;

/** Audio defaults (0..1). */
export const AUDIO = {
  MASTER_VOLUME: 1,
  MUSIC_VOLUME: 0.6,
  SFX_VOLUME: 0.9,
  /** Cross-fade duration between music tracks, in milliseconds. */
  MUSIC_FADE_MS: 800,
} as const;

/** Day/night cycle configuration. */
export const TIME = {
  /** Real seconds for one full in-game day. */
  SECONDS_PER_DAY: 1200,
  /** In-game hour the world starts at. */
  START_HOUR: 8,
} as const;

/** Persistence configuration. */
export const SAVE = {
  /** `localStorage` key prefix for every save slot. */
  STORAGE_PREFIX: 'pixel-city:save',
  /** Number of available manual save slots. */
  SLOT_COUNT: 3,
  /** Schema version — bump when the SaveData shape changes. */
  SCHEMA_VERSION: 1,
} as const;

/** Colour palette used by procedural placeholder art and UI. */
export const COLORS = {
  BACKGROUND: 0x0a0a0f,
  GRASS: 0x2e5d34,
  ROAD: 0x3a3a42,
  ROAD_LINE: 0xd9c85a,
  SIDEWALK: 0x9aa0a6,
  WATER: 0x2b6d8c,
  BUILDING: 0x6b6f7a,
  ACCENT: 0xffcc33,
  UI_PANEL: 0x14141c,
  UI_BORDER: 0x3a3a4a,
  TEXT: 0xf4f4f8,
  HEALTH: 0xe4405f,
  MONEY: 0x53d769,
} as const;

// ── Phase 2 gameplay balance ─────────────────────────────────────────────────

/** Player tuning. */
export const PLAYER = {
  MAX_HEALTH: 100,
  MAX_ARMOR: 100,
  WALK_SPEED: 92,
  RUN_SPEED: 168,
  RADIUS: 9,
  RESPAWN_INVULN_MS: 2200,
  INTERACT_RANGE: 44,
  /** Exact wallet balance owned by a newly constructed player inventory. */
  START_MONEY: 700,
} as const;

/** Pedestrian tuning. */
export const PED = {
  MAX_HEALTH: 40,
  WALK_SPEED: 52,
  FLEE_SPEED: 122,
  MAX_ACTIVE: 190,
  /** Ring (px) around the player just outside which pedestrians spawn. */
  SPAWN_RADIUS: 760,
  /** Distance (px) from the player beyond which pedestrians despawn. */
  DESPAWN_RADIUS: 1120,
  RADIUS: 8,
} as const;

/** Vehicle tuning. */
export const VEHICLE = {
  MAX_HEALTH: 100,
  MAX_TRAFFIC: 96,
  TRAFFIC_SPEED: 74,
  ACCEL: 280,
  MAX_SPEED: 320,
  REVERSE_SPEED: 130,
  /** Steering rate in radians/second at speed. */
  TURN_RATE: 2.7,
  FRICTION: 240,
  EXPLOSION_DAMAGE: 65,
  EXPLOSION_RADIUS: 96,
  ENTER_RANGE: 48,
  /** Minimum speed loss (px/s) in one frame that registers as a crash. */
  CRASH_MIN_SPEED: 165,
  /** Hit-point damage per px/s of crash speed beyond the threshold. */
  CRASH_DAMAGE_SCALE: 0.09,
  /** Health ratio below which a vehicle swaps to its damaged frame. */
  DAMAGED_FRAME_RATIO: 0.55,
  /** Health ratio below which a vehicle trails engine smoke. */
  SMOKE_RATIO: 0.35,
} as const;

/** Combat tuning. */
export const COMBAT = {
  BULLET_SPEED: 640,
  BULLET_LIFESPAN_MS: 900,
  MAX_BULLETS: 160,
  BLOOD_LIFESPAN_MS: 9000,
  /** Maximum blood decals kept alive at once (oldest are reaped first). */
  MAX_BLOOD_DECALS: 48,
  /** Maximum skid-mark decals kept alive at once. */
  MAX_SKID_MARKS: 96,
} as const;

/** Police wanted-system tuning. */
export const WANTED = {
  MAX_LEVEL: 5,
  /** Time (ms) with no fresh crime before one wanted star decays. */
  DECAY_MS: 9000,
  /** Decay accelerator applied while the police have lost sight of the player. */
  SEARCH_DECAY_FACTOR: 3,
  /** Time (ms) without police line-of-sight before search mode engages. */
  SEARCH_AFTER_MS: 6000,
  /** Distance (px) within which an officer "sees" the player. */
  SIGHT_RANGE: 360,
  MAX_POLICE: 12,
  POLICE_HEALTH: 60,
  SWAT_HEALTH: 110,
  POLICE_SPEED: 150,
  POLICE_SHOOT_RANGE: 270,
  POLICE_ARREST_RANGE: 28,
  SPAWN_RADIUS: 720,
  /** Wanted level at which police cruisers join the pursuit. */
  CAR_LEVEL: 2,
  /** Wanted level at which SWAT officers are dispatched. */
  SWAT_LEVEL: 4,
  /** Wanted level at which roadblocks with spike strips are deployed. */
  ROADBLOCK_LEVEL: 4,
  /** Wanted level at which the police helicopter is dispatched. */
  HELI_LEVEL: 5,
  /** Maximum simultaneous pursuit cars. */
  MAX_PURSUIT_CARS: 6,
  /** Minimum time between upward star transitions, even under heavy report load. */
  ESCALATION_INTERVAL_MS: 2400,
  /** Patrols lose positive identification after this much broken line of sight. */
  IDENTIFICATION_LOST_MS: 2800,
  /** Search duration per current star before heat can fall. */
  SEARCH_STAR_MS: 12500,
  /** Desired living patrol fleet while the city is calm. */
  AMBIENT_PATROL_COUNT: 4,
} as const;

/** Witness perception and reporting budgets. */
export const CRIME = {
  INCIDENT_LIFETIME_MS: 30000,
  DUPLICATE_WINDOW_MS: 180,
  CIVILIAN_SIGHT_RANGE: 330,
  POLICE_SIGHT_RANGE: 430,
  VEHICLE_SIGHT_RANGE: 390,
  CIVILIAN_REPORT_MIN_MS: 1100,
  CIVILIAN_REPORT_MAX_MS: 4200,
  POLICE_REPORT_DELAY_MS: 180,
  MAX_WITNESSES_PER_INCIDENT: 12,
} as const;

/** Seat rendering and physical transition tuning. */
export const OCCUPANTS = {
  RENDER_RANGE: 720,
  DOOR_OPEN_MS: 220,
  EXIT_MS: 360,
  FALL_MS: 420,
  BOARD_MS: 420,
  DOOR_CLOSE_MS: 220,
  CARJACK_MAX_SPEED: 34,
} as const;

/** Procedural city-generation tuning (in tiles). */
export const CITY = {
  BLOCK_TILES: 7,
  ROAD_TILES: 3,
  SIDEWALK_TILES: 1,
} as const;

/** Whether verbose logging is enabled (driven by Vite's DEV flag). */
/** Vite defines this in-game; the fallback keeps offline validation modules loadable in Node. */
export const IS_DEV = import.meta.env?.DEV ?? false;
