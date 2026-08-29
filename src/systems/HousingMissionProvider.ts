import { BaseManager } from '@/core/BaseManager';
import type { ISerializable } from '@/core/interfaces';
import type { Json } from '@/core/types';
import { EventKeys } from '@/config/EventKeys';
import { ServiceKeys } from '@/config/ServiceKeys';
import { ServiceLocator } from '@/core/ServiceLocator';
import { hashHousingSeed } from '@/gameplay/HousingCatalog';
import { emitHousingTelemetry } from '@/gameplay/HousingTelemetry';
import type { HousingSystem } from './HousingSystem';
import type { HousingProgressionSystem } from './HousingProgressionSystem';
import type { HousingMissionDefinition, PropertyTier } from '@/gameplay/types/HousingPhase2Types';

const SCHEMA_VERSION = 1;
const OFFER_COOLDOWN_TICKS = 900;

/** Deterministic housing mission offer adapter; MissionSystem remains the state owner. */
export class HousingMissionProvider extends BaseManager implements ISerializable {
  public readonly key = ServiceKeys.HousingMission;
  public readonly saveId = 'housing-missions';

  private readonly definitions = new Map<string, HousingMissionDefinition[]>();
  private readonly lastOfferTick = new Map<string, number>();
  private simulationTick = 0;

  protected onInit(): void {
    const housing = this.resolveHousing();
    for (const property of housing?.catalog ?? []) {
      const tier: PropertyTier = 'starter';
      const definitions: HousingMissionDefinition[] = [
        {
          id: `${property.id}:mission:materials`,
          cityId: property.cityId,
          districtId: property.districtId,
          propertyTier: tier,
          requiredUpgradeIds: [],
          missionId: `housing:${property.id}:materials`,
          deterministicWeight: 1 + (hashHousingSeed(property.id, 'materials') % 100) / 100,
        },
        {
          id: `${property.id}:mission:garage`,
          cityId: property.cityId,
          districtId: property.districtId,
          propertyTier: 'improved',
          requiredUpgradeIds: [`${property.id}:upgrade:garage:1`],
          missionId: `housing:${property.id}:garage`,
          deterministicWeight: 1 + (hashHousingSeed(property.id, 'garage') % 100) / 100,
        },
        {
          id: `${property.id}:mission:safehouse`,
          cityId: property.cityId,
          districtId: property.districtId,
          propertyTier: 'premium',
          requiredUpgradeIds: [`${property.id}:upgrade:safehouse:1`],
          missionId: `housing:${property.id}:safehouse`,
          deterministicWeight: 1 + (hashHousingSeed(property.id, 'safehouse') % 100) / 100,
        },
      ];
      this.definitions.set(
        property.id,
        definitions.map((definition) => Object.freeze(definition)),
      );
    }
    this.subscribe(EventKeys.MissionCompleted, ({ missionId, reward }) => {
      for (const [propertyId, definitions] of this.definitions) {
        if (definitions.some((definition) => definition.missionId === missionId)) {
          this.bus.emit(EventKeys.HousingMissionCompleted, { missionId, propertyId, reward });
          break;
        }
      }
    });
  }

  public update(_time: number, _delta: number): void {
    this.simulationTick += 1;
  }

  public getMissionOffers(
    propertyId: string,
    tick = this.simulationTick,
  ): readonly HousingMissionDefinition[] {
    const housing = this.resolveHousing();
    if (!housing?.isOwned(propertyId)) return [];
    const progression = this.resolveProgression();
    const tier = progression?.getPropertyTier(propertyId) ?? 'starter';
    return (this.definitions.get(propertyId) ?? []).filter((definition) => {
      if (!this.tierAtLeast(tier, definition.propertyTier ?? 'starter')) return false;
      if (
        !definition.requiredUpgradeIds.every(
          (id) => progression?.isUpgradePurchased(propertyId, id) ?? false,
        )
      )
        {return false;}
      const last = this.lastOfferTick.get(definition.id) ?? -Infinity;
      return tick - last >= OFFER_COOLDOWN_TICKS;
    });
  }

  public offerMission(
    propertyId: string,
    tick = this.simulationTick,
  ): HousingMissionDefinition | null {
    const candidates = this.getMissionOffers(propertyId, tick);
    const candidate = candidates[0] ?? null;
    if (!candidate) return null;
    this.lastOfferTick.set(candidate.id, tick);
    this.bus.emit(EventKeys.HousingMissionOffered, candidate);
    emitHousingTelemetry('mission-offer', propertyId, 'success');
    this.bus.emit(EventKeys.MissionOffered, {
      missionId: candidate.missionId,
      title: `Home task: ${candidate.missionId.split(':').pop() ?? 'task'}`,
    });
    return candidate;
  }

  public serialize(): Json {
    return {
      schemaVersion: SCHEMA_VERSION,
      simulationTick: this.simulationTick,
      lastOfferTick: Array.from(this.lastOfferTick.entries()).sort(([a], [b]) =>
        a.localeCompare(b),
      ),
    };
  }

  public deserialize(data: Json): void {
    this.lastOfferTick.clear();
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return;
    const tick = data['simulationTick'];
    if (typeof tick === 'number' && Number.isFinite(tick))
      {this.simulationTick = Math.max(0, Math.floor(tick));}
    const raw = data['lastOfferTick'];
    if (!Array.isArray(raw)) return;
    for (const entry of raw) {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        typeof entry[0] !== 'string' ||
        typeof entry[1] !== 'number'
      )
        {continue;}
      if (
        !Array.from(this.definitions.values()).some(
          (definitions: readonly HousingMissionDefinition[]) =>
            definitions.some((definition: HousingMissionDefinition) => definition.id === entry[0]),
        )
      )
        {continue;}
      this.lastOfferTick.set(entry[0], Math.max(0, Math.floor(entry[1])));
    }
  }

  public onMissingSaveSection(): void {
    this.lastOfferTick.clear();
    this.simulationTick = 0;
  }

  private tierAtLeast(current: PropertyTier, required: PropertyTier): boolean {
    const rank: Record<PropertyTier, number> = { starter: 1, improved: 2, premium: 3 };
    return rank[current] >= rank[required];
  }

  private resolveHousing(): HousingSystem | null {
    return ServiceLocator.tryResolve<HousingSystem>(ServiceKeys.Housing);
  }

  private resolveProgression(): HousingProgressionSystem | null {
    return ServiceLocator.tryResolve<HousingProgressionSystem>(ServiceKeys.HousingProgression);
  }
}
