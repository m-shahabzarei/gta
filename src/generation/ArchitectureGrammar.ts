/**
 * Deterministic, program-aware block architecture grammar.
 *
 * This module is deliberately pure: it proposes coherent lots, footprints,
 * entrances, roof equipment and public-realm anchors, but never writes the
 * world raster. WorldManager remains the single occupancy rasterizer so every
 * accepted footprint reaches physics, navigation and rendering together.
 */
import type {
  CityId,
  PlannedBlockComposition,
  PlannedBlockProgram,
  PlannedBuildingArchetype,
  PlannedBuildingKind,
  PlannedBuildingLot,
  PlannedBuildingMaterial,
  PlannedBuildingShape,
  PlannedBuildingSize,
  PlannedEntrance,
  PlannedEntranceKind,
  PlannedFacing,
  PlannedGroundFeature,
  PlannedGroundFeatureKind,
  PlannedRoofAsset,
  PlannedRoofAssetKind,
  PlannedRoofStyle,
  PlannedTilePoint,
  PlannedUrbanBlock,
  PlannedUrbanSpace,
  PlannedUrbanSpaceKind,
} from '@/gameplay/types';

interface TileRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface LotDraft {
  bounds: TileRect;
  kind: PlannedBuildingKind;
  shape: PlannedBuildingShape;
  primary: boolean;
  frontage?: PlannedFacing;
}

interface EntranceRequest {
  kind: PlannedEntranceKind;
  primary: boolean;
  preferred: PlannedFacing;
}

const OPEN_PROGRAMS = new Set<PlannedBlockProgram>([
  'public-plaza',
  'playground',
  'small-park',
  'cemetery',
  'beach-access',
  'forest-park',
]);

/** Deterministic, weighted city material selection shared by runtime and validation. */
export function selectBuildingMaterial(
  city: CityId,
  district: PlannedUrbanBlock['district'],
  archetype: PlannedBuildingArchetype,
  salt: number,
): PlannedBuildingMaterial {
  const house = archetype === 'tiny-house' || archetype === 'small-house';
  const apartment = archetype === 'medium-apartment' || archetype === 'large-apartment';
  let choices: readonly PlannedBuildingMaterial[];
  if (city === 'gilan' && house) {
    choices = ['wood', 'wood', 'wood', 'wood', 'wood', 'wood', 'wood', 'wood', 'brick', 'stone'];
  } else if (city === 'gilan') {
    choices =
      archetype === 'industrial'
        ? ['wood', 'wood', 'brick', 'brick', 'stone', 'concrete']
        : ['wood', 'wood', 'wood', 'brick', 'brick', 'stone', 'concrete'];
  } else if (city === 'yazd' && house) {
    choices = [
      'adobe',
      'adobe',
      'adobe',
      'adobe',
      'adobe',
      'adobe',
      'adobe',
      'adobe',
      'stone',
      'brick',
    ];
  } else if (city === 'yazd') {
    choices =
      archetype === 'industrial'
        ? ['brick', 'brick', 'concrete', 'stone', 'adobe']
        : [
            'adobe',
            'adobe',
            'adobe',
            'adobe',
            'adobe',
            'adobe',
            'stone',
            'stone',
            'brick',
            'concrete',
          ];
  } else if (archetype === 'tower') {
    choices = ['glass', 'glass', 'glass', 'glass', 'glass', 'steel', 'steel', 'steel', 'concrete'];
  } else if (archetype === 'office' || archetype === 'wide-commercial') {
    choices = ['glass', 'glass', 'glass', 'steel', 'steel', 'concrete', 'concrete', 'stone'];
  } else if (apartment) {
    choices = ['concrete', 'concrete', 'concrete', 'glass', 'glass', 'brick', 'brick', 'stone'];
  } else if (district === 'industrial' || archetype === 'industrial') {
    choices = ['steel', 'steel', 'brick', 'concrete', 'concrete'];
  } else {
    choices = ['brick', 'concrete', 'concrete', 'stone', 'glass'];
  }
  return choose(choices, mixHash(salt, 0x6d21));
}

/** Deterministic, weighted roof silhouette selection shared by runtime and validation. */
export function selectRoofStyle(
  city: CityId,
  district: PlannedUrbanBlock['district'],
  archetype: PlannedBuildingArchetype,
  floors: number,
  salt: number,
): PlannedRoofStyle {
  const house = archetype === 'tiny-house' || archetype === 'small-house';
  let choices: readonly PlannedRoofStyle[];
  if (archetype === 'industrial') {
    choices = ['industrial', 'industrial', 'solar', 'mechanical'];
  } else if (city === 'gilan' && house) {
    choices = [
      'sloped',
      'sloped',
      'sloped',
      'sloped',
      'sloped',
      'sloped',
      'sloped',
      'sloped',
      'green',
      'water-tanks',
    ];
  } else if (city === 'gilan') {
    choices = ['sloped', 'sloped', 'sloped', 'sloped', 'sloped', 'green', 'green', 'solar'];
  } else if (city === 'yazd') {
    choices = [
      'flat',
      'flat',
      'flat',
      'flat',
      'flat',
      'flat',
      'flat',
      'water-tanks',
      'water-tanks',
      'solar',
    ];
  } else if (floors >= 20 || archetype === 'tower') {
    choices = ['helipad', 'helipad', 'mechanical', 'mechanical', 'solar', 'green'];
  } else if (district === 'luxury') {
    choices = ['roof-garden', 'roof-garden', 'green', 'solar', 'sloped'];
  } else {
    choices = ['flat', 'mechanical', 'mechanical', 'solar', 'green', 'satellite'];
  }
  return choose(choices, mixHash(salt, 0x4f91));
}

/** Deterministic city-weighted façade vocabulary used by the pixel renderer. */
export function selectFacadeStyle(
  city: CityId,
  district: PlannedUrbanBlock['district'],
  archetype: PlannedBuildingArchetype,
  salt: number,
): string {
  const house = archetype === 'tiny-house' || archetype === 'small-house';
  let windows: readonly string[];
  let balconies: readonly string[];
  let entrances: readonly string[];
  let details: readonly string[];
  if (city === 'yazd') {
    windows = ['arched', 'arched', 'arched', 'arched', 'arched', 'paired', 'bay'];
    balconies = ['none', 'none', 'none', 'recessed', 'recessed'];
    entrances = ['arcade', 'arcade', 'portico', 'portico', 'double', 'single'];
    details = ['stone-trim', 'stone-trim', 'columns', 'awning', 'canopy'];
  } else if (city === 'gilan' && house) {
    windows = ['paired', 'paired', 'bay', 'bay', 'vertical'];
    balconies = ['wraparound', 'wraparound', 'wraparound', 'projecting', 'projecting', 'recessed'];
    entrances = ['portico', 'portico', 'single', 'double'];
    details = ['canopy', 'canopy', 'awning', 'awning', 'stone-trim'];
  } else if (
    city === 'tehran' &&
    (archetype === 'tower' || archetype === 'office' || archetype === 'wide-commercial')
  ) {
    windows = ['ribbon', 'ribbon', 'grid', 'grid', 'vertical', 'corner'];
    balconies = ['none', 'none', 'recessed', 'juliet'];
    entrances = ['glass-lobby', 'glass-lobby', 'double', 'arcade'];
    details = ['corner-glass', 'corner-glass', 'light-bands', 'light-bands', 'canopy'];
  } else {
    windows = ['ribbon', 'paired', 'vertical', 'bay', 'grid', 'corner', 'arched', 'shopfront'];
    balconies = ['none', 'recessed', 'projecting', 'wraparound', 'juliet'];
    entrances = ['single', 'double', 'arcade', 'portico', 'glass-lobby', 'garage'];
    details = ['columns', 'canopy', 'awning', 'corner-glass', 'light-bands', 'stone-trim'];
  }
  const window = choose(windows, mixHash(salt, 0x1021));
  const balcony = choose(balconies, mixHash(salt, 0x2043));
  const entrance = choose(entrances, mixHash(salt, 0x4087));
  const detailA = choose(details, mixHash(salt, 0x8111));
  const detailB = choose(details, mixHash(salt, 0x1223));
  return `${city}:${district}:${archetype}:windows-${window}:balcony-${balcony}:entrance-${entrance}:${detailA}:${detailB}`;
}

/** Build one complete, reproducible architectural proposal for a city block. */
export function composeBlockArchitecture(
  block: PlannedUrbanBlock,
  seed: number,
): PlannedBlockComposition {
  const blockSeed = hashString(`${seed}:${block.id}:${block.signature}:${block.generationAttempt}`);
  const topologyVariant = topologyVariantFor(block, blockSeed);
  const template = templateFor(block, topologyVariant);
  const drafts = OPEN_PROGRAMS.has(block.program)
    ? []
    : lotDrafts(block, blockSeed, topologyVariant);
  const materializedLots: PlannedBuildingLot[] = [];

  for (let index = 0; index < drafts.length; index++) {
    const draft = drafts[index];
    if (!draft || draft.bounds.width < 2 || draft.bounds.height < 2) continue;
    const salt = mixHash(blockSeed, index + 1, draft.bounds.x, draft.bounds.y);
    const lot = materializeLot(block, draft, index, salt);
    if (lot) materializedLots.push(lot);
  }

  const lots = routeLotEntrances(block, materializedLots, blockSeed);
  const spaces = [makeUrbanSpace(block, lots, blockSeed)];
  const signature = [
    block.id,
    template,
    lots.map((lot) => lot.signature).join('|'),
    spaces.map((space) => space.signature).join('|'),
  ].join('::');

  return {
    blockId: block.id,
    cityId: block.cityId,
    district: block.district,
    program: block.program,
    template,
    lots,
    spaces,
    coverageTarget: block.densityTarget,
    signature,
  };
}

