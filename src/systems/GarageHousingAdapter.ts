import { BaseManager } from '@/core/BaseManager';
import { EngineDiagnostics } from '@/core/EngineDiagnostics';
import type { ISerializable } from '@/core/interfaces';
import type { Json } from '@/core/types';
import { EventKeys } from '@/config/EventKeys';
import { ServiceKeys } from '@/config/ServiceKeys';
import { ServiceLocator } from '@/core/ServiceLocator';
import type { Vehicle } from '@/entities/Vehicle';
import type { HousingSystem } from './HousingSystem';
import type { HousingProgressionSystem } from './HousingProgressionSystem';
import type {
  GarageOperationReason,
  GarageOperationResult,
  GarageSlotState,
} from '@/gameplay/types/HousingPhase2Types';
import { emitHousingTelemetry } from '@/gameplay/HousingTelemetry';

const SCHEMA_VERSION = 2;

/** Adapter that stores explicit vehicle ids in owned-home slots without replacing VehicleSystem. */
export class GarageHousingAdapter extends BaseManager implements ISerializable {
  public readonly key = ServiceKeys.GarageHousing;
  public readonly saveId = 'housing-garage';

  private readonly slotsByProperty = new Map<string, Map<string, string | null>>();
  private readonly activeVehicleByProperty = new Map<string, string>();
  private operationInProgress = false;

  protected onInit(): void {
    this.subscribe(EventKeys.GarageOperationRequested, ({ propertyId, vehicleId, operation }) => {
      if (this.operationInProgress) return;
      this.operationInProgress = true;
      try {
        if (operation === 'store') this.storeVehicleInternal(propertyId, vehicleId);
        else if (operation === 'remove') this.removeVehicleInternal(propertyId, vehicleId);
        else this.setActiveVehicleInternal(propertyId, vehicleId);
      } finally {
        this.operationInProgress = false;
      }
    });
  }

  public getGarageSlots(propertyId: string): readonly GarageSlotState[] {
    const capacity = this.capacity(propertyId);
    const map = this.ensureSlots(propertyId, capacity);
    const result: GarageSlotState[] = [];
    for (let index = 0; index < capacity; index += 1) {
      const slotId = `${propertyId}:garage:${index + 1}`;
      result.push({ slotId, vehicleId: map.get(slotId) ?? null });
    }
    return result;
  }

  public canStoreVehicle(propertyId: string, vehicleId: string): boolean {
    return this.validateStore(propertyId, vehicleId) === null;
  }

  public storeVehicle(propertyId: string, vehicleId: string): GarageOperationResult {
    if (this.operationInProgress) {
      return this.failure(propertyId, vehicleId, 'store', 'transition-busy');
    }
    this.operationInProgress = true;
    try {
      this.bus.emit(EventKeys.GarageOperationRequested, {
        propertyId,
        vehicleId,
        operation: 'store',
      });
      return this.storeVehicleInternal(propertyId, vehicleId);
    } finally {
      this.operationInProgress = false;
    }
  }

  private storeVehicleInternal(propertyId: string, vehicleId: string): GarageOperationResult {
    const reason = this.validateStore(propertyId, vehicleId);
    if (reason) return this.failure(propertyId, vehicleId, 'store', reason);
    const slots = this.ensureSlots(propertyId, this.capacity(propertyId));
    const slot = this.getGarageSlots(propertyId).find((candidate) => candidate.vehicleId === null);
    if (!slot) return this.failure(propertyId, vehicleId, 'store', 'capacity-full');
    slots.set(slot.slotId, vehicleId);
    const vehicle = this.findVehicle(vehicleId);
    vehicle?.movement.stopImmediately();
    vehicle?.sprite.setData('housingStored', true);
    vehicle?.sprite.setData('housingPropertyId', propertyId);
    this.bus.emit(EventKeys.GarageOperationCompleted, {
      propertyId,
      vehicleId,
      operation: 'store',
    });
    emitHousingTelemetry('garage-store', propertyId, 'success');
    return { success: true, propertyId, vehicleId, reason: 'stored' };
  }

  public removeVehicle(propertyId: string, vehicleId: string): GarageOperationResult {
    if (this.operationInProgress) {
      return this.failure(propertyId, vehicleId, 'remove', 'transition-busy');
    }
    this.operationInProgress = true;
    try {
      this.bus.emit(EventKeys.GarageOperationRequested, {
        propertyId,
        vehicleId,
        operation: 'remove',
      });
      return this.removeVehicleInternal(propertyId, vehicleId);
    } finally {
      this.operationInProgress = false;
    }
  }

