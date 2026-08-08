import type { Vector2 } from '@/core/types';
import type {
  HighwayCarriagewayDirection,
  HighwayCityGateZone,
  HighwayFurnitureSite,
  HighwayGoreArea,
  HighwayMedianType,
  HighwayScenerySite,
  HighwayServiceArea,
  HighwayStructure,
  HighwayTransitionMerge,
  HighwayTransitionPathKind,
} from '@/gameplay/types';

export type HighwayRenderLod = 'near' | 'medium' | 'far';

export interface HighwaySplineSample extends Vector2 {
  tangentX: number;
  tangentY: number;
  normalX: number;
  normalY: number;
  distance: number;
}

export interface HighwayMainlineSection {
  id: string;
  routeId: string;
  character: 'desert' | 'mountain' | 'forest' | 'coastal' | 'urban';
  direction: HighwayCarriagewayDirection;
  laneCount: 3;
  laneWidth: number;
  pavementWidth: number;
  shoulderWidth: number;
  points: HighwaySplineSample[];
}

export interface HighwayMedianSection {
  id: string;
  routeId: string;
  medianType: HighwayMedianType;
  width: number;
  points: HighwaySplineSample[];
}

export interface HighwayRampSection {
  id: string;
  routeId: string;
  character: 'desert' | 'mountain' | 'forest' | 'coastal' | 'urban';
  kind: HighwayTransitionPathKind | 'service-road';
  direction?: 'entry' | 'exit' | 'circulating';
  laneCount: 1 | 2;
  laneWidth: number;
  shoulderWidth: number;
  mergeKind?: HighwayTransitionMerge['kind'];
  elevation: 'ground' | 'overpass';
  /** Full unbucketed arc length. Width/taper evaluation must use this value. */
  length: number;
  startWidth: number;
  middleWidth?: number;
  endWidth: number;
  /** Arc-distance interval over which startWidth transitions to endWidth. */
  taperStartDistance: number;
  taperEndDistance: number;
  /** Mainline-facing merge lane span. Undefined for standalone service loops. */
  laneStartDistance?: number;
  laneEndDistance?: number;
  /** Side of the ramp normal facing away from the mainline. */
  mergeSide?: -1 | 1;
  /** Stable placement within the parallel acceleration/deceleration lane. */
  arrowDistance?: number;
  points: HighwaySplineSample[];
}

export interface HighwayChunkGeometry {
  readonly key: string;
  readonly mainlines: readonly HighwayMainlineSection[];
  readonly medians: readonly HighwayMedianSection[];
  readonly ramps: readonly HighwayRampSection[];
  readonly gores: readonly HighwayGoreArea[];
  readonly gateZones: readonly HighwayCityGateZone[];
  readonly furniture: readonly HighwayFurnitureSite[];
  readonly serviceAreas: readonly HighwayServiceArea[];
  readonly structures: readonly HighwayStructure[];
  readonly scenery: readonly HighwayScenerySite[];
  /** Local row-major tile offsets occupied by coarse guard-rail collision. */
  readonly railCollisionTiles: readonly number[];
}

export interface HighwayGeometryStats {
  readonly indexedChunks: number;
  readonly mainlineSections: number;
  readonly medianSections: number;
  readonly rampSections: number;
  readonly goreSections: number;
  readonly gateZones: number;
  readonly splineSamples: number;
  readonly corridorTiles: number;
  readonly railCollisionTiles: number;
}

export interface HighwayRenderStats extends HighwayGeometryStats {
  readonly residentChunks: number;
  readonly visibleChunks: number;
  readonly cachedTextures: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly rasterizedDetails: number;
  readonly estimatedBatchedDraws: number;
  readonly lastBuildMs: number;
  readonly maximumBuildMs: number;
  readonly totalBuildMs: number;
}

export interface HighwayChunkHandle {
  readonly key: string;
  readonly lod: HighwayRenderLod;
  readonly textureKey: string;
  readonly image: Phaser.GameObjects.Image;
}
