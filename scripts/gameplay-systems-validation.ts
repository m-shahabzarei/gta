import { HealthComponent } from '@/entities/components/HealthComponent';
import { InventoryComponent } from '@/entities/components/InventoryComponent';
import {
  DRIVABLE_TILE_TYPES,
  Faction,
  PEDESTRIAN_BLOCKED_TILE_TYPES,
  PHYSICAL_GROUND_FEATURE_KINDS,
  SOLID_TILE_TYPES,
  TILE_TYPE_COUNT,
  TileType,
  VEHICLE_ONLY_SOLID_TILE_TYPES,
  VISION_BLOCKING_TILE_TYPES,
  type PlannedGroundFeatureKind,
} from '@/gameplay/types';
import {
  responseProfileForLevel,
  roleForResponseSlot,
} from '@/gameplay/police/PoliceResponseRules';
import { planRoadblock } from '@/gameplay/police/RoadblockPlanner';
import type { RoadEdge, RoadIntersectionData, RoadNode } from '@/gameplay/types';
import {
  isCircleClearOnGrid,
  isCircleSegmentClearOnGrid,
  resolveCirclePositionOnGrid,
  type SolidTileGrid,
} from '@/gameplay/world/SafePedestrianPlacement';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const failures: string[] = [];
let assertions = 0;

function check(condition: boolean, message: string): void {
  assertions += 1;
  if (!condition) failures.push(message);
}

validateArmorFirstDamage();
validateDamageGuards();
validateHealthLifecycle();
validateWeaponDropLifecycle();
validateResponseProfiles();
validateRoadblockPlanning();
validateArchitectureCollisionPolicy();
validateSafePedestrianPlacement();

if (failures.length > 0) {
  console.error(`Gameplay validation FAILED (${failures.length} failures / ${assertions} checks)`);
  for (const failure of failures) console.error(` - ${failure}`);
  process.exitCode = 1;
} else {
  console.log('Gameplay systems validation PASSED');
  console.log(`  ${assertions} vitals and police-response invariant checks`);
  console.log('  armor, HP, death, restore, five response levels, and city alerts passed');
}

function validateArmorFirstDamage(): void {
  const health = new HealthComponent(100);
  health.setArmor(50, 100);
  const armorOnly = hit(health, 30);
  check(armorOnly.absorbedByArmor === 30, 'armor must absorb the first 30 damage');
  check(armorOnly.appliedToHealth === 0, 'armor-only damage must not reduce HP');
  check(armorOnly.health === 100 && armorOnly.armor === 20, 'armor-only snapshot is inconsistent');

  const overflow = hit(health, 45);
  check(overflow.absorbedByArmor === 20, 'remaining armor must be exhausted first');
  check(overflow.appliedToHealth === 25, 'only overflow damage may reach HP');
  check(overflow.health === 75 && overflow.armor === 0, 'overflow snapshot is inconsistent');
}

function validateDamageGuards(): void {
  const health = new HealthComponent(100);
  const invalid = hit(health, Number.NaN);
  check(invalid.ignored === 'invalid' && invalid.health === 100, 'NaN damage must be ignored');
  health.setInvulnerable(500);
  const invulnerable = hit(health, 20);
  check(
    invulnerable.ignored === 'invulnerable' && invulnerable.health === 100,
    'invulnerability must reject the complete hit',
  );
  health.update(0, 500);
  check(hit(health, 20).health === 80, 'damage must resume when invulnerability expires');
}

function validateHealthLifecycle(): void {
  const health = new HealthComponent(100);
  let deaths = 0;
  health.onDeath = () => {
    deaths += 1;
  };
  const fatal = hit(health, 140);
  check(fatal.health === 0 && fatal.killed, 'fatal damage must clamp HP to zero');
  check(fatal.appliedToHealth === 100, 'fatal result must report actual HP lost');
  const afterDeath = hit(health, 20);
  check(afterDeath.ignored === 'dead', 'dead entities must reject later damage');
  check(deaths === 1, 'death callback must execute exactly once');

  health.reset();
  health.heal(1000);
  check(health.health === 100 && !health.isDead, 'reset must revive at max HP');
  health.setArmor(0, 100);
  health.restore(42, 63);
  check(health.health === 42 && health.armor === 63, 'restore must apply one coherent snapshot');
  health.heal(1000);
  check(health.health === 100, 'healing must never exceed max HP');
}

