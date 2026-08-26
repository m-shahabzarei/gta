/**
 * PlayerController — the scene-bound system that owns the player avatar and turns
 * raw input into on-foot and in-vehicle behaviour.
 *
 * It creates the {@link Player} at the world's spawn point, wires the camera to
 * follow whatever the player is currently controlling (their body or a stolen
 * car), and each frame drives movement, aiming, firing, weapon switching,
 * interaction and vehicle entry/exit. It also owns the respawn loop: on death it
 * waits a short delay, then revives the player at the nearest hospital.
 *
 * The controller is the single authority on "where/what is the player", so it
 * implements {@link IPlayerRef} for the AI systems and {@link ISerializable} for
 * the save system. Every cross-system dependency (world, vehicles, camera, input)
 * is resolved defensively through the {@link ServiceLocator} and treated as
 * optional, so the controller degrades gracefully if a system is absent.
 */
import Phaser from 'phaser';
import { BaseSceneManager } from '@/core/BaseSceneManager';
import { ServiceLocator } from '@/core/ServiceLocator';
import { ServiceKeys } from '@/config/ServiceKeys';
import { EventKeys } from '@/config/EventKeys';
import { InputAction } from '@/config/InputConfig';
import { CAMERA, OCCUPANTS, PLAYER, VEHICLE, WORLD_WIDTH, WORLD_HEIGHT } from '@/config/Constants';
import { Player } from '@/entities/Player';
import type { Vehicle } from '@/entities/Vehicle';
import type { InputManager } from '@/managers/InputManager';
import type { CameraManager } from '@/managers/CameraManager';
import { EntityCategory, type EntityManager } from '@/systems/EntityManager';
import type { ISerializable } from '@/core/interfaces';
import type { CrimeType, Json, Vector2 } from '@/core/types';
import { damageAttribution } from '@/gameplay/types';
import { getWorldQuery, type IPlayerRef, type MapData, type VehicleSeat } from '@/gameplay/types';
import type { VehicleOccupantSystem } from '@/systems/VehicleOccupantSystem';
import type { PedestrianSystem } from '@/systems/PedestrianSystem';
import type { TrafficSystem } from '@/systems/TrafficSystem';
import type { TransportationSystem } from '@/systems/TransportationSystem';
import type { WantedSystem } from '@/systems/WantedSystem';
import type { VehicleSystem } from '@/systems/VehicleSystem';
import type { PassengerBoardingFailureReason, PassengerBoardingResult } from '@/gameplay/transit';

interface VehicleEntryTransition {
  vehicle: Vehicle;
  seat: VehicleSeat;
  mode: 'driver' | 'passenger';
  elapsed: number;
  ejectDuration: number;
  start: Vector2;
  door: Vector2;
}

interface VehicleExitTransition {
  vehicle: Vehicle;
  seat: VehicleSeat;
  mode: 'driver' | 'passenger';
  elapsed: number;
  target: Vector2;
}

/**
 * Minimal structural view of the world manager needed for spawning and respawn.
 * The concrete class is resolved at runtime, so only the fields consumed here are
 * declared and every access is guarded.
 */
interface WorldSpawnProvider {
  /** The generated city description, if the world has finished building. */
  readonly map?: MapData;
  /** Nearest hospital position to a world coordinate, if implemented. */
  nearestHospital?(x: number, y: number): Vector2 | null;
  /** Nearest police station position to a world coordinate, if implemented. */
  nearestPoliceStation?(x: number, y: number): Vector2 | null;
}

/**
 * Minimal structural view of the vehicle registry needed for boarding a car.
 */
interface VehicleRegistry {
  /** Nearest non-destroyed vehicle within `maxRange`, or `null`. */
  nearestVehicle(x: number, y: number, maxRange: number): Vehicle | null;
}

export class PlayerController extends BaseSceneManager implements IPlayerRef, ISerializable {
  /** Service-locator key for this system. */
  public readonly key = ServiceKeys.Player;

  /** Stable id under which the player's state is stored in a save file. */
  public readonly saveId = 'player';

  /** Milliseconds between death and automatic respawn. */
  private static readonly RESPAWN_DELAY_MS = 2000;

  /** Extra clearance (px) when placing the player beside an exited vehicle. */
  private static readonly EXIT_CLEARANCE = 6;

  /** Bounded neighborhood inspected before a voluntary actor exit is rejected. */
  private static readonly EXIT_SEARCH_RADIUS = 96;

  /** How far the camera zooms out at full vehicle speed. */
  private static readonly SPEED_ZOOM_OUT = 0.55;

  /** The live player entity for the attached scene, or `null` before spawn. */
  private playerEntity: Player | null = null;

  /** The vehicle the player is currently driving, or `null` when on foot. */
  private vehicleOccupied: Vehicle | null = null;
  /** Service vehicle carrying the player without transferring driving authority. */
  private passengerVehicle: Vehicle | null = null;
  private passengerSeat: VehicleSeat | null = null;
  private entryTransition: VehicleEntryTransition | null = null;
  private exitTransition: VehicleExitTransition | null = null;

  /** Remaining respawn countdown in ms; `0` means no respawn is pending. */
  private respawnTimerMs = 0;

  /** Remaining jail countdown in ms; `0` means no arrest is pending. */
  private jailTimerMs = 0;

  /** Where the player last died, used to pick the nearest hospital. */
  private deathPosition: Vector2 | null = null;

  /** Where the player was arrested, used to pick the nearest police station. */
  private arrestPosition: Vector2 | null = null;

  /**
   * Continue-game loading happens from the main menu before this scene creates
   * the player entity. Retain that validated payload until `onAttach` can apply
   * it to the real inventory instead of silently dropping the saved wallet.
   */
  private pendingSaveData: Json | null = null;

