import Phaser from 'phaser';
import { COLORS } from '@/config/Constants';
import { DepthLayers } from '@/config/DepthLayers';
import { t } from '@/config/Strings';
import { UIComponent } from '@/ui/UIComponent';
import { Button, Label } from '@/ui/components';
import type { PhoneAppDefinition, PhonePresentationMode } from '@/phone/PhoneTypes';

/** Safe-area values in the scene's logical coordinate space. */
export interface PhoneShellSafeArea {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Pixel-art phone shell configuration. */
export interface PhoneShellConfig {
  onClose: () => void;
}

const BODY_RATIO = 9 / 16;
const MAX_BODY_HEIGHT = 640;
const OUTER_GUTTER = 16;
const BODY_RADIUS = 24;
const SCREEN_RADIUS = 14;

function cssColor(value: number): string {
  return '#' + value.toString(16).padStart(6, '0');
}

/** Reusable dark, portrait phone frame and home-screen chrome. */
export class PhoneShell extends UIComponent {
  private readonly bodyGfx = this.uiScene.add.graphics();
  private readonly screen = this.uiScene.add.graphics();
  private readonly details = this.uiScene.add.graphics();
  private readonly appGrid = this.uiScene.add.container();
  private readonly appViewContainer = this.uiScene.add.container();
  /** Hidden stencil geometry matching the physical screen opening. */
  private screenMaskShape: Phaser.GameObjects.Graphics | null = null;
  private screenMask: Phaser.Display.Masks.GeometryMask | null = null;
  private readonly screenMaskTransform = new Phaser.GameObjects.Components.TransformMatrix();
  private readonly screenMaskParentTransform = new Phaser.GameObjects.Components.TransformMatrix();
  private readonly title = new Label(this.uiScene, 0, 0, 'PIXEL CITY', {
    fontSize: '12px',
    fontStyle: 'bold',
    color: cssColor(COLORS.TEXT),
  });
  private readonly status = new Label(this.uiScene, 0, 0, t('phoneReady'), {
    fontSize: '11px',
    color: cssColor(COLORS.ACCENT),
  });
  private readonly emptyState = new Label(this.uiScene, 0, 0, t('phoneNoApps'), {
    fontSize: '14px',
    fontStyle: 'bold',
    color: cssColor(COLORS.TEXT),
    align: 'center',
  });
  private readonly emptyHint = new Label(this.uiScene, 0, 0, t('phoneRegistryReady'), {
    fontSize: '11px',
    color: cssColor(COLORS.UI_BORDER),
    align: 'center',
  });
  private readonly backButton: Button;
  private readonly closeButton: Button;
  private apps: readonly PhoneAppDefinition[] = [];
  private onAppOpen: ((app: PhoneAppDefinition) => void) | null = null;
  private mountedView: Phaser.GameObjects.GameObject | null = null;
  private homeVisible = true;
  private screenWidth = 0;
  private screenHeight = 0;
  private screenOriginX = 0;
  private screenOriginY = 0;
  /** Last presentation requested by PhoneScene; preserves mode across shell relayouts. */
  private presentationMode: PhonePresentationMode = 'portrait';
  private lastLayout = {
    width: 1280,
    height: 720,
    safe: { top: 0, right: 0, bottom: 0, left: 0 } as PhoneShellSafeArea,
  };

  constructor(scene: Phaser.Scene, config: PhoneShellConfig) {
    super(scene);
    this.setDepth(DepthLayers.Overlay + 10);
    this.setScrollFactor(0);

    this.closeButton = new Button(scene, 0, 0, {
      text: t('phoneClose'),
      width: 88,
      height: 48,
      onClick: config.onClose,
    });
    this.closeButton.setDepth(DepthLayers.Overlay + 11);
    this.closeButton.setData('accessibility-label', t('phoneClose'));
    this.backButton = new Button(scene, 0, 0, {
      text: t('phoneBack'),
      width: 88,
      height: 48,
    });
    this.backButton.setDepth(DepthLayers.Overlay + 11);
    this.backButton.setData('accessibility-label', t('phoneBack'));
    this.backButton.setEnabled(false);

    this.add([
      this.bodyGfx,
      this.screen,
      this.details,
      this.title,
      this.status,
      this.emptyState,
      this.emptyHint,
      this.appGrid,
      this.appViewContainer,
      this.backButton,
      this.closeButton,
    ]);
    this.layout(1280, 720, { top: 0, right: 0, bottom: 0, left: 0 });
    this.uiScene.events.on(Phaser.Scenes.Events.UPDATE, this.syncScreenMaskTransform, this);
  }

