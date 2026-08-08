/**
 * InventoryScene - paused, game-facing inventory overlay.
 *
 * The scene renders the player's full backpack grid, equipment slots, wallet,
 * quick weapon strip and item detail panel. It owns no gameplay state; every
 * move, equip, use and purchase-visible value flows through InventoryComponent.
 */
import Phaser from 'phaser';
import { SceneKeys } from '@/config/SceneKeys';
import { ServiceLocator } from '@/core/ServiceLocator';
import { ServiceKeys } from '@/config/ServiceKeys';
import { COLORS, GAME_HEIGHT, GAME_WIDTH, PLAYER } from '@/config/Constants';
import { t } from '@/config/Strings';
import { EventKeys } from '@/config/EventKeys';
import { eventBus } from '@/core/EventBus';
import { Button, Label, Panel } from '@/ui/components';
import { WEAPONS, getItemDef, weaponItemId } from '@/data';
import type {
  InventoryEquipmentSlot,
  InventoryItemId,
  InventorySlotState,
  WeaponId,
} from '@/gameplay/types';
import type { Player } from '@/entities/Player';
import type { InventoryComponent } from '@/entities/components/InventoryComponent';
import type { PlayerController } from '@/systems/PlayerController';
import type { GameManager } from '@/managers/GameManager';

/** Scene launch data. */
interface InventorySceneData {
  resumeOnClose?: boolean;
}

interface SlotHitArea {
  index: number;
  rect: Phaser.Geom.Rectangle;
}

interface DragState {
  fromIndex: number;
  view: Phaser.GameObjects.Container;
}

const PANEL_W = 1120;
const PANEL_H = 620;
const PANEL_X = (GAME_WIDTH - PANEL_W) / 2;
const PANEL_Y = (GAME_HEIGHT - PANEL_H) / 2;
const SCRIM_ALPHA = 0.68;

const SLOT_SIZE = 64;
const SLOT_GAP = 10;
const BAG_COLS = 6;
const BAG_ROWS = 4;
const BAG_X = PANEL_X + 56;
const BAG_Y = PANEL_Y + 166;

const EQUIP_X = PANEL_X + 56;
const EQUIP_Y = PANEL_Y + 86;
const EQUIP_W = 94;
const EQUIP_H = 58;
const EQUIP_GAP = 12;

const DETAIL_X = PANEL_X + 642;
const DETAIL_Y = PANEL_Y + 92;
const DETAIL_W = 410;
const DETAIL_H = 408;

const WEAPON_STRIP_X = PANEL_X + 56;
const WEAPON_STRIP_Y = PANEL_Y + 478;
const WEAPON_TILE = 52;
const WEAPON_GAP = 8;

const UNLIMITED_AMMO = -1;
const EQUIP_ORDER: readonly InventoryEquipmentSlot[] = [
  'weapon',
  'armor',
  'quick',
  'key',
  'mission',
];

const EQUIP_LABELS: Readonly<Record<InventoryEquipmentSlot, string>> = {
  weapon: 'WEAPON',
  armor: 'ARMOR',
  quick: 'QUICK',
  key: 'KEY',
  mission: 'MISSION',
};

/** Pixel-friendly overlay inventory. */
export class InventoryScene extends Phaser.Scene {
  private inventory: InventoryComponent | null = null;
  private player: Player | null = null;
  private resumeOnClose = false;
  private selectedIndex = 0;
  private contentRoot: Phaser.GameObjects.Container | null = null;

  private readonly dynamicObjects: Phaser.GameObjects.GameObject[] = [];
  private readonly slotHitAreas: SlotHitArea[] = [];
  private dragState: DragState | null = null;
  private suppressClickUntil = 0;

  constructor() {
    super({ key: SceneKeys.Inventory });
  }

  /** Build the inventory overlay. */
  public create(data?: InventorySceneData): void {
    this.resumeOnClose = data?.resumeOnClose === true;
    this.resolvePlayer();
    this.enableMenuCursor();

    this.contentRoot = this.add.container(0, 0).setAlpha(0);

    this.addStatic(
      this.add
      .rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, 0x03050a, SCRIM_ALPHA)
        .setInteractive(),
    );