  /** Subscribe to death (respawn loop), destroyed-vehicle ejection and rewards. */
  protected onInit(): void {
    this.subscribe(EventKeys.PlayerDied, (payload) => this.onPlayerDied(payload.position));
    this.subscribe(EventKeys.PlayerBusted, (payload) => this.onPlayerBusted(payload.position));
    this.subscribe(EventKeys.MissionCompleted, (payload) => this.giveReward(payload.reward));
    this.subscribe(EventKeys.VehicleDestroyed, (payload) =>
      this.onVehicleDestroyed(payload.vehicleId),
    );
    this.subscribe(EventKeys.GameNew, () => {
      this.pendingSaveData = null;
    });
    this.log.debug('player controller ready');
  }

  /**
   * If the player's own vehicle is destroyed while they survive the blast, bail
   * them out so they are never stranded in an inert wreck.
   * @param vehicleId Id of the vehicle that was destroyed.
   */
  private onVehicleDestroyed(vehicleId: number): void {
    const vehicle = this.vehicleOccupied ?? this.passengerVehicle;
    const player = this.playerEntity;
    if (!vehicle || vehicle.id !== vehicleId || !player || player.isDead) {
      return;
    }
    this.forceExitVehicle(player);
  }

  /** Spawn the player, then frame and follow it with the main camera. */
  protected onAttach(scene: Phaser.Scene): void {
    this.vehicleOccupied = null;
    this.passengerVehicle = null;
    this.passengerSeat = null;
    this.entryTransition = null;
    this.exitTransition = null;
    this.respawnTimerMs = 0;
    this.jailTimerMs = 0;
    this.deathPosition = null;
    this.arrestPosition = null;

    const spawn = this.resolveSpawnPoint();
    this.playerEntity = new Player(scene, spawn.x, spawn.y);
    const player = this.playerEntity;
    this.resolveEntityManager()?.register(player, {
      category: EntityCategory.Player,
      alwaysActive: true,
      canRender: () =>
        ((this.vehicleOccupied === null && this.passengerVehicle === null) ||
          this.exitTransition !== null) &&
        this.jailTimerMs <= 0,
      canSimulatePhysics: () =>
        !player.isDead &&
        this.vehicleOccupied === null &&
        this.passengerVehicle === null &&
        this.entryTransition === null &&
        this.exitTransition === null &&
        this.jailTimerMs <= 0,
    });

    const camera = this.resolveCamera();
    if (camera) {
      const bounds = this.worldBounds();
      camera.setBounds(0, 0, bounds.x, bounds.y);
      camera.setZoom(CAMERA.DEFAULT_ZOOM);
      camera.follow(this.playerEntity.sprite);
    }

    const pending = this.pendingSaveData;
    this.pendingSaveData = null;
    if (pending !== null) this.applySavedState(player, pending);

    this.bus.emit(EventKeys.PlayerSpawned, { x: spawn.x, y: spawn.y });
    player.publishInitialVitals();
    // HUD presentation mirrors the inventory's real wallet. A later save load
    // replaces this value through InventoryComponent.setMoney; no UI-only money
    // default is involved.
    this.bus.emit(EventKeys.MoneyChanged, { total: player.inventory.money, delta: 0 });
  }

  /** Destroy the player entity on scene teardown. */
  protected override onDetach(_scene: Phaser.Scene): void {
    this.vehicleOccupied = null;
    this.passengerVehicle = null;
    this.passengerSeat = null;
    this.entryTransition = null;
    this.exitTransition = null;
    if (this.playerEntity) this.resolveEntityManager()?.unregister(this.playerEntity);
    this.playerEntity?.destroy();
    this.playerEntity = null;
  }

  /** Advance the respawn loop and, when alive, drive the player each frame. */
  public update(_time: number, delta: number): void {
    this.tickRespawn(delta);
    this.tickJail(delta);
    this.materializeCompletedOccupantExits();

    const player = this.playerEntity;
    if (!player || player.isDead || this.jailTimerMs > 0) {
      return;
    }
    if (this.entryTransition) {
      this.tickVehicleEntry(player, delta);
      return;
    }
    if (this.exitTransition) {
      this.tickVehicleExit(player, delta);
      return;
    }
    const input = this.resolveInput();
    if (!input) {
      return;
    }

    const drivenVehicle = this.vehicleOccupied;
    const passengerVehicle = this.passengerVehicle;
    if (drivenVehicle) {
      this.updateDriving(input, player, drivenVehicle);
    } else if (passengerVehicle) {
      this.updatePassenger(input, player, passengerVehicle);
    } else {
      this.updateOnFoot(input, player);
    }
  }

  // ── IPlayerRef ──────────────────────────────────────────────────────────────

  /** Current player position (the driven car when in a vehicle), or `null`. */
  public get playerPosition(): Vector2 | null {
    const player = this.playerEntity;
    if (!player || player.isDead) {
      return null;
    }
    const vehicle = this.vehicleOccupied ?? this.passengerVehicle;
    if (vehicle) {
      return { x: vehicle.sprite.x, y: vehicle.sprite.y };
    }
    const pos = player.position;
    return { x: pos.x, y: pos.y };
  }

  /** Whether the player is currently driving a vehicle. */
  public get playerInVehicle(): boolean {
    return this.vehicleOccupied !== null || this.passengerVehicle !== null;
  }

  /** Whether the player entity exists and is alive. */
  public get playerAlive(): boolean {
    return this.playerEntity?.isAlive ?? false;
  }

  // ── Public accessors ─────────────────────────────────────────────────────────

