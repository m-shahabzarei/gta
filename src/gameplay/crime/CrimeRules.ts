import type { CrimeType, NpcPersonality, WitnessReaction } from '@/gameplay/types';

export const CRIME_HEAT: Readonly<Record<CrimeType, number>> = {
  gunfire: 38,
  assault: 52,
  'vehicle-theft': 45,
  'hit-and-run': 105,
  murder: 135,
  'police-assault': 195,
  explosion: 125,
};

export const WANTED_HEAT_THRESHOLDS = [0, 35, 95, 175, 285, 420] as const;

/** Deterministic traits keep an NPC's behaviour stable for its whole lifetime. */
export function personalityFromSeed(seed: number): NpcPersonality {
  let value = (seed | 0) ^ 0x6d2b79f5;
  const next = (): number => {
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  return {
    bravery: next(),
    lawfulness: next(),
    panic: next(),
    aggression: next(),
    helpfulness: next(),
    awareness: 0.45 + next() * 0.55,
  };
}

export function civilianReaction(personality: NpcPersonality, crime: CrimeType): WitnessReaction {
  const violent = crime !== 'vehicle-theft' && crime !== 'gunfire';
  if (personality.awareness < 0.5 && personality.lawfulness < 0.45) return 'ignore';
  if (personality.aggression > 0.88 && personality.bravery > 0.72) return 'fight';
  if (personality.helpfulness > 0.86 && personality.bravery > 0.62 && violent) return 'help';
  if (personality.panic > 0.82) return personality.bravery < 0.35 ? 'freeze' : 'panic';
  if (personality.lawfulness > 0.62) return 'call-police';
  if (personality.bravery < 0.28) return 'hide';
  if (personality.bravery > 0.74) return 'point';
  if (personality.panic > 0.55) return 'scream';
  return 'run';
}

export function reactionWillReport(
  reaction: WitnessReaction,
  personality: NpcPersonality,
): boolean {
  if (reaction === 'call-police' || reaction === 'point' || reaction === 'help') return true;
  if (reaction === 'scream') return personality.lawfulness > 0.72;
  if (reaction === 'run' || reaction === 'hide') return personality.lawfulness > 0.86;
  return false;
}

export function desiredWantedLevel(heat: number): number {
  let level = 0;
  for (let i = 1; i < WANTED_HEAT_THRESHOLDS.length; i++) {
    if (heat >= (WANTED_HEAT_THRESHOLDS[i] ?? Infinity)) level = i;
  }
  return level;
}

/** An escalation tick may expose at most one additional star. */
export function nextWantedLevel(current: number, heat: number): number {
  return Math.min(desiredWantedLevel(heat), current + 1);
}

export function witnessReportDelay(
  police: boolean,
  personality: NpcPersonality | null,
  civilianMinMs: number,
  civilianMaxMs: number,
  policeDelayMs: number,
): number {
  if (police) return policeDelayMs;
  const lawfulness = personality?.lawfulness ?? 0;
  return civilianMaxMs + (civilianMinMs - civilianMaxMs) * lawfulness;
}
