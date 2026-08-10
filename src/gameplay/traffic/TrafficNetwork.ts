import type { Vector2 } from '@/core/types';
import type { RoadEdge, RoadNode, TrafficLightInfo, VehicleKind } from '@/gameplay/types';
import { findPath, type IPathGraph } from '@/utils/AStar';
import { LruCache } from '@/utils/LruCache';
import {
  clamp,
  createLaneSpline,
  projectOnSpline,
  sampleSpline,
  wrapAngle,
  type SplinePose,
  type SplineProjection,
} from './SplineMath';
import type {
  ParkingSpace,
  TrafficJunction,
  TrafficLane,
  TrafficNodeKind,
  TrafficRoadSegment,
  TrafficTurn,
} from './TrafficTypes';

const LANE_WIDTH = 18;
const INNER_LANE_OFFSET = 11.5;
const OUTER_LANE_OFFSET = 29.5;
const PARKING_OFFSET = 39;
const JUNCTION_CLEARANCE = 48;
const LANE_INDEX_CELL = 320;
const ROUTE_CACHE_SIZE = 4096;
/** One-off transit/map searches may be complete, but are still explicitly bounded and cached. */
const COMPLETE_ROUTE_CACHE_SIZE = 1024;
const ROUTE_SEARCH_EXPANSION_BUDGET = 24;
/** A complete player-facing route is assembled from bounded native A* slices. */
const COMPLETE_ROUTE_SLICE_EXPANSIONS = 128;
const COMPLETE_ROUTE_MAX_SLICES = 256;
const CONNECTOR_HANDLE_MIN = 12;
const CONNECTOR_HANDLE_MAX = 35;

const ALL_VEHICLES: readonly VehicleKind[] = [
  'sedan',
  'taxi',
  'police',
  'policeSuv',
  'ambulance',
  'fireTruck',
  'sports',
  'luxury',
  'classic',
  'muscle',
  'truck',
  'van',
  'pickup',
  'suv',
  'bus',
  'motorcycle',
  'scooter',
  'bicycle',
  'delivery',
  'construction',
];

interface LaneProjection extends SplineProjection {
  readonly lane: TrafficLane;
}

interface DirectedLaneSet {
  readonly fromNodeId: number;
  readonly toNodeId: number;
  readonly lanes: TrafficLane[];
}

class LaneGraph implements IPathGraph<TrafficLane> {
  constructor(private readonly lanes: ReadonlyMap<string, TrafficLane>) {}

  public key(lane: TrafficLane): string {
    return lane.id;
  }

  public *neighbours(lane: TrafficLane): Iterable<TrafficLane> {
    for (const id of lane.connectionIds) {
      const next = this.lanes.get(id);
      if (next) yield next;
    }
  }

  public cost(_from: TrafficLane, to: TrafficLane): number {
    const turnCost =
      to.turn === 'left' ? 34 : to.turn === 'right' ? 12 : to.turn === 'u-turn' ? 120 : 0;
    return to.spline.length + turnCost + (to.role === 'outer' ? 3 : 0);
  }

  public heuristic(lane: TrafficLane, goal: TrafficLane): number {
    const from = lane.spline.controlPoints[3];
    const to = goal.spline.controlPoints[3];
    return Math.hypot(to.x - from.x, to.y - from.y);
  }
}

/**
 * Immutable traffic road network. Tiles are consulted only while the world is
 * authored; every runtime movement and rule decision uses this directed graph.
 */
export class TrafficNetwork {
  private readonly roadsById = new Map<string, TrafficRoadSegment>();
  private readonly lanesById = new Map<string, TrafficLane>();
  private readonly junctionsById = new Map<number, TrafficJunction>();
  private readonly directedSets = new Map<string, DirectedLaneSet>();
  private readonly laneList: TrafficLane[] = [];
  private readonly travelLanes: TrafficLane[] = [];
  private readonly parkingList: ParkingSpace[] = [];
  private readonly laneIndex = new Map<string, TrafficLane[]>();
  private readonly parkingIndex = new Map<string, ParkingSpace[]>();
  private readonly routeCache = new LruCache<string, readonly TrafficLane[]>(ROUTE_CACHE_SIZE);
  private readonly completeRouteCache = new LruCache<string, readonly TrafficLane[]>(
    COMPLETE_ROUTE_CACHE_SIZE,
  );
  /** Lazily built SCC index used by authored services to avoid invalid directed loops. */
  private strongComponentByLaneId: Map<string, number> | null = null;
  private readonly graph: LaneGraph;
  private routeCacheHitsValue = 0;
  private routeCacheMissesValue = 0;

  constructor(
    nodes: readonly RoadNode[],
    lights: readonly TrafficLightInfo[],
    roadEdges: readonly RoadEdge[] = [],
    authoredParkingSites: readonly Vector2[] = [],
  ) {
    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    const roadEdgesByPair = new Map(
      roadEdges.map((edge) => [this.edgePairKey(edge.fromNodeId, edge.toNodeId), edge]),
    );
    const signalNodes = this.findSignalNodes(nodes, lights);
    this.buildRoadSegments(nodes, nodesById, roadEdgesByPair);
    this.buildJunctions(nodes, nodesById, signalNodes);
    this.buildConflictSets();
    this.addAuthoredParkingSpaces(authoredParkingSites);
    this.graph = new LaneGraph(this.lanesById);
    this.buildSpatialIndexes();
  }

