import type { Vector2 } from '@/core/types';
import { ENGINE_LIMITS } from '@/config/EngineLimits';
import { EngineDiagnostics } from '@/core/EngineDiagnostics';
import type { Vehicle } from '@/entities/Vehicle';
import type { EntityManager } from '@/systems/EntityManager';
import { EntityCategory } from '@/systems/EntityManager';
import type { IWorldQuery } from '@/gameplay/types';
import type { IntersectionReservationController } from './IntersectionReservationController';
import type { TrafficNetwork } from './TrafficNetwork';
import { personalityForVehicle } from './TrafficPersonality';
import { clamp, lerp, lerpAngle, sampleSpline, smoothstep, wrapAngle } from './SplineMath';
import type {
  PredictedObstacle,
  RecoveryStatus,
  TrafficAgentSnapshot,
  TrafficApproach,
  TrafficDestination,
  TrafficDriverDebug,
  TrafficDriverState,
  TrafficIntention,
  TrafficLane,
  TrafficLaneStopTarget,
  TrafficObstacleKind,
  TrafficPersonality,
} from './TrafficTypes';

export type TrafficSimulationDetail = 'full' | 'coarse' | 'frozen';

export interface TemporaryTrafficObstacle {
  readonly id: string;
  readonly kind: 'road-work' | 'temporary-obstacle';
  readonly position: Vector2;
  readonly radius: number;
  readonly expiresAt: number | null;
}

export interface TrafficPerceptionFrame {
  readonly managedVehicleIds: ReadonlySet<number>;
  readonly temporaryObstacles: readonly TemporaryTrafficObstacle[];
  forEachNearbyAgent(
    x: number,
    y: number,
    radius: number,
    visitor: (agent: TrafficAgentSnapshot) => void,
  ): void;
  forEachAgentOnLane(laneId: string, visitor: (agent: TrafficAgentSnapshot) => void): void;
}

export interface TrafficDriverUpdateMetrics {
  readonly navigationMs: number;
  readonly steeringMs: number;
  readonly collisionMs: number;
}

export interface TrafficDriverContext {
  readonly network: TrafficNetwork;
  readonly intersections: IntersectionReservationController;
  readonly world: IWorldQuery;
  readonly entities: EntityManager | null;
  readonly random: () => number;
  requestDespawn(driver: TrafficDriver, reason: string): void;
  onEmergencyBrake?(): void;
  onRecovery?(): void;
  onBlocked?(blocked: boolean): void;
}

interface DriverPose {
  readonly x: number;
  readonly y: number;
  readonly heading: number;
}

interface LaneChangeManeuver {
  readonly fromLane: TrafficLane;
  readonly toLane: TrafficLane;
  readonly startDistance: number;
  readonly length: number;
  travelled: number;
}

interface PathSample {
  readonly point: Vector2;
  readonly tangent: Vector2;
  readonly distance: number;
}

interface MutablePathSample {
  point: Vector2;
  tangent: Vector2;
  distance: number;
}

/** An actual rectangular vehicle body, measured in world-space road coordinates. */
interface VehicleFootprint {
  readonly heading: number;
  readonly width: number;
  readonly length: number;
}

interface MutableTrafficAgentSnapshot {
  vehicleId: number;
  laneId: string;
  laneDistance: number;
  speed: number;
  length: number;
  position: Vector2;
  heading: number;
  state: TrafficDriverState;
  emergency: boolean;
}

interface MutableTrafficDriverUpdateMetrics {
  navigationMs: number;
  steeringMs: number;
  collisionMs: number;
}

const SPAWN_SETTLE_SECONDS = 0.18;
const ROUTE_LOOK_AHEAD = 380;
const INTERSECTION_APPROACH_DISTANCE = 175;
const STOP_LINE_MARGIN = 7;
const DOWNSTREAM_CLEARANCE = 74;
const MAX_LATERAL_ACCELERATION = 175;
const MAX_JERK = 260;
const RECOVERY_TRIGGER_SECONDS = 5;
const MAX_RECOVERY_SECONDS = 24;
const ROUTE_REPLAN_COOLDOWN_SECONDS = 1.2;
const LANE_CHANGE_LENGTH = 105;
const STRATEGIC_UPDATE_MS = 1000;
const EXPLICIT_DESTINATION_UPDATE_MS = 250;
/** Keep a visible physical gap without inflating a car's length into lateral radius. */
const VEHICLE_SWEEP_CLEARANCE = 4;
/**
 * Distance-spline arc lengths are accumulated independently by route planning,
 * braking, and the fixed-step integrator.  Treat their final sub-pixel rounding
 * difference as zero so a service cannot settle a fraction of a pixel before
 * its legal curb target forever.  This is deliberately far smaller than the
 * caller's stop range; it is numerical precision, not a proximity trigger.
 */
const EXPLICIT_DESTINATION_DISTANCE_EPSILON = 0.75;

/**
 * One autonomous driver's complete decision state. Its pose is constrained to
 * network splines; only longitudinal speed and deliberate lane changes evolve.
 */
export class TrafficDriver {
  private readonly personality: TrafficPersonality;
  private readonly speedPreference: number;
  private targetProvider: (() => Vector2 | null) | null;
  private stopRange: number;
  private stateValue: TrafficDriverState = 'Spawning';
  private intentionValue: TrafficIntention = 'Reach Destination';
  private route: TrafficLane[] = [];
  private routeIndex = 0;
  private routeRequiresContinuation = false;
  /** A validated service segment supplied by route authoring; never rebuilt per frame. */
  private plannedRouteActive = false;
  private laneDistance = 0;
  private destinationValue: TrafficDestination | null = null;
  /** Optional exact curb target. Generic services continue to use nearest-lane destinations. */
  private laneStopTarget: TrafficLaneStopTarget | null = null;
  private desiredSpeedValue = 0;
  private speedValue = 0;
  private accelerationValue = 0;
  private steeringAngleValue = 0;
  private headingErrorValue = 0;
  private lateralErrorValue = 0;
  private collisionPredictionValue: PredictedObstacle | null = null;
  private reservationId: string | null = null;
  private externallyStopped = false;
  private cityAlertUrgency = 0;
  private arrivedValue = false;
  private ageSeconds = 0;
  private stationarySeconds = 0;
  private blockedSeconds = 0;
  private replanCooldownSeconds = 0;
  private recoveryAttempt = 0;
  private recoveryPhase: RecoveryStatus['phase'] = 'none';
  private recoveryReason: string | null = null;
  private recoveryPhaseSeconds = 0;
  private recoveryTotalSeconds = 0;
  private laneChange: LaneChangeManeuver | null = null;
  private previousPose: DriverPose;
  private currentPose: DriverPose;
  private readonly predictedPathValue: Vector2[] = [];
  private readonly pathScratch: MutablePathSample[] = [];
  private emergencyBraking = false;
  private lastExplicitTargetLaneId: string | null = null;
  private lastExplicitTargetPosition: Vector2 | null = null;
  private snapshotValue: MutableTrafficAgentSnapshot | null = null;
  private readonly updateMetricsValue: MutableTrafficDriverUpdateMetrics = {
    navigationMs: 0,
    steeringMs: 0,
    collisionMs: 0,
  };
  private strategicDirty = true;
  private nextStrategicUpdateAt = 0;
  private highwayLaneChangeCooldown = 0;
  private highwayClearSeconds = 0;

  constructor(
    private readonly vehicle: Vehicle,
    private readonly context: TrafficDriverContext,
    targetProvider: (() => Vector2 | null) | null,
    stopRange = 56,
    initialLane: TrafficLane | null = null,
    initialDistance: number | null = null,
  ) {
    this.personality = personalityForVehicle(vehicle.def.kind, vehicle.def.isEmergency);
    this.speedPreference = 1 + (context.random() * 2 - 1) * this.personality.speedVariation;
    this.targetProvider = targetProvider;
    this.stopRange = stopRange;
    const lane =
      initialLane ?? context.network.nearestLane(vehicle.position, vehicle.movement.heading, true);
    if (lane) {
      this.route = [lane];
      this.laneDistance = clamp(
        initialDistance ?? context.network.projectPoint(vehicle.position, lane).distance,
        0,
        lane.spline.length,
      );
      const pose = this.poseOnCurrentLane();
      this.previousPose = pose;
      this.currentPose = pose;
    } else {
      this.previousPose = {
        x: vehicle.sprite.x,
        y: vehicle.sprite.y,
        heading: vehicle.movement.heading,
      };
      this.currentPose = this.previousPose;
    }
    this.vehicle.movement.setTrafficAuthority(true);
  }

  public get id(): number {
    return this.vehicle.id;
  }

  /** Current authoritative simulation pose. The scheduler uses it for LOD. */
  public get position(): Vector2 {
    return this.currentPose;
  }

  public get updateMetrics(): Readonly<TrafficDriverUpdateMetrics> {
    return this.updateMetricsValue;
  }

  /** Streaming keeps explicit mission/service destinations when an entity sleeps. */
  public get streamingTargetProvider(): (() => Vector2 | null) | null {
    return this.targetProvider;
  }

  public get streamingStopRange(): number {
    return this.stopRange;
  }

  public restoreVirtualSpeed(speed: number): void {
    this.speedValue = Math.max(0, speed);
    this.desiredSpeedValue = this.speedValue;
    this.accelerationValue = 0;
    this.previousPose = this.currentPose;
  }

  public get arrived(): boolean {
    return this.arrivedValue;
  }

  public get state(): TrafficDriverState {
    return this.stateValue;
  }

