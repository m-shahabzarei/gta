import Phaser from 'phaser';
import { ENGINE_LIMITS } from '@/config/EngineLimits';
import { EventKeys } from '@/config/EventKeys';
import { ServiceKeys } from '@/config/ServiceKeys';
import { VEHICLE_COLLISION } from '@/config/Constants';
import { eventBus } from '@/core/EventBus';
import { ServiceLocator } from '@/core/ServiceLocator';
import type { Vehicle } from '@/entities/Vehicle';
import {
  Faction,
  damageAttribution,
  getPlayerRef,
  type IWorldQuery,
} from '@/gameplay/types';
import {
  computeSweptBounds,
  computeSweptObbContact,
  createVehicleContact,
  type VehicleContact,
  type VehicleObbPose,
  type VehicleSweptBounds,
} from './VehicleCollisionGeometry';
import {
  computeImpactDamage,
  createSolverResult,
  isCollisionPairInCooldown,
  resolveVehicleContact,
  type VehicleDamageResult,
  type VehicleSolverBody,
  type VehicleSolverResult,
} from './VehicleCollisionSolver';
import {
  VehicleCollisionTelemetry,
  type VehicleCollisionLodTier,
  type VehicleCollisionTelemetrySnapshot,
} from './VehicleCollisionTelemetry';
import type {
  VehicleCollisionSeverity,
  VehicleCollisionType,
  VehiclePhysicsDef,
} from './VehicleDynamicsTypes';
import {
  clampVehicleTranslation,
  createWorldClampResult,
  removeVelocityIntoWorld,
  type VehicleWorldClampResult,
} from './VehicleWorldSafety';

interface PreviousPoseRecord {
  generation: number;
  x: number;
  y: number;
  heading: number;
}

interface PairState {
  stepStamp: number;
  lastImpactAt: number;
  lastDamageAt: number;
}

interface RuntimeBodySlot {
  vehicle: Vehicle | null;
  handle: number;
  lod: VehicleCollisionLodTier;
  current: VehicleObbPose;
  previous: VehicleObbPose;
  bounds: VehicleSweptBounds;
  solver: VehicleSolverBody;
  initialX: number;
  initialY: number;
  initialVelocityX: number;
  initialVelocityY: number;
  contactCount: number;
}

interface RuntimeContactSlot {
  firstIndex: number;
  secondIndex: number;
  pairHandle: number;
  pairState: PairState | null;
  contact: VehicleContact;
  firstResult: VehicleSolverResult;
  cooldown: boolean;
  lod: VehicleCollisionLodTier;
}

const EMPTY_PHYSICS: VehiclePhysicsDef = {
  mass: 1,
  rotationalInertia: 1,
  restitution: 0,
  tireFriction: 0,
  lateralGrip: 0,
  rollingResistance: 0,
  lateralDamping: 0,
  angularDamping: 0,
  collisionDamageMultiplier: 1,
  minimumImpactSpeed: 0,
  maximumCollisionImpulse: 1,
  maximumAngularVelocity: 0,
};

function bodySlot(): RuntimeBodySlot {
  return {
    vehicle: null,
    handle: 0,
    lod: 'near',
    current: { x: 0, y: 0, heading: 0, halfWidth: 0, halfLength: 0 },
    previous: { x: 0, y: 0, heading: 0, halfWidth: 0, halfLength: 0 },
    bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    solver: {
      x: 0,
      y: 0,
      heading: 0,
      velocityX: 0,
      velocityY: 0,
      angularVelocity: 0,
      halfWidth: 0,
      halfLength: 0,
      physics: EMPTY_PHYSICS,
      inverseMass: 1,
      inverseInertia: 1,
    },
    initialX: 0,
    initialY: 0,
    initialVelocityX: 0,
    initialVelocityY: 0,
    contactCount: 0,
  };
}

function contactSlot(): RuntimeContactSlot {
  return {
    firstIndex: 0,
    secondIndex: 0,
    pairHandle: 0,
    pairState: null,
    contact: createVehicleContact(),
    firstResult: createSolverResult(),
    cooldown: false,
    lod: 'near',
  };
}

function stableHandle(vehicle: Vehicle): number {
  return vehicle.id * 1_000_000 + vehicle.poolGeneration;
}

function clampMagnitude(x: number, y: number, maximum: number): number {
  const length = Math.hypot(x, y);
  return length > maximum && length > 0 ? maximum / length : 1;
}

