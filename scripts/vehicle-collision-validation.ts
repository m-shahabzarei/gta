import { VEHICLE_COLLISION } from '@/config/Constants';
import {
  computeObbContact,
  computeSweptObbContact,
  createVehicleContact,
  type VehicleObbPose,
} from '@/gameplay/vehicle/VehicleCollisionGeometry';
import {
  computeImpactDamage,
  createSolverBody,
  createSolverResult,
  isCollisionPairInCooldown,
  resolveVehicleContact,
  type VehicleSolverBody,
} from '@/gameplay/vehicle/VehicleCollisionSolver';
import type { VehiclePhysicsDef } from '@/gameplay/vehicle/VehicleDynamicsTypes';
import {
  createVehicleDynamicsState,
  resetVehicleDynamicsState,
} from '@/gameplay/vehicle/VehicleDynamicsTypes';
import {
  clampVehicleTranslation,
  createWorldClampResult,
  isVehiclePoseSafe,
  removeVelocityIntoWorld,
} from '@/gameplay/vehicle/VehicleWorldSafety';

const failures: string[] = [];
let assertions = 0;
let tests = 0;

function check(condition: boolean, message: string): void {
  assertions += 1;
  if (!condition) failures.push(message);
}

function close(actual: number, expected: number, tolerance: number, message: string): void {
  check(
    Math.abs(actual - expected) <= tolerance,
    `${message}: expected ${expected} +/- ${tolerance}, received ${actual}`,
  );
}