/** Public for focused validation and controlled residual infill. */
export function makeBuildingFootprint(
  bounds: TileRect,
  shape: PlannedBuildingShape,
  rotation: 0 | 90 | 180 | 270,
  mirrored: boolean,
): PlannedBuildingLot['footprint'] {
  if (bounds.width < 2 || bounds.height < 2) return [];
  const canonicalWidth = rotation === 90 || rotation === 270 ? bounds.height : bounds.width;
  const canonicalHeight = rotation === 90 || rotation === 270 ? bounds.width : bounds.height;
  const cells = new Set<string>();

  for (let cy = 0; cy < canonicalHeight; cy++) {
    for (let cx = 0; cx < canonicalWidth; cx++) {
      const mx = mirrored ? canonicalWidth - 1 - cx : cx;
      if (!shapeOwnsCell(shape, mx, cy, canonicalWidth, canonicalHeight)) continue;
      const transformed = rotateCell(cx, cy, canonicalWidth, canonicalHeight, rotation);
      cells.add(`${transformed.x},${transformed.y}`);
    }
  }

  const rectangles = compressCells(cells, bounds.width, bounds.height).map((rect) => ({
    x: bounds.x + rect.x,
    y: bounds.y + rect.y,
    width: rect.width,
    height: rect.height,
  }));
  if (
    rectangles.length === 0 ||
    rectangles.some((rect) => rect.width < 2 || rect.height < 2) ||
    footprintArea(rectangles) < Math.min(4, bounds.width * bounds.height)
  ) {
    return [{ ...bounds }];
  }
  return rectangles;
}

function templateFor(block: PlannedUrbanBlock, topologyVariant: string): string {
  const program = block.program;
  let base: string;
  if (program === 'housing') {
    base =
      block.cityId === 'yazd'
        ? 'adobe-courtyard-quarter'
        : block.cityId === 'gilan'
          ? 'garden-villa-lane'
          : 'residential-frontage-row';
  } else if (program === 'apartments') base = 'apartment-courtyard-complex';
  else if (['continuous-retail', 'market', 'restaurant-row', 'shopping-center'].includes(program)) {
    base = block.cityId === 'yazd' ? 'covered-bazaar-frontage' : 'retail-street-and-service-court';
  } else if (['office-complex', 'financial-center'].includes(program)) base = 'podium-tower-plaza';
  else if (['factory', 'warehouse', 'industrial-yard', 'rail-yard'].includes(program)) {
    base = 'production-sheds-and-loading-yard';
  } else if (program === 'stadium') base = 'stadium-field-and-stands';
  else if (['school', 'university-campus'].includes(program)) base = 'education-courtyard-campus';
  else if (program === 'hospital') base = 'hospital-wings-and-emergency-approach';
  else if (['government-complex', 'police-station', 'fire-station'].includes(program)) {
    base = 'civic-forecourt-compound';
  } else if (['small-park', 'forest-park', 'playground'].includes(program)) {
    base = 'landscape-park';
  } else if (program === 'public-plaza') base = 'civic-square';
  else if (program === 'sports-center') base = 'sports-hall-and-courts';
  else if (program === 'farm-compound') base = 'farm-house-and-working-yard';
  else if (program === 'airport-facility') base = 'terminal-and-service-apron';
  else if (program === 'harbor-facility') base = 'harbor-sheds-and-quay-yard';
  else if (program === 'rail-yard') base = 'rail-depot-and-service-tracks';
  else if (program === 'military-base') base = 'secured-administration-and-logistics-yard';
  else if (program === 'construction-site') base = 'site-office-and-material-yard';
  else if (program === 'utility-site') base = 'utility-plant-and-service-yard';
  else if (program === 'parking-garage') base = 'parking-structure-and-forecourt';
  else base = 'mixed-purpose-urban-compound';
  return `${base}:${topologyVariant}`;
}

function topologyVariantFor(block: PlannedUrbanBlock, seed: number): string {
  const program = block.program;
  // Nationally reserved landmarks must read as one deliberate civic/site
  // composition. Letting the ordinary variant hash split the government
  // reservation into narrow twin wings produced a nominal landmark whose
  // primary mass was only three tiles wide.
  if (block.signature.includes('reserved-tehran-government')) return 'courtyard-anchor';
  if (block.signature.includes('reserved-yazd-mosque')) return 'courtyard-anchor';
  let variants: readonly string[];
  if (program === 'housing') {
    variants =
      block.cityId === 'gilan'
        ? [
            'garden-pavilions',
            'garden-pavilions',
            'deep-lot-pairs',
            'frontage-row',
            'staggered-homesteads',
          ]
        : block.cityId === 'yazd'
          ? [
              'courtyard-clusters',
              'courtyard-clusters',
              'deep-lot-pairs',
              'double-row',
              'frontage-row',
            ]
          : [
              'frontage-row',
              'double-row',
              'garden-pavilions',
              'courtyard-clusters',
              'deep-lot-pairs',
            ];
  } else if (program === 'apartments') {
    variants = ['courtyard-anchor', 'paired-wings', 'front-rear-bars', 'three-slab-campus'];
  } else if (
    ['continuous-retail', 'market', 'restaurant-row', 'shopping-center'].includes(program)
  ) {
    variants = [
      'continuous-arcade',
      'split-shopfronts',
      'gapped-pavilions',
      'corner-anchor',
      'deep-bazaar-spine',
    ];
  } else if (['office-complex', 'financial-center'].includes(program)) {
    variants = ['landmark-podium', 'twin-wings', 'office-court', 'front-rear-campus'];
  } else if (['factory', 'warehouse', 'industrial-yard', 'utility-site'].includes(program)) {
    variants = [
      'shed-and-office',
      'parallel-sheds',
      'l-yard',
      'front-rear-works',
      'three-bay-works',
    ];
  } else if (
    [
      'school',
      'university-campus',
      'hospital',
      'government-complex',
      'police-station',
      'fire-station',
      'sports-center',
      'hotel',
      'parking-garage',
    ].includes(program)
  ) {
    variants = [
      'formal-forecourt',
      'courtyard-anchor',
      'twin-wings',
      'cross-axis',
      'pavilion-campus',
    ];
  } else {
    variants = ['canonical'];
  }
  return choose(variants, mixHash(seed, 0x51a7));
}

function lotDrafts(block: PlannedUrbanBlock, seed: number, topologyVariant: string): LotDraft[] {
  const inset = setbackForProgram(block.program, block.cityId);
  const inner = insetRect(block.bounds, inset);
  if (inner.width < 2 || inner.height < 2) return [];
  const program = block.program;

  if (program === 'housing') return housingDrafts(block, inner, seed, topologyVariant);
  if (program === 'apartments') return apartmentDrafts(inner, seed, topologyVariant);
  if (['continuous-retail', 'market', 'restaurant-row', 'shopping-center'].includes(program)) {
    return retailDrafts(block, inner, seed, topologyVariant);
  }
  if (['office-complex', 'financial-center'].includes(program)) {
    return officeDrafts(block, inner, seed, topologyVariant);
  }
  if (['factory', 'warehouse', 'industrial-yard', 'utility-site'].includes(program)) {
    return industrialDrafts(block, inner, seed, topologyVariant);
  }
  if (program === 'stadium') return stadiumDrafts(inner);
  if (program === 'farm-compound') return farmDrafts(inner, seed);
  if (program === 'military-base') return militaryDrafts(inner, seed);
  if (program === 'construction-site') return constructionDrafts(inner, seed);
  if (program === 'airport-facility') return airportDrafts(inner, seed);
  if (program === 'harbor-facility') return harborDrafts(inner, seed);
  if (program === 'rail-yard') return railDrafts(inner, seed);
  return civicDrafts(block, inner, seed, topologyVariant);
}

function apartmentDrafts(inner: TileRect, seed: number, topologyVariant: string): LotDraft[] {
  // Thin graph-cut parcels cannot carry meaningful wings plus a separating
  // court. Keep their exact inner envelope as one real bar so the zoning
  // contract is achievable without overlapping 2-tile fallback drafts.
  if (inner.width < 5 || inner.height < 5) {
    return [
      {
        bounds: { ...inner },
        kind: 'apartment',
        shape: 'rectangle',
        primary: true,
        frontage: 'north',
      },
    ];
  }
  switch (topologyVariant) {
    case 'paired-wings':
      return splitDrafts(inner, 2, 'apartment', ['paired'], seed, 1);
    case 'front-rear-bars':
      return splitRowDrafts(inner, 2, 'apartment', ['rectangle'], seed, 1);
    case 'three-slab-campus':
      return splitDrafts(
        inner,
        inner.width >= 24 ? 3 : 2,
        'apartment',
        ['rectangle'],
        seed,
        1,
      );
    case 'courtyard-anchor':
    default:
      return [
        {
          bounds: { ...inner },
          kind: 'apartment',
          shape: choose(['courtyard', 'u'], seed),
          primary: true,
          frontage: 'north',
        },
      ];
  }
}

function retailDrafts(
  block: PlannedUrbanBlock,
  inner: TileRect,
  seed: number,
  topologyVariant: string,
): LotDraft[] {
  const kind: PlannedBuildingKind = block.program === 'market' ? 'market' : 'retail';
  // Very narrow commercial parcels are continuous party-wall street bars.
  // Preserve one full-length access lane on the long edge instead of slicing
  // the frontage into modules that cannot satisfy the retail density contract.
  if (block.bounds.width <= 6) {
    return [
      {
        bounds: {
          x: block.bounds.x,
          y: block.bounds.y,
          width: block.bounds.width - 1,
          height: block.bounds.height,
        },
        kind,
        shape: 'arcade',
        primary: true,
        frontage: 'east',
      },
    ];
  }
  if (block.bounds.height <= 6) {
    return [
      {
        bounds: {
          x: block.bounds.x,
          y: block.bounds.y,
          width: block.bounds.width,
          height: block.bounds.height - 1,
        },
        kind,
        shape: 'arcade',
        primary: true,
        frontage: 'south',
      },
    ];
  }
  // Commercial density is carried by authored street walls, not by random
  // residual sheds. Each variant therefore supplies enough primary mass to
  // satisfy the 0.58 retail contract even when a road fragment rejects one
  // optional pavilion at runtime.
  const maximumModules = Math.max(1, Math.floor(inner.width / 2));
  const moduleCount = Math.min(
    maximumModules,
    Math.min(8, inner.width <= 8 ? Math.floor(inner.width / 2) : Math.ceil(inner.width / 3)),
  );
  const splitCount = inner.width <= 8 ? moduleCount : Math.max(2, moduleCount - 1);
  const pavilionCount = Math.min(
    maximumModules,
    clamp(Math.ceil(inner.width / 8), 2, 4),
  );
  const maximumDepth = Math.max(2, inner.height - 1);
  const depthFor = (ratio: number): number =>
    clamp(Math.ceil(inner.height * ratio), 2, maximumDepth);
  const normalDepth = depthFor(0.84);
  const anchorDepth = depthFor(0.9);
  const pavilionDepth = depthFor(0.94);
  const deepDepth = maximumDepth;
  switch (topologyVariant) {
    case 'continuous-arcade':
      return splitDrafts(
        { ...inner, height: normalDepth },
        moduleCount,
        kind,
        ['rectangle'],
        seed,
        0,
      );
    case 'gapped-pavilions':
      return splitDrafts(
        { ...inner, height: pavilionDepth },
        pavilionCount,
        kind,
        ['rectangle'],
        seed,
        0,
      ).map((draft, index) => ({
        ...draft,
        shape: index === 0 ? 'arcade' : draft.shape,
      }));
    case 'corner-anchor':
      return splitDrafts(
        { ...inner, height: anchorDepth },
        splitCount,
        kind,
        ['rectangle'],
        seed,
        0,
      );
    case 'deep-bazaar-spine':
      return splitDrafts(
        { ...inner, height: deepDepth },
        moduleCount,
        kind,
        ['rectangle'],
        seed,
        0,
      );
    case 'split-shopfronts':
    default:
      return splitDrafts(
        { ...inner, height: normalDepth },
        splitCount,
        kind,
        ['rectangle'],
        seed,
        0,
      );
  }
}

