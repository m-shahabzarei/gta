/**
 * GameHud — the in-game heads-up display.
 *
 * A camera-pinned {@link UIComponent} that renders every live gameplay readout:
 * the player's health and armor bars, cash, wanted-level stars (which blink
 * while the police are searching), the equipped-weapon panel (icon + name +
 * magazine/reserve ammo), a vehicle-health bar and speedometer shown only while
 * driving, an objective compass arrow that points to the active mission target,
 * a mission objective banner, an in-game clock and transient toast messages.
 *
 * The HUD is purely presentational: it owns no gameplay state and never mutates
 * the world. It initialises from {@link DEFAULT_HUD_STATE} and then reacts to a
 * fixed set of {@link EventKeys} broadcast on the {@link eventBus}, plus a pair
 * of per-frame push methods ({@link GameHud.setVehicleSpeed} /
 * {@link GameHud.setObjectiveArrow}) driven by the {@link UIScene}. Every
 * subscription's unsubscribe handle is retained and released in
 * {@link GameHud.destroy}.
 */

import Phaser from 'phaser';
import { UIComponent } from '@/ui/UIComponent';
import { Button, Label, ProgressBar } from '@/ui/components';
import { WEAPONS } from '@/data';
import type { PlayerVitalsSnapshot, WeaponDef } from '@/gameplay/types';
import { TextureKeys } from '@/config/AssetKeys';
import { COLORS, GAME_WIDTH, GAME_HEIGHT, PLAYER, WANTED } from '@/config/Constants';
import { DepthLayers } from '@/config/DepthLayers';
import { EventKeys } from '@/config/EventKeys';
import { t } from '@/config/Strings';
import { eventBus } from '@/core/EventBus';
import { DEFAULT_HUD_STATE } from '@/core/types';
import type { Unsubscribe } from '@/core/types';
import { ServiceLocator } from '@/core/ServiceLocator';
import { ServiceKeys } from '@/config/ServiceKeys';
import type { PhoneManager } from '@/managers/PhoneManager';
import type { MobilePlatform } from '@/platform';
import { TRANSIT_PIXELS_PER_KILOMETER } from '@/gameplay/transit';

/** Glyph used for a weapon that has unlimited ammunition. */
const INFINITY = '∞';

/** Diameter (px) budget the weapon icon is scaled into. */
const ICON_SIZE = 32;

/** Outer radius (px) of a wanted-level star. */
const STAR_RADIUS = 8;

/** Horizontal spacing (px) between adjacent wanted stars. */
const STAR_SPACING = 22;

/** Milliseconds a completed/failed mission banner lingers before clearing. */
const BANNER_CLEAR_MS = 2600;

/** Default lifetime (ms) of a toast when the event omits a duration. */
const DEFAULT_TOAST_MS = 2000;

/** Pseudo-km/h scale applied to a vehicle's px/sec speed for the readout. */
const SPEED_SCALE = 0.62;

/** Milliseconds per searching-star blink half-cycle. */
const BLINK_MS = 320;

/** Converts a 0xRRGGBB colour to a CSS hex string. */
function cssColor(value: number): string {
  return '#' + value.toString(16).padStart(6, '0');
}

export class GameHud extends UIComponent {
  private readonly mobileMode: boolean;
  private viewportWidth = GAME_WIDTH;
  private readonly hpLabel: Label;
  private readonly apLabel: Label;
  private readonly healthBar: ProgressBar;
  private readonly armorBar: ProgressBar;
  private readonly moneyLabel: Label;
  private readonly starGraphics: Phaser.GameObjects.Graphics;
  private readonly weaponIcon: Phaser.GameObjects.Image;
  private readonly weaponName: Label;
  private readonly ammoLabel: Label;
  private readonly reloadLabel: Label;
  private readonly vehicleBar: ProgressBar;
  private readonly speedLabel: Label;
  private readonly missionBanner: Label;
  private readonly clockLabel: Label;
  private readonly regionLabel: Label;
  private readonly interactionPrompt: Label;
  private readonly toastLabel: Label;
  private readonly compass: Phaser.GameObjects.Graphics;
  private readonly snappArrivalPanel: Phaser.GameObjects.Container;
  private readonly snappArrivalDetail: Label;
  private readonly snappArrivalOpen: Button;
  private readonly snappArrivalDismiss: Button;
  private readonly snappArrivalBookings = new Set<string>();