function validateWeaponDropLifecycle(): void {
  const inventory = new InventoryComponent(0);
  inventory.giveWeapon('pistol', 20);
  inventory.switchNext();
  const dropped = inventory.dropEquippedWeapon();
  check(
    dropped?.weaponId === 'pistol' && dropped.ammo === 20,
    'death drop must retain weapon ammo',
  );
  check(
    inventory.currentWeaponId === 'fist',
    'death drop must re-equip the permanent starting weapon',
  );
  check(!inventory.hasWeapon('pistol'), 'dropped weapon must leave the player inventory');
}

function validateArchitectureCollisionPolicy(): void {
  const gameSceneSource = readFileSync(
    join(process.cwd(), 'src', 'scenes', 'GameScene.ts'),
    'utf8',
  );
  const movementSource = readFileSync(
    join(process.cwd(), 'src', 'entities', 'components', 'VehicleMovementComponent.ts'),
    'utf8',
  );
  const runtimeSource = readFileSync(
    join(process.cwd(), 'src', 'gameplay', 'vehicle', 'VehicleCollisionRuntime.ts'),
    'utf8',
  );
  check(
    !gameSceneSource.includes('p.collider(vehicleGroup, vehicleGroup)'),
    'Arcade vehicle self-collision must remain disabled when the custom solver is active',
  );
  check(
    gameSceneSource.includes('interactionColliders.push') &&
      gameSceneSource.includes('this.clearInteractionColliders();'),
    'scene group colliders must be destroyed before their pooled groups detach',
  );
  check(
    runtimeSource.includes('Phaser.Physics.Arcade.Events.WORLD_STEP'),
    'vehicle collision runtime must execute from the authoritative Arcade WORLD_STEP boundary',
  );
  check(
    runtimeSource.includes('pair.stepStamp === this.stepStamp'),
    'vehicle pair resolution must retain a per-step duplicate stamp',
  );
  check(
    runtimeSource.includes('computeSweptObbContact'),
    'vehicle pair narrow phase must use swept oriented geometry',
  );
  check(
    runtimeSource.includes("const impactActive = vehicle.movement.dynamics.impactState !== 'None'") &&
      runtimeSource.includes('!impactActive'),
    'active collision recovery must remain inside the physical runtime beyond ordinary LOD range',
  );
  check(
    !movementSource.includes('this.signedSpeed *= -0.18'),
    'legacy fixed reverse crash response must not coexist with impulse resolution',
  );
  const trafficAuthorityBody =
    movementSource.match(/public setTrafficAuthority[\s\S]*?public get trafficControlled/)?.[0] ?? '';
  check(
    !trafficAuthorityBody.includes('setImmovable(enabled)'),
    'traffic authority must not directly define physical immovability',
  );
  check(
    !SOLID_TILE_TYPES.includes(TileType.InteriorDoor),
    'pedestrian doors must remain open on the shared collision layer',
  );
  check(
    !PEDESTRIAN_BLOCKED_TILE_TYPES.includes(TileType.InteriorDoor),
    'pedestrian navigation must be able to cross an interior door',
  );
  check(
    VEHICLE_ONLY_SOLID_TILE_TYPES.includes(TileType.InteriorDoor),
    'interior doors must be solid on the vehicle-only collision layer',
  );
  check(
    SOLID_TILE_TYPES.includes(TileType.UrbanFixture),
    'physical urban fixtures must block the shared collision layer',
  );
  check(
    PEDESTRIAN_BLOCKED_TILE_TYPES.includes(TileType.UrbanFixture),
    'physical urban fixtures must block pedestrian navigation',
  );
  check(
    VISION_BLOCKING_TILE_TYPES.includes(TileType.UrbanFixture),
    'physical urban fixtures must block witness and combat sight lines',
  );
  check(
    !DRIVABLE_TILE_TYPES.includes(TileType.UrbanFixture),
    'physical urban fixtures must never be drivable terrain',
  );
  check(
    SOLID_TILE_TYPES.includes(TileType.InteriorFixture),
    'substantial interior fixtures must block the shared collision layer',
  );
  check(
    PEDESTRIAN_BLOCKED_TILE_TYPES.includes(TileType.InteriorFixture),
    'substantial interior fixtures must block pedestrian navigation',
  );
  check(
    !DRIVABLE_TILE_TYPES.includes(TileType.InteriorFixture),
    'substantial interior fixtures must never be drivable terrain',
  );
  check(
    TILE_TYPE_COUNT === TileType.InteriorFixture + 1,
    'tile atlas size must include the InteriorFixture collision adapter',
  );

  const expectedPhysicalKinds = [
    'wall',
    'fence',
    'tree',
    'planter',
    'street-light',
    'bench',
    'trash-bin',
    'bike-rack',
    'utility-box',
    'fire-hydrant',
    'mailbox',
    'market-stall',
    'playground-equipment',
    'plaza-fountain',
    'solar-array',
    'stadium-stand',
  ] as const satisfies readonly PlannedGroundFeatureKind[];
  const nonSolidKinds = [
    'path',
    'parking-bay',
    'loading-bay',
    'gate',
    'flower-bed',
    'football-marking',
    'basketball-marking',
    'service-marking',
    'ambulance-bay',
    'police-parking',
    'goal',
  ] as const satisfies readonly PlannedGroundFeatureKind[];
  const actualPhysicalKinds = new Set<PlannedGroundFeatureKind>(PHYSICAL_GROUND_FEATURE_KINDS);
  check(
    actualPhysicalKinds.size === PHYSICAL_GROUND_FEATURE_KINDS.length,
    'physical ground-feature policy must not contain duplicate kinds',
  );
  check(
    actualPhysicalKinds.size === expectedPhysicalKinds.length &&
      expectedPhysicalKinds.every((kind) => actualPhysicalKinds.has(kind)),
    'physical ground-feature collision membership must match the authoritative policy',
  );
  for (const kind of nonSolidKinds) {
    check(!actualPhysicalKinds.has(kind), `${kind} must remain non-solid`);
  }
}