function officeDrafts(
  block: PlannedUrbanBlock,
  inner: TileRect,
  seed: number,
  topologyVariant: string,
): LotDraft[] {
  const primaryKind: PlannedBuildingKind =
    block.program === 'financial-center' && inner.width >= 9 && inner.height >= 9
      ? 'tower'
      : 'office';
  if (inner.width < 5 || inner.height < 5) {
    return [
      {
        bounds: { ...inner },
        kind: primaryKind,
        shape: 'rectangle',
        primary: true,
        frontage: inner.width < inner.height ? 'north' : 'west',
      },
    ];
  }
  const primaryShape: PlannedBuildingShape =
    primaryKind === 'tower'
      ? 'podium-tower'
      : choose(['courtyard', 'paired', 'podium-tower'], seed);
  switch (topologyVariant) {
    case 'twin-wings':
      return splitDrafts(
        inner,
        2,
        primaryKind,
        primaryKind === 'tower' ? ['podium-tower'] : ['rectangle', 'paired'],
        seed,
        1,
      ).map((draft, index) => ({ ...draft, kind: index === 0 ? primaryKind : 'office' }));
    case 'office-court':
      return [
        {
          bounds: { ...inner },
          kind: primaryKind,
          shape: primaryKind === 'tower' ? 'podium-tower' : 'courtyard',
          primary: true,
          frontage: 'north',
        },
      ];
    case 'front-rear-campus':
      return splitRowDrafts(
        inner,
        2,
        primaryKind,
        primaryKind === 'tower' ? ['podium-tower'] : ['rectangle', 'paired'],
        seed,
        1,
      ).map((draft, index) => ({ ...draft, kind: index === 0 ? primaryKind : 'office' }));
    case 'landmark-podium':
    default:
      return [
        {
          bounds: trimRect(inner, 0, Math.max(0, Math.floor(inner.height * 0.16)), 0, 0),
          kind: primaryKind,
          shape: primaryShape,
          primary: true,
          frontage: 'north',
        },
      ];
  }
}

function industrialDrafts(
  block: PlannedUrbanBlock,
  inner: TileRect,
  seed: number,
  topologyVariant: string,
): LotDraft[] {
  const mainKind: PlannedBuildingKind =
    block.program === 'warehouse'
      ? 'warehouse'
      : block.program === 'utility-site'
        ? 'utility'
        : 'factory';
  const secondaryKind: PlannedBuildingKind =
    block.program === 'utility-site' ? 'utility' : 'office';
  const shedShape: PlannedBuildingShape =
    inner.width >= 12 && inner.height >= 8 ? 'shed-cluster' : 'rectangle';
  if (inner.width < 5 || inner.height < 5) {
    return [
      {
        bounds: { ...inner },
        kind: mainKind,
        shape: 'rectangle',
        primary: true,
        frontage: inner.width < inner.height ? 'north' : 'west',
      },
    ];
  }
  switch (topologyVariant) {
    case 'parallel-sheds':
      return splitDrafts(inner, 2, mainKind, [shedShape, 'rectangle'], seed, 1);
    case 'l-yard': {
      const mainWidth = clamp(Math.floor(inner.width * 0.64), 3, inner.width);
      const annexWidth = inner.width - mainWidth - 1;
      const drafts: LotDraft[] = [
        {
          bounds: {
            x: inner.x,
            y: inner.y,
            width: mainWidth,
            height: Math.max(3, inner.height - Math.floor(inner.height * 0.15)),
          },
          kind: mainKind,
          shape: shedShape,
          primary: true,
          frontage: 'north',
        },
      ];
      if (annexWidth >= 3) {
        drafts.push({
          bounds: {
            x: inner.x + mainWidth + 1,
            y: inner.y + Math.floor(inner.height * 0.45),
            width: annexWidth,
            height: Math.max(3, Math.ceil(inner.height * 0.55)),
          },
          kind: secondaryKind,
          shape: 'rectangle',
          primary: false,
          frontage: 'east',
        });
      }
      return drafts;
    }
    case 'front-rear-works':
      return splitRowDrafts(inner, 2, mainKind, [shedShape, 'rectangle'], seed, 1).map(
        (draft, index) => ({ ...draft, kind: index === 0 ? mainKind : secondaryKind }),
      );
    case 'three-bay-works':
      return splitDrafts(
        inner,
        inner.width >= 21 ? 3 : 2,
        mainKind,
        [shedShape, 'rectangle'],
        seed,
        1,
      );
    case 'shed-and-office':
    default: {
      const hasOffice = inner.width >= 16 && inner.height >= 10;
      const officeWidth = hasOffice ? Math.max(3, Math.floor(inner.width * 0.25)) : 0;
      const serviceGap = hasOffice ? 1 : 0;
      const mainWidth = inner.width - officeWidth - serviceGap;
      const drafts: LotDraft[] = [
        {
          bounds: {
            x: inner.x,
            y: inner.y,
            width: mainWidth,
            height: Math.max(2, inner.height - Math.floor(inner.height * 0.2)),
          },
          kind: mainKind,
          shape: shedShape,
          primary: true,
          frontage: 'north',
        },
      ];
      if (hasOffice) {
        drafts.push({
          bounds: {
            x: inner.x + mainWidth + serviceGap,
            y: inner.y,
            width: officeWidth,
            height: Math.max(3, Math.floor(inner.height * 0.42)),
          },
          kind: secondaryKind,
          shape: 'rectangle',
          primary: false,
          frontage: 'east',
        });
      }
      return drafts;
    }
  }
}

function stadiumDrafts(inner: TileRect): LotDraft[] {
  const sideDepth = clamp(
    Math.floor(inner.width * 0.14),
    2,
    Math.max(2, Math.floor((inner.width - 2) / 3)),
  );
  const endDepth = clamp(
    Math.floor(inner.height * 0.2),
    2,
    Math.max(2, Math.floor((inner.height - 2) / 3)),
  );
  const fieldWidth = inner.width - sideDepth * 2;
  const fieldHeight = inner.height - endDepth * 2;
  if (fieldWidth < 2 || fieldHeight < 2) {
    return [
      {
        bounds: { x: inner.x, y: inner.y, width: inner.width, height: endDepth },
        kind: 'stadium',
        shape: 'rectangle',
        primary: true,
        frontage: 'north',
      },
      {
        bounds: {
          x: inner.x,
          y: inner.y + inner.height - endDepth,
          width: inner.width,
          height: endDepth,
        },
        kind: 'stadium',
        shape: 'rectangle',
        primary: false,
        frontage: 'south',
      },
    ];
  }
  return [
    {
      bounds: { x: inner.x + sideDepth, y: inner.y, width: fieldWidth, height: endDepth },
      kind: 'stadium',
      shape: 'rectangle',
      primary: true,
      frontage: 'north',
    },
    {
      bounds: {
        x: inner.x + sideDepth,
        y: inner.y + inner.height - endDepth,
        width: fieldWidth,
        height: endDepth,
      },
      kind: 'stadium',
      shape: 'rectangle',
      primary: false,
      frontage: 'south',
    },
    {
      bounds: { x: inner.x, y: inner.y + endDepth, width: sideDepth, height: fieldHeight },
      kind: 'stadium',
      shape: 'rectangle',
      primary: false,
      frontage: 'west',
    },
    {
      bounds: {
        x: inner.x + inner.width - sideDepth,
        y: inner.y + endDepth,
        width: sideDepth,
        height: fieldHeight,
      },
      kind: 'stadium',
      shape: 'rectangle',
      primary: false,
      frontage: 'east',
    },
  ];
}

function farmDrafts(inner: TileRect, seed: number): LotDraft[] {
  const houseWidth = clamp(Math.floor(inner.width * 0.38), 3, Math.max(3, inner.width - 4));
  const houseHeight = clamp(Math.floor(inner.height * 0.5), 3, inner.height);
  const drafts: LotDraft[] = [
    {
      bounds: { x: inner.x, y: inner.y, width: houseWidth, height: houseHeight },
      kind: 'house',
      shape: choose(['corner', 'l', 'rectangle'], seed),
      primary: true,
      frontage: 'north',
    },
  ];
  const shedWidth = inner.width - houseWidth - 1;
  const shedHeight = clamp(Math.floor(inner.height * 0.4), 3, inner.height);
  if (shedWidth >= 3 && inner.height >= 6) {
    drafts.push({
      bounds: {
        x: inner.x + houseWidth + 1,
        y: inner.y + inner.height - shedHeight,
        width: shedWidth,
        height: shedHeight,
      },
      kind: 'warehouse',
      shape: shedWidth >= 8 && shedHeight >= 8 ? 'shed-cluster' : 'rectangle',
      primary: false,
      frontage: 'south',
    });
  }
  return drafts;
}