/**
 * Scene-scoped, deterministic vehicle-pair collision owner. It is the only
 * system allowed to resolve a live vehicle pair and runs once per Arcade step.
 */
export class VehicleCollisionRuntime {
  private scene: Phaser.Scene | null = null;
  private world: IWorldQuery | null = null;
  private readonly telemetry = new VehicleCollisionTelemetry();
  private readonly previousPoses = new Map<number, PreviousPoseRecord>();
  private readonly pairStates = new Map<number, Map<number, PairState>>();
  private readonly bodySlots: RuntimeBodySlot[] = Array.from(
    { length: ENGINE_LIMITS.MAX_ACTIVE_VEHICLES },
    bodySlot,
  );
  private readonly contactSlots: RuntimeContactSlot[] = Array.from(
    { length: ENGINE_LIMITS.MAX_VEHICLE_CONTACTS },
    contactSlot,
  );
  private readonly vehiclesScratch: Vehicle[] = [];
  private readonly grid = new Map<number, number[]>();
  private readonly activeGridKeys: number[] = [];
  private readonly candidateKeys: number[] = [];
  private readonly secondarySolverResult = createSolverResult();
  private readonly damageResult: VehicleDamageResult = { damageToFirst: 0, damageToSecond: 0 };
  private readonly worldClamp: VehicleWorldClampResult = createWorldClampResult();
  private activeBodyCount = 0;
  private activeContactCount = 0;
  private stepStamp = 0;
  private droppedPairs = 0;

  constructor(private readonly vehicles: () => readonly Vehicle[]) {}

  public attach(scene: Phaser.Scene): void {
    this.detach();
    this.scene = scene;
    this.world = ServiceLocator.tryResolve(ServiceKeys.World) as unknown as IWorldQuery | null;
    this.telemetry.reset();
    this.capturePreviousPoses();
    scene.physics.world.on(Phaser.Physics.Arcade.Events.WORLD_STEP, this.onWorldStep, this);
  }

  public detach(): void {
    this.scene?.physics.world.off(
      Phaser.Physics.Arcade.Events.WORLD_STEP,
      this.onWorldStep,
      this,
    );
    this.scene = null;
    this.world = null;
    this.previousPoses.clear();
    this.pairStates.clear();
    this.clearGrid();
    this.vehiclesScratch.length = 0;
    this.candidateKeys.length = 0;
    this.activeBodyCount = 0;
    this.activeContactCount = 0;
    this.stepStamp = 0;
  }

  /** Capture the pre-Arcade pose after the preceding completed physics step. */
  public capturePreviousPoses(): void {
    for (const vehicle of this.vehicles()) {
      if (!vehicle.sprite.active || vehicle.isDestroyed) continue;
      const record = this.previousPoses.get(vehicle.id);
      if (record) {
        record.generation = vehicle.poolGeneration;
        record.x = vehicle.sprite.x;
        record.y = vehicle.sprite.y;
        record.heading = vehicle.movement.collisionHeading;
      } else {
        this.previousPoses.set(vehicle.id, {
          generation: vehicle.poolGeneration,
          x: vehicle.sprite.x,
          y: vehicle.sprite.y,
          heading: vehicle.movement.collisionHeading,
        });
      }
    }
  }

  public forgetVehicle(vehicle: Vehicle): void {
    this.previousPoses.delete(vehicle.id);
    const handle = stableHandle(vehicle);
    this.pairStates.delete(handle);
    for (const [first, seconds] of this.pairStates) {
      seconds.delete(handle);
      if (seconds.size === 0) this.pairStates.delete(first);
    }
  }

  public snapshot(): VehicleCollisionTelemetrySnapshot {
    return this.telemetry.snapshot();
  }

  public recordRecovery(durationSeconds: number, failed: boolean): void {
    this.telemetry.recordRecovery(durationSeconds, failed);
  }

  private readonly onWorldStep = (deltaSeconds: number): void => {
    const scene = this.scene;
    if (!scene) return;
    this.step(scene.time.now, Math.max(0, Math.min(deltaSeconds, 0.05)));
  };

  private step(now: number, deltaSeconds: number): void {
    const startedAt = performance.now();
    this.stepStamp += 1;
    this.droppedPairs = 0;
    this.gatherBodies();
    this.buildBroadphase();
    const broadphasePairs = this.gatherContacts(now);
    this.resolveContacts(now, deltaSeconds);
    this.applySolvedBodies(deltaSeconds);
    this.refreshPreviousPoseRecords();
    this.telemetry.recordStep(
      performance.now() - startedAt,
      broadphasePairs,
      this.activeContactCount,
      this.droppedPairs,
    );
    if (this.stepStamp % 600 === 0) this.prunePairCache(now);
  }

