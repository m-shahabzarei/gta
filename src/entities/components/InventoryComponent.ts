/**
 * Player inventory: money, owned weapons and per-weapon ammunition split into
 * a loaded magazine plus reserve rounds.
 *
 * This component is player-only. It is the single source of truth for the
 * player's wallet and armoury and drives the HUD purely through global events
 * on the {@link eventBus} (money, weapon selection and ammo counters). The
 * combat pipeline reads the current weapon / ammo via the owning entity; this
 * component never touches the world or the combat service directly.
 */
import { Component } from '@/entities/Component';
import { WEAPONS, WEAPON_ORDER, STARTING_WEAPON, weaponItemId } from '@/data';
import type {
  InventoryEquipmentState,
  InventoryItemId,
  InventorySlotState,
  InventorySnapshot,
  InventoryUseResult,
} from '@/gameplay/types';
import type { VehicleKind, WeaponDef, WeaponId } from '@/gameplay/types';
import type { Json } from '@/core/types';
import { eventBus } from '@/core/EventBus';
import { EventKeys } from '@/config/EventKeys';
import { getItemDef, isWeaponItemId } from '@/data';

/** Sentinel ammo value meaning "unlimited" (used for melee weapons). */
const UNLIMITED_AMMO = -1;

/** Magazine + reserve rounds carried for one owned weapon. */
interface AmmoState {
  mag: number;
  reserve: number;
}

/** Default size of the backpack grid. */
const BAG_SLOT_COUNT = 24;

/** Default equipment slots the UI can render. */
const DEFAULT_EQUIPMENT: InventoryEquipmentState = {};

/** Vehicle kinds the player has bought and can later retrieve from the garage. */
const DEFAULT_GARAGE: VehicleKind[] = [];

export class InventoryComponent extends Component {
  /** Component id within its host entity. */
  public readonly name = 'inventory';

  /** Owned weapons mapped to their ammo state (melee stores zeros). */
  private readonly ammoByWeapon = new Map<WeaponId, AmmoState>();

  /** The currently selected weapon id. */
  private selectedWeapon: WeaponId = STARTING_WEAPON;

  /** The player's current money balance. */
  private wallet: number;

  /** Backpack grid holding non-weapon items. */
  private readonly bag: Array<InventorySlotState | null> = Array.from(
    { length: BAG_SLOT_COUNT },
    () => null,
  );

  /** Equipment slots shown in the inventory scene. */
  private readonly equipmentSlots: InventoryEquipmentState = { ...DEFAULT_EQUIPMENT };

  /** Purchased vehicles stored in the player's garage. */
  private readonly garageVehicles: VehicleKind[] = [...DEFAULT_GARAGE];

  /**
   * @param startMoney the player's starting cash balance.
   */
  constructor(startMoney: number) {
    super();
    this.wallet = Math.max(0, Math.floor(startMoney));
    // The starting weapon is always owned and never lost.
    this.ammoByWeapon.set(STARTING_WEAPON, { mag: 0, reserve: 0 });
    this.selectedWeapon = STARTING_WEAPON;
    this.equipmentSlots.weapon = weaponItemId(STARTING_WEAPON);
  }

  // ── Money ─────────────────────────────────────────────────────────────────

  /** The player's current money balance. */
  public get money(): number {
    return this.wallet;
  }

  /**
   * Credit money to the wallet and notify the HUD.
   * @param n amount to add (negative values are ignored).
   */
  public addMoney(n: number): void {
    if (n <= 0) return;
    const delta = Math.floor(n);
    this.wallet += delta;
    eventBus.emit(EventKeys.MoneyChanged, { total: this.wallet, delta });
  }

  /**
   * Restore the wallet to an exact balance and notify the HUD of the delta.
   * @param n New non-negative money balance.
   */
  public setMoney(n: number): void {
    if (!Number.isFinite(n)) return;
    const next = Math.max(0, Math.floor(n));
    const delta = next - this.wallet;
    if (delta === 0) return;
    this.wallet = next;
    eventBus.emit(EventKeys.MoneyChanged, { total: this.wallet, delta });
  }

  /**
   * Attempt to spend money.
   * @param n amount to spend.
   * @returns `true` when the balance was sufficient and the debit occurred.
   */
  public spendMoney(n: number): boolean {
    const cost = Math.floor(n);
    if (cost <= 0 || this.wallet < cost) return false;
    this.wallet -= cost;
    eventBus.emit(EventKeys.MoneyChanged, { total: this.wallet, delta: -cost });
    return true;
  }

