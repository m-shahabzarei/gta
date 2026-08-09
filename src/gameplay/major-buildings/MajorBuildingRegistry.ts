import type {
  CityId,
  MajorBuildingDefinition,
  MajorBuildingType,
} from '@/gameplay/types/WorldTypes';
import type { Vector2 } from '@/core/types';

/** Immutable query layer over the generated major-building definitions. */
export class MajorBuildingRegistry {
  private readonly definitions: readonly MajorBuildingDefinition[];
  private readonly byId = new Map<string, MajorBuildingDefinition>();

  constructor(definitions: readonly MajorBuildingDefinition[]) {
    this.definitions = definitions.map((definition) => ({
      ...definition,
      worldPosition: { ...definition.worldPosition },
      entrancePosition: { ...definition.entrancePosition },
      exteriorBounds: { ...definition.exteriorBounds },
      npcProfile: { ...definition.npcProfile, roles: [...definition.npcProfile.roles] },
      parkingArea: { ...definition.parkingArea, position: { ...definition.parkingArea.position } },
      services: [...definition.services],
    }));
    for (const definition of this.definitions) {
      if (this.byId.has(definition.id)) {
        throw new Error(`Duplicate major building id: ${definition.id}`);
      }
      this.byId.set(definition.id, definition);
    }
  }

  public all(): readonly MajorBuildingDefinition[] {
    return this.definitions;
  }

  public get(id: string): MajorBuildingDefinition | null {
    return this.byId.get(id) ?? null;
  }

  public ofType(type: MajorBuildingType): readonly MajorBuildingDefinition[] {
    return this.definitions.filter((definition) => definition.type === type);
  }

  public inCity(city: CityId): readonly MajorBuildingDefinition[] {
    return this.definitions.filter((definition) => definition.city === city);
  }

  public nearest(type: MajorBuildingType, position: Vector2): MajorBuildingDefinition | null {
    let nearest: MajorBuildingDefinition | null = null;
    let nearestSq = Infinity;
    for (const definition of this.definitions) {
      if (definition.type !== type) continue;
      const dx = definition.entrancePosition.x - position.x;
      const dy = definition.entrancePosition.y - position.y;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq >= nearestSq) continue;
      nearest = definition;
      nearestSq = distanceSq;
    }
    return nearest;
  }
}