  /** The live player entity, or `null` before spawn / after teardown. */
  public get player(): Player | null {
    return this.playerEntity;
  }

  /** The vehicle the player is driving, or `null` when on foot. */
  public get currentVehicle(): Vehicle | null {
    return this.vehicleOccupied ?? this.passengerVehicle;
  }

  /** True while the player rides as a non-driving bus or taxi passenger. */
  public get playerIsTransitPassenger(): boolean {
    return this.passengerVehicle !== null;
  }

  public get currentPassengerSeat(): VehicleSeat | null {
    return this.passengerSeat;
  }

  /**
   * Credit money to the player's wallet (e.g. a mission payout).
   * @param n Amount to award; non-positive values are ignored.
   */
  public giveReward(n: number): void {
    if (n <= 0) {
      return;
    }
    this.playerEntity?.inventory.addMoney(n);
  }

  /**
   * Start a door-mediated passenger transition without stealing vehicle control.
   * Transit calls this only after reserving `seat` in VehicleOccupantSystem.
   */
  public beginPassengerBoarding(
    vehicle: Vehicle,
    seat: VehicleSeat,
    boardingApproach?: Vector2,
  ): PassengerBoardingResult {
    const player = this.playerEntity;
    const occupants = this.resolveOccupants();
    if (!player || player.isDead) return this.rejectPassengerBoarding(vehicle, 'player-unavailable');
    if (!occupants) return this.rejectPassengerBoarding(vehicle, 'boarding-approach-unavailable');
    if (vehicle.isDestroyed || !vehicle.sprite.active) {
      return this.rejectPassengerBoarding(vehicle, 'vehicle-destroyed');
    }
    if (this.vehicleOccupied || this.passengerVehicle) {
      return this.rejectPassengerBoarding(vehicle, 'player-already-in-vehicle');
    }
    if (this.entryTransition || this.exitTransition) {
      return this.rejectPassengerBoarding(vehicle, 'transition-in-progress');
    }
    if (Math.abs(vehicle.movement.speed) > OCCUPANTS.CARJACK_MAX_SPEED) {
      return this.rejectPassengerBoarding(vehicle, 'vehicle-moving');
    }
    const start = { ...player.position };
    const door = boardingApproach
      ? { ...boardingApproach }
      : occupants.doorWorldPosition(vehicle, seat, 4);
    const world = getWorldQuery();
    if (!world) return this.rejectPassengerBoarding(vehicle, 'boarding-approach-unavailable');
    if (!world.isPedestrianClearAtWorld(door.x, door.y, PLAYER.RADIUS)) {
      return this.rejectPassengerBoarding(vehicle, 'door-position-blocked');
    }
    if (!world.isPedestrianSegmentClear(start, door, PLAYER.RADIUS)) {
      return this.rejectPassengerBoarding(vehicle, 'path-to-door-blocked');
    }
    // The exterior approach is a world-space pedestrian path. The following
    // door-to-seat phase is a controlled vehicle-entry animation whose target
    // is intentionally inside the vehicle, so static pedestrian raster checks
    // are not semantically valid for that interior segment.
    this.entryTransition = {
      vehicle,
      seat,
      mode: 'passenger',
      elapsed: 0,
      ejectDuration: OCCUPANTS.DOOR_OPEN_MS,
      start,
      door,
    };
    player.stopMoving();
    player.movement.setEnabled(false);
    const body = player.sprite.body as Phaser.Physics.Arcade.Body;
    body.setVelocity(0, 0);
    body.enable = false;
    this.bus.emit(EventKeys.VehicleDoor, { open: true, vehicleId: vehicle.id, seat });
    return { ok: true };
  }

  private rejectPassengerBoarding(
    vehicle: Vehicle,
    reason: PassengerBoardingFailureReason,
  ): PassengerBoardingResult {
    this.log.debug(`Passenger boarding rejected vehicle=${vehicle.id} reason=${reason}`);
    return { ok: false, reason };
  }

  /** Begin a passenger exit to a transit-supplied curb/platform location. */
  public beginPassengerExit(requested: Vector2): boolean {
    const player = this.playerEntity;
    const vehicle = this.passengerVehicle;
    const seat = this.passengerSeat;
    const occupants = this.resolveOccupants();
    if (!player || !vehicle || !seat || !occupants || this.exitTransition || this.entryTransition) {
      return false;
    }
    const target = this.resolveSafeVehicleExitPosition(vehicle, requested, false);
    if (!target) return false;
    const seatPosition = occupants.seatWorldPosition(vehicle, seat);
    player.sprite.setPosition(seatPosition.x, seatPosition.y).setVisible(true).setActive(true);
    const body = player.sprite.body as Phaser.Physics.Arcade.Body;
    body.enable = false;
    this.exitTransition = { vehicle, seat, mode: 'passenger', elapsed: 0, target };
    this.bus.emit(EventKeys.VehicleDoor, { open: true, vehicleId: vehicle.id, seat });
    return true;
  }

  // ── On-foot control ──────────────────────────────────────────────────────────