function militaryDrafts(inner: TileRect, seed: number): LotDraft[] {
  const adminWidth = clamp(Math.floor(inner.width * 0.58), 4, inner.width);
  const adminHeight = clamp(Math.floor(inner.height * 0.4), 3, inner.height);
  const drafts: LotDraft[] = [
    {
      bounds: { x: inner.x, y: inner.y, width: adminWidth, height: adminHeight },
      kind: 'government',
      shape: choose(['u', 't', 'l'], seed),
      primary: true,
      frontage: 'north',
    },
  ];
  const logisticsWidth = clamp(Math.floor(inner.width * 0.34), 3, inner.width);
  const logisticsHeight = clamp(Math.floor(inner.height * 0.34), 3, inner.height);
  if (inner.width - logisticsWidth >= 3 && inner.height - logisticsHeight >= 3) {
    drafts.push({
      bounds: {
        x: inner.x + inner.width - logisticsWidth,
        y: inner.y + inner.height - logisticsHeight,
        width: logisticsWidth,
        height: logisticsHeight,
      },
      kind: 'warehouse',
      shape: 'rectangle',
      primary: false,
      frontage: 'south',
    });
  }
  return drafts;
}

function constructionDrafts(inner: TileRect, seed: number): LotDraft[] {
  const officeWidth = clamp(Math.floor(inner.width * 0.36), 3, inner.width);
  const officeHeight = clamp(Math.floor(inner.height * 0.34), 3, inner.height);
  const drafts: LotDraft[] = [
    {
      bounds: { x: inner.x, y: inner.y, width: officeWidth, height: officeHeight },
      kind: 'utility',
      shape: choose(['rectangle', 'corner'], seed),
      primary: true,
      frontage: 'north',
    },
  ];
  const storeWidth = clamp(Math.floor(inner.width * 0.48), 3, inner.width);
  const storeHeight = clamp(Math.floor(inner.height * 0.32), 3, inner.height);
  if (inner.width - storeWidth >= 2 && inner.height - storeHeight >= 2) {
    drafts.push({
      bounds: {
        x: inner.x + inner.width - storeWidth,
        y: inner.y + inner.height - storeHeight,
        width: storeWidth,
        height: storeHeight,
      },
      kind: 'warehouse',
      shape: 'rectangle',
      primary: false,
      frontage: 'south',
    });
  }
  return drafts;
}

function airportDrafts(inner: TileRect, seed: number): LotDraft[] {
  const terminalDepth = clamp(Math.floor(inner.height * 0.38), 3, Math.max(3, inner.height - 3));
  const drafts: LotDraft[] = [
    {
      bounds: { x: inner.x, y: inner.y, width: inner.width, height: terminalDepth },
      kind: 'terminal',
      shape: choose(['arcade', 't', 'rectangle'], seed),
      primary: true,
      frontage: 'north',
    },
  ];
  const serviceWidth = clamp(Math.floor(inner.width * 0.28), 3, inner.width);
  const serviceHeight = clamp(Math.floor(inner.height * 0.28), 3, inner.height);
  if (inner.width - serviceWidth >= 3 && inner.height - terminalDepth - serviceHeight >= 1) {
    drafts.push({
      bounds: {
        x: inner.x + inner.width - serviceWidth,
        y: inner.y + inner.height - serviceHeight,
        width: serviceWidth,
        height: serviceHeight,
      },
      kind: 'warehouse',
      shape: 'rectangle',
      primary: false,
      frontage: 'south',
    });
  }
  return drafts;
}

function harborDrafts(inner: TileRect, seed: number): LotDraft[] {
  const shedWidth = clamp(Math.floor(inner.width * 0.68), 4, inner.width);
  const shedHeight = clamp(Math.floor(inner.height * 0.42), 3, inner.height);
  const drafts: LotDraft[] = [
    {
      bounds: { x: inner.x, y: inner.y, width: shedWidth, height: shedHeight },
      kind: 'warehouse',
      shape: choose(['shed-cluster', 'rectangle'], seed),
      primary: true,
      frontage: 'north',
    },
  ];
  const officeWidth = clamp(Math.floor(inner.width * 0.26), 3, inner.width);
  const officeHeight = clamp(Math.floor(inner.height * 0.32), 3, inner.height);
  if (inner.width - officeWidth >= 3 && inner.height - officeHeight >= 3) {
    drafts.push({
      bounds: {
        x: inner.x + inner.width - officeWidth,
        y: inner.y + inner.height - officeHeight,
        width: officeWidth,
        height: officeHeight,
      },
      kind: 'office',
      shape: 'rectangle',
      primary: false,
      frontage: 'east',
    });
  }
  return drafts;
}

function railDrafts(inner: TileRect, seed: number): LotDraft[] {
  const depotHeight = clamp(Math.floor(inner.height * 0.34), 3, inner.height);
  const depotWidth = clamp(Math.floor(inner.width * 0.72), 4, inner.width);
  const drafts: LotDraft[] = [
    {
      bounds: { x: inner.x, y: inner.y, width: depotWidth, height: depotHeight },
      kind: 'warehouse',
      shape: choose(['shed-cluster', 'rectangle'], seed),
      primary: true,
      frontage: 'north',
    },
  ];
  const serviceWidth = clamp(Math.floor(inner.width * 0.24), 3, inner.width);
  const serviceHeight = clamp(Math.floor(inner.height * 0.28), 3, inner.height);
  if (inner.width - serviceWidth >= 3 && inner.height - serviceHeight >= 3) {
    drafts.push({
      bounds: {
        x: inner.x + inner.width - serviceWidth,
        y: inner.y + inner.height - serviceHeight,
        width: serviceWidth,
        height: serviceHeight,
      },
      kind: 'utility',
      shape: 'rectangle',
      primary: false,
      frontage: 'south',
    });
  }
  return drafts;
}

function civicDrafts(
  block: PlannedUrbanBlock,
  inner: TileRect,
  seed: number,
  topologyVariant: string,
): LotDraft[] {
  const program = block.program;
  const kind = kindForProgram(block);
  const defaultShape: PlannedBuildingShape =
    program === 'parking-garage'
      ? 'rectangle'
      : program === 'sports-center'
        ? 't'
        : program === 'hotel'
          ? 'l'
          : program === 'school' || program === 'university-campus'
            ? choose(['u', 'courtyard'], seed)
            : program === 'hospital'
              ? choose(['t', 'u'], seed)
              : program === 'government-complex'
                ? block.signature.includes('reserved-tehran-government')
                  ? 'u'
                  : choose(['u', 'courtyard', 't'], seed)
                : choose(['u', 't', 'l'], seed);
  if (inner.width < 5 || inner.height < 5) {
    return [
      {
        bounds: { ...inner },
        kind,
        shape: 'rectangle',
        primary: true,
        frontage: inner.width < inner.height ? 'north' : 'west',
      },
    ];
  }
  const frontCourt = clamp(Math.floor(inner.height * 0.22), 1, Math.max(1, inner.height - 3));
  const annexPrograms: readonly PlannedBlockProgram[] = [
    'school',
    'university-campus',
    'hospital',
    'government-complex',
    'police-station',
    'fire-station',
    'sports-center',
  ];
  const buildable = {
    x: inner.x,
    y: inner.y + frontCourt,
    width: inner.width,
    height: inner.height - frontCourt,
  };
  const annexKind = annexKindForProgram(program, kind);
  switch (topologyVariant) {
    case 'courtyard-anchor':
      return [
        {
          bounds: buildable,
          kind,
          shape: program === 'parking-garage' ? 'rectangle' : choose(['courtyard', 'u'], seed),
          primary: true,
          frontage: 'north',
        },
      ];
    case 'twin-wings':
      return splitDrafts(
        buildable,
        2,
        kind,
        program === 'parking-garage' ? ['rectangle'] : ['l', 'u', 'corner'],
        seed,
        1,
      ).map((draft, index) => ({ ...draft, kind: index === 0 ? kind : annexKind }));
    case 'pavilion-campus':
      return splitDrafts(
        buildable,
        buildable.width >= 24 ? 3 : 2,
        kind,
        program === 'parking-garage' ? ['rectangle'] : ['corner', 'l', 'rectangle'],
        seed,
        1,
      ).map((draft, index) => ({ ...draft, kind: index === 0 ? kind : annexKind }));
    case 'cross-axis': {
      const mainWidth = clamp(Math.floor(buildable.width * 0.7), 3, buildable.width);
      const annexWidth = buildable.width - mainWidth - 1;
      const drafts: LotDraft[] = [
        {
          bounds: { ...buildable, width: mainWidth },
          kind,
          shape: program === 'parking-garage' ? 'rectangle' : 't',
          primary: true,
          frontage: 'north',
        },
      ];
      if (annexWidth >= 3) {
        drafts.push({
          bounds: {
            x: buildable.x + mainWidth + 1,
            y: buildable.y + Math.floor(buildable.height * 0.35),
            width: annexWidth,
            height: Math.max(3, Math.ceil(buildable.height * 0.65)),
          },
          kind: annexKind,
          shape: 'rectangle',
          primary: false,
          frontage: 'east',
        });
      }
      return drafts;
    }
    case 'formal-forecourt':
    default: {
      const hasAnnex =
        annexPrograms.includes(program) && buildable.width >= 16 && buildable.height >= 7;
      const annexWidth = hasAnnex ? clamp(Math.floor(buildable.width * 0.24), 4, 8) : 0;
      const gap = hasAnnex ? 1 : 0;
      const mainWidth = buildable.width - annexWidth - gap;
      const drafts: LotDraft[] = [
        {
          bounds: { ...buildable, width: mainWidth },
          kind,
          shape: defaultShape,
          primary: true,
          frontage: 'north',
        },
      ];
      if (hasAnnex) {
        const annexHeight = clamp(Math.floor(buildable.height * 0.42), 3, buildable.height);
        drafts.push({
          bounds: {
            x: buildable.x + mainWidth + gap,
            y: buildable.y + buildable.height - annexHeight,
            width: annexWidth,
            height: annexHeight,
          },
          kind: annexKind,
          shape: 'rectangle',
          primary: false,
          frontage: 'east',
        });
      }
      return drafts;
    }
  }
}

