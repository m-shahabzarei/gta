import type { VehiclePhysicsDef } from './VehicleDynamicsTypes';
import type { VehicleContact } from './VehicleCollisionGeometry';

export interface VehicleSolverBodyInput {
  x: number;
  y: number;
  heading: number;
  velocityX: number;
  velocityY: number;
  angularVelocity: number;
  halfWidth: number;
  halfLength: number;
  physics: VehiclePhysicsDef;
}

/** Mutable solver body; the runtime reuses one slot per active vehicle. */
export interface VehicleSolverBody extends VehicleSolverBodyInput {
  inverseMass: number;
  inverseInertia: number;
}

export interface VehicleSolverTuning {
  readonly RESTITUTION_MAX: number;
  readonly FRICTION_MAX: number;
  readonly PENETRATION_SLOP: number;
  readonly POSITION_CORRECTION_PERCENT: number;
  readonly MAX_POSITION_CORRECTION: number;
  readonly MIN_EVENT_IMPULSE: number;
  readonly DAMAGE_ENERGY_THRESHOLD: number;
  readonly DAMAGE_ENERGY_SCALE: number;
}

export interface VehicleSolverOptions {
  readonly restitutionEnabled?: boolean;
}

export interface VehicleSolverResult {
  impulseApplied: boolean;
  impactful: boolean;
  normalImpulse: number;
  tangentImpulse: number;
  impulseX: number;
  impulseY: number;
  closingSpeed: number;
  relativeVelocityX: number;
  relativeVelocityY: number;
  impactEnergy: number;
  positionCorrection: number;
}

export interface VehicleDamageResult {
  damageToFirst: number;
  damageToSecond: number;
}

export function createSolverBody(input: VehicleSolverBodyInput): VehicleSolverBody {
  return {
    ...input,
    inverseMass: input.physics.mass > 0 ? 1 / input.physics.mass : 0,
    inverseInertia:
      input.physics.rotationalInertia > 0 ? 1 / input.physics.rotationalInertia : 0,
  };
}

export function createSolverResult(): VehicleSolverResult {
  return {
    impulseApplied: false,
    impactful: false,
    normalImpulse: 0,
    tangentImpulse: 0,
    impulseX: 0,
    impulseY: 0,
    closingSpeed: 0,
    relativeVelocityX: 0,
    relativeVelocityY: 0,
    impactEnergy: 0,
    positionCorrection: 0,
  };
}

export function isCollisionPairInCooldown(
  now: number,
  lastImpactAt: number,
  cooldownMs: number,
): boolean {
  return now - lastImpactAt < cooldownMs;
}

