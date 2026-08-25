import Phaser from 'phaser';
import { COLORS } from '@/config/Constants';
import { EventKeys } from '@/config/EventKeys';
import { t } from '@/config/Strings';
import { eventBus } from '@/core/EventBus';
import { ServiceLocator } from '@/core/ServiceLocator';
import { ServiceKeys } from '@/config/ServiceKeys';
import type { PhoneAppContext } from '@/phone/PhoneTypes';
import type { CityId } from '@/gameplay/types';
import { TRANSIT_PIXELS_PER_KILOMETER } from '@/gameplay/transit';
import type { SnappTrackingSnapshot, TaxiDestination, TrafficRoutePreview } from '@/gameplay/transit';
import type { TransportationSystem } from '@/systems/TransportationSystem';
import type { TrafficSystem } from '@/systems/TrafficSystem';
import type { PlayerController } from '@/systems/PlayerController';
import type { WorldManager } from '@/systems/WorldManager';
import { UIComponent } from '@/ui/UIComponent';
import { Button, Label } from '@/ui/components';

type SnappViewState = 'home' | 'destination' | 'quote' | 'status';

const TURQUOISE = 0x13c8bc;
const SURFACE = 0x102a2e;
const TEXT = `#${COLORS.TEXT.toString(16).padStart(6, '0')}`;

/** Focused Snapp MVP UI; all gameplay mutations go through TransportationSystem. */
export class SnappPhoneView extends UIComponent {
  private readonly context: PhoneAppContext;
  private readonly transportation: TransportationSystem | null;
  private readonly player: PlayerController | null;
  private readonly world: WorldManager | null;
  private readonly traffic: TrafficSystem | null;
  private readonly content = this.uiScene.add.container();
  private readonly unsubs: Array<() => void> = [];
  private viewState: SnappViewState = 'home';
  private screenWidth = 240;
  private screenHeight = 400;
  private errorMessage: string | null = null;
  private paymentPending = false;
  private paymentTimer: Phaser.Time.TimerEvent | null = null;
  private trackingSnapshot: SnappTrackingSnapshot | null = null;
  private mapGraphics: Phaser.GameObjects.Graphics | null = null;
  private mapZone: Phaser.GameObjects.Zone | null = null;
  private mapViewportContainer: Phaser.GameObjects.Container | null = null;
  private mapWorldLayer: Phaser.GameObjects.Container | null = null;
  private mapOverlayLayer: Phaser.GameObjects.Container | null = null;
  private mapMaskShape: Phaser.GameObjects.Graphics | null = null;
  private mapMask: Phaser.Display.Masks.GeometryMask | null = null;
  private mapMode: 'destination' | 'status' | null = null;
  private mapInitialized = false;
  private mapRect = { x: 12, y: 90, width: 216, height: 190 };
  private mapCenter = { x: 0, y: 0 };
  private mapZoom = 1;
  private mapDragging = false;
  private mapMoved = false;
  private mapLastPointer = { x: 0, y: 0 };
  private selectedMapPoint: Phaser.Math.Vector2 | null = null;
  private readonly roadNodes = new Map<number, { x: number; y: number }>();
  private statusRemainingLabel: Label | null = null;
  private statusWaitLabel: Label | null = null;

  constructor(scene: Phaser.Scene, context: PhoneAppContext) {
    super(scene);
    this.context = context;
    this.transportation = ServiceLocator.tryResolve<TransportationSystem>(ServiceKeys.Transportation);
    this.player = ServiceLocator.tryResolve<PlayerController>(ServiceKeys.Player);
    this.world = ServiceLocator.tryResolve<WorldManager>(ServiceKeys.World);
    this.traffic = ServiceLocator.tryResolve<TrafficSystem>(ServiceKeys.Traffic);
    this.add(this.content);
    this.setData('accessibility-label', t('phoneSnapp'));
    const refresh = (): void => this.render();
    for (const key of [
      EventKeys.SnappDestinationSelected,
      EventKeys.SnappQuoteCreated,
      EventKeys.SnappPaymentCompleted,
      EventKeys.SnappPaymentFailed,
      EventKeys.SnappDriverAssigned,
      EventKeys.SnappDriverEnRoute,
      EventKeys.SnappDriverArrived,
      EventKeys.SnappBoardingStarted,
      EventKeys.SnappRideStarted,
      EventKeys.SnappRideArrived,
      EventKeys.SnappRideCompleted,
      EventKeys.SnappBookingCancelled,
      EventKeys.SnappBookingFailed,
      EventKeys.SnappRefundIssued,
      EventKeys.MoneyChanged,
    ] as const) {
      this.unsubs.push(eventBus.on(key, refresh));
    }
    this.unsubs.push(eventBus.on(EventKeys.SnappTrackingUpdated, (snapshot) => {
      this.trackingSnapshot = snapshot;
      if (this.viewState === 'status' && this.mapGraphics) {
        this.redrawMap();
        this.updateStatusOverlay(snapshot);
      }
      else this.render();
    }));
    this.render();
  }

  /** Called by PhoneShell on safe-area/orientation changes. */
  public layout(width: number, height: number): this {
    this.screenWidth = width;
    this.screenHeight = height;
    this.render();
    return this;
  }

  public override destroy(fromScene?: boolean): void {
    this.paymentTimer?.remove(false);
    this.paymentTimer = null;
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;
    this.disposeMapLayers();
    this.content.destroy(true);
    this.mapGraphics = null;
    this.mapZone = null;
    super.destroy(fromScene);
  }

