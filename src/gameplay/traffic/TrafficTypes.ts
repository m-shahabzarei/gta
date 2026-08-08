import type { Vector2 } from '@/core/types';
import type {
  HighwayCarriagewayDirection,
  HighwayComponent,
  RoadClass,
  VehicleKind,
} from '@/gameplay/types';

export type TrafficDriverState =
  | 'Spawning'
  | 'Finding Lane'
  | 'Following Lane'
  | 'Preparing Turn'
  | 'Turning'
  | 'Changing Lane'
  | 'Stopping'
  | 'Waiting'
  | 'Yielding'
  | 'Avoiding Obstacle'
  | 'Reversing'
  | 'Recovering'
  | 'Parking'
  | 'Despawning';

export type TrafficIntention =
  | 'Reach Destination'
  | 'Cruise'
  | 'Go Straight'
  | 'Turn Left'
  | 'Turn Right'
  | 'Change Lane Left'
  | 'Change Lane Right'
  | 'Yield'
  | 'Stop'
  | 'Reverse Safely'
  | 'Recalculate Route'
  | 'Park'
  | 'Despawn';

export type TrafficTurn = 'left' | 'right' | 'straight' | 'u-turn';
export type TrafficLaneKind = 'travel' | 'turn' | 'merge' | 'exit' | 'roundabout';
export type TrafficLaneRole = 'inner' | 'outer' | 'turn' | 'connector';
export type TrafficNodeKind =
  'intersection' | 'turn-node' | 'merge-node' | 'exit-node' | 'roundabout';
export type IntersectionControl = 'signal' | 'priority' | 'roundabout' | 'uncontrolled';

export interface SplineArcSample {
  readonly t: number;
  readonly distance: number;
  readonly point: Vector2;
}

/** Cubic Bezier spline with a distance lookup table for constant-speed sampling. */
export interface LaneSpline {
  readonly id: string;
  readonly controlPoints: readonly [Vector2, Vector2, Vector2, Vector2];
  readonly arcTable: readonly SplineArcSample[];
  readonly length: number;
}

export interface TrafficRoadSegment {
  readonly id: string;
  readonly fromNodeId: number;
  readonly toNodeId: number;
  readonly speedLimit: number;
  readonly laneWidth: number;
  readonly laneIds: readonly string[];
  readonly allowedVehicleTypes: readonly VehicleKind[];
  readonly roadClass: RoadClass;
  readonly direction: 'both' | 'forward' | 'reverse';
  readonly shoulder: boolean;
  readonly highwayId?: string;
  readonly highwayComponent?: HighwayComponent;
  readonly laneTransition?: 'acceleration' | 'deceleration' | 'merge' | 'diverge';
  readonly transitionPathId?: string;
  readonly interchangeId?: string;
  readonly carriageway?: HighwayCarriagewayDirection;
}

export interface TrafficLane {
  readonly id: string;
  readonly roadSegmentId: string | null;
  readonly kind: TrafficLaneKind;
  readonly role: TrafficLaneRole;
  readonly fromNodeId: number;
  readonly toNodeId: number;
  readonly laneIndex: number;
  readonly direction: 'forward';
  readonly width: number;
  readonly speedLimit: number;
  readonly spline: LaneSpline;
  readonly entryNodeId: number;
  readonly exitNodeId: number;
  readonly connectionIds: readonly string[];
  readonly turningPermissions: readonly TrafficTurn[];
  readonly priority: number;
  readonly intersectionId: number | null;
  readonly turn: TrafficTurn | null;
  readonly conflictLaneIds: readonly string[];
}

export interface TrafficJunction {
  readonly id: number;
  readonly kind: TrafficNodeKind;
  readonly control: IntersectionControl;
  readonly center: Vector2;
  readonly radius: number;
  readonly incomingLaneIds: readonly string[];
  readonly outgoingLaneIds: readonly string[];
  readonly connectorLaneIds: readonly string[];
  readonly priorityRule: 'signals' | 'yield-to-right' | 'roundabout' | 'dead-end';
}

export interface ParkingSpace {
  readonly id: string;
  readonly roadSegmentId: string;
  readonly adjacentLaneId: string;
  readonly position: Vector2;
  readonly heading: number;
  readonly width: number;
  readonly length: number;
  readonly distanceFromIntersection: number;
}

