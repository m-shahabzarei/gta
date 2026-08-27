import type { VehicleObbPose } from './VehicleCollisionGeometry';

export interface VehicleWorldSafetyQuery {
  isSolidAtWorld(x: number, y: number): boolean;
  isDrivableAtWorld(x: number, y: number): boolean;
}

export interface VehicleWorldClampResult {
  appliedX: number;
  appliedY: number;
  fraction: number;
  normalX: number;
  normalY: number;
  blocked: boolean;
}

/**
 * Dynamic Arcade vehicles need only the solid raster because Arcade owns their
 * tile response. Traffic must keep its complete footprint on road terrain.
 * Parked vehicles keep their centerline on road terrain while tolerating legal
 * curb overlap at the corners of an existing parking bay.
 */
export type VehicleWorldSafetyPolicy =
  | 'solid-only'
  | 'drivable-footprint'
  | 'parked-centerline';

const CANDIDATE_POSE: VehicleObbPose = {
  x: 0,
  y: 0,
  heading: 0,
  halfWidth: 0,
  halfLength: 0,
};

export function createWorldClampResult(): VehicleWorldClampResult {
  return { appliedX: 0, appliedY: 0, fraction: 1, normalX: 0, normalY: 0, blocked: false };
}

function sampleAllowed(
  world: VehicleWorldSafetyQuery,
  x: number,
  y: number,
  requireDrivable: boolean,
): boolean {
  return !world.isSolidAtWorld(x, y) && (!requireDrivable || world.isDrivableAtWorld(x, y));
}

function normalizePolicy(
  policy: VehicleWorldSafetyPolicy | boolean,
): VehicleWorldSafetyPolicy {
  if (typeof policy === 'boolean') return policy ? 'drivable-footprint' : 'solid-only';
  return policy;
}

/** Validate center, corners and edge midpoints of an oriented vehicle footprint. */
export function isVehiclePoseSafe(
  world: VehicleWorldSafetyQuery,
  pose: VehicleObbPose,
  policy: VehicleWorldSafetyPolicy | boolean,
): boolean {
  const normalizedPolicy = normalizePolicy(policy);
  const centerlineDrivable = normalizedPolicy !== 'solid-only';
  const completeFootprintDrivable = normalizedPolicy === 'drivable-footprint';
  const forwardX = Math.cos(pose.heading);
  const forwardY = Math.sin(pose.heading);
  const rightX = -forwardY;
  const rightY = forwardX;
  if (!sampleAllowed(world, pose.x, pose.y, centerlineDrivable)) return false;
  for (let forwardSign = -1; forwardSign <= 1; forwardSign += 2) {
    const forwardOffsetX = forwardX * pose.halfLength * forwardSign;
    const forwardOffsetY = forwardY * pose.halfLength * forwardSign;
    if (
      !sampleAllowed(
        world,
        pose.x + forwardOffsetX,
        pose.y + forwardOffsetY,
        centerlineDrivable,
      )
    ) {
      return false;
    }
    for (let rightSign = -1; rightSign <= 1; rightSign += 2) {
      if (
        !sampleAllowed(
          world,
          pose.x + forwardOffsetX + rightX * pose.halfWidth * rightSign,
          pose.y + forwardOffsetY + rightY * pose.halfWidth * rightSign,
          completeFootprintDrivable,
        )
      ) {
        return false;
      }
    }
  }
  for (let rightSign = -1; rightSign <= 1; rightSign += 2) {
    if (
      !sampleAllowed(
        world,
        pose.x + rightX * pose.halfWidth * rightSign,
        pose.y + rightY * pose.halfWidth * rightSign,
        completeFootprintDrivable,
      )
    ) {
      return false;
    }
  }
  return true;
}

function candidateFrom(
  pose: VehicleObbPose,
  dx: number,
  dy: number,
  fraction: number,
): VehicleObbPose {
  const candidate = CANDIDATE_POSE;
  candidate.x = pose.x + dx * fraction;
  candidate.y = pose.y + dy * fraction;
  candidate.heading = pose.heading;
  candidate.halfWidth = pose.halfWidth;
  candidate.halfLength = pose.halfLength;
  return candidate;
}

/** Deterministically shorten an impact translation to the last safe OBB pose. */
export function clampVehicleTranslation(
  world: VehicleWorldSafetyQuery,
  pose: VehicleObbPose,
  dx: number,
  dy: number,
  policy: VehicleWorldSafetyPolicy | boolean,
  binarySteps: number,
  out: VehicleWorldClampResult,
): void {
  out.appliedX = dx;
  out.appliedY = dy;
  out.fraction = 1;
  out.normalX = 0;
  out.normalY = 0;
  out.blocked = false;
  if (dx * dx + dy * dy <= 1e-12) return;
  if (isVehiclePoseSafe(world, candidateFrom(pose, dx, dy, 1), policy)) return;

  let safe = 0;
  let blocked = 1;
  for (let index = 0; index < binarySteps; index += 1) {
    const midpoint = (safe + blocked) * 0.5;
    if (isVehiclePoseSafe(world, candidateFrom(pose, dx, dy, midpoint), policy)) {
      safe = midpoint;
    } else {
      blocked = midpoint;
    }
  }
  out.fraction = safe;
  out.appliedX = dx * safe;
  out.appliedY = dy * safe;
  out.blocked = true;

  const xBlocked =
    Math.abs(dx) > 1e-8 &&
    !isVehiclePoseSafe(world, candidateFrom(pose, dx, 0, 1), policy);
  const yBlocked =
    Math.abs(dy) > 1e-8 &&
    !isVehiclePoseSafe(world, candidateFrom(pose, 0, dy, 1), policy);
  if (xBlocked) out.normalX = -Math.sign(dx);
  if (yBlocked) out.normalY = -Math.sign(dy);
  if (!xBlocked && !yBlocked) {
    const length = Math.hypot(dx, dy);
    out.normalX = -dx / length;
    out.normalY = -dy / length;
  } else if (xBlocked && yBlocked) {
    const length = Math.hypot(out.normalX, out.normalY);
    out.normalX /= length;
    out.normalY /= length;
  }
}

/** Remove only velocity directed into the blocking surface and preserve its tangent. */
export function removeVelocityIntoWorld(
  velocity: { x: number; y: number },
  normalX: number,
  normalY: number,
): void {
  const intoSurface = velocity.x * normalX + velocity.y * normalY;
  if (intoSurface >= 0) return;
  velocity.x -= normalX * intoSurface;
  velocity.y -= normalY * intoSurface;
}