  /** Refit the body and all child controls inside safe insets. */
  public layout(
    width: number,
    height: number,
    safe: PhoneShellSafeArea,
    presentationMode: PhonePresentationMode = 'portrait',
  ): this {
    this.presentationMode = presentationMode;
    this.lastLayout = { width, height, safe: { ...safe } };
    const availableWidth = Math.max(120, width - safe.left - safe.right - OUTER_GUTTER * 2);
    const availableHeight = Math.max(180, height - safe.top - safe.bottom - OUTER_GUTTER * 2);
    let bodyHeight: number;
    let bodyWidth: number;
    if (presentationMode === 'landscape-fullscreen') {
      // This is an in-game wide presentation, not browser fullscreen. The
      // shell stays upright and reflows its content into the usable viewport.
      bodyWidth = Math.max(104, Math.min(availableWidth, Math.floor(availableWidth / 8) * 8));
      bodyHeight = Math.max(160, Math.min(availableHeight, Math.floor(availableHeight / 8) * 8));
    } else {
      bodyHeight = Math.min(MAX_BODY_HEIGHT, availableHeight);
      bodyWidth = bodyHeight * BODY_RATIO;
      if (bodyWidth > availableWidth) {
        bodyWidth = availableWidth;
        bodyHeight = bodyWidth / BODY_RATIO;
      }
      // Keep the procedural art aligned to the project's pixel grid where the
      // available viewport allows it, while never overflowing a small screen.
      bodyWidth = Math.max(104, Math.min(availableWidth, Math.round(bodyWidth / 8) * 8));
      bodyHeight = Math.max(160, Math.min(availableHeight, Math.round(bodyHeight / 8) * 8));
    }
    const centerX = (safe.left + width - safe.right) / 2;
    const centerY = (safe.top + height - safe.bottom) / 2;
    this.setPosition(Math.round(centerX), Math.round(centerY));

    this.screenWidth = Math.max(64, bodyWidth - 32);
    this.screenHeight = Math.max(96, bodyHeight - 112);
    const compact = this.screenWidth < 144;
    if (this.homeVisible) this.title.setText(compact ? t('phoneTitleCompact') : t('title'));
    this.status.setVisible(this.homeVisible && !compact);
    this.emptyState.setText(compact ? t('phoneNoAppsCompact') : t('phoneNoApps'));
    this.emptyHint.setText(compact ? t('phoneRegistryReadyCompact') : t('phoneRegistryReady'));
    this.emptyState.setVisible(this.homeVisible && this.apps.length === 0);
    this.emptyHint.setVisible(this.homeVisible && this.apps.length === 0);
    const screenX = -this.screenWidth / 2;
    const screenY = -bodyHeight / 2 + 64;
    this.screenOriginX = screenX;
    this.screenOriginY = screenY;

    this.bodyGfx.clear();
    this.bodyGfx.fillStyle(0x06070d, 1);
    this.bodyGfx.fillRoundedRect(-bodyWidth / 2, -bodyHeight / 2, bodyWidth, bodyHeight, BODY_RADIUS);
    this.bodyGfx.lineStyle(4, COLORS.UI_BORDER, 1);
    this.bodyGfx.strokeRoundedRect(-bodyWidth / 2, -bodyHeight / 2, bodyWidth, bodyHeight, BODY_RADIUS);

    this.screen.clear();
    this.screen.fillStyle(COLORS.BACKGROUND, 1);
    this.screen.fillRoundedRect(screenX, screenY, this.screenWidth, this.screenHeight, SCREEN_RADIUS);
    this.screen.lineStyle(2, COLORS.UI_BORDER, 1);
    this.screen.strokeRoundedRect(screenX, screenY, this.screenWidth, this.screenHeight, SCREEN_RADIUS);
    this.rebuildScreenMask(screenX, screenY);

    this.details.clear();
    this.details.fillStyle(COLORS.UI_BORDER, 1);
    this.details.fillRoundedRect(-24, -bodyHeight / 2 + 22, 48, 4, 2);
    this.details.fillCircle(bodyWidth / 2 - 30, -bodyHeight / 2 + 24, 3);
    this.details.fillStyle(COLORS.TEXT, 0.92);
    this.details.fillRoundedRect(-28, bodyHeight / 2 - 24, 56, 4, 2);

    this.title.setPosition(
      screenX + (this.homeVisible ? 14 : compact ? 8 : 104),
      screenY + 12,
    );
    this.status.setPosition(screenX + this.screenWidth - 92, screenY + 12);
    this.emptyState.setPosition(
      screenX + (this.screenWidth - this.emptyState.getBounds().width) / 2,
      screenY + this.screenHeight * 0.48 - 12,
    );
    this.emptyHint.setPosition(
      screenX + (this.screenWidth - this.emptyHint.getBounds().width) / 2,
      screenY + this.screenHeight * 0.48 + 18,
    );
    this.backButton.setPosition(
      compact && !this.homeVisible ? screenX + this.screenWidth / 2 : screenX + 52,
      compact && !this.homeVisible ? screenY + this.screenHeight - 26 : screenY + 36,
    );
    this.backButton.setEnabled(!this.homeVisible);
    this.closeButton.setPosition(bodyWidth / 2 - 58, -bodyHeight / 2 + 42);
    this.appViewContainer.setPosition(screenX, screenY);
    this.appGrid.setVisible(this.homeVisible);
    this.appGrid.setActive(this.homeVisible);
    this.appViewContainer.setVisible(!this.homeVisible);
    this.appViewContainer.setActive(!this.homeVisible);
    this.redrawAppGrid(this.screenOriginX, this.screenOriginY);
    this.layoutMountedView();
    return this;
  }

