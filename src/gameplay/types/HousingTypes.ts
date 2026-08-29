import type { Rect, Vector2 } from '@/core/types';
import type { CityId, District } from './WorldTypes';

/** Immutable, data-driven home offered by a city real-estate office. */
export interface PropertyDefinition {
  readonly id: string;
  readonly cityId: CityId;
  readonly districtId: District;
  readonly displayName: string;
  readonly price: number;
  readonly currency: string;
  readonly entranceWorldPosition: Vector2;
  readonly previewWorldPosition: Vector2;
  readonly previewBounds?: Rect;
  readonly interactionRadius: number;
  readonly interiorLayoutId: string;
  readonly styleId: 'tehran-apartment' | 'yazd-courtyard' | 'gilan-wooden';
  readonly features: readonly string[];
  readonly parkingCapacity: number;
  readonly valid: boolean;
  readonly buildingId: string;
  /** Stable layout seed derived from the generated world seed and property id. */
  readonly deterministicSeed?: number;
}

/** A valid real-estate office projected onto existing world geometry. */
export interface RealEstateOfficeDefinition {
  readonly id: string;
  readonly cityId: CityId;
  readonly buildingId: string;
  readonly npcRole: string;
  readonly npcSpawnPosition: Vector2;
  readonly interactionRadius: number;
}

/** Durable ownership state owned exclusively by HousingSystem. */
export interface HousingOwnershipState {
  readonly ownedPropertyIds: readonly string[];
  readonly activeHomeId: string | null;
  readonly schemaVersion: number;
}

export type PropertyPurchaseReason =
  | 'purchased'
  | 'already-owned'
  | 'insufficient-funds'
  | 'invalid-property'
  | 'wrong-city'
  | 'transaction-rejected';

export interface PropertyPurchaseResult {
  readonly success: boolean;
  readonly propertyId: string;
  readonly reason: PropertyPurchaseReason;
}

/** Payload passed to the existing InteriorScene when entering a home. */
export interface HomeInteriorPayload {
  readonly propertyId: string;
  readonly layoutId: string;
  readonly deterministicSeed: number;
  readonly entryWorldPosition: Vector2;
}

/** Snapshot needed to restore the outdoor player/camera/input lifecycle. */
export interface HomeEntrySnapshot {
  readonly worldPosition: Vector2;
  readonly cameraScroll: Vector2;
  readonly cameraZoom: number;
  readonly activeSceneKey: string;
  readonly inputMode: string;
  readonly previousPauseState: unknown;
}

export interface HousingCatalogData {
  readonly properties: readonly PropertyDefinition[];
  readonly offices: readonly RealEstateOfficeDefinition[];
}

// Phase 2 contracts are re-exported here for callers that already import all
// housing data from this module; the definitions themselves remain focused in
// HousingPhase2Types.ts to avoid duplicating ownership/property contracts.
export type {
  PropertyTier,
  PropertyUpgradeCategory,
  PropertyUpgradeDefinition,
  PropertyUpgradeState,
  PurchaseUpgradeReason,
  PurchaseUpgradeResult,
  FurnitureSlotDefinition,
  FurniturePlacement,
  HomeCustomizationState,
  FurnitureItemDefinition,
  FurniturePlacementReason,
  FurniturePlacementResult,
  CustomizationResult,
  RoomDefinition,
  GarageSlotState,
  GarageOperationReason,
  GarageOperationResult,
  NeighborDefinition,
  NeighborRelationshipState,
  NeighborInteractionResult,
  HousingMissionDefinition,
  SafehousePolicy,
  WantedReductionResult,
  SafehouseDecision,
  SafehouseResult,
  HousingReplaySnapshot,
  HousingPhase2State,
} from './HousingPhase2Types';
