/**
 * GameScene — the gameplay composition root.
 *
 * This scene wires the whole simulation together. It attaches every scene-bound
 * manager/system to itself (input, camera, particles, lighting, world, combat,
 * vehicles, pedestrians, traffic, wanted, missions and the player controller),
 * then registers the Arcade-physics colliders/overlaps that connect them:
 * characters and vehicles collide with the city walls, bullets damage anyone
 * hostile, and fast vehicles run down anyone in the road.
 *
 * The systems themselves run their per-frame logic off the global manager tick
 * (see {@link ManagerRegistry}); this scene owns only the world composition, the
 * physics wiring and the high-level scene flow (pause / resume / quit + HUD).
 */
import Phaser from 'phaser';
import { SceneKeys } from '@/config/SceneKeys';
import { ServiceLocator } from '@/core/ServiceLocator';
import { ServiceKeys } from '@/config/ServiceKeys';
import { WORLD_WIDTH, WORLD_HEIGHT } from '@/config/Constants';
import { AudioKeys } from '@/config/AssetKeys';
import { eventBus } from '@/core/EventBus';
import { EventKeys } from '@/config/EventKeys';
import { Logger } from '@/utils';
import { clearMapState } from '@/gameplay/WorldMapState';
import type { MusicManager } from '@/managers/MusicManager';
import type { SaveManager } from '@/managers/SaveManager';
import type { WorldManager } from '@/systems/WorldManager';
import type { CombatSystem } from '@/systems/CombatSystem';
import type { VehicleSystem } from '@/systems/VehicleSystem';
import type { PedestrianSystem } from '@/systems/PedestrianSystem';
import type { WantedSystem } from '@/systems/WantedSystem';
import type { CityLifeSystem } from '@/systems/CityLifeSystem';
import type { PlayerController } from '@/systems/PlayerController';
import type { BaseSceneManager } from '@/core/BaseSceneManager';
import type { InputManager } from '@/managers/InputManager';

/** Phaser's Arcade collide/overlap callback signature. */
type Pair = Phaser.Types.Physics.Arcade.ArcadePhysicsCallback;

export class GameScene extends Phaser.Scene {
  private readonly log = new Logger('GameScene');

  /** Event-bus unsubscribe callbacks, all invoked on shutdown. */
  private readonly unsubs: Array<() => void> = [];

  /** Tile-layer colliders recreated whenever WorldManager streams a new chunk set. */
  private readonly worldColliders: Phaser.Physics.Arcade.Collider[] = [];

  constructor() {
    super({ key: SceneKeys.Game });
  }

  /** Build the world, attach systems, wire physics and start the flow. */
  public create(): void {
    this.physics.world.setBounds(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    clearMapState();

    this.attachSystems();
    this.wireColliders();

    this.scene.launch(SceneKeys.UI);
    eventBus.emit(EventKeys.UIShowHud);
    this.startCityMusic();

    this.wireLifecycleEvents();
    this.registerHotkeys();

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.onShutdown, this);
  }

  /**
   * Attach every scene-bound manager to this scene, in dependency order so the
   * world (and its collision layer) exists before the player spawns and before
   * traffic/combat query it.
   */
  private attachSystems(): void {
    // Engine services first.
    this.attach(ServiceKeys.Input);
    this.attach(ServiceKeys.Camera);
    this.attach(ServiceKeys.Particle);
    this.attach(ServiceKeys.Lighting);
    this.attach(ServiceKeys.Entity);
    this.attach(ServiceKeys.Profiler);
    // World must build its tilemap before anything queries it.
    this.attach(ServiceKeys.World);
    this.attach(ServiceKeys.Interior);
    // Navigation queries the world's tile grid for pathfinding.
    this.attach(ServiceKeys.Navigation);
    // Gameplay systems (groups created on attach). Vehicle before Wanted so the
    // wanted system can resolve the vehicle registry for pursuit cars.
    this.attach(ServiceKeys.Combat);
    this.attach(ServiceKeys.Vehicle);
    this.attach(ServiceKeys.Occupants);
    this.attach(ServiceKeys.Pedestrian);
    this.attach(ServiceKeys.Traffic);
    this.attach(ServiceKeys.Transportation);
    this.attach(ServiceKeys.Emergency);
    this.attach(ServiceKeys.Crime);
    this.attach(ServiceKeys.Wanted);
    this.attach(ServiceKeys.CityLife);
    this.attach(ServiceKeys.Pickup);
    this.attach(ServiceKeys.Shop);
    this.attach(ServiceKeys.SideGig);
    this.attach(ServiceKeys.Mission);
    this.attach(ServiceKeys.Weather);
    // Player after world/systems: needs the world (spawn point) and camera (follow).
    this.attach(ServiceKeys.Player);
    // Interaction prompts resolve the live player position each frame.
    this.attach(ServiceKeys.Interaction);
  }

