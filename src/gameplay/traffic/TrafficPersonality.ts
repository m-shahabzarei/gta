import type { VehicleKind } from '@/gameplay/types';
import type { TrafficPersonality } from './TrafficTypes';

const PROFILES: Readonly<Record<TrafficPersonality['name'], TrafficPersonality>> = {
  careful: {
    name: 'careful',
    preferredSpeedFactor: 0.82,
    speedVariation: 0.035,
    maxAcceleration: 70,
    comfortableBraking: 92,
    emergencyBraking: 205,
    reactionSeconds: 1.35,
    minimumGap: 22,
    timeHeadway: 1.75,
    laneChangeDesire: 0.12,
    overtakingBias: 0.08,
    politeness: 0.8,
    riskTolerance: 0.12,
    intersectionPriority: 1,
  },
  normal: {
    name: 'normal',
    preferredSpeedFactor: 0.94,
    speedVariation: 0.055,
    maxAcceleration: 88,
    comfortableBraking: 110,
    emergencyBraking: 235,
    reactionSeconds: 1.05,
    minimumGap: 18,
    timeHeadway: 1.4,
    laneChangeDesire: 0.28,
    overtakingBias: 0.22,
    politeness: 0.55,
    riskTolerance: 0.34,
    intersectionPriority: 2,
  },
  aggressive: {
    name: 'aggressive',
    preferredSpeedFactor: 1.07,
    speedVariation: 0.075,
    maxAcceleration: 116,
    comfortableBraking: 138,
    emergencyBraking: 275,
    reactionSeconds: 0.74,
    minimumGap: 12,
    timeHeadway: 0.98,
    laneChangeDesire: 0.58,
    overtakingBias: 0.72,
    politeness: 0.25,
    riskTolerance: 0.68,
    intersectionPriority: 3,
  },
  taxi: {
    name: 'taxi',
    preferredSpeedFactor: 1,
    speedVariation: 0.065,
    maxAcceleration: 102,
    comfortableBraking: 126,
    emergencyBraking: 255,
    reactionSeconds: 0.86,
    minimumGap: 15,
    timeHeadway: 1.16,
    laneChangeDesire: 0.46,
    overtakingBias: 0.54,
    politeness: 0.38,
    riskTolerance: 0.5,
    intersectionPriority: 3,
  },
  bus: {
    name: 'bus',
    preferredSpeedFactor: 0.76,
    speedVariation: 0.025,
    maxAcceleration: 52,
    comfortableBraking: 72,
    emergencyBraking: 165,
    reactionSeconds: 1.3,
    minimumGap: 30,
    timeHeadway: 1.9,
    laneChangeDesire: 0.08,
    overtakingBias: 0.03,
    politeness: 0.9,
    riskTolerance: 0.08,
    intersectionPriority: 2,
  },
  truck: {
    name: 'truck',
    preferredSpeedFactor: 0.79,
    speedVariation: 0.03,
    maxAcceleration: 56,
    comfortableBraking: 78,
    emergencyBraking: 175,
    reactionSeconds: 1.25,
    minimumGap: 28,
    timeHeadway: 1.8,
    laneChangeDesire: 0.11,
    overtakingBias: 0.06,
    politeness: 0.82,
    riskTolerance: 0.1,
    intersectionPriority: 2,
  },
  police: {
    name: 'police',
    preferredSpeedFactor: 1.08,
    speedVariation: 0.045,
    maxAcceleration: 126,
    comfortableBraking: 148,
    emergencyBraking: 295,
    reactionSeconds: 0.66,
    minimumGap: 15,
    timeHeadway: 1.02,
    laneChangeDesire: 0.65,
    overtakingBias: 0.78,
    politeness: 0.24,
    riskTolerance: 0.72,
    intersectionPriority: 8,
  },
  ambulance: {
    name: 'ambulance',
    preferredSpeedFactor: 1.12,
    speedVariation: 0.035,
    maxAcceleration: 118,
    comfortableBraking: 142,
    emergencyBraking: 285,
    reactionSeconds: 0.6,
    minimumGap: 18,
    timeHeadway: 1.08,
    laneChangeDesire: 0.7,
    overtakingBias: 0.82,
    politeness: 0.2,
    riskTolerance: 0.76,
    intersectionPriority: 10,
  },
};

export function personalityForVehicle(kind: VehicleKind, emergency: boolean): TrafficPersonality {
  if (kind === 'ambulance' || kind === 'fireTruck') return PROFILES.ambulance;
  if (kind === 'police' || kind === 'policeSuv') return PROFILES.police;
  if (emergency) return PROFILES.ambulance;
  switch (kind) {
    case 'taxi':
      return PROFILES.taxi;
    case 'bus':
      return PROFILES.bus;
    case 'truck':
    case 'construction':
    case 'delivery':
      return PROFILES.truck;
    case 'sports':
    case 'muscle':
    case 'motorcycle':
      return PROFILES.aggressive;
    case 'bicycle':
    case 'scooter':
      return PROFILES.careful;
    default:
      return PROFILES.normal;
  }
}
