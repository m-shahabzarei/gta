import { BaseManager } from '@/core/BaseManager';
import { EngineDiagnostics } from '@/core/EngineDiagnostics';
import type { ISerializable } from '@/core/interfaces';
import type { Json, Vector2 } from '@/core/types';
import { EventKeys } from '@/config/EventKeys';
import { ServiceKeys } from '@/config/ServiceKeys';
import { ServiceLocator } from '@/core/ServiceLocator';
import { hashHousingSeed } from '@/gameplay/HousingCatalog';
import { emitHousingTelemetry } from '@/gameplay/HousingTelemetry';
import { PED_PROFILES } from '@/data';
import type { HousingSystem } from './HousingSystem';
import type { PedestrianSystem } from './PedestrianSystem';
import type {
  NeighborDefinition,
  NeighborInteractionResult,
  NeighborRelationshipState,
} from '@/gameplay/types/HousingPhase2Types';

const SCHEMA_VERSION = 1;
const INTERACTION_COOLDOWN_TICKS = 180;

/** Resident projection backed by the existing pooled PedestrianSystem. */
export class NeighborhoodSystem extends BaseManager implements ISerializable {
  public readonly key = ServiceKeys.Neighborhood;
  public readonly saveId = 'housing-neighborhood';

  private readonly definitions = new Map<string, NeighborDefinition[]>();
  private readonly relationships = new Map<string, NeighborRelationshipState>();
  private readonly activeResidents = new Map<string, number>();
  private readonly lastInteractionTick = new Map<string, number>();
  private simulationTick = 0;

  protected onInit(): void {
    const housing = this.resolveHousing();
    for (const property of housing?.catalog ?? []) {
      const routine =
        property.cityId === 'tehran'
          ? 'commercial-commute'
          : property.cityId === 'yazd'
            ? 'local-market'
            : 'rain-garden';
      const definition: NeighborDefinition = {
        id: `${property.id}:neighbor:1`,
        propertyId: property.id,
        role:
          property.cityId === 'tehran'
            ? 'apartment neighbour'
            : property.cityId === 'yazd'
              ? 'courtyard elder'
              : 'veranda gardener',
        routineId: routine,
        dialogueSetId: `dialogue:${property.cityId}:neighbor`,
        interactionTags: [property.cityId, property.districtId, routine],
      };
      this.definitions.set(property.id, [Object.freeze(definition)]);
    }
    this.subscribe(EventKeys.HomeEnterAccepted, ({ propertyId }) =>
      this.activateResidents(propertyId),
    );
    this.subscribe(EventKeys.HomeExited, ({ propertyId }) => this.deactivateResidents(propertyId));
  }

  public update(_time: number, _delta: number): void {
    this.simulationTick += 1;
  }

  public getNeighbors(propertyId: string): readonly NeighborDefinition[] {
    return this.definitions.get(propertyId) ?? [];
  }

  public routineFor(
    neighborId: string,
    simulationTick = this.simulationTick,
  ): 'home' | 'work' | 'market' | 'social' | 'sleep' | 'unavailable' {
    const definition = this.findNeighbor(neighborId);
    if (!definition) return 'unavailable';
    const phase = Math.floor(simulationTick / 600) % 6;
    const offset = hashHousingSeed(neighborId, definition.routineId) % 6;
    const states: readonly ['home', 'work', 'market', 'social', 'sleep', 'unavailable'] = [
      'home',
      'work',
      'market',
      'social',
      'sleep',
      'unavailable',
    ];
    return states[(phase + offset) % states.length] ?? 'unavailable';
  }

  public getRelationship(neighborId: string): NeighborRelationshipState {
    return (
      this.relationships.get(neighborId) ?? { neighborId, affinity: 0, completedInteractionIds: [] }
    );
  }

  public allRelationships(): readonly NeighborRelationshipState[] {
    return Array.from(this.relationships.values()).sort((a, b) =>
      a.neighborId.localeCompare(b.neighborId),
    );
  }