  public get approachingIntersection(): TrafficApproach | null {
    const lane = this.currentLane();
    const next = this.nextLane();
    if (!lane || lane.kind !== 'travel' || !next?.intersectionId) return null;
    const distance = lane.spline.length - this.laneDistance;
    if (distance > INTERSECTION_APPROACH_DISTANCE) return null;
    const junction = this.context.network.junction(next.intersectionId);
    return junction
      ? { intersectionId: junction.id, x: junction.center.x, y: junction.center.y, distance }
      : null;
  }

  public get debug(): TrafficDriverDebug {
    return {
      vehicleId: this.vehicle.id,
      personality: this.personality.name,
      state: this.stateValue,
      intention: this.intentionValue,
      laneId: this.currentLane()?.id ?? null,
      targetLaneId: this.laneChange?.toLane.id ?? this.nextLane()?.id ?? null,
      destination: this.destinationValue,
      laneDistance: this.laneDistance,
      routeIndex: this.routeIndex,
      plannedRouteActive: this.plannedRouteActive,
      externallyStopped: this.externallyStopped,
      distanceToDestination: this.distanceToExplicitDestination(),
      destinationLaneDistance: this.destinationValue && this.currentLane()
        ? this.destinationLaneDistance(this.destinationValue, this.currentLane() as TrafficLane)
        : null,
      currentSpeed: this.speedValue,
      desiredSpeed: this.desiredSpeedValue,
      steeringAngle: this.steeringAngleValue,
      headingError: this.headingErrorValue,
      lateralError: this.lateralErrorValue,
      collisionPrediction: this.collisionPredictionValue,
      recovery: this.recoveryStatus(),
      reservationId: this.reservationId,
      trafficAuthority: this.vehicle.movement.trafficControlled,
      route: this.route.map((lane) => lane.id),
      routeTailKind: this.route[this.route.length - 1]?.kind ?? null,
      routeTailHasOutgoing: (this.route[this.route.length - 1]?.connectionIds.length ?? 0) > 0,
      predictedPath: this.predictedPathValue,
    };
  }

  public snapshot(): TrafficAgentSnapshot | null {
    const lane = this.currentLane();
    if (!lane) return null;
    const snapshot =
      this.snapshotValue ??
      (this.snapshotValue = {
        vehicleId: this.vehicle.id,
        laneId: lane.id,
        laneDistance: this.laneDistance,
        speed: 0,
        length: Math.max(this.vehicle.def.width, this.vehicle.def.height),
        position: { x: this.currentPose.x, y: this.currentPose.y },
        heading: this.currentPose.heading,
        state: this.stateValue,
        emergency: this.vehicle.def.isEmergency,
      });
    snapshot.laneId = lane.id;
    snapshot.laneDistance = this.laneDistance;
    snapshot.speed = Math.max(0, this.speedValue);
    snapshot.position.x = this.currentPose.x;
    snapshot.position.y = this.currentPose.y;
    snapshot.heading = this.currentPose.heading;
    snapshot.state = this.stateValue;
    return snapshot;
  }

  public configure(
    targetProvider: (() => Vector2 | null) | null,
    stopRange = this.stopRange,
  ): void {
    const changed = targetProvider !== this.targetProvider;
    this.targetProvider = targetProvider;
    this.stopRange = stopRange;
    if (changed) {
      this.arrivedValue = false;
      this.forceReplan();
    }
  }

  /**
   * Bind a service destination to an exact directed lane arc. This is used by
   * curb services such as buses; it deliberately bypasses nearest-lane lookup
   * so an opposite-direction lane cannot satisfy the target.
   */
  public configureLaneStopTarget(target: TrafficLaneStopTarget | null): boolean {
    if (target === null) {
      if (this.laneStopTarget !== null) {
        this.laneStopTarget = null;
        this.arrivedValue = false;
        this.forceReplan();
      }
      return true;
    }
    const lane = this.context.network.lane(target.laneId);
    if (!lane || lane.kind !== 'travel') return false;
    const laneDistance = clamp(target.laneDistance, 0, lane.spline.length);
    const pose = this.context.network.pointAt(lane, laneDistance);
    const changed =
      this.laneStopTarget?.laneId !== lane.id ||
      Math.abs((this.laneStopTarget?.laneDistance ?? -1) - laneDistance) > 0.5;
    this.laneStopTarget = {
      laneId: lane.id,
      laneDistance,
      position: { x: pose.point.x, y: pose.point.y },
      heading: pose.heading,
    };
    if (changed) {
      this.lastExplicitTargetPosition = null;
      this.lastExplicitTargetLaneId = null;
      this.arrivedValue = false;
      this.forceReplan();
    }
    return true;
  }

  /**
   * Follow a prevalidated directed lane segment exactly. This is used by buses
   * after route authoring has cached the ordered stop-to-stop path, avoiding
   * partial live A* choices that can drift onto a valid but unrelated loop.
   */
  public configurePlannedRoute(laneIds: readonly string[] | null): boolean {
    if (laneIds === null || laneIds.length === 0) {
      this.plannedRouteActive = false;
      return true;
    }
    const lanes: TrafficLane[] = [];
    for (const laneId of laneIds) {
      const lane = this.context.network.lane(laneId);
      if (!lane) return false;
      const previous = lanes[lanes.length - 1];
      if (previous && !previous.connectionIds.includes(lane.id)) return false;
      lanes.push(lane);
    }
    const current = this.currentLane();
    const currentIndex = current ? lanes.findIndex((lane) => lane.id === current.id) : -1;
    if (currentIndex < 0) return false;
    this.route = lanes;
    this.routeIndex = currentIndex;
    this.routeRequiresContinuation = false;
    this.plannedRouteActive = true;
    this.strategicDirty = false;
    this.nextStrategicUpdateAt = 0;
    this.arrivedValue = false;
    return true;
  }

  /**
   * Hold a persistent service vehicle at its current legal lane after the
   * generic traffic recovery system asks to despawn it. The service manager
   * owns the next action (recalculate, alternate approach, then bounded skip)
   * because deleting or blindly resetting a scheduled bus loses route state.
   */
  public holdForServiceRecovery(reason: string | null = null): void {
    this.externallyStopped = true;
    this.arrivedValue = false;
    this.speedValue = 0;
    this.desiredSpeedValue = 0;
    this.accelerationValue = 0;
    this.recoveryAttempt = 0;
    this.recoveryPhase = 'none';
    // Preserve the escalation reason while the service owner is deciding
    // whether it can reinstall an authored route. Clearing this here made a
    // persistent taxi look like an unexplained external stop in diagnostics.
    this.recoveryReason = reason;
    this.recoveryPhaseSeconds = 0;
    this.recoveryTotalSeconds = 0;
    this.blockedSeconds = 0;
    this.stationarySeconds = 0;
    this.context.intersections.releaseVehicle(this.vehicle.id);
    this.reservationId = null;
    this.stateValue = 'Stopping';
    this.intentionValue = 'Stop';
  }

  /** Clear a held service recovery before transit assigns a fresh exact target. */
  public resumeFromServiceRecovery(): void {
    this.externallyStopped = false;
    this.recoveryAttempt = 0;
    this.recoveryPhase = 'none';
    this.recoveryReason = null;
    this.recoveryPhaseSeconds = 0;
    this.recoveryTotalSeconds = 0;
    this.blockedSeconds = 0;
    this.stationarySeconds = 0;
    this.forceReplan();
  }

  /** Try the normal validated adjacent-lane manoeuvre for a blocked scheduled service. */
  public requestServiceRecoveryLaneChange(): boolean {
    if (this.laneChange || this.externallyStopped) return false;
    const lane = this.currentLane();
    if (!lane || lane.kind !== 'travel') return false;
    const clearPerception: TrafficPerceptionFrame = {
      managedVehicleIds: new Set<number>([this.vehicle.id]),
      temporaryObstacles: [],
      forEachNearbyAgent: () => undefined,
      forEachAgentOnLane: (laneId, visitor) => {
        this.context.entities?.forEachNearby(
          this.currentPose.x,
          this.currentPose.y,
          ROUTE_LOOK_AHEAD,
          (entity) => {
            const candidate = entity as unknown as Vehicle;
            if (
              !candidate.sprite?.active ||
              candidate.id === this.vehicle.id ||
              candidate.isDestroyed ||
              !candidate.movement
            ) {
              return;
            }
            const projectedLane = this.context.network.nearestLane(
              candidate.position,
              candidate.movement.heading,
              true,
            );
            if (!projectedLane || projectedLane.id !== laneId) return;
            visitor({
              vehicleId: candidate.id,
              laneId: projectedLane.id,
              laneDistance: this.context.network.projectPoint(candidate.position, projectedLane).distance,
              speed: Math.max(0, candidate.movement.speed),
              length: Math.max(candidate.def.width, candidate.def.height),
              position: candidate.position,
              heading: candidate.movement.heading,
              state: 'Following Lane',
              emergency: candidate.def.isEmergency,
            });
          },
          EntityCategory.Vehicle,
        );
      },
    };
    return this.tryBeginLaneChange(clearPerception);
  }

  public setStopped(stopped: boolean): void {
    this.externallyStopped = stopped;
    if (stopped) this.intentionValue = 'Stop';
  }

  public setCityAlert(urgency: number): void {
    this.cityAlertUrgency = this.vehicle.def.isEmergency
      ? 0
      : clamp(Number.isFinite(urgency) ? urgency : 0, 0, 0.4);
  }

  public forceReplan(): void {
    const current = this.currentLane();
    this.route = current ? [current] : [];
    this.routeIndex = 0;
    this.routeRequiresContinuation = false;
    this.plannedRouteActive = false;
    this.context.intersections.releaseVehicle(this.vehicle.id);
    this.reservationId = null;
    this.replanCooldownSeconds = ROUTE_REPLAN_COOLDOWN_SECONDS;
    this.strategicDirty = true;
    this.nextStrategicUpdateAt = 0;
    this.arrivedValue = false;
    this.stateValue = 'Finding Lane';
    this.intentionValue = 'Recalculate Route';
  }