export interface TrafficDestination {
  readonly laneId: string;
  readonly position: Vector2;
  readonly purpose: 'ambient' | 'service' | 'emergency' | 'parking' | 'respawn';
}

export type TrafficPersonalityName =
  'careful' | 'normal' | 'aggressive' | 'taxi' | 'bus' | 'truck' | 'police' | 'ambulance';

export interface TrafficPersonality {
  readonly name: TrafficPersonalityName;
  readonly preferredSpeedFactor: number;
  readonly speedVariation: number;
  readonly maxAcceleration: number;
  readonly comfortableBraking: number;
  readonly emergencyBraking: number;
  readonly reactionSeconds: number;
  readonly minimumGap: number;
  readonly timeHeadway: number;
  readonly laneChangeDesire: number;
  readonly overtakingBias: number;
  readonly politeness: number;
  readonly riskTolerance: number;
  readonly intersectionPriority: number;
}

export type TrafficObstacleKind =
  | 'traffic'
  | 'stopped-traffic'
  | 'emergency-vehicle'
  | 'pedestrian'
  | 'road-work'
  | 'broken-vehicle'
  | 'temporary-obstacle'
  | 'building';

export interface PredictedObstacle {
  readonly kind: TrafficObstacleKind;
  readonly entityId: number | null;
  readonly position: Vector2;
  readonly distance: number;
  readonly timeToCollision: number | null;
  readonly desiredSpeed: number;
}

export interface TrafficAgentSnapshot {
  readonly vehicleId: number;
  readonly laneId: string;
  readonly laneDistance: number;
  readonly speed: number;
  readonly length: number;
  readonly position: Vector2;
  readonly heading: number;
  readonly state: TrafficDriverState;
  readonly emergency: boolean;
}

export interface TrafficApproach {
  readonly intersectionId: number;
  readonly x: number;
  readonly y: number;
  readonly distance: number;
}

export interface RecoveryStatus {
  readonly attempt: number;
  readonly phase: 'none' | 'wait' | 'reverse' | 'lane-change' | 'replan' | 'priority' | 'respawn';
  readonly blockedSeconds: number;
  readonly reason: string | null;
}

export interface TrafficDriverDebug {
  readonly vehicleId: number;
  readonly personality: TrafficPersonalityName;
  readonly state: TrafficDriverState;
  readonly intention: TrafficIntention;
  readonly laneId: string | null;
  readonly targetLaneId: string | null;
  readonly destination: TrafficDestination | null;
  readonly currentSpeed: number;
  readonly desiredSpeed: number;
  readonly steeringAngle: number;
  readonly headingError: number;
  readonly lateralError: number;
  readonly collisionPrediction: PredictedObstacle | null;
  readonly recovery: RecoveryStatus;
  readonly reservationId: string | null;
  readonly route: readonly string[];
  readonly predictedPath: readonly Vector2[];
}

export interface TrafficRuntimeStats {
  activeDrivers: number;
  parkedVehicles: number;
  queuedVehicles: number;
  routeCacheHits: number;
  routeCacheMisses: number;
  reservationsGranted: number;
  reservationsDenied: number;
  emergencyBrakes: number;
  recoveries: number;
  blockedDrivers: number;
  safeSpawnRejects: number;
  validationFailures: number;
  trafficCpuMs: number;
  navigationCpuMs: number;
  steeringCpuMs: number;
  collisionCpuMs: number;
  simulatedVehicles: number;
  virtualVehicles: number;
  nearSimulationVehicles: number;
  mediumSimulationVehicles: number;
  farSimulationVehicles: number;
  frozenSimulationVehicles: number;
  averageAiUpdateHz: number;
  schedulerLoad: number;
  schedulerDeferredUpdates: number;
  frameTimeMs: number;
}

export type TrafficValidationCode =
  | 'wrong-direction'
  | 'unexplained-stop'
  | 'blocked-intersection'
  | 'left-road'
  | 'building-collision'
  | 'bad-spawn-orientation'
  | 'stopped-in-merge'
  | 'transition-reversal'
  | 'recovery-timeout';

export interface TrafficValidationFailure {
  readonly code: TrafficValidationCode;
  readonly vehicleId: number;
  readonly message: string;
  readonly at: number;
}

export interface TrafficValidationReport {
  readonly passed: boolean;
  readonly checkedVehicles: number;
  readonly failures: readonly TrafficValidationFailure[];
}
