import type { Rect, Vector2 } from '@/core/types';
import type { CityId, District } from './WorldTypes';

export type PropertyTier = 'starter' | 'improved' | 'premium';

export type PropertyUpgradeCategory =
  'space' | 'security' | 'storage' | 'garage' | 'comfort' | 'workshop' | 'safehouse';

export interface PropertyUpgradeDefinition {
  readonly id: string;
  readonly propertyId?: string;
  readonly cityId?: CityId;
  readonly category: PropertyUpgradeCategory;
  readonly level: number;
  readonly price: number;
  readonly prerequisiteIds: readonly string[];
  readonly featureFlags: readonly string[];
  readonly effects: Readonly<Record<string, number | boolean | string>>;
}

export interface PropertyUpgradeState {
  readonly upgradeId: string;
  readonly purchasedAtSimulationTick: number;
  readonly level: number;
}

export type PurchaseUpgradeReason =
  | 'purchased'
  | 'already-owned'
  | 'insufficient-funds'
  | 'not-owned-property'
  | 'invalid-upgrade'
  | 'prerequisite-missing'
  | 'wrong-property'
  | 'transaction-rejected';

export interface PurchaseUpgradeResult {
  readonly success: boolean;
  readonly propertyId: string;
  readonly upgradeId: string;
  readonly reason: PurchaseUpgradeReason;
}

export interface FurnitureSlotDefinition {
  readonly id: string;
  readonly roomId: string;
  readonly allowedCategories: readonly string[];
  readonly anchor: Vector2;
  readonly bounds: Rect;
  readonly collisionBounds?: Rect;
  readonly maxItems: number;
}

export interface FurniturePlacement {
  readonly slotId: string;
  readonly itemId: string;
  readonly variantId: string;
  readonly rotation: 0 | 90 | 180 | 270;
}

export interface HomeCustomizationState {
  readonly propertyId: string;
  readonly placements: readonly FurniturePlacement[];
  readonly revision: number;
  readonly schemaVersion: number;
}

export interface FurnitureItemDefinition {
  readonly id: string;
  readonly category: string;
  readonly width: number;
  readonly height: number;
  readonly variants: readonly string[];
}

export type FurniturePlacementReason =
  | 'valid'
  | 'not-owned-property'
  | 'unknown-slot'
  | 'locked-room'
  | 'unknown-item'
  | 'unknown-variant'
  | 'category-not-allowed'
  | 'slot-capacity'
  | 'outside-bounds'
  | 'collision-overlap'
  | 'invalid-rotation';

export interface FurniturePlacementResult {
  readonly valid: boolean;
  readonly placement: FurniturePlacement;
  readonly reason: FurniturePlacementReason;
}

export interface CustomizationResult {
  readonly success: boolean;
  readonly propertyId: string;
  readonly revision: number;
  readonly reason: 'applied' | 'invalid-placement' | 'not-owned-property' | 'transaction-rejected';
}

export interface RoomDefinition {
  readonly id: string;
  readonly propertyId?: string;
  readonly anchor: Vector2;
  readonly bounds: Rect;
  readonly collisionBounds: readonly Rect[];
  readonly entryPoint: Vector2;
  readonly unlockUpgradeIds: readonly string[];
  readonly featureTags: readonly string[];
}

export interface GarageSlotState {
  readonly slotId: string;
  readonly vehicleId: string | null;
}

export type GarageOperationReason =
  | 'stored'
  | 'removed'
  | 'not-owned-property'
  | 'unknown-vehicle'
  | 'capacity-full'
  | 'duplicate-vehicle'
  | 'protected-vehicle'
  | 'vehicle-moving'
  | 'vehicle-destroyed'
  | 'transition-busy'
  | 'invalid-clearance'
  | 'transaction-rejected';

export interface GarageOperationResult {
  readonly success: boolean;
  readonly propertyId: string;
  readonly vehicleId: string;
  readonly reason: GarageOperationReason;
}

export interface NeighborDefinition {
  readonly id: string;
  readonly propertyId: string;
  readonly role: string;
  readonly routineId: string;
  readonly dialogueSetId: string;
  readonly interactionTags: readonly string[];
}

export interface NeighborRelationshipState {
  readonly neighborId: string;
  readonly affinity: number;
  readonly completedInteractionIds: readonly string[];
}

export interface NeighborInteractionResult {
  readonly success: boolean;
  readonly neighborId: string;
  readonly interactionId: string;
  readonly affinityDelta: number;
  readonly reason: 'accepted' | 'unknown-neighbor' | 'not-owned-property' | 'cooldown';
}

export interface HousingMissionDefinition {
  readonly id: string;
  readonly cityId: CityId;
  readonly districtId?: District;
  readonly propertyTier?: PropertyTier;
  readonly requiredUpgradeIds: readonly string[];
  readonly missionId: string;
  readonly deterministicWeight: number;
}

export interface SafehousePolicy {
  readonly propertyId: string;
  readonly enabled: boolean;
  readonly requiresNoActiveCombat: boolean;
  readonly requiresNoArrestTransition: boolean;
  readonly wantedCooldownSeconds: number;
  readonly maxUsesPerSimulationDay: number;
}

export interface WantedReductionResult {
  readonly accepted: boolean;
  readonly reductionApplied: number;
  readonly reason: 'applied' | 'no-wanted' | 'invalid-duration' | 'unsafe-state';
}

export interface SafehouseDecision {
  readonly allowed: boolean;
  readonly reason:
    'allowed' | 'not-owned-property' | 'policy-disabled' | 'wanted-unsafe' | 'cooldown';
}

export interface SafehouseResult {
  readonly success: boolean;
  readonly propertyId: string;
  readonly reason: SafehouseDecision['reason'] | 'used';
  readonly remainingCooldownTicks: number;
}

export interface HousingReplaySnapshot {
  readonly worldSeed: number;
  readonly simulationSeed: number;
  readonly simulationTick: number;
  readonly activeHomeId: string | null;
  readonly ownedPropertyIds: readonly string[];
  readonly upgrades: readonly PropertyUpgradeState[];
  readonly customization: readonly HomeCustomizationState[];
  readonly garage: readonly GarageSlotState[];
  readonly neighbors: readonly NeighborRelationshipState[];
  readonly safehouseUses: number;
  readonly housingEventCount: number;
  readonly deterministicHash: string;
}

export interface HousingPhase2State {
  readonly schemaVersion: number;
  readonly upgrades: readonly PropertyUpgradeState[];
  readonly customization: readonly HomeCustomizationState[];
  readonly garage: readonly GarageSlotState[];
  readonly activeVehicleIds: readonly string[];
  readonly neighbors: readonly NeighborRelationshipState[];
  readonly safehouse: Readonly<Record<string, { uses: number; cooldownTicks: number }>>;
}
