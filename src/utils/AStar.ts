/**
 * Generic A* pathfinding over an abstract graph.
 *
 * Deliberately decoupled from any specific world representation: a caller
 * supplies an {@link IPathGraph} adapter (e.g. a windowed tile grid for
 * pedestrians, or — later — the sparse road-node graph for vehicles) and gets
 * the same search back. Kept dependency-free so it stays trivially reusable
 * and reasoned-about in isolation.
 */

/** An abstract graph A* can search: identity, adjacency, cost and heuristic. */
export interface IPathGraph<TNode> {
  /** Stable identity for a node, used for map/set membership. */
  key(node: TNode): number | string;
  /** Nodes reachable in one step from `node`. */
  neighbours(node: TNode): Iterable<TNode>;
  /** Cost of stepping from `from` to the adjacent `to`. */
  cost(from: TNode, to: TNode): number;
  /** Admissible estimate of the remaining cost from `node` to `goal`. */
  heuristic(node: TNode, goal: TNode): number;
}

/** Tuning knobs for a single {@link findPath} call. */
export interface AStarOptions {
  /** Expansion budget before the search gives up (default 2000). */
  maxExpansions?: number;
  /**
   * When true, a search that exhausts its budget or open set without reaching
   * the goal returns the best partial path toward it (by heuristic distance)
   * instead of failing outright.
   */
  allowPartial?: boolean;
}

/** The outcome of a search: the path found and whether it reaches the goal. */
export interface AStarResult<TNode> {
  /** Waypoints from start to goal (or as far as the search reached). */
  path: TNode[];
  /** Whether `path` actually reaches the goal node. */
  complete: boolean;
}

/** Default expansion budget, generous enough for a ~32x32-tile search window. */
const DEFAULT_MAX_EXPANSIONS = 2000;

/** Binary min-heap keyed by an external priority; the A* open set. */
class MinHeap<T> {
  private readonly items: Array<{ priority: number; value: T }> = [];

  public get size(): number {
    return this.items.length;
  }

  public push(value: T, priority: number): void {
    this.items.push({ priority, value });
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const parentItem = this.items[parent];
      const item = this.items[i];
      if (!parentItem || !item || parentItem.priority <= item.priority) break;
      this.items[parent] = item;
      this.items[i] = parentItem;
      i = parent;
    }
  }

  public pop(): T | undefined {
    const top = this.items[0];
    if (!top) return undefined;
    const last = this.items.pop();
    if (this.items.length > 0 && last) {
      this.items[0] = last;
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        const right = i * 2 + 2;
        let smallest = i;
        const leftItem = this.items[left];
        const rightItem = this.items[right];
        const smallestItem = this.items[smallest];
        if (leftItem && smallestItem && leftItem.priority < smallestItem.priority) {
          smallest = left;
        }
        const smallestAfterLeft = this.items[smallest];
        if (rightItem && smallestAfterLeft && rightItem.priority < smallestAfterLeft.priority) {
          smallest = right;
        }
        if (smallest === i) break;
        const a = this.items[i];
        const b = this.items[smallest];
        if (!a || !b) break;
        this.items[i] = b;
        this.items[smallest] = a;
        i = smallest;
      }
    }
    return top.value;
  }
}

/**
 * Search `graph` from `start` to `goal` with A*.
 * @returns The path (and whether it's complete), or `null` when no path — not
 *   even a partial one — could be produced (only possible when `allowPartial`
 *   is false or falsy and the goal is unreachable within the expansion budget).
 */
export function findPath<TNode>(
  graph: IPathGraph<TNode>,
  start: TNode,
  goal: TNode,
  options: AStarOptions = {},
): AStarResult<TNode> | null {
  const maxExpansions = options.maxExpansions ?? DEFAULT_MAX_EXPANSIONS;
  const allowPartial = options.allowPartial ?? false;

  const startKey = graph.key(start);
  const goalKey = graph.key(goal);

  if (startKey === goalKey) {
    return { path: [start], complete: true };
  }

  const gScore = new Map<number | string, number>([[startKey, 0]]);
  const cameFrom = new Map<number | string, TNode>();
  const nodeByKey = new Map<number | string, TNode>([[startKey, start]]);
  const closed = new Set<number | string>();

  const open = new MinHeap<TNode>();
  open.push(start, graph.heuristic(start, goal));

  let bestKey = startKey;
  let bestHeuristic = graph.heuristic(start, goal);

  let expansions = 0;
  while (open.size > 0 && expansions < maxExpansions) {
    const current = open.pop();
    if (current === undefined) break;
    const currentKey = graph.key(current);
    if (closed.has(currentKey)) continue;
    closed.add(currentKey);
    expansions++;

    if (currentKey === goalKey) {
      return {
        path: reconstructPath(cameFrom, current, startKey, graph),
        complete: true,
      };
    }

    const h = graph.heuristic(current, goal);
    if (h < bestHeuristic) {
      bestHeuristic = h;
      bestKey = currentKey;
    }

    const g = gScore.get(currentKey) ?? 0;
    for (const next of graph.neighbours(current)) {
      const nextKey = graph.key(next);
      if (closed.has(nextKey)) continue;
      const tentative = g + graph.cost(current, next);
      if (tentative < (gScore.get(nextKey) ?? Infinity)) {
        gScore.set(nextKey, tentative);
        cameFrom.set(nextKey, current);
        nodeByKey.set(nextKey, next);
        open.push(next, tentative + graph.heuristic(next, goal));
      }
    }
  }

  if (!allowPartial) return null;
  const bestNode = nodeByKey.get(bestKey);
  if (!bestNode) return null;
  return {
    path: reconstructPath(cameFrom, bestNode, startKey, graph),
    complete: false,
  };
}

/** Walk `cameFrom` back from `end` to the start, then reverse into path order. */
function reconstructPath<TNode>(
  cameFrom: Map<number | string, TNode>,
  end: TNode,
  startKey: number | string,
  graph: IPathGraph<TNode>,
): TNode[] {
  const path: TNode[] = [end];
  let currentKey = graph.key(end);
  while (currentKey !== startKey) {
    const prev = cameFrom.get(currentKey);
    if (!prev) break;
    path.push(prev);
    currentKey = graph.key(prev);
  }
  path.reverse();
  return path;
}
