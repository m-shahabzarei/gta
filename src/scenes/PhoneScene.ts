/** Modal in-game phone shell. It owns UI only; gameplay stays in GameScene. */
import Phaser from 'phaser';
import { SceneKeys } from '@/config/SceneKeys';
import { ServiceKeys } from '@/config/ServiceKeys';
import { DepthLayers } from '@/config/DepthLayers';
import { ServiceLocator } from '@/core/ServiceLocator';
import type { MobilePlatform } from '@/platform';
import type { PhoneAppDefinition } from '@/phone/PhoneTypes';
import type { PhoneManager } from '@/managers/PhoneManager';
import type { SettingsManager } from '@/managers/SettingsManager';
import { PhoneShell } from '@/ui/phone';

/** Modal scrim opacity that keeps the phone visually separate from the world. */
const SCRIM_ALPHA = 0.58;

export class PhoneScene extends Phaser.Scene {
  private phoneManager: PhoneManager | null = null;
  private platform: MobilePlatform | null = null;
  private scrim: Phaser.GameObjects.Rectangle | null = null;
  private shell: PhoneShell | null = null;
  private layoutUnsub: (() => void) | null = null;
  private activeApp: PhoneAppDefinition | null = null;
  private activeAppView: Phaser.GameObjects.GameObject | null = null;
  private closing = false;
  private reducedMotion = false;

  constructor() {
    super({ key: SceneKeys.Phone });
  }

  /** Build one shell instance and claim every pointer in the overlay scene. */
  public create(): void {
    this.closing = false;
    this.phoneManager = ServiceLocator.tryResolve<PhoneManager>(ServiceKeys.Phone);
    this.platform = ServiceLocator.tryResolve<MobilePlatform>(ServiceKeys.Platform);
    this.reducedMotion = this.prefersReducedMotion();
    this.input.setTopOnly(true);
    this.input.keyboard?.on('keydown-ESC', this.onEscape, this);
    this.input.keyboard?.on('keydown-BACKSPACE', this.onEscape, this);
    this.input.keyboard?.on('keydown-N', this.onEscape, this);

    // A phone opening always gives the cursor back to the browser and releases
    // any gameplay pointer lock before the first frame is rendered.
    this.input.setDefaultCursor('default');
    this.input.mouse?.releasePointerLock();
    this.game.canvas.style.cursor = 'default';

    this.scrim = this.add
      .rectangle(0, 0, this.scale.width, this.scale.height, 0x000000, 0)
      .setOrigin(0)
      .setDepth(DepthLayers.Overlay)
      .setInteractive();
    this.scrim.on(
      Phaser.Input.Events.POINTER_DOWN,
      (_pointer: Phaser.Input.Pointer, _x: number, _y: number, event: Phaser.Types.Input.EventData) => {
        event.stopPropagation();
      },
    );

    this.shell = new PhoneShell(this, { onClose: () => this.beginClose() });
    const apps = this.phoneManager?.registry.listAvailable({ scene: this }) ?? [];
    this.shell.setApps(apps, (app) => this.openApp(app));
    this.layoutUnsub = this.platform?.onLayoutChanged(() => this.applyLayout()) ?? null;
    this.applyLayout();
    this.startOpenTransition();

    this.scene.bringToTop();
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.onShutdown, this);
  }

  /** Tick only the active future app; the v1 registry has no active app. */
  public override update(time: number, delta: number): void {
    if (!this.activeApp || !this.activeApp.update) return;
    this.activeApp.update(this.appContext(), time, delta);
  }

  private applyLayout(): void {
    const layout = this.platform?.isMobile
      ? this.platform.layout(this)
      : {
          width: this.scale.width,
          height: this.scale.height,
          safe: { top: 0, right: 0, bottom: 0, left: 0 },
        };
    this.scrim?.setSize(layout.width, layout.height);
    this.shell?.layout(layout.width, layout.height, layout.safe);
  }

  private startOpenTransition(): void {
    const scrim = this.scrim;
    const shell = this.shell;
    if (!scrim || !shell) return;
    shell.setAlpha(0);
    shell.setScale(0.88);
    scrim.setAlpha(0);
    this.tweens.add({
      targets: scrim,
      alpha: SCRIM_ALPHA,
      duration: this.reducedMotion ? 1 : 220,
      ease: 'Cubic.Out',
    });
    this.tweens.add({
      targets: shell,
      alpha: 1,
      scale: 1,
      duration: this.reducedMotion ? 1 : 220,
      ease: 'Cubic.Out',
    });
  }

  /** Escape and the visible close affordance share one interruptible path. */
  private beginClose(): void {
    if (this.closing) return;
    this.closing = true;
    this.preflightPointerLockRestore();
    const scrim = this.scrim;
    const shell = this.shell;
    this.tweens.killTweensOf([scrim, shell]);
    if (!scrim || !shell) {
      this.finishClose();
      return;
    }

    let completed = 0;
    const finish = (): void => {
      completed += 1;
      if (completed === 2) this.finishClose();
    };
    this.tweens.add({
      targets: scrim,
      alpha: 0,
      duration: this.reducedMotion ? 1 : 150,
      ease: 'Cubic.In',
      onComplete: finish,
    });
    this.tweens.add({
      targets: shell,
      alpha: 0,
      scale: 0.94,
      duration: this.reducedMotion ? 1 : 150,
      ease: 'Cubic.In',
      onComplete: finish,
    });
  }

  private finishClose(): void {
    if (!this.phoneManager?.closePhone()) this.scene.stop(SceneKeys.Phone);
  }

  /** Request pointer-lock restoration while a close click is still a gesture. */
  private preflightPointerLockRestore(): void {
    const ui = this.scene.get(SceneKeys.UI);
    try {
      ui?.input.mouse?.requestPointerLock();
    } catch {
      // Escape or browser policy may reject this; UIScene retries on resume.
    }
  }

  private openApp(app: PhoneAppDefinition): void {
    this.navigateHome();
    this.activeApp = app;
    const context = this.appContext();
    app.onOpen?.({ ...context, app });
    const view = app.createView?.(context) ?? null;
    if (!view) return;
    this.add.existing(view);
    this.activeAppView = view;
  }

  private navigateHome(): void {
    if (this.activeApp) {
      const app = this.activeApp;
      app.onClose?.({ ...this.appContext(), app });
    }
    this.activeAppView?.destroy();
    this.activeAppView = null;
    this.activeApp = null;
  }

  private appContext() {
    return {
      scene: this,
      navigateHome: (): void => this.navigateHome(),
      closePhone: (): void => this.beginClose(),
    };
  }

  private onEscape(): void {
    this.beginClose();
  }

  private prefersReducedMotion(): boolean {
    const settings = ServiceLocator.tryResolve<SettingsManager>(ServiceKeys.Settings)?.settings as
      Readonly<{ reducedMotion?: boolean }> | undefined;
    if (settings?.reducedMotion === true) return true;
    return typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  private onShutdown(): void {
    this.input.keyboard?.off('keydown-ESC', this.onEscape, this);
    this.input.keyboard?.off('keydown-BACKSPACE', this.onEscape, this);
    this.input.keyboard?.off('keydown-N', this.onEscape, this);
    this.layoutUnsub?.();
    this.layoutUnsub = null;
    this.tweens.killTweensOf([this.scrim, this.shell]);
    this.navigateHome();
    this.shell?.destroy();
    this.scrim?.destroy();
    this.shell = null;
    this.scrim = null;
    this.phoneManager = null;
    this.platform = null;
  }
}