  private render(): void {
    this.disposeMapLayers();
    this.content.removeAll(true);
    this.statusRemainingLabel = null;
    this.statusWaitLabel = null;
    const booking = this.transportation?.snappBooking ?? null;
    this.trackingSnapshot = this.transportation?.snappTracking ?? this.trackingSnapshot;
    if (booking?.state === 'DRIVER_EN_ROUTE' || booking?.state === 'DRIVER_ARRIVED' || booking?.state === 'PASSENGER_BOARDING' || booking?.state === 'RIDING' || booking?.state === 'ARRIVED') {
      this.viewState = 'status';
    } else if (booking?.state === 'QUOTE_READY' || booking?.state === 'PAYMENT_PENDING') {
      this.viewState = 'quote';
    } else if (booking?.state === 'SELECTING_DESTINATION') {
      this.viewState = 'destination';
    } else if (booking?.state === 'COMPLETED' || booking?.state === 'CANCELLED' || booking?.state === 'REFUNDED' || booking?.state === 'FAILED') {
      this.viewState = 'home';
    }
    switch (this.viewState) {
      case 'destination':
        this.renderDestination();
        break;
      case 'quote':
        this.renderQuote();
        break;
      case 'status':
        this.renderStatus();
        break;
      default:
        this.renderHome();
        break;
    }
  }

  /** Dispose the map hierarchy before a rerender, relayout, or app teardown. */
  private disposeMapLayers(): void {
    this.mapWorldLayer?.clearMask(false);
    this.mapMask?.destroy();
    this.mapMask = null;
    if (this.mapMaskShape) {
      this.mapViewportContainer?.remove(this.mapMaskShape, false);
      this.mapMaskShape.destroy();
      this.mapMaskShape = null;
    }
    this.mapZone?.removeAllListeners();
    this.mapViewportContainer?.destroy(true);
    this.mapViewportContainer = null;
    this.mapWorldLayer = null;
    this.mapOverlayLayer = null;
    this.mapGraphics = null;
    this.mapZone = null;
  }

  private renderHome(): void {
    this.addHeader(t('phoneSnappHome'));
    this.addLocationCard();
    const booking = this.transportation?.snappBooking ?? null;
    if (booking?.state === 'COMPLETED' || booking?.state === 'REFUNDED' || booking?.state === 'CANCELLED' || booking?.state === 'FAILED') {
      this.addText(this.bookingTerminalMessage(booking.state), this.screenHeight * 0.38, TURQUOISE, true);
    }
    if (this.errorMessage) this.addText(this.errorMessage, this.screenHeight * 0.46, COLORS.HEALTH, true, 10);
    const choose = this.addButton(
      t('phoneSnappChooseDestination'),
      this.screenHeight * 0.58,
      () => {
        this.errorMessage = null;
        if (!this.transportation?.beginSnappSelection()) {
          this.errorMessage = this.transportation?.snappError ?? t('phoneSnappUnavailable');
          this.render();
          return;
        }
        this.viewState = 'destination';
        this.render();
      },
      TURQUOISE,
    );
    choose.setData('accessibility-label', t('phoneSnappChooseDestination'));
    this.addText(t('phoneSnappPickupHint'), this.screenHeight * 0.73, undefined, false, 10);
    this.addText(t('phoneSnappCloseHint'), this.screenHeight * 0.82, undefined, false, 10);
  }

  private renderDestination(): void {
    this.addHeader(t('phoneSnappDestination'));
    const booking = this.transportation?.snappBooking;
    this.addText(t('phoneSnappCurrentLocation'), 52, TURQUOISE, true, 11);
    this.addText(this.locationSummary(), 72, undefined, false, 11);
    this.createMap('destination', booking?.pickupAnchor ?? booking?.pickup ?? this.player?.playerPosition ?? null);
    if (this.screenHeight >= 240 && this.screenWidth >= 150) {
      this.addText(t('phoneSnappMapHint'), this.mapRect.y + this.mapRect.height + 14, undefined, false, 10);
    }
    this.addQuickDestinations(booking?.cityId);
    this.addBackButton(() => {
      this.viewState = 'home';
      this.render();
    });
  }

  private renderQuote(): void {
    this.addHeader(t('phoneSnappQuote'));
    const quote = this.transportation?.snappBooking?.quote;
    if (!quote) {
      this.addText(t('phoneSnappNoRoute'), this.screenHeight * 0.42, COLORS.HEALTH, true, 12);
      this.addBackButton(() => {
        this.viewState = 'destination';
        this.render();
      });
      return;
    }
    this.addCard(12, 66, this.screenWidth - 24, 188);
    this.addText(`${t('phoneSnappDestination')}: ${quote.destination.label}`, 82, TURQUOISE, true, 11);
    this.addText(`${t('phoneSnappDistance')}: ${quote.distanceKm.toFixed(2)} km`, 108, undefined, false, 11);
    this.addText(`${t('phoneSnappDuration')}: ${quote.estimatedDurationMinutes} min`, 130, undefined, false, 11);
    this.addText(`${t('phoneSnappPickupAnchor')}: ${this.worldPixelsToMeters(quote.pickupWalkingDistancePx)} m`, 150, undefined, false, 10);
    if (quote.dropoffSnapDistancePx > 4) {
      this.addText(`${t('phoneSnappDropoffSnap')}: ${this.worldPixelsToMeters(quote.dropoffSnapDistancePx)} m`, 170, TURQUOISE, false, 10);
    }
    this.addText(`${t('phoneSnappWallet')}: $${this.player?.player?.inventory.money ?? 0}`, 194, undefined, false, 11);
    this.addText(`${t('phoneSnappFare')}: $${quote.total}`, 218, TEXT, true, 14);
    const booking = this.transportation?.snappBooking;
    if (booking?.error) this.addText(booking.error, 250, COLORS.HEALTH, true, 11);
    if (this.paymentPending) {
      this.addText(t('phoneSnappPaymentProcessing'), this.screenHeight * 0.64, TURQUOISE, true, 11);
    } else {
      const pay = this.addButton(
        t('phoneSnappConfirmPay'),
        this.screenHeight * 0.72,
        () => this.beginPayment(),
        TURQUOISE,
      );
      pay.setData('accessibility-label', t('phoneSnappConfirmPay'));
      if (this.errorMessage) this.addText(this.errorMessage, this.screenHeight * 0.64, COLORS.HEALTH, true, 11);
    }
    const back = this.addBackButton(() => {
      this.errorMessage = null;
      this.viewState = 'destination';
      this.render();
    });
    if (this.paymentPending) back.setEnabled(false);
  }