  private gatherBodies(): void {
    this.vehiclesScratch.length = 0;
    const player = getPlayerRef()?.playerPosition ?? null;
    const mediumRadiusSq =
      VEHICLE_COLLISION.MEDIUM_PHYSICS_RADIUS * VEHICLE_COLLISION.MEDIUM_PHYSICS_RADIUS;
    for (const vehicle of this.vehicles()) {
      if (
        !vehicle.sprite.active ||
        vehicle.isDestroyed ||
        vehicle.movement.physicalMode === 'Disabled'
      ) {
        continue;
      }
      const impactActive = vehicle.movement.dynamics.impactState !== 'None';
      if (!vehicle.isPlayerDriven && player && !impactActive) {
        const dx = vehicle.sprite.x - player.x;
        const dy = vehicle.sprite.y - player.y;
        if (dx * dx + dy * dy > mediumRadiusSq) continue;
      }
      this.vehiclesScratch.push(vehicle);
    }
    this.vehiclesScratch.sort(
      (first, second) =>
        first.id - second.id || first.poolGeneration - second.poolGeneration,
    );
    this.activeBodyCount = Math.min(this.vehiclesScratch.length, this.bodySlots.length);
    const fullRadiusSq =
      VEHICLE_COLLISION.FULL_PHYSICS_RADIUS * VEHICLE_COLLISION.FULL_PHYSICS_RADIUS;
    for (let index = 0; index < this.activeBodyCount; index += 1) {
      const vehicle = this.vehiclesScratch[index]!;
      const slot = this.bodySlots[index]!;
      slot.vehicle = vehicle;
      slot.handle = stableHandle(vehicle);
      if (vehicle.movement.physicalMode === 'PlayerDynamic' || vehicle.movement.physicalMode === 'ArcadeDynamic') {
        vehicle.movement.syncArcadeWorldVelocity();
      }
      const playerDx = player ? vehicle.sprite.x - player.x : 0;
      const playerDy = player ? vehicle.sprite.y - player.y : 0;
      slot.lod = !player || playerDx * playerDx + playerDy * playerDy <= fullRadiusSq ? 'near' : 'medium';
      const current = slot.current;
      current.x = vehicle.sprite.x;
      current.y = vehicle.sprite.y;
      current.heading = vehicle.movement.collisionHeading;
      current.halfWidth = vehicle.def.width * 0.5;
      current.halfLength = vehicle.def.height * 0.5;
      const previousRecord = this.previousPoses.get(vehicle.id);
      const previous = slot.previous;
      if (previousRecord?.generation === vehicle.poolGeneration) {
        previous.x = previousRecord.x;
        previous.y = previousRecord.y;
        previous.heading = previousRecord.heading;
      } else {
        previous.x = current.x;
        previous.y = current.y;
        previous.heading = current.heading;
      }
      previous.halfWidth = current.halfWidth;
      previous.halfLength = current.halfLength;
      computeSweptBounds(previous, current, slot.bounds);
      const solver = slot.solver;
      const dynamics = vehicle.movement.dynamics;
      const body = vehicle.sprite.body as Phaser.Physics.Arcade.Body;
      const kinematic =
        vehicle.movement.physicalMode === 'TrafficKinematicWithImpact' ||
        vehicle.movement.physicalMode === 'ParkedDynamic';
      solver.x = current.x;
      solver.y = current.y;
      solver.heading = current.heading;
      solver.velocityX = kinematic
        ? dynamics.controlVelocity.x + dynamics.externalVelocity.x
        : body.velocity.x;
      solver.velocityY = kinematic
        ? dynamics.controlVelocity.y + dynamics.externalVelocity.y
        : body.velocity.y;
      solver.angularVelocity = dynamics.angularVelocity;
      solver.halfWidth = current.halfWidth;
      solver.halfLength = current.halfLength;
      solver.physics = vehicle.def.physics;
      solver.inverseMass = 1 / vehicle.def.physics.mass;
      solver.inverseInertia = 1 / vehicle.def.physics.rotationalInertia;
      slot.initialX = solver.x;
      slot.initialY = solver.y;
      slot.initialVelocityX = solver.velocityX;
      slot.initialVelocityY = solver.velocityY;
      slot.contactCount = 0;
      dynamics.previousVelocity.x = solver.velocityX;
      dynamics.previousVelocity.y = solver.velocityY;
    }
    for (let index = this.activeBodyCount; index < this.bodySlots.length; index += 1) {
      const slot = this.bodySlots[index];
      if (!slot?.vehicle) break;
      slot.vehicle = null;
    }
  }

