/** Mutable two-dimensional vector used by the allocation-free collision hot path. */
export interface MutableVehicleVector {
  x: number;
  y: number;
}

/** Physical integration ownership. Route authority is deliberately separate. */
export type VehiclePhysicalMode =
  | 'PlayerDynamic'
  | 'ArcadeDynamic'
  | 'TrafficKinematicWithImpact'
  | 'ParkedDynamic'
  | 'Disabled';

/** Temporary physical response layered over player control or a traffic route pose. */
export type VehicleImpactState =
  | 'None'
  | 'ImpactResponse'
  | 'ImpactRecovering'
  | 'RejoiningLane';

export type VehicleCollisionType =
  | 'rear-end'
  | 'head-on'
  | 'side'
  | 'glancing'
  | 'world';

export type VehicleCollisionSeverity = 'light' | 'medium' | 'heavy';
export type VehicleCollisionSolverSource = 'custom-obb' | 'custom-swept-obb' | 'arcade-world';

/** Data-driven rigid-body and impact tuning attached to every vehicle definition. */
export interface VehiclePhysicsDef {
  /** Collision mass in relative kilograms. */
  readonly mass: number;
  /** Rectangle moment of inertia in mass * px^2. */
  readonly rotationalInertia: number;
  /** Normal restitution before the global stability clamp. */
  readonly restitution: number;
  /** Coulomb friction coefficient at a vehicle contact. */
  readonly tireFriction: number;
  /** Fraction of route/control lateral velocity retained under tire grip. */
  readonly lateralGrip: number;
  /** External linear velocity damping coefficient in 1/s. */
  readonly rollingResistance: number;
  /** External lateral velocity damping coefficient in 1/s. */
  readonly lateralDamping: number;
  /** Collision yaw damping coefficient in 1/s. */
  readonly angularDamping: number;
  /** Target-specific multiplier applied to impact-energy damage. */
  readonly collisionDamageMultiplier: number;
  /** Relative normal speed below which no crash impulse/event is generated. */
  readonly minimumImpactSpeed: number;
  /** Maximum scalar impulse accepted in one contact. */
  readonly maximumCollisionImpulse: number;
  /** Absolute yaw-rate clamp in radians/second. */
  readonly maximumAngularVelocity: number;
}

export interface VehicleImpactDebugState {
  targetVehicleId: number | null;
  previousVelocity: MutableVehicleVector;
  velocityAfterImpact: MutableVehicleVector;
  relativeVelocity: MutableVehicleVector;
  collisionNormal: MutableVehicleVector;
  impulseVector: MutableVehicleVector;
  contactPoint: MutableVehicleVector;
  impactEnergy: number;
  damage: number;
  collisionType: VehicleCollisionType | null;
  solverSource: VehicleCollisionSolverSource | null;
  atMs: number;
}

/** Mutable state reset on every pool lifecycle transition. */
export interface VehicleDynamicsState {
  poolGeneration: number;
  physicalMode: VehiclePhysicalMode;
  controlVelocity: MutableVehicleVector;
  externalVelocity: MutableVehicleVector;
  previousVelocity: MutableVehicleVector;
  lateralVelocity: number;
  angularVelocity: number;
  impactOffset: MutableVehicleVector;
  impactHeadingOffset: number;
  impactTimer: number;
  recoveryTimer: number;
  recoveryDuration: number;
  /** Prevents a protected service vehicle from re-enqueueing timeout recovery every tick. */
  impactRecoveryFailureReported: boolean;
  impactState: VehicleImpactState;
  rejoinAllowed: boolean;
  lastCollisionAt: number;
  lastContactVehicleId: number | null;
  lastPairHandle: number | null;
  pairCooldownUntil: number;
  pendingCollisionEvent: boolean;
  damageImpulse: number;
  basePoseX: number;
  basePoseY: number;
  baseHeading: number;
  hasBasePose: boolean;
  debug: VehicleImpactDebugState;
}

function vector(): MutableVehicleVector {
  return { x: 0, y: 0 };
}

function debugState(): VehicleImpactDebugState {
  return {
    targetVehicleId: null,
    previousVelocity: vector(),
    velocityAfterImpact: vector(),
    relativeVelocity: vector(),
    collisionNormal: vector(),
    impulseVector: vector(),
    contactPoint: vector(),
    impactEnergy: 0,
    damage: 0,
    collisionType: null,
    solverSource: null,
    atMs: -Infinity,
  };
}

export function createVehicleDynamicsState(): VehicleDynamicsState {
  return {
    poolGeneration: 0,
    physicalMode: 'ArcadeDynamic',
    controlVelocity: vector(),
    externalVelocity: vector(),
    previousVelocity: vector(),
    lateralVelocity: 0,
    angularVelocity: 0,
    impactOffset: vector(),
    impactHeadingOffset: 0,
    impactTimer: 0,
    recoveryTimer: 0,
    recoveryDuration: 0,
    impactRecoveryFailureReported: false,
    impactState: 'None',
    rejoinAllowed: true,
    lastCollisionAt: -Infinity,
    lastContactVehicleId: null,
    lastPairHandle: null,
    pairCooldownUntil: -Infinity,
    pendingCollisionEvent: false,
    damageImpulse: 0,
    basePoseX: 0,
    basePoseY: 0,
    baseHeading: 0,
    hasBasePose: false,
    debug: debugState(),
  };
}

/** Reset in-place so a pooled vehicle never retains another spawn's impact state. */
export function resetVehicleDynamicsState(
  state: VehicleDynamicsState,
  heading: number,
  incrementGeneration = false,
): void {
  if (incrementGeneration) state.poolGeneration += 1;
  state.physicalMode = 'ArcadeDynamic';
  state.controlVelocity.x = 0;
  state.controlVelocity.y = 0;
  state.externalVelocity.x = 0;
  state.externalVelocity.y = 0;
  state.previousVelocity.x = 0;
  state.previousVelocity.y = 0;
  state.lateralVelocity = 0;
  state.angularVelocity = 0;
  state.impactOffset.x = 0;
  state.impactOffset.y = 0;
  state.impactHeadingOffset = 0;
  state.impactTimer = 0;
  state.recoveryTimer = 0;
  state.recoveryDuration = 0;
  state.impactRecoveryFailureReported = false;
  state.impactState = 'None';
  state.rejoinAllowed = true;
  state.lastCollisionAt = -Infinity;
  state.lastContactVehicleId = null;
  state.lastPairHandle = null;
  state.pairCooldownUntil = -Infinity;
  state.pendingCollisionEvent = false;
  state.damageImpulse = 0;
  state.basePoseX = 0;
  state.basePoseY = 0;
  state.baseHeading = heading;
  state.hasBasePose = false;
  const debug = state.debug;
  debug.targetVehicleId = null;
  debug.previousVelocity.x = 0;
  debug.previousVelocity.y = 0;
  debug.velocityAfterImpact.x = 0;
  debug.velocityAfterImpact.y = 0;
  debug.relativeVelocity.x = 0;
  debug.relativeVelocity.y = 0;
  debug.collisionNormal.x = 0;
  debug.collisionNormal.y = 0;
  debug.impulseVector.x = 0;
  debug.impulseVector.y = 0;
  debug.contactPoint.x = 0;
  debug.contactPoint.y = 0;
  debug.impactEnergy = 0;
  debug.damage = 0;
  debug.collisionType = null;
  debug.solverSource = null;
  debug.atMs = -Infinity;
}
