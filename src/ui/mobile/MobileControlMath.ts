export interface MutableAxisSample {
  x: number;
  y: number;
  magnitude: number;
  knobX: number;
  knobY: number;
}

/** Allocation-free radial dead-zone mapping used by every joystick pointer move. */
export function sampleJoystick(
  dx: number,
  dy: number,
  radius: number,
  deadZone: number,
  steeringOnly: boolean,
  out: MutableAxisSample,
): void {
  const safeRadius = Math.max(1, radius);
  const sourceY = steeringOnly ? 0 : dy;
  const distance = Math.hypot(dx, sourceY);
  const clampedDistance = Math.min(distance, safeRadius);
  const nx = distance > 0 ? dx / distance : 0;
  const ny = distance > 0 ? sourceY / distance : 0;
  const rawMagnitude = clampedDistance / safeRadius;
  const zone = Math.min(0.9, Math.max(0, deadZone));
  const magnitude = rawMagnitude <= zone ? 0 : (rawMagnitude - zone) / (1 - zone);

  out.x = nx * magnitude;
  out.y = steeringOnly ? 0 : ny * magnitude;
  out.magnitude = magnitude;
  out.knobX = nx * clampedDistance;
  out.knobY = ny * clampedDistance;
}

export interface MobileControlSizes {
  joystickRadius: number;
  button: number;
  smallButton: number;
}

/** Responsive logical sizes; called only when the canvas layout changes. */
export function mobileControlSizes(
  height: number,
  controlScale: number,
  joystickScale: number,
): MobileControlSizes {
  const clamp = (value: number, min: number, max: number): number =>
    Math.min(max, Math.max(min, value));
  return {
    joystickRadius: clamp(height * 0.155, 92, 116) * joystickScale,
    button: clamp(height * 0.13, 88, 102) * controlScale,
    smallButton: clamp(height * 0.112, 78, 88) * controlScale,
  };
}
