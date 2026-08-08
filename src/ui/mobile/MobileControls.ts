import Phaser from 'phaser';
import { InputAction } from '@/config/InputConfig';
import { DepthLayers } from '@/config/DepthLayers';
import { EventKeys } from '@/config/EventKeys';
import { ServiceKeys } from '@/config/ServiceKeys';
import { eventBus } from '@/core/EventBus';
import { ServiceLocator } from '@/core/ServiceLocator';
import { GameState, type Unsubscribe } from '@/core/types';
import type { InteractionContext } from '@/gameplay/types';
import type { InputManager } from '@/managers/InputManager';
import type { GameManager } from '@/managers/GameManager';
import type { SettingsManager } from '@/managers/SettingsManager';
import { DEFAULT_SETTINGS, type GameSettings } from '@/config/Settings';
import type { MobilePlatform } from '@/platform';
import type { PlayerController } from '@/systems/PlayerController';
import { UIComponent } from '@/ui/UIComponent';
import { MobileActionButton, type MobileButtonIcon } from './MobileActionButton';
import { VirtualJoystick } from './VirtualJoystick';
import { mobileControlSizes } from './MobileControlMath';

type ButtonName =
  | 'attack'
  | 'context'
  | 'reload'
  | 'weapon'
  | 'accelerate'
  | 'reverse'
  | 'handbrake'
  | 'horn'
  | 'map'
  | 'pause';

interface ButtonSpec {
  name: ButtonName;
  icon: MobileButtonIcon;
  label: string;
  press: (pointer: Phaser.Input.Pointer) => void;
  release: (pointerId: number) => void;
}

/** Persistent, mobile-only two-thumb input HUD. */
export class MobileControls extends UIComponent {
  private readonly inputManager: InputManager;
  private readonly platform: MobilePlatform;
  private readonly joystick: VirtualJoystick;
  private readonly buttons = new Map<ButtonName, MobileActionButton>();
  private readonly unsubs: Unsubscribe[] = [];
  private readonly pendingReleases = new Map<InputAction, number>();

  private inVehicle = false;
  private gameplayVisible = true;
  private interaction: InteractionContext | null = null;
  private hasReloadableWeapon = false;
  private accelerating = false;
  private reversing = false;
  private steer = 0;
  private attackDiameter = 112;
  private settings: Readonly<GameSettings> = DEFAULT_SETTINGS;

  private readonly onPointerMove = (pointer: Phaser.Input.Pointer): void => {
    this.joystick.movePointer(pointer);
    if (this.button('attack').activePointerId === pointer.id) this.updateAttackAim(pointer);
  };
  private readonly onPointerUp = (pointer: Phaser.Input.Pointer): void => {
    this.releasePointer(pointer.id);
  };
  private readonly onCancel = (): void => this.resetAll();
  private readonly onVisibilityChange = (): void => {
    if (document.hidden) this.resetAll();
  };