  /** Drive walking, aiming, firing, weapon switching and interaction. */
  private updateOnFoot(input: InputManager, player: Player): void {
    const axis = input.getAxis();
    player.moveDir(axis.x, axis.y, input.isDown(InputAction.Run));

    const moveLen = Math.hypot(axis.x, axis.y);
    const aimVector = input.getAimVector();
    const aimAngle =
      aimVector !== null
        ? Math.atan2(aimVector.y, aimVector.x)
        : moveLen > 1e-3
          ? Math.atan2(axis.y, axis.x)
          : player.movement.facingAngle;

    if (moveLen > 1e-3 || aimVector !== null) {
      player.face(aimAngle);
    }

    if (input.isDown(InputAction.Attack)) {
      const fired = player.fireAt(aimAngle);
      const isMelee = player.weaponComp.weapon?.isMelee ?? true;
      if (fired && !isMelee) {
        this.emitCrime('gunfire', player.position);
      }
    }

    if (input.isJustDown(InputAction.NextWeapon)) {
      player.switchWeapon(1);
    } else if (input.isJustDown(InputAction.PrevWeapon)) {
      player.switchWeapon(-1);
    }

    if (input.isJustDown(InputAction.Reload)) {
      player.startReload();
    }

    if (input.isJustDown(InputAction.EnterVehicle)) {
      this.tryEnterVehicle(player);
    }

    if (input.isJustDown(InputAction.Interact)) {
      const pos = player.position;
      this.bus.emit(EventKeys.PlayerInteract, { x: pos.x, y: pos.y });
    }
  }

  /** A passenger retains camera follow and interaction, but never receives driving authority. */
  private updatePassenger(input: InputManager, player: Player, vehicle: Vehicle): void {
    player.stopMoving();
    if (
      input.isJustDown(InputAction.Interact) ||
      input.isJustDown(InputAction.EnterVehicle)
    ) {
      this.bus.emit(EventKeys.PlayerInteract, { x: vehicle.sprite.x, y: vehicle.sprite.y });
    }
  }

  // ── In-vehicle control ───────────────────────────────────────────────────────

  /** Drive throttle/steering from the movement axis; handle horn, camera and exit. */
  private updateDriving(input: InputManager, player: Player, vehicle: Vehicle): void {
    const axis = input.getAxis();
    vehicle.movement.setThrottle(-axis.y);
    vehicle.movement.setSteer(axis.x);
    if (input.isDown(InputAction.Handbrake)) {
      vehicle.movement.brake();
    }

    if (input.isJustDown(InputAction.Horn)) {
      this.bus.emit(EventKeys.HornSounded, { kind: vehicle.def.kind });
    }

    // Pull the camera back a touch at high speed for a sense of pace.
    this.applySpeedZoom(vehicle);

    if (input.isJustDown(InputAction.EnterVehicle)) {
      this.beginExitVehicle(player);
    }
  }

  /** Ease the camera zoom out slightly as vehicle speed rises. */
  private applySpeedZoom(vehicle: Vehicle): void {
    const camera = this.resolveCamera();
    if (!camera) return;
    const ratio = Math.min(1, Math.abs(vehicle.movement.speed) / vehicle.def.maxSpeed);
    const target = CAMERA.DEFAULT_ZOOM - ratio * PlayerController.SPEED_ZOOM_OUT;
    const cam = camera.camera;
    if (cam) {
      cam.setZoom(Phaser.Math.Linear(cam.zoom, target, 0.06));
    }
  }

  /**
   * Attempt to board the nearest drivable vehicle within {@link VEHICLE.ENTER_RANGE}.
   * @param player The on-foot player attempting entry.
   */
  private tryEnterVehicle(player: Player): void {
    const pos = player.position;
    const transit = ServiceLocator.tryResolve<TransportationSystem>(ServiceKeys.Transportation);
    const transitInteraction = transit?.interactionAt(pos);
    if (
      transitInteraction?.kind === 'enter-taxi' ||
      transitInteraction?.kind === 'board-bus'
    ) {
      // F/Enter is the semantic vehicle-entry action. Route it through the same
      // authoritative transit interaction as E so Snapp always targets the
      // assigned booking vehicle rather than whichever vehicle is merely nearest.
      this.bus.emit(EventKeys.PlayerInteract, { x: pos.x, y: pos.y });
      return;
    }
    const registry = this.resolveVehicles();
    if (!registry) {
      return;
    }
    const vehicle = registry.nearestVehicle(pos.x, pos.y, VEHICLE.ENTER_RANGE);
    if (
      !vehicle ||
      vehicle.isDestroyed ||
      Math.abs(vehicle.movement.speed) > OCCUPANTS.CARJACK_MAX_SPEED
    ) {
      return;
    }
    if (vehicle.sprite.getData('persistentTransitService') === true) {
      this.bus.emit(EventKeys.PlayerInteract, { x: pos.x, y: pos.y });
      return;
    }
    const occupants = this.resolveOccupants();
    if (!occupants) return;
    const manifest = occupants.occupantsFor(vehicle);
    const driver = manifest.find((occupant) => occupant.seat === 'driver') ?? null;
    const start = { ...player.position };
    const door = occupants.doorWorldPosition(vehicle, 'driver', 4);
    const seat = occupants.seatWorldPosition(vehicle, 'driver');
    const world = getWorldQuery();
    if (
      !world ||
      !world.isPedestrianClearAtWorld(door.x, door.y, PLAYER.RADIUS) ||
      !world.isPedestrianSegmentClear(start, door, PLAYER.RADIUS) ||
      !world.isPedestrianSegmentClear(door, seat, PLAYER.RADIUS)
    ) {
      return;
    }
    if (!vehicle.sprite.getData('stolenByPlayer')) {
      this.emitCrime('vehicle-theft', { x: vehicle.sprite.x, y: vehicle.sprite.y });
      vehicle.sprite.setData('stolenByPlayer', true);
    }
    const carjack = occupants.beginCarjack(vehicle);
    const occupantExitDuration = OCCUPANTS.DOOR_OPEN_MS + OCCUPANTS.EXIT_MS + OCCUPANTS.FALL_MS;
    this.entryTransition = {
      vehicle,
      seat: 'driver',
      mode: 'driver',
      elapsed: 0,
      ejectDuration:
        driver || carjack.passengers.length > 0 ? occupantExitDuration : OCCUPANTS.DOOR_OPEN_MS,
      start,
      door,
    };
    player.stopMoving();
    player.movement.setEnabled(false);
    const body = player.sprite.body as Phaser.Physics.Arcade.Body;
    body.setVelocity(0, 0);
    body.enable = false;
    this.resolveTraffic()?.setDriverStopped(vehicle, true);
    this.bus.emit(EventKeys.VehicleDoor, {
      open: true,
      vehicleId: vehicle.id,
      seat: 'driver',
    });
  }