  private clearGrid(): void {
    for (const key of this.activeGridKeys) this.grid.get(key)!.length = 0;
    this.activeGridKeys.length = 0;
  }

  private gridKey(cellX: number, cellY: number): number {
    return (cellX + 32_768) * 65_536 + cellY + 32_768;
  }

  private buildBroadphase(): void {
    this.clearGrid();
    const cellSize = VEHICLE_COLLISION.BROADPHASE_CELL_SIZE;
    for (let index = 0; index < this.activeBodyCount; index += 1) {
      const bounds = this.bodySlots[index]!.bounds;
      const minimumX = Math.floor(bounds.minX / cellSize);
      const minimumY = Math.floor(bounds.minY / cellSize);
      const maximumX = Math.floor(bounds.maxX / cellSize);
      const maximumY = Math.floor(bounds.maxY / cellSize);
      for (let cellX = minimumX; cellX <= maximumX; cellX += 1) {
        for (let cellY = minimumY; cellY <= maximumY; cellY += 1) {
          const key = this.gridKey(cellX, cellY);
          let bucket = this.grid.get(key);
          if (!bucket) {
            bucket = [];
            this.grid.set(key, bucket);
          }
          if (bucket.length === 0) this.activeGridKeys.push(key);
          bucket.push(index);
        }
      }
    }
  }

  private gatherContacts(now: number): number {
    this.candidateKeys.length = 0;
    const bodyCapacity = this.bodySlots.length;
    for (const key of this.activeGridKeys) {
      const bucket = this.grid.get(key)!;
      for (let first = 0; first < bucket.length; first += 1) {
        for (let second = first + 1; second < bucket.length; second += 1) {
          const firstIndex = bucket[first]!;
          const secondIndex = bucket[second]!;
          const low = Math.min(firstIndex, secondIndex);
          const high = Math.max(firstIndex, secondIndex);
          this.candidateKeys.push(low * bodyCapacity + high);
        }
      }
    }
    this.candidateKeys.sort((first, second) => first - second);
    this.activeContactCount = 0;
    let broadphasePairs = 0;
    let previousCandidate = -1;
    for (const candidate of this.candidateKeys) {
      if (candidate === previousCandidate) {
        this.telemetry.recordDuplicateSuppression();
        continue;
      }
      previousCandidate = candidate;
      broadphasePairs += 1;
      if (broadphasePairs > ENGINE_LIMITS.MAX_VEHICLE_COLLISION_PAIRS) {
        this.droppedPairs += 1;
        continue;
      }
      const firstIndex = Math.floor(candidate / bodyCapacity);
      const secondIndex = candidate % bodyCapacity;
      const first = this.bodySlots[firstIndex]!;
      const second = this.bodySlots[secondIndex]!;
      if (
        first.contactCount >= VEHICLE_COLLISION.MAX_CONTACTS_PER_VEHICLE ||
        second.contactCount >= VEHICLE_COLLISION.MAX_CONTACTS_PER_VEHICLE
      ) {
        this.droppedPairs += 1;
        continue;
      }
      const pair = this.pairState(first.handle, second.handle);
      if (pair.stepStamp === this.stepStamp) {
        this.telemetry.recordDuplicateSuppression();
        continue;
      }
      pair.stepStamp = this.stepStamp;
      if (this.activeContactCount >= this.contactSlots.length) {
        this.droppedPairs += 1;
        continue;
      }
      const slot = this.contactSlots[this.activeContactCount]!;
      if (
        !computeSweptObbContact(
          first.previous,
          first.current,
          second.previous,
          second.current,
          slot.contact,
        )
      ) {
        continue;
      }
      slot.firstIndex = firstIndex;
      slot.secondIndex = secondIndex;
      slot.pairState = pair;
      slot.pairHandle = this.numericPairHandle(first.handle, second.handle);
      slot.cooldown = isCollisionPairInCooldown(
        now,
        pair.lastImpactAt,
        VEHICLE_COLLISION.PAIR_COOLDOWN_MS,
      );
      slot.lod = first.lod === 'near' || second.lod === 'near' ? 'near' : 'medium';
      first.contactCount += 1;
      second.contactCount += 1;
      this.activeContactCount += 1;
    }
    return broadphasePairs;
  }

