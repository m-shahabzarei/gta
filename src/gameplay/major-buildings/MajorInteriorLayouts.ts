import { TILE_SIZE } from '@/config/Constants';
import type { Vector2 } from '@/core/types';
import type {
  BuildingInterior,
  CityId,
  InteriorNpcActivity,
  InteriorNpcAppearance,
  InteriorObjectInfo,
  MajorBuildingVariant,
} from '@/gameplay/types/WorldTypes';

interface TileCell {
  x: number;
  y: number;
}

export interface MajorInteriorLayoutInput {
  kind: 'hospital' | 'police';
  cityId: CityId;
  variant: MajorBuildingVariant;
  bounds: { x: number; y: number; w: number; h: number };
  widthTiles: number;
  heightTiles: number;
  doorX: number;
  entrance: Vector2;
}

export interface MajorInteriorLayout {
  rooms: BuildingInterior['rooms'];
  doors: BuildingInterior['doors'];
  objects: InteriorObjectInfo[];
  npcSpawns: BuildingInterior['npcSpawns'];
  wallCells: TileCell[];
  doorCells: TileCell[];
  fixtureCells: TileCell[];
}

interface RoleSpec {
  role: string;
  appearance: InteriorNpcAppearance;
  activity: InteriorNpcActivity;
}

