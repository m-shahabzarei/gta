import { BaseManager } from '@/core/BaseManager';
import { EngineDiagnostics } from '@/core/EngineDiagnostics';
import type { ISerializable } from '@/core/interfaces';
import type { Json } from '@/core/types';
import { EventKeys } from '@/config/EventKeys';
import { ServiceKeys } from '@/config/ServiceKeys';
import { ServiceLocator } from '@/core/ServiceLocator';
import { createHousingUpgradeCatalog, validateUpgradeDag } from '@/gameplay/HousingUpgradeCatalog';
import { emitHousingTelemetry } from '@/gameplay/HousingTelemetry';
import type { HousingSystem } from './HousingSystem';
import type { PlayerController } from './PlayerController';
import type {
  PropertyTier,
  PropertyUpgradeDefinition,
  PropertyUpgradeState,
  PurchaseUpgradeReason,
  PurchaseUpgradeResult,
} from '@/gameplay/types/HousingPhase2Types';

const SCHEMA_VERSION = 2;

/** Owns upgrade definitions and purchased-upgrade state for HousingSystem properties. */
export class HousingProgressionSystem extends BaseManager implements ISerializable {
  public readonly key = ServiceKeys.HousingProgression;
  public readonly saveId = 'housing-progression';

  private definitions: readonly PropertyUpgradeDefinition[] = [];
  private readonly byProperty = new Map<string, PropertyUpgradeDefinition[]>();
  private readonly purchased = new Map<string, PropertyUpgradeState>();
  private simulationTick = 0;
  private purchaseInProgress = false;

  protected onInit(): void {
    const housing = this.resolveHousing();
    this.definitions = createHousingUpgradeCatalog(housing?.catalog ?? []);
    this.byProperty.clear();
    for (const definition of this.definitions) {
      const propertyId = definition.propertyId;
      if (!propertyId) continue;
      const bucket = this.byProperty.get(propertyId) ?? [];
      bucket.push(definition);
      this.byProperty.set(propertyId, bucket);
    }
    const dagFailures = validateUpgradeDag(this.definitions);
    for (const failure of dagFailures) {
      EngineDiagnostics.recordError(new Error(failure), 'housing-upgrade-catalog', this.key);
    }
    this.subscribe(EventKeys.PropertyUpgradePurchaseRequested, ({ propertyId, upgradeId }) => {
      if (this.purchaseInProgress) return;
      this.purchaseInProgress = true;
      try {
        this.purchaseInternal(propertyId, upgradeId);
      } finally {
        this.purchaseInProgress = false;
      }
    });
  }

  public update(_time: number, _delta: number): void {
    this.simulationTick += 1;
  }

  public get currentSimulationTick(): number {
    return this.simulationTick;
  }

  public getUpgradeDefinitions(propertyId: string): readonly PropertyUpgradeDefinition[] {
    return this.byProperty.get(propertyId) ?? [];
  }

  public isUpgradePurchased(propertyId: string, upgradeId: string): boolean {
    const definition = this.getUpgradeDefinitions(propertyId).find(
      (candidate) => candidate.id === upgradeId,
    );
    return definition !== undefined && this.purchased.has(this.stateKey(propertyId, upgradeId));
  }

  public canPurchaseUpgrade(propertyId: string, upgradeId: string): boolean {
    const definition = this.definitionFor(propertyId, upgradeId);
    if (!definition || !this.resolveHousing()?.isOwned(propertyId)) return false;
    if (this.purchased.has(this.stateKey(propertyId, upgradeId))) return false;
    return definition.prerequisiteIds.every(
      (id) => this.purchased.has(this.stateKey(propertyId, id)) || this.purchased.has(id),
    );
  }

  public purchaseUpgrade(propertyId: string, upgradeId: string): PurchaseUpgradeResult {
    if (this.purchaseInProgress) {
      return this.failure(propertyId, upgradeId, 'transaction-rejected');
    }
    this.purchaseInProgress = true;
    try {
      this.bus.emit(EventKeys.PropertyUpgradePurchaseRequested, { propertyId, upgradeId });
      return this.purchaseInternal(propertyId, upgradeId);
    } finally {
      this.purchaseInProgress = false;
    }
  }

