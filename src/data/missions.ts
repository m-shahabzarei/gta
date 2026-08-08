/**
 * Mission catalogue. Marker positions are assigned at runtime by the mission
 * system from the generated map's building entrances, and GoTo destinations are
 * resolved to live world positions, so the definitions stay world-agnostic.
 */
import { ObjectiveKind, type MissionDef } from '@/gameplay/types';

/** Ordered list of story missions offered to the player. */
export const MISSIONS: readonly MissionDef[] = [
  {
    id: 'm1',
    title: 'Joyride',
    briefing: 'Grab a set of wheels and take it for a spin across town.',
    reward: 250,
    markerX: 0,
    markerY: 0,
    objectives: [
      { kind: ObjectiveKind.StealVehicle, description: 'Steal any vehicle' },
      { kind: ObjectiveKind.GoTo, description: 'Drive to the drop-off', radius: 70 },
    ],
  },
  {
    id: 'm2',
    title: 'Courier',
    briefing: 'Pick up the package and run it across the district.',
    reward: 400,
    markerX: 0,
    markerY: 0,
    objectives: [
      { kind: ObjectiveKind.GoTo, description: 'Reach the pickup', radius: 70 },
      { kind: ObjectiveKind.GoTo, description: 'Deliver the package', radius: 70 },
    ],
  },
  {
    id: 'm3',
    title: 'Cleaner',
    briefing: 'Some folks need to disappear. Make it quick.',
    reward: 550,
    markerX: 0,
    markerY: 0,
    objectives: [{ kind: ObjectiveKind.Eliminate, description: 'Eliminate 4 targets', target: 4 }],
  },
  {
    id: 'm4',
    title: 'Hot Plates',
    briefing: 'The boss wants a fresh car at the lock-up. Clock is ticking.',
    reward: 500,
    markerX: 0,
    markerY: 0,
    timeLimitMs: 95000,
    objectives: [
      { kind: ObjectiveKind.StealVehicle, description: 'Boost a car' },
      { kind: ObjectiveKind.GoTo, description: 'Deliver it to the lock-up', radius: 70 },
    ],
  },
  {
    id: 'm5',
    title: 'Demolition Man',
    briefing: 'Send a message: their fleet burns tonight.',
    reward: 750,
    markerX: 0,
    markerY: 0,
    objectives: [
      { kind: ObjectiveKind.DestroyVehicles, description: 'Destroy 3 vehicles', target: 3 },
    ],
  },
  {
    id: 'm6',
    title: 'Heat',
    briefing: 'Draw the cops out and survive the response.',
    reward: 900,
    markerX: 0,
    markerY: 0,
    objectives: [
      { kind: ObjectiveKind.Survive, description: 'Survive the heat for 45s', target: 45000 },
    ],
  },
  {
    id: 'm7',
    title: 'Milk Run',
    briefing: 'Three stops, no questions. Keep the engine warm.',
    reward: 800,
    markerX: 0,
    markerY: 0,
    timeLimitMs: 150000,
    objectives: [
      { kind: ObjectiveKind.GoTo, description: 'Make the first drop', radius: 70 },
      { kind: ObjectiveKind.GoTo, description: 'Make the second drop', radius: 70 },
      { kind: ObjectiveKind.GoTo, description: 'Make the final drop', radius: 70 },
    ],
  },
  {
    id: 'm8',
    title: 'Kingpin',
    briefing: 'Everything ends tonight. Wipe out the crew and walk away.',
    reward: 1500,
    markerX: 0,
    markerY: 0,
    objectives: [
      { kind: ObjectiveKind.GoTo, description: 'Reach the meet', radius: 70 },
      { kind: ObjectiveKind.Eliminate, description: 'Take out 6 of the crew', target: 6 },
      { kind: ObjectiveKind.Survive, description: 'Hold out for 30s', target: 30000 },
    ],
  },
];
