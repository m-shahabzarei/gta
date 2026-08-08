import type { NpcPersonality, WitnessReaction } from './CrimeTypes';

export type VehicleSeat =
  | 'driver'
  | 'front-passenger'
  | 'rear-left'
  | 'rear-right'
  | 'rear-centre'
  | 'passenger-4'
  | 'passenger-5';

export type VehicleOccupantRole =
  | 'civilian'
  | 'taxi-driver'
  | 'bus-driver'
  | 'passenger'
  | 'police-officer'
  | 'police-supervisor'
  | 'paramedic'
  | 'firefighter';

export type VehicleOccupantState =
  'seated' | 'opening-door' | 'exiting' | 'pulled-out' | 'fallen' | 'boarding' | 'on-foot';

export interface VehicleOccupantRecord {
  id: number;
  vehicleId: number;
  seat: VehicleSeat;
  role: VehicleOccupantRole;
  state: VehicleOccupantState;
  personality: NpcPersonality;
  reaction: WitnessReaction;
  color: number;
}

export interface CompletedVehicleExit {
  vehicleId: number;
  occupant: VehicleOccupantRecord;
  x: number;
  y: number;
  reason: 'police-deploy' | 'carjack' | 'passenger-escape';
}