  /** Resolve and attach a single scene-bound manager, guarding absence. */
  private attach(key: ServiceKeys): void {
    const mgr = ServiceLocator.tryResolve<BaseSceneManager>(key);
    if (mgr && typeof mgr.attach === 'function') {
      mgr.attach(this);
    } else {
      this.log.debug(`attach skipped: ${key} is not scene-bound`);
    }
  }

  /**
   * Register all Arcade colliders/overlaps between the systems' groups. Walls
   * block movement; bullets damage hostiles; fast cars run people down.
   */
  private wireColliders(): void {
    const world = ServiceLocator.tryResolve<WorldManager>(ServiceKeys.World);
    const combat = ServiceLocator.tryResolve<CombatSystem>(ServiceKeys.Combat);
    const vehicles = ServiceLocator.tryResolve<VehicleSystem>(ServiceKeys.Vehicle);
    const peds = ServiceLocator.tryResolve<PedestrianSystem>(ServiceKeys.Pedestrian);
    const wanted = ServiceLocator.tryResolve<WantedSystem>(ServiceKeys.Wanted);
    const cityLife = ServiceLocator.tryResolve<CityLifeSystem>(ServiceKeys.CityLife);
    const player = ServiceLocator.tryResolve<PlayerController>(ServiceKeys.Player);

    if (!world || !combat || !vehicles || !peds || !wanted || !cityLife || !player) {
      this.log.warn('collider wiring skipped: a gameplay system is missing');
      return;
    }

    const vehicleGroup = vehicles.group;
    const pedGroup = peds.group;
    const policeGroup = wanted.group;
    const airGroup = wanted.airGroup;
    const spikeGroup = wanted.hazardGroup;
    const barrierGroup = wanted.blockadeGroup;
    const lifeGroup = cityLife.group;
    const bulletGroup = combat.bulletGroup;
    const playerSprite = player.player?.sprite ?? null;

    const p = this.physics.add;

    // Terrain exists as local streamed chunks. Rebuild only these layer
    // colliders when WorldManager changes the active chunk window.
    this.rebuildWorldColliders(world, combat, vehicles, peds, wanted, cityLife, player);

    // Vehicles shove one another.
    p.collider(vehicleGroup, vehicleGroup);
    p.collider(vehicleGroup, barrierGroup);

    // Bullets damage anyone hostile (including ambient life and the chopper).
    const onHit: Pair = (b, target) =>
      combat.handleBulletHit(
        b as unknown as Phaser.GameObjects.GameObject,
        target as unknown as Phaser.GameObjects.GameObject,
      );
    p.overlap(bulletGroup, pedGroup, onHit);
    p.overlap(bulletGroup, policeGroup, onHit);
    p.overlap(bulletGroup, lifeGroup, onHit);
    p.overlap(bulletGroup, vehicleGroup, onHit);
    p.overlap(bulletGroup, airGroup, onHit);
    if (playerSprite) p.overlap(bulletGroup, playerSprite, onHit);

    // Fast vehicles run people down (vehicle is always the first argument).
    const onRunOver: Pair = (veh, victim) =>
      combat.handleRunOver(
        veh as unknown as Phaser.GameObjects.GameObject,
        victim as unknown as Phaser.GameObjects.GameObject,
      );
    p.overlap(vehicleGroup, pedGroup, onRunOver);
    p.overlap(vehicleGroup, policeGroup, onRunOver);
    p.overlap(vehicleGroup, lifeGroup, onRunOver);
    if (playerSprite) p.overlap(vehicleGroup, playerSprite, onRunOver);

    // Spike strips shred the tires of any vehicle that rolls over them.
    p.overlap(vehicleGroup, spikeGroup, ((veh) =>
      wanted.handleSpikeHit(veh as unknown as Phaser.GameObjects.GameObject)) as Pair);
  }

