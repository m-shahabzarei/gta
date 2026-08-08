import Phaser from 'phaser';
import { BaseManager } from '@/core/BaseManager';
import { ServiceKeys } from '@/config/ServiceKeys';
import { ServiceLocator } from '@/core/ServiceLocator';
import type { InputManager } from '@/managers/InputManager';

export interface SafeAreaInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface MobileLayout {
  width: number;
  height: number;
  safe: SafeAreaInsets;
}

type LayoutListener = () => void;

let cachedMobileEnvironment: boolean | undefined;

/** Resolve mobile/touch capability once; it is stable for the page lifetime. */
export function detectMobileEnvironment(): boolean {
  if (cachedMobileEnvironment !== undefined) return cachedMobileEnvironment;
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    cachedMobileEnvironment = false;
    return false;
  }

  const touch = navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const noHover = window.matchMedia?.('(hover: none)').matches ?? false;
  const nav = navigator as Navigator & { userAgentData?: { mobile?: boolean } };
  const mobileUserAgent =
    nav.userAgentData?.mobile === true ||
    /Android|webOS|iPhone|iPad|iPod|IEMobile|Opera Mini/i.test(navigator.userAgent);

  cachedMobileEnvironment = touch && (coarse || noHover || mobileUserAgent);
  return cachedMobileEnvironment;
}

/** Cached browser-platform state shared by scale, input, and mobile UI. */
export class MobilePlatform extends BaseManager {
  public readonly key = ServiceKeys.Platform;

  public readonly isMobile = detectMobileEnvironment();

  private portrait = false;
  private rawSafeArea: SafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  private readonly layoutListeners = new Set<LayoutListener>();
  private safeAreaProbe: HTMLDivElement | null = null;
  private orientationOverlay: HTMLDivElement | null = null;
  private resumeLoopOnLandscape = false;

  private readonly handleLayoutChange = (): void => this.refreshLayout();
  private readonly handleGesture = (): void => this.tryLockLandscape();

  public get isPortrait(): boolean {
    return this.portrait;
  }

  public get isGameplayBlocked(): boolean {
    return this.isMobile && this.portrait;
  }

  protected onInit(): void {
    if (!this.isMobile || typeof document === 'undefined') return;

    document.documentElement.classList.add('mobile-game');
    this.safeAreaProbe = document.createElement('div');
    this.safeAreaProbe.className = 'safe-area-probe';
    document.body.appendChild(this.safeAreaProbe);

    this.orientationOverlay = document.createElement('div');
    this.orientationOverlay.className = 'orientation-overlay';
    this.orientationOverlay.setAttribute('role', 'status');
    this.orientationOverlay.setAttribute('aria-live', 'polite');
    this.orientationOverlay.innerHTML =
      '<div class="orientation-phone" aria-hidden="true"><span></span></div>' +
      '<strong>ROTATE DEVICE</strong><p>This game plays in landscape.</p>';
    document.body.appendChild(this.orientationOverlay);

    window.addEventListener('resize', this.handleLayoutChange, { passive: true });
    window.addEventListener('orientationchange', this.handleLayoutChange, { passive: true });
    this.game.scale.on(Phaser.Scale.Events.RESIZE, this.handleLayoutChange);
    window.addEventListener('pointerdown', this.handleGesture, { once: true, passive: true });
    this.refreshLayout();
  }

  /** Convert CSS safe-area pixels to the active Phaser scene's logical pixels. */
  public layout(scene: Phaser.Scene): MobileLayout {
    const scaleX = Math.max(0.0001, scene.scale.displayScale.x || 1);
    const scaleY = Math.max(0.0001, scene.scale.displayScale.y || 1);
    return {
      width: scene.scale.gameSize.width,
      height: scene.scale.gameSize.height,
      safe: {
        top: this.rawSafeArea.top / scaleY,
        right: this.rawSafeArea.right / scaleX,
        bottom: this.rawSafeArea.bottom / scaleY,
        left: this.rawSafeArea.left / scaleX,
      },
    };
  }

  public onLayoutChanged(listener: LayoutListener): () => void {
    this.layoutListeners.add(listener);
    return () => this.layoutListeners.delete(listener);
  }

  /** Short, optional haptic feedback; unsupported browsers simply ignore it. */
  public vibrate(durationMs: number): void {
    if (!this.isMobile || durationMs <= 0) return;
    try {
      navigator.vibrate?.(durationMs);
    } catch {
      // Vibration is best-effort and may be disabled by the OS/browser.
    }
  }

  private refreshLayout(): void {
    if (!this.isMobile) return;
    const wasPortrait = this.portrait;
    this.portrait = window.innerHeight > window.innerWidth;
    this.readSafeArea();
    this.orientationOverlay?.classList.toggle('visible', this.portrait);

    if (this.portrait) {
      ServiceLocator.tryResolve<InputManager>(ServiceKeys.Input)?.resetTouchInput();
      if (this.game.loop.running) {
        this.resumeLoopOnLandscape = true;
        this.game.loop.sleep();
      }
    } else if (wasPortrait && this.resumeLoopOnLandscape) {
      this.resumeLoopOnLandscape = false;
      this.game.loop.wake();
    }

    for (const listener of this.layoutListeners) listener();
  }

  private readSafeArea(): void {
    const probe = this.safeAreaProbe;
    if (!probe) return;
    const style = getComputedStyle(probe);
    this.rawSafeArea.top = MobilePlatform.cssPixels(style.paddingTop);
    this.rawSafeArea.right = MobilePlatform.cssPixels(style.paddingRight);
    this.rawSafeArea.bottom = MobilePlatform.cssPixels(style.paddingBottom);
    this.rawSafeArea.left = MobilePlatform.cssPixels(style.paddingLeft);
  }

  private tryLockLandscape(): void {
    if (!this.isMobile) return;
    const orientation = screen.orientation as ScreenOrientation & {
      lock?: (orientation: 'landscape') => Promise<void>;
    };
    try {
      void orientation.lock?.('landscape').catch(() => undefined);
    } catch {
      // Orientation locking is commonly restricted to installed/fullscreen apps.
    }
  }

  private static cssPixels(value: string): number {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  }

  protected override onDestroy(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', this.handleLayoutChange);
      window.removeEventListener('orientationchange', this.handleLayoutChange);
      window.removeEventListener('pointerdown', this.handleGesture);
    }
    this.game.scale.off(Phaser.Scale.Events.RESIZE, this.handleLayoutChange);
    this.layoutListeners.clear();
    this.safeAreaProbe?.remove();
    this.orientationOverlay?.remove();
    this.safeAreaProbe = null;
    this.orientationOverlay = null;
    document.documentElement.classList.remove('mobile-game');
  }
}
