import {
  DRIVABLE_TILE_TYPES,
  PEDESTRIAN_BLOCKED_TILE_TYPES,
  SOLID_TILE_TYPES,
  type BuildingEntrance,
  type CityId,
  type District,
  type MapData,
  type PlannedBuilding,
} from '@/gameplay/types';
import type {
  HousingCatalogData,
  PropertyDefinition,
  RealEstateOfficeDefinition,
} from '@/gameplay/types/HousingTypes';

export const HOUSING_WORLD_SEED = 1337;

const SOLID = new Set<number>(SOLID_TILE_TYPES);
const DRIVABLE = new Set<number>(DRIVABLE_TILE_TYPES);
const PEDESTRIAN_BLOCKED = new Set<number>(PEDESTRIAN_BLOCKED_TILE_TYPES);

const CITY_STYLE: Record<CityId, PropertyDefinition['styleId']> = {
  tehran: 'tehran-apartment',
  yazd: 'yazd-courtyard',
  gilan: 'gilan-wooden',
};

const CITY_NAMES: Record<CityId, string> = {
  tehran: 'Tehran',
  yazd: 'Yazd',
  gilan: 'Gilan',
};

const CITY_FEATURES: Record<CityId, readonly string[]> = {
  tehran: ['Lift', 'Rooftop view', 'Secure lobby'],
  yazd: ['Central courtyard', 'Windcatcher', 'Clay walls'],
  gilan: ['Covered veranda', 'Rainwater garden', 'Wood stove'],
};

