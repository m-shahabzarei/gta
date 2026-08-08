import Phaser from 'phaser';
import { BaseSceneManager } from '@/core/BaseSceneManager';
import { ServiceLocator } from '@/core/ServiceLocator';
import { ServiceKeys } from '@/config/ServiceKeys';
import { EventKeys } from '@/config/EventKeys';
import { DepthLayers } from '@/config/DepthLayers';
import { ENGINE_LIMITS } from '@/config/EngineLimits';
import { OCCUPANTS } from '@/config/Constants';
import { EngineDiagnostics } from '@/core/EngineDiagnostics';
import { civilianReaction, personalityFromSeed } from '@/gameplay/crime/CrimeRules';
import { isPoliceOccupant, occupantManifestFor } from '@/gameplay/occupants/OccupantRules';
import type {
  CompletedVehicleExit,
  NpcPersonality,
  VehicleOccupantRecord,
  VehicleOccupantRole,
  VehicleSeat,
  WitnessKind,
} from '@/gameplay/types';
import type { Vector2 } from '@/core/types';
import { getPlayerRef } from '@/gameplay/types';
import type { Vehicle } from '@/entities/Vehicle';
import type { VehicleSystem } from './VehicleSystem';

interface ExitTransition {
  vehicle: Vehicle;
  occupant: VehicleOccupantRecord;
  reason: CompletedVehicleExit['reason'];
  elapsed: number;
  delay: number;
  target: Vector2;
}

interface BoardingTransition {
  vehicle: Vehicle;
  occupant: VehicleOccupantRecord;
  elapsed: number;
  from: Vector2;
}

export interface VehicleWitness {
  id: number;
  kind: WitnessKind;
  personality: NpcPersonality;
  position: Vector2;
  vehicle: Vehicle;
  occupant: VehicleOccupantRecord;
}

export interface CarjackManifest {
  driver: VehicleOccupantRecord | null;
  passengers: readonly VehicleOccupantRecord[];
}

const DRIVER_COLOR = 0xf1c27d;
const PASSENGER_COLOR = 0xd7a56d;
const POLICE_COLOR = 0x76a9ff;
const SERVICE_COLOR = 0xf1f5f9;

/** Persistent seat ownership, transitions, and one-draw-call occupant rendering. */
export class VehicleOccupantSystem extends BaseSceneManager {
  public readonly key = ServiceKeys.Occupants;

  private readonly manifests = new Map<number, VehicleOccupantRecord[]>();
  private readonly vehicleRefs = new Map<number, Vehicle>();
  private readonly exitTransitions: ExitTransition[] = [];
  private readonly boardingTransitions: BoardingTransition[] = [];
  private readonly completedExits: CompletedVehicleExit[] = [];
  private nextOccupantId = 1;
  private occupantCount = 0;
  private graphics: Phaser.GameObjects.Graphics | null = null;
  private vehicles: VehicleSystem | null = null;

  protected onInit(): void {
    this.subscribe(EventKeys.VehicleSpawned, ({ vehicleId }) => {
      const vehicle = this.resolveVehicle(vehicleId);
      if (vehicle) this.ensureManifest(vehicle);
    });
    this.subscribe(EventKeys.VehicleRemoved, ({ vehicleId }) => this.removeManifest(vehicleId));
  }

  protected onAttach(scene: Phaser.Scene): void {
    this.vehicles = ServiceLocator.tryResolve<VehicleSystem>(ServiceKeys.Vehicle);
    this.graphics = scene.add.graphics().setDepth(DepthLayers.Vehicles + 1);
    this.vehicles?.forEachVehicle((vehicle) => this.ensureManifest(vehicle));
  }

  protected onDetach(_scene: Phaser.Scene): void {
    this.graphics?.destroy();
    this.graphics = null;
    this.manifests.clear();
    this.vehicleRefs.clear();
    this.exitTransitions.length = 0;
    this.boardingTransitions.length = 0;
    this.completedExits.length = 0;
    this.occupantCount = 0;
    this.nextOccupantId = 1;
    this.vehicles = null;
  }

  public update(_time: number, delta: number): void {
    const vehicles = this.vehicles;
    if (!vehicles || !this.graphics) return;
    vehicles.forEachVehicle((vehicle) => this.ensureManifest(vehicle));
    this.tickExits(delta);
    this.tickBoarding(delta);
    this.renderOccupants();
  }

