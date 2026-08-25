/**
 * Owns the lifecycle of every engine manager/system.
 *
 * Responsibilities:
 *  - instantiate all managers in dependency order;
 *  - register them with the {@link ServiceLocator};
 *  - `init()` them (awaiting async initialisation);
 *  - tick the updatable ones from a single subscription to Phaser's game STEP,
 *    so managers advance independently of any particular scene;
 *  - tear everything down in reverse order.
 *
 * This is the one place that knows the concrete manager set, keeping the rest of
 * the engine dependent only on interfaces and service keys.
 */
import Phaser from 'phaser';
import { ServiceLocator } from '@/core/ServiceLocator';
import { ServiceKeys } from '@/config/ServiceKeys';
import { isUpdatable } from '@/core/interfaces';
import type { IManager, IUpdatable } from '@/core/interfaces';
import { Logger } from '@/utils/Logger';
import { ENGINE_LIMITS } from '@/config/EngineLimits';
import { EngineDiagnostics } from '@/core/EngineDiagnostics';

import { SaveManager } from '@/managers/SaveManager';
import { ResourceManager } from '@/managers/ResourceManager';
import { AnimationManager } from '@/managers/AnimationManager';
import { SoundManager } from '@/managers/SoundManager';
import { MusicManager } from '@/managers/MusicManager';
import { InputManager } from '@/managers/InputManager';
import { CameraManager } from '@/managers/CameraManager';
import { ParticleManager } from '@/managers/ParticleManager';
import { LightingSystem } from '@/systems/LightingSystem';
import { DayNightSystem } from '@/systems/DayNightSystem';
import { UIManager } from '@/managers/UIManager';
import { GameManager } from '@/managers/GameManager';
import { PhoneManager } from '@/managers/PhoneManager';
// Phase 2 gameplay systems.
import { GameAudioSystem } from '@/systems/GameAudioSystem';
import { WorldManager } from '@/systems/WorldManager';
import { WorldInteriorSystem } from '@/systems/WorldInteriorSystem';
import { NavigationSystem } from '@/systems/NavigationSystem';
import { CombatSystem } from '@/systems/CombatSystem';
import { VehicleSystem } from '@/systems/VehicleSystem';
import { VehicleOccupantSystem } from '@/systems/VehicleOccupantSystem';
import { PedestrianSystem } from '@/systems/PedestrianSystem';
import { TrafficSystem } from '@/systems/TrafficSystem';
import { TransportationSystem } from '@/systems/TransportationSystem';
import { EmergencyResponseSystem } from '@/systems/EmergencyResponseSystem';
import { CrimeSystem } from '@/systems/CrimeSystem';
import { WantedSystem } from '@/systems/WantedSystem';
import { MissionSystem } from '@/systems/MissionSystem';
import { PlayerController } from '@/systems/PlayerController';
import { SettingsManager } from '@/managers/SettingsManager';
import { MobilePlatform } from '@/platform';
import { WeatherSystem } from '@/systems/WeatherSystem';
import { CityLifeSystem } from '@/systems/CityLifeSystem';
import { PickupSystem } from '@/systems/PickupSystem';
import { InteractionSystem } from '@/systems/InteractionSystem';
import { EntityManager } from '@/systems/EntityManager';
import { ProfilerSystem } from '@/systems/ProfilerSystem';
import { ShopSystem } from '@/systems/ShopSystem';
import { SideGigSystem } from '@/systems/SideGigSystem';
import { GameState } from '@/core/types';

/** A manager that also opts into the per-frame update loop. */
type UpdatableManager = IManager & IUpdatable;

export class ManagerRegistry {
  private readonly log = Logger.create('ManagerRegistry');
  private readonly managers: IManager[] = [];
  private updatables: UpdatableManager[] = [];
  private stepHandler: ((time: number, delta: number) => void) | null = null;
  /** Cached game manager, used to freeze the simulation while paused. */
  private gameManager: GameManager | null = null;
  private profiler: ProfilerSystem | null = null;

  constructor(private readonly game: Phaser.Game) {}

