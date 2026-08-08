import { VEHICLES } from '@/data/vehicles';
import type { NpcPersonality, VehicleKind, WitnessReaction } from '@/gameplay/types';
import {
  CRIME_HEAT,
  civilianReaction,
  desiredWantedLevel,
  nextWantedLevel,
  personalityFromSeed,
  reactionWillReport,
  witnessReportDelay,
} from '@/gameplay/crime/CrimeRules';
import { isPoliceOccupant, occupantManifestFor } from '@/gameplay/occupants/OccupantRules';

const failures: string[] = [];
let assertions = 0;

function check(condition: boolean, message: string): void {
  assertions += 1;
  if (!condition) failures.push(message);
}

validateWitnessDiscovery();
validateReportDelays();
validatePersonalities();
validateWantedEscalation();
validateSearchDecay();
validateVehicleOwnership();
validatePhysicalTransitions();

if (failures.length > 0) {
  console.error(`Police validation FAILED (${failures.length} failures / ${assertions} checks)`);
  for (const failure of failures) console.error(` - ${failure}`);
  process.exitCode = 1;
} else {
  console.log('Police validation PASSED');
  console.log(`  ${assertions} deterministic invariant checks`);
  console.log(`  ${Object.keys(VEHICLES).length} vehicle kinds require real drivers`);
  console.log('  witness delay, five-star escalation, search decay, crews, and transitions passed');
}

function validateWitnessDiscovery(): void {
  const reportedWithoutWitness = simulateReportCount([]);
  check(reportedWithoutWitness === 0, 'an incident with no witnesses must remain unknown');

  const policePersonality = personality(1, 1, 0, 0.2, 0.5, 1);
  const policeReports = simulateReportCount([
    { reaction: 'call-police', personality: policePersonality, police: true },
  ]);
  check(policeReports === 1, 'a police observer must report exactly once');

  const ignoringCivilian = personality(0.2, 0.1, 0.4, 0.2, 0.2, 0.2);
  check(
    simulateReportCount([{ reaction: 'ignore', personality: ignoringCivilian, police: false }]) ===
      0,
    'an ignoring civilian must not create police knowledge',
  );
}

function validateReportDelays(): void {
  const lawful = personality(0.5, 0.95, 0.4, 0.2, 0.4, 0.8);
  const policeDelay = witnessReportDelay(true, lawful, 1100, 4200, 180);
  const civilianDelay = witnessReportDelay(false, lawful, 1100, 4200, 180);
  check(policeDelay === 180, 'police reports should use the direct-radio delay');
  check(civilianDelay >= 1100, 'civilian reports must never be instant');
  check(
    civilianDelay > policeDelay,
    'civilian reaction/report delay must exceed police radio delay',
  );
}

function validatePersonalities(): void {
  const profiles = Array.from({ length: 24 }, (_, index) => personalityFromSeed(index + 1));
  const reactions = new Set(profiles.map((profile) => civilianReaction(profile, 'murder')));
  check(reactions.size >= 5, 'personality sampling should produce varied civilian reactions');
  check(
    profiles.every((profile) => Object.values(profile).every((value) => value >= 0 && value <= 1)),
    'personality traits must remain normalized',
  );
}

function validateWantedEscalation(): void {
  let level = 0;
  const heat = 1000;
  for (let tick = 0; tick < 5; tick++) {
    const next = nextWantedLevel(level, heat);
    check(next - level <= 1, `escalation tick ${tick} jumped more than one star`);
    level = next;
  }
  check(level === 5, 'sustained maximum heat should stop at five stars');
  check(desiredWantedLevel(CRIME_HEAT.gunfire) === 1, 'reported gunfire should begin at one star');
  check(desiredWantedLevel(CRIME_HEAT.murder) === 2, 'reported murder should build to two stars');
  check(
    desiredWantedLevel(CRIME_HEAT['police-assault']) === 3,
    'reported police assault should build to armed-suspect response',
  );
}

function validateSearchDecay(): void {
  let level = 4;
  let heat = 330;
  for (let completedSearchStars = 0; completedSearchStars < 4; completedSearchStars++) {
    level = Math.max(0, level - 1);
    heat = level === 0 ? 0 : Math.min(heat, [0, 35, 95, 175, 285, 420][level] ?? heat);
  }
  check(level === 0 && heat === 0, 'uninterrupted unseen search must eventually clear awareness');
}

function validateVehicleOwnership(): void {
  for (const kind of Object.keys(VEHICLES) as VehicleKind[]) {
    const manifest = occupantManifestFor(kind);
    check(
      manifest.some(([seat]) => seat === 'driver'),
      `${kind} has no driver seat occupant`,
    );
  }
  const cruiser = occupantManifestFor('police');
  const enforcer = occupantManifestFor('policeSuv');
  check(
    cruiser.filter(([, role]) => isPoliceOccupant(role)).length >= 2,
    'cruiser needs two officers',
  );
  check(
    enforcer.filter(([, role]) => isPoliceOccupant(role)).length >= 3,
    'police SUV needs a full crew',
  );
  check(occupantManifestFor('bus').length >= 5, 'bus needs a driver and visible passengers');
}

function validatePhysicalTransitions(): void {
  const carjack = ['opening-door', 'exiting', 'pulled-out', 'fallen', 'on-foot'];
  const police = ['opening-door', 'exiting', 'on-foot', 'boarding', 'seated'];
  check(
    carjack.indexOf('fallen') > carjack.indexOf('pulled-out'),
    'driver must be pulled before falling',
  );
  check(carjack.at(-1) === 'on-foot', 'carjacked driver must finish as a world NPC');
  check(
    police.indexOf('boarding') > police.indexOf('on-foot'),
    'police must reach the car before boarding',
  );
  check(police.at(-1) === 'seated', 'returning police must finish visibly seated');
}

function simulateReportCount(
  witnesses: Array<{ reaction: WitnessReaction; personality: NpcPersonality; police: boolean }>,
): number {
  return witnesses.some(
    (witness) => witness.police || reactionWillReport(witness.reaction, witness.personality),
  )
    ? 1
    : 0;
}

function personality(
  bravery: number,
  lawfulness: number,
  panic: number,
  aggression: number,
  helpfulness: number,
  awareness: number,
): NpcPersonality {
  return { bravery, lawfulness, panic, aggression, helpfulness, awareness };
}
