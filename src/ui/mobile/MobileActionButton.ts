import Phaser from 'phaser';
import { COLORS } from '@/config/Constants';
import { UIComponent } from '@/ui/UIComponent';

export type MobileButtonIcon =
  | 'attack'
  | 'interact'
  | 'enter'
  | 'exit'
  | 'reload'
  | 'weapon'
  | 'accelerate'
  | 'reverse'
  | 'handbrake'
  | 'horn'
  | 'pause'
  | 'map'
  | 'phone';

export interface MobileActionButtonConfig {
  icon: MobileButtonIcon;
  label: string;
  diameter?: number;
  opacity?: number;
  accent?: number;
  onPress?: (pointer: Phaser.Input.Pointer) => void;
  onRelease?: (pointerId: number) => void;
}

/** A circular, single-pointer-owned mobile action button. */
export class MobileActionButton extends UIComponent {
  private readonly background: Phaser.GameObjects.Graphics;
  private readonly glyph: Phaser.GameObjects.Graphics;
  private icon: MobileButtonIcon;
  private diameter: number;
  private opacity: number;
  private accent: number;
  private pointerId: number | null = null;
  private readonly onPress?: (pointer: Phaser.Input.Pointer) => void;
  private readonly onRelease?: (pointerId: number) => void;

  constructor(scene: Phaser.Scene, config: MobileActionButtonConfig) {
    super(scene);
    this.icon = config.icon;
    this.diameter = config.diameter ?? 96;
    this.opacity = config.opacity ?? 0.62;
    this.accent = config.accent ?? COLORS.ACCENT;
    this.onPress = config.onPress;
    this.onRelease = config.onRelease;
    this.background = scene.add.graphics();
    this.glyph = scene.add.graphics();
    this.add([this.background, this.glyph]);
    this.setData('accessibility-label', config.label);
    this.installHitArea();
    this.redraw(false);

    this.on(
      Phaser.Input.Events.POINTER_DOWN,
      (pointer: Phaser.Input.Pointer, _x: number, _y: number, event: Phaser.Types.Input.EventData) => {
        if (this.pointerId !== null) return;
        event.stopPropagation();
        this.pointerId = pointer.id;
        this.setScale(0.92);
        this.redraw(true);
        this.onPress?.(pointer);
      },
    );
  }

  public get activePointerId(): number | null {
    return this.pointerId;
  }

  public setIcon(icon: MobileButtonIcon, label?: string): this {
    if (this.icon !== icon) {
      this.icon = icon;
      this.redraw(this.pointerId !== null);
    }
    if (label) this.setData('accessibility-label', label);
    return this;
  }

  public setDiameter(diameter: number): this {
    this.diameter = Math.max(56, diameter);
    this.installHitArea();
    this.redraw(this.pointerId !== null);
    return this;
  }

  public setControlOpacity(opacity: number): this {
    this.opacity = Phaser.Math.Clamp(opacity, 0.3, 0.9);
    this.redraw(this.pointerId !== null);
    return this;
  }

  /** Release only the pointer that owns this control. */
  public releasePointer(pointerId: number): boolean {
    if (this.pointerId !== pointerId) return false;
    this.pointerId = null;
    this.onRelease?.(pointerId);
    this.uiScene.tweens.add({
      targets: this,
      scale: 1,
      duration: 90,
      ease: 'Quad.Out',
    });
    this.redraw(false);
    return true;
  }

  public cancel(): void {
    if (this.pointerId === null) return;
    const pointerId = this.pointerId;
    this.pointerId = null;
    this.onRelease?.(pointerId);
    this.setScale(1);
    this.redraw(false);
  }

  private installHitArea(): void {
    const radius = this.diameter * 0.5;
    if (this.input) {
      this.input.hitArea = new Phaser.Geom.Circle(0, 0, radius);
      this.input.hitAreaCallback = Phaser.Geom.Circle.Contains;
    } else {
      this.setInteractive(new Phaser.Geom.Circle(0, 0, radius), Phaser.Geom.Circle.Contains);
    }
  }

  private redraw(pressed: boolean): void {
    const radius = this.diameter * 0.5;
    const alpha = pressed ? Math.min(0.94, this.opacity + 0.18) : this.opacity;
    this.background.clear();
    this.background.fillStyle(COLORS.UI_PANEL, alpha);
    this.background.fillCircle(0, 0, radius);
    this.background.lineStyle(Math.max(2, this.diameter * 0.025), pressed ? this.accent : COLORS.TEXT, pressed ? 1 : 0.72);
    this.background.strokeCircle(0, 0, radius - 2);
    this.glyph.clear();
    this.drawGlyph(this.glyph, this.icon, this.diameter * 0.25, pressed ? this.accent : COLORS.TEXT);
  }