  constructor(scene: Phaser.Scene, platform: MobilePlatform) {
    super(scene);
    const input = ServiceLocator.tryResolve<InputManager>(ServiceKeys.Input);
    if (!input) throw new Error('MobileControls requires InputManager');
    this.inputManager = input;
    this.platform = platform;
    this.settings =
      ServiceLocator.tryResolve<SettingsManager>(ServiceKeys.Settings)?.settings ?? DEFAULT_SETTINGS;
    this.setDepth(DepthLayers.Overlay);
    this.setScrollFactor(0);

    while (scene.input.manager.pointersTotal < 6) scene.input.addPointer(1);

    this.joystick = new VirtualJoystick(scene, {
      onChange: (x, y, magnitude) => this.onJoystick(x, y, magnitude),
    });
    this.add(this.joystick);

    const specs: ButtonSpec[] = [
      { name: 'attack', icon: 'attack', label: 'Attack', press: (p) => this.pressAttack(p), release: () => this.releaseAttack() },
      { name: 'context', icon: 'interact', label: 'Interact', press: () => this.pressContext(), release: () => this.releaseContext() },
      { name: 'reload', icon: 'reload', label: 'Reload', press: () => this.pressAction(InputAction.Reload, 8), release: () => this.deferActionRelease(InputAction.Reload) },
      { name: 'weapon', icon: 'weapon', label: 'Next weapon', press: () => this.pressAction(InputAction.NextWeapon, 8), release: () => this.deferActionRelease(InputAction.NextWeapon) },
      { name: 'accelerate', icon: 'accelerate', label: 'Accelerate', press: () => this.setAccelerating(true), release: () => this.setAccelerating(false) },
      { name: 'reverse', icon: 'reverse', label: 'Brake and reverse', press: () => this.setReversing(true), release: () => this.setReversing(false) },
      { name: 'handbrake', icon: 'handbrake', label: 'Handbrake', press: () => this.pressAction(InputAction.Handbrake, 8), release: () => this.inputManager.setTouchAction(InputAction.Handbrake, false) },
      { name: 'horn', icon: 'horn', label: 'Horn', press: () => this.pressAction(InputAction.Horn, 8), release: () => this.deferActionRelease(InputAction.Horn) },
      { name: 'map', icon: 'map', label: 'Map', press: () => this.pressAction(InputAction.ToggleMap, 8), release: () => this.deferActionRelease(InputAction.ToggleMap) },
      { name: 'pause', icon: 'pause', label: 'Pause', press: () => this.pressAction(InputAction.Pause, 8), release: () => this.deferActionRelease(InputAction.Pause) },
    ];
    for (const spec of specs) {
      const button = new MobileActionButton(scene, {
        icon: spec.icon,
        label: spec.label,
        onPress: spec.press,
        onRelease: spec.release,
      });
      this.buttons.set(spec.name, button);
      this.add(button);
    }

    const player = ServiceLocator.tryResolve<PlayerController>(ServiceKeys.Player);
    this.inVehicle = player?.playerInVehicle ?? false;
    this.hasReloadableWeapon = (player?.player?.weaponComp.weapon?.magazine ?? 0) > 0;
    this.gameplayVisible =
      ServiceLocator.tryResolve<GameManager>(ServiceKeys.Game)?.state === GameState.Playing;

    this.unsubs.push(
      eventBus.on(EventKeys.InteractionContextChanged, ({ context }) => {
        this.interaction = context;
        this.refreshMode();
      }),
      eventBus.on(EventKeys.PlayerEnteredVehicle, () => {
        this.resetAll();
        this.inVehicle = true;
        this.interaction = { kind: 'vehicle', prompt: 'Exit vehicle' };
        this.refreshMode();
      }),
      eventBus.on(EventKeys.PlayerExitedVehicle, () => {
        this.resetAll();
        this.inVehicle = false;
        this.interaction = null;
        this.refreshMode();
      }),
      eventBus.on(EventKeys.WeaponSwitched, ({ weaponId }) => {
        const controller = ServiceLocator.tryResolve<PlayerController>(ServiceKeys.Player);
        const weapon = controller?.player?.weaponComp.weapon;
        this.hasReloadableWeapon = weapon?.id === weaponId && weapon.magazine > 0;
        this.refreshMode();
      }),
      eventBus.on(EventKeys.GameStateChanged, ({ current }) => {
        this.gameplayVisible = current === GameState.Playing;
        if (!this.gameplayVisible) this.resetAll();
        this.refreshMode();
      }),
      eventBus.on(EventKeys.SettingsChanged, ({ settings }) => {
        this.settings = settings;
        this.applyVisualSettings();
        this.layoutControls();
      }),
    );

    scene.input.on(Phaser.Input.Events.POINTER_MOVE, this.onPointerMove);
    scene.input.on(Phaser.Input.Events.POINTER_UP, this.onPointerUp);
    scene.input.on(Phaser.Input.Events.POINTER_UP_OUTSIDE, this.onPointerUp);
    scene.input.on(Phaser.Input.Events.GAME_OUT, this.onCancel);
    window.addEventListener('blur', this.onCancel);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.unsubs.push(platform.onLayoutChanged(() => this.layoutControls()));

    this.layoutControls();
    this.applyVisualSettings();
    this.refreshMode();
  }

