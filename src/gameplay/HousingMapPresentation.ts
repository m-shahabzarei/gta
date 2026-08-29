/** Visual states used by the full-screen map without leaking UI concerns into HousingSystem. */
export type PropertyMapStatus = 'for-sale' | 'owned' | 'active';

/** Resolve the most specific visible state for a property map marker. */
export function classifyPropertyMapStatus(
  propertyId: string,
  ownedPropertyIds: readonly string[],
  activeHomeId: string | null,
): PropertyMapStatus {
  if (activeHomeId === propertyId) return 'active';
  return ownedPropertyIds.includes(propertyId) ? 'owned' : 'for-sale';
}

/** Short, player-facing copy shared by the map guide, tooltip, and detail card. */
export function propertyMapStatusLabel(status: PropertyMapStatus): string {
  switch (status) {
    case 'for-sale':
      return 'For sale';
    case 'owned':
      return 'Owned home';
    case 'active':
      return 'Active home';
  }
}

/** Housing uses cash as an in-world currency; keep the map price compact and stable. */
export function formatPropertyMapPrice(price: number, currency: string): string {
  const amount = Math.max(0, Math.round(price)).toLocaleString('en-US');
  return currency === 'cash' ? `$${amount}` : `${amount} ${currency}`;
}