  /** Recreate the screen stencil so relayout cannot retain stale geometry. */
  private rebuildScreenMask(screenX: number, screenY: number): void {
    this.appViewContainer.clearMask(false);
    this.appGrid.clearMask(false);
    this.screenMask?.destroy();
    this.screenMask = null;
    if (this.screenMaskShape) {
      this.screenMaskShape.destroy();
      this.screenMaskShape = null;
    }
    const shape = this.uiScene.make.graphics({ x: 0, y: 0 }, false);
    shape.setScrollFactor(0);
    shape.fillStyle(0xffffff, 1);
    shape.fillRoundedRect(screenX, screenY, this.screenWidth, this.screenHeight, SCREEN_RADIUS);
    this.screenMaskShape = shape;
    this.screenMask = shape.createGeometryMask();
    this.appViewContainer.setMask(this.screenMask);
    this.appGrid.setMask(this.screenMask);
    this.syncScreenMaskTransform();
  }

  /**
   * GeometryMask renders its source without the target Container's parent
   * matrix. Keep the off-list stencil aligned to the shell's world transform.
   */
  private syncScreenMaskTransform(): void {
    const shape = this.screenMaskShape;
    if (!shape || !this.scene) return;
    const transform = this.getWorldTransformMatrix(
      this.screenMaskTransform,
      this.screenMaskParentTransform,
    ).decomposeMatrix();
    shape
      .setPosition(transform.translateX, transform.translateY)
      .setRotation(transform.rotation)
      .setScale(transform.scaleX, transform.scaleY);
  }