  /** All active event-bus unsubscribe handles, released on destroy. */
  private readonly unsubscribes: Unsubscribe[] = [];

  private bannerTimer?: Phaser.Time.TimerEvent;
  private toastTween?: Phaser.Tweens.Tween;

  /** Latest wanted level and search state, for the star renderer. */
  private wantedLevel = DEFAULT_HUD_STATE.wanted;
  private searching = false;
  private blinkMs = 0;
  private starsVisible = true;

  constructor(scene: Phaser.Scene, mobileMode = false) {
    super(scene, 0, 0);
    this.mobileMode = mobileMode;

    this.setScrollFactor(0);
    this.setDepth(DepthLayers.HUD);

    // ── Health + armor (top-left) ────────────────────────────────────────────
    this.hpLabel = new Label(scene, 16, 12, 'HP', {
      color: cssColor(COLORS.TEXT),
      fontSize: '13px',
    });
    this.healthBar = new ProgressBar(scene, 46, 24, 190, 12, { color: COLORS.HEALTH });
    this.apLabel = new Label(scene, 16, 30, 'AR', { color: cssColor(0x3a6cff), fontSize: '13px' });
    this.armorBar = new ProgressBar(scene, 46, 42, 190, 8, { color: 0x3a6cff });
    this.armorBar.setValue(0);

    // ── Money (under armor) ──────────────────────────────────────────────────
    this.moneyLabel = new Label(scene, 16, 56, `$${PLAYER.START_MONEY}`, {
      color: cssColor(COLORS.MONEY),
      fontSize: '18px',
    });

    // ── Vehicle health + speedometer (hidden until driving) ──────────────────
    this.vehicleBar = new ProgressBar(scene, 16, 86, 190, 10, { color: COLORS.ACCENT });
    this.vehicleBar.setVisible(false);
    this.speedLabel = new Label(scene, GAME_WIDTH - 150, GAME_HEIGHT - 96, '', {
      color: cssColor(COLORS.TEXT),
      fontSize: '20px',
    });
    this.speedLabel.setVisible(false);

    // ── Wanted stars + clock (top-right) ─────────────────────────────────────
    this.clockLabel = new Label(scene, GAME_WIDTH - 92, 14, DEFAULT_HUD_STATE.timeLabel, {
      color: cssColor(COLORS.TEXT),
      fontSize: '18px',
    });
    this.regionLabel = new Label(scene, GAME_WIDTH - 250, 42, 'TEHRAN / DOWNTOWN', {
      color: cssColor(COLORS.ACCENT),
      fontSize: '12px',
    });
    const starsWidth = WANTED.MAX_LEVEL * STAR_SPACING;
    this.starGraphics = scene.add.graphics({ x: GAME_WIDTH - 16 - starsWidth, y: 52 });

    // ── Weapon panel (bottom-right) ──────────────────────────────────────────
    this.weaponIcon = scene.add
      .image(GAME_WIDTH - 148, GAME_HEIGHT - 50, TextureKeys.IconFist)
      .setOrigin(0, 0.5)
      .setDisplaySize(ICON_SIZE, ICON_SIZE)
      .setVisible(false);
    this.weaponName = new Label(scene, GAME_WIDTH - 108, GAME_HEIGHT - 64, '', {
      color: cssColor(COLORS.TEXT),
      fontSize: '15px',
    });
    this.ammoLabel = new Label(scene, GAME_WIDTH - 108, GAME_HEIGHT - 44, '', {
      color: cssColor(COLORS.ACCENT),
      fontSize: '16px',
    });
    this.reloadLabel = new Label(scene, GAME_WIDTH - 108, GAME_HEIGHT - 24, '', {
      color: cssColor(COLORS.HEALTH),
      fontSize: '13px',
    });

    // ── Mission banner (centred, top) ────────────────────────────────────────
    this.missionBanner = new Label(scene, GAME_WIDTH / 2, 74, '', {
      color: cssColor(COLORS.ACCENT),
      fontSize: '20px',
    });

    // ── Objective compass arrow (under the banner) ───────────────────────────
    this.compass = scene.add.graphics({ x: GAME_WIDTH / 2, y: 110 });
    this.compass.fillStyle(COLORS.ACCENT, 0.95);
    this.compass.fillTriangle(12, 0, -6, -7, -6, 7);
    this.compass.fillStyle(COLORS.BACKGROUND, 0.5);
    this.compass.fillTriangle(6, 0, -2, -3, -2, 3);
    this.compass.setVisible(false);

    this.interactionPrompt = new Label(scene, GAME_WIDTH / 2, GAME_HEIGHT - 166, '', {
      color: cssColor(COLORS.ACCENT),
      fontSize: '16px',
      backgroundColor: '#11131d',
      padding: { x: 10, y: 5 },
    });
    this.interactionPrompt.setVisible(false);

    // ── Toast (centred, bottom) ──────────────────────────────────────────────
    this.toastLabel = new Label(scene, GAME_WIDTH / 2, GAME_HEIGHT - 120, '', {
      color: cssColor(COLORS.TEXT),
      fontSize: '18px',
    });
    this.toastLabel.setVisible(false);

    this.snappArrivalPanel = scene.add.container(GAME_WIDTH / 2, 132);
    const arrivalBg = scene.add.graphics();
    arrivalBg.fillStyle(0x071a1d, 0.98);
    arrivalBg.lineStyle(2, 0x13c8bc, 1);
    arrivalBg.fillRoundedRect(-270, -52, 540, 104, 10);
    arrivalBg.strokeRoundedRect(-270, -52, 540, 104, 10);
    const arrivalTitle = new Label(scene, -250, -42, t('phoneSnappDriverArrived'), {
      color: '#f2ffff', fontSize: '17px', fontStyle: 'bold', fixedWidth: 500,
    });
    this.snappArrivalDetail = new Label(scene, -250, -16, '', {
      color: '#a8c3c5', fontSize: '12px', fixedWidth: 500,
    });
    this.snappArrivalOpen = new Button(scene, 150, 28, {
      text: t('phoneSnappOpen'), width: 122, height: 44,
      onClick: () => {
        const phone = ServiceLocator.tryResolve<PhoneManager>(ServiceKeys.Phone);
        if (!phone?.openPhoneToApp('snapp')) phone?.openPhone();
        this.hideSnappArrival();
      },
    });
    this.snappArrivalDismiss = new Button(scene, 34, 28, {
      text: t('phoneSnappDismiss'), width: 104, height: 44,
      onClick: () => this.hideSnappArrival(),
    });
    this.snappArrivalPanel.add([arrivalBg, arrivalTitle, this.snappArrivalDetail, this.snappArrivalDismiss, this.snappArrivalOpen]);
    this.snappArrivalPanel.setDepth(DepthLayers.Overlay + 20);
    this.snappArrivalPanel.setVisible(false);

    this.add([
      this.hpLabel,
      this.healthBar,
      this.apLabel,
      this.armorBar,
      this.moneyLabel,
      this.vehicleBar,
      this.speedLabel,
      this.clockLabel,
      this.regionLabel,
      this.starGraphics,
      this.weaponIcon,
      this.weaponName,
      this.ammoLabel,
      this.reloadLabel,
      this.missionBanner,
      this.compass,
      this.interactionPrompt,
      this.toastLabel,
    ]);
    this.add(this.snappArrivalPanel);

    this.applyDefaultState();
    this.registerEvents();
  }