  /** Recreate only the colliders that target streamed terrain chunks. */
  private rebuildWorldColliders(
    world: WorldManager,
    combat: CombatSystem,
    vehicles: VehicleSystem,
    peds: PedestrianSystem,
    wanted: WantedSystem,
    cityLife: CityLifeSystem,
    player: PlayerController,
  ): void {
    this.clearWorldColliders();
    const physics = this.physics.add;
    const playerSprite = player.player?.sprite ?? null;
    for (const layer of world.collisionLayers) {
      if (playerSprite) this.worldColliders.push(physics.collider(playerSprite, layer));
      this.worldColliders.push(
        physics.collider(peds.group, layer),
        physics.collider(wanted.group, layer),
        physics.collider(cityLife.group, layer),
        physics.collider(vehicles.group, layer),
        physics.collider(combat.bulletGroup, layer, ((bullet, tile) =>
          combat.handleBulletWorld(
            bullet as unknown as Phaser.GameObjects.GameObject,
            tile as unknown as Phaser.GameObjects.GameObject,
          )) as Pair),
      );
    }
    for (const layer of world.vehicleOnlyCollisionLayers) {
      this.worldColliders.push(physics.collider(vehicles.group, layer));
    }
  }

  /** Resolve live systems and update terrain colliders after a stream swap. */
  private refreshStreamedWorldColliders(): void {
    const world = ServiceLocator.tryResolve<WorldManager>(ServiceKeys.World);
    const combat = ServiceLocator.tryResolve<CombatSystem>(ServiceKeys.Combat);
    const vehicles = ServiceLocator.tryResolve<VehicleSystem>(ServiceKeys.Vehicle);
    const peds = ServiceLocator.tryResolve<PedestrianSystem>(ServiceKeys.Pedestrian);
    const wanted = ServiceLocator.tryResolve<WantedSystem>(ServiceKeys.Wanted);
    const cityLife = ServiceLocator.tryResolve<CityLifeSystem>(ServiceKeys.CityLife);
    const player = ServiceLocator.tryResolve<PlayerController>(ServiceKeys.Player);
    if (!world || !combat || !vehicles || !peds || !wanted || !cityLife || !player) return;
    this.rebuildWorldColliders(world, combat, vehicles, peds, wanted, cityLife, player);
  }

  private clearWorldColliders(): void {
    for (const collider of this.worldColliders) collider.destroy();
    this.worldColliders.length = 0;
  }

  /** Begin the looping city music, best-effort (no-op without audio). */
  private startCityMusic(): void {
    ServiceLocator.tryResolve<MusicManager>(ServiceKeys.Music)?.crossFade(AudioKeys.MusicCity);
  }

