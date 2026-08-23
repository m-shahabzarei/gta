/**
 * Data structures describing a generated city.
 *
 * `MapData` is produced by the city generator and consumed by the world
 * manager (to build the tilemap + collision) and by every spawn system (roads
 * for traffic, sidewalks for pedestrians, entrances for missions/interiors).
 */
import type { Vector2 } from '@/core/types';
import type { InteriorKind } from './InteriorTypes';

/** Optional constraints for deterministic pedestrian-sized actor placement. */
export interface SafePedestrianPlacementOptions {
  /** Maximum distance from the requested point; omitted searches the complete world grid. */
  readonly maxDistance?: number;
  /** When supplied, the complete swept actor circle must reach the resolved point from here. */
  readonly segmentStart?: Vector2;
}

/** A node in the road graph (an intersection or road-segment midpoint). */
export interface RoadNode {
  id: number;
  x: number;
  y: number;
  /** Ids of connected nodes, for traffic routing. */
  neighbours: number[];
}

/** Physical classification used to derive lanes, speeds, signs and priority. */
export type RoadClass = 'local' | 'collector' | 'arterial' | 'highway' | 'service' | 'scenic';

/** A physical road edge adapted from the accepted plan and verified against the final raster. */
export interface RoadEdge {
  id: string;
  fromNodeId: number;
  toNodeId: number;
  roadClass: RoadClass;
  laneCount: 1 | 2 | 3;
  speedLimit: number;
  direction: 'both' | 'forward' | 'reverse';
  priority: number;
  surface:
    'urban-asphalt' | 'desert-asphalt' | 'forest-asphalt' | 'coastal-asphalt' | 'service-concrete';
  highwayId?: string;
  /** Physical part of a divided highway; absent for ordinary urban roads. */
  highwayComponent?: HighwayComponent;
  laneTransition?: PlannedRoadSegment['laneTransition'];
  transitionPathId?: string;
  interchangeId?: string;
  /** Legal carriageway direction, kept separate from the graph-edge direction. */
  carriageway?: HighwayCarriagewayDirection;
  navigationAllowed: boolean;
  trafficAllowed: boolean;
  pedestrianAllowed: boolean;
  emergencyAllowed: boolean;
  shoulder: boolean;
  lighting: boolean;
  turnRestrictions: Array<'left' | 'right' | 'u-turn'>;
}

/** Generated control and topology record for one physical junction. */
export interface RoadIntersectionData {
  nodeId: number;
  kind: 'dead-end' | 'bend' | 'merge' | 'intersection' | 'interchange';
  control: 'signal' | 'priority' | 'yield' | 'uncontrolled';
  connectedEdgeIds: string[];
  priorityEdgeIds: string[];
  trafficLight: boolean;
  /** Urban-design form authored by the planner; traffic policy remains separate. */
  design?: PlannedIntersectionDesign;
}

/** Ordered road hierarchy used by the urban planner before rasterisation. */
export type PlannedRoadHierarchy =
  'highway' | 'primary' | 'secondary' | 'residential' | 'alley' | 'access';

/** The only legal reasons for a planned street to terminate at degree one. */
export type PlannedRoadTerminalKind =
  | 'cul-de-sac'
  | 'parking-area'
  | 'roundabout'
  | 'dead-end-alley'
  | 'industrial-yard'
  | 'residential-court'
  | 'public-square'
  | 'harbor-entrance'
  | 'airport-entrance'
  | 'checkpoint'
  | 'highway-ramp'
  | 'forest-trail'
  | 'beach-access';

/** Visual/planning identity of a junction, independent from traffic control. */
export type PlannedIntersectionDesign =
  | 'cross'
  | 't-junction'
  | 'roundabout'
  | 'plaza'
  | 'offset'
  | 'diagonal'
  | 'multi-lane'
  | 'industrial'
  | 'residential'
  | 'bend'
  | 'terminal';

/** Tile-space point used by deterministic generation records. */
export interface PlannedTilePoint {
  x: number;
  y: number;
}

/** Authoritative road centreline. Every record becomes one physical graph edge. */
export interface PlannedRoadSegment {
  id: string;
  from: PlannedTilePoint;
  to: PlannedTilePoint;
  hierarchy: PlannedRoadHierarchy;
  halfWidth: number;
  cityId?: CityId;
  highwayId?: string;
  direction?: 'both' | 'forward' | 'reverse';
  highwayComponent?: HighwayComponent;
  carriageway?: HighwayCarriagewayDirection;
  laneCount?: 1 | 2 | 3;
  /** Authored operating speed in world pixels per second. */
  designSpeed?: number;
  /** Owning transition spline when this edge belongs to a city interchange. */
  transitionPathId?: string;
  /** Owning interchange; used by final graph hierarchy validation. */
  interchangeId?: string;
  /** Explicit highway transition; ordinary city junction logic must not infer one. */
  laneTransition?: 'acceleration' | 'deceleration' | 'merge' | 'diverge';
  startTerminal?: PlannedRoadTerminalKind;
  endTerminal?: PlannedRoadTerminalKind;
}

/** A designed road junction emitted before tiles or traffic lanes exist. */
export interface PlannedIntersection {
  id: string;
  position: PlannedTilePoint;
  design: PlannedIntersectionDesign;
  connectedRoadIds: string[];
  cityId?: CityId;
}