  private resolveContacts(now: number, deltaSeconds: number): void {
    for (let iteration = 0; iteration < VEHICLE_COLLISION.SOLVER_ITERATIONS; iteration += 1) {
      for (let index = 0; index < this.activeContactCount; index += 1) {
        const runtimeContact = this.contactSlots[index]!;
        const first = this.bodySlots[runtimeContact.firstIndex]!;
        const second = this.bodySlots[runtimeContact.secondIndex]!;
        const originalPenetration = runtimeContact.contact.penetration;
        if (iteration > 0) runtimeContact.contact.penetration = 0;
        const result = iteration === 0 ? runtimeContact.firstResult : this.secondarySolverResult;
        resolveVehicleContact(
          first.solver,
          second.solver,
          runtimeContact.contact,
          VEHICLE_COLLISION,
          result,
          { restitutionEnabled: iteration === 0 && !runtimeContact.cooldown },
        );
        runtimeContact.contact.penetration = originalPenetration;
        if (iteration === 0 && runtimeContact.contact.swept && result.impulseApplied) {
          this.applySweptRemainder(first, second, runtimeContact.contact, deltaSeconds);
        }
      }
    }

    for (let index = 0; index < this.activeContactCount; index += 1) {
      const runtimeContact = this.contactSlots[index]!;
      const result = runtimeContact.firstResult;
      if (!result.impulseApplied) continue;
      const first = this.bodySlots[runtimeContact.firstIndex]!;
      const second = this.bodySlots[runtimeContact.secondIndex]!;
      const firstVehicle = first.vehicle!;
      const secondVehicle = second.vehicle!;
      firstVehicle.movement.setResolvedTotalVelocity(
        first.solver.velocityX,
        first.solver.velocityY,
        first.solver.angularVelocity,
      );
      secondVehicle.movement.setResolvedTotalVelocity(
        second.solver.velocityX,
        second.solver.velocityY,
        second.solver.angularVelocity,
      );
      if (!result.impactful) continue;
      if (runtimeContact.cooldown) {
        this.telemetry.recordCooldownSuppression();
        continue;
      }
      runtimeContact.pairState!.lastImpactAt = now;
      firstVehicle.movement.beginImpact(now, secondVehicle.id, runtimeContact.pairHandle);
      secondVehicle.movement.beginImpact(now, firstVehicle.id, runtimeContact.pairHandle);
      this.processImpactEvent(now, first, second, runtimeContact);
    }
  }

  private applySweptRemainder(
    first: RuntimeBodySlot,
    second: RuntimeBodySlot,
    contact: VehicleContact,
    deltaSeconds: number,
  ): void {
    const remaining = 1 - contact.timeOfImpact;
    const firstContactX =
      first.previous.x + (first.current.x - first.previous.x) * contact.timeOfImpact;
    const firstContactY =
      first.previous.y + (first.current.y - first.previous.y) * contact.timeOfImpact;
    const secondContactX =
      second.previous.x + (second.current.x - second.previous.x) * contact.timeOfImpact;
    const secondContactY =
      second.previous.y + (second.current.y - second.previous.y) * contact.timeOfImpact;
    const firstTargetX = firstContactX + first.solver.velocityX * deltaSeconds * remaining;
    const firstTargetY = firstContactY + first.solver.velocityY * deltaSeconds * remaining;
    const secondTargetX = secondContactX + second.solver.velocityX * deltaSeconds * remaining;
    const secondTargetY = secondContactY + second.solver.velocityY * deltaSeconds * remaining;
    const firstScale = clampMagnitude(
      firstTargetX - first.solver.x,
      firstTargetY - first.solver.y,
      VEHICLE_COLLISION.MAX_SWEEP_REWIND,
    );
    const secondScale = clampMagnitude(
      secondTargetX - second.solver.x,
      secondTargetY - second.solver.y,
      VEHICLE_COLLISION.MAX_SWEEP_REWIND,
    );
    first.solver.x += (firstTargetX - first.solver.x) * firstScale;
    first.solver.y += (firstTargetY - first.solver.y) * firstScale;
    second.solver.x += (secondTargetX - second.solver.x) * secondScale;
    second.solver.y += (secondTargetY - second.solver.y) * secondScale;
  }