  /** Snapshot of all backpack slots (empty slots are filtered out). */
  public get slots(): InventorySlotState[] {
    return this.bag.filter((slot): slot is InventorySlotState => slot !== null);
  }

  /** Snapshot of the full backpack grid, preserving empty-slot positions. */
  public get bagSlots(): ReadonlyArray<InventorySlotState | null> {
    return this.bag.map((slot) => (slot ? { ...slot } : null));
  }

  /** Number of backpack slots. */
  public get slotCount(): number {
    return this.bag.length;
  }

  /** Copy a slot by index, or null when empty/out of range. */
  public slotAt(index: number): InventorySlotState | null {
    const slot = this.bag[index];
    return slot ? { ...slot } : null;
  }

  /** Equipment slots exposed to the inventory scene. */
  public get equipment(): InventoryEquipmentState {
    return { ...this.equipmentSlots };
  }

  /** Vehicles purchased for the garage. */
  public get ownedVehicles(): readonly VehicleKind[] {
    return this.garageVehicles.slice();
  }

  /** Whether the garage already contains a purchased vehicle kind. */
  public hasVehicle(kind: VehicleKind): boolean {
    return this.garageVehicles.includes(kind);
  }

  /** Add a vehicle kind to the garage, if not already owned. */
  public addVehicle(kind: VehicleKind): boolean {
    if (this.hasVehicle(kind)) {
      return false;
    }
    this.garageVehicles.push(kind);
    return true;
  }

  /** Add a generic inventory item to the bag. Returns the amount stored. */
  public addItem(itemId: InventoryItemId, quantity = 1): number {
    const def = getItemDef(itemId);
    const amount = Math.max(0, Math.floor(quantity));
    if (amount <= 0) {
      return 0;
    }
    if (def.stackMax <= 1 && this.hasItem(itemId)) {
      return 0;
    }

    let remaining = amount;

    for (let i = 0; i < this.bag.length && remaining > 0; i++) {
      const slot = this.bag[i];
      if (!slot || slot.itemId !== itemId) continue;
      const space = def.stackMax - slot.quantity;
      if (space <= 0) continue;
      const moved = Math.min(space, remaining);
      slot.quantity += moved;
      remaining -= moved;
    }

    for (let i = 0; i < this.bag.length && remaining > 0; i++) {
      if (this.bag[i] !== null) continue;
      const moved = Math.min(def.stackMax, remaining);
      this.bag[i] = { itemId, quantity: moved };
      remaining -= moved;
    }

    return amount - remaining;
  }

  /** Whether a bag stack or equipment slot contains an item. */
  public hasItem(itemId: InventoryItemId): boolean {
    return (
      this.bag.some((slot) => slot?.itemId === itemId) ||
      Object.values(this.equipmentSlots).some((equipped) => equipped === itemId)
    );
  }

  /** Remove an item quantity from a slot index. */
  public removeSlotQuantity(index: number, quantity = 1): boolean {
    const slot = this.bag[index];
    if (!slot) return false;
    const amount = Math.max(0, Math.floor(quantity));
    if (amount <= 0) return false;
    if (slot.quantity <= amount) {
      this.bag[index] = null;
    } else {
      slot.quantity -= amount;
    }
    return true;
  }

  /** Move or merge a stack from one slot to another. */
  public moveSlot(fromIndex: number, toIndex: number): boolean {
    if (fromIndex === toIndex) return false;
    if (!this.isBagIndex(fromIndex) || !this.isBagIndex(toIndex)) return false;
    const from = this.bag[fromIndex];
    const to = this.bag[toIndex];
    if (!from) return false;

    if (!to) {
      this.bag[toIndex] = from;
      this.bag[fromIndex] = null;
      return true;
    }

    if (from.itemId === to.itemId) {
      const def = getItemDef(from.itemId);
      const space = def.stackMax - to.quantity;
      if (space <= 0) {
        this.bag[fromIndex] = to;
        this.bag[toIndex] = from;
        return true;
      }
      const moved = Math.min(space, from.quantity);
      to.quantity += moved;
      from.quantity -= moved;
      if (from.quantity <= 0) {
        this.bag[fromIndex] = null;
      }
      return true;
    }

    this.bag[fromIndex] = to;
    this.bag[toIndex] = from;
    return true;
  }

