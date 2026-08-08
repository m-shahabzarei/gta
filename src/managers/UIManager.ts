/**
 * UIManager — scene-bound owner of the heads-up display and transient UI.
 *
 * A single instance lives for the whole game and re-binds to whichever gameplay
 * scene is active. On {@link onAttach} it builds a fresh {@link HUD} and paints
 * the last-known {@link HudState}; on {@link onDetach} it drops its reference and
 * lets the scene destroy its own display objects. Phase 2 systems never touch
 * the HUD directly — they emit {@link EventKeys.UIHudUpdate} / {@link EventKeys.UIToast}
 * (etc.) and this manager fans those events out to the presentational layer.
 */

import type Phaser from 'phaser';

import { EventKeys } from '@/config/EventKeys';
import { ServiceKeys } from '@/config/ServiceKeys';
import { GAME_HEIGHT, GAME_WIDTH } from '@/config/Constants';
import { DepthLayers } from '@/config/DepthLayers';
import { DEFAULT_HUD_STATE, type HudState } from '@/core/types';
import { BaseSceneManager } from '@/core/BaseSceneManager';
import { HUD } from '@/ui/hud/HUD';
import { Label } from '@/ui/components/Label';

/**
 * Manages the on-screen HUD and short-lived overlay messages (toasts) for the
 * active scene.
 */
export class UIManager extends BaseSceneManager {
  /** Service-locator key for this manager. */
  public readonly key = ServiceKeys.UI;

  /** The HUD bound to the current scene, or `null` while detached. */
  private hudInstance: HUD | null = null;

  /** The most recent HUD snapshot; re-applied whenever a new HUD is built. */
  private hudState: HudState = { ...DEFAULT_HUD_STATE };

  /**
   * Subscribes to the global UI events so gameplay code can drive the HUD and
   * toasts without holding a reference to this manager.
   */
  protected onInit(): void {
    this.subscribe(EventKeys.UIHudUpdate, (payload) => this.updateHud(payload));
    this.subscribe(EventKeys.UIToast, (payload) => this.toast(payload.message, payload.durationMs));
    this.subscribe(EventKeys.UIShowHud, () => this.showHud());
    this.subscribe(EventKeys.UIHideHud, () => this.hideHud());
  }

  /**
   * Builds the HUD for the newly-attached scene and applies the cached state.
   */
  protected override onAttach(scene: Phaser.Scene): void {
    this.hudInstance = new HUD(scene);
    this.hudInstance.setHudState(this.hudState);
  }

  /**
   * Drops the HUD reference. The scene destroys its own display objects on
   * shutdown, so no explicit teardown is required here.
   */
  protected override onDetach(_scene: Phaser.Scene): void {
    this.hudInstance = null;
  }

  /** The HUD bound to the current scene, or `null` while detached. */
  public get hud(): HUD | null {
    return this.hudInstance;
  }

  /** Reveals the HUD, if one is currently built. */
  public showHud(): void {
    this.hudInstance?.show();
  }

  /** Hides the HUD without destroying it. */
  public hideHud(): void {
    this.hudInstance?.hide();
  }

  /**
   * Replaces the entire HUD state and repaints.
   * @param state The full HUD snapshot to display.
   */
  public setHud(state: HudState): void {
    this.hudState = state;
    this.hudInstance?.setHudState(state);
  }

  /**
   * Merges `partial` over the cached HUD state and repaints. Only the supplied
   * fields change; everything else keeps its last value.
   * @param partial The subset of HUD fields to update.
   */
  public updateHud(partial: Partial<HudState>): void {
    this.hudState = { ...this.hudState, ...partial };
    this.hudInstance?.setHudState(this.hudState);
  }

  /**
   * Shows a transient message near the bottom-centre of the screen, then fades
   * and destroys it. No-op when the manager is not attached to a scene.
   * @param message The text to display.
   * @param durationMs How long the toast stays fully visible before fading.
   */
  public toast(message: string, durationMs = 2000): void {
    const scene = this.scene;
    if (!scene) return;

    const label = new Label(scene, GAME_WIDTH / 2, GAME_HEIGHT - 80, message, {
      align: 'center',
    });
    label.setScrollFactor(0);
    label.setDepth(DepthLayers.Overlay);

    scene.time.delayedCall(durationMs, () => {
      scene.tweens.add({
        targets: label,
        alpha: 0,
        duration: 300,
        onComplete: () => label.destroy(),
      });
    });
  }
}
