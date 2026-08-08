import { mobileControlSizes, sampleJoystick, type MutableAxisSample } from '@/ui/mobile/MobileControlMath';

const failures: string[] = [];
let assertions = 0;
const sample: MutableAxisSample = { x: 0, y: 0, magnitude: 0, knobX: 0, knobY: 0 };

function check(condition: boolean, message: string): void {
  assertions += 1;
  if (!condition) failures.push(message);
}

sampleJoystick(8, 5, 100, 0.16, false, sample);
check(sample.magnitude === 0, 'touches inside the dead zone must remain neutral');

sampleJoystick(100, 0, 100, 0.16, false, sample);
check(Math.abs(sample.x - 1) < 1e-9 && sample.y === 0, 'full-right must normalize to (1, 0)');

sampleJoystick(100, 100, 100, 0.16, false, sample);
check(Math.abs(Math.hypot(sample.x, sample.y) - 1) < 1e-9, 'diagonal output must be unit normalized');
check(Math.hypot(sample.knobX, sample.knobY) <= 100.0001, 'joystick knob must remain inside its base');

sampleJoystick(-70, 80, 100, 0.16, true, sample);
check(sample.x < 0 && sample.y === 0 && sample.knobY === 0, 'vehicle steering must ignore vertical drag');

for (const height of [720, 900, 1080, 1170]) {
  const sizes = mobileControlSizes(height, 1, 1);
  check(sizes.joystickRadius >= 92 && sizes.joystickRadius <= 116, `joystick size out of bounds at ${height}`);
  check(sizes.button >= 88 && sizes.button <= 102, `button size out of bounds at ${height}`);
  check(sizes.smallButton >= 78 && sizes.smallButton <= 88, `small button size out of bounds at ${height}`);
}

const small = mobileControlSizes(720, 0.8, 0.8);
const large = mobileControlSizes(720, 1.25, 1.25);
check(small.button < large.button, 'control scale must change action-button size');
check(small.joystickRadius < large.joystickRadius, 'joystick scale must change joystick size');

if (failures.length > 0) {
  console.error(`Mobile controls validation FAILED (${failures.length} failures / ${assertions} checks)`);
  for (const failure of failures) console.error(` - ${failure}`);
  process.exitCode = 1;
} else {
  console.log('Mobile controls validation PASSED');
  console.log(`  ${assertions} joystick, dead-zone, normalization, steering, and scaling checks`);
}
