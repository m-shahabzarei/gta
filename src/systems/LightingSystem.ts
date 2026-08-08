/**
 * LightingSystem — a scene-bound engine system that renders the world's ambient
 * lighting as a single full-screen, camera-pinned overlay rectangle.
 *
 * The overlay darkens and tints everything beneath it using a NORMAL blend, so a
 * low-alpha dark colour reads as dusk/night while a warm colour reads as a sunlit
 * or emergency wash. The {@link DayNightSystem} drives the ambient values by
 * emitting {@link EventKeys.LightingChanged}; this system also exposes a one-shot
 * {@link flash} for momentary effects (lightning, explosions, camera pops).
 *
 * Phase 1 ships no art, so the overlay is a plain tinted rectangle rather than a
 * shader/light-pipeline effect; the public surface is stable for Phase 2 upgrades.
 */
import Phaser from 'phaser';
import { BaseSceneManager } from '@/core/BaseSceneManager';
import { ServiceKeys } from '@/config/ServiceKeys';
import { EventKeys } from '@/config/EventKeys';
import { DepthLayers } from '@/config/DepthLayers';
import { GAME_WIDTH, GAME_HEIGHT } from '@/config/Constants';
import { hexToRgb } from '@/utils';

export class LightingSystem extends BaseSceneManager {
  /** Service-locator key for this system. */
  public readonly key = ServiceKeys.Lighting;

  /** The full-screen ambient overlay for the attached scene, if any. */
  private overlay: Phaser.GameObjects.Rectangle | null = null;

  /** Current ambient tint colour (0xRRGGBB). */
  private colorValue = 0x0a0a2a;

  /** Current ambient opacity in the range 0..1. */
  private alphaValue = 0;

  /** The tint colour currently applied to the world overlay. */
  public get ambientColor(): number {
    return this.colorValue;
  }

  /** The opacity currently applied to the world overlay. */
  public get ambientAlpha(): number {
    return this.alphaValue;
  }

  /** Subscribe to day/night lighting changes for the lifetime of the system. */
  protected onInit(): void {
    this.subscribe(EventKeys.LightingChanged, (payload) => {
      // Payload contract: `ambient` is the tint colour (0xRRGGBB) and `tint` is
      // the overlay opacity (0..1). Apply both directly — do NOT flash here, or
      // the per-frame day/night updates would stack into a black screen.
      this.setAmbient(payload.ambient, payload.tint);
    });
    this.log.debug('lighting system ready');
  }

  /**
   * Build the scene-scoped overlay: a camera-pinned, full-screen rectangle sitting
   * on the day/night overlay depth so it covers the world but not the HUD.
   */
  protected onAttach(scene: Phaser.Scene): void {
    const overlay = scene.add.rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, this.colorValue, 1);
    overlay.setOrigin(0, 0);
    overlay.setScrollFactor(0);
    overlay.setDepth(DepthLayers.DayNightOverlay);
    // Multiply preserves authored material contrast while shifting the palette
    // toward amber dusk or cool moonlight; emissive props render above it.
    overlay.setBlendMode(Phaser.BlendModes.MULTIPLY);
    overlay.setAlpha(this.alphaValue);
    this.overlay = overlay;
  }

  /** Release the scene-scoped overlay reference on scene shutdown. */
  protected override onDetach(_scene: Phaser.Scene): void {
    this.overlay = null;
  }

  /**
   * Set the ambient wash. Stores the values so a later {@link onAttach} reuses
   * them, and applies them immediately when an overlay exists.
   */
  public setAmbient(color: number, alpha: number): void {
    this.colorValue = color;
    this.alphaValue = alpha;
    if (this.overlay) {
      this.overlay.setFillStyle(color, 1);
      this.overlay.setAlpha(alpha);
    }
    const rgb = hexToRgb(color);
    this.log.debug(`ambient -> rgb(${rgb.r},${rgb.g},${rgb.b}) @ ${alpha.toFixed(2)}`);
  }

  /**
   * Momentary full-screen colour flash that fades to transparent. Layered just
   * above the ambient overlay and destroyed when the fade completes.
   */
  public flash(color: number, durationMs: number): void {
    const scene = this.scene;
    if (!scene) return;

    const rect = scene.add.rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, color, 1);
    rect.setOrigin(0, 0);
    rect.setScrollFactor(0);
    rect.setDepth(DepthLayers.DayNightOverlay + 1);
    rect.setBlendMode(Phaser.BlendModes.NORMAL);
    rect.setAlpha(0.6);

    scene.tweens.add({
      targets: rect,
      alpha: 0,
      duration: durationMs,
      onComplete: () => rect.destroy(),
    });
  }
}
