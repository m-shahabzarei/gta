/** Modal in-game phone shell. It owns UI only; gameplay stays in GameScene. */
import Phaser from 'phaser';
import { SceneKeys } from '@/config/SceneKeys';
import { ServiceKeys } from '@/config/ServiceKeys';
import { DepthLayers } from '@/config/DepthLayers';
import { t } from '@/config/Strings';
import { ServiceLocator } from '@/core/ServiceLocator';
import type { MobilePlatform } from '@/platform';
import type { PhoneAppDefinition } from '@/phone/PhoneTypes';
import type { PhonePresentationMode } from '@/phone/PhoneTypes';
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
  private transitioningView: Phaser.GameObjects.GameObject | null = null;
  private appTransition: Phaser.Tweens.Tween | null = null;
  private navigatingHome = false;
  private closing = false;
  private reducedMotion = false;
  /** Presentation belongs to the overlay scene, while apps only request it. */
  private presentationMode: PhonePresentationMode = 'portrait';

  constructor() {
    super({ key: SceneKeys.Phone });
  }

  /** Build one shell instance and claim every pointer in the overlay scene. */
  public create(): void {
    this.closing = false;
    this.presentationMode = 'portrait';
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
    const apps = this.phoneManager?.registry.listInstalled({ scene: this }) ?? [];
    this.shell.setApps(apps, (app) => this.openApp(app));
    const pendingAppId = this.phoneManager?.consumePendingAppId() ?? null;
    this.layoutUnsub = this.platform?.onLayoutChanged(() => this.applyLayout()) ?? null;
    this.applyLayout();
    this.startOpenTransition();
    const pendingApp = pendingAppId ? apps.find((app) => app.id === pendingAppId) : null;
    if (pendingApp) this.openApp(pendingApp);

    this.scene.bringToTop();
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.onShutdown, this);
  }

  /** Tick only the currently mounted phone application. */
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
    this.shell?.layout(layout.width, layout.height, layout.safe, this.presentationMode);
  }

  /** Reflow the mounted Phone in-game; this never invokes browser fullscreen. */
  public setPresentationMode(mode: PhonePresentationMode): void {
    if (this.presentationMode === mode) return;
    this.presentationMode = mode;
    this.applyLayout();
    const shell = this.shell;
    if (!shell || this.reducedMotion) return;
    this.tweens.killTweensOf(shell);
    shell.setScale(0.985);
    this.tweens.add({
      targets: shell,
      scale: 1,
      duration: 180,
      ease: 'Cubic.Out',
    });
  }

  public getPresentationMode(): PhonePresentationMode {
    return this.presentationMode;
  }

  public exitExpandedMode(): void {
    this.setPresentationMode('portrait');
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
    const canvas = this.game.canvas as HTMLCanvasElement & {
      mozRequestPointerLock?: () => void;
      webkitRequestPointerLock?: () => void;
    };
    if (typeof canvas.requestPointerLock !== 'function' &&
      typeof canvas.mozRequestPointerLock !== 'function' &&
      typeof canvas.webkitRequestPointerLock !== 'function') return;
    try {
      const result = ui?.input.mouse?.requestPointerLock() as unknown;
      if (result && typeof result === 'object' && 'catch' in result) {
        void (result as Promise<void>).catch(() => undefined);
      }
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
    this.shell?.mountAppView(view, app.titleKey ? t(app.titleKey) : app.title, () => {
      if (this.presentationMode !== 'portrait') {
        this.exitExpandedMode();
        return;
      }
      this.navigateHome();
    });
    this.transitioningView = view;
    const animatedView = view as Phaser.GameObjects.GameObject & {
      setAlpha?: (alpha: number) => Phaser.GameObjects.GameObject;
      setScale?: (scale: number) => Phaser.GameObjects.GameObject;
    };
    animatedView.setAlpha?.(0);
    animatedView.setScale?.(0.96);
    this.appTransition = this.tweens.add({
      targets: view,
      alpha: 1,
      scale: 1,
      duration: this.reducedMotion ? 1 : 180,
      ease: 'Cubic.Out',
      onComplete: () => {
        this.appTransition = null;
        this.transitioningView = null;
      },
    });
  }

  private refreshInstalledApps(): void {
    const apps = this.phoneManager?.registry.listInstalled({ scene: this }) ?? [];
    this.shell?.setApps(apps, (app) => this.openApp(app));
  }

  private navigateHome(): void {
    if (this.navigatingHome) return;
    if (!this.activeApp) {
      this.shell?.showHome();
      return;
    }
    this.navigatingHome = true;
    this.appTransition?.stop();
    this.appTransition = null;
    if (this.activeApp) {
      const app = this.activeApp;
      app.onClose?.({ ...this.appContext(), app });
    }
    const view = this.activeAppView;
    this.activeAppView = null;
    this.activeApp = null;
    if (!view || this.closing) {
      this.finishNavigateHome(view);
      return;
    }
    this.transitioningView = view;
    this.appTransition = this.tweens.add({
      targets: view,
      alpha: 0,
      scale: 0.97,
      duration: this.reducedMotion ? 1 : 130,
      ease: 'Cubic.In',
      onComplete: () => this.finishNavigateHome(view),
    });
  }

  private finishNavigateHome(view: Phaser.GameObjects.GameObject | null): void {
    this.appTransition = null;
    this.transitioningView = null;
    view?.destroy();
    this.navigatingHome = false;
    this.shell?.showHome();
  }

  private appContext() {
    return {
      scene: this,
      navigateHome: (): void => this.navigateHome(),
      closePhone: (): void => this.beginClose(),
      refreshInstalledApps: (): void => this.refreshInstalledApps(),
      listCatalogApps: (): PhoneAppDefinition[] =>
        this.phoneManager?.registry.listCatalogApps({ scene: this }) ?? [],
      installApp: (appId: string): boolean => this.phoneManager?.installApp(appId) ?? false,
      setPresentationMode: (mode: PhonePresentationMode): void => this.setPresentationMode(mode),
      getPresentationMode: (): PhonePresentationMode => this.presentationMode,
      exitExpandedMode: (): void => this.exitExpandedMode(),
    };
  }

  private onEscape(): void {
    if (this.presentationMode !== 'portrait') {
      this.exitExpandedMode();
      return;
    }
    if (this.activeApp) {
      this.navigateHome();
      return;
    }
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
    this.appTransition?.stop();
    this.appTransition = null;
    // Phaser begins tearing down the scene display list before SHUTDOWN is
    // delivered. Do not call navigateHome() here: it asks PhoneShell to
    // relayout and update Text objects that may already have been destroyed.
    // Dispose the mounted app directly instead, keeping teardown idempotent.
    const app = this.activeApp;
    if (app) app.onClose?.({ ...this.appContext(), app });
    const mountedView = this.activeAppView;
    const transitioningView = this.transitioningView;
    this.activeApp = null;
    mountedView?.destroy();
    this.activeAppView = null;
    if (transitioningView && transitioningView !== mountedView) transitioningView.destroy();
    this.transitioningView = null;
    this.navigatingHome = false;
    this.tweens.killTweensOf([this.scrim, this.shell]);
    this.shell?.destroy();
    this.scrim?.destroy();
    this.shell = null;
    this.scrim = null;
    this.phoneManager = null;
    this.platform = null;
  }
}
