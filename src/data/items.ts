/**
 * Inventory item catalogue.
 *
 * Weapon items are derived from the weapon catalogue; the rest are defined
 * here because they are UI / economy / mission specific.
 */
import { TextureKeys } from '@/config/AssetKeys';
import { WEAPONS } from '@/data/weapons';
import type {
  InventoryItemDef,
  InventoryItemId,
  InventoryItemCategory,
} from '@/gameplay/types/InventoryTypes';
import type { WeaponId } from '@/gameplay/types/WeaponTypes';

/** Weapon item identifier helper. */
export function weaponItemId(id: WeaponId): InventoryItemId {
  return `weapon:${id}` as InventoryItemId;
}

/** Ammunition item identifier helper. */
export function ammoItemId(id: WeaponId): InventoryItemId {
  return `ammo:${id}` as InventoryItemId;
}

/** Stable catalogue of non-weapon items. */
const ITEM_DEFS: Record<string, InventoryItemDef> = {
  'armor:vest': {
    id: 'armor:vest',
    name: 'Armor Vest',
    description: 'Toughens you up against bullets and crashes.',
    category: 'armor',
    iconKey: TextureKeys.PickupArmor,
    stackMax: 3,
    equipmentSlot: 'armor',
    armorAmount: 40,
  },
  'health:kit': {
    id: 'health:kit',
    name: 'Health Kit',
    description: 'Small first-aid pack for a quick patch-up.',
    category: 'consumable',
    iconKey: TextureKeys.PickupHealth,
    stackMax: 6,
    equipmentSlot: 'quick',
    healAmount: 35,
  },
  'health:medkit': {
    id: 'health:medkit',
    name: 'Medkit',
    description: 'Large medkit that restores a lot of health.',
    category: 'consumable',
    iconKey: TextureKeys.PickupHealth,
    stackMax: 4,
    equipmentSlot: 'quick',
    healAmount: 75,
  },
  'food:snack': {
    id: 'food:snack',
    name: 'Snack',
    description: 'Small bite of food that restores a little health.',
    category: 'food',
    iconKey: TextureKeys.Package,
    stackMax: 8,
    equipmentSlot: 'quick',
    healAmount: 12,
  },
  'food:meal': {
    id: 'food:meal',
    name: 'Hot Meal',
    description: 'Restores health over time when used.',
    category: 'food',
    iconKey: TextureKeys.Package,
    stackMax: 4,
    equipmentSlot: 'quick',
    healAmount: 28,
  },
  'money:cash': {
    id: 'money:cash',
    name: 'Cash Stash',
    description: 'Loose cash bundle.',
    category: 'currency',
    iconKey: TextureKeys.PickupMoney,
    stackMax: 999,
    cashValue: 100,
  },
  'key:garage': {
    id: 'key:garage',
    name: 'Garage Key',
    description: 'Opens up purchased garage vehicles.',
    category: 'key',
    iconKey: TextureKeys.Package,
    stackMax: 1,
    equipmentSlot: 'key',
  },
  'key:police': {
    id: 'key:police',
    name: 'Police Access Card',
    description: 'Lets you move through restricted interiors.',
    category: 'key',
    iconKey: TextureKeys.Package,
    stackMax: 1,
    equipmentSlot: 'key',
  },
  'key:safehouse': {
    id: 'key:safehouse',
    name: 'Safe House Key',
    description: 'Entry key for a hidden safe house.',
    category: 'key',
    iconKey: TextureKeys.Package,
    stackMax: 1,
    equipmentSlot: 'key',
  },
  'mission:package': {
    id: 'mission:package',
    name: 'Mission Package',
    description: 'Important mission cargo.',
    category: 'mission',
    iconKey: TextureKeys.Package,
    stackMax: 1,
    equipmentSlot: 'mission',
  },
  'mission:documents': {
    id: 'mission:documents',
    name: 'Documents',
    description: 'Sensitive papers for a mission chain.',
    category: 'mission',
    iconKey: TextureKeys.Package,
    stackMax: 1,
    equipmentSlot: 'mission',
  },
};

/** Returns the metadata for an inventory item. */
export function getItemDef(itemId: InventoryItemId): InventoryItemDef {
  if (itemId.startsWith('weapon:')) {
    const weaponId = itemId.slice(7) as WeaponId;
    const weapon = WEAPONS[weaponId];
    if (!weapon) {
      return {
        id: itemId,
        name: 'Unknown Weapon',
        description: 'Unclassified weapon item.',
        category: 'weapon',
        iconKey: TextureKeys.Package,
        stackMax: 1,
        equipmentSlot: 'weapon',
      };
    }
    return {
      id: itemId,
      name: weapon.name,
      description: weapon.isMelee
        ? 'Equipped melee weapon.'
        : `${weapon.damage} damage, ${weapon.fireRateMs} ms fire rate.`,
      category: 'weapon',
      iconKey: weapon.iconKey,
      stackMax: 1,
      equipmentSlot: 'weapon',
      weaponId,
    };
  }
  if (itemId.startsWith('ammo:')) {
    const weaponId = itemId.slice(5) as WeaponId;
    const weapon = WEAPONS[weaponId];
    if (!weapon) {
      return {
        id: itemId,
        name: 'Unknown Ammo',
        description: 'Ammunition for an unknown weapon.',
        category: 'ammo',
        iconKey: TextureKeys.PickupAmmo,
        stackMax: 1,
      };
    }
    return {
      id: itemId,
      name: `${weapon.name} Ammo`,
      description: 'Ammunition for the matching weapon.',
      category: 'ammo',
      iconKey: TextureKeys.PickupAmmo,
      stackMax: weapon.reserveMax,
      ammoWeaponId: weaponId,
      ammoAmount: Math.max(1, weapon.magazine || 24),
    };
  }
  return (
    ITEM_DEFS[itemId] ?? {
      id: itemId,
      name: 'Unknown Item',
      description: 'Unclassified inventory item.',
      category: 'mission' as InventoryItemCategory,
      iconKey: TextureKeys.Package,
      stackMax: 1,
    }
  );
}

/** Whether an item id refers to a weapon item. */
export function isWeaponItemId(itemId: InventoryItemId): itemId is `weapon:${WeaponId}` {
  return itemId.startsWith('weapon:');
}

/** Whether an item id refers to an ammunition item. */
export function isAmmoItemId(itemId: InventoryItemId): itemId is `ammo:${WeaponId}` {
  return itemId.startsWith('ammo:');
}

/** Return a sensible initial stack size for item grants. */
export function defaultStackSize(itemId: InventoryItemId): number {
  return getItemDef(itemId).stackMax;
}
