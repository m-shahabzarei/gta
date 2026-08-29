import { BaseManager } from '@/core/BaseManager';
import { EngineDiagnostics } from '@/core/EngineDiagnostics';
import type { ISerializable } from '@/core/interfaces';
import type { Json, Rect, Vector2 } from '@/core/types';
import { EventKeys } from '@/config/EventKeys';
import { ServiceKeys } from '@/config/ServiceKeys';
import { ServiceLocator } from '@/core/ServiceLocator';
import {
  createHomeLayout,
  type HomeLayoutSpec,
  type HomeSlotSpec,
} from '@/gameplay/HomeLayoutRegistry';
import { emitHousingTelemetry } from '@/gameplay/HousingTelemetry';
import type { HousingSystem } from './HousingSystem';
import type { HousingProgressionSystem } from './HousingProgressionSystem';
import type {
  CustomizationResult,
  FurnitureItemDefinition,
  FurniturePlacement,
  FurniturePlacementReason,
  FurniturePlacementResult,
  HomeCustomizationState,
  RoomDefinition,
} from '@/gameplay/types/HousingPhase2Types';

const SCHEMA_VERSION = 2;

export const FURNITURE_ITEMS: readonly FurnitureItemDefinition[] = Object.freeze([
  { id: 'bed:basic', category: 'bed', width: 110, height: 54, variants: ['default', 'linen'] },
  { id: 'sofa:basic', category: 'sofa', width: 128, height: 48, variants: ['default', 'modern'] },
  { id: 'table:basic', category: 'table', width: 82, height: 42, variants: ['default', 'wood'] },
  { id: 'desk:basic', category: 'desk', width: 118, height: 46, variants: ['default', 'office'] },
  {
    id: 'storage:chest',
    category: 'storage',
    width: 90,
    height: 38,
    variants: ['default', 'clay'],
  },
  {
    id: 'kitchen:unit',
    category: 'kitchen',
    width: 140,
    height: 42,
    variants: ['default', 'timber'],
  },
  { id: 'lighting:lamp', category: 'lighting', width: 24, height: 24, variants: ['warm', 'cool'] },
  {
    id: 'decorative:plant',
    category: 'decorative',
    width: 38,
    height: 38,
    variants: ['fern', 'cactus'],
  },
  { id: 'workshop:bench', category: 'workshop', width: 132, height: 48, variants: ['default'] },
]);

/** Slot-based furniture and room-unlock authority for owned homes. */
export class HomeCustomizationSystem extends BaseManager implements ISerializable {
  public readonly key = ServiceKeys.HomeCustomization;
  public readonly saveId = 'housing-customization';

  private readonly states = new Map<string, HomeCustomizationState>();
  private readonly previews = new Map<string, HomeCustomizationState>();
  private readonly layoutCache = new Map<string, HomeLayoutSpec>();

  protected onInit(): void {
    this.layoutCache.clear();
  }

  public getRooms(propertyId: string): readonly RoomDefinition[] {
    const property = this.resolveHousing()?.getProperty(propertyId);
    if (!property) return [];
    const layout = this.layoutFor(propertyId);
    const rooms = layout.rooms.map((room) => ({
      id: room.id,
      propertyId,
      anchor: { ...room.anchor },
      bounds: { ...room.bounds },
      collisionBounds: [...layout.walls, ...layout.furniture]
        .map((rect) => ({ x: rect.x, y: rect.y, width: rect.w, height: rect.h }))
        .filter((rect) => intersects(rect, room.bounds)),
      entryPoint: { ...room.entryPoint },
      unlockUpgradeIds: room.unlockUpgradeIds.map((id) => this.resolveUpgradeId(propertyId, id)),
      featureTags: [...room.featureTags],
    }));
    const progression = this.resolveProgression();
    if (progression?.getEffectivePropertyFeatures(propertyId).includes('room:hidden')) {
      rooms.push({
        id: 'hidden',
        propertyId,
        anchor: { x: 640, y: 380 },
        bounds: { x: 560, y: 300, width: 160, height: 120 },
        collisionBounds: [],
        entryPoint: { x: 640, y: 430 },
        unlockUpgradeIds: [`${propertyId}:upgrade:space:3`],
        featureTags: ['hidden', 'safe'],
      });
    }
    return rooms;
  }