/** Zoning category assigned before buildings are generated. */
export type PlannedLandUse =
  | 'residential'
  | 'commercial'
  | 'office'
  | 'industrial'
  | 'institutional'
  | 'mixed-use'
  | 'park'
  | 'public-service'
  | 'infrastructure';

/** Concrete purpose that explains how a finalized block is occupied. */
export type PlannedBlockProgram =
  | 'housing'
  | 'apartments'
  | 'continuous-retail'
  | 'office-complex'
  | 'financial-center'
  | 'factory'
  | 'warehouse'
  | 'school'
  | 'hospital'
  | 'hotel'
  | 'market'
  | 'restaurant-row'
  | 'parking-garage'
  | 'government-complex'
  | 'police-station'
  | 'fire-station'
  | 'construction-site'
  | 'shopping-center'
  | 'public-plaza'
  | 'playground'
  | 'sports-center'
  | 'small-park'
  | 'university-campus'
  | 'industrial-yard'
  | 'harbor-facility'
  | 'airport-facility'
  | 'military-base'
  | 'rail-yard'
  | 'cemetery'
  | 'stadium'
  | 'beach-access'
  | 'forest-park'
  | 'farm-compound'
  | 'utility-site';

/** Finalized city block enclosed by the authoritative road reservation. */
export interface PlannedUrbanBlock {
  id: string;
  cityId: CityId;
  district: District;
  landUse: PlannedLandUse;
  program: PlannedBlockProgram;
  /** Minimum footprint coverage expected across net developable parcel land. */
  densityTarget: number;
  /** Memorable local destination; several may exist between world-map markers. */
  landmark: boolean;
  /** True only when low building coverage is explained by a deliberate use. */
  purposefulOpenSpace: boolean;
  /**
   * Exact disjoint developable parcel owned by this block. Merged or irregular
   * road cells may share an envelope with another block, so `bounds` alone is
   * never authoritative for occupancy. Optional for legacy/synthetic plans.
   */
  footprint?: Array<{ x: number; y: number; width: number; height: number }>;
  /** Tight display/composition envelope around `footprint`. */
  bounds: { x: number; y: number; width: number; height: number };
  form: 'short' | 'long' | 'rectangular' | 'irregular' | 'diagonal' | 'mixed';
  signature: string;
  generationAttempt: number;
}

export type PlannedBuildingArchetype =
  | 'tiny-house'
  | 'small-house'
  | 'corner-shop'
  | 'medium-apartment'
  | 'large-apartment'
  | 'office'
  | 'wide-commercial'
  | 'industrial'
  | 'tower'
  | 'public';

/** Discrete footprint scale used by the architecture grammar and renderer. */
export type PlannedBuildingSize = 'small' | 'medium' | 'large' | 'huge';

/** Building-level massing grammar. Every shape rasterizes to disjoint rectangles. */
export type PlannedBuildingShape =
  | 'rectangle'
  | 'l'
  | 'u'
  | 't'
  | 'corner'
  | 'courtyard'
  | 'paired'
  | 'podium-tower'
  | 'arcade'
  | 'shed-cluster';

/** Semantic identity used to select program-specific architecture modules. */
export type PlannedBuildingKind =
  | 'house'
  | 'villa'
  | 'apartment'
  | 'office'
  | 'tower'
  | 'retail'
  | 'market'
  | 'factory'
  | 'warehouse'
  | 'government'
  | 'mosque'
  | 'school'
  | 'university'
  | 'hospital'
  | 'police'
  | 'fire-station'
  | 'sports-hall'
  | 'stadium'
  | 'parking-structure'
  | 'gas-station'
  | 'hotel'
  | 'terminal'
  | 'utility';

export type PlannedFacing = 'north' | 'east' | 'south' | 'west';

export type PlannedEntranceKind =
  'main' | 'residential' | 'storefront' | 'service' | 'vehicle' | 'emergency' | 'campus' | 'gate';

/** A doorway and its collision-free exterior approach, owned by one building. */
export interface PlannedEntrance {
  id: string;
  buildingId: string;
  position: PlannedTilePoint;
  apron: PlannedTilePoint;
  facing: PlannedFacing;
  kind: PlannedEntranceKind;
  primary: boolean;
  /** Tile-space route from the apron toward the block frontage. */
  accessPath: PlannedTilePoint[];
}

export type PlannedRoofAssetKind =
  | 'hvac'
  | 'water-tank'
  | 'solar-panels'
  | 'roof-access'
  | 'chimney'
  | 'vent'
  | 'satellite-dish'
  | 'billboard'
  | 'air-conditioner'
  | 'skylight'
  | 'helipad'
  | 'windcatcher'
  | 'dome'
  | 'minaret';

/** Integer roof-space reservation; assets belonging to one roof may not overlap. */
export interface PlannedRoofAsset {
  id: string;
  buildingId: string;
  kind: PlannedRoofAssetKind;
  bounds: { x: number; y: number; width: number; height: number };
  facing: PlannedFacing;
  variant: number;
}