  /** Apply the dedicated safe-area-aware mobile information layout. */
  public setMobileLayout(width: number, height: number, safe: { top: number; right: number; bottom: number; left: number }): void {
    if (!this.mobileMode) return;
    this.viewportWidth = width;
    const left = Math.round(safe.left + 146);
    const top = Math.round(safe.top + 16);
    const right = Math.round(width - safe.right);

    this.hpLabel.setPosition(left, top);
    this.healthBar.setPosition(left + 30, top + 12);
    this.apLabel.setPosition(left, top + 18);
    this.armorBar.setPosition(left + 30, top + 30);
    this.moneyLabel.setPosition(left, top + 43);
    this.vehicleBar.setPosition(left, top + 76);

    this.clockLabel.setPosition(right - 348, top);
    this.starGraphics.setPosition(right - 352, top + 39);
    this.regionLabel.setVisible(false);
    this.interactionPrompt.setVisible(false);

    this.weaponIcon.setPosition(right - 438, top + 26);
    this.weaponName.setPosition(right - 398, top + 10);
    this.ammoLabel.setPosition(right - 398, top + 30);
    this.reloadLabel.setPosition(right - 398, top + 50);
    this.speedLabel.setPosition(Math.round(width / 2 + 104), top + 4);

    this.missionBanner.setPosition(Math.round(width / 2), top + 70);
    this.compass.setPosition(Math.round(width / 2), top + 108);
    this.toastLabel.setPosition(Math.round(width / 2), Math.round(height - safe.bottom - 182));
    this.snappArrivalPanel.setPosition(Math.round(width / 2), Math.round(safe.top + 136));
    this.snappArrivalPanel.setScale(Math.min(1, Math.max(0.72, (width - safe.left - safe.right - 24) / 560)));
    this.centerHorizontally(this.missionBanner);
    this.centerHorizontally(this.toastLabel);
  }

