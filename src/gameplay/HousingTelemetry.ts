import { EventKeys } from '@/config/EventKeys';
import { eventBus } from '@/core/EventBus';
import { ServiceKeys } from '@/config/ServiceKeys';
import { ServiceLocator } from '@/core/ServiceLocator';
import { HOUSING_WORLD_SEED } from './HousingCatalog';
import type { HousingSystem } from '@/systems/HousingSystem';
import type { HousingReplaySnapshot } from './types/HousingPhase2Types';

/** Emit a complete, schema-stable housing diagnostic event. */
export function emitHousingTelemetry(
  event: string,
  propertyId: string,
  result: string,
  denialReason: string | null = null,
  elapsedMs: number | 'unknown' = 'unknown',
): void {
  const housing = ServiceLocator.tryResolve<HousingSystem>(ServiceKeys.Housing);
  const property = housing?.getProperty(propertyId);
  const dayNight = ServiceLocator.tryResolve(ServiceKeys.DayNight) as unknown as {
    getTimeLabel?: () => string;
  } | null;
  const replayKey = `${event}:${propertyId}:${result}`;
  const progression = ServiceLocator.tryResolve(ServiceKeys.HousingProgression) as unknown as {
    currentSimulationTick?: number;
  } | null;
  eventBus.emit(EventKeys.HousingTelemetry, {
    event,
    simulationTick: progression?.currentSimulationTick ?? 0,
    simulationClock: dayNight?.getTimeLabel?.() ?? 'unknown',
    worldSeed: HOUSING_WORLD_SEED,
    simulationSeed: HOUSING_WORLD_SEED,
    city: property?.cityId ?? 'unknown',
    district: property?.districtId ?? 'unknown',
    propertyId,
    playerId: 'player:local',
    ownershipClass: property && housing?.isOwned(propertyId) ? 'owned' : 'unowned',
    currentScene: 'unknown',
    activeHome: housing?.getActiveHome()?.id ?? null,
    result,
    denialReason,
    elapsedMs,
    deterministicReplayKey: replayKey,
  });
}

export function replayKeyFor(snapshot: HousingReplaySnapshot): string {
  return `housing:${snapshot.worldSeed}:${snapshot.simulationSeed}:${snapshot.simulationTick}:${snapshot.deterministicHash}`;
}