function test(name: string, run: () => void): void {
  tests += 1;
  const before = failures.length;
  try {
    run();
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (failures.length > before) failures[before] = `${name}: ${failures[before]}`;
}

function physics(mass: number, overrides: Partial<VehiclePhysicsDef> = {}): VehiclePhysicsDef {
  return {
    mass,
    rotationalInertia: mass * 160,
    restitution: 0.1,
    tireFriction: 0.7,
    lateralGrip: 0.8,
    rollingResistance: 1.4,
    lateralDamping: 3,
    angularDamping: 3,
    collisionDamageMultiplier: 1,
    minimumImpactSpeed: 20,
    maximumCollisionImpulse: mass * 500,
    maximumAngularVelocity: 3,
    ...overrides,
  };
}

function pose(
  x: number,
  y: number,
  heading = 0,
  halfWidth = 10,
  halfLength = 20,
): VehicleObbPose {
  return { x, y, heading, halfWidth, halfLength };
}

function body(
  x: number,
  y: number,
  velocityX: number,
  velocityY: number,
  mass = 1000,
  overrides: Partial<VehiclePhysicsDef> = {},
): VehicleSolverBody {
  return createSolverBody({
    x,
    y,
    heading: 0,
    velocityX,
    velocityY,
    angularVelocity: 0,
    halfWidth: 10,
    halfLength: 20,
    physics: physics(mass, overrides),
  });
}

function solve(
  first: VehicleSolverBody,
  second: VehicleSolverBody,
  normalX: number,
  normalY: number,
  contactX = (first.x + second.x) * 0.5,
  contactY = (first.y + second.y) * 0.5,
  penetration = 0,
) {
  const contact = createVehicleContact();
  contact.normalX = normalX;
  contact.normalY = normalY;
  contact.pointX = contactX;
  contact.pointY = contactY;
  contact.penetration = penetration;
  const result = createSolverResult();
  resolveVehicleContact(first, second, contact, VEHICLE_COLLISION, result);
  return result;
}

test('rotated OBB overlap and A-to-B normal', () => {
  const contact = createVehicleContact();
  check(
    computeObbContact(pose(0, 0, Math.PI / 4), pose(22, 22, Math.PI / 4), contact),
    'rotated boxes should overlap',
  );
  check(contact.normalX > 0 && contact.normalY > 0, 'normal must point from A to B');
  check(contact.penetration > 0, 'overlap must report positive penetration');
});

test('partial side overlap chooses lateral normal', () => {
  const contact = createVehicleContact();
  check(computeObbContact(pose(0, 0), pose(0, 16), contact), 'side overlap should contact');
  check(Math.abs(contact.normalY) > 0.99, 'side contact must use the lateral axis');
});

test('separated OBBs do not contact', () => {
  check(
    !computeObbContact(pose(0, 0, 0.35), pose(100, 100, -0.4), createVehicleContact()),
    'separated boxes must not overlap',
  );
});

test('swept high-speed OBB collision has a bounded time of impact', () => {
  const contact = createVehicleContact();
  check(
    computeSweptObbContact(
      pose(-70, 0),
      pose(70, 0),
      pose(0, 0),
      pose(0, 0),
      contact,
    ),
    'fast crossing must not tunnel',
  );
  check(contact.swept, 'crossing contact must be marked swept');
  close(contact.timeOfImpact, 30 / 140, 0.025, 'swept time of impact');
  check(contact.normalX > 0.99, 'swept normal must point A to B');
});

test('equal-mass head-on impact distributes momentum', () => {
  const first = body(-20, 0, 100, 0, 1000, { restitution: 0 });
  const second = body(20, 0, -100, 0, 1000, { restitution: 0 });
  const result = solve(first, second, 1, 0);
  check(result.impulseApplied, 'head-on impact must apply an impulse');
  close(first.velocityX, 0, 0.001, 'first equal-mass velocity');
  close(second.velocityX, 0, 0.001, 'second equal-mass velocity');
});

test('heavy vehicle pushes a light vehicle strongly', () => {
  const heavy = body(-20, 0, 120, 0, 6000);
  const light = body(20, 0, 0, 0, 900);
  solve(heavy, light, 1, 0);
  check(light.velocityX > 100, 'light target should receive most of the speed change');
  check(heavy.velocityX > 80, 'heavy striker should retain substantial momentum');
});

test('light vehicle loses speed against a heavy vehicle', () => {
  const light = body(-20, 0, 120, 0, 900);
  const heavy = body(20, 0, 0, 0, 6000);
  solve(light, heavy, 1, 0);
  check(light.velocityX < 30, 'light striker should lose most forward velocity');
  check(heavy.velocityX < 30, 'heavy target should accelerate less than a light target');
});

test('rear-end collision pushes the lead vehicle forward', () => {
  const rear = body(-20, 0, 140, 0);
  const lead = body(20, 0, 45, 0);
  solve(rear, lead, 1, 0);
  check(rear.velocityX < 140, 'rear vehicle must lose speed');
  check(lead.velocityX > 45, 'lead vehicle must gain forward speed');
});

test('side impact creates lateral velocity', () => {
  const first = body(0, -20, 0, 110);
  const second = body(0, 20, 0, 0);
  solve(first, second, 0, 1);
  check(second.velocityY > 45, 'side target must receive lateral motion');
});

test('glancing impact preserves controlled tangential motion', () => {
  const first = body(-20, 0, 100, 35, 1000, { tireFriction: 0.15 });
  const second = body(20, 0, 0, 0, 1000, { tireFriction: 0.15 });
  solve(first, second, 1, 0);
  check(Math.abs(first.velocityY) > 20, 'low friction should preserve sliding');
  check(Math.abs(first.velocityX) < 70, 'normal momentum must still transfer');
});

test('separating bodies receive no normal impulse', () => {
  const first = body(-20, 0, -20, 0);
  const second = body(20, 0, 20, 0);
  const result = solve(first, second, 1, 0, 0, 0, 2);
  check(!result.impulseApplied, 'separating bodies must not receive an impulse');
  close(first.velocityX, -20, 0.001, 'separating A velocity');
  close(second.velocityX, 20, 0.001, 'separating B velocity');
});

test('below-threshold contact is inelastic and not impactful', () => {
  const first = body(-20, 0, 8, 0, 1000, { restitution: 0.4, minimumImpactSpeed: 20 });
  const second = body(20, 0, 0, 0, 1000, { restitution: 0.4, minimumImpactSpeed: 20 });
  const result = solve(first, second, 1, 0);
  check(result.impulseApplied, 'low-speed constraint should prevent interpenetration');
  check(!result.impactful, 'low-speed contact must not become a crash event');
  close(first.velocityX, second.velocityX, 0.001, 'low-speed inelastic velocities');
});

test('zero restitution does not bounce', () => {
  const first = body(-20, 0, 80, 0, 1000, { restitution: 0 });
  const second = body(20, 0, 0, 0, 1000, { restitution: 0 });
  solve(first, second, 1, 0);
  close(first.velocityX, second.velocityX, 0.001, 'zero restitution shared velocity');
});

test('high restitution is clamped below energy creation', () => {
  const first = body(-20, 0, 100, 0, 1000, { restitution: 4 });
  const second = body(20, 0, 0, 0, 1000, { restitution: 4 });
  solve(first, second, 1, 0);
  const energyAfter = first.velocityX ** 2 + second.velocityX ** 2;
  check(energyAfter <= 10_000 + 0.001, 'clamped restitution must not add kinetic energy');
});

test('friction is Coulomb-clamped', () => {
  const lowA = body(-20, 0, 100, 60, 1000, { tireFriction: 0.05 });
  const lowB = body(20, 0, 0, 0, 1000, { tireFriction: 0.05 });
  solve(lowA, lowB, 1, 0);
  const highA = body(-20, 0, 100, 60, 1000, { tireFriction: 1.2 });
  const highB = body(20, 0, 0, 0, 1000, { tireFriction: 1.2 });
  solve(highA, highB, 1, 0);
  check(
    Math.abs(highA.velocityY - highB.velocityY) < Math.abs(lowA.velocityY - lowB.velocityY),
    'high friction should reduce relative tangent speed more strongly',
  );
});

test('off-center hit produces opposite yaw response', () => {
  const first = body(-20, 0, 100, 0);
  const second = body(20, 0, 0, 0);
  solve(first, second, 1, 0, 0, 9);
  check(Math.abs(first.angularVelocity) > 0.01, 'first body should receive torque');
  check(Math.abs(second.angularVelocity) > 0.01, 'second body should receive torque');
});

test('deep penetration correction is bounded', () => {
  const first = body(-5, 0, 0, 0);
  const second = body(5, 0, 0, 0);
  const result = solve(first, second, 1, 0, 0, 0, 30);
  check(result.positionCorrection > 0, 'deep overlap must be corrected');
  check(
    result.positionCorrection <= VEHICLE_COLLISION.MAX_POSITION_CORRECTION + 0.001,
    'correction must respect the per-step cap',
  );
});

test('three-body chain does not multiply energy', () => {
  const bodies = [body(-40, 0, 100, 0), body(0, 0, 0, 0), body(40, 0, 0, 0)];
  const before = bodies.reduce((sum, item) => sum + item.velocityX ** 2, 0);
  for (let iteration = 0; iteration < VEHICLE_COLLISION.SOLVER_ITERATIONS; iteration += 1) {
    solve(bodies[0]!, bodies[1]!, 1, 0);
    solve(bodies[1]!, bodies[2]!, 1, 0);
  }
  const after = bodies.reduce((sum, item) => sum + item.velocityX ** 2, 0);
  check(after <= before * 1.001, 'chain resolution must not create energy');
  check(bodies[2]!.velocityX > 0, 'last vehicle should receive transferred momentum');
});

test('deterministic replay returns identical floating-point state', () => {
  const replay = (): number[] => {
    const bodies = [body(-40, 0, 130, 8, 1500), body(0, 0, 20, 0, 1500), body(40, 0, 0, 0, 3000)];
    for (let step = 0; step < 8; step += 1) {
      solve(bodies[0]!, bodies[1]!, 1, 0, -20, step % 2 === 0 ? 4 : -4);
      solve(bodies[1]!, bodies[2]!, 1, 0, 20, step % 2 === 0 ? -3 : 3);
    }
    return bodies.flatMap((item) => [item.velocityX, item.velocityY, item.angularVelocity]);
  };
  const first = replay();
  const second = replay();
  for (let index = 0; index < first.length; index += 1) {
    close(first[index]!, second[index]!, 1e-12, `replay component ${index}`);
  }
});

test('pair cooldown has deterministic inclusive boundaries', () => {
  check(
    isCollisionPairInCooldown(1259, 1000, 260),
    'pair must remain cooling down before the boundary',
  );
  check(
    !isCollisionPairInCooldown(1260, 1000, 260),
    'pair cooldown must expire exactly at its configured boundary',
  );
});

test('pool reset clears every mutable impact field and advances generation', () => {
  const state = createVehicleDynamicsState();
  state.poolGeneration = 7;
  state.physicalMode = 'TrafficKinematicWithImpact';
  state.externalVelocity.x = 99;
  state.externalVelocity.y = -44;
  state.lateralVelocity = 31;
  state.angularVelocity = 2;
  state.impactOffset.x = 8;
  state.impactOffset.y = 5;
  state.impactHeadingOffset = 0.4;
  state.impactTimer = 2;
  state.recoveryTimer = 3;
  state.impactState = 'RejoiningLane';
  state.lastContactVehicleId = 88;
  state.lastPairHandle = 123;
  state.pendingCollisionEvent = true;
  state.damageImpulse = 80_000;
  resetVehicleDynamicsState(state, 0.75, true);
  check(state.poolGeneration === 8, 'pool generation must advance');
  check(state.physicalMode === 'ArcadeDynamic', 'physical mode must reset');
  check(
    state.externalVelocity.x === 0 &&
      state.externalVelocity.y === 0 &&
      state.angularVelocity === 0 &&
      state.lateralVelocity === 0,
    'all external motion must reset',
  );
  check(
    state.impactOffset.x === 0 &&
      state.impactOffset.y === 0 &&
      state.impactHeadingOffset === 0,
    'all impact pose state must reset',
  );
  check(
    state.impactState === 'None' &&
      !state.impactRecoveryFailureReported &&
      state.lastContactVehicleId === null &&
      state.lastPairHandle === null &&
      !state.pendingCollisionEvent &&
      state.damageImpulse === 0,
    'contact, event, recovery and damage state must reset',
  );
});

test('vehicle versus world translation stops at the last safe OBB pose', () => {
  const world = {
    isSolidAtWorld: (x: number) => x > 50,
    isDrivableAtWorld: () => true,
  };
  const result = createWorldClampResult();
  clampVehicleTranslation(world, pose(0, 0), 45, 0, false, 8, result);
  check(result.blocked, 'solid geometry must clamp impact translation');
  check(result.appliedX > 20 && result.appliedX < 31, 'clamp must stop the front edge near x=50');
  const velocity = { x: 80, y: 25 };
  removeVelocityIntoWorld(velocity, result.normalX, result.normalY);
  close(velocity.x, 0, 0.001, 'world-normal velocity removal');
  close(velocity.y, 25, 0.001, 'world tangent preservation');
});

test('parked world safety tolerates legal curb corners but rejects centerline departure', () => {
  const world = {
    isSolidAtWorld: () => false,
    isDrivableAtWorld: (_x: number, y: number) => Math.abs(y) <= 5,
  };
  const parkedPose = pose(0, 0);
  check(
    !isVehiclePoseSafe(world, parkedPose, 'drivable-footprint'),
    'a complete-road policy must reject curb-overlapping corners',
  );
  check(
    isVehiclePoseSafe(world, parkedPose, 'parked-centerline'),
    'a legal parked centerline must tolerate existing curb overlap',
  );
  const result = createWorldClampResult();
  clampVehicleTranslation(world, parkedPose, 0, 18, 'parked-centerline', 8, result);
  check(result.blocked && result.appliedY < 6, 'a pushed parked centerline must not enter sidewalk');
});

test('impact-energy damage favors the lighter target', () => {
  const light = body(-20, 0, 160, 0, 900);
  const heavy = body(20, 0, 0, 0, 6000);
  const result = solve(light, heavy, 1, 0);
  const damage = { damageToFirst: 0, damageToSecond: 0 };
  computeImpactDamage(light, heavy, result.impactEnergy, 1, 1, VEHICLE_COLLISION, damage);
  check(damage.damageToFirst > damage.damageToSecond * 4, 'light target must take more damage');
});

test('integration: player versus sedan scales low, medium and high impacts', () => {
  const run = (speed: number) => {
    const player = body(-20, 0, speed, 0, 1450);
    const sedan = body(20, 0, 0, 0, 1450);
    return { player, sedan, result: solve(player, sedan, 1, 0) };
  };
  const low = run(15);
  const medium = run(110);
  const high = run(280);
  check(!low.result.impactful, 'low-speed sedan contact must stay below crash threshold');
  check(medium.sedan.velocityX > 45, 'medium impact must visibly push the sedan');
  check(high.result.impactEnergy > medium.result.impactEnergy * 5, 'high-speed energy must scale quadratically');
});

test('integration: player versus truck preserves mass asymmetry', () => {
  const player = body(-20, 0, 180, 0, 1450);
  const truck = body(20, 0, 0, 0, 6500, { restitution: 0.06 });
  solve(player, truck, 1, 0);
  check(player.velocityX < 60, 'player must lose substantial speed against a truck');
  check(truck.velocityX > 0 && truck.velocityX < 60, 'truck must move, but less than a sedan');
});

test('integration: player versus motorcycle launches only the light target', () => {
  const player = body(-20, 0, 130, 0, 1450);
  const motorcycle = body(20, 0, 0, 0, 280, { maximumCollisionImpulse: 58_000 });
  solve(player, motorcycle, 1, 0);
  check(motorcycle.velocityX > player.velocityX, 'motorcycle must receive the larger velocity change');
  check(motorcycle.velocityX < 240, 'impulse clamp must prevent an unrealistic launch');
});

test('integration: moving vehicle pushes a finite-mass parked car', () => {
  const player = body(-20, 0, 100, 0, 1450);
  const parked = body(20, 0, 0, 0, 1650);
  solve(player, parked, 1, 0);
  check(parked.velocityX > 35, 'parked car must receive physical motion');
});

test('integration: traffic-to-traffic rear impact preserves forward flow', () => {
  const rear = body(-20, 0, 95, 0, 1500);
  const lead = body(20, 0, 55, 0, 1450);
  solve(rear, lead, 1, 0);
  check(lead.velocityX > 55 && rear.velocityX > 0, 'both traffic cars must continue forward');
});

test('integration: lane-change glancing impact produces bounded yaw', () => {
  const changer = body(-20, -5, 105, 35, 1450);
  const laneCar = body(20, 5, 75, 0, 1500);
  solve(changer, laneCar, 1, 0, 0, 8);
  check(Math.abs(changer.angularVelocity) > 0, 'lane-change contact must produce yaw');
  check(
    Math.abs(changer.angularVelocity) <= changer.physics.maximumAngularVelocity,
    'lane-change yaw must remain clamped',
  );
});

test('integration: highway head-on affects both vehicles without energy growth', () => {
  const first = body(-20, 0, 190, 0, 1800);
  const second = body(20, 0, -190, 0, 1800);
  const before = first.velocityX ** 2 + second.velocityX ** 2;
  solve(first, second, 1, 0);
  const after = first.velocityX ** 2 + second.velocityX ** 2;
  check(first.velocityX < 50 && second.velocityX > -50, 'head-on must affect both vehicles');
  check(after <= before * 1.001, 'highway impact must remain energy stable');
});

test('integration: police SUV, bus and taxi retain class-specific response', () => {
  const police = body(-20, 0, 150, 0, 2400);
  const sedan = body(20, 0, 0, 0, 1450);
  solve(police, sedan, 1, 0);
  const bus = body(-20, 0, 150, 0, 11_500);
  const taxi = body(20, 0, 0, 0, 1500);
  solve(bus, taxi, 1, 0);
  check(sedan.velocityX > 70, 'police SUV must transfer momentum to sedan');
  check(taxi.velocityX > sedan.velocityX, 'bus must affect taxi more strongly than SUV affects sedan');
});

test('integration: severe impact energy can destroy a normal-health vehicle', () => {
  const first = body(-20, 0, 390, 0, 1450);
  const second = body(20, 0, -250, 0, 1450);
  const result = solve(first, second, 1, 0);
  const damage = { damageToFirst: 0, damageToSecond: 0 };
  computeImpactDamage(first, second, result.impactEnergy, 1, 1, VEHICLE_COLLISION, damage);
  check(damage.damageToFirst > 100, 'severe collision must exceed sedan destruction threshold');
  check(damage.damageToSecond > 100, 'severe collision must damage both vehicles proportionally');
});

if (failures.length > 0) {
  console.error(`Vehicle collision validation FAILED (${failures.length} failures / ${assertions} checks)`);
  for (const failure of failures) console.error(` - ${failure}`);
  process.exitCode = 1;
} else {
  console.log('Vehicle collision validation PASSED');
  console.log(`  ${tests} deterministic scenarios / ${assertions} tolerance checks`);
}
