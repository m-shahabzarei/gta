/**
 * Inventory data contracts shared by the player inventory component, shop UI
 * and inventory scene.
 */
import type { WeaponId } from './WeaponTypes';
import type { VehicleKind } from './VehicleTypes';

/** Broad category used for filtering, visuals and equipment rules. */
export type InventoryItemCategory =
  | 'weapon'
  | 'ammo'
  | 'armor'
  | 'consumable'
  | 'food'
  | 'currency'
  | 'key'
  | 'mission';

/** Equipment slot identifiers shown in the inventory UI. */
export type InventoryEquipmentSlot = 'weapon' | 'armor' | 'quick' | 'key' | 'mission';

/** Stable item identifiers. */
export type InventoryItemId =
  | `weapon:${WeaponId}`
  | `ammo:${WeaponId}`
  | 'armor:vest'
  | 'health:kit'
  | 'health:medkit'
  | 'food:snack'
  | 'food:meal'
  | 'money:cash'
  | 'key:garage'
  | 'key:police'
  | 'key:safehouse'
  | 'mission:package'
  | 'mission:documents';

/** A stackable slot in the player's bag. */
export interface InventorySlotState {
  itemId: InventoryItemId;
  quantity: number;
}

/** Item metadata consumed by UI and use/equip rules. */
export interface InventoryItemDef {
  id: InventoryItemId;
  name: string;
  description: string;
  category: InventoryItemCategory;
  iconKey: string;
  stackMax: number;
  equipmentSlot?: InventoryEquipmentSlot;
  weaponId?: WeaponId;
  ammoWeaponId?: WeaponId;
  ammoAmount?: number;
  healAmount?: number;
  armorAmount?: number;
  cashValue?: number;
}

/** Equipment slots store item ids, not slot indexes, so sorting never breaks them. */
export type InventoryEquipmentState = Partial<Record<InventoryEquipmentSlot, InventoryItemId>>;

/** Result from using an inventory slot. */
export interface InventoryUseResult {
  itemId: InventoryItemId;
  consumed: boolean;
  equippedWeapon?: WeaponId;
  healAmount?: number;
  armorAmount?: number;
  cashValue?: number;
  ammoWeaponId?: WeaponId;
  ammoAmount?: number;
  message: string;
}

/** Persistent inventory snapshot embedded in the player save section. */
export interface InventorySnapshot {
  money: number;
  selected: WeaponId;
  weapons: Record<string, { mag: number; reserve: number }>;
  slots: Array<InventorySlotState | null>;
  equipment: InventoryEquipmentState;
  garageVehicles: VehicleKind[];
}
