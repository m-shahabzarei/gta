import { GAME_WIDTH } from '@/config/Constants';
import type { PropertyDefinition } from '@/gameplay/types/HousingTypes';

export interface HomeRectSpec {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly color: number;
  readonly label?: string;
}

export interface HomeZoneSpec {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly prompt: string;
  readonly action: 'exit';
}

export interface HomeRoomSpec {
  readonly id: string;
  readonly anchor: { x: number; y: number };
  readonly bounds: { x: number; y: number; width: number; height: number };
  readonly entryPoint: { x: number; y: number };
  readonly unlockUpgradeIds: readonly string[];
  readonly featureTags: readonly string[];
}

export interface HomeSlotSpec {
  readonly id: string;
  readonly roomId: string;
  readonly allowedCategories: readonly string[];
  readonly anchor: { x: number; y: number };
  readonly bounds: { x: number; y: number; width: number; height: number };
  readonly collisionBounds?: { x: number; y: number; width: number; height: number };
  readonly maxItems: number;
}

export interface HomeLayoutSpec {
  readonly styleId: PropertyDefinition['styleId'];
  readonly title: string;
  readonly subtitle: string;
  readonly floor: number;
  readonly walls: readonly HomeRectSpec[];
  readonly furniture: readonly HomeRectSpec[];
  readonly zones: readonly HomeZoneSpec[];
  readonly rooms: readonly HomeRoomSpec[];
  readonly slots: readonly HomeSlotSpec[];
  readonly spawn: { x: number; y: number };
}

const OUTER_W = 1108;
const OUTER_H = 566;
const LEFT = 86;
const TOP = 72;

const room = (
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  entryX: number,
  entryY: number,
  unlockUpgradeIds: readonly string[] = [],
  featureTags: readonly string[] = [],
): HomeRoomSpec => ({
  id,
  anchor: { x: x + width / 2, y: y + height / 2 },
  bounds: { x, y, width, height },
  entryPoint: { x: entryX, y: entryY },
  unlockUpgradeIds,
  featureTags,
});

const slot = (
  id: string,
  roomId: string,
  x: number,
  y: number,
  width: number,
  height: number,
  allowedCategories: readonly string[],
  maxItems = 1,
): HomeSlotSpec => ({
  id,
  roomId,
  allowedCategories,
  anchor: { x: x + width / 2, y: y + height / 2 },
  bounds: { x, y, width, height },
  maxItems,
});

const upgradeSuffix = (category: string, level: number): string => `upgrade:${category}:${level}`;

