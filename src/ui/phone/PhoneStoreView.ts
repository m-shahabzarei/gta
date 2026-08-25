import Phaser from 'phaser';
import { COLORS } from '@/config/Constants';
import { t } from '@/config/Strings';
import { UIComponent } from '@/ui/UIComponent';
import { Button, Label } from '@/ui/components';
import type { PhoneAppContext, PhoneAppDefinition } from '@/phone/PhoneTypes';

/** Store catalog content rendered inside the existing Phone shell. */
export class PhoneStoreView extends UIComponent {
  private readonly symbol: Phaser.GameObjects.Graphics;
  private readonly message: Label;
  private readonly hint: Label;
  private readonly catalogContainer: Phaser.GameObjects.Container;
  private readonly context: PhoneAppContext;
  private catalog: PhoneAppDefinition[] = [];

  constructor(scene: Phaser.Scene, context: PhoneAppContext) {
    super(scene);
    this.context = context;
    this.symbol = scene.add.graphics();
    this.message = new Label(scene, 0, 0, t('phoneStoreEmpty'), {
      fontSize: '14px',
      fontStyle: 'bold',
      color: `#${COLORS.TEXT.toString(16).padStart(6, '0')}`,
      align: 'center',
    });
    this.hint = new Label(scene, 0, 0, t('phoneStoreCatalogHint'), {
      fontSize: '11px',
      color: `#${COLORS.UI_BORDER.toString(16).padStart(6, '0')}`,
      align: 'center',
    });
    this.catalogContainer = scene.add.container();
    this.add([this.symbol, this.message, this.hint, this.catalogContainer]);
    this.setData('accessibility-label', t('phoneStore'));
    this.layout(240, 400);
  }

  /** Refit catalog or empty state to the shell's current screen rectangle. */
  public layout(width: number, height: number): this {
    const compact = width < 160;
    const centreX = Math.round(width / 2);
    this.catalog = this.context.listCatalogApps();
    const empty = this.catalog.length === 0;
    this.message.setVisible(empty);
    this.hint.setVisible(empty && !compact);
    this.catalogContainer.setVisible(!empty);
    const iconY = Math.round(height * (compact ? 0.2 : 0.39));
    this.message.setText(compact ? t('phoneStoreEmptyCompact') : t('phoneStoreEmpty'));
    this.hint.setText(compact ? t('phoneStoreCatalogHintCompact') : t('phoneStoreCatalogHint'));
    this.drawSymbol(Math.max(18, Math.min(34, width * 0.14)), centreX, iconY);
    this.message.setPosition(
      Math.round(centreX - this.message.getBounds().width / 2),
      iconY + (compact ? 22 : 42),
    );
    this.hint.setPosition(Math.round(centreX - this.hint.getBounds().width / 2), iconY + 68);
    this.renderCatalog(width, height, centreX);
    return this;
  }

  private renderCatalog(width: number, height: number, centreX: number): void {
    this.catalogContainer.removeAll(true);
    if (this.catalog.length === 0) return;
    const buttonWidth = Math.max(96, width - 28);
    const startY = Math.max(72, Math.round(height * 0.2));
    this.catalog.forEach((app, index) => {
      const row = this.uiScene.add.container(centreX, startY + index * 68);
      const icon = this.uiScene.add.graphics();
      app.renderIcon?.(icon, 10);
      icon.setPosition(-buttonWidth / 2 + 20, 0);
      const title = new Label(
        this.uiScene,
        -buttonWidth / 2 + 38,
        -16,
        app.titleKey ? t(app.titleKey) : app.title,
        {
          fontSize: '12px',
          fontStyle: 'bold',
          color: `#${COLORS.TEXT.toString(16).padStart(6, '0')}`,
        },
      );
      const subtitle = new Label(this.uiScene, -buttonWidth / 2 + 38, 4, t('phoneStoreInstallHint'), {
        fontSize: '10px',
        color: `#${COLORS.UI_BORDER.toString(16).padStart(6, '0')}`,
      });
      const button = new Button(this.uiScene, buttonWidth / 2 - 38, 0, {
        text: t('phoneInstall'),
        width: 76,
        height: 48,
        onClick: () => {
          if (!this.context.installApp(app.id)) return;
          this.context.refreshInstalledApps();
          this.context.navigateHome();
        },
      });
      button.setData('accessibility-label', `${t('phoneInstall')} ${app.title}`);
      row.add([icon, title, subtitle, button]);
      this.catalogContainer.add(row);
    });
  }

  private drawSymbol(size: number, x: number, y: number): void {
    const half = size;
    this.symbol.clear();
    this.symbol.setPosition(x, y);
    this.symbol.lineStyle(Math.max(2, Math.round(size * 0.1)), COLORS.ACCENT, 1);
    this.symbol.strokeRoundedRect(-half, -half * 0.52, half * 2, half * 1.18, Math.max(3, size * 0.16));
    this.symbol.lineBetween(-half * 0.42, -half * 0.52, -half * 0.42, -half * 0.88);
    this.symbol.lineBetween(half * 0.42, -half * 0.52, half * 0.42, -half * 0.88);
    this.symbol.lineBetween(-half * 0.42, -half * 0.88, half * 0.42, -half * 0.88);
    this.symbol.fillStyle(COLORS.ACCENT, 1);
    this.symbol.fillRect(-half * 0.55, half * 0.02, half * 0.22, half * 0.22);
    this.symbol.fillRect(-half * 0.11, half * 0.02, half * 0.22, half * 0.22);
    this.symbol.fillRect(half * 0.33, half * 0.02, half * 0.22, half * 0.22);
  }
}
