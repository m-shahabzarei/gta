/**
 * Heads-up display root component.
 *
 * The HUD is a purely presentational container that renders a {@link HudState}
 * snapshot: a health bar, cash total, in-game clock, equipped-weapon readout,
 * and a police wanted-level star row. It owns no gameplay logic — Phase 2
 * systems push fresh values in through {@link HUD.setHudState} / {@link HUD.applyPartial}
 * (typically fanned out from a `UIHudUpdate` event) and the HUD simply mirrors
 * whatever arrives.
 *
 * Every widget is a child of this container and the container is pinned to the
 * camera (`scrollFactor = 0`, depth {@link DepthLayers.HUD}), so the whole HUD
 * moves and layers as a single unit and never scrolls with the world.
 */

import Phaser from 'phaser';

import { COLORS, GAME_HEIGHT, GAME_WIDTH } from '@/config/Constants';
import { DepthLayers } from '@/config/DepthLayers';
import { DEFAULT_HUD_STATE, type HudState } from '@/core/types';
import { Label, ProgressBar } from '@/ui/components';
import { UIComponent } from '@/ui/UIComponent';
import { clamp } from '@/utils';

/** Screen-edge padding, in pixels. */
const PAD = 16;
/** Maximum number of wanted-level stars the HUD can display. */
const MAX_STARS = 6;
/** Horizontal gap between star centres, in pixels. */
const STAR_SPACING = 30;
/** Outer radius of a single drawn star, in pixels. */
const STAR_RADIUS = 9;
/** Dim colour used for unfilled wanted stars. */
const STAR_EMPTY = COLORS.UI_BORDER;

/** Converts a `0xRRGGBB` colour number into a CSS `#rrggbb` string. */
function cssColor(value: number): string {
  return '#' + value.toString(16).padStart(6, '0');
}

/**
 * Root HUD container. Build once per {@link UIScene} and drive with
 * {@link HUD.setHudState}.
 */
export class HUD extends UIComponent {
  /** Health / max-health ratio bar. */
  private readonly healthBar: ProgressBar;
  /** Static "HP" caption sitting left of the health bar. */
  private readonly hpLabel: Label;
  /** On-hand cash readout (money is prefixed with "$"). */
  private readonly moneyLabel: Label;
  /** Pre-formatted in-game clock, top-right. */
  private readonly clockLabel: Label;
  /** Equipped weapon and ammo readout. */
  private readonly weaponLabel: Label;
  /** Graphics surface the wanted-level stars are drawn onto. */
  private readonly starGfx: Phaser.GameObjects.Graphics;
  /** Local origin of the star row within {@link HUD.starGfx}. */
  private readonly starOriginX: number;

  /** Last applied state; the merge target for {@link HUD.applyPartial}. */
  private cached: HudState;

  /**
   * Builds every child widget, pins the container to the camera, and paints
   * the initial {@link DEFAULT_HUD_STATE}.
   */
  constructor(scene: Phaser.Scene) {
    super(scene, 0, 0);

    this.cached = { ...DEFAULT_HUD_STATE };

    // --- Top-left: health bar + caption ---
    this.hpLabel = new Label(scene, PAD, PAD, 'HP', { fontSize: '14px' });
    this.healthBar = new ProgressBar(scene, PAD + 30, PAD + 1, 180, 16, {
      color: COLORS.HEALTH,
      background: COLORS.UI_PANEL,
    });

    // --- Below health: money ---
    this.moneyLabel = new Label(scene, PAD, PAD + 26, '$0', {
      color: cssColor(COLORS.MONEY),
    });

    // --- Bottom-left: weapon / ammo ---
    this.weaponLabel = new Label(scene, PAD, GAME_HEIGHT - 30, 'Unarmed');

    // --- Top-right: clock ---
    this.clockLabel = new Label(scene, GAME_WIDTH - 96, PAD, DEFAULT_HUD_STATE.timeLabel, {
      fontSize: '18px',
    });

    // --- Top-right, under the clock: wanted-level star row ---
    const rowWidth = (MAX_STARS - 1) * STAR_SPACING;
    this.starOriginX = STAR_RADIUS;
    this.starGfx = scene.add.graphics();
    this.starGfx.setPosition(GAME_WIDTH - PAD - rowWidth - STAR_RADIUS * 2, PAD + 40);

    this.add([
      this.hpLabel,
      this.healthBar,
      this.moneyLabel,
      this.weaponLabel,
      this.clockLabel,
      this.starGfx,
    ]);

    this.setDepth(DepthLayers.HUD);
    this.setScrollFactor(0, 0, true);

    this.setHudState(this.cached);
  }

  /**
   * Replaces the entire HUD state and repaints every widget.
   */
  public setHudState(state: HudState): void {
    this.cached = { ...state };

    const ratio = state.maxHealth > 0 ? state.health / state.maxHealth : 0;
    this.healthBar.setValue(ratio);

    this.moneyLabel.setText('$' + state.money);
    this.clockLabel.setText(state.timeLabel);

    const weaponName = state.weaponLabel ?? 'Unarmed';
    this.weaponLabel.setText(
      state.ammo !== null ? `${weaponName}  ${state.ammo}` : weaponName,
    );

    this.drawStars(Math.round(clamp(state.wanted, 0, MAX_STARS)));
  }

  /**
   * Merges `partial` over the currently cached state and repaints. Only the
   * supplied fields change; everything else keeps its last value.
   */
  public applyPartial(partial: Partial<HudState>): void {
    this.setHudState({ ...this.cached, ...partial });
  }

  /** Reveals the HUD. */
  public show(): void {
    this.setVisible(true);
  }

  /** Hides the HUD without destroying it. */
  public hide(): void {
    this.setVisible(false);
  }

  /**
   * Repaints the wanted-level row so the first `count` stars are filled with
   * the accent colour and the remainder are drawn dim.
   */
  private drawStars(count: number): void {
    this.starGfx.clear();
    for (let i = 0; i < MAX_STARS; i += 1) {
      const cx = this.starOriginX + i * STAR_SPACING;
      const color = i < count ? COLORS.ACCENT : STAR_EMPTY;
      this.starGfx.fillStyle(color, 1);
      this.starGfx.fillPoints(HUD.starPoints(cx, STAR_RADIUS, STAR_RADIUS), true);
    }
  }

  /**
   * Computes the ten vertices of a five-pointed star centred at (`cx`, `cy`)
   * with the given outer radius. The inner radius is a fixed fraction of it.
   */
  private static starPoints(cx: number, cy: number, radius: number): Phaser.Geom.Point[] {
    const points: Phaser.Geom.Point[] = [];
    const inner = radius * 0.42;
    for (let i = 0; i < 10; i += 1) {
      const angle = -Math.PI / 2 + (i * Math.PI) / 5;
      const r = i % 2 === 0 ? radius : inner;
      points.push(new Phaser.Geom.Point(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r));
    }
    return points;
  }
}