  /**
   * Instantiate, register and initialise every manager, then start the tick.
   * Managers are created in dependency order (persistence and resources first,
   * high-level coordinators last).
   */
  public async initAll(): Promise<void> {
    const instances: IManager[] = [
      new MobilePlatform(this.game),
      new SaveManager(this.game),
      new ResourceManager(this.game),
      new AnimationManager(this.game),
      new SoundManager(this.game),
      new MusicManager(this.game),
      // Settings after the audio managers so it can apply saved volumes on init.
      new SettingsManager(this.game),
      new InputManager(this.game),
      new CameraManager(this.game),
      new ParticleManager(this.game),
      new LightingSystem(this.game),
      new DayNightSystem(this.game),
      // Gameplay systems (World before Player so the map exists at spawn).
      new GameAudioSystem(this.game),
      new WorldManager(this.game),
      new WorldInteriorSystem(this.game),
      // Navigation queries the world's tile grid, so it comes right after it
      // and before anything (pedestrian AI, later traffic AI) that paths.
      new NavigationSystem(this.game),
      new CombatSystem(this.game),
      new VehicleSystem(this.game),
      new VehicleOccupantSystem(this.game),
      new PedestrianSystem(this.game),
      new TrafficSystem(this.game),
      new TransportationSystem(this.game),
      new EmergencyResponseSystem(this.game),
      new CrimeSystem(this.game),
      new WantedSystem(this.game),
      new MissionSystem(this.game),
      new WeatherSystem(this.game),
      new CityLifeSystem(this.game),
      new PickupSystem(this.game),
      new ShopSystem(this.game),
      new SideGigSystem(this.game),
      new PlayerController(this.game),
      new InteractionSystem(this.game),
      // The entity scheduler ticks after directors/controllers have produced
      // their frame intents, and is the only service that advances entities.
      new EntityManager(this.game),
      new ProfilerSystem(this.game),
      new UIManager(this.game),
      new PhoneManager(this.game),
      new GameManager(this.game),
    ];

    for (const manager of instances) {
      ServiceLocator.register(manager);
      this.managers.push(manager);
    }

    // Initialise sequentially so async managers (e.g. ResourceManager) finish
    // before dependents run.
    for (const manager of this.managers) {
      await manager.init();
    }

    this.updatables = this.managers.filter((m): m is UpdatableManager => isUpdatable(m));
    this.gameManager =
      this.managers.find((m): m is GameManager => m instanceof GameManager) ?? null;
    this.profiler =
      this.managers.find((m): m is ProfilerSystem => m instanceof ProfilerSystem) ?? null;

    this.startTicking();
    this.log.info(`initialised ${this.managers.length} managers`);
  }

  /** Subscribe the update loop to the game STEP event. */
  private startTicking(): void {
    this.stepHandler = (time: number, delta: number): void => {
      const paused = this.gameManager?.state === GameState.Paused;
      const phoneOpen = ServiceLocator.tryResolve<PhoneManager>(ServiceKeys.Phone)?.isOpen === true;
      // Freeze the whole simulation for ordinary modal overlays. The phone has
      // one narrowly-scoped exception: TrafficSystem and TransportationSystem
      // may advance an assigned Snapp taxi only, so its live tracking remains
      // truthful while player/world simulation stays paused.
      if (paused && !phoneOpen) {
        return;
      }
      // Cap delta so a background tab that resumes doesn't teleport everything.
      const dt = delta > 100 ? 100 : delta;
      EngineDiagnostics.beginFrame(time, dt);
      for (const manager of this.updatables) {
        const nowPaused = this.gameManager?.state === GameState.Paused;
        if (nowPaused && !phoneOpen) break;
        if (nowPaused && phoneOpen && manager.key !== ServiceKeys.Traffic && manager.key !== ServiceKeys.Transportation) {
          continue;
        }
        const startedAt = performance.now();
        EngineDiagnostics.beginSystem(manager.key);
        try {
          if (nowPaused && phoneOpen) {
            const phoneTick = manager as UpdatableManager & {
              updateWhilePhoneOpen?: (tickTime: number, tickDelta: number) => void;
            };
            phoneTick.updateWhilePhoneOpen?.(time, dt);
          } else {
            manager.update(time, dt);
          }
        } catch (error) {
          EngineDiagnostics.recordError(error, 'manager-update', manager.key);
          EngineDiagnostics.recordRecovery(manager.key, 'continued-after-manager-exception');
          this.log.error(`update failed in ${manager.key}`, error);
        } finally {
          const elapsed = performance.now() - startedAt;
          EngineDiagnostics.endSystem(manager.key, elapsed);
          if (elapsed >= ENGINE_LIMITS.MANAGER_RECOVERY_MS) {
            EngineDiagnostics.recordSlowSystem(
              manager.key,
              elapsed,
              ENGINE_LIMITS.MANAGER_RECOVERY_MS,
            );
            this.log.warn(`${manager.key} exceeded watchdog budget: ${elapsed.toFixed(2)}ms`);
          } else if (elapsed >= ENGINE_LIMITS.MANAGER_WARN_MS) {
            EngineDiagnostics.recordLimitExceeded(
              'MANAGER_WARN_MS',
              elapsed,
              ENGINE_LIMITS.MANAGER_WARN_MS,
              'manager-frame-budget-warning',
              manager.key,
            );
          }
          try {
            this.profiler?.recordSystemSample(manager.key, elapsed);
          } catch (error) {
            EngineDiagnostics.recordError(error, 'profiler-system-sample', manager.key);
          }
        }
      }
      EngineDiagnostics.endFrame();
    };
    this.game.events.on(Phaser.Core.Events.STEP, this.stepHandler);
  }

  /** Destroy every manager (reverse order) and unhook the update loop. */
  public destroyAll(): void {
    if (this.stepHandler) {
      this.game.events.off(Phaser.Core.Events.STEP, this.stepHandler);
      this.stepHandler = null;
    }
    for (let i = this.managers.length - 1; i >= 0; i--) {
      this.managers[i]?.destroy();
    }
    ServiceLocator.clear();
    this.managers.length = 0;
    this.updatables = [];
    this.profiler = null;
    this.log.info('all managers destroyed');
  }
}
