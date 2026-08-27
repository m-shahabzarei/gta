const GEOMETRY_EPSILON = 1e-8;

/** Single-threaded runtime scratch; allocated once rather than once per swept candidate. */
const SWEPT_CONTACT_FIRST: VehicleObbPose = {
  x: 0,
  y: 0,
  heading: 0,
  halfWidth: 0,
  halfLength: 0,
};
const SWEPT_CONTACT_SECOND: VehicleObbPose = {
  x: 0,
  y: 0,
  heading: 0,
  halfWidth: 0,
  halfLength: 0,
};

/** Center pose and half-extents for a vehicle OBB. Heading points along its long axis. */
export interface VehicleObbPose {
  x: number;
  y: number;
  heading: number;
  halfWidth: number;
  halfLength: number;
}

export interface VehicleSweptBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Reusable narrow-phase result. The normal always points from A to B. */
export interface VehicleContact {
  normalX: number;
  normalY: number;
  pointX: number;
  pointY: number;
  penetration: number;
  timeOfImpact: number;
  swept: boolean;
}

export function createVehicleContact(): VehicleContact {
  return {
    normalX: 0,
    normalY: 0,
    pointX: 0,
    pointY: 0,
    penetration: 0,
    timeOfImpact: 1,
    swept: false,
  };
}

function projectionRadius(
  axisX: number,
  axisY: number,
  forwardX: number,
  forwardY: number,
  rightX: number,
  rightY: number,
  halfWidth: number,
  halfLength: number,
): number {
  return (
    halfLength * Math.abs(axisX * forwardX + axisY * forwardY) +
    halfWidth * Math.abs(axisX * rightX + axisY * rightY)
  );
}

function supportPointX(
  pose: VehicleObbPose,
  forwardX: number,
  forwardY: number,
  rightX: number,
  rightY: number,
  directionX: number,
  directionY: number,
): number {
  const forwardSign = Math.sign(directionX * forwardX + directionY * forwardY);
  const rightSign = Math.sign(directionX * rightX + directionY * rightY);
  return pose.x + forwardX * forwardSign * pose.halfLength + rightX * rightSign * pose.halfWidth;
}

function supportPointY(
  pose: VehicleObbPose,
  forwardX: number,
  forwardY: number,
  rightX: number,
  rightY: number,
  directionX: number,
  directionY: number,
): number {
  const forwardSign = Math.sign(directionX * forwardX + directionY * forwardY);
  const rightSign = Math.sign(directionX * rightX + directionY * rightY);
  return pose.y + forwardY * forwardSign * pose.halfLength + rightY * rightSign * pose.halfWidth;
}

/** Four-axis SAT for two oriented vehicle rectangles. */
export function computeObbContact(
  first: VehicleObbPose,
  second: VehicleObbPose,
  out: VehicleContact,
): boolean {
  const firstForwardX = Math.cos(first.heading);
  const firstForwardY = Math.sin(first.heading);
  const firstRightX = -firstForwardY;
  const firstRightY = firstForwardX;
  const secondForwardX = Math.cos(second.heading);
  const secondForwardY = Math.sin(second.heading);
  const secondRightX = -secondForwardY;
  const secondRightY = secondForwardX;
  const centerX = second.x - first.x;
  const centerY = second.y - first.y;
  let minimumOverlap = Infinity;
  let normalX = 0;
  let normalY = 0;

  for (let axisIndex = 0; axisIndex < 4; axisIndex += 1) {
    let axisX: number;
    let axisY: number;
    if (axisIndex === 0) {
      axisX = firstForwardX;
      axisY = firstForwardY;
    } else if (axisIndex === 1) {
      axisX = firstRightX;
      axisY = firstRightY;
    } else if (axisIndex === 2) {
      axisX = secondForwardX;
      axisY = secondForwardY;
    } else {
      axisX = secondRightX;
      axisY = secondRightY;
    }
    const firstRadius = projectionRadius(
      axisX,
      axisY,
      firstForwardX,
      firstForwardY,
      firstRightX,
      firstRightY,
      first.halfWidth,
      first.halfLength,
    );
    const secondRadius = projectionRadius(
      axisX,
      axisY,
      secondForwardX,
      secondForwardY,
      secondRightX,
      secondRightY,
      second.halfWidth,
      second.halfLength,
    );
    const signedDistance = centerX * axisX + centerY * axisY;
    const overlap = firstRadius + secondRadius - Math.abs(signedDistance);
    if (overlap <= GEOMETRY_EPSILON) return false;
    if (overlap < minimumOverlap) {
      minimumOverlap = overlap;
      const direction = signedDistance < 0 ? -1 : 1;
      normalX = axisX * direction;
      normalY = axisY * direction;
    }
  }

  const firstSupportX = supportPointX(
    first,
    firstForwardX,
    firstForwardY,
    firstRightX,
    firstRightY,
    normalX,
    normalY,
  );
  const firstSupportY = supportPointY(
    first,
    firstForwardX,
    firstForwardY,
    firstRightX,
    firstRightY,
    normalX,
    normalY,
  );
  const secondSupportX = supportPointX(
    second,
    secondForwardX,
    secondForwardY,
    secondRightX,
    secondRightY,
    -normalX,
    -normalY,
  );
  const secondSupportY = supportPointY(
    second,
    secondForwardX,
    secondForwardY,
    secondRightX,
    secondRightY,
    -normalX,
    -normalY,
  );
  out.normalX = normalX;
  out.normalY = normalY;
  out.pointX = (firstSupportX + secondSupportX) * 0.5;
  out.pointY = (firstSupportY + secondSupportY) * 0.5;
  out.penetration = minimumOverlap;
  out.timeOfImpact = 1;
  out.swept = false;
  return true;
}

