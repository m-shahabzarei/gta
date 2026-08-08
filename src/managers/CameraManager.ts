/**
 * Scene-bound manager that owns the main camera for the active scene.
 *
 * It centralises every camera operation the game needs — follow/unfollow,
 * bounds, zoom (instant or tweened), screen shake, colour flash, centring and
 * relative panning — behind a small, guard-checked API. Other systems can also
 * drive the camera indirectly by emitting {@link EventKeys.CameraShake},
 * {@link EventKeys.CameraFlash} or {@link EventKeys.CameraZoom}, which this
 * manager subscribes to.
 *
 * The concrete {@link Phaser.Cameras.Scene2D.Camera} only exists while a scene
 * is attached, so every method no-ops (with a debug log) when no camera is
 * bound instead of throwing.
 */
import Phaser from 'phaser';
import { BaseSceneManager } from '@/core/BaseSceneManager';
import { ServiceLocator } from '@/core/ServiceLocator';
import { ServiceKeys } from '@/config/ServiceKeys';
import { EventKeys } from '@/config/EventKeys';
import { CAMERA } from '@/config/Constants';
import { clamp, hexToRgb } from '@/utils';

export class CameraManager extends BaseSceneManager {
  /** Service-locator key for this manager. */
  public readonly key = ServiceKeys.Camera;

  /** The active scene's main camera, or `null` while detached. */
  private cam: Phaser.Cameras.Scene2D.Camera | null = null;

  /** Wire up the event-driven camera controls. */
  protected onInit(): void {
    // Event-driven shakes honour the player's screen-shake preference; the
    // direct `shake()` method is left unconditional for deliberate callers.
    this.subscribe(EventKeys.CameraShake, (p) => {
      if (this.screenShakeEnabled()) this.shake(p.durationMs, p.intensity);
    });
    this.subscribe(EventKeys.CameraFlash, (p) => this.flash(p.durationMs, p.color));
    this.subscribe(EventKeys.CameraZoom, (p) => this.setZoom(p.zoom, p.durationMs));
  }

  /** Whether the screen-shake setting is enabled (default true). */
  private screenShakeEnabled(): boolean {
    const settings = ServiceLocator.tryResolve(ServiceKeys.Settings) as unknown as {
      settings?: { screenShake?: boolean };
    } | null;
    return settings?.settings?.screenShake ?? true;
  }

  /** Bind to the scene's main camera and apply default framing. */
  protected onAttach(scene: Phaser.Scene): void {
    this.cam = scene.cameras.main;
    this.cam.setRoundPixels(true);
    this.cam.setZoom(CAMERA.DEFAULT_ZOOM);
  }

  /** Release the camera reference on scene teardown. */
  protected override onDetach(_scene: Phaser.Scene): void {
    this.cam = null;
  }

  /** The bound camera, or `null` when no scene is attached. */
  public get camera(): Phaser.Cameras.Scene2D.Camera | null {
    return this.cam;
  }

  /** Smoothly follow a game object; `lerp` overrides the default follow speed. */
  public follow(target: Phaser.GameObjects.GameObject, lerp?: number): void {
    if (!this.cam) {
      this.log.debug('follow ignored: no camera attached');
      return;
    }
    const l = lerp ?? CAMERA.LERP;
    this.cam.startFollow(target, true, l, l);
  }

  /** Stop following the current target. */
  public stopFollow(): void {
    if (!this.cam) {
      this.log.debug('stopFollow ignored: no camera attached');
      return;
    }
    this.cam.stopFollow();
  }

  /** Constrain the camera to the given world rectangle. */
  public setBounds(x: number, y: number, w: number, h: number): void {
    if (!this.cam) {
      this.log.debug('setBounds ignored: no camera attached');
      return;
    }
    this.cam.setBounds(x, y, w, h);
  }

  /**
   * Set the zoom, clamped to the configured range. When `durationMs > 0` the
   * change is tweened; otherwise it is applied instantly.
   */
  public setZoom(zoom: number, durationMs?: number): void {
    if (!this.cam) {
      this.log.debug('setZoom ignored: no camera attached');
      return;
    }
    const z = clamp(zoom, CAMERA.MIN_ZOOM, CAMERA.MAX_ZOOM);
    if (durationMs !== undefined && durationMs > 0) {
      this.cam.zoomTo(z, durationMs);
    } else {
      this.cam.setZoom(z);
    }
  }

  /** Shake the camera for `durationMs`; `intensity` defaults to a subtle jolt. */
  public shake(durationMs: number, intensity?: number): void {
    if (!this.cam) {
      this.log.debug('shake ignored: no camera attached');
      return;
    }
    this.cam.shake(durationMs, intensity ?? 0.01);
  }

  /** Flash the screen for `durationMs`; `color` (0xRRGGBB) defaults to white. */
  public flash(durationMs: number, color?: number): void {
    if (!this.cam) {
      this.log.debug('flash ignored: no camera attached');
      return;
    }
    if (color !== undefined) {
      const { r, g, b } = hexToRgb(color);
      this.cam.flash(durationMs, r, g, b);
    } else {
      this.cam.flash(durationMs);
    }
  }

  /** Center the camera on a world coordinate. */
  public centerOn(x: number, y: number): void {
    if (!this.cam) {
      this.log.debug('centerOn ignored: no camera attached');
      return;
    }
    this.cam.centerOn(x, y);
  }

  /** Pan the camera by a relative offset in world pixels. */
  public panBy(dx: number, dy: number): void {
    if (!this.cam) {
      this.log.debug('panBy ignored: no camera attached');
      return;
    }
    this.cam.setScroll(this.cam.scrollX + dx, this.cam.scrollY + dy);
  }
}