  private removeVehicleInternal(propertyId: string, vehicleId: string): GarageOperationResult {
    const slots = this.ensureSlots(propertyId, this.capacity(propertyId));
    const slot = this.getGarageSlots(propertyId).find(
      (candidate) => candidate.vehicleId === vehicleId,
    );
    if (!slot) return this.failure(propertyId, vehicleId, 'remove', 'unknown-vehicle');
    const vehicle = this.findVehicle(vehicleId);
    if (!vehicle || vehicle.isDestroyed) {
      return this.failure(propertyId, vehicleId, 'remove', 'vehicle-destroyed');
    }
    slots.set(slot.slotId, null);
    if (this.activeVehicleByProperty.get(propertyId) === vehicleId) {
      this.activeVehicleByProperty.delete(propertyId);
    }
    vehicle.sprite.setData('housingStored', false);
    vehicle.sprite.data?.remove('housingPropertyId');
    this.bus.emit(EventKeys.GarageOperationCompleted, {
      propertyId,
      vehicleId,
      operation: 'remove',
    });
    emitHousingTelemetry('garage-remove', propertyId, 'success');
    return { success: true, propertyId, vehicleId, reason: 'removed' };
  }

  public setActiveVehicleFromGarage(propertyId: string, vehicleId: string): boolean {
    if (this.operationInProgress) {
      this.bus.emit(EventKeys.GarageOperationRejected, {
        propertyId,
        vehicleId,
        operation: 'activate',
        reason: 'transition-busy',
      });
      emitHousingTelemetry('garage-operation', propertyId, 'denied', 'transition-busy');
      return false;
    }
    this.operationInProgress = true;
    try {
      this.bus.emit(EventKeys.GarageOperationRequested, {
        propertyId,
        vehicleId,
        operation: 'activate',
      });
      return this.setActiveVehicleInternal(propertyId, vehicleId);
    } finally {
      this.operationInProgress = false;
    }
  }

  private setActiveVehicleInternal(propertyId: string, vehicleId: string): boolean {
    if (!this.resolveHousing()?.isOwned(propertyId)) {
      this.bus.emit(EventKeys.GarageOperationRejected, {
        propertyId,
        vehicleId,
        operation: 'activate',
        reason: 'not-owned-property',
      });
      emitHousingTelemetry('garage-operation', propertyId, 'denied', 'not-owned-property');
      return false;
    }
    const owns = this.getGarageSlots(propertyId).some((slot) => slot.vehicleId === vehicleId);
    if (!owns || !this.findVehicle(vehicleId)) {
      this.bus.emit(EventKeys.GarageOperationRejected, {
        propertyId,
        vehicleId,
        operation: 'activate',
        reason: 'unknown-vehicle',
      });
      emitHousingTelemetry('garage-operation', propertyId, 'denied', 'unknown-vehicle');
      return false;
    }
    this.activeVehicleByProperty.set(propertyId, vehicleId);
    this.bus.emit(EventKeys.GarageOperationCompleted, {
      propertyId,
      vehicleId,
      operation: 'activate',
    });
    emitHousingTelemetry('garage-active', propertyId, 'success');
    return true;
  }

  public activeVehicle(propertyId: string): string | null {
    return this.activeVehicleByProperty.get(propertyId) ?? null;
  }

  public allGarageSlots(): readonly GarageSlotState[] {
    const result: GarageSlotState[] = [];
    for (const property of this.resolveHousing()?.catalog ?? []) {
      result.push(...this.getGarageSlots(property.id));
    }
    return result.sort((a, b) => a.slotId.localeCompare(b.slotId));
  }

  public serialize(): Json {
    const garage = Array.from(this.slotsByProperty.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([propertyId, slots]) => ({
        propertyId,
        slots: Array.from(slots.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([slotId, vehicleId]) => ({ slotId, vehicleId })),
        activeVehicleId: this.activeVehicleByProperty.get(propertyId) ?? null,
      }));
    return { schemaVersion: SCHEMA_VERSION, garage };
  }