function wrappedAngleDelta(from: number, to: number): number {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  else if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

/**
 * Continuous SAT for linearly translated OBBs. Axes use the current orientation;
 * heading is interpolated only for the final contact point. This catches a fast
 * vehicle crossing another between fixed poses without sub-stepping every pair.
 */
export function computeSweptObbContact(
  previousFirst: VehicleObbPose,
  currentFirst: VehicleObbPose,
  previousSecond: VehicleObbPose,
  currentSecond: VehicleObbPose,
  out: VehicleContact,
): boolean {
  if (computeObbContact(currentFirst, currentSecond, out)) return true;

  const firstForwardX = Math.cos(currentFirst.heading);
  const firstForwardY = Math.sin(currentFirst.heading);
  const firstRightX = -firstForwardY;
  const firstRightY = firstForwardX;
  const secondForwardX = Math.cos(currentSecond.heading);
  const secondForwardY = Math.sin(currentSecond.heading);
  const secondRightX = -secondForwardY;
  const secondRightY = secondForwardX;
  const startCenterX = previousSecond.x - previousFirst.x;
  const startCenterY = previousSecond.y - previousFirst.y;
  const relativeDeltaX =
    currentSecond.x - previousSecond.x - (currentFirst.x - previousFirst.x);
  const relativeDeltaY =
    currentSecond.y - previousSecond.y - (currentFirst.y - previousFirst.y);
  let globalEnter = 0;
  let globalExit = 1;
  let hitAxisX = 0;
  let hitAxisY = 0;

  for (let axisIndex = 0; axisIndex < 4; axisIndex += 1) {
    let axisX: number;
    let axisY: number;
    if (axisIndex === 0) {
      axisX = firstForwardX;
      axisY = firstForwardY;
    } else if (axisIndex === 1) {
      axisX = firstRightX;
      axisY = firstRightY;
    } else if (axisIndex === 2) {
      axisX = secondForwardX;
      axisY = secondForwardY;
    } else {
      axisX = secondRightX;
      axisY = secondRightY;
    }
    const radius =
      projectionRadius(
        axisX,
        axisY,
        firstForwardX,
        firstForwardY,
        firstRightX,
        firstRightY,
        currentFirst.halfWidth,
        currentFirst.halfLength,
      ) +
      projectionRadius(
        axisX,
        axisY,
        secondForwardX,
        secondForwardY,
        secondRightX,
        secondRightY,
        currentSecond.halfWidth,
        currentSecond.halfLength,
      );
    const startDistance = startCenterX * axisX + startCenterY * axisY;
    const deltaDistance = relativeDeltaX * axisX + relativeDeltaY * axisY;
    if (Math.abs(deltaDistance) <= GEOMETRY_EPSILON) {
      if (Math.abs(startDistance) > radius) return false;
      continue;
    }
    const firstTime = (-radius - startDistance) / deltaDistance;
    const secondTime = (radius - startDistance) / deltaDistance;
    const axisEnter = Math.min(firstTime, secondTime);
    const axisExit = Math.max(firstTime, secondTime);
    if (axisEnter > globalEnter) {
      globalEnter = axisEnter;
      hitAxisX = axisX;
      hitAxisY = axisY;
    }
    globalExit = Math.min(globalExit, axisExit);
    if (globalEnter - globalExit > GEOMETRY_EPSILON) return false;
  }

  if (globalExit < 0 || globalEnter < 0 || globalEnter > 1) return false;
  const contactTime = Math.max(0, Math.min(1, globalEnter));
  const firstX = previousFirst.x + (currentFirst.x - previousFirst.x) * contactTime;
  const firstY = previousFirst.y + (currentFirst.y - previousFirst.y) * contactTime;
  const secondX = previousSecond.x + (currentSecond.x - previousSecond.x) * contactTime;
  const secondY = previousSecond.y + (currentSecond.y - previousSecond.y) * contactTime;
  const signedDistance =
    (secondX - firstX) * hitAxisX + (secondY - firstY) * hitAxisY;
  const direction = signedDistance < 0 ? -1 : 1;
  const normalX = hitAxisX * direction;
  const normalY = hitAxisY * direction;
  const firstHeading =
    previousFirst.heading +
    wrappedAngleDelta(previousFirst.heading, currentFirst.heading) * contactTime;
  const secondHeading =
    previousSecond.heading +
    wrappedAngleDelta(previousSecond.heading, currentSecond.heading) * contactTime;
  const contactFirst = SWEPT_CONTACT_FIRST;
  contactFirst.x = firstX;
  contactFirst.y = firstY;
  contactFirst.heading = firstHeading;
  contactFirst.halfWidth = currentFirst.halfWidth;
  contactFirst.halfLength = currentFirst.halfLength;
  const contactSecond = SWEPT_CONTACT_SECOND;
  contactSecond.x = secondX;
  contactSecond.y = secondY;
  contactSecond.heading = secondHeading;
  contactSecond.halfWidth = currentSecond.halfWidth;
  contactSecond.halfLength = currentSecond.halfLength;
  const contactFirstForwardX = Math.cos(firstHeading);
  const contactFirstForwardY = Math.sin(firstHeading);
  const contactFirstRightX = -contactFirstForwardY;
  const contactFirstRightY = contactFirstForwardX;
  const contactSecondForwardX = Math.cos(secondHeading);
  const contactSecondForwardY = Math.sin(secondHeading);
  const contactSecondRightX = -contactSecondForwardY;
  const contactSecondRightY = contactSecondForwardX;
  out.normalX = normalX;
  out.normalY = normalY;
  out.pointX =
    (supportPointX(
      contactFirst,
      contactFirstForwardX,
      contactFirstForwardY,
      contactFirstRightX,
      contactFirstRightY,
      normalX,
      normalY,
    ) +
      supportPointX(
        contactSecond,
        contactSecondForwardX,
        contactSecondForwardY,
        contactSecondRightX,
        contactSecondRightY,
        -normalX,
        -normalY,
      )) *
    0.5;
  out.pointY =
    (supportPointY(
      contactFirst,
      contactFirstForwardX,
      contactFirstForwardY,
      contactFirstRightX,
      contactFirstRightY,
      normalX,
      normalY,
    ) +
      supportPointY(
        contactSecond,
        contactSecondForwardX,
        contactSecondForwardY,
        contactSecondRightX,
        contactSecondRightY,
        -normalX,
        -normalY,
      )) *
    0.5;
  out.penetration = 0;
  out.timeOfImpact = contactTime;
  out.swept = true;
  return true;
}

/** Axis-aligned bounds containing both previous and current oriented footprints. */
export function computeSweptBounds(
  previous: VehicleObbPose,
  current: VehicleObbPose,
  out: VehicleSweptBounds,
): void {
  const previousForwardX = Math.cos(previous.heading);
  const previousForwardY = Math.sin(previous.heading);
  const currentForwardX = Math.cos(current.heading);
  const currentForwardY = Math.sin(current.heading);
  const previousExtentX =
    Math.abs(previousForwardX) * previous.halfLength +
    Math.abs(previousForwardY) * previous.halfWidth;
  const previousExtentY =
    Math.abs(previousForwardY) * previous.halfLength +
    Math.abs(previousForwardX) * previous.halfWidth;
  const currentExtentX =
    Math.abs(currentForwardX) * current.halfLength +
    Math.abs(currentForwardY) * current.halfWidth;
  const currentExtentY =
    Math.abs(currentForwardY) * current.halfLength +
    Math.abs(currentForwardX) * current.halfWidth;
  out.minX = Math.min(previous.x - previousExtentX, current.x - currentExtentX);
  out.minY = Math.min(previous.y - previousExtentY, current.y - currentExtentY);
  out.maxX = Math.max(previous.x + previousExtentX, current.x + currentExtentX);
  out.maxY = Math.max(previous.y + previousExtentY, current.y + currentExtentY);
}