  public fixedUpdate(
    now: number,
    deltaSeconds: number,
    perception: TrafficPerceptionFrame,
    detail: TrafficSimulationDetail = 'full',
  ): void {
    this.resetUpdateMetrics();
    if (this.vehicle.isDestroyed || this.vehicle.isPlayerDriven || !this.vehicle.sprite.active) {
      this.stateValue = 'Despawning';
      this.intentionValue = 'Despawn';
      this.context.intersections.releaseVehicle(this.vehicle.id);
      this.vehicle.movement.setTrafficAuthority(false);
      return;
    }
    this.previousPose = this.currentPose;
    this.ageSeconds += deltaSeconds;
    this.replanCooldownSeconds = Math.max(0, this.replanCooldownSeconds - deltaSeconds);
    this.highwayLaneChangeCooldown = Math.max(0, this.highwayLaneChangeCooldown - deltaSeconds);

    if (this.ageSeconds < SPAWN_SETTLE_SECONDS) {
      this.stateValue = 'Spawning';
      this.desiredSpeedValue = 0;
      this.integrateSpeed(0, deltaSeconds);
      this.currentPose = this.poseOnCurrentLane();
      return;
    }
    const navigationStartedAt = performance.now();
    if (!this.refreshStrategicRoute(now)) {
      this.updateMetricsValue.navigationMs = performance.now() - navigationStartedAt;
      this.stateValue = 'Finding Lane';
      this.intentionValue = 'Recalculate Route';
      this.integrateSpeed(0, deltaSeconds);
      this.updateRecovery(deltaSeconds, true, 'no legal route', perception);
      return;
    }
    this.updateMetricsValue.navigationMs = performance.now() - navigationStartedAt;
    if (this.reachedExplicitDestination()) {
      this.arrivedValue = true;
      this.stateValue = this.destinationValue?.purpose === 'parking' ? 'Parking' : 'Stopping';
      this.intentionValue = this.destinationValue?.purpose === 'parking' ? 'Park' : 'Stop';
      this.desiredSpeedValue = 0;
      this.integrateSpeed(0, deltaSeconds);
      this.currentPose = this.poseOnCurrentLane();
      this.updateKinematicTelemetry(deltaSeconds);
      return;
    }
    this.arrivedValue = false;
    if (detail === 'frozen') {
      this.updateVirtual(deltaSeconds);
      return;
    }
    if (this.stateValue === 'Reversing' && this.updateReverse(deltaSeconds, perception)) return;
    if (this.stateValue === 'Recovering' && this.updateRecoveryPhase(deltaSeconds, perception)) {
      return;
    }

    const lane = this.currentLane();
    if (!lane) return;
    if (detail === 'coarse') {
      this.updateCoarse(now, deltaSeconds, lane, perception);
      return;
    }
    const collisionStartedAt = performance.now();
    const path = this.buildPredictedPath(ROUTE_LOOK_AHEAD);
    this.updatePredictedPathDebug(path);
    const obstacle = this.predictObstacle(path, perception);
    this.updateMetricsValue.collisionMs = performance.now() - collisionStartedAt;
    const steeringStartedAt = performance.now();
    this.collisionPredictionValue = obstacle;
    this.updateHighwayLanePolicy(deltaSeconds, lane, obstacle, perception);
    const intersectionLimit = this.intersectionSpeedLimit(now, lane, perception);
    const curvatureLimit = this.curvatureSpeedLimit(lane);
    const alertSpeedFactor = 1 + this.cityAlertUrgency * (0.82 + (this.vehicle.id % 5) * 0.045);
    const freeSpeed = Math.min(
      this.vehicle.movement.effectiveMaxSpeed * 0.86 * alertSpeedFactor,
      lane.speedLimit *
        this.personality.preferredSpeedFactor *
        this.speedPreference *
        alertSpeedFactor,
      this.routeTransitionSpeedLimit(lane),
      curvatureLimit,
      intersectionLimit,
      this.destinationSpeedLimit(lane),
    );
    const obstacleSpeed = obstacle?.desiredSpeed ?? Infinity;
    const targetSpeed = this.externallyStopped
      ? 0
      : Math.max(0, Math.min(freeSpeed, obstacleSpeed));
    this.desiredSpeedValue = targetSpeed;
    const acceleration = this.intelligentAcceleration(targetSpeed, obstacle);
    this.integrateAcceleration(acceleration, deltaSeconds);

    if (this.externallyStopped) {
      this.stateValue = 'Stopping';
      this.intentionValue = 'Stop';
    } else if (obstacle && obstacle.distance < 150) {
      this.stateValue = 'Avoiding Obstacle';
      this.intentionValue =
        obstacle.kind === 'traffic' || obstacle.kind === 'stopped-traffic' ? 'Yield' : 'Stop';
    } else if (lane.kind !== 'travel') {
      this.stateValue = 'Turning';
      this.intentionValue = this.intentionForTurn(lane.turn);
      this.context.intersections.markEntered(this.vehicle.id);
    } else if (this.laneChange) {
      this.stateValue = 'Changing Lane';
    } else if (this.approachingIntersection) {
      this.stateValue = 'Preparing Turn';
    } else {
      this.stateValue = 'Following Lane';
      this.intentionValue = this.isMainHighwayLane(lane) ? 'Cruise' : 'Reach Destination';
    }

    this.advanceAlongRoute(Math.max(0, this.speedValue) * deltaSeconds);
    this.currentPose = this.poseOnCurrentLane();
    this.updateKinematicTelemetry(deltaSeconds);
    this.updateMetricsValue.steeringMs = performance.now() - steeringStartedAt;
    const recoveryBlocked =
      this.speedValue < 1.5 &&
      (this.desiredSpeedValue > 14 ||
        (this.stateValue === 'Avoiding Obstacle' &&
          this.stationarySeconds > RECOVERY_TRIGGER_SECONDS));
    this.updateRecovery(deltaSeconds, recoveryBlocked, obstacle?.kind ?? null, perception);
  }

  public render(interpolation: number): void {
    if (
      !this.vehicle.sprite.active ||
      (!this.vehicle.sprite.visible && this.vehicle.sprite.getData('persistentTransitService') !== true)
    ) {
      return;
    }
    const amount = clamp(interpolation, 0, 1);
    const x = lerp(this.previousPose.x, this.currentPose.x, amount);
    const y = lerp(this.previousPose.y, this.currentPose.y, amount);
    const heading = lerpAngle(this.previousPose.heading, this.currentPose.heading, amount);
    this.vehicle.movement.applyTrafficPose(
      x,
      y,
      heading,
      this.speedValue,
      this.steeringAngleValue,
      this.accelerationValue < -10,
    );
  }

  public destroy(): void {
    this.context.intersections.releaseVehicle(this.vehicle.id);
    this.vehicle.movement.setTrafficAuthority(false);
    this.route.length = 0;
  }

  private refreshDestination(): void {
    const laneStop = this.laneStopTarget;
    const target = laneStop?.position ?? this.targetProvider?.() ?? null;
    if (!target) {
      if (!this.destinationValue || this.destinationValue.purpose !== 'ambient') {
        this.destinationValue = null;
      }
      this.lastExplicitTargetLaneId = null;
      this.lastExplicitTargetPosition = null;
      return;
    }
    const previousTarget = this.lastExplicitTargetPosition;
    if (
      previousTarget &&
      this.destinationValue &&
      this.destinationValue.purpose !== 'ambient' &&
      Math.abs(previousTarget.x - target.x) <= 24 &&
      Math.abs(previousTarget.y - target.y) <= 24 &&
      (!laneStop ||
        (this.destinationValue.laneId === laneStop.laneId &&
          Math.abs((this.destinationValue.laneDistance ?? -1) - laneStop.laneDistance) <= 0.5))
    ) {
      return;
    }
    const goal = laneStop
      ? this.context.network.lane(laneStop.laneId)
      : this.context.network.nearestLane(target, undefined, true);
    if (goal?.kind !== 'travel') return;
    const position = laneStop
      ? this.context.network.pointAt(goal, laneStop.laneDistance).point
      : { x: target.x, y: target.y };
    this.destinationValue = {
      laneId: goal.id,
      position,
      purpose: this.vehicle.def.isEmergency ? 'emergency' : 'service',
      laneDistance: laneStop?.laneDistance,
      heading: laneStop?.heading,
    };
    if (
      this.lastExplicitTargetLaneId !== null &&
      this.lastExplicitTargetLaneId !== goal.id &&
      this.replanCooldownSeconds <= 0
    ) {
      this.forceReplan();
    }
    this.lastExplicitTargetLaneId = goal.id;
    this.lastExplicitTargetPosition = { x: target.x, y: target.y };
  }

  /** Strategic destination and route work is event-driven and rate limited. */
  private refreshStrategicRoute(now: number): boolean {
    const lane = this.currentLane();
    if (!this.strategicDirty && lane && now < this.nextStrategicUpdateAt) return true;
    this.refreshDestination();
    const resolved = this.ensureRoute();
    this.strategicDirty = !resolved;
    const explicit = this.destinationValue?.purpose !== 'ambient';
    this.nextStrategicUpdateAt =
      now + (explicit ? EXPLICIT_DESTINATION_UPDATE_MS : STRATEGIC_UPDATE_MS);
    return resolved;
  }

