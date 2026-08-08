export type PoliceEngagementPolicy = 'investigate' | 'arrest' | 'combat';

export type PoliceUnitRole =
  'investigation' | 'pursuit' | 'interceptor' | 'containment' | 'roadblock';

export interface PoliceRolePlan {
  readonly investigation: number;
  readonly pursuit: number;
  readonly interceptor: number;
  readonly containment: number;
  readonly roadblock: number;
}

export interface PoliceResponseProfile {
  readonly level: number;
  /** Compatibility name used by HUD/tests; equal to maxActiveUnits. */
  readonly respondingUnits: number;
  readonly maxActiveUnits: number;
  readonly maxActiveOfficers: number;
  readonly waveSize: number;
  readonly waveCooldownMs: number;
  readonly engagement: PoliceEngagementPolicy;
  readonly allowLethalForce: boolean;
  readonly searchRadius: number;
  readonly searchStarMs: number;
  readonly roadblocks: boolean;
  readonly roadblockCount: number;
  readonly helicopter: boolean;
  readonly swat: boolean;
  readonly pedestrianPanic: boolean;
  readonly trafficPanic: number;
  readonly roles: PoliceRolePlan;
}

const RESPONSE_PROFILES: readonly PoliceResponseProfile[] = [
  profile(0, 0, 0, 0, 'investigate', false, 0, 0, 0, false, false, 0, roles()),
  profile(1, 1, 1, 18000, 'investigate', false, 120, 9000, 0, false, false, 0, roles(1)),
  profile(2, 2, 2, 14500, 'arrest', false, 175, 11000, 0, false, false, 0.08, roles(0, 1, 0, 1)),
  profile(3, 4, 2, 10000, 'combat', true, 240, 13500, 0, false, false, 0.15, roles(0, 2, 1, 1)),
  profile(4, 5, 3, 7500, 'combat', true, 330, 16000, 1, false, true, 0.24, roles(0, 2, 1, 1, 1)),
  profile(5, 6, 3, 5200, 'combat', true, 430, 19000, 2, true, true, 0.34, roles(0, 2, 1, 1, 2)),
] as const;

export function responseProfileForLevel(level: number): PoliceResponseProfile {
  const safeLevel = Number.isFinite(level) ? Math.round(level) : 0;
  const index = Math.max(0, Math.min(RESPONSE_PROFILES.length - 1, safeLevel));
  return RESPONSE_PROFILES[index] ?? RESPONSE_PROFILES[0]!;
}

/** Deterministic desired role for one active-response slot. */
export function roleForResponseSlot(response: PoliceResponseProfile, slot: number): PoliceUnitRole {
  const ordered: readonly PoliceUnitRole[] = [
    'roadblock',
    'interceptor',
    'containment',
    'pursuit',
    'investigation',
  ];
  let cursor = Math.max(0, Math.floor(slot));
  for (const role of ordered) {
    const count = response.roles[role];
    if (cursor < count) return role;
    cursor -= count;
  }
  return response.engagement === 'investigate' ? 'investigation' : 'pursuit';
}

function roles(
  investigation = 0,
  pursuit = 0,
  interceptor = 0,
  containment = 0,
  roadblock = 0,
): PoliceRolePlan {
  return { investigation, pursuit, interceptor, containment, roadblock };
}

function profile(
  level: number,
  maxActiveUnits: number,
  waveSize: number,
  waveCooldownMs: number,
  engagement: PoliceEngagementPolicy,
  allowLethalForce: boolean,
  searchRadius: number,
  searchStarMs: number,
  roadblockCount: number,
  helicopter: boolean,
  swat: boolean,
  trafficPanic: number,
  rolePlan: PoliceRolePlan,
): PoliceResponseProfile {
  return {
    level,
    respondingUnits: maxActiveUnits,
    maxActiveUnits,
    maxActiveOfficers: maxActiveUnits * 2,
    waveSize,
    waveCooldownMs,
    engagement,
    allowLethalForce,
    searchRadius,
    searchStarMs,
    roadblocks: roadblockCount > 0,
    roadblockCount,
    helicopter,
    swat,
    pedestrianPanic: level >= 4,
    trafficPanic,
    roles: rolePlan,
  };
}