  public getEffectivePropertyFeatures(propertyId: string): readonly string[] {
    const property = this.resolveHousing()?.getProperty(propertyId);
    if (!property) return [];
    const features = new Set<string>(property.features);
    for (const definition of this.getUpgradeDefinitions(propertyId)) {
      if (this.isUpgradePurchased(propertyId, definition.id)) {
        for (const flag of definition.featureFlags) features.add(flag);
      }
    }
    return Array.from(features).sort();
  }

  public getPropertyTier(propertyId: string): PropertyTier {
    let highest = 1;
    for (const definition of this.getUpgradeDefinitions(propertyId)) {
      if (this.isUpgradePurchased(propertyId, definition.id)) {
        highest = Math.max(highest, definition.level);
      }
    }
    return highest >= 3 ? 'premium' : highest >= 2 ? 'improved' : 'starter';
  }

  public purchasedStates(propertyId?: string): readonly PropertyUpgradeState[] {
    const states = Array.from(this.purchased.values()).filter((state) => {
      if (!propertyId) return true;
      return this.definitionForState(state)?.propertyId === propertyId;
    });
    return states.sort((a, b) => a.upgradeId.localeCompare(b.upgradeId));
  }

  public serialize(): Json {
    return {
      schemaVersion: SCHEMA_VERSION,
      simulationTick: this.simulationTick,
      purchased: this.purchasedStates().map((state) => ({ ...state })),
    };
  }

  public deserialize(data: Json): void {
    this.purchased.clear();
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return;
    const tick = data['simulationTick'];
    if (typeof tick === 'number' && Number.isFinite(tick) && tick >= 0) {
      this.simulationTick = Math.floor(tick);
    }
    const raw = data['purchased'];
    if (!Array.isArray(raw)) return;
    const pending: Array<{
      definition: PropertyUpgradeDefinition;
      upgradeId: string;
      level: number;
      purchasedAt: number;
    }> = [];
    for (const value of raw) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
      const upgradeId = value['upgradeId'];
      const level = value['level'];
      const purchasedAt = value['purchasedAtSimulationTick'];
      if (
        typeof upgradeId !== 'string' ||
        typeof level !== 'number' ||
        typeof purchasedAt !== 'number'
      ) {
        continue;
      }
      const definition = this.definitions.find((candidate) => candidate.id === upgradeId);
      if (
        !definition ||
        !definition.propertyId ||
        !this.resolveHousing()?.isOwned(definition.propertyId)
      ) {
        EngineDiagnostics.recordError(
          new Error(`Unknown or unowned upgrade in save: ${upgradeId}`),
          'housing-upgrade-load',
          this.key,
        );
        continue;
      }
      if (!Number.isFinite(level) || Math.floor(level) !== definition.level) {
        EngineDiagnostics.recordError(
          new Error(`Invalid upgrade level in save: ${upgradeId}`),
          'housing-upgrade-load',
          this.key,
        );
        continue;
      }
      if (!Number.isFinite(purchasedAt) || purchasedAt < 0) {
        EngineDiagnostics.recordError(
          new Error(`Invalid upgrade tick in save: ${upgradeId}`),
          'housing-upgrade-load',
          this.key,
        );
        continue;
      }
      const key = this.stateKey(definition.propertyId, upgradeId);
      if (
        this.purchased.has(key) ||
        pending.some((candidate) => candidate.upgradeId === upgradeId)
      ) {
        EngineDiagnostics.recordLimitExceeded(
          'housing-duplicate-upgrade',
          2,
          1,
          'ignored-duplicate-upgrade',
          upgradeId,
        );
        continue;
      }
      pending.push({
        definition,
        upgradeId,
        purchasedAt: Math.floor(purchasedAt),
        level: Math.floor(level),
      });
    }