  public deserialize(data: Json): void {
    this.slotsByProperty.clear();
    this.activeVehicleByProperty.clear();
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return;
    const raw = data['garage'];
    if (!Array.isArray(raw)) return;
    const seenVehiclesGlobal = new Set<string>();
    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
      const propertyId = entry['propertyId'];
      const slots = entry['slots'];
      if (
        typeof propertyId !== 'string' ||
        !Array.isArray(slots) ||
        !this.resolveHousing()?.getProperty(propertyId)
      ) {
        if (typeof propertyId === 'string') {
          EngineDiagnostics.recordError(
            new Error(`Unknown garage property: ${propertyId}`),
            'housing-garage-load',
            this.key,
          );
        }
        continue;
      }
      const target = this.ensureSlots(propertyId, this.capacity(propertyId));
      const seenVehicles = new Set<string>();
      const seenSlots = new Set<string>();
      for (const value of slots) {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
        const slotId = value['slotId'];
        const vehicleId = value['vehicleId'];
        if (typeof slotId !== 'string' || (vehicleId !== null && typeof vehicleId !== 'string')) {
          continue;
        }
        if (!target.has(slotId) || vehicleId === null) continue;
        if (seenSlots.has(slotId)) {
          EngineDiagnostics.recordLimitExceeded(
            'housing-duplicate-garage-slot',
            2,
            1,
            'ignored-duplicate-slot',
            `${propertyId}:${slotId}`,
          );
          continue;
        }
        seenSlots.add(slotId);
        if (seenVehicles.has(vehicleId)) {
          EngineDiagnostics.recordLimitExceeded(
            'housing-duplicate-garage-vehicle',
            2,
            1,
            'ignored-duplicate-vehicle',
            vehicleId,
          );
          continue;
        }
        if (seenVehiclesGlobal.has(vehicleId)) {
          EngineDiagnostics.recordLimitExceeded(
            'housing-duplicate-garage-vehicle',
            2,
            1,
            'ignored-cross-property-duplicate-vehicle',
            vehicleId,
          );
          continue;
        }
        if (!this.findVehicle(vehicleId)) {
          EngineDiagnostics.recordError(
            new Error(`Unknown garage vehicle: ${vehicleId}`),
            'housing-garage-load',
            this.key,
          );
          continue;
        }
        seenVehicles.add(vehicleId);
        seenVehiclesGlobal.add(vehicleId);
        target.set(slotId, vehicleId);
      }
      const active = entry['activeVehicleId'];
      if (typeof active === 'string' && seenVehicles.has(active)) {
        this.activeVehicleByProperty.set(propertyId, active);
      } else if (active !== null && active !== undefined) {
        EngineDiagnostics.recordError(
          new Error(`Invalid active garage vehicle: ${String(active)}`),
          'housing-garage-load',
          this.key,
        );
      }
    }
  }

  public onMissingSaveSection(): void {
    this.slotsByProperty.clear();
    this.activeVehicleByProperty.clear();
  }

  private validateStore(propertyId: string, vehicleId: string): GarageOperationReason | null {
    if (!this.resolveHousing()?.isOwned(propertyId)) return 'not-owned-property';
    const vehicle = this.findVehicle(vehicleId);
    if (!vehicle) return 'unknown-vehicle';
    if (vehicle.isDestroyed) return 'vehicle-destroyed';
    if (vehicle.isPlayerDriven) return 'protected-vehicle';
    if (Math.abs(vehicle.movement.speed) > 0.1) return 'vehicle-moving';
    if (vehicle.movement.dynamics.impactState !== 'None') return 'protected-vehicle';
    const data = vehicle.sprite.data;
    if (
      data?.get('missionVehicle') === true ||
      data?.get('missionId') !== undefined ||
      data?.get('missionOwnerId') !== undefined ||
      data?.get('policeResponseActive') === true ||
      data?.get('persistentTransitService') === true ||
      data?.get('serviceParking') === true
    ) {
      return 'protected-vehicle';
    }
    if (this.isVehicleStored(vehicleId)) {
      return 'duplicate-vehicle';
    }
    return this.getGarageSlots(propertyId).some((slot) => slot.vehicleId === null)
      ? null
      : 'capacity-full';
  }

  private failure(
    propertyId: string,
    vehicleId: string,
    operation: 'store' | 'remove' | 'activate',
    reason: GarageOperationReason,
  ): GarageOperationResult {
    this.bus.emit(EventKeys.GarageOperationRejected, { propertyId, vehicleId, operation, reason });
    emitHousingTelemetry('garage-operation', propertyId, 'denied', reason);
    return { success: false, propertyId, vehicleId, reason };
  }

  private capacity(propertyId: string): number {
    const property = this.resolveHousing()?.getProperty(propertyId);
    if (!property) return 0;
    const progression = ServiceLocator.tryResolve<HousingProgressionSystem>(
      ServiceKeys.HousingProgression,
    );
    let extra = 0;
    for (const definition of progression?.getUpgradeDefinitions(propertyId) ?? []) {
      if (
        definition.category === 'garage' &&
        progression?.isUpgradePurchased(propertyId, definition.id)
      ) {
        const effect = definition.effects['parkingCapacity'];
        if (typeof effect === 'number') extra += effect;
      }
    }
    return Math.max(0, Math.floor(property.parkingCapacity + extra));
  }

  private ensureSlots(propertyId: string, capacity: number): Map<string, string | null> {
    const current = this.slotsByProperty.get(propertyId) ?? new Map<string, string | null>();
    for (let index = 0; index < capacity; index += 1) {
      const slotId = `${propertyId}:garage:${index + 1}`;
      if (!current.has(slotId)) current.set(slotId, null);
    }
    this.slotsByProperty.set(propertyId, current);
    return current;
  }

  private isVehicleStored(vehicleId: string): boolean {
    for (const slots of this.slotsByProperty.values()) {
      for (const storedId of slots.values()) {
        if (storedId === vehicleId) return true;
      }
    }
    return false;
  }

  private findVehicle(vehicleId: string): Vehicle | null {
    const numeric = Number(vehicleId);
    if (!Number.isFinite(numeric)) return null;
    const vehicles = ServiceLocator.tryResolve(ServiceKeys.Vehicle) as unknown as {
      vehicles: readonly Vehicle[];
    } | null;
    return vehicles?.vehicles.find((vehicle) => vehicle.id === numeric) ?? null;
  }

  private resolveHousing(): HousingSystem | null {
    return ServiceLocator.tryResolve<HousingSystem>(ServiceKeys.Housing);
  }
}