  /**
   * Leave the current vehicle, placing the player alongside it.
   * @param player The player currently behind the wheel.
   */
  private beginExitVehicle(player: Player): void {
    const vehicle = this.vehicleOccupied;
    if (!vehicle || this.exitTransition) return;
    const occupants = this.resolveOccupants();
    if (!occupants) return;
    const requested = occupants.doorWorldPosition(vehicle, 'driver', PLAYER.RADIUS + 5);
    const target = this.resolveSafeVehicleExitPosition(vehicle, requested, false);
    if (!target) return;
    vehicle.movement.setThrottle(0);
    vehicle.movement.setSteer(0);
    vehicle.setPlayerDriven(false);
    const seat = occupants.seatWorldPosition(vehicle, 'driver');
    player.sprite.setPosition(seat.x, seat.y).setVisible(true).setActive(true);
    const body = player.sprite.body as Phaser.Physics.Arcade.Body;
    body.enable = false;
    this.exitTransition = { vehicle, seat: 'driver', mode: 'driver', elapsed: 0, target };
    this.bus.emit(EventKeys.VehicleDoor, {
      open: true,
      vehicleId: vehicle.id,
      seat: 'driver',
    });
  }

  private tickVehicleEntry(player: Player, delta: number): void {
    const transition = this.entryTransition;
    const occupants = this.resolveOccupants();
    if (!transition || !occupants || transition.vehicle.isDestroyed) {
      this.cancelEntry(player);
      return;
    }
    transition.elapsed += delta;
    const door = transition.door;
    const seat = occupants.seatWorldPosition(transition.vehicle, transition.seat);
    const enterStart = transition.ejectDuration;
    const closeStart = enterStart + OCCUPANTS.BOARD_MS;
    const finish = closeStart + OCCUPANTS.DOOR_CLOSE_MS;
    if (transition.elapsed < OCCUPANTS.DOOR_OPEN_MS) {
      const t = Phaser.Math.Clamp(transition.elapsed / OCCUPANTS.DOOR_OPEN_MS, 0, 1);
      player.sprite.setPosition(
        Phaser.Math.Linear(transition.start.x, door.x, t),
        Phaser.Math.Linear(transition.start.y, door.y, t),
      );
    } else if (transition.elapsed < enterStart) {
      player.sprite.setPosition(door.x, door.y);
    } else if (transition.elapsed < closeStart) {
      const t = Phaser.Math.Clamp((transition.elapsed - enterStart) / OCCUPANTS.BOARD_MS, 0, 1);
      player.sprite.setPosition(
        Phaser.Math.Linear(door.x, seat.x, t),
        Phaser.Math.Linear(door.y, seat.y, t),
      );
    } else {
      player.sprite.setPosition(seat.x, seat.y).setVisible(false);
    }
    if (transition.elapsed < finish) return;
    this.completeVehicleEntry(player, transition);
  }

  private completeVehicleEntry(player: Player, transition: VehicleEntryTransition): void {
    const { vehicle } = transition;
    this.entryTransition = null;
    if (transition.mode === 'passenger') {
      this.passengerVehicle = vehicle;
      this.passengerSeat = transition.seat;
      player.sprite.setVisible(false);
      this.resolveCamera()?.follow(vehicle.sprite);
      this.bus.emit(EventKeys.VehicleDoor, {
        open: false,
        vehicleId: vehicle.id,
        seat: transition.seat,
      });
      this.bus.emit(EventKeys.PlayerEnteredVehicle, {
        vehicleId: vehicle.id,
        seat: transition.seat,
        mode: 'passenger',
      });
      return;
    }
    this.vehicleOccupied = vehicle;
    this.resolveTraffic()?.releaseDriver(vehicle.id);
    this.resolveOccupants()?.claimDriverSeat(vehicle, player.id);
    vehicle.setPlayerDriven(true);
    player.sprite.setVisible(false);
    this.resolveCamera()?.follow(vehicle.sprite);
    this.bus.emit(EventKeys.VehicleDoor, {
      open: false,
      vehicleId: vehicle.id,
      seat: 'driver',
    });
    this.bus.emit(EventKeys.PlayerEnteredVehicle, {
      vehicleId: vehicle.id,
      seat: 'driver',
      mode: 'driver',
    });
    this.bus.emit(EventKeys.EngineStateChanged, { running: true, vehicleKind: vehicle.def.kind });
  }

  private tickVehicleExit(player: Player, delta: number): void {
    const transition = this.exitTransition;
    const occupants = this.resolveOccupants();
    if (!transition || !occupants) return;
    transition.elapsed += delta;
    const seat = occupants.seatWorldPosition(transition.vehicle, transition.seat);
    const target = transition.target;
    const moveStart = OCCUPANTS.DOOR_OPEN_MS;
    const closeStart = moveStart + OCCUPANTS.EXIT_MS;
    const finish = closeStart + OCCUPANTS.DOOR_CLOSE_MS;
    if (transition.elapsed < moveStart) {
      player.sprite.setPosition(seat.x, seat.y);
    } else {
      const t = Phaser.Math.Clamp((transition.elapsed - moveStart) / OCCUPANTS.EXIT_MS, 0, 1);
      player.sprite.setPosition(
        Phaser.Math.Linear(seat.x, target.x, t),
        Phaser.Math.Linear(seat.y, target.y, t),
      );
    }
    if (transition.elapsed < finish) return;
    this.completeVehicleExit(player, transition, target);
  }