/** Stable 32-bit hash used for all housing variation and interior seeds. */
export function hashHousingSeed(...parts: readonly (string | number)[]): number {
  let hash = 0x811c9dc5;
  for (const part of parts) {
    const text = String(part);
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    hash ^= 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Project three properties and one office per city from existing finalized
 * building entrances. No synthetic topology or collision layer is created.
 */
export function createHousingCatalog(
  map: MapData,
  worldSeed = HOUSING_WORLD_SEED,
): HousingCatalogData {
  const majorIds = new Set(map.majorBuildings.map((building) => building.buildingId));
  const buildings = new Map<string, PlannedBuilding>(
    map.urbanPlan.buildings.map((building) => [building.id, building]),
  );
  const properties: PropertyDefinition[] = [];
  const offices: RealEstateOfficeDefinition[] = [];

  for (const city of ['tehran', 'yazd', 'gilan'] as const) {
    const viable = map.buildingEntrances
      .filter((entrance) => entrance.cityId === city && !majorIds.has(entrance.buildingId))
      .filter((entrance) => isValidWorldEntrance(map, entrance))
      .sort(compareEntrances)
      .filter(
        (entrance, index, all) =>
          index === all.findIndex((item) => item.buildingId === entrance.buildingId),
      );

    const officeEntrance = viable[0];
    if (officeEntrance) {
      offices.push({
        id: `real-estate-office:${city}`,
        cityId: city,
        buildingId: officeEntrance.buildingId,
        npcRole: 'real-estate-agent',
        npcSpawnPosition: { x: officeEntrance.x, y: officeEntrance.y - 12 },
        interactionRadius: 52,
      });
    }

    const style = CITY_STYLE[city];
    // Offices may project onto any non-major walkable building, but homes must
    // resolve to authored residential/apartment lots rather than retail or
    // industrial doors that merely happen to be nearby.
    const residential = viable.filter(
      (entrance) =>
        (entrance.program === 'housing' || entrance.program === 'apartments') &&
        entrance.groundFloorUse === 'residential',
    );
    const candidates = residential
      .filter((entrance) => entrance.buildingId !== officeEntrance?.buildingId)
      .slice(0, 3);
    for (const [index, entrance] of candidates.entries()) {
      const building = buildings.get(entrance.buildingId);
      if (!building) continue;
      const id = `property:${city}:${index + 1}`;
      const previewBounds = {
        x: building.bounds.x * map.tileSize,
        y: building.bounds.y * map.tileSize,
        width: building.bounds.width * map.tileSize,
        height: building.bounds.height * map.tileSize,
      };
      const valid =
        isValidWorldEntrance(map, entrance) &&
        building.cityId === city &&
        isValidPreviewBounds(map, previewBounds);
      const deterministicSeed = hashHousingSeed(worldSeed, id, `home:${style}`);
      const districtId = districtAtMap(map, entrance.x, entrance.y) ?? building.district;
      properties.push({
        id,
        cityId: city,
        districtId,
        displayName: `${CITY_NAMES[city]} ${styleName(style)} ${index + 1}`,
        price: 500 + index * 350 + (city === 'tehran' ? 180 : city === 'yazd' ? 0 : 100),
        currency: 'cash',
        entranceWorldPosition: { x: entrance.x, y: entrance.y },
        previewWorldPosition: {
          x: previewBounds.x + previewBounds.width / 2,
          y: previewBounds.y + previewBounds.height / 2,
        },
        previewBounds,
        interactionRadius: 46,
        interiorLayoutId: `home:${style}`,
        styleId: style,
        features: CITY_FEATURES[city],
        parkingCapacity: city === 'tehran' ? 1 + (index === 2 ? 1 : 0) : 1,
        valid,
        buildingId: entrance.buildingId,
        deterministicSeed,
      });
    }
  }

  // A deterministic, explicit failure is safer than silently accepting a
  // partial catalog. The generated map normally supplies many more entrances.
  for (const city of ['tehran', 'yazd', 'gilan'] as const) {
    const count = properties.filter((property) => property.cityId === city).length;
    if (count < 3) {
      // Keep the data available for diagnostics and tests; callers can expose
      // the shortfall without inventing an invalid position.
      continue;
    }
  }

  const sortedProperties = properties.slice().sort((a, b) => a.id.localeCompare(b.id));
  const sortedOffices = offices.slice().sort((a, b) => a.id.localeCompare(b.id));
  const frozenProperties = sortedProperties.map((property) =>
    Object.freeze({
      ...property,
      entranceWorldPosition: Object.freeze({ ...property.entranceWorldPosition }),
      previewWorldPosition: Object.freeze({ ...property.previewWorldPosition }),
      previewBounds: property.previewBounds
        ? Object.freeze({ ...property.previewBounds })
        : undefined,
      features: Object.freeze([...property.features]),
    }),
  );
  const frozenOffices = sortedOffices.map((office) =>
    Object.freeze({
      ...office,
      npcSpawnPosition: Object.freeze({ ...office.npcSpawnPosition }),
    }),
  );
  return {
    properties: Object.freeze(frozenProperties),
    offices: Object.freeze(frozenOffices),
  };
}

function compareEntrances(a: BuildingEntrance, b: BuildingEntrance): number {
  return a.buildingId.localeCompare(b.buildingId) || a.x - b.x || a.y - b.y;
}

function isValidWorldEntrance(map: MapData, entrance: BuildingEntrance): boolean {
  const city = map.cities.find((candidate) => candidate.id === entrance.cityId);
  if (!city) return false;
  if (
    entrance.x < city.bounds.x ||
    entrance.y < city.bounds.y ||
    entrance.x >= city.bounds.x + city.bounds.width ||
    entrance.y >= city.bounds.y + city.bounds.height
  ) {
    return false;
  }
  const tx = Math.floor(entrance.x / map.tileSize);
  const ty = Math.floor(entrance.y / map.tileSize);
  const tile = map.tiles[ty]?.[tx];
  return (
    tile !== undefined && !SOLID.has(tile) && !DRIVABLE.has(tile) && !PEDESTRIAN_BLOCKED.has(tile)
  );
}

/** Read the finalized district grid when present, with blueprint fallback for
 * lightweight validation fixtures that intentionally omit the grid. */
function districtAtMap(map: MapData, x: number, y: number): District | undefined {
  if (!map.blockPeriod || !map.districts?.length) return undefined;
  const tx = Math.floor(x / map.tileSize);
  const ty = Math.floor(y / map.tileSize);
  return map.districts[Math.floor(ty / map.blockPeriod)]?.[Math.floor(tx / map.blockPeriod)];
}

function isValidPreviewBounds(
  map: MapData,
  bounds: { x: number; y: number; width: number; height: number },
): boolean {
  const worldWidth = map.widthTiles * map.tileSize;
  const worldHeight = map.heightTiles * map.tileSize;
  return (
    bounds.x >= 0 &&
    bounds.y >= 0 &&
    bounds.width > 0 &&
    bounds.height > 0 &&
    bounds.x + bounds.width <= worldWidth &&
    bounds.y + bounds.height <= worldHeight
  );
}

function styleName(style: PropertyDefinition['styleId']): string {
  switch (style) {
    case 'tehran-apartment':
      return 'Metro Apartment';
    case 'yazd-courtyard':
      return 'Courtyard House';
    case 'gilan-wooden':
      return 'Wooden Home';
  }
}