  public occupantsFor(vehicle: Vehicle): readonly VehicleOccupantRecord[] {
    return this.manifests.get(vehicle.id) ?? [];
  }

  public debugSnapshot(): {
    occupants: number;
    occupiedVehicles: number;
    movingWithoutDriver: number;
    policeWithoutCrew: number;
    transitions: number;
  } {
    let movingWithoutDriver = 0;
    let policeWithoutCrew = 0;
    this.vehicles?.forEachVehicle((vehicle) => {
      if (vehicle.isDestroyed) return;
      if (Math.abs(vehicle.movement.speed) > 2 && vehicle.driverId === null) {
        movingWithoutDriver += 1;
      }
      const police = vehicle.def.kind === 'police' || vehicle.def.kind === 'policeSuv';
      if (
        police &&
        Math.abs(vehicle.movement.speed) > 2 &&
        !vehicle.isPlayerDriven &&
        !this.hasPoliceCrew(vehicle)
      ) {
        policeWithoutCrew += 1;
      }
    });
    return {
      occupants: this.occupantCount,
      occupiedVehicles: this.manifests.size,
      movingWithoutDriver,
      policeWithoutCrew,
      transitions: this.exitTransitions.length + this.boardingTransitions.length,
    };
  }

  public hasPoliceCrew(vehicle: Vehicle): boolean {
    return (this.manifests.get(vehicle.id) ?? []).some(
      (occupant) => occupant.role === 'police-officer' || occupant.role === 'police-supervisor',
    );
  }

  public forEachWitnessNear(
    position: Vector2,
    radius: number,
    visitor: (witness: VehicleWitness) => void,
  ): void {
    const radiusSq = radius * radius;
    for (const [vehicleId, occupants] of this.manifests) {
      const vehicle = this.resolveVehicle(vehicleId);
      if (!vehicle || vehicle.isDestroyed || !vehicle.sprite.active) continue;
      const dx = vehicle.sprite.x - position.x;
      const dy = vehicle.sprite.y - position.y;
      if (dx * dx + dy * dy > radiusSq) continue;
      for (const occupant of occupants) {
        if (occupant.state === 'on-foot' || occupant.state === 'boarding') continue;
        const police = isPoliceOccupant(occupant.role);
        visitor({
          id: occupant.id,
          kind: police ? 'police-vehicle' : 'civilian',
          personality: occupant.personality,
          position: { x: vehicle.sprite.x, y: vehicle.sprite.y },
          vehicle,
          occupant,
        });
      }
    }
  }

  public beginCrewExit(vehicle: Vehicle): number {
    const crew = (this.manifests.get(vehicle.id) ?? []).filter(
      (occupant) => occupant.state === 'seated' && isPoliceOccupant(occupant.role),
    );
    crew.forEach((occupant, index) =>
      this.queueExit(vehicle, occupant, 'police-deploy', index * 120),
    );
    return crew.length;
  }

  public vehicleForOccupant(occupantId: number): Vehicle | null {
    for (const [vehicleId, occupants] of this.manifests) {
      if (!occupants.some((occupant) => occupant.id === occupantId)) continue;
      return this.resolveVehicle(vehicleId);
    }
    return null;
  }

  public beginCarjack(vehicle: Vehicle): CarjackManifest {
    const occupants = this.manifests.get(vehicle.id) ?? [];
    const driver = occupants.find((occupant) => occupant.seat === 'driver') ?? null;
    const passengers = occupants.filter((occupant) => occupant.seat !== 'driver');
    if (driver?.state === 'seated') this.queueExit(vehicle, driver, 'carjack', 0);
    passengers.forEach((occupant, index) => {
      if (occupant.state === 'seated') {
        this.queueExit(vehicle, occupant, 'passenger-escape', 260 + index * 140);
      }
    });
    return { driver, passengers };
  }

  public claimDriverSeat(vehicle: Vehicle, playerId: number): void {
    const occupants = this.manifests.get(vehicle.id);
    if (occupants) {
      for (let i = occupants.length - 1; i >= 0; i--) {
        if (occupants[i]?.seat === 'driver') {
          occupants.splice(i, 1);
          this.occupantCount = Math.max(0, this.occupantCount - 1);
        }
      }
    }
    vehicle.setDriverId(playerId);
    this.emitOccupancy(vehicle.id);
  }

