import { createHousingCatalog } from '@/gameplay/HousingCatalog';
import { createHousingReplaySnapshot, housingReplayHash } from '@/gameplay/HousingReplay';
import { createHomeLayout } from '@/gameplay/HomeLayoutRegistry';
import { createHousingUpgradeCatalog, validateUpgradeDag } from '@/gameplay/HousingUpgradeCatalog';
import { TileType, type MapData } from '@/gameplay/types';
import { EventKeys } from '@/config/EventKeys';
import { eventBus } from '@/core/EventBus';
import { ServiceLocator } from '@/core/ServiceLocator';
import { ServiceKeys } from '@/config/ServiceKeys';
import { HousingSystem } from '@/systems/HousingSystem';
import { HousingProgressionSystem } from '@/systems/HousingProgressionSystem';
import { HomeCustomizationSystem } from '@/systems/HomeCustomizationSystem';

let assertions = 0;
const failures: string[] = [];
const check = (condition: boolean, message: string): void => {
  assertions += 1;
  if (!condition) failures.push(message);
};

const map = {
  widthTiles: 60,
  heightTiles: 20,
  tileSize: 32,
  cities: [
    {
      id: 'tehran',
      name: 'TEHRAN',
      center: { x: 960, y: 320 },
      bounds: { x: 0, y: 0, width: 1920, height: 640 },
      color: 0,
      theme: '',
      pedestrianDensity: 1,
      trafficDensity: 1,
      weather: 'clear',
      atmosphere: {},
    },
  ],
  majorBuildings: [],
  buildingEntrances: Array.from({ length: 5 }, (_, index) => ({
    x: 200 + index * 220,
    y: 256,
    buildingId: `home-${index + 1}`,
    cityId: 'tehran',
    buildingKind: 'house',
    program: 'housing',
    groundFloorUse: 'residential',
  })),
  urbanPlan: {
    buildings: Array.from({ length: 5 }, (_, index) => ({
      id: `home-${index + 1}`,
      cityId: 'tehran',
      district: 'residential',
      bounds: { x: 5 + index * 7, y: 6, width: 4, height: 3 },
    })),
  },
  tiles: Array.from({ length: 20 }, () => Array.from({ length: 60 }, () => TileType.Sidewalk)),
  properties: [],
  realEstateOffices: [],
} as unknown as MapData;
const catalog = createHousingCatalog(map, 1337);
const properties = catalog.properties.slice(0, 3);
check(properties.length === 3, 'fixture should expose three properties');
const upgradeCatalog = createHousingUpgradeCatalog(properties);
check(
  upgradeCatalog.length === properties.length * 15,
  'every property should have the full upgrade catalog',
);
check(
  validateUpgradeDag(upgradeCatalog).length === 0,
  `upgrade prerequisite graph must be acyclic and resolvable: ${validateUpgradeDag(upgradeCatalog).join(';')}`,
);
check(
  new Set(upgradeCatalog.map((definition) => definition.id)).size === upgradeCatalog.length,
  'upgrade ids must be unique',
);
check(
  upgradeCatalog.every((definition) => definition.price >= 0),
  'upgrade prices must be non-negative',
);

for (const style of ['tehran-apartment', 'yazd-courtyard', 'gilan-wooden'] as const) {
  const layout = createHomeLayout(`home:${style}`, 42);
  check(layout.rooms.length >= 4, `${style} should expose room definitions`);
  check(layout.slots.length >= 4, `${style} should expose furniture slots`);
  check(
    JSON.stringify(layout) === JSON.stringify(createHomeLayout(`home:${style}`, 42)),
    `${style} layout must be deterministic`,
  );
}

ServiceLocator.clear();
const player = {
  sprite: { x: 200, y: 256 },
  inventory: {
    money: 10000,
    spendMoney(amount: number): boolean {
      if (this.money < amount) return false;
      this.money -= amount;
      return true;
    },
  },
};
const world = {
  key: ServiceKeys.World,
  isInitialised: true,
  init: (): void => undefined,
  destroy: (): void => undefined,
  map: { ...map, properties, realEstateOffices: catalog.offices },
  cityAt: (): { id: 'tehran' } => ({ id: 'tehran' }),
};
const playerService = {
  key: ServiceKeys.Player,
  isInitialised: true,
  init: (): void => undefined,
  destroy: (): void => undefined,
  player,
  playerPosition: { x: 200, y: 256 },
};
ServiceLocator.register(world as never);
ServiceLocator.register(playerService as never);
const housing = new HousingSystem({} as never);
await housing.init();
ServiceLocator.register(housing as never);
const progression = new HousingProgressionSystem({} as never);
await progression.init();
ServiceLocator.register(progression as never);
const customization = new HomeCustomizationSystem({} as never);
await customization.init();
ServiceLocator.register(customization as never);