  /** Release short pulse actions after they have survived at least one game step. */
  public update(time: number): void {
    if (this.pendingReleases.size === 0) return;
    for (const [action, releaseAt] of this.pendingReleases) {
      if (time < releaseAt) continue;
      this.inputManager.setTouchAction(action, false);
      this.pendingReleases.delete(action);
    }
  }

  public resetAll(): void {
    this.joystick.cancel();
    for (const button of this.buttons.values()) button.cancel();
    this.pendingReleases.clear();
    this.accelerating = false;
    this.reversing = false;
    this.steer = 0;
    this.inputManager.resetTouchInput();
  }

  public layoutControls(): void {
    const layout = this.platform.layout(this.uiScene);
    const { width, height, safe } = layout;
    const controlScale = this.settings.mobileControlScale;
    const sizes = mobileControlSizes(height, controlScale, this.settings.mobileJoystickScale);
    const joystickRadius = sizes.joystickRadius;
    // Keep every hit target at least 46 CSS px after Phaser display scaling.
    const canvasCssWidth = this.uiScene.game.canvas.getBoundingClientRect().width;
    const cssScale = canvasCssWidth > 0 ? canvasCssWidth / width : 1;
    const minLogicalTarget = 46 / Math.max(0.01, cssScale);
    const buttonSize = Math.max(sizes.button, minLogicalTarget);
    const smallSize = Math.max(sizes.smallButton, minLogicalTarget);
    this.attackDiameter = buttonSize * 1.12;

    this.joystick
      .setRadius(joystickRadius)
      .setPosition(
        safe.left + joystickRadius + 30 + width * this.settings.mobileJoystickOffsetX,
        height - safe.bottom - joystickRadius - 24 + height * this.settings.mobileJoystickOffsetY,
      );

    const right = width - safe.right - 28;
    const bottom = height - safe.bottom - 28;
    this.place('pause', right - smallSize * 0.5, safe.top + 28 + smallSize * 0.5, smallSize);
    this.place('map', right - smallSize * 1.65, safe.top + 28 + smallSize * 0.5, smallSize);

    if (this.inVehicle) {
      this.place('accelerate', right - buttonSize * 0.55, bottom - buttonSize * 0.72, buttonSize * 1.08);
      this.place('reverse', right - buttonSize * 1.72, bottom - buttonSize * 0.52, buttonSize);
      this.place('handbrake', right - buttonSize * 0.55, bottom - buttonSize * 1.92, smallSize);
      this.place('context', right - buttonSize * 1.72, bottom - buttonSize * 1.7, smallSize);
      this.place('horn', right - buttonSize * 2.82, bottom - buttonSize * 0.62, smallSize);
    } else {
      this.place('attack', right - this.attackDiameter * 0.52, bottom - this.attackDiameter * 0.62, this.attackDiameter);
      this.place('context', right - buttonSize * 1.72, bottom - buttonSize * 0.66, buttonSize);
      this.place('reload', right - smallSize * 0.53, bottom - buttonSize * 2.02, smallSize);
      this.place('weapon', right - buttonSize * 1.65, bottom - buttonSize * 1.78, smallSize);
    }
  }

  private place(name: ButtonName, x: number, y: number, diameter: number): void {
    this.button(name).setPosition(Math.round(x), Math.round(y)).setDiameter(diameter);
  }

  private refreshMode(): void {
    this.joystick.setMode(this.inVehicle ? 'steer' : 'move');
    const active = this.gameplayVisible && !this.platform.isGameplayBlocked;
    this.joystick.setEnabled(active);
    const desired = new Set<ButtonName>();
    if (active) {
      desired.add('map');
      desired.add('pause');
      if (this.inVehicle) {
        desired.add('accelerate');
        desired.add('reverse');
        desired.add('handbrake');
        desired.add('horn');
        desired.add('context');
        this.button('context').setIcon('exit', 'Exit vehicle');
      } else {
        desired.add('attack');
        desired.add('weapon');
        if (this.hasReloadableWeapon) desired.add('reload');
        if (this.interaction) {
          desired.add('context');
          const vehicle = this.interaction.kind === 'vehicle';
          this.button('context').setIcon(
            vehicle ? 'enter' : 'interact',
            vehicle ? 'Enter vehicle' : 'Interact',
          );
        }
      }
    }
    for (const [name, button] of this.buttons) {
      const enabled = desired.has(name);
      if (!enabled && button.visible) button.cancel();
      button.setEnabled(enabled);
    }
    this.layoutControls();
  }