  public beginBoarding(vehicle: Vehicle, occupant: VehicleOccupantRecord, from: Vector2): boolean {
    if (this.boardingTransitions.some((transition) => transition.occupant.id === occupant.id)) {
      return false;
    }
    occupant.vehicleId = vehicle.id;
    occupant.state = 'boarding';
    let manifest = this.manifests.get(vehicle.id);
    if (!manifest) {
      manifest = [];
      this.manifests.set(vehicle.id, manifest);
    }
    if (!manifest.some((candidate) => candidate.id === occupant.id)) {
      manifest.push(occupant);
      this.occupantCount += 1;
    }
    this.boardingTransitions.push({ vehicle, occupant, elapsed: 0, from: { ...from } });
    this.bus.emit(EventKeys.VehicleDoor, {
      open: true,
      vehicleId: vehicle.id,
      seat: occupant.seat,
    });
    return true;
  }

  public drainCompletedExits(reason: CompletedVehicleExit['reason']): CompletedVehicleExit[] {
    const matches: CompletedVehicleExit[] = [];
    for (let i = this.completedExits.length - 1; i >= 0; i--) {
      const exit = this.completedExits[i];
      if (!exit || exit.reason !== reason) continue;
      matches.push(exit);
      this.completedExits.splice(i, 1);
    }
    matches.reverse();
    return matches;
  }

  public seatWorldPosition(vehicle: Vehicle, seat: VehicleSeat): Vector2 {
    const local = this.seatOffset(vehicle, seat);
    return this.localToWorld(vehicle, local.x, local.y);
  }

  public doorWorldPosition(vehicle: Vehicle, seat: VehicleSeat, outside = 0): Vector2 {
    const local = this.seatOffset(vehicle, seat);
    const side = this.seatSide(seat);
    return this.localToWorld(vehicle, side * (vehicle.def.width * 0.5 + 5 + outside), local.y);
  }

  private ensureManifest(vehicle: Vehicle): void {
    this.vehicleRefs.set(vehicle.id, vehicle);
    if (this.manifests.has(vehicle.id) || vehicle.isDestroyed || vehicle.isPlayerDriven) return;
    const specs = occupantManifestFor(vehicle.def.kind);
    const records: VehicleOccupantRecord[] = [];
    for (const [seat, role] of specs) {
      if (this.occupantCount >= ENGINE_LIMITS.MAX_VEHICLE_OCCUPANTS) {
        EngineDiagnostics.recordLimitExceeded(
          'MAX_VEHICLE_OCCUPANTS',
          this.occupantCount + 1,
          ENGINE_LIMITS.MAX_VEHICLE_OCCUPANTS,
          'rejected-vehicle-occupant',
          `vehicle:${vehicle.id}`,
        );
        break;
      }
      const id = this.nextOccupantId++;
      const personality = personalityFromSeed((id * 73856093) ^ (vehicle.id * 19349663));
      records.push({
        id,
        vehicleId: vehicle.id,
        seat,
        role,
        state: 'seated',
        personality,
        reaction: civilianReaction(personality, 'vehicle-theft'),
        color: this.colorFor(role),
      });
      this.occupantCount += 1;
    }
    this.manifests.set(vehicle.id, records);
    const driver = records.find((record) => record.seat === 'driver');
    if (driver) vehicle.setDriverId(driver.id);
    this.emitOccupancy(vehicle.id);
  }

  private removeManifest(vehicleId: number): void {
    const records = this.manifests.get(vehicleId);
    if (records) this.occupantCount = Math.max(0, this.occupantCount - records.length);
    this.manifests.delete(vehicleId);
    this.vehicleRefs.delete(vehicleId);
    this.removeTransitions(this.exitTransitions, vehicleId);
    this.removeTransitions(this.boardingTransitions, vehicleId);
  }

  private removeTransitions<T extends { vehicle: Vehicle }>(
    transitions: T[],
    vehicleId: number,
  ): void {
    for (let i = transitions.length - 1; i >= 0; i--) {
      if (transitions[i]?.vehicle.id === vehicleId) transitions.splice(i, 1);
    }
  }