  private beginPayment(): void {
    if (this.paymentPending) return;
    this.paymentPending = true;
    this.errorMessage = null;
    this.render();
    this.paymentTimer?.remove(false);
    this.paymentTimer = this.uiScene.time.delayedCall(90, () => {
      this.paymentTimer = null;
      this.paymentPending = false;
      const result = this.transportation?.confirmSnappBooking();
      if (result === 'paid') {
        this.viewState = 'status';
      } else if (result === 'insufficient-funds') {
        this.errorMessage = t('phoneSnappInsufficientFunds');
      } else if (result === 'invalid-quote') {
        this.errorMessage = t('phoneSnappUnavailable');
      }
      this.render();
    });
  }

  private renderStatus(): void {
    const booking = this.transportation?.snappBooking;
    const expanded = this.context.getPresentationMode() === 'landscape-fullscreen';
    this.addHeader(t('phoneSnapp'));
    const state = booking?.state;
    const message = state === 'DRIVER_ARRIVED'
      ? t('phoneSnappDriverArrived')
      : state === 'PASSENGER_BOARDING'
        ? t('phoneSnappBoard')
        : state === 'RIDING'
          ? t('phoneSnappRiding')
          : state === 'ARRIVED'
            ? t('phoneSnappDriverArrived')
            : t('phoneSnappDriverEnRoute');
    const snapshot = this.trackingSnapshot ?? this.transportation?.snappTracking ?? null;
    if (!expanded) {
      this.addText(message, this.screenHeight * 0.34, TURQUOISE, true, 14);
      if (booking?.destination) this.addText(`${t('phoneSnappDestination')}: ${booking.destination.label}`, this.screenHeight * 0.44, undefined, false, 11);
      if (booking?.pickupAnchor && booking.pickupAnchorLabel) {
        this.addText(
          `${t('phoneSnappMeetAt')} ${booking.pickupAnchorLabel}  •  ${Math.round(booking.pickupWalkingDistancePx * 1000 / TRANSIT_PIXELS_PER_KILOMETER)} m`,
          this.screenHeight * 0.48,
          undefined,
          false,
          10,
        );
      }
      this.addText(`${t('phoneSnappFare')}: $${booking?.quote?.total ?? 0}  •  PAID`, this.screenHeight * 0.54, TEXT, true, 11);
    }
    if (snapshot) {
      const eta = Math.max(0, Math.ceil(snapshot.estimatedTimeOfArrivalMs / 60000));
      if (expanded) {
        const panelX = 12 + Math.max(112, Math.min(this.screenWidth - 24, Math.floor(this.screenWidth * 0.68))) + 8;
        const panelWidth = Math.max(88, this.screenWidth - panelX - 12);
        const panel = this.uiScene.add.graphics();
        panel.fillStyle(SURFACE, 1);
        panel.fillRoundedRect(panelX, 48, panelWidth, Math.max(64, this.screenHeight - 60), 8);
        panel.lineStyle(1, TURQUOISE, 0.45);
        panel.strokeRoundedRect(panelX, 48, panelWidth, Math.max(64, this.screenHeight - 60), 8);
        this.content.add(panel);
        this.addPanelText(message, panelX + 8, 62, panelWidth - 16, TURQUOISE, true, 13);
        if (booking?.destination) this.addPanelText(`${t('phoneSnappDestination')}: ${booking.destination.label}`, panelX + 8, 98, panelWidth - 16, TEXT, false, 10);
        this.addPanelText(`${t('phoneSnappFare')}: $${booking?.quote?.total ?? 0}  •  PAID`, panelX + 8, 124, panelWidth - 16, TEXT, true, 10);
        this.statusRemainingLabel = this.addPanelText(`${t('phoneSnappRemaining')}: ${(snapshot.remainingDistancePx / TRANSIT_PIXELS_PER_KILOMETER).toFixed(2)} km  •  ${eta} min`, panelX + 8, 150, panelWidth - 16, TEXT, false, 9);
        if (state === 'DRIVER_ARRIVED') {
          this.statusWaitLabel = this.addPanelText(`${t('phoneSnappPickupWait')} — ${this.formatWait(snapshot.pickupWaitRemainingMs)}`, panelX + 8, 178, panelWidth - 16, TURQUOISE, true, 10);
        }
      } else {
        this.statusRemainingLabel = this.addText(`${t('phoneSnappRemaining')}: ${(snapshot.remainingDistancePx / TRANSIT_PIXELS_PER_KILOMETER).toFixed(2)} km  •  ${eta} min`, this.screenHeight * 0.60, undefined, false, 10);
        if (state === 'DRIVER_ARRIVED') {
          this.statusWaitLabel = this.addText(
            `${t('phoneSnappPickupWait')} — ${this.formatWait(snapshot.pickupWaitRemainingMs)}`,
            this.screenHeight * 0.64,
            TURQUOISE,
            true,
            11,
          );
        }
      }
      this.createMap('status', snapshot.pickupAnchor, snapshot);
    }
    const actionY = Math.min(
      this.screenHeight - 30,
      Math.max(this.screenHeight * 0.66, this.mapRect.y + this.mapRect.height + 30),
    );
    if (state === 'DRIVER_ARRIVED') {
      const board = expanded
        ? this.addButtonAt(t('phoneSnappBoard'), this.screenWidth * 0.84, this.screenHeight - 34, () => {
          if (booking?.assignedVehicleId === null || booking?.assignedVehicleId === undefined || !this.transportation?.requestSnappBoarding(booking.assignedVehicleId)) {
            this.errorMessage = t('phoneSnappPickupHint');
            this.render();
          } else {
            this.errorMessage = null;
            this.context.closePhone();
          }
        }, TURQUOISE)
        : this.addButton(t('phoneSnappBoard'), actionY, () => {
        if (booking?.assignedVehicleId === null || booking?.assignedVehicleId === undefined || !this.transportation?.requestSnappBoarding(booking.assignedVehicleId)) {
          this.errorMessage = t('phoneSnappPickupHint');
          this.render();
        } else {
          this.errorMessage = null;
          this.context.closePhone();
        }
      }, TURQUOISE);
      board.setData('accessibility-label', t('phoneSnappBoard'));
    } else if (state === 'DRIVER_EN_ROUTE') {
      const cancel = expanded
        ? this.addButtonAt(t('phoneSnappCancel'), this.screenWidth * 0.84, this.screenHeight - 34, () => {
          this.transportation?.cancelSnappBooking();
          this.render();
        }, COLORS.HEALTH)
        : this.addButton(t('phoneSnappCancel'), actionY, () => {
        this.transportation?.cancelSnappBooking();
        this.render();
      }, COLORS.HEALTH);
      cancel.setData('accessibility-label', t('phoneSnappCancel'));
    }
    if (this.errorMessage) this.addText(this.errorMessage, this.screenHeight * 0.78, COLORS.HEALTH, true, 10);
    if (!expanded) this.addText(t('phoneSnappCloseHint'), this.screenHeight * 0.86, undefined, false, 10);
    this.addBackButton(() => {
      this.viewState = 'home';
      this.render();
    });
  }

