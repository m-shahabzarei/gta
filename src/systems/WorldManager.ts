/**
 * WorldManager — owns the procedural open world: its {@link MapData}, the
 * rendered Phaser tilemap + collision layer, chunk-streamed decoration, and the
 * service markers (hospitals / police / fire / gas / gun-shops).
 *
 * The map is produced once, deterministically, by the internal
 * {@link CityGenerator} in {@link onInit}: one country-sized world divided into
 * named {@link District}s and built from an authoritative urban plan. Roads,
 * junctions and merged blocks are finalized first; varied building footprints,
 * entrances, traffic data, service buildings, collectibles and race starts are
 * derived only after the accepted road graph has been rasterized.
 *
 * The scene-scoped tilemap and fixed markers are (re)built on attach and torn
 * down on shutdown. Ambient decoration (trees, lamps, cacti, rocks, crates) is
 * NOT placed all at once — it is streamed per 32-tile chunk around the player
 * each frame so a world 4× the old size still stays light. The manager also
 * implements {@link IWorldQuery}, the narrow read-only surface AI systems use
 * to test collision and pick spawn points — resolved through
 * {@link ServiceKeys.World}.
 */
import Phaser from 'phaser';
import { BaseSceneManager } from '@/core/BaseSceneManager';
import { ServiceKeys } from '@/config/ServiceKeys';
import { EventKeys } from '@/config/EventKeys';
import { DepthLayers } from '@/config/DepthLayers';
import { TextureKeys } from '@/config/AssetKeys';
import {
  CITY,
  PED,
  TILE_SIZE,
  WORLD_HEIGHT,
  WORLD_TILES_X,
  WORLD_TILES_Y,
  WORLD_WIDTH,
} from '@/config/Constants';
import {
  DRIVABLE_TILE_TYPES,
  PEDESTRIAN_BLOCKED_TILE_TYPES,
  PHYSICAL_GROUND_FEATURE_KINDS,
  SOLID_TILE_TYPES,
  VEHICLE_ONLY_SOLID_TILE_TYPES,
  VISION_BLOCKING_TILE_TYPES,
  TileType,
  District,
} from '@/gameplay/types';
import type {
  BenchSite,
  BusStopSite,
  BuildingInterior,
  BuildingEntrance,
  CityId,
  CrossingInfo,
  HighwayQualityReport,
  HighwayRoute,
  InteriorObjectInfo,
  IWorldQuery,
  MapData,
  MapOverview,
  MajorBuildingDefinition,
  MajorBuildingVariant,
  PlannedBlockProgram,
  PlannedBuilding,
  PlannedBuildingArchetype,
  PlannedBuildingKind,
  PlannedBuildingLot,
  PlannedBuildingMaterial,
  PlannedEntrance,
  PlannedFacing,
  PlannedGroundFeature,
  PlannedGroundFloorUse,
  PlannedIntersection,
  PlannedLandUse,
  PlannedRoadSegment,
  PlannedRoofStyle,
  PlannedTilePoint,
  PlannedUrbanSpace,
  PlannedUrbanBlock,
  RoadEdge,
  RoadIntersectionData,
  RoadNode,
  SafePedestrianPlacementOptions,
  TrafficLightInfo,
  UrbanPlanData,
  UrbanQualityReport,
  WorldCity,
  WorldLandmark,
  WorldStreamZone,
  WorldValidationReport,
} from '@/gameplay/types';
import type { InteriorKind } from '@/gameplay/types';
import type { Vector2 } from '@/core/types';
import { getPlayerRef } from '@/gameplay/types';
import {
  isCircleClearOnGrid,
  isCircleSegmentClearOnGrid,
  resolveCirclePositionOnGrid,
  type SolidTileGrid,
} from '@/gameplay/world/SafePedestrianPlacement';
import { interiorNpcSpawnPosition } from '@/gameplay/world/InteriorNpcPlacement';
import { MajorBuildingRegistry } from '@/gameplay/major-buildings';
import {
  createMajorInteriorLayout,
  type MajorInteriorLayout,
} from '@/gameplay/major-buildings';
import { QuadTree, Random, random } from '@/utils';
import { ArchitectureComposer } from '@/graphics/ArchitectureComposer';
import {
  composeBlockArchitecture,
  selectBuildingMaterial,
  selectFacadeStyle,
  selectRoofStyle,
} from '@/generation/ArchitectureGrammar';
import { UrbanPlanner } from '@/generation/UrbanPlanner';
import { HighwayPlanner } from '@/generation/HighwayPlanner';
import {
  HighwayGeometryIndex,
  HighwayRenderSystem,
  type HighwayChunkHandle,
  type HighwayRenderLod,
  type HighwayRenderStats,
} from '@/gameplay/highway';

/** Fixed seed so every run generates byte-for-byte the same world. */
const CITY_SEED = 1337;

/** Tile widths of the repeating city cell, derived from {@link CITY} tuning. */
const ROAD_W = CITY.ROAD_TILES;
const SIDE_W = CITY.SIDEWALK_TILES;
const BLOCK_W = CITY.BLOCK_TILES;
/** Full period of the road/sidewalk/block/sidewalk lattice, in tiles. */
const PERIOD = ROAD_W + SIDE_W + BLOCK_W + SIDE_W;
/** Index of the centre lane within a road band (carries the lane marking). */
const ROAD_MID = Math.floor(ROAD_W / 2);

/** Chunk edge length, in tiles, used by the terrain + decoration streamer. */
const CHUNK_TILES = 32;
/** Chunk radius (in chunks) kept fully rendered around the player. */
const CHUNK_RADIUS = 1;
/** Inner chunk radius receiving rich props rather than terrain-only LOD. */
const DETAIL_CHUNK_RADIUS = 0;
/** Main-thread chunk work budget; at least one queued operation is allowed per frame. */
const CHUNK_BUILD_BUDGET_MS = 4;
const MAX_CHUNK_OPERATIONS_PER_FRAME = 1;
/** Keep anchor-owned architecture visible when a large footprint crosses a chunk edge. */
const CHUNK_CULL_MARGIN = CHUNK_TILES * TILE_SIZE;
const CHUNK_VISIBILITY_CELL = 96;
/** Bucket edge for repeated nearby spawn queries from crowd/traffic streaming. */
const SPAWN_QUERY_CELL_PX = 256;
/** Existing TrafficNetwork clearance requires every graph edge to exceed 126 pixels. */
const MIN_TRAFFIC_EDGE_LENGTH_PX = 127;

/** Drivable-tile membership set, precomputed for fast lookups. */
const DRIVABLE_SET = new Set<number>(DRIVABLE_TILE_TYPES);
/** Asphalt owned by the accepted road plan (concrete plazas are deliberately excluded). */
const PLANNED_ROAD_SURFACE_SET = new Set<number>([
  TileType.Road,
  TileType.RoadLineH,
  TileType.RoadLineV,
  TileType.Crossing,
]);
/** Solid-tile membership set, precomputed for fast lookups. */
const SOLID_SET = new Set<number>(SOLID_TILE_TYPES);
/** Opaque terrain membership set, distinct from collision and pathing rules. */
const VISION_BLOCKING_SET = new Set<number>(VISION_BLOCKING_TILE_TYPES);
/** Pedestrian-blocked tile membership set, precomputed for fast lookups. */
const PEDESTRIAN_BLOCKED_SET = new Set<number>(PEDESTRIAN_BLOCKED_TILE_TYPES);

/** Maximum sidewalk benches placed across the whole city. */
const MAX_BENCHES = 150;
/** One bench is sampled per this many sidewalk spawn points, roughly. */
const BENCH_STRIDE = 45;
/** Maximum bus stops placed across the city. */
const MAX_BUS_STOPS = 90;
/** One bus stop is sampled per this many sidewalk spawn points, roughly. */
const BUS_STOP_STRIDE = 86;
/** Cosmetic sit-facing choices, cycled deterministically per bench. */
const CARDINAL_FACINGS = [0, Math.PI / 2, Math.PI, -Math.PI / 2] as const;

/** Convert tile-grid coordinates into world-space centres. */
function tileCenter(tx: number, ty: number): Vector2 {
  return { x: tx * TILE_SIZE + TILE_SIZE / 2, y: ty * TILE_SIZE + TILE_SIZE / 2 };
}

/** Bounds are authored in tiles but exposed to the rest of the game in pixels. */
function tileBounds(x: number, y: number, width: number, height: number) {
  return {
    x: x * TILE_SIZE,
    y: y * TILE_SIZE,
    width: width * TILE_SIZE,
    height: height * TILE_SIZE,
  };
}

/** Inclusive tile-space containment helper. */
function inTileRect(tx: number, ty: number, rect: TileRect): boolean {
  return tx >= rect.x && ty >= rect.y && tx < rect.x + rect.width && ty < rect.y + rect.height;
}

interface TileRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type RequiredArchitectureLandmarkId =
  'tehran-financial' | 'tehran-government' | 'tehran-stadium' | 'yazd-mosque';

interface RequiredArchitectureLandmark {
  id: RequiredArchitectureLandmarkId;
  cityId: CityId;
  anchor: { x: number; y: number };
  program: PlannedBlockProgram;
  landUse: PlannedLandUse;
  purposefulOpenSpace: boolean;
  densityTarget: number;
  minimumWidth: number;
  minimumHeight: number;
  /** Minimum short-axis span of the landmark's primary physical building. */
  minimumBuildingSpan: number;
  preferredDistricts: readonly District[];
  preferredPrograms: readonly PlannedBlockProgram[];
  requiredKind: PlannedBuildingKind;
}

/** Major city footprints; Tehran alone exceeds three times the former 256² map. */
const TEHRAN_RECT: TileRect = { x: 120, y: 720, width: 1020, height: 620 };
const GILAN_RECT: TileRect = { x: 100, y: 70, width: 520, height: 390 };
const YAZD_RECT: TileRect = { x: 1450, y: 500, width: 360, height: 390 };

/** Sub-regions authored as tile rectangles for precise city identities. */
const TEHRAN_AIRPORT_RECT: TileRect = { x: 860, y: 780, width: 250, height: 170 };
const TEHRAN_GOVERNMENT_RECT: TileRect = { x: 490, y: 880, width: 160, height: 100 };
const TEHRAN_UNIVERSITY_RECT: TileRect = { x: 250, y: 840, width: 170, height: 130 };
const TEHRAN_INDUSTRIAL_RECT: TileRect = { x: 830, y: 1110, width: 270, height: 180 };
const GILAN_MARINA_RECT: TileRect = { x: 112, y: 260, width: 120, height: 110 };
const YAZD_MINING_RECT: TileRect = { x: 1690, y: 760, width: 100, height: 100 };

/**
 * World-map destinations which must also exist as physical architecture.
 * Anchors are in tile space and match the discoverable landmarks emitted by
 * {@link CityGenerator.buildLandmarks}.
 */
const REQUIRED_ARCHITECTURE_LANDMARKS: readonly RequiredArchitectureLandmark[] = [
  {
    id: 'tehran-financial',
    cityId: 'tehran',
    anchor: { x: 690, y: 1010 },
    program: 'financial-center',
    landUse: 'office',
    purposefulOpenSpace: false,
    densityTarget: 0.52,
    minimumWidth: 11,
    minimumHeight: 11,
    minimumBuildingSpan: 8,
    preferredDistricts: [District.Downtown, District.Commercial],
    preferredPrograms: ['financial-center', 'office-complex', 'shopping-center', 'hotel'],
    requiredKind: 'tower',
  },
  {
    id: 'tehran-government',
    cityId: 'tehran',
    anchor: { x: 565, y: 930 },
    program: 'government-complex',
    landUse: 'public-service',
    purposefulOpenSpace: false,
    densityTarget: 0.38,
    minimumWidth: 12,
    minimumHeight: 10,
    minimumBuildingSpan: 7,
    preferredDistricts: [District.Government, District.Downtown],
    preferredPrograms: ['government-complex', 'office-complex', 'public-plaza', 'hospital'],
    requiredKind: 'government',
  },
  {
    id: 'tehran-stadium',
    cityId: 'tehran',
    anchor: { x: 430, y: 1260 },
    program: 'stadium',
    landUse: 'institutional',
    purposefulOpenSpace: true,
    densityTarget: 0.2,
    minimumWidth: 16,
    minimumHeight: 14,
    minimumBuildingSpan: 5,
    preferredDistricts: [District.University, District.Park, District.Residential],
    preferredPrograms: [
      'stadium',
      'sports-center',
      'university-campus',
      'playground',
      'small-park',
      'public-plaza',
    ],
    requiredKind: 'stadium',
  },
  {
    id: 'yazd-mosque',
    cityId: 'yazd',
    anchor: { x: 1510, y: 565 },
    // The block program remains a civic compound; the reserved primary lot is
    // specialized below as a mosque until mosque becomes a first-class zone.
    program: 'government-complex',
    landUse: 'public-service',
    purposefulOpenSpace: false,
    densityTarget: 0.38,
    minimumWidth: 12,
    minimumHeight: 10,
    minimumBuildingSpan: 8,
    preferredDistricts: [District.Historic, District.Bazaar, District.OldTown],
    preferredPrograms: ['government-complex', 'public-plaza', 'market', 'school'],
    requiredKind: 'mosque',
  },
];

/** Classification of a single axis coordinate within one {@link PERIOD}. */
interface AxisInfo {
  road: boolean;
  roadMid: boolean;
  sidewalk: boolean;
}

/**
 * Classify a coordinate by its offset within the repeating city period:
 * `[road … | sidewalk | block … | sidewalk]`.
 */
function classifyAxis(offset: number): AxisInfo {
  if (offset < ROAD_W) {
    return { road: true, roadMid: offset === ROAD_MID, sidewalk: false };
  }
  if (offset < ROAD_W + SIDE_W) {
    return { road: false, roadMid: false, sidewalk: true };
  }
  if (offset < ROAD_W + SIDE_W + BLOCK_W) {
    return { road: false, roadMid: false, sidewalk: false };
  }
  return { road: false, roadMid: false, sidewalk: true };
}

/** How each district renders its lattice cells. */
interface DistrictStyle {
  /** Interior block fill for this district. */
  block: (rng: Random) => TileType;
  /** Whether the cell keeps the road/sidewalk lattice (false = flooded). */
  hasRoads: boolean;
  /** Tile flooding the whole cell when {@link hasRoads} is false. */
  flood?: TileType;
  /** Overrides the road tiles (e.g. airport runway/concrete). */
  roadTile?: TileType;
  /** Overrides the sidewalk tiles (e.g. airport concrete apron). */
  sidewalkTile?: TileType;
}

/** Service positions selected from real building entrances. */
interface ServiceSites {
  hospitals: Vector2[];
  policeStations: Vector2[];
  fireStations: Vector2[];
  gasStations: Vector2[];
  gunShops: Vector2[];
  garages: Vector2[];
  safeHouses: Vector2[];
}

type ServiceArchitectureRole =
  'hospital' | 'police' | 'fire-station' | 'gas-station' | 'gun-shop' | 'garage' | 'safe-house';

interface InteriorBuildResult {
  interiors: BuildingInterior[];
  spawns: Vector2[];
}

interface RoadBuildResult {
  nodes: RoadNode[];
  edges: RoadEdge[];
}

interface ArchitectureOwnershipAudit {
  unownedBuildingTiles: number;
  footprintMismatches: number;
  inaccessibleEntrances: number;
  inaccessibleEntranceSamples: string[];
  missingSiteContent: number;
  missingSiteContentSamples: string[];
  cityStyleViolations: number;
}

type SpawnIndex = Map<string, Vector2[]>;

/** Per-district rendering rules. */
const DISTRICT_STYLES: Record<District, DistrictStyle> = {
  [District.Downtown]: { block: () => TileType.Concrete, hasRoads: true },
  [District.Commercial]: {
    block: (r) => (r.chance(0.15) ? TileType.Grass : TileType.Concrete),
    hasRoads: true,
  },
  [District.Residential]: {
    block: () => TileType.Grass,
    hasRoads: true,
  },
  [District.Luxury]: {
    block: () => TileType.Grass,
    hasRoads: true,
  },
  [District.OldTown]: { block: () => TileType.Grass, hasRoads: true },
  [District.Government]: { block: () => TileType.Concrete, hasRoads: true },
  [District.University]: {
    block: (r) => (r.chance(0.35) ? TileType.Grass : TileType.Concrete),
    hasRoads: true,
  },
  [District.Industrial]: {
    block: () => TileType.Concrete,
    hasRoads: true,
  },
  [District.Harbor]: {
    block: () => TileType.Concrete,
    hasRoads: true,
    sidewalkTile: TileType.Concrete,
  },
  [District.Airport]: {
    block: () => TileType.Concrete,
    hasRoads: true,
    roadTile: TileType.Runway,
    sidewalkTile: TileType.Concrete,
  },
  [District.Historic]: {
    block: () => TileType.Sand,
    hasRoads: true,
    sidewalkTile: TileType.Sand,
  },
  [District.Bazaar]: {
    block: () => TileType.Sand,
    hasRoads: true,
    sidewalkTile: TileType.Sand,
  },
  [District.Village]: {
    block: () => TileType.Sand,
    hasRoads: true,
    sidewalkTile: TileType.Sand,
  },
  [District.Mining]: {
    block: (r) => (r.chance(0.45) ? TileType.Rock : TileType.Concrete),
    hasRoads: true,
    sidewalkTile: TileType.Dirt,
  },
  [District.Marina]: {
    block: () => TileType.Concrete,
    hasRoads: true,
    sidewalkTile: TileType.Concrete,
  },
  [District.RiceFields]: { block: () => TileType.Dirt, hasRoads: false, flood: TileType.Dirt },
  [District.TeaFarm]: { block: () => TileType.Grass, hasRoads: false, flood: TileType.Grass },
  [District.Beach]: {
    block: () => TileType.Sand,
    hasRoads: true,
    sidewalkTile: TileType.Sand,
  },
  [District.Ocean]: { block: () => TileType.Water, hasRoads: false, flood: TileType.Water },
  [District.Park]: { block: () => TileType.Grass, hasRoads: true },
  [District.Forest]: {
    block: () => TileType.Grass,
    hasRoads: false,
    flood: TileType.Grass,
    sidewalkTile: TileType.Grass,
  },
  [District.Mountains]: {
    block: (r) => (r.chance(0.8) ? TileType.Rock : TileType.Grass),
    hasRoads: false,
    flood: TileType.Rock,
  },
  [District.Desert]: {
    block: () => TileType.Sand,
    hasRoads: false,
    flood: TileType.Sand,
    sidewalkTile: TileType.Sand,
  },
  [District.Farmland]: {
    block: () => TileType.Dirt,
    hasRoads: false,
    flood: TileType.Dirt,
  },
};

/**
 * Deterministic road-first world generator. Produces a complete {@link MapData}
 * — planning records, tile grid, graph, spawn samples, entrances, traffic
 * lights, service buildings, collectibles and race starts — from one seed.
 */
class CityGenerator {
  private readonly rng: Random;
  private readonly architectureLandmarkByBlock = new Map<string, RequiredArchitectureLandmarkId>();
  private plannedBuildings: PlannedBuilding[] = [];
  private plannedSpaces: PlannedUrbanSpace[] = [];

  private constructor(seed: number) {
    this.rng = new Random(seed);
  }

  /** Generate a fresh world for `seed`. */
  public static generate(seed: number): MapData {
    return new CityGenerator(seed).build();
  }

  /** Run the full generation pipeline. */
  private build(): MapData {
    const widthTiles = WORLD_TILES_X;
    const heightTiles = WORLD_TILES_Y;
    const cols = Math.floor((widthTiles - 1) / PERIOD) + 1;
    const rows = Math.floor((heightTiles - 1) / PERIOD) + 1;

    const cities = this.cityDefinitions();
    const districts = this.assignDistricts(cols, rows);
    const tiles = this.paintTiles(widthTiles, heightTiles, cols, rows, districts);
    this.paintRegionalFeatures(tiles);
    const highwayPlan = HighwayPlanner.generate(CITY_SEED, cities, PERIOD, ROAD_MID);
    const highways = highwayPlan.routes;

    // Roads are now authoritative planning records. The legacy raster above is
    // reduced to a terrain/geography seed before the accepted plan is painted.
    const planned = UrbanPlanner.generate(
      CITY_SEED,
      cities,
      highways,
      highwayPlan.roads,
      PERIOD,
      ROAD_MID,
      (tx, ty) =>
        districts[Math.floor(ty / PERIOD)]?.[Math.floor(tx / PERIOD)] ?? District.Residential,
    );
    if (!planned.quality.passed) {
      throw new Error(`Urban road planning failed: ${planned.quality.issues.join('; ')}`);
    }
    this.clearLegacyUrbanInfrastructure(tiles, districts);
    this.restoreProtectedGeography(tiles);
    this.paintPlannedRoads(tiles, planned.roads, planned.intersections);
    this.paintHighwayFacilities(tiles, highways);
    this.regenerateUnbuildableBlocks(tiles, planned.blocks);
    this.reserveRequiredArchitectureLandmarks(tiles, planned.roads, planned.blocks);
    this.paintBlockPrograms(tiles, planned.blocks);
    this.plannedBuildings = this.planAndPaintBuildings(tiles, planned.blocks);
    const initialUrbanQuality = this.validateUrbanFabric(
      tiles,
      planned.roads,
      planned.blocks,
      this.plannedBuildings,
      this.plannedSpaces,
      planned.quality,
    );
    const urbanPlan = {
      roads: planned.roads,
      intersections: planned.intersections,
      blocks: planned.blocks,
      buildings: this.plannedBuildings,
      spaces: this.plannedSpaces,
      quality: initialUrbanQuality,
    };
    if (!initialUrbanQuality.passed) {
      throw new Error(`Urban fabric validation failed: ${initialUrbanQuality.issues.join('; ')}`);
    }

    const sidewalkSpawns = this.sampleWalkable(tiles, widthTiles, heightTiles);
    sidewalkSpawns.push(
      ...highways.flatMap((highway) => highway.serviceAreas.flatMap((area) => area.visitorSpawns)),
    );
    const roadBuild = this.buildRoadGraph(tiles, planned.roads);
    const roadNodes = roadBuild.nodes;
    const roadEdges = roadBuild.edges;
    const roadSpawns = this.sampleDrivable(roadNodes, roadEdges, tiles);
    const buildingEntrances = this.buildEntrancesFromPlan(tiles, this.plannedBuildings);
    const benches = this.sampleBenches(sidewalkSpawns);
    const busStops = this.sampleBusStops(sidewalkSpawns, benches);
    const trafficLights = this.buildTrafficLights(roadNodes, cities);
    const intersections = this.buildIntersectionData(
      roadNodes,
      roadEdges,
      trafficLights,
      planned.intersections,
    );
    const crossings = this.sampleCrossings(tiles, widthTiles, heightTiles, trafficLights);
    const playerStart = this.pickPlayerStart(roadNodes, cities[0]?.center ?? tileCenter(312, 456));

    const services = this.pickServices(buildingEntrances, cities);
    const interiorBuild = this.buildServiceInteriors(tiles, services);
    const majorBuildings = this.buildMajorBuildings(services, interiorBuild.interiors);
    this.assertMajorBuildings(majorBuildings);
    const serviceArchitectureIssues = this.auditServiceArchitecture(services, buildingEntrances);
    const postInteriorQuality = this.validateUrbanFabric(
      tiles,
      planned.roads,
      planned.blocks,
      this.plannedBuildings,
      this.plannedSpaces,
      planned.quality,
    );
    const finalUrbanIssues = [...postInteriorQuality.issues, ...serviceArchitectureIssues];
    urbanPlan.quality = {
      ...postInteriorQuality,
      passed: finalUrbanIssues.length === 0,
      issues: finalUrbanIssues,
    };
    if (!urbanPlan.quality.passed) {
      throw new Error(`Final urban fabric validation failed: ${finalUrbanIssues.join('; ')}`);
    }
    const collectibles = this.pickCollectibles(sidewalkSpawns);
    const raceStarts = this.pickRaceStarts(roadSpawns);
    const overview = this.buildOverview(tiles);
    const landmarks = this.buildLandmarks(cities, services, highways);
    const streamZones = this.streamZoneDefinitions(highways);
    const validation = this.validateWorld(
      cities,
      highways,
      roadNodes,
      roadEdges,
      intersections,
      crossings,
      tiles,
      urbanPlan,
      highwayPlan.quality,
    );

    if (!validation.passed) {
      throw new Error(`Generated world failed validation: ${validation.issues.join('; ')}`);
    }

    return {
      widthTiles,
      heightTiles,
      tileSize: TILE_SIZE,
      cities,
      landmarks,
      majorBuildings,
      highways,
      highwayQuality: highwayPlan.quality,
      streamZones,
      overview,
      tiles,
      districts,
      urbanPlan,
      blockPeriod: PERIOD,
      roadNodes,
      roadEdges,
      intersections,
      roadSpawns,
      sidewalkSpawns,
      buildingEntrances,
      buildingInteriors: interiorBuild.interiors,
      interiorSpawns: interiorBuild.spawns,
      benches,
      busStops,
      crossings,
      trafficLights,
      playerStart,
      raceStarts,
      collectibles,
      validation,
      ...services,
    };
  }

  /**
   * Assign a {@link District} to every block cell from a positional field with
   * per-cell jitter, so district boundaries read as organic rather than gridded.
   */
  private assignDistricts(cols: number, rows: number): District[][] {
    const grid: District[][] = [];
    for (let bj = 0; bj < rows; bj++) {
      const line: District[] = new Array<District>(cols);
      for (let bi = 0; bi < cols; bi++) {
        line[bi] = this.districtFor(bi, bj, cols, rows);
      }
      grid.push(line);
    }
    return grid;
  }

  /** Resolve a single cell's district from warped normalized coordinates. */
  private districtFor(bi: number, bj: number, cols: number, rows: number): District {
    // The city grid is still authored in lattice cells, but district assignment
    // now follows real geographic footprints instead of a single concentric
    // city. This makes the spaces physically contiguous while letting every
    // destination retain a strong visual identity.
    const tx = Math.min(WORLD_TILES_X - 1, bi * PERIOD + Math.floor(PERIOD / 2));
    const ty = Math.min(WORLD_TILES_Y - 1, bj * PERIOD + Math.floor(PERIOD / 2));
    void cols;
    void rows;

    if (inTileRect(tx, ty, TEHRAN_RECT)) {
      if (inTileRect(tx, ty, TEHRAN_AIRPORT_RECT)) return District.Airport;
      if (inTileRect(tx, ty, TEHRAN_GOVERNMENT_RECT)) return District.Government;
      if (inTileRect(tx, ty, TEHRAN_UNIVERSITY_RECT)) return District.University;
      if (inTileRect(tx, ty, TEHRAN_INDUSTRIAL_RECT)) return District.Industrial;
      if (tx > 150 && tx < 390 && ty > 1060 && ty < 1280) return District.OldTown;
      if (tx > 150 && tx < 460 && ty > 750 && ty < 930) return District.Luxury;
      if (
        (tx > 690 && tx < 820 && ty > 770 && ty < 890) ||
        (tx > 500 && tx < 680 && ty > 1190 && ty < 1300)
      ) {
        return District.Park;
      }
      const d = Math.hypot(tx - 620, ty - 1010);
      if (d < 125) return District.Downtown;
      if (d < 260 || (tx > 650 && ty < 1080)) return District.Commercial;
      return District.Residential;
    }

    if (inTileRect(tx, ty, GILAN_RECT)) {
      if (inTileRect(tx, ty, GILAN_MARINA_RECT)) return District.Marina;
      if (tx > 430 && ty < 250) return District.TeaFarm;
      if (tx > 300 && tx < 500 && ty > 320) return District.RiceFields;
      if (tx < 290 && ty < 220) return District.Historic;
      if (tx < 300 && ty > 235) return District.Harbor;
      if (tx > 460 && ty < 350) return District.Forest;
      return District.Residential;
    }

    if (inTileRect(tx, ty, YAZD_RECT)) {
      if (inTileRect(tx, ty, YAZD_MINING_RECT)) return District.Mining;
      if (tx > 1600 && tx < 1760 && ty < 625) return District.Airport;
      if (tx < 1550 && ty > 710) return District.Village;
      if (tx > 1530 && tx < 1650 && ty > 620 && ty < 770) return District.Bazaar;
      if (tx < 1610 && ty < 690) return District.Historic;
      if (tx > 1680 && ty > 650) return District.Industrial;
      return District.Residential;
    }

    // The route from Gilan to Tehran crosses wooded foothills; the east opens
    // into the Yazd desert, while a farm belt cushions the Tehran fringe.
    if (tx < 100 && ty < 520) return tx < 74 ? District.Ocean : District.Beach;
    if (tx < 760 && ty < 560) return tx < 180 ? District.Mountains : District.Forest;
    if (tx > 1180 && ty > 300) return District.Desert;
    if (tx < 1160 && ty > 1230) return District.Farmland;
    if (tx > 520 && tx < 1120 && ty < 760) return District.Mountains;
    if (tx > 900 && ty > 760) return District.Farmland;
    return District.Forest;
  }

  /** Static destination metadata consumed by map, HUD, traffic and weather. */
  private cityDefinitions(): WorldCity[] {
    return [
      {
        id: 'tehran',
        name: 'TEHRAN',
        center: tileCenter(620, 1010),
        bounds: tileBounds(TEHRAN_RECT.x, TEHRAN_RECT.y, TEHRAN_RECT.width, TEHRAN_RECT.height),
        color: 0xf59e0b,
        theme: 'Dense capital â€” towers, ring roads, river districts and a major airport',
        pedestrianDensity: 1.28,
        trafficDensity: 1.32,
        weather: 'clear',
        atmosphere: {
          lightingTint: 0xffd7b0,
          architecture: 'glass towers, civic stone, apartments, villas and logistics sheds',
          roadMaterial: 'dark urban asphalt with illuminated expressways',
          vegetation: 'plane trees, formal parks and dry foothill planting',
          ambientSound: 'dense traffic, rail, aircraft and commercial crowds',
          signStyle: 'blue metropolitan gantries and bilingual district blades',
          vehicleProfile: 'dense mixed commuter, taxi, bus and freight traffic',
          weatherWeights: { clear: 0.7, rain: 0.12, storm: 0.04, fog: 0.14 },
        },
      },
      {
        id: 'yazd',
        name: 'YAZD',
        center: tileCenter(1620, 690),
        bounds: tileBounds(YAZD_RECT.x, YAZD_RECT.y, YAZD_RECT.width, YAZD_RECT.height),
        color: 0xe7a34b,
        theme: 'Quiet adobe desert city â€” bazaars, windcatchers and open dunes',
        pedestrianDensity: 0.62,
        trafficDensity: 0.58,
        weather: 'clear',
        atmosphere: {
          lightingTint: 0xffc978,
          architecture: 'adobe courts, windcatchers, bazaars and low desert industry',
          roadMaterial: 'sun-bleached asphalt with sand shoulders',
          vegetation: 'date palms, oasis gardens and sparse desert scrub',
          ambientSound: 'wind, distant market activity and sparse highway traffic',
          signStyle: 'ochre route boards with reflective desert markers',
          vehicleProfile: 'light local traffic with trucks and utility vehicles',
          weatherWeights: { clear: 0.9, rain: 0.02, storm: 0.01, fog: 0.07 },
        },
      },
      {
        id: 'gilan',
        name: 'GILAN',
        center: tileCenter(350, 270),
        bounds: tileBounds(GILAN_RECT.x, GILAN_RECT.y, GILAN_RECT.width, GILAN_RECT.height),
        color: 0x4cbf87,
        theme: 'Rainy Caspian coast â€” forests, rice fields, harbor life and beaches',
        pedestrianDensity: 0.78,
        trafficDensity: 0.74,
        weather: 'rain',
        atmosphere: {
          lightingTint: 0xc7e6d5,
          architecture: 'timber houses, tiled roofs, harbor sheds and coastal hotels',
          roadMaterial: 'wet coastal asphalt and timber rural bridges',
          vegetation: 'tea hedges, rice paddies and dense Hyrcanian forest',
          ambientSound: 'rain, rivers, surf, birds and harbor activity',
          signStyle: 'green coastal route boards and park wayfinding',
          vehicleProfile: 'moderate local traffic with pickups, buses and port vans',
          weatherWeights: { clear: 0.22, rain: 0.5, storm: 0.16, fog: 0.12 },
        },
      },
    ];
  }

  /** Regions remain independently addressable even though they share one scene and coordinate space. */
  private streamZoneDefinitions(highways: readonly HighwayRoute[]): WorldStreamZone[] {
    const zones: WorldStreamZone[] = [
      { id: 'city:tehran', kind: 'city', bounds: tileBounds(120, 720, 1020, 620), detail: 'dense' },
      { id: 'city:yazd', kind: 'city', bounds: tileBounds(1450, 500, 360, 390), detail: 'dense' },
      { id: 'city:gilan', kind: 'city', bounds: tileBounds(100, 70, 520, 390), detail: 'dense' },
      {
        id: 'caspian-coast',
        kind: 'coast',
        bounds: tileBounds(0, 0, 650, 540),
        detail: 'standard',
      },
      {
        id: 'hyrcanian-forest',
        kind: 'forest',
        bounds: tileBounds(180, 260, 720, 420),
        detail: 'standard',
      },
      {
        id: 'alborz-range',
        kind: 'mountain',
        bounds: tileBounds(520, 320, 640, 470),
        detail: 'sparse',
      },
      {
        id: 'central-desert',
        kind: 'desert',
        bounds: tileBounds(1160, 280, 760, 720),
        detail: 'sparse',
      },
      {
        id: 'capital-farm-belt',
        kind: 'farmland',
        bounds: tileBounds(0, 1180, 1450, 228),
        detail: 'standard',
      },
    ];
    for (const highway of highways) {
      const xs = highway.points.map((point) => point.x / TILE_SIZE);
      const ys = highway.points.map((point) => point.y / TILE_SIZE);
      const margin = 24;
      const minX = Math.max(0, Math.floor(Math.min(...xs) - margin));
      const minY = Math.max(0, Math.floor(Math.min(...ys) - margin));
      const maxX = Math.min(WORLD_TILES_X, Math.ceil(Math.max(...xs) + margin));
      const maxY = Math.min(WORLD_TILES_Y, Math.ceil(Math.max(...ys) + margin));
      zones.push({
        id: `highway:${highway.id}`,
        kind: 'highway',
        bounds: tileBounds(minX, minY, maxX - minX, maxY - minY),
        detail: 'standard',
      });
    }
    return zones;
  }

  /** Snap authored tile coordinates to an existing road-lattice centre. */
  private roadTile(value: number): number {
    return Math.round((value - ROAD_MID) / PERIOD) * PERIOD + ROAD_MID;
  }