  private queueExit(
    vehicle: Vehicle,
    occupant: VehicleOccupantRecord,
    reason: CompletedVehicleExit['reason'],
    delay: number,
  ): void {
    if (this.exitTransitions.some((transition) => transition.occupant.id === occupant.id)) return;
    occupant.state = 'opening-door';
    const door = this.doorWorldPosition(vehicle, occupant.seat, 12);
    this.exitTransitions.push({
      vehicle,
      occupant,
      reason,
      elapsed: 0,
      delay,
      target: door,
    });
    if (occupant.seat === 'driver') vehicle.setDriverId(null);
  }

  private tickExits(delta: number): void {
    const total = OCCUPANTS.DOOR_OPEN_MS + OCCUPANTS.EXIT_MS + OCCUPANTS.FALL_MS;
    for (let i = this.exitTransitions.length - 1; i >= 0; i--) {
      const transition = this.exitTransitions[i];
      if (!transition) continue;
      transition.elapsed += delta;
      if (transition.elapsed < transition.delay) continue;
      const localElapsed = transition.elapsed - transition.delay;
      if (localElapsed < OCCUPANTS.DOOR_OPEN_MS) {
        transition.occupant.state = 'opening-door';
      } else if (localElapsed < OCCUPANTS.DOOR_OPEN_MS + OCCUPANTS.EXIT_MS) {
        transition.occupant.state = transition.reason === 'carjack' ? 'pulled-out' : 'exiting';
      } else {
        transition.occupant.state = transition.reason === 'carjack' ? 'fallen' : 'exiting';
      }
      if (localElapsed < total) continue;
      const manifest = this.manifests.get(transition.vehicle.id);
      const manifestIndex = manifest?.indexOf(transition.occupant) ?? -1;
      if (manifest && manifestIndex >= 0) {
        manifest.splice(manifestIndex, 1);
        this.occupantCount = Math.max(0, this.occupantCount - 1);
      }
      transition.occupant.state = 'on-foot';
      this.completedExits.push({
        vehicleId: transition.vehicle.id,
        occupant: transition.occupant,
        x: transition.target.x,
        y: transition.target.y,
        reason: transition.reason,
      });
      this.bus.emit(EventKeys.VehicleDoor, {
        open: false,
        vehicleId: transition.vehicle.id,
        seat: transition.occupant.seat,
      });
      this.emitOccupancy(transition.vehicle.id);
      this.exitTransitions.splice(i, 1);
    }
  }

  private tickBoarding(delta: number): void {
    for (let i = this.boardingTransitions.length - 1; i >= 0; i--) {
      const transition = this.boardingTransitions[i];
      if (!transition) continue;
      transition.elapsed += delta;
      if (transition.elapsed < OCCUPANTS.BOARD_MS) continue;
      transition.occupant.state = 'seated';
      if (transition.occupant.seat === 'driver') {
        transition.vehicle.setDriverId(transition.occupant.id);
      }
      this.bus.emit(EventKeys.VehicleDoor, {
        open: false,
        vehicleId: transition.vehicle.id,
        seat: transition.occupant.seat,
      });
      this.emitOccupancy(transition.vehicle.id);
      this.boardingTransitions.splice(i, 1);
    }
  }

  private renderOccupants(): void {
    const graphics = this.graphics;
    if (!graphics) return;
    graphics.clear();
    const player = getPlayerRef()?.playerPosition;
    if (!player) return;
    const rangeSq = OCCUPANTS.RENDER_RANGE * OCCUPANTS.RENDER_RANGE;
    for (const [vehicleId, occupants] of this.manifests) {
      const vehicle = this.resolveVehicle(vehicleId);
      if (!vehicle || !vehicle.sprite.visible || !vehicle.sprite.active) continue;
      const dx = vehicle.sprite.x - player.x;
      const dy = vehicle.sprite.y - player.y;
      if (dx * dx + dy * dy > rangeSq) continue;
      for (const occupant of occupants) {
        if (occupant.state === 'on-foot') continue;
        const position = this.renderPosition(vehicle, occupant);
        graphics.fillStyle(0x1b1d24, 0.9).fillCircle(position.x, position.y - 1, 2.3);
        graphics.fillStyle(occupant.color, 1).fillRect(position.x - 1.5, position.y, 3, 3);
      }
    }
    for (const transition of this.exitTransitions) {
      this.renderOpenDoor(graphics, transition.vehicle, transition.occupant.seat);
    }
    for (const transition of this.boardingTransitions) {
      this.renderOpenDoor(graphics, transition.vehicle, transition.occupant.seat);
    }
  }

