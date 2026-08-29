import { BaseManager } from '@/core/BaseManager';
import type { ISerializable } from '@/core/interfaces';
import type { Json } from '@/core/types';
import { EventKeys } from '@/config/EventKeys';
import { ServiceKeys } from '@/config/ServiceKeys';
import { ServiceLocator } from '@/core/ServiceLocator';
import type { HousingSystem } from './HousingSystem';
import type { HousingProgressionSystem } from './HousingProgressionSystem';
import type { WantedSystem } from './WantedSystem';
import type {
  SafehouseDecision,
  SafehousePolicy,
  SafehouseResult,
  WantedReductionResult,
} from '@/gameplay/types/HousingPhase2Types';
import { emitHousingTelemetry } from '@/gameplay/HousingTelemetry';

const SCHEMA_VERSION = 1;
const DEFAULT_POLICY: Omit<SafehousePolicy, 'propertyId' | 'enabled'> = {
  requiresNoActiveCombat: true,
  requiresNoArrestTransition: true,
  wantedCooldownSeconds: 45,
  maxUsesPerSimulationDay: 2,
};

interface SafehouseState {
  uses: number;
  cooldownTicks: number;
  dayIndex: number;
}

/** Policy-only bridge to WantedSystem; it never clears wanted directly. */
export class SafehouseAdapter extends BaseManager implements ISerializable {
  public readonly key = ServiceKeys.Safehouse;
  public readonly saveId = 'housing-safehouse';

  private readonly policies = new Map<string, SafehousePolicy>();
  private readonly states = new Map<string, SafehouseState>();
  private simulationTick = 0;
  private operationInProgress = false;

  protected onInit(): void {
    for (const property of this.resolveHousing()?.catalog ?? []) {
      this.policies.set(property.id, { propertyId: property.id, enabled: true, ...DEFAULT_POLICY });
    }
  }

  public update(_time: number, _delta: number): void {
    this.simulationTick += 1;
    for (const [propertyId, state] of this.states) {
      if (state.cooldownTicks <= 0) continue;
      state.cooldownTicks -= 1;
      if (state.cooldownTicks === 0) this.completeReduction(propertyId);
    }
  }

  public getPolicy(propertyId: string): SafehousePolicy | undefined {
    return this.policies.get(propertyId);
  }

  public totalUses(): number {
    let total = 0;
    for (const state of this.states.values()) total += state.uses;
    return total;
  }

  public stateSnapshot(): readonly { propertyId: string; uses: number; cooldownTicks: number }[] {
    return Array.from(this.states.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([propertyId, state]) => ({
        propertyId,
        uses: state.uses,
        cooldownTicks: state.cooldownTicks,
      }));
  }

  public canUseSafehouse(propertyId: string): SafehouseDecision {
    const housing = this.resolveHousing();
    if (!housing?.isOwned(propertyId)) return { allowed: false, reason: 'not-owned-property' };
    const policy = this.policies.get(propertyId);
    const progression = this.resolveProgression();
    const enabled =
      policy?.enabled === true &&
      (progression?.getEffectivePropertyFeatures(propertyId).includes('safehouse:enabled') ??
        false);
    if (!enabled) return { allowed: false, reason: 'policy-disabled' };
    const state = this.stateFor(propertyId);
    const currentDay = Math.floor(this.simulationTick / 86400);
    if (state.dayIndex < currentDay) {
      state.dayIndex = currentDay;
      state.uses = 0;
    }
    if (state.cooldownTicks > 0 || state.uses >= (policy?.maxUsesPerSimulationDay ?? 0))
      {return { allowed: false, reason: 'cooldown' };}
    const wanted = this.resolveWanted();
    const phase = wanted && 'phase' in wanted ? String(wanted.phase) : 'unknown';
    const player = ServiceLocator.tryResolve(ServiceKeys.Player) as unknown as {
      playerInVehicle?: boolean;
    } | null;
    if (policy?.requiresNoActiveCombat && (phase === 'pursuit' || phase === 'responding'))
      {return { allowed: false, reason: 'wanted-unsafe' };}
    if (policy?.requiresNoArrestTransition && player?.playerInVehicle === true)
      {return { allowed: false, reason: 'wanted-unsafe' };}
    return { allowed: true, reason: 'allowed' };
  }