  /**
   * Stamp non-lattice geography after the district base pass.  Highways are
   * painted into the same tile grid as every city road, so driving between
   * cities never swaps scenes or teleports the player.
   */
  private paintRegionalFeatures(tiles: number[][]): void {
    // The Caspian edge, harbor basin, rivers and lakes are continuous terrain,
    // with roads restored only at authored bridges and causeways below.
    this.paintRect(tiles, 0, 0, 86, 540, TileType.Water);
    this.paintRect(tiles, 86, 24, 18, 490, TileType.Sand);
    this.paintRect(tiles, 108, 300, 138, 92, TileType.Water);
    this.paintRect(tiles, 126, 322, 116, 13, TileType.Dock);
    this.paintRect(tiles, 455, 135, 104, 66, TileType.Water);
    this.paintRect(tiles, 170, 348, 438, 8, TileType.Water);
    for (const x of [208, 338, 468, 585]) {
      this.paintRoadSegment(
        tiles,
        { x: this.roadTile(x), y: this.roadTile(95) },
        { x: this.roadTile(x), y: this.roadTile(435) },
        2,
      );
    }

    // Tehran's river crosses the whole capital. Five bridges and the two ring
    // roads are the only deliberate crossings.
    this.paintRect(tiles, 140, 1110, 970, 12, TileType.Water);
    for (const x of [210, 405, 600, 795, 1015]) {
      this.paintRoadSegment(
        tiles,
        { x: this.roadTile(x), y: 1094 },
        { x: this.roadTile(x), y: 1138 },
        2,
      );
    }

    // Tehran parks, university lawns and green riverfront corridors.
    this.paintRect(tiles, 690, 775, 130, 112, TileType.Grass);
    this.paintRect(tiles, 505, 1190, 175, 105, TileType.Grass);
    this.paintRect(tiles, 270, 855, 130, 92, TileType.Grass);

    // Two complete beltways, cross-city arterials, service roads and the
    // airport expressway form the capital's hierarchy above the local streets.
    this.paintRoadLoop(tiles, 140, 740, 1120, 1320, 3);
    this.paintRoadLoop(tiles, 340, 850, 900, 1210, 2);
    for (const x of [210, 600, 1015]) {
      this.paintRoadSegment(
        tiles,
        { x: this.roadTile(x), y: this.roadTile(740) },
        { x: this.roadTile(x), y: this.roadTile(1320) },
        2,
      );
    }
    for (const y of [820, 1015, 1240]) {
      this.paintRoadSegment(
        tiles,
        { x: this.roadTile(140), y: this.roadTile(y) },
        { x: this.roadTile(1120), y: this.roadTile(y) },
        2,
      );
    }
    this.paintRoadSegment(
      tiles,
      { x: this.roadTile(820), y: this.roadTile(820) },
      { x: this.roadTile(1140), y: this.roadTile(820) },
      3,
    );
    this.paintRoadSegment(
      tiles,
      { x: this.roadTile(1030), y: this.roadTile(820) },
      { x: this.roadTile(1030), y: this.roadTile(1050) },
      3,
    );

    // Tehran International Airport: two full runways, passenger terminal,
    // cargo terminal, control complex, apron, hotels and logistics pads.
    this.paintRect(tiles, 872, 790, 226, 150, TileType.Concrete);
    this.paintRect(tiles, 886, 808, 190, 10, TileType.Runway);
    this.paintRect(tiles, 886, 858, 190, 10, TileType.Runway);
    this.paintRect(tiles, 900, 890, 68, 24, TileType.Concrete);
    this.paintRect(tiles, 980, 890, 52, 24, TileType.Concrete);
    this.paintRect(tiles, 1042, 890, 42, 24, TileType.Concrete);
    this.paintRect(tiles, 842, 920, 44, 24, TileType.Concrete);

    // Gilan's coastal road, inland bypass and mountain approach link the port,
    // rice belt, tea hills and forest without imposing Tehran's grid.
    this.paintRoadSegment(
      tiles,
      { x: this.roadTile(112), y: this.roadTile(86) },
      { x: this.roadTile(112), y: this.roadTile(445) },
      2,
    );
    this.paintRoadSegment(
      tiles,
      { x: this.roadTile(170), y: this.roadTile(238) },
      { x: this.roadTile(590), y: this.roadTile(238) },
      2,
    );
    this.paintRoadSegment(
      tiles,
      { x: this.roadTile(350), y: this.roadTile(86) },
      { x: this.roadTile(350), y: this.roadTile(445) },
      2,
    );
    this.paintRoadLoop(tiles, 130, 95, 585, 435, 2);
    this.paintRect(tiles, 500, 245, 70, 72, TileType.Grass);
    this.paintRect(tiles, 380, 365, 112, 54, TileType.Dirt);

    // Yazd's regional airport, dry river, mine, solar field, military compound,
    // oasis and bypass establish a sparse desert metropolis rather than a copy
    // of the capital street pattern.
    this.paintRect(tiles, 1605, 520, 150, 96, TileType.Concrete);
    this.paintRect(tiles, 1620, 548, 120, 8, TileType.Runway);
    this.paintRect(tiles, 1700, 775, 82, 66, TileType.Rock);
    this.paintRect(tiles, 1480, 820, 215, 10, TileType.Dirt);
    this.paintRect(tiles, 1458, 720, 48, 46, TileType.Sand);
    this.paintRect(tiles, 1760, 630, 42, 76, TileType.Concrete);
    this.paintRect(tiles, 1510, 850, 96, 26, TileType.Concrete);
    this.paintRect(tiles, 1370, 660, 72, 58, TileType.Grass);
    this.paintRect(tiles, 1394, 680, 30, 18, TileType.Water);
    this.paintRect(tiles, 1250, 710, 98, 56, TileType.Water);
    this.paintRoadLoop(tiles, 1460, 515, 1795, 875, 3);
    this.paintRoadSegment(
      tiles,
      { x: this.roadTile(1460), y: this.roadTile(690) },
      { x: this.roadTile(1795), y: this.roadTile(690) },
      2,
    );
    this.paintRoadSegment(
      tiles,
      { x: this.roadTile(1620), y: this.roadTile(515) },
      { x: this.roadTile(1620), y: this.roadTile(875) },
      2,
    );

    // Road-trip services keep the long country drives populated.
    for (const [x, y] of [
      [1040, 345],
      [1190, 420],
      [1300, 1000],
      [900, 560],
      [720, 650],
    ] as const) {
      this.paintRect(tiles, x - 10, y - 8, 20, 16, TileType.Dirt);
    }

    // Hand-authored country terrain breaks up biome-scale fills and keeps the
    // long drives visually occupied without cloning city blocks.
    for (const [x, y, w, h] of [
      [635, 72, 132, 82],
      [805, 175, 118, 74],
      [985, 85, 106, 148],
      [555, 505, 126, 98],
      [715, 590, 174, 76],
      [950, 490, 168, 92],
    ] as const) {
      this.paintRect(tiles, x, y, w, h, TileType.Grass);
    }
    for (const [x, y, w, h] of [
      [690, 250, 74, 42],
      [875, 395, 98, 58],
      [1030, 250, 82, 52],
      [745, 475, 58, 36],
      [1080, 610, 72, 44],
    ] as const) {
      this.paintRect(tiles, x, y, w, h, TileType.Rock);
    }
    this.paintRect(tiles, 830, 420, 66, 28, TileType.Water);
    this.paintRect(tiles, 990, 565, 44, 22, TileType.Water);
    this.paintRect(tiles, 675, 335, 94, 9, TileType.Dirt);

    // Remote northern plateau: reservoirs, forestry clearings and upland farms
    // keep the land beyond the transnational route legible on the world map.
    for (const [x, y, w, h] of [
      [1150, 35, 180, 76],
      [1375, 80, 146, 92],
      [1580, 30, 208, 68],
      [1715, 145, 134, 86],
      [1240, 205, 172, 62],
      [1490, 230, 118, 54],
    ] as const) {
      this.paintRect(tiles, x, y, w, h, TileType.Dirt);
    }
    this.paintRect(tiles, 1320, 118, 96, 58, TileType.Water);
    this.paintRect(tiles, 1640, 110, 84, 46, TileType.Water);
    this.paintRect(tiles, 1810, 45, 68, 92, TileType.Rock);
    this.paintRect(tiles, 1460, 28, 54, 42, TileType.Dirt);
    this.paintRect(tiles, 1760, 245, 46, 34, TileType.Dirt);

    for (const [x, y, w, h] of [
      [1120, 910, 142, 72],
      [1210, 1090, 176, 86],
      [1390, 1040, 138, 78],
      [1060, 1235, 154, 92],
      [1285, 1270, 188, 76],
      [1535, 1110, 128, 96],
    ] as const) {
      this.paintRect(tiles, x, y, w, h, TileType.Dirt);
    }
    for (const [x, y, w, h] of [
      [1165, 940, 42, 32],
      [1260, 1130, 54, 38],
      [1430, 1080, 48, 36],
      [1110, 1270, 46, 42],
      [1330, 1310, 62, 34],
    ] as const) {
      this.paintRect(tiles, x, y, w, h, TileType.Grass);
    }
    this.paintRect(tiles, 1170, 1180, 290, 8, TileType.Water);

    for (const [x, y, w, h] of [
      [1190, 310, 126, 18],
      [1315, 370, 168, 12],
      [1510, 330, 190, 16],
      [1215, 555, 92, 14],
      [1350, 610, 118, 12],
      [1580, 930, 174, 18],
      [1740, 410, 104, 14],
      [1810, 720, 76, 18],
    ] as const) {
      this.paintRect(tiles, x, y, w, h, TileType.Dirt);
    }
    for (const [x, y, w, h] of [
      [1240, 455, 48, 42],
      [1360, 305, 70, 50],
      [1450, 915, 54, 44],
      [1770, 300, 76, 62],
      [1830, 850, 52, 46],
    ] as const) {
      this.paintRect(tiles, x, y, w, h, TileType.Rock);
    }

    // Reserve terrain pads for future explicitly planned roadside compounds.
    for (const [x, y, w, h] of [
      [890, 280, 30, 22],
      [1065, 350, 36, 24],
      [1225, 440, 34, 26],
      [1320, 935, 42, 24],
      [1160, 1010, 34, 22],
      [730, 620, 30, 20],
    ] as const) {
      this.paintRect(tiles, x, y, w, h, TileType.Dirt);
    }
  }

  /** Remove the old inferred lattice after it has served as a terrain seed. */
  private clearLegacyUrbanInfrastructure(
    tiles: number[][],
    districts: readonly (readonly District[])[],
  ): void {
    for (let ty = 0; ty < tiles.length; ty++) {
      const row = tiles[ty];
      if (!row) continue;
      const bj = Math.floor(ty / PERIOD);
      for (let tx = 0; tx < row.length; tx++) {
        const tile = row[tx];
        const roadSurface =
          tile === TileType.Road ||
          tile === TileType.RoadLineH ||
          tile === TileType.RoadLineV ||
          tile === TileType.Crossing;
        const legacyBuilding =
          tile === TileType.Building ||
          tile === TileType.BuildingRes ||
          tile === TileType.BuildingInd;
        if (!roadSurface && tile !== TileType.Sidewalk && !legacyBuilding) continue;
        const district = districts[bj]?.[Math.floor(tx / PERIOD)] ?? District.Residential;
        row[tx] = this.terrainTileFor(district, tx, ty);
      }
    }
  }

  /** Restore protected natural features before the immutable road mask is painted. */
  private restoreProtectedGeography(tiles: number[][]): void {
    this.paintRect(tiles, 0, 0, 86, 540, TileType.Water);
    this.paintRect(tiles, 86, 24, 18, 490, TileType.Sand);
    this.paintRect(tiles, 108, 300, 138, 92, TileType.Water);
    this.paintRect(tiles, 126, 322, 116, 13, TileType.Dock);
    this.paintRect(tiles, 455, 135, 104, 66, TileType.Water);
    this.paintRect(tiles, 170, 348, 438, 8, TileType.Water);
    this.paintRect(tiles, 140, 1110, 970, 12, TileType.Water);
    this.paintRect(tiles, 1394, 680, 30, 18, TileType.Water);
    this.paintRect(tiles, 1250, 710, 98, 56, TileType.Water);
    this.paintRect(tiles, 830, 420, 66, 28, TileType.Water);
    this.paintRect(tiles, 990, 565, 44, 22, TileType.Water);
    this.paintRect(tiles, 1320, 118, 96, 58, TileType.Water);
    this.paintRect(tiles, 1640, 110, 84, 46, TileType.Water);
    this.paintRect(tiles, 1170, 1180, 290, 8, TileType.Water);
  }

  private terrainTileFor(district: District, tx: number, ty: number): TileType {
    if (district === District.Ocean) return TileType.Water;
    if (
      district === District.Desert ||
      district === District.Historic ||
      district === District.Bazaar ||
      district === District.Village ||
      district === District.Beach ||
      inTileRect(tx, ty, YAZD_RECT)
    ) {
      return TileType.Sand;
    }
    if (district === District.Mountains || district === District.Mining) return TileType.Rock;
    if (district === District.RiceFields || district === District.Farmland) return TileType.Dirt;
    if (
      district === District.Downtown ||
      district === District.Commercial ||
      district === District.Government ||
      district === District.University ||
      district === District.Industrial ||
      district === District.Harbor ||
      district === District.Marina ||
      district === District.Airport
    ) {
      return TileType.Concrete;
    }
    return TileType.Grass;
  }

  /** Rasterize the accepted graph. No terrain/building pass runs after this. */
  private paintPlannedRoads(
    tiles: number[][],
    roads: readonly PlannedRoadSegment[],
    intersections: readonly PlannedIntersection[],
  ): void {
    for (const road of roads) {
      if (road.hierarchy === 'highway') continue;
      this.paintSurfaceSegment(tiles, road.from, road.to, road.halfWidth + 1, TileType.Sidewalk);
    }

    for (const intersection of intersections) {
      if (intersection.design === 'roundabout') {
        this.paintCircle(
          tiles,
          intersection.position.x,
          intersection.position.y,
          6,
          TileType.Sidewalk,
        );
      } else if (intersection.design === 'plaza') {
        this.paintCircle(
          tiles,
          intersection.position.x,
          intersection.position.y,
          5,
          TileType.Concrete,
        );
      }
    }

    for (const road of roads) {
      if (road.startTerminal) this.paintTerminal(tiles, road.from, road.startTerminal);
      if (road.endTerminal) this.paintTerminal(tiles, road.to, road.endTerminal);
    }

    // Repaint every accepted centreline last so even concrete parking and
    // industrial terminal pads retain unambiguous graph-owned asphalt access.
    for (const road of roads) {
      this.paintRoadSegment(tiles, road.from, road.to, road.halfWidth);
    }

    for (const intersection of intersections) {
      if (intersection.design === 'roundabout') {
        this.paintCircle(tiles, intersection.position.x, intersection.position.y, 5, TileType.Road);
      }
      if (
        intersection.connectedRoadIds.length >= 3 &&
        intersection.design !== 'roundabout' &&
        this.mod(intersection.position.x + intersection.position.y, 3) === 0
      ) {
        this.setRoadTile(
          tiles,
          intersection.position.x,
          intersection.position.y,
          TileType.Crossing,
        );
      }
    }
  }

  /** Stamp purposeful off-line facilities without ever overwriting graph-owned asphalt. */
  private paintHighwayFacilities(tiles: number[][], highways: readonly HighwayRoute[]): void {
    for (const highway of highways) {
      for (const area of highway.serviceAreas) {
        const centerX = Math.floor(area.position.x / TILE_SIZE);
        const centerY = Math.floor(area.position.y / TILE_SIZE);
        const halfWidth = area.facilities.includes('truck-parking') ? 12 : 10;
        const halfHeight = 7;
        for (let ty = centerY - halfHeight; ty <= centerY + halfHeight; ty++) {
          const row = tiles[ty];
          if (!row) continue;
          for (let tx = centerX - halfWidth; tx <= centerX + halfWidth; tx++) {
            const current = row[tx];
            if (current === undefined || PLANNED_ROAD_SURFACE_SET.has(current)) continue;
            row[tx] = TileType.Concrete;
          }
        }
      }
    }
  }

  /** Give every accepted block a visible, zoning-specific ground contract. */
  private paintBlockPrograms(tiles: number[][], blocks: readonly PlannedUrbanBlock[]): void {
    for (const block of blocks) {
      const surface = this.blockProgramSurface(block);
      for (let ty = block.bounds.y; ty < block.bounds.y + block.bounds.height; ty++) {
        const row = tiles[ty];
        if (!row) continue;
        for (let tx = block.bounds.x; tx < block.bounds.x + block.bounds.width; tx++) {
          if (!this.blockOwnsTile(block, tx, ty)) continue;
          const current = row[tx];
          if (
            current === undefined ||
            DRIVABLE_TILE_TYPES.includes(current as TileType) ||
            current === TileType.Sidewalk ||
            current === TileType.Water ||
            current === TileType.Rock ||
            current === TileType.Runway ||
            current === TileType.Dock
          ) {
            continue;
          }
          row[tx] = surface;
        }
      }
    }
  }

  /** Convert road/geography fragments with no viable 2x2 lot into designed pocket space. */
  private regenerateUnbuildableBlocks(tiles: number[][], blocks: PlannedUrbanBlock[]): void {
    for (const block of blocks) {
      if (block.purposefulOpenSpace || block.densityTarget <= 0) continue;
      if (this.blockHasDevelopableLot(tiles, block)) continue;

      if (block.district === District.Industrial || block.district === District.Mining) {
        block.program = 'industrial-yard';
        block.landUse = 'industrial';
      } else if (block.cityId === 'gilan') {
        block.program = 'forest-park';
        block.landUse = 'park';
      } else {
        block.program = 'public-plaza';
        block.landUse = 'park';
      }
      block.purposefulOpenSpace = true;
      block.densityTarget = 0;
      block.generationAttempt++;
      block.signature += `:regenerated-${block.program}`;
    }
  }

  /**
   * Preserve the architectural counterpart of major map destinations after
   * road/geography painting has revealed which nominal parcels are buildable.
   */
  private reserveRequiredArchitectureLandmarks(
    tiles: number[][],
    roads: readonly PlannedRoadSegment[],
    blocks: PlannedUrbanBlock[],
  ): void {
    const usedBlockIds = new Set<string>();
    for (const requirement of REQUIRED_ARCHITECTURE_LANDMARKS) {
      const candidates = blocks
        .map((block, index) => ({ block, index }))
        .filter(
          ({ block }) =>
            block.cityId === requirement.cityId &&
            !usedBlockIds.has(block.id) &&
            block.bounds.width >= requirement.minimumWidth &&
            block.bounds.height >= requirement.minimumHeight &&
            this.blockHasDevelopableLot(tiles, block) &&
            !this.blockContainsRoadTerminal(block, roads),
        )
        .sort((first, second) => {
          const firstPreference = this.landmarkPreference(first.block, requirement);
          const secondPreference = this.landmarkPreference(second.block, requirement);
          const firstDistance = this.squaredDistanceToBlock(requirement.anchor, first.block.bounds);
          const secondDistance = this.squaredDistanceToBlock(
            requirement.anchor,
            second.block.bounds,
          );
          // A preferred zoning match may beat a moderately closer fallback,
          // but never move a physical destination hundreds of tiles away from
          // its map marker merely to preserve the original random district.
          const firstScore = Math.sqrt(firstDistance) + firstPreference * 48;
          const secondScore = Math.sqrt(secondDistance) + secondPreference * 48;
          return (
            firstScore - secondScore || firstDistance - secondDistance || first.index - second.index
          );
        });

      for (const candidate of candidates) {
        const reserved = this.reservedLandmarkBlock(candidate.block, requirement);
        if (!this.landmarkBlockCanMaterialize(tiles, reserved, requirement)) continue;
        Object.assign(candidate.block, reserved);
        usedBlockIds.add(candidate.block.id);
        this.architectureLandmarkByBlock.set(candidate.block.id, requirement.id);
        break;
      }
    }
  }

  private blockHasDevelopableLot(tiles: number[][], block: PlannedUrbanBlock): boolean {
    for (let ty = block.bounds.y; ty < block.bounds.y + block.bounds.height - 1; ty++) {
      for (let tx = block.bounds.x; tx < block.bounds.x + block.bounds.width - 1; tx++) {
        if (
          this.blockOwnsTile(block, tx, ty) &&
          this.blockOwnsTile(block, tx + 1, ty) &&
          this.blockOwnsTile(block, tx, ty + 1) &&
          this.blockOwnsTile(block, tx + 1, ty + 1) &&
          this.isDevelopableBlockTile(tiles[ty]?.[tx]) &&
          this.isDevelopableBlockTile(tiles[ty]?.[tx + 1]) &&
          this.isDevelopableBlockTile(tiles[ty + 1]?.[tx]) &&
          this.isDevelopableBlockTile(tiles[ty + 1]?.[tx + 1])
        ) {
          return true;
        }
      }
    }
    return false;
  }

  private blockContainsRoadTerminal(
    block: PlannedUrbanBlock,
    roads: readonly PlannedRoadSegment[],
  ): boolean {
    for (const road of roads) {
      for (const [point, terminal] of [
        [road.from, road.startTerminal],
        [road.to, road.endTerminal],
      ] as const) {
        if (
          terminal !== undefined &&
          this.blockOwnsTile(block, point.x, point.y)
        ) {
          return true;
        }
      }
    }
    return false;
  }

  private landmarkPreference(
    block: PlannedUrbanBlock,
    requirement: RequiredArchitectureLandmark,
  ): number {
    const preferredDistrict = requirement.preferredDistricts.includes(block.district);
    const preferredProgram = requirement.preferredPrograms.includes(block.program);
    if (preferredDistrict && preferredProgram) return 0;
    if (preferredDistrict) return 1;
    if (preferredProgram) return 2;
    return 3;
  }

  private squaredDistanceToBlock(point: { x: number; y: number }, bounds: TileRect): number {
    const dx = bounds.x + bounds.width / 2 - point.x;
    const dy = bounds.y + bounds.height / 2 - point.y;
    return dx * dx + dy * dy;
  }

  private reservedLandmarkBlock(
    block: PlannedUrbanBlock,
    requirement: RequiredArchitectureLandmark,
  ): PlannedUrbanBlock {
    const generationAttempt = block.generationAttempt + 1;
    return {
      ...block,
      program: requirement.program,
      landUse: requirement.landUse,
      purposefulOpenSpace: requirement.purposefulOpenSpace,
      densityTarget: requirement.densityTarget,
      landmark: true,
      generationAttempt,
      signature: `${block.cityId}:${block.district}:${requirement.landUse}:${requirement.program}:${block.form}:${block.bounds.width}x${block.bounds.height}:reserved-${requirement.id}:${block.id}:attempt-${generationAttempt}`,
    };
  }

  private landmarkBlockCanMaterialize(
    tiles: number[][],
    block: PlannedUrbanBlock,
    requirement: RequiredArchitectureLandmark,
  ): boolean {
    const composition = composeBlockArchitecture(block, CITY_SEED);
    const primaryLot = composition.lots.find((lot) => lot.primary);
    if (!primaryLot) return false;
    const building = this.specializeReservedLandmarkBuilding(
      this.buildingFromGrammarLot(block, primaryLot, 0),
      requirement.id,
    );
    return (
      building.kind === requirement.requiredKind &&
      Math.min(building.bounds.width, building.bounds.height) >=
        requirement.minimumBuildingSpan &&
      this.canPlaceBuilding(tiles, building, new Set<string>(), new Set<string>(), block)
    );
  }

  private isDevelopableBlockTile(tile: number | undefined): boolean {
    return !(
      tile === undefined ||
      PLANNED_ROAD_SURFACE_SET.has(tile) ||
      tile === TileType.Sidewalk ||
      tile === TileType.Water ||
      tile === TileType.Rock ||
      tile === TileType.Runway ||
      tile === TileType.Dock ||
      tile === TileType.InteriorFloor ||
      tile === TileType.InteriorWall ||
      tile === TileType.InteriorDoor ||
      tile === TileType.InteriorFixture
    );
  }

  /** Exact parcel ownership; bounds remain only a composition/search envelope. */
  private blockOwnsTile(block: PlannedUrbanBlock, tx: number, ty: number): boolean {
    const footprint = block.footprint;
    if (!footprint || footprint.length === 0) {
      return (
        tx >= block.bounds.x &&
        ty >= block.bounds.y &&
        tx < block.bounds.x + block.bounds.width &&
        ty < block.bounds.y + block.bounds.height
      );
    }
    return footprint.some(
      (part) =>
        tx >= part.x && ty >= part.y && tx < part.x + part.width && ty < part.y + part.height,
    );
  }

  private blockOwnsRect(block: PlannedUrbanBlock, rect: TileRect): boolean {
    for (let ty = rect.y; ty < rect.y + rect.height; ty++) {
      for (let tx = rect.x; tx < rect.x + rect.width; tx++) {
        if (!this.blockOwnsTile(block, tx, ty)) return false;
      }
    }
    return true;
  }

  private blockParcelArea(block: PlannedUrbanBlock): number {
    const footprint = block.footprint;
    return footprint && footprint.length > 0
      ? footprint.reduce((sum, part) => sum + part.width * part.height, 0)
      : block.bounds.width * block.bounds.height;
  }

  /** A frontage cell is owned by the block and touches its exact outside edge. */
  private reachesBlockFrontage(block: PlannedUrbanBlock, point: PlannedTilePoint): boolean {
    if (!this.blockOwnsTile(block, point.x, point.y)) return false;
    return [
      { x: point.x, y: point.y - 1 },
      { x: point.x + 1, y: point.y },
      { x: point.x, y: point.y + 1 },
      { x: point.x - 1, y: point.y },
    ].some((neighbor) => !this.blockOwnsTile(block, neighbor.x, neighbor.y));
  }

  private blockProgramSurface(block: PlannedUrbanBlock): TileType {
    if (block.program === 'beach-access') return TileType.Sand;
    if (
      ['small-park', 'playground', 'forest-park'].includes(block.program) ||
      (block.program === 'housing' && block.cityId === 'gilan')
    ) {
      return TileType.Grass;
    }
    if (
      ['farm-compound', 'industrial-yard', 'construction-site', 'rail-yard'].includes(block.program)
    ) {
      return block.cityId === 'yazd' ? TileType.Sand : TileType.Dirt;
    }
    if (
      block.landUse === 'commercial' ||
      block.landUse === 'office' ||
      block.landUse === 'institutional' ||
      block.landUse === 'public-service' ||
      block.landUse === 'infrastructure' ||
      block.program === 'public-plaza' ||
      block.program === 'sports-center'
    ) {
      return TileType.Concrete;
    }
    return this.terrainTileFor(
      block.district,
      Math.floor(block.bounds.x + block.bounds.width / 2),
      Math.floor(block.bounds.y + block.bounds.height / 2),
    );
  }

  private paintSurfaceSegment(
    tiles: number[][],
    from: { x: number; y: number },
    to: { x: number; y: number },
    halfWidth: number,
    tile: TileType,
  ): void {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const steps = Math.max(1, Math.max(Math.abs(dx), Math.abs(dy)) * 2);
    for (let step = 0; step <= steps; step++) {
      const t = step / steps;
      const cx = Math.round(from.x + dx * t);
      const cy = Math.round(from.y + dy * t);
      for (let oy = -halfWidth; oy <= halfWidth; oy++) {
        for (let ox = -halfWidth; ox <= halfWidth; ox++) {
          if (ox * ox + oy * oy > (halfWidth + 0.35) ** 2) continue;
          const row = tiles[cy + oy];
          if (!row || cx + ox < 0 || cx + ox >= row.length) continue;
          row[cx + ox] = tile;
        }
      }
    }
  }

  private paintCircle(
    tiles: number[][],
    cx: number,
    cy: number,
    radius: number,
    tile: TileType,
  ): void {
    for (let oy = -radius; oy <= radius; oy++) {
      const row = tiles[cy + oy];
      if (!row) continue;
      for (let ox = -radius; ox <= radius; ox++) {
        if (ox * ox + oy * oy > radius * radius) continue;
        const tx = cx + ox;
        if (tx < 0 || tx >= row.length) continue;
        row[tx] = tile;
      }
    }
  }

  private paintTerminal(
    tiles: number[][],
    point: { x: number; y: number },
    terminal: PlannedRoadSegment['startTerminal'],
  ): void {
    if (!terminal) return;
    if (terminal === 'cul-de-sac' || terminal === 'residential-court') {
      this.paintCircle(tiles, point.x, point.y, terminal === 'cul-de-sac' ? 4 : 5, TileType.Road);
      return;
    }
    if (
      terminal === 'parking-area' ||
      terminal === 'industrial-yard' ||
      terminal === 'airport-entrance' ||
      terminal === 'harbor-entrance' ||
      terminal === 'checkpoint' ||
      terminal === 'highway-ramp'
    ) {
      const radius =
        terminal === 'industrial-yard' ||
        terminal === 'airport-entrance' ||
        terminal === 'harbor-entrance'
          ? 6
          : 5;
      this.paintRect(
        tiles,
        point.x - radius,
        point.y - Math.floor(radius * 0.7),
        radius * 2 + 1,
        Math.floor(radius * 1.4) + 1,
        TileType.Concrete,
      );
      this.paintCircle(tiles, point.x, point.y, 2, TileType.Road);
      return;
    }
    if (terminal === 'public-square' || terminal === 'roundabout') {
      this.paintCircle(
        tiles,
        point.x,
        point.y,
        terminal === 'roundabout' ? 6 : 7,
        TileType.Concrete,
      );
      this.paintCircle(tiles, point.x, point.y, terminal === 'roundabout' ? 4 : 2, TileType.Road);
      return;
    }
    if (terminal === 'forest-trail' || terminal === 'beach-access') {
      this.paintCircle(
        tiles,
        point.x,
        point.y,
        4,
        terminal === 'beach-access' ? TileType.Sand : TileType.Dirt,
      );
      this.paintRect(tiles, point.x - 2, point.y - 1, 5, 3, TileType.Road);
      return;
    }
    // Hammerhead cap for a dead-end alley.
    this.paintRect(tiles, point.x - 3, point.y - 2, 7, 5, TileType.Road);
  }

  private mod(value: number, modulus: number): number {
    return ((value % modulus) + modulus) % modulus;
  }

  /** Paint a clamped solid terrain rectangle. */
  private paintRect(
    tiles: number[][],
    x: number,
    y: number,
    width: number,
    height: number,
    tile: TileType,
  ): void {
    const minY = Math.max(0, y);
    const maxY = Math.min(tiles.length, y + height);
    for (let ty = minY; ty < maxY; ty++) {
      const row = tiles[ty];
      if (!row) continue;
      const minX = Math.max(0, x);
      const maxX = Math.min(row.length, x + width);
      for (let tx = minX; tx < maxX; tx++) row[tx] = tile;
    }
  }

  /** Paint a four-lane road segment between two orthogonal tile points. */
  private paintRoadSegment(
    tiles: number[][],
    from: { x: number; y: number },
    to: { x: number; y: number },
    halfWidth: number,
  ): void {
    if (from.x !== to.x && from.y !== to.y) {
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const steps = Math.max(Math.abs(dx), Math.abs(dy)) * 2;
      const marking = Math.abs(dx) >= Math.abs(dy) ? TileType.RoadLineH : TileType.RoadLineV;
      for (let step = 0; step <= steps; step++) {
        const t = step / Math.max(1, steps);
        const cx = Math.round(from.x + dx * t);
        const cy = Math.round(from.y + dy * t);
        for (let oy = -halfWidth; oy <= halfWidth; oy++) {
          for (let ox = -halfWidth; ox <= halfWidth; ox++) {
            if (ox * ox + oy * oy > (halfWidth + 0.35) ** 2) continue;
            this.setRoadTile(
              tiles,
              cx + ox,
              cy + oy,
              ox === 0 && oy === 0 ? marking : TileType.Road,
            );
          }
        }
      }
      return;
    }
    if (from.y === to.y) {
      const min = Math.min(from.x, to.x);
      const max = Math.max(from.x, to.x);
      for (let tx = min; tx <= max; tx++) {
        for (let ty = from.y - halfWidth; ty <= from.y + halfWidth; ty++) {
          this.setRoadTile(tiles, tx, ty, ty === from.y ? TileType.RoadLineH : TileType.Road);
        }
      }
      return;
    }
    const min = Math.min(from.y, to.y);
    const max = Math.max(from.y, to.y);
    for (let ty = min; ty <= max; ty++) {
      for (let tx = from.x - halfWidth; tx <= from.x + halfWidth; tx++) {
        this.setRoadTile(tiles, tx, ty, tx === from.x ? TileType.RoadLineV : TileType.Road);
      }
    }
  }

  /** Paint a continuous ring road around an urban footprint. */
  private paintRoadLoop(
    tiles: number[][],
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    halfWidth: number,
  ): void {
    const left = this.roadTile(x0);
    const right = this.roadTile(x1);
    const top = this.roadTile(y0);
    const bottom = this.roadTile(y1);
    this.paintRoadSegment(tiles, { x: left, y: top }, { x: right, y: top }, halfWidth);
    this.paintRoadSegment(tiles, { x: right, y: top }, { x: right, y: bottom }, halfWidth);
    this.paintRoadSegment(tiles, { x: right, y: bottom }, { x: left, y: bottom }, halfWidth);
    this.paintRoadSegment(tiles, { x: left, y: bottom }, { x: left, y: top }, halfWidth);
  }

  /** Write a road cell safely and leave a continuous highway at map edges. */
  private setRoadTile(tiles: number[][], tx: number, ty: number, tile: TileType): void {
    const row = tiles[ty];
    if (!row || tx < 0 || tx >= row.length) return;
    row[tx] = tile;
  }

  /** Paint the tile grid cell by cell from the district lattice styles. */
  private paintTiles(
    widthTiles: number,
    heightTiles: number,
    cols: number,
    rows: number,
    districts: District[][],
  ): number[][] {
    const tiles: number[][] = [];
    // Per-block RNGs so block fills are stable and independent.
    for (let y = 0; y < heightTiles; y++) {
      const ya = classifyAxis(y % PERIOD);
      const bj = Math.min(rows - 1, Math.floor(y / PERIOD));
      const row: number[] = new Array<number>(widthTiles);
      for (let x = 0; x < widthTiles; x++) {
        const xa = classifyAxis(x % PERIOD);
        const bi = Math.min(cols - 1, Math.floor(x / PERIOD));
        const district = districts[bj]?.[bi] ?? District.Residential;
        row[x] = this.tileFor(xa, ya, district, bi, bj, x, y);
      }
      tiles.push(row);
    }
    return tiles;
  }

  /** Resolve one tile from its axis classifications and district style. */
  private tileFor(
    xa: AxisInfo,
    ya: AxisInfo,
    district: District,
    bi: number,
    bj: number,
    tx: number,
    ty: number,
  ): TileType {
    const style = DISTRICT_STYLES[district];

    if (!style.hasRoads) {
      return style.flood ?? TileType.Water;
    }

    const horizontalRoad = ya.road && this.keepsLocalRoad(district, bi, bj, 'ew');
    const verticalRoad = xa.road && this.keepsLocalRoad(district, bi, bj, 'ns');

    // Road bands (either axis).
    if (horizontalRoad && verticalRoad) return style.roadTile ?? TileType.Road;
    if (horizontalRoad) {
      if (xa.sidewalk) return style.sidewalkTile ?? TileType.Crossing;
      if (style.roadTile !== undefined) return style.roadTile;
      return ya.roadMid ? TileType.RoadLineH : TileType.Road;
    }
    if (verticalRoad) {
      if (ya.sidewalk) return style.sidewalkTile ?? TileType.Crossing;
      if (style.roadTile !== undefined) return style.roadTile;
      return xa.roadMid ? TileType.RoadLineV : TileType.Road;
    }

    // Suppressed streets become yards, service courts and green seams instead
    // of cloning the neighbouring building across an old road reservation.
    if ((xa.road && !verticalRoad) || (ya.road && !horizontalRoad)) {
      return this.openBlockTile(district, bi, bj);
    }

    // Sidewalk ring around a block.
    if (xa.sidewalk || ya.sidewalk) return style.sidewalkTile ?? TileType.Sidewalk;

    // Hand-authored lot grammar: each seven-tile cell receives setbacks,
    // courtyards, alleys and yards while its surrounding roads stay unchanged.
    const lx = (((tx % PERIOD) + PERIOD) % PERIOD) - ROAD_W - SIDE_W;
    const ly = (((ty % PERIOD) + PERIOD) % PERIOD) - ROAD_W - SIDE_W;
    return this.blockInteriorTile(district, bi, bj, lx, ly);
  }

  private blockInteriorTile(
    district: District,
    bi: number,
    bj: number,
    lx: number,
    ly: number,
  ): TileType {
    const variant = this.blockVariant(bi, bj, 8);
    const centerTx = bi * PERIOD + Math.floor(PERIOD / 2);
    const centerTy = bj * PERIOD + Math.floor(PERIOD / 2);
    const inYazd = inTileRect(centerTx, centerTy, YAZD_RECT);
    const inGilan = inTileRect(centerTx, centerTy, GILAN_RECT);
    const open = this.openBlockTile(district, bi, bj);
    const building = open;

    switch (district) {
      case District.Downtown:
        if (variant % 4 === 0) return lx > 0 && lx < 6 && ly < 6 ? building : TileType.Concrete;
        if (variant % 4 === 1) {
          return (lx <= 2 || lx >= 4) && ly <= 5 ? building : TileType.Concrete;
        }
        if (variant % 4 === 2) {
          return (ly <= 2 || lx <= 2) && !(lx === 1 && ly === 1) ? building : TileType.Concrete;
        }
        return lx >= 1 && lx <= 5 && ly >= 1 && ly <= 5 ? building : TileType.Concrete;
      case District.Commercial:
        if (variant % 3 === 0) {
          return ly <= 3 || (lx <= 1 && ly <= 5) ? building : TileType.Concrete;
        }
        if (variant % 3 === 1) return lx !== 3 && ly <= 5 ? building : TileType.Concrete;
        return lx >= 1 && lx <= 5 && ly <= 4 ? building : TileType.Concrete;
      case District.Residential:
        if (inGilan) {
          return lx % 3 !== 2 && ly % 3 !== 2 && lx !== 6 && ly !== 6 ? building : TileType.Grass;
        }
        if (inYazd) {
          return lx === 0 ||
            lx === 6 ||
            ly === 0 ||
            (ly === 6 && lx < 3) ||
            ((variant & 1) === 0 && lx === 3 && ly < 4)
            ? building
            : TileType.Sand;
        }
        if (variant % 3 === 0) return lx === 3 || ly === 6 ? TileType.Grass : building;
        if (variant % 3 === 1) {
          return (lx <= 2 || lx >= 5) && ly <= 5 ? building : TileType.Grass;
        }
        return lx >= 1 && lx <= 5 && ly <= 4 ? building : TileType.Grass;
      case District.Luxury:
        if (variant % 2 === 0) {
          return lx >= 1 && lx <= 4 && ly >= 1 && ly <= 4 ? building : TileType.Grass;
        }
        return (lx <= 2 && ly <= 3) || (lx >= 5 && ly >= 3) ? building : TileType.Grass;
      case District.OldTown:
        return lx === 0 || ly === 0 || lx === 6 || (ly === 6 && lx < 3) || (lx === 3 && ly > 2)
          ? building
          : open;
      case District.Government:
        return lx >= 1 && lx <= 5 && ly >= 1 && ly <= 4 ? building : TileType.Concrete;
      case District.University:
        return ((lx <= 1 || lx >= 5) && ly <= 4) || (ly === 0 && lx > 1 && lx < 5)
          ? building
          : variant % 2 === 0
            ? TileType.Grass
            : TileType.Concrete;
      case District.Industrial:
        return (variant % 2 === 0 ? lx <= 4 && ly <= 3 : lx >= 1 && lx <= 5 && ly <= 4)
          ? building
          : TileType.Concrete;
      case District.Harbor:
      case District.Marina:
        return (lx <= 3 && ly <= 4) || (variant % 3 === 0 && lx >= 5 && ly <= 2)
          ? building
          : TileType.Concrete;
      case District.Airport:
        return (ly <= 1 && lx >= 1 && lx <= 5) || (variant % 3 === 0 && lx <= 2 && ly <= 4)
          ? variant % 4 === 0
            ? building
            : building
          : TileType.Concrete;
      case District.Historic:
        return lx === 0 ||
          lx === 6 ||
          ly === 0 ||
          (ly === 6 && lx !== 3) ||
          (variant % 3 === 0 && lx === 2 && ly >= 2 && ly <= 4)
          ? building
          : TileType.Sand;
      case District.Bazaar:
        return (lx !== 3 && ly <= 5) || (ly === 6 && (lx === 0 || lx === 6))
          ? building
          : TileType.Sand;
      case District.Village:
        return (lx <= 1 && ly <= 2) || (lx >= 4 && lx <= 5 && ly >= 3 && ly <= 5)
          ? building
          : TileType.Sand;
      case District.Mining:
        return lx <= 3 && ly <= 3
          ? building
          : variant % 2 === 0
            ? TileType.Rock
            : TileType.Concrete;
      case District.Park:
        return TileType.Grass;
      case District.Beach:
        return inGilan && variant % 4 === 0 && lx >= 1 && lx <= 3 && ly >= 1 && ly <= 3
          ? building
          : TileType.Sand;
      case District.Desert:
        return inYazd && variant % 5 === 0 && lx >= 1 && lx <= 3 && ly >= 1 && ly <= 3
          ? building
          : TileType.Sand;
      default:
        return DISTRICT_STYLES[district].block(
          new Random(CITY_SEED ^ (bi * 73856093) ^ (bj * 19349663)),
        );
    }
  }

