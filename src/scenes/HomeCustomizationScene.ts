import Phaser from 'phaser';
import { SceneKeys } from '@/config/SceneKeys';
import { COLORS, GAME_HEIGHT, GAME_WIDTH } from '@/config/Constants';
import { Button, Label, Panel } from '@/ui/components';
import { ServiceKeys } from '@/config/ServiceKeys';
import { ServiceLocator } from '@/core/ServiceLocator';
import type { HomeCustomizationSystem } from '@/systems/HomeCustomizationSystem';
import { FURNITURE_ITEMS } from '@/systems/HomeCustomizationSystem';

interface HomeCustomizationData {
  propertyId: string;
}

/** Constrained slot-based customization UI; Apply/Cancel are adapter operations. */
export class HomeCustomizationScene extends Phaser.Scene {
  private propertyId = '';
  private system: HomeCustomizationSystem | null = null;
  private pending: import('@/gameplay/types/HousingPhase2Types').FurniturePlacement[] = [];
  private status: Label | null = null;

  constructor() {
    super({ key: SceneKeys.HomeCustomization });
  }

  public create(data?: HomeCustomizationData): void {
    this.propertyId = data?.propertyId ?? '';
    this.system = ServiceLocator.tryResolve<HomeCustomizationSystem>(ServiceKeys.HomeCustomization);
    this.pending =
      this.system
        ?.beginPreview(this.propertyId)
        .placements.map((placement) => ({ ...placement })) ?? [];
    this.add
      .rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, 0x000000, 0.8)
      .setInteractive();
    new Panel(this, GAME_WIDTH / 2, GAME_HEIGHT / 2, 900, 560, {
      fill: COLORS.UI_PANEL,
      alpha: 0.98,
    });
    new Label(this, 70, 50, 'HOME CUSTOMIZATION', {
      fontSize: '24px',
      fontStyle: 'bold',
      color: '#f4f4f8',
    });
    new Label(
      this,
      70,
      90,
      'Select a valid furniture slot. Invalid or colliding placements are rejected.',
      { fontSize: '14px', color: '#b7c0d0' },
    );
    this.status = new Label(this, 90, 470, '', { fontSize: '14px', color: '#f0c674' });
    this.status.setVisible(false);
    const slots = this.system?.getSlots(this.propertyId) ?? [];
    slots.forEach((slot, index) => {
      const y = 140 + index * 52;
      new Label(this, 90, y, `${slot.id} · ${slot.allowedCategories.join('/')}`, {
        fontSize: '14px',
        color: '#e7eaf2',
      });
      const item = FURNITURE_ITEMS.find((candidate) =>
        slot.allowedCategories.includes(candidate.category),
      );
      const existing = this.pending.find((placement) => placement.slotId === slot.id);
      const setButton = new Button(this, 640, y + 8, {
        text: existing ? `Set ${item?.category ?? 'item'}` : `Add ${item?.category ?? 'item'}`,
        width: 150,
        height: 30,
        onClick: () => {
          if (!item) return;
          this.pending = [
            ...this.pending.filter((placement) => placement.slotId !== slot.id),
            {
              slotId: slot.id,
              itemId: item.id,
              variantId: item.variants[0] ?? 'default',
              rotation: 0,
            },
          ];
          this.status?.setText(`${item.category} staged for ${slot.id}`).setVisible(true);
        },
      });
      setButton.setEnabled(item !== undefined);
      new Button(this, 805, y + 8, {
        text: 'Clear',
        width: 90,
        height: 30,
        onClick: () => {
          this.pending = this.pending.filter((placement) => placement.slotId !== slot.id);
          this.status?.setText(`${slot.id} cleared`).setVisible(true);
        },
      });
    });
    new Button(this, 650, 470, {
      text: 'Apply',
      width: 120,
      onClick: () => {
        const result = this.system?.applyPreview(this.propertyId, this.pending);
        if (!result?.success) {
          this.status?.setText(`Apply rejected: ${result?.reason ?? 'unknown'}`).setVisible(true);
          return;
        }
        this.scene.stop();
      },
    });
    new Button(this, 790, 470, {
      text: 'Cancel',
      width: 120,
      onClick: () => {
        this.system?.cancelPreview(this.propertyId);
        this.scene.stop();
      },
    });
    this.events.once(
      Phaser.Scenes.Events.SHUTDOWN,
      () => {
        this.system = null;
        this.pending = [];
        this.status = null;
      },
      this,
    );
    this.input.keyboard?.once('keydown-ESC', () => {
      this.system?.cancelPreview(this.propertyId);
      this.scene.stop();
    });
  }
}