  /** Render all widgets from {@link DEFAULT_HUD_STATE}. */
  private applyDefaultState(): void {
    const { health, maxHealth, wanted } = DEFAULT_HUD_STATE;
    this.healthBar.setValue(maxHealth > 0 ? health / maxHealth : 0);
    this.wantedLevel = wanted;
    this.drawStars();
  }

  public setVitals(vitals: PlayerVitalsSnapshot): void {
    this.healthBar.setValue(vitals.maxHP > 0 ? vitals.currentHP / vitals.maxHP : 0);
    this.armorBar.setValue(vitals.maxArmor > 0 ? vitals.armor / vitals.maxArmor : 0);
  }

  /** Render the actual inventory wallet when the HUD is created after a save load. */
  public setMoney(total: number): void {
    this.moneyLabel.setText(`$${Math.max(0, Math.round(total))}`);
  }

  /** Subscribe to every HUD-relevant event, retaining unsubscribe handles. */
  private registerEvents(): void {
    this.unsubscribes.push(
      eventBus.on(EventKeys.PlayerVitalsChanged, (p) => {
        this.setVitals(p);
      }),
      eventBus.on(EventKeys.MoneyChanged, (p) => {
        this.setMoney(p.total);
      }),
      eventBus.on(EventKeys.WantedChanged, (p) => {
        this.wantedLevel = p.level;
        this.drawStars();
      }),
      eventBus.on(EventKeys.WantedSearchChanged, (p) => {
        this.searching = p.searching;
        this.blinkMs = 0;
        this.starsVisible = true;
        this.drawStars();
      }),
      eventBus.on(EventKeys.WeaponSwitched, (p) => {
        this.showWeapon(p.weaponId);
      }),
      eventBus.on(EventKeys.WeaponAmmoChanged, (p) => {
        this.ammoLabel.setText(p.ammo < 0 ? INFINITY : `${p.ammo} / ${p.reserve}`);
      }),
      eventBus.on(EventKeys.WeaponReloadStarted, () => {
        this.reloadLabel.setText('RELOADING…');
      }),
      eventBus.on(EventKeys.WeaponReloadFinished, () => {
        this.reloadLabel.setText('');
      }),
      eventBus.on(EventKeys.PlayerEnteredVehicle, () => {
        this.vehicleBar.setValue(1);
        this.vehicleBar.setVisible(true);
        this.speedLabel.setVisible(true);
      }),
      eventBus.on(EventKeys.PlayerExitedVehicle, () => {
        this.vehicleBar.setVisible(false);
        this.speedLabel.setVisible(false);
      }),
      eventBus.on(EventKeys.VehicleDamaged, (p) => {
        const ratio = p.maxHealth > 0 ? p.health / p.maxHealth : 0;
        this.vehicleBar.setValue(Phaser.Math.Clamp(ratio, 0, 1));
      }),
      eventBus.on(EventKeys.MissionStarted, (p) => {
        this.setBanner(p.title, false);
      }),
      eventBus.on(EventKeys.MissionObjectiveChanged, (p) => {
        const suffix = p.total > 0 ? ` (${p.progress}/${p.total})` : '';
        this.setBanner(`${p.text}${suffix}`, false);
      }),
      eventBus.on(EventKeys.MissionCompleted, () => {
        this.setBanner('Mission complete', true);
      }),
      eventBus.on(EventKeys.MissionFailed, (p) => {
        this.setBanner(`Mission failed: ${p.reason}`, true);
      }),
      eventBus.on(EventKeys.UIToast, (p) => {
        this.showToast(p.message, p.durationMs ?? DEFAULT_TOAST_MS);
      }),
      eventBus.on(EventKeys.InteractionPromptChanged, (p) => {
        this.setInteractionPrompt(p.text);
      }),
      eventBus.on(EventKeys.UIHudUpdate, (p) => {
        if (p.timeLabel !== undefined) {
          this.clockLabel.setText(p.timeLabel);
        }
      }),
      eventBus.on(EventKeys.SnappDriverArrived, (payload) => this.showSnappArrival(payload)),
    );
  }