  private openBlockTile(district: District, bi: number, bj: number): TileType {
    const centerTx = bi * PERIOD + Math.floor(PERIOD / 2);
    const centerTy = bj * PERIOD + Math.floor(PERIOD / 2);
    if (inTileRect(centerTx, centerTy, YAZD_RECT)) return TileType.Sand;
    if (
      district === District.Downtown ||
      district === District.Commercial ||
      district === District.Government ||
      district === District.University ||
      district === District.Industrial ||
      district === District.Harbor ||
      district === District.Marina ||
      district === District.Airport ||
      district === District.Mining
    ) {
      return TileType.Concrete;
    }
    return TileType.Grass;
  }

  private blockVariant(bi: number, bj: number, modulus: number): number {
    let h = Math.imul(bi, 73856093) ^ Math.imul(bj, 19349663) ^ CITY_SEED;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) % modulus;
  }

  /** Stable continuous hash used to jitter parcels without consuming global RNG state. */
  private cellHash(tx: number, ty: number): number {
    let h = Math.imul(Math.floor(tx), 374761393) ^ Math.imul(Math.floor(ty), 668265263);
    h ^= CITY_SEED;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  /** Compose finalized blocks and commit only grammar-owned building candidates. */
  private planAndPaintBuildings(tiles: number[][], blocks: PlannedUrbanBlock[]): PlannedBuilding[] {
    const buildings: PlannedBuilding[] = [];
    const occupied = new Set<string>();
    const reservedAccess = new Set<string>();
    this.plannedSpaces = [];
    let buildingIndex = 0;

    for (const block of blocks) {
      const composition = composeBlockArchitecture(block, CITY_SEED);
      for (const lot of composition.lots) {
        const candidate = this.specializeReservedLandmarkBuilding(
          this.buildingFromGrammarLot(block, lot, buildingIndex),
          this.architectureLandmarkByBlock.get(block.id),
        );
        if (!this.canPlaceBuilding(tiles, candidate, occupied, reservedAccess, block)) continue;
        this.commitBuilding(tiles, candidate, occupied, reservedAccess);
        buildings.push(candidate);
        buildingIndex++;
      }

      let coverage = this.buildingCoverageForBlock(block, buildings, tiles);
      if (!block.purposefulOpenSpace && coverage + 1e-9 < composition.coverageTarget) {
        buildingIndex = this.addDeterministicInfill(
          tiles,
          block,
          composition.coverageTarget,
          buildings,
          occupied,
          reservedAccess,
          buildingIndex,
        );
        coverage = this.buildingCoverageForBlock(block, buildings, tiles);
      }
      const rawArea = this.blockParcelArea(block);
      const developableArea = this.developableAreaForBlock(tiles, block);
      if (
        coverage + 1 / Math.max(1, developableArea) < block.densityTarget &&
        coverage >= 0.12 &&
        developableArea < rawArea * 0.92
      ) {
        // An internal graph-owned alley or diagonal has divided the parcel into
        // narrow residual lots. Preserve that passage and regenerate the block
        // as a deliberate courtyard composition instead of forcing overlap.
        block.purposefulOpenSpace = true;
        block.generationAttempt++;
        block.signature += ':regenerated-courtyard-passage';
      }
      const acceptedBuildings = buildings.filter((building) => building.blockId === block.id);
      const reconciledSpaces = this.reconcileBlockSpaces(
        tiles,
        block,
        composition.spaces,
        acceptedBuildings,
        reservedAccess,
      );
      this.plannedSpaces.push(
        ...this.specializeReservedLandmarkSpaces(
          block,
          reconciledSpaces,
          this.architectureLandmarkByBlock.get(block.id),
        ),
      );
    }
    this.stampPublicRealmFixtureCollision(tiles, buildings, this.plannedSpaces, reservedAccess);
    return buildings;
  }

  /** Stamp transparent collision ownership only beneath reconciled physical fixtures. */
  private stampPublicRealmFixtureCollision(
    tiles: number[][],
    buildings: readonly PlannedBuilding[],
    spaces: readonly PlannedUrbanSpace[],
    reservedAccess: ReadonlySet<string>,
  ): void {
    const buildingCells = new Set<string>();
    for (const building of buildings) {
      for (const part of building.footprint) {
        for (let ty = part.y; ty < part.y + part.height; ty++) {
          for (let tx = part.x; tx < part.x + part.width; tx++) {
            buildingCells.add(`${tx},${ty}`);
          }
        }
      }
    }
    const physicalKinds = new Set<string>(PHYSICAL_GROUND_FEATURE_KINDS);
    for (const space of spaces) {
      const spaceCells = this.publicRealmFootprintCells(space.footprint);
      for (const feature of space.features) {
        if (!physicalKinds.has(feature.kind)) continue;
        const cells: Array<{ x: number; y: number }> = [];
        let safe = true;
        for (let ty = feature.bounds.y; ty < feature.bounds.y + feature.bounds.height; ty++) {
          for (let tx = feature.bounds.x; tx < feature.bounds.x + feature.bounds.width; tx++) {
            const key = `${tx},${ty}`;
            const tile = tiles[ty]?.[tx];
            if (
              !spaceCells.has(key) ||
              buildingCells.has(key) ||
              reservedAccess.has(key) ||
              !this.isResidualSiteTile(tile)
            ) {
              safe = false;
              break;
            }
            cells.push({ x: tx, y: ty });
          }
          if (!safe) break;
        }
        if (!safe) continue;
        for (const cell of cells) {
          const row = tiles[cell.y];
          if (row) row[cell.x] = TileType.UrbanFixture;
        }
      }
    }
  }

  /**
   * Rebase public-realm anchors on the footprints that actually reached the
   * collision raster. Grammar lots rejected by road/geography/access checks
   * therefore become deliberate residual space instead of invisible dead land.
   */
  private reconcileBlockSpaces(
    tiles: number[][],
    block: PlannedUrbanBlock,
    proposed: readonly PlannedUrbanSpace[],
    acceptedBuildings: readonly PlannedBuilding[],
    reservedAccess: ReadonlySet<string>,
  ): PlannedUrbanSpace[] {
    const occupied = new Set<string>();
    for (const building of acceptedBuildings) {
      for (const part of building.footprint) {
        for (let ty = part.y; ty < part.y + part.height; ty++) {
          for (let tx = part.x; tx < part.x + part.width; tx++) occupied.add(`${tx},${ty}`);
        }
      }
    }

    const residual = new Set<string>();
    for (let ty = block.bounds.y; ty < block.bounds.y + block.bounds.height; ty++) {
      for (let tx = block.bounds.x; tx < block.bounds.x + block.bounds.width; tx++) {
        if (
          !this.blockOwnsTile(block, tx, ty) ||
          occupied.has(`${tx},${ty}`) ||
          !this.isResidualSiteTile(tiles[ty]?.[tx])
        ) {
          continue;
        }
        residual.add(`${tx},${ty}`);
      }
    }
    if (residual.size === 0) return [];

    const unclaimed = new Set(residual);
    const reconciled: PlannedUrbanSpace[] = [];
    const usedFixtures = new Set<string>();
    const acceptedSignature = acceptedBuildings.map((building) => building.id).join(',');

    for (const space of proposed) {
      const acceptedCells = new Set<string>();
      for (const key of this.publicRealmFootprintCells(space.footprint)) {
        if (unclaimed.has(key)) acceptedCells.add(key);
      }
      if (acceptedCells.size === 0) continue;
      for (const key of acceptedCells) unclaimed.delete(key);
      const footprint = this.compressPublicRealmCells(acceptedCells);
      const bounds = this.publicRealmBounds(footprint);
      let features = this.reconcileGroundFeatures(
        space.features,
        acceptedCells,
        reservedAccess,
        usedFixtures,
      );
      if (features.length === 0) {
        const longest = footprint
          .slice()
          .sort(
            (first, second) =>
              second.width * second.height - first.width * first.height ||
              second.width - first.width ||
              second.height - first.height,
          )[0];
        if (longest) {
          features = this.reconcileGroundFeatures(
            [
              {
                id: `${space.id}:feature:recovery-path`,
                kind: 'path',
                bounds: {
                  x: longest.x,
                  y: longest.y,
                  width: longest.width >= longest.height ? Math.min(4, longest.width) : 1,
                  height: longest.width >= longest.height ? 1 : Math.min(4, longest.height),
                },
                variant: this.blockVariant(longest.x, longest.y, 4),
              },
            ],
            acceptedCells,
            reservedAccess,
            usedFixtures,
          );
        }
      }
      if (features.length === 0) {
        const point = this.publicRealmPoints(acceptedCells)[0];
        if (point) {
          features = [
            {
              id: `${space.id}:feature:recovery-marker`,
              kind: 'path',
              bounds: { x: point.x, y: point.y, width: 1, height: 1 },
              variant: this.blockVariant(point.x, point.y, 4),
            },
          ];
          usedFixtures.add(`${point.x},${point.y}`);
        }
      }
      reconciled.push({
        ...space,
        blockId: block.id,
        cityId: block.cityId,
        district: block.district,
        program: block.program,
        footprint,
        bounds,
        purposeful: true,
        accessPoints: this.reconcilePublicRealmAccess(space.accessPoints, acceptedCells, block),
        features,
        signature: `${space.signature}:accepted-${acceptedSignature}:cells-${acceptedCells.size}:parts-${footprint.map((part) => `${part.x},${part.y},${part.width},${part.height}`).join('|')}`,
      });
    }

    const recoverySource = proposed[0];
    const recoveryComponents = this.publicRealmComponents(unclaimed);
    for (let componentIndex = 0; componentIndex < recoveryComponents.length; componentIndex++) {
      const component = recoveryComponents[componentIndex];
      if (!component || component.size === 0) continue;
      const id = `${block.id}:realm:recovery:${componentIndex}`;
      const footprint = this.compressPublicRealmCells(component);
      const bounds = this.publicRealmBounds(footprint);
      const sourceTemplates = (recoverySource?.features ?? [])
        .slice(0, 2)
        .map((feature, index) => ({
          ...feature,
          id: `${id}:feature:${index}`,
        }));
      if (sourceTemplates.length === 0) {
        const longest = footprint
          .slice()
          .sort(
            (first, second) =>
              second.width * second.height - first.width * first.height ||
              first.y - second.y ||
              first.x - second.x,
          )[0]!;
        sourceTemplates.push({
          id: `${id}:feature:0`,
          kind: 'path',
          bounds: {
            x: longest.x,
            y: longest.y,
            width: longest.width >= longest.height ? Math.min(4, longest.width) : 1,
            height: longest.width >= longest.height ? 1 : Math.min(4, longest.height),
          },
          variant: this.blockVariant(longest.x, longest.y, 4),
        });
      }
      let features = this.reconcileGroundFeatures(
        sourceTemplates,
        component,
        reservedAccess,
        usedFixtures,
      );
      if (features.length === 0) {
        const point = this.publicRealmPoints(component)[0];
        if (point) {
          features = [
            {
              id: `${id}:feature:recovery-marker`,
              kind: 'path',
              bounds: { x: point.x, y: point.y, width: 1, height: 1 },
              variant: this.blockVariant(point.x, point.y, 4),
            },
          ];
          usedFixtures.add(`${point.x},${point.y}`);
        }
      }
      reconciled.push({
        id,
        blockId: block.id,
        cityId: block.cityId,
        district: block.district,
        program: block.program,
        kind: recoverySource?.kind ?? (block.cityId === 'gilan' ? 'garden' : 'courtyard'),
        footprint,
        bounds,
        purposeful: true,
        accessPoints: this.reconcilePublicRealmAccess(
          recoverySource?.accessPoints ?? [],
          component,
          block,
        ),
        features,
        signature: `${block.signature}:recovery-${componentIndex}:cells-${component.size}:parts-${footprint.map((part) => `${part.x},${part.y},${part.width},${part.height}`).join('|')}`,
      });
    }

    return reconciled;
  }

  private publicRealmFootprintCells(footprint: readonly TileRect[]): Set<string> {
    const cells = new Set<string>();
    for (const part of footprint) {
      for (let y = part.y; y < part.y + part.height; y++) {
        for (let x = part.x; x < part.x + part.width; x++) cells.add(`${x},${y}`);
      }
    }
    return cells;
  }

  private publicRealmPoints(cells: ReadonlySet<string>): Array<{ x: number; y: number }> {
    return Array.from(cells)
      .map((key) => {
        const [x, y] = key.split(',').map(Number);
        return { x: x ?? 0, y: y ?? 0 };
      })
      .sort((first, second) => first.y - second.y || first.x - second.x);
  }

  private compressPublicRealmCells(cells: ReadonlySet<string>): TileRect[] {
    const rows = new Map<number, number[]>();
    for (const point of this.publicRealmPoints(cells)) {
      const row = rows.get(point.y) ?? [];
      row.push(point.x);
      rows.set(point.y, row);
    }
    const ys = Array.from(rows.keys()).sort((first, second) => first - second);
    if (ys.length === 0) return [];
    const active = new Map<string, TileRect>();
    const completed: TileRect[] = [];
    for (let y = ys[0]!; y <= ys[ys.length - 1]!; y++) {
      const xs = rows.get(y) ?? [];
      const runs: Array<{ x: number; width: number }> = [];
      for (let index = 0; index < xs.length;) {
        const start = xs[index]!;
        let end = start + 1;
        index++;
        while (index < xs.length && xs[index] === end) {
          end++;
          index++;
        }
        runs.push({ x: start, width: end - start });
      }
      const seen = new Set<string>();
      for (const run of runs) {
        const key = `${run.x}:${run.width}`;
        seen.add(key);
        const current = active.get(key);
        if (current) current.height++;
        else active.set(key, { x: run.x, y, width: run.width, height: 1 });
      }
      for (const [key, rect] of Array.from(active)) {
        if (seen.has(key)) continue;
        completed.push(rect);
        active.delete(key);
      }
    }
    completed.push(...active.values());
    return completed.sort((first, second) => first.y - second.y || first.x - second.x);
  }

  private publicRealmBounds(footprint: readonly TileRect[]): TileRect {
    const minX = Math.min(...footprint.map((part) => part.x));
    const minY = Math.min(...footprint.map((part) => part.y));
    const maxX = Math.max(...footprint.map((part) => part.x + part.width));
    const maxY = Math.max(...footprint.map((part) => part.y + part.height));
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  private publicRealmComponents(cells: ReadonlySet<string>): Set<string>[] {
    const remaining = new Set(cells);
    const components: Set<string>[] = [];
    for (const start of this.publicRealmPoints(cells)) {
      const startKey = `${start.x},${start.y}`;
      if (!remaining.delete(startKey)) continue;
      const component = new Set<string>([startKey]);
      const queue = [start];
      for (let index = 0; index < queue.length; index++) {
        const point = queue[index]!;
        for (const neighbour of [
          { x: point.x + 1, y: point.y },
          { x: point.x - 1, y: point.y },
          { x: point.x, y: point.y + 1 },
          { x: point.x, y: point.y - 1 },
        ]) {
          const key = `${neighbour.x},${neighbour.y}`;
          if (!remaining.delete(key)) continue;
          component.add(key);
          queue.push(neighbour);
        }
      }
      components.push(component);
    }
    return components;
  }

  private reconcilePublicRealmAccess(
    requested: readonly { x: number; y: number }[],
    cells: ReadonlySet<string>,
    block: PlannedUrbanBlock,
  ): Array<{ x: number; y: number }> {
    const candidates = this.publicRealmPoints(cells);
    if (candidates.length === 0) return [];
    const targets =
      requested.length > 0
        ? requested
        : [
            { x: block.bounds.x + Math.floor(block.bounds.width / 2), y: block.bounds.y },
            { x: block.bounds.x, y: block.bounds.y + Math.floor(block.bounds.height / 2) },
          ];
    const result: Array<{ x: number; y: number }> = [];
    const used = new Set<string>();
    for (const target of targets) {
      let best: { x: number; y: number } | undefined;
      let bestDistance = Infinity;
      for (const candidate of candidates) {
        if (used.has(`${candidate.x},${candidate.y}`)) continue;
        const distance = Math.abs(candidate.x - target.x) + Math.abs(candidate.y - target.y);
        if (distance >= bestDistance) continue;
        best = candidate;
        bestDistance = distance;
      }
      if (!best) continue;
      used.add(`${best.x},${best.y}`);
      result.push({ ...best });
    }
    return result;
  }

  private reconcileGroundFeatures(
    templates: readonly PlannedGroundFeature[],
    spaceCells: ReadonlySet<string>,
    reservedAccess: ReadonlySet<string>,
    used: Set<string>,
  ): PlannedGroundFeature[] {
    const features: PlannedGroundFeature[] = [];
    for (const template of templates) {
      // Paint-only markings (paths, courts, bays) may explain and decorate an
      // entrance corridor; only physical fixtures must stay off that route.
      const blockedAccess = (
        PHYSICAL_GROUND_FEATURE_KINDS as readonly PlannedGroundFeature['kind'][]
      ).includes(template.kind)
        ? reservedAccess
        : new Set<string>();
      const width = Math.max(1, Math.floor(template.bounds.width));
      const height = Math.max(1, Math.floor(template.bounds.height));
      const original = {
        x: Math.floor(template.bounds.x),
        y: Math.floor(template.bounds.y),
        width,
        height,
      };
      let bounds = this.nearestPublicRealmFeatureRect(
        original,
        original.x,
        original.y,
        spaceCells,
        blockedAccess,
        used,
      );
      if (!bounds) {
        for (const size of this.degradedPublicRealmFeatureSizes(template, width, height)) {
          bounds = this.nearestPublicRealmFeatureRect(
            { ...original, ...size },
            original.x,
            original.y,
            spaceCells,
            blockedAccess,
            used,
          );
          if (bounds) break;
        }
      }
      if (!bounds) continue;
      for (let y = bounds.y; y < bounds.y + bounds.height; y++) {
        for (let x = bounds.x; x < bounds.x + bounds.width; x++) used.add(`${x},${y}`);
      }
      features.push({ ...template, bounds });
    }
    return features;
  }

  private nearestPublicRealmFeatureRect(
    size: TileRect,
    originX: number,
    originY: number,
    spaceCells: ReadonlySet<string>,
    reservedAccess: ReadonlySet<string>,
    used: ReadonlySet<string>,
  ): TileRect | null {
    const candidates = this.publicRealmPoints(spaceCells);
    candidates.sort((first, second) => {
      const firstDistance = Math.abs(first.x - originX) + Math.abs(first.y - originY);
      const secondDistance = Math.abs(second.x - originX) + Math.abs(second.y - originY);
      return firstDistance - secondDistance || first.y - second.y || first.x - second.x;
    });
    for (const point of candidates) {
      let fits = true;
      for (let y = point.y; y < point.y + size.height && fits; y++) {
        for (let x = point.x; x < point.x + size.width; x++) {
          const key = `${x},${y}`;
          if (!spaceCells.has(key) || reservedAccess.has(key) || used.has(key)) {
            fits = false;
            break;
          }
        }
      }
      if (fits) return { x: point.x, y: point.y, width: size.width, height: size.height };
    }
    return null;
  }

  private degradedPublicRealmFeatureSizes(
    feature: PlannedGroundFeature,
    width: number,
    height: number,
  ): Array<{ width: number; height: number }> {
    const linear = ['path', 'fence', 'wall', 'gate', 'goal'].includes(feature.kind);
    const area = [
      'parking-bay',
      'loading-bay',
      'planter',
      'flower-bed',
      'football-marking',
      'basketball-marking',
      'solar-array',
      'service-marking',
      'ambulance-bay',
      'police-parking',
      'stadium-stand',
    ].includes(feature.kind);
    if (!linear && !area) return [];
    const minimumWidth =
      feature.kind === 'football-marking' || feature.kind === 'basketball-marking'
        ? Math.min(3, width)
        : linear && width >= height
          ? Math.min(2, width)
          : 1;
    const minimumHeight =
      feature.kind === 'football-marking' || feature.kind === 'basketball-marking'
        ? Math.min(3, height)
        : linear && height > width
          ? Math.min(2, height)
          : 1;
    const sizes: Array<{ width: number; height: number }> = [];
    for (let candidateWidth = width; candidateWidth >= minimumWidth; candidateWidth--) {
      for (let candidateHeight = height; candidateHeight >= minimumHeight; candidateHeight--) {
        if (candidateWidth === width && candidateHeight === height) continue;
        if (linear && width >= height && candidateHeight !== height) continue;
        if (linear && height > width && candidateWidth !== width) continue;
        sizes.push({ width: candidateWidth, height: candidateHeight });
      }
    }
    return sizes.sort(
      (first, second) =>
        second.width * second.height - first.width * first.height ||
        second.width - first.width ||
        second.height - first.height,
    );
  }

  private isResidualSiteTile(tile: number | undefined): boolean {
    return !(
      tile === undefined ||
      this.isBuildingTile(tile) ||
      PLANNED_ROAD_SURFACE_SET.has(tile) ||
      tile === TileType.Sidewalk ||
      tile === TileType.Water ||
      tile === TileType.Rock ||
      tile === TileType.Runway ||
      tile === TileType.Dock ||
      tile === TileType.InteriorFloor ||
      tile === TileType.InteriorWall ||
      tile === TileType.InteriorFixture
    );
  }

  /** Add legacy styling fields without changing the grammar's authoritative geometry. */
  private buildingFromGrammarLot(
    block: PlannedUrbanBlock,
    lot: PlannedBuildingLot,
    index: number,
  ): PlannedBuilding {
    const archetype = this.archetypeForBuildingKind(lot.kind, lot.size);
    const salt = Math.floor(
      this.cellHash(lot.bounds.x + index * 17, lot.bounds.y + lot.bounds.width * 31) * 1_000_003,
    );
    return {
      id: lot.id,
      blockId: block.id,
      cityId: block.cityId,
      district: block.district,
      landUse: block.landUse,
      program: block.program,
      landmark: block.landmark && lot.primary,
      footprint: lot.footprint.map((part) => ({ ...part })),
      bounds: { ...lot.bounds },
      archetype,
      material: this.buildingMaterialFor(block.cityId, block.district, archetype, salt),
      roofStyle: this.roofStyleFor(block.cityId, block.district, archetype, lot.floors, salt),
      facadeStyle: this.facadeStyleFor(block.cityId, block.district, archetype, salt),
      groundFloorUse: this.groundFloorUseFor(block, archetype, salt),
      floors: lot.floors,
      setbackTiles: lot.setbackTiles,
      signature: lot.signature,
      shape: lot.shape,
      size: lot.size,
      kind: lot.kind,
      entrances: lot.entrances.map((entrance) => ({ ...entrance, buildingId: lot.id })),
      roofAssets: lot.roofAssets.map((asset) => ({ ...asset, buildingId: lot.id })),
    };
  }

  /** Give the reserved Yazd civic lot its explicit religious identity and roof silhouette. */
  private specializeReservedLandmarkBuilding(
    building: PlannedBuilding,
    landmarkId: RequiredArchitectureLandmarkId | undefined,
  ): PlannedBuilding {
    if (!building.landmark) return building;
    if (landmarkId === 'tehran-financial') {
      return {
        ...building,
        material: 'glass',
        facadeStyle: `${building.facadeStyle}:financial-glass-crown`,
        signature: `${building.signature}:reserved-tehran-financial:glass-crown`,
      };
    }
    if (landmarkId !== 'yazd-mosque') return building;

    const cells: Array<{ x: number; y: number }> = [];
    for (const part of building.footprint) {
      for (let y = part.y; y < part.y + part.height; y++) {
        for (let x = part.x; x < part.x + part.width; x++) cells.push({ x, y });
      }
    }
    if (cells.length < 2) return building;

    const centerX = building.bounds.x + building.bounds.width / 2;
    const centerY = building.bounds.y + building.bounds.height / 2;
    cells.sort((first, second) => {
      const firstDistance = (first.x - centerX) ** 2 + (first.y - centerY) ** 2;
      const secondDistance = (second.x - centerX) ** 2 + (second.y - centerY) ** 2;
      return firstDistance - secondDistance || first.y - second.y || first.x - second.x;
    });
    const domeCell = cells[0]!;
    const minaretCell = cells.reduce((farthest, cell) => {
      const farthestDistance =
        Math.abs(farthest.x - domeCell.x) + Math.abs(farthest.y - domeCell.y);
      const cellDistance = Math.abs(cell.x - domeCell.x) + Math.abs(cell.y - domeCell.y);
      return cellDistance > farthestDistance ? cell : farthest;
    }, cells[1]!);
    const reservedRoofCells = new Set([
      `${domeCell.x},${domeCell.y}`,
      `${minaretCell.x},${minaretCell.y}`,
    ]);
    const retainedAssets = building.roofAssets
      .filter(
        (asset) =>
          asset.kind !== 'dome' &&
          asset.kind !== 'minaret' &&
          !Array.from(reservedRoofCells).some((key) => {
            const [xText, yText] = key.split(',');
            const x = Number(xText);
            const y = Number(yText);
            return (
              x >= asset.bounds.x &&
              y >= asset.bounds.y &&
              x < asset.bounds.x + asset.bounds.width &&
              y < asset.bounds.y + asset.bounds.height
            );
          }),
      )
      .slice(0, 3);

    return {
      ...building,
      kind: 'mosque',
      archetype: 'public',
      material: 'adobe',
      roofStyle: 'flat',
      floors: Math.min(5, Math.max(2, building.floors)),
      groundFloorUse: 'office',
      facadeStyle: `${building.facadeStyle}:mosque-courtyard:arched-portals`,
      signature: `${building.signature}:reserved-yazd-mosque:dome-minaret`,
      roofAssets: [
        {
          id: `${building.id}:roof:dome`,
          buildingId: building.id,
          kind: 'dome',
          bounds: { ...domeCell, width: 1, height: 1 },
          facing: 'north',
          variant: 0,
        },
        {
          id: `${building.id}:roof:minaret`,
          buildingId: building.id,
          kind: 'minaret',
          bounds: { ...minaretCell, width: 1, height: 1 },
          facing: 'east',
          variant: 0,
        },
        ...retainedAssets,
      ],
    };
  }

  private specializeReservedLandmarkSpaces(
    block: PlannedUrbanBlock,
    spaces: readonly PlannedUrbanSpace[],
    landmarkId: RequiredArchitectureLandmarkId | undefined,
  ): PlannedUrbanSpace[] {
    if (landmarkId !== 'yazd-mosque') return spaces.slice();
    return spaces.map((space) => ({
      ...space,
      kind: 'mosque-court',
      program: block.program,
      signature: `${space.signature}:reserved-yazd-mosque-court`,
    }));
  }

  private archetypeForBuildingKind(
    kind: PlannedBuildingKind,
    size: PlannedBuildingLot['size'],
  ): PlannedBuildingArchetype {
    switch (kind) {
      case 'house':
        return size === 'small' ? 'tiny-house' : 'small-house';
      case 'villa':
        return 'small-house';
      case 'apartment':
        return size === 'small' || size === 'medium' ? 'medium-apartment' : 'large-apartment';
      case 'office':
        return 'office';
      case 'tower':
        return 'tower';
      case 'retail':
      case 'market':
        return size === 'small' ? 'corner-shop' : 'wide-commercial';
      case 'factory':
      case 'warehouse':
      case 'terminal':
      case 'utility':
        return 'industrial';
      case 'parking-structure':
      case 'gas-station':
      case 'hotel':
        return 'wide-commercial';
      default:
        return 'public';
    }
  }

  /** Close small accidental coverage gaps without replacing grammar massing with dense rectangles. */
  private addDeterministicInfill(
    tiles: number[][],
    block: PlannedUrbanBlock,
    targetCoverage: number,
    buildings: PlannedBuilding[],
    occupied: Set<string>,
    reservedAccess: Set<string>,
    firstIndex: number,
  ): number {
    const area = Math.max(1, block.bounds.width * block.bounds.height);
    const start = this.blockVariant(block.bounds.x, block.bounds.y, area);
    let buildingIndex = firstIndex;
    let coverage = this.buildingCoverageForBlock(block, buildings, tiles);
    const dimensions: ReadonlyArray<readonly [number, number]> = [
      [12, 5],
      [5, 12],
      [11, 5],
      [5, 11],
      [10, 5],
      [5, 10],
      [12, 4],
      [4, 12],
      [10, 4],
      [4, 10],
      [8, 4],
      [4, 8],
      [6, 4],
      [4, 6],
      [5, 3],
      [3, 5],
      [4, 4],
      [4, 3],
      [3, 4],
      [3, 3],
      [4, 2],
      [2, 4],
      [3, 2],
      [2, 3],
      [2, 2],
    ];
    const fill = (
      candidateDimensions: ReadonlyArray<readonly [number, number]>,
      allowDogleg: boolean,
    ): void => {
      for (let scan = 0; scan < area * 2 && coverage + 1e-9 < targetCoverage; scan++) {
        const cell = (scan + start) % area;
        const x = block.bounds.x + (cell % block.bounds.width);
        const y = block.bounds.y + Math.floor(cell / block.bounds.width);
        let accepted = false;
        for (const [requestedWidth, requestedHeight] of candidateDimensions) {
          const width = Math.min(requestedWidth, block.bounds.x + block.bounds.width - x);
          const height = Math.min(requestedHeight, block.bounds.y + block.bounds.height - y);
          if (width < 2 || height < 2) continue;
          if (
            !this.canPlaceInfillFootprint(
              tiles,
              block,
              x,
              y,
              width,
              height,
              occupied,
              reservedAccess,
            )
          ) {
            continue;
          }
          const facings = this.infillFacings(block, x, y, width, height);
          for (const facing of facings) {
            for (let entranceVariant = 0; entranceVariant < 5; entranceVariant++) {
              const candidate = this.infillBuilding(
                block,
                x,
                y,
                width,
                height,
                buildingIndex,
                facing,
                entranceVariant,
                allowDogleg,
                tiles,
                occupied,
                reservedAccess,
              );
              if (
                !candidate ||
                !this.canPlaceBuilding(tiles, candidate, occupied, reservedAccess, block)
              ) {
                continue;
              }
              this.commitBuilding(tiles, candidate, occupied, reservedAccess);
              buildings.push(candidate);
              buildingIndex++;
              coverage = this.buildingCoverageForBlock(block, buildings, tiles);
              accepted = true;
              break;
            }
            if (accepted) break;
          }
          if (accepted) break;
        }
        if (accepted && coverage + 1e-9 >= targetCoverage) break;
      }
    };
    fill(dimensions, false);
    if (
      coverage + 1e-9 < targetCoverage &&
      coverage >= Math.max(0.3, targetCoverage - 0.06)
    ) {
      // Only close a small, already-urbanized residual deficit with routed
      // doglegs. This avoids letting early overlapping parcel envelopes claim
      // large interior sites that belong to later blocks.
      fill(
        [
          [2, 2],
          [3, 2],
          [2, 3],
          [3, 3],
        ],
        true,
      );
    }
    return buildingIndex;
  }

  private canPlaceInfillFootprint(
    tiles: number[][],
    block: PlannedUrbanBlock,
    x: number,
    y: number,
    width: number,
    height: number,
    occupied: ReadonlySet<string>,
    reservedAccess: ReadonlySet<string>,
  ): boolean {
    if (!this.blockOwnsRect(block, { x, y, width, height })) return false;
    for (let ty = y; ty < y + height; ty++) {
      for (let tx = x; tx < x + width; tx++) {
        const key = `${tx},${ty}`;
        if (
          occupied.has(key) ||
          reservedAccess.has(key) ||
          !this.isDevelopableBlockTile(tiles[ty]?.[tx]) ||
          tiles[ty]?.[tx] === TileType.InteriorDoor
        ) {
          return false;
        }
      }
    }
    return true;
  }

  private infillBuilding(
    block: PlannedUrbanBlock,
    x: number,
    y: number,
    width: number,
    height: number,
    index: number,
    facing: PlannedFacing,
    entranceVariant: number,
    allowDogleg: boolean,
    tiles: number[][],
    occupied: ReadonlySet<string>,
    reservedAccess: ReadonlySet<string>,
  ): PlannedBuilding | null {
    const id = `${block.id}:infill:${index}`;
    const entrance = this.infillEntrance(
      block,
      id,
      x,
      y,
      width,
      height,
      facing,
      entranceVariant,
      allowDogleg,
      tiles,
      occupied,
      reservedAccess,
    );
    if (!entrance) return null;
    const kind = this.infillKindFor(block);
    const salt = this.blockVariant(x + index * 11, y + index * 19, 1_000_003);
    const floorRange =
      block.cityId === 'tehran' && (kind === 'apartment' || kind === 'office')
        ? 5
        : block.cityId === 'yazd'
          ? 2
          : 3;
    const roofKind =
      block.cityId === 'yazd'
        ? 'windcatcher'
        : block.cityId === 'gilan'
          ? 'chimney'
          : kind === 'factory' || kind === 'warehouse'
            ? 'vent'
            : 'air-conditioner';
    const lot: PlannedBuildingLot = {
      id,
      blockId: block.id,
      cityId: block.cityId,
      district: block.district,
      program: block.program,
      bounds: { x, y, width, height },
      shape: 'rectangle',
      size: 'small',
      kind,
      floors:
        1 +
        this.mod(
          index + this.blockVariant(block.bounds.x, block.bounds.y, floorRange),
          floorRange,
        ),
      setbackTiles: 0,
      frontage: facing,
      rotation: facing === 'north' ? 0 : facing === 'east' ? 90 : facing === 'south' ? 180 : 270,
      mirrored: false,
      primary: false,
      footprint: [{ x, y, width, height }],
      entrances: [entrance],
      roofAssets: [
        {
          id: `${id}:roof:0`,
          buildingId: id,
          kind: roofKind,
          bounds: {
            x: x + Math.floor((width - 1) / 2),
            y: y + Math.floor((height - 1) / 2),
            width: 1,
            height: 1,
          },
          facing,
          variant: this.mod(salt >>> 5, 4),
        },
      ],
      signature: `${block.signature}:small-infill:${x},${y}:${width}x${height}:${salt}`,
    };
    return this.buildingFromGrammarLot(block, lot, index);
  }

  private infillFacings(
    block: PlannedUrbanBlock,
    x: number,
    y: number,
    width: number,
    height: number,
  ): PlannedFacing[] {
    const candidates: Array<{ facing: PlannedFacing; distance: number }> = [
      { facing: 'north', distance: y - block.bounds.y },
      { facing: 'east', distance: block.bounds.x + block.bounds.width - (x + width) },
      { facing: 'south', distance: block.bounds.y + block.bounds.height - (y + height) },
      { facing: 'west', distance: x - block.bounds.x },
    ];
    candidates.sort((first, second) => first.distance - second.distance);
    return candidates.map((candidate) => candidate.facing);
  }

  private infillEntrance(
    block: PlannedUrbanBlock,
    buildingId: string,
    x: number,
    y: number,
    width: number,
    height: number,
    facing: PlannedFacing,
    entranceVariant: number,
    allowDogleg: boolean,
    tiles: number[][],
    occupied: ReadonlySet<string>,
    reservedAccess: ReadonlySet<string>,
  ): PlannedEntrance | null {
    const span = facing === 'north' || facing === 'south' ? width : height;
    const offsets = Array.from(
      new Set([
        Math.floor((span - 1) / 2),
        Math.floor((span - 1) / 3),
        Math.ceil(((span - 1) * 2) / 3),
        0,
        span - 1,
      ]),
    );
    const offset = offsets[this.mod(entranceVariant, offsets.length)] ?? 0;
    const position =
      facing === 'north'
        ? { x: x + offset, y }
        : facing === 'south'
          ? { x: x + offset, y: y + height - 1 }
          : facing === 'east'
            ? { x: x + width - 1, y: y + offset }
            : { x, y: y + offset };
    const delta = this.facingDelta(facing);
    const apron = { x: position.x + delta.x, y: position.y + delta.y };
    const accessPath = allowDogleg
      ? this.infillAccessPath(
          block,
          apron,
          facing,
          { x, y, width, height },
          tiles,
          occupied,
          reservedAccess,
        )
      : this.straightInfillAccessPath(block, apron, facing);
    if (!accessPath) return null;
    return {
      id: `${buildingId}:entrance:0`,
      buildingId,
      position,
      apron,
      facing,
      kind: this.infillEntranceKind(this.infillKindFor(block)),
      primary: true,
      accessPath,
    };
  }

  private straightInfillAccessPath(
    block: PlannedUrbanBlock,
    start: PlannedTilePoint,
    facing: PlannedFacing,
  ): PlannedTilePoint[] | null {
    if (!this.blockOwnsTile(block, start.x, start.y)) return null;
    const delta = this.facingDelta(facing);
    const accessPath: PlannedTilePoint[] = [{ ...start }];
    let cursor = { ...start };
    // Primary infill is frontage massing: keep authored access short so one
    // early building cannot reserve a corridor through an entire superblock.
    for (let step = 0; step < 3; step++) {
      if (this.reachesBlockFrontage(block, cursor)) return accessPath;
      cursor = { x: cursor.x + delta.x, y: cursor.y + delta.y };
      if (!this.blockOwnsTile(block, cursor.x, cursor.y)) return null;
      accessPath.push(cursor);
    }
    return null;
  }

  private infillAccessPath(
    block: PlannedUrbanBlock,
    start: { x: number; y: number },
    facing: PlannedFacing,
    footprint: TileRect,
    tiles: number[][],
    occupied: ReadonlySet<string>,
    reservedAccess: ReadonlySet<string>,
  ): PlannedTilePoint[] | null {
    const inFootprint = (point: PlannedTilePoint): boolean =>
      point.x >= footprint.x &&
      point.y >= footprint.y &&
      point.x < footprint.x + footprint.width &&
      point.y < footprint.y + footprint.height;
    const canTraverse = (point: PlannedTilePoint): boolean => {
      if (!this.blockOwnsTile(block, point.x, point.y)) return false;
      const key = `${point.x},${point.y}`;
      const tile = tiles[point.y]?.[point.x];
      return !(
        tile === undefined ||
        inFootprint(point) ||
        occupied.has(key) ||
        reservedAccess.has(key) ||
        SOLID_SET.has(tile) ||
        PLANNED_ROAD_SURFACE_SET.has(tile) ||
        tile === TileType.Water ||
        tile === TileType.Rock ||
        tile === TileType.Runway ||
        tile === TileType.Dock
      );
    };
    if (!canTraverse(start)) return null;

    const forward = this.facingDelta(facing);
    const right = { x: -forward.y, y: forward.x };
    const directions = [
      forward,
      right,
      { x: -right.x, y: -right.y },
      { x: -forward.x, y: -forward.y },
    ];
    const startKey = `${start.x},${start.y}`;
    const queue: PlannedTilePoint[] = [{ ...start }];
    const previous = new Map<string, string | null>([[startKey, null]]);
    const pathSteps = new Map<string, number>([[startKey, 0]]);
    const maximumSteps = Math.min(8, block.bounds.width + block.bounds.height);
    for (let head = 0; head < queue.length; head++) {
      const point = queue[head]!;
      const pointKey = `${point.x},${point.y}`;
      if (this.reachesBlockFrontage(block, point)) {
        const path: PlannedTilePoint[] = [];
        let cursor: string | null = pointKey;
        while (cursor) {
          const [xText, yText] = cursor.split(',');
          path.push({ x: Number(xText), y: Number(yText) });
          cursor = previous.get(cursor) ?? null;
        }
        path.reverse();
        return path;
      }
      const steps = pathSteps.get(pointKey) ?? maximumSteps;
      if (steps >= maximumSteps) continue;
      for (const direction of directions) {
        const next = { x: point.x + direction.x, y: point.y + direction.y };
        const key = `${next.x},${next.y}`;
        if (previous.has(key) || !canTraverse(next)) continue;
        previous.set(key, pointKey);
        pathSteps.set(key, steps + 1);
        queue.push(next);
      }
    }
    return null;
  }

  private facingDelta(facing: PlannedFacing): { x: number; y: number } {
    switch (facing) {
      case 'north':
        return { x: 0, y: -1 };
      case 'east':
        return { x: 1, y: 0 };
      case 'south':
        return { x: 0, y: 1 };
      case 'west':
        return { x: -1, y: 0 };
    }
  }

  private infillKindFor(block: PlannedUrbanBlock): PlannedBuildingKind {
    switch (block.program) {
      case 'hospital':
        return 'hospital';
      case 'police-station':
        return 'police';
      case 'fire-station':
        return 'fire-station';
      case 'school':
        return 'school';
      case 'university-campus':
        return 'university';
      case 'government-complex':
        return 'government';
      case 'stadium':
        return 'stadium';
      case 'sports-center':
        return 'sports-hall';
      case 'factory':
        return 'factory';
      case 'warehouse':
      case 'industrial-yard':
        return 'warehouse';
      case 'parking-garage':
        return 'parking-structure';
      case 'hotel':
        return 'hotel';
      case 'market':
        return 'market';
      default:
        if (block.landUse === 'residential') {
          return block.program === 'apartments' ? 'apartment' : 'house';
        }
        if (block.landUse === 'office') return 'office';
        if (block.landUse === 'industrial') return 'warehouse';
        if (block.landUse === 'commercial' || block.landUse === 'mixed-use') return 'retail';
        if (block.landUse === 'infrastructure') return 'utility';
        return 'government';
    }
  }

  private infillEntranceKind(kind: PlannedBuildingKind): PlannedEntrance['kind'] {
    if (kind === 'house' || kind === 'villa' || kind === 'apartment') return 'residential';
    if (kind === 'retail' || kind === 'market' || kind === 'hotel') return 'storefront';
    if (kind === 'factory' || kind === 'warehouse' || kind === 'utility') return 'service';
    if (kind === 'terminal' || kind === 'parking-structure') return 'vehicle';
    if (kind === 'hospital' || kind === 'fire-station') return 'emergency';
    return 'main';
  }

  private buildingCoverageForBlock(
    block: PlannedUrbanBlock,
    buildings: readonly PlannedBuilding[],
    tiles?: number[][],
  ): number {
    const blockArea = tiles
      ? this.developableAreaForBlock(tiles, block)
      : this.blockParcelArea(block);
    if (blockArea <= 0) return 0;
    let buildingArea = 0;
    for (const building of buildings) {
      if (building.blockId !== block.id) continue;
      for (const part of building.footprint) buildingArea += part.width * part.height;
    }
    return Math.min(1, buildingArea / blockArea);
  }

  private developableAreaForBlock(tiles: number[][], block: PlannedUrbanBlock): number {
    let area = 0;
    for (let ty = block.bounds.y; ty < block.bounds.y + block.bounds.height; ty++) {
      const row = tiles[ty];
      if (!row) continue;
      for (let tx = block.bounds.x; tx < block.bounds.x + block.bounds.width; tx++) {
        if (!this.blockOwnsTile(block, tx, ty) || !this.isDevelopableBlockTile(row[tx])) continue;
        area++;
      }
    }
    return area;
  }

  private buildingMaterialFor(
    city: CityId,
    district: District,
    archetype: PlannedBuildingArchetype,
    salt: number,
  ): PlannedBuildingMaterial {
    return selectBuildingMaterial(city, district, archetype, salt);
  }

  private roofStyleFor(
    city: CityId,
    district: District,
    archetype: PlannedBuildingArchetype,
    floors: number,
    salt: number,
  ): PlannedRoofStyle {
    return selectRoofStyle(city, district, archetype, floors, salt);
  }

  private groundFloorUseFor(
    block: PlannedUrbanBlock,
    archetype: PlannedBuildingArchetype,
    salt: number,
  ): PlannedGroundFloorUse {
    let choices: readonly PlannedGroundFloorUse[];
    if (block.program === 'hospital') choices = ['clinic', 'pharmacy', 'office'];
    else if (block.program === 'school' || block.program === 'university-campus') {
      choices = ['bookstore', 'gym', 'coffee-shop', 'office'];
    } else if (block.program === 'police-station' || block.program === 'fire-station') {
      choices = ['office', 'parking'];
    } else if (block.program === 'parking-garage') choices = ['parking', 'office'];
    else if (block.program === 'restaurant-row') choices = ['restaurant', 'coffee-shop', 'market'];
    else if (block.program === 'market' || block.program === 'shopping-center') {
      choices = ['market', 'supermarket', 'electronics', 'pharmacy', 'coffee-shop'];
    } else if (block.program === 'financial-center') choices = ['bank', 'office', 'coffee-shop'];
    else if (block.program === 'hotel') choices = ['restaurant', 'coffee-shop', 'gym', 'parking'];
    else if (archetype === 'industrial') choices = ['parking', 'office'];
    else if (archetype === 'public') choices = ['clinic', 'office', 'gym', 'bookstore'];
    else if (block.district === District.Commercial || block.district === District.Downtown) {
      choices = [
        'restaurant',
        'coffee-shop',
        'market',
        'bank',
        'gym',
        'clinic',
        'bookstore',
        'pharmacy',
        'electronics',
        'supermarket',
        'office',
        'parking',
      ];
    } else if (block.district === District.Bazaar || block.district === District.OldTown) {
      choices = ['market', 'restaurant', 'coffee-shop', 'bookstore', 'pharmacy'];
    } else choices = ['residential', 'coffee-shop', 'clinic', 'pharmacy', 'office'];
    return choices[this.mod(salt >>> 12, choices.length)] ?? 'residential';
  }

  private facadeStyleFor(
    city: CityId,
    district: District,
    archetype: PlannedBuildingArchetype,
    salt: number,
  ): string {
    return selectFacadeStyle(city, district, archetype, salt);
  }

  /** Validate semantic massing without rejecting purposeful long industrial/retail forms. */
  private hasProfessionalBuildingMassing(building: PlannedBuilding): boolean {
    if (building.floors < 1 || building.floors > 60) return false;
    if (
      building.bounds.width < 2 ||
      building.bounds.height < 2 ||
      building.footprint.length === 0 ||
      building.footprint.some((part) => part.width < 2 || part.height < 2)
    ) {
      return false;
    }
    const footprintCells = new Set<string>();
    for (const part of building.footprint) {
      for (let ty = part.y; ty < part.y + part.height; ty++) {
        for (let tx = part.x; tx < part.x + part.width; tx++) {
          const key = `${tx},${ty}`;
          if (footprintCells.has(key)) return false;
          footprintCells.add(key);
        }
      }
    }
    const actualMinX = Math.min(...building.footprint.map((part) => part.x));
    const actualMinY = Math.min(...building.footprint.map((part) => part.y));
    const actualMaxX = Math.max(...building.footprint.map((part) => part.x + part.width));
    const actualMaxY = Math.max(...building.footprint.map((part) => part.y + part.height));
    if (
      building.bounds.x !== actualMinX ||
      building.bounds.y !== actualMinY ||
      building.bounds.width !== actualMaxX - actualMinX ||
      building.bounds.height !== actualMaxY - actualMinY
    ) {
      return false;
    }
    const aspect = Math.max(
      building.bounds.width / building.bounds.height,
      building.bounds.height / building.bounds.width,
    );
    const elongatedProgram =
      building.kind === 'factory' ||
      building.kind === 'warehouse' ||
      building.kind === 'retail' ||
      building.kind === 'market' ||
      building.kind === 'stadium' ||
      building.kind === 'sports-hall' ||
      building.kind === 'parking-structure' ||
      building.kind === 'terminal';
    if (aspect > (elongatedProgram ? 24 : 12)) return false;
    const envelopeArea = building.bounds.width * building.bounds.height;
    return footprintCells.size / Math.max(1, envelopeArea) >= 0.18;
  }

  private canPlaceBuilding(
    tiles: number[][],
    building: PlannedBuilding,
    occupied: ReadonlySet<string>,
    reservedAccess: ReadonlySet<string>,
    block?: PlannedUrbanBlock,
  ): boolean {
    if (!this.hasProfessionalBuildingMassing(building)) return false;
    if (block && building.blockId !== block.id) return false;
    for (const part of building.footprint) {
      if (block && !this.blockOwnsRect(block, part)) return false;
      for (let ty = part.y; ty < part.y + part.height; ty++) {
        const row = tiles[ty];
        if (!row) return false;
        for (let tx = part.x; tx < part.x + part.width; tx++) {
          const tile = row[tx];
          const key = `${tx},${ty}`;
          if (tile === undefined || occupied.has(key) || reservedAccess.has(key)) return false;
          if (
            tile === TileType.Road ||
            tile === TileType.RoadLineH ||
            tile === TileType.RoadLineV ||
            tile === TileType.Crossing ||
            tile === TileType.Sidewalk ||
            tile === TileType.Water ||
            tile === TileType.Rock ||
            tile === TileType.Runway ||
            tile === TileType.Dock ||
            tile === TileType.InteriorFloor ||
            tile === TileType.InteriorWall ||
            tile === TileType.InteriorDoor ||
            tile === TileType.InteriorFixture
          ) {
            return false;
          }
        }
      }
    }
    const entrances = building.entrances ?? [];
    if (entrances.length === 0) return false;
    for (const entrance of entrances) {
      if (!this.footprintOwnsTile(building, entrance.position.x, entrance.position.y)) return false;
      const delta = this.facingDelta(entrance.facing);
      if (
        entrance.apron.x !== entrance.position.x + delta.x ||
        entrance.apron.y !== entrance.position.y + delta.y ||
        this.footprintOwnsTile(building, entrance.apron.x, entrance.apron.y)
      ) {
        return false;
      }
      const approach = [entrance.apron, ...entrance.accessPath];
      for (const point of approach) {
        if (block && !this.blockOwnsTile(block, point.x, point.y)) return false;
        if (this.footprintOwnsTile(building, point.x, point.y)) return false;
        const tile = tiles[point.y]?.[point.x];
        if (
          tile === undefined ||
          occupied.has(`${point.x},${point.y}`) ||
          SOLID_SET.has(tile) ||
          PLANNED_ROAD_SURFACE_SET.has(tile) ||
          tile === TileType.Water ||
          tile === TileType.Rock ||
          tile === TileType.Runway ||
          tile === TileType.Dock
        ) {
          return false;
        }
      }
      if (block && !approach.some((point) => this.reachesBlockFrontage(block, point))) return false;
    }
    return true;
  }

  private footprintOwnsTile(building: PlannedBuilding, tx: number, ty: number): boolean {
    return building.footprint.some(
      (part) =>
        tx >= part.x && ty >= part.y && tx < part.x + part.width && ty < part.y + part.height,
    );
  }

  private commitBuilding(
    tiles: number[][],
    building: PlannedBuilding,
    occupied: Set<string>,
    reservedAccess: Set<string>,
  ): void {
    const industrial =
      building.kind === 'factory' ||
      building.kind === 'warehouse' ||
      building.kind === 'terminal' ||
      building.kind === 'utility';
    const residential =
      building.kind === 'house' || building.kind === 'villa' || building.kind === 'apartment';
    const tile = industrial
      ? TileType.BuildingInd
      : residential
        ? TileType.BuildingRes
        : TileType.Building;
    for (const part of building.footprint) {
      for (let ty = part.y; ty < part.y + part.height; ty++) {
        const row = tiles[ty];
        if (!row) continue;
        for (let tx = part.x; tx < part.x + part.width; tx++) {
          row[tx] = tile;
          occupied.add(`${tx},${ty}`);
        }
      }
    }
    for (const entrance of building.entrances ?? []) {
      reservedAccess.add(`${entrance.apron.x},${entrance.apron.y}`);
      for (const point of entrance.accessPath) {
        reservedAccess.add(`${point.x},${point.y}`);
      }
    }
  }

  /** Prove that the rich plan, collision raster, entrances, and residual sites agree. */
  private auditArchitectureOwnership(
    tiles: number[][],
    blocks: readonly PlannedUrbanBlock[],
    buildings: readonly PlannedBuilding[],
    spaces: readonly PlannedUrbanSpace[],
  ): ArchitectureOwnershipAudit {
    const owners = new Map<string, string[]>();
    const cellsByBuilding = new Map<string, Set<string>>();
    let footprintMismatches = 0;
    let cityStyleViolations = 0;

    for (const building of buildings) {
      const localCells = new Set<string>();
      cellsByBuilding.set(building.id, localCells);
      for (const part of building.footprint) {
        if (part.width < 2 || part.height < 2) footprintMismatches++;
        for (let ty = part.y; ty < part.y + part.height; ty++) {
          for (let tx = part.x; tx < part.x + part.width; tx++) {
            const key = `${tx},${ty}`;
            if (localCells.has(key)) footprintMismatches++;
            localCells.add(key);
            const list = owners.get(key) ?? [];
            list.push(building.id);
            owners.set(key, list);
            const tile = tiles[ty]?.[tx];
            if (
              tile === undefined ||
              (!this.isBuildingTile(tile) &&
                tile !== TileType.InteriorFloor &&
                tile !== TileType.InteriorWall &&
                tile !== TileType.InteriorDoor &&
                tile !== TileType.InteriorFixture)
            ) {
              footprintMismatches++;
            }
          }
        }
      }
      for (const asset of building.roofAssets ?? []) {
        for (let ty = asset.bounds.y; ty < asset.bounds.y + asset.bounds.height; ty++) {
          for (let tx = asset.bounds.x; tx < asset.bounds.x + asset.bounds.width; tx++) {
            if (!localCells.has(`${tx},${ty}`)) footprintMismatches++;
          }
        }
      }

      const missingRichContract =
        building.shape === undefined ||
        building.size === undefined ||
        building.kind === undefined ||
        (building.entrances?.length ?? 0) === 0 ||
        (building.roofAssets?.length ?? 0) === 0;
      const exceedsCityHeight =
        (building.cityId === 'yazd' && building.floors > 8) ||
        (building.cityId === 'gilan' && building.floors > 12) ||
        building.floors > 60;
      const invalidCityMaterial =
        (building.cityId === 'yazd' &&
          !['adobe', 'stone', 'brick', 'concrete'].includes(building.material)) ||
        (building.cityId === 'gilan' &&
          !['wood', 'brick', 'stone', 'concrete'].includes(building.material));
      if (missingRichContract || exceedsCityHeight || invalidCityMaterial) cityStyleViolations++;
    }

    let unownedBuildingTiles = 0;
    for (let ty = 0; ty < tiles.length; ty++) {
      const row = tiles[ty];
      if (!row) continue;
      for (let tx = 0; tx < row.length; tx++) {
        if (!this.isBuildingTile(row[tx] ?? TileType.Grass)) continue;
        const count = owners.get(`${tx},${ty}`)?.length ?? 0;
        if (count === 0) unownedBuildingTiles++;
        else if (count !== 1) footprintMismatches++;
      }
    }

    const blocksById = new Map(blocks.map((block) => [block.id, block]));
    const rasterWidth = tiles[0]?.length ?? 0;
    const routeFromAuthoredApproach = (
      block: PlannedUrbanBlock,
      approach: readonly { x: number; y: number }[],
      vehicleOrEmergency: boolean,
    ): { reachable: boolean; visited: number } => {
      const margin = CITY.SIDEWALK_TILES + 3;
      const minX = Math.max(0, block.bounds.x - margin);
      const minY = Math.max(0, block.bounds.y - margin);
      const maxX = Math.min(rasterWidth - 1, block.bounds.x + block.bounds.width - 1 + margin);
      const maxY = Math.min(tiles.length - 1, block.bounds.y + block.bounds.height - 1 + margin);
      const queue: Array<{ x: number; y: number }> = [];
      const visited = new Set<string>();
      const isGoal = (tile: number): boolean =>
        vehicleOrEmergency
          ? DRIVABLE_SET.has(tile)
          : tile === TileType.Sidewalk || tile === TileType.Crossing;
      const canTraverse = (x: number, y: number): boolean => {
        if (x < minX || y < minY || x > maxX || y > maxY) return false;
        const tile = tiles[y]?.[x];
        if (
          tile === undefined ||
          owners.has(`${x},${y}`) ||
          this.isBuildingTile(tile) ||
          tile === TileType.InteriorWall ||
          tile === TileType.UrbanFixture ||
          tile === TileType.Water ||
          tile === TileType.Rock
        ) {
          return false;
        }
        if (isGoal(tile)) return true;
        return !PLANNED_ROAD_SURFACE_SET.has(tile) && tile !== TileType.Runway;
      };
      const enqueue = (point: { x: number; y: number }): void => {
        const key = `${point.x},${point.y}`;
        if (visited.has(key) || !canTraverse(point.x, point.y)) return;
        visited.add(key);
        queue.push(point);
      };
      for (const point of approach) enqueue(point);
      const directions = [
        { x: 0, y: -1 },
        { x: 1, y: 0 },
        { x: 0, y: 1 },
        { x: -1, y: 0 },
      ] as const;
      for (let head = 0; head < queue.length; head++) {
        const point = queue[head]!;
        const tile = tiles[point.y]?.[point.x];
        if (tile !== undefined && isGoal(tile)) {
          return { reachable: true, visited: visited.size };
        }
        for (const direction of directions) {
          enqueue({ x: point.x + direction.x, y: point.y + direction.y });
        }
      }
      return { reachable: false, visited: visited.size };
    };
    let inaccessibleEntrances = 0;
    const inaccessibleEntranceSamples: string[] = [];
    for (const building of buildings) {
      const buildingCells = cellsByBuilding.get(building.id) ?? new Set<string>();
      const entrances = building.entrances ?? [];
      if (entrances.length === 0) {
        inaccessibleEntrances++;
        if (inaccessibleEntranceSamples.length < 8) {
          inaccessibleEntranceSamples.push(`${building.id}:missing-authored-entrance`);
        }
        continue;
      }
      const block = blocksById.get(building.blockId);
      for (const entrance of entrances) {
        let invalid = entrance.buildingId !== building.id || block === undefined;
        const positionKey = `${entrance.position.x},${entrance.position.y}`;
        if (!buildingCells.has(positionKey)) invalid = true;
        const delta = this.facingDelta(entrance.facing);
        if (
          entrance.apron.x !== entrance.position.x + delta.x ||
          entrance.apron.y !== entrance.position.y + delta.y ||
          buildingCells.has(`${entrance.apron.x},${entrance.apron.y}`)
        ) {
          invalid = true;
        }
        const approach = [entrance.apron, ...entrance.accessPath];
        let previous = entrance.apron;
        for (const point of approach) {
          const tile = tiles[point.y]?.[point.x];
          if (
            tile === undefined ||
            owners.has(`${point.x},${point.y}`) ||
            SOLID_SET.has(tile) ||
            tile === TileType.UrbanFixture ||
            PLANNED_ROAD_SURFACE_SET.has(tile) ||
            tile === TileType.Water ||
            tile === TileType.Rock ||
            tile === TileType.Runway ||
            tile === TileType.Dock
          ) {
            invalid = true;
          }
          const stepDistance = Math.abs(point.x - previous.x) + Math.abs(point.y - previous.y);
          if (stepDistance > 1) invalid = true;
          previous = point;
        }
        if (block) {
          const reachesBlockEdge = approach.some((point) =>
            this.reachesBlockFrontage(block, point),
          );
          if (!reachesBlockEdge) invalid = true;
        }
        const authoredApproachInvalid = invalid;
        const vehicleOrEmergency = entrance.kind === 'vehicle' || entrance.kind === 'emergency';
        const route = block
          ? routeFromAuthoredApproach(block, approach, vehicleOrEmergency)
          : { reachable: false, visited: 0 };
        if (!route.reachable) invalid = true;
        if (invalid) {
          inaccessibleEntrances++;
          if (inaccessibleEntranceSamples.length < 8) {
            const terminal = approach[approach.length - 1];
            inaccessibleEntranceSamples.push(
              `${entrance.id}:${entrance.kind}:authored=${authoredApproachInvalid ? 'invalid' : 'valid'}:` +
                `route=${route.reachable ? 'connected' : 'missing'}:${route.visited}-cells:` +
                `terminal=${terminal ? `${terminal.x},${terminal.y}` : 'missing'}`,
            );
          }
        }
      }
    }

    const spacesByBlock = new Map<string, PlannedUrbanSpace[]>();
    for (const space of spaces) {
      const list = spacesByBlock.get(space.blockId) ?? [];
      list.push(space);
      spacesByBlock.set(space.blockId, list);
    }
    const entranceCorridors = new Set<string>();
    for (const building of buildings) {
      for (const entrance of building.entrances ?? []) {
        entranceCorridors.add(`${entrance.apron.x},${entrance.apron.y}`);
        for (const point of entrance.accessPath) {
          entranceCorridors.add(`${point.x},${point.y}`);
        }
      }
    }
    const physicalFixtureKinds = new Set<string>(PHYSICAL_GROUND_FEATURE_KINDS);
    let missingSiteContent = 0;
    const missingSiteContentSamples: string[] = [];
    for (const block of blocks) {
      const blockSpaces = spacesByBlock.get(block.id) ?? [];
      const residualCells = new Set<string>();
      for (let ty = block.bounds.y; ty < block.bounds.y + block.bounds.height; ty++) {
        for (let tx = block.bounds.x; tx < block.bounds.x + block.bounds.width; tx++) {
          if (
            !this.blockOwnsTile(block, tx, ty) ||
            owners.has(`${tx},${ty}`) ||
            !this.isResidualSiteTile(tiles[ty]?.[tx])
          ) {
            continue;
          }
          residualCells.add(`${tx},${ty}`);
        }
      }

      const siteReasons = new Set<string>();
      let invalidSite = residualCells.size > 0 ? blockSpaces.length === 0 : blockSpaces.length > 0;
      if (invalidSite) siteReasons.add('presence');
      const fixtureOwners = new Set<string>();
      const physicalFixtureOwners = new Set<string>();
      const spaceOwners = new Map<string, string>();
      for (const space of blockSpaces) {
        if (
          !space.purposeful ||
          space.cityId !== block.cityId ||
          space.district !== block.district ||
          space.program !== block.program ||
          space.footprint.length === 0 ||
          space.bounds.x < block.bounds.x ||
          space.bounds.y < block.bounds.y ||
          space.bounds.x + space.bounds.width > block.bounds.x + block.bounds.width ||
          space.bounds.y + space.bounds.height > block.bounds.y + block.bounds.height
        ) {
          invalidSite = true;
          siteReasons.add('metadata');
        }
        const ownCells = new Set<string>();
        for (const part of space.footprint) {
          if (
            !Number.isInteger(part.x) ||
            !Number.isInteger(part.y) ||
            !Number.isInteger(part.width) ||
            !Number.isInteger(part.height) ||
            part.width <= 0 ||
            part.height <= 0 ||
            !this.blockOwnsRect(block, part)
          ) {
            invalidSite = true;
            siteReasons.add('part');
          }
          for (let ty = part.y; ty < part.y + part.height; ty++) {
            for (let tx = part.x; tx < part.x + part.width; tx++) {
              const key = `${tx},${ty}`;
              if (ownCells.has(key) || spaceOwners.has(key) || !residualCells.has(key)) {
                invalidSite = true;
                siteReasons.add('ownership');
              }
              ownCells.add(key);
              spaceOwners.set(key, space.id);
            }
          }
        }
        if (ownCells.size > 0) {
          const ownBounds = this.publicRealmBounds(this.compressPublicRealmCells(ownCells));
          if (
            ownBounds.x !== space.bounds.x ||
            ownBounds.y !== space.bounds.y ||
            ownBounds.width !== space.bounds.width ||
            ownBounds.height !== space.bounds.height
          ) {
            invalidSite = true;
            siteReasons.add('bounds');
          }
        }
        for (const feature of space.features) {
          const physical = physicalFixtureKinds.has(feature.kind);
          for (let ty = feature.bounds.y; ty < feature.bounds.y + feature.bounds.height; ty++) {
            for (let tx = feature.bounds.x; tx < feature.bounds.x + feature.bounds.width; tx++) {
              const key = `${tx},${ty}`;
              const tile = tiles[ty]?.[tx];
              if (
                fixtureOwners.has(key) ||
                !ownCells.has(key) ||
                (physical && entranceCorridors.has(key)) ||
                !residualCells.has(key) ||
                (physical ? tile !== TileType.UrbanFixture : tile === TileType.UrbanFixture)
              ) {
                invalidSite = true;
                siteReasons.add('feature');
              }
              fixtureOwners.add(key);
              if (physical) physicalFixtureOwners.add(key);
            }
          }
        }
        for (const point of space.accessPoints) {
          if (!ownCells.has(`${point.x},${point.y}`)) {
            invalidSite = true;
            siteReasons.add('access');
          }
        }
      }

      if (residualCells.size > 0) {
        if (!blockSpaces.some((space) => space.purposeful && space.features.length > 0)) {
          invalidSite = true;
          siteReasons.add('featureless');
        }
        if (
          spaceOwners.size !== residualCells.size ||
          Array.from(residualCells).some((key) => !spaceOwners.has(key))
        ) {
          invalidSite = true;
          siteReasons.add('union');
        }
        for (const key of residualCells) {
          const [tx, ty] = key.split(',').map(Number);
          if (
            tiles[ty ?? -1]?.[tx ?? -1] === TileType.UrbanFixture &&
            !physicalFixtureOwners.has(key)
          ) {
            invalidSite = true;
            siteReasons.add('orphan-fixture');
          }
        }
      }
      if (invalidSite) {
        missingSiteContent++;
        if (missingSiteContentSamples.length < 8) {
          missingSiteContentSamples.push(
            `${block.id}:${residualCells.size}r/${blockSpaces.length}s/${siteReasons.size > 0 ? Array.from(siteReasons).join('+') : 'unknown'}`,
          );
        }
      }
    }

    return {
      unownedBuildingTiles,
      footprintMismatches,
      inaccessibleEntrances,
      inaccessibleEntranceSamples,
      missingSiteContent,
      missingSiteContentSamples,
      cityStyleViolations,
    };
  }

  /** Audit the finalized raster, parcels, façades and skyline before runtime data is derived. */
  private validateUrbanFabric(
    tiles: number[][],
    roads: readonly PlannedRoadSegment[],
    blocks: readonly PlannedUrbanBlock[],
    buildings: readonly PlannedBuilding[],
    spaces: readonly PlannedUrbanSpace[],
    planningQuality: UrbanQualityReport,
  ): UrbanQualityReport {
    const issues = [...planningQuality.issues];
    issues.push(...this.requiredArchitectureLandmarkIssues(blocks, buildings));
    const architectureAudit = this.auditArchitectureOwnership(tiles, blocks, buildings, spaces);
    if (architectureAudit.unownedBuildingTiles > 0) {
      issues.push(
        `${architectureAudit.unownedBuildingTiles} building-family tiles have no planned owner`,
      );
    }
    if (architectureAudit.footprintMismatches > 0) {
      issues.push(
        `${architectureAudit.footprintMismatches} planned footprint cells disagree with raster ownership`,
      );
    }
    if (architectureAudit.inaccessibleEntrances > 0) {
      issues.push(
        `${architectureAudit.inaccessibleEntrances} planned entrances are inaccessible ` +
          `(${architectureAudit.inaccessibleEntranceSamples.join(', ')})`,
      );
    }
    if (architectureAudit.missingSiteContent > 0) {
      issues.push(
        `${architectureAudit.missingSiteContent} blocks lack planned residual-site content (${architectureAudit.missingSiteContentSamples.join(', ')})`,
      );
    }
    if (architectureAudit.cityStyleViolations > 0) {
      issues.push(
        `${architectureAudit.cityStyleViolations} buildings violate their city architecture profile`,
      );
    }
    const interruptedRoadSegments = roads.filter(
      (road) => !this.plannedRoadSegmentIsClear(tiles, road),
    ).length;
    if (interruptedRoadSegments > 0) {
      issues.push(`${interruptedRoadSegments} accepted roads are interrupted in the final raster`);
    }
    const undersizedRoadSegments = roads.filter(
      (road) =>
        Math.hypot(road.to.x - road.from.x, road.to.y - road.from.y) * TILE_SIZE <
        MIN_TRAFFIC_EDGE_LENGTH_PX,
    ).length;
    if (undersizedRoadSegments > 0) {
      issues.push(
        `${undersizedRoadSegments} planned roads are too short for runtime traffic lanes`,
      );
    }

    const degrees = new Map<string, number>();
    const terminals = new Map<string, PlannedRoadSegment['startTerminal']>();
    for (const road of roads) {
      const fromKey = `${road.from.x},${road.from.y}`;
      const toKey = `${road.to.x},${road.to.y}`;
      degrees.set(fromKey, (degrees.get(fromKey) ?? 0) + 1);
      degrees.set(toKey, (degrees.get(toKey) ?? 0) + 1);
      if (road.startTerminal) terminals.set(fromKey, road.startTerminal);
      if (road.endTerminal) terminals.set(toKey, road.endTerminal);
    }
    let invalidTerminals = 0;
    for (const [point, degree] of degrees) {
      const terminal = terminals.has(point);
      if ((degree === 1 && !terminal) || (degree !== 1 && terminal)) invalidTerminals++;
    }
    if (invalidTerminals > 0) {
      issues.push(`${invalidTerminals} road endpoints have invalid or missing terminal designs`);
    }

    const roadReservation = new Set<string>();
    for (const road of roads) {
      const dx = road.to.x - road.from.x;
      const dy = road.to.y - road.from.y;
      const steps = Math.max(1, Math.max(Math.abs(dx), Math.abs(dy)) * 2);
      const radius = Math.max(0, Math.ceil(road.halfWidth));
      for (let step = 0; step <= steps; step++) {
        const t = step / steps;
        const cx = Math.round(road.from.x + dx * t);
        const cy = Math.round(road.from.y + dy * t);
        for (let oy = -radius; oy <= radius; oy++) {
          for (let ox = -radius; ox <= radius; ox++) {
            if (ox * ox + oy * oy > (road.halfWidth + 0.35) ** 2) continue;
            roadReservation.add(`${cx + ox},${cy + oy}`);
          }
        }
      }
    }
    let roadBuildingOverlaps = 0;
    for (const building of buildings) {
      let overlaps = false;
      for (const part of building.footprint) {
        for (let ty = part.y; ty < part.y + part.height && !overlaps; ty++) {
          for (let tx = part.x; tx < part.x + part.width; tx++) {
            if (!roadReservation.has(`${tx},${ty}`)) continue;
            overlaps = true;
            break;
          }
        }
        if (overlaps) break;
      }
      if (overlaps) roadBuildingOverlaps++;
    }
    if (roadBuildingOverlaps > 0) {
      issues.push(`${roadBuildingOverlaps} buildings overlap authoritative road reservations`);
    }

    const blockSignatures = new Map<string, number>();
    for (const block of blocks) {
      blockSignatures.set(block.signature, (blockSignatures.get(block.signature) ?? 0) + 1);
    }
    const duplicateBlockSignatures = Array.from(blockSignatures.values()).reduce(
      (total, count) => total + Math.max(0, count - 3),
      0,
    );
    if (duplicateBlockSignatures > Math.max(4, Math.floor(blocks.length * 0.04))) {
      issues.push(`${duplicateBlockSignatures} urban block signatures repeat excessively`);
    }

    const facadeSignatures = new Map<string, number>();
    for (const building of buildings) {
      facadeSignatures.set(building.signature, (facadeSignatures.get(building.signature) ?? 0) + 1);
    }
    const excessiveFacadeRepeats = Array.from(facadeSignatures.values()).reduce(
      (total, count) => total + Math.max(0, count - 2),
      0,
    );
    if (excessiveFacadeRepeats > 0) {
      issues.push(`${excessiveFacadeRepeats} building façades exceed the repetition limit`);
    }

    const unrealisticBuildings = buildings.filter(
      (building) => !this.hasProfessionalBuildingMassing(building),
    );
    const unrealisticBuildingProportions = unrealisticBuildings.length;
    if (unrealisticBuildingProportions > 0) {
      const samples = unrealisticBuildings
        .slice(0, 6)
        .map(
          (building) =>
            `${building.id}/${building.kind ?? 'unknown'}/${building.shape ?? 'unknown'}/${building.bounds.width}x${building.bounds.height}/${building.footprint.length}p`,
        )
        .join(', ');
      issues.push(
        `${unrealisticBuildingProportions} buildings have invalid grammar massing (${samples})`,
      );
    }

    const skylineGroups = new Map<string, PlannedBuilding[]>();
    for (const building of buildings) {
      if (
        building.kind !== 'tower' &&
        building.kind !== 'office' &&
        building.kind !== 'apartment' &&
        building.kind !== 'hotel' &&
        building.kind !== 'government' &&
        building.kind !== 'hospital' &&
        building.kind !== 'university'
      ) {
        continue;
      }
      const group = skylineGroups.get(building.blockId) ?? [];
      group.push(building);
      skylineGroups.set(building.blockId, group);
    }
    let skylineAdjacencyViolations = 0;
    const skylineSamples: string[] = [];
    for (const group of skylineGroups.values()) {
      if (group.length < 4) continue;
      const distinctHeights = new Set(group.map((building) => building.floors)).size;
      const requiredHeights = group[0]?.cityId === 'tehran' && group.length >= 8 ? 3 : 2;
      if (distinctHeights < requiredHeights) {
        skylineAdjacencyViolations++;
        if (skylineSamples.length < 6) {
          skylineSamples.push(
            `${group[0]?.blockId ?? 'unknown'}:${group.map((building) => building.floors).join('/')}`,
          );
        }
      }
    }
    if (skylineAdjacencyViolations > 0) {
      issues.push(
        `${skylineAdjacencyViolations} major block skylines lack height variation (${skylineSamples.join(', ')})`,
      );
    }

    const buildingsByBlock = new Map<string, PlannedBuilding[]>();
    for (const building of buildings) {
      const list = buildingsByBlock.get(building.blockId) ?? [];
      list.push(building);
      buildingsByBlock.set(building.blockId, list);
    }
    const coverageByBlock = new Map<string, number>();
    for (const block of blocks) {
      coverageByBlock.set(
        block.id,
        this.buildingCoverageForBlock(block, buildingsByBlock.get(block.id) ?? [], tiles),
      );
    }

    const oversizedEmptyBlocks = blocks.filter((block) => {
      const area = this.blockParcelArea(block);
      const coverage = coverageByBlock.get(block.id) ?? 0;
      return area >= 1_200 && coverage < 0.12 && !block.purposefulOpenSpace;
    }).length;
    if (oversizedEmptyBlocks > 0) {
      issues.push(
        `${oversizedEmptyBlocks} oversized urban blocks remain empty without a valid program`,
      );
    }

    const densityFailures = blocks.filter((block) => {
      if (block.purposefulOpenSpace) return false;
      const area = Math.max(1, this.blockParcelArea(block));
      const coverage = coverageByBlock.get(block.id) ?? 0;
      return coverage + 1 / area < block.densityTarget;
    });
    const excessiveEmptyTerrainBlocks = densityFailures.length;
    if (excessiveEmptyTerrainBlocks > 0) {
      const breakdown = this.urbanFailureBreakdown(densityFailures);
      const samples = densityFailures
        .slice(0, 8)
        .map((block) => {
          const coverage = coverageByBlock.get(block.id) ?? 0;
          const buildingCount = buildingsByBlock.get(block.id)?.length ?? 0;
          const developableArea = this.developableAreaForBlock(tiles, block);
          const tileCounts = new Map<string, number>();
          for (const part of block.footprint ?? [block.bounds]) {
            for (let ty = part.y; ty < part.y + part.height; ty++) {
              for (let tx = part.x; tx < part.x + part.width; tx++) {
                const tile = tiles[ty]?.[tx];
                const name = tile === undefined ? 'undefined' : (TileType[tile] ?? String(tile));
                tileCounts.set(name, (tileCounts.get(name) ?? 0) + 1);
              }
            }
          }
          const tileSummary = Array.from(tileCounts.entries())
            .sort((first, second) => second[1] - first[1])
            .slice(0, 3)
            .map(([name, count]) => `${name}:${count}`)
            .join('+');
          return `${block.cityId}/${block.program}@${block.bounds.x},${block.bounds.y}=${coverage.toFixed(2)}/${block.densityTarget.toFixed(2)}/${buildingCount}b/${developableArea}d/${this.blockParcelArea(block)}p/${block.footprint?.length ?? 1}r/${tileSummary}`;
        })
        .join(', ');
      issues.push(
        `${excessiveEmptyTerrainBlocks} urban blocks fall below their zoning density contract (${breakdown}; samples ${samples})`,
      );
    }

    const lowCoverageBlocks = blocks.filter((block) => {
      const coverage = coverageByBlock.get(block.id) ?? 0;
      return !block.purposefulOpenSpace && (block.densityTarget <= 0 || coverage < 0.12);
    });
    const unprogrammedOpenSpaces = lowCoverageBlocks.length;
    if (unprogrammedOpenSpaces > 0) {
      issues.push(
        `${unprogrammedOpenSpaces} low-coverage blocks have no purposeful open-space use (${this.urbanFailureBreakdown(lowCoverageBlocks)})`,
      );
    }

    const terminalBlocks = new Map<string, PlannedUrbanBlock | undefined>();
    for (const [point, terminal] of terminals) {
      if (!terminal) continue;
      const [xText, yText] = point.split(',');
      const x = Number(xText);
      const y = Number(yText);
      terminalBlocks.set(
        point,
        blocks.find(
          (block) =>
            this.blockOwnsTile(block, x, y),
        ),
      );
    }
    let meaninglessDeadEnds = 0;
    let streetsLeadingToEmptyLand = 0;
    for (const [point, degree] of degrees) {
      if (degree !== 1) continue;
      const terminal = terminals.get(point);
      const block = terminalBlocks.get(point);
      if (!terminal || !block || !this.terminalMatchesBlockPurpose(terminal, block)) {
        meaninglessDeadEnds++;
        continue;
      }
      const coverage = coverageByBlock.get(block.id) ?? 0;
      if (!block.purposefulOpenSpace && coverage < 0.12) streetsLeadingToEmptyLand++;
    }
    if (meaninglessDeadEnds > 0) {
      issues.push(`${meaninglessDeadEnds} dead-end roads lack a matching land-use purpose`);
    }
    if (streetsLeadingToEmptyLand > 0) {
      const streetBreakdown = Array.from(terminals.entries())
        .filter(([point]) => {
          const block = terminalBlocks.get(point);
          return block && !block.purposefulOpenSpace && (coverageByBlock.get(block.id) ?? 0) < 0.12;
        })
        .map(([point, terminal]) => `${terminal}@${point}`)
        .slice(0, 12)
        .join(', ');
      issues.push(
        `${streetsLeadingToEmptyLand} streets terminate at unexplained empty land (${streetBreakdown})`,
      );
    }

    const districtBlocks = new Map<string, PlannedUrbanBlock[]>();
    for (const block of blocks) {
      const key = `${block.cityId}:${block.district}`;
      const list = districtBlocks.get(key) ?? [];
      list.push(block);
      districtBlocks.set(key, list);
    }
    let repetitiveDistricts = 0;
    let landmarkCoverageViolations = 0;
    for (const group of districtBlocks.values()) {
      if (group.length >= 6) {
        const programs = new Set(group.map((block) => block.program));
        const forms = new Set(group.map((block) => block.form));
        if (programs.size < Math.min(3, Math.ceil(group.length / 8)) && forms.size < 2) {
          repetitiveDistricts++;
        }
      }
      const landmarks = group.filter((block) => block.landmark);
      if (landmarks.length === 0) {
        landmarkCoverageViolations++;
        continue;
      }
      for (const block of group) {
        const cx = block.bounds.x + block.bounds.width / 2;
        const cy = block.bounds.y + block.bounds.height / 2;
        const nearest = Math.min(
          ...landmarks.map((landmark) => {
            const lx = landmark.bounds.x + landmark.bounds.width / 2;
            const ly = landmark.bounds.y + landmark.bounds.height / 2;
            return Math.hypot(lx - cx, ly - cy);
          }),
        );
        if (nearest > 144) landmarkCoverageViolations++;
      }
    }
    if (repetitiveDistricts > 0) {
      issues.push(`${repetitiveDistricts} districts repeat too few programs or block forms`);
    }
    if (landmarkCoverageViolations > 0) {
      issues.push(
        `${landmarkCoverageViolations} district areas are too far from a planned landmark`,
      );
    }

    const urbanizedBlocks = blocks.filter((block) => {
      if (block.purposefulOpenSpace) return true;
      const coverage = coverageByBlock.get(block.id) ?? 0;
      return coverage >= Math.max(0.12, block.densityTarget - 0.01);
    }).length;
    const urbanizedBlockRatio = blocks.length === 0 ? 0 : urbanizedBlocks / blocks.length;
    if (urbanizedBlockRatio < 0.96) {
      issues.push(
        `only ${(urbanizedBlockRatio * 100).toFixed(1)}% of blocks are meaningfully urbanized`,
      );
    }

    const regeneratedBlocks =
      planningQuality.regeneratedBlocks +
      blocks.filter((block) => block.generationAttempt > 0).length;
    return {
      ...planningQuality,
      passed: issues.length === 0,
      plannedRoadSegments: roads.length,
      intentionalTerminals: terminals.size,
      invalidTerminals,
      interruptedRoadSegments,
      roadBuildingOverlaps,
      duplicateBlockSignatures,
      excessiveFacadeRepeats,
      unrealisticBuildingProportions,
      skylineAdjacencyViolations,
      oversizedEmptyBlocks,
      excessiveEmptyTerrainBlocks,
      unprogrammedOpenSpaces,
      meaninglessDeadEnds,
      streetsLeadingToEmptyLand,
      repetitiveDistricts,
      landmarkCoverageViolations,
      urbanizedBlockRatio,
      regeneratedBlocks,
      ...architectureAudit,
      issues,
    };
  }

  /** Fail generation when a named map destination has no matching physical structure. */
  private requiredArchitectureLandmarkIssues(
    blocks: readonly PlannedUrbanBlock[],
    buildings: readonly PlannedBuilding[],
  ): string[] {
    const issues: string[] = [];
    const blocksById = new Map(blocks.map((block) => [block.id, block]));
    for (const requirement of REQUIRED_ARCHITECTURE_LANDMARKS) {
      const reservedEntry = Array.from(this.architectureLandmarkByBlock.entries()).find(
        ([, landmarkId]) => landmarkId === requirement.id,
      );
      const block = reservedEntry ? blocksById.get(reservedEntry[0]) : undefined;
      if (!block) {
        issues.push(`${requirement.id} has no viable reserved architecture block`);
        continue;
      }
      if (
        block.cityId !== requirement.cityId ||
        block.program !== requirement.program ||
        block.landUse !== requirement.landUse ||
        block.purposefulOpenSpace !== requirement.purposefulOpenSpace ||
        !block.landmark
      ) {
        issues.push(`${requirement.id} reserved block lost its zoning contract`);
        continue;
      }

      const landmarkBuilding = buildings.find(
        (building) =>
          building.blockId === block.id &&
          building.kind === requirement.requiredKind &&
          building.landmark,
      );
      if (!landmarkBuilding) {
        issues.push(
          `${requirement.id} reserved block produced no landmark ${requirement.requiredKind} building`,
        );
        continue;
      }
      if (requirement.id !== 'yazd-mosque') continue;

      const dome = landmarkBuilding.roofAssets.find((asset) => asset.kind === 'dome');
      const minaret = landmarkBuilding.roofAssets.find((asset) => asset.kind === 'minaret');
      if (!dome || !minaret) {
        issues.push('yazd-mosque is missing its dome or minaret roof module');
        continue;
      }
      const roofModulesOverlap =
        dome.bounds.x < minaret.bounds.x + minaret.bounds.width &&
        dome.bounds.x + dome.bounds.width > minaret.bounds.x &&
        dome.bounds.y < minaret.bounds.y + minaret.bounds.height &&
        dome.bounds.y + dome.bounds.height > minaret.bounds.y;
      if (roofModulesOverlap) {
        issues.push('yazd-mosque dome and minaret roof modules overlap');
      }
    }
    return issues;
  }

  private terminalMatchesBlockPurpose(
    terminal: NonNullable<PlannedRoadSegment['startTerminal']>,
    block: PlannedUrbanBlock,
  ): boolean {
    switch (terminal) {
      case 'cul-de-sac':
      case 'residential-court':
        return block.program === 'housing' || block.program === 'apartments';
      case 'dead-end-alley':
        return (
          block.purposefulOpenSpace ||
          ['housing', 'market', 'continuous-retail', 'restaurant-row', 'public-plaza'].includes(
            block.program,
          )
        );
      case 'parking-area':
        return block.program === 'parking-garage';
      case 'industrial-yard':
        return block.program === 'industrial-yard';
      case 'roundabout':
      case 'public-square':
        return block.program === 'public-plaza';
      case 'harbor-entrance':
        return block.program === 'harbor-facility';
      case 'airport-entrance':
        return block.program === 'airport-facility';
      case 'checkpoint':
        return block.program === 'airport-facility' || block.program === 'government-complex';
      case 'highway-ramp':
        return block.program === 'airport-facility' || block.program === 'parking-garage';
      case 'forest-trail':
        return block.program === 'forest-park';
      case 'beach-access':
        return block.program === 'beach-access';
    }
  }

  private urbanFailureBreakdown(blocks: readonly PlannedUrbanBlock[]): string {
    const counts = new Map<string, number>();
    for (const block of blocks) {
      const key = `${block.cityId}/${block.program}/${block.bounds.width}x${block.bounds.height}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((first, second) => second[1] - first[1])
      .slice(0, 8)
      .map(([key, count]) => `${key}:${count}`)
      .join(', ');
  }

  /** Keep different local-street rhythms in each city while arterials are authored separately. */
  private keepsLocalRoad(district: District, bi: number, bj: number, axis: 'ns' | 'ew'): boolean {
    const tx = bi * PERIOD + Math.floor(PERIOD / 2);
    const ty = bj * PERIOD + Math.floor(PERIOD / 2);
    if (inTileRect(tx, ty, TEHRAN_RECT)) {
      if (
        district === District.Downtown ||
        district === District.Commercial ||
        district === District.Government
      ) {
        return axis === 'ns' ? bi % 4 !== 1 : bj % 5 !== 2;
      }
      if (district === District.OldTown) return axis === 'ns' ? bi % 3 !== 0 : bj % 4 !== 1;
      if (district === District.Airport || district === District.Industrial) {
        return axis === 'ns' ? bi % 4 === 0 : bj % 4 === 0;
      }
      return axis === 'ns' ? bi % 3 !== 1 : bj % 4 !== 2;
    }
    if (inTileRect(tx, ty, GILAN_RECT)) {
      if (
        district === District.Forest ||
        district === District.TeaFarm ||
        district === District.RiceFields
      ) {
        return false;
      }
      return axis === 'ns' ? bi % 4 !== 1 && bi % 4 !== 2 : bj % 5 === 0 || bj % 5 === 3;
    }
    if (inTileRect(tx, ty, YAZD_RECT)) {
      if (district === District.Airport || district === District.Mining) {
        return axis === 'ns' ? bi % 5 === 0 : bj % 5 === 0;
      }
      if (district === District.Historic || district === District.Bazaar) {
        return axis === 'ns' ? bi % 3 !== 1 : bj % 3 !== 2;
      }
      return axis === 'ns' ? bi % 4 === 0 || bi % 4 === 3 : bj % 4 === 1;
    }
    return false;
  }

  // ── Road graph & spawn sampling (validated against the tile grid) ──────────────

  /** Adapt the accepted plan directly into the runtime graph; never infer roads from terrain. */
  private buildRoadGraph(tiles: number[][], roads: readonly PlannedRoadSegment[]): RoadBuildResult {
    const nodes: RoadNode[] = [];
    const edges: RoadEdge[] = [];
    const connections: Array<{
      road: PlannedRoadSegment;
      from: RoadNode;
      to: RoadNode;
    }> = [];
    const byPosition = new Map<string, RoadNode>();
    const nodeForPoint = (point: PlannedRoadSegment['from']): RoadNode => {
      const key = `${point.x},${point.y}`;
      const existing = byPosition.get(key);
      if (existing) return existing;
      const world = tileCenter(point.x, point.y);
      const node: RoadNode = {
        id: nodes.length,
        x: world.x,
        y: world.y,
        neighbours: [],
      };
      nodes.push(node);
      byPosition.set(key, node);
      return node;
    };

    for (const road of roads) {
      if (!this.plannedRoadSegmentIsClear(tiles, road)) {
        throw new Error(`Accepted road ${road.id} was interrupted during rasterisation`);
      }
      const from = nodeForPoint(road.from);
      const to = nodeForPoint(road.to);
      if (!from.neighbours.includes(to.id)) from.neighbours.push(to.id);
      if (!to.neighbours.includes(from.id)) to.neighbours.push(from.id);
      connections.push({ road, from, to });
    }

    for (const node of nodes) node.neighbours.sort((first, second) => first - second);
    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    for (const connection of connections) {
      edges.push(this.buildRoadEdge(connection.road, connection.from, connection.to, nodesById));
    }
    return { nodes, edges };
  }

  /** Translate planning hierarchy into the unchanged traffic system's existing policy schema. */
  private buildRoadEdge(
    road: PlannedRoadSegment,
    from: RoadNode,
    to: RoadNode,
    nodesById: ReadonlyMap<number, RoadNode>,
  ): RoadEdge {
    const midpoint = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
    const district = this.districtAtPoint(midpoint.x, midpoint.y);
    const roadClass: RoadEdge['roadClass'] =
      road.highwayComponent === 'service-road'
        ? 'service'
        : road.highwayComponent === 'collector-road'
          ? 'collector'
          : road.highwayComponent === 'transition-road'
            ? 'arterial'
            : road.hierarchy === 'highway'
              ? 'highway'
              : road.hierarchy === 'primary'
                ? 'arterial'
                : road.hierarchy === 'secondary'
                  ? 'collector'
                  : road.hierarchy === 'access'
                    ? 'service'
                    : district === District.Forest || district === District.Mountains
                      ? 'scenic'
                      : 'local';
    const inCity = this.cityIdAtPoint(midpoint.x, midpoint.y) !== undefined;
    const taperForJunction =
      this.nodeNeedsSingleTrafficLane(from, nodesById) ||
      this.nodeNeedsSingleTrafficLane(to, nodesById);
    return {
      id: `road:${road.id}`,
      fromNodeId: from.id,
      toNodeId: to.id,
      roadClass,
      laneCount:
        road.laneCount ??
        (!taperForJunction && (road.hierarchy === 'highway' || road.hierarchy === 'primary')
          ? 2
          : 1),
      speedLimit:
        road.designSpeed ??
        (road.highwayComponent === 'carriageway'
          ? 220
          : road.highwayComponent === 'entry-ramp'
            ? 135
            : road.highwayComponent === 'exit-ramp'
              ? 120
              : road.highwayComponent === 'service-road'
                ? 95
                : road.hierarchy === 'primary'
                  ? 180
                  : road.hierarchy === 'secondary'
                    ? 145
                    : road.hierarchy === 'residential'
                      ? 105
                      : road.hierarchy === 'access'
                        ? 95
                        : 80),
      direction: road.direction ?? 'both',
      priority:
        road.hierarchy === 'highway'
          ? 5
          : road.hierarchy === 'primary'
            ? 4
            : road.hierarchy === 'secondary'
              ? 3
              : road.hierarchy === 'residential'
                ? 2
                : 1,
      surface:
        district === District.Desert ||
        district === District.Historic ||
        district === District.Bazaar
          ? 'desert-asphalt'
          : district === District.Forest || district === District.TeaFarm
            ? 'forest-asphalt'
            : district === District.Harbor ||
                district === District.Marina ||
                district === District.Beach
              ? 'coastal-asphalt'
              : road.hierarchy === 'access'
                ? 'service-concrete'
                : 'urban-asphalt',
      highwayId: road.highwayId,
      highwayComponent: road.highwayComponent,
      laneTransition: road.laneTransition,
      transitionPathId: road.transitionPathId,
      interchangeId: road.interchangeId,
      carriageway: road.carriageway,
      navigationAllowed: true,
      trafficAllowed: true,
      pedestrianAllowed:
        road.highwayComponent === undefined &&
        road.hierarchy !== 'highway' &&
        road.hierarchy !== 'primary',
      emergencyAllowed: true,
      shoulder:
        road.highwayComponent !== undefined ||
        road.hierarchy === 'primary' ||
        roadClass === 'scenic',
      lighting: inCity || road.highwayComponent !== undefined,
      turnRestrictions:
        road.highwayComponent !== undefined ||
        road.hierarchy === 'highway' ||
        road.hierarchy === 'primary'
          ? ['u-turn']
          : [],
    };
  }

  /** Avoid lane-permission dead ends at terminals and sharp two-leg bends. */
  private nodeNeedsSingleTrafficLane(
    node: RoadNode,
    nodesById: ReadonlyMap<number, RoadNode>,
  ): boolean {
    if (node.neighbours.length <= 1) return true;
    if (node.neighbours.length !== 2) return false;
    const first = nodesById.get(node.neighbours[0] ?? -1);
    const second = nodesById.get(node.neighbours[1] ?? -1);
    if (!first || !second) return true;
    const firstDx = first.x - node.x;
    const firstDy = first.y - node.y;
    const secondDx = second.x - node.x;
    const secondDy = second.y - node.y;
    const denominator = Math.max(1, Math.hypot(firstDx, firstDy) * Math.hypot(secondDx, secondDy));
    const cosine = (firstDx * secondDx + firstDy * secondDy) / denominator;
    // Opposing vectors form a through-road. A bend more than roughly forty
    // degrees from straight receives one unambiguous runtime travel lane.
    return cosine > -0.77;
  }

  private districtAtPoint(x: number, y: number): District {
    const cols = Math.ceil(WORLD_TILES_X / PERIOD);
    const rows = Math.ceil(WORLD_TILES_Y / PERIOD);
    return this.districtFor(
      Math.floor(x / (TILE_SIZE * PERIOD)),
      Math.floor(y / (TILE_SIZE * PERIOD)),
      cols,
      rows,
    );
  }

  private cityIdAtPoint(x: number, y: number): CityId | undefined {
    const tx = Math.floor(x / TILE_SIZE);
    const ty = Math.floor(y / TILE_SIZE);
    if (inTileRect(tx, ty, TEHRAN_RECT)) return 'tehran';
    if (inTileRect(tx, ty, YAZD_RECT)) return 'yazd';
    if (inTileRect(tx, ty, GILAN_RECT)) return 'gilan';
    return undefined;
  }

  /** Sample every physical edge, including non-orthogonal intercity corridors. */
  private sampleDrivable(nodes: RoadNode[], edges: RoadEdge[], tiles: number[][]): Vector2[] {
    const spawns: Vector2[] = [];
    for (const node of nodes) spawns.push({ x: node.x, y: node.y });
    const byId = new Map(nodes.map((node) => [node.id, node]));
    for (const edge of edges) {
      const from = byId.get(edge.fromNodeId);
      const to = byId.get(edge.toNodeId);
      if (!from || !to) continue;
      const distance = Math.hypot(to.x - from.x, to.y - from.y);
      const samples = Math.max(1, Math.ceil(distance / (PERIOD * TILE_SIZE)));
      for (let index = 1; index < samples; index++) {
        const t = index / samples;
        const point = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
        if (this.isDrivableAt(tiles, point.x, point.y)) spawns.push(point);
      }
    }
    return spawns;
  }

  /** Sample walkable sidewalk points across the whole grid (thinned by stride). */
  private sampleWalkable(tiles: number[][], widthTiles: number, heightTiles: number): Vector2[] {
    const spawns: Vector2[] = [];
    for (let ty = 0; ty < heightTiles; ty++) {
      const row = tiles[ty];
      if (!row) continue;
      for (let tx = 0; tx < widthTiles; tx++) {
        const tile = row[tx];
        if (tile === TileType.Sidewalk && (tx + ty) % 3 === 0) {
          spawns.push({ x: tx * TILE_SIZE + TILE_SIZE / 2, y: ty * TILE_SIZE + TILE_SIZE / 2 });
        }
      }
    }
    return spawns;
  }

  /** Expose only authored north entrances compatible with the current interior raster. */
  private buildEntrancesFromPlan(
    tiles: number[][],
    buildings: readonly PlannedBuilding[],
  ): BuildingEntrance[] {
    const entrances: BuildingEntrance[] = [];
    for (const building of buildings) {
      if (building.shape !== 'rectangle' || building.footprint.length !== 1) continue;
      const part = building.footprint[0];
      if (!part || part.width < 7 || part.height < 7) continue;
      const planned = [...(building.entrances ?? [])].sort(
        (first, second) => Number(second.primary) - Number(first.primary),
      );
      const authored = planned.find(
        (candidate) =>
          candidate.facing === 'north' &&
          candidate.position.x > part.x &&
          candidate.position.x < part.x + part.width - 1 &&
          candidate.position.y === part.y &&
          candidate.apron.x === candidate.position.x &&
          candidate.apron.y === candidate.position.y - 1,
      );
      if (!authored) continue;
      const door = authored.position;
      const apron = authored.apron;
      const doorTile = tiles[door.y]?.[door.x];
      const apronTile = tiles[apron.y]?.[apron.x];
      if (doorTile === undefined || !this.isBuildingTile(doorTile) || apronTile === undefined) {
        continue;
      }
      if (
        SOLID_SET.has(apronTile) ||
        PLANNED_ROAD_SURFACE_SET.has(apronTile) ||
        apronTile === TileType.Runway
      ) {
        continue;
      }
      entrances.push({
        ...tileCenter(apron.x, apron.y),
        buildingId: building.id,
        cityId: building.cityId,
        buildingKind: building.kind,
        program: building.program,
        groundFloorUse: building.groundFloorUse,
      });
    }
    return entrances;
  }

  /**
   * Scatter sidewalk benches across the city: a shuffled, capped subset of the
   * already-sampled sidewalk spawn points, each given a stable cosmetic sit
   * facing.
   */
  private sampleBenches(sidewalkSpawns: Vector2[]): BenchSite[] {
    if (sidewalkSpawns.length === 0) return [];
    const count = Math.min(
      MAX_BENCHES,
      Math.max(1, Math.floor(sidewalkSpawns.length / BENCH_STRIDE)),
    );
    const picks = this.rng.shuffle(sidewalkSpawns).slice(0, count);
    return picks.map((p, i) => ({
      x: p.x,
      y: p.y,
      facing: CARDINAL_FACINGS[i % CARDINAL_FACINGS.length] ?? 0,
      occupiedBy: null,
    }));
  }

  /** Scatter bus stops across sidewalks so pedestrians can wait for transit. */
  private sampleBusStops(sidewalkSpawns: Vector2[], benches: readonly BenchSite[]): BusStopSite[] {
    if (sidewalkSpawns.length === 0) return [];
    const occupied = new Set(benches.map((bench) => `${bench.x},${bench.y}`));
    const candidates = sidewalkSpawns.filter((point) => !occupied.has(`${point.x},${point.y}`));
    if (candidates.length === 0) return [];
    const count = Math.min(
      MAX_BUS_STOPS,
      Math.max(1, Math.floor(candidates.length / BUS_STOP_STRIDE)),
    );
    const picks = this.rng.shuffle(candidates).slice(0, count);
    return picks.map((p, i) => ({
      x: p.x,
      y: p.y,
      facing: CARDINAL_FACINGS[(i + 1) % CARDINAL_FACINGS.length] ?? 0,
      occupiedBy: null,
    }));
  }

  /**
   * One crossing point per physical crosswalk: scan the finished tile grid for
   * {@link TileType.Crossing} tiles, keeping only the road band's centre row/
   * column so a 3-tile-wide crosswalk yields a single point, and derive the
   * axis vehicle traffic travels through it from the same lattice
   * classification {@link tileFor} used to paint it. Each crossing also
   * records whether a real traffic light of the matching axis governs it —
   * lights only cover a thinned subset of intersections, and a pedestrian has
   * no reason to wait on the citywide light phase at a crossing nothing
   * actually enforces.
   */
  private sampleCrossings(
    tiles: number[][],
    widthTiles: number,
    heightTiles: number,
    trafficLights: TrafficLightInfo[],
  ): CrossingInfo[] {
    const crossings: CrossingInfo[] = [];
    const linkRadiusSq = (PERIOD * TILE_SIZE * 1.5) ** 2;
    for (let ty = 0; ty < heightTiles; ty++) {
      const row = tiles[ty];
      if (!row) continue;
      const ya = classifyAxis(ty % PERIOD);
      for (let tx = 0; tx < widthTiles; tx++) {
        if (row[tx] !== TileType.Crossing) continue;
        const xa = classifyAxis(tx % PERIOD);
        let axis: 'ns' | 'ew';
        if (ya.road) {
          if (!ya.roadMid) continue;
          axis = 'ew';
        } else if (xa.road) {
          if (!xa.roadMid) continue;
          axis = 'ns';
        } else {
          continue;
        }
        const x = tx * TILE_SIZE + TILE_SIZE / 2;
        const y = ty * TILE_SIZE + TILE_SIZE / 2;
        const hasLight = trafficLights.some((light) => {
          if (light.northSouth !== (axis === 'ns')) return false;
          const dx = light.x - x;
          const dy = light.y - y;
          return dx * dx + dy * dy <= linkRadiusSq;
        });
        crossings.push({ x, y, axis, hasLight });
      }
    }
    return crossings;
  }

  /**
   * One alternating-axis traffic light at a thinned subset of interior drivable
   * intersections. Thinning (every other intersection) keeps the sprite count
   * modest across the large world while lights still read as present.
   */
  private buildTrafficLights(
    nodes: readonly RoadNode[],
    cities: readonly WorldCity[],
  ): TrafficLightInfo[] {
    const lights: TrafficLightInfo[] = [];
    for (const node of nodes) {
      if (node.neighbours.length < 3) continue;
      const city = cities.find((entry) => {
        const b = entry.bounds;
        return node.x >= b.x && node.y >= b.y && node.x < b.x + b.width && node.y < b.y + b.height;
      });
      if (!city) continue;
      const cadence = city.id === 'tehran' ? 3 : city.id === 'yazd' ? 5 : 6;
      if (Math.abs((node.id * 17 + node.neighbours.length * 11) % cadence) !== 0) continue;
      lights.push({ x: node.x, y: node.y, northSouth: node.id % 2 === 0 });
    }
    return lights;
  }

  private buildIntersectionData(
    nodes: readonly RoadNode[],
    edges: readonly RoadEdge[],
    lights: readonly TrafficLightInfo[],
    plannedIntersections: readonly PlannedIntersection[],
  ): RoadIntersectionData[] {
    const edgesByNode = new Map<number, RoadEdge[]>();
    const designsByPosition = new Map(
      plannedIntersections.map((intersection) => [
        `${intersection.position.x},${intersection.position.y}`,
        intersection.design,
      ]),
    );
    for (const edge of edges) {
      for (const id of [edge.fromNodeId, edge.toNodeId]) {
        const bucket = edgesByNode.get(id) ?? [];
        bucket.push(edge);
        edgesByNode.set(id, bucket);
      }
    }
    return nodes.map((node) => {
      const connected = edgesByNode.get(node.id) ?? [];
      const maxPriority = connected.reduce((best, edge) => Math.max(best, edge.priority), 0);
      const trafficLight = lights.some(
        (light) => Math.hypot(light.x - node.x, light.y - node.y) <= TILE_SIZE,
      );
      const highwayCount = connected.filter((edge) => edge.roadClass === 'highway').length;
      const kind: RoadIntersectionData['kind'] =
        connected.length <= 1
          ? 'dead-end'
          : highwayCount > 0 && connected.length >= 3
            ? 'interchange'
            : connected.length === 2
              ? 'bend'
              : connected.length === 3
                ? 'merge'
                : 'intersection';
      return {
        nodeId: node.id,
        kind,
        control: trafficLight
          ? 'signal'
          : connected.length >= 3
            ? highwayCount > 0
              ? 'yield'
              : 'priority'
            : 'uncontrolled',
        connectedEdgeIds: connected.map((edge) => edge.id),
        priorityEdgeIds: connected
          .filter((edge) => edge.priority === maxPriority)
          .map((edge) => edge.id),
        trafficLight,
        design: designsByPosition.get(
          `${Math.floor(node.x / TILE_SIZE)},${Math.floor(node.y / TILE_SIZE)}`,
        ),
      };
    });
  }

  /** The road node closest to the Tehran core becomes the player spawn. */
  private pickPlayerStart(nodes: RoadNode[], target: Vector2): Vector2 {
    const cx = target.x;
    const cy = target.y;
    let best: RoadNode | undefined = nodes[0];
    let bestDist = Infinity;
    for (const node of nodes) {
      const dx = node.x - cx;
      const dy = node.y - cy;
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) {
        bestDist = dist;
        best = node;
      }
    }
    return best ? { x: best.x, y: best.y } : { x: cx, y: cy };
  }

  /** Reserve and specialize owned architecture as semantic service buildings. */
  private pickServices(entrances: BuildingEntrance[], cities: readonly WorldCity[]): ServiceSites {
    const used = new Set<BuildingEntrance>();
    const usedBuildingIds = new Set<string>();
    const byCity = (id: CityId, role: ServiceArchitectureRole): BuildingEntrance[] => {
      const city = cities.find((entry) => entry.id === id);
      if (!city) return [];
      const b = city.bounds;
      return this.rng
        .shuffle(
          entrances.filter(
            (entry) =>
              !used.has(entry) &&
              !usedBuildingIds.has(entry.buildingId) &&
              entry.x >= b.x &&
              entry.y >= b.y &&
              entry.x < b.x + b.width &&
              entry.y < b.y + b.height,
          ),
        )
        .sort(
          (first, second) =>
            this.serviceEntranceScore(first, role) - this.serviceEntranceScore(second, role),
        );
    };
    const claim = (
      entrance: BuildingEntrance,
      role: ServiceArchitectureRole,
      points: Vector2[],
    ): void => {
      used.add(entrance);
      usedBuildingIds.add(entrance.buildingId);
      this.specializeServiceEntrance(entrance, role);
      points.push({ x: entrance.x, y: entrance.y });
    };
    const reserve = (
      plan: ReadonlyArray<readonly [CityId, number]>,
      role: ServiceArchitectureRole,
    ): Vector2[] => {
      const points: Vector2[] = [];
      for (const [cityId, count] of plan) {
        const candidates = byCity(cityId, role).filter(
          (entrance) => this.serviceInteriorCandidateFits(entrance, role),
        );
        for (const entrance of this.distinctServiceEntrances(candidates, role, count)) {
          claim(entrance, role, points);
        }
        if (points.filter((point) => this.cityIdForPoint(point, cities) === cityId).length < count) {
          throw new Error(`City ${cityId} lacks ${count} interior-capable ${role} buildings`);
        }
      }
      return points;
    };
    const fill = (points: Vector2[], target: number, role: ServiceArchitectureRole): Vector2[] => {
      if (points.length >= target) return points;
      const candidates = this.rng
        .shuffle(
          entrances.filter(
            (entry) =>
              !used.has(entry) &&
              !usedBuildingIds.has(entry.buildingId) &&
              this.serviceInteriorCandidateFits(entry, role),
          ),
        )
        .sort(
          (first, second) =>
            this.serviceEntranceScore(first, role) - this.serviceEntranceScore(second, role),
        );
      for (const entrance of candidates) {
        if (points.length >= target) break;
        claim(entrance, role, points);
      }
      if (points.length === 0) {
        throw new Error(`No planned building entrance can own required ${role} architecture`);
      }
      return points;
    };

    return {
      hospitals: fill(
        reserve(
          [
            ['tehran', 2],
            ['yazd', 1],
            ['gilan', 1],
          ],
          'hospital',
        ),
        4,
        'hospital',
      ),
      policeStations: fill(
        reserve(
          [
            ['tehran', 2],
            ['yazd', 1],
            ['gilan', 1],
          ],
          'police',
        ),
        4,
        'police',
      ),
      fireStations: fill(
        reserve(
          [
            ['tehran', 2],
            ['yazd', 1],
            ['gilan', 1],
          ],
          'fire-station',
        ),
        4,
        'fire-station',
      ),
      gasStations: fill(
        reserve(
          [
            ['tehran', 4],
            ['yazd', 2],
            ['gilan', 2],
          ],
          'gas-station',
        ),
        8,
        'gas-station',
      ),
      gunShops: fill(
        reserve(
          [
            ['tehran', 2],
            ['yazd', 1],
            ['gilan', 1],
          ],
          'gun-shop',
        ),
        4,
        'gun-shop',
      ),
      garages: fill(
        reserve(
          [
            ['tehran', 3],
            ['yazd', 1],
            ['gilan', 1],
          ],
          'garage',
        ),
        5,
        'garage',
      ),
      safeHouses: fill(
        reserve(
          [
            ['tehran', 3],
            ['yazd', 1],
            ['gilan', 1],
          ],
          'safe-house',
        ),
        5,
        'safe-house',
      ),
    };
  }

  /** Prefer genuinely different owners for repeated services in one city. */
  private distinctServiceEntrances(
    candidates: readonly BuildingEntrance[],
    role: ServiceArchitectureRole,
    count: number,
  ): BuildingEntrance[] {
    const unique = candidates.filter(
      (candidate, index) =>
        candidates.findIndex((other) => other.buildingId === candidate.buildingId) === index,
    );
    const selected: BuildingEntrance[] = [];
    while (selected.length < count && unique.length > 0) {
      if (selected.length === 0) {
        const first = unique.shift();
        if (first) selected.push(first);
        continue;
      }
      const bestRoleScore = Math.min(
        ...unique.map((candidate) => this.serviceEntranceScore(candidate, role)),
      );
      const comparable = unique.filter(
        (candidate) => this.serviceEntranceScore(candidate, role) === bestRoleScore,
      );
      let best = comparable[0] ?? unique[0];
      let bestVariation = -Infinity;
      for (const candidate of comparable) {
        const building = this.plannedBuildings.find((item) => item.id === candidate.buildingId);
        if (!building) continue;
        let nearestVariation = Infinity;
        for (const chosen of selected) {
          const other = this.plannedBuildings.find((item) => item.id === chosen.buildingId);
          if (!other) continue;
          const variation =
            Math.abs(building.bounds.width - other.bounds.width) * 4 +
            Math.abs(building.bounds.height - other.bounds.height) * 4 +
            Math.abs(building.floors - other.floors) * 28 +
            (building.size !== other.size ? 80 : 0) +
            (building.material !== other.material ? 64 : 0) +
            (building.roofStyle !== other.roofStyle ? 36 : 0);
          nearestVariation = Math.min(nearestVariation, variation);
        }
        if (nearestVariation <= bestVariation) continue;
        best = candidate;
        bestVariation = nearestVariation;
      }
      if (!best) break;
      selected.push(best);
      unique.splice(unique.indexOf(best), 1);
    }
    return selected;
  }

  private serviceNeedsInterior(role: ServiceArchitectureRole): boolean {
    return role === 'hospital' || role === 'police' || role === 'gun-shop' || role === 'garage';
  }

  private serviceInteriorCandidateFits(
    entrance: BuildingEntrance,
    role: ServiceArchitectureRole,
  ): boolean {
    if (!this.serviceNeedsInterior(role)) return true;
    const grid = this.interiorBoundsFromEntrance(entrance);
    if (!grid) return false;
    if (role !== 'hospital' && role !== 'police') return true;
    const longest = Math.max(grid.w, grid.h);
    const shortest = Math.min(grid.w, grid.h);
    return longest <= 24 && longest / Math.max(1, shortest) <= 3;
  }

  private serviceEntranceScore(entrance: BuildingEntrance, role: ServiceArchitectureRole): number {
    const preferred: Readonly<Record<ServiceArchitectureRole, readonly PlannedBuildingKind[]>> = {
      hospital: ['hospital', 'government', 'office', 'school'],
      police: ['police', 'government', 'office'],
      'fire-station': ['fire-station', 'warehouse', 'factory'],
      'gas-station': ['gas-station', 'parking-structure', 'retail', 'market'],
      'gun-shop': ['retail', 'market', 'warehouse'],
      garage: ['parking-structure', 'warehouse', 'factory'],
      'safe-house': ['house', 'villa', 'apartment', 'hotel'],
    };
    const index = preferred[role].indexOf(entrance.buildingKind);
    return index >= 0 ? index : preferred[role].length + 4;
  }

  /** Convert a committed compatible lot into the service architecture it owns. */
  private specializeServiceEntrance(
    entrance: BuildingEntrance,
    role: ServiceArchitectureRole,
  ): void {
    const building = this.plannedBuildings.find(
      (candidate) => candidate.id === entrance.buildingId,
    );
    if (!building) throw new Error(`Service entrance lost planned owner ${entrance.buildingId}`);

    let kind = building.kind;
    let groundFloorUse = building.groundFloorUse;
    let landUse = building.landUse;
    let roofStyle = building.roofStyle;
    let entranceKind: PlannedEntrance['kind'] = 'main';
    switch (role) {
      case 'hospital':
        kind = 'hospital';
        groundFloorUse = 'clinic';
        landUse = 'institutional';
        roofStyle = 'mechanical';
        entranceKind = 'emergency';
        break;
      case 'police':
        kind = 'police';
        groundFloorUse = 'office';
        landUse = 'public-service';
        roofStyle = 'mechanical';
        break;
      case 'fire-station':
        kind = 'fire-station';
        groundFloorUse = 'parking';
        landUse = 'public-service';
        roofStyle = 'mechanical';
        entranceKind = 'emergency';
        break;
      case 'gas-station':
        kind = 'gas-station';
        groundFloorUse = 'market';
        landUse = 'commercial';
        roofStyle = 'solar';
        entranceKind = 'storefront';
        building.floors = Math.min(2, building.floors);
        break;
      case 'gun-shop':
        kind = 'retail';
        groundFloorUse = 'electronics';
        landUse = 'commercial';
        entranceKind = 'storefront';
        break;
      case 'garage':
        kind = 'parking-structure';
        groundFloorUse = 'parking';
        landUse = 'commercial';
        roofStyle = 'flat';
        entranceKind = 'vehicle';
        break;
      case 'safe-house':
        if (!['house', 'villa', 'apartment', 'hotel'].includes(kind)) kind = 'house';
        groundFloorUse = 'residential';
        landUse = 'residential';
        entranceKind = 'residential';
        break;
    }

    building.kind = kind;
    building.groundFloorUse = groundFloorUse;
    building.landUse = landUse;
    building.roofStyle = roofStyle;
    building.archetype = this.archetypeForBuildingKind(kind, building.size);
    building.facadeStyle = `${building.facadeStyle}:service-${role}`;
    building.signature = `${building.signature}:service-${role}`;
    for (const plannedEntrance of building.entrances) {
      if (plannedEntrance.primary) plannedEntrance.kind = entranceKind;
    }
    entrance.buildingKind = kind;
    entrance.groundFloorUse = groundFloorUse;
  }

  /** Prove every gameplay service marker still points at the specialized building it owns. */
  private auditServiceArchitecture(
    services: ServiceSites,
    entrances: readonly BuildingEntrance[],
  ): string[] {
    const issues: string[] = [];
    const entrancesByPoint = new Map<string, BuildingEntrance[]>();
    for (const entrance of entrances) {
      const key = `${entrance.x},${entrance.y}`;
      const list = entrancesByPoint.get(key) ?? [];
      list.push(entrance);
      entrancesByPoint.set(key, list);
    }
    const buildingsById = new Map(this.plannedBuildings.map((building) => [building.id, building]));
    const expectations: Readonly<
      Record<
        ServiceArchitectureRole,
        {
          kinds: readonly PlannedBuildingKind[];
          groundFloorUse: PlannedGroundFloorUse;
          entranceKind: PlannedEntrance['kind'];
        }
      >
    > = {
      hospital: { kinds: ['hospital'], groundFloorUse: 'clinic', entranceKind: 'emergency' },
      police: { kinds: ['police'], groundFloorUse: 'office', entranceKind: 'main' },
      'fire-station': {
        kinds: ['fire-station'],
        groundFloorUse: 'parking',
        entranceKind: 'emergency',
      },
      'gas-station': {
        kinds: ['gas-station'],
        groundFloorUse: 'market',
        entranceKind: 'storefront',
      },
      'gun-shop': { kinds: ['retail'], groundFloorUse: 'electronics', entranceKind: 'storefront' },
      garage: {
        kinds: ['parking-structure'],
        groundFloorUse: 'parking',
        entranceKind: 'vehicle',
      },
      'safe-house': {
        kinds: ['house', 'villa', 'apartment', 'hotel'],
        groundFloorUse: 'residential',
        entranceKind: 'residential',
      },
    };
    const groups: ReadonlyArray<readonly [ServiceArchitectureRole, readonly Vector2[]]> = [
      ['hospital', services.hospitals],
      ['police', services.policeStations],
      ['fire-station', services.fireStations],
      ['gas-station', services.gasStations],
      ['gun-shop', services.gunShops],
      ['garage', services.garages],
      ['safe-house', services.safeHouses],
    ];
    const claimedBuildings = new Set<string>();

    for (const [role, points] of groups) {
      const expected = expectations[role];
      for (const point of points) {
        const candidates = entrancesByPoint.get(`${point.x},${point.y}`) ?? [];
        const entrance = candidates.find((candidate) => {
          const owner = buildingsById.get(candidate.buildingId);
          return owner?.facadeStyle.includes(`:service-${role}`) ?? false;
        });
        if (!entrance) {
          issues.push(`${role} service at ${point.x},${point.y} has no specialized entrance owner`);
          continue;
        }
        const building = buildingsById.get(entrance.buildingId);
        if (!building) {
          issues.push(`${role} service entrance lost building ${entrance.buildingId}`);
          continue;
        }
        if (claimedBuildings.has(building.id)) {
          issues.push(`${building.id} owns more than one service role`);
        }
        claimedBuildings.add(building.id);
        if (!expected.kinds.includes(building.kind)) {
          issues.push(`${role} service owner ${building.id} has kind ${building.kind}`);
        }
        if (building.groundFloorUse !== expected.groundFloorUse) {
          issues.push(
            `${role} service owner ${building.id} has ground-floor use ${building.groundFloorUse}`,
          );
        }
        if (
          entrance.buildingKind !== building.kind ||
          entrance.groundFloorUse !== building.groundFloorUse ||
          entrance.cityId !== building.cityId ||
          entrance.program !== building.program
        ) {
          issues.push(`${role} service entrance metadata disagrees with owner ${building.id}`);
        }
        if (
          !building.entrances.some(
            (plannedEntrance) =>
              plannedEntrance.primary && plannedEntrance.kind === expected.entranceKind,
          )
        ) {
          issues.push(`${role} service owner ${building.id} lacks its semantic primary entrance`);
        }
      }
    }
    return issues;
  }

  /** Stamp real interiors into service buildings and return their metadata. */
  private buildServiceInteriors(tiles: number[][], services: ServiceSites): InteriorBuildResult {
    const interiors: BuildingInterior[] = [];
    const spawns: Vector2[] = [];
    const groups: Array<readonly [InteriorKind, readonly Vector2[]]> = [
      ['hospital', services.hospitals],
      ['police', services.policeStations],
      ['gunstore', services.gunShops],
      ['dealership', services.garages],
    ];

    for (const [kind, points] of groups) {
      points.forEach((point, index) => {
        const interior = this.carveInterior(tiles, kind, point, index);
        if (!interior) return;
        interiors.push(interior);
        spawns.push(...this.sampleInteriorWalkSpawns(tiles, interior.bounds));
      });
    }

    this.assertInteriorNpcSpawnsClear(tiles, interiors);

    return { interiors, spawns };
  }

  /** Reject authored NPC seeds whose complete deterministic jitter envelope touches solidity. */
  private assertInteriorNpcSpawnsClear(
    tiles: number[][],
    interiors: readonly BuildingInterior[],
  ): void {
    const grid: SolidTileGrid = {
      tileSize: TILE_SIZE,
      widthTiles: tiles[0]?.length ?? 0,
      heightTiles: tiles.length,
      isSolidTile: (tx, ty) => {
        const tile = tiles[ty]?.[tx];
        return tile === undefined || SOLID_SET.has(tile);
      },
    };

    for (const interior of interiors) {
      for (const spawn of interior.npcSpawns) {
        for (let ordinal = 0; ordinal < spawn.count; ordinal += 1) {
          const point = interiorNpcSpawnPosition(spawn, ordinal);
          if (isCircleClearOnGrid(grid, point, PED.RADIUS)) continue;
          throw new Error(
            `Interior ${interior.id} NPC seed ${spawn.role} jitter ${ordinal} touches a solid tile`,
          );
        }
      }
    }
  }

  /** Resolve a service doorway back to the exact rectangular footprint that owns it. */
  private interiorBoundsFromEntrance(
    point: Vector2,
  ): { buildingId: string; tx0: number; ty0: number; w: number; h: number; doorX: number } | null {
    const tx = Math.floor(point.x / TILE_SIZE);
    const ty = Math.floor(point.y / TILE_SIZE);
    for (const building of this.plannedBuildings) {
      if (building.shape !== 'rectangle' || building.footprint.length !== 1) continue;
      const part = building.footprint[0];
      if (!part || part.width < 7 || part.height < 7) continue;
      const authored = (building.entrances ?? []).find(
        (entrance) =>
          entrance.facing === 'north' &&
          entrance.position.x > part.x &&
          entrance.position.x < part.x + part.width - 1 &&
          entrance.position.y === part.y &&
          entrance.apron.x === tx &&
          entrance.apron.y === ty,
      );
      const doorTx = authored?.position.x ?? part.x + Math.floor(part.width / 2);
      if (tx !== doorTx || ty !== part.y - 1) continue;
      if (
        part.x < 1 ||
        part.y < 1 ||
        part.x + part.width >= WORLD_TILES_X ||
        part.y + part.height >= WORLD_TILES_Y
      ) {
        return null;
      }
      return {
        buildingId: building.id,
        tx0: part.x,
        ty0: part.y,
        w: part.width,
        h: part.height,
        doorX: doorTx - part.x,
      };
    }
    return null;
  }

  /** Carve one planned building footprint into a walkable interior with rooms and props. */
  private carveInterior(
    tiles: number[][],
    kind: InteriorKind,
    entrance: Vector2,
    index: number,
  ): BuildingInterior | null {
    const grid = this.interiorBoundsFromEntrance(entrance);
    if (!grid) return null;
    const building = this.plannedBuildings.find((candidate) => candidate.id === grid.buildingId);
    if (!building) return null;

    const bounds = {
      x: grid.tx0 * TILE_SIZE,
      y: grid.ty0 * TILE_SIZE,
      w: grid.w * TILE_SIZE,
      h: grid.h * TILE_SIZE,
    };
    const variant =
      kind === 'hospital' || kind === 'police'
        ? this.majorVariantFor(building.cityId, kind, index)
        : kind === 'gunstore'
          ? 'gun-store'
          : 'vehicle-showroom';
    const majorLayout =
      kind === 'hospital' || kind === 'police'
        ? createMajorInteriorLayout({
            kind,
            cityId: building.cityId,
            variant: variant as MajorBuildingVariant,
            bounds,
            widthTiles: grid.w,
            heightTiles: grid.h,
            doorX: grid.doorX,
            entrance,
          })
        : null;
    this.paintInteriorTiles(
      tiles,
      kind,
      grid.tx0,
      grid.ty0,
      grid.w,
      grid.h,
      grid.doorX,
      majorLayout,
    );

    const interior: BuildingInterior = {
      id: `${kind}:${index}`,
      buildingId: grid.buildingId,
      kind,
      cityId: building.cityId,
      variant,
      entrance: { x: entrance.x, y: entrance.y },
      bounds,
      rooms: majorLayout?.rooms ?? this.interiorRooms(kind, bounds),
      doors: majorLayout?.doors ?? this.interiorDoors(bounds, entrance),
      objects: majorLayout?.objects ?? this.interiorObjects(kind, bounds),
      npcSpawns: majorLayout?.npcSpawns ?? this.interiorNpcSpawns(kind, bounds),
      ambient:
        kind === 'hospital'
          ? 'medical'
          : kind === 'police'
            ? 'police'
            : kind === 'dealership'
              ? 'garage'
              : 'shop',
    };
    return interior;
  }

  private majorVariantFor(
    cityId: CityId,
    kind: 'hospital' | 'police',
    globalIndex: number,
  ): MajorBuildingVariant {
    if (kind === 'police') {
      if (cityId === 'yazd') return 'yazd-courtyard-police';
      if (cityId === 'gilan') return 'gilan-regional-police';
      return globalIndex === 0 ? 'tehran-police-headquarters' : 'tehran-district-police';
    }
    if (cityId === 'yazd') return 'yazd-courtyard-hospital';
    if (cityId === 'gilan') return 'gilan-regional-hospital';
    return globalIndex === 0 ? 'tehran-general-hospital' : 'tehran-emergency-hospital';
  }

  /** Build the shared gameplay/map registry from the exact specialized owners and interiors. */
  private buildMajorBuildings(
    services: ServiceSites,
    interiors: readonly BuildingInterior[],
  ): MajorBuildingDefinition[] {
    const definitions: MajorBuildingDefinition[] = [];
    const cityOrdinals = new Map<string, number>();
    const groups: ReadonlyArray<readonly ['hospital' | 'police-station', readonly Vector2[]]> = [
      ['hospital', services.hospitals],
      ['police-station', services.policeStations],
    ];

    for (const [type, points] of groups) {
      const interiorKind = type === 'hospital' ? 'hospital' : 'police';
      for (const point of points) {
        const interior = interiors.find(
          (candidate) =>
            candidate.kind === interiorKind &&
            candidate.entrance.x === point.x &&
            candidate.entrance.y === point.y,
        );
        if (!interior) {
          throw new Error(`${type} at ${point.x},${point.y} has no playable interior`);
        }
        const building = this.plannedBuildings.find(
          (candidate) => candidate.id === interior.buildingId,
        );
        if (!building) throw new Error(`Major interior ${interior.id} lost ${interior.buildingId}`);

        const ordinalKey = `${building.cityId}:${type}`;
        const ordinal = cityOrdinals.get(ordinalKey) ?? 0;
        cityOrdinals.set(ordinalKey, ordinal + 1);
        const variant = interior.variant as MajorBuildingVariant;
        const police = type === 'police-station';
        const parking = this.majorBuildingParkingArea(building, point, police);
        const id = `${building.cityId}-${police ? 'police' : 'hospital'}-${ordinal + 1}`;
        const bounds = tileBounds(
          building.bounds.x,
          building.bounds.y,
          building.bounds.width,
          building.bounds.height,
        );
        definitions.push({
          id,
          name: this.majorBuildingName(variant),
          type,
          city: building.cityId,
          buildingId: building.id,
          worldPosition: {
            x: bounds.x + bounds.width / 2,
            y: bounds.y + bounds.height / 2,
          },
          entrancePosition: { ...point },
          exteriorBounds: bounds,
          interiorId: interior.id,
          mapIcon: police ? 'police-badge' : 'medical-cross',
          minimapIcon: police ? 'police-badge' : 'medical-cross',
          size:
            building.cityId === 'tehran' && ordinal === 0
              ? 'metropolitan'
              : building.cityId === 'tehran'
                ? 'district'
                : 'regional',
          architecturalVariant: variant,
          npcProfile: {
            maxActive: interior.npcSpawns.reduce((sum, spawn) => sum + spawn.count, 0),
            roles: interior.npcSpawns.map((spawn) => spawn.role),
          },
          parkingArea: {
            position: parking.position,
            heading: parking.heading,
            slots: building.cityId === 'tehran' && ordinal === 0 ? 3 : 2,
            vehicleKind: police
              ? building.cityId === 'tehran' && ordinal === 0
                ? 'policeSuv'
                : 'police'
              : 'ambulance',
          },
          services: police
            ? ['arrest', 'dispatch', 'wanted-clearance']
            : ['healing', 'revival', 'ambulance'],
          activeState: 'proximity-streamed',
        });
      }
    }
    return definitions;
  }

  /** Resolve the actual planned police/ambulance bay owned by the service block. */
  private majorBuildingParkingArea(
    building: PlannedBuilding,
    entrance: Vector2,
    police: boolean,
  ): { position: Vector2; heading: number } {
    const requiredKind = police ? 'police-parking' : 'ambulance-bay';
    let best: PlannedGroundFeature | null = null;
    let bestSq = Infinity;
    for (const space of this.plannedSpaces) {
      if (space.blockId !== building.blockId) continue;
      for (const feature of space.features) {
        if (feature.kind !== requiredKind) continue;
        const x = (feature.bounds.x + feature.bounds.width / 2) * TILE_SIZE;
        const y = (feature.bounds.y + feature.bounds.height / 2) * TILE_SIZE;
        const dx = x - entrance.x;
        const dy = y - entrance.y;
        const distanceSq = dx * dx + dy * dy;
        if (distanceSq >= bestSq) continue;
        best = feature;
        bestSq = distanceSq;
      }
    }
    if (best) {
      const position = {
        x: (best.bounds.x + best.bounds.width / 2) * TILE_SIZE,
        y: (best.bounds.y + best.bounds.height / 2) * TILE_SIZE,
      };
      const heading =
        best.facing === 'east' || best.facing === 'west'
          ? 0
          : best.facing === 'north' || best.facing === 'south'
            ? Math.PI / 2
            : best.bounds.width >= best.bounds.height
              ? 0
              : Math.PI / 2;
      return { position, heading };
    }

    // A rare service conversion can reuse a building whose original block did
    // not include the semantic yard. Keep the fallback on its entrance apron,
    // never on an arbitrary live traffic lane.
    const plannedEntrance = building.entrances.find((candidate) => candidate.primary);
    if (plannedEntrance) {
      const dx = plannedEntrance.apron.x - plannedEntrance.position.x;
      const dy = plannedEntrance.apron.y - plannedEntrance.position.y;
      return {
        position: {
          x: plannedEntrance.apron.x * TILE_SIZE + TILE_SIZE / 2 + dx * TILE_SIZE * 1.5,
          y: plannedEntrance.apron.y * TILE_SIZE + TILE_SIZE / 2 + dy * TILE_SIZE * 1.5,
        },
        heading: Math.abs(dx) >= Math.abs(dy) ? Math.PI / 2 : 0,
      };
    }
    return { position: { ...entrance }, heading: 0 };
  }

  private majorBuildingName(variant: MajorBuildingVariant): string {
    const names: Record<MajorBuildingVariant, string> = {
      'tehran-police-headquarters': 'Tehran Metropolitan Police Headquarters',
      'tehran-district-police': 'Tehran District Police Station',
      'yazd-courtyard-police': 'Yazd Courtyard Police Station',
      'gilan-regional-police': 'Gilan Regional Police Station',
      'tehran-general-hospital': 'Tehran General Hospital',
      'tehran-emergency-hospital': 'Tehran Emergency Hospital',
      'yazd-courtyard-hospital': 'Yazd Courtyard Hospital',
      'gilan-regional-hospital': 'Gilan Regional Hospital',
    };
    return names[variant];
  }

  private assertMajorBuildings(definitions: readonly MajorBuildingDefinition[]): void {
    const registry = new MajorBuildingRegistry(definitions);
    const expected: ReadonlyArray<readonly [CityId, 'hospital' | 'police-station', number]> = [
      ['tehran', 'hospital', 2],
      ['tehran', 'police-station', 2],
      ['yazd', 'hospital', 1],
      ['yazd', 'police-station', 1],
      ['gilan', 'hospital', 1],
      ['gilan', 'police-station', 1],
    ];
    if (definitions.length !== 8) {
      throw new Error(`Major-building registry expected 8 definitions, received ${definitions.length}`);
    }
    for (const [city, type, count] of expected) {
      const actual = registry.inCity(city).filter((definition) => definition.type === type).length;
      if (actual !== count) {
        throw new Error(`Major-building distribution ${city}/${type}: expected ${count}, got ${actual}`);
      }
    }
    if (new Set(definitions.map((definition) => definition.buildingId)).size !== definitions.length) {
      throw new Error('A planned building owns more than one major-building definition');
    }
    if (
      new Set(definitions.map((definition) => definition.architecturalVariant)).size !==
      definitions.length
    ) {
      throw new Error('Required major buildings must use eight distinct architectural variants');
    }
  }

  /** Paint floor, exterior walls, working door tiles and simple partitions. */
  private paintInteriorTiles(
    tiles: number[][],
    kind: InteriorKind,
    tx0: number,
    ty0: number,
    w: number,
    h: number,
    doorX: number,
    majorLayout: MajorInteriorLayout | null,
  ): void {
    for (let y = 0; y < h; y++) {
      const row = tiles[ty0 + y];
      if (!row) continue;
      for (let x = 0; x < w; x++) {
        const border = x === 0 || y === 0 || x === w - 1 || y === h - 1;
        row[tx0 + x] = border ? TileType.InteriorWall : TileType.InteriorFloor;
      }
    }

    const doorRow = tiles[ty0];
    if (doorRow) doorRow[tx0 + doorX] = TileType.InteriorDoor;
    const apronRow = tiles[ty0 - 1];
    if (apronRow) apronRow[tx0 + doorX] = TileType.InteriorDoor;

    const wall = (x: number, y: number): void => {
      const row = tiles[ty0 + y];
      if (!row) return;
      row[tx0 + x] = TileType.InteriorWall;
    };
    const door = (x: number, y: number): void => {
      const row = tiles[ty0 + y];
      if (!row) return;
      row[tx0 + x] = TileType.InteriorDoor;
    };

    if (majorLayout) {
      for (const cell of majorLayout.wallCells) wall(cell.x, cell.y);
      for (const cell of majorLayout.doorCells) door(cell.x, cell.y);
      for (const cell of majorLayout.fixtureCells) {
        const row = tiles[ty0 + cell.y];
        if (row && row[tx0 + cell.x] === TileType.InteriorFloor) {
          row[tx0 + cell.x] = TileType.InteriorFixture;
        }
      }
      return;
    }

    if (kind === 'hospital') {
      for (const x of [1, 2, 4, 5]) wall(x, 3);
      door(3, 3);
      wall(5, 1);
      wall(5, 2);
      wall(1, 5);
      wall(2, 5);
    } else if (kind === 'police') {
      for (const y of [1, 3, 5]) wall(4, y);
      door(4, 2);
      door(4, 4);
      for (const x of [1, 2]) wall(x, 3);
      door(3, 3);
    } else if (kind === 'gunstore') {
      for (const x of [1, 2, 3, 4]) wall(x, 5);
      door(5, 5);
    } else {
      for (const x of [3, 4, 5]) wall(x, 5);
      door(2, 5);
    }
  }

  /** Sample walkable interior tile centres for local pedestrian pathing. */
  private sampleInteriorWalkSpawns(
    tiles: number[][],
    bounds: { x: number; y: number; w: number; h: number },
  ): Vector2[] {
    const out: Vector2[] = [];
    const tx0 = Math.floor(bounds.x / TILE_SIZE);
    const ty0 = Math.floor(bounds.y / TILE_SIZE);
    const tx1 = Math.floor((bounds.x + bounds.w) / TILE_SIZE);
    const ty1 = Math.floor((bounds.y + bounds.h) / TILE_SIZE);
    for (let ty = ty0; ty < ty1; ty++) {
      const row = tiles[ty];
      if (!row) continue;
      for (let tx = tx0; tx < tx1; tx++) {
        const tile = row[tx];
        if (tile === TileType.InteriorFloor || tile === TileType.InteriorDoor) {
          out.push({ x: tx * TILE_SIZE + TILE_SIZE / 2, y: ty * TILE_SIZE + TILE_SIZE / 2 });
        }
      }
    }
    return out;
  }

  private interiorRooms(
    kind: InteriorKind,
    b: { x: number; y: number; w: number; h: number },
  ): BuildingInterior['rooms'] {
    const r = (name: string, x: number, y: number, w: number, h: number) => ({
      name,
      x: b.x + x,
      y: b.y + y,
      w,
      h,
    });
    if (kind === 'hospital') {
      return [
        r('Reception', 12, 12, 76, 42),
        r('Waiting Area', 12, 60, 76, 62),
        r('Emergency Room', 100, 12, 52, 70),
        r('Doctor Office', 156, 12, 48, 70),
        r('Pharmacy', 132, 94, 72, 40),
        r('Patient Rooms', 92, 140, 72, 52),
        r('Storage', 16, 150, 54, 36),
        r('Bathrooms', 168, 144, 36, 42),
        r('Corridors', 92, 88, 40, 42),
      ];
    }
    if (kind === 'police') {
      return [
        r('Lobby', 12, 12, 88, 52),
        r('Reception', 14, 68, 78, 34),
        r('Offices', 104, 12, 62, 72),
        r('Evidence Room', 168, 14, 36, 54),
        r('Armory', 110, 96, 54, 42),
        r('Locker Room', 110, 144, 52, 46),
        r('Interrogation', 16, 118, 72, 44),
        r('Jail Cells', 168, 92, 36, 98),
      ];
    }
    if (kind === 'gunstore') {
      return [
        r('Sales Floor', 12, 12, 116, 122),
        r('Weapon Displays', 132, 12, 72, 80),
        r('Ammunition Shelves', 132, 96, 72, 42),
        r('Cashier', 18, 146, 90, 44),
        r('Storage', 116, 154, 88, 38),
      ];
    }
    return [
      r('Reception', 12, 12, 76, 42),
      r('Indoor Showroom', 92, 12, 112, 112),
      r('Service Area', 92, 132, 112, 58),
      r('Parking Area', 14, 72, 74, 118),
    ];
  }

  private interiorDoors(
    b: { x: number; y: number; w: number; h: number },
    entrance: Vector2,
  ): BuildingInterior['doors'] {
    return [
      { x: entrance.x - 12, y: b.y - 4, w: 24, h: 12, open: true },
      { x: b.x + b.w / 2 - 10, y: b.y + b.h / 2 - 6, w: 20, h: 12, open: true },
    ];
  }

  private interiorObjects(
    kind: InteriorKind,
    b: { x: number; y: number; w: number; h: number },
  ): InteriorObjectInfo[] {
    const o = (
      kindName: InteriorObjectInfo['kind'],
      x: number,
      y: number,
      w: number,
      h: number,
      color: number,
      prompt?: string,
      action?: InteriorObjectInfo['action'],
    ): InteriorObjectInfo => ({
      kind: kindName,
      x: b.x + x,
      y: b.y + y,
      w,
      h,
      color,
      prompt,
      action,
    });

    if (kind === 'hospital') {
      return [
        o('counter', 16, 18, 58, 14, 0x5c8193, 'E  Check in / heal', 'hospital-heal'),
        o('bench', 16, 72, 22, 10, 0x47606e),
        o('bench', 48, 72, 22, 10, 0x47606e),
        o('stretcher', 108, 28, 34, 14, 0xd8dde7),
        o('desk', 164, 26, 28, 18, 0x4f657c),
        o('shelf', 140, 100, 50, 12, 0x4b7a63, 'E  Buy medkit', 'hospital-medkit'),
        o('bed', 102, 150, 38, 16, 0xa8c0d0),
        o('bed', 146, 150, 34, 16, 0xa8c0d0),
        o('cabinet', 22, 158, 24, 22, 0x596675, 'E  Save chart', 'hospital-save'),
        o('washroom', 176, 154, 16, 22, 0x84919e),
      ];
    }

    if (kind === 'police') {
      return [
        o('counter', 18, 22, 62, 14, 0x2e4e82, 'E  Clear report', 'police-clear'),
        o('desk', 112, 24, 34, 20, 0x465060),
        o('cabinet', 176, 24, 18, 30, 0x343f51),
        o('display', 116, 102, 36, 16, 0x202833),
        o('locker', 116, 154, 36, 22, 0x3a4658),
        o('desk', 28, 130, 44, 20, 0x384250),
        o('cell', 174, 104, 20, 30, 0x141922),
        o('cell', 174, 146, 20, 30, 0x141922),
      ];
    }

    if (kind === 'gunstore') {
      return [
        o('counter', 20, 150, 72, 16, 0x5a4331, 'E  Buy weapon', 'gun-buy-weapon'),
        o('display', 138, 22, 54, 18, 0x3d2f24, 'E  Inspect weapons', 'gun-buy-weapon'),
        o('display', 138, 54, 54, 18, 0x3d2f24),
        o('shelf', 138, 104, 52, 12, 0x59422f, 'E  Buy ammo', 'gun-buy-ammo'),
        o('cabinet', 52, 112, 36, 16, 0x4c3a2c, 'E  Buy armor', 'gun-buy-armor'),
        o('crate', 132, 164, 38, 18, 0x8a6a44),
      ];
    }

    return [
      o('counter', 18, 20, 58, 14, 0x315666, 'E  Buy vehicle', 'dealer-buy-vehicle'),
      o('vehicle-display', 104, 26, 38, 54, 0x18252c, 'E  View showroom', 'dealer-buy-vehicle'),
      o('vehicle-display', 154, 26, 38, 54, 0x18252c),
      o('vehicle-display', 34, 90, 32, 52, 0x18252c),
      o('display', 112, 148, 74, 18, 0x364752, 'E  Service desk', 'dealer-service'),
      o('crate', 150, 174, 30, 14, 0x596675),
    ];
  }

  private interiorNpcSpawns(
    kind: InteriorKind,
    b: { x: number; y: number; w: number; h: number },
  ): BuildingInterior['npcSpawns'] {
    const s = (role: string, x: number, y: number, count = 1) => ({
      role,
      x: b.x + x,
      y: b.y + y,
      count,
    });
    if (kind === 'hospital') {
      return [
        s('nurse', 52, 48, 2),
        s('doctor', 126, 58, 2),
        s('patient', 54, 144, 2),
        s('pharmacist', 166, 144, 1),
      ];
    }
    if (kind === 'police') {
      return [
        s('desk officer', 56, 52, 1),
        // Keep the entire shared runtime jitter envelope clear of the x=4
        // partition wall (128 px from the interior origin).
        s('officer', 104, 70, 2),
        s('detective', 52, 146, 1),
        s('guard', 88, 170, 1),
      ];
    }
    if (kind === 'gunstore') {
      return [s('clerk', 56, 142, 1), s('shopper', 114, 86, 2)];
    }
    return [s('sales', 50, 50, 1), s('customer', 122, 92, 2), s('mechanic', 156, 128, 1)];
  }

  /** Scatter hidden collectible packages across walkable spots. */
  private pickCollectibles(walkable: Vector2[]): Vector2[] {
    if (walkable.length === 0) return [];
    const picks = this.rng.shuffle(walkable).slice(0, 20);
    return picks.map((p) => ({ x: p.x, y: p.y }));
  }

  /** Pick a handful of road points as street-race start flags. */
  private pickRaceStarts(roadSpawns: Vector2[]): Vector2[] {
    if (roadSpawns.length === 0) return [];
    return this.rng
      .shuffle(roadSpawns)
      .slice(0, 5)
      .map((p) => ({ x: p.x, y: p.y }));
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** Create always-available map landmarks for navigation and exploration. */
  private buildLandmarks(
    cities: readonly WorldCity[],
    services: ServiceSites,
    highways: readonly HighwayRoute[],
  ): WorldLandmark[] {
    const mark = (
      id: string,
      name: string,
      tx: number,
      ty: number,
      kind: WorldLandmark['kind'],
      description?: string,
    ): WorldLandmark => {
      const position = tileCenter(tx, ty);
      return {
        id,
        name,
        position,
        kind,
        cityId: this.cityIdForPoint(position, cities),
        description,
      };
    };

    const landmarks: WorldLandmark[] = [
      mark(
        'tehran-airport',
        'Tehran International Airport',
        980,
        840,
        'airport',
        'Two runways, passenger terminal, cargo apron and control complex',
      ),
      mark('tehran-airport-control', 'Airport Control Tower', 1070, 900, 'tower'),
      mark('tehran-cargo', 'National Air Cargo Terminal', 1010, 902, 'cargo'),
      mark('tehran-airport-hotels', 'Airport Hotel District', 850, 930, 'hotel'),
      mark('tehran-tv-tower', 'Milad TV Tower', 705, 930, 'tower'),
      mark('tehran-stadium', 'Azadi National Stadium', 430, 1260, 'stadium'),
      mark('tehran-government', 'National Government Complex', 565, 930, 'government'),
      mark('tehran-financial', 'Capital Financial Towers', 690, 1010, 'financial'),
      mark('tehran-university', 'Tehran University District', 330, 900, 'university'),
      mark('tehran-station', 'Tehran Central Train Station', 590, 1210, 'station'),
      mark('tehran-metro-old-town', 'Metro: Old Town', 270, 1160, 'metro'),
      mark('tehran-metro-central', 'Metro: Central Business District', 620, 1010, 'metro'),
      mark('tehran-metro-airport', 'Metro: Airport Express', 875, 845, 'metro'),
      mark('tehran-shopping', 'Iran Grand Shopping Center', 790, 1035, 'shop'),
      mark('tehran-river-park', 'Capital River Park', 600, 1225, 'park'),
      mark('tehran-logistics', 'South Logistics and Warehouse City', 960, 1190, 'cargo'),
      mark('tehran-beltway-west', 'West Beltway Interchange', 145, 1015, 'bridge'),
      mark('tehran-beltway-east', 'East Beltway Interchange', 1120, 1040, 'bridge'),
      mark('tehran-bridge-west', 'Old Town River Bridge', 210, 1116, 'bridge'),
      mark('tehran-bridge-central', 'Central River Bridge', 600, 1116, 'bridge'),
      mark('tehran-bridge-east', 'Industrial River Bridge', 1015, 1116, 'bridge'),

      mark('yazd-airfield', 'Yazd Desert Airport', 1680, 570, 'airport'),
      mark('yazd-bazaar', 'Ancient Covered Bazaar', 1585, 690, 'bazaar'),
      mark('yazd-windcatchers', 'Windcatcher District', 1535, 610, 'tower'),
      mark('yazd-mosque', 'Sun Courtyard Mosque', 1510, 565, 'mosque'),
      mark('yazd-fort', 'Historic Yazd Fortress', 1490, 655, 'fort'),
      mark('yazd-caravanserai', 'Ancient Caravanserai', 1468, 740, 'caravanserai'),
      mark('yazd-observatory', 'Desert Observatory', 1780, 540, 'observatory'),
      mark('yazd-mine', 'Salt Ridge Mining Works', 1740, 800, 'mine'),
      mark('yazd-salt-lake', 'Kavir Salt Lake', 1300, 735, 'salt-lake'),
      mark('yazd-oasis', 'Mehr Oasis', 1408, 685, 'oasis'),
      mark('yazd-solar', 'Central Desert Solar Plant', 1555, 862, 'solar'),
      mark('yazd-military', 'Desert Military Base', 1780, 665, 'military'),
      mark('yazd-viewpoint', 'Dune Sea Viewpoint', 1375, 900, 'viewpoint'),
      mark('yazd-rest', 'Silk Road Truck Stop', 1320, 990, 'rest-stop'),

      mark('gilan-harbor', 'Gilan Fishing Harbor', 185, 335, 'harbor'),
      mark('gilan-port', 'Caspian Commercial Port', 225, 365, 'port'),
      mark('gilan-marina', 'Caspian Marina', 165, 275, 'marina'),
      mark('gilan-lighthouse', 'Anzali Lighthouse', 96, 155, 'lighthouse'),
      mark('gilan-beach', 'Grand Caspian Beach', 98, 430, 'hotel'),
      mark('gilan-national-park', 'Hyrcanian National Forest', 530, 280, 'forest'),
      mark('gilan-waterfall', 'Misty Forest Waterfall', 505, 175, 'waterfall'),
      mark('gilan-tea', 'Lahijan Tea Hills', 500, 235, 'viewpoint'),
      mark('gilan-lake', 'Gilan Forest Lake', 505, 165, 'park'),
      mark('gilan-rice', 'Sefid Rice Fields', 420, 390, 'park'),
      mark('gilan-camping', 'National Park Campground', 545, 300, 'camping'),
      mark('gilan-cabins', 'Forest Cabin Village', 455, 330, 'hotel'),
      mark('gilan-mountain-pass', 'Green Mountain Pass', 650, 420, 'viewpoint'),
      mark('gilan-wooden-bridge', 'Sefid Wooden Bridge', 338, 352, 'bridge'),

      mark('alborz-pass', 'Alborz Tunnel and Scenic Pass', 820, 590, 'viewpoint'),
      mark('alborz-maintenance', 'Alborz Road Maintenance Depot', 720, 650, 'rest-stop'),
      mark('east-route-stop', 'Caspian Route Service Plaza', 1040, 345, 'gas'),
      mark('desert-rest-area', 'Kavir Highway Rest Area', 1300, 1000, 'rest-stop'),
    ];

    const serviceGroups: Array<readonly [string, readonly Vector2[], WorldLandmark['kind']]> = [
      ['fuel', services.gasStations, 'gas'],
      ['garage', services.garages, 'shop'],
      ['gun', services.gunShops, 'shop'],
    ];
    for (const [prefix, points, kind] of serviceGroups) {
      points.forEach((position, index) => {
        landmarks.push({
          id: prefix + '-' + index,
          name:
            kind === 'gas' ? 'Fuel and Repair' : 'Service District',
          position: { x: position.x, y: position.y },
          kind,
          cityId: this.cityIdForPoint(position, cities),
        });
      });
    }
    for (const highway of highways) {
      for (const area of highway.serviceAreas) {
        landmarks.push({
          id: area.id,
          name: area.name,
          position: { ...area.position },
          kind: area.facilities.includes('fuel') ? 'gas' : 'rest-stop',
          description: `${area.kilometer.toFixed(1)} km · ${area.facilities.join(', ')}`,
        });
      }
      for (const structure of highway.structures) {
        if (structure.kind !== 'bridge' && structure.kind !== 'tunnel') continue;
        landmarks.push({
          id: structure.id,
          name: `${highway.name} ${structure.kind === 'bridge' ? 'Bridge' : 'Tunnel'}`,
          position: { ...structure.position },
          kind: structure.kind === 'bridge' ? 'bridge' : 'viewpoint',
          description: `Engineered ${structure.kind} on ${highway.name}`,
        });
      }
    }
    return landmarks;
  }

  private cityIdForPoint(point: Vector2, cities: readonly WorldCity[]): CityId | undefined {
    for (const city of cities) {
      const b = city.bounds;
      if (point.x >= b.x && point.y >= b.y && point.x < b.x + b.width && point.y < b.y + b.height) {
        return city.id;
      }
    }
    return undefined;
  }

  /** Audit the actual generated graph before any simulation system can consume it. */
  private validateWorld(
    cities: readonly WorldCity[],
    highways: readonly HighwayRoute[],
    nodes: readonly RoadNode[],
    edges: readonly RoadEdge[],
    intersections: readonly RoadIntersectionData[],
    crossings: readonly CrossingInfo[],
    tiles: number[][],
    urbanPlan: UrbanPlanData,
    highwayQuality: HighwayQualityReport,
  ): WorldValidationReport {
    const issues: string[] = [];
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const edgesByNode = new Map<number, RoadEdge[]>();
    const edgeByPair = new Map<string, RoadEdge>();
    const pairKey = (first: number, second: number): string =>
      first < second ? `${first}:${second}` : `${second}:${first}`;
    for (const edge of edges) {
      if (!byId.has(edge.fromNodeId) || !byId.has(edge.toNodeId)) {
        issues.push(`road edge ${edge.id} references a missing node`);
        continue;
      }
      const key = pairKey(edge.fromNodeId, edge.toNodeId);
      if (edgeByPair.has(key)) issues.push(`multiple road edges own node pair ${key}`);
      edgeByPair.set(key, edge);
      for (const id of [edge.fromNodeId, edge.toNodeId]) {
        const bucket = edgesByNode.get(id) ?? [];
        bucket.push(edge);
        edgesByNode.set(id, bucket);
      }
    }
    for (const node of nodes) {
      const uniqueNeighbours = new Set(node.neighbours);
      if (uniqueNeighbours.size !== node.neighbours.length) {
        issues.push(`road node ${node.id} contains duplicate neighbours`);
      }
      for (const neighbourId of uniqueNeighbours) {
        const neighbour = byId.get(neighbourId);
        if (!neighbour) {
          issues.push(`road node ${node.id} references missing neighbour ${neighbourId}`);
          continue;
        }
        if (!neighbour.neighbours.includes(node.id)) {
          issues.push(`road connection ${node.id}:${neighbourId} is not reciprocal`);
        }
        if (!edgeByPair.has(pairKey(node.id, neighbourId))) {
          issues.push(`road connection ${node.id}:${neighbourId} has no policy edge`);
        }
      }
    }
    for (const edge of edges) {
      const from = byId.get(edge.fromNodeId);
      const to = byId.get(edge.toNodeId);
      if (!from?.neighbours.includes(edge.toNodeId) || !to?.neighbours.includes(edge.fromNodeId)) {
        issues.push(`road edge ${edge.id} is absent from its endpoint neighbour lists`);
      }
      if (from && to && Math.hypot(to.x - from.x, to.y - from.y) < MIN_TRAFFIC_EDGE_LENGTH_PX) {
        issues.push(`road edge ${edge.id} is too short for the runtime lane builder`);
      }
    }

    const plannedEdgeIds = new Set(urbanPlan.roads.map((road) => `road:${road.id}`));
    if (plannedEdgeIds.size !== edges.length) {
      issues.push(
        `runtime road graph generated ${edges.length}/${plannedEdgeIds.size} planned edges`,
      );
    }
    for (const edgeId of plannedEdgeIds) {
      if (!edges.some((edge) => edge.id === edgeId)) {
        issues.push(`planned edge ${edgeId} is missing`);
      }
    }
    const interruptedRoads = urbanPlan.roads.filter(
      (road) => !this.plannedRoadSegmentIsClear(tiles, road),
    );
    if (interruptedRoads.length > 0) {
      issues.push(`${interruptedRoads.length} final road centrelines are not explicit asphalt`);
    }
    const urbanQualityPassed =
      urbanPlan.quality.passed &&
      urbanPlan.quality.invalidTerminals === 0 &&
      urbanPlan.quality.interruptedRoadSegments === 0 &&
      urbanPlan.quality.roadBuildingOverlaps === 0 &&
      interruptedRoads.length === 0;
    if (!urbanQualityPassed) issues.push('urban planning quality gate did not pass');
    const highwayQualityPassed =
      highwayQuality.passed &&
      highwayQuality.jaggedEdgeViolations === 0 &&
      highwayQuality.brokenGuardRails === 0 &&
      highwayQuality.medianDiscontinuities === 0 &&
      highwayQuality.opposingPavementOverlaps === 0 &&
      highwayQuality.brokenLaneMarkings === 0 &&
      highwayQuality.unexpectedLaneWidthChanges === 0 &&
      highwayQuality.highwayDeadEnds === 0 &&
      highwayQuality.invalidRamps === 0 &&
      highwayQuality.serviceSpacingViolations === 0 &&
      highwayQuality.rampCurvatureViolations === 0 &&
      highwayQuality.overlappingMarkings === 0 &&
      highwayQuality.shortMergeLanes === 0 &&
      highwayQuality.directLocalConnections === 0 &&
      highwayQuality.oversizedGores === 0 &&
      highwayQuality.roadEdgeIntersections === 0 &&
      highwayQuality.missingHierarchyLinks === 0 &&
      highwayQuality.missingCityGateZones === 0;
    if (!highwayQualityPassed) issues.push('procedural highway quality gate did not pass');
    for (const highway of highways) {
      for (const interchange of highway.interchanges) {
        const connection = {
          x: Math.floor(interchange.cityConnection.x / TILE_SIZE),
          y: Math.floor(interchange.cityConnection.y / TILE_SIZE),
        };
        const incident = urbanPlan.roads.filter(
          (road) =>
            (road.from.x === connection.x && road.from.y === connection.y) ||
            (road.to.x === connection.x && road.to.y === connection.y),
        );
        const cityRoads = incident.filter((road) => road.highwayId === undefined);
        if (cityRoads.length === 0 || cityRoads.every((road) => road.hierarchy !== 'primary')) {
          issues.push(`${interchange.id} does not terminate at a primary boulevard`);
        }
        if (
          cityRoads.some((road) =>
            ['secondary', 'residential', 'alley', 'access'].includes(road.hierarchy),
          )
        ) {
          issues.push(`${interchange.id} connects directly to a lower-order city street`);
        }
        const carriageways = incident.filter(
          (road) => road.highwayId === highway.id && road.highwayComponent === 'carriageway',
        );
        if (carriageways.length !== 2) {
          issues.push(`${interchange.id} does not meet both carriageways at one city-road node`);
        }
        if (
          interchange.transitionPaths.length > 0 ||
          interchange.goreAreas.length > 0 ||
          interchange.entryRampIds.length > 0 ||
          interchange.exitRampIds.length > 0 ||
          interchange.circulatingRoadIds.length > 0
        ) {
          issues.push(`${interchange.id} contains forbidden ramp or interchange geometry`);
        }
      }
    }

    const nearestNode = (point: Vector2): RoadNode | undefined => {
      let best: RoadNode | undefined;
      let bestDistance = Infinity;
      for (const node of nodes) {
        const distance = (node.x - point.x) ** 2 + (node.y - point.y) ** 2;
        if (distance < bestDistance) {
          best = node;
          bestDistance = distance;
        }
      }
      return best;
    };
    const start = nearestNode(
      cities.find((city) => city.id === 'tehran')?.center ?? { x: 0, y: 0 },
    );
    const visit = (
      origin: RoadNode | undefined,
      directed: boolean,
      emergencyOnly: boolean,
    ): Set<number> => {
      const visited = new Set<number>();
      if (!origin) return visited;
      const queue = [origin.id];
      visited.add(origin.id);
      for (let cursor = 0; cursor < queue.length; cursor++) {
        const id = queue[cursor];
        if (id === undefined) continue;
        for (const edge of edgesByNode.get(id) ?? []) {
          if (emergencyOnly && !edge.emergencyAllowed) continue;
          let next: number | undefined;
          if (edge.fromNodeId === id && (!directed || edge.direction !== 'reverse')) {
            next = edge.toNodeId;
          }
          if (edge.toNodeId === id && (!directed || edge.direction !== 'forward')) {
            next = edge.fromNodeId;
          }
          if (next === undefined || visited.has(next)) continue;
          visited.add(next);
          queue.push(next);
        }
      }
      return visited;
    };

    const connected = visit(start, false, false);
    const connectedEdges = edges.filter(
      (edge) => connected.has(edge.fromNodeId) && connected.has(edge.toNodeId),
    ).length;
    if (connected.size !== nodes.length) {
      const samples = nodes
        .filter((node) => !connected.has(node.id))
        .slice(0, 8)
        .map((node) => `${Math.round(node.x / TILE_SIZE)},${Math.round(node.y / TILE_SIZE)}`)
        .join(' | ');
      issues.push(
        `${nodes.length - connected.size} road nodes are disconnected from the national network near ${samples}`,
      );
    }
    if (connectedEdges !== edges.length) {
      issues.push(`${edges.length - connectedEdges} physical road edges are disconnected`);
    }

    const representatives = new Map<CityId, RoadNode>();
    for (const city of cities) {
      const representative = nearestNode(city.center);
      if (representative) representatives.set(city.id, representative);
    }
    const reachableCities = cities
      .filter((city) => {
        const node = representatives.get(city.id);
        return node !== undefined && connected.has(node.id);
      })
      .map((city) => city.id);
    if (reachableCities.length !== cities.length) {
      issues.push('not every city is attached to the physical road network');
    }

    let directedCitiesContinuous = true;
    let emergencyNetworkContinuous = true;
    for (const source of cities) {
      const sourceNode = representatives.get(source.id);
      const trafficReach = visit(sourceNode, true, false);
      const emergencyReach = visit(sourceNode, true, true);
      for (const target of cities) {
        const targetNode = representatives.get(target.id);
        if (!targetNode || !trafficReach.has(targetNode.id)) directedCitiesContinuous = false;
        if (!targetNode || !emergencyReach.has(targetNode.id)) emergencyNetworkContinuous = false;
      }
    }
    if (!directedCitiesContinuous) {
      issues.push('one-way rules prevent traffic from driving between every city');
    }
    const lanePolicyDeadEnds = nodes.filter((node) => {
      const incident = edgesByNode.get(node.id) ?? [];
      return (
        incident.length <= 1 &&
        incident.some((edge) => edge.laneCount > 1 && edge.highwayComponent === 'carriageway')
      );
    }).length;
    const trafficLaneGraphContinuous = directedCitiesContinuous && lanePolicyDeadEnds === 0;
    if (lanePolicyDeadEnds > 0) {
      issues.push(`${lanePolicyDeadEnds} junctions can strand a multi-lane traffic lane`);
    }
    if (!emergencyNetworkContinuous) {
      issues.push('emergency routes do not reach every city in both directions');
    }

    const generatedHighwayIds = Array.from(
      new Set(edges.flatMap((edge) => (edge.highwayId ? [edge.highwayId] : []))),
    );
    const intercityDriveSeconds: Record<string, number> = {};
    for (const highway of highways) {
      const segmentCount = edges.filter((edge) => edge.highwayId === highway.id).length;
      const expectedSegments =
        highway.carriageways.reduce(
          (count, carriageway) => count + carriageway.roadSegmentIds.length,
          0,
        ) +
        highway.interchanges.reduce(
          (count, interchange) =>
            count +
            interchange.entryRampIds.length +
            interchange.exitRampIds.length +
            interchange.circulatingRoadIds.length,
          0,
        ) +
        highway.serviceAreas.reduce((count, area) => count + area.accessRoadIds.length, 0);
      if (segmentCount !== expectedSegments) {
        issues.push(
          `highway ${highway.id} generated ${segmentCount}/${expectedSegments} graph segments`,
        );
      }
      const mixedDirection = edges.some(
        (edge) =>
          edge.highwayId === highway.id &&
          edge.highwayComponent === 'carriageway' &&
          edge.direction !== 'forward',
      );
      if (mixedDirection) issues.push(`highway ${highway.id} contains a bidirectional carriageway`);
      const fromCity = cities.find((city) => city.id === highway.from);
      const toCity = cities.find((city) => city.id === highway.to);
      const first = highway.points[0];
      const last = highway.points[highway.points.length - 1];
      let distance = 0;
      if (fromCity && first) {
        distance += Math.hypot(first.x - fromCity.center.x, first.y - fromCity.center.y);
      }
      for (let index = 1; index < highway.points.length; index++) {
        const previous = highway.points[index - 1];
        const point = highway.points[index];
        if (previous && point) distance += Math.hypot(point.x - previous.x, point.y - previous.y);
      }
      if (toCity && last) {
        distance += Math.hypot(toCity.center.x - last.x, toCity.center.y - last.y);
      }
      const seconds = Math.round(distance / 220);
      intercityDriveSeconds[`${highway.from}:${highway.to}`] = seconds;
      if (seconds < 120) {
        issues.push(`highway ${highway.id} produces a drive shorter than two minutes`);
      }
    }

    const edgeIds = new Set(edges.map((edge) => edge.id));
    for (const intersection of intersections) {
      if (!byId.has(intersection.nodeId)) {
        issues.push(`intersection ${intersection.nodeId} has no road node`);
      }
      if (intersection.connectedEdgeIds.some((id) => !edgeIds.has(id))) {
        issues.push(`intersection ${intersection.nodeId} references a missing road edge`);
      }
    }
    const pedestrianCrossingsValid =
      crossings.length >= cities.length * 4 &&
      crossings.every((crossing) => Number.isFinite(crossing.x) && Number.isFinite(crossing.y));
    if (!pedestrianCrossingsValid) issues.push('pedestrian crossing graph is incomplete');

    return {
      passed: issues.length === 0,
      connectedRoadNodes: connected.size,
      totalRoadNodes: nodes.length,
      connectedRoadEdges: connectedEdges,
      totalRoadEdges: edges.length,
      reachableCities,
      highwayIds: generatedHighwayIds,
      intercityDriveSeconds,
      navigationGraphContinuous: connected.size === nodes.length,
      trafficLaneGraphContinuous,
      pathfindingGraphContinuous: connected.size === nodes.length,
      emergencyNetworkContinuous,
      pedestrianCrossingsValid,
      urbanQualityPassed,
      highwayQualityPassed,
      issues,
    };
  }

  /** Build a compact terrain cache used by the radar. */
  private buildOverview(tiles: number[][]): MapOverview {
    const cellSizeTiles = 8;
    const height = Math.ceil(tiles.length / cellSizeTiles);
    const width = Math.ceil((tiles[0]?.length ?? 0) / cellSizeTiles);
    const overview: number[][] = [];
    for (let oy = 0; oy < height; oy++) {
      const row: number[] = [];
      for (let ox = 0; ox < width; ox++) {
        let selected = TileType.Grass;
        let bestPriority = -1;
        for (let dy = 0; dy < cellSizeTiles; dy++) {
          const source = tiles[oy * cellSizeTiles + dy];
          if (!source) continue;
          for (let dx = 0; dx < cellSizeTiles; dx++) {
            const tile = source[ox * cellSizeTiles + dx] ?? TileType.Grass;
            const priority = this.overviewPriority(tile);
            if (priority > bestPriority) {
              selected = tile;
              bestPriority = priority;
            }
          }
        }
        row.push(selected);
      }
      overview.push(row);
    }
    return { cellSizeTiles, width, height, tiles: overview };
  }

  private overviewPriority(tile: number): number {
    switch (tile) {
      case TileType.Road:
      case TileType.RoadLineH:
      case TileType.RoadLineV:
      case TileType.Crossing:
      case TileType.Runway:
        return 10;
      case TileType.Water:
      case TileType.Dock:
        return 9;
      case TileType.Building:
      case TileType.BuildingRes:
      case TileType.BuildingInd:
        return 7;
      case TileType.Rock:
        return 6;
      case TileType.Sand:
        return 5;
      case TileType.Dirt:
        return 4;
      default:
        return 1;
    }
  }

  /** Verify an accepted centreline is still explicit asphalt, never merely drivable concrete. */
  private plannedRoadSegmentIsClear(tiles: number[][], road: PlannedRoadSegment): boolean {
    const dx = road.to.x - road.from.x;
    const dy = road.to.y - road.from.y;
    const steps = Math.max(1, Math.max(Math.abs(dx), Math.abs(dy)) * 2);
    for (let step = 0; step <= steps; step++) {
      const t = step / steps;
      const tx = Math.round(road.from.x + dx * t);
      const ty = Math.round(road.from.y + dy * t);
      const tile = tiles[ty]?.[tx];
      if (tile === undefined || !PLANNED_ROAD_SURFACE_SET.has(tile)) return false;
    }
    return true;
  }

  /** Whether the tile under a world position is drivable. */
  private isDrivableAt(tiles: number[][], x: number, y: number): boolean {
    const tx = Math.floor(x / TILE_SIZE);
    const ty = Math.floor(y / TILE_SIZE);
    const tile = tiles[ty]?.[tx];
    return tile !== undefined && DRIVABLE_SET.has(tile);
  }

  /** Whether a tile value belongs to the building family. */
  private isBuildingTile(tile: number): boolean {
    return (
      tile === TileType.Building || tile === TileType.BuildingRes || tile === TileType.BuildingInd
    );
  }

  /** Cheap stable hash → [0, 1) for per-cell jitter. */
}

/** A live streamed terrain chunk with its own render and collision layer. */
interface DecoChunk {
  key: string;
  tx0: number;
  ty0: number;
  tilemap: Phaser.Tilemaps.Tilemap;
  layer: Phaser.Tilemaps.TilemapLayer;
  railCollisionLayer: Phaser.Tilemaps.TilemapLayer | null;
  /** Pedestrian doors stay walkable on the shared layer but remain solid to vehicles. */
  vehicleDoorCollisionLayer: Phaser.Tilemaps.TilemapLayer | null;
  objects: Phaser.GameObjects.GameObject[];
  detailObjects: Phaser.GameObjects.GameObject[];
  enterableRoofs: Map<string, Phaser.GameObjects.Graphics>;
  highway: HighwayChunkHandle | null;
  detailed: boolean;
  regionId: string;
}

interface EnterableRoofHandle {
  roof: Phaser.GameObjects.Graphics;
  chunkKey: string;
}

interface ChunkOperation {
  run(): void;
}

/**
 * The world/service manager. Registered under {@link ServiceKeys.World} and
 * consumed by every gameplay system that needs the map, its collision or its
 * spawn metadata.
 */
export class WorldManager extends BaseSceneManager implements IWorldQuery {
  /** Service-locator key for this manager. */
  public readonly key = ServiceKeys.World;

  /** The generated world, available after {@link onInit}. */
  private mapData: MapData | null = null;
  private majorBuildingRegistry: MajorBuildingRegistry | null = null;

  /** Active streamed terrain/decor chunks, keyed by "cx,cy". */
  private readonly chunks = new Map<string, DecoChunk>();
  private readonly chunkQueue: ChunkOperation[] = [];
  private readonly chunkIndex = new QuadTree<string>({
    x: 0,
    y: 0,
    width: WORLD_WIDTH,
    height: WORLD_HEIGHT,
  });
  private visibilityAnchor = '';
  private highwayGeometry: HighwayGeometryIndex | null = null;
  private highwayRenderer: HighwayRenderSystem | null = null;
  private architectureComposer: ArchitectureComposer | null = null;
  private readonly enterableRoofs = new Map<string, EnterableRoofHandle>();
  private openInteriorRoofId: string | null = null;
  private highwayPrewarmFrame = 0;

  /** Spatial bucket index for nearby road spawn queries. */
  private readonly roadSpawnIndex: SpawnIndex = new Map();

  /** Spatial bucket index for nearby sidewalk + interior walk spawn queries. */
  private readonly walkSpawnIndex: SpawnIndex = new Map();

  /** The chunk the player last occupied, to avoid rebuilding every frame. */
  private lastChunkKey = '';

  /** Shared immutable lane graph; every AI vehicle reads the same network. */

  /** The generated map. Throws if accessed before {@link init}. */
  public get map(): MapData {
    if (!this.mapData) {
      throw new Error('WorldManager.map accessed before init()');
    }
    return this.mapData;
  }

  public get majorBuildings(): MajorBuildingRegistry {
    if (!this.majorBuildingRegistry) {
      throw new Error('WorldManager.majorBuildings accessed before init()');
    }
    return this.majorBuildingRegistry;
  }

  /** The active collision layer, or `null` when no scene is attached. */
  public get collisionLayer(): Phaser.Tilemaps.TilemapLayer | null {
    return this.collisionLayers[0] ?? null;
  }

  /** All terrain collision layers currently resident around the player. */
  public get collisionLayers(): readonly Phaser.Tilemaps.TilemapLayer[] {
    return Array.from(this.chunks.values()).flatMap((chunk) =>
      chunk.railCollisionLayer ? [chunk.layer, chunk.railCollisionLayer] : [chunk.layer],
    );
  }

  /** Extra streamed blockers used only by vehicle bodies at pedestrian-sized doors. */
  public get vehicleOnlyCollisionLayers(): readonly Phaser.Tilemaps.TilemapLayer[] {
    return Array.from(this.chunks.values()).flatMap((chunk) =>
      chunk.vehicleDoorCollisionLayer ? [chunk.vehicleDoorCollisionLayer] : [],
    );
  }

  public get loadedChunkCount(): number {
    return this.chunks.size;
  }

  public get highwayRenderStats(): HighwayRenderStats | null {
    return this.highwayRenderer?.stats ?? null;
  }

  public get loadedRegionCounts(): Readonly<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const chunk of this.chunks.values()) {
      counts[chunk.regionId] = (counts[chunk.regionId] ?? 0) + 1;
    }
    return counts;
  }

  /** Shared lane graph, built once rather than once per streamed traffic car. */

  /** World width in pixels (IWorldQuery). */
  public get widthPx(): number {
    return WORLD_WIDTH;
  }

  /** World height in pixels (IWorldQuery). */
  public get heightPx(): number {
    return WORLD_HEIGHT;
  }

  /** Generate the world once, up front. */
  protected onInit(): void {
    this.mapData = CityGenerator.generate(CITY_SEED);
    this.majorBuildingRegistry = new MajorBuildingRegistry(this.mapData.majorBuildings);
    this.highwayGeometry = HighwayGeometryIndex.build(this.mapData, CHUNK_TILES);
    this.architectureComposer = new ArchitectureComposer(
      this.mapData,
      PERIOD,
      ROAD_W,
      SIDE_W,
      (tx, ty) => this.highwayGeometry?.ownsTile(tx, ty) ?? false,
    );
    this.rebuildSpawnIndexes(this.mapData);
    this.log.debug(
      `world generated: ${this.mapData.widthTiles}x${this.mapData.heightTiles} tiles, ` +
        `${this.mapData.roadNodes.length} road nodes, ` +
        `${this.mapData.urbanPlan.roads.length} planned road segments, ` +
        `${this.mapData.urbanPlan.blocks.length} blocks, ` +
        `${this.mapData.urbanPlan.buildings.length} buildings, ` +
        `${this.mapData.buildingEntrances.length} entrances, ` +
        `${this.mapData.benches.length} benches, ` +
        `${this.mapData.busStops.length} bus stops, ` +
        `${this.mapData.crossings.length} crossings`,
    );
  }

  /** Build the tilemap, collision and fixed markers for the attached scene. */
  protected onAttach(_scene: Phaser.Scene): void {
    const map = this.map;
    if (!this.highwayGeometry) {
      throw new Error('highway geometry index missing after world initialization');
    }
    this.highwayRenderer = new HighwayRenderSystem(_scene, this.highwayGeometry);
    this.lastChunkKey = '';
    const chunkX = Math.floor(map.playerStart.x / (CHUNK_TILES * TILE_SIZE));
    const chunkY = Math.floor(map.playerStart.y / (CHUNK_TILES * TILE_SIZE));
    this.streamChunks(chunkX, chunkY, true);
    this.updateChunkVisibility(true);
    this.bus.emit(EventKeys.WorldReady);
  }

  /** Release scene-scoped tilemap, layer, markers and chunks on detach. */
  protected override onDetach(_scene: Phaser.Scene): void {
    for (const chunk of this.chunks.values()) {
      this.destroyChunk(chunk);
    }
    this.chunks.clear();
    this.enterableRoofs.clear();
    this.openInteriorRoofId = null;
    this.highwayRenderer?.destroy();
    this.highwayRenderer = null;
    this.chunkQueue.length = 0;
    this.chunkIndex.clear();
    this.visibilityAnchor = '';
    this.lastChunkKey = '';
    this.highwayPrewarmFrame = 0;
  }

  /** Stream decoration chunks around the player each frame. */
  public update(_time: number, _delta: number): void {
    if (!this.scene || !this.mapData) return;
    const player = getPlayerRef()?.playerPosition;
    if (!player) return;

    const cx = Math.floor(player.x / (CHUNK_TILES * TILE_SIZE));
    const cy = Math.floor(player.y / (CHUNK_TILES * TILE_SIZE));
    const key = `${cx},${cy}`;
    if (key !== this.lastChunkKey) {
      this.lastChunkKey = key;
      this.streamChunks(cx, cy);
    }
    this.processChunkQueue();
    this.updateChunkVisibility();
    this.highwayPrewarmFrame++;
    if (this.chunkQueue.length === 0 && this.highwayPrewarmFrame % 4 === 0) {
      this.prewarmHighwayDetail();
    }
  }

  /** Open only the exterior roof that owns the active in-world interior. */
  public setInteriorRoofOpen(interiorId: string | null): void {
    if (interiorId === this.openInteriorRoofId) return;
    this.openInteriorRoofId = interiorId;
    this.visibilityAnchor = '';
    this.updateChunkVisibility(true);
  }

  // ── IWorldQuery ─────────────────────────────────────────────────────────────

  /** Whether the given world position falls inside a solid tile. */
  public isSolidAtWorld(x: number, y: number): boolean {
    const tile = this.tileAtWorld(x, y);
    if (tile === undefined) return true;
    return SOLID_SET.has(tile);
  }

  /** Whether a complete pedestrian circle fits against the finalized solid raster. */
  public isPedestrianClearAtWorld(x: number, y: number, radius: number): boolean {
    const grid = this.finalizedSolidGrid();
    return grid !== null && isCircleClearOnGrid(grid, { x, y }, radius);
  }

  /** Whether a swept pedestrian circle stays clear against the finalized solid raster. */
  public isPedestrianSegmentClear(from: Vector2, to: Vector2, radius: number): boolean {
    const grid = this.finalizedSolidGrid();
    return grid !== null && isCircleSegmentClearOnGrid(grid, from, to, radius);
  }

  /** Preserve a clear point or deterministically relocate it on the finalized solid raster. */
  public resolveSafePedestrianPosition(
    requested: Vector2,
    radius: number,
    options: SafePedestrianPlacementOptions = {},
  ): Vector2 | null {
    const grid = this.finalizedSolidGrid();
    return grid ? resolveCirclePositionOnGrid(grid, requested, radius, options) : null;
  }

  /** Adapt the immutable generated tile grid to the pure circle-placement algorithms. */
  private finalizedSolidGrid(): SolidTileGrid | null {
    const map = this.mapData;
    if (!map) return null;
    return {
      tileSize: map.tileSize,
      widthTiles: map.widthTiles,
      heightTiles: map.heightTiles,
      isSolidTile: (tx, ty) => {
        const tile = map.tiles[ty]?.[tx];
        return tile === undefined || SOLID_SET.has(tile);
      },
    };
  }

  /** Whether a witness or combatant's view is occluded at this position. */
  public blocksVisionAtWorld(x: number, y: number): boolean {
    const tile = this.tileAtWorld(x, y);
    if (tile === undefined) return true;
    return VISION_BLOCKING_SET.has(tile);
  }

  /** Whether a world position lies on a drivable tile. */
  public isDrivableAtWorld(x: number, y: number): boolean {
    const tile = this.tileAtWorld(x, y);
    return tile !== undefined && DRIVABLE_SET.has(tile);
  }

  /** A random world position on a sidewalk. */
  public randomSidewalkPoint(): Vector2 {
    const map = this.mapData;
    if (!map || map.sidewalkSpawns.length === 0) {
      return { x: WORLD_WIDTH / 2, y: WORLD_HEIGHT / 2 };
    }
    const point = random.pick(map.sidewalkSpawns);
    return point ? { x: point.x, y: point.y } : { x: WORLD_WIDTH / 2, y: WORLD_HEIGHT / 2 };
  }

  /** A random world position on a road. */
  public randomRoadPoint(): Vector2 {
    const map = this.mapData;
    if (!map || map.roadSpawns.length === 0) {
      const fx = map ? map.playerStart.x : WORLD_WIDTH / 2;
      const fy = map ? map.playerStart.y : WORLD_HEIGHT / 2;
      return { x: fx, y: fy };
    }
    const point = random.pick(map.roadSpawns);
    return point ? { x: point.x, y: point.y } : { x: map.playerStart.x, y: map.playerStart.y };
  }

  /** A random road point within `maxDist` px of `(x, y)`, or null. */
  public randomRoadPointNear(x: number, y: number, maxDist: number): Vector2 | null {
    const map = this.mapData;
    if (!map) return null;
    return this.randomIndexedPointNear(this.roadSpawnIndex, x, y, maxDist);
  }

  /** Whether a pedestrian may occupy this world position. */
  public isPedestrianWalkableAtWorld(x: number, y: number): boolean {
    const tile = this.tileAtWorld(x, y);
    if (tile === undefined) return false;
    return !PEDESTRIAN_BLOCKED_SET.has(tile);
  }

  /** Relative pathing cost for a pedestrian crossing this tile. */
  public pedestrianTileCost(x: number, y: number): number {
    const tile = this.tileAtWorld(x, y);
    if (tile === undefined) return Infinity;
    switch (tile) {
      case TileType.Sidewalk:
      case TileType.Crossing:
      case TileType.Concrete:
      case TileType.Dock:
      case TileType.InteriorFloor:
      case TileType.InteriorFixture:
      case TileType.InteriorDoor:
        return 1;
      default:
        // Crossable (grass/sand/dirt/…) but sidewalks are preferred when available.
        return 1.6;
    }
  }

  /** A random sidewalk point within `maxDist` px of `(x, y)`, or null if none is found nearby. */
  public randomSidewalkPointNear(x: number, y: number, maxDist: number): Vector2 | null {
    const map = this.mapData;
    if (!map) return null;
    return this.randomIndexedPointNear(this.walkSpawnIndex, x, y, maxDist);
  }

  /** The nearest road crossing within `maxDist` px of `(x, y)`, or null. */
  public nearestCrossing(x: number, y: number, maxDist: number): CrossingInfo | null {
    const map = this.mapData;
    if (!map) return null;
    let best: CrossingInfo | null = null;
    let bestSq = maxDist * maxDist;
    for (const crossing of map.crossings) {
      const dx = crossing.x - x;
      const dy = crossing.y - y;
      const distSq = dx * dx + dy * dy;
      if (distSq <= bestSq) {
        best = crossing;
        bestSq = distSq;
      }
    }
    return best;
  }

  /** The nearest unoccupied bench within `maxDist` px of `(x, y)`, or null. */
  public nearestFreeBench(x: number, y: number, maxDist: number): BenchSite | null {
    const map = this.mapData;
    if (!map) return null;
    let best: BenchSite | null = null;
    let bestSq = maxDist * maxDist;
    for (const bench of map.benches) {
      if (bench.occupiedBy !== null) continue;
      const dx = bench.x - x;
      const dy = bench.y - y;
      const distSq = dx * dx + dy * dy;
      if (distSq <= bestSq) {
        best = bench;
        bestSq = distSq;
      }
    }
    return best;
  }

  /** Claim `bench` for `entityId`. Returns false if it's already occupied by someone else. */
  public claimBench(bench: BenchSite, entityId: number): boolean {
    if (bench.occupiedBy !== null && bench.occupiedBy !== entityId) return false;
    bench.occupiedBy = entityId;
    return true;
  }

  /** Release `bench` if it's currently held by `entityId` (no-op otherwise). */
  public releaseBench(bench: BenchSite, entityId: number): void {
    if (bench.occupiedBy === entityId) {
      bench.occupiedBy = null;
    }
  }

  /** The nearest unoccupied bus stop within `maxDist` px of `(x, y)`, or null. */
  public nearestFreeBusStop(x: number, y: number, maxDist: number): BusStopSite | null {
    const map = this.mapData;
    if (!map) return null;
    let best: BusStopSite | null = null;
    let bestSq = maxDist * maxDist;
    for (const stop of map.busStops) {
      if (stop.occupiedBy !== null) continue;
      const dx = stop.x - x;
      const dy = stop.y - y;
      const distSq = dx * dx + dy * dy;
      if (distSq <= bestSq) {
        best = stop;
        bestSq = distSq;
      }
    }
    return best;
  }

  /** Claim `busStop` for `entityId`. Returns false if it's already occupied by someone else. */
  public claimBusStop(busStop: BusStopSite, entityId: number): boolean {
    if (busStop.occupiedBy !== null && busStop.occupiedBy !== entityId) return false;
    busStop.occupiedBy = entityId;
    return true;
  }

  /** Release `busStop` if it's currently held by `entityId` (no-op otherwise). */
  public releaseBusStop(busStop: BusStopSite, entityId: number): void {
    if (busStop.occupiedBy === entityId) {
      busStop.occupiedBy = null;
    }
  }

  // ── Public queries ──────────────────────────────────────────────────────────

  /** Convert a world position to integer tile coordinates. */
  public worldToTile(x: number, y: number): { tx: number; ty: number } {
    return { tx: Math.floor(x / TILE_SIZE), ty: Math.floor(y / TILE_SIZE) };
  }

  /** The district covering a world position (Residential fallback). */
  public districtAt(x: number, y: number): District {
    const map = this.mapData;
    if (!map) return District.Residential;
    const bi = Math.floor(Math.floor(x / TILE_SIZE) / PERIOD);
    const bj = Math.floor(Math.floor(y / TILE_SIZE) / PERIOD);
    return map.districts[bj]?.[bi] ?? District.Residential;
  }

  /** City containing a point, or null while the player is on an intercity road. */
  public cityAt(x: number, y: number): WorldCity | null {
    for (const city of this.map.cities) {
      const b = city.bounds;
      if (x >= b.x && y >= b.y && x < b.x + b.width && y < b.y + b.height) return city;
    }
    return null;
  }

  /** Population multiplier for the local city or the intentionally quieter countryside. */
  public pedestrianDensityAt(x: number, y: number): number {
    return this.cityAt(x, y)?.pedestrianDensity ?? 0.28;
  }

  /** Traffic multiplier for the local city or open intercity roads. */
  public trafficDensityAt(x: number, y: number): number {
    return this.cityAt(x, y)?.trafficDensity ?? 0.36;
  }

  /** Regional climate target used by the smooth weather transition director. */
  public weatherAt(x: number, y: number): WorldCity['weather'] {
    const city = this.cityAt(x, y);
    if (city) return city.weather;
    const district = this.districtAt(x, y);
    return district === District.Forest || district === District.Mountains ? 'fog' : 'clear';
  }

  /** The hospital nearest to a world position (for respawns). */
  public nearestHospital(x: number, y: number): Vector2 {
    const building = this.majorBuildings.nearest('hospital', { x, y });
    return building ? { ...building.entrancePosition } : this.nearestOf(this.map.hospitals, x, y);
  }

  /** The police station nearest to a world position. */
  public nearestPoliceStation(x: number, y: number): Vector2 {
    const building = this.majorBuildings.nearest('police-station', { x, y });
    return building
      ? { ...building.entrancePosition }
      : this.nearestOf(this.map.policeStations, x, y);
  }

  /** Dispatch pose for the hospital nearest to an incident. */
  public nearestHospitalParking(x: number, y: number): Vector2 {
    const building = this.majorBuildings.nearest('hospital', { x, y });
    return building ? { ...building.parkingArea.position } : this.nearestHospital(x, y);
  }

  /** Dispatch pose for the police station nearest to an incident. */
  public nearestPoliceParking(x: number, y: number): Vector2 {
    const building = this.majorBuildings.nearest('police-station', { x, y });
    return building ? { ...building.parkingArea.position } : this.nearestPoliceStation(x, y);
  }

  /** The fire station nearest to a world position. */
  public nearestFireStation(x: number, y: number): Vector2 {
    return this.nearestOf(this.map.fireStations, x, y);
  }

  /** The gas station nearest to a world position. */
  public nearestGasStation(x: number, y: number): Vector2 {
    return this.nearestOf(this.map.gasStations, x, y);
  }

  /** The garage nearest to a world position. */
  public nearestGarage(x: number, y: number): Vector2 {
    return this.nearestOf(this.map.garages, x, y);
  }

  /** The safe house nearest to a world position. */
  public nearestSafeHouse(x: number, y: number): Vector2 {
    return this.nearestOf(this.map.safeHouses, x, y);
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /** Nearest point in `points` to `(x, y)`, or `(x, y)` itself when empty. */
  private nearestOf(points: readonly Vector2[], x: number, y: number): Vector2 {
    let best: Vector2 | null = null;
    let bestDist = Infinity;
    for (const point of points) {
      const dx = point.x - x;
      const dy = point.y - y;
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) {
        bestDist = dist;
        best = point;
      }
    }
    return best ? { x: best.x, y: best.y } : { x, y };
  }

  /** Build reusable spatial buckets for high-frequency nearby spawn lookups. */
  private rebuildSpawnIndexes(map: MapData): void {
    this.roadSpawnIndex.clear();
    this.walkSpawnIndex.clear();
    this.indexSpawnPoints(this.roadSpawnIndex, map.roadSpawns);
    this.indexSpawnPoints(this.walkSpawnIndex, map.sidewalkSpawns);
    // Interior NPCs are seeded explicitly by WorldInteriorSystem. Keeping their
    // points out of the ambient sidewalk index prevents pedestrians, wildlife
    // and patrols from spawning inside closed buildings.
  }

  private indexSpawnPoints(index: SpawnIndex, points: readonly Vector2[]): void {
    for (const point of points) {
      const key = this.spawnCellKey(point.x, point.y);
      const bucket = index.get(key);
      if (bucket) {
        bucket.push(point);
      } else {
        index.set(key, [point]);
      }
    }
  }

  private randomIndexedPointNear(
    index: SpawnIndex,
    x: number,
    y: number,
    maxDist: number,
  ): Vector2 | null {
    const maxSq = maxDist * maxDist;
    const minCx = Math.floor((x - maxDist) / SPAWN_QUERY_CELL_PX);
    const maxCx = Math.floor((x + maxDist) / SPAWN_QUERY_CELL_PX);
    const minCy = Math.floor((y - maxDist) / SPAWN_QUERY_CELL_PX);
    const maxCy = Math.floor((y + maxDist) / SPAWN_QUERY_CELL_PX);
    const candidates: Vector2[] = [];

    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const bucket = index.get(`${cx},${cy}`);
        if (!bucket) continue;
        for (const point of bucket) {
          const dx = point.x - x;
          const dy = point.y - y;
          if (dx * dx + dy * dy <= maxSq) candidates.push(point);
        }
      }
    }

    const pick = random.pick(candidates);
    return pick ? { x: pick.x, y: pick.y } : null;
  }

  private spawnCellKey(x: number, y: number): string {
    return `${Math.floor(x / SPAWN_QUERY_CELL_PX)},${Math.floor(y / SPAWN_QUERY_CELL_PX)}`;
  }

  /** Read the tile value under a world position, guarding bounds. */
  private tileAtWorld(x: number, y: number): number | undefined {
    const map = this.mapData;
    if (!map) return undefined;
    const tx = Math.floor(x / TILE_SIZE);
    const ty = Math.floor(y / TILE_SIZE);
    if (tx < 0 || ty < 0 || tx >= map.widthTiles || ty >= map.heightTiles) return undefined;
    return map.tiles[ty]?.[tx];
  }

  /** Add only the service and transit fixtures inside one active world chunk. */
  private placeChunkMarkers(
    scene: Phaser.Scene,
    tx0: number,
    ty0: number,
    out: Phaser.GameObjects.GameObject[],
  ): void {
    const map = this.map;
    this.placeMajorBuildingSigns(scene, tx0, ty0, out);
    this.markerSet(scene, map.fireStations, 0xc0281e, 'F', tx0, ty0, out);
    this.markerSet(scene, map.gasStations, 0x53d769, 'G', tx0, ty0, out);
    this.markerSet(scene, map.gunShops, 0xffcc33, '$', tx0, ty0, out);
    this.markerSet(scene, map.garages, 0x8b5cf6, 'R', tx0, ty0, out);
    this.markerSet(scene, map.safeHouses, 0x14b8a6, 'S', tx0, ty0, out);
    this.placeBenches(scene, map.benches, tx0, ty0, out);
    this.placeBusStops(scene, map.busStops, tx0, ty0, out);
    this.placeLandmarkLabels(scene, tx0, ty0, out);
  }

  /** Stream recognizable entrance-scale service signage from the shared registry. */
  private placeMajorBuildingSigns(
    scene: Phaser.Scene,
    tx0: number,
    ty0: number,
    out: Phaser.GameObjects.GameObject[],
  ): void {
    for (const building of this.majorBuildings.all()) {
      const point = building.entrancePosition;
      if (!this.pointInChunk(point, tx0, ty0)) continue;
      const police = building.type === 'police-station';
      const g = scene.add.graphics();
      g.setDepth(DepthLayers.BuildingsHigh + 2);
      const x = Math.round(point.x);
      const y = Math.round(point.y - 22);
      const panel = police ? 0x214f76 : 0xf1eee6;
      const accent = police ? 0x6eb2d5 : 0xb8323b;
      g.fillStyle(0x121a20, 0.42);
      g.fillRect(x - 24, y + 4, 52, 14);
      g.fillStyle(0x1b252b, 1);
      g.fillRect(x - 27, y - 2, 54, 15);
      g.fillStyle(panel, 1);
      g.fillRect(x - 25, y, 50, 11);
      g.fillStyle(accent, 1);
      if (police) {
        g.fillRect(x - 22, y + 2, 8, 2);
        g.fillRect(x - 20, y, 4, 7);
        g.fillRect(x + 15, y + 2, 8, 2);
        g.fillRect(x + 17, y, 4, 7);
      } else {
        g.fillRect(x - 21, y + 4, 10, 3);
        g.fillRect(x - 18, y + 1, 3, 9);
        g.fillRect(x + 12, y + 4, 10, 3);
        g.fillRect(x + 15, y + 1, 3, 9);
      }
      g.fillStyle(0x29333a, 1);
      g.fillRect(x - 22, y + 11, 3, 10);
      g.fillRect(x + 19, y + 11, 3, 10);
      out.push(g);

      const label = scene.add.text(x, y + 5, police ? 'POLICE' : 'HOSPITAL', {
        fontFamily: 'Courier New',
        fontSize: police ? '8px' : '7px',
        fontStyle: 'bold',
        color: police ? '#ffffff' : '#8f222c',
      });
      label.setOrigin(0.5);
      label.setResolution(2);
      label.setDepth(DepthLayers.BuildingsHigh + 3);
      out.push(label);
    }
  }

  /** Draw a tinted marker rectangle + glyph at each service location. */
  private markerSet(
    scene: Phaser.Scene,
    points: readonly Vector2[],
    color: number,
    glyph: string,
    tx0: number,
    ty0: number,
    out: Phaser.GameObjects.GameObject[],
  ): void {
    for (const point of points) {
      if (!this.pointInChunk(point, tx0, ty0)) continue;
      const rect = scene.add.rectangle(point.x, point.y - 18, 30, 12, color, 0.9);
      rect.setStrokeStyle(1, 0xffffff, 0.65);
      rect.setDepth(DepthLayers.GroundDetail);
      out.push(rect);

      const label = scene.add.text(point.x, point.y - 18, glyph, {
        fontFamily: 'Courier New',
        fontSize: '11px',
        color: '#ffffff',
      });
      label.setOrigin(0.5);
      label.setDepth(DepthLayers.GroundDetail + 1);
      out.push(label);
    }
  }

  // ── Decoration streaming ─────────────────────────────────────────────────────

  /** Render the exact benches used by pedestrian sitting behaviour. */
  private placeBenches(
    scene: Phaser.Scene,
    benches: readonly BenchSite[],
    tx0: number,
    ty0: number,
    out: Phaser.GameObjects.GameObject[],
  ): void {
    for (const site of benches) {
      if (!this.pointInChunk(site, tx0, ty0)) continue;
      const bench = scene.add.image(site.x, site.y, TextureKeys.Bench);
      bench.setRotation(site.facing);
      bench.setDepth(DepthLayers.GroundDetail + 4);
      out.push(bench);
    }
  }

  /** Draw persistent bus-stop fixtures at generated transit waiting points. */
  private placeBusStops(
    scene: Phaser.Scene,
    stops: readonly BusStopSite[],
    tx0: number,
    ty0: number,
    out: Phaser.GameObjects.GameObject[],
  ): void {
    for (const stop of stops) {
      if (!this.pointInChunk(stop, tx0, ty0)) continue;
      const shelter = scene.add.rectangle(stop.x, stop.y - 4, 22, 16, 0x2b5b8a, 0.82);
      shelter.setStrokeStyle(1, 0xd8dde7, 0.62);
      shelter.setDepth(DepthLayers.GroundDetail);

      const pole = scene.add.rectangle(stop.x - 12, stop.y + 7, 2, 18, 0x222831, 1);
      pole.setDepth(DepthLayers.GroundDetail);

      const sign = scene.add.text(stop.x, stop.y - 5, 'BUS', {
        fontFamily: 'Courier New',
        fontSize: '7px',
        color: '#ffffff',
      });
      sign.setOrigin(0.5);
      sign.setDepth(DepthLayers.GroundDetail + 1);
      out.push(shelter, pole, sign);
    }
  }

  private placeLandmarkLabels(
    scene: Phaser.Scene,
    tx0: number,
    ty0: number,
    out: Phaser.GameObjects.GameObject[],
  ): void {
    for (const landmark of this.map.landmarks) {
      if (!this.pointInChunk(landmark.position, tx0, ty0)) continue;
      const label = scene.add.text(landmark.position.x, landmark.position.y - 22, landmark.name, {
        fontFamily: 'Courier New',
        fontSize: '8px',
        color: '#f7f3df',
        backgroundColor: '#11131d',
        padding: { x: 3, y: 1 },
      });
      label.setOrigin(0.5);
      label.setDepth(DepthLayers.GroundDetail + 2);
      out.push(label);
    }
  }

  private pointInChunk(point: Vector2, tx0: number, ty0: number): boolean {
    const tx = Math.floor(point.x / TILE_SIZE);
    const ty = Math.floor(point.y / TILE_SIZE);
    return tx >= tx0 && ty >= ty0 && tx < tx0 + CHUNK_TILES && ty < ty0 + CHUNK_TILES;
  }

  private isDetailedChunk(key: string, pcx: number, pcy: number): boolean {
    const [cxText, cyText] = key.split(',');
    const cx = Number(cxText);
    const cy = Number(cyText);
    return Math.abs(cx - pcx) <= DETAIL_CHUNK_RADIUS && Math.abs(cy - pcy) <= DETAIL_CHUNK_RADIUS;
  }

  private destroyChunk(chunk: DecoChunk): void {
    this.highwayRenderer?.releaseChunk(chunk.highway);
    for (const [interiorId, roof] of chunk.enterableRoofs) {
      if (this.enterableRoofs.get(interiorId)?.roof === roof) {
        this.enterableRoofs.delete(interiorId);
      }
    }
    for (const object of chunk.detailObjects) object.destroy();
    for (const object of chunk.objects) object.destroy();
    chunk.vehicleDoorCollisionLayer?.destroy();
    chunk.railCollisionLayer?.destroy();
    chunk.layer.destroy();
    chunk.tilemap.destroy();
  }

  /** Rebuild the active chunk set centred on the player's chunk. */
  private streamChunks(pcx: number, pcy: number, immediate = false): void {
    const wanted = new Set<string>();
    for (let dy = -CHUNK_RADIUS; dy <= CHUNK_RADIUS; dy++) {
      for (let dx = -CHUNK_RADIUS; dx <= CHUNK_RADIUS; dx++) {
        wanted.add(`${pcx + dx},${pcy + dy}`);
      }
    }

    const maxChunkX = Math.ceil(this.map.widthTiles / CHUNK_TILES);
    const maxChunkY = Math.ceil(this.map.heightTiles / CHUNK_TILES);
    for (const key of Array.from(wanted)) {
      const [cxText, cyText] = key.split(',');
      const cx = Number(cxText);
      const cy = Number(cyText);
      if (cx < 0 || cy < 0 || cx >= maxChunkX || cy >= maxChunkY) wanted.delete(key);
    }

    const operations: ChunkOperation[] = [];

    // Despawn chunks that fell out of range and refresh their detail LOD when
    // they move from the outer terrain ring into the close-prop ring.
    for (const [key, chunk] of this.chunks) {
      if (!wanted.has(key)) {
        operations.push({
          run: () => {
            const current = this.chunks.get(key);
            if (!current) return;
            this.destroyChunk(current);
            this.chunks.delete(key);
          },
        });
      } else if (chunk.detailed !== this.isDetailedChunk(key, pcx, pcy)) {
        const detailed = this.isDetailedChunk(key, pcx, pcy);
        operations.push({
          run: () => {
            const current = this.chunks.get(key);
            if (current) this.setChunkDetail(current, detailed);
          },
        });
      }
    }

    // Spawn newly in-range chunks.
    const newKeys = Array.from(wanted)
      .filter((key) => !this.chunks.has(key))
      .sort((first, second) => {
        const [firstX, firstY] = first.split(',').map(Number);
        const [secondX, secondY] = second.split(',').map(Number);
        return (
          Math.hypot((firstX ?? pcx) - pcx, (firstY ?? pcy) - pcy) -
          Math.hypot((secondX ?? pcx) - pcx, (secondY ?? pcy) - pcy)
        );
      });
    for (const key of newKeys) {
      if (!this.chunks.has(key)) {
        const detailed = this.isDetailedChunk(key, pcx, pcy);
        operations.push({
          run: () => {
            if (!this.chunks.has(key)) this.chunks.set(key, this.buildChunk(key, detailed));
          },
        });
      }
    }
    this.chunkQueue.length = 0;
    this.chunkQueue.push(...operations);
    if (immediate) {
      while (this.chunkQueue.length > 0) this.chunkQueue.shift()?.run();
      if (operations.length > 0) this.finishChunkBatch();
    }
  }

  private processChunkQueue(): void {
    if (this.chunkQueue.length === 0) return;
    const startedAt = performance.now();
    let processed = 0;
    while (
      processed < MAX_CHUNK_OPERATIONS_PER_FRAME &&
      this.chunkQueue.length > 0 &&
      (processed === 0 || performance.now() - startedAt < CHUNK_BUILD_BUDGET_MS)
    ) {
      this.chunkQueue.shift()?.run();
      processed += 1;
    }
    if (processed > 0) this.finishChunkBatch();
  }

  private finishChunkBatch(): void {
    this.rebuildChunkIndex();
    this.visibilityAnchor = '';
    this.bus.emit(EventKeys.WorldStreamChanged);
  }

  private prewarmHighwayDetail(): void {
    if (!this.highwayRenderer) return;
    for (const chunk of this.chunks.values()) {
      if (!chunk.detailed && this.highwayRenderer.prewarmChunk(chunk.key, 'near')) return;
    }
  }

  private rebuildChunkIndex(): void {
    this.chunkIndex.clear();
    const size = CHUNK_TILES * TILE_SIZE;
    for (const key of this.chunks.keys()) {
      const [cxText, cyText] = key.split(',');
      this.chunkIndex.insert(
        { x: Number(cxText) * size, y: Number(cyText) * size, width: size, height: size },
        key,
      );
    }
  }

  private updateChunkVisibility(force = false): void {
    const view = this.scene?.cameras.main.worldView;
    if (!view) return;
    const anchor = `${Math.floor(view.centerX / CHUNK_VISIBILITY_CELL)},${Math.floor(view.centerY / CHUNK_VISIBILITY_CELL)}`;
    if (!force && anchor === this.visibilityAnchor) return;
    this.visibilityAnchor = anchor;
    const visible = new Set<string>();
    this.chunkIndex.query(
      {
        x: view.x - CHUNK_CULL_MARGIN,
        y: view.y - CHUNK_CULL_MARGIN,
        width: view.width + CHUNK_CULL_MARGIN * 2,
        height: view.height + CHUNK_CULL_MARGIN * 2,
      },
      (key) => visible.add(key),
    );
    const openRoof = this.openInteriorRoofId
      ? this.enterableRoofs.get(this.openInteriorRoofId)?.roof
      : undefined;
    for (const [key, chunk] of this.chunks) {
      const show = visible.has(key);
      chunk.layer.setVisible(show);
      for (const object of chunk.objects) {
        (
          object as Phaser.GameObjects.GameObject & { setVisible?: (value: boolean) => unknown }
        ).setVisible?.(show && object !== openRoof);
      }
      for (const object of chunk.detailObjects) {
        (
          object as Phaser.GameObjects.GameObject & { setVisible?: (value: boolean) => unknown }
        ).setVisible?.(show);
      }
      this.highwayRenderer?.setVisible(chunk.highway, show);
    }
  }

  /** Build one terrain chunk plus its close-range decoration LOD. */
  private buildChunk(key: string, detailed: boolean): DecoChunk {
    const objects: Phaser.GameObjects.GameObject[] = [];
    const detailObjects: Phaser.GameObjects.GameObject[] = [];
    const enterableRoofs = new Map<string, Phaser.GameObjects.Graphics>();
    const scene = this.scene;
    const map = this.mapData;
    if (!scene || !map) throw new Error('world chunk requested without an attached scene');

    const parts = key.split(',');
    const cx = Number(parts[0]);
    const cy = Number(parts[1]);
    const tx0 = cx * CHUNK_TILES;
    const ty0 = cy * CHUNK_TILES;
    const data: number[][] = [];

    for (let localY = 0; localY < CHUNK_TILES; localY++) {
      const source = map.tiles[ty0 + localY];
      const row: number[] = [];
      for (let localX = 0; localX < CHUNK_TILES; localX++) {
        const tx = tx0 + localX;
        const ty = ty0 + localY;
        const sourceTile = source?.[tx] ?? TileType.Grass;
        const reserved = this.highwayGeometry?.ownsTile(tx, ty) ?? false;
        row.push(
          reserved && sourceTile !== TileType.Water ? this.highwayUnderlayTile(tx, ty) : sourceTile,
        );
      }
      data.push(row);
    }

    const tilemap = scene.make.tilemap({
      data,
      tileWidth: TILE_SIZE,
      tileHeight: TILE_SIZE,
    });
    const tileset = tilemap.addTilesetImage('city', TextureKeys.CityTileset, TILE_SIZE, TILE_SIZE);
    if (!tileset) throw new Error('CityTileset texture missing');
    const layer = tilemap.createLayer(0, tileset, tx0 * TILE_SIZE, ty0 * TILE_SIZE);
    if (!layer) throw new Error('failed to create streamed world chunk');
    layer.setDepth(DepthLayers.Ground);
    layer.setCollision([...SOLID_TILE_TYPES]);
    layer.setCullPadding(1, 1);
    this.applyDistrictArtTint(layer, tx0, ty0);

    const highwayLod: HighwayRenderLod = detailed ? 'near' : 'medium';
    const highway = this.highwayRenderer?.acquireChunk(key, highwayLod) ?? null;
    const highwayChunk = this.highwayGeometry?.getChunk(key) ?? null;
    let railCollisionLayer: Phaser.Tilemaps.TilemapLayer | null = null;
    if (highwayChunk && highwayChunk.railCollisionTiles.length > 0) {
      railCollisionLayer = tilemap.createBlankLayer(
        `highway-rail:${key}`,
        tileset,
        tx0 * TILE_SIZE,
        ty0 * TILE_SIZE,
      );
      if (!railCollisionLayer) throw new Error(`failed to create guard-rail collision for ${key}`);
      for (const localIndex of highwayChunk.railCollisionTiles) {
        const localX = localIndex % CHUNK_TILES;
        const localY = Math.floor(localIndex / CHUNK_TILES);
        tilemap.putTileAt(TileType.Rock, localX, localY, false, railCollisionLayer);
      }
      railCollisionLayer.setVisible(false);
      railCollisionLayer.setCollision([TileType.Rock]);
    }

    let vehicleDoorCollisionLayer: Phaser.Tilemaps.TilemapLayer | null = null;
    const vehicleDoorCells: Array<{ x: number; y: number }> = [];
    for (let localY = 0; localY < data.length; localY++) {
      const row = data[localY];
      if (!row) continue;
      for (let localX = 0; localX < row.length; localX++) {
        if (row[localX] === TileType.InteriorDoor) vehicleDoorCells.push({ x: localX, y: localY });
      }
    }
    if (vehicleDoorCells.length > 0) {
      vehicleDoorCollisionLayer = tilemap.createBlankLayer(
        `vehicle-door:${key}`,
        tileset,
        tx0 * TILE_SIZE,
        ty0 * TILE_SIZE,
      );
      if (!vehicleDoorCollisionLayer) {
        throw new Error(`failed to create vehicle door collision for ${key}`);
      }
      for (const cell of vehicleDoorCells) {
        tilemap.putTileAt(TileType.InteriorDoor, cell.x, cell.y, false, vehicleDoorCollisionLayer);
      }
      vehicleDoorCollisionLayer.setVisible(false);
      vehicleDoorCollisionLayer.setCollision([...VEHICLE_ONLY_SOLID_TILE_TYPES]);
    }

    // Architecture is lot-scale and is painted for every resident chunk. Rich
    // props remain limited to the detailed chunk, preserving streaming cost.
    const architecture = this.architectureComposer?.paintChunk(
      scene,
      tx0,
      ty0,
      CHUNK_TILES,
      CHUNK_TILES,
    );
    if (architecture) {
      objects.push(...architecture.objects);
      for (const [interiorId, roof] of architecture.enterableRoofs) {
        enterableRoofs.set(interiorId, roof);
        this.enterableRoofs.set(interiorId, { roof, chunkKey: key });
      }
    }

    if (detailed) {
      for (let ty = ty0; ty < ty0 + CHUNK_TILES; ty++) {
        const row = map.tiles[ty];
        if (!row) continue;
        for (let tx = tx0; tx < tx0 + CHUNK_TILES; tx++) {
          const tile = row[tx];
          if (tile === undefined) continue;
          this.decorateTile(scene, tx, ty, tile, detailObjects);
        }
      }
    }
    this.placeChunkMarkers(scene, tx0, ty0, objects);
    return {
      key,
      tx0,
      ty0,
      tilemap,
      layer,
      railCollisionLayer,
      vehicleDoorCollisionLayer,
      objects,
      detailObjects,
      enterableRoofs,
      highway,
      detailed,
      regionId: this.streamRegionAt(tx0, ty0),
    };
  }

  /** Change rich-decoration/highway LOD without rebuilding terrain or architecture. */
  private setChunkDetail(chunk: DecoChunk, detailed: boolean): void {
    if (chunk.detailed === detailed || !this.scene || !this.mapData) return;
    for (const object of chunk.detailObjects) object.destroy();
    chunk.detailObjects.length = 0;
    this.highwayRenderer?.releaseChunk(chunk.highway);
    chunk.highway =
      this.highwayRenderer?.acquireChunk(chunk.key, detailed ? 'near' : 'medium') ?? null;
    chunk.detailed = detailed;
    if (!detailed) return;
    for (let ty = chunk.ty0; ty < chunk.ty0 + CHUNK_TILES; ty++) {
      const row = this.mapData.tiles[ty];
      if (!row) continue;
      for (let tx = chunk.tx0; tx < chunk.tx0 + CHUNK_TILES; tx++) {
        const tile = row[tx];
        if (tile !== undefined) this.decorateTile(this.scene, tx, ty, tile, chunk.detailObjects);
      }
    }
  }

  /**
   * Give the shared collision tiles a regional colour script. Tile tint is a
   * render-only property, so Tehran, Yazd and Gilan can feel different without
   * duplicating map data or changing any navigation classification.
   */
  private applyDistrictArtTint(
    layer: Phaser.Tilemaps.TilemapLayer,
    tx0: number,
    ty0: number,
  ): void {
    layer.forEachTile((tile) => {
      const tx = tx0 + tile.x;
      const ty = ty0 + tile.y;
      const x = tx * TILE_SIZE + TILE_SIZE / 2;
      const y = ty * TILE_SIZE + TILE_SIZE / 2;
      const city = this.cityAt(x, y)?.id;
      const district = this.districtAt(x, y);
      const variant = this.tileHash(tx + 41, ty - 17);
      tile.tint = this.surfaceTint(tile.index, city, district, variant);
    });
  }

  private highwayUnderlayTile(tx: number, ty: number): TileType {
    const x = tx * TILE_SIZE + TILE_SIZE / 2;
    const y = ty * TILE_SIZE + TILE_SIZE / 2;
    const district = this.districtAt(x, y);
    if (this.cityAt(x, y)?.id === 'yazd' || district === District.Desert) return TileType.Sand;
    return TileType.Grass;
  }

  private surfaceTint(
    tile: number,
    city: CityId | undefined,
    district: District,
    variant: number,
  ): number {
    if (tile === TileType.Water) return variant < 0.5 ? 0xd0edf0 : 0xc3e3e8;
    if (tile === TileType.Grass) {
      if (city === 'gilan' || district === District.Forest || district === District.TeaFarm) {
        return variant < 0.5 ? 0xc8ead3 : 0xd8efda;
      }
      if (city === 'yazd' || district === District.Desert) return 0xd8c99e;
      return variant < 0.5 ? 0xe0ebd7 : 0xd4e3d0;
    }
    if (
      tile === TileType.Road ||
      tile === TileType.RoadLineH ||
      tile === TileType.RoadLineV ||
      tile === TileType.Crossing ||
      tile === TileType.Runway
    ) {
      if (city === 'yazd') return variant < 0.4 ? 0xe8cdb4 : 0xf0d8c2;
      if (city === 'gilan') return variant < 0.4 ? 0xcce0df : 0xd8e8e5;
      return variant < 0.4 ? 0xdde3e9 : 0xe8e9e7;
    }
    if (city === 'yazd') return variant < 0.34 ? 0xf0c48f : variant < 0.67 ? 0xf6d1a3 : 0xe8b984;
    if (city === 'gilan') return variant < 0.34 ? 0xc8e2d1 : variant < 0.67 ? 0xd8eadb : 0xbfd9c8;
    if (city === 'tehran') return variant < 0.34 ? 0xe2e8ec : variant < 0.67 ? 0xeee8dc : 0xd8dfe4;
    if (district === District.Desert || district === District.Mountains) return 0xe5c79e;
    return variant < 0.5 ? 0xe5e7df : 0xdce2d9;
  }

  private streamRegionAt(tx0: number, ty0: number): string {
    const x = (tx0 + CHUNK_TILES / 2) * TILE_SIZE;
    const y = (ty0 + CHUNK_TILES / 2) * TILE_SIZE;
    const zones = this.map.streamZones;
    const priority: WorldStreamZone['kind'][] = [
      'city',
      'highway',
      'coast',
      'forest',
      'mountain',
      'desert',
      'farmland',
    ];
    for (const kind of priority) {
      const zone = zones.find((candidate) => {
        if (candidate.kind !== kind) return false;
        const b = candidate.bounds;
        return x >= b.x && y >= b.y && x < b.x + b.width && y < b.y + b.height;
      });
      if (zone) return zone.id;
    }
    return 'country:open-land';
  }

  /**
   * Deterministically decide (and create) the decoration for one tile, pushing
   * any created objects into `out`. Most tiles create nothing so the world
   * stays sparse and light; street lamps also get an additive glow halo that
   * renders above the day/night overlay, so they read as lit at night.
   */
  private decorateTile(
    scene: Phaser.Scene,
    tx: number,
    ty: number,
    tile: number,
    out: Phaser.GameObjects.GameObject[],
  ): void {
    // The precomputed mask replaces thousands of point-distance checks per chunk.
    if (this.highwayGeometry?.ownsTile(tx, ty)) return;
    const roll = this.tileHash(tx, ty);
    const cxp = tx * TILE_SIZE + TILE_SIZE / 2;
    const cyp = ty * TILE_SIZE + TILE_SIZE / 2;
    const district = this.districtAt(cxp, cyp);
    const cityId = this.cityAt(cxp, cyp)?.id;
    const detailRoll = this.tileHash(tx + 97, ty - 53);

    if (tile === TileType.Grass) {
      const density =
        district === District.Forest
          ? 0.55
          : district === District.Park
            ? 0.35
            : district === District.TeaFarm
              ? 0.22
              : district === District.Luxury
                ? 0.2
                : 0.12;
      if (roll < density) {
        const treeKey =
          cityId === 'gilan'
            ? TextureKeys.TreeGilan
            : cityId === 'yazd' || district === District.Desert
              ? this.tileHash(tx + 3, ty + 7) > 0.62
                ? TextureKeys.TreePalm
                : TextureKeys.TreeCypress
              : district === District.Park || district === District.Luxury
                ? TextureKeys.TreePlane
                : TextureKeys.Tree;
        const tree = scene.add.image(
          cxp + (this.tileHash(tx + 5, ty) - 0.5) * 10,
          cyp + (this.tileHash(tx, ty + 5) - 0.5) * 10,
          treeKey,
        );
        tree.setDepth(DepthLayers.Foliage);
        tree.setScale(0.9 + this.tileHash(tx + 9, ty + 9) * 0.35);
        out.push(tree);
      } else if (
        roll < density + 0.055 &&
        (district === District.Park || district === District.Residential)
      ) {
        const flower = scene.add.image(cxp, cyp, TextureKeys.FlowerPatch);
        flower.setDepth(DepthLayers.GroundDetail);
        out.push(flower);
      } else if (roll < density + 0.1) {
        const key =
          district === District.Forest || cityId === 'gilan'
            ? TextureKeys.Bush
            : TextureKeys.GrassTuft;
        const green = scene.add.image(cxp, cyp, key);
        green.setDepth(key === TextureKeys.Bush ? DepthLayers.Foliage : DepthLayers.GroundDetail);
        green.setRotation((Math.floor(this.tileHash(tx + 7, ty - 3) * 4) * Math.PI) / 2);
        out.push(green);
      }
      if (district === District.TeaFarm && roll > 0.72 && roll < 0.83) {
        const teaRow = scene.add.rectangle(cxp, cyp, 23, 5, 0x2c5939, 0.9);
        teaRow.setDepth(DepthLayers.GroundDetail);
        teaRow.setStrokeStyle(1, 0x5d8754, 0.75);
        out.push(teaRow);
      }
    } else if (tile === TileType.Sidewalk) {
      if (detailRoll < 0.055) {
        const decalKey =
          cityId === 'gilan' && detailRoll < 0.025
            ? TextureKeys.Puddle
            : district === District.Park || district === District.Residential
              ? TextureKeys.FallenLeaves
              : TextureKeys.PavementCrack;
        const decal = scene.add.image(cxp, cyp, decalKey);
        decal.setDepth(DepthLayers.GroundDetail - 1);
        decal.setRotation((Math.floor(this.tileHash(tx - 9, ty + 4) * 4) * Math.PI) / 2);
        out.push(decal);
      }
      // Furniture and fixtures come from accepted site plans or explicit gameplay sites.
    } else if (
      tile === TileType.Road ||
      tile === TileType.RoadLineH ||
      tile === TileType.RoadLineV
    ) {
      let roadDecal: TextureKeys | null = null;
      if (detailRoll < 0.025) roadDecal = TextureKeys.RoadCrack;
      else if (detailRoll < 0.038) roadDecal = TextureKeys.RoadPatch;
      else if (detailRoll < 0.05) roadDecal = TextureKeys.OilStain;
      else if (detailRoll < 0.06) roadDecal = TextureKeys.Manhole;
      else if (detailRoll < 0.068) roadDecal = TextureKeys.StormDrain;
      else if (detailRoll < 0.078 && tile !== TileType.Road) roadDecal = TextureKeys.RoadArrow;
      else if (detailRoll < 0.083 && district !== District.Downtown) {
        roadDecal = TextureKeys.SpeedBump;
      }
      if (roadDecal) {
        const decal = scene.add.image(cxp, cyp, roadDecal);
        decal.setDepth(DepthLayers.GroundDetail - 2);
        if (roadDecal === TextureKeys.RoadArrow || roadDecal === TextureKeys.SpeedBump) {
          decal.setRotation(tile === TileType.RoadLineH ? Math.PI / 2 : 0);
        } else {
          decal.setRotation((Math.floor(this.tileHash(tx - 12, ty + 31) * 4) * Math.PI) / 2);
        }
        out.push(decal);
      }
      // Sparse roadworks are visual only: lane-aware AI continues to follow the
      // legal lane graph, while cones make the city feel maintained.
      if (roll < 0.0025) {
        const cone = scene.add.image(cxp, cyp, TextureKeys.TrafficCone);
        cone.setDepth(DepthLayers.GroundDetail);
        out.push(cone);
      } else if (roll < 0.005 && this.cityAt(cxp, cyp) === null) {
        const sign = scene.add.image(cxp, cyp - 10, TextureKeys.RoadSign);
        sign.setDepth(DepthLayers.GroundDetail);
        sign.setScale(0.9);
        out.push(sign);
      }
    } else if (tile === TileType.Water) {
      if ((district === District.Harbor || district === District.Marina) && roll < 0.045) {
        const boat = scene.add.rectangle(cxp, cyp, 22, 8, 0xf2f2e8, 0.9);
        boat.setDepth(DepthLayers.Water + 1);
        boat.setStrokeStyle(1, 0x28384b, 0.75);
        out.push(boat);
      }
    } else if (tile === TileType.Sand) {
      if (
        (district === District.Desert ||
          district === District.Historic ||
          district === District.Bazaar ||
          district === District.Village) &&
        roll < 0.06
      ) {
        const desertPlant = scene.add.image(
          cxp,
          cyp,
          cityId === 'yazd' && detailRoll < 0.18 ? TextureKeys.TreePalm : TextureKeys.Cactus,
        );
        desertPlant.setDepth(DepthLayers.Foliage);
        out.push(desertPlant);
      }
    } else if (tile === TileType.Rock) {
      if (roll < 0.08) {
        const rock = scene.add.image(cxp, cyp, TextureKeys.Rock);
        rock.setDepth(DepthLayers.Foliage);
        out.push(rock);
      }
    } else if (tile === TileType.Concrete || tile === TileType.Dock) {
      if (
        (district === District.Harbor ||
          district === District.Marina ||
          district === District.Industrial ||
          district === District.Mining) &&
        roll < 0.05
      ) {
        const cargoKey = detailRoll < 0.33 ? TextureKeys.Pallet : TextureKeys.Crate;
        const cargo = scene.add.image(cxp, cyp, cargoKey);
        cargo.setDepth(DepthLayers.Foliage);
        out.push(cargo);
      } else if (
        (district === District.Harbor ||
          district === District.Marina ||
          district === District.Industrial ||
          district === District.Mining) &&
        roll < 0.065
      ) {
        const fence = scene.add.image(cxp, cyp, TextureKeys.ConstructionFence);
        fence.setDepth(DepthLayers.GroundDetail);
        out.push(fence);
      } else if (
        (district === District.Harbor ||
          district === District.Marina ||
          district === District.Industrial ||
          district === District.Mining) &&
        roll < 0.083
      ) {
        const barrel = scene.add.image(cxp, cyp, TextureKeys.Barrel);
        barrel.setDepth(DepthLayers.GroundDetail);
        out.push(barrel);
      }
    } else if (
      tile === TileType.Building ||
      tile === TileType.BuildingRes ||
      tile === TileType.BuildingInd
    ) {
      // Architecture is composed once at lot scale for the whole chunk.
      return;
    } else if (tile === TileType.InteriorFloor || tile === TileType.InteriorFixture) {
      if (roll < 0.035) {
        const rug = scene.add.rectangle(cxp, cyp, 18, 10, 0x394f66, 0.45);
        rug.setDepth(DepthLayers.GroundDetail);
        out.push(rug);
      }
    }
  }

  /** Stable per-tile hash → [0, 1). */
  private tileHash(tx: number, ty: number): number {
    let h = (tx * 374761393 + ty * 668265263) ^ 0xdec0;
    h = (h ^ (h >>> 13)) * 1274126177;
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
}
