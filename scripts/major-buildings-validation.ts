import { TILE_SIZE } from '@/config/Constants';
import {
  MajorBuildingRegistry,
  createMajorInteriorLayout,
  type MajorInteriorLayout,
} from '@/gameplay/major-buildings';
import type {
  CityId,
  InteriorNpcAppearance,
  MajorBuildingDefinition,
  MajorBuildingVariant,
} from '@/gameplay/types';

interface LayoutCase {
  variant: MajorBuildingVariant;
  city: CityId;
  kind: 'hospital' | 'police';
  width: number;
  height: number;
  doorX: number;
}

const CASES: readonly LayoutCase[] = [
  {
    variant: 'tehran-police-headquarters',
    city: 'tehran',
    kind: 'police',
    width: 16,
    height: 12,
    doorX: 7,
  },
  {
    variant: 'tehran-district-police',
    city: 'tehran',
    kind: 'police',
    width: 12,
    height: 10,
    doorX: 5,
  },
  {
    variant: 'yazd-courtyard-police',
    city: 'yazd',
    kind: 'police',
    width: 13,
    height: 11,
    doorX: 6,
  },
  {
    variant: 'gilan-regional-police',
    city: 'gilan',
    kind: 'police',
    width: 11,
    height: 10,
    doorX: 4,
  },
  {
    variant: 'tehran-general-hospital',
    city: 'tehran',
    kind: 'hospital',
    width: 16,
    height: 13,
    doorX: 8,
  },
  {
    variant: 'tehran-emergency-hospital',
    city: 'tehran',
    kind: 'hospital',
    width: 14,
    height: 11,
    doorX: 5,
  },
  {
    variant: 'yazd-courtyard-hospital',
    city: 'yazd',
    kind: 'hospital',
    width: 13,
    height: 12,
    doorX: 6,
  },
  {
    variant: 'gilan-regional-hospital',
    city: 'gilan',
    kind: 'hospital',
    width: 12,
    height: 11,
    doorX: 5,
  },
];

const EXPECTED_ROOMS = {
  police: [
    'Reception',
    'Waiting Area',
    'Police Desks',
    'Offices',
    'Interrogation Room',
    'Evidence Room',
    'Locker and Equipment',
    'Holding Cells',
  ],
  hospital: [
    'Reception',
    'Waiting Room',
    'Emergency Room',
    'Examination Rooms',
    'Patient Rooms',
    'Nurses Station',
    'Doctors Area',
    'Procedure Room',
    'Pharmacy and Storage',
  ],
} as const;

const EXPECTED_APPEARANCES: Readonly<Record<LayoutCase['kind'], readonly InteriorNpcAppearance[]>> =
  {
    police: ['police-uniform', 'police-detective'],
    hospital: [
      'hospital-doctor',
      'hospital-nurse',
      'hospital-paramedic',
      'hospital-patient',
      'hospital-reception',
      'hospital-security',
    ],
  };

const failures: string[] = [];
let assertions = 0;
const definitions: MajorBuildingDefinition[] = [];

for (const [index, definition] of CASES.entries()) {
  const origin = { x: index * 1000, y: index * 800 };
  const entrance = {
    x: origin.x + definition.doorX * TILE_SIZE + TILE_SIZE / 2,
    y: origin.y - TILE_SIZE / 2,
  };
  const layout = createMajorInteriorLayout({
    kind: definition.kind,
    cityId: definition.city,
    variant: definition.variant,
    bounds: {
      x: origin.x,
      y: origin.y,
      w: definition.width * TILE_SIZE,
      h: definition.height * TILE_SIZE,
    },
    widthTiles: definition.width,
    heightTiles: definition.height,
    doorX: definition.doorX,
    entrance,
  });
  validateLayout(definition, layout, origin);
  const police = definition.kind === 'police';
  const type = police ? 'police-station' : 'hospital';
  definitions.push({
    id: `${definition.city}-${police ? 'police' : 'hospital'}-${index + 1}`,
    name: definition.variant,
    type,
    city: definition.city,
    buildingId: `building-${index + 1}`,
    worldPosition: {
      x: origin.x + (definition.width * TILE_SIZE) / 2,
      y: origin.y + (definition.height * TILE_SIZE) / 2,
    },
    entrancePosition: entrance,
    exteriorBounds: {
      x: origin.x,
      y: origin.y,
      width: definition.width * TILE_SIZE,
      height: definition.height * TILE_SIZE,
    },
    interiorId: `${definition.kind}:${index}`,
    mapIcon: police ? 'police-badge' : 'medical-cross',
    minimapIcon: police ? 'police-badge' : 'medical-cross',
    size: definition.city === 'tehran' && index % 4 === 0 ? 'metropolitan' : 'regional',
    architecturalVariant: definition.variant,
    npcProfile: {
      maxActive: layout.npcSpawns.length,
      roles: layout.npcSpawns.map((spawn) => spawn.role),
    },
    parkingArea: {
      position: { x: entrance.x + 96, y: entrance.y },
      heading: 0,
      slots: 2,
      vehicleKind: police ? 'police' : 'ambulance',
    },
    services: police
      ? ['arrest', 'dispatch', 'wanted-clearance']
      : ['healing', 'revival', 'ambulance'],
    activeState: 'proximity-streamed',
  });
}

validateRegistry(definitions);

