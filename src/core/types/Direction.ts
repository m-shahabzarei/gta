/**
 * The eight cardinal + intercardinal directions used for character facing and
 * animation selection (walk/run/idle in 8 directions).
 */
export enum Direction {
  South = 'south',
  SouthWest = 'south-west',
  West = 'west',
  NorthWest = 'north-west',
  North = 'north',
  NorthEast = 'north-east',
  East = 'east',
  SouthEast = 'south-east',
}

/** Ordered list of the eight directions, starting at South and going clockwise. */
export const DIRECTION_ORDER: readonly Direction[] = [
  Direction.South,
  Direction.SouthWest,
  Direction.West,
  Direction.NorthWest,
  Direction.North,
  Direction.NorthEast,
  Direction.East,
  Direction.SouthEast,
] as const;

/**
 * Convert a movement vector into the nearest of the eight {@link Direction}s.
 * Returns `null` when the vector is (near) zero-length, i.e. the entity is idle.
 *
 * @param x Horizontal component of the movement vector.
 * @param y Vertical component of the movement vector (screen-space, +y = down).
 */
export function vectorToDirection(x: number, y: number): Direction | null {
  if (Math.abs(x) < 1e-4 && Math.abs(y) < 1e-4) {
    return null;
  }
  // atan2 with +y downward: 0 = East, PI/2 = South.
  const angle = Math.atan2(y, x); // -PI..PI
  const twoPi = Math.PI * 2;
  // Shift so South (index 0) is centred, then quantise to 8 sectors.
  const normalized = (angle + twoPi) % twoPi; // 0..2PI, 0 = East
  const sector = Math.round(normalized / (Math.PI / 4)) % 8; // 0 = East
  // Map "East-relative clockwise" sector to our South-first order.
  const eastFirst: Direction[] = [
    Direction.East,
    Direction.SouthEast,
    Direction.South,
    Direction.SouthWest,
    Direction.West,
    Direction.NorthWest,
    Direction.North,
    Direction.NorthEast,
  ];
  return eastFirst[sector] ?? Direction.South;
}