function annexKindForProgram(
  program: PlannedBlockProgram,
  primaryKind: PlannedBuildingKind,
): PlannedBuildingKind {
  if (program === 'government-complex') return 'office';
  if (program === 'fire-station' || program === 'sports-center') return 'utility';
  return primaryKind;
}

function housingDrafts(
  block: PlannedUrbanBlock,
  inner: TileRect,
  seed: number,
  topologyVariant: string,
): LotDraft[] {
  const baseColumns = clamp(
    Math.floor(inner.width / (block.cityId === 'gilan' ? 7 : block.cityId === 'yazd' ? 8 : 6)),
    1,
    4,
  );
  let columns = baseColumns;
  let rows = 1;
  let gap = block.cityId === 'yazd' ? 0 : 1;
  switch (topologyVariant) {
    case 'double-row':
      rows = inner.height >= 14 ? 2 : 1;
      break;
    case 'garden-pavilions':
      columns = Math.min(3, Math.max(1, baseColumns - 1));
      rows = inner.height >= 20 ? 2 : 1;
      gap = block.cityId === 'gilan' ? 2 : 1;
      break;
    case 'courtyard-clusters':
      columns = Math.min(3, baseColumns);
      rows = 1;
      gap = block.cityId === 'yazd' ? 0 : 1;
      break;
    case 'deep-lot-pairs':
      columns = Math.min(2, baseColumns);
      rows = 1;
      gap = block.cityId === 'gilan' ? 2 : 1;
      break;
    case 'staggered-homesteads':
      columns = Math.min(3, baseColumns);
      rows = inner.height >= 18 ? 2 : 1;
      gap = 2;
      break;
  }
  const drafts: LotDraft[] = [];
  for (let row = 0; row < rows; row++) {
    const y0 = inner.y + Math.floor((row * inner.height) / rows);
    const y1 = inner.y + Math.floor(((row + 1) * inner.height) / rows);
    for (let column = 0; column < columns; column++) {
      const x0 = inner.x + Math.floor((column * inner.width) / columns);
      const x1 = inner.x + Math.floor(((column + 1) * inner.width) / columns);
      const rect = {
        x: x0,
        y: y0,
        width: Math.max(2, x1 - x0 - gap),
        height: Math.max(2, y1 - y0 - gap),
      };
      const kind: PlannedBuildingKind =
        block.cityId === 'gilan'
          ? positiveMod(column + row + seed, 3) === 0
            ? 'villa'
            : 'house'
          : block.cityId === 'tehran' && columns <= 2 && rect.width >= 7
            ? 'apartment'
            : block.district === 'luxury'
              ? 'villa'
              : 'house';
      const shapes: readonly PlannedBuildingShape[] =
        block.cityId === 'yazd'
          ? [
              'courtyard',
              'courtyard',
              'courtyard',
              'courtyard',
              'courtyard',
              'courtyard',
              'courtyard',
              'u',
              'u',
              'corner',
            ]
          : block.cityId === 'gilan'
            ? ['rectangle', 'rectangle', 'l', 'corner', 't']
            : ['l', 't', 'paired', 'corner'];
      drafts.push({
        bounds: rect,
        kind,
        shape: choose(shapes, seed + row * 17 + column * 31),
        primary: row === 0 && column === 0,
      });
    }
  }
  return drafts;
}

function splitDrafts(
  bounds: TileRect,
  count: number,
  kind: PlannedBuildingKind,
  shapes: readonly PlannedBuildingShape[],
  seed: number,
  gap = 1,
): LotDraft[] {
  const drafts: LotDraft[] = [];
  for (let index = 0; index < count; index++) {
    const x0 = bounds.x + Math.floor((index * bounds.width) / count);
    const x1 = bounds.x + Math.floor(((index + 1) * bounds.width) / count);
    drafts.push({
      bounds: {
        x: x0,
        y: bounds.y,
        width: Math.max(2, x1 - x0 - (index < count - 1 ? gap : 0)),
        height: bounds.height,
      },
      kind,
      shape: choose(shapes, seed + index * 43),
      primary: index === 0,
    });
  }
  return drafts;
}

function splitRowDrafts(
  bounds: TileRect,
  count: number,
  kind: PlannedBuildingKind,
  shapes: readonly PlannedBuildingShape[],
  seed: number,
  gap = 1,
): LotDraft[] {
  const drafts: LotDraft[] = [];
  for (let index = 0; index < count; index++) {
    const y0 = bounds.y + Math.floor((index * bounds.height) / count);
    const y1 = bounds.y + Math.floor(((index + 1) * bounds.height) / count);
    drafts.push({
      bounds: {
        x: bounds.x,
        y: y0,
        width: bounds.width,
        height: Math.max(2, y1 - y0 - (index < count - 1 ? gap : 0)),
      },
      kind,
      shape: choose(shapes, seed + index * 47),
      primary: index === 0,
      frontage: index === 0 ? 'north' : index === count - 1 ? 'south' : 'east',
    });
  }
  return drafts;
}

function materializeLot(
  block: PlannedUrbanBlock,
  draft: LotDraft,
  index: number,
  seed: number,
): PlannedBuildingLot | null {
  const rotation = ([0, 90, 180, 270] as const)[positiveMod(seed >>> 3, 4)] ?? 0;
  const mirrored = (seed & 0x10) !== 0;
  let shape = supportedShape(draft.shape, draft.bounds) ? draft.shape : 'rectangle';
  let footprint = makeBuildingFootprint(draft.bounds, shape, rotation, mirrored);
  if (footprint.length === 0) return null;
  if (shape !== 'rectangle' && footprint.length === 1 && sameRect(footprint[0], draft.bounds)) {
    shape = 'rectangle';
  }
  const lotId = `${block.id}:lot:${index}`;
  const frontage = draft.frontage ?? frontageFor(draft.bounds, block.bounds, seed);
  const primaryRequest = entranceRequestsFor(block.program, draft.kind, frontage)[0] ?? {
    kind: 'main' as const,
    primary: true,
    preferred: frontage,
  };
  const entrance = makeEntrance(lotId, footprint, block.bounds, primaryRequest, 0, seed);
  if (!entrance) {
    shape = 'rectangle';
    footprint = [{ ...draft.bounds }];
  }
  const fallbackRequest = { ...primaryRequest, preferred: 'north' as const };
  const finalEntrance =
    entrance ?? makeEntrance(lotId, footprint, block.bounds, fallbackRequest, 0, seed);
  if (!finalEntrance) return null;
  const floors = floorsFor(block, draft.kind, draft.bounds, seed);
  const size = sizeFor(footprint);
  const roofAssets = makeRoofAssets(lotId, block, draft.kind, footprint, seed);
  const signature = [
    lotId,
    draft.kind,
    shape,
    size,
    `${footprintArea(footprint)}t`,
    floors,
    rotation,
    mirrored ? 'm' : 'n',
    roofAssets.map((asset) => asset.kind).join(','),
  ].join(':');
  return {
    id: lotId,
    blockId: block.id,
    cityId: block.cityId,
    district: block.district,
    program: block.program,
    bounds: boundsOf(footprint),
    shape,
    size,
    kind: draft.kind,
    floors,
    setbackTiles: setbackForProgram(block.program, block.cityId),
    frontage: finalEntrance.facing,
    rotation,
    mirrored,
    primary: draft.primary,
    footprint,
    entrances: [finalEntrance],
    roofAssets,
    signature,
  };
}

function kindForProgram(block: PlannedUrbanBlock): PlannedBuildingKind {
  switch (block.program) {
    case 'school':
      return 'school';
    case 'university-campus':
      return 'university';
    case 'hospital':
      return 'hospital';
    case 'government-complex':
      return 'government';
    case 'police-station':
      return 'police';
    case 'fire-station':
      return 'fire-station';
    case 'sports-center':
      return 'sports-hall';
    case 'stadium':
      return 'stadium';
    case 'parking-garage':
      return 'parking-structure';
    case 'hotel':
      return 'hotel';
    case 'airport-facility':
      return 'terminal';
    case 'harbor-facility':
    case 'rail-yard':
      return 'warehouse';
    case 'military-base':
      return 'government';
    case 'construction-site':
    case 'utility-site':
      return 'utility';
    case 'farm-compound':
      return 'house';
    case 'market':
      return 'market';
    case 'factory':
      return 'factory';
    case 'warehouse':
      return 'warehouse';
    default:
      return 'office';
  }
}

function floorsFor(
  block: PlannedUrbanBlock,
  kind: PlannedBuildingKind,
  bounds: TileRect,
  seed: number,
): number {
  const variance = positiveMod(seed >>> 6, 4);
  if (block.cityId === 'yazd') {
    if (kind === 'terminal' || kind === 'hotel' || kind === 'government') return 3 + (variance % 3);
    if (kind === 'house' || kind === 'villa') return 1 + (variance % 2);
    if (kind === 'apartment' || kind === 'office') return 2 + (variance % 2);
    return 1 + (variance % 3);
  }
  if (block.cityId === 'gilan') {
    if (kind === 'hotel') return 4 + variance;
    if (kind === 'apartment' || kind === 'office') return 3 + (variance % 4);
    return 1 + (variance % 3);
  }
  if (kind === 'tower') return 18 + variance * 7;
  if (kind === 'office') return 5 + variance * 2 + (block.district === 'downtown' ? 4 : 0);
  if (kind === 'apartment') return 4 + variance * 2;
  if (kind === 'factory' || kind === 'warehouse' || kind === 'stadium') return 1 + (variance % 3);
  const broad = bounds.width * bounds.height > 180 ? 1 : 0;
  return 2 + variance + broad;
}

function sizeFor(footprint: readonly TileRect[]): PlannedBuildingSize {
  const area = footprintArea(footprint);
  if (area < 36) return 'small';
  if (area < 120) return 'medium';
  if (area < 320) return 'large';
  return 'huge';
}

