import Phaser from 'phaser';
import { COLORS } from '@/config/Constants';
import { EventKeys } from '@/config/EventKeys';
import { t } from '@/config/Strings';
import { eventBus } from '@/core/EventBus';
import { ServiceLocator } from '@/core/ServiceLocator';
import { ServiceKeys } from '@/config/ServiceKeys';
import type { PhoneAppContext } from '@/phone/PhoneTypes';
import type { TaxiDestination } from '@/gameplay/transit';
import type { TransportationSystem } from '@/systems/TransportationSystem';
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
  private readonly transportation: TransportationSystem | null;
  private readonly player: PlayerController | null;
  private readonly world: WorldManager | null;
  private readonly content = this.uiScene.add.container();
  private readonly unsubs: Array<() => void> = [];
  private viewState: SnappViewState = 'home';
  private screenWidth = 240;
  private screenHeight = 400;
  private errorMessage: string | null = null;
  private paymentPending = false;
  private paymentTimer: Phaser.Time.TimerEvent | null = null;

  constructor(scene: Phaser.Scene, _context: PhoneAppContext) {
    super(scene);
    this.transportation = ServiceLocator.tryResolve<TransportationSystem>(ServiceKeys.Transportation);
    this.player = ServiceLocator.tryResolve<PlayerController>(ServiceKeys.Player);
    this.world = ServiceLocator.tryResolve<WorldManager>(ServiceKeys.World);
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
    this.content.destroy(true);
    super.destroy(fromScene);
  }

  private render(): void {
    this.content.removeAll(true);
    const booking = this.transportation?.snappBooking ?? null;
    if (booking?.state === 'DRIVER_EN_ROUTE' || booking?.state === 'DRIVER_ARRIVED' || booking?.state === 'RIDING' || booking?.state === 'ARRIVED') {
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

  private renderHome(): void {
    this.addHeader(t('phoneSnappHome'));
    this.addLocationCard();
    const booking = this.transportation?.snappBooking ?? null;
    if (booking?.state === 'COMPLETED' || booking?.state === 'REFUNDED' || booking?.state === 'CANCELLED' || booking?.state === 'FAILED') {
      this.addText(this.bookingTerminalMessage(booking.state), this.screenHeight * 0.38, TURQUOISE, true);
    }
    const choose = this.addButton(
      t('phoneSnappChooseDestination'),
      this.screenHeight * 0.58,
      () => {
        this.errorMessage = null;
        if (!this.transportation?.beginSnappSelection()) {
          this.errorMessage = t('phoneSnappUnavailable');
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
    const city = booking?.cityId;
    const destinations = city ? this.transportation?.snappDestinations(city) ?? [] : [];
    this.addText(t('phoneSnappCurrentLocation'), 52, TURQUOISE, true, 11);
    this.addText(this.locationSummary(), 72, undefined, false, 11);
    if (destinations.length === 0) {
      this.addText(t('phoneSnappNoDestinations'), this.screenHeight * 0.44, COLORS.HEALTH, true, 12);
    } else {
      const max = Math.min(destinations.length, 6);
      const top = 112;
      for (let index = 0; index < max; index += 1) {
        const destination = destinations[index];
        if (!destination) continue;
        this.addDestinationButton(destination, top + index * 48);
      }
    }
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
    this.addCard(12, 66, this.screenWidth - 24, 154);
    this.addText(`${t('phoneSnappDestination')}: ${quote.destination.label}`, 82, TURQUOISE, true, 11);
    this.addText(`${t('phoneSnappDistance')}: ${quote.distanceKm.toFixed(2)} km`, 108, undefined, false, 11);
    this.addText(`${t('phoneSnappDuration')}: ${quote.estimatedDurationMinutes} min`, 130, undefined, false, 11);
    this.addText(`${t('phoneSnappWallet')}: $${this.player?.player?.inventory.money ?? 0}`, 164, undefined, false, 11);
    this.addText(`${t('phoneSnappFare')}: $${quote.total}`, 188, TEXT, true, 14);
    const booking = this.transportation?.snappBooking;
    if (booking?.error) this.addText(booking.error, 236, COLORS.HEALTH, true, 11);
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
    this.addHeader(t('phoneSnapp'));
    const state = booking?.state;
    const message = state === 'DRIVER_ARRIVED'
      ? t('phoneSnappDriverArrived')
      : state === 'RIDING'
        ? t('phoneSnappRiding')
        : state === 'ARRIVED'
          ? t('phoneSnappDriverArrived')
          : t('phoneSnappDriverEnRoute');
    this.addText(message, this.screenHeight * 0.34, TURQUOISE, true, 14);
    if (booking?.destination) this.addText(`${t('phoneSnappDestination')}: ${booking.destination.label}`, this.screenHeight * 0.44, undefined, false, 11);
    this.addText(`${t('phoneSnappFare')}: $${booking?.quote?.total ?? 0}  •  PAID`, this.screenHeight * 0.51, TEXT, true, 11);
    if (state === 'DRIVER_ARRIVED') {
      const board = this.addButton(t('phoneSnappBoard'), this.screenHeight * 0.66, () => {
        if (!booking?.assignedVehicleId || !this.transportation?.requestSnappBoarding(booking.assignedVehicleId)) {
          this.errorMessage = t('phoneSnappPickupHint');
        } else {
          this.errorMessage = null;
        }
        this.render();
      }, TURQUOISE);
      board.setData('accessibility-label', t('phoneSnappBoard'));
    } else if (state === 'DRIVER_EN_ROUTE') {
      this.addButton(t('phoneSnappCancel'), this.screenHeight * 0.66, () => {
        this.transportation?.cancelSnappBooking();
        this.render();
      }, COLORS.HEALTH);
    }
    if (this.errorMessage) this.addText(this.errorMessage, this.screenHeight * 0.78, COLORS.HEALTH, true, 10);
    this.addText(t('phoneSnappCloseHint'), this.screenHeight * 0.86, undefined, false, 10);
    this.addBackButton(() => {
      this.viewState = 'home';
      this.render();
    });
  }

  private addDestinationButton(destination: TaxiDestination, y: number): void {
    const button = new Button(this.uiScene, this.screenWidth / 2, y, {
      text: destination.label,
      width: Math.max(120, this.screenWidth - 24),
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
      width: Math.max(128, this.screenWidth - 24),
      height: 48,
      onClick,
    });
    button.setData('snapp-accent', accent);
    this.content.add(button);
    return button;
  }

  private addBackButton(onClick: () => void): Button {
    const button = new Button(this.uiScene, 50, this.screenHeight - 28, {
      text: t('phoneBack'),
      width: 88,
      height: 48,
      onClick,
    });
    button.setData('accessibility-label', t('phoneBack'));
    this.content.add(button);
    return button;
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