  private renderPosition(vehicle: Vehicle, occupant: VehicleOccupantRecord): Vector2 {
    const exiting = this.exitTransitions.find(
      (transition) => transition.occupant.id === occupant.id,
    );
    if (exiting) {
      const elapsed = Math.max(0, exiting.elapsed - exiting.delay - OCCUPANTS.DOOR_OPEN_MS);
      const t = Phaser.Math.Clamp(elapsed / OCCUPANTS.EXIT_MS, 0, 1);
      const seat = this.seatWorldPosition(vehicle, occupant.seat);
      return {
        x: Phaser.Math.Linear(seat.x, exiting.target.x, t),
        y: Phaser.Math.Linear(seat.y, exiting.target.y, t),
      };
    }
    const boarding = this.boardingTransitions.find(
      (transition) => transition.occupant.id === occupant.id,
    );
    if (boarding) {
      const t = Phaser.Math.Clamp(boarding.elapsed / OCCUPANTS.BOARD_MS, 0, 1);
      const seat = this.seatWorldPosition(vehicle, occupant.seat);
      return {
        x: Phaser.Math.Linear(boarding.from.x, seat.x, t),
        y: Phaser.Math.Linear(boarding.from.y, seat.y, t),
      };
    }
    return this.seatWorldPosition(vehicle, occupant.seat);
  }

  private renderOpenDoor(
    graphics: Phaser.GameObjects.Graphics,
    vehicle: Vehicle,
    seat: VehicleSeat,
  ): void {
    const hinge = this.doorWorldPosition(vehicle, seat, -4);
    const edge = this.doorWorldPosition(vehicle, seat, 4);
    graphics.lineStyle(2, 0x20242c, 1).lineBetween(hinge.x, hinge.y, edge.x, edge.y);
  }

  private seatOffset(vehicle: Vehicle, seat: VehicleSeat): Vector2 {
    const left = -vehicle.def.width * 0.2;
    const right = vehicle.def.width * 0.2;
    const front = -vehicle.def.height * 0.1;
    const rear = vehicle.def.height * 0.16;
    switch (seat) {
      case 'driver':
        return { x: left, y: front };
      case 'front-passenger':
        return { x: right, y: front };
      case 'rear-left':
        return { x: left, y: rear };
      case 'rear-right':
        return { x: right, y: rear };
      case 'rear-centre':
        return { x: 0, y: rear };
      case 'passenger-4':
        return { x: left, y: vehicle.def.height * 0.28 };
      case 'passenger-5':
        return { x: right, y: vehicle.def.height * 0.28 };
    }
  }

  private seatSide(seat: VehicleSeat): number {
    return seat === 'driver' || seat === 'rear-left' || seat === 'passenger-4' ? -1 : 1;
  }

  private localToWorld(vehicle: Vehicle, x: number, y: number): Vector2 {
    const rotation = vehicle.sprite.rotation;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    return {
      x: vehicle.sprite.x + x * cos - y * sin,
      y: vehicle.sprite.y + x * sin + y * cos,
    };
  }

  private colorFor(role: VehicleOccupantRole): number {
    if (role === 'police-officer' || role === 'police-supervisor') return POLICE_COLOR;
    if (role === 'paramedic' || role === 'firefighter') return SERVICE_COLOR;
    if (role === 'passenger') return PASSENGER_COLOR;
    return DRIVER_COLOR;
  }

  private resolveVehicle(vehicleId: number): Vehicle | null {
    const cached = this.vehicleRefs.get(vehicleId);
    if (cached) return cached;
    const vehicles = this.vehicles ?? ServiceLocator.tryResolve<VehicleSystem>(ServiceKeys.Vehicle);
    this.vehicles = vehicles;
    if (!vehicles) return null;
    for (const vehicle of vehicles.vehicles) {
      if (vehicle.id !== vehicleId) continue;
      this.vehicleRefs.set(vehicleId, vehicle);
      return vehicle;
    }
    return null;
  }

  private emitOccupancy(vehicleId: number): void {
    this.bus.emit(EventKeys.VehicleOccupancyChanged, {
      vehicleId,
      occupantCount: this.manifests.get(vehicleId)?.length ?? 0,
    });
  }
}