function routeLotEntrances(
  block: PlannedUrbanBlock,
  sourceLots: readonly PlannedBuildingLot[],
  seed: number,
): PlannedBuildingLot[] {
  let remaining = sourceLots.slice();
  while (remaining.length > 0) {
    const blocked = new Set<string>();
    for (const lot of remaining) {
      for (const key of footprintCells(lot.footprint)) blocked.add(key);
    }
    const reservedApproaches = new Set<string>();
    const reservedDoors = new Set<string>();
    const entrancesByLot = new Map<string, PlannedEntrance[]>();
    let failedIndex = -1;

    for (let index = 0; index < remaining.length; index++) {
      const lot = remaining[index]!;
      const requests = entranceRequestsFor(block.program, lot.kind, lot.frontage);
      const request = requests.find((candidate) => candidate.primary) ?? requests[0];
      if (!request) {
        failedIndex = index;
        break;
      }
      const entrance = makeEntrance(
        lot.id,
        lot.footprint,
        block.bounds,
        request,
        0,
        mixHash(seed, index + 1, 1),
        blocked,
        reservedApproaches,
        reservedDoors,
      );
      if (!entrance) {
        failedIndex = index;
        break;
      }
      entrancesByLot.set(lot.id, [entrance]);
      reserveEntrance(entrance, reservedApproaches, reservedDoors);
    }

    if (failedIndex >= 0) {
      const failedLot = remaining[failedIndex];
      let removableIndex = failedIndex;
      if (failedLot?.primary) {
        for (let index = remaining.length - 1; index >= 0; index--) {
          if (remaining[index]?.primary) continue;
          removableIndex = index;
          break;
        }
      }
      const indexToRemove = removableIndex >= 0 ? removableIndex : failedIndex;
      remaining = remaining.filter((_, index) => index !== indexToRemove);
      continue;
    }

    for (let index = 0; index < remaining.length; index++) {
      const lot = remaining[index]!;
      const requests = entranceRequestsFor(block.program, lot.kind, lot.frontage).filter(
        (request) => !request.primary,
      );
      const entrances = entrancesByLot.get(lot.id) ?? [];
      for (let requestIndex = 0; requestIndex < requests.length; requestIndex++) {
        const request = requests[requestIndex]!;
        const entrance = makeEntrance(
          lot.id,
          lot.footprint,
          block.bounds,
          request,
          entrances.length,
          mixHash(seed, index + 1, requestIndex + 2),
          blocked,
          reservedApproaches,
          reservedDoors,
        );
        if (!entrance) continue;
        entrances.push(entrance);
        reserveEntrance(entrance, reservedApproaches, reservedDoors);
      }
      entrancesByLot.set(lot.id, entrances);
    }

    return remaining.map((lot) => {
      const entrances = entrancesByLot.get(lot.id) ?? lot.entrances;
      const entranceSignature = entrances
        .map(
          (entrance) =>
            `${entrance.kind}@${entrance.position.x},${entrance.position.y}:${entrance.facing}`,
        )
        .join(',');
      return {
        ...lot,
        frontage: entrances[0]?.facing ?? lot.frontage,
        entrances,
        signature: `${lot.signature}:doors=${entranceSignature}`,
      };
    });
  }
  return [];
}

function entranceRequestsFor(
  program: PlannedBlockProgram,
  kind: PlannedBuildingKind,
  frontage: PlannedFacing,
): EntranceRequest[] {
  const rear = oppositeFacing(frontage);
  const primary = (entranceKind: PlannedEntranceKind): EntranceRequest => ({
    kind: entranceKind,
    primary: true,
    preferred: frontage,
  });
  const secondary = (entranceKind: PlannedEntranceKind): EntranceRequest => ({
    kind: entranceKind,
    primary: false,
    preferred: rear,
  });

  if (program === 'housing' || program === 'apartments') {
    return kind === 'apartment'
      ? [primary('residential'), secondary('service')]
      : [primary('residential')];
  }
  if (['continuous-retail', 'market', 'restaurant-row', 'shopping-center'].includes(program)) {
    return [primary('storefront'), secondary('service')];
  }
  if (program === 'school' || program === 'university-campus') {
    return [primary('campus'), secondary('service')];
  }
  if (program === 'hospital') return [primary('emergency'), secondary('service')];
  if (program === 'police-station') return [primary('gate'), secondary('emergency')];
  if (program === 'fire-station') return [primary('emergency'), secondary('vehicle')];
  if (program === 'parking-garage') return [primary('vehicle'), secondary('gate')];
  if (program === 'stadium' || program === 'sports-center') {
    return [primary('gate'), secondary('service')];
  }
  if (program === 'military-base') {
    return kind === 'government'
      ? [primary('gate'), secondary('service')]
      : [primary('vehicle'), secondary('service')];
  }
  if (program === 'construction-site') {
    return kind === 'utility'
      ? [primary('gate'), secondary('service')]
      : [primary('vehicle'), secondary('service')];
  }
  if (program === 'farm-compound') {
    return kind === 'house'
      ? [primary('residential'), secondary('service')]
      : [primary('vehicle'), secondary('service')];
  }
  if (program === 'airport-facility') {
    return kind === 'terminal'
      ? [primary('main'), secondary('service')]
      : [primary('vehicle'), secondary('service')];
  }
  if (
    [
      'factory',
      'warehouse',
      'industrial-yard',
      'harbor-facility',
      'rail-yard',
      'utility-site',
    ].includes(program)
  ) {
    return [primary('vehicle'), secondary('service')];
  }
  if (program === 'government-complex') return [primary('main'), secondary('gate')];
  if (program === 'hotel' || program === 'office-complex' || program === 'financial-center') {
    return [primary('main'), secondary('service')];
  }
  return [primary('main')];
}

function reserveEntrance(
  entrance: PlannedEntrance,
  approaches: Set<string>,
  doors: Set<string>,
): void {
  doors.add(`${entrance.position.x},${entrance.position.y}`);
  for (const point of entrance.accessPath) approaches.add(`${point.x},${point.y}`);
}

function makeEntrance(
  buildingId: string,
  footprint: readonly TileRect[],
  blockBounds: TileRect,
  request: EntranceRequest,
  entranceIndex: number,
  seed: number,
  blockedCells: ReadonlySet<string> = footprintCells(footprint),
  reservedApproaches: ReadonlySet<string> = new Set<string>(),
  reservedDoors: ReadonlySet<string> = new Set<string>(),
): PlannedEntrance | null {
  const cells = footprintCells(footprint);
  const facings: readonly PlannedFacing[] = [request.preferred, 'north', 'south', 'east', 'west'];
  for (const facing of Array.from(new Set(facings))) {
    const delta = facingDelta(facing);
    const candidates: PlannedTilePoint[] = [];
    for (const key of cells) {
      const [xText, yText] = key.split(',');
      const x = Number(xText);
      const y = Number(yText);
      if (cells.has(`${x + delta.x},${y + delta.y}`)) continue;
      candidates.push({ x, y });
    }
    if (candidates.length === 0) continue;
    candidates.sort((first, second) => {
      const firstScore = frontageScore(first, facing, blockBounds);
      const secondScore = frontageScore(second, facing, blockBounds);
      return firstScore - secondScore || first.x - second.x || first.y - second.y;
    });
    const startIndex = positiveMod(seed, Math.min(3, candidates.length));
    for (let offset = 0; offset < candidates.length; offset++) {
      const position = candidates[(startIndex + offset) % candidates.length];
      if (!position || reservedDoors.has(`${position.x},${position.y}`)) continue;
      const apron = { x: position.x + delta.x, y: position.y + delta.y };
      const apronKey = `${apron.x},${apron.y}`;
      if (cells.has(apronKey) || blockedCells.has(apronKey) || reservedApproaches.has(apronKey)) {
        continue;
      }
      const accessPath = pathToBlockEdge(
        apron,
        facing,
        blockBounds,
        blockedCells,
        reservedApproaches,
      );
      if (!accessPath) continue;
      return {
        id: `${buildingId}:entrance:${entranceIndex}`,
        buildingId,
        position,
        apron,
        facing,
        kind: request.kind,
        primary: request.primary,
        accessPath,
      };
    }
  }
  return null;
}

function makeRoofAssets(
  buildingId: string,
  block: PlannedUrbanBlock,
  kind: PlannedBuildingKind,
  footprint: readonly TileRect[],
  seed: number,
): PlannedRoofAsset[] {
  const cells = Array.from(footprintCells(footprint))
    .map((key) => {
      const [x, y] = key.split(',').map(Number);
      return { x: x ?? 0, y: y ?? 0 };
    })
    .sort((first, second) => first.y - second.y || first.x - second.x);
  if (cells.length === 0) return [];
  const desired =
    kind === 'mosque'
      ? clamp(Math.max(3, Math.ceil(cells.length / 65)), 1, 5)
      : clamp(Math.ceil(cells.length / 65), 1, 5);
  const sequence = roofAssetSequence(block, kind, seed);
  const assets: PlannedRoofAsset[] = [];
  const used = new Set<string>();
  for (let index = 0; index < desired; index++) {
    let cell: PlannedTilePoint | undefined;
    for (let attempt = 0; attempt < cells.length; attempt++) {
      const candidate = cells[positiveMod(seed + index * 37 + attempt * 19, cells.length)];
      if (!candidate || used.has(`${candidate.x},${candidate.y}`)) continue;
      cell = candidate;
      break;
    }
    if (!cell) break;
    used.add(`${cell.x},${cell.y}`);
    const assetKind = sequence[index % sequence.length] ?? 'roof-access';
    assets.push({
      id: `${buildingId}:roof:${index}`,
      buildingId,
      kind: assetKind,
      bounds: { x: cell.x, y: cell.y, width: 1, height: 1 },
      facing:
        (['north', 'east', 'south', 'west'] as const)[positiveMod(seed + index, 4)] ?? 'north',
      variant: positiveMod(seed >>> (index % 12), 4),
    });
  }
  return assets;
}