  public isRoomUnlocked(propertyId: string, roomId: string): boolean {
    const room = this.getRooms(propertyId).find((candidate) => candidate.id === roomId);
    if (!room) return false;
    const progression = this.resolveProgression();
    return room.unlockUpgradeIds.every(
      (id) => progression?.isUpgradePurchased(propertyId, id) ?? false,
    );
  }

  public canEnterRoom(propertyId: string, roomId: string, position: Vector2): boolean {
    const room = this.getRooms(propertyId).find((candidate) => candidate.id === roomId);
    return (
      room !== undefined &&
      this.isRoomUnlocked(propertyId, roomId) &&
      containsRect(room.bounds, { x: position.x, y: position.y, width: 0, height: 0 })
    );
  }

  public getSlots(
    propertyId: string,
    roomId?: string,
  ): readonly import('@/gameplay/types/HousingPhase2Types').FurnitureSlotDefinition[] {
    if (!this.resolveHousing()?.getProperty(propertyId)) return [];
    const slots = this.layoutFor(propertyId).slots;
    return slots
      .filter((candidate) => roomId === undefined || candidate.roomId === roomId)
      .map((candidate) => this.toSlot(candidate));
  }

  public getCustomization(propertyId: string): HomeCustomizationState {
    return (
      this.states.get(propertyId) ?? {
        propertyId,
        placements: [],
        revision: 0,
        schemaVersion: SCHEMA_VERSION,
      }
    );
  }

  public allCustomizations(): readonly HomeCustomizationState[] {
    return Array.from(this.states.values()).sort((a, b) =>
      a.propertyId.localeCompare(b.propertyId),
    );
  }

  public beginPreview(propertyId: string): HomeCustomizationState {
    const current = this.getCustomization(propertyId);
    const preview = {
      propertyId,
      placements: current.placements.map((placement) => ({ ...placement })),
      revision: current.revision,
      schemaVersion: SCHEMA_VERSION,
    };
    this.previews.set(propertyId, preview);
    return preview;
  }

  public validatePlacement(
    propertyId: string,
    placement: FurniturePlacement,
  ): FurniturePlacementResult {
    const preview = this.previews.get(propertyId) ?? this.getCustomization(propertyId);
    return this.validatePlacementAgainst(propertyId, placement, preview.placements);
  }

  /**
   * Validate a candidate against an explicit placement set.  Keeping this
   * helper separate lets Apply/load validate a complete snapshot
   * sequentially, so later placements cannot hide overlap with earlier ones.
   */
  private validatePlacementAgainst(
    propertyId: string,
    placement: FurniturePlacement,
    existingPlacements: readonly FurniturePlacement[],
  ): FurniturePlacementResult {
    const invalid = (reason: FurniturePlacementReason): FurniturePlacementResult => ({
      valid: false,
      placement,
      reason,
    });
    if (!this.resolveHousing()?.isOwned(propertyId)) return invalid('not-owned-property');
    const slot = this.getSlots(propertyId).find((candidate) => candidate.id === placement.slotId);
    if (!slot) return invalid('unknown-slot');
    if (!this.isRoomUnlocked(propertyId, slot.roomId)) return invalid('locked-room');
    const item = FURNITURE_ITEMS.find((candidate) => candidate.id === placement.itemId);
    if (!item) return invalid('unknown-item');
    if (!item.variants.includes(placement.variantId)) return invalid('unknown-variant');
    if (!slot.allowedCategories.includes(item.category)) return invalid('category-not-allowed');
    if (![0, 90, 180, 270].includes(placement.rotation)) return invalid('invalid-rotation');
    const duplicate = existingPlacements.some(
      (candidate) =>
        candidate.slotId === placement.slotId &&
        candidate.itemId === placement.itemId &&
        candidate.variantId === placement.variantId &&
        candidate.rotation === placement.rotation,
    );
    if (duplicate) return invalid('slot-capacity');
    const count = existingPlacements.filter((candidate) => candidate.slotId === slot.id).length;
    if (count >= slot.maxItems) {
      return invalid('slot-capacity');
    }
    const bounds = this.placementBounds(slot, item.width, item.height, placement.rotation);
    if (!containsRect(slot.bounds, bounds)) return invalid('outside-bounds');
    if (slot.collisionBounds && intersects(slot.collisionBounds, bounds)) {
      return invalid('collision-overlap');
    }
    for (const existing of existingPlacements) {
      const existingItem = FURNITURE_ITEMS.find((candidate) => candidate.id === existing.itemId);
      const existingSlot = this.getSlots(propertyId).find(
        (candidate) => candidate.id === existing.slotId,
      );
      if (
        existingItem &&
        existingSlot &&
        intersects(
          this.placementBounds(
            existingSlot,
            existingItem.width,
            existingItem.height,
            existing.rotation,
          ),
          bounds,
        )
      ) {
        return invalid('collision-overlap');
      }
    }
    return { valid: true, placement, reason: 'valid' };
  }