  private drawGlyph(
    g: Phaser.GameObjects.Graphics,
    icon: MobileButtonIcon,
    size: number,
    color: number,
  ): void {
    const s = size;
    g.lineStyle(Math.max(3, s * 0.13), color, 1);
    g.fillStyle(color, 1);
    switch (icon) {
      case 'attack':
        g.strokeCircle(0, 0, s * 0.65);
        g.strokeCircle(0, 0, s * 0.18);
        g.lineBetween(-s, 0, -s * 0.42, 0);
        g.lineBetween(s * 0.42, 0, s, 0);
        g.lineBetween(0, -s, 0, -s * 0.42);
        g.lineBetween(0, s * 0.42, 0, s);
        break;
      case 'interact':
        g.strokeCircle(0, -s * 0.3, s * 0.24);
        g.strokeRoundedRect(-s * 0.55, -s * 0.02, s * 1.1, s * 0.82, s * 0.18);
        g.lineBetween(-s * 0.7, s * 0.82, s * 0.7, s * 0.82);
        break;
      case 'enter':
      case 'exit': {
        g.strokeRoundedRect(-s * 0.9, -s * 0.25, s * 1.35, s * 0.72, s * 0.16);
        g.strokeCircle(-s * 0.55, s * 0.5, s * 0.18);
        g.strokeCircle(s * 0.15, s * 0.5, s * 0.18);
        const direction = icon === 'enter' ? -1 : 1;
        const x0 = direction * s * 0.92;
        const x1 = direction * s * 0.28;
        g.lineBetween(x0, -s * 0.65, x1, -s * 0.65);
        g.lineBetween(x0, -s * 0.65, x0 - direction * s * 0.3, -s * 0.9);
        g.lineBetween(x0, -s * 0.65, x0 - direction * s * 0.3, -s * 0.4);
        break;
      }
      case 'reload':
        g.beginPath();
        g.arc(0, 0, s * 0.7, -Math.PI * 0.15, Math.PI * 1.45);
        g.strokePath();
        g.fillTriangle(-s * 0.78, -s * 0.12, -s * 0.34, -s * 0.16, -s * 0.55, s * 0.2);
        break;
      case 'weapon':
        g.fillRoundedRect(-s * 0.8, -s * 0.32, s * 1.45, s * 0.48, s * 0.08);
        g.fillRect(-s * 0.34, s * 0.05, s * 0.38, s * 0.68);
        g.fillRect(s * 0.55, -s * 0.2, s * 0.38, s * 0.18);
        break;
      case 'accelerate':
        g.lineBetween(-s * 0.62, s * 0.6, 0, -s * 0.65);
        g.lineBetween(0, -s * 0.65, s * 0.62, s * 0.6);
        g.lineBetween(-s * 0.62, s * 0.05, 0, -s * 0.95);
        g.lineBetween(0, -s * 0.95, s * 0.62, s * 0.05);
        break;
      case 'reverse':
        g.lineBetween(-s * 0.62, -s * 0.55, 0, s * 0.55);
        g.lineBetween(0, s * 0.55, s * 0.62, -s * 0.55);
        g.lineBetween(-s * 0.62, 0, 0, s * 0.9);
        g.lineBetween(0, s * 0.9, s * 0.62, 0);
        break;
      case 'handbrake':
        g.strokeCircle(0, 0, s * 0.78);
        g.lineBetween(-s * 0.36, -s * 0.5, -s * 0.36, s * 0.5);
        g.lineBetween(s * 0.36, -s * 0.5, s * 0.36, s * 0.5);
        g.lineBetween(-s * 0.36, 0, s * 0.36, 0);
        break;
      case 'horn':
        g.fillTriangle(-s * 0.75, -s * 0.35, -s * 0.75, s * 0.35, s * 0.1, s * 0.7);
        g.fillRect(-s, -s * 0.32, s * 0.34, s * 0.64);
        g.beginPath();
        g.arc(s * 0.05, 0, s * 0.62, -Math.PI * 0.42, Math.PI * 0.42);
        g.strokePath();
        break;
      case 'pause':
        g.fillRoundedRect(-s * 0.62, -s * 0.82, s * 0.42, s * 1.64, s * 0.08);
        g.fillRoundedRect(s * 0.2, -s * 0.82, s * 0.42, s * 1.64, s * 0.08);
        break;
      case 'map':
        g.lineBetween(-s * 0.9, -s * 0.65, -s * 0.3, -s * 0.88);
        g.lineBetween(-s * 0.3, -s * 0.88, s * 0.32, -s * 0.62);
        g.lineBetween(s * 0.32, -s * 0.62, s * 0.9, -s * 0.86);
        g.lineBetween(-s * 0.9, -s * 0.65, -s * 0.9, s * 0.72);
        g.lineBetween(-s * 0.9, s * 0.72, -s * 0.3, s * 0.48);
        g.lineBetween(-s * 0.3, s * 0.48, s * 0.32, s * 0.74);
        g.lineBetween(s * 0.32, s * 0.74, s * 0.9, s * 0.5);
        g.lineBetween(s * 0.9, s * 0.5, s * 0.9, -s * 0.86);
        g.lineBetween(-s * 0.3, -s * 0.88, -s * 0.3, s * 0.48);
        g.lineBetween(s * 0.32, -s * 0.62, s * 0.32, s * 0.74);
        break;
      case 'phone':
        g.strokeRoundedRect(-s * 0.48, -s * 0.82, s * 0.96, s * 1.64, s * 0.14);
        g.lineBetween(-s * 0.16, -s * 0.58, s * 0.16, -s * 0.58);
        g.fillCircle(0, s * 0.58, s * 0.08);
        break;
    }
  }
}