function cross(x: number, y: number, otherX: number, otherY: number): number {
  return x * otherY - y * otherX;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function resetResult(out: VehicleSolverResult): void {
  out.impulseApplied = false;
  out.impactful = false;
  out.normalImpulse = 0;
  out.tangentImpulse = 0;
  out.impulseX = 0;
  out.impulseY = 0;
  out.closingSpeed = 0;
  out.relativeVelocityX = 0;
  out.relativeVelocityY = 0;
  out.impactEnergy = 0;
  out.positionCorrection = 0;
}

/** Apply a signed impulse to both bodies using the A-to-B normal convention. */
function applyImpulse(
  first: VehicleSolverBody,
  second: VehicleSolverBody,
  radiusFirstX: number,
  radiusFirstY: number,
  radiusSecondX: number,
  radiusSecondY: number,
  impulseX: number,
  impulseY: number,
): void {
  first.velocityX -= impulseX * first.inverseMass;
  first.velocityY -= impulseY * first.inverseMass;
  second.velocityX += impulseX * second.inverseMass;
  second.velocityY += impulseY * second.inverseMass;
  first.angularVelocity -= cross(radiusFirstX, radiusFirstY, impulseX, impulseY) * first.inverseInertia;
  second.angularVelocity += cross(radiusSecondX, radiusSecondY, impulseX, impulseY) * second.inverseInertia;
}

/**
 * Resolve one contact. Normal impulse is skipped for separating bodies, while
 * bounded positional correction remains active to drain persistent overlap.
 */
export function resolveVehicleContact(
  first: VehicleSolverBody,
  second: VehicleSolverBody,
  contact: VehicleContact,
  tuning: VehicleSolverTuning,
  out: VehicleSolverResult,
  options: VehicleSolverOptions = {},
): boolean {
  resetResult(out);
  const radiusFirstX = contact.pointX - first.x;
  const radiusFirstY = contact.pointY - first.y;
  const radiusSecondX = contact.pointX - second.x;
  const radiusSecondY = contact.pointY - second.y;
  const contactVelocityFirstX = first.velocityX - first.angularVelocity * radiusFirstY;
  const contactVelocityFirstY = first.velocityY + first.angularVelocity * radiusFirstX;
  const contactVelocitySecondX = second.velocityX - second.angularVelocity * radiusSecondY;
  const contactVelocitySecondY = second.velocityY + second.angularVelocity * radiusSecondX;
  let relativeX = contactVelocitySecondX - contactVelocityFirstX;
  let relativeY = contactVelocitySecondY - contactVelocityFirstY;
  const velocityAlongNormal = relativeX * contact.normalX + relativeY * contact.normalY;
  const closingSpeed = Math.max(0, -velocityAlongNormal);
  const reducedMass =
    first.physics.mass + second.physics.mass > 0
      ? (first.physics.mass * second.physics.mass) /
        (first.physics.mass + second.physics.mass)
      : 0;
  out.relativeVelocityX = relativeX;
  out.relativeVelocityY = relativeY;
  out.closingSpeed = closingSpeed;
  out.impactEnergy = 0.5 * reducedMass * closingSpeed * closingSpeed;

  if (velocityAlongNormal < 0) {
    const firstNormalRadius = cross(radiusFirstX, radiusFirstY, contact.normalX, contact.normalY);
    const secondNormalRadius = cross(
      radiusSecondX,
      radiusSecondY,
      contact.normalX,
      contact.normalY,
    );
    const effectiveNormalMass =
      first.inverseMass +
      second.inverseMass +
      firstNormalRadius * firstNormalRadius * first.inverseInertia +
      secondNormalRadius * secondNormalRadius * second.inverseInertia;
    if (effectiveNormalMass > 1e-12) {
      const minimumImpactSpeed = Math.max(
        first.physics.minimumImpactSpeed,
        second.physics.minimumImpactSpeed,
      );
      const impactfulSpeed = closingSpeed >= minimumImpactSpeed;
      const restitution =
        impactfulSpeed && options.restitutionEnabled !== false
          ? clamp(
              Math.min(first.physics.restitution, second.physics.restitution),
              0,
              tuning.RESTITUTION_MAX,
            )
          : 0;
      const maximumImpulse = Math.min(
        first.physics.maximumCollisionImpulse,
        second.physics.maximumCollisionImpulse,
      );
      const normalImpulse = Math.min(
        maximumImpulse,
        (-(1 + restitution) * velocityAlongNormal) / effectiveNormalMass,
      );
      const normalImpulseX = contact.normalX * normalImpulse;
      const normalImpulseY = contact.normalY * normalImpulse;
      applyImpulse(
        first,
        second,
        radiusFirstX,
        radiusFirstY,
        radiusSecondX,
        radiusSecondY,
        normalImpulseX,
        normalImpulseY,
      );
      out.impulseApplied = normalImpulse > 0;
      out.normalImpulse = normalImpulse;

      const updatedFirstX = first.velocityX - first.angularVelocity * radiusFirstY;
      const updatedFirstY = first.velocityY + first.angularVelocity * radiusFirstX;
      const updatedSecondX = second.velocityX - second.angularVelocity * radiusSecondY;
      const updatedSecondY = second.velocityY + second.angularVelocity * radiusSecondX;
      relativeX = updatedSecondX - updatedFirstX;
      relativeY = updatedSecondY - updatedFirstY;
      const updatedNormal = relativeX * contact.normalX + relativeY * contact.normalY;
      let tangentX = relativeX - updatedNormal * contact.normalX;
      let tangentY = relativeY - updatedNormal * contact.normalY;
      const tangentLength = Math.hypot(tangentX, tangentY);
      if (tangentLength > 1e-8 && normalImpulse > 0) {
        tangentX /= tangentLength;
        tangentY /= tangentLength;
        const firstTangentRadius = cross(radiusFirstX, radiusFirstY, tangentX, tangentY);
        const secondTangentRadius = cross(radiusSecondX, radiusSecondY, tangentX, tangentY);
        const effectiveTangentMass =
          first.inverseMass +
          second.inverseMass +
          firstTangentRadius * firstTangentRadius * first.inverseInertia +
          secondTangentRadius * secondTangentRadius * second.inverseInertia;
        if (effectiveTangentMass > 1e-12) {
          const tangentSpeed = relativeX * tangentX + relativeY * tangentY;
          const friction = clamp(
            Math.sqrt(first.physics.tireFriction * second.physics.tireFriction),
            0,
            tuning.FRICTION_MAX,
          );
          const tangentLimit = friction * normalImpulse;
          const tangentImpulse = clamp(
            -tangentSpeed / effectiveTangentMass,
            -tangentLimit,
            tangentLimit,
          );
          const tangentImpulseX = tangentX * tangentImpulse;
          const tangentImpulseY = tangentY * tangentImpulse;
          applyImpulse(
            first,
            second,
            radiusFirstX,
            radiusFirstY,
            radiusSecondX,
            radiusSecondY,
            tangentImpulseX,
            tangentImpulseY,
          );
          out.tangentImpulse = tangentImpulse;
          out.impulseX = normalImpulseX + tangentImpulseX;
          out.impulseY = normalImpulseY + tangentImpulseY;
        } else {
          out.impulseX = normalImpulseX;
          out.impulseY = normalImpulseY;
        }
      } else {
        out.impulseX = normalImpulseX;
        out.impulseY = normalImpulseY;
      }
      out.impactful =
        impactfulSpeed && normalImpulse >= tuning.MIN_EVENT_IMPULSE;
    }
  }

  const inverseMassSum = first.inverseMass + second.inverseMass;
  if (contact.penetration > tuning.PENETRATION_SLOP && inverseMassSum > 1e-12) {
    const correction = Math.min(
      tuning.MAX_POSITION_CORRECTION,
      (contact.penetration - tuning.PENETRATION_SLOP) * tuning.POSITION_CORRECTION_PERCENT,
    );
    const firstShare = first.inverseMass / inverseMassSum;
    const secondShare = second.inverseMass / inverseMassSum;
    first.x -= contact.normalX * correction * firstShare;
    first.y -= contact.normalY * correction * firstShare;
    second.x += contact.normalX * correction * secondShare;
    second.y += contact.normalY * correction * secondShare;
    out.positionCorrection = correction;
  }

  first.angularVelocity = clamp(
    first.angularVelocity,
    -first.physics.maximumAngularVelocity,
    first.physics.maximumAngularVelocity,
  );
  second.angularVelocity = clamp(
    second.angularVelocity,
    -second.physics.maximumAngularVelocity,
    second.physics.maximumAngularVelocity,
  );
  return out.impulseApplied || out.positionCorrection > 0;
}

/** Damage shares favor the lighter target when masses differ. */
export function computeImpactDamage(
  first: VehicleSolverBody,
  second: VehicleSolverBody,
  impactEnergy: number,
  firstDirectionMultiplier: number,
  secondDirectionMultiplier: number,
  tuning: Pick<VehicleSolverTuning, 'DAMAGE_ENERGY_THRESHOLD' | 'DAMAGE_ENERGY_SCALE'>,
  out: VehicleDamageResult,
): void {
  const baseDamage =
    Math.max(0, impactEnergy - tuning.DAMAGE_ENERGY_THRESHOLD) * tuning.DAMAGE_ENERGY_SCALE;
  const totalMass = Math.max(1, first.physics.mass + second.physics.mass);
  out.damageToFirst =
    baseDamage *
    ((second.physics.mass * 2) / totalMass) *
    first.physics.collisionDamageMultiplier *
    firstDirectionMultiplier;
  out.damageToSecond =
    baseDamage *
    ((first.physics.mass * 2) / totalMass) *
    second.physics.collisionDamageMultiplier *
    secondDirectionMultiplier;
}