  public applyPreview(
    propertyId: string,
    placements: readonly FurniturePlacement[],
  ): CustomizationResult {
    if (!this.resolveHousing()?.isOwned(propertyId)) {
      return this.customizationFailure(propertyId, 'not-owned-property');
    }
    const previous = this.previews.get(propertyId);
    const previousSnapshot = previous
      ? { ...previous, placements: previous.placements.map((placement) => ({ ...placement })) }
      : null;
    this.previews.set(propertyId, {
      propertyId,
      placements: [],
      revision: this.getCustomization(propertyId).revision,
      schemaVersion: SCHEMA_VERSION,
    });
    for (const placement of placements) {
      const preview = this.previews.get(propertyId);
      const result = this.validatePlacementAgainst(
        propertyId,
        placement,
        preview?.placements ?? [],
      );
      if (!result.valid) {
        if (previousSnapshot) this.previews.set(propertyId, previousSnapshot);
        else this.previews.delete(propertyId);
        this.bus.emit(EventKeys.PropertyCustomizationRejected, {
          propertyId,
          reason: result.reason,
        });
        return this.customizationFailure(propertyId, 'invalid-placement');
      }
      // Build a validated working set.  This makes the complete Apply
      // transaction reject duplicate or colliding entries atomically.
      this.previews.set(propertyId, {
        propertyId,
        placements: [...(preview?.placements ?? []), { ...placement }],
        revision: this.getCustomization(propertyId).revision,
        schemaVersion: SCHEMA_VERSION,
      });
    }
    const current = this.getCustomization(propertyId);
    const state: HomeCustomizationState = {
      propertyId,
      placements: placements.map((placement) => ({ ...placement })),
      revision: current.revision + 1,
      schemaVersion: SCHEMA_VERSION,
    };
    this.states.set(propertyId, state);
    this.previews.delete(propertyId);
    const result: CustomizationResult = {
      success: true,
      propertyId,
      revision: state.revision,
      reason: 'applied',
    };
    this.bus.emit(EventKeys.PropertyCustomizationApplied, {
      ...result,
      placements: state.placements,
    });
    emitHousingTelemetry('customization-apply', propertyId, 'success');
    return result;
  }

  public cancelPreview(propertyId: string): void {
    this.previews.delete(propertyId);
    const revision = this.getCustomization(propertyId).revision;
    this.bus.emit(EventKeys.PropertyCustomizationCancelled, { propertyId, revision });
    emitHousingTelemetry('customization-cancel', propertyId, 'cancelled');
  }

  public serialize(): Json {
    return {
      schemaVersion: SCHEMA_VERSION,
      states: Array.from(this.states.values())
        .sort((a, b) => a.propertyId.localeCompare(b.propertyId))
        .map((state) => ({
          propertyId: state.propertyId,
          placements: state.placements.map((placement) => ({ ...placement })),
          revision: state.revision,
          schemaVersion: state.schemaVersion,
        })),
    };
  }