function validateSafePedestrianPlacement(): void {
  const solids = new Set(['2,2', '4,1']);
  const grid: SolidTileGrid = {
    tileSize: 32,
    widthTiles: 6,
    heightTiles: 5,
    isSolidTile: (tx, ty) => solids.has(`${tx},${ty}`),
  };

  check(
    !isCircleClearOnGrid(grid, { x: 80, y: 80 }, 9),
    'actor center inside a building tile must be rejected',
  );
  check(
    !isCircleClearOnGrid(grid, { x: 57, y: 80 }, 9),
    'actor radius overlapping a building edge must be rejected',
  );
  check(
    isCircleClearOnGrid(grid, { x: 54, y: 80 }, 9),
    'actor tangent to a building edge must remain valid',
  );
  check(
    !isCircleSegmentClearOnGrid(grid, { x: 16, y: 80 }, { x: 144, y: 80 }, 9),
    'swept actor segment crossing a building must be rejected',
  );
  check(
    isCircleSegmentClearOnGrid(grid, { x: 16, y: 16 }, { x: 144, y: 16 }, 9),
    'clear swept actor segment must remain valid',
  );

  const exactRequested = { x: 42.25, y: 40.75 };
  const exactResolved = resolveCirclePositionOnGrid(grid, exactRequested, 9);
  check(
    exactResolved?.x === exactRequested.x && exactResolved.y === exactRequested.y,
    'a valid saved coordinate must be preserved exactly rather than snapped to a tile center',
  );

  const resolved = resolveCirclePositionOnGrid(grid, { x: 80, y: 80 }, 9, {
    maxDistance: 80,
  });
  check(
    resolved?.x === 80 && resolved.y === 48,
    'blocked placement must resolve deterministically to the nearest y/x tile center',
  );
  const segmentResolved = resolveCirclePositionOnGrid(grid, { x: 144, y: 48 }, 9, {
    maxDistance: 80,
    segmentStart: { x: 176, y: 48 },
  });
  check(
    segmentResolved?.x === 176 && segmentResolved.y === 48,
    'placement resolver must reject candidates hidden behind a solid segment',
  );
  check(
    resolveCirclePositionOnGrid(grid, { x: -500, y: -500 }, 9)?.x === 16,
    'out-of-bounds stale coordinates must relocate onto the finalized grid',
  );
  check(
    resolveCirclePositionOnGrid(grid, { x: 80, y: 80 }, 9, { maxDistance: 8 }) === null,
    'a bounded local exit search must fail instead of teleporting beyond its maximum distance',
  );
}

