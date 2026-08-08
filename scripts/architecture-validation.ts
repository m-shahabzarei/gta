import {
  composeBlockArchitecture,
  selectBuildingMaterial,
  selectFacadeStyle,
  selectRoofStyle,
} from '@/generation/ArchitectureGrammar';
import {
  District,
  PHYSICAL_GROUND_FEATURE_KINDS,
  type CityId,
  type PlannedBlockProgram,
  type PlannedBuildingKind,
  type PlannedBuildingLot,
  type PlannedEntranceKind,
  type PlannedGroundFeatureKind,
  type PlannedTilePoint,
  type PlannedUrbanBlock,
  type PlannedUrbanSpace,
} from '@/gameplay/types';

interface CaseDefinition {
  cityId: CityId;
  district: District;
  programs: readonly PlannedBlockProgram[];
}

const CASES: readonly CaseDefinition[] = [
  {
    cityId: 'tehran',
    district: District.Downtown,
    programs: [
      'apartments',
      'continuous-retail',
      'office-complex',
      'financial-center',
      'government-complex',
      'hospital',
      'shopping-center',
      'stadium',
      'parking-garage',
      'industrial-yard',
      'factory',
      'warehouse',
      'police-station',
      'fire-station',
      'construction-site',
      'university-campus',
      'airport-facility',
      'military-base',
      'rail-yard',
      'cemetery',
      'utility-site',
    ],
  },
  {
    cityId: 'yazd',
    district: District.Historic,
    programs: [
      'housing',
      'market',
      'restaurant-row',
      'school',
      'hotel',
      'government-complex',
      'sports-center',
      'public-plaza',
      'farm-compound',
    ],
  },
  {
    cityId: 'gilan',
    district: District.Residential,
    programs: [
      'housing',
      'apartments',
      'school',
      'market',
      'hotel',
      'harbor-facility',
      'small-park',
      'playground',
      'forest-park',
      'farm-compound',
      'beach-access',
    ],
  },
];

const PROGRAM_PRIMARY_KINDS: Record<PlannedBlockProgram, readonly PlannedBuildingKind[]> = {
  housing: ['house', 'villa', 'apartment'],
  apartments: ['apartment'],
  'continuous-retail': ['retail'],
  'office-complex': ['office'],
  'financial-center': ['tower'],
  factory: ['factory'],
  warehouse: ['warehouse'],
  school: ['school'],
  hospital: ['hospital'],
  hotel: ['hotel'],
  market: ['market'],
  'restaurant-row': ['retail'],
  'parking-garage': ['parking-structure'],
  'government-complex': ['government'],
  'police-station': ['police'],
  'fire-station': ['fire-station'],
  'construction-site': ['utility'],
  'shopping-center': ['retail'],
  'public-plaza': [],
  playground: [],
  'sports-center': ['sports-hall'],
  'small-park': [],
  'university-campus': ['university'],
  'industrial-yard': ['factory'],
  'harbor-facility': ['warehouse'],
  'airport-facility': ['terminal'],
  'military-base': ['government'],
  'rail-yard': ['warehouse'],
  cemetery: [],
  stadium: ['stadium'],
  'beach-access': [],
  'forest-park': [],
  'farm-compound': ['house'],
  'utility-site': ['utility'],
};