  private ensureRoute(): boolean {
    let current = this.currentLane();
    if (!current) {
      current = this.context.network.nearestLane(
        this.vehicle.position,
        this.vehicle.movement.heading,
        true,
      );
      if (!current) return false;
      this.route = [current];
      this.routeIndex = 0;
      this.routeRequiresContinuation = false;
      this.laneDistance = this.context.network.projectPoint(
        this.vehicle.position,
        current,
      ).distance;
    }
    if (!this.destinationValue) {
      const destination = this.context.network.chooseDestination(current.id, this.context.random);
      if (!destination) return false;
      const endPose = sampleSpline(destination.spline, destination.spline.length * 0.8);
      this.destinationValue = {
        laneId: destination.id,
        position: endPose.point,
        purpose: 'ambient',
      };
    }
    // A stale exact-stop route can leave the target arc behind the vehicle on
    // the same directed lane. Treating that as a zero-distance trip makes the
    // destination speed limit clamp to zero forever. Install a complete legal
    // cycle through the road graph and use the final occurrence of the lane as
    // the actual destination instead.
    if (
      this.destinationValue.purpose !== 'ambient' &&
      this.destinationValue.laneId === current.id &&
      this.destinationValue.laneDistance !== undefined &&
      this.destinationValue.laneDistance < this.laneDistance - EXPLICIT_DESTINATION_DISTANCE_EPSILON
    ) {
      const loop = this.buildDestinationLoop(current, this.destinationValue.laneId);
      if (!loop) return false;
      this.route = loop;
      this.routeIndex = 0;
      this.routeRequiresContinuation = false;
      this.plannedRouteActive = true;
      this.strategicDirty = false;
      this.nextStrategicUpdateAt = 0;
      this.arrivedValue = false;
      return true;
    }
    if (this.plannedRouteActive) {
      const finalLane = this.route[this.route.length - 1];
      if (
        this.route[this.routeIndex]?.id === current.id &&
        finalLane?.id === this.destinationValue.laneId
      ) {
        return true;
      }
      // A recovery manoeuvre or external lane change moved the vehicle off its
      // authored segment. Fall back to normal bounded replanning; the transit
      // state machine will account for the recovery instead of pretending the
      // bus is still on the cached path.
      this.plannedRouteActive = false;
    }
    if (this.route.length > 1) {
      const routeEndsAtDestination =
        this.route[this.route.length - 1]?.id === this.destinationValue.laneId;
      if (routeEndsAtDestination) return true;

      // A bounded A* slice may end at a connector. That connector cannot be
      // entered safely without its following travel lane: it has no outgoing
      // lane for downstream-clearance/reservation validation. Continue the
      // route while there is still a travel-plus-connector buffer instead of
      // retaining the incomplete tail until the lead vehicle freezes at the
      // stop line and blocks every vehicle behind it.
      const remainingLanes = this.route.length - this.routeIndex - 1;
      if (this.routeRequiresContinuation && remainingLanes > 2) return true;
    }
    const route = this.context.network.findRoute(current.id, this.destinationValue.laneId);
    if (!route || route.length === 0) return false;
    this.route = route.slice();
    this.routeIndex = 0;
    this.routeRequiresContinuation =
      this.route[this.route.length - 1]?.id !== this.destinationValue.laneId;
    if (this.route[0]?.id !== current.id) this.laneDistance = 0;
    return true;
  }

  private intersectionSpeedLimit(
    now: number,
    lane: TrafficLane,
    perception: TrafficPerceptionFrame,
  ): number {
    const next = this.nextLane();
    if (lane.kind !== 'travel' || !next?.intersectionId) return Infinity;
    const distanceToStopLine = Math.max(
      0,
      lane.spline.length - this.laneDistance - STOP_LINE_MARGIN,
    );
    if (distanceToStopLine > INTERSECTION_APPROACH_DISTANCE) return Infinity;
    const outgoing = this.route[this.routeIndex + 2];
    if (!outgoing) return 0;
    const existing = this.context.intersections.hasReservation(this.vehicle.id);
    const approachClear = this.approachIsClear(lane, distanceToStopLine, perception);
    if (existing?.connectorLaneId === next.id && approachClear) {
      this.reservationId = existing.id;
      return next.speedLimit;
    }
    const downstreamClear = this.downstreamIsClear(outgoing, perception);
    const speed = Math.max(12, this.speedValue);
    const decision = this.context.intersections.request(now, {
      vehicleId: this.vehicle.id,
      intersectionId: next.intersectionId,
      connectorLaneId: next.id,
      incomingLaneId: lane.id,
      outgoingLaneId: outgoing.id,
      distanceToStopLine,
      arrivalAt: now + (distanceToStopLine / speed) * 1000,
      priority: this.personality.intersectionPriority + Math.min(4, this.recoveryAttempt),
      emergency: this.vehicle.def.isEmergency,
      recoveryAttempt: this.recoveryAttempt,
      approachClear,
      downstreamClear,
    });
    if (decision.granted && decision.reservation) {
      this.reservationId = decision.reservation.id;
      return next.speedLimit;
    }
    this.reservationId = null;
    this.stateValue = decision.reason === 'exit-blocked' ? 'Waiting' : 'Yielding';
    this.intentionValue = decision.reason === 'signal' ? 'Stop' : 'Yield';
    return Math.sqrt(Math.max(0, 2 * this.personality.comfortableBraking * distanceToStopLine));
  }

  /**
   * Never reserve an intersection through the physical body of a queued
   * vehicle on this same approach. The reservation controller cannot infer
   * this from connector conflicts alone because only the lead vehicle is at
   * the stop line; permitting a follower would produce a real queue deadlock.
   */
  private approachIsClear(
    lane: TrafficLane,
    distanceToStopLine: number,
    perception: TrafficPerceptionFrame,
  ): boolean {
    const frontDistance = this.laneDistance + distanceToStopLine;
    const requiredGap = Math.max(this.vehicle.def.width, this.vehicle.def.height) * 0.5 + 8;
    let clear = true;
    perception.forEachAgentOnLane(lane.id, (agent) => {
      if (agent.vehicleId === this.vehicle.id || agent.laneId !== lane.id) return;
      if (agent.laneDistance > this.laneDistance + 1 && agent.laneDistance < frontDistance + requiredGap) {
        clear = false;
      }
    });
    return clear;
  }

  private downstreamIsClear(outgoing: TrafficLane, perception: TrafficPerceptionFrame): boolean {
    let clear = true;
    perception.forEachAgentOnLane(outgoing.id, (agent) => {
      if (agent.vehicleId === this.vehicle.id || agent.laneId !== outgoing.id) return;
      if (agent.laneDistance < DOWNSTREAM_CLEARANCE + agent.length) clear = false;
    });
    return clear;
  }

  private intelligentAcceleration(targetSpeed: number, obstacle: PredictedObstacle | null): number {
    if (targetSpeed <= 0.1) return -this.personality.comfortableBraking;
    const speed = Math.max(0, this.speedValue);
    const freeRoad = 1 - (speed / Math.max(1, targetSpeed)) ** 4;
    let interaction = 0;
    if (obstacle) {
      const closingSpeed = obstacle.timeToCollision
        ? obstacle.distance / Math.max(0.1, obstacle.timeToCollision)
        : speed;
      const highway = this.isEngineeredHighwayLane(this.currentLane());
      const minimumGap = this.personality.minimumGap * (highway ? 1.35 : 1);
      const timeHeadway = highway
        ? Math.max(1.55, this.personality.timeHeadway)
        : this.personality.timeHeadway;
      const dynamicGap =
        minimumGap +
        speed * timeHeadway +
        (speed * closingSpeed) /
          (2 * Math.sqrt(this.personality.maxAcceleration * this.personality.comfortableBraking));
      interaction = (dynamicGap / Math.max(1, obstacle.distance)) ** 2;
    }
    const acceleration = this.personality.maxAcceleration * (freeRoad - interaction);
    return clamp(
      acceleration,
      -this.personality.emergencyBraking,
      this.personality.maxAcceleration,
    );
  }

  private integrateAcceleration(requested: number, deltaSeconds: number): void {
    const maxChange =
      (this.isEngineeredHighwayLane(this.currentLane()) ? MAX_JERK * 0.72 : MAX_JERK) *
      deltaSeconds;
    this.accelerationValue += clamp(requested - this.accelerationValue, -maxChange, maxChange);
    this.speedValue = clamp(
      this.speedValue + this.accelerationValue * deltaSeconds,
      0,
      this.vehicle.movement.effectiveMaxSpeed,
    );
    if (requested <= -this.personality.emergencyBraking * 0.7 && !this.emergencyBraking) {
      this.context.onEmergencyBrake?.();
      this.emergencyBraking = true;
    } else if (requested > -this.personality.emergencyBraking * 0.35) {
      this.emergencyBraking = false;
    }
  }

  private integrateSpeed(targetSpeed: number, deltaSeconds: number): void {
    const requested =
      targetSpeed > this.speedValue
        ? this.personality.maxAcceleration
        : -this.personality.comfortableBraking;
    this.integrateAcceleration(requested, deltaSeconds);
  }

  /** Far traffic keeps legal lane motion without path sampling or local steering. */
  private updateCoarse(
    now: number,
    deltaSeconds: number,
    lane: TrafficLane,
    perception: TrafficPerceptionFrame,
  ): void {
    const steeringStartedAt = performance.now();
    const collisionStartedAt = performance.now();
    const obstacle = this.nearestLeadOnLane(lane, perception);
    this.updateMetricsValue.collisionMs = performance.now() - collisionStartedAt;
    this.collisionPredictionValue = obstacle;
    this.updateHighwayLanePolicy(deltaSeconds, lane, obstacle, perception);
    const intersectionLimit = this.intersectionSpeedLimit(now, lane, perception);
    const freeSpeed = Math.min(
      this.vehicle.movement.effectiveMaxSpeed * 0.82,
      lane.speedLimit * this.personality.preferredSpeedFactor * this.speedPreference,
      intersectionLimit,
      this.destinationSpeedLimit(lane),
    );
    const targetSpeed = this.externallyStopped
      ? 0
      : Math.max(0, Math.min(freeSpeed, obstacle?.desiredSpeed ?? Infinity));
    this.desiredSpeedValue = targetSpeed;
    this.integrateAcceleration(this.intelligentAcceleration(targetSpeed, obstacle), deltaSeconds);
    this.stateValue = lane.kind === 'travel' ? 'Following Lane' : 'Turning';
    this.intentionValue =
      lane.kind === 'travel'
        ? this.isMainHighwayLane(lane)
          ? 'Cruise'
          : 'Reach Destination'
        : this.intentionForTurn(lane.turn);
    this.advanceAlongRoute(Math.max(0, this.speedValue) * deltaSeconds);
    this.currentPose = this.poseOnCurrentLane();
    this.steeringAngleValue = 0;
    this.headingErrorValue = 0;
    this.lateralErrorValue = 0;
    this.predictedPathValue.length = 0;
    this.updateMetricsValue.steeringMs = performance.now() - steeringStartedAt;
  }