const property = properties[0];
if (property) {
  const purchased = housing.purchaseProperty(property.id);
  check(purchased.success, 'property purchase should succeed with funds');
  const firstUpgrade = progression
    .getUpgradeDefinitions(property.id)
    .find((definition) => definition.category === 'space' && definition.level === 1);
  const storageUpgrade = progression
    .getUpgradeDefinitions(property.id)
    .find((definition) => definition.category === 'storage');
  check(
    firstUpgrade !== undefined && progression.purchaseUpgrade(property.id, firstUpgrade.id).success,
    'space upgrade should succeed',
  );
  check(
    storageUpgrade !== undefined &&
      progression.purchaseUpgrade(property.id, storageUpgrade.id).success,
    'prerequisite upgrade should succeed',
  );
  check(
    firstUpgrade !== undefined &&
      !progression.purchaseUpgrade(property.id, firstUpgrade.id).success,
    'duplicate upgrade should be rejected',
  );
  const safehouse = progression
    .getUpgradeDefinitions(property.id)
    .find((definition) => definition.category === 'safehouse');
  check(
    safehouse !== undefined && !progression.canPurchaseUpgrade(property.id, safehouse.id),
    'safehouse prerequisite should be enforced',
  );
  const sofaSlot = customization
    .getSlots(property.id)
    .find((slot) => slot.allowedCategories.includes('sofa'));
  check(sofaSlot !== undefined, 'owned property should expose sofa slot');
  if (sofaSlot) {
    const placement = {
      slotId: sofaSlot.id,
      itemId: 'sofa:basic',
      variantId: 'default',
      rotation: 0 as const,
    };
    check(
      customization.validatePlacement(property.id, placement).valid,
      'valid furniture placement should pass',
    );
    check(
      customization.applyPreview(property.id, [placement]).success,
      'Apply should commit customization',
    );
    const duplicateApply = customization.applyPreview(property.id, [placement, placement]);
    check(!duplicateApply.success, 'duplicate furniture placement should be rejected atomically');
    check(
      customization.getCustomization(property.id).placements.length === 1,
      'duplicate furniture rejection must preserve the previous committed layout',
    );

    // A save can contain two entries targeting one slot with different
    // variants. Deserialization must validate the complete set sequentially,
    // rather than accepting each entry against an empty preview.
    customization.deserialize({
      schemaVersion: 2,
      states: [
        {
          propertyId: property.id,
          revision: 4,
          placements: [placement, { ...placement, variantId: 'modern' }],
        },
      ],
    });
    check(
      customization.getCustomization(property.id).placements.length === 1,
      'load should ignore colliding furniture entries while retaining valid entries',
    );
    customization.beginPreview(property.id);
    check(
      !customization.validatePlacement(property.id, { ...placement, slotId: 'missing' }).valid,
      'unknown slot should be rejected',
    );
    customization.cancelPreview(property.id);
  }
  const save = customization.serialize();
  customization.deserialize(save);
  check(
    customization.getCustomization(property.id).revision === 4,
    'customization should round-trip its revision',
  );
}

const snapshot = createHousingReplaySnapshot({
  worldSeed: 1337,
  simulationSeed: 7,
  simulationTick: 12,
  activeHomeId: null,
  ownedPropertyIds: [],
  upgrades: [],
  customization: [],
  garage: [],
  neighbors: [],
  safehouseUses: 0,
  housingEventCount: 0,
});
check(
  snapshot.deterministicHash ===
    housingReplayHash({ ...snapshot, deterministicHash: undefined } as never),
  'replay hash should be deterministic',
);
check(
  snapshot.deterministicHash ===
    createHousingReplaySnapshot({ ...snapshot, deterministicHash: undefined } as never)
      .deterministicHash,
  'replay snapshots should hash equally',
);
check(
  eventBus.listenerCount(EventKeys.PropertyUpgradePurchaseRequested) >= 1,
  'progression should register one upgrade request listener',
);

customization.destroy();
progression.destroy();
housing.destroy();
ServiceLocator.clear();
if (failures.length > 0) {
  console.error(`Housing Phase 2 validation FAILED (${failures.length}/${assertions})`);
  for (const failure of failures) console.error(` - ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Housing Phase 2 validation PASSED (${assertions} checks)`);
}