  /** Wire pause/resume/quit + the HUD clock bridge onto the shared bus. */
  private wireLifecycleEvents(): void {
    this.unsubs.push(
      eventBus.on(EventKeys.WorldStreamChanged, () => this.refreshStreamedWorldColliders()),
      eventBus.on(EventKeys.GamePaused, () => {
        this.scene.launch(SceneKeys.Pause);
        this.scene.pause();
      }),
      eventBus.on(EventKeys.GamePhoneRequested, () => {
        // Phone is only requested from Playing, but stop any stale modal before
        // bringing the single phone overlay to the top.
        this.scene.stop(SceneKeys.Pause);
        this.scene.stop(SceneKeys.Map);
        this.scene.stop(SceneKeys.Inventory);
        this.scene.stop(SceneKeys.Settings);
        this.scene.stop(SceneKeys.Interior);
        ServiceLocator.tryResolve<InputManager>(ServiceKeys.Input)?.resetGameplayInput();
        if (!this.scene.isActive(SceneKeys.Phone)) {
          this.scene.launch(SceneKeys.Phone);
        }
        this.scene.bringToTop(SceneKeys.Phone);
        this.scene.pause();
      }),
      eventBus.on(EventKeys.GameMapRequested, () => {
        this.scene.stop(SceneKeys.Pause);
        this.scene.stop(SceneKeys.Inventory);
        this.scene.stop(SceneKeys.Interior);
        this.scene.stop(SceneKeys.Phone);
        this.scene.launch(SceneKeys.Map);
        this.scene.bringToTop(SceneKeys.Map);
        this.scene.pause();
      }),
      eventBus.on(EventKeys.GameInventoryRequested, () => {
        this.scene.stop(SceneKeys.Pause);
        this.scene.stop(SceneKeys.Map);
        this.scene.stop(SceneKeys.Interior);
        this.scene.stop(SceneKeys.Phone);
        this.scene.launch(SceneKeys.Inventory, { resumeOnClose: true });
        this.scene.bringToTop(SceneKeys.Inventory);
        this.scene.pause();
      }),
      eventBus.on(EventKeys.GameInteriorRequested, () => {
        this.scene.stop(SceneKeys.Pause);
        this.scene.stop(SceneKeys.Map);
        this.scene.stop(SceneKeys.Inventory);
        this.scene.stop(SceneKeys.Phone);
        this.scene.stop(SceneKeys.Interior);
      }),
      eventBus.on(EventKeys.GameResumed, () => {
        this.scene.stop(SceneKeys.Pause);
        this.scene.stop(SceneKeys.Map);
        this.scene.stop(SceneKeys.Inventory);
        this.scene.stop(SceneKeys.Interior);
        this.scene.stop(SceneKeys.Phone);
        this.scene.resume();
      }),
      eventBus.on(EventKeys.GameQuitToMenu, () => {
        this.scene.stop(SceneKeys.UI);
        this.scene.stop(SceneKeys.Pause);
        this.scene.stop(SceneKeys.Map);
        this.scene.stop(SceneKeys.Inventory);
        this.scene.stop(SceneKeys.Interior);
        this.scene.stop(SceneKeys.Settings);
        this.scene.stop(SceneKeys.Phone);
        this.scene.start(SceneKeys.MainMenu);
      }),
      eventBus.on(EventKeys.TimeChanged, (payload) => {
        eventBus.emit(EventKeys.UIHudUpdate, {
          timeLabel: this.formatClock(payload.hour, payload.minute),
        });
      }),
    );
  }

  /** Register quick-save (F5) and quick-load (F9) hotkeys. */
  private registerHotkeys(): void {
    const keyboard = this.input.keyboard;
    if (!keyboard) return;
    keyboard.on('keydown-F5', () => {
      ServiceLocator.tryResolve<SaveManager>(ServiceKeys.Save)?.save(0, 'Quicksave');
      eventBus.emit(EventKeys.UIToast, { message: 'Game saved' });
    });
    keyboard.on('keydown-F9', () => {
      ServiceLocator.tryResolve<SaveManager>(ServiceKeys.Save)?.load(0);
      eventBus.emit(EventKeys.UIToast, { message: 'Game loaded' });
    });
  }

  /** Format an hour/minute pair as a zero-padded HH:MM clock label. */
  private formatClock(hour: number, minute: number): string {
    const hh = String(Math.floor(hour)).padStart(2, '0');
    const mm = String(Math.floor(minute)).padStart(2, '0');
    return `${hh}:${mm}`;
  }

  /** Detach bus subscriptions when the scene shuts down. */
  private onShutdown(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;
    this.clearWorldColliders();
  }
}