  /** Virtual traffic advances only its lane state and is never allowed to wake physics. */
  private updateVirtual(deltaSeconds: number): void {
    const startedAt = performance.now();
    const lane = this.currentLane();
    if (!lane) return;
    this.collisionPredictionValue = null;
    this.predictedPathValue.length = 0;
    const targetSpeed = this.externallyStopped
      ? 0
      : Math.min(
          this.vehicle.movement.effectiveMaxSpeed * 0.72,
          lane.speedLimit * this.personality.preferredSpeedFactor * this.speedPreference * 0.76,
          this.destinationSpeedLimit(lane),
        );
    this.desiredSpeedValue = targetSpeed;
    this.integrateSpeed(targetSpeed, deltaSeconds);
    this.advanceVirtualRoute(Math.max(0, this.speedValue) * deltaSeconds);
    this.currentPose = this.poseOnCurrentLane();
    this.steeringAngleValue = 0;
    this.headingErrorValue = 0;
    this.lateralErrorValue = 0;
    this.stateValue = lane.kind === 'travel' ? 'Following Lane' : 'Turning';
    this.intentionValue =
      lane.kind === 'travel' ? 'Reach Destination' : this.intentionForTurn(lane.turn);
    this.updateMetricsValue.steeringMs = performance.now() - startedAt;
  }

  private nearestLeadOnLane(
    lane: TrafficLane,
    perception: TrafficPerceptionFrame,
  ): PredictedObstacle | null {
    let closest: PredictedObstacle | null = null;
    perception.forEachAgentOnLane(lane.id, (agent) => {
      if (agent.vehicleId === this.vehicle.id || agent.laneDistance <= this.laneDistance) return;
      const gap = Math.max(
        0.5,
        agent.laneDistance -
          this.laneDistance -
          agent.length * 0.5 -
          Math.max(this.vehicle.def.width, this.vehicle.def.height) * 0.5,
      );
      const obstacle = this.makeObstacle(
        agent.emergency ? 'emergency-vehicle' : agent.speed < 2 ? 'stopped-traffic' : 'traffic',
        agent.vehicleId,
        agent.position,
        gap,
        this.speedValue - agent.speed,
        agent.speed,
      );
      closest = closerObstacle(closest, obstacle);
    });
    return closest;
  }

  private advanceVirtualRoute(distance: number): void {
    let remaining = distance;
    for (
      let advances = 0;
      remaining > 0 && advances < ENGINE_LIMITS.MAX_ROUTE_ADVANCES_PER_UPDATE;
      advances += 1
    ) {
      if (!Number.isFinite(remaining) || !Number.isFinite(this.laneDistance)) {
        this.abortRouteAdvance('invalid virtual route distance');
        return;
      }
      const lane = this.currentLane();
      if (!lane) return;
      if (this.stopAtExplicitDestinationIfCrossed(lane, remaining)) return;
      const available = lane.spline.length - this.laneDistance;
      if (!Number.isFinite(available) || !Number.isFinite(lane.spline.length)) {
        this.abortRouteAdvance(`invalid virtual lane ${lane.id}`);
        return;
      }
      if (remaining < available) {
        this.laneDistance += remaining;
        return;
      }
      const next = this.nextLane();
      if (!next) {
        this.laneDistance = lane.spline.length;
        this.handleDestinationReached();
        return;
      }
      remaining -= Math.max(0, available);
      this.routeIndex += 1;
      this.laneDistance = 0;
      this.context.intersections.releaseVehicle(this.vehicle.id);
      this.reservationId = null;
    }
    if (remaining > 0) this.abortRouteAdvance('virtual route advance limit');
  }

  private advanceAlongRoute(distance: number): void {
    if (this.laneChange) this.laneChange.travelled += distance;
    let remaining = distance;
    for (
      let advances = 0;
      remaining > 0 && advances < ENGINE_LIMITS.MAX_ROUTE_ADVANCES_PER_UPDATE;
      advances += 1
    ) {
      if (!Number.isFinite(remaining) || !Number.isFinite(this.laneDistance)) {
        this.abortRouteAdvance('invalid route distance');
        return;
      }
      const lane = this.currentLane();
      if (!lane) return;
      if (this.stopAtExplicitDestinationIfCrossed(lane, remaining)) return;
      const available = lane.spline.length - this.laneDistance;
      if (!Number.isFinite(available) || !Number.isFinite(lane.spline.length)) {
        this.abortRouteAdvance(`invalid lane ${lane.id}`);
        return;
      }
      if (remaining < available) {
        this.laneDistance += remaining;
        remaining = 0;
        break;
      }
      const next = this.nextLane();
      if (!next) {
        this.laneDistance = lane.spline.length;
        this.handleDestinationReached();
        return;
      }
      if (
        next.intersectionId !== null &&
        !this.context.intersections.hasReservation(this.vehicle.id)
      ) {
        this.laneDistance = Math.max(0, lane.spline.length - STOP_LINE_MARGIN);
        this.speedValue = 0;
        return;
      }
      remaining -= Math.max(0, available);
      const leavingConnector = lane.intersectionId !== null;
      this.routeIndex += 1;
      this.laneDistance = 0;
      if (leavingConnector) {
        this.context.intersections.releaseVehicle(this.vehicle.id);
        this.reservationId = null;
      }
    }
    if (remaining > 0) {
      this.abortRouteAdvance('route advance limit');
      return;
    }
    if (this.laneChange && this.laneChange.travelled >= this.laneChange.length) {
      this.completeLaneChange();
    }
  }

  private abortRouteAdvance(reason: string): void {
    EngineDiagnostics.recordLimitExceeded(
      'MAX_ROUTE_ADVANCES_PER_UPDATE',
      ENGINE_LIMITS.MAX_ROUTE_ADVANCES_PER_UPDATE + 1,
      ENGINE_LIMITS.MAX_ROUTE_ADVANCES_PER_UPDATE,
      'despawned-runaway-traffic-driver',
      `vehicle:${this.vehicle.id}:${reason}`,
    );
    this.stateValue = 'Despawning';
    this.intentionValue = 'Despawn';
    this.speedValue = 0;
    this.context.intersections.releaseVehicle(this.vehicle.id);
    this.reservationId = null;
    this.context.requestDespawn(this, reason);
  }

  private handleDestinationReached(): void {
    const destination = this.destinationValue;
    if (!destination) return;
    if (destination.purpose === 'ambient') {
      const current = this.currentLane();
      this.destinationValue = null;
      this.route = current ? [current] : [];
      this.routeIndex = 0;
      this.routeRequiresContinuation = false;
      this.strategicDirty = true;
      this.nextStrategicUpdateAt = 0;
      return;
    }
    if (destination.laneDistance !== undefined) {
      if (this.reachedExplicitDestination()) this.markExplicitDestinationArrived();
      else this.forceReplan();
      return;
    }
    const dx = this.currentPose.x - destination.position.x;
    const dy = this.currentPose.y - destination.position.y;
    if (Math.hypot(dx, dy) <= this.stopRange + 80) {
      this.markExplicitDestinationArrived();
    } else {
      this.forceReplan();
    }
  }

  private buildPredictedPath(maxDistance: number): PathSample[] {
    const result = this.pathScratch;
    let count = 0;
    let routeDistance = 0;
    for (
      let index = this.routeIndex;
      index < this.route.length && routeDistance <= maxDistance;
      index++
    ) {
      const lane = this.route[index];
      if (!lane) continue;
      const start = index === this.routeIndex ? this.laneDistance : 0;
      for (let distance = start; distance <= lane.spline.length; distance += 18) {
        const relative = routeDistance + distance - start;
        if (relative > maxDistance) break;
        const pose = sampleSpline(lane.spline, distance);
        const sample =
          result[count] ??
          (result[count] = {
            point: { x: pose.point.x, y: pose.point.y },
            tangent: { x: pose.tangent.x, y: pose.tangent.y },
            distance: relative,
          });
        sample.point.x = pose.point.x;
        sample.point.y = pose.point.y;
        sample.tangent.x = pose.tangent.x;
        sample.tangent.y = pose.tangent.y;
        sample.distance = relative;
        count += 1;
      }
      routeDistance += lane.spline.length - start;
    }
    result.length = count;
    return result;
  }

  private updatePredictedPathDebug(path: readonly PathSample[]): void {
    this.predictedPathValue.length = path.length;
    for (let index = 0; index < path.length; index++) {
      const sample = path[index];
      if (!sample) continue;
      const point =
        this.predictedPathValue[index] ??
        (this.predictedPathValue[index] = { x: sample.point.x, y: sample.point.y });
      point.x = sample.point.x;
      point.y = sample.point.y;
    }
  }

