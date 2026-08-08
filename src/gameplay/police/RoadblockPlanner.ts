import type { Vector2 } from '@/core/types';
import type {
  RoadEdge,
  RoadIntersectionData,
  RoadNode,
  WorldLandmark,
} from '@/gameplay/types/WorldTypes';

export interface RoadblockPlan {
  readonly nodeId: number;
  readonly position: Vector2;
  /** Predicted road-travel heading; barriers are placed perpendicular to it. */
  readonly heading: number;
  readonly score: number;
  readonly site: 'intersection' | 'highway' | 'bridge' | 'city-exit';
}

export interface RoadblockPlannerInput {
  readonly origin: Vector2;
  readonly velocity: Vector2;
  readonly roadNodes: readonly RoadNode[];
  readonly roadEdges: readonly RoadEdge[];
  readonly intersections: readonly RoadIntersectionData[];
  readonly landmarks?: readonly WorldLandmark[];
  readonly usedNodeIds?: ReadonlySet<number>;
  readonly minDistance: number;
  readonly maxDistance: number;
}

/** Select a major road site ahead of the suspect and outside the safety radius. */
export function planRoadblock(input: RoadblockPlannerInput): RoadblockPlan | null {
  const speed = Math.hypot(input.velocity.x, input.velocity.y);
  if (speed < 8 || input.roadNodes.length === 0) return null;
  const direction = { x: input.velocity.x / speed, y: input.velocity.y / speed };
  const nodesById = new Map(input.roadNodes.map((node) => [node.id, node]));
  const edgesByNode = new Map<number, RoadEdge[]>();
  for (const edge of input.roadEdges) {
    append(edgesByNode, edge.fromNodeId, edge);
    append(edgesByNode, edge.toNodeId, edge);
  }
  const intersectionByNode = new Map(input.intersections.map((item) => [item.nodeId, item]));
  const bridges = (input.landmarks ?? []).filter((landmark) => landmark.kind === 'bridge');
  const preferredDistance = input.minDistance + (input.maxDistance - input.minDistance) * 0.58;
  let best: RoadblockPlan | null = null;

  for (const node of input.roadNodes) {
    if (input.usedNodeIds?.has(node.id)) continue;
    const dx = node.x - input.origin.x;
    const dy = node.y - input.origin.y;
    const distance = Math.hypot(dx, dy);
    if (distance < input.minDistance || distance > input.maxDistance) continue;
    const forward = (dx * direction.x + dy * direction.y) / Math.max(1, distance);
    if (forward < 0.28) continue;

    const edges = edgesByNode.get(node.id) ?? [];
    const majorEdge = edges.reduce<RoadEdge | null>(
      (bestEdge, edge) => (roadPriority(edge) > roadPriority(bestEdge) ? edge : bestEdge),
      null,
    );
    const intersection = intersectionByNode.get(node.id);
    const bridge = bridges.some(
      (landmark) => Math.hypot(landmark.position.x - node.x, landmark.position.y - node.y) <= 130,
    );
    const highway = edges.some(
      (edge) =>
        edge.roadClass === 'highway' ||
        edge.highwayComponent === 'entry-ramp' ||
        edge.highwayComponent === 'exit-ramp',
    );
    const cityExit =
      node.neighbours.length <= 1 && edges.some((edge) => edge.roadClass !== 'local');
    const isIntersection = node.neighbours.length >= 3 || intersection?.kind === 'intersection';
    if (!isIntersection && !highway && !bridge && !cityExit) continue;

    const distanceFit = 1 - Math.min(1, Math.abs(distance - preferredDistance) / preferredDistance);
    const score =
      forward * 8 +
      distanceFit * 4 +
      roadPriority(majorEdge) +
      (isIntersection ? 4 : 0) +
      (highway ? 5 : 0) +
      (bridge ? 5 : 0) +
      (cityExit ? 3 : 0);
    if (best && best.score >= score) continue;
    best = {
      nodeId: node.id,
      position: { x: node.x, y: node.y },
      heading: roadHeading(node, majorEdge, nodesById, direction),
      score,
      site: bridge ? 'bridge' : highway ? 'highway' : cityExit ? 'city-exit' : 'intersection',
    };
  }
  return best;
}

function append(map: Map<number, RoadEdge[]>, nodeId: number, edge: RoadEdge): void {
  const existing = map.get(nodeId);
  if (existing) existing.push(edge);
  else map.set(nodeId, [edge]);
}

function roadPriority(edge: RoadEdge | null): number {
  if (!edge) return 0;
  if (edge.highwayComponent === 'entry-ramp' || edge.highwayComponent === 'exit-ramp') return 7;
  switch (edge.roadClass) {
    case 'highway':
      return 6;
    case 'arterial':
      return 5;
    case 'collector':
      return 3;
    case 'service':
      return 2;
    default:
      return 1;
  }
}

function roadHeading(
  node: RoadNode,
  edge: RoadEdge | null,
  nodesById: ReadonlyMap<number, RoadNode>,
  fallback: Vector2,
): number {
  if (!edge) return Math.atan2(fallback.y, fallback.x);
  const otherId = edge.fromNodeId === node.id ? edge.toNodeId : edge.fromNodeId;
  const other = nodesById.get(otherId);
  return other
    ? Math.atan2(other.y - node.y, other.x - node.x)
    : Math.atan2(fallback.y, fallback.x);
}