  /** Render installed apps generically; the built-in Store is the first entry. */
  public setApps(apps: readonly PhoneAppDefinition[], onOpen: (app: PhoneAppDefinition) => void): this {
    this.apps = apps;
    this.onAppOpen = onOpen;
    this.emptyState.setVisible(this.homeVisible && apps.length === 0);
    this.emptyHint.setVisible(this.homeVisible && apps.length === 0);
    this.redrawAppGrid(this.screenOriginX, this.screenOriginY);
    return this;
  }

  /** Mount one app view inside the existing screen and expose a hierarchical Back control. */
  public mountAppView(
    view: Phaser.GameObjects.GameObject,
    title: string,
    onBack: () => void,
  ): this {
    this.appViewContainer.removeAll(false);
    this.appViewContainer.add(view);
    this.mountedView = view;
    this.homeVisible = false;
    this.title.setText(title);
    this.backButton.setOnClick(onBack);
    this.layout(this.lastLayout.width, this.lastLayout.height, this.lastLayout.safe, this.presentationMode);
    return this;
  }

  /** Return the shell to Home without destroying the app view owner. */
  public showHome(): this {
    this.appViewContainer.removeAll(false);
    this.mountedView = null;
    this.homeVisible = true;
    this.title.setText(t('title'));
    this.backButton.setOnClick(() => undefined);
    this.emptyState.setVisible(this.apps.length === 0);
    this.emptyHint.setVisible(this.apps.length === 0);
    this.layoutMountedView();
    this.layout(this.lastLayout.width, this.lastLayout.height, this.lastLayout.safe, this.presentationMode);
    return this;
  }

  /** Whether the shell is currently presenting an app view rather than Home. */
  public get isShowingApp(): boolean {
    return !this.homeVisible;
  }

  private layoutMountedView(): void {
    if (!this.mountedView) return;
    const candidate = this.mountedView as unknown as {
      layout?: (width: number, height: number) => void;
    };
    candidate.layout?.(this.screenWidth, this.screenHeight);
  }

  public override destroy(fromScene?: boolean): void {
    this.uiScene.events.off(Phaser.Scenes.Events.UPDATE, this.syncScreenMaskTransform, this);
    this.appViewContainer.clearMask(false);
    this.appGrid.clearMask(false);
    this.screenMask?.destroy();
    this.screenMask = null;
    if (this.screenMaskShape) {
      this.screenMaskShape.destroy();
      this.screenMaskShape = null;
    }
    this.screenMaskTransform.destroy();
    this.screenMaskParentTransform.destroy();
    super.destroy(fromScene);
  }

  private redrawAppGrid(screenX: number, screenY: number): void {
    this.appGrid.removeAll(true);
    if (this.apps.length === 0 || this.screenWidth <= 0) return;
    const columns = this.screenWidth >= 190 ? 2 : 1;
    const gap = 8;
    const buttonWidth = Math.max(64, (this.screenWidth - gap * (columns + 1)) / columns);
    const buttonHeight = 56;
    this.apps.forEach((app, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const button = new Button(this.uiScene, 0, 0, {
        text: app.titleKey ? t(app.titleKey) : app.title,
        width: buttonWidth,
        height: buttonHeight,
        onClick: () => this.onAppOpen?.(app),
      });
      button.setData('accessibility-label', app.titleKey ? t(app.titleKey) : app.title);
      button.setPosition(
        screenX + gap + buttonWidth / 2 + column * (buttonWidth + gap),
        screenY + 72 + row * (buttonHeight + gap),
      );
      const icon = this.uiScene.add.graphics();
      icon.setPosition(0, -18);
      if (app.renderIcon) {
        app.renderIcon(icon, 14);
      } else if (app.iconKey && this.uiScene.textures.exists(app.iconKey)) {
        const image = this.uiScene.add.image(0, -18, app.iconKey).setDisplaySize(20, 20);
        button.add(image);
      }
      button.add(icon);
      this.appGrid.add(button);
    });
  }
}