  public get roadCount(): number {
    return this.roadsById.size;
  }

  public get laneCount(): number {
    return this.laneList.length;
  }

  public get intersectionCount(): number {
    return this.junctionsById.size;
  }

  public get parkingSpaceCount(): number {
    return this.parkingList.length;
  }

  public get routeCacheHits(): number {
    return this.routeCacheHitsValue;
  }

  public get routeCacheMisses(): number {
    return this.routeCacheMissesValue;
  }

  public lanes(): readonly TrafficLane[] {
    return this.laneList;
  }

  public junctions(): readonly TrafficJunction[] {
    return Array.from(this.junctionsById.values());
  }

  public parkingSpaces(): readonly ParkingSpace[] {
    return this.parkingList;
  }

  public lane(id: string | null | undefined): TrafficLane | null {
    return id ? (this.lanesById.get(id) ?? null) : null;
  }

  public road(id: string | null | undefined): TrafficRoadSegment | null {
    return id ? (this.roadsById.get(id) ?? null) : null;
  }

  public junction(id: number | null | undefined): TrafficJunction | null {
    return id === null || id === undefined ? null : (this.junctionsById.get(id) ?? null);
  }

  public nearestJunction(position: Vector2, maximumDistance = 96): TrafficJunction | null {
    let nearest: TrafficJunction | null = null;
    let nearestSq = maximumDistance * maximumDistance;
    for (const junction of this.junctionsById.values()) {
      const dx = junction.center.x - position.x;
      const dy = junction.center.y - position.y;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq < nearestSq) {
        nearest = junction;
        nearestSq = distanceSq;
      }
    }
    return nearest;
  }

  public pointAt(lane: TrafficLane, distance: number): SplinePose {
    return sampleSpline(lane.spline, distance);
  }

  public projectPoint(position: Vector2, lane: TrafficLane): LaneProjection {
    return { lane, ...projectOnSpline(position, lane.spline) };
  }

  public nearestLane(position: Vector2, heading?: number, travelOnly = false): TrafficLane | null {
    let best: TrafficLane | null = null;
    let bestScore = Infinity;
    const inspect = (lane: TrafficLane): void => {
      if (travelOnly && lane.kind !== 'travel') return;
      const projection = projectOnSpline(position, lane.spline);
      const headingPenalty =
        heading === undefined ? 0 : Math.abs(wrapAngle(projection.heading - heading)) * 76;
      const score = projection.distanceSq + headingPenalty * headingPenalty;
      if (score < bestScore) {
        best = lane;
        bestScore = score;
      }
    };
    this.forEachIndexedLane(position, LANE_INDEX_CELL, inspect);
    if (bestScore > LANE_INDEX_CELL * LANE_INDEX_CELL) {
      this.forEachIndexedLane(position, LANE_INDEX_CELL * 2, inspect);
    }
    if (!best) {
      const candidates = travelOnly ? this.travelLanes : this.laneList;
      for (const lane of candidates) {
        const projection = projectOnSpline(position, lane.spline);
        if (projection.distanceSq < bestScore) {
          best = lane;
          bestScore = projection.distanceSq;
        }
      }
    }
    return best;
  }

  public randomTravelLaneNear(
    position: Vector2,
    minimumDistance: number,
    maximumDistance: number,
    random: () => number,
  ): TrafficLane | null {
    const minimumSq = minimumDistance * minimumDistance;
    const maximumSq = maximumDistance * maximumDistance;
    let selected: TrafficLane | null = null;
    let count = 0;
    this.forEachIndexedLane(position, maximumDistance, (lane) => {
      if (lane.kind !== 'travel' || lane.spline.length < 150) return;
      const midpoint = sampleSpline(lane.spline, lane.spline.length * 0.5).point;
      const dx = midpoint.x - position.x;
      const dy = midpoint.y - position.y;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq < minimumSq || distanceSq > maximumSq) return;
      count += 1;
      if (random() <= 1 / count) selected = lane;
    });
    return selected;
  }

  public parallelLane(lane: TrafficLane, direction: -1 | 1): TrafficLane | null {
    if (lane.kind !== 'travel') return null;
    const set = this.directedSets.get(this.directedKey(lane.fromNodeId, lane.toNodeId));
    return (
      set?.lanes.find((candidate) => candidate.laneIndex === lane.laneIndex + direction) ?? null
    );
  }

  public findRoute(startId: string, goalId: string): readonly TrafficLane[] | null {
    const start = this.lanesById.get(startId);
    const goal = this.lanesById.get(goalId);
    if (!start || !goal) return null;
    const key = `${startId}|${goalId}`;
    const cached = this.routeCache.get(key);
    if (cached !== undefined) {
      this.routeCacheHitsValue += 1;
      return cached.length > 0 ? cached : null;
    }
    this.routeCacheMissesValue += 1;
    // Long inter-city searches return a legal partial route when their
    // expansion slice is exhausted. Drivers continue that route from its
    // final lane, preventing a single city-wide A* request from stalling a frame.
    const result = findPath(this.graph, start, goal, {
      maxExpansions: ROUTE_SEARCH_EXPANSION_BUDGET,
      allowPartial: true,
    });
    const route = result?.path ?? [];
    this.routeCache.set(key, route);
    return route.length > 0 ? route : null;
  }

  /**
   * Resolve an exact legal lane route for player-facing quotes and authored
   * transit lines. Unlike {@link findRoute}, this never turns an A* partial
   * result into a destination route; drivers retain the short sliced query for
   * their per-vehicle replanning budget.
   */
  public findCompleteRoute(startId: string, goalId: string): readonly TrafficLane[] | null {
    const start = this.lanesById.get(startId);
    const goal = this.lanesById.get(goalId);
    if (!start || !goal) return null;
    const key = `${startId}|${goalId}`;
    const cached = this.completeRouteCache.get(key);
    if (cached !== undefined) return cached.length > 0 ? cached : null;

    // This API is event-driven (route authoring, fare selection, map open),
    // never called from the traffic update loop. Reuse the driver's bounded A*
    // policy in forward slices instead of one world-wide search, which avoids
    // freezing the game while still rejecting an incomplete destination route.
    const route: TrafficLane[] = [start];
    const reached = new Set<string>([start.id]);
    let current = start;
    for (let slice = 0; slice < COMPLETE_ROUTE_MAX_SLICES && current.id !== goal.id; slice += 1) {
      const result = findPath(this.graph, current, goal, {
        maxExpansions: COMPLETE_ROUTE_SLICE_EXPANSIONS,
        allowPartial: true,
      });
      const segment = result?.path ?? [];
      if (segment.length < 2) break;
      for (const lane of segment.slice(1)) route.push(lane);
      const next = segment[segment.length - 1];
      if (!next || reached.has(next.id)) break;
      reached.add(next.id);
      current = next;
    }
    if (current.id !== goal.id) route.length = 0;
    this.completeRouteCache.set(key, route);
    return route.length > 0 ? route : null;
  }

  /** Return the directed strongly-connected component for a lane, if it exists. */
  public strongComponentId(laneId: string): number | null {
    if (!this.lanesById.has(laneId)) return null;
    this.ensureStrongComponents();
    return this.strongComponentByLaneId?.get(laneId) ?? null;
  }

  /** A same-component pair is guaranteed to have legal directed paths both ways. */
  public sharesStrongComponent(firstLaneId: string, secondLaneId: string): boolean {
    const first = this.strongComponentId(firstLaneId);
    return first !== null && first === this.strongComponentId(secondLaneId);
  }

  /** Every ambient trip has a concrete reachable destination lane. */
  public chooseDestination(
    startId: string,
    random: () => number,
    minimumTravelLanes = 8,
  ): TrafficLane | null {
    const start = this.lanesById.get(startId);
    if (!start) return null;
    let current = start;
    let lastTravel = start.kind === 'travel' ? start : null;
    const steps = minimumTravelLanes * 2 + Math.floor(random() * minimumTravelLanes * 3);
    for (let index = 0; index < steps; index++) {
      const choices = current.connectionIds
        .map((id) => this.lanesById.get(id))
        .filter((lane): lane is TrafficLane => lane !== undefined);
      if (choices.length === 0) break;
      current = choices[Math.floor(random() * choices.length)] ?? current;
      if (current.kind === 'travel') lastTravel = current;
    }
    return lastTravel && lastTravel.id !== start.id
      ? lastTravel
      : this.farthestReachableTravelLane(start);
  }

  /**
   * Iterative Kosaraju traversal avoids recursive stack depth on country-size
   * lane graphs. It is calculated once, only when an authored transit route
   * needs a directed-cycle check; vehicle movement continues to use A*.
   */
  private ensureStrongComponents(): void {
    if (this.strongComponentByLaneId) return;
    const reverse = new Map<string, string[]>();
    for (const lane of this.laneList) reverse.set(lane.id, []);
    for (const lane of this.laneList) {
      for (const nextId of lane.connectionIds) {
        const incoming = reverse.get(nextId);
        if (incoming) incoming.push(lane.id);
      }
    }

    const visited = new Set<string>();
    const finishOrder: string[] = [];
    for (const seed of this.laneList) {
      if (visited.has(seed.id)) continue;
      const stack: Array<{ laneId: string; edgeIndex: number }> = [{ laneId: seed.id, edgeIndex: 0 }];
      visited.add(seed.id);
      while (stack.length > 0) {
        const frame = stack[stack.length - 1];
        if (!frame) break;
        const lane = this.lanesById.get(frame.laneId);
        const nextId = lane?.connectionIds[frame.edgeIndex];
        if (nextId !== undefined) {
          frame.edgeIndex += 1;
          if (!visited.has(nextId) && this.lanesById.has(nextId)) {
            visited.add(nextId);
            stack.push({ laneId: nextId, edgeIndex: 0 });
          }
          continue;
        }
        stack.pop();
        finishOrder.push(frame.laneId);
      }
    }

    const components = new Map<string, number>();
    let componentId = 0;
    for (let index = finishOrder.length - 1; index >= 0; index -= 1) {
      const seedId = finishOrder[index];
      if (!seedId || components.has(seedId)) continue;
      const stack = [seedId];
      components.set(seedId, componentId);
      while (stack.length > 0) {
        const laneId = stack.pop();
        if (!laneId) continue;
        for (const previousId of reverse.get(laneId) ?? []) {
          if (components.has(previousId)) continue;
          components.set(previousId, componentId);
          stack.push(previousId);
        }
      }
      componentId += 1;
    }
    this.strongComponentByLaneId = components;
  }

  public parkingSpacesNear(
    position: Vector2,
    minimumDistance: number,
    maximumDistance: number,
  ): ParkingSpace[] {
    const result: ParkingSpace[] = [];
    const minSq = minimumDistance * minimumDistance;
    const maxSq = maximumDistance * maximumDistance;
    const minX = Math.floor((position.x - maximumDistance) / LANE_INDEX_CELL);
    const maxX = Math.floor((position.x + maximumDistance) / LANE_INDEX_CELL);
    const minY = Math.floor((position.y - maximumDistance) / LANE_INDEX_CELL);
    const maxY = Math.floor((position.y + maximumDistance) / LANE_INDEX_CELL);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        for (const space of this.parkingIndex.get(this.cellKeyFromCell(x, y)) ?? []) {
          const dx = space.position.x - position.x;
          const dy = space.position.y - position.y;
          const distanceSq = dx * dx + dy * dy;
          if (distanceSq >= minSq && distanceSq <= maxSq) result.push(space);
        }
      }
    }
    return result;
  }

  public routeDistanceToLane(
    route: readonly TrafficLane[],
    routeIndex: number,
    laneDistance: number,
    targetLaneId: string,
    targetDistance: number,
  ): number | null {
    let distance = -laneDistance;
    for (let index = routeIndex; index < route.length; index++) {
      const lane = route[index];
      if (!lane) continue;
      if (lane.id === targetLaneId) return distance + targetDistance;
      distance += lane.spline.length;
    }
    return null;
  }

  /** Exhaustive audit used once at startup to prove that regional lanes share one graph. */
  public positionsAreMutuallyReachable(positions: readonly Vector2[]): boolean {
    const lanes = positions
      .map((position) => this.nearestLane(position, undefined, true))
      .filter((lane): lane is TrafficLane => lane !== null);
    if (lanes.length !== positions.length) return false;
    for (const start of lanes) {
      const remaining = new Set(lanes.map((lane) => lane.id));
      const visited = new Set<string>([start.id]);
      const queue = [start.id];
      remaining.delete(start.id);
      for (let cursor = 0; cursor < queue.length && remaining.size > 0; cursor++) {
        const id = queue[cursor];
        if (!id) continue;
        const lane = this.lanesById.get(id);
        if (!lane) continue;
        for (const nextId of lane.connectionIds) {
          if (visited.has(nextId)) continue;
          visited.add(nextId);
          queue.push(nextId);
          remaining.delete(nextId);
        }
      }
      if (remaining.size > 0) return false;
    }
    return true;
  }

  private buildRoadSegments(
    nodes: readonly RoadNode[],
    nodesById: ReadonlyMap<number, RoadNode>,
    roadEdgesByPair: ReadonlyMap<string, RoadEdge>,
  ): void {
    for (const from of nodes) {
      for (const toId of from.neighbours) {
        if (from.id >= toId) continue;
        const to = nodesById.get(toId);
        if (!to) continue;
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const length = Math.hypot(dx, dy);
        if (length <= JUNCTION_CLEARANCE * 2 + 30) continue;
        const arterial = this.isArterial(from, to);
        const policy = roadEdgesByPair.get(this.edgePairKey(from.id, to.id));
        const laneCount = policy?.laneCount ?? (arterial ? 2 : 1);
        const speedLimit = policy?.speedLimit ?? (arterial ? 165 : 122);
        const roadId = this.roadId(from.id, to.id);
        const laneIds: string[] = [];
        const legalOriginId =
          policy?.direction === 'forward'
            ? policy.fromNodeId
            : policy?.direction === 'reverse'
              ? policy.toNodeId
              : null;
        const forward =
          legalOriginId === null || legalOriginId === from.id
            ? this.addDirectedLanes(roadId, from, to, laneCount, speedLimit, policy)
            : null;
        const reverse =
          legalOriginId === null || legalOriginId === to.id
            ? this.addDirectedLanes(roadId, to, from, laneCount, speedLimit, policy)
            : null;
        laneIds.push(
          ...(forward?.lanes.map((lane) => lane.id) ?? []),
          ...(reverse?.lanes.map((lane) => lane.id) ?? []),
        );
        if (forward) this.directedSets.set(this.directedKey(from.id, to.id), forward);
        if (reverse) this.directedSets.set(this.directedKey(to.id, from.id), reverse);
        this.roadsById.set(roadId, {
          id: roadId,
          fromNodeId: from.id,
          toNodeId: to.id,
          speedLimit,
          laneWidth: LANE_WIDTH,
          laneIds,
          allowedVehicleTypes: ALL_VEHICLES,
          roadClass: policy?.roadClass ?? (arterial ? 'arterial' : 'local'),
          direction: policy?.direction ?? 'both',
          shoulder: policy?.shoulder ?? arterial,
          highwayId: policy?.highwayId,
          highwayComponent: policy?.highwayComponent,
          laneTransition: policy?.laneTransition,
          transitionPathId: policy?.transitionPathId,
          interchangeId: policy?.interchangeId,
          carriageway: policy?.carriageway,
        });
        if (
          forward &&
          reverse &&
          (policy?.roadClass === undefined ||
            policy.roadClass === 'local' ||
            policy.roadClass === 'collector')
        ) {
          this.addParkingSpaces(roadId, forward.lanes[0], reverse.lanes[0], from, to);
        }
      }
    }
  }

  private addDirectedLanes(
    roadId: string,
    from: RoadNode,
    to: RoadNode,
    laneCount: number,
    speedLimit: number,
    policy?: RoadEdge,
  ): DirectedLaneSet {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const physicalLength = Math.hypot(dx, dy);
    const ux = dx / physicalLength;
    const uy = dy / physicalLength;
    const right = { x: uy, y: -ux };
    const lanes: TrafficLane[] = [];
    for (let laneIndex = 0; laneIndex < laneCount; laneIndex++) {
      const independentCarriageway =
        policy?.highwayComponent === 'carriageway' && policy.direction !== 'both';
      const offset = independentCarriageway
        ? laneCount === 3
          ? ([-18, 0, 18][laneIndex] ?? 0)
          : laneCount === 2
            ? ([-9, 9][laneIndex] ?? 0)
            : 0
        : laneIndex === 0
          ? INNER_LANE_OFFSET
          : OUTER_LANE_OFFSET + Math.max(0, laneIndex - 1) * LANE_WIDTH;
      const start = {
        x: from.x + ux * JUNCTION_CLEARANCE + right.x * offset,
        y: from.y + uy * JUNCTION_CLEARANCE + right.y * offset,
      };
      const end = {
        x: to.x - ux * JUNCTION_CLEARANCE + right.x * offset,
        y: to.y - uy * JUNCTION_CLEARANCE + right.y * offset,
      };
      const span = Math.hypot(end.x - start.x, end.y - start.y);
      const id = `lane:${from.id}>${to.id}:${laneIndex}`;
      const basePermissions: TrafficTurn[] =
        laneCount === 1
          ? ['left', 'straight', 'right', 'u-turn']
          : laneIndex === 0
            ? ['left', 'straight', 'u-turn']
            : ['straight', 'right'];
      const lane: TrafficLane = {
        id,
        roadSegmentId: roadId,
        kind: 'travel',
        role: laneCount === 1 || laneIndex === laneCount - 1 ? 'outer' : 'inner',
        fromNodeId: from.id,
        toNodeId: to.id,
        laneIndex,
        direction: 'forward',
        width: LANE_WIDTH,
        speedLimit,
        spline: createLaneSpline(
          id,
          start,
          { x: start.x + (ux * span) / 3, y: start.y + (uy * span) / 3 },
          { x: start.x + (ux * span * 2) / 3, y: start.y + (uy * span * 2) / 3 },
          end,
          12,
        ),
        entryNodeId: from.id,
        exitNodeId: to.id,
        connectionIds: [],
        turningPermissions: basePermissions.filter(
          (turn) => !policy?.turnRestrictions.includes(turn as 'left' | 'right' | 'u-turn'),
        ),
        priority: policy?.priority ?? 2,
        intersectionId: null,
        turn: null,
        conflictLaneIds: [],
      };
      lanes.push(lane);
      this.lanesById.set(id, lane);
      this.laneList.push(lane);
      this.travelLanes.push(lane);
    }
    return { fromNodeId: from.id, toNodeId: to.id, lanes };
  }

  private buildJunctions(
    nodes: readonly RoadNode[],
    nodesById: ReadonlyMap<number, RoadNode>,
    signalNodes: ReadonlySet<number>,
  ): void {
    for (const node of nodes) {
      const incoming = node.neighbours.flatMap(
        (fromId) => this.directedSets.get(this.directedKey(fromId, node.id))?.lanes ?? [],
      );
      const outgoingSets = node.neighbours
        .map((toId) => this.directedSets.get(this.directedKey(node.id, toId)))
        .filter((set): set is DirectedLaneSet => set !== undefined);
      const outgoing = outgoingSets.flatMap((set) => set.lanes);
      const connectorIds: string[] = [];
      for (const incomingLane of incoming) {
        const connectionCountBefore = incomingLane.connectionIds.length;
        const choices = outgoingSets.filter(
          (set) => set.toNodeId !== incomingLane.fromNodeId || outgoingSets.length === 1,
        );
        for (const outgoingSet of choices) {
          const target = this.targetLaneForTurn(incomingLane, outgoingSet.lanes);
          if (!target) continue;
          const turn = this.classifyTurn(incomingLane, target);
          // A planner-approved degree-one terminal must remain routable as a
          // turnaround even when its parent arterial normally forbids U-turns.
          if (!incomingLane.turningPermissions.includes(turn) && outgoingSets.length > 1) {
            continue;
          }
          const connector = this.addConnector(node, incomingLane, target, turn);
          (incomingLane.connectionIds as string[]).push(connector.id);
          connectorIds.push(connector.id);
        }
        // Directional ramp nodes can make the only legal continuation look
        // like a geometric U-turn at an adjacent urban boundary. Preserve the
        // directed graph contract: if the normal lane rules found no exit,
        // connect to the best legal outgoing set rather than publishing a
        // stranded lane.
        if (incomingLane.connectionIds.length === connectionCountBefore) {
          const fallbackSet =
            outgoingSets.find((set) => set.toNodeId !== incomingLane.fromNodeId) ?? outgoingSets[0];
          const target = fallbackSet
            ? this.targetLaneForTurn(incomingLane, fallbackSet.lanes)
            : null;
          if (target) {
            const turn = this.classifyTurn(incomingLane, target);
            const connector = this.addConnector(node, incomingLane, target, turn);
            (incomingLane.connectionIds as string[]).push(connector.id);
            connectorIds.push(connector.id);
          }
        }
      }
      const roundaboutConnector = connectorIds.some(
        (id) => this.lanesById.get(id)?.kind === 'roundabout',
      );
      const kind = roundaboutConnector ? 'roundabout' : this.classifyNodeKind(node, nodesById);
      const control = signalNodes.has(node.id)
        ? 'signal'
        : kind === 'roundabout'
          ? 'roundabout'
          : node.neighbours.length > 1
            ? 'priority'
            : 'uncontrolled';
      this.junctionsById.set(node.id, {
        id: node.id,
        kind,
        control,
        center: { x: node.x, y: node.y },
        radius: JUNCTION_CLEARANCE,
        incomingLaneIds: incoming.map((lane) => lane.id),
        outgoingLaneIds: outgoing.map((lane) => lane.id),
        connectorLaneIds: connectorIds,
        priorityRule:
          control === 'signal'
            ? 'signals'
            : control === 'roundabout'
              ? 'roundabout'
              : node.neighbours.length <= 1
                ? 'dead-end'
                : 'yield-to-right',
      });
    }
  }

  private addConnector(
    junction: RoadNode,
    incoming: TrafficLane,
    outgoing: TrafficLane,
    turn: TrafficTurn,
  ): TrafficLane {
    const startPose = sampleSpline(incoming.spline, incoming.spline.length);
    const endPose = sampleSpline(outgoing.spline, 0);
    const chord = Math.hypot(
      endPose.point.x - startPose.point.x,
      endPose.point.y - startPose.point.y,
    );
    const handle = clamp(chord * 0.45, CONNECTOR_HANDLE_MIN, CONNECTOR_HANDLE_MAX);
    const id = `connector:${junction.id}:${incoming.id}:${outgoing.id}`;
    const incomingRoad = this.road(incoming.roadSegmentId);
    const outgoingRoad = this.road(outgoing.roadSegmentId);
    const mainlineContinuation =
      incomingRoad?.highwayComponent === 'carriageway' &&
      outgoingRoad?.highwayComponent === 'carriageway' &&
      incomingRoad.highwayId === outgoingRoad.highwayId &&
      incomingRoad.carriageway === outgoingRoad.carriageway;
    const highwayExit =
      incomingRoad?.highwayComponent === 'carriageway' &&
      (outgoingRoad?.highwayComponent === 'exit-ramp' ||
        outgoingRoad?.highwayComponent === 'service-road');
    const highwayMerge =
      (incomingRoad?.highwayComponent === 'entry-ramp' ||
        incomingRoad?.highwayComponent === 'slip-road' ||
        incomingRoad?.highwayComponent === 'service-road') &&
      outgoingRoad?.highwayComponent === 'carriageway';
    const roundaboutMerge =
      outgoingRoad?.highwayComponent === 'collector-road' &&
      outgoingRoad.laneTransition === 'merge' &&
      incomingRoad?.transitionPathId !== outgoingRoad.transitionPathId;
    const transitionContinuation =
      incomingRoad?.interchangeId !== undefined &&
      incomingRoad.interchangeId === outgoingRoad?.interchangeId &&
      !highwayMerge &&
      !highwayExit &&
      !roundaboutMerge;
    const connectorKind = roundaboutMerge
      ? 'roundabout'
      : highwayExit
      ? 'exit'
      : mainlineContinuation || highwayMerge || transitionContinuation
        ? 'merge'
        : turn === 'straight'
          ? 'merge'
          : 'turn';
    const lane: TrafficLane = {
      id,
      roadSegmentId: null,
      kind: connectorKind,
      role: 'connector',
      fromNodeId: incoming.fromNodeId,
      toNodeId: outgoing.toNodeId,
      laneIndex: outgoing.laneIndex,
      direction: 'forward',
      width: LANE_WIDTH,
      speedLimit: mainlineContinuation
        ? Math.min(incoming.speedLimit, outgoing.speedLimit)
        : highwayExit
          ? Math.min(incoming.speedLimit, outgoing.speedLimit, 120)
          : highwayMerge
            ? Math.min(incoming.speedLimit, outgoing.speedLimit, 110)
            : roundaboutMerge
              ? Math.min(incoming.speedLimit, outgoing.speedLimit, 72)
              : transitionContinuation
                ? Math.min(incoming.speedLimit, outgoing.speedLimit)
            : turn === 'straight'
              ? Math.min(incoming.speedLimit, 105)
              : turn === 'right'
                ? 76
                : 68,
      spline: createLaneSpline(
        id,
        startPose.point,
        {
          x: startPose.point.x + startPose.tangent.x * handle,
          y: startPose.point.y + startPose.tangent.y * handle,
        },
        {
          x: endPose.point.x - endPose.tangent.x * handle,
          y: endPose.point.y - endPose.tangent.y * handle,
        },
        endPose.point,
        24,
      ),
      entryNodeId: junction.id,
      exitNodeId: junction.id,
      connectionIds: [outgoing.id],
      turningPermissions: [turn],
      priority: mainlineContinuation
        ? 5
        : highwayExit || transitionContinuation
          ? 4
          : highwayMerge
            ? 3
            : roundaboutMerge
              ? 2
          : turn === 'straight'
            ? 3
            : turn === 'right'
              ? 2
              : 1,
      intersectionId:
        mainlineContinuation || highwayExit || transitionContinuation ? null : junction.id,
      turn,
      conflictLaneIds: [],
    };
    this.lanesById.set(id, lane);
    this.laneList.push(lane);
    return lane;
  }

  private buildConflictSets(): void {
    for (const junction of this.junctionsById.values()) {
      const connectors = junction.connectorLaneIds
        .map((id) => this.lanesById.get(id))
        .filter((lane): lane is TrafficLane => lane !== undefined);
      for (let firstIndex = 0; firstIndex < connectors.length; firstIndex++) {
        const first = connectors[firstIndex];
        if (!first) continue;
        for (let secondIndex = firstIndex + 1; secondIndex < connectors.length; secondIndex++) {
          const second = connectors[secondIndex];
          if (!second || !this.connectorPathsConflict(first, second)) continue;
          (first.conflictLaneIds as string[]).push(second.id);
          (second.conflictLaneIds as string[]).push(first.id);
        }
      }
    }
  }

  private connectorPathsConflict(first: TrafficLane, second: TrafficLane): boolean {
    const firstIncoming = first.id.split(':lane:')[1]?.split(':connector:')[0] ?? first.id;
    const secondIncoming = second.id.split(':lane:')[1]?.split(':connector:')[0] ?? second.id;
    if (firstIncoming === secondIncoming) return true;
    const firstExit = first.connectionIds[0];
    const secondExit = second.connectionIds[0];
    if (firstExit && firstExit === secondExit) return true;
    const thresholdSq = (LANE_WIDTH * 0.78) ** 2;
    for (let a = 0.18; a <= 0.82; a += 0.1) {
      const pointA = sampleSpline(first.spline, first.spline.length * a).point;
      for (let b = 0.18; b <= 0.82; b += 0.1) {
        const pointB = sampleSpline(second.spline, second.spline.length * b).point;
        const dx = pointA.x - pointB.x;
        const dy = pointA.y - pointB.y;
        if (dx * dx + dy * dy <= thresholdSq) return true;
      }
    }
    return false;
  }

  private addParkingSpaces(
    roadId: string,
    forward: TrafficLane | undefined,
    reverse: TrafficLane | undefined,
    from: RoadNode,
    to: RoadNode,
  ): void {
    if (!forward || !reverse) return;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    const ux = dx / length;
    const uy = dy / length;
    const right = { x: uy, y: -ux };
    const margin = JUNCTION_CLEARANCE + 42;
    const usable = length - margin * 2;
    const count = Math.max(0, Math.floor(usable / 72));
    for (let index = 0; index < count; index++) {
      const along = margin + ((index + 0.5) * usable) / Math.max(1, count);
      this.addParkingSpace(roadId, forward, from, ux, uy, right, along, PARKING_OFFSET, index);
      this.addParkingSpace(roadId, reverse, from, ux, uy, right, along, -PARKING_OFFSET, index);
    }
  }

  /** Attach rest-area parking bays to their nearest one-way service lane. */
  private addAuthoredParkingSpaces(sites: readonly Vector2[]): void {
    for (let index = 0; index < sites.length; index++) {
      const position = sites[index];
      if (!position) continue;
      let bestLane: TrafficLane | undefined;
      let bestProjection: SplineProjection | undefined;
      for (const lane of this.travelLanes) {
        const road = this.roadsById.get(lane.roadSegmentId ?? '');
        if (road?.highwayComponent !== 'service-road') continue;
        const projection = projectOnSpline(position, lane.spline);
        if (!bestProjection || projection.distanceSq < bestProjection.distanceSq) {
          bestLane = lane;
          bestProjection = projection;
        }
      }
      if (!bestLane || !bestProjection || bestProjection.distanceSq > 420 * 420) continue;
      this.parkingList.push({
        id: `parking:rest-area:${index}`,
        roadSegmentId: bestLane.roadSegmentId ?? '',
        adjacentLaneId: bestLane.id,
        position: { ...position },
        heading: bestProjection.heading,
        width: 26,
        length: 50,
        distanceFromIntersection: Math.min(
          bestProjection.distance,
          bestLane.spline.length - bestProjection.distance,
        ),
      });
    }
  }

  private addParkingSpace(
    roadId: string,
    lane: TrafficLane,
    origin: RoadNode,
    ux: number,
    uy: number,
    right: Vector2,
    along: number,
    offset: number,
    index: number,
  ): void {
    const heading = sampleSpline(lane.spline, lane.spline.length * 0.5).heading;
    this.parkingList.push({
      id: `parking:${roadId}:${offset > 0 ? 'a' : 'b'}:${index}`,
      roadSegmentId: roadId,
      adjacentLaneId: lane.id,
      position: {
        x: origin.x + ux * along + right.x * offset,
        y: origin.y + uy * along + right.y * offset,
      },
      heading,
      width: 17,
      length: 42,
      distanceFromIntersection: JUNCTION_CLEARANCE + 42,
    });
  }

  private targetLaneForTurn(
    incoming: TrafficLane,
    outgoing: readonly TrafficLane[],
  ): TrafficLane | null {
    if (outgoing.length === 0) return null;
    const provisional = outgoing[Math.min(incoming.laneIndex, outgoing.length - 1)] ?? outgoing[0];
    if (!provisional) return null;
    const turn = this.classifyTurn(incoming, provisional);
    if (turn === 'left') return outgoing[0] ?? null;
    if (turn === 'right') return outgoing[outgoing.length - 1] ?? null;
    return provisional;
  }

  private classifyTurn(incoming: TrafficLane, outgoing: TrafficLane): TrafficTurn {
    const incomingHeading = sampleSpline(incoming.spline, incoming.spline.length).heading;
    const outgoingHeading = sampleSpline(outgoing.spline, 0).heading;
    const delta = wrapAngle(outgoingHeading - incomingHeading);
    if (Math.abs(delta) < Math.PI * 0.22) return 'straight';
    if (Math.abs(delta) > Math.PI * 0.78) return 'u-turn';
    return delta > 0 ? 'right' : 'left';
  }

  private classifyNodeKind(
    node: RoadNode,
    nodesById: ReadonlyMap<number, RoadNode>,
  ): TrafficNodeKind {
    if (node.neighbours.length <= 1) return 'exit-node';
    if (node.neighbours.length === 2) {
      const first = nodesById.get(node.neighbours[0] ?? -1);
      const second = nodesById.get(node.neighbours[1] ?? -1);
      if (first && second) {
        const firstHeading = Math.atan2(first.y - node.y, first.x - node.x);
        const secondHeading = Math.atan2(second.y - node.y, second.x - node.x);
        if (Math.abs(Math.abs(wrapAngle(secondHeading - firstHeading)) - Math.PI) > 0.25) {
          return 'turn-node';
        }
      }
      return 'merge-node';
    }
    return node.neighbours.length === 3 ? 'merge-node' : 'intersection';
  }

  private isArterial(from: RoadNode, to: RoadNode): boolean {
    const topology = from.neighbours.length + to.neighbours.length;
    const stableClass = Math.abs((from.id * 31 + to.id * 17) % 5);
    return topology >= 7 && stableClass <= 1;
  }

  private edgePairKey(firstId: number, secondId: number): string {
    return firstId < secondId ? `${firstId}:${secondId}` : `${secondId}:${firstId}`;
  }

  private farthestReachableTravelLane(start: TrafficLane): TrafficLane | null {
    const visited = new Set<string>([start.id]);
    let frontier: TrafficLane[] = [start];
    let farthest: TrafficLane | null = start.kind === 'travel' ? start : null;
    for (let depth = 0; depth < 32 && frontier.length > 0; depth++) {
      const next: TrafficLane[] = [];
      for (const lane of frontier) {
        for (const id of lane.connectionIds) {
          if (visited.has(id)) continue;
          const candidate = this.lanesById.get(id);
          if (!candidate) continue;
          visited.add(id);
          next.push(candidate);
          if (candidate.kind === 'travel') farthest = candidate;
        }
      }
      frontier = next;
    }
    return farthest && farthest.id !== start.id ? farthest : null;
  }

  private buildSpatialIndexes(): void {
    for (const lane of this.laneList) {
      const steps = Math.max(1, Math.ceil(lane.spline.length / 110));
      const seen = new Set<string>();
      for (let index = 0; index <= steps; index++) {
        const point = sampleSpline(lane.spline, (lane.spline.length * index) / steps).point;
        const key = this.cellKey(point.x, point.y);
        if (seen.has(key)) continue;
        seen.add(key);
        const bucket = this.laneIndex.get(key);
        if (bucket) bucket.push(lane);
        else this.laneIndex.set(key, [lane]);
      }
    }
    for (const space of this.parkingList) {
      const key = this.cellKey(space.position.x, space.position.y);
      const bucket = this.parkingIndex.get(key);
      if (bucket) bucket.push(space);
      else this.parkingIndex.set(key, [space]);
    }
  }

  private forEachIndexedLane(
    position: Vector2,
    radius: number,
    visitor: (lane: TrafficLane) => void,
  ): void {
    const minX = Math.floor((position.x - radius) / LANE_INDEX_CELL);
    const maxX = Math.floor((position.x + radius) / LANE_INDEX_CELL);
    const minY = Math.floor((position.y - radius) / LANE_INDEX_CELL);
    const maxY = Math.floor((position.y + radius) / LANE_INDEX_CELL);
    const visited = new Set<string>();
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        for (const lane of this.laneIndex.get(this.cellKeyFromCell(x, y)) ?? []) {
          if (visited.has(lane.id)) continue;
          visited.add(lane.id);
          visitor(lane);
        }
      }
    }
  }

  private findSignalNodes(
    nodes: readonly RoadNode[],
    lights: readonly TrafficLightInfo[],
  ): Set<number> {
    const result = new Set<number>();
    for (const light of lights) {
      let nearest: RoadNode | null = null;
      let nearestSq = 72 * 72;
      for (const node of nodes) {
        const dx = node.x - light.x;
        const dy = node.y - light.y;
        const distanceSq = dx * dx + dy * dy;
        if (distanceSq < nearestSq) {
          nearest = node;
          nearestSq = distanceSq;
        }
      }
      if (nearest) result.add(nearest.id);
    }
    return result;
  }

  private roadId(first: number, second: number): string {
    return `road:${Math.min(first, second)}-${Math.max(first, second)}`;
  }

  private directedKey(from: number, to: number): string {
    return `${from}>${to}`;
  }

  private cellKey(x: number, y: number): string {
    return this.cellKeyFromCell(Math.floor(x / LANE_INDEX_CELL), Math.floor(y / LANE_INDEX_CELL));
  }

  private cellKeyFromCell(x: number, y: number): string {
    return `${x},${y}`;
  }
}
