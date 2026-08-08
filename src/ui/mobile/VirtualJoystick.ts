import Phaser from 'phaser';
import { COLORS } from '@/config/Constants';
import { UIComponent } from '@/ui/UIComponent';
import { sampleJoystick, type MutableAxisSample } from './MobileControlMath';

export type JoystickMode = 'move' | 'steer';

export interface VirtualJoystickConfig {
  radius?: number;
  deadZone?: number;
  opacity?: number;
  onChange: (x: number, y: number, magnitude: number) => void;
}

/** Fixed-zone analog joystick with radial dead-zone remapping and pointer ownership. */
export class VirtualJoystick extends UIComponent {
  private readonly base: Phaser.GameObjects.Graphics;
  private readonly knob: Phaser.GameObjects.Graphics;
  private radius: number;
  private deadZone: number;
  private opacity: number;
  private mode: JoystickMode = 'move';
  private pointerId: number | null = null;
  private readonly onChange: (x: number, y: number, magnitude: number) => void;
  private readonly sample: MutableAxisSample = { x: 0, y: 0, magnitude: 0, knobX: 0, knobY: 0 };

  constructor(scene: Phaser.Scene, config: VirtualJoystickConfig) {
    super(scene);
    this.radius = config.radius ?? 112;
    this.deadZone = config.deadZone ?? 0.16;
    this.opacity = config.opacity ?? 0.5;
    this.onChange = config.onChange;
    this.base = scene.add.graphics();
    this.knob = scene.add.graphics();
    this.add([this.base, this.knob]);
    this.setData('accessibility-label', 'Movement joystick');
    this.installHitArea();
    this.redraw();

    this.on(
      Phaser.Input.Events.POINTER_DOWN,
      (pointer: Phaser.Input.Pointer, _x: number, _y: number, event: Phaser.Types.Input.EventData) => {
        if (this.pointerId !== null) return;
        event.stopPropagation();
        this.pointerId = pointer.id;
        this.updatePointer(pointer);
      },
    );
  }

  public get activePointerId(): number | null {
    return this.pointerId;
  }

  public setMode(mode: JoystickMode): this {
    if (mode === this.mode) return this;
    this.cancel();
    this.mode = mode;
    this.setData('accessibility-label', mode === 'move' ? 'Movement joystick' : 'Steering joystick');
    this.redraw();
    return this;
  }

  public setRadius(radius: number): this {
    this.radius = Math.max(72, radius);
    this.installHitArea();
    this.redraw();
    return this;
  }

  public setControlOpacity(opacity: number): this {
    this.opacity = Phaser.Math.Clamp(opacity, 0.25, 0.85);
    this.redraw();
    return this;
  }

  public movePointer(pointer: Phaser.Input.Pointer): void {
    if (pointer.id === this.pointerId) this.updatePointer(pointer);
  }

  public releasePointer(pointerId: number): boolean {
    if (pointerId !== this.pointerId) return false;
    this.pointerId = null;
    this.knob.setPosition(0, 0);
    this.onChange(0, 0, 0);
    return true;
  }

  public cancel(): void {
    if (this.pointerId === null && this.knob.x === 0 && this.knob.y === 0) return;
    this.pointerId = null;
    this.knob.setPosition(0, 0);
    this.onChange(0, 0, 0);
  }

  private installHitArea(): void {
    const hitRadius = this.radius * 1.28;
    if (this.input) {
      this.input.hitArea = new Phaser.Geom.Circle(0, 0, hitRadius);
      this.input.hitAreaCallback = Phaser.Geom.Circle.Contains;
    } else {
      this.setInteractive(new Phaser.Geom.Circle(0, 0, hitRadius), Phaser.Geom.Circle.Contains);
    }
  }

  private updatePointer(pointer: Phaser.Input.Pointer): void {
    sampleJoystick(
      pointer.x - this.x,
      pointer.y - this.y,
      this.radius,
      this.deadZone,
      this.mode === 'steer',
      this.sample,
    );
    this.knob.setPosition(this.sample.knobX, this.sample.knobY);
    this.onChange(this.sample.x, this.sample.y, this.sample.magnitude);
  }

  private redraw(): void {
    const r = this.radius;
    this.base.clear();
    this.base.fillStyle(COLORS.UI_PANEL, this.opacity * 0.72);
    this.base.fillCircle(0, 0, r);
    this.base.lineStyle(Math.max(2, r * 0.025), COLORS.TEXT, 0.52);
    this.base.strokeCircle(0, 0, r - 2);
    this.base.lineStyle(Math.max(2, r * 0.018), COLORS.UI_BORDER, 0.6);
    this.base.strokeCircle(0, 0, r * this.deadZone);
    if (this.mode === 'steer') {
      this.base.lineStyle(Math.max(3, r * 0.035), COLORS.TEXT, 0.5);
      this.base.lineBetween(-r * 0.7, 0, r * 0.7, 0);
    }

    this.knob.clear();
    this.knob.fillStyle(COLORS.TEXT, Math.min(0.86, this.opacity + 0.18));
    this.knob.fillCircle(0, 0, r * 0.38);
    this.knob.lineStyle(Math.max(2, r * 0.025), COLORS.ACCENT, 0.86);
    this.knob.strokeCircle(0, 0, r * 0.38 - 2);
  }
}