  /** Equip a weapon item if owned. */
  public equipWeaponItem(itemId: InventoryItemId): boolean {
    if (!isWeaponItemId(itemId)) return false;
    const weaponId = itemId.slice(7) as WeaponId;
    if (!this.ammoByWeapon.has(weaponId)) return false;
    this.selectedWeapon = weaponId;
    this.equipmentSlots.weapon = itemId;
    this.emitSwitched();
    return true;
  }

  /** Equip a consumable / quick-use item into the quick slot. */
  public equipQuickItem(itemId: InventoryItemId): void {
    this.equipmentSlots.quick = itemId;
  }

  /** Equip an armor item. */
  public equipArmorItem(itemId: InventoryItemId): void {
    this.equipmentSlots.armor = itemId;
  }

  /** Equip a key item. */
  public equipKeyItem(itemId: InventoryItemId): void {
    this.equipmentSlots.key = itemId;
  }

  /** Equip a mission item. */
  public equipMissionItem(itemId: InventoryItemId): void {
    this.equipmentSlots.mission = itemId;
  }

  /**
   * Use a bag slot. Weapon items equip, consumables restore stats, ammo items
   * refill the matching weapon and currency items add money.
   */
  public useSlot(index: number): InventoryUseResult | null {
    const slot = this.bag[index];
    if (!slot) return null;
    const def = getItemDef(slot.itemId);
    const result: InventoryUseResult = {
      itemId: slot.itemId,
      consumed: false,
      message: def.name,
    };

    if (def.category === 'weapon' && def.weaponId) {
      this.selectedWeapon = def.weaponId;
      this.equipmentSlots.weapon = slot.itemId;
      this.emitSwitched();
      result.equippedWeapon = def.weaponId;
      result.message = `Equipped ${def.name}`;
      return result;
    }

    if (def.category === 'consumable' || def.category === 'food') {
      result.consumed = this.removeSlotQuantity(index, 1);
      result.healAmount = def.healAmount;
      result.armorAmount = def.armorAmount;
      result.message = `Used ${def.name}`;
      return result;
    }

    if (def.category === 'currency') {
      result.consumed = this.removeSlotQuantity(index, 1);
      result.cashValue = def.cashValue ?? 0;
      if (result.cashValue > 0) {
        this.addMoney(result.cashValue);
      }
      result.message = `Added $${result.cashValue}`;
      return result;
    }

    if (def.category === 'ammo' && def.ammoWeaponId) {
      result.consumed = this.removeSlotQuantity(index, 1);
      result.ammoWeaponId = def.ammoWeaponId;
      result.ammoAmount = def.ammoAmount ?? def.stackMax;
      if (result.ammoAmount > 0) {
        this.addAmmo(def.ammoWeaponId, result.ammoAmount);
      }
      result.message = `Ammo for ${WEAPONS[def.ammoWeaponId].name}`;
      return result;
    }

    if (def.category === 'armor') {
      result.consumed = this.removeSlotQuantity(index, 1);
      result.armorAmount = def.armorAmount ?? 0;
      result.message = `Used ${def.name}`;
      return result;
    }

    result.message = `Cannot use ${def.name}`;
    return result;
  }

  // ── Weapons & ammo ──────────────────────────────────────────────────────────

  /**
   * Grant a weapon (owning it if not already) with a starting ammo amount.
   * Rounds fill the magazine first; the surplus lands in reserve (clamped to
   * the weapon's reserve capacity).
   * @param id weapon to grant.
   * @param ammo ammunition to add for that weapon.
   */
  public giveWeapon(id: WeaponId, ammo: number): void {
    const def = WEAPONS[id];
    const alreadyOwned = this.ammoByWeapon.has(id);
    const state = this.ammoByWeapon.get(id) ?? { mag: 0, reserve: 0 };
    if (!def.isMelee) {
      let rounds = Math.max(0, Math.floor(ammo));
      const toMag = Math.min(def.magazine - state.mag, rounds);
      state.mag += toMag;
      rounds -= toMag;
      state.reserve = Math.min(def.reserveMax, state.reserve + rounds);
    }
    this.ammoByWeapon.set(id, state);
    if (!alreadyOwned) {
      this.addItem(weaponItemId(id), 1);
    }
    this.equipmentSlots.weapon = weaponItemId(this.selectedWeapon);
    this.emitAmmoChanged(id);
  }