export type PlannedUrbanSpaceKind =
  | 'courtyard'
  | 'garden'
  | 'parking-lot'
  | 'loading-yard'
  | 'public-plaza'
  | 'playground'
  | 'sports-court'
  | 'football-field'
  | 'schoolyard'
  | 'hospital-approach'
  | 'police-yard'
  | 'mosque-court'
  | 'stadium-field'
  | 'market-lane'
  | 'park'
  | 'forest-pocket'
  | 'service-yard'
  | 'farmyard'
  | 'beach'
  | 'cemetery'
  | 'rail-yard'
  | 'construction-yard'
  | 'utility-yard';

export type PlannedGroundFeatureKind =
  | 'path'
  | 'parking-bay'
  | 'loading-bay'
  | 'gate'
  | 'fence'
  | 'wall'
  | 'tree'
  | 'planter'
  | 'street-light'
  | 'bench'
  | 'trash-bin'
  | 'bike-rack'
  | 'utility-box'
  | 'road-sign'
  | 'fire-hydrant'
  | 'mailbox'
  | 'market-stall'
  | 'playground-equipment'
  | 'football-marking'
  | 'basketball-marking'
  | 'plaza-fountain'
  | 'flower-bed'
  | 'solar-array'
  | 'service-marking'
  | 'ambulance-bay'
  | 'police-parking'
  | 'stadium-stand'
  | 'goal';

/** Planned fixtures with world volume; their reconciled cells receive collision ownership. */
export const PHYSICAL_GROUND_FEATURE_KINDS = [
  'wall',
  'fence',
  'tree',
  'planter',
  'street-light',
  'bench',
  'trash-bin',
  'bike-rack',
  'utility-box',
  'fire-hydrant',
  'mailbox',
  'market-stall',
  'playground-equipment',
  'plaza-fountain',
  'solar-array',
  'stadium-stand',
] as const satisfies readonly PlannedGroundFeatureKind[];

/** Deliberately positioned public-realm detail, never a random architectural prop. */
export interface PlannedGroundFeature {
  id: string;
  kind: PlannedGroundFeatureKind;
  bounds: { x: number; y: number; width: number; height: number };
  facing?: PlannedFacing;
  variant: number;
}

/** One coherent non-building use inside a finalized block. */
export interface PlannedUrbanSpace {
  id: string;
  blockId: string;
  cityId: CityId;
  district: District;
  program: PlannedBlockProgram;
  kind: PlannedUrbanSpaceKind;
  /** Exact disjoint tile rectangles owned by this public-realm use. */
  footprint: Array<{ x: number; y: number; width: number; height: number }>;
  /** Tight axis-aligned envelope used only for indexing and chunk intersection. */
  bounds: { x: number; y: number; width: number; height: number };
  purposeful: boolean;
  accessPoints: PlannedTilePoint[];
  features: PlannedGroundFeature[];
  signature: string;
}

/** Pure grammar lot; Task 2 converts it into a fully styled PlannedBuilding. */
export interface PlannedBuildingLot {
  id: string;
  blockId: string;
  cityId: CityId;
  district: District;
  program: PlannedBlockProgram;
  bounds: { x: number; y: number; width: number; height: number };
  shape: PlannedBuildingShape;
  size: PlannedBuildingSize;
  kind: PlannedBuildingKind;
  floors: number;
  setbackTiles: number;
  frontage: PlannedFacing;
  rotation: 0 | 90 | 180 | 270;
  mirrored: boolean;
  primary: boolean;
  footprint: Array<{ x: number; y: number; width: number; height: number }>;
  entrances: PlannedEntrance[];
  roofAssets: PlannedRoofAsset[];
  signature: string;
}

/** Complete deterministic site proposal for one accepted urban block. */
export interface PlannedBlockComposition {
  blockId: string;
  cityId: CityId;
  district: District;
  program: PlannedBlockProgram;
  template: string;
  lots: PlannedBuildingLot[];
  spaces: PlannedUrbanSpace[];
  coverageTarget: number;
  signature: string;
}

export type PlannedBuildingMaterial =
  'glass' | 'brick' | 'concrete' | 'stone' | 'wood' | 'steel' | 'adobe';

export type PlannedRoofStyle =
  | 'flat'
  | 'sloped'
  | 'mechanical'
  | 'green'
  | 'solar'
  | 'industrial'
  | 'roof-garden'
  | 'helipad'
  | 'water-tanks'
  | 'satellite';

export type PlannedGroundFloorUse =
  | 'residential'
  | 'restaurant'
  | 'coffee-shop'
  | 'market'
  | 'bank'
  | 'gym'
  | 'clinic'
  | 'bookstore'
  | 'pharmacy'
  | 'electronics'
  | 'supermarket'
  | 'office'
  | 'parking';

/** Generation-time building blueprint shared by validation and rendering. */
export interface PlannedBuilding {
  id: string;
  blockId: string;
  cityId: CityId;
  district: District;
  landUse: PlannedLandUse;
  program: PlannedBlockProgram;
  landmark: boolean;
  /** One or more rectangles allow L, U and courtyard footprints without polygons. */
  footprint: Array<{ x: number; y: number; width: number; height: number }>;
  bounds: { x: number; y: number; width: number; height: number };
  archetype: PlannedBuildingArchetype;
  material: PlannedBuildingMaterial;
  roofStyle: PlannedRoofStyle;
  facadeStyle: string;
  groundFloorUse: PlannedGroundFloorUse;
  floors: number;
  setbackTiles: number;
  signature: string;
  /** Authoritative semantic form emitted by the block grammar. */
  shape: PlannedBuildingShape;
  size: PlannedBuildingSize;
  kind: PlannedBuildingKind;
  entrances: PlannedEntrance[];
  roofAssets: PlannedRoofAsset[];
}