/** Build one compact but complete service interior from the exact owned footprint. */
export function createMajorInteriorLayout(input: MajorInteriorLayoutInput): MajorInteriorLayout {
  const w = input.widthTiles;
  const h = input.heightTiles;
  const innerWidth = w - 2;
  const innerHeight = h - 2;
  if (innerWidth < 5 || innerHeight < 5) {
    throw new Error(`${input.variant} requires at least a 7x7 tile footprint`);
  }

  const reverse =
    input.variant === 'tehran-district-police' ||
    input.variant === 'tehran-emergency-hospital' ||
    input.cityId === 'gilan';
  const entranceX = clamp(input.doorX, 1, w - 2);
  let splitX = clamp(
    Math.round(w * (input.cityId === 'yazd' ? 0.56 : reverse ? 0.58 : 0.46)),
    3,
    w - 3,
  );
  if (Math.abs(splitX - entranceX) <= 1) {
    splitX = entranceX + 2 <= w - 3 ? entranceX + 2 : entranceX - 2 >= 3 ? entranceX - 2 : splitX;
  }
  const splitY = clamp(Math.round(h * (input.cityId === 'gilan' ? 0.56 : 0.5)), 3, h - 3);
  const wallCells: TileCell[] = [];
  const doorCells: TileCell[] = [];
  const wallKeys = new Set<string>();
  const addWall = (x: number, y: number): void => {
    const key = `${x},${y}`;
    if (wallKeys.has(key)) return;
    wallKeys.add(key);
    wallCells.push({ x, y });
  };
  const addDoor = (x: number, y: number): void => {
    wallKeys.delete(`${x},${y}`);
    const index = wallCells.findIndex((cell) => cell.x === x && cell.y === y);
    if (index >= 0) wallCells.splice(index, 1);
    if (!doorCells.some((cell) => cell.x === x && cell.y === y)) doorCells.push({ x, y });
  };

  for (let x = 1; x < w - 1; x++) {
    if (x === entranceX || x === splitX) continue;
    addWall(x, splitY);
  }
  for (let y = 1; y < h - 1; y++) {
    if (y === splitY || y === splitY - 1) continue;
    addWall(splitX, y);
  }
  addDoor(entranceX, splitY);
  addDoor(splitX, splitY - 1);
  if (h >= 9) addDoor(splitX, h - 3);

  const palette = interiorPalette(input.cityId, input.kind);
  const occupied = new Set<string>(wallCells.map((cell) => `${cell.x},${cell.y}`));
  const objects: InteriorObjectInfo[] = [];
  const addObject = (
    kind: InteriorObjectInfo['kind'],
    relativeX: number,
    relativeY: number,
    color: number,
    blocksMovement = true,
    prompt?: string,
    action?: InteriorObjectInfo['action'],
  ): void => {
    const authoredX = reverse ? 1 - relativeX : relativeX;
    const requested = {
      x: clamp(1 + Math.round(authoredX * (innerWidth - 1)), 1, w - 2),
      y: clamp(1 + Math.round(relativeY * (innerHeight - 1)), 1, h - 2),
    };
    const cell = nearestFreeCell(requested, w, h, occupied, entranceX);
    if (!cell) return;
    occupied.add(`${cell.x},${cell.y}`);
    const large =
      kind === 'bed' ||
      kind === 'stretcher' ||
      kind === 'exam-table' ||
      kind === 'operating-table' ||
      kind === 'counter' ||
      kind === 'evidence-table';
    const objectWidth = large ? TILE_SIZE - 6 : TILE_SIZE - 12;
    const objectHeight = large ? 18 : 16;
    objects.push({
      kind,
      x: input.bounds.x + cell.x * TILE_SIZE + (TILE_SIZE - objectWidth) / 2,
      y: input.bounds.y + cell.y * TILE_SIZE + (TILE_SIZE - objectHeight) / 2,
      w: objectWidth,
      h: objectHeight,
      color,
      blocksMovement,
      prompt,
      action,
    });
  };

  if (input.kind === 'hospital') {
    addObject('counter', 0.08, 0.08, palette.accent, true, 'E  Check in / heal', 'hospital-heal');
    addObject('computer', 0.25, 0.08, palette.equipment);
    addObject('bench', 0.08, 0.27, palette.seating);
    addObject('chair', 0.25, 0.27, palette.seating, false);
    addObject('exam-table', 0.69, 0.08, palette.clinical);
    addObject('medical-cart', 0.88, 0.18, palette.equipment);
    addObject('desk', 0.7, 0.3, palette.equipment);
    addObject('counter', 0.48, 0.48, palette.accent);
    addObject('bed', 0.08, 0.76, palette.clinical);
    addObject('bed', 0.28, 0.9, palette.clinical);
    addObject('operating-table', 0.7, 0.76, palette.clinical);
    addObject('privacy-screen', 0.88, 0.7, palette.screen, false);
    addObject('shelf', 0.88, 0.9, palette.storage, true, 'E  Buy medkit', 'hospital-medkit');
    addObject('cabinet', 0.48, 0.9, palette.storage, true, 'E  Save chart', 'hospital-save');
  } else {
    addObject('counter', 0.08, 0.08, palette.accent, true, 'E  Clear report', 'police-clear');
    addObject('security-console', 0.25, 0.08, palette.equipment);
    addObject('bench', 0.08, 0.28, palette.seating);
    addObject('desk', 0.66, 0.08, palette.equipment);
    addObject('desk', 0.88, 0.22, palette.equipment);
    addObject('filing-cabinet', 0.7, 0.34, palette.storage);
    addObject('security-console', 0.48, 0.48, palette.accent);
    addObject('evidence-table', 0.08, 0.72, palette.equipment);
    addObject('filing-cabinet', 0.27, 0.9, palette.storage);
    addObject('locker', 0.48, 0.9, palette.storage);
    addObject('desk', 0.7, 0.72, palette.equipment);
    addObject('cell', 0.88, 0.72, palette.cell);
    addObject('cell', 0.88, 0.9, palette.cell);
  }

  const fixtureCells = objects
    .filter((object) => object.blocksMovement)
    .map((object) => ({
      x: Math.floor((object.x + object.w / 2 - input.bounds.x) / TILE_SIZE),
      y: Math.floor((object.y + object.h / 2 - input.bounds.y) / TILE_SIZE),
    }));
  const blocked = new Set([
    ...wallCells.map((cell) => `${cell.x},${cell.y}`),
    ...fixtureCells.map((cell) => `${cell.x},${cell.y}`),
  ]);
  const allSafeCells: TileCell[] = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (!blocked.has(`${x},${y}`)) allSafeCells.push({ x, y });
    }
  }
  const safeCells = reachableCells(allSafeCells, { x: entranceX, y: 1 });
  const roles = input.kind === 'hospital' ? hospitalRoles() : policeRoles();
  if (safeCells.length < roles.length) {
    throw new Error(`${input.variant} has only ${safeCells.length} reachable NPC cells`);
  }
  const npcSpawns = roles.slice(0, Math.min(roles.length, safeCells.length)).map((role, index) => {
    const spawnCell = safeCells[(index * 3 + (reverse ? 2 : 0)) % safeCells.length] as TileCell;
    const anchors = [0, 1, 2]
      .map((offset) => safeCells[(index * 3 + offset * 2 + (reverse ? 2 : 0)) % safeCells.length])
      .filter((cell): cell is TileCell => cell !== undefined)
      .map((cell) => cellCenter(input.bounds, cell));
    const position = cellCenter(input.bounds, spawnCell);
    return { ...role, ...position, count: 1, anchors };
  });

  return {
    rooms: roomPlan(input, splitX, splitY),
    doors: [
      { x: input.entrance.x - 12, y: input.bounds.y - 4, w: 24, h: 12, open: true },
      ...doorCells.map((cell) => ({
        x: input.bounds.x + cell.x * TILE_SIZE + 5,
        y: input.bounds.y + cell.y * TILE_SIZE + 10,
        w: TILE_SIZE - 10,
        h: 12,
        open: true,
      })),
    ],
    objects,
    npcSpawns,
    wallCells,
    doorCells,
    fixtureCells,
  };
}

