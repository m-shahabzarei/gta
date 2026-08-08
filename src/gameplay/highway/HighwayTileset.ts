/**
 * Dedicated procedural highway tileset.
 *
 * The renderer uses these integer-aligned primitives like an atlas: every
 * straight, curve, junction and merge is assembled from the same immutable
 * cross-section and palette, so chunk boundaries cannot select a mismatched
 * visual variant.
 */
export const HIGHWAY_TILESET = {
  metrics: {
    laneWidth: 24,
    lanesPerDirection: 3,
    shoulderWidth: 10,
    pavementWidth: 92,
    medianWidth: 18,
    edgeLineWidth: 2,
    laneLineWidth: 2,
    railWidth: 3,
    dashLength: 18,
    dashGap: 14,
    railPostSpacing: 40,
  },
  colors: {
    asphalt: '#34393b',
    asphaltCool: '#30383a',
    asphaltWarm: '#3b3936',
    asphaltGrainLight: 'rgba(126, 132, 128, 0.12)',
    asphaltGrainDark: 'rgba(13, 17, 18, 0.13)',
    edgeShadow: '#1d2224',
    shoulder: '#4a5051',
    shoulderEdge: '#646967',
    marking: '#eee9d9',
    markingFaded: '#d8d3c5',
    concreteDark: '#4a4f50',
    concrete: '#929796',
    concreteLight: '#c4c7c1',
    railDark: '#252b2d',
    rail: '#aeb8b8',
    railHighlight: '#e0e4de',
    reflector: '#f5d66a',
    verge: '#4d674c',
    vergeDark: '#344936',
    vergeForest: '#34563b',
    vergeMountain: '#4b5b45',
    vergeDesert: '#9c754c',
    vergeDesertDark: '#806043',
    signGreen: '#2f6b51',
    signBlue: '#315f78',
    signText: '#edf0df',
  },
} as const;

export type HighwayTileKind =
  | 'asphalt-straight'
  | 'asphalt-curve'
  | 'lane-marking'
  | 'shoulder'
  | 'concrete-median'
  | 'outer-guard-rail'
  | 'grass-transition'
  | 'at-grade-intersection'
  | 'merge'
  | 'exit'
  | 'service-area'
  | 'bridge';

export const HIGHWAY_TILE_KINDS: readonly HighwayTileKind[] = [
  'asphalt-straight',
  'asphalt-curve',
  'lane-marking',
  'shoulder',
  'concrete-median',
  'outer-guard-rail',
  'grass-transition',
  'at-grade-intersection',
  'merge',
  'exit',
  'service-area',
  'bridge',
] as const;
