/**
 * City tile taxonomy.
 *
 * The numeric values are also the frame indices into the `CityTileset` texture
 * strip produced by the tileset art factory, so the map data, the rendered
 * tilemap and the collision layer all stay in lock-step.
 */
export enum TileType {
  Grass = 0,
  Road = 1,
  RoadLineH = 2,
  RoadLineV = 3,
  Sidewalk = 4,
  Water = 5,
  Building = 6,
  Crossing = 7,
  /** Beach / desert sand. */
  Sand = 8,
  /** Ploughed farmland rows. */
  Dirt = 9,
  /** Impassable rocky outcrop (mountains). */
  Rock = 10,
  /** Poured concrete (airport aprons, harbor pads, plazas). */
  Concrete = 11,
  /** Airport runway asphalt with centreline markings. */
  Runway = 12,
  /** Residential housing block (warm brick, pitched-roof look). */
  BuildingRes = 13,
  /** Industrial warehouse block (corrugated roof look). */
  BuildingInd = 14,
  /** Wooden dock planking over the harbor water. */
  Dock = 15,
  /** Walkable indoor floor stamped into enterable service buildings. */
  InteriorFloor = 16,
  /** Solid indoor partition / exterior wall for enterable buildings. */
  InteriorWall = 17,
  /** Walkable doorway tile joining the sidewalk to an interior. */
  InteriorDoor = 18,
  /** Transparent collision adapter beneath a composer-owned physical urban fixture. */
  UrbanFixture = 19,
  /** Indoor floor appearance with solid collision beneath substantial furniture. */
  InteriorFixture = 20,
}

/** Total number of tiles in the tileset strip (drives the atlas width). */
export const TILE_TYPE_COUNT = 21;

/** Tiles that block movement — used to set tilemap collision. */
export const SOLID_TILE_TYPES: readonly TileType[] = [
  TileType.Building,
  TileType.BuildingRes,
  TileType.BuildingInd,
  TileType.Water,
  TileType.Rock,
  TileType.InteriorWall,
  TileType.UrbanFixture,
  TileType.InteriorFixture,
];

/** Pedestrian-sized openings that only vehicle bodies must treat as solid. */
export const VEHICLE_ONLY_SOLID_TILE_TYPES: readonly TileType[] = [TileType.InteriorDoor];

/** Tiles that vehicles and the player may drive along. */
export const DRIVABLE_TILE_TYPES: readonly TileType[] = [
  TileType.Road,
  TileType.RoadLineH,
  TileType.RoadLineV,
  TileType.Crossing,
  TileType.Concrete,
  TileType.Runway,
];

/** The building-family tiles (any solid block with a roof). */
export const BUILDING_TILE_TYPES: readonly TileType[] = [
  TileType.Building,
  TileType.BuildingRes,
  TileType.BuildingInd,
];

/** Opaque tiles that block witness and combat sight lines. */
export const VISION_BLOCKING_TILE_TYPES: readonly TileType[] = [
  ...BUILDING_TILE_TYPES,
  TileType.Rock,
  TileType.InteriorWall,
  TileType.UrbanFixture,
];

/**
 * Tiles pedestrians treat as off-limits: solids (can't walk through them) plus
 * open road/runway surfaces away from a marked {@link TileType.Crossing} (they
 * don't jaywalk). Everything else — sidewalks, crossings, grass, sand, dirt,
 * concrete plazas, dock planking — is fair game for pedestrian navigation.
 */
export const PEDESTRIAN_BLOCKED_TILE_TYPES: readonly TileType[] = [
  ...SOLID_TILE_TYPES,
  TileType.Road,
  TileType.RoadLineH,
  TileType.RoadLineV,
  TileType.Runway,
];