  private onJoystick(x: number, y: number, magnitude: number): void {
    if (this.inVehicle) {
      this.steer = x;
      this.writeVehicleAxis();
      return;
    }
    const sensitivity = this.settings.mobileMoveSensitivity;
    this.inputManager.setTouchMoveAxis(x * sensitivity, y * sensitivity);
    this.inputManager.setTouchAction(InputAction.Run, magnitude >= 0.82);
  }

  private pressAttack(pointer: Phaser.Input.Pointer): void {
    this.haptic(8);
    this.inputManager.setTouchAction(InputAction.Attack, true);
    this.updateAttackAim(pointer);
  }

  private releaseAttack(): void {
    this.inputManager.setTouchAction(InputAction.Attack, false);
    this.inputManager.setTouchAimAxis(0, 0);
  }

  private updateAttackAim(pointer: Phaser.Input.Pointer): void {
    const button = this.button('attack');
    const dx = pointer.x - button.x;
    const dy = pointer.y - button.y;
    const distance = Math.hypot(dx, dy);
    if (distance < (this.attackDiameter * 0.18) / this.settings.mobileAimSensitivity) {
      this.inputManager.setTouchAimAxis(0, 0);
      return;
    }
    this.inputManager.setTouchAimAxis(dx / distance, dy / distance);
  }

  private pressContext(): void {
    const action = this.inVehicle || this.interaction?.kind === 'vehicle'
      ? InputAction.EnterVehicle
      : InputAction.Interact;
    this.pressAction(action, 12);
  }

  private releaseContext(): void {
    const action = this.inVehicle || this.interaction?.kind === 'vehicle'
      ? InputAction.EnterVehicle
      : InputAction.Interact;
    this.deferActionRelease(action);
  }

  private pressAction(action: InputAction, vibrationMs: number): void {
    this.pendingReleases.delete(action);
    this.haptic(vibrationMs);
    this.inputManager.setTouchAction(action, true);
  }

  private deferActionRelease(action: InputAction): void {
    this.pendingReleases.set(action, this.uiScene.time.now + 48);
  }

  private setAccelerating(down: boolean): void {
    this.accelerating = down;
    this.writeVehicleAxis();
  }

  private setReversing(down: boolean): void {
    this.reversing = down;
    this.writeVehicleAxis();
  }

  private writeVehicleAxis(): void {
    const throttle = (this.reversing ? 1 : 0) - (this.accelerating ? 1 : 0);
    this.inputManager.setTouchMoveAxis(this.steer, throttle);
  }

  private releasePointer(pointerId: number): void {
    this.joystick.releasePointer(pointerId);
    for (const button of this.buttons.values()) button.releasePointer(pointerId);
  }

  private button(name: ButtonName): MobileActionButton {
    const button = this.buttons.get(name);
    if (!button) throw new Error(`Missing mobile control: ${name}`);
    return button;
  }

  private applyVisualSettings(): void {
    this.joystick.setControlOpacity(this.settings.mobileControlOpacity * 0.84);
    for (const button of this.buttons.values()) {
      button.setControlOpacity(this.settings.mobileControlOpacity);
    }
  }

  private haptic(durationMs: number): void {
    if (this.settings.mobileVibration) this.platform.vibrate(durationMs);
  }

  public override destroy(fromScene?: boolean): void {
    this.resetAll();
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;
    this.uiScene.input.off(Phaser.Input.Events.POINTER_MOVE, this.onPointerMove);
    this.uiScene.input.off(Phaser.Input.Events.POINTER_UP, this.onPointerUp);
    this.uiScene.input.off(Phaser.Input.Events.POINTER_UP_OUTSIDE, this.onPointerUp);
    this.uiScene.input.off(Phaser.Input.Events.GAME_OUT, this.onCancel);
    window.removeEventListener('blur', this.onCancel);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    super.destroy(fromScene);
  }
}