  private applySolvedBodies(deltaSeconds: number): void {
    for (let index = 0; index < this.activeBodyCount; index += 1) {
      const slot = this.bodySlots[index]!;
      const vehicle = slot.vehicle!;
      this.applySafeTranslation(
        slot,
        slot.solver.x - slot.initialX,
        slot.solver.y - slot.initialY,
      );
      const dynamics = vehicle.movement.dynamics;
      let impactX = 0;
      let impactY = 0;
      if (
        vehicle.movement.physicalMode === 'TrafficKinematicWithImpact' ||
        vehicle.movement.physicalMode === 'ParkedDynamic'
      ) {
        impactX = dynamics.externalVelocity.x * deltaSeconds;
        impactY = dynamics.externalVelocity.y * deltaSeconds;
        const applied = this.safeTranslation(slot, impactX, impactY);
        impactX = applied.appliedX;
        impactY = applied.appliedY;
        if (applied.blocked) {
          removeVelocityIntoWorld(
            dynamics.externalVelocity,
            applied.normalX,
            applied.normalY,
          );
          this.telemetry.recordWorldClamp();
        }
      }
      const priorState = dynamics.impactState;
      const priorRecovery = dynamics.recoveryDuration;
      vehicle.movement.integrateImpactStep(deltaSeconds, impactX, impactY);
      if (priorState !== 'None' && dynamics.impactState === 'None') {
        this.telemetry.recordRecovery(Math.max(priorRecovery, dynamics.recoveryDuration), false);
      }
    }
  }

  private safeTranslation(
    slot: RuntimeBodySlot,
    dx: number,
    dy: number,
  ): VehicleWorldClampResult {
    const out = this.worldClamp;
    const world = this.world;
    if (!world || dx * dx + dy * dy <= 1e-12) {
      out.appliedX = dx;
      out.appliedY = dy;
      out.fraction = 1;
      out.normalX = 0;
      out.normalY = 0;
      out.blocked = false;
      return out;
    }
    const vehicle = slot.vehicle!;
    const pose = slot.current;
    pose.x = vehicle.sprite.x;
    pose.y = vehicle.sprite.y;
    pose.heading = vehicle.movement.collisionHeading;
    const physicalMode = vehicle.movement.physicalMode;
    clampVehicleTranslation(
      world,
      pose,
      dx,
      dy,
      physicalMode === 'TrafficKinematicWithImpact'
        ? 'drivable-footprint'
        : physicalMode === 'ParkedDynamic'
          ? 'parked-centerline'
          : 'solid-only',
      VEHICLE_COLLISION.WORLD_SAFETY_BINARY_STEPS,
      out,
    );
    return out;
  }

  private applySafeTranslation(slot: RuntimeBodySlot, dx: number, dy: number): void {
    if (dx * dx + dy * dy <= 1e-12) return;
    const vehicle = slot.vehicle!;
    const applied = this.safeTranslation(slot, dx, dy);
    if (
      vehicle.movement.physicalMode === 'TrafficKinematicWithImpact' ||
      vehicle.movement.physicalMode === 'ParkedDynamic'
    ) {
      vehicle.movement.translateImpactOffset(applied.appliedX, applied.appliedY);
    } else {
      vehicle.movement.translateDynamic(applied.appliedX, applied.appliedY);
    }
    if (applied.blocked) {
      removeVelocityIntoWorld(
        vehicle.movement.dynamics.externalVelocity,
        applied.normalX,
        applied.normalY,
      );
      this.telemetry.recordWorldClamp();
    }
  }

