import type { VehicleKind, VehicleOccupantRole, VehicleSeat } from '@/gameplay/types';

export type OccupantSeatSpec = readonly [VehicleSeat, VehicleOccupantRole];

/** Seats that may be claimed dynamically by real transit passengers. */
export function passengerSeatsFor(kind: VehicleKind): readonly VehicleSeat[] {
  switch (kind) {
    case 'taxi':
      return ['rear-right'];
    case 'bus':
      return ['front-passenger', 'rear-left', 'rear-right', 'passenger-4', 'passenger-5'];
    default:
      return [];
  }
}

/** Canonical ownership/passenger manifest for every vehicle kind. */
export function occupantManifestFor(kind: VehicleKind): readonly OccupantSeatSpec[] {
  switch (kind) {
    case 'police':
      return [
        ['driver', 'police-officer'],
        ['front-passenger', 'police-officer'],
      ];
    case 'policeSuv':
      return [
        ['driver', 'police-supervisor'],
        ['front-passenger', 'police-officer'],
        ['rear-left', 'police-officer'],
        ['rear-right', 'police-officer'],
      ];
    case 'ambulance':
      return [
        ['driver', 'paramedic'],
        ['front-passenger', 'paramedic'],
      ];
    case 'fireTruck':
      return [
        ['driver', 'firefighter'],
        ['front-passenger', 'firefighter'],
      ];
    case 'taxi':
      return [['driver', 'taxi-driver']];
    case 'bus':
      return [['driver', 'bus-driver']];
    case 'van':
    case 'suv':
      return [
        ['driver', 'civilian'],
        ['front-passenger', 'passenger'],
        ['rear-right', 'passenger'],
      ];
    case 'sedan':
    case 'luxury':
    case 'classic':
      return [
        ['driver', 'civilian'],
        ['front-passenger', 'passenger'],
      ];
    default:
      return [['driver', 'civilian']];
  }
}

export function isPoliceOccupant(role: VehicleOccupantRole): boolean {
  return role === 'police-officer' || role === 'police-supervisor';
}