function roomPlan(
  input: MajorInteriorLayoutInput,
  splitX: number,
  splitY: number,
): BuildingInterior['rooms'] {
  const b = input.bounds;
  const rect = (name: string, x: number, y: number, width: number, height: number) => ({
    name,
    x: b.x + x * TILE_SIZE,
    y: b.y + y * TILE_SIZE,
    w: Math.max(TILE_SIZE, width * TILE_SIZE),
    h: Math.max(TILE_SIZE, height * TILE_SIZE),
  });
  const leftW = Math.max(1, splitX - 1);
  const rightW = Math.max(1, input.widthTiles - splitX - 1);
  const topH = Math.max(1, splitY - 1);
  const bottomH = Math.max(1, input.heightTiles - splitY - 1);
  if (input.kind === 'hospital') {
    const halfTop = Math.max(1, Math.floor(topH / 2));
    const halfRight = Math.max(1, Math.floor(rightW / 2));
    const halfBottom = Math.max(1, Math.floor(bottomH / 2));
    return [
      rect('Reception', 1, 1, leftW, halfTop),
      rect('Waiting Room', 1, 1 + halfTop, leftW, Math.max(1, topH - halfTop)),
      rect('Emergency Room', splitX + 1, 1, halfRight, topH),
      rect('Examination Rooms', splitX + 1 + halfRight, 1, Math.max(1, rightW - halfRight), topH),
      rect('Nurses Station', Math.max(1, splitX - 1), Math.max(1, splitY - 1), 3, 3),
      rect('Patient Rooms', 1, splitY + 1, leftW, bottomH),
      rect('Doctors Area', splitX + 1, splitY + 1, rightW, halfBottom),
      rect(
        'Procedure Room',
        splitX + 1,
        splitY + 1 + halfBottom,
        rightW,
        Math.max(1, bottomH - halfBottom),
      ),
      rect('Pharmacy and Storage', Math.max(1, input.widthTiles - 3), input.heightTiles - 3, 2, 2),
    ];
  }
  const halfLeft = Math.max(1, Math.floor(leftW / 2));
  const halfRight = Math.max(1, Math.floor(rightW / 2));
  const halfTop = Math.max(1, Math.floor(topH / 2));
  return [
    rect('Reception', 1, 1, halfLeft, topH),
    rect('Waiting Area', 1 + halfLeft, 1, Math.max(1, leftW - halfLeft), topH),
    rect('Police Desks', splitX + 1, 1, rightW, halfTop),
    rect('Offices', splitX + 1, 1 + halfTop, rightW, Math.max(1, topH - halfTop)),
    rect('Duty Corridor', Math.max(1, splitX - 1), Math.max(1, splitY - 1), 3, 3),
    rect('Interrogation Room', 1, splitY + 1, halfLeft, bottomH),
    rect('Evidence Room', 1 + halfLeft, splitY + 1, Math.max(1, leftW - halfLeft), bottomH),
    rect('Locker and Equipment', Math.max(1, splitX - 1), input.heightTiles - 3, 3, 2),
    rect(
      'Holding Cells',
      splitX + 1 + halfRight,
      splitY + 1,
      Math.max(1, rightW - halfRight),
      bottomH,
    ),
    rect('Custody Area', splitX + 1, splitY + 1, halfRight, bottomH),
  ];
}

function reachableCells(cells: readonly TileCell[], start: TileCell): TileCell[] {
  const available = new Map(cells.map((cell) => [`${cell.x},${cell.y}`, cell]));
  const first = available.get(`${start.x},${start.y}`);
  if (!first) return [];
  const visited = new Set<string>([`${first.x},${first.y}`]);
  const queue: TileCell[] = [first];
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    if (!current) continue;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const key = `${current.x + dx},${current.y + dy}`;
      const next = available.get(key);
      if (!next || visited.has(key)) continue;
      visited.add(key);
      queue.push(next);
    }
  }
  return queue;
}

