import Phaser from 'phaser';
import { SceneKeys } from '@/config/SceneKeys';
import { COLORS, GAME_HEIGHT, GAME_WIDTH } from '@/config/Constants';
import { Button, Label, Panel } from '@/ui/components';
import { ServiceKeys } from '@/config/ServiceKeys';
import { ServiceLocator } from '@/core/ServiceLocator';
import { EventKeys } from '@/config/EventKeys';
import { eventBus } from '@/core/EventBus';
import type { HousingSystem } from '@/systems/HousingSystem';
import type { HousingProgressionSystem } from '@/systems/HousingProgressionSystem';
import type { GarageHousingAdapter } from '@/systems/GarageHousingAdapter';
import type { SafehouseAdapter } from '@/systems/SafehouseAdapter';

interface HomeManagementData {
  propertyId: string;
}

/** Stateless owned-home management modal. All mutations route to adapters. */
export class HomeManagementScene extends Phaser.Scene {
  private propertyId = '';
  private readonly unsubs: Array<() => void> = [];
  private readonly content: Phaser.GameObjects.GameObject[] = [];
  private status: Label | null = null;

  constructor() {
    super({ key: SceneKeys.HomeManagement });
  }

  public create(data?: HomeManagementData): void {
    this.propertyId = data?.propertyId ?? '';
    this.input.setDefaultCursor('default');
    this.add
      .rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, 0x000000, 0.78)
      .setInteractive();
    new Panel(this, GAME_WIDTH / 2, GAME_HEIGHT / 2, 980, 620, {
      fill: COLORS.UI_PANEL,
      alpha: 0.98,
    });
    this.status = new Label(this, 70, 584, '', { fontSize: '15px', color: '#53d769' });
    new Button(this, GAME_WIDTH - 120, 36, {
      text: 'Back',
      width: 130,
      onClick: () => this.close(),
    });
    this.unsubs.push(
      eventBus.on(EventKeys.PropertyUpgradeChanged, () => this.render()),
      eventBus.on(EventKeys.MoneyChanged, () => this.render()),
      eventBus.on(EventKeys.GarageOperationCompleted, () => this.render()),
    );
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.onShutdown, this);
    this.input.keyboard?.once('keydown-ESC', () => this.close());
    this.render();
  }

  private render(): void {
    for (const object of this.content) object.destroy();
    this.content.length = 0;
    const housing = ServiceLocator.tryResolve<HousingSystem>(ServiceKeys.Housing);
    const progression = ServiceLocator.tryResolve<HousingProgressionSystem>(
      ServiceKeys.HousingProgression,
    );
    const property = housing?.getProperty(this.propertyId);
    if (!housing || !progression || !property) return;
    const header = new Label(this, 70, 48, `HOME MANAGEMENT · ${property.displayName}`, {
      fontSize: '24px',
      fontStyle: 'bold',
      color: '#f4f4f8',
    });
    const summary = new Label(
      this,
      70,
      84,
      `Tier: ${progression.getPropertyTier(property.id)} · ${property.cityId} · ${property.districtId}\n${progression.getEffectivePropertyFeatures(property.id).join(' · ')}`,
      { fontSize: '14px', color: '#b7c0d0' },
    );
    this.content.push(header, summary);
    const active = housing.getActiveHome()?.id === property.id;
    const activeButton = new Button(this, 690, 110, {
      text: active ? 'Active Home' : 'Set Active',
      width: 170,
      height: 30,
      onClick: () => {
        if (housing.setActiveHome(property.id)) this.render();
      },
    });
    activeButton.setEnabled(!active);
    this.content.push(activeButton);
    progression.getUpgradeDefinitions(property.id).forEach((definition, index) => {
      const purchased = progression.isUpgradePurchased(property.id, definition.id);
      const canBuy = progression.canPurchaseUpgrade(property.id, definition.id);
      const y = 150 + index * 36;
      const label = new Label(
        this,
        90,
        y,
        `${definition.category} ${definition.level}  $${definition.price}${purchased ? '  ✓' : ''}`,
        { fontSize: '14px', color: purchased ? '#53d769' : '#e7eaf2', fixedWidth: 430 },
      );
      this.content.push(label);
      const button = new Button(this, 520, y + 10, {
        text: purchased ? 'Owned' : canBuy ? 'Upgrade' : 'Locked',
        width: 120,
        height: 28,
        onClick: () => {
          const result = progression.purchaseUpgrade(property.id, definition.id);
          this.status?.setText(
            result.success ? 'Upgrade applied.' : `Upgrade unavailable: ${result.reason}`,
          );
          this.render();
        },
      });
      button.setEnabled(!purchased && canBuy);
      this.content.push(button);
    });
    const customization = new Button(this, 690, 180, {
      text: 'Customize',
      width: 170,
      height: 34,
      onClick: () => {
        if (this.scene.isActive(SceneKeys.HomeCustomization)) return;
        this.scene.launch(SceneKeys.HomeCustomization, { propertyId: property.id });
        this.scene.bringToTop(SceneKeys.HomeCustomization);
      },
    });
    const garage = new Button(this, 690, 230, {
      text: 'Garage',
      width: 170,
      height: 34,
      onClick: () => {
        if (this.scene.isActive(SceneKeys.Garage)) return;
        this.scene.launch(SceneKeys.Garage, { propertyId: property.id });
        this.scene.bringToTop(SceneKeys.Garage);
      },
    });
    this.content.push(customization, garage);
    const safehouse = ServiceLocator.tryResolve<SafehouseAdapter>(ServiceKeys.Safehouse);
    const decision = safehouse?.canUseSafehouse(property.id);
    const safehouseButton = new Button(this, 690, 280, {
      text: 'Use Safehouse',
      width: 170,
      height: 34,
      onClick: () => {
        const result = safehouse?.useSafehouse(property.id);
        this.status?.setText(
          result?.success
            ? 'Safehouse rest started.'
            : `Safehouse unavailable: ${result?.reason ?? 'unknown'}`,
        );
      },
    });
    safehouseButton.setEnabled(decision?.allowed === true);
    this.content.push(safehouseButton);
    const garageAdapter = ServiceLocator.tryResolve<GarageHousingAdapter>(
      ServiceKeys.GarageHousing,
    );
    const slots = garageAdapter?.getGarageSlots(property.id) ?? [];
    const garageSummary = new Label(
      this,
      690,
      350,
      `Garage ${slots.filter((slot) => slot.vehicleId !== null).length}/${slots.length}\nActive: ${garageAdapter?.activeVehicle(property.id) ?? 'none'}`,
      { fontSize: '14px', color: '#b7c0d0' },
    );
    this.content.push(garageSummary);
  }

  private close(): void {
    this.scene.stop();
  }

  private onShutdown(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;
    this.content.length = 0;
    this.status = null;
  }
}