function validateResponseProfiles(): void {
  const profiles = Array.from({ length: 6 }, (_, level) => responseProfileForLevel(level));
  check(profiles[0]?.respondingUnits === 0, 'clear state must dispatch no units');
  check(profiles[1]?.engagement === 'investigate', 'one star must investigate');
  check(profiles[2]?.engagement === 'arrest', 'two stars must begin arrest pursuit');
  check(
    profiles[3]?.allowLethalForce === true && profiles[3]?.respondingUnits === 4,
    'three stars must unlock armed multi-unit response',
  );
  check(
    profiles[4]?.roadblocks === true && profiles[4]?.swat === true,
    'four stars must unlock tactical response',
  );
  check(
    profiles[5]?.respondingUnits === 6 &&
      (profiles[5]?.trafficPanic ?? 0) > (profiles[4]?.trafficPanic ?? 0),
    'five stars must produce the maximum city response',
  );
  for (let level = 1; level < profiles.length; level += 1) {
    check(
      JSON.stringify(profiles[level]) !== JSON.stringify(profiles[level - 1]),
      `wanted level ${level} has no measurable response difference`,
    );
    check(
      (profiles[level]?.maxActiveUnits ?? 0) > (profiles[level - 1]?.maxActiveUnits ?? -1),
      `wanted level ${level} must increase the active vehicle cap`,
    );
  }
  check(profiles[2]?.maxActiveUnits === 2, 'two stars must dispatch multiple vehicles');
  check(profiles[4]?.roadblockCount === 1, 'four stars must establish one roadblock');
  check(profiles[5]?.roadblockCount === 2, 'five stars must maximize roadblocks');
  check(profiles[4]?.helicopter === false, 'helicopter must not dispatch below five stars');
  check(profiles[5]?.helicopter === true, 'five stars must dispatch helicopter support');
  for (const profile of profiles.slice(1)) {
    const roles = Array.from({ length: profile.maxActiveUnits }, (_, slot) =>
      roleForResponseSlot(profile, slot),
    );
    check(
      roles.length === profile.maxActiveUnits,
      `level ${profile.level} role plan is incomplete`,
    );
    check(
      profile.waveSize > 0 && profile.waveSize <= profile.maxActiveUnits,
      `level ${profile.level} wave size must be bounded by its active cap`,
    );
  }
}

function validateRoadblockPlanning(): void {
  const nodes: RoadNode[] = [
    { id: 1, x: 0, y: 0, neighbours: [2] },
    { id: 2, x: 620, y: 0, neighbours: [1, 3, 4, 5] },
    { id: 3, x: 900, y: 0, neighbours: [2] },
    { id: 4, x: 620, y: -200, neighbours: [2] },
    { id: 5, x: 620, y: 200, neighbours: [2] },
    { id: 6, x: -620, y: 0, neighbours: [1] },
  ];
  const edges: RoadEdge[] = [
    roadEdge('1-2', 1, 2, 'arterial'),
    roadEdge('2-3', 2, 3, 'highway'),
    roadEdge('2-4', 2, 4, 'collector'),
    roadEdge('2-5', 2, 5, 'collector'),
  ];
  const intersections: RoadIntersectionData[] = [
    {
      nodeId: 2,
      kind: 'intersection',
      control: 'signal',
      connectedEdgeIds: edges.map((edge) => edge.id),
      priorityEdgeIds: ['2-3'],
      trafficLight: true,
    },
  ];
  const plan = planRoadblock({
    origin: { x: 0, y: 0 },
    velocity: { x: 120, y: 0 },
    roadNodes: nodes,
    roadEdges: edges,
    intersections,
    minDistance: 460,
    maxDistance: 920,
  });
  check(plan?.nodeId === 2, 'roadblock planner must select the major intersection ahead');
  check((plan?.position.x ?? 0) >= 460, 'roadblock must remain outside the player safety radius');
  const stationary = planRoadblock({
    origin: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
    roadNodes: nodes,
    roadEdges: edges,
    intersections,
    minDistance: 460,
    maxDistance: 920,
  });
  check(stationary === null, 'roadblock planner must not invent a route for a stationary suspect');
}

function roadEdge(
  id: string,
  fromNodeId: number,
  toNodeId: number,
  roadClass: RoadEdge['roadClass'],
): RoadEdge {
  return {
    id,
    fromNodeId,
    toNodeId,
    roadClass,
    laneCount: roadClass === 'highway' ? 3 : 2,
    speedLimit: roadClass === 'highway' ? 190 : 110,
    direction: 'both',
    priority: 1,
    surface: 'urban-asphalt',
    navigationAllowed: true,
    trafficAllowed: true,
    pedestrianAllowed: roadClass !== 'highway',
    emergencyAllowed: true,
    shoulder: roadClass === 'highway',
    lighting: true,
    turnRestrictions: [],
  };
}

function hit(health: HealthComponent, amount: number) {
  return health.applyDamage({
    amount,
    type: 'bullet',
    sourceFaction: Faction.Police,
    fromPlayer: false,
  });
}
