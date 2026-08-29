import { createHousingCatalog } from '@/gameplay/HousingCatalog';
import { createHomeLayout } from '@/gameplay/HomeLayoutRegistry';
import {
  DRIVABLE_TILE_TYPES,
  SOLID_TILE_TYPES,
  TileType,
  type CityId,
  type MapData,
} from '@/gameplay/types';
import { HousingSystem } from '@/systems/HousingSystem';
import { ServiceLocator } from '@/core/ServiceLocator';
import { ServiceKeys } from '@/config/ServiceKeys';
import { eventBus } from '@/core/EventBus';
import { EventKeys } from '@/config/EventKeys';
import { classifyPropertyMapStatus } from '@/gameplay/HousingMapPresentation';

const failures: string[] = [];
let assertions = 0;
const check = (condition: boolean, message: string): void => {
  assertions += 1;
  if (!condition) failures.push(message);
};

check(
  classifyPropertyMapStatus('property:test', [], null) === 'for-sale',
  'unowned property must render as for-sale on the map',
);
check(
  classifyPropertyMapStatus('property:test', ['property:test'], null) === 'owned',
  'owned property must render as owned on the map',
);
check(
  classifyPropertyMapStatus('property:test', ['property:test'], 'property:test') === 'active',
  'active home must render as active on the map',
);

function fixtureMap(): MapData {
  const cities = [
    {
      id: 'tehran' as const,
      name: 'TEHRAN' as const,
      center: { x: 320, y: 320 },
      bounds: { x: 0, y: 0, width: 640, height: 640 },
      color: 0,
      theme: '',
      pedestrianDensity: 1,
      trafficDensity: 1,
      weather: 'clear' as const,
      atmosphere: {} as never,
    },
    {
      id: 'yazd' as const,
      name: 'YAZD' as const,
      center: { x: 960, y: 320 },
      bounds: { x: 640, y: 0, width: 640, height: 640 },
      color: 0,
      theme: '',
      pedestrianDensity: 1,
      trafficDensity: 1,
      weather: 'clear' as const,
      atmosphere: {} as never,
    },
    {
      id: 'gilan' as const,
      name: 'GILAN' as const,
      center: { x: 320, y: 960 },
      bounds: { x: 0, y: 640, width: 640, height: 640 },
      color: 0,
      theme: '',
      pedestrianDensity: 1,
      trafficDensity: 1,
      weather: 'clear' as const,
      atmosphere: {} as never,
    },
  ];
  const buildingEntrances = cities.flatMap((city) =>
    Array.from({ length: 5 }, (_, index) => ({
      x: city.bounds.x + 96 + index * 80,
      y: city.bounds.y + 96,
      buildingId: `${city.id}-building-${index + 1}`,
      cityId: city.id,
      buildingKind: 'house' as const,
      program: 'housing' as const,
      groundFloorUse: 'residential' as const,
    })),
  );
  const buildings = buildingEntrances.map((entry) => ({
    id: entry.buildingId,
    cityId: entry.cityId,
    district: 'residential' as const,
    bounds: {
      x: Math.floor(entry.x / 32) - 1,
      y: Math.floor(entry.y / 32) - 2,
      width: 4,
      height: 3,
    },
  }));
  return {
    widthTiles: 40,
    heightTiles: 40,
    tileSize: 32,
    cities,
    majorBuildings: [],
    buildingEntrances,
    urbanPlan: { buildings },
    tiles: Array.from({ length: 40 }, () => Array.from({ length: 40 }, () => TileType.Sidewalk)),
  } as unknown as MapData;
}

