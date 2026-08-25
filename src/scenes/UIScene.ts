/**
 * UIScene — the transparent, always-on-top gameplay overlay.
 *
 * Runs in parallel with {@link SceneKeys.Game} and hosts the {@link GameHud}
 * (health, armor, money, wanted stars, weapon, speedometer, objective compass,
 * banner, clock, toasts), the {@link MiniMap} and the hit markers flashed when
 * the player's shots connect. The HUD is largely event-driven; this scene feeds
 * it the per-frame values it cannot get from events alone (vehicle speed, the
 * objective-arrow direction) and drives the minimap from the live player
 * position and entity blips.
 */
import Phaser from 'phaser';
import { SceneKeys } from '@/config/SceneKeys';
import { ServiceLocator } from '@/core/ServiceLocator';
import { ServiceKeys } from '@/config/ServiceKeys';
import { COLORS } from '@/config/Constants';
import { TextureKeys } from '@/config/AssetKeys';
import { DepthLayers } from '@/config/DepthLayers';
import { EventKeys } from '@/config/EventKeys';
import { InputAction } from '@/config/InputConfig';
import { eventBus } from '@/core/EventBus';
import { GameState } from '@/core/types';
import type { Unsubscribe, Vector2 } from '@/core/types';
import { GameHud } from '@/ui/hud/GameHud';
import { MiniMap } from '@/ui/hud/MiniMap';
import { TransitHud } from '@/ui/hud/TransitHud';
import { GameplayDebugOverlay } from '@/ui/hud/GameplayDebugOverlay';
import type { MiniMapBlip } from '@/ui/hud/MiniMap';
import type { WorldManager } from '@/systems/WorldManager';
import type { PlayerController } from '@/systems/PlayerController';
import type { WantedSystem } from '@/systems/WantedSystem';
import type { VehicleSystem } from '@/systems/VehicleSystem';
import type { GameManager } from '@/managers/GameManager';
import type { InputManager } from '@/managers/InputManager';
import type { MobilePlatform } from '@/platform';
import type { TransportationSystem } from '@/systems/TransportationSystem';
import { MobileControls } from '@/ui/mobile';
import { Button } from '@/ui/components';
import { getObjectiveTarget, getWaypoint, setObjectiveTarget } from '@/gameplay/WorldMapState';

export class UIScene extends Phaser.Scene {
  private hud: GameHud | null = null;
  private minimap: MiniMap | null = null;
  private transitHud: TransitHud | null = null;
  private deathFade: Phaser.GameObjects.Rectangle | null = null;
  private gameplayDebug: GameplayDebugOverlay | null = null;
  private mobileControls: MobileControls | null = null;
  private mobilePlatform: MobilePlatform | null = null;
  private mobileLayoutUnsub: (() => void) | null = null;
  private phoneButton: Button | null = null;

  /** The active mission/gig target in world space, or null. */
  private objectiveTarget: Vector2 | null = getObjectiveTarget();
  /** The active custom waypoint in world space, or null. */
  private waypointTarget: Vector2 | null = getWaypoint();

  /** Event unsubscribe handles. */
  private readonly unsubs: Unsubscribe[] = [];

  constructor() {
    super({ key: SceneKeys.UI });
  }