    this.addStatic(
      new Panel(this, GAME_WIDTH / 2, GAME_HEIGHT / 2, PANEL_W, PANEL_H, {
        fill: 0x11131d,
        border: COLORS.UI_BORDER,
        alpha: 0.98,
      }),
    );
    this.addStatic(this.drawChrome());

    this.tweens.add({
      targets: this.contentRoot,
      alpha: 1,
      duration: 170,
      ease: 'Quad.easeOut',
    });

    this.addStatic(
      new Label(this, PANEL_X + 28, PANEL_Y + 24, t('inventory').toUpperCase(), {
      fontSize: '30px',
      fontStyle: 'bold',
      color: this.hex(COLORS.ACCENT),
      }),
    );

    this.addStatic(new Button(this, PANEL_X + PANEL_W - 76, PANEL_Y + 36, {
      text: 'Close',
      width: 104,
      height: 34,
      onClick: (): void => this.close(),
    }));

    this.addStatic(new Button(this, DETAIL_X + 92, DETAIL_Y + DETAIL_H + 58, {
      text: 'Use / Equip',
      width: 168,
      height: 40,
      onClick: (): void => this.useSelected(),
    }));

    this.refresh();
    this.bindInput();

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.onShutdown, this);
  }

  /** Draw non-changing panel dividers. */
  private drawChrome(): Phaser.GameObjects.Graphics {
    const g = this.add.graphics();
    g.lineStyle(2, COLORS.UI_BORDER, 1);
    g.strokeRect(BAG_X - 18, EQUIP_Y - 22, 514, 388);
    g.strokeRect(WEAPON_STRIP_X - 18, WEAPON_STRIP_Y - 42, 514, 106);
    g.strokeRect(DETAIL_X - 18, DETAIL_Y - 22, DETAIL_W, DETAIL_H + 106);
    g.lineStyle(1, 0xffffff, 0.08);
    g.lineBetween(PANEL_X + 582, PANEL_Y + 76, PANEL_X + 582, PANEL_Y + PANEL_H - 52);
    return g;
  }

  /** Rebuild dynamic item, equipment, weapon and details widgets. */
  private refresh(): void {
    for (const obj of this.dynamicObjects) obj.destroy();
    this.dynamicObjects.length = 0;
    this.slotHitAreas.length = 0;

    const inv = this.inventory;
    if (!inv) {
      this.renderUnavailable();
      return;
    }

    this.ensureSelection();
    this.renderWallet(inv);
    this.renderEquipment(inv);
    this.renderBag(inv);
    this.renderWeaponStrip(inv);
    this.renderDetails(inv);
  }

  /** Money and garage summary. */
  private renderWallet(inv: InventoryComponent): void {
    this.track(
      new Label(this, DETAIL_X + DETAIL_W - 24, PANEL_Y + 28, `$${inv.money}`, {
        fontSize: '24px',
        fontStyle: 'bold',
        color: this.hex(COLORS.MONEY),
        align: 'right',
        fixedWidth: 220,
      }),
    );
    this.track(
      this.add.text(DETAIL_X, PANEL_Y + 60, `${inv.ownedVehicles.length} garage vehicles`, {
        fontFamily: 'Courier New',
        fontSize: '14px',
        color: this.hex(0x9aa0a6),
      }),
    );
  }

  /** Equipment slots displayed above the bag. */
  private renderEquipment(inv: InventoryComponent): void {
    this.track(this.sectionLabel('EQUIPMENT', EQUIP_X, EQUIP_Y - 30));
    const equipment = inv.equipment;
    EQUIP_ORDER.forEach((slot, i) => {
      const x = EQUIP_X + i * (EQUIP_W + EQUIP_GAP);
      const y = EQUIP_Y;
      const itemId = equipment[slot] ?? null;
      const container = this.slotContainer(x, y, EQUIP_W, EQUIP_H, false);
      const frame = this.slotFrame(EQUIP_W, EQUIP_H, itemId !== null, COLORS.UI_BORDER);
      container.add(frame);
      const label = this.add.text(0, -EQUIP_H / 2 + 5, EQUIP_LABELS[slot], {
        fontFamily: 'Courier New',
        fontSize: '10px',
        color: this.hex(0x9aa0a6),
      });
      label.setOrigin(0.5, 0);
      container.add(label);
      if (itemId) {
        const def = getItemDef(itemId);
        const icon = this.add.image(0, 10, def.iconKey).setDisplaySize(28, 28);
        container.add(icon);
      }
      this.track(container);
    });
  }

  /** 24-slot backpack grid. */
  private renderBag(inv: InventoryComponent): void {
    this.track(this.sectionLabel('BAG', BAG_X, BAG_Y - 30));
    const slots = inv.bagSlots;
    for (let i = 0; i < BAG_ROWS * BAG_COLS; i += 1) {
      const col = i % BAG_COLS;
      const row = Math.floor(i / BAG_COLS);
      const x = BAG_X + col * (SLOT_SIZE + SLOT_GAP);
      const y = BAG_Y + row * (SLOT_SIZE + SLOT_GAP);
      const slot = slots[i] ?? null;
      const selected = i === this.selectedIndex;
      this.renderBagSlot(i, x, y, slot, selected);
    }
  }

  /** One backpack slot. */
  private renderBagSlot(
    index: number,
    x: number,
    y: number,
    slot: InventorySlotState | null,
    selected: boolean,
  ): void {
    const container = this.slotContainer(x, y, SLOT_SIZE, SLOT_SIZE, true);
    container.setData('slotIndex', index);
    container.add(this.slotFrame(SLOT_SIZE, SLOT_SIZE, slot !== null, selected ? COLORS.ACCENT : COLORS.UI_BORDER));
    if (slot) {
      const def = getItemDef(slot.itemId);
      const icon = this.add.image(0, -3, def.iconKey).setDisplaySize(34, 34);
      container.add(icon);
      if (slot.quantity > 1) {
        const qty = this.add.text(SLOT_SIZE / 2 - 7, SLOT_SIZE / 2 - 17, String(slot.quantity), {
          fontFamily: 'Courier New',
          fontSize: '13px',
          fontStyle: 'bold',
          color: '#ffffff',
          stroke: '#000000',
          strokeThickness: 3,
        });
        qty.setOrigin(1, 0);
        container.add(qty);
      }
    }

    container.on('pointerdown', () => {
      this.selectedIndex = index;
    });
    container.on('pointerup', () => {
      if (this.time.now < this.suppressClickUntil) return;
      this.selectSlot(index);
    });
    this.input.setDraggable(container);
    this.track(container);
    this.slotHitAreas.push({
      index,
      rect: new Phaser.Geom.Rectangle(x - SLOT_SIZE / 2, y - SLOT_SIZE / 2, SLOT_SIZE, SLOT_SIZE),
    });
  }

  /** Bottom quick weapon selector. */
  private renderWeaponStrip(inv: InventoryComponent): void {
    this.track(this.sectionLabel('QUICK WEAPONS', WEAPON_STRIP_X, WEAPON_STRIP_Y - 34));
    inv.ownedWeapons.forEach((id, i) => {
      const x = WEAPON_STRIP_X + i * (WEAPON_TILE + WEAPON_GAP);
      const selected = id === inv.currentWeaponId;
      const container = this.slotContainer(x, WEAPON_STRIP_Y, WEAPON_TILE, WEAPON_TILE, true);
      container.add(this.slotFrame(WEAPON_TILE, WEAPON_TILE, true, selected ? COLORS.ACCENT : COLORS.UI_BORDER));
      container.add(this.add.image(0, -3, WEAPONS[id].iconKey).setDisplaySize(28, 28));
      const ammo = this.weaponAmmo(inv, id);
      if (ammo !== '') {
        const label = this.add.text(0, 17, ammo, {
          fontFamily: 'Courier New',
          fontSize: '9px',
          color: this.hex(selected ? COLORS.ACCENT : 0xd8dde7),
        });
        label.setOrigin(0.5, 0);
        container.add(label);
      }
      container.on('pointerdown', () => this.switchWeapon(id));
      this.track(container);
    });
  }

  /** Item detail panel. */
  private renderDetails(inv: InventoryComponent): void {
    this.track(this.sectionLabel('ITEM DETAILS', DETAIL_X, DETAIL_Y - 30));
    const slot = inv.slotAt(this.selectedIndex);
    if (!slot) {
      this.track(
        new Label(this, DETAIL_X, DETAIL_Y + 56, 'Empty slot', {
          fontSize: '20px',
          color: this.hex(0x9aa0a6),
        }),
      );
      this.renderStats(inv, null);
      return;
    }

    const def = getItemDef(slot.itemId);
    this.track(this.add.image(DETAIL_X + 36, DETAIL_Y + 36, def.iconKey).setDisplaySize(46, 46));
    this.track(
      new Label(this, DETAIL_X + 78, DETAIL_Y + 8, def.name, {
        fontSize: '22px',
        fontStyle: 'bold',
        color: this.hex(COLORS.TEXT),
        wordWrap: { width: DETAIL_W - 112 },
      }),
    );
    this.track(
      new Label(this, DETAIL_X + 78, DETAIL_Y + 38, `${def.category.toUpperCase()} x${slot.quantity}`, {
        fontSize: '14px',
        color: this.hex(COLORS.ACCENT),
      }),
    );
    this.track(
      new Label(this, DETAIL_X, DETAIL_Y + 98, def.description, {
        fontSize: '16px',
        color: this.hex(0xd8dde7),
        wordWrap: { width: DETAIL_W - 44 },
        lineSpacing: 4,
      }),
    );

    let y = DETAIL_Y + 182;
    y = this.renderItemStats(def.id, y);
    this.renderStats(inv, y);
  }

  /** Stat lines specific to the selected item. */
  private renderItemStats(itemId: InventoryItemId, startY: number): number {
    const def = getItemDef(itemId);
    let y = startY;
    const line = (label: string, value: string): void => {
      this.track(
        new Label(this, DETAIL_X, y, label, {
          fontSize: '14px',
          color: this.hex(0x9aa0a6),
          fixedWidth: 140,
        }),
      );
      this.track(
        new Label(this, DETAIL_X + 148, y, value, {
          fontSize: '14px',
          color: this.hex(COLORS.TEXT),
        }),
      );
      y += 24;
    };

    if (def.weaponId) {
      const weapon = WEAPONS[def.weaponId];
      line('Damage', String(weapon.damage));
      line('Fire rate', `${weapon.fireRateMs} ms`);
      line('Accuracy', `${Math.max(0, 100 - weapon.spreadDeg * 5)}%`);
      line('Magazine', weapon.isMelee ? 'Unlimited' : String(weapon.magazine));
    }
    if (def.healAmount) line('Restores HP', `+${def.healAmount}`);
    if (def.armorAmount) line('Armor', `+${def.armorAmount}`);
    if (def.ammoAmount) line('Ammo bundle', `+${def.ammoAmount}`);
    if (def.cashValue) line('Cash value', `$${def.cashValue}`);
    return y + 8;
  }

  /** Player stats in the detail panel footer. */
  private renderStats(inv: InventoryComponent, startY: number | null): void {
    const player = this.player;
    const y = startY ?? DETAIL_Y + 170;
    const health = player ? `${Math.round(player.healthComp.health)} / ${player.healthComp.maxHealth}` : '-';
    const armor = player ? `${Math.round(player.armor)} / ${PLAYER.MAX_ARMOR}` : '-';
    const current = inv.currentWeapon;
    this.track(
      new Label(this, DETAIL_X, y, `HP  ${health}`, {
        fontSize: '15px',
        color: this.hex(COLORS.HEALTH),
      }),
    );
    this.track(
      new Label(this, DETAIL_X, y + 24, `AR  ${armor}`, {
        fontSize: '15px',
        color: this.hex(0x3a6cff),
      }),
    );
    this.track(
      new Label(this, DETAIL_X, y + 48, `Equipped  ${current.name}`, {
        fontSize: '15px',
        color: this.hex(COLORS.ACCENT),
      }),
    );
    this.track(
      new Label(this, DETAIL_X, y + 88, 'Drag slots to reorder. Click weapon icons to switch.', {
        fontSize: '13px',
        color: this.hex(0x9aa0a6),
        wordWrap: { width: DETAIL_W - 40 },
      }),
    );
  }

  /** Message shown when no player exists yet. */
  private renderUnavailable(): void {
    this.track(
      new Label(this, PANEL_X + 56, PANEL_Y + 116, 'Inventory unavailable before player spawn.', {
        fontSize: '18px',
        color: this.hex(0x9aa0a6),
      }),
    );
  }

  /** Build an interactive slot container centered at x/y. */
  private slotContainer(
    x: number,
    y: number,
    width: number,
    height: number,
    interactive: boolean,
  ): Phaser.GameObjects.Container {
    const c = this.add.container(x, y);
    if (interactive) {
      c.setSize(width, height);
      c.setInteractive(
        new Phaser.Geom.Rectangle(-width / 2, -height / 2, width, height),
        Phaser.Geom.Rectangle.Contains,
      );
    }
    return c;
  }

  /** Draw a pixel slot frame. */
  private slotFrame(
    width: number,
    height: number,
    filled: boolean,
    border: number,
  ): Phaser.GameObjects.Graphics {
    const g = this.add.graphics();
    const fill = filled ? 0x1b2030 : 0x0c0f18;
    g.fillStyle(fill, 0.96);
    g.fillRect(-width / 2, -height / 2, width, height);
    g.lineStyle(2, border, 1);
    g.strokeRect(-width / 2, -height / 2, width, height);
    g.lineStyle(1, 0xffffff, 0.1);
    g.strokeRect(-width / 2 + 4, -height / 2 + 4, width - 8, height - 8);
    return g;
  }

  /** Section heading helper. */
  private sectionLabel(text: string, x: number, y: number): Label {
    return new Label(this, x, y, text, {
      fontSize: '15px',
      fontStyle: 'bold',
      color: this.hex(COLORS.ACCENT),
    });
  }

  /** Select a bag slot and refresh details/highlight. */
  private selectSlot(index: number): void {
    this.selectedIndex = Phaser.Math.Clamp(index, 0, BAG_ROWS * BAG_COLS - 1);
    this.refresh();
  }

  /** Use/equip the selected slot. */
  private useSelected(): void {
    const inv = this.inventory;
    const player = this.player;
    if (!inv || !player) return;

    const slot = inv.slotAt(this.selectedIndex);
    if (!slot) {
      this.toast('Select an item first');
      return;
    }

    const def = getItemDef(slot.itemId);
    if ((def.category === 'consumable' || def.category === 'food') && def.healAmount) {
      if (player.healthComp.health >= player.healthComp.maxHealth) {
        this.toast('Health is already full');
        return;
      }
    }
    if (def.category === 'armor' && player.armor >= PLAYER.MAX_ARMOR) {
      this.toast('Armor is already full');
      return;
    }
    if (def.category === 'ammo' && def.ammoWeaponId && !inv.hasWeapon(def.ammoWeaponId)) {
      this.toast('No matching weapon owned');
      return;
    }

    const result = inv.useSlot(this.selectedIndex);
    if (!result) return;

    if (result.healAmount) {
      player.giveHealth(result.healAmount);
    }
    if (result.armorAmount) {
      player.giveArmor(result.armorAmount);
    }
    if (result.equippedWeapon) {
      player.refreshEquippedWeapon();
    }

    this.toast(result.message);
    this.refresh();
  }

  /** Switch currently equipped weapon from the quick strip. */
  private switchWeapon(id: WeaponId): void {
    const inv = this.inventory;
    if (!inv) return;
    inv.switchTo(id);
    this.player?.refreshEquippedWeapon();
    const weaponItem = weaponItemId(id);
    const index = inv.bagSlots.findIndex((slot) => slot?.itemId === weaponItem);
    if (index >= 0) {
      this.selectedIndex = index;
    }
    this.refresh();
  }

  /** Keyboard and drag/drop listeners. */
  private bindInput(): void {
    this.input.keyboard?.once('keydown-ESC', () => this.close());
    this.input.keyboard?.once('keydown-I', () => this.close());
    this.input.keyboard?.on('keydown-ENTER', this.useSelected, this);
    this.input.keyboard?.on('keydown-SPACE', this.useSelected, this);
    this.input.on(Phaser.Input.Events.DRAG_START, this.onDragStart, this);
    this.input.on(Phaser.Input.Events.DRAG, this.onDrag, this);
    this.input.on(Phaser.Input.Events.DRAG_END, this.onDragEnd, this);
  }

  /** Start dragging a bag slot. */
  private onDragStart(
    _pointer: Phaser.Input.Pointer,
    gameObject: Phaser.GameObjects.GameObject,
  ): void {
    const index = gameObject.getData('slotIndex');
    if (typeof index !== 'number') return;
    const slot = this.inventory?.slotAt(index);
    if (!slot) return;
    this.selectedIndex = index;
    const view = gameObject as Phaser.GameObjects.Container;
    view.setDepth(200);
    view.setAlpha(0.8);
    this.dragState = { fromIndex: index, view };
  }

  /** Move the visual slot while dragging. */
  private onDrag(
    pointer: Phaser.Input.Pointer,
    gameObject: Phaser.GameObjects.GameObject,
  ): void {
    if (!this.dragState) return;
    const view = gameObject as Phaser.GameObjects.Container;
    view.setPosition(pointer.x, pointer.y);
  }

  /** Drop a dragged slot onto another bag slot. */
  private onDragEnd(pointer: Phaser.Input.Pointer): void {
    const drag = this.dragState;
    this.dragState = null;
    if (!drag) return;
    const target = this.slotAtPoint(pointer.x, pointer.y);
    if (target !== null && target !== drag.fromIndex) {
      this.inventory?.moveSlot(drag.fromIndex, target);
      this.selectedIndex = target;
    }
    this.suppressClickUntil = this.time.now + 80;
    this.refresh();
  }

  /** Slot index under a screen point. */
  private slotAtPoint(x: number, y: number): number | null {
    for (const hit of this.slotHitAreas) {
      if (hit.rect.contains(x, y)) return hit.index;
    }
    return null;
  }

  /** Keep selection on a valid slot. */
  private ensureSelection(): void {
    if (this.selectedIndex >= 0 && this.selectedIndex < BAG_ROWS * BAG_COLS) return;
    this.selectedIndex = 0;
  }

  /** Ammo label for a quick weapon tile. */
  private weaponAmmo(inv: InventoryComponent, id: WeaponId): string {
    const mag = inv.magOf(id);
    if (mag === UNLIMITED_AMMO || WEAPONS[id].isMelee) return '';
    return `${mag}/${inv.reserveOf(id)}`;
  }

  /** Track an object so it can be destroyed on refresh. */
  private track<T extends Phaser.GameObjects.GameObject>(obj: T): T {
    this.dynamicObjects.push(obj);
    this.contentRoot?.add(obj);
    return obj;
  }

  /** Attach a static widget to the content root without refresh bookkeeping. */
  private addStatic<T extends Phaser.GameObjects.GameObject>(obj: T): T {
    this.contentRoot?.add(obj);
    return obj;
  }

  /** Resolve the active player and inventory. */
  private resolvePlayer(): void {
    const controller = ServiceLocator.tryResolve<PlayerController>(ServiceKeys.Player);
    this.player = controller?.player ?? null;
    this.inventory = this.player?.inventory ?? null;
  }

  /** Restore cursor behavior appropriate for menus. */
  private enableMenuCursor(): void {
    this.input.setDefaultCursor('default');
    this.input.mouse?.releasePointerLock();
    this.game.canvas.style.cursor = 'default';
  }

  /** Emit a HUD toast. */
  private toast(message: string): void {
    eventBus.emit(EventKeys.UIToast, { message });
  }

  /** Close the overlay. */
  private close(): void {
    if (this.resumeOnClose) {
      ServiceLocator.tryResolve<GameManager>(ServiceKeys.Game)?.resumeGame();
    }
    this.scene.stop();
  }

  /** Remove listeners. */
  private onShutdown(): void {
    this.contentRoot?.destroy();
    this.contentRoot = null;
    this.dynamicObjects.length = 0;
    this.slotHitAreas.length = 0;
    this.dragState = null;
    this.input.keyboard?.off('keydown-ENTER', this.useSelected, this);
    this.input.keyboard?.off('keydown-SPACE', this.useSelected, this);
    this.input.off(Phaser.Input.Events.DRAG_START, this.onDragStart, this);
    this.input.off(Phaser.Input.Events.DRAG, this.onDrag, this);
    this.input.off(Phaser.Input.Events.DRAG_END, this.onDragEnd, this);
  }

  /** Format a 0xRRGGBB colour for Phaser text. */
  private hex(color: number): string {
    return '#' + color.toString(16).padStart(6, '0');
  }
}