  private processImpactEvent(
    now: number,
    first: RuntimeBodySlot,
    second: RuntimeBodySlot,
    runtimeContact: RuntimeContactSlot,
  ): void {
    const firstVehicle = first.vehicle!;
    const secondVehicle = second.vehicle!;
    const contact = runtimeContact.contact;
    const result = runtimeContact.firstResult;
    const type = this.classifyCollision(first, second, contact);
    const firstDirection = this.directionDamageMultiplier(first.solver.heading, contact.normalX, contact.normalY);
    const secondDirection = this.directionDamageMultiplier(second.solver.heading, contact.normalX, contact.normalY);
    computeImpactDamage(
      first.solver,
      second.solver,
      result.impactEnergy,
      firstDirection,
      secondDirection,
      VEHICLE_COLLISION,
      this.damageResult,
    );
    const canDamage =
      now - runtimeContact.pairState!.lastDamageAt >= VEHICLE_COLLISION.DAMAGE_COOLDOWN_MS;
    const damageToFirst = canDamage ? this.damageResult.damageToFirst : 0;
    const damageToSecond = canDamage ? this.damageResult.damageToSecond : 0;
    if (canDamage && (damageToFirst > 0 || damageToSecond > 0)) {
      runtimeContact.pairState!.lastDamageAt = now;
      this.applyCollisionDamage(firstVehicle, secondVehicle, damageToFirst);
      this.applyCollisionDamage(secondVehicle, firstVehicle, damageToSecond);
    }
    const severity = this.severity(result.normalImpulse);
    const firstSpeedLoss =
      Math.hypot(first.initialVelocityX, first.initialVelocityY) -
      Math.hypot(first.solver.velocityX, first.solver.velocityY);
    const secondSpeedLoss =
      Math.hypot(second.initialVelocityX, second.initialVelocityY) -
      Math.hypot(second.solver.velocityX, second.solver.velocityY);
    const playerSpeedLoss = firstVehicle.isPlayerDriven
      ? Math.max(0, firstSpeedLoss)
      : secondVehicle.isPlayerDriven
        ? Math.max(0, secondSpeedLoss)
        : 0;
    const displacement =
      Math.hypot(second.solver.x - second.initialX, second.solver.y - second.initialY) +
      Math.hypot(first.solver.x - first.initialX, first.solver.y - first.initialY);
    const intensity = Math.min(1, result.normalImpulse / VEHICLE_COLLISION.HEAVY_IMPULSE);
    const byPlayer = firstVehicle.isPlayerDriven || secondVehicle.isPlayerDriven;
    eventBus.emit(EventKeys.VehicleCollision, {
      x: contact.pointX,
      y: contact.pointY,
      intensity,
      byPlayer,
      vehicleId: firstVehicle.id,
      otherVehicleId: secondVehicle.id,
      relativeSpeed: result.closingSpeed,
      impulse: result.normalImpulse,
      impulseVector: { x: result.impulseX, y: result.impulseY },
      collisionNormal: { x: contact.normalX, y: contact.normalY },
      contactPoint: { x: contact.pointX, y: contact.pointY },
      damageToSelf: damageToFirst,
      damageToOther: damageToSecond,
      collisionType: type,
      playerResponsible: byPlayer,
      solverSource: contact.swept ? 'custom-swept-obb' : 'custom-obb',
    });
    this.writeImpactDebug(
      firstVehicle,
      secondVehicle.id,
      first,
      second,
      runtimeContact,
      type,
      damageToFirst,
      -1,
      now,
    );
    this.writeImpactDebug(
      secondVehicle,
      firstVehicle.id,
      second,
      first,
      runtimeContact,
      type,
      damageToSecond,
      1,
      now,
    );
    firstVehicle.movement.dynamics.damageImpulse = result.normalImpulse;
    secondVehicle.movement.dynamics.damageImpulse = result.normalImpulse;
    firstVehicle.movement.dynamics.pendingCollisionEvent = false;
    secondVehicle.movement.dynamics.pendingCollisionEvent = false;
    this.telemetry.recordCollision({
      type,
      severity,
      lod: runtimeContact.lod,
      relativeSpeed: result.closingSpeed,
      impulse: result.normalImpulse,
      targetDisplacement: displacement,
      playerSpeedLoss,
      angularVelocity: Math.max(
        Math.abs(first.solver.angularVelocity),
        Math.abs(second.solver.angularVelocity),
      ),
      damage: damageToFirst + damageToSecond,
    });
  }

  private writeImpactDebug(
    vehicle: Vehicle,
    targetId: number,
    self: RuntimeBodySlot,
    other: RuntimeBodySlot,
    runtimeContact: RuntimeContactSlot,
    type: Exclude<VehicleCollisionType, 'world'>,
    damage: number,
    impulseSign: -1 | 1,
    now: number,
  ): void {
    const debug = vehicle.movement.dynamics.debug;
    const result = runtimeContact.firstResult;
    const contact = runtimeContact.contact;
    debug.targetVehicleId = targetId;
    debug.previousVelocity.x = self.initialVelocityX;
    debug.previousVelocity.y = self.initialVelocityY;
    debug.velocityAfterImpact.x = self.solver.velocityX;
    debug.velocityAfterImpact.y = self.solver.velocityY;
    debug.relativeVelocity.x = other.initialVelocityX - self.initialVelocityX;
    debug.relativeVelocity.y = other.initialVelocityY - self.initialVelocityY;
    debug.collisionNormal.x = contact.normalX * (impulseSign === -1 ? 1 : -1);
    debug.collisionNormal.y = contact.normalY * (impulseSign === -1 ? 1 : -1);
    debug.impulseVector.x = result.impulseX * impulseSign;
    debug.impulseVector.y = result.impulseY * impulseSign;
    debug.contactPoint.x = contact.pointX;
    debug.contactPoint.y = contact.pointY;
    debug.impactEnergy = result.impactEnergy;
    debug.damage = damage;
    debug.collisionType = type;
    debug.solverSource = contact.swept ? 'custom-swept-obb' : 'custom-obb';
    debug.atMs = now;
  }