  private showSnappArrival(payload: {
    bookingId: string;
    walkingDistancePx: number;
    pickupAnchorLabel: string;
  }): void {
    if (this.snappArrivalBookings.has(payload.bookingId)) return;
    this.snappArrivalBookings.add(payload.bookingId);
    const walking = Math.round(payload.walkingDistancePx * 1000 / TRANSIT_PIXELS_PER_KILOMETER);
    this.snappArrivalDetail.setText(
      walking > 1
        ? `${t('phoneSnappMeetAt')} ${payload.pickupAnchorLabel}  •  ${walking} m away`
        : `${t('phoneSnappMeetAt')} ${payload.pickupAnchorLabel}`,
    );
    this.snappArrivalPanel.setVisible(true);
    const settings = ServiceLocator.tryResolve<import('@/managers/SettingsManager').SettingsManager>(ServiceKeys.Settings)?.settings as Readonly<{ reducedMotion?: boolean }> | undefined;
    const reduced = settings?.reducedMotion === true;
    this.uiScene.tweens.killTweensOf(this.snappArrivalPanel);
    this.snappArrivalPanel.setAlpha(reduced ? 1 : 0);
    if (!reduced) this.uiScene.tweens.add({ targets: this.snappArrivalPanel, alpha: 1, duration: 180, ease: 'Cubic.Out' });
    eventBus.emit(EventKeys.AudioPlaySound, { key: 'snapp-driver-arrived', volume: 0.8 });
    ServiceLocator.tryResolve<MobilePlatform>(ServiceKeys.Platform)?.vibrate(18);
  }

  private hideSnappArrival(): void {
    this.uiScene.tweens.killTweensOf(this.snappArrivalPanel);
    this.snappArrivalPanel.setVisible(false);
  }

  /** Update the regional locator without coupling HUD code to world state. */
  public setRegion(name: string, district: string, color: number): void {
    this.regionLabel.setText(name + ' / ' + district.toUpperCase());
    this.regionLabel.setColor(cssColor(color));
  }

  /**
   * Push the current vehicle speed (px/sec) each frame while driving; the
   * speedometer shows a pseudo-km/h readout.
   * @param speedPxSec Signed vehicle speed in px/sec.
   */
  public setVehicleSpeed(speedPxSec: number): void {
    if (!this.speedLabel.visible) return;
    const kmh = Math.round(Math.abs(speedPxSec) * SPEED_SCALE);
    this.speedLabel.setText(`${kmh} km/h`);
  }

  /**
   * Point (or hide) the objective compass arrow and advance the searching-star
   * blink. Must be called every frame by the UI scene.
   * @param angle Screen-space direction to the target in radians, or null.
   * @param delta Frame delta in ms (for the blink timer).
   */
  public setObjectiveArrow(angle: number | null, delta: number): void {
    if (angle === null) {
      this.compass.setVisible(false);
    } else {
      this.compass.setVisible(true);
      this.compass.setRotation(angle);
    }

    if (this.searching) {
      this.blinkMs += delta;
      if (this.blinkMs >= BLINK_MS) {
        this.blinkMs = 0;
        this.starsVisible = !this.starsVisible;
        this.drawStars();
      }
    }
  }