const first = fixtureMap();
const second = fixtureMap();
const catalog = createHousingCatalog(first, 1337);
const repeat = createHousingCatalog(second, 1337);
const alternateSeed = createHousingCatalog(first, 42);
check(
  JSON.stringify(catalog) === JSON.stringify(repeat),
  'catalog is not deterministic for equal world seed',
);
check(
  catalog.properties[0]?.deterministicSeed !== alternateSeed.properties[0]?.deterministicSeed,
  'layout seed must incorporate world seed',
);
check(
  Object.isFrozen(catalog.properties) && Object.isFrozen(catalog.offices),
  'catalog collections must be immutable',
);
for (const office of catalog.offices) {
  check(
    first.urbanPlan.buildings.some(
      (building) => building.id === office.buildingId && building.cityId === office.cityId,
    ),
    `${office.id} must reference a building in its city`,
  );
}
for (const property of catalog.properties) {
  check(
    first.urbanPlan.buildings.some(
      (building) => building.id === property.buildingId && building.cityId === property.cityId,
    ),
    `${property.id} must reference a building in its city`,
  );
}
check(
  new Set(catalog.properties.map((property) => property.id)).size === catalog.properties.length,
  'property ids are not unique',
);
check(
  new Set(catalog.offices.map((office) => office.id)).size === catalog.offices.length,
  'office ids are not unique',
);
for (const city of ['tehran', 'yazd', 'gilan'] as const) {
  check(
    catalog.offices.filter((office) => office.cityId === city).length === 1,
    `${city} must have exactly one real-estate office`,
  );
  check(
    catalog.properties.filter((property) => property.cityId === city).length >= 3,
    `${city} must have at least three properties`,
  );
}
const solid = new Set<number>(SOLID_TILE_TYPES);
const drivable = new Set<number>(DRIVABLE_TILE_TYPES);
for (const property of catalog.properties) {
  check(property.price >= 0, `${property.id} has a negative price`);
  const tx = Math.floor(property.entranceWorldPosition.x / first.tileSize);
  const ty = Math.floor(property.entranceWorldPosition.y / first.tileSize);
  const tile = first.tiles[ty]?.[tx];
  check(
    tile !== undefined && !solid.has(tile) && !drivable.has(tile),
    `${property.id} entrance is not on valid walkable geometry`,
  );
}
const layoutSeeds = [
  createHomeLayout('home:tehran-apartment', 1),
  createHomeLayout('home:yazd-courtyard', 2),
  createHomeLayout('home:gilan-wooden', 3),
];
check(
  JSON.stringify(layoutSeeds[0]) === JSON.stringify(createHomeLayout('home:tehran-apartment', 1)),
  'Tehran layout is not deterministic',
);
check(
  new Set(layoutSeeds.map((layout) => layout.styleId)).size === 3,
  'city layout styles are not distinct',
);
for (const city of ['tehran', 'yazd', 'gilan'] as readonly CityId[]) {
  const style =
    city === 'tehran' ? 'tehran-apartment' : city === 'yazd' ? 'yazd-courtyard' : 'gilan-wooden';
  check(
    createHomeLayout(`home:${style}`, 77).furniture.length >= 5,
    `${city} layout lacks furniture/decorations`,
  );
}