  private predictObstacle(
    path: readonly PathSample[],
    perception: TrafficPerceptionFrame,
  ): PredictedObstacle | null {
    let closest: PredictedObstacle | null = null;
    perception.forEachNearbyAgent(
      this.currentPose.x,
      this.currentPose.y,
      ROUTE_LOOK_AHEAD,
      (agent) => {
        if (agent.vehicleId === this.vehicle.id) return;
        const routeDistance = this.context.network.routeDistanceToLane(
          this.route,
          this.routeIndex,
          this.laneDistance,
          agent.laneId,
          agent.laneDistance,
        );
        if (routeDistance === null || routeDistance <= 0 || routeDistance > ROUTE_LOOK_AHEAD) {
          return;
        }
        const gap = Math.max(
          0.5,
          routeDistance -
            agent.length * 0.5 -
            Math.max(this.vehicle.def.width, this.vehicle.def.height) * 0.5,
        );
        const closing = this.speedValue - agent.speed;
        const kind: TrafficObstacleKind = agent.emergency
          ? 'emergency-vehicle'
          : agent.speed < 2
            ? 'stopped-traffic'
            : 'traffic';
        const obstacle = this.makeObstacle(
          kind,
          agent.vehicleId,
          agent.position,
          gap,
          closing,
          agent.speed,
        );
        if (!closest || obstacle.distance < closest.distance) closest = obstacle;
      },
    );

    const inspectWorldObject = (
      entityId: number | null,
      position: Vector2,
      radius: number,
      kind: TrafficObstacleKind,
      otherSpeed = 0,
    ): void => {
      const projected = this.projectOnPredictedPath(position, path);
      if (!projected || projected.lateral > radius + this.vehicle.def.width * 0.65) return;
      const gap = Math.max(
        0.5,
        projected.distance -
          radius -
          Math.max(this.vehicle.def.width, this.vehicle.def.height) * 0.5,
      );
      const obstacle = this.makeObstacle(
        kind,
        entityId,
        position,
        gap,
        this.speedValue - otherSpeed,
        otherSpeed,
      );
      if (!closest || obstacle.distance < closest.distance) closest = obstacle;
    };

    const inspectVehicleFootprint = (
      candidate: Vehicle,
      kind: TrafficObstacleKind,
      otherSpeed: number,
    ): void => {
      const contactDistance = this.projectFootprintOntoPredictedPath(
        candidate.position,
        {
          heading: candidate.movement.heading,
          width: candidate.def.width,
          length: candidate.def.height,
        },
        path,
      );
      // A parked vehicle must remain an obstacle when it genuinely occupies
      // the lane, but its full length must not be treated as a circular lateral
      // radius while it is correctly parked beside that lane.
      if (contactDistance === null) return;
      const obstacle = this.makeObstacle(
        kind,
        candidate.id,
        candidate.position,
        contactDistance,
        this.speedValue - otherSpeed,
        otherSpeed,
      );
      if (!closest || obstacle.distance < closest.distance) closest = obstacle;
    };

    this.context.entities?.forEachNearby(
      this.currentPose.x,
      this.currentPose.y,
      ROUTE_LOOK_AHEAD,
      (entity) => {
        const candidate = entity as unknown as Vehicle;
        if (
          !candidate.sprite?.active ||
          candidate.id === this.vehicle.id ||
          perception.managedVehicleIds.has(candidate.id)
        ) {
          return;
        }
        const kind: TrafficObstacleKind = candidate.isDestroyed
          ? 'broken-vehicle'
          : candidate.def?.isEmergency
            ? 'emergency-vehicle'
            : candidate.movement?.speed < 2
              ? 'stopped-traffic'
              : 'traffic';
        inspectVehicleFootprint(candidate, kind, Math.max(0, candidate.movement?.speed ?? 0));
      },
      EntityCategory.Vehicle,
    );
    this.context.entities?.forEachNearby(
      this.currentPose.x,
      this.currentPose.y,
      ROUTE_LOOK_AHEAD,
      (entity) => {
        const pedestrian = entity as unknown as {
          id: number;
          isDead?: boolean;
          sprite?: { x: number; y: number; active: boolean };
        };
        if (pedestrian.isDead || !pedestrian.sprite?.active) return;
        inspectWorldObject(pedestrian.id, pedestrian.sprite, 13, 'pedestrian');
      },
      EntityCategory.Npc,
    );
    for (const obstacle of perception.temporaryObstacles) {
      inspectWorldObject(null, obstacle.position, obstacle.radius, obstacle.kind);
    }
    for (const sample of path) {
      if (sample.distance < 22) continue;
      if (this.context.world.isDrivableAtWorld(sample.point.x, sample.point.y)) continue;
      const obstacle = this.makeObstacle(
        'building',
        null,
        sample.point,
        sample.distance,
        this.speedValue,
        0,
      );
      closest = closerObstacle(closest, obstacle);
      break;
    }
    return closest;
  }

  private makeObstacle(
    kind: TrafficObstacleKind,
    entityId: number | null,
    position: Vector2,
    distance: number,
    closingSpeed: number,
    otherSpeed: number,
  ): PredictedObstacle {
    const timeToCollision = closingSpeed > 0.5 ? distance / closingSpeed : null;
    const highway = this.isEngineeredHighwayLane(this.currentLane());
    const minimumGap = this.personality.minimumGap * (highway ? 1.35 : 1);
    const timeHeadway = highway
      ? Math.max(1.55, this.personality.timeHeadway)
      : this.personality.timeHeadway;
    const stopSpeed = Math.sqrt(
      Math.max(0, 2 * this.personality.comfortableBraking * Math.max(0, distance - minimumGap)),
    );
    const followSpeed = Math.max(0, otherSpeed + (distance - minimumGap) / timeHeadway);
    return {
      kind,
      entityId,
      position: { ...position },
      distance,
      timeToCollision,
      desiredSpeed: Math.min(stopSpeed, followSpeed),
    };
  }

  private projectOnPredictedPath(
    position: Vector2,
    path: readonly PathSample[],
  ): { distance: number; lateral: number } | null {
    let closest: { distance: number; lateral: number } | null = null;
    for (const sample of path) {
      const lateral = Math.hypot(position.x - sample.point.x, position.y - sample.point.y);
      if (!closest || lateral < closest.lateral) closest = { distance: sample.distance, lateral };
    }
    return closest;
  }

  /**
   * Find the first contact between a rectangular vehicle body and this
   * driver's swept lane corridor. Unlike the old circular approximation, a
   * long parked sedan clears the bus if its actual width stays outside the
   * corridor; a diagonally parked or lane-blocking sedan still produces a
   * finite stopping gap.
   */
  private projectFootprintOntoPredictedPath(
    position: Vector2,
    footprint: VehicleFootprint,
    path: readonly PathSample[],
  ): number | null {
    const vehicleHalfWidth = this.vehicle.def.width * 0.5;
    const vehicleHalfLength = this.vehicle.def.height * 0.5;
    let closestContact = Infinity;
    for (const sample of path) {
      const tangent = sample.tangent;
      const normal = { x: -tangent.y, y: tangent.x };
      const dx = position.x - sample.point.x;
      const dy = position.y - sample.point.y;
      const longitudinal = dx * tangent.x + dy * tangent.y;
      const lateral = Math.abs(dx * normal.x + dy * normal.y);
      const footprintHalfWidth = this.footprintHalfExtent(footprint, normal);
      if (lateral > vehicleHalfWidth + footprintHalfWidth + VEHICLE_SWEEP_CLEARANCE) {
        continue;
      }
      const footprintHalfLength = this.footprintHalfExtent(footprint, tangent);
      const nearestContact =
        sample.distance + longitudinal - footprintHalfLength - vehicleHalfLength;
      const furthestContact =
        sample.distance + longitudinal + footprintHalfLength + vehicleHalfLength;
      if (furthestContact < 0) continue;
      closestContact = Math.min(closestContact, Math.max(0.5, nearestContact));
    }
    return Number.isFinite(closestContact) ? closestContact : null;
  }

  private footprintHalfExtent(footprint: VehicleFootprint, axis: Vector2): number {
    const forward = { x: Math.cos(footprint.heading), y: Math.sin(footprint.heading) };
    const right = { x: -forward.y, y: forward.x };
    return (
      Math.abs(forward.x * axis.x + forward.y * axis.y) * footprint.length * 0.5 +
      Math.abs(right.x * axis.x + right.y * axis.y) * footprint.width * 0.5
    );
  }

  private curvatureSpeedLimit(lane: TrafficLane): number {
    let maximumCurvature = 0;
    for (let lookAhead = 0; lookAhead <= 90; lookAhead += 15) {
      const pose = sampleSpline(lane.spline, this.laneDistance + lookAhead);
      maximumCurvature = Math.max(maximumCurvature, Math.abs(pose.curvature));
    }
    return maximumCurvature > 0.0001
      ? Math.sqrt(MAX_LATERAL_ACCELERATION / maximumCurvature)
      : Infinity;
  }

  private updateRecovery(
    deltaSeconds: number,
    blocked: boolean,
    reason: string | null,
    perception: TrafficPerceptionFrame,
  ): void {
    this.stationarySeconds = this.speedValue < 1.5 ? this.stationarySeconds + deltaSeconds : 0;
    this.blockedSeconds = blocked
      ? this.blockedSeconds + deltaSeconds
      : Math.max(0, this.blockedSeconds - deltaSeconds * 2);
    this.context.onBlocked?.(blocked);
    if (this.recoveryPhase !== 'none') this.recoveryTotalSeconds += deltaSeconds;
    if (this.recoveryTotalSeconds > MAX_RECOVERY_SECONDS) {
      this.recoveryPhase = 'respawn';
      this.stateValue = 'Despawning';
      this.intentionValue = 'Despawn';
      this.context.requestDespawn(this, 'recovery timeout');
      return;
    }
    if (
      !blocked ||
      this.blockedSeconds < RECOVERY_TRIGGER_SECONDS ||
      this.recoveryPhase !== 'none'
    ) {
      return;
    }
    this.beginNextRecovery(reason ?? 'blocked', perception);
  }