  private applyCollisionDamage(target: Vehicle, source: Vehicle, amount: number): void {
    if (amount <= 0 || target.isDestroyed) return;
    const fromPlayer = source.isPlayerDriven;
    target.applyDamage({
      amount,
      type: 'vehicle',
      sourceFaction: Faction.Neutral,
      fromPlayer,
      attribution: damageAttribution('collision', fromPlayer, {
        sourceId: source.id,
        vehicleOwnerId: source.id,
        collisionOwnerId: source.driverId ?? source.id,
        lastAttackerId: source.driverId ?? source.id,
      }),
    });
  }

  private classifyCollision(
    first: RuntimeBodySlot,
    second: RuntimeBodySlot,
    contact: VehicleContact,
  ): Exclude<VehicleCollisionType, 'world'> {
    const firstFacing =
      Math.cos(first.solver.heading) * contact.normalX +
      Math.sin(first.solver.heading) * contact.normalY;
    const secondFacing =
      Math.cos(second.solver.heading) * contact.normalX +
      Math.sin(second.solver.heading) * contact.normalY;
    if (Math.abs(firstFacing) < 0.42 || Math.abs(secondFacing) < 0.42) return 'side';
    if (firstFacing > 0.72 && secondFacing < -0.72) return 'head-on';
    if (
      (firstFacing > 0.68 && secondFacing > 0.68) ||
      (firstFacing < -0.68 && secondFacing < -0.68)
    ) {
      return 'rear-end';
    }
    return 'glancing';
  }

  private directionDamageMultiplier(
    heading: number,
    normalX: number,
    normalY: number,
  ): number {
    const forwardAlignment = Math.abs(Math.cos(heading) * normalX + Math.sin(heading) * normalY);
    return forwardAlignment < 0.45 ? 1.2 : 0.94;
  }

  private severity(impulse: number): VehicleCollisionSeverity {
    if (impulse >= VEHICLE_COLLISION.HEAVY_IMPULSE) return 'heavy';
    if (impulse >= VEHICLE_COLLISION.LIGHT_IMPULSE) return 'medium';
    return 'light';
  }

  private pairState(firstHandle: number, secondHandle: number): PairState {
    const low = Math.min(firstHandle, secondHandle);
    const high = Math.max(firstHandle, secondHandle);
    let seconds = this.pairStates.get(low);
    if (!seconds) {
      seconds = new Map<number, PairState>();
      this.pairStates.set(low, seconds);
    }
    let state = seconds.get(high);
    if (!state) {
      state = { stepStamp: -1, lastImpactAt: -Infinity, lastDamageAt: -Infinity };
      seconds.set(high, state);
    }
    return state;
  }

  private numericPairHandle(firstHandle: number, secondHandle: number): number {
    const low = Math.min(firstHandle, secondHandle);
    const high = Math.max(firstHandle, secondHandle);
    let hash = 2_166_136_261;
    hash = Math.imul(hash ^ (low | 0), 16_777_619);
    hash = Math.imul(hash ^ (high | 0), 16_777_619);
    return hash >>> 0;
  }

  private refreshPreviousPoseRecords(): void {
    for (let index = 0; index < this.activeBodyCount; index += 1) {
      const vehicle = this.bodySlots[index]!.vehicle!;
      const record = this.previousPoses.get(vehicle.id);
      if (record) {
        record.generation = vehicle.poolGeneration;
        record.x = vehicle.sprite.x;
        record.y = vehicle.sprite.y;
        record.heading = vehicle.movement.collisionHeading;
      } else {
        this.previousPoses.set(vehicle.id, {
          generation: vehicle.poolGeneration,
          x: vehicle.sprite.x,
          y: vehicle.sprite.y,
          heading: vehicle.movement.collisionHeading,
        });
      }
    }
  }

  private prunePairCache(now: number): void {
    const expiry = now - 5000;
    for (const [first, seconds] of this.pairStates) {
      for (const [second, state] of seconds) {
        if (state.lastImpactAt < expiry && this.stepStamp - state.stepStamp > 300) {
          seconds.delete(second);
        }
      }
      if (seconds.size === 0) this.pairStates.delete(first);
    }
  }
}