  private updateStatusOverlay(snapshot: SnappTrackingSnapshot): void {
    if (this.statusRemainingLabel) {
      const eta = Math.max(0, Math.ceil(snapshot.estimatedTimeOfArrivalMs / 60000));
      this.statusRemainingLabel.setText(`${t('phoneSnappRemaining')}: ${(snapshot.remainingDistancePx / TRANSIT_PIXELS_PER_KILOMETER).toFixed(2)} km  •  ${eta} min`);
    }
    if (this.statusWaitLabel) {
      this.statusWaitLabel.setText(`${t('phoneSnappPickupWait')} — ${this.formatWait(snapshot.pickupWaitRemainingMs)}`);
    }
  }

  private formatWait(remainingMs: number): string {
    const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }

  private worldPixelsToMeters(distancePx: number): number {
    return Math.round(Math.max(0, distancePx) * 1000 / TRANSIT_PIXELS_PER_KILOMETER);
  }

  private addDestinationButton(destination: TaxiDestination, y: number): void {
    const button = new Button(this.uiScene, this.screenWidth / 2, y, {
      text: destination.label,
      width: Math.max(44, this.screenWidth - 24),
      height: 44,
      onClick: () => {
        const quote = this.transportation?.previewSnappDestination(destination);
        if (!quote) {
          this.errorMessage = this.transportation?.snappBooking?.error ?? t('phoneSnappNoRoute');
          this.render();
          return;
        }
        this.errorMessage = null;
        this.viewState = 'quote';
        this.render();
      },
    });
    button.setData('accessibility-label', `${t('phoneSnappDestination')}: ${destination.label}`);
    this.content.add(button);
  }

  private addQuickDestinations(cityId: string | undefined): void {
    if (!cityId) return;
    if (this.screenHeight < 240 || this.screenWidth < 150) return;
    const destinations = this.transportation?.snappDestinations(cityId as CityId) ?? [];
    const top = this.mapRect.y + this.mapRect.height + 34;
    if (destinations.length === 0) {
      this.addText(t('phoneSnappNoDestinations'), top, COLORS.HEALTH, true, 11);
      return;
    }
    const max = Math.min(destinations.length, 2);
    for (let index = 0; index < max; index += 1) {
      const destination = destinations[index];
      if (destination) this.addDestinationButton(destination, top + index * 48);
    }
  }

