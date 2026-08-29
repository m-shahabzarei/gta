import Phaser from 'phaser';
import { SceneKeys } from '@/config/SceneKeys';
import { COLORS, GAME_HEIGHT, GAME_WIDTH } from '@/config/Constants';
import { Button, Label, Panel } from '@/ui/components';
import { ServiceKeys } from '@/config/ServiceKeys';
import { ServiceLocator } from '@/core/ServiceLocator';
import type { GarageHousingAdapter } from '@/systems/GarageHousingAdapter';
import { EventKeys } from '@/config/EventKeys';
import { eventBus } from '@/core/EventBus';
import type { VehicleSystem } from '@/systems/VehicleSystem';

interface GarageData {
  propertyId: string;
}

/** Stateless garage view backed by GarageHousingAdapter. */
export class GarageScene extends Phaser.Scene {
  private propertyId = '';
  private readonly content: Phaser.GameObjects.GameObject[] = [];
  private readonly unsubs: Array<() => void> = [];
  private adapter: GarageHousingAdapter | null = null;
  constructor() {
    super({ key: SceneKeys.Garage });
  }

  public create(data?: GarageData): void {
    this.propertyId = data?.propertyId ?? '';
    this.adapter = ServiceLocator.tryResolve<GarageHousingAdapter>(ServiceKeys.GarageHousing);
    this.add
      .rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, 0x000000, 0.8)
      .setInteractive();
    new Panel(this, GAME_WIDTH / 2, GAME_HEIGHT / 2, 760, 480, {
      fill: COLORS.UI_PANEL,
      alpha: 0.98,
    });
    new Label(this, 90, 70, 'GARAGE', { fontSize: '24px', fontStyle: 'bold', color: '#f4f4f8' });
    this.unsubs.push(
      eventBus.on(EventKeys.GarageOperationCompleted, ({ propertyId }) => {
        if (propertyId === this.propertyId) this.render();
      }),
      eventBus.on(EventKeys.GarageOperationRejected, ({ propertyId }) => {
        if (propertyId === this.propertyId) this.render();
      }),
    );
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.onShutdown, this);
    this.render();
    new Button(this, GAME_WIDTH - 140, 60, {
      text: 'Back',
      width: 120,
      onClick: () => this.scene.stop(),
    });
    this.input.keyboard?.once('keydown-ESC', () => this.scene.stop());
  }

  private render(): void {
    for (const object of this.content) object.destroy();
    this.content.length = 0;
    const adapter = this.adapter;
    if (!adapter) return;
    const slots = adapter.getGarageSlots(this.propertyId);
    const active = adapter.activeVehicle(this.propertyId);
    slots.forEach((slot, index) => {
      const y = 140 + index * 46;
      const label = new Label(this, 120, y, `${slot.slotId} · ${slot.vehicleId ?? 'empty'}`, {
        fontSize: '15px',
        color: '#e7eaf2',
      });
      this.content.push(label);
      if (!slot.vehicleId) return;
      const remove = new Button(this, 635, y + 8, {
        text: 'Remove',
        width: 100,
        height: 28,
        onClick: () => {
          adapter.removeVehicle(this.propertyId, slot.vehicleId as string);
          this.render();
        },
      });
      const setActive = new Button(this, 750, y + 8, {
        text: active === slot.vehicleId ? 'Active' : 'Set Active',
        width: 130,
        height: 28,
        onClick: () => {
          adapter.setActiveVehicleFromGarage(this.propertyId, slot.vehicleId as string);
          this.render();
        },
      });
      setActive.setEnabled(active !== slot.vehicleId);
      this.content.push(remove, setActive);
    });
    const vehicleSystem = ServiceLocator.tryResolve<VehicleSystem>(ServiceKeys.Vehicle);
    const storedIds = new Set(
      slots.map((slot) => slot.vehicleId).filter((id): id is string => id !== null),
    );
    const candidates =
      vehicleSystem?.vehicles.filter(
        (vehicle) =>
          !storedIds.has(String(vehicle.id)) &&
          adapter.canStoreVehicle(this.propertyId, String(vehicle.id)),
      ) ?? [];
    const candidateTop = 180 + slots.length * 46;
    new Label(this, 120, candidateTop, 'Available live vehicles', {
      fontSize: '14px',
      color: '#b7c0d0',
    });
    this.content.push(
      ...candidates.flatMap((vehicle, index) => {
        const y = candidateTop + 32 + index * 38;
        const label = new Label(this, 120, y, `${vehicle.def.name} · #${vehicle.id}`, {
          fontSize: '14px',
          color: '#e7eaf2',
        });
        const store = new Button(this, 750, y + 8, {
          text: 'Store',
          width: 130,
          height: 28,
          onClick: () => {
            adapter.storeVehicle(this.propertyId, String(vehicle.id));
            this.render();
          },
        });
        return [label, store];
      }),
    );
    const summary = new Label(
      this,
      120,
      Math.min(GAME_HEIGHT - 70, candidateTop + 56 + candidates.length * 38),
      `Active vehicle: ${active ?? 'none'} · capacity ${slots.filter((slot) => slot.vehicleId !== null).length}/${slots.length}`,
      { fontSize: '15px', color: '#b7c0d0' },
    );
    this.content.push(summary);
  }

  private onShutdown(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;
    this.content.length = 0;
    this.adapter = null;
  }
}