  public useSafehouse(propertyId: string): SafehouseResult {
    if (this.operationInProgress)
      {return {
        success: false,
        propertyId,
        reason: 'cooldown',
        remainingCooldownTicks: this.stateFor(propertyId).cooldownTicks,
      };}
    this.operationInProgress = true;
    try {
      this.bus.emit(EventKeys.SafehouseUseRequested, { propertyId });
      const decision = this.canUseSafehouse(propertyId);
      if (!decision.allowed) {
        this.bus.emit(EventKeys.SafehouseUseDenied, { propertyId, decision });
        emitHousingTelemetry('safehouse-use', propertyId, 'denied', decision.reason);
        return {
          success: false,
          propertyId,
          reason: decision.reason,
          remainingCooldownTicks: this.stateFor(propertyId).cooldownTicks,
        };
      }
      const policy = this.policies.get(propertyId) as SafehousePolicy;
      const state = this.stateFor(propertyId);
      state.uses += 1;
      state.cooldownTicks = Math.max(1, Math.floor(policy.wantedCooldownSeconds * 60));
      state.dayIndex = Math.floor(this.simulationTick / 86400);
      const result: SafehouseResult = {
        success: true,
        propertyId,
        reason: 'used',
        remainingCooldownTicks: state.cooldownTicks,
      };
      this.bus.emit(EventKeys.SafehouseUseCompleted, { ...result, wanted: null });
      emitHousingTelemetry('safehouse-use', propertyId, 'accepted');
      return result;
    } finally {
      this.operationInProgress = false;
    }
  }

  public serialize(): Json {
    return {
      schemaVersion: SCHEMA_VERSION,
      simulationTick: this.simulationTick,
      states: Array.from(this.states.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([propertyId, state]) => ({ propertyId, ...state })),
    };
  }

  public deserialize(data: Json): void {
    this.states.clear();
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return;
    const tick = data['simulationTick'];
    if (typeof tick === 'number' && Number.isFinite(tick))
      {this.simulationTick = Math.max(0, Math.floor(tick));}
    const raw = data['states'];
    if (!Array.isArray(raw)) return;
    for (const value of raw) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
      const propertyId = value['propertyId'];
      const uses = value['uses'];
      const cooldownTicks = value['cooldownTicks'];
      const dayIndex = value['dayIndex'];
      if (
        typeof propertyId !== 'string' ||
        typeof uses !== 'number' ||
        typeof cooldownTicks !== 'number' ||
        typeof dayIndex !== 'number' ||
        !this.policies.has(propertyId)
      )
        {continue;}
      this.states.set(propertyId, {
        uses: Math.max(0, Math.floor(uses)),
        cooldownTicks: Math.max(0, Math.floor(cooldownTicks)),
        dayIndex: Math.max(0, Math.floor(dayIndex)),
      });
    }
  }

  public onMissingSaveSection(): void {
    this.states.clear();
    this.simulationTick = 0;
  }

  private completeReduction(propertyId: string): void {
    const wanted = this.resolveWanted();
    let reduction: WantedReductionResult | null = null;
    if (wanted)
      {reduction = wanted.requestSafehouseReduction(
        this.policies.get(propertyId)?.wantedCooldownSeconds ?? 0,
      );}
    const result: SafehouseResult = {
      success: true,
      propertyId,
      reason: 'used',
      remainingCooldownTicks: 0,
    };
    this.bus.emit(EventKeys.SafehouseUseCompleted, { ...result, wanted: reduction });
    emitHousingTelemetry(
      'safehouse-reduction',
      propertyId,
      reduction?.accepted === true ? 'success' : 'denied',
      reduction?.reason ?? null,
    );
  }

  private stateFor(propertyId: string): SafehouseState {
    const current = this.states.get(propertyId);
    if (current) return current;
    const created = {
      uses: 0,
      cooldownTicks: 0,
      dayIndex: Math.floor(this.simulationTick / 86400),
    };
    this.states.set(propertyId, created);
    return created;
  }

  private resolveHousing(): HousingSystem | null {
    return ServiceLocator.tryResolve<HousingSystem>(ServiceKeys.Housing);
  }

  private resolveProgression(): HousingProgressionSystem | null {
    return ServiceLocator.tryResolve<HousingProgressionSystem>(ServiceKeys.HousingProgression);
  }

  private resolveWanted(): WantedSystem | null {
    return ServiceLocator.tryResolve<WantedSystem>(ServiceKeys.Wanted);
  }
}