  /**
   * Add reserve ammunition to an already-owned weapon. No-op for weapons that
   * are not owned or for melee weapons (which are unlimited).
   * @param id weapon to top up.
   * @param ammo ammunition to add.
   * @returns Whether any rounds were actually added.
   */
  public addAmmo(id: WeaponId, ammo: number): boolean {
    const state = this.ammoByWeapon.get(id);
    if (!state || WEAPONS[id].isMelee) return false;
    const before = state.reserve;
    state.reserve = Math.min(WEAPONS[id].reserveMax, state.reserve + Math.max(0, Math.floor(ammo)));
    if (state.reserve === before) return false;
    this.emitAmmoChanged(id);
    return true;
  }

  /** Whether the given weapon is owned. */
  public hasWeapon(id: WeaponId): boolean {
    return this.ammoByWeapon.has(id);
  }

  /** The owned weapon ids, in canonical {@link WEAPON_ORDER}. */
  public get ownedWeapons(): WeaponId[] {
    return WEAPON_ORDER.filter((id) => this.ammoByWeapon.has(id));
  }

  /** The currently selected weapon id. */
  public get currentWeaponId(): WeaponId {
    return this.selectedWeapon;
  }

  /** The full definition of the currently selected weapon. */
  public get currentWeapon(): WeaponDef {
    return WEAPONS[this.selectedWeapon];
  }

  /** Remove and return the equipped non-starting weapon for a world drop. */
  public dropEquippedWeapon(): { weaponId: WeaponId; ammo: number } | null {
    const weaponId = this.selectedWeapon;
    if (weaponId === STARTING_WEAPON) return null;
    const state = this.ammoByWeapon.get(weaponId);
    if (!state) return null;

    const dropped = { weaponId, ammo: state.mag + state.reserve };
    this.ammoByWeapon.delete(weaponId);
    const itemId = weaponItemId(weaponId);
    for (let index = 0; index < this.bag.length; index++) {
      if (this.bag[index]?.itemId === itemId) this.bag[index] = null;
    }
    this.selectedWeapon = STARTING_WEAPON;
    this.equipmentSlots.weapon = weaponItemId(STARTING_WEAPON);
    this.emitSwitched();
    return dropped;
  }

  /**
   * Loaded rounds for the current weapon. Returns {@link UNLIMITED_AMMO} (-1)
   * for melee weapons, whose ammunition is unlimited.
   */
  public get ammo(): number {
    return this.magFor(this.selectedWeapon);
  }

  /** Reserve rounds for the current weapon (0 for melee). */
  public get reserve(): number {
    return this.ammoByWeapon.get(this.selectedWeapon)?.reserve ?? 0;
  }

  /** Magazine rounds for an arbitrary owned weapon (-1 for melee). */
  public magOf(id: WeaponId): number {
    return this.magFor(id);
  }

  /** Reserve rounds for an arbitrary owned weapon. */
  public reserveOf(id: WeaponId): number {
    return this.ammoByWeapon.get(id)?.reserve ?? 0;
  }

  /** Whether the current weapon can fire right now (melee always can). */
  public hasAmmo(): boolean {
    if (this.currentWeapon.isMelee) return true;
    return (this.ammoByWeapon.get(this.selectedWeapon)?.mag ?? 0) > 0;
  }

  /** Whether a reload would actually move rounds into the magazine. */
  public canReload(): boolean {
    const def = this.currentWeapon;
    if (def.isMelee) return false;
    const state = this.ammoByWeapon.get(this.selectedWeapon);
    if (!state) return false;
    return state.mag < def.magazine && state.reserve > 0;
  }

  /**
   * Consume one round of the current weapon's magazine. Melee weapons are
   * skipped; other weapons decrement (clamped at zero) and notify the HUD.
   */
  public consumeAmmo(): void {
    if (this.currentWeapon.isMelee) return;
    const state = this.ammoByWeapon.get(this.selectedWeapon);
    if (!state || state.mag <= 0) return;
    state.mag -= 1;
    this.emitAmmoChanged(this.selectedWeapon);
  }