// Exercise the transaction and save/migration semantics against a tiny mocked
// player/world surface; no Phaser scene or second gameplay loop is required.
ServiceLocator.clear();
const playerState = {
  sprite: { x: 320, y: 320 },
  inventory: {
    money: 1200,
    spendMoney(amount: number): boolean {
      if (this.money < amount) return false;
      this.money -= amount;
      return true;
    },
  },
};
const fakeWorld = {
  key: ServiceKeys.World,
  isInitialised: true,
  init: (): void => undefined,
  destroy: (): void => undefined,
  map: first,
  cityAt: (x: number, y: number) =>
    first.cities.find(
      (city) =>
        x >= city.bounds.x &&
        y >= city.bounds.y &&
        x < city.bounds.x + city.bounds.width &&
        y < city.bounds.y + city.bounds.height,
    ) ?? null,
};
const fakePlayer = {
  key: ServiceKeys.Player,
  isInitialised: true,
  init: (): void => undefined,
  destroy: (): void => undefined,
  player: playerState,
};
ServiceLocator.register(fakeWorld as never);
ServiceLocator.register(fakePlayer as never);
const housing = new HousingSystem({} as never);
await housing.init();
check(
  eventBus.listenerCount(EventKeys.HomeEnterRequested) === 1,
  'housing should register one home-enter listener',
);
const tehranProperty = housing.getPropertiesForCity('tehran')[0];
if (tehranProperty) {
  const before = playerState.inventory.money;
  const purchased = housing.purchaseProperty(tehranProperty.id);
  check(
    purchased.success && purchased.reason === 'purchased',
    'purchase with sufficient funds should succeed',
  );
  check(
    playerState.inventory.money === before - tehranProperty.price,
    'successful purchase must debit exactly once',
  );
  const duplicate = housing.purchaseProperty(tehranProperty.id);
  check(
    !duplicate.success && duplicate.reason === 'already-owned',
    'duplicate purchase must be rejected',
  );
  check(
    playerState.inventory.money === before - tehranProperty.price,
    'duplicate purchase must not debit money',
  );
  const yazdProperty = housing.getPropertiesForCity('yazd')[0];
  if (yazdProperty) {
    const wrongCity = housing.purchaseProperty(yazdProperty.id);
    check(
      !wrongCity.success && wrongCity.reason === 'wrong-city',
      'purchase from another city must be rejected',
    );
  }
  housing.deserialize({
    ownedPropertyIds: ['missing-property', tehranProperty.id],
    activeHomeId: tehranProperty.id,
    schemaVersion: 1,
  });
  check(housing.isOwned(tehranProperty.id), 'valid ownership must round-trip through deserialize');
  check(
    housing.getActiveHome()?.id === tehranProperty.id,
    'active home should restore for an owned valid id',
  );
  const secondProperty = housing.getPropertiesForCity('tehran')[1];
  if (secondProperty) {
    playerState.inventory.money = 0;
    const insufficient = housing.purchaseProperty(secondProperty.id);
    check(
      !insufficient.success && insufficient.reason === 'insufficient-funds',
      'insufficient funds should reject purchase',
    );
    check(!housing.isOwned(secondProperty.id), 'insufficient funds must not mutate ownership');
  }
  housing.deserialize({ schemaVersion: 0 });
  check(
    housing.ownershipState.ownedPropertyIds.length === 0,
    'legacy save without housing state migrates to empty ownership',
  );
  housing.deserialize({
    ownedPropertyIds: [tehranProperty.id],
    activeHomeId: tehranProperty.id,
    schemaVersion: 1,
  });
  housing.onMissingSaveSection();
  check(
    housing.ownershipState.ownedPropertyIds.length === 0,
    'missing housing save section resets ownership through migration hook',
  );
  check(
    !housing.setActiveHome(tehranProperty.id),
    'active home cannot be set for an unowned property',
  );
  housing.deserialize({
    ownedPropertyIds: [tehranProperty.id],
    activeHomeId: null,
    schemaVersion: 1,
  });
  check(housing.setActiveHome(tehranProperty.id), 'owned property should become active home');
  check(
    housing.canEnterHome(tehranProperty.id, tehranProperty.entranceWorldPosition),
    'owned home should accept a player at its entrance',
  );
  check(
    !housing.canEnterHome(tehranProperty.id, {
      x: tehranProperty.entranceWorldPosition.x + 1000,
      y: tehranProperty.entranceWorldPosition.y,
    }),
    'home entry must reject an out-of-range player',
  );
}
housing.destroy();
check(
  eventBus.listenerCount(EventKeys.HomeEnterRequested) === 0,
  'housing destroy should remove home-enter listener',
);
ServiceLocator.clear();

if (failures.length > 0) {
  console.error(`Housing validation FAILED (${failures.length}/${assertions})`);
  for (const failure of failures) console.error(` - ${failure}`);
  process.exitCode = 1;
} else {
  console.log('Housing validation PASSED');
  console.log(
    `  ${catalog.properties.length} properties, ${catalog.offices.length} offices, ${assertions} deterministic checks`,
  );
}
