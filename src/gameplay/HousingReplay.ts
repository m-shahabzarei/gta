import { hashHousingSeed } from './HousingCatalog';
import type { HousingReplaySnapshot } from './types/HousingPhase2Types';

/** Build a canonical JSON representation so replay hashes are stable across runs. */
export function housingReplayHash(
  snapshot: Omit<HousingReplaySnapshot, 'deterministicHash'>,
): string {
  const canonical = JSON.stringify({
    worldSeed: snapshot.worldSeed,
    simulationSeed: snapshot.simulationSeed,
    simulationTick: snapshot.simulationTick,
    activeHomeId: snapshot.activeHomeId,
    ownedPropertyIds: [...snapshot.ownedPropertyIds].sort(),
    upgrades: [...snapshot.upgrades].sort((a, b) => a.upgradeId.localeCompare(b.upgradeId)),
    customization: [...snapshot.customization].sort((a, b) =>
      a.propertyId.localeCompare(b.propertyId),
    ),
    garage: [...snapshot.garage].sort((a, b) => a.slotId.localeCompare(b.slotId)),
    neighbors: [...snapshot.neighbors].sort((a, b) => a.neighborId.localeCompare(b.neighborId)),
    safehouseUses: snapshot.safehouseUses,
    housingEventCount: snapshot.housingEventCount,
  });
  return hashHousingSeed(canonical).toString(16).padStart(8, '0');
}

export function createHousingReplaySnapshot(
  data: Omit<HousingReplaySnapshot, 'deterministicHash'>,
): HousingReplaySnapshot {
  const deterministicHash = housingReplayHash(data);
  return Object.freeze({
    ...data,
    ownedPropertyIds: Object.freeze([...data.ownedPropertyIds].sort()),
    upgrades: Object.freeze(data.upgrades.map((state) => ({ ...state }))),
    customization: Object.freeze(data.customization.map((state) => ({ ...state }))),
    garage: Object.freeze(data.garage.map((state) => ({ ...state }))),
    neighbors: Object.freeze(data.neighbors.map((state) => ({ ...state }))),
    deterministicHash,
  });
}