  public deserialize(data: Json): void {
    this.states.clear();
    this.previews.clear();
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return;
    const raw = data['states'];
    if (!Array.isArray(raw)) return;
    for (const value of raw) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
      const propertyId = value['propertyId'];
      const revision = value['revision'];
      const placements = value['placements'];
      if (
        typeof propertyId !== 'string' ||
        typeof revision !== 'number' ||
        !Array.isArray(placements)
      ) {
        continue;
      }
      if (!this.resolveHousing()?.getProperty(propertyId)) {
        EngineDiagnostics.recordError(
          new Error(`Unknown customization property: ${propertyId}`),
          'housing-customization-load',
          this.key,
        );
        continue;
      }
      const validPlacements: FurniturePlacement[] = [];
      this.previews.set(propertyId, {
        propertyId,
        placements: [],
        revision: Math.max(0, Math.floor(revision)),
        schemaVersion: SCHEMA_VERSION,
      });
      for (const placement of placements) {
        if (typeof placement !== 'object' || placement === null || Array.isArray(placement)) {
          continue;
        }
        const candidate = {
          slotId: placement['slotId'],
          itemId: placement['itemId'],
          variantId: placement['variantId'],
          rotation: placement['rotation'],
        } as FurniturePlacement;
        const result = this.validatePlacementAgainst(propertyId, candidate, validPlacements);
        if (result.valid) validPlacements.push({ ...candidate });
        else {
          EngineDiagnostics.recordLimitExceeded(
            'housing-invalid-furniture',
            1,
            0,
            'ignored-invalid-placement',
            `${propertyId}:${result.reason}`,
          );
        }
      }
      this.states.set(propertyId, {
        propertyId,
        placements: validPlacements,
        revision: Math.max(0, Math.floor(revision)),
        schemaVersion: SCHEMA_VERSION,
      });
      this.previews.delete(propertyId);
    }
  }

  public onMissingSaveSection(): void {
    this.states.clear();
    this.previews.clear();
  }

  private customizationFailure(
    propertyId: string,
    reason: 'invalid-placement' | 'not-owned-property' | 'transaction-rejected',
  ): CustomizationResult {
    return {
      success: false,
      propertyId,
      revision: this.getCustomization(propertyId).revision,
      reason,
    };
  }

  private layoutFor(propertyId: string): HomeLayoutSpec {
    const cached = this.layoutCache.get(propertyId);
    if (cached) return cached;
    const property = this.resolveHousing()?.getProperty(propertyId);
    const layout = property
      ? createHomeLayout(property.interiorLayoutId, property.deterministicSeed ?? 0)
      : createHomeLayout('home:tehran-apartment', 0);
    this.layoutCache.set(propertyId, layout);
    return layout;
  }

  private toSlot(
    spec: HomeSlotSpec,
  ): import('@/gameplay/types/HousingPhase2Types').FurnitureSlotDefinition {
    return {
      id: spec.id,
      roomId: spec.roomId,
      allowedCategories: [...spec.allowedCategories],
      anchor: { ...spec.anchor },
      bounds: {
        x: spec.bounds.x,
        y: spec.bounds.y,
        width: spec.bounds.width,
        height: spec.bounds.height,
      },
      collisionBounds: spec.collisionBounds ? { ...spec.collisionBounds } : undefined,
      maxItems: spec.maxItems,
    };
  }

  private resolveUpgradeId(propertyId: string, id: string): string {
    if (id.startsWith(`${propertyId}:`)) return id;
    return `${propertyId}:${id}`;
  }

  private placementBounds(
    slot: { anchor: { x: number; y: number } },
    width: number,
    height: number,
    rotation: 0 | 90 | 180 | 270,
  ): Rect {
    const rotated = rotation === 90 || rotation === 270;
    const w = rotated ? height : width;
    const h = rotated ? width : height;
    return { x: slot.anchor.x - w / 2, y: slot.anchor.y - h / 2, width: w, height: h };
  }

  private resolveHousing(): HousingSystem | null {
    return ServiceLocator.tryResolve<HousingSystem>(ServiceKeys.Housing);
  }

  private resolveProgression(): HousingProgressionSystem | null {
    return ServiceLocator.tryResolve<HousingProgressionSystem>(ServiceKeys.HousingProgression);
  }
}

function containsRect(container: Rect, value: Rect): boolean {
  return (
    value.x >= container.x &&
    value.y >= container.y &&
    value.x + value.width <= container.x + container.width &&
    value.y + value.height <= container.y + container.height
  );
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}