/** Automatic urban-quality audit emitted with every generated country. */
export interface UrbanQualityReport {
  passed: boolean;
  plannedRoadSegments: number;
  hierarchyCounts: Record<PlannedRoadHierarchy, number>;
  intersectionCounts: Partial<Record<PlannedIntersectionDesign, number>>;
  intentionalTerminals: number;
  invalidTerminals: number;
  interruptedRoadSegments: number;
  roadBuildingOverlaps: number;
  duplicateBlockSignatures: number;
  excessiveFacadeRepeats: number;
  unrealisticBuildingProportions: number;
  skylineAdjacencyViolations: number;
  oversizedEmptyBlocks: number;
  excessiveEmptyTerrainBlocks: number;
  unprogrammedOpenSpaces: number;
  meaninglessDeadEnds: number;
  streetsLeadingToEmptyLand: number;
  repetitiveDistricts: number;
  landmarkCoverageViolations: number;
  urbanizedBlockRatio: number;
  regeneratedBlocks: number;
  /** Bidirectional architecture/raster ownership and site-quality audits. */
  unownedBuildingTiles: number;
  footprintMismatches: number;
  inaccessibleEntrances: number;
  missingSiteContent: number;
  cityStyleViolations: number;
  issues: string[];
}

/** Complete professional-planning layer, finalized before simulation data. */
export interface UrbanPlanData {
  roads: PlannedRoadSegment[];
  intersections: PlannedIntersection[];
  blocks: PlannedUrbanBlock[];
  buildings: PlannedBuilding[];
  /** Purposeful public realm emitted alongside the building lots. */
  spaces: PlannedUrbanSpace[];
  quality: UrbanQualityReport;
}

/** A traffic-light position (placed near intersections). */
export interface TrafficLightInfo {
  x: number;
  y: number;
  /** Axis this light governs: true = controls north-south flow. */
  northSouth: boolean;
}

/** A building doorway usable as a mission marker / interior entrance. */
export interface BuildingEntrance {
  x: number;
  y: number;
  /** Exterior architecture owner retained so services cannot be assigned to anonymous doors. */
  buildingId: string;
  cityId: CityId;
  buildingKind: PlannedBuildingKind;
  program: PlannedBlockProgram;
  groundFloorUse: PlannedGroundFloorUse;
}

/** A stamped in-world building interior. All coordinates are world pixels. */
export interface BuildingInterior {
  id: string;
  /** Planned exterior object whose roof is opened for this interior. */
  buildingId: string;
  kind: InteriorKind;
  /** City and layout identity used by rendering, NPC routines and validation. */
  cityId: CityId;
  variant: MajorBuildingVariant | 'gun-store' | 'vehicle-showroom';
  entrance: Vector2;
  bounds: { x: number; y: number; w: number; h: number };
  rooms: InteriorRoom[];
  doors: InteriorDoorInfo[];
  objects: InteriorObjectInfo[];
  npcSpawns: InteriorNpcSpawn[];
  ambient: InteriorAmbienceKind;
}