  private beginNextRecovery(reason: string, perception: TrafficPerceptionFrame): void {
    this.recoveryAttempt += 1;
    this.recoveryReason = reason;
    this.recoveryPhaseSeconds = 0;
    this.context.onRecovery?.();
    this.context.intersections.releaseVehicle(this.vehicle.id);
    this.reservationId = null;
    if (this.recoveryAttempt === 1) {
      this.recoveryPhase = 'wait';
      this.stateValue = 'Recovering';
      this.intentionValue = 'Yield';
      return;
    }
    if (this.recoveryAttempt === 2 && this.canReverse(perception)) {
      this.recoveryPhase = 'reverse';
      this.stateValue = 'Reversing';
      this.intentionValue = 'Reverse Safely';
      return;
    }
    if (this.recoveryAttempt === 3 && this.tryBeginLaneChange(perception)) {
      this.recoveryPhase = 'lane-change';
      return;
    }
    if (this.recoveryAttempt <= 4) {
      this.recoveryPhase = 'replan';
      this.intentionValue = 'Recalculate Route';
      this.forceReplan();
      this.stateValue = 'Recovering';
      return;
    }
    if (this.recoveryAttempt === 5) {
      this.recoveryPhase = 'priority';
      this.stateValue = 'Recovering';
      this.intentionValue = 'Yield';
      return;
    }
    this.recoveryPhase = 'respawn';
    this.stateValue = 'Despawning';
    this.intentionValue = 'Despawn';
    this.context.requestDespawn(this, reason);
  }

  private updateRecoveryPhase(deltaSeconds: number, perception: TrafficPerceptionFrame): boolean {
    this.recoveryPhaseSeconds += deltaSeconds;
    this.recoveryTotalSeconds += deltaSeconds;
    this.speedValue = Math.max(
      0,
      this.speedValue - this.personality.comfortableBraking * deltaSeconds,
    );
    if (this.recoveryPhase === 'wait' && this.recoveryPhaseSeconds >= 1.4) {
      this.recoveryPhase = 'none';
      this.blockedSeconds = RECOVERY_TRIGGER_SECONDS * 0.65;
      return false;
    }
    if (this.recoveryPhase === 'replan' && this.recoveryPhaseSeconds >= 0.5) {
      this.recoveryPhase = 'none';
      this.blockedSeconds = RECOVERY_TRIGGER_SECONDS * 0.65;
      return false;
    }
    if (this.recoveryPhase === 'priority' && this.recoveryPhaseSeconds >= 2.4) {
      this.recoveryPhase = 'none';
      this.blockedSeconds = RECOVERY_TRIGGER_SECONDS * 0.85;
      return false;
    }
    if (this.recoveryPhase === 'lane-change' && !this.laneChange) {
      this.recoveryPhase = 'none';
      return false;
    }
    this.currentPose = this.poseOnCurrentLane();
    void perception;
    return true;
  }

  private updateReverse(deltaSeconds: number, perception: TrafficPerceptionFrame): boolean {
    this.recoveryPhaseSeconds += deltaSeconds;
    this.recoveryTotalSeconds += deltaSeconds;
    if (
      !this.canReverse(perception) ||
      this.recoveryPhaseSeconds >= 1.15 ||
      this.laneDistance <= 12
    ) {
      this.speedValue = 0;
      this.recoveryPhase = 'none';
      this.stateValue = 'Recovering';
      this.blockedSeconds = RECOVERY_TRIGGER_SECONDS * 0.65;
      this.forceReplan();
      return false;
    }
    const reverseSpeed = Math.min(34, this.recoveryPhaseSeconds * 48);
    this.speedValue = -reverseSpeed;
    this.laneDistance = Math.max(0, this.laneDistance - reverseSpeed * deltaSeconds);
    this.currentPose = this.poseOnCurrentLane();
    return true;
  }

  private canReverse(perception: TrafficPerceptionFrame): boolean {
    const lane = this.currentLane();
    if (
      !lane ||
      lane.kind !== 'travel' ||
      this.isEngineeredHighwayLane(lane) ||
      this.laneDistance < 28
    ) {
      return false;
    }
    let clear = true;
    perception.forEachAgentOnLane(lane.id, (agent) => {
      if (agent.vehicleId === this.vehicle.id || agent.laneId !== lane.id) return;
      const gap = this.laneDistance - agent.laneDistance;
      if (gap > 0 && gap < 58 + agent.length) clear = false;
    });
    return clear;
  }

  private tryBeginLaneChange(perception: TrafficPerceptionFrame): boolean {
    const lane = this.currentLane();
    if (
      !lane ||
      lane.kind !== 'travel' ||
      lane.spline.length - this.laneDistance < LANE_CHANGE_LENGTH + 35
    ) {
      return false;
    }
    const choices = [
      this.context.network.parallelLane(lane, 1),
      this.context.network.parallelLane(lane, -1),
    ].filter((candidate): candidate is TrafficLane => candidate !== null);
    for (const target of choices) {
      if (this.beginLaneChangeTo(lane, target, perception, true)) return true;
    }
    return false;
  }

  /** Highway-only overtaking and keep-right policy; city lanes never enter here. */
  private updateHighwayLanePolicy(
    deltaSeconds: number,
    lane: TrafficLane,
    obstacle: PredictedObstacle | null,
    perception: TrafficPerceptionFrame,
  ): void {
    if (
      this.plannedRouteActive ||
      !this.isMainHighwayLane(lane) ||
      lane.kind !== 'travel' ||
      this.laneChange ||
      this.highwayLaneChangeCooldown > 0 ||
      lane.spline.length - this.laneDistance < LANE_CHANGE_LENGTH + 45
    ) {
      this.highwayClearSeconds = 0;
      return;
    }
    const blockedBySlowerTraffic =
      obstacle !== null &&
      (obstacle.kind === 'traffic' || obstacle.kind === 'stopped-traffic') &&
      obstacle.distance < 190 &&
      obstacle.desiredSpeed < Math.max(42, this.speedValue * 0.84);
    if (blockedBySlowerTraffic && lane.laneIndex > 0) {
      const passingLane = this.context.network.parallelLane(lane, -1);
      if (passingLane && this.beginLaneChangeTo(lane, passingLane, perception, false)) {
        this.highwayClearSeconds = 0;
        return;
      }
    }
    if (obstacle && obstacle.distance < 230) {
      this.highwayClearSeconds = 0;
      return;
    }
    this.highwayClearSeconds += deltaSeconds;
    if (this.highwayClearSeconds >= 2.8) {
      const rightLane = this.context.network.parallelLane(lane, 1);
      if (rightLane && this.beginLaneChangeTo(lane, rightLane, perception, false)) {
        this.highwayClearSeconds = 0;
      }
    }
  }

  private beginLaneChangeTo(
    lane: TrafficLane,
    target: TrafficLane,
    perception: TrafficPerceptionFrame,
    recovery: boolean,
  ): boolean {
    let clear = true;
    perception.forEachAgentOnLane(target.id, (agent) => {
      if (agent.vehicleId === this.vehicle.id || agent.laneId !== target.id) return;
      const relative = agent.laneDistance - this.laneDistance;
      const forwardGap = Math.max(88, this.speedValue * 1.35) + agent.length;
      const rearGap = Math.max(72, agent.speed * 1.15) + agent.length;
      if ((relative >= 0 && relative < forwardGap) || (relative < 0 && -relative < rearGap)) {
        clear = false;
      }
    });
    if (!clear) return false;
    this.laneChange = {
      fromLane: lane,
      toLane: target,
      startDistance: this.laneDistance,
      length: LANE_CHANGE_LENGTH,
      travelled: 0,
    };
    if (recovery) this.recoveryPhase = 'lane-change';
    this.stateValue = 'Changing Lane';
    this.intentionValue =
      target.laneIndex > lane.laneIndex ? 'Change Lane Right' : 'Change Lane Left';
    this.highwayLaneChangeCooldown = 3.5;
    return true;
  }

  private completeLaneChange(): void {
    const maneuver = this.laneChange;
    if (!maneuver) return;
    const destination = this.destinationValue;
    this.route = [maneuver.toLane];
    this.routeIndex = 0;
    this.routeRequiresContinuation = false;
    this.plannedRouteActive = false;
    this.laneDistance = clamp(
      maneuver.startDistance + maneuver.travelled,
      0,
      maneuver.toLane.spline.length,
    );
    this.laneChange = null;
    this.recoveryPhase = 'none';
    this.highwayLaneChangeCooldown = Math.max(this.highwayLaneChangeCooldown, 3.5);
    if (destination) this.strategicDirty = true;
    this.nextStrategicUpdateAt = 0;
  }

  private poseOnCurrentLane(): DriverPose {
    const lane = this.currentLane();
    if (!lane) {
      return (
        this.currentPose ?? {
          x: this.vehicle.sprite.x,
          y: this.vehicle.sprite.y,
          heading: this.vehicle.movement.heading,
        }
      );
    }
    if (!this.laneChange) {
      const pose = sampleSpline(lane.spline, this.laneDistance);
      return { x: pose.point.x, y: pose.point.y, heading: pose.heading };
    }
    const maneuver = this.laneChange;
    const amount = smoothstep(maneuver.travelled / maneuver.length);
    const fromPose = sampleSpline(maneuver.fromLane.spline, this.laneDistance);
    const targetDistance = clamp(this.laneDistance, 0, maneuver.toLane.spline.length);
    const toPose = sampleSpline(maneuver.toLane.spline, targetDistance);
    const point = {
      x: lerp(fromPose.point.x, toPose.point.x, amount),
      y: lerp(fromPose.point.y, toPose.point.y, amount),
    };
    const aheadAmount = smoothstep((maneuver.travelled + 2) / maneuver.length);
    const fromAhead = sampleSpline(maneuver.fromLane.spline, this.laneDistance + 2).point;
    const toAhead = sampleSpline(maneuver.toLane.spline, targetDistance + 2).point;
    const ahead = {
      x: lerp(fromAhead.x, toAhead.x, aheadAmount),
      y: lerp(fromAhead.y, toAhead.y, aheadAmount),
    };
    return { x: point.x, y: point.y, heading: Math.atan2(ahead.y - point.y, ahead.x - point.x) };
  }