const EXPECTED_PHYSICAL_GROUND_FEATURE_KINDS = [
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

const NON_SOLID_GROUND_FEATURE_KINDS = [
  'path',
  'parking-bay',
  'loading-bay',
  'gate',
  'flower-bed',
  'football-marking',
  'basketball-marking',
  'service-marking',
  'ambulance-bay',
  'police-parking',
  'goal',
] as const satisfies readonly PlannedGroundFeatureKind[];

const failures: string[] = [];
let assertions = 0;
const shapes = new Set<string>();
const sizes = new Set<string>();
const kinds = new Set<string>();
const entranceKinds = new Set<PlannedEntranceKind>();
let lots = 0;
let spaces = 0;
let entrances = 0;
let roofAssets = 0;
let multiEntranceLots = 0;
let multiTileFeatures = 0;
const multiTileFeatureKinds = new Set<PlannedGroundFeatureKind>();

validatePhysicalGroundFeaturePolicy();

for (const [caseIndex, definition] of CASES.entries()) {
  for (const [programIndex, program] of definition.programs.entries()) {
    for (const scale of [0, 1, 2] as const) {
      const width = [13, 24, 40][scale] ?? 24;
      const height = [12, 22, 34][scale] ?? 22;
      const block = makeBlock(
        definition.cityId,
        definition.district,
        program,
        caseIndex * 500 + programIndex * 47 + scale * 13,
        width,
        height,
      );
      const seed = 1337 + caseIndex * 101 + programIndex * 17 + scale;
      const composition = composeBlockArchitecture(block, seed);
      const repeated = composeBlockArchitecture(block, seed);

      check(
        JSON.stringify(composition) === JSON.stringify(repeated),
        `${block.id}: composition is not deterministic`,
      );
      check(composition.blockId === block.id, `${block.id}: wrong block ownership`);
      check(composition.spaces.length > 0, `${block.id}: no planned public realm`);
      check(composition.signature.length > 16, `${block.id}: weak composition signature`);
      validateProgramKind(block, composition.lots);

      const occupied = new Set<string>();
      for (const lot of composition.lots) {
        validateLot(block, lot, occupied);
        shapes.add(lot.shape);
        sizes.add(lot.size);
        kinds.add(lot.kind);
        lots++;
        entrances += lot.entrances.length;
        if (lot.entrances.length > 1) multiEntranceLots++;
        for (const entrance of lot.entrances) entranceKinds.add(entrance.kind);
        roofAssets += lot.roofAssets.length;
        if (definition.cityId === 'yazd') {
          check(lot.floors <= 5, `${lot.id}: Yazd mass exceeds five floors`);
        }
        if (definition.cityId === 'gilan' && lot.kind !== 'hotel') {
          check(lot.floors <= 6, `${lot.id}: Gilan neighbourhood mass is too tall`);
        }
      }

      const approachCells = validateApproaches(block, composition.lots, occupied);
      const featureCells = new Set<string>();
      const publicRealmOwners = new Map<string, string>();

      for (const space of composition.spaces) {
        spaces++;
        validateSpace(block, space, occupied, approachCells, publicRealmOwners, featureCells);
        for (const feature of space.features) {
          if (feature.bounds.width * feature.bounds.height <= 1) continue;
          multiTileFeatures++;
          multiTileFeatureKinds.add(feature.kind);
        }
      }
      for (let y = block.bounds.y; y < block.bounds.y + block.bounds.height; y++) {
        for (let x = block.bounds.x; x < block.bounds.x + block.bounds.width; x++) {
          const key = `${x},${y}`;
          check(
            occupied.has(key) !== publicRealmOwners.has(key),
            `${block.id}: lot/public-realm union is not exact at ${key}`,
          );
        }
      }
    }
  }
}

validateTopologyAndCityIdentity();

check(shapes.size >= 8, `shape vocabulary too small (${Array.from(shapes).join(', ')})`);
check(sizes.size === 4, `size categories incomplete (${Array.from(sizes).join(', ')})`);
check(kinds.size >= 12, `semantic kinds too sparse (${Array.from(kinds).join(', ')})`);
check(entrances >= lots, `missing entrances (${entrances}/${lots})`);
check(multiEntranceLots > 0, 'no building received multiple semantic entrances');
check(roofAssets >= lots, `missing roof assets (${roofAssets}/${lots})`);
check(
  multiTileFeatures > spaces,
  `multi-tile ground geometry is too sparse (${multiTileFeatures})`,
);
check(
  multiTileFeatureKinds.size >= 8,
  `multi-tile feature vocabulary is too sparse (${Array.from(multiTileFeatureKinds).join(', ')})`,
);
for (const kind of [
  'residential',
  'storefront',
  'service',
  'emergency',
  'campus',
  'vehicle',
  'gate',
] as const) {
  check(entranceKinds.has(kind), `missing representative ${kind} entrance`);
}

if (failures.length > 0) {
  console.error(`Architecture validation failed (${failures.length}/${assertions}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log('Architecture validation passed.');
  console.log(
    `  ${assertions} assertions; ${lots} buildings; ${spaces} planned spaces; ` +
      `${shapes.size} shapes; ${sizes.size} sizes; ${kinds.size} kinds; ` +
      `${roofAssets} roof assets; ${multiTileFeatures} multi-tile ground features.`,
  );
}

function makeBlock(
  cityId: CityId,
  district: District,
  program: PlannedBlockProgram,
  ordinal: number,
  width: number,
  height: number,
): PlannedUrbanBlock {
  const open = [
    'public-plaza',
    'playground',
    'small-park',
    'forest-park',
    'stadium',
    'industrial-yard',
    'farm-compound',
  ].includes(program);
  return {
    id: `validation:${cityId}:${program}:${ordinal}`,
    cityId,
    district,
    landUse:
      program === 'housing' || program === 'apartments' || program === 'farm-compound'
        ? 'residential'
        : program.includes('park') || program === 'playground' || program === 'public-plaza'
          ? 'park'
          : program === 'industrial-yard'
            ? 'industrial'
            : program === 'office-complex' || program === 'financial-center'
              ? 'office'
              : 'institutional',
    program,
    densityTarget: open ? (program === 'stadium' ? 0.2 : 0) : 0.42,
    landmark: ordinal % 3 === 0,
    purposefulOpenSpace: open,
    bounds: { x: 100 + (ordinal % 11) * 47, y: 100 + (ordinal % 13) * 41, width, height },
    form: width > height * 1.5 ? 'long' : width === height ? 'rectangular' : 'mixed',
    signature: `validation:${cityId}:${district}:${program}:${width}x${height}:${ordinal}`,
    generationAttempt: 0,
  };
}

function validateTopologyAndCityIdentity(): void {
  const topologyCases: ReadonlyArray<{
    family: string;
    cityId: CityId;
    district: District;
    program: PlannedBlockProgram;
  }> = [
    {
      family: 'housing',
      cityId: 'tehran',
      district: District.Residential,
      program: 'housing',
    },
    {
      family: 'apartments',
      cityId: 'tehran',
      district: District.Residential,
      program: 'apartments',
    },
    {
      family: 'retail',
      cityId: 'tehran',
      district: District.Commercial,
      program: 'continuous-retail',
    },
    {
      family: 'office',
      cityId: 'tehran',
      district: District.Downtown,
      program: 'office-complex',
    },
    {
      family: 'civic',
      cityId: 'tehran',
      district: District.Government,
      program: 'government-complex',
    },
    {
      family: 'industrial',
      cityId: 'tehran',
      district: District.Industrial,
      program: 'factory',
    },
  ];
  for (const [familyIndex, definition] of topologyCases.entries()) {
    const templates = new Set<string>();
    const topologies = new Set<string>();
    for (let variantIndex = 0; variantIndex < 48; variantIndex++) {
      const ordinal = 10_000 + familyIndex * 1_000 + variantIndex * 37;
      const block = makeBlock(
        definition.cityId,
        definition.district,
        definition.program,
        ordinal,
        32,
        26,
      );
      const composition = composeBlockArchitecture(block, 20_000 + variantIndex * 101);
      if (!templates.has(composition.template)) {
        validateCompositionExactSpace(block, composition);
      }
      templates.add(composition.template);
      topologies.add(
        composition.lots
          .map(
            (lot) =>
              `${lot.kind}:${lot.shape}:${lot.bounds.x - block.bounds.x},${lot.bounds.y - block.bounds.y},${lot.bounds.width}x${lot.bounds.height}`,
          )
          .join('|'),
      );
      check(
        composition.signature.includes(composition.template),
        `${block.id}: composition signature omits selected template variant`,
      );
    }
    check(
      templates.size >= 3 && templates.size <= 5,
      `${definition.family}: expected 3-5 topology variants, found ${templates.size} (${Array.from(templates).join(', ')})`,
    );
    check(
      topologies.size >= templates.size,
      `${definition.family}: named variants do not produce distinct lot topologies`,
    );
  }

  const gilanShapes: PlannedBuildingLot['shape'][] = [];
  const yazdShapes: PlannedBuildingLot['shape'][] = [];
  const yazdFloors: number[] = [];
  const firstRoofAssets = new Map<CityId, Set<string>>([
    ['tehran', new Set<string>()],
    ['yazd', new Set<string>()],
    ['gilan', new Set<string>()],
  ]);
  for (let sample = 0; sample < 96; sample++) {
    for (const cityId of ['tehran', 'yazd', 'gilan'] as const) {
      const district =
        cityId === 'tehran'
          ? District.Residential
          : cityId === 'yazd'
            ? District.Historic
            : District.Residential;
      const block = makeBlock(cityId, district, 'housing', 30_000 + sample * 71, 30, 24);
      const composition = composeBlockArchitecture(block, 40_000 + sample * 131);
      for (const lot of composition.lots) {
        const firstAsset = lot.roofAssets[0]?.kind;
        if (firstAsset) firstRoofAssets.get(cityId)?.add(firstAsset);
        if (cityId === 'gilan') gilanShapes.push(lot.shape);
        if (cityId === 'yazd') {
          yazdShapes.push(lot.shape);
          yazdFloors.push(lot.floors);
        }
      }
    }
  }
  const detachedGilan = gilanShapes.filter(
    (shape) => !['paired', 'courtyard', 'arcade', 'shed-cluster', 'podium-tower'].includes(shape),
  ).length;
  check(
    detachedGilan / Math.max(1, gilanShapes.length) >= 0.85,
    `Gilan detached housing proportion is too low (${detachedGilan}/${gilanShapes.length})`,
  );
  const courtyardYazd = yazdShapes.filter((shape) => shape === 'courtyard' || shape === 'u').length;
  check(
    courtyardYazd / Math.max(1, yazdShapes.length) >= 0.75,
    `Yazd courtyard housing proportion is too low (${courtyardYazd}/${yazdShapes.length})`,
  );
  const lowRiseYazd = yazdFloors.filter((floors) => floors <= 2).length;
  check(
    lowRiseYazd / Math.max(1, yazdFloors.length) >= 0.85,
    `Yazd low-rise housing proportion is too low (${lowRiseYazd}/${yazdFloors.length})`,
  );
  for (const [cityId, assets] of firstRoofAssets) {
    check(
      assets.size >= 3,
      `${cityId}: roof sequences always begin with the same module (${Array.from(assets).join(', ')})`,
    );
  }

  const styleCases = [
    {
      label: 'Gilan detached house',
      cityId: 'gilan',
      district: District.Residential,
      archetype: 'small-house',
      materialMatches: (value: string) => value === 'wood',
      roofMatches: (value: string) => value === 'sloped',
      facadeMatches: (value: string) =>
        value.includes('balcony-wraparound') || value.includes('balcony-projecting'),
      minimumMaterialRatio: 0.72,
      minimumRoofRatio: 0.72,
      minimumFacadeRatio: 0.65,
    },
    {
      label: 'Yazd courtyard house',
      cityId: 'yazd',
      district: District.Historic,
      archetype: 'small-house',
      materialMatches: (value: string) => value === 'adobe',
      roofMatches: (value: string) => value === 'flat',
      facadeMatches: (value: string) => value.includes('windows-arched'),
      minimumMaterialRatio: 0.72,
      minimumRoofRatio: 0.62,
      minimumFacadeRatio: 0.62,
    },
    {
      label: 'Tehran financial tower',
      cityId: 'tehran',
      district: District.Downtown,
      archetype: 'tower',
      materialMatches: (value: string) => value === 'glass' || value === 'steel',
      roofMatches: (value: string) => value === 'helipad' || value === 'mechanical',
      facadeMatches: (value: string) =>
        ['windows-ribbon', 'windows-grid', 'windows-vertical', 'windows-corner'].some((token) =>
          value.includes(token),
        ),
      minimumMaterialRatio: 0.82,
      minimumRoofRatio: 0.62,
      minimumFacadeRatio: 0.9,
    },
  ] as const;
  for (const [caseIndex, definition] of styleCases.entries()) {
    let materialMatches = 0;
    let roofMatches = 0;
    let facadeMatches = 0;
    const sampleCount = 512;
    for (let sample = 0; sample < sampleCount; sample++) {
      const salt = (Math.imul(sample + 1, 0x45d9f3b) ^ Math.imul(caseIndex + 7, 0x119de1f3)) >>> 0;
      const material = selectBuildingMaterial(
        definition.cityId,
        definition.district,
        definition.archetype,
        salt,
      );
      const roof = selectRoofStyle(
        definition.cityId,
        definition.district,
        definition.archetype,
        definition.archetype === 'tower' ? 32 : 2,
        salt,
      );
      const facade = selectFacadeStyle(
        definition.cityId,
        definition.district,
        definition.archetype,
        salt,
      );
      if (definition.materialMatches(material)) materialMatches++;
      if (definition.roofMatches(roof)) roofMatches++;
      if (definition.facadeMatches(facade)) facadeMatches++;
      check(
        material ===
          selectBuildingMaterial(
            definition.cityId,
            definition.district,
            definition.archetype,
            salt,
          ),
        `${definition.label}: material selection is not deterministic`,
      );
    }
    check(
      materialMatches / sampleCount >= definition.minimumMaterialRatio,
      `${definition.label}: material identity is too weak (${materialMatches}/${sampleCount})`,
    );
    check(
      roofMatches / sampleCount >= definition.minimumRoofRatio,
      `${definition.label}: roof identity is too weak (${roofMatches}/${sampleCount})`,
    );
    check(
      facadeMatches / sampleCount >= definition.minimumFacadeRatio,
      `${definition.label}: facade identity is too weak (${facadeMatches}/${sampleCount})`,
    );
  }
}

function validateCompositionExactSpace(
  block: PlannedUrbanBlock,
  composition: ReturnType<typeof composeBlockArchitecture>,
): void {
  const occupied = new Set<string>();
  for (const lot of composition.lots) validateLot(block, lot, occupied);
  const approachCells = validateApproaches(block, composition.lots, occupied);
  const publicRealmOwners = new Map<string, string>();
  const featureCells = new Set<string>();
  for (const space of composition.spaces) {
    validateSpace(block, space, occupied, approachCells, publicRealmOwners, featureCells);
  }
  for (let y = block.bounds.y; y < block.bounds.y + block.bounds.height; y++) {
    for (let x = block.bounds.x; x < block.bounds.x + block.bounds.width; x++) {
      const key = `${x},${y}`;
      check(
        occupied.has(key) !== publicRealmOwners.has(key),
        `${block.id}: topology variant lot/public-realm union is not exact at ${key}`,
      );
    }
  }
}

function validateLot(
  block: PlannedUrbanBlock,
  lot: PlannedBuildingLot,
  occupied: Set<string>,
): void {
  check(lot.blockId === block.id, `${lot.id}: wrong block id`);
  check(rectInside(lot.bounds, block.bounds), `${lot.id}: lot leaves block`);
  check(lot.footprint.length > 0, `${lot.id}: empty footprint`);
  check(lot.entrances.length > 0, `${lot.id}: missing entrance`);
  check(lot.roofAssets.length > 0, `${lot.id}: missing rooftop plan`);

  const own = new Set<string>();
  for (const part of lot.footprint) {
    check(part.width >= 2 && part.height >= 2, `${lot.id}: sub-2-tile footprint part`);
    check(rectInside(part, block.bounds), `${lot.id}: footprint leaves block`);
    for (let y = part.y; y < part.y + part.height; y++) {
      for (let x = part.x; x < part.x + part.width; x++) {
        const key = `${x},${y}`;
        check(!own.has(key), `${lot.id}: footprint rectangles overlap at ${key}`);
        check(!occupied.has(key), `${lot.id}: overlaps another lot at ${key}`);
        own.add(key);
        occupied.add(key);
      }
    }
  }

  check(
    lot.size === sizeForFootprint(own.size),
    `${lot.id}: size is not derived from actual footprint area`,
  );

  for (const entrance of lot.entrances) {
    check(own.has(pointKey(entrance.position)), `${entrance.id}: door is not on footprint`);
    check(!own.has(pointKey(entrance.apron)), `${entrance.id}: apron lies inside footprint`);
    check(entrance.accessPath.length > 0, `${entrance.id}: no access path`);
  }

  const roofCells = new Set<string>();
  for (const asset of lot.roofAssets) {
    check(rectInside(asset.bounds, lot.bounds), `${asset.id}: rooftop asset leaves roof bounds`);
    for (const key of rectKeys(asset.bounds)) {
      check(own.has(key), `${asset.id}: rooftop asset is not on the actual roof at ${key}`);
      check(!roofCells.has(key), `${asset.id}: rooftop asset overlaps another asset at ${key}`);
      roofCells.add(key);
    }
  }
}

function validateProgramKind(block: PlannedUrbanBlock, lots: readonly PlannedBuildingLot[]): void {
  const expected = PROGRAM_PRIMARY_KINDS[block.program];
  const primaryLots = lots.filter((lot) => lot.primary);
  if (expected.length === 0) {
    check(lots.length === 0, `${block.id}: open-space program unexpectedly generated buildings`);
    return;
  }
  check(primaryLots.length === 1, `${block.id}: expected exactly one primary building`);
  const primary = primaryLots[0];
  check(
    Boolean(primary && expected.includes(primary.kind)),
    `${block.id}: incorrect primary building kind ${primary?.kind}`,
  );
}

function validateSpace(
  block: PlannedUrbanBlock,
  space: PlannedUrbanSpace,
  occupied: ReadonlySet<string>,
  approachCells: ReadonlySet<string>,
  publicRealmOwners: Map<string, string>,
  featureCells: Set<string>,
): void {
  check(space.purposeful, `${space.id}: public realm is not purposeful`);
  check(space.footprint.length > 0, `${space.id}: public realm has no exact footprint`);
  check(rectInside(space.bounds, block.bounds), `${space.id}: public realm leaves block`);
  const own = new Set<string>();
  for (const part of space.footprint) {
    check(
      Number.isInteger(part.x) &&
        Number.isInteger(part.y) &&
        Number.isInteger(part.width) &&
        Number.isInteger(part.height) &&
        part.width > 0 &&
        part.height > 0,
      `${space.id}: public-realm footprint is not a positive integer rectangle`,
    );
    check(rectInside(part, block.bounds), `${space.id}: footprint leaves block`);
    for (const key of rectKeys(part)) {
      check(!own.has(key), `${space.id}: footprint rectangles overlap at ${key}`);
      check(!occupied.has(key), `${space.id}: footprint overlaps a building at ${key}`);
      check(
        !publicRealmOwners.has(key),
        `${space.id}: footprint overlaps ${publicRealmOwners.get(key) ?? 'another space'} at ${key}`,
      );
      own.add(key);
      publicRealmOwners.set(key, space.id);
    }
  }
  if (own.size > 0) {
    const expectedBounds = boundsForKeys(own);
    check(
      expectedBounds.x === space.bounds.x &&
        expectedBounds.y === space.bounds.y &&
        expectedBounds.width === space.bounds.width &&
        expectedBounds.height === space.bounds.height,
      `${space.id}: bounds are not the tight footprint envelope`,
    );
  }
  check(space.accessPoints.length > 0, `${space.id}: public realm has no access point`);
  for (const point of space.accessPoints) {
    check(own.has(pointKey(point)), `${space.id}: access point is outside its footprint`);
  }
  const hasFixtureCell = Array.from(own).some((key) => !approachCells.has(key));
  check(
    space.features.length > 0 || !hasFixtureCell,
    `${space.id}: public realm has no content despite available cells`,
  );
  for (const feature of space.features) {
    check(
      Number.isInteger(feature.bounds.x) &&
        Number.isInteger(feature.bounds.y) &&
        Number.isInteger(feature.bounds.width) &&
        Number.isInteger(feature.bounds.height) &&
        feature.bounds.width > 0 &&
        feature.bounds.height > 0,
      `${feature.id}: feature bounds are not a positive integer rectangle`,
    );
    for (const key of rectKeys(feature.bounds)) {
      check(own.has(key), `${feature.id}: feature leaves its exact public realm at ${key}`);
      check(!occupied.has(key), `${feature.id}: feature overlaps a building at ${key}`);
      check(
        !approachCells.has(key),
        `${feature.id}: feature blocks an entrance approach at ${key}`,
      );
      check(!featureCells.has(key), `${feature.id}: overlaps another ground feature at ${key}`);
      featureCells.add(key);
    }
  }
}

function validatePhysicalGroundFeaturePolicy(): void {
  const actual = new Set<PlannedGroundFeatureKind>(PHYSICAL_GROUND_FEATURE_KINDS);
  const expected = new Set<PlannedGroundFeatureKind>(EXPECTED_PHYSICAL_GROUND_FEATURE_KINDS);
  check(
    actual.size === PHYSICAL_GROUND_FEATURE_KINDS.length,
    'physical ground-feature policy contains duplicate kinds',
  );
  check(
    actual.size === expected.size && Array.from(expected).every((kind) => actual.has(kind)),
    `physical ground-feature policy drifted (${Array.from(actual).join(', ')})`,
  );
  for (const kind of NON_SOLID_GROUND_FEATURE_KINDS) {
    check(!actual.has(kind), `${kind} must remain a non-solid ground feature`);
  }
}

function validateApproaches(
  block: PlannedUrbanBlock,
  lots: readonly PlannedBuildingLot[],
  occupied: ReadonlySet<string>,
): Set<string> {
  const usedApproaches = new Set<string>();
  const usedDoors = new Set<string>();
  for (const lot of lots) {
    const own = footprintKeys(lot);
    for (const entrance of lot.entrances) {
      const doorKey = pointKey(entrance.position);
      check(!usedDoors.has(doorKey), `${entrance.id}: duplicates another entrance position`);
      usedDoors.add(doorKey);

      const delta = facingDelta(entrance.facing);
      check(
        entrance.apron.x === entrance.position.x + delta.x &&
          entrance.apron.y === entrance.position.y + delta.y,
        `${entrance.id}: apron does not match entrance facing`,
      );
      check(
        !own.has(pointKey(entrance.apron)),
        `${entrance.id}: entrance is not on an exposed perimeter`,
      );
      check(
        entrance.accessPath[0]?.x === entrance.apron.x &&
          entrance.accessPath[0]?.y === entrance.apron.y,
        `${entrance.id}: access path does not begin at apron`,
      );

      for (let index = 0; index < entrance.accessPath.length; index++) {
        const point = entrance.accessPath[index]!;
        const key = pointKey(point);
        check(!occupied.has(key), `${entrance.id}: access path crosses a building at ${key}`);
        check(
          !usedApproaches.has(key),
          `${entrance.id}: access path overlaps another approach at ${key}`,
        );
        usedApproaches.add(key);
        if (index > 0) {
          const previous = entrance.accessPath[index - 1]!;
          check(
            point.x === previous.x + delta.x && point.y === previous.y + delta.y,
            `${entrance.id}: access path is not contiguous toward its frontage`,
          );
        }
      }

      const end = entrance.accessPath.at(-1);
      check(
        Boolean(end && reachesFacingEdge(end, entrance.facing, block.bounds)),
        `${entrance.id}: path misses block edge`,
      );
    }
  }
  return usedApproaches;
}

function footprintKeys(lot: PlannedBuildingLot): Set<string> {
  const keys = new Set<string>();
  for (const part of lot.footprint) {
    for (const key of rectKeys(part)) keys.add(key);
  }
  return keys;
}

function rectKeys(rect: { x: number; y: number; width: number; height: number }): string[] {
  const keys: string[] = [];
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) keys.push(`${x},${y}`);
  }
  return keys;
}

function sizeForFootprint(area: number): PlannedBuildingLot['size'] {
  if (area < 36) return 'small';
  if (area < 120) return 'medium';
  if (area < 320) return 'large';
  return 'huge';
}

function boundsForKeys(keys: ReadonlySet<string>): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const points = Array.from(keys).map((key) => key.split(',').map(Number));
  const xs = points.map((point) => point[0] ?? 0);
  const ys = points.map((point) => point[1] ?? 0);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function facingDelta(facing: PlannedBuildingLot['frontage']): PlannedTilePoint {
  if (facing === 'north') return { x: 0, y: -1 };
  if (facing === 'south') return { x: 0, y: 1 };
  if (facing === 'east') return { x: 1, y: 0 };
  return { x: -1, y: 0 };
}

function reachesFacingEdge(
  point: PlannedTilePoint,
  facing: PlannedBuildingLot['frontage'],
  bounds: PlannedUrbanBlock['bounds'],
): boolean {
  if (facing === 'north') return point.y <= bounds.y;
  if (facing === 'south') return point.y >= bounds.y + bounds.height - 1;
  if (facing === 'east') return point.x >= bounds.x + bounds.width - 1;
  return point.x <= bounds.x;
}

function rectInside(
  inner: { x: number; y: number; width: number; height: number },
  outer: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

function pointKey(point: PlannedTilePoint): string {
  return `${point.x},${point.y}`;
}

function check(condition: boolean, message: string): void {
  assertions++;
  if (!condition) failures.push(message);
}