  private completeVehicleExit(
    player: Player,
    transition: Pick<VehicleExitTransition, 'vehicle' | 'seat' | 'mode'>,
    position: Vector2,
  ): void {
    const { vehicle } = transition;
    this.exitTransition = null;
    if (transition.mode === 'driver') {
      this.vehicleOccupied = null;
      vehicle.setDriverId(null);
    } else {
      this.passengerVehicle = null;
      this.passengerSeat = null;
      this.resolveOccupants()?.releasePlayerPassengerSeat(vehicle);
    }
    player.sprite.enableBody(true, position.x, position.y, true, true);
    player.movement.setEnabled(true);
    player.stopMoving();
    const camera = this.resolveCamera();
    camera?.follow(player.sprite);
    camera?.setZoom(CAMERA.DEFAULT_ZOOM, 250);
    this.bus.emit(EventKeys.VehicleDoor, {
      open: false,
      vehicleId: vehicle.id,
      seat: transition.seat,
    });
    this.bus.emit(EventKeys.PlayerExitedVehicle, { vehicleId: vehicle.id });
    if (transition.mode === 'driver') {
      this.bus.emit(EventKeys.EngineStateChanged, { running: false });
    }
  }

  private forceExitVehicle(player: Player): void {
    const vehicle = this.vehicleOccupied ?? this.passengerVehicle;
    if (!vehicle) return;
    const side = vehicle.movement.heading + Math.PI / 2;
    const distance = vehicle.def.width / 2 + PLAYER.RADIUS + PlayerController.EXIT_CLEARANCE;
    const position = {
      x: vehicle.sprite.x + Math.cos(side) * distance,
      y: vehicle.sprite.y + Math.sin(side) * distance,
    };
    const safePosition = this.resolveSafeVehicleExitPosition(vehicle, position, true);
    if (!safePosition) return;
    const mode = this.vehicleOccupied ? 'driver' : 'passenger';
    const seat = mode === 'driver' ? 'driver' : (this.passengerSeat ?? 'rear-right');
    if (mode === 'driver') vehicle.setPlayerDriven(false);
    this.completeVehicleExit(player, { vehicle, seat, mode }, safePosition);
  }

  private cancelEntry(player: Player): void {
    const transition = this.entryTransition;
    this.entryTransition = null;
    if (!transition) return;
    if (transition.mode === 'passenger') {
      this.resolveOccupants()?.releasePlayerPassengerSeat(transition.vehicle);
    }
    const query = getWorldQuery();
    const position = query
      ? (query.resolveSafePedestrianPosition(transition.start, PLAYER.RADIUS, {
          maxDistance: PlayerController.EXIT_SEARCH_RADIUS,
        }) ?? query.resolveSafePedestrianPosition(transition.start, PLAYER.RADIUS))
      : transition.start;
    if (!position) return;
    player.sprite.enableBody(true, position.x, position.y, true, true);
    player.movement.setEnabled(true);
  }

  private materializeCompletedOccupantExits(): void {
    const occupants = this.resolveOccupants();
    if (!occupants) return;
    const exits = [
      ...occupants.drainCompletedExits('carjack'),
      ...occupants.drainCompletedExits('passenger-escape'),
    ];
    for (const exit of exits) {
      const vehicle = this.vehicleForId(exit.vehicleId);
      const requested = { x: exit.x, y: exit.y };
      const position = vehicle
        ? this.resolveSafeVehicleExitPosition(vehicle, requested, false)
        : getWorldQuery()?.resolveSafePedestrianPosition(requested, PLAYER.RADIUS, {
            maxDistance: PlayerController.EXIT_SEARCH_RADIUS,
          });
      if (!position) continue;
      const safeExit = { ...exit, x: position.x, y: position.y };
      const police =
        exit.occupant.role === 'police-officer' || exit.occupant.role === 'police-supervisor';
      if (police) {
        this.resolveWanted()?.materializeCarjackedOfficer(safeExit);
        continue;
      }
      const pedestrian = this.resolvePedestrians()?.spawnFromVehicleOccupant(
        exit.occupant,
        position.x,
        position.y,
      );
      const danger = vehicle;
      pedestrian?.ai.reactToCrime(
        exit.occupant.reaction,
        danger ? { x: danger.sprite.x, y: danger.sprite.y } : position,
        this.playerEntity,
      );
    }
  }

  // ── Respawn loop ─────────────────────────────────────────────────────────────

  /** Arm the respawn timer and drop the player out of any vehicle on death. */
  private onPlayerDied(position: Vector2): void {
    this.deathPosition = { x: position.x, y: position.y };
    this.respawnTimerMs = PlayerController.RESPAWN_DELAY_MS;
    if (this.entryTransition) {
      const transition = this.entryTransition;
      if (transition.mode === 'driver') this.resolveTraffic()?.setDriverStopped(transition.vehicle, false);
      else this.resolveOccupants()?.releasePlayerPassengerSeat(transition.vehicle);
      this.entryTransition = null;
    }
    this.exitTransition = null;

    this.clearPlayerVehicleState();
  }