  private updateKinematicTelemetry(deltaSeconds: number): void {
    const lane = this.currentLane();
    if (!lane) return;
    const projection = this.context.network.projectPoint(this.currentPose, lane);
    this.lateralErrorValue = Math.sqrt(projection.distanceSq);
    this.headingErrorValue = wrapAngle(projection.heading - this.currentPose.heading);
    const wheelbase = Math.max(
      18,
      Math.hypot(this.vehicle.def.width, this.vehicle.def.height) * 1.45,
    );
    const desiredSteering = Math.atan(wheelbase * projection.curvature);
    const steeringRate = 2.8 * deltaSeconds;
    this.steeringAngleValue += clamp(
      desiredSteering - this.steeringAngleValue,
      -steeringRate,
      steeringRate,
    );
  }

  private resetUpdateMetrics(): void {
    this.updateMetricsValue.navigationMs = 0;
    this.updateMetricsValue.steeringMs = 0;
    this.updateMetricsValue.collisionMs = 0;
  }

  private recoveryStatus(): RecoveryStatus {
    return {
      attempt: this.recoveryAttempt,
      phase: this.recoveryPhase,
      blockedSeconds: this.blockedSeconds,
      reason: this.recoveryReason,
    };
  }

  private destinationSpeedLimit(lane: TrafficLane): number {
    const destination = this.destinationValue;
    if (!destination || destination.purpose === 'ambient') return Infinity;
    const distance = this.distanceToExplicitDestination(lane);
    if (distance === null) return Infinity;
    // Negative distance means the current route is stale or malformed. Do not
    // turn that diagnostic condition into a permanent zero-speed vehicle; the
    // next route refresh will either install the loop above or enter bounded
    // traffic recovery.
    if (distance < -this.destinationArrivalWindow()) return Infinity;
    const remaining = distance - this.destinationArrivalWindow();
    return Math.sqrt(Math.max(0, 2 * this.personality.comfortableBraking * remaining));
  }

  /** Remaining legal route distance to the exact service target, or null if it is not on this route. */
  private distanceToExplicitDestination(startLane: TrafficLane | null = this.currentLane()): number | null {
    const destination = this.destinationValue;
    const current = startLane;
    if (!destination || destination.purpose === 'ambient' || !current) return null;
    const destinationIndex = this.destinationRouteIndex();
    if (destinationIndex < this.routeIndex) return null;
    const targetLane = this.route[destinationIndex] ?? null;
    if (!targetLane || targetLane.id !== destination.laneId) return null;
    if (destinationIndex === this.routeIndex) {
      return this.destinationLaneDistance(destination, current) - this.laneDistance;
    }

    let distance = Math.max(0, current.spline.length - this.laneDistance);
    for (let index = this.routeIndex + 1; index <= destinationIndex; index += 1) {
      const lane = this.route[index];
      if (!lane) continue;
      distance += index === destinationIndex
        ? this.destinationLaneDistance(destination, lane)
        : lane.spline.length;
    }
    return distance;
  }

  private destinationLaneDistance(destination: TrafficDestination, lane: TrafficLane): number {
    return clamp(
      destination.laneDistance ?? this.context.network.projectPoint(destination.position, lane).distance,
      0,
      lane.spline.length,
    );
  }

  private destinationArrivalWindow(): number {
    return Math.max(1, this.stopRange * 0.35) + EXPLICIT_DESTINATION_DISTANCE_EPSILON;
  }

  /** Clamp a coarse or virtual update at a valid curb target instead of allowing it to pass the stop. */
  private stopAtExplicitDestinationIfCrossed(lane: TrafficLane, requestedDistance: number): boolean {
    const destination = this.destinationValue;
    if (
      !destination ||
      destination.purpose === 'ambient' ||
      destination.laneId !== lane.id ||
      this.destinationRouteIndex() !== this.routeIndex
    ) {
      return false;
    }
    const targetDistance = this.destinationLaneDistance(destination, lane);
    const stoppingDistance = clamp(
      targetDistance - this.destinationArrivalWindow(),
      0,
      lane.spline.length,
    );
    const remaining = stoppingDistance - this.laneDistance;
    // If a malformed/old route has already travelled beyond the curb, let the
    // normal recovery path replan instead of falsely declaring an arrival.
    if (remaining < -this.destinationArrivalWindow()) return false;
    if (remaining > requestedDistance) return false;
    this.laneDistance = stoppingDistance;
    this.markExplicitDestinationArrived();
    return true;
  }

  private markExplicitDestinationArrived(): void {
    const destination = this.destinationValue;
    if (!destination) return;
    this.arrivedValue = true;
    this.stateValue = destination.purpose === 'parking' ? 'Parking' : 'Stopping';
    this.intentionValue = destination.purpose === 'parking' ? 'Park' : 'Stop';
    this.desiredSpeedValue = 0;
    this.speedValue = 0;
    this.accelerationValue = 0;
  }

  private routeTransitionSpeedLimit(lane: TrafficLane): number {
    let distance = Math.max(0, lane.spline.length - this.laneDistance);
    let limit = Infinity;
    for (let index = this.routeIndex + 1; index < this.route.length && distance <= 520; index++) {
      const candidate = this.route[index];
      if (!candidate) continue;
      const candidateLimit = candidate.speedLimit;
      const brakingLimit = Math.sqrt(
        Math.max(
          0,
          candidateLimit * candidateLimit + 2 * this.personality.comfortableBraking * distance,
        ),
      );
      limit = Math.min(limit, brakingLimit);
      distance += candidate.spline.length;
    }
    return limit;
  }

  private reachedExplicitDestination(): boolean {
    const destination = this.destinationValue;
    const lane = this.currentLane();
    if (
      !destination ||
      destination.purpose === 'ambient' ||
      !lane ||
      destination.laneId !== lane.id ||
      this.destinationRouteIndex() !== this.routeIndex
    ) {
      return false;
    }
    const remaining = this.destinationLaneDistance(destination, lane) - this.laneDistance;
    // Braking uses a small arc-length buffer so the body settles before the
    // exact curb point. Arrival, however, is the configured service stopping
    // radius: a low-speed vehicle on the named directional lane has reached
    // its legal stop even when fixed-step braking leaves a few pixels before
    // the ideal arc. TransportationSystem performs the final route, lane,
    // heading, and curb-radius validation before it opens boarding.
    const tolerance = Math.max(this.stopRange, this.destinationArrivalWindow());
    const headingAligned =
      destination.heading === undefined || Math.abs(wrapAngle(this.currentPose.heading - destination.heading)) <= 0.35;
    return remaining <= tolerance && remaining >= -tolerance * 0.5 && this.speedValue < 3 && headingAligned;
  }

  private intentionForTurn(turn: TrafficLane['turn']): TrafficIntention {
    if (turn === 'left') return 'Turn Left';
    if (turn === 'right') return 'Turn Right';
    return 'Go Straight';
  }

  private currentLane(): TrafficLane | null {
    return this.route[this.routeIndex] ?? null;
  }

  /** The final occurrence of the exact destination lane in a looped route. */
  private destinationRouteIndex(): number {
    const destination = this.destinationValue;
    if (!destination) return -1;
    for (let index = this.route.length - 1; index >= this.routeIndex; index -= 1) {
      if (this.route[index]?.id === destination.laneId) return index;
    }
    return -1;
  }

  /** Build the shortest complete directed cycle back to an exact lane stop. */
  private buildDestinationLoop(start: TrafficLane, targetLaneId: string): TrafficLane[] | null {
    const destination = this.destinationValue;
    if (!destination || destination.purpose === 'ambient') return null;
    let selected: TrafficLane[] | null = null;
    let selectedDistance = Infinity;
    for (const connectionId of start.connectionIds) {
      const returnRoute = this.context.network.findCompleteRoute(connectionId, targetLaneId);
      if (!returnRoute || returnRoute.length === 0 || returnRoute[returnRoute.length - 1]?.id !== targetLaneId) {
        continue;
      }
      const candidate = [start, ...returnRoute];
      let distance = Math.max(0, start.spline.length - this.laneDistance);
      for (let index = 1; index < candidate.length; index += 1) {
        const lane = candidate[index];
        if (!lane) continue;
        distance += index === candidate.length - 1
          ? this.destinationLaneDistance(destination, lane)
          : lane.spline.length;
      }
      if (distance < selectedDistance) {
        selected = candidate;
        selectedDistance = distance;
      }
    }
    return selected;
  }

  private nextLane(): TrafficLane | null {
    return this.route[this.routeIndex + 1] ?? null;
  }

  private isMainHighwayLane(lane: TrafficLane | null): boolean {
    if (!lane?.roadSegmentId) return false;
    return this.context.network.road(lane.roadSegmentId)?.highwayComponent === 'carriageway';
  }

  private isEngineeredHighwayLane(lane: TrafficLane | null): boolean {
    if (!lane?.roadSegmentId) return false;
    return this.context.network.road(lane.roadSegmentId)?.highwayComponent !== undefined;
  }
}

function closerObstacle(
  current: PredictedObstacle | null,
  candidate: PredictedObstacle,
): PredictedObstacle | null {
  return candidate.distance < (current?.distance ?? Infinity) ? candidate : current;
}
