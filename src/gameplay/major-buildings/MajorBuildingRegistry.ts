import type {
  CityId,
  MajorBuildingIcon,
  MajorBuildingDefinition,
  MajorBuildingType,
} from '@/gameplay/types/WorldTypes';
import type { Vector2 } from '@/core/types';

/** Data-only POI projection consumed by map UIs and validation. */
export interface MajorLocationPoi {
  id: string;
  type: MajorBuildingType;
  city: CityId;
  worldPosition: Vector2;
  entrancePosition: Vector2;
  mapIcon: MajorBuildingIcon;
  minimapIcon: MajorBuildingIcon;
  displayName: string;
  label: string;
  interiorId: string;
  buildingId: string;
}

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

  public pois(): readonly MajorLocationPoi[] {
    return this.definitions.map((definition) => this.toPoi(definition));
  }

  public poisForCity(city: CityId): readonly MajorLocationPoi[] {
    return this.definitions
      .filter((definition) => definition.city === city)
      .map((definition) => this.toPoi(definition));
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

  private toPoi(definition: MajorBuildingDefinition): MajorLocationPoi {
    return {
      id: definition.id,
      type: definition.type,
      city: definition.city,
      worldPosition: { ...definition.worldPosition },
      entrancePosition: { ...definition.entrancePosition },
      mapIcon: definition.mapIcon,
      minimapIcon: definition.minimapIcon,
      displayName: definition.name,
      label: `${this.typeLabel(definition.type)} — ${this.cityLabel(definition.city)}`,
      interiorId: definition.interiorId,
      buildingId: definition.buildingId,
    };
  }

  private typeLabel(type: MajorBuildingType): string {
    switch (type) {
      case 'hospital':
        return 'Hospital';
      case 'police-station':
        return 'Police Station';
      case 'fire-station':
        return 'Fire Station';
      case 'gas-station':
        return 'Gas Station';
      case 'bank':
        return 'Bank';
      case 'government':
        return 'Government';
      case 'shopping-center':
        return 'Shopping Center';
    }
  }

  private cityLabel(city: CityId): string {
    switch (city) {
      case 'tehran':
        return 'Tehran';
      case 'yazd':
        return 'Yazd';
      case 'gilan':
        return 'Gilan';
    }
  }
}
