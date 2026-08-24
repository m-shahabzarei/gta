import Phaser from 'phaser';
import { COLORS } from '@/config/Constants';
import { DepthLayers } from '@/config/DepthLayers';
import { UIComponent } from '@/ui/UIComponent';
import { Button, Label } from '@/ui/components';
import type { PhoneAppDefinition } from '@/phone/PhoneTypes';

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
  private readonly title = new Label(this.uiScene, 0, 0, 'PIXEL CITY', {
    fontSize: '12px',
    fontStyle: 'bold',
    color: cssColor(COLORS.TEXT),
  });
  private readonly status = new Label(this.uiScene, 0, 0, 'PHONE READY', {
    fontSize: '11px',
    color: cssColor(COLORS.ACCENT),
  });
  private readonly emptyState = new Label(this.uiScene, 0, 0, 'NO APPS AVAILABLE', {
    fontSize: '14px',
    fontStyle: 'bold',
    color: cssColor(COLORS.TEXT),
    align: 'center',
  });
  private readonly emptyHint = new Label(this.uiScene, 0, 0, 'APP REGISTRY READY', {
    fontSize: '11px',
    color: cssColor(COLORS.UI_BORDER),
    align: 'center',
  });
  private readonly closeButton: Button;
  private apps: readonly PhoneAppDefinition[] = [];
  private onAppOpen: ((app: PhoneAppDefinition) => void) | null = null;
  private screenWidth = 0;
  private screenHeight = 0;
  private screenOriginX = 0;
  private screenOriginY = 0;

  constructor(scene: Phaser.Scene, config: PhoneShellConfig) {
    super(scene);
    this.setDepth(DepthLayers.Overlay + 10);
    this.setScrollFactor(0);

    this.closeButton = new Button(scene, 0, 0, {
      text: 'CLOSE',
      width: 88,
      height: 48,
      onClick: config.onClose,
    });
    this.closeButton.setDepth(DepthLayers.Overlay + 11);

    this.add([
      this.bodyGfx,
      this.screen,
      this.details,
      this.title,
      this.status,
      this.emptyState,
      this.emptyHint,
      this.appGrid,
      this.closeButton,
    ]);
    this.layout(1280, 720, { top: 0, right: 0, bottom: 0, left: 0 });
  }

  /** Refit the portrait body and all child controls inside safe insets. */
  public layout(width: number, height: number, safe: PhoneShellSafeArea): this {
    const availableWidth = Math.max(120, width - safe.left - safe.right - OUTER_GUTTER * 2);
    const availableHeight = Math.max(180, height - safe.top - safe.bottom - OUTER_GUTTER * 2);
    let bodyHeight = Math.min(MAX_BODY_HEIGHT, availableHeight);
    let bodyWidth = bodyHeight * BODY_RATIO;
    if (bodyWidth > availableWidth) {
      bodyWidth = availableWidth;
      bodyHeight = bodyWidth / BODY_RATIO;
    }

    // Keep the procedural art aligned to the project's pixel grid where the
    // available viewport allows it, while never overflowing a small screen.
    bodyWidth = Math.max(104, Math.round(bodyWidth / 8) * 8);
    bodyHeight = Math.max(184, Math.round(bodyHeight / 8) * 8);
    const centerX = (safe.left + width - safe.right) / 2;
    const centerY = (safe.top + height - safe.bottom) / 2;
    this.setPosition(Math.round(centerX), Math.round(centerY));

    this.screenWidth = Math.max(64, bodyWidth - 32);
    this.screenHeight = Math.max(96, bodyHeight - 112);
    const compact = this.screenWidth < 144;
    this.title.setText(compact ? 'PIXEL' : 'PIXEL CITY');
    this.status.setVisible(!compact);
    this.emptyState.setText(compact ? 'NO APPS' : 'NO APPS AVAILABLE');
    this.emptyHint.setText(compact ? 'READY' : 'APP REGISTRY READY');
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

    this.details.clear();
    this.details.fillStyle(COLORS.UI_BORDER, 1);
    this.details.fillRoundedRect(-24, -bodyHeight / 2 + 22, 48, 4, 2);
    this.details.fillCircle(bodyWidth / 2 - 30, -bodyHeight / 2 + 24, 3);
    this.details.fillStyle(COLORS.TEXT, 0.92);
    this.details.fillRoundedRect(-28, bodyHeight / 2 - 24, 56, 4, 2);

    this.title.setPosition(screenX + 14, screenY + 12);
    this.status.setPosition(screenX + this.screenWidth - 92, screenY + 12);
    this.emptyState.setPosition(
      screenX + (this.screenWidth - this.emptyState.getBounds().width) / 2,
      screenY + this.screenHeight * 0.48 - 12,
    );
    this.emptyHint.setPosition(
      screenX + (this.screenWidth - this.emptyHint.getBounds().width) / 2,
      screenY + this.screenHeight * 0.48 + 18,
    );
    this.closeButton.setPosition(bodyWidth / 2 - 58, -bodyHeight / 2 + 42);
    this.redrawAppGrid(this.screenOriginX, this.screenOriginY);
    return this;
  }

  /** Render registered apps generically; v1 passes an empty list. */
  public setApps(apps: readonly PhoneAppDefinition[], onOpen: (app: PhoneAppDefinition) => void): this {
    this.apps = apps;
    this.onAppOpen = onOpen;
    this.emptyState.setVisible(apps.length === 0);
    this.emptyHint.setVisible(apps.length === 0);
    this.redrawAppGrid(this.screenOriginX, this.screenOriginY);
    return this;
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
        text: app.title,
        width: buttonWidth,
        height: buttonHeight,
        onClick: () => this.onAppOpen?.(app),
      });
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