/** Deterministic, data-only home layouts shared by all Home-mode scene runs. */
export function createHomeLayout(layoutId: string, seed: number): HomeLayoutSpec {
  const style = layoutId.replace(/^home:/, '') as PropertyDefinition['styleId'];
  const variant = seed % 3;
  const baseWalls: HomeRectSpec[] = [
    { x: LEFT, y: TOP, w: OUTER_W, h: 12, color: 0x16131a },
    { x: LEFT, y: TOP + OUTER_H - 12, w: OUTER_W, h: 12, color: 0x16131a },
    { x: LEFT, y: TOP, w: 12, h: OUTER_H, color: 0x16131a },
    { x: LEFT + OUTER_W - 12, y: TOP, w: 12, h: OUTER_H, color: 0x16131a },
  ];
  const exit = {
    x: GAME_WIDTH / 2 - 58,
    y: TOP + OUTER_H - 54,
    w: 116,
    h: 42,
    prompt: 'E  Leave home',
    action: 'exit' as const,
  };

  if (style === 'yazd-courtyard') {
    const clay = variant === 0 ? 0x956b4e : variant === 1 ? 0xa97856 : 0x8e6248;
    return {
      styleId: style,
      title: 'Yazd Courtyard House',
      subtitle: 'Adobe walls · central courtyard · windcatcher',
      floor: 0x3c2a25,
      walls: [
        ...baseWalls,
        { x: 410, y: 180, w: 12, h: 280, color: clay },
        { x: 850, y: 180, w: 12, h: 280, color: clay },
      ],
      furniture: [
        { x: 170, y: 150, w: 180, h: 42, color: clay, label: 'SITTING ROOM' },
        { x: 500, y: 240, w: 260, h: 170, color: 0x27433a, label: 'COURTYARD' },
        { x: 920, y: 150, w: 190, h: 42, color: 0xb4885f, label: 'KITCHEN' },
        { x: 930, y: 270, w: 150, h: 70, color: 0x6c4939, label: 'BEDROOM' },
        { x: 200, y: 420, w: 190, h: 32, color: 0x6c4939, label: 'STORAGE' },
        { x: 515, y: 275, w: 40, h: 40, color: 0x65a9a0, label: 'FOUNTAIN' },
        { x: 640 + variant * 24, y: 500, w: 78, h: 18, color: 0xc69a6b, label: 'RUG' },
      ],
      zones: [exit],
      rooms: [
        room('sitting', 120, 108, 270, 300, 400, 250, [], ['courtyard', 'sitting']),
        room('courtyard', 430, 190, 400, 280, 430, 330, [], ['courtyard']),
        room('kitchen', 870, 108, 260, 190, 840, 250, [], ['kitchen', 'adobe']),
        room('bedroom', 870, 300, 260, 170, 840, 420, [], ['sleep']),
        room('storage', 120, 410, 270, 80, 400, 420, [upgradeSuffix('space', 1)], ['storage']),
      ],
      slots: [
        slot('sitting-rug', 'sitting', 175, 270, 160, 70, ['decorative', 'sofa']),
        slot('courtyard-fountain', 'courtyard', 580, 260, 80, 80, ['decorative', 'lighting']),
        slot('kitchen-unit', 'kitchen', 905, 200, 160, 54, ['kitchen']),
        slot('bedroom-bed', 'bedroom', 920, 330, 150, 70, ['bed']),
        slot('storage-chest', 'storage', 180, 425, 130, 42, ['storage']),
      ],
      spawn: { x: 640, y: 560 },
    };
  }

  if (style === 'gilan-wooden') {
    const wood = variant === 0 ? 0x6d8e83 : variant === 1 ? 0x5f7e78 : 0x789b8d;
    return {
      styleId: style,
      title: 'Gilan Wooden House',
      subtitle: 'Rainy veranda · timber rooms · garden light',
      floor: 0x243b3d,
      walls: [
        ...baseWalls,
        { x: 300, y: 190, w: 12, h: 250, color: wood },
        { x: 780, y: 190, w: 12, h: 250, color: wood },
      ],
      furniture: [
        { x: 140, y: 120, w: 100, h: 390, color: 0x315e56, label: 'VERANDA' },
        { x: 370, y: 160, w: 230, h: 58, color: wood, label: 'LIVING ROOM' },
        { x: 400, y: 310, w: 150, h: 78, color: 0x4d6c62, label: 'BEDROOM' },
        { x: 900, y: 170, w: 190, h: 46, color: 0x8ba79a, label: 'KITCHEN' },
        { x: 920, y: 300, w: 150, h: 60, color: 0x4c6862, label: 'PANTRY' },
        { x: 350, y: 470, w: 220, h: 34, color: 0x6b4939, label: 'DINING TABLE' },
        { x: 620 + variant * 18, y: 500, w: 180, h: 20, color: 0x4a766d, label: 'RAIN GARDEN' },
      ],
      zones: [exit],
      rooms: [
        room('veranda', 120, 108, 150, 390, 300, 250, [], ['veranda', 'garden']),
        room('living', 320, 108, 450, 270, 300, 250, [], ['living', 'timber']),
        room('bedroom', 320, 380, 450, 130, 300, 420, [], ['sleep']),
        room('kitchen', 805, 108, 325, 270, 790, 250, [], ['kitchen']),
        room('pantry', 805, 380, 325, 130, 790, 420, [upgradeSuffix('storage', 1)], ['storage']),
      ],
      slots: [
        slot('veranda-planter', 'veranda', 145, 280, 100, 90, ['decorative', 'lighting']),
        slot('living-sofa', 'living', 370, 210, 180, 72, ['sofa']),
        slot('bedroom-bed', 'bedroom', 430, 405, 170, 70, ['bed']),
        slot('kitchen-unit', 'kitchen', 870, 205, 180, 54, ['kitchen']),
        slot('pantry-storage', 'pantry', 860, 420, 150, 52, ['storage']),
      ],
      spawn: { x: 640, y: 560 },
    };
  }

  const modern = variant === 0 ? 0x566274 : variant === 1 ? 0x4b596e : 0x626b7c;
  return {
    styleId: 'tehran-apartment',
    title: 'Tehran Metro Apartment',
    subtitle: 'Compact modern apartment · secure lobby · city lights',
    floor: 0x2e3342,
    walls: [
      ...baseWalls,
      { x: 430, y: 180, w: 12, h: 220, color: modern },
      { x: 820, y: 180, w: 12, h: 220, color: modern },
    ],
    furniture: [
      { x: 150, y: 135, w: 230, h: 58, color: modern, label: 'LIVING ROOM' },
      { x: 500, y: 145, w: 250, h: 46, color: 0x8b654e, label: 'KITCHEN' },
      { x: 500, y: 280, w: 180, h: 78, color: 0x5b6173, label: 'BEDROOM' },
      { x: 900, y: 150, w: 190, h: 70, color: 0x394c69, label: 'STUDY' },
      { x: 920, y: 320, w: 130, h: 68, color: 0x8b654e, label: 'BATHROOM' },
      { x: 180, y: 430, w: 220, h: 34, color: 0x6d7486, label: 'DINING TABLE' },
      { x: 610 + variant * 20, y: 485, w: 180, h: 24, color: 0x3c6d8f, label: 'WINDOW VIEW' },
    ],
    zones: [exit],
    rooms: [
      room('living', 120, 108, 290, 300, 420, 250, [], ['living', 'urban']),
      room('kitchen', 455, 108, 340, 190, 450, 250, [], ['kitchen']),
      room('bedroom', 455, 300, 340, 170, 450, 420, [], ['sleep']),
      room('study', 835, 108, 300, 270, 825, 250, [upgradeSuffix('space', 2)], ['work']),
      room('bathroom', 835, 300, 300, 170, 825, 420, [], ['comfort']),
    ],
    slots: [
      slot('living-sofa', 'living', 165, 210, 170, 70, ['sofa']),
      slot('living-table', 'living', 180, 320, 130, 44, ['table', 'decorative']),
      slot('kitchen-unit', 'kitchen', 520, 200, 180, 54, ['kitchen']),
      slot('bedroom-bed', 'bedroom', 530, 330, 150, 72, ['bed']),
      slot('study-desk', 'study', 900, 220, 150, 60, ['desk', 'workshop']),
      slot('bathroom-storage', 'bathroom', 900, 340, 130, 44, ['storage', 'decorative']),
    ],
    spawn: { x: 640, y: 560 },
  };
}