if (failures.length > 0) {
  console.error(
    `Major-building validation FAILED (${failures.length} failures / ${assertions} checks)`,
  );
  for (const failure of failures) console.error(` - ${failure}`);
  process.exitCode = 1;
} else {
  console.log('Major-building validation PASSED');
  console.log(
    `  ${assertions} distribution, interior, collision, navigation, NPC, marker, and parking checks`,
  );
  console.log('  4 police stations and 4 hospitals across Tehran, Yazd, and Gilan passed');
}

function validateLayout(
  definition: LayoutCase,
  layout: MajorInteriorLayout,
  origin: { x: number; y: number },
): void {
  const prefix = definition.variant;
  const roomNames = new Set(layout.rooms.map((room) => room.name));
  for (const room of EXPECTED_ROOMS[definition.kind]) {
    check(roomNames.has(room), `${prefix} is missing ${room}`);
  }
  check(layout.objects.length >= 12, `${prefix} has too few authored fixtures`);
  check(layout.doors.length >= 3, `${prefix} lacks connected internal doors`);

  const cellKeys = (cells: readonly { x: number; y: number }[]) =>
    new Set(cells.map((cell) => `${cell.x},${cell.y}`));
  const walls = cellKeys(layout.wallCells);
  const doors = cellKeys(layout.doorCells);
  const fixtures = cellKeys(layout.fixtureCells);
  for (const key of doors) check(!walls.has(key), `${prefix} door ${key} is still a wall`);
  for (const key of fixtures) check(!walls.has(key), `${prefix} fixture ${key} overlaps a wall`);

  const reachable = floodReachable(definition, walls, fixtures);
  check(reachable.size > 0, `${prefix} has no entrance-connected floor`);
  for (const spawn of layout.npcSpawns) {
    const spawnKey = worldCellKey(spawn, origin);
    check(reachable.has(spawnKey), `${prefix} ${spawn.role} spawn is unreachable`);
    check((spawn.anchors?.length ?? 0) >= 2, `${prefix} ${spawn.role} lacks a work route`);
    for (const anchor of spawn.anchors ?? []) {
      check(
        reachable.has(worldCellKey(anchor, origin)),
        `${prefix} ${spawn.role} anchor is unreachable`,
      );
    }
  }
  const appearances = new Set(layout.npcSpawns.map((spawn) => spawn.appearance));
  for (const appearance of EXPECTED_APPEARANCES[definition.kind]) {
    check(appearances.has(appearance), `${prefix} lacks ${appearance}`);
  }
  const roles = new Set(layout.npcSpawns.map((spawn) => spawn.role));
  check(roles.size === layout.npcSpawns.length, `${prefix} duplicates an interior role`);
}

function floodReachable(
  definition: LayoutCase,
  walls: ReadonlySet<string>,
  fixtures: ReadonlySet<string>,
): Set<string> {
  const start = `${definition.doorX},1`;
  const visited = new Set<string>();
  const queue: Array<{ x: number; y: number }> = [{ x: definition.doorX, y: 1 }];
  if (walls.has(start) || fixtures.has(start)) return visited;
  visited.add(start);
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    if (!current) continue;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const x = current.x + dx;
      const y = current.y + dy;
      const key = `${x},${y}`;
      if (
        x < 1 ||
        y < 1 ||
        x >= definition.width - 1 ||
        y >= definition.height - 1 ||
        walls.has(key) ||
        fixtures.has(key) ||
        visited.has(key)
      )
        continue;
      visited.add(key);
      queue.push({ x, y });
    }
  }
  return visited;
}

function worldCellKey(point: { x: number; y: number }, origin: { x: number; y: number }): string {
  return `${Math.floor((point.x - origin.x) / TILE_SIZE)},${Math.floor((point.y - origin.y) / TILE_SIZE)}`;
}

function validateRegistry(source: readonly MajorBuildingDefinition[]): void {
  const registry = new MajorBuildingRegistry(source);
  check(registry.all().length === 8, 'registry must contain exactly eight required locations');
  for (const [city, police, hospitals] of [
    ['tehran', 2, 2],
    ['yazd', 1, 1],
    ['gilan', 1, 1],
  ] as const) {
    const cityBuildings = registry.inCity(city);
    check(
      cityBuildings.filter((item) => item.type === 'police-station').length === police,
      `${city} police count is wrong`,
    );
    check(
      cityBuildings.filter((item) => item.type === 'hospital').length === hospitals,
      `${city} hospital count is wrong`,
    );
  }
  check(new Set(source.map((item) => item.id)).size === 8, 'major-building ids must be unique');
  check(
    new Set(source.map((item) => item.buildingId)).size === 8,
    'major-building owners must be unique',
  );
  check(
    new Set(source.map((item) => item.architecturalVariant)).size === 8,
    'architectural variants must be unique',
  );
  for (const item of source) {
    check(item.mapIcon === item.minimapIcon, `${item.id} map and minimap icons diverge`);
    check(
      distance(item.entrancePosition, item.parkingArea.position) >= 48,
      `${item.id} parking blocks its entrance`,
    );
    check(
      registry.get(item.id)?.interiorId === item.interiorId,
      `${item.id} registry lookup is inconsistent`,
    );
    check(
      registry.nearest(item.type, item.entrancePosition)?.id === item.id,
      `${item.id} nearest lookup is inconsistent`,
    );
  }
}

function distance(first: { x: number; y: number }, second: { x: number; y: number }): number {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function check(condition: boolean, message: string): void {
  assertions += 1;
  if (!condition) failures.push(message);
}
