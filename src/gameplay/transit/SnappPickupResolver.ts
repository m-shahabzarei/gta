import type { TrafficLaneRole } from '@/gameplay/traffic';

/** Minimal immutable data needed to rank a resolved Snapp curb candidate. */
export interface SnappPickupCandidateRank {
  readonly roadSegmentId: string | null;
  readonly laneRole: TrafficLaneRole;
  readonly curbFacing: boolean;
  readonly displacementPx: number;
  readonly approachUsable: boolean;
  readonly routeReachable: boolean;
  readonly routeDistancePx: number;
}

/** Development diagnostics emitted while resolving a passenger-centric pickup. */
export type SnappPickupCandidateRejectionReason =
  | 'different-road-segment'
  | 'not-curb-facing-outer-lane'
  | 'outside-city'
  | 'excessive-displacement'
  | 'vehicle-clearance-blocked'
  | 'boarding-approach-blocked'
  | 'path-to-boarding-approach-blocked'
  | 'route-unreachable';

/**
 * Compare only candidates that belong to the passenger's nearest physical road.
 * Route distance is deliberately last: it may choose a driver, never a street.
 */
export function compareSnappPickupCandidates<T extends SnappPickupCandidateRank>(
  left: T,
  right: T,
  nearestRoadSegmentId: string,
  distanceEpsilonPx: number,
): number {
  const leftSameRoad = left.roadSegmentId === nearestRoadSegmentId;
  const rightSameRoad = right.roadSegmentId === nearestRoadSegmentId;
  if (leftSameRoad !== rightSameRoad) return leftSameRoad ? -1 : 1;

  const leftCurbLane = left.laneRole === 'outer' && left.curbFacing;
  const rightCurbLane = right.laneRole === 'outer' && right.curbFacing;
  if (leftCurbLane !== rightCurbLane) return leftCurbLane ? -1 : 1;

  const displacementDifference = left.displacementPx - right.displacementPx;
  if (Math.abs(displacementDifference) > Math.max(0, distanceEpsilonPx)) {
    return displacementDifference;
  }
  if (left.approachUsable !== right.approachUsable) return left.approachUsable ? -1 : 1;
  if (left.routeReachable !== right.routeReachable) return left.routeReachable ? -1 : 1;
  return left.routeDistancePx - right.routeDistancePx;
}

/** Return the best legal same-street curb or `null`; never degrade to another road. */
export function selectSnappPickupCandidate<T extends SnappPickupCandidateRank>(
  candidates: readonly T[],
  nearestRoadSegmentId: string,
  maximumDisplacementPx: number,
  distanceEpsilonPx: number,
): T | null {
  const valid = candidates.filter(
    (candidate) =>
      candidate.roadSegmentId === nearestRoadSegmentId &&
      candidate.laneRole === 'outer' &&
      candidate.curbFacing &&
      candidate.displacementPx <= maximumDisplacementPx &&
      candidate.approachUsable &&
      candidate.routeReachable,
  );
  valid.sort((left, right) => {
    const ranked = compareSnappPickupCandidates(
      left,
      right,
      nearestRoadSegmentId,
      distanceEpsilonPx,
    );
    if (ranked !== 0) return ranked;
    const leftKey = 'laneId' in left ? String(left.laneId) : '';
    const rightKey = 'laneId' in right ? String(right.laneId) : '';
    return leftKey.localeCompare(rightKey);
  });
  return valid[0] ?? null;
}
