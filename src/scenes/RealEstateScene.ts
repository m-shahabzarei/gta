import Phaser from 'phaser';
import { SceneKeys } from '@/config/SceneKeys';
import { EventKeys } from '@/config/EventKeys';
import { eventBus } from '@/core/EventBus';
import { ServiceKeys } from '@/config/ServiceKeys';
import { ServiceLocator } from '@/core/ServiceLocator';
import { COLORS, GAME_HEIGHT, GAME_WIDTH } from '@/config/Constants';
import { Button, Label, Panel } from '@/ui/components';
import { TextureKeys } from '@/config/AssetKeys';
import type { CityId, PropertyDefinition } from '@/gameplay/types';
import type { HousingSystem } from '@/systems/HousingSystem';
import type { PlayerController } from '@/systems/PlayerController';

interface RealEstateSceneData {
  cityId: CityId;
  officeId: string;
}

/** Stateless real-estate presentation overlay; HousingSystem owns all state. */
export class RealEstateScene extends Phaser.Scene {
  private cityId: CityId = 'tehran';
  private readonly unsubs: Array<() => void> = [];
  private readonly content: Phaser.GameObjects.GameObject[] = [];
  private status: Label | null = null;

  constructor() {
    super({ key: SceneKeys.RealEstate });
  }

  public create(data?: RealEstateSceneData): void {
    this.cityId = data?.cityId ?? 'tehran';
    this.input.setDefaultCursor('default');
    this.add
      .rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, 0x000000, 0.72)
      .setInteractive();
    new Panel(this, GAME_WIDTH / 2, GAME_HEIGHT / 2, 1160, 650, {
      fill: COLORS.UI_PANEL,
      alpha: 0.98,
    });
    new Label(this, 80, 34, `REAL ESTATE OFFICE · ${this.cityId.toUpperCase()}`, {
      fontSize: '28px',
      fontStyle: 'bold',
      color: `#${COLORS.ACCENT.toString(16).padStart(6, '0')}`,
    });
    new Label(
      this,
      80,
      70,
      'Speak with the agent to purchase a home. Visit previews never move you.',
      {
        fontSize: '14px',
        color: '#aeb6c7',
      },
    );
    // Office dressing is scene-local and static: the agent is visibly seated
    // behind a desk while the existing world NPC interaction opens this modal.
    this.add.rectangle(GAME_WIDTH - 220, 118, 300, 70, 0x4c3a2d, 1).setStrokeStyle(2, 0xc69a6b, 1);
    const agent = this.add.sprite(GAME_WIDTH - 220, 78, TextureKeys.CharPed);
    if (agent.texture.has('idle0')) agent.setFrame('idle0');
    agent.setScale(1.15);
    new Label(this, GAME_WIDTH - 330, 136, 'REAL-ESTATE AGENT', {
      fontSize: '12px',
      color: '#f4f4f8',
      fixedWidth: 220,
      align: 'center',
    });
    this.status = new Label(this, 80, 640, '', { fontSize: '16px', color: '#53d769' });
    this.status.setVisible(false);
    new Button(this, GAME_WIDTH - 130, 42, {
      text: 'Back',
      width: 150,
      onClick: () => this.close(),
    });
    this.unsubs.push(
      eventBus.on(EventKeys.PropertyOwnershipChanged, () => this.renderProperties()),
      eventBus.on(EventKeys.MoneyChanged, () => this.renderProperties()),
      eventBus.on(EventKeys.PropertyPreviewStarted, ({ propertyId }) =>
        this.showPreviewState(`Previewing ${propertyId}. Press Back to restore camera.`),
      ),
      eventBus.on(EventKeys.PropertyPreviewEnded, () =>
        this.showPreviewState('Preview ended; camera restored.'),
      ),
      eventBus.on(EventKeys.HomeEnterRejected, ({ reason }) =>
        this.showPreviewState(`Cannot enter home: ${reason}`),
      ),
    );
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.onShutdown, this);
    this.renderProperties();
    this.input.keyboard?.once('keydown-ESC', () => this.close());
  }

  private renderProperties(): void {
    for (const object of this.content) object.destroy();
    this.content.length = 0;
    const housing = ServiceLocator.tryResolve<HousingSystem>(ServiceKeys.Housing);
    if (!housing) return;
    const properties = housing.getPropertiesForCity(this.cityId);
    properties.forEach((property, index) => this.renderCard(housing, property, index));
  }

  private renderCard(housing: HousingSystem, property: PropertyDefinition, index: number): void {
    const x = 220 + (index % 2) * 510;
    const y = 145 + Math.floor(index / 2) * 220;
    const card = new Panel(this, x, y, 470, 185, {
      fill: 0x1d2230,
      border: property.valid ? COLORS.UI_BORDER : 0x7a3d4e,
      alpha: 1,
    });
    this.content.push(card);
    const owned = housing.isOwned(property.id);
    const money =
      ServiceLocator.tryResolve<PlayerController>(ServiceKeys.Player)?.player?.inventory.money ?? 0;
    const name = new Label(
      this,
      x - 210,
      y - 78,
      `${property.displayName}${owned ? '  ✓ OWNED' : ''}`,
      {
        fontSize: '18px',
        fontStyle: 'bold',
        color: owned ? '#53d769' : '#f4f4f8',
        fixedWidth: 430,
      },
    );
    this.content.push(name);
    const details = new Label(
      this,
      x - 210,
      y - 48,
      `${property.districtId} · $${property.price} · parking ${property.parkingCapacity}\n${property.features.join(' · ')}\nstyle: ${property.styleId}`,
      {
        fontSize: '13px',
        color: '#c6ccda',
        fixedWidth: 430,
        wordWrap: { width: 430 },
      },
    );
    this.content.push(details);
    const visit = new Button(this, x - 98, y + 65, {
      text: 'Visit',
      width: 140,
      height: 38,
      onClick: () => {
        eventBus.emit(EventKeys.PropertyPreviewRequested, { propertyId: property.id });
      },
    });
    this.content.push(visit);
    const buy = new Button(this, x + 88, y + 65, {
      text: owned
        ? 'Owned'
        : !property.valid
          ? 'Unavailable'
          : money < property.price
            ? 'Need funds'
            : 'Buy',
      width: 140,
      height: 38,
      onClick: () => this.buy(housing, property),
    });
    buy.setEnabled(!owned && property.valid && money >= property.price);
    this.content.push(buy);
    if (owned) {
      const manage = new Button(this, x + 142, y - 68, {
        text: 'Manage',
        width: 110,
        height: 28,
        onClick: () => {
          if (this.scene.isActive(SceneKeys.HomeManagement)) return;
          this.scene.launch(SceneKeys.HomeManagement, { propertyId: property.id });
          this.scene.bringToTop(SceneKeys.HomeManagement);
        },
      });
      this.content.push(manage);
    }
  }

  private buy(housing: HousingSystem, property: PropertyDefinition): void {
    const result = housing.purchaseProperty(property.id);
    this.showPreviewState(
      result.success ? `${property.displayName} purchased.` : `Purchase failed: ${result.reason}`,
    );
    this.renderProperties();
  }

  private showPreviewState(message: string): void {
    this.status?.setText(message).setVisible(true);
  }

  private close(): void {
    const housing = ServiceLocator.tryResolve<HousingSystem>(ServiceKeys.Housing);
    if (housing) housing.closeRealEstate();
    else this.scene.stop();
  }

  private onShutdown(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;
    this.content.length = 0;
    this.status = null;
  }
}
