export type InteractionKind =
  | 'hospital'
  | 'police'
  | 'gunshop'
  | 'dealership'
  | 'safehouse'
  | 'gas'
  | 'mission'
  | 'transit'
  | 'vehicle'
  | 'npc'
  | 'interior'
  | 'door';

export interface InteractionContext {
  kind: InteractionKind;
  prompt: string;
}