function hospitalRoles(): RoleSpec[] {
  return [
    { role: 'receptionist', appearance: 'hospital-reception', activity: 'reception' },
    { role: 'triage nurse', appearance: 'hospital-nurse', activity: 'desk-work' },
    { role: 'ward nurse', appearance: 'hospital-nurse', activity: 'deliver' },
    { role: 'emergency doctor', appearance: 'hospital-doctor', activity: 'treat' },
    { role: 'physician', appearance: 'hospital-doctor', activity: 'inspect' },
    { role: 'waiting patient', appearance: 'hospital-patient', activity: 'wait' },
    { role: 'recovering patient', appearance: 'hospital-patient', activity: 'recover' },
    { role: 'paramedic', appearance: 'hospital-paramedic', activity: 'patrol' },
    { role: 'hospital security', appearance: 'hospital-security', activity: 'guard' },
  ];
}

function policeRoles(): RoleSpec[] {
  return [
    { role: 'reception officer', appearance: 'police-uniform', activity: 'reception' },
    { role: 'desk officer', appearance: 'police-uniform', activity: 'desk-work' },
    { role: 'corridor officer', appearance: 'police-uniform', activity: 'patrol' },
    { role: 'detective', appearance: 'police-detective', activity: 'inspect' },
    { role: 'evidence officer', appearance: 'police-uniform', activity: 'inspect' },
    { role: 'cell officer', appearance: 'police-uniform', activity: 'guard' },
    { role: 'custody officer', appearance: 'police-uniform', activity: 'patrol' },
  ];
}

function nearestFreeCell(
  requested: TileCell,
  width: number,
  height: number,
  occupied: ReadonlySet<string>,
  entranceX: number,
): TileCell | null {
  let best: TileCell | null = null;
  let bestScore = Infinity;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      if (occupied.has(`${x},${y}`)) continue;
      if (x === entranceX && y <= Math.ceil(height / 2)) continue;
      const score = (x - requested.x) ** 2 + (y - requested.y) ** 2;
      if (score >= bestScore) continue;
      best = { x, y };
      bestScore = score;
    }
  }
  return best;
}

function cellCenter(bounds: MajorInteriorLayoutInput['bounds'], cell: TileCell): Vector2 {
  return {
    x: bounds.x + cell.x * TILE_SIZE + TILE_SIZE / 2,
    y: bounds.y + cell.y * TILE_SIZE + TILE_SIZE / 2,
  };
}

function interiorPalette(city: CityId, kind: 'hospital' | 'police') {
  if (city === 'yazd') {
    return kind === 'hospital'
      ? {
          accent: 0x8a6f54,
          equipment: 0x6d665c,
          seating: 0x765b4c,
          clinical: 0xd8d0bd,
          storage: 0x725844,
          screen: 0xbca98b,
          cell: 0x2e2924,
        }
      : {
          accent: 0x72533d,
          equipment: 0x554d45,
          seating: 0x675044,
          clinical: 0xcfc4ad,
          storage: 0x4f443b,
          screen: 0xa68f70,
          cell: 0x241f1c,
        };
  }
  if (city === 'gilan') {
    return kind === 'hospital'
      ? {
          accent: 0x3f756f,
          equipment: 0x506b6a,
          seating: 0x486a61,
          clinical: 0xd5e2dc,
          storage: 0x49615b,
          screen: 0x9bb9aa,
          cell: 0x1b2928,
        }
      : {
          accent: 0x355f64,
          equipment: 0x465d62,
          seating: 0x3f5a55,
          clinical: 0xc9d9d3,
          storage: 0x405255,
          screen: 0x83a39a,
          cell: 0x172223,
        };
  }
  return kind === 'hospital'
    ? {
        accent: 0x4d8296,
        equipment: 0x506981,
        seating: 0x47606e,
        clinical: 0xd8e0e7,
        storage: 0x536675,
        screen: 0xa8c4ce,
        cell: 0x17202a,
      }
    : {
        accent: 0x2e4e82,
        equipment: 0x465060,
        seating: 0x3b4960,
        clinical: 0xcbd5df,
        storage: 0x343f51,
        screen: 0x718ca3,
        cell: 0x141922,
      };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