  /**
   * Complete a reload: move rounds from reserve into the magazine. The reload
   * *timing* lives in the weapon component; this is the instant transfer once
   * that timer elapses.
   */
  public performReload(): void {
    const def = this.currentWeapon;
    const state = this.ammoByWeapon.get(this.selectedWeapon);
    if (!state || def.isMelee) return;
    const moved = Math.min(def.magazine - state.mag, state.reserve);
    if (moved <= 0) return;
    state.mag += moved;
    state.reserve -= moved;
    this.emitAmmoChanged(this.selectedWeapon);
  }

  /** Cycle forward to the next owned weapon. */
  public switchNext(): void {
    this.cycle(1);
  }

  /** Cycle backward to the previous owned weapon. */
  public switchPrev(): void {
    this.cycle(-1);
  }

  /**
   * Select a specific weapon by id. No-op when the weapon is not owned or is
   * already selected.
   * @param id weapon to switch to.
   */
  public switchTo(id: WeaponId): void {
    if (!this.ammoByWeapon.has(id) || id === this.selectedWeapon) return;
    this.selectedWeapon = id;
    this.equipmentSlots.weapon = weaponItemId(id);
    this.emitSwitched();
  }

  // ── Persistence ─────────────────────────────────────────────────────────────

  /** JSON-safe snapshot of the full inventory. */
  public snapshotInventory(): InventorySnapshot {
    const weapons: Record<string, { mag: number; reserve: number }> = {};
    for (const [id, state] of this.ammoByWeapon) {
      weapons[id] = { mag: state.mag, reserve: state.reserve };
    }
    return {
      money: this.wallet,
      selected: this.selectedWeapon,
      weapons,
      slots: this.bag.map((slot) => (slot ? { ...slot } : null)),
      equipment: { ...this.equipmentSlots },
      garageVehicles: this.garageVehicles.slice(),
    };
  }

  /** JSON-safe snapshot of the armoury, kept for older save code. */
  public snapshotWeapons(): Json {
    return this.snapshotInventory() as unknown as Json;
  }

  /** Restore the full inventory from a save snapshot. */
  public restoreInventory(data: Json): void {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return;
    const record = data as { [key: string]: Json };

    const money = record.money;
    if (typeof money === 'number') {
      this.setMoney(money);
    }

    this.ammoByWeapon.clear();
    this.ammoByWeapon.set(STARTING_WEAPON, { mag: 0, reserve: 0 });
    this.selectedWeapon = STARTING_WEAPON;

    const weapons = record.weapons;
    if (typeof weapons === 'object' && weapons !== null && !Array.isArray(weapons)) {
      for (const [id, raw] of Object.entries(weapons)) {
        if (!this.isWeaponId(id)) continue;
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
        const def = WEAPONS[id];
        const mag = (raw as { mag?: Json }).mag;
        const reserve = (raw as { reserve?: Json }).reserve;
        this.ammoByWeapon.set(id, {
          mag: def.isMelee ? 0 : this.clampInt(mag, 0, def.magazine),
          reserve: def.isMelee ? 0 : this.clampInt(reserve, 0, def.reserveMax),
        });
      }
    }

    this.bag.fill(null);
    const slots = record.slots;
    if (Array.isArray(slots)) {
      for (let i = 0; i < slots.length && i < this.bag.length; i++) {
        const raw = slots[i];
        if (raw === null) continue;
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
        const itemId = (raw as { itemId?: Json }).itemId;
        const quantity = (raw as { quantity?: Json }).quantity;
        if (
          typeof itemId !== 'string' ||
          typeof quantity !== 'number' ||
          !this.isKnownItemId(itemId)
        ) {
          continue;
        }
        const def = getItemDef(itemId as InventoryItemId);
        const qty = this.clampInt(quantity, 1, def.stackMax);
        this.bag[i] = { itemId: itemId as InventoryItemId, quantity: qty };
      }
    }

    for (const slotName of ['weapon', 'armor', 'quick', 'key', 'mission'] as const) {
      delete this.equipmentSlots[slotName];
    }
    const equipment = record.equipment;
    if (typeof equipment === 'object' && equipment !== null && !Array.isArray(equipment)) {
      for (const slotName of ['weapon', 'armor', 'quick', 'key', 'mission'] as const) {
        const raw = equipment[slotName];
        if (typeof raw === 'string' && this.isKnownItemId(raw)) {
          this.equipmentSlots[slotName] = raw as InventoryItemId;
        }
      }
    }

    const garageVehicles = record.garageVehicles;
    this.garageVehicles.length = 0;
    if (Array.isArray(garageVehicles)) {
      for (const raw of garageVehicles) {
        if (typeof raw === 'string' && this.isVehicleKind(raw)) {
          this.garageVehicles.push(raw);
        }
      }
    }

    const selected = record.selected;
    if (
      typeof selected === 'string' &&
      this.isWeaponId(selected) &&
      this.ammoByWeapon.has(selected)
    ) {
      this.selectedWeapon = selected;
    }
    this.equipmentSlots.weapon = weaponItemId(this.selectedWeapon);
    this.emitSwitched();
  }