  public interact(neighborId: string, interactionId = 'greeting'): NeighborInteractionResult {
    const definition = this.findNeighbor(neighborId);
    if (!definition)
      {return {
        success: false,
        neighborId,
        interactionId,
        affinityDelta: 0,
        reason: 'unknown-neighbor',
      };}
    if (!this.resolveHousing()?.isOwned(definition.propertyId))
      {return {
        success: false,
        neighborId,
        interactionId,
        affinityDelta: 0,
        reason: 'not-owned-property',
      };}
    const last = this.lastInteractionTick.get(neighborId) ?? -Infinity;
    if (this.simulationTick - last < INTERACTION_COOLDOWN_TICKS)
      {return { success: false, neighborId, interactionId, affinityDelta: 0, reason: 'cooldown' };}
    const before = this.getRelationship(neighborId);
    const completed = new Set(before.completedInteractionIds);
    const affinityDelta = completed.has(interactionId) ? 0 : 1;
    completed.add(interactionId);
    const next: NeighborRelationshipState = {
      neighborId,
      affinity: Math.max(-100, Math.min(100, before.affinity + affinityDelta)),
      completedInteractionIds: Array.from(completed).sort(),
    };
    this.relationships.set(neighborId, next);
    this.lastInteractionTick.set(neighborId, this.simulationTick);
    const result: NeighborInteractionResult = {
      success: true,
      neighborId,
      interactionId,
      affinityDelta,
      reason: 'accepted',
    };
    this.bus.emit(EventKeys.NeighborInteractionRequested, { neighborId, interactionId });
    this.bus.emit(EventKeys.NeighborInteractionCompleted, result);
    if (affinityDelta !== 0)
      {this.bus.emit(EventKeys.NeighborAffinityChanged, {
        neighborId,
        affinity: next.affinity,
        delta: affinityDelta,
      });}
    emitHousingTelemetry('neighbor-interaction', definition.propertyId, 'success');
    return result;
  }

  /** Materialize one resident per definition through PedestrianSystem pooling. */
  public activateResidents(propertyId: string, positions?: readonly Vector2[]): readonly number[] {
    if (!this.resolveHousing()?.isOwned(propertyId)) return [];
    const pedestrians = this.resolvePedestrians();
    const property = this.resolveHousing()?.getProperty(propertyId);
    if (!pedestrians || !property) return [];
    const ids: number[] = [];
    for (const [index, definition] of this.getNeighbors(propertyId).entries()) {
      if (this.activeResidents.has(definition.id)) {
        ids.push(this.activeResidents.get(definition.id) as number);
        continue;
      }
      const requested = positions?.[index] ?? {
        x: property.entranceWorldPosition.x,
        y: property.entranceWorldPosition.y,
      };
      const profile =
        PED_PROFILES[
          hashHousingSeed(property.id, definition.id) % Math.max(1, PED_PROFILES.length)
        ];
      if (!profile) continue;
      const ped = pedestrians.spawnProfileAt(requested.x, requested.y, profile);
      if (!ped) continue;
      this.activeResidents.set(definition.id, ped.id);
      ids.push(ped.id);
    }
    return ids;
  }

  public deactivateResidents(propertyId: string): void {
    const pedestrians = this.resolvePedestrians();
    for (const definition of this.getNeighbors(propertyId)) {
      const id = this.activeResidents.get(definition.id);
      if (id !== undefined) pedestrians?.removeById(id);
      this.activeResidents.delete(definition.id);
    }
  }

  public serialize(): Json {
    return {
      schemaVersion: SCHEMA_VERSION,
      simulationTick: this.simulationTick,
      relationships: Array.from(this.relationships.values())
        .sort((a, b) => a.neighborId.localeCompare(b.neighborId))
        .map((state) => ({
          neighborId: state.neighborId,
          affinity: state.affinity,
          completedInteractionIds: [...state.completedInteractionIds],
        })),
    };
  }

  public deserialize(data: Json): void {
    this.relationships.clear();
    this.lastInteractionTick.clear();
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return;
    const tick = data['simulationTick'];
    if (typeof tick === 'number' && Number.isFinite(tick))
      {this.simulationTick = Math.max(0, Math.floor(tick));}
    const raw = data['relationships'];
    if (!Array.isArray(raw)) return;
    for (const value of raw) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
      const neighborId = value['neighborId'];
      const affinity = value['affinity'];
      const history = value['completedInteractionIds'];
      if (
        typeof neighborId !== 'string' ||
        typeof affinity !== 'number' ||
        !Array.isArray(history) ||
        !this.findNeighbor(neighborId)
      ) {
        EngineDiagnostics.recordError(
          new Error(`Invalid neighbor state: ${String(neighborId)}`),
          'housing-neighborhood-load',
          this.key,
        );
        continue;
      }
      const completedInteractionIds = history
        .filter((id): id is string => typeof id === 'string')
        .sort();
      this.relationships.set(neighborId, {
        neighborId,
        affinity: Math.max(-100, Math.min(100, Math.floor(affinity))),
        completedInteractionIds,
      });
    }
  }

  public onMissingSaveSection(): void {
    this.relationships.clear();
    this.lastInteractionTick.clear();
  }

  private findNeighbor(neighborId: string): NeighborDefinition | undefined {
    for (const definitions of this.definitions.values()) {
      const found = definitions.find((definition) => definition.id === neighborId);
      if (found) return found;
    }
    return undefined;
  }

  private resolveHousing(): HousingSystem | null {
    return ServiceLocator.tryResolve<HousingSystem>(ServiceKeys.Housing);
  }

  private resolvePedestrians(): PedestrianSystem | null {
    return ServiceLocator.tryResolve<PedestrianSystem>(ServiceKeys.Pedestrian);
  }
}