  /** Create one authoritative world-data map canvas for destination or status. */
  private createMap(
    mode: 'destination' | 'status',
    focus: { x: number; y: number } | null,
    snapshot: SnappTrackingSnapshot | null = null,
  ): void {
    const world = this.world;
    if (!world) return;
    const compact = this.screenHeight < 240 || this.screenWidth < 150;
    const expanded = this.context.getPresentationMode() === 'landscape-fullscreen';
    const top = expanded ? 48 : compact ? 48 : mode === 'status' ? 86 : 90;
    const maxHeight = mode === 'status' ? 154 : 184;
    const usableWidth = Math.max(40, this.screenWidth - 24);
    const usableHeight = Math.max(40, this.screenHeight - top - 12);
    const height = expanded
      ? usableHeight
      : Math.max(Math.min(compact ? 64 : 118, usableHeight), Math.min(maxHeight, usableHeight));
    const width = expanded
      ? Math.min(usableWidth, Math.max(64, Math.floor(this.screenWidth * 0.68)))
      : usableWidth;
    this.mapRect = { x: 12, y: top, width, height };
    const preserveViewport = this.mapInitialized && this.mapMode === mode;
    if (!preserveViewport) {
      if (focus) this.mapCenter = { x: focus.x, y: focus.y };
      else this.mapCenter = { x: world.map.widthTiles * world.map.tileSize / 2, y: world.map.heightTiles * world.map.tileSize / 2 };
      this.mapZoom = mode === 'status' ? 1.7 : 1.15;
    }
    this.mapMode = mode;
    this.mapInitialized = true;
    this.clampMapCenter();
    this.mapViewportContainer = this.uiScene.add.container();
    this.mapWorldLayer = this.uiScene.add.container();
    this.mapOverlayLayer = this.uiScene.add.container();
    this.mapViewportContainer.add([this.mapWorldLayer, this.mapOverlayLayer]);
    this.content.add(this.mapViewportContainer);
    this.mapMaskShape = this.uiScene.make.graphics({ x: 0, y: 0 }, false);
    this.mapMaskShape.setVisible(false);
    this.mapMaskShape.fillStyle(0xffffff, 1);
    this.mapMaskShape.fillRoundedRect(this.mapRect.x, this.mapRect.y, this.mapRect.width, this.mapRect.height, 6);
    this.mapViewportContainer.add(this.mapMaskShape);
    this.mapMask = this.mapMaskShape.createGeometryMask();
    this.mapWorldLayer.setMask(this.mapMask);
    this.mapGraphics = this.uiScene.add.graphics();
    this.mapWorldLayer.add(this.mapGraphics);
    this.mapZone = this.uiScene.add.zone(
      this.mapRect.x + this.mapRect.width / 2,
      this.mapRect.y + this.mapRect.height / 2,
      this.mapRect.width,
      this.mapRect.height,
    ).setInteractive();
    this.mapZone.on('pointerdown', (pointer: Phaser.Input.Pointer, _x: number, _y: number, event: Phaser.Types.Input.EventData) => {
      event.stopPropagation();
      this.mapDragging = true;
      this.mapMoved = false;
      this.mapLastPointer = { x: pointer.x, y: pointer.y };
    });
    this.mapZone.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      if (!this.mapDragging) return;
      const dx = pointer.x - this.mapLastPointer.x;
      const dy = pointer.y - this.mapLastPointer.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) this.mapMoved = true;
      const scale = this.mapScale();
      this.mapCenter.x -= dx / scale;
      this.mapCenter.y -= dy / scale;
      this.clampMapCenter();
      this.mapLastPointer = { x: pointer.x, y: pointer.y };
      this.redrawMap();
    });
    this.mapZone.on('pointerup', (pointer: Phaser.Input.Pointer, _localX: number, _localY: number, event: Phaser.Types.Input.EventData) => {
      event.stopPropagation();
      const wasMoved = this.mapMoved;
      this.mapDragging = false;
      if (mode !== 'destination' || wasMoved) return;
      const local = this.pointerToLocal(pointer);
      const worldPoint = this.screenToWorld(local.x, local.y);
      this.selectedMapPoint = new Phaser.Math.Vector2(worldPoint.x, worldPoint.y);
      const quote = this.transportation?.previewSnappMapPoint(worldPoint, t('phoneSnappMapPin')) ?? null;
      if (!quote) {
        this.errorMessage = this.transportation?.snappBooking?.error ?? t('phoneSnappNoRoute');
        this.render();
        return;
      }
      this.errorMessage = null;
      this.viewState = 'quote';
      this.render();
    });
    this.mapZone.on('pointerupoutside', () => {
      this.mapDragging = false;
    });
    this.mapZone.on('wheel', (_pointer: Phaser.Input.Pointer, _over: unknown, _dx: number, dy: number, event: Phaser.Types.Input.EventData) => {
      event.stopPropagation();
      this.mapZoom = Phaser.Math.Clamp(this.mapZoom * (dy < 0 ? 1.12 : 0.9), 0.85, 3.2);
      this.clampMapCenter();
      this.redrawMap();
    });
    this.mapOverlayLayer.add(this.mapZone);
    if (!compact) {
      this.addMapControl('+', this.mapRect.x + this.mapRect.width - 22, this.mapRect.y + 24, () => {
        this.mapZoom = Phaser.Math.Clamp(this.mapZoom * 1.2, 0.85, 3.2);
        this.clampMapCenter();
        this.redrawMap();
      });
      this.addMapControl('−', this.mapRect.x + this.mapRect.width - 22, this.mapRect.y + 72, () => {
        this.mapZoom = Phaser.Math.Clamp(this.mapZoom * 0.84, 0.85, 3.2);
        this.clampMapCenter();
        this.redrawMap();
      });
    }
    if (!compact && this.mapRect.width >= 190) {
      this.addMapControl('CENTER', this.mapRect.x + 42, this.mapRect.y + this.mapRect.height - 22, () => {
        const player = this.player?.playerPosition;
        if (player) {
          this.mapCenter = { ...player };
          this.clampMapCenter();
        }
        this.redrawMap();
      });
    }
    if (mode === 'status' && !compact && this.mapRect.width >= 190) {
      this.addMapControl('FIT', this.mapRect.x + 112, this.mapRect.y + this.mapRect.height - 22, () => {
        const current = this.trackingSnapshot ?? snapshot;
        if (current) this.fitTrackingRoute(current);
      });
    }
    this.addMapControl(
      expanded ? 'PORTRAIT' : 'EXPAND',
      this.mapRect.x + this.mapRect.width - 48,
      this.mapRect.y + this.mapRect.height - 22,
      () => expanded ? this.context.exitExpandedMode() : this.context.setPresentationMode('landscape-fullscreen'),
    );
    if (mode === 'status') this.addMapLegend();
    if (mode === 'status' && snapshot && !preserveViewport) this.fitTrackingRoute(snapshot);
    else this.redrawMap(snapshot);
  }

  private addMapControl(text: string, x: number, y: number, onClick: () => void): void {
    const button = new Button(this.uiScene, x, y, { text, width: text.length > 2 ? 68 : 44, height: 44, onClick });
    button.setData(
      'accessibility-label',
      text === 'CENTER' ? t('phoneSnappRecenter')
        : text === 'FIT' ? t('phoneSnappFitRoute')
          : text === 'EXPAND' ? t('phoneSnappExpandMap')
            : text === 'PORTRAIT' ? t('phoneSnappPortraitMap')
              : `Zoom ${text}`,
    );
    (this.mapOverlayLayer ?? this.content).add(button);
  }

  /** Compact, non-color-only key for the live tracking markers. */
  private addMapLegend(): void {
    const entries = [
      { label: t('phoneSnappLegendPlayer'), color: 0x4da3ff, shape: 'circle' },
      { label: t('phoneSnappLegendDriver'), color: TURQUOISE, shape: 'triangle' },
      { label: t('phoneSnappLegendPickup'), color: 0xf6c453, shape: 'square' },
      { label: t('phoneSnappLegendDestination'), color: COLORS.HEALTH, shape: 'diamond' },
    ] as const;
    const rowWidth = Math.max(56, (this.mapRect.width - 16) / 2);
    const legend = this.uiScene.add.container(this.mapRect.x + 8, this.mapRect.y + 8);
    legend.setData('accessibility-label', entries.map((entry) => entry.label).join(', '));
    entries.forEach((entry, index) => {
      const row = Math.floor(index / 2);
      const column = index % 2;
      const x = column * rowWidth;
      const y = row * 16;
      const symbol = this.uiScene.add.graphics();
      symbol.fillStyle(entry.color, 1);
      if (entry.shape === 'circle') symbol.fillCircle(x + 4, y + 5, 3);
      else if (entry.shape === 'triangle') symbol.fillTriangle(x + 1, y + 8, x + 7, y + 8, x + 4, y + 1);
      else if (entry.shape === 'square') symbol.fillRect(x + 1, y + 2, 6, 6);
      else symbol.fillTriangle(x + 4, y + 1, x + 7, y + 5, x + 4, y + 9);
      const label = new Label(this.uiScene, x + 10, y - 1, entry.label, {
        fontSize: '8px',
        color: TEXT,
        fixedWidth: Math.max(32, rowWidth - 12),
      });
      legend.add([symbol, label]);
    });
    (this.mapOverlayLayer ?? this.content).add(legend);
  }

  private redrawMap(snapshot: SnappTrackingSnapshot | null = this.trackingSnapshot): void {
    const graphics = this.mapGraphics;
    const world = this.world;
    if (!graphics || !world) return;
    const map = world.map;
    if (this.roadNodes.size !== map.roadNodes.length) {
      this.roadNodes.clear();
      for (const node of map.roadNodes) this.roadNodes.set(node.id, { x: node.x, y: node.y });
    }
    const worldWidth = map.widthTiles * map.tileSize;
    const worldHeight = map.heightTiles * map.tileSize;
    const scale = this.mapScale();
    graphics.clear();
    graphics.fillStyle(0x071a1d, 1);
    graphics.fillRect(this.mapRect.x, this.mapRect.y, this.mapRect.width, this.mapRect.height);
    graphics.lineStyle(1, 0x27484c, 0.9);
    for (const edge of map.roadEdges) {
      const from = this.roadNodes.get(edge.fromNodeId);
      const to = this.roadNodes.get(edge.toNodeId);
      if (!from || !to) continue;
      const a = this.worldToScreen(from, scale, worldWidth, worldHeight);
      const b = this.worldToScreen(to, scale, worldWidth, worldHeight);
      graphics.lineBetween(a.x, a.y, b.x, b.y);
    }
    for (const city of map.cities) {
      const x = this.mapRect.x + (city.bounds.x + city.bounds.width / 2 - this.mapCenter.x) * scale + this.mapRect.width / 2;
      const y = this.mapRect.y + (city.bounds.y + city.bounds.height / 2 - this.mapCenter.y) * scale + this.mapRect.height / 2;
      graphics.lineStyle(1, city.color, 0.45);
      graphics.strokeRect(x - city.bounds.width * scale / 2, y - city.bounds.height * scale / 2, city.bounds.width * scale, city.bounds.height * scale);
    }
    graphics.fillStyle(0xf2ffff, 1);
    for (const landmark of map.landmarks) {
      const point = this.worldToScreen(landmark.position, scale, worldWidth, worldHeight);
      graphics.fillRect(point.x - 1, point.y - 1, 3, 3);
    }
    const booking = this.transportation?.snappBooking;
    const player = this.player?.playerPosition;
    if (player) this.drawMapMarker(graphics, player, 0x4da3ff, 4, scale, worldWidth, worldHeight);
    if (booking?.pickup) this.drawMapMarker(graphics, booking.pickup, 0xf6c453, 3, scale, worldWidth, worldHeight);
    if (booking?.pickupAnchor) this.drawMapMarker(graphics, booking.pickupAnchor, TURQUOISE, 4, scale, worldWidth, worldHeight);
    if (booking?.destination) this.drawMapMarker(graphics, booking.dropoffPosition ?? booking.destination.position, COLORS.HEALTH, 4, scale, worldWidth, worldHeight);
    if (this.selectedMapPoint) this.drawMapMarker(graphics, this.selectedMapPoint, 0xffffff, 3, scale, worldWidth, worldHeight);
    if (snapshot) {
      if (snapshot.driverRoute) this.drawRoute(graphics, snapshot.driverRoute, 0x13c8bc, scale, worldWidth, worldHeight);
      if (snapshot.passengerRoute) this.drawRoute(graphics, snapshot.passengerRoute, 0xf2ffff, scale, worldWidth, worldHeight);
      this.drawMapMarker(graphics, snapshot.driverPosition, TURQUOISE, 5, scale, worldWidth, worldHeight, snapshot.vehicleHeading);
    }
    graphics.lineStyle(1, 0x80a6a8, 0.8);
    graphics.strokeRect(this.mapRect.x, this.mapRect.y, this.mapRect.width, this.mapRect.height);
  }

  private drawRoute(
    graphics: Phaser.GameObjects.Graphics,
    route: TrafficRoutePreview,
    color: number,
    scale: number,
    worldWidth: number,
    worldHeight: number,
  ): void {
    graphics.lineStyle(2, color, 0.9);
    const network = this.traffic?.roadNetwork;
    if (!network || route.laneIds.length === 0) {
      const start = this.worldToScreen(route.start, scale, worldWidth, worldHeight);
      const end = this.worldToScreen(route.end, scale, worldWidth, worldHeight);
      graphics.lineBetween(start.x, start.y, end.x, end.y);
      return;
    }
    let previous: { x: number; y: number } | null = null;
    for (const laneId of route.laneIds) {
      const lane = network.lane(laneId);
      if (!lane) continue;
      for (let step = 0; step <= 6; step += 1) {
        const point = network.pointAt(lane, lane.spline.length * step / 6).point;
        const screen = this.worldToScreen(point, scale, worldWidth, worldHeight);
        if (previous) graphics.lineBetween(previous.x, previous.y, screen.x, screen.y);
        previous = screen;
      }
    }
  }

  private drawMapMarker(
    graphics: Phaser.GameObjects.Graphics,
    point: { x: number; y: number },
    color: number,
    radius: number,
    scale: number,
    worldWidth: number,
    worldHeight: number,
    heading?: number,
  ): void {
    const screen = this.worldToScreen(point, scale, worldWidth, worldHeight);
    graphics.fillStyle(0x071a1d, 0.95);
    graphics.fillCircle(screen.x, screen.y, radius + 2);
    graphics.fillStyle(color, 1);
    graphics.fillCircle(screen.x, screen.y, radius);
    if (heading !== undefined) {
      graphics.lineStyle(2, 0xf2ffff, 0.9);
      graphics.lineBetween(screen.x, screen.y, screen.x + Math.cos(heading) * (radius + 5), screen.y + Math.sin(heading) * (radius + 5));
    }
  }

  private mapScale(): number {
    const world = this.world;
    if (!world) return 0.001;
    return Math.max(
      0.0001,
      Math.min(this.mapRect.width / (world.map.widthTiles * world.map.tileSize), this.mapRect.height / (world.map.heightTiles * world.map.tileSize)) * this.mapZoom,
    );
  }

  /** Keep the visible map anchored to authoritative world bounds. */
  private clampMapCenter(): void {
    const world = this.world;
    if (!world || this.mapRect.width <= 0 || this.mapRect.height <= 0) return;
    const worldWidth = world.map.widthTiles * world.map.tileSize;
    const worldHeight = world.map.heightTiles * world.map.tileSize;
    const scale = this.mapScale();
    const halfWorldWidth = this.mapRect.width / (2 * scale);
    const halfWorldHeight = this.mapRect.height / (2 * scale);
    const centerX = worldWidth / 2;
    const centerY = worldHeight / 2;
    this.mapCenter.x = halfWorldWidth >= worldWidth / 2
      ? centerX
      : Phaser.Math.Clamp(this.mapCenter.x, halfWorldWidth, worldWidth - halfWorldWidth);
    this.mapCenter.y = halfWorldHeight >= worldHeight / 2
      ? centerY
      : Phaser.Math.Clamp(this.mapCenter.y, halfWorldHeight, worldHeight - halfWorldHeight);
  }

  /** Fit both the active driver leg and passenger leg inside the map viewport. */
  private fitTrackingRoute(snapshot: SnappTrackingSnapshot): void {
    const world = this.world;
    if (!world) return;
    const points: Array<{ x: number; y: number }> = [
      snapshot.driverPosition,
      snapshot.pickupAnchor,
      snapshot.destinationPosition,
    ];
    const network = this.traffic?.roadNetwork;
    const routes = [snapshot.driverRoute, snapshot.passengerRoute];
    if (network) {
      for (const route of routes) {
        if (!route) continue;
        for (const laneId of route.laneIds) {
          const lane = network.lane(laneId);
          if (!lane) continue;
          for (let step = 0; step <= 6; step += 1) points.push(network.pointAt(lane, lane.spline.length * step / 6).point);
        }
      }
    }
    const minX = Math.min(...points.map((point) => point.x));
    const maxX = Math.max(...points.map((point) => point.x));
    const minY = Math.min(...points.map((point) => point.y));
    const maxY = Math.max(...points.map((point) => point.y));
    const padding = 18;
    const routeWidth = Math.max(1, maxX - minX);
    const routeHeight = Math.max(1, maxY - minY);
    const worldWidth = world.map.widthTiles * world.map.tileSize;
    const worldHeight = world.map.heightTiles * world.map.tileSize;
    const baseScale = Math.min(
      (this.mapRect.width - padding * 2) / routeWidth,
      (this.mapRect.height - padding * 2) / routeHeight,
    );
    const worldScale = Math.min(this.mapRect.width / worldWidth, this.mapRect.height / worldHeight);
    this.mapZoom = Phaser.Math.Clamp(baseScale / Math.max(0.0001, worldScale), 0.85, 3.2);
    this.mapCenter = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
    this.clampMapCenter();
    this.redrawMap();
  }

  private worldToScreen(point: { x: number; y: number }, scale: number, _worldWidth: number, _worldHeight: number): { x: number; y: number } {
    // The phone map is an affine projection of authoritative world pixels:
    // translate by the current world-space centre, then apply one uniform
    // nearest-neighbour-friendly scale into the clipped phone viewport.
    return {
      x: this.mapRect.x + this.mapRect.width / 2 + (point.x - this.mapCenter.x) * scale,
      y: this.mapRect.y + this.mapRect.height / 2 + (point.y - this.mapCenter.y) * scale,
    };
  }

  private screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
    const scale = this.mapScale();
    const world = this.world;
    if (!world) return { x: 0, y: 0 };
    return {
      x: Phaser.Math.Clamp(this.mapCenter.x + (screenX - this.mapRect.x - this.mapRect.width / 2) / scale, 0, world.map.widthTiles * world.map.tileSize),
      y: Phaser.Math.Clamp(this.mapCenter.y + (screenY - this.mapRect.y - this.mapRect.height / 2) / scale, 0, world.map.heightTiles * world.map.tileSize),
    };
  }

  private pointerToLocal(pointer: Phaser.Input.Pointer): { x: number; y: number } {
    const matrix = this.getWorldTransformMatrix();
    const dx = pointer.x - matrix.tx;
    const dy = pointer.y - matrix.ty;
    const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
    if (Math.abs(determinant) < 0.0001) return { x: dx, y: dy };
    return {
      x: (matrix.d * dx - matrix.c * dy) / determinant,
      y: (-matrix.b * dx + matrix.a * dy) / determinant,
    };
  }

  private addLocationCard(): void {
    this.addCard(12, 54, this.screenWidth - 24, 78);
    this.addText(t('phoneSnappCurrentLocation'), 68, TURQUOISE, true, 10);
    this.addText(this.locationSummary(), 92, TEXT, true, 11);
  }

  private addHeader(text: string): void {
    this.addText(text, 18, TURQUOISE, true, 14);
  }

  private addCard(x: number, y: number, width: number, height: number): void {
    const card = this.uiScene.add.graphics();
    card.fillStyle(SURFACE, 1);
    card.fillRoundedRect(x, y, width, height, 8);
    card.lineStyle(1, TURQUOISE, 0.45);
    card.strokeRoundedRect(x, y, width, height, 8);
    this.content.add(card);
  }

  private addText(text: string, y: number, color: string | number = TEXT, bold = false, fontSize = 12): Label {
    const label = new Label(this.uiScene, 12, Math.round(y), text, {
      fontSize: `${fontSize}px`,
      fontStyle: bold ? 'bold' : 'normal',
      color: typeof color === 'number' ? `#${color.toString(16).padStart(6, '0')}` : color,
      fixedWidth: Math.max(20, this.screenWidth - 24),
      align: 'center',
    });
    this.content.add(label);
    return label;
  }

  private addButton(text: string, y: number, onClick: () => void, accent = TURQUOISE): Button {
    const button = new Button(this.uiScene, this.screenWidth / 2, Math.round(y), {
      text,
      width: Math.max(44, this.screenWidth - 24),
      height: 48,
      onClick,
    });
    button.setData('snapp-accent', accent);
    this.content.add(button);
    return button;
  }

  private addBackButton(onClick: () => void): Button {
    const width = Math.min(88, Math.max(44, this.screenWidth - 16));
    const button = new Button(this.uiScene, Math.min(50, this.screenWidth / 2), this.screenHeight - 28, {
      text: t('phoneBack'),
      width,
      height: 48,
      onClick: () => {
        if (this.context.getPresentationMode() !== 'portrait') {
          this.context.exitExpandedMode();
          return;
        }
        onClick();
      },
    });
    button.setData('accessibility-label', t('phoneBack'));
    this.content.add(button);
    return button;
  }

  private addButtonAt(text: string, x: number, y: number, onClick: () => void, accent = TURQUOISE): Button {
    const button = new Button(this.uiScene, Math.round(x), Math.round(y), {
      text,
      width: Math.max(44, Math.min(220, this.screenWidth - 24)),
      height: 48,
      onClick,
    });
    button.setData('snapp-accent', accent);
    this.content.add(button);
    return button;
  }

  private addPanelText(text: string, x: number, y: number, width: number, color: string | number, bold: boolean, fontSize: number): Label {
    const label = new Label(this.uiScene, Math.round(x), Math.round(y), text, {
      fontSize: `${fontSize}px`,
      fontStyle: bold ? 'bold' : 'normal',
      color: typeof color === 'number' ? `#${color.toString(16).padStart(6, '0')}` : color,
      fixedWidth: Math.max(20, Math.round(width)),
      align: 'left',
    });
    this.content.add(label);
    return label;
  }

  private locationSummary(): string {
    const position = this.player?.playerPosition;
    const city = position ? this.world?.cityAt(position.x, position.y) : null;
    return city ? `${city.name}  ${Math.round(position?.x ?? 0)},${Math.round(position?.y ?? 0)}` : 'INTERCITY';
  }

  private bookingTerminalMessage(state: string): string {
    if (state === 'COMPLETED') return t('phoneSnappCompleted');
    if (state === 'REFUNDED') return t('phoneSnappUnavailable');
    return t('phoneSnappUnavailable');
  }
}