function roofAssetSequence(
  block: PlannedUrbanBlock,
  kind: PlannedBuildingKind,
  seed: number,
): readonly PlannedRoofAssetKind[] {
  let sequence: readonly PlannedRoofAssetKind[];
  if (kind === 'mosque') sequence = ['dome', 'minaret', 'roof-access'];
  else if (kind === 'factory' || kind === 'warehouse') {
    sequence = ['skylight', 'vent', 'solar-panels', 'hvac'];
  } else if (kind === 'tower') {
    sequence = ['hvac', 'roof-access', 'helipad', 'air-conditioner'];
  } else if (block.cityId === 'yazd') {
    sequence = ['windcatcher', 'water-tank', 'solar-panels', 'satellite-dish'];
  } else if (block.cityId === 'gilan') {
    sequence = ['chimney', 'vent', 'water-tank', 'solar-panels'];
  } else if (kind === 'retail' || kind === 'market') {
    sequence = ['billboard', 'air-conditioner', 'roof-access'];
  } else {
    sequence = ['hvac', 'water-tank', 'solar-panels', 'roof-access', 'satellite-dish'];
  }
  const offset = positiveMod(mixHash(seed, 0x7a0f), sequence.length);
  return sequence.map((_, index) => sequence[(index + offset) % sequence.length]!);
}

function makeUrbanSpace(
  block: PlannedUrbanBlock,
  lots: readonly PlannedBuildingLot[],
  seed: number,
): PlannedUrbanSpace {
  const kind = realmKindFor(block);
  const occupied = new Set<string>();
  const reservedAccess = new Set<string>();
  for (const lot of lots) {
    for (const key of footprintCells(lot.footprint)) occupied.add(key);
    for (const entrance of lot.entrances) {
      for (const point of entrance.accessPath) reservedAccess.add(`${point.x},${point.y}`);
    }
  }
  const publicCells = new Set<string>();
  const fixtureCells: PlannedTilePoint[] = [];
  for (let y = block.bounds.y; y < block.bounds.y + block.bounds.height; y++) {
    for (let x = block.bounds.x; x < block.bounds.x + block.bounds.width; x++) {
      const key = `${x},${y}`;
      if (occupied.has(key)) continue;
      publicCells.add(`${x - block.bounds.x},${y - block.bounds.y}`);
      if (!reservedAccess.has(key)) fixtureCells.push({ x, y });
    }
  }
  const footprint = compressCells(publicCells, block.bounds.width, block.bounds.height).map(
    (rect) => ({
      x: block.bounds.x + rect.x,
      y: block.bounds.y + rect.y,
      width: rect.width,
      height: rect.height,
    }),
  );
  const bounds =
    footprint.length > 0 ? boundsOf(footprint) : { ...block.bounds, width: 0, height: 0 };
  const publicWorldCells = new Set<string>();
  for (const part of footprint) {
    for (let y = part.y; y < part.y + part.height; y++) {
      for (let x = part.x; x < part.x + part.width; x++) publicWorldCells.add(`${x},${y}`);
    }
  }
  const features = groundFeaturesFor(block, kind, fixtureCells, seed);
  return {
    id: `${block.id}:realm:0`,
    blockId: block.id,
    cityId: block.cityId,
    district: block.district,
    program: block.program,
    kind,
    footprint,
    bounds,
    purposeful: true,
    accessPoints: accessPointsFor(block.bounds, publicWorldCells),
    features,
    signature: `${block.id}:${kind}:${footprint.map(rectSignature).join('|')}:${features.map((feature) => `${feature.kind}@${rectSignature(feature.bounds)}`).join(',')}:${seed}`,
  };
}

function realmKindFor(block: PlannedUrbanBlock): PlannedUrbanSpaceKind {
  switch (block.program) {
    case 'public-plaza':
      return 'public-plaza';
    case 'playground':
      return 'playground';
    case 'sports-center':
      return 'sports-court';
    case 'stadium':
      return 'stadium-field';
    case 'small-park':
      return 'park';
    case 'forest-park':
      return 'forest-pocket';
    case 'school':
    case 'university-campus':
      return 'schoolyard';
    case 'hospital':
      return 'hospital-approach';
    case 'police-station':
      return 'police-yard';
    case 'fire-station':
      return 'service-yard';
    case 'government-complex':
      return 'public-plaza';
    case 'market':
    case 'continuous-retail':
    case 'restaurant-row':
      return 'market-lane';
    case 'factory':
    case 'warehouse':
    case 'industrial-yard':
    case 'harbor-facility':
      return 'loading-yard';
    case 'airport-facility':
      return 'service-yard';
    case 'military-base':
      return 'police-yard';
    case 'parking-garage':
    case 'shopping-center':
    case 'office-complex':
    case 'financial-center':
      return 'parking-lot';
    case 'farm-compound':
      return 'farmyard';
    case 'beach-access':
      return 'beach';
    case 'cemetery':
      return 'cemetery';
    case 'rail-yard':
      return 'rail-yard';
    case 'construction-site':
      return 'construction-yard';
    case 'utility-site':
      return 'utility-yard';
    default:
      return block.cityId === 'gilan' ? 'garden' : 'courtyard';
  }
}

function groundFeaturesFor(
  block: PlannedUrbanBlock,
  kind: PlannedUrbanSpaceKind,
  openCells: readonly PlannedTilePoint[],
  seed: number,
): PlannedGroundFeature[] {
  if (openCells.length === 0) return [];
  const featureKinds = featureKindsFor(kind, block.cityId);
  const count = Math.min(
    openCells.length,
    clamp(Math.ceil((block.bounds.width * block.bounds.height) / 90), 2, 12),
  );
  const features: PlannedGroundFeature[] = [];
  const available = new Set(openCells.map((point) => `${point.x},${point.y}`));
  const used = new Set<string>();
  for (let index = 0; index < count; index++) {
    const featureKind = featureKinds[index % featureKinds.length] ?? 'path';
    const facing =
      (['north', 'east', 'south', 'west'] as const)[positiveMod(seed + index, 4)] ?? 'north';
    const sizeOptions = featureSizeOptions(featureKind, facing);
    let bounds: TileRect | null = null;
    for (const size of sizeOptions) {
      bounds = placeFeatureRect(
        openCells,
        available,
        used,
        size.width,
        size.height,
        seed + index * 53,
      );
      if (bounds) break;
    }
    if (!bounds) continue;
    for (let y = bounds.y; y < bounds.y + bounds.height; y++) {
      for (let x = bounds.x; x < bounds.x + bounds.width; x++) used.add(`${x},${y}`);
    }
    features.push({
      id: `${block.id}:feature:${index}`,
      kind: featureKind,
      bounds,
      facing,
      variant: positiveMod(seed >>> (index % 16), 4),
    });
  }
  return features;
}

function featureSizeOptions(
  kind: PlannedGroundFeatureKind,
  facing: PlannedFacing,
): ReadonlyArray<{ width: number; height: number }> {
  const vertical = facing === 'east' || facing === 'west';
  const oriented = (across: number, deep: number) =>
    vertical ? { width: deep, height: across } : { width: across, height: deep };
  switch (kind) {
    case 'path':
    case 'fence':
    case 'wall':
      return [oriented(4, 1), oriented(3, 1), oriented(2, 1)];
    case 'gate':
    case 'goal':
      return [oriented(2, 1)];
    case 'parking-bay':
    case 'police-parking':
      return [oriented(2, 3), oriented(1, 2)];
    case 'loading-bay':
    case 'ambulance-bay':
      return [oriented(2, 4), oriented(2, 3), oriented(1, 3)];
    case 'football-marking':
      return [oriented(6, 4), oriented(4, 3), { width: 3, height: 3 }];
    case 'basketball-marking':
      return [oriented(4, 3), { width: 3, height: 3 }];
    case 'stadium-stand':
      return [oriented(5, 2), oriented(3, 2)];
    case 'service-marking':
    case 'solar-array':
      return [oriented(3, 2), oriented(2, 2), oriented(2, 1)];
    case 'planter':
    case 'flower-bed':
    case 'market-stall':
    case 'bike-rack':
    case 'bench':
      return [oriented(2, 1), { width: 1, height: 1 }];
    case 'plaza-fountain':
    case 'playground-equipment':
      return [
        { width: 2, height: 2 },
        { width: 1, height: 1 },
      ];
    default:
      return [{ width: 1, height: 1 }];
  }
}

function placeFeatureRect(
  openCells: readonly PlannedTilePoint[],
  available: ReadonlySet<string>,
  used: ReadonlySet<string>,
  width: number,
  height: number,
  seed: number,
): TileRect | null {
  const start = positiveMod(seed, openCells.length);
  for (let attempt = 0; attempt < openCells.length; attempt++) {
    const point = openCells[(start + attempt * 29) % openCells.length];
    if (!point) continue;
    let fits = true;
    for (let y = point.y; y < point.y + height && fits; y++) {
      for (let x = point.x; x < point.x + width; x++) {
        const key = `${x},${y}`;
        if (!available.has(key) || used.has(key)) {
          fits = false;
          break;
        }
      }
    }
    if (fits) return { x: point.x, y: point.y, width, height };
  }
  return null;
}

function featureKindsFor(
  kind: PlannedUrbanSpaceKind,
  cityId: PlannedUrbanBlock['cityId'],
): readonly PlannedGroundFeatureKind[] {
  switch (kind) {
    case 'parking-lot':
      return ['parking-bay', 'street-light', 'tree', 'trash-bin', 'bike-rack'];
    case 'loading-yard':
    case 'service-yard':
    case 'rail-yard':
    case 'utility-yard':
      return ['loading-bay', 'service-marking', 'fence', 'gate', 'utility-box'];
    case 'public-plaza':
      return ['path', 'plaza-fountain', 'bench', 'planter', 'street-light'];
    case 'playground':
      return ['playground-equipment', 'bench', 'tree', 'fence', 'trash-bin'];
    case 'sports-court':
      return ['basketball-marking', 'fence', 'bench', 'street-light'];
    case 'football-field':
    case 'stadium-field':
      return ['football-marking', 'goal', 'stadium-stand', 'street-light'];
    case 'schoolyard':
      return ['path', 'basketball-marking', 'bench', 'tree', 'bike-rack'];
    case 'hospital-approach':
      return ['ambulance-bay', 'path', 'street-light', 'bench', 'planter'];
    case 'police-yard':
      return ['police-parking', 'gate', 'fence', 'street-light', 'service-marking'];
    case 'market-lane':
      return ['market-stall', 'path', 'trash-bin', 'street-light', 'bike-rack'];
    case 'farmyard':
      return ['fence', 'gate', 'tree', 'service-marking'];
    case 'garden':
    case 'park':
    case 'forest-pocket':
      return cityId === 'gilan'
        ? ['tree', 'flower-bed', 'path', 'bench', 'street-light']
        : ['tree', 'planter', 'path', 'bench', 'flower-bed'];
    case 'construction-yard':
      return ['fence', 'gate', 'utility-box', 'service-marking'];
    default:
      return ['path', 'tree', 'bench', 'street-light', 'trash-bin'];
  }
}

