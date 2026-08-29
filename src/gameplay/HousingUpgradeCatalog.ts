import type { PropertyDefinition } from '@/gameplay/types/HousingTypes';
import type { PropertyUpgradeDefinition } from '@/gameplay/types/HousingPhase2Types';

const BASE_UPGRADES: ReadonlyArray<
  Omit<PropertyUpgradeDefinition, 'id' | 'propertyId' | 'cityId'>
> = [
  {
    category: 'space',
    level: 1,
    price: 650,
    prerequisiteIds: [],
    featureFlags: ['room:storage'],
    effects: { interiorArea: 1, roomStorage: true },
  },
  {
    category: 'storage',
    level: 1,
    price: 480,
    prerequisiteIds: ['space:1'],
    featureFlags: ['storage:expanded'],
    effects: { storageCapacity: 12 },
  },
  {
    category: 'garage',
    level: 1,
    price: 900,
    prerequisiteIds: [],
    featureFlags: ['garage:expanded'],
    effects: { parkingCapacity: 1 },
  },
  {
    category: 'security',
    level: 1,
    price: 720,
    prerequisiteIds: [],
    featureFlags: ['security:alarm'],
    effects: { securityRating: 1 },
  },
  {
    category: 'comfort',
    level: 1,
    price: 560,
    prerequisiteIds: [],
    featureFlags: ['comfort:climate'],
    effects: { comfort: 1 },
  },
  {
    category: 'workshop',
    level: 1,
    price: 1100,
    prerequisiteIds: ['space:1'],
    featureFlags: ['room:workshop', 'workshop:basic'],
    effects: { workshop: true },
  },
  {
    category: 'safehouse',
    level: 1,
    price: 1350,
    prerequisiteIds: ['security:1'],
    featureFlags: ['safehouse:enabled'],
    effects: { safehouse: true },
  },
  {
    category: 'space',
    level: 2,
    price: 1700,
    prerequisiteIds: ['space:1', 'storage:1'],
    featureFlags: ['room:office'],
    effects: { interiorArea: 2, roomOffice: true },
  },
  {
    category: 'garage',
    level: 2,
    price: 1800,
    prerequisiteIds: ['garage:1', 'space:1'],
    featureFlags: ['garage:double'],
    effects: { parkingCapacity: 2 },
  },
  {
    category: 'security',
    level: 2,
    price: 2100,
    prerequisiteIds: ['security:1', 'safehouse:1'],
    featureFlags: ['security:reinforced', 'room:safe'],
    effects: { securityRating: 2, safeRoom: true },
  },
  {
    category: 'comfort',
    level: 2,
    price: 1450,
    prerequisiteIds: ['comfort:1', 'space:1'],
    featureFlags: ['comfort:premium'],
    effects: { comfort: 2 },
  },
  {
    category: 'workshop',
    level: 2,
    price: 2400,
    prerequisiteIds: ['workshop:1', 'space:2'],
    featureFlags: ['workshop:advanced'],
    effects: { workshop: 'advanced' },
  },
  {
    category: 'space',
    level: 3,
    price: 3600,
    prerequisiteIds: ['space:2', 'workshop:1'],
    featureFlags: ['room:hidden'],
    effects: { interiorArea: 3, hiddenRoom: true },
  },
  {
    category: 'garage',
    level: 3,
    price: 4200,
    prerequisiteIds: ['garage:2', 'space:2'],
    featureFlags: ['garage:workshop-bay'],
    effects: { parkingCapacity: 3 },
  },
  {
    category: 'security',
    level: 3,
    price: 4800,
    prerequisiteIds: ['security:2', 'space:2'],
    featureFlags: ['security:panic-room'],
    effects: { securityRating: 3, panicRoom: true },
  },
];

/** Build immutable, property-scoped upgrade definitions from the Phase 1 catalog. */
export function createHousingUpgradeCatalog(
  properties: readonly PropertyDefinition[],
): readonly PropertyUpgradeDefinition[] {
  const definitions: PropertyUpgradeDefinition[] = [];
  for (const property of properties) {
    for (const template of BASE_UPGRADES) {
      const baseId = `${template.category}:${template.level}`;
      definitions.push({
        ...template,
        price: Math.max(
          0,
          Math.floor(
            template.price *
              (property.cityId === 'tehran' ? 1.2 : property.cityId === 'yazd' ? 0.9 : 1.05),
          ),
        ),
        id: `${property.id}:upgrade:${baseId}`,
        propertyId: property.id,
        cityId: property.cityId,
        prerequisiteIds: template.prerequisiteIds.map((id) => `${property.id}:upgrade:${id}`),
        featureFlags: [...template.featureFlags, `city:${property.cityId}`],
      });
    }
  }
  definitions.sort((a, b) => a.id.localeCompare(b.id));
  return Object.freeze(
    definitions.map((definition) =>
      Object.freeze({
        ...definition,
        prerequisiteIds: Object.freeze([...definition.prerequisiteIds]),
        featureFlags: Object.freeze([...definition.featureFlags]),
        effects: Object.freeze({ ...definition.effects }),
      }),
    ),
  );
}

/** Validate the prerequisite graph with Kahn's algorithm. */
export function validateUpgradeDag(
  definitions: readonly PropertyUpgradeDefinition[],
): readonly string[] {
  const failures: string[] = [];
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  const indegree = new Map<string, number>();
  const edges = new Map<string, string[]>();
  for (const definition of definitions) {
    indegree.set(definition.id, 0);
    edges.set(definition.id, []);
  }
  for (const definition of definitions) {
    if (definition.price < 0 || !Number.isFinite(definition.price)) {
      failures.push(`${definition.id}: invalid price`);
    }
    for (const prerequisiteId of definition.prerequisiteIds) {
      if (!byId.has(prerequisiteId)) {
        failures.push(`${definition.id}: unknown prerequisite ${prerequisiteId}`);
        continue;
      }
      indegree.set(definition.id, (indegree.get(definition.id) ?? 0) + 1);
      edges.get(prerequisiteId)?.push(definition.id);
    }
  }
  const queue = definitions
    .filter((definition) => indegree.get(definition.id) === 0)
    .map((d) => d.id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift();
    if (!id) continue;
    visited += 1;
    for (const next of edges.get(id) ?? []) {
      const nextDegree = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, nextDegree);
      if (nextDegree === 0) queue.push(next);
    }
  }
  if (visited !== definitions.length) failures.push('upgrade prerequisite cycle detected');
  return failures;
}

export function upgradeId(propertyId: string, category: string, level: number): string {
  return `${propertyId}:upgrade:${category}:${level}`;
}