  /** Update the weapon panel to reflect the equipped weapon. */
  private showWeapon(weaponId: string): void {
    const table = WEAPONS as Record<string, WeaponDef>;
    const def = table[weaponId];
    if (!def) {
      this.weaponIcon.setVisible(false);
      this.weaponName.setText('');
      return;
    }
    this.weaponIcon.setTexture(def.iconKey);
    this.weaponIcon.setDisplaySize(ICON_SIZE, ICON_SIZE);
    this.weaponIcon.setVisible(true);
    this.weaponName.setText(def.name);
    this.reloadLabel.setText('');
  }

  /** Redraw the wanted-level star row (honouring the search blink). */
  private drawStars(): void {
    const filled = Phaser.Math.Clamp(Math.round(this.wantedLevel), 0, WANTED.MAX_LEVEL);
    this.starGraphics.clear();
    const dim = this.searching && !this.starsVisible;
    for (let i = 0; i < WANTED.MAX_LEVEL; i += 1) {
      const cx = i * STAR_SPACING + STAR_RADIUS;
      const on = i < filled && !dim;
      this.starGraphics.fillStyle(on ? COLORS.ACCENT : COLORS.UI_BORDER, 1);
      this.paintStar(cx, 0, STAR_RADIUS);
    }
  }

  /** Fill a five-pointed star into {@link starGraphics}. */
  private paintStar(cx: number, cy: number, radius: number): void {
    const points = 5;
    const inner = radius * 0.45;
    this.starGraphics.beginPath();
    for (let i = 0; i < points * 2; i += 1) {
      const r = i % 2 === 0 ? radius : inner;
      const angle = (Math.PI * i) / points - Math.PI / 2;
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;
      if (i === 0) {
        this.starGraphics.moveTo(x, y);
      } else {
        this.starGraphics.lineTo(x, y);
      }
    }
    this.starGraphics.closePath();
    this.starGraphics.fillPath();
  }

  /** Set the mission banner text, recentre it and optionally auto-clear it. */
  private setBanner(text: string, autoHide: boolean): void {
    this.bannerTimer?.remove(false);
    this.bannerTimer = undefined;
    this.missionBanner.setText(text);
    this.centerHorizontally(this.missionBanner);
    if (autoHide && text.length > 0) {
      this.bannerTimer = this.uiScene.time.delayedCall(BANNER_CLEAR_MS, () => {
        this.missionBanner.setText('');
        this.bannerTimer = undefined;
      });
    }
  }

  /** Show a transient toast that fades out over its lifetime. */
  private showToast(message: string, durationMs: number): void {
    this.toastTween?.stop();
    this.toastTween = undefined;
    this.toastLabel.setText(message);
    this.centerHorizontally(this.toastLabel);
    this.toastLabel.setAlpha(1);
    this.toastLabel.setVisible(true);
    this.toastTween = this.uiScene.tweens.add({
      targets: this.toastLabel,
      alpha: 0,
      delay: Math.max(0, durationMs - 400),
      duration: 400,
      onComplete: () => {
        this.toastLabel.setVisible(false);
        this.toastTween = undefined;
      },
    });
  }

  /** Show or hide the contextual interaction prompt. */
  private setInteractionPrompt(text: string | null): void {
    if (this.mobileMode) {
      this.interactionPrompt.setVisible(false);
      return;
    }
    if (!text) {
      this.interactionPrompt.setVisible(false);
      return;
    }
    this.interactionPrompt.setText(text);
    this.centerHorizontally(this.interactionPrompt);
    this.interactionPrompt.setVisible(true);
  }

  /** Horizontally centre a label around the screen midpoint. */
  private centerHorizontally(label: Label): void {
    const width = label.getBounds().width;
    label.setX(Math.round(this.viewportWidth / 2 - width / 2));
  }

  /** Release every subscription/timer, then tear down the container. */
  public override destroy(fromScene?: boolean): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes.length = 0;
    this.bannerTimer?.remove(false);
    this.bannerTimer = undefined;
    this.toastTween?.stop();
    this.toastTween = undefined;
    this.snappArrivalBookings.clear();
    this.uiScene.tweens.killTweensOf(this.snappArrivalPanel);
    super.destroy(fromScene);
  }
}