  /** Arm the jail timer and immobilise the player after being busted. */
  private onPlayerBusted(position: Vector2): void {
    const player = this.playerEntity;
    if (!player || player.isDead) {
      return;
    }
    this.arrestPosition = { x: position.x, y: position.y };
    this.jailTimerMs = PlayerController.RESPAWN_DELAY_MS;
    if (this.entryTransition) {
      const transition = this.entryTransition;
      if (transition.mode === 'driver') this.resolveTraffic()?.setDriverStopped(transition.vehicle, false);
      else this.resolveOccupants()?.releasePlayerPassengerSeat(transition.vehicle);
      this.entryTransition = null;
    }
    this.exitTransition = null;

    this.clearPlayerVehicleState();

    player.stopMoving();
    player.movement.setEnabled(false);
    const body = player.sprite.body as Phaser.Physics.Arcade.Body;
    body.setVelocity(0, 0);
  }

  /** Drop either driving or passenger ownership without disturbing a service driver. */
  private clearPlayerVehicleState(): void {
    const drivenVehicle = this.vehicleOccupied;
    if (drivenVehicle) {
      drivenVehicle.setPlayerDriven(false);
      drivenVehicle.setDriverId(null);
      this.vehicleOccupied = null;
    }
    const passengerVehicle = this.passengerVehicle;
    if (passengerVehicle) {
      this.resolveOccupants()?.releasePlayerPassengerSeat(passengerVehicle);
      this.passengerVehicle = null;
      this.passengerSeat = null;
    }
  }

  /** Count the respawn timer down and revive the player when it elapses. */
  private tickRespawn(delta: number): void {
    if (this.respawnTimerMs <= 0) {
      return;
    }
    this.respawnTimerMs -= delta;
    if (this.respawnTimerMs > 0) {
      return;
    }
    this.respawnTimerMs = 0;
    this.respawnPlayer();
  }

  /** Count the jail timer down and respawn at the nearest police station. */
  private tickJail(delta: number): void {
    if (this.jailTimerMs <= 0) {
      return;
    }
    this.jailTimerMs -= delta;
    if (this.jailTimerMs > 0) {
      return;
    }
    this.jailTimerMs = 0;
    this.respawnAtPoliceStation();
  }

  /** Revive the player at the nearest hospital and re-follow with the camera. */
  private respawnPlayer(): void {
    const player = this.playerEntity;
    if (!player) {
      return;
    }
    const from = this.deathPosition ?? player.position;
    const spawn = this.resolveHospital(from);

    player.respawn(spawn.x, spawn.y);
    this.resolveCamera()?.follow(player.sprite);
    this.bus.emit(EventKeys.PlayerRespawned, { x: spawn.x, y: spawn.y });
  }

  /** Respawn the player at the nearest police station after an arrest. */
  private respawnAtPoliceStation(): void {
    const player = this.playerEntity;
    if (!player) {
      return;
    }
    const from = this.arrestPosition ?? player.position;
    const spawn = this.resolvePoliceStation(from);

    player.respawn(spawn.x, spawn.y);
    this.resolveCamera()?.follow(player.sprite);
    this.bus.emit(EventKeys.PlayerRespawned, { x: spawn.x, y: spawn.y });
  }

  // ── Spawn / world resolution ─────────────────────────────────────────────────

  /** Resolve the initial spawn point from the world map, then sensible defaults. */
  private resolveSpawnPoint(): Vector2 {
    const start = this.resolveWorld()?.map?.playerStart;
    if (start) {
      return { x: start.x, y: start.y };
    }
    const query = getWorldQuery();
    if (query) {
      return { x: query.widthPx / 2, y: query.heightPx / 2 };
    }
    return this.defaultSpawn();
  }

  /** Resolve a nearby actor-safe vehicle exit, with an optional global forced-exit fallback. */
  private resolveSafeVehicleExitPosition(
    vehicle: Vehicle,
    requested: Vector2,
    allowGlobalFallback: boolean,
  ): Vector2 | null {
    const query = getWorldQuery();
    if (!query) return null;
    const local = query.resolveSafePedestrianPosition(requested, PLAYER.RADIUS, {
      maxDistance: PlayerController.EXIT_SEARCH_RADIUS,
      segmentStart: { x: vehicle.sprite.x, y: vehicle.sprite.y },
    });
    if (local || !allowGlobalFallback) return local;
    return query.resolveSafePedestrianPosition(requested, PLAYER.RADIUS);
  }

  /** Resolve the nearest hospital to `from`, falling back through the map. */
  private resolveHospital(from: Vector2): Vector2 {
    const world = this.resolveWorld();
    if (world && typeof world.nearestHospital === 'function') {
      const nearest = world.nearestHospital(from.x, from.y);
      if (nearest) {
        return { x: nearest.x, y: nearest.y };
      }
    }
    const hospitals = world?.map?.hospitals;
    if (hospitals && hospitals.length > 0) {
      const first = hospitals[0];
      if (first) {
        return { x: first.x, y: first.y };
      }
    }
    const start = world?.map?.playerStart;
    if (start) {
      return { x: start.x, y: start.y };
    }
    return this.defaultSpawn();
  }

  /** Resolve the nearest police station to `from`, falling back through the map. */
  private resolvePoliceStation(from: Vector2): Vector2 {
    const world = this.resolveWorld();
    if (world && typeof world.nearestPoliceStation === 'function') {
      const nearest = world.nearestPoliceStation(from.x, from.y);
      if (nearest) {
        return { x: nearest.x, y: nearest.y };
      }
    }
    const stations = world?.map?.policeStations;
    if (stations && stations.length > 0) {
      const first = stations[0];
      if (first) {
        return { x: first.x, y: first.y };
      }
    }
    return this.resolveHospital(from);
  }