  /** Build the HUD/minimap and wire the overlay events. */
  public create(): void {
    this.mobilePlatform = ServiceLocator.tryResolve<MobilePlatform>(ServiceKeys.Platform);
    const mobile = this.mobilePlatform?.isMobile ?? false;
    this.hud = new GameHud(this, mobile);
    this.minimap = new MiniMap(this, mobile ? 120 : 176);
    this.transitHud = new TransitHud(this, mobile);
    this.gameplayDebug = new GameplayDebugOverlay(this);
    if (this.mobilePlatform?.isMobile) {
      this.mobileControls = new MobileControls(this, this.mobilePlatform);
      this.mobileLayoutUnsub = this.mobilePlatform.onLayoutChanged(() => this.applyMobileLayout());
      this.applyMobileLayout();
    } else {
      this.phoneButton = new Button(this, this.scale.width - 86, 92, {
        text: 'PHONE [N]',
        width: 148,
        height: 48,
        onClick: () => {
          ServiceLocator.tryResolve<InputManager>(ServiceKeys.Input)?.triggerAction(InputAction.OpenPhone);
        },
      }).setDepth(DepthLayers.UI);
    }
    const playerController = ServiceLocator.tryResolve<PlayerController>(ServiceKeys.Player);
    if (playerController?.player) {
      this.hud.setVitals(playerController.player.vitals);
      this.hud.setMoney(playerController.player.inventory.money);
    }

    const world = ServiceLocator.tryResolve<WorldManager>(ServiceKeys.World);
    if (world && this.minimap) {
      this.minimap.setMap(world.map);
    }

    this.applyCursorState(this.currentState() === GameState.Playing);

    this.unsubs.push(
      eventBus.on(EventKeys.MissionTargetChanged, (p) => {
        this.objectiveTarget = p.target ? { x: p.target.x, y: p.target.y } : null;
        setObjectiveTarget(this.objectiveTarget);
      }),
      eventBus.on(EventKeys.WaypointChanged, (p) => {
        this.waypointTarget = p.target ? { x: p.target.x, y: p.target.y } : null;
      }),
      eventBus.on(EventKeys.GameStateChanged, (p) => {
        this.applyCursorState(p.current === GameState.Playing);
        this.applyPhoneButtonState(p.current === GameState.Playing);
      }),
      eventBus.on(EventKeys.HitConfirmed, (p) => this.flashHitMarker(p)),
      eventBus.on(EventKeys.PlayerDied, () => this.showDeathFade()),
      eventBus.on(EventKeys.PlayerRespawned, () => this.hideDeathFade()),
    );

    this.applyPhoneButtonState(this.currentState() === GameState.Playing);

    this.scene.bringToTop();
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.onShutdown, this);
  }

  private showDeathFade(): void {
    this.deathFade?.destroy();
    this.deathFade = this.add
      .rectangle(0, 0, this.scale.width, this.scale.height, 0x12090b, 1)
      .setOrigin(0)
      .setScrollFactor(0)
      .setDepth(DepthLayers.Overlay + 10)
      .setAlpha(0);
    this.tweens.add({ targets: this.deathFade, alpha: 0.78, duration: 650 });
  }

  private hideDeathFade(): void {
    const fade = this.deathFade;
    if (!fade) return;
    this.tweens.add({
      targets: fade,
      alpha: 0,
      duration: 500,
      onComplete: () => {
        fade.destroy();
        if (this.deathFade === fade) this.deathFade = null;
      },
    });
  }

  /** Feed the HUD + minimap the live view centre, speed, arrow and blips. */
  public override update(_time: number, delta: number): void {
    this.mobileControls?.update(this.time.now);
    this.gameplayDebug?.update(delta);
    const player = ServiceLocator.tryResolve<PlayerController>(ServiceKeys.Player);
    const centre = player?.playerPosition ?? null;

    if (this.minimap && centre) {
      this.minimap.setViewCenter(centre.x, centre.y);
      this.minimap.setBlips(this.gatherBlips());
    }

    // Speedometer + objective compass.
    const hud = this.hud;
    if (hud) {
      const vehicle = player?.currentVehicle ?? null;
      if (vehicle) hud.setVehicleSpeed(vehicle.movement.speed);
      hud.setObjectiveArrow(this.objectiveAngle(centre), delta);
      const world = ServiceLocator.tryResolve<WorldManager>(ServiceKeys.World);
      if (centre && world) {
        const city = world.cityAt(centre.x, centre.y);
        hud.setRegion(
          city?.name ?? 'INTERCITY',
          this.formatDistrict(world.districtAt(centre.x, centre.y)),
          city?.color ?? 0xf8d36e,
        );
      }
    }
    this.transitHud?.setRide(
      ServiceLocator.tryResolve<TransportationSystem>(ServiceKeys.Transportation)?.playerRide ?? null,
    );
  }

  private formatDistrict(district: string): string {
    return district
      .split('-')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  private applyMobileLayout(): void {
    const platform = this.mobilePlatform;
    if (!platform?.isMobile) return;
    const layout = platform.layout(this);
    this.hud?.setMobileLayout(layout.width, layout.height, layout.safe);
    const mapRadius = 60;
    this.minimap?.setScreenPosition(
      layout.safe.left + mapRadius + 14,
      layout.safe.top + mapRadius + 14,
    );
    this.transitHud?.setMobileLayout(layout.width, layout.height, layout.safe);
    this.mobileControls?.layoutControls();
  }

  /** Keep the desktop phone affordance available only during active play. */
  private applyPhoneButtonState(playing: boolean): void {
    this.phoneButton?.setEnabled(playing);
  }

  /** The screen-space angle from the player to the objective, or null. */
  private objectiveAngle(centre: Vector2 | null): number | null {
    const target = this.objectiveTarget ?? this.waypointTarget;
    if (!centre || !target) return null;
    return Math.atan2(target.y - centre.y, target.x - centre.x);
  }

  /** Briefly flash a hit marker at the supplied world position. */
  private flashHitMarker(payload: { x: number; y: number; fatal: boolean }): void {
    const screen = this.worldToScreen(payload.x, payload.y);
    const marker = this.add
      .image(screen.x, screen.y, TextureKeys.HitMarker)
      .setScrollFactor(0)
      .setDepth(DepthLayers.Overlay)
      .setTint(payload.fatal ? COLORS.HEALTH : COLORS.ACCENT);
    this.tweens.add({
      targets: marker,
      alpha: { from: 1, to: 0 },
      scale: { from: 1.3, to: 0.8 },
      duration: 220,
      onComplete: () => marker.destroy(),
    });
  }

  /** Collect minimap blips: police (red), vehicles (grey), objective (gold). */
  private gatherBlips(): MiniMapBlip[] {
    const blips: MiniMapBlip[] = [];
    try {
      const wanted = ServiceLocator.tryResolve<WantedSystem>(ServiceKeys.Wanted);
      if (wanted) {
        for (const officer of wanted.group.getChildren()) {
          const s = officer as Phaser.GameObjects.Sprite;
          if (s.active) blips.push({ x: s.x, y: s.y, color: COLORS.HEALTH, size: 3 });
        }
        for (const air of wanted.airGroup.getChildren()) {
          const s = air as Phaser.GameObjects.Sprite;
          if (s.active) blips.push({ x: s.x, y: s.y, color: 0x3a6cff, size: 4 });
        }
      }
      const vehicles = ServiceLocator.tryResolve<VehicleSystem>(ServiceKeys.Vehicle);
      if (vehicles) {
        for (const veh of vehicles.vehicles) {
          if (veh.isDestroyed) continue;
          blips.push({ x: veh.sprite.x, y: veh.sprite.y, color: 0x8a8f98, size: 2 });
        }
      }
      ServiceLocator.tryResolve<TransportationSystem>(ServiceKeys.Transportation)?.forEachServiceBlip(
        (kind, position) => {
          blips.push({
            x: position.x,
            y: position.y,
            color: kind === 'bus' ? 0x38bdf8 : kind === 'snapp' ? 0x13c8bc : 0xf6c453,
            size: kind === 'bus' ? 3 : kind === 'snapp' ? 3 : 2.5,
          });
        },
      );
    } catch {
      // Systems may briefly be detached during scene transitions — ignore.
    }
    if (this.objectiveTarget) {
      blips.push({
        x: this.objectiveTarget.x,
        y: this.objectiveTarget.y,
        color: COLORS.ACCENT,
        size: 4,
      });
    }
    if (this.waypointTarget) {
      blips.push({
        x: this.waypointTarget.x,
        y: this.waypointTarget.y,
        color: 0x22d3ee,
        size: 3,
      });
    }
    return blips;
  }

  /** Convert a world-space point to screen-space using the gameplay camera. */
  private worldToScreen(x: number, y: number): Vector2 {
    const gameScene = this.scene.get(SceneKeys.Game);
    const cam = gameScene?.cameras.main;
    if (!cam) {
      return { x: 0.5 * this.scale.width, y: 0.5 * this.scale.height };
    }
    return {
      x: (x - cam.scrollX) * cam.zoom,
      y: (y - cam.scrollY) * cam.zoom,
    };
  }

  /** Read the current gameplay state defensively. */
  private currentState(): GameState {
    return ServiceLocator.tryResolve<GameManager>(ServiceKeys.Game)?.state ?? GameState.Menu;
  }

  /** Show or hide the mouse cursor depending on whether gameplay is running. */
  private applyCursorState(playing: boolean): void {
    if (this.mobilePlatform?.isMobile) {
      this.input.setDefaultCursor('default');
      this.game.canvas.style.cursor = 'default';
      return;
    }
    this.input.setDefaultCursor(playing ? 'none' : 'default');
    this.game.canvas.style.cursor = playing ? 'none' : 'default';
    const mouse = this.input.mouse;
    if (!mouse) return;
    if (playing) {
      const canvas = this.game.canvas as HTMLCanvasElement & {
        mozRequestPointerLock?: () => void;
        webkitRequestPointerLock?: () => void;
      };
      if (typeof canvas.requestPointerLock !== 'function' &&
        typeof canvas.mozRequestPointerLock !== 'function' &&
        typeof canvas.webkitRequestPointerLock !== 'function') return;
      try {
        const result = mouse.requestPointerLock() as unknown;
        if (result && typeof result === 'object' && 'catch' in result) {
          void (result as Promise<void>).catch(() => undefined);
        }
      } catch {
        // Browsers may reject pointer lock unless this follows a user gesture.
      }
    } else {
      mouse.releasePointerLock();
    }
  }

  /** Tear down HUD + minimap + subscriptions. */
  private onShutdown(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;
    this.applyCursorState(false);
    this.hud?.destroy();
    this.minimap?.destroy();
    this.transitHud?.destroy();
    this.deathFade?.destroy();
    this.gameplayDebug?.destroy();
    this.mobileControls?.destroy();
    this.phoneButton?.destroy();
    this.mobileLayoutUnsub?.();
    this.hud = null;
    this.minimap = null;
    this.transitHud = null;
    this.deathFade = null;
    this.gameplayDebug = null;
    this.mobileControls = null;
    this.phoneButton = null;
    this.mobilePlatform = null;
    this.mobileLayoutUnsub = null;
  }
}