  /** Restore the inventory from either the old or the new snapshot shape. */
  public restoreWeapons(data: Json): void {
    this.restoreInventory(data);
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  /** Runtime guard for the {@link WeaponId} union. */
  private isWeaponId(id: string): id is WeaponId {
    return (WEAPON_ORDER as readonly string[]).includes(id);
  }

  /** Runtime guard for inventory item identifiers. */
  private isKnownItemId(id: string): id is InventoryItemId {
    return (
      (id.startsWith('weapon:') && this.isWeaponId(id.slice(7))) ||
      (id.startsWith('ammo:') && this.isWeaponId(id.slice(5))) ||
      id === 'armor:vest' ||
      id === 'health:kit' ||
      id === 'health:medkit' ||
      id === 'food:snack' ||
      id === 'food:meal' ||
      id === 'money:cash' ||
      id === 'key:garage' ||
      id === 'key:police' ||
      id === 'key:safehouse' ||
      id === 'mission:package' ||
      id === 'mission:documents'
    );
  }

  /** Whether a bag index is in bounds. */
  private isBagIndex(index: number): boolean {
    return Number.isInteger(index) && index >= 0 && index < this.bag.length;
  }

  /** Runtime guard for vehicle kinds stored in the garage. */
  private isVehicleKind(id: string): id is VehicleKind {
    return (
      id === 'sedan' ||
      id === 'taxi' ||
      id === 'police' ||
      id === 'policeSuv' ||
      id === 'ambulance' ||
      id === 'fireTruck' ||
      id === 'sports' ||
      id === 'luxury' ||
      id === 'classic' ||
      id === 'muscle' ||
      id === 'truck' ||
      id === 'van' ||
      id === 'pickup' ||
      id === 'suv' ||
      id === 'bus' ||
      id === 'motorcycle' ||
      id === 'scooter' ||
      id === 'bicycle' ||
      id === 'delivery' ||
      id === 'construction'
    );
  }

  /** Clamp an untyped JSON number into an integer range (default `min`). */
  private clampInt(value: Json | undefined, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return min;
    return Math.max(min, Math.min(max, Math.floor(value)));
  }

  /** Magazine rounds for a weapon id, or {@link UNLIMITED_AMMO} for melee. */
  private magFor(id: WeaponId): number {
    if (WEAPONS[id].isMelee) return UNLIMITED_AMMO;
    return this.ammoByWeapon.get(id)?.mag ?? 0;
  }

  /**
   * Advance the selection through the owned weapons in canonical order.
   * @param direction +1 for next, -1 for previous.
   */
  private cycle(direction: number): void {
    const owned = this.ownedWeapons;
    if (owned.length <= 1) return;
    const currentIndex = owned.indexOf(this.selectedWeapon);
    const base = currentIndex === -1 ? 0 : currentIndex;
    const nextIndex = (base + direction + owned.length) % owned.length;
    const next = owned[nextIndex];
    if (next === undefined || next === this.selectedWeapon) return;
    this.selectedWeapon = next;
    this.emitSwitched();
  }

  /** Emit weapon-switch + ammo events for the current weapon. */
  private emitSwitched(): void {
    const index = WEAPON_ORDER.indexOf(this.selectedWeapon);
    eventBus.emit(EventKeys.WeaponSwitched, { weaponId: this.selectedWeapon, index });
    this.emitAmmoChanged(this.selectedWeapon);
  }

  /**
   * Emit an ammo-changed event for a weapon.
   * @param id weapon whose ammo changed.
   */
  private emitAmmoChanged(id: WeaponId): void {
    eventBus.emit(EventKeys.WeaponAmmoChanged, {
      weaponId: id,
      ammo: this.magFor(id),
      reserve: this.ammoByWeapon.get(id)?.reserve ?? 0,
    });
  }
}