/** Named room rectangle used by ambience, NPC placement and debug-friendly layout. */
export interface InteriorRoom {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Doorway or internal door in an enterable building. */
export interface InteriorDoorInfo {
  x: number;
  y: number;
  w: number;
  h: number;
  open: boolean;
}

export type InteriorAmbienceKind = 'medical' | 'police' | 'shop' | 'garage';

export type InteriorObjectKind =
  | 'counter'
  | 'bench'
  | 'bed'
  | 'desk'
  | 'shelf'
  | 'cabinet'
  | 'locker'
  | 'cell'
  | 'display'
  | 'vehicle-display'
  | 'washroom'
  | 'crate'
  | 'stretcher'
  | 'door'
  | 'chair'
  | 'computer'
  | 'medical-cart'
  | 'exam-table'
  | 'operating-table'
  | 'privacy-screen'
  | 'filing-cabinet'
  | 'security-console'
  | 'evidence-table';

export type InteriorInteractionAction =
  | 'hospital-heal'
  | 'hospital-medkit'
  | 'hospital-save'
  | 'police-clear'
  | 'gun-buy-weapon'
  | 'gun-buy-ammo'
  | 'gun-buy-armor'
  | 'dealer-buy-vehicle'
  | 'dealer-service';

/** Decorative or interactive prop inside a real in-world interior. */
export interface InteriorObjectInfo {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: InteriorObjectKind;
  color: number;
  /** Substantial furniture stamps an invisible solid floor tile beneath its core. */
  blocksMovement?: boolean;
  prompt?: string;
  action?: InteriorInteractionAction;
}

/** Candidate spawn point for same-system NPCs inside a building. */
export interface InteriorNpcSpawn {
  x: number;
  y: number;
  role: string;
  count: number;
  appearance?: InteriorNpcAppearance;
  activity?: InteriorNpcActivity;
  /** Validated local route anchors used by the shared pedestrian navigation state machine. */
  anchors?: Vector2[];
}

export type InteriorNpcAppearance =
  | 'police-uniform'
  | 'police-detective'
  | 'hospital-doctor'
  | 'hospital-nurse'
  | 'hospital-paramedic'
  | 'hospital-patient'
  | 'hospital-reception'
  | 'hospital-security'
  | 'civilian';

export type InteriorNpcActivity =
  | 'reception'
  | 'desk-work'
  | 'patrol'
  | 'guard'
  | 'inspect'
  | 'treat'
  | 'deliver'
  | 'wait'
  | 'recover'
  | 'talk';

/** A sidewalk bench pedestrians can path to and sit on. */
export interface BenchSite {
  x: number;
  y: number;
  /** Facing angle (radians) used purely for the sitting pose. */
  facing: number;
  /** Entity id of the pedestrian currently seated here, or null if free. */
  occupiedBy: number | null;
}

/**
 * A curb-side transit stop generated from a legal directed traffic lane.
 * `x`/`y` remain the pedestrian platform position for existing world and
 * pedestrian APIs. The remaining fields are a directed, lane-bound stop
 * target; a bus must drive to `stopPosition`, never merely near the shelter.
 */
export interface BusStopSite {
  /** Stable generated id used by routes, discovery and map markers. */
  id: string;
  /** City whose transit configuration may serve this stop. */
  cityId: CityId;
  x: number;
  y: number;
  /** Facing angle (radians) used for the waiting pose and shelter art. */
  facing: number;
  /** Directed outer-lane id used by the traffic network. */
  laneId: string;
  /** Directed road node from which the service vehicle approaches this curb. */
  roadNodeId: number;
  /** Directed road node to which the service vehicle resumes after this curb. */
  resumeNodeId: number;
  /** Exact legal bus stopping point sampled from `laneId`. */
  stopPosition: Vector2;
  /** Legal lane point before `stopPosition`, used to enter the approach state. */
  approachPosition: Vector2;
  /** Legal lane point after `stopPosition`, documenting the resume direction. */
  resumePosition: Vector2;
  /** Unit forward direction of the directed lane at the stopping point. */
  approachDirection: Vector2;
  /** Arc distance along the directed lane to the exact stopping point. */
  laneDistance: number;
  /** Total directed lane length, retained for validation diagnostics. */
  laneLength: number;
  /** Directed-lane heading at the bus stopping point. */
  heading: number;
  /** Route ids that resolve to this directional stop in the generated world. */
  routeIds: string[];
  /** Bounded number of pedestrians able to wait at this platform. */
  capacity: number;
  /** Entity ids currently assigned to this stop's distinct waiting slots. */
  waitingEntityIds: number[];
  /** Distinct pedestrian-safe positions beside the shelter. */
  waitingPositions: Vector2[];
}

/** A road crossing (crosswalk) pedestrians can use to safely cross traffic. */
export interface CrossingInfo {
  x: number;
  y: number;
  /** The axis vehicle traffic travels through this crossing. */
  axis: 'ns' | 'ew';
  /** Whether a real traffic light of the matching axis governs this crossing. */
  hasLight: boolean;
}

/** Stable identifiers for the three seamless destination cities. */
export type CityId = 'tehran' | 'yazd' | 'gilan';

/** Functional landmark categories supported by the shared major-building registry. */
export type MajorBuildingType =
  | 'police-station'
  | 'hospital'
  | 'fire-station'
  | 'gas-station'
  | 'bank'
  | 'government'
  | 'shopping-center';

export type MajorBuildingIcon =
  | 'police-badge'
  | 'medical-cross'
  | 'fire-shield'
  | 'fuel-pump'
  | 'bank-columns'
  | 'government-columns'
  | 'shopping-bag';

export type MajorBuildingVariant =
  | 'tehran-police-headquarters'
  | 'tehran-district-police'
  | 'yazd-courtyard-police'
  | 'gilan-regional-police'
  | 'tehran-general-hospital'
  | 'tehran-emergency-hospital'
  | 'yazd-courtyard-hospital'
  | 'gilan-regional-hospital';

export type MajorBuildingSize = 'district' | 'regional' | 'metropolitan';

export interface MajorBuildingParkingArea {
  position: Vector2;
  heading: number;
  slots: number;
  vehicleKind: 'police' | 'policeSuv' | 'ambulance';
}

export interface MajorBuildingNpcProfile {
  maxActive: number;
  roles: string[];
}

/** Authoritative record shared by simulation, rendering, world map and minimap. */
export interface MajorBuildingDefinition {
  id: string;
  name: string;
  type: MajorBuildingType;
  city: CityId;
  buildingId: string;
  worldPosition: Vector2;
  entrancePosition: Vector2;
  exteriorBounds: WorldBounds;
  interiorId: string;
  mapIcon: MajorBuildingIcon;
  minimapIcon: MajorBuildingIcon;
  size: MajorBuildingSize;
  architecturalVariant: MajorBuildingVariant;
  npcProfile: MajorBuildingNpcProfile;
  parkingArea: MajorBuildingParkingArea;
  services: Array<'arrest' | 'dispatch' | 'wanted-clearance' | 'healing' | 'revival' | 'ambulance'>;
  activeState: 'proximity-streamed';
}

/** A rectangular world-space extent, used by map and streaming queries. */
export interface WorldBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A named city embedded directly in the continuous world map. */
export interface WorldCity {
  id: CityId;
  /** Display label used by HUD, map, road signs, and travel notices. */
  name: 'TEHRAN' | 'YAZD' | 'GILAN';
  center: Vector2;
  bounds: WorldBounds;
  /** Map/HUD accent colour (`0xRRGGBB`). */
  color: number;
  /** Short identity statement displayed in the world-map city card. */
  theme: string;
  /** Density multipliers applied only while the player is in this region. */
  pedestrianDensity: number;
  trafficDensity: number;
  /** Default local climate; the transition system blends between these values. */
  weather: 'clear' | 'rain' | 'storm' | 'fog';
  atmosphere: {
    lightingTint: number;
    architecture: string;
    roadMaterial: string;
    vegetation: string;
    ambientSound: string;
    signStyle: string;
    vehicleProfile: string;
    weatherWeights: Readonly<Record<'clear' | 'rain' | 'storm' | 'fog', number>>;
  };
}

/** Geographic ownership used by the chunk streamer and diagnostics. */
export interface WorldStreamZone {
  id: string;
  kind: 'city' | 'highway' | 'forest' | 'desert' | 'coast' | 'farmland' | 'mountain';
  bounds: WorldBounds;
  detail: 'dense' | 'standard' | 'sparse';
}

/** Result of validating the generated country before it is exposed to systems. */
export interface WorldValidationReport {
  passed: boolean;
  connectedRoadNodes: number;
  totalRoadNodes: number;
  connectedRoadEdges: number;
  totalRoadEdges: number;
  reachableCities: CityId[];
  highwayIds: string[];
  intercityDriveSeconds: Record<string, number>;
  navigationGraphContinuous: boolean;
  trafficLaneGraphContinuous: boolean;
  pathfindingGraphContinuous: boolean;
  emergencyNetworkContinuous: boolean;
  pedestrianCrossingsValid: boolean;
  urbanQualityPassed: boolean;
  highwayQualityPassed: boolean;
  issues: string[];
}

/**
 * Discoverable world landmark.  Landmarks are data rather than scene objects so
 * they can be drawn on the full map even when their chunk is not currently
 * loaded.
 */
export interface WorldLandmark {
  id: string;
  name: string;
  position: Vector2;
  cityId?: CityId;
  kind:
    | 'airport'
    | 'stadium'
    | 'government'
    | 'university'
    | 'station'
    | 'metro'
    | 'hospital'
    | 'police'
    | 'hotel'
    | 'harbor'
    | 'marina'
    | 'lighthouse'
    | 'mosque'
    | 'bazaar'
    | 'fort'
    | 'mine'
    | 'park'
    | 'waterfall'
    | 'viewpoint'
    | 'rest-stop'
    | 'gas'
    | 'shop'
    | 'bridge'
    | 'tower'
    | 'financial'
    | 'cargo'
    | 'military'
    | 'solar'
    | 'observatory'
    | 'caravanserai'
    | 'salt-lake'
    | 'oasis'
    | 'forest'
    | 'camping'
    | 'port';
  /** Optional longer flavour text exposed in the world-map detail panel. */
  description?: string;
}

/** All national routes share one visual median; per-route random styles are forbidden. */
export type HighwayMedianType = 'concrete-barrier';

export type HighwayComponent =
  | 'carriageway'
  | 'entry-ramp'
  | 'exit-ramp'
  | 'slip-road'
  | 'collector-road'
  | 'transition-road'
  | 'service-road';

export type HighwayCarriagewayDirection = 'forward' | 'reverse';

export interface HighwayCarriageway {
  id: string;
  direction: HighwayCarriagewayDirection;
  /** Smooth render spline samples in legal driving order. */
  points: Vector2[];
  laneCount: 3;
  laneWidth: number;
  pavementWidth: number;
  shoulderWidth: number;
  roadSegmentIds: string[];
}

/** At-grade road junctions are the only legal city/highway connection. */
export type HighwayInterchangeKind = 't-junction' | 'cross' | 'priority-cross';

export type HighwayTransitionPathKind = Exclude<HighwayComponent, 'carriageway' | 'service-road'>;

export interface HighwayTransitionMerge {
  kind: 'acceleration' | 'deceleration' | 'yield' | 'continuation';
  startDistance: number;
  endDistance: number;
  taperLength: number;
  side: -1 | 1;
}

/** One continuous, legal-direction centreline through an interchange. */
export interface HighwayTransitionPath {
  id: string;
  kind: HighwayTransitionPathKind;
  direction: 'entry' | 'exit' | 'circulating';
  points: Vector2[];
  roadSegmentIds: string[];
  laneCount: 1 | 2;
  laneWidth: number;
  shoulderWidth: number;
  designSpeed: number;
  elevation: 'ground' | 'overpass';
  merge?: HighwayTransitionMerge;
  minimumRadius: number;
  maximumHeadingDelta: number;
}

export interface HighwayGoreArea {
  id: string;
  pathId: string;
  kind: 'entry' | 'exit';
  points: [Vector2, Vector2, Vector2];
  tip: Vector2;
  length: number;
  width: number;
  taperAngle: number;
  stripeSpacing: number;
  crashAttenuator: boolean;
  chevrons: boolean;
  guardRail: boolean;
}

export type HighwayCityGateKind =
  | 'industrial-logistics'
  | 'commercial-mobility'
  | 'park-and-ride'
  | 'truck-terminal'
  | 'transit-terminal'
  | 'controlled-entry';

export type HighwayCityGateSiteKind =
  | 'warehouse'
  | 'truck-terminal'
  | 'large-fuel-station'
  | 'commercial-strip'
  | 'park-and-ride'
  | 'bus-terminal'
  | 'police-checkpoint'
  | 'direction-sign'
  | 'lighting'
  | 'sound-barrier'
  | 'tree-belt'
  | 'bushes'
  | 'retaining-wall'
  | 'embankment'
  | 'drainage-ditch'
  | 'decorative-rocks'
  | 'small-hill'
  | 'fence';

export interface HighwayCityGateSite {
  id: string;
  kind: HighwayCityGateSiteKind;
  position: Vector2;
  heading: number;
  width: number;
  depth: number;
}

export interface HighwayCityGateZone {
  id: string;
  kind: HighwayCityGateKind;
  center: Vector2;
  heading: number;
  radius: number;
  sites: HighwayCityGateSite[];
}

export interface HighwayInterchangeMetrics {
  minimumRampRadius: number;
  shortestMergeLane: number;
  maximumHeadingDelta: number;
  laneWidthDeviation: number;
  shoulderWidthDeviation: number;
  edgeIntersections: number;
  markingOverlaps: number;
}

export interface HighwayInterchange {
  id: string;
  cityId: CityId;
  position: Vector2;
  cityConnection: Vector2;
  /** The two carriageway terminals consumed as ordinary city-grid anchors. */
  cityConnections: [Vector2, Vector2];
  kind: HighwayInterchangeKind;
  selectionReason: string;
  entryRampIds: string[];
  exitRampIds: string[];
  circulatingRoadIds: string[];
  accelerationLane: boolean;
  decelerationLane: boolean;
  transitionPaths: HighwayTransitionPath[];
  goreAreas: HighwayGoreArea[];
  gateZone: HighwayCityGateZone;
  metrics: HighwayInterchangeMetrics;
}

export type HighwayServiceFacility =
  | 'fuel'
  | 'restaurant'
  | 'coffee'
  | 'parking'
  | 'truck-parking'
  | 'repair'
  | 'ev-charging'
  | 'toilets'
  | 'motel'
  | 'police'
  | 'ambulance'
  | 'mini-market'
  | 'rest-area'
  | 'picnic';

export interface HighwayServiceArea {
  id: string;
  name: string;
  position: Vector2;
  side: HighwayCarriagewayDirection;
  kilometer: number;
  facilities: HighwayServiceFacility[];
  accessRoadIds: string[];
  parkingSpaces: Vector2[];
  visitorSpawns: Vector2[];
}

export type HighwayStructureKind =
  'bridge' | 'overpass' | 'underpass' | 'tunnel' | 'retaining-wall' | 'mountain-cut' | 'causeway';

export interface HighwayStructure {
  id: string;
  kind: HighwayStructureKind;
  startDistance: number;
  endDistance: number;
  position: Vector2;
}

export type HighwayFurnitureKind =
  | 'direction-sign'
  | 'distance-sign'
  | 'exit-sign'
  | 'speed-limit'
  | 'warning'
  | 'reflector'
  | 'emergency-phone'
  | 'exit-lighting'
  | 'traffic-camera'
  | 'variable-message-sign'
  | 'drainage'
  | 'crash-cushion';

export interface HighwayFurnitureSite {
  id: string;
  kind: HighwayFurnitureKind;
  position: Vector2;
  heading: number;
  label?: string;
}

export type HighwaySceneryKind =
  | 'industrial-buildings'
  | 'warehouses'
  | 'power-lines'
  | 'factory'
  | 'billboard'
  | 'construction'
  | 'sound-barrier'
  | 'concrete-wall'
  | 'sand-dunes'
  | 'rock-formations'
  | 'dry-river'
  | 'wind-turbines'
  | 'solar-farm'
  | 'caravan-ruins'
  | 'cactus'
  | 'dust'
  | 'dense-forest'
  | 'rice-fields'
  | 'river'
  | 'fog-bank'
  | 'tea-farm'
  | 'wetlands'
  | 'lake'
  | 'small-village';

export interface HighwayScenerySite {
  id: string;
  kind: HighwaySceneryKind;
  position: Vector2;
  heading: number;
  scale: number;
}

/** Hard rejection report produced before a highway enters the world. */
export interface HighwayQualityReport {
  passed: boolean;
  routes: number;
  carriageways: number;
  interchanges: number;
  serviceAreas: number;
  structures: number;
  furnitureSites: number;
  scenerySites: number;
  jaggedEdgeViolations: number;
  brokenGuardRails: number;
  medianDiscontinuities: number;
  opposingPavementOverlaps: number;
  brokenLaneMarkings: number;
  unexpectedLaneWidthChanges: number;
  highwayDeadEnds: number;
  invalidRamps: number;
  serviceSpacingViolations: number;
  rampCurvatureViolations: number;
  overlappingMarkings: number;
  shortMergeLanes: number;
  directLocalConnections: number;
  oversizedGores: number;
  roadEdgeIntersections: number;
  missingHierarchyLinks: number;
  missingCityGateZones: number;
  issues: string[];
}

/** A divided intercity corridor generated from a smooth procedural alignment. */
export interface HighwayRoute {
  id: string;
  name: string;
  from: CityId;
  to: CityId;
  points: Vector2[];
  /** Whether the route mainly reads as a desert, mountain, forest or coastal drive. */
  character: 'desert' | 'mountain' | 'forest' | 'coastal' | 'urban';
  medianType: HighwayMedianType;
  medianWidth: number;
  carriageways: [HighwayCarriageway, HighwayCarriageway];
  interchanges: HighwayInterchange[];
  serviceAreas: HighwayServiceArea[];
  structures: HighwayStructure[];
  furniture: HighwayFurnitureSite[];
  scenery: HighwayScenerySite[];
  quality: HighwayQualityReport;
}

/** Compact low-resolution terrain map used by the minimap cache. */
export interface MapOverview {
  cellSizeTiles: number;
  width: number;
  height: number;
  tiles: number[][];
}

/** Named districts assigned per city block by the generator. */
export enum District {
  Downtown = 'downtown',
  Commercial = 'commercial',
  Residential = 'residential',
  Luxury = 'luxury',
  OldTown = 'old-town',
  Government = 'government',
  University = 'university',
  Industrial = 'industrial',
  Harbor = 'harbor',
  Airport = 'airport',
  Historic = 'historic',
  Bazaar = 'bazaar',
  Village = 'village',
  Mining = 'mining',
  Marina = 'marina',
  RiceFields = 'rice-fields',
  TeaFarm = 'tea-farm',
  Beach = 'beach',
  Ocean = 'ocean',
  Park = 'park',
  Forest = 'forest',
  Mountains = 'mountains',
  Desert = 'desert',
  Farmland = 'farmland',
}

/** The complete procedurally-generated city description. */
export interface MapData {
  widthTiles: number;
  heightTiles: number;
  tileSize: number;
  /** Full connected-city metadata for map labels, ambience and density. */
  cities: WorldCity[];
  /** Static destinations that remain visible on the world map while unloaded. */
  landmarks: WorldLandmark[];
  /** Required service landmarks consumed by gameplay, world map and minimap. */
  majorBuildings: MajorBuildingDefinition[];
  /** Intercity highway routes used by routing preview and road-trip traffic. */
  highways: HighwayRoute[];
  /** Rejection-gate result for the complete national expressway system. */
  highwayQuality: HighwayQualityReport;
  /** Independently classified regions consumed by chunk streaming diagnostics. */
  streamZones: WorldStreamZone[];
  /** Downsampled terrain cache for the HUD radar. */
  overview: MapOverview;
  /** Row-major tile grid, `tiles[y][x]` holding a {@link TileType} value. */
  tiles: number[][];
  /** Per-block district grid, `districts[bj][bi]` (block period = `blockPeriod`). */
  districts: District[][];
  /** Roads, finalized blocks and building blueprints produced by the planner. */
  urbanPlan: UrbanPlanData;
  /** Tile width/height of one repeating block cell (road+sidewalk+block). */
  blockPeriod: number;
  /** Road graph for traffic AI routing (nodes on water/airport are pruned). */
  roadNodes: RoadNode[];
  /** Road policy generated from the same finished terrain as {@link roadNodes}. */
  roadEdges: RoadEdge[];
  /** Intersection rules generated from road topology and lights. */
  intersections: RoadIntersectionData[];
  /** Sampled world positions that lie on drivable roads (vehicle spawns). */
  roadSpawns: Vector2[];
  /** Sampled world positions that lie on sidewalks (pedestrian spawns). */
  sidewalkSpawns: Vector2[];
  /** Building doorways for missions / interiors. */
  buildingEntrances: BuildingEntrance[];
  /** Real interiors stamped into service buildings in the normal world map. */
  buildingInteriors: BuildingInterior[];
  /** Walkable interior sample points used by nearby pedestrian pathing. */
  interiorSpawns: Vector2[];
  /** Sidewalk benches pedestrians can path to and sit on. */
  benches: BenchSite[];
  /** Bus stops pedestrians can path to and wait at. */
  busStops: BusStopSite[];
  /** Road crossings (crosswalks) pedestrians can use to cross traffic safely. */
  crossings: CrossingInfo[];
  /** Traffic-light placements. */
  trafficLights: TrafficLightInfo[];
  /** Hospital positions (player respawn points; heal service). */
  hospitals: Vector2[];
  /** Police-station positions (extra police spawn points). */
  policeStations: Vector2[];
  /** Fire-station positions. */
  fireStations: Vector2[];
  /** Gas stations (vehicle repair service). */
  gasStations: Vector2[];
  /** Gun shops (ammo / armor purchase). */
  gunShops: Vector2[];
  /** Public garages / workshops. */
  garages: Vector2[];
  /** Safe houses used as player hideouts. */
  safeHouses: Vector2[];
  /** Hidden collectible package positions. */
  collectibles: Vector2[];
  /** Street race starting flags. */
  raceStarts: Vector2[];
  /** Where the player starts. */
  playerStart: Vector2;
  /** Connectivity audit performed during generation; invalid maps fail generation. */
  validation: WorldValidationReport;
}