function shapeOwnsCell(
  shape: PlannedBuildingShape,
  x: number,
  y: number,
  width: number,
  height: number,
): boolean {
  const tx = clamp(Math.floor(Math.min(width, height) / 3), 2, Math.max(2, width - 2));
  const ty = clamp(Math.floor(Math.min(width, height) / 3), 2, Math.max(2, height - 2));
  switch (shape) {
    case 'l':
      return x < tx || y < ty;
    case 'corner':
      return x < tx || y >= height - ty;
    case 'u':
      return y < ty || x < tx || x >= width - tx;
    case 't': {
      const stem = clamp(tx, 2, width);
      const start = Math.floor((width - stem) / 2);
      return y < ty || (x >= start && x < start + stem);
    }
    case 'courtyard':
      return x < tx || x >= width - tx || y < ty || y >= height - ty;
    case 'paired': {
      const gap = width >= 7 ? 1 : 0;
      const split = Math.floor(width / 2);
      return x < split - gap || x >= split + gap;
    }
    case 'arcade':
      return y < ty || (y < height - ty && (x < tx || x >= width - tx));
    case 'shed-cluster': {
      const band = clamp(Math.floor(height / 5), 2, Math.max(2, height));
      const middle = Math.floor((height - band) / 2);
      return y < band || (y >= middle && y < middle + band) || y >= height - band;
    }
    case 'podium-tower':
    case 'rectangle':
      return true;
  }
}

function supportedShape(shape: PlannedBuildingShape, bounds: TileRect): boolean {
  const min = Math.min(bounds.width, bounds.height);
  if (shape === 'rectangle' || shape === 'podium-tower') return true;
  if (shape === 'l' || shape === 'corner' || shape === 'paired') return min >= 5;
  if (shape === 't' || shape === 'u' || shape === 'arcade') return min >= 7;
  if (shape === 'courtyard' || shape === 'shed-cluster') return min >= 8;
  return false;
}

function rotateCell(
  x: number,
  y: number,
  width: number,
  height: number,
  rotation: 0 | 90 | 180 | 270,
): PlannedTilePoint {
  switch (rotation) {
    case 90:
      return { x: height - 1 - y, y: x };
    case 180:
      return { x: width - 1 - x, y: height - 1 - y };
    case 270:
      return { x: y, y: width - 1 - x };
    default:
      return { x, y };
  }
}

function compressCells(cells: ReadonlySet<string>, width: number, height: number): TileRect[] {
  const active = new Map<string, TileRect>();
  const completed: TileRect[] = [];
  for (let y = 0; y < height; y++) {
    const runs: Array<{ x: number; width: number }> = [];
    let x = 0;
    while (x < width) {
      if (!cells.has(`${x},${y}`)) {
        x++;
        continue;
      }
      const start = x;
      while (x < width && cells.has(`${x},${y}`)) x++;
      runs.push({ x: start, width: x - start });
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
  return completed;
}

function frontageFor(bounds: TileRect, block: TileRect, seed: number): PlannedFacing {
  const distances: Array<{ side: PlannedFacing; distance: number }> = [
    { side: 'north', distance: bounds.y - block.y },
    { side: 'south', distance: block.y + block.height - (bounds.y + bounds.height) },
    { side: 'west', distance: bounds.x - block.x },
    { side: 'east', distance: block.x + block.width - (bounds.x + bounds.width) },
  ];
  distances.sort((a, b) => a.distance - b.distance);
  const tied = distances.filter((entry) => entry.distance === distances[0]?.distance);
  return tied[positiveMod(seed, Math.max(1, tied.length))]?.side ?? 'north';
}

function frontageScore(point: PlannedTilePoint, facing: PlannedFacing, block: TileRect): number {
  if (facing === 'north') {
    return point.y - block.y + Math.abs(point.x - (block.x + block.width / 2)) * 0.01;
  }
  if (facing === 'south') {
    return (
      block.y + block.height - point.y + Math.abs(point.x - (block.x + block.width / 2)) * 0.01
    );
  }
  if (facing === 'west') {
    return point.x - block.x + Math.abs(point.y - (block.y + block.height / 2)) * 0.01;
  }
  return block.x + block.width - point.x + Math.abs(point.y - (block.y + block.height / 2)) * 0.01;
}

function pathToBlockEdge(
  start: PlannedTilePoint,
  facing: PlannedFacing,
  bounds: TileRect,
  blockedCells: ReadonlySet<string>,
  reservedApproaches: ReadonlySet<string>,
): PlannedTilePoint[] | null {
  const delta = facingDelta(facing);
  const path: PlannedTilePoint[] = [];
  let point = { ...start };
  const limit = bounds.width + bounds.height + 2;
  for (let index = 0; index < limit; index++) {
    const key = `${point.x},${point.y}`;
    if (blockedCells.has(key) || reservedApproaches.has(key)) return null;
    path.push({ ...point });
    if (reachesFacingEdge(point, facing, bounds)) return path;
    point = { x: point.x + delta.x, y: point.y + delta.y };
  }
  return null;
}

function accessPointsFor(bounds: TileRect, publicCells: ReadonlySet<string>): PlannedTilePoint[] {
  if (publicCells.size === 0) return [];
  const requested = [
    { x: bounds.x + Math.floor(bounds.width / 2), y: bounds.y },
    { x: bounds.x + bounds.width - 1, y: bounds.y + Math.floor(bounds.height / 2) },
    { x: bounds.x + Math.floor(bounds.width / 2), y: bounds.y + bounds.height - 1 },
    { x: bounds.x, y: bounds.y + Math.floor(bounds.height / 2) },
  ];
  const candidates = Array.from(publicCells)
    .map((key) => {
      const [x, y] = key.split(',').map(Number);
      return { x: x ?? 0, y: y ?? 0 };
    })
    .sort((first, second) => first.y - second.y || first.x - second.x);
  const result: PlannedTilePoint[] = [];
  const used = new Set<string>();
  for (const target of requested) {
    let best: PlannedTilePoint | undefined;
    let bestDistance = Infinity;
    for (const candidate of candidates) {
      const key = `${candidate.x},${candidate.y}`;
      if (used.has(key)) continue;
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

function facingDelta(facing: PlannedFacing): PlannedTilePoint {
  switch (facing) {
    case 'north':
      return { x: 0, y: -1 };
    case 'south':
      return { x: 0, y: 1 };
    case 'east':
      return { x: 1, y: 0 };
    case 'west':
      return { x: -1, y: 0 };
  }
}

function oppositeFacing(facing: PlannedFacing): PlannedFacing {
  if (facing === 'north') return 'south';
  if (facing === 'south') return 'north';
  if (facing === 'east') return 'west';
  return 'east';
}

function reachesFacingEdge(
  point: PlannedTilePoint,
  facing: PlannedFacing,
  bounds: TileRect,
): boolean {
  if (facing === 'north') return point.y <= bounds.y;
  if (facing === 'south') return point.y >= bounds.y + bounds.height - 1;
  if (facing === 'east') return point.x >= bounds.x + bounds.width - 1;
  return point.x <= bounds.x;
}

function footprintCells(footprint: readonly TileRect[]): Set<string> {
  const cells = new Set<string>();
  for (const part of footprint) {
    for (let y = part.y; y < part.y + part.height; y++) {
      for (let x = part.x; x < part.x + part.width; x++) cells.add(`${x},${y}`);
    }
  }
  return cells;
}

function boundsOf(rects: readonly TileRect[]): TileRect {
  const minX = Math.min(...rects.map((rect) => rect.x));
  const minY = Math.min(...rects.map((rect) => rect.y));
  const maxX = Math.max(...rects.map((rect) => rect.x + rect.width));
  const maxY = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function rectSignature(rect: TileRect): string {
  return `${rect.x},${rect.y},${rect.width},${rect.height}`;
}

function footprintArea(rects: readonly TileRect[]): number {
  return rects.reduce((area, rect) => area + rect.width * rect.height, 0);
}

function setbackForProgram(
  program: PlannedBlockProgram,
  cityId: PlannedUrbanBlock['cityId'],
): number {
  if (['continuous-retail', 'market', 'restaurant-row'].includes(program)) return 0;
  if (cityId === 'gilan' && program === 'housing') return 2;
  if (['government-complex', 'university-campus', 'stadium', 'hospital'].includes(program)) {
    return 2;
  }
  return 1;
}

function insetRect(rect: TileRect, amount: number): TileRect {
  const maximum = Math.max(0, Math.floor((Math.min(rect.width, rect.height) - 2) / 2));
  const inset = Math.min(amount, maximum);
  return {
    x: rect.x + inset,
    y: rect.y + inset,
    width: Math.max(2, rect.width - inset * 2),
    height: Math.max(2, rect.height - inset * 2),
  };
}

function trimRect(
  rect: TileRect,
  left: number,
  top: number,
  right: number,
  bottom: number,
): TileRect {
  return {
    x: rect.x + left,
    y: rect.y + top,
    width: Math.max(2, rect.width - left - right),
    height: Math.max(2, rect.height - top - bottom),
  };
}

function sameRect(first: TileRect | undefined, second: TileRect): boolean {
  return Boolean(
    first &&
    first.x === second.x &&
    first.y === second.y &&
    first.width === second.width &&
    first.height === second.height,
  );
}

function choose<T>(values: readonly T[], seed: number): T {
  return values[positiveMod(seed, values.length)] ?? values[0]!;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function positiveMod(value: number, modulus: number): number {
  if (modulus <= 0) return 0;
  return ((value % modulus) + modulus) % modulus;
}

function mixHash(...values: number[]): number {
  let hash = 0x811c9dc5;
  for (const value of values) {
    hash ^= value | 0;
    hash = Math.imul(hash, 0x01000193);
    hash ^= hash >>> 15;
  }
  return hash >>> 0;
}

function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash ^ (hash >>> 16)) >>> 0;
}