  /** World pixel bounds, from the world query when available. */
  private worldBounds(): Vector2 {
    const query = getWorldQuery();
    return {
      x: query?.widthPx ?? WORLD_WIDTH,
      y: query?.heightPx ?? WORLD_HEIGHT,
    };
  }

  /** Centre-of-world fallback used when no world data is available. */
  private defaultSpawn(): Vector2 {
    return { x: WORLD_WIDTH / 2, y: WORLD_HEIGHT / 2 };
  }

  // ── Service resolution ───────────────────────────────────────────────────────

  /** Resolve the scene input manager, or `null` when absent. */
  private resolveInput(): InputManager | null {
    return ServiceLocator.tryResolve<InputManager>(ServiceKeys.Input);
  }

  /** Resolve the camera manager, or `null` when absent. */
  private resolveCamera(): CameraManager | null {
    return ServiceLocator.tryResolve<CameraManager>(ServiceKeys.Camera);
  }

  private resolveEntityManager(): EntityManager | null {
    return ServiceLocator.tryResolve<EntityManager>(ServiceKeys.Entity);
  }

  /** Resolve the world manager as its structural spawn view, or `null`. */
  private resolveWorld(): WorldSpawnProvider | null {
    const service = ServiceLocator.tryResolve(ServiceKeys.World);
    return service ? (service as unknown as WorldSpawnProvider) : null;
  }

  /** Resolve the vehicle system as its structural registry view, or `null`. */
  private resolveVehicles(): VehicleRegistry | null {
    const service = ServiceLocator.tryResolve(ServiceKeys.Vehicle);
    if (!service) {
      return null;
    }
    const registry = service as unknown as VehicleRegistry;
    return typeof registry.nearestVehicle === 'function' ? registry : null;
  }

  private resolveOccupants(): VehicleOccupantSystem | null {
    return ServiceLocator.tryResolve<VehicleOccupantSystem>(ServiceKeys.Occupants);
  }

  private resolvePedestrians(): PedestrianSystem | null {
    return ServiceLocator.tryResolve<PedestrianSystem>(ServiceKeys.Pedestrian);
  }

  private resolveTraffic(): TrafficSystem | null {
    return ServiceLocator.tryResolve<TrafficSystem>(ServiceKeys.Traffic);
  }

  private resolveWanted(): WantedSystem | null {
    return ServiceLocator.tryResolve<WantedSystem>(ServiceKeys.Wanted);
  }

  private vehicleForId(id: number): Vehicle | null {
    const vehicles = ServiceLocator.tryResolve<VehicleSystem>(ServiceKeys.Vehicle);
    if (!vehicles) return null;
    for (const vehicle of vehicles.vehicles) if (vehicle.id === id) return vehicle;
    return null;
  }

  /** Emit a crime at a position (defensively copying the coordinates). */
  private emitCrime(crime: CrimeType, position: Vector2): void {
    this.bus.emit(EventKeys.CrimeCommitted, {
      crime,
      position: { x: position.x, y: position.y },
      attribution: damageAttribution('unknown', true, {
        sourceId: this.playerEntity?.id,
        lastAttackerId: this.playerEntity?.id,
      }),
    });
  }

  // ── ISerializable ────────────────────────────────────────────────────────────

  /** Snapshot the player's position, health, armor, money and armoury. */
  public serialize(): Json {
    const player = this.playerEntity;
    if (!player) {
      return { x: 0, y: 0, health: 0, money: 0 };
    }
    const pos = player.position;
    return {
      x: pos.x,
      y: pos.y,
      health: player.currentHP,
      armor: player.armor,
      money: player.inventory.money,
      inventory: player.inventory.snapshotInventory() as unknown as Json,
      weapons: player.inventory.snapshotWeapons(),
    };
  }

  /**
   * Best-effort restore of the player's position, money and health from a
   * previously produced snapshot. Malformed or partial data is ignored field by
   * field so a corrupt save can never crash the load.
   * @param data A value previously returned by {@link serialize}.
   */
  public deserialize(data: Json): void {
    const player = this.playerEntity;
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      return;
    }
    if (!player) {
      this.pendingSaveData = data;
      return;
    }
    this.applySavedState(player, data);
  }

  /** Apply one previously validated save section to an already constructed player. */
  private applySavedState(player: Player, data: Json): void {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return;
    const record = data as { [key: string]: Json };

    const x = record.x;
    const y = record.y;
    if (
      typeof x === 'number' &&
      typeof y === 'number' &&
      Number.isFinite(x) &&
      Number.isFinite(y)
    ) {
      const query = getWorldQuery();
      const playerStart = this.resolveWorld()?.map?.playerStart;
      const safePosition = query?.resolveSafePedestrianPosition({ x, y }, PLAYER.RADIUS);
      const fallback = playerStart
        ? query?.resolveSafePedestrianPosition(playerStart, PLAYER.RADIUS)
        : null;
      const restored = safePosition ?? fallback;
      if (restored) player.sprite.setPosition(restored.x, restored.y);
    }

    const money = record.money;
    if (typeof money === 'number') {
      player.inventory.setMoney(money);
    }

    const armor = record.armor;
    const health = record.health;
    player.restoreVitals(
      typeof health === 'number' ? health : player.currentHP,
      typeof armor === 'number' ? armor : player.armor,
    );

    // Armoury fields are guarded so pre-v2 saves load cleanly.
    if (record.inventory !== undefined) {
      player.inventory.restoreInventory(record.inventory);
      player.refreshEquippedWeapon();
    } else if (record.weapons !== undefined) {
      player.inventory.restoreWeapons(record.weapons);
      player.refreshEquippedWeapon();
    }
  }
}