    // Resolve the saved set in prerequisite order. A corrupt save may list a
    // higher tier first or omit a prerequisite; those entries are diagnosed
    // and discarded without partially repairing the graph.
    pending.sort((a, b) => a.upgradeId.localeCompare(b.upgradeId));
    let remaining = pending;
    while (remaining.length > 0) {
      const next: typeof pending = [];
      let committed = 0;
      for (const candidate of remaining) {
        const propertyId = candidate.definition.propertyId as string;
        const prerequisitesSatisfied = candidate.definition.prerequisiteIds.every((id) =>
          this.purchased.has(this.stateKey(propertyId, id)),
        );
        if (!prerequisitesSatisfied) {
          next.push(candidate);
          continue;
        }
        this.purchased.set(this.stateKey(propertyId, candidate.upgradeId), {
          upgradeId: candidate.upgradeId,
          purchasedAtSimulationTick: candidate.purchasedAt,
          level: candidate.level,
        });
        committed += 1;
      }
      if (committed === 0) {
        for (const candidate of next) {
          EngineDiagnostics.recordError(
            new Error(`Missing upgrade prerequisite in save: ${candidate.upgradeId}`),
            'housing-upgrade-load',
            this.key,
          );
        }
        break;
      }
      remaining = next;
    }
  }

  public onMissingSaveSection(): void {
    this.purchased.clear();
    this.simulationTick = 0;
  }

  private purchaseInternal(propertyId: string, upgradeId: string): PurchaseUpgradeResult {
    const definition = this.definitionFor(propertyId, upgradeId);
    if (!definition) return this.failure(propertyId, upgradeId, 'invalid-upgrade');
    const housing = this.resolveHousing();
    if (!housing?.isOwned(propertyId)) {
      return this.failure(propertyId, upgradeId, 'not-owned-property');
    }
    if (definition.propertyId !== propertyId) {
      return this.failure(propertyId, upgradeId, 'wrong-property');
    }
    const key = this.stateKey(propertyId, upgradeId);
    if (this.purchased.has(key)) return this.failure(propertyId, upgradeId, 'already-owned');
    if (
      !definition.prerequisiteIds.every(
        (id) => this.purchased.has(this.stateKey(propertyId, id)) || this.purchased.has(id),
      )
    ) {
      return this.failure(propertyId, upgradeId, 'prerequisite-missing');
    }
    const player = this.resolvePlayer()?.player;
    if (!player) return this.failure(propertyId, upgradeId, 'transaction-rejected');
    if (player.inventory.money < definition.price) {
      return this.failure(propertyId, upgradeId, 'insufficient-funds');
    }
    if (!player.inventory.spendMoney(definition.price)) {
      return this.failure(propertyId, upgradeId, 'transaction-rejected');
    }
    this.purchased.set(key, {
      upgradeId,
      purchasedAtSimulationTick: this.simulationTick,
      level: definition.level,
    });
    const purchasedUpgradeIds = this.purchasedStates(propertyId).map((state) => state.upgradeId);
    this.bus.emit(EventKeys.PropertyUpgradeChanged, {
      propertyId,
      upgradeId,
      purchased: true,
      purchasedUpgradeIds,
    });
    emitHousingTelemetry('upgrade-purchase', propertyId, 'success');
    this.bus.emit(EventKeys.UIToast, {
      message: `Upgrade purchased: ${definition.category} ${definition.level}`,
    });
    return { success: true, propertyId, upgradeId, reason: 'purchased' };
  }

  private failure(
    propertyId: string,
    upgradeId: string,
    reason: PurchaseUpgradeReason,
  ): PurchaseUpgradeResult {
    this.bus.emit(EventKeys.UIToast, { message: `Upgrade unavailable: ${reason}` });
    emitHousingTelemetry('upgrade-purchase', propertyId, 'denied', reason);
    return { success: false, propertyId, upgradeId, reason };
  }

  private definitionFor(
    propertyId: string,
    upgradeId: string,
  ): PropertyUpgradeDefinition | undefined {
    return this.getUpgradeDefinitions(propertyId).find((definition) => definition.id === upgradeId);
  }

  private definitionForState(state: PropertyUpgradeState): PropertyUpgradeDefinition | undefined {
    return this.definitions.find((definition) => definition.id === state.upgradeId);
  }

  private stateKey(propertyId: string, upgradeId: string): string {
    return `${propertyId}|${upgradeId}`;
  }

  private resolveHousing(): HousingSystem | null {
    return ServiceLocator.tryResolve<HousingSystem>(ServiceKeys.Housing);
  }

  private resolvePlayer(): PlayerController | null {
    return ServiceLocator.tryResolve<PlayerController>(ServiceKeys.Player);
  }
}
