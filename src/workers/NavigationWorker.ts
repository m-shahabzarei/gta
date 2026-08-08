import { findPath, type IPathGraph } from '@/utils/AStar';
import type { NavAgentProfile } from '@/gameplay/types';

const WINDOW_MARGIN_TILES = 8;
const MAX_WINDOW_HALF_TILES = 24;
const MAX_EXPANSIONS = 900;

interface InitMessage {
  type: 'init';
  width: number;
  height: number;
  pedestrianCosts: Uint8Array;
  policeCosts: Uint8Array;
}

interface PathMessage {
  type: 'path';
  id: number;
  start: number;
  goal: number;
  profile: NavAgentProfile;
}

type RequestMessage = InitMessage | PathMessage;

class WorkerAgentGraph implements IPathGraph<number> {
  constructor(
    private readonly width: number,
    private readonly height: number,
    private readonly costs: Uint8Array,
    private readonly minX: number,
    private readonly minY: number,
    private readonly maxX: number,
    private readonly maxY: number,
  ) {}

  public key(node: number): number {
    return node;
  }

  public *neighbours(node: number): Iterable<number> {
    const x = node % this.width;
    const y = Math.floor(node / this.width);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < this.minX || nx > this.maxX || ny < this.minY || ny > this.maxY) continue;
        if (!this.walkable(nx, ny)) continue;
        if (dx !== 0 && dy !== 0 && (!this.walkable(x + dx, y) || !this.walkable(x, y + dy))) {
          continue;
        }
        yield ny * this.width + nx;
      }
    }
  }

  public cost(from: number, to: number): number {
    const diagonal =
      from % this.width !== to % this.width &&
      Math.floor(from / this.width) !== Math.floor(to / this.width);
    return (diagonal ? Math.SQRT2 : 1) * Math.max(1, this.costs[to] ?? 1);
  }

  public heuristic(node: number, goal: number): number {
    const x1 = node % this.width;
    const y1 = Math.floor(node / this.width);
    const x2 = goal % this.width;
    const y2 = Math.floor(goal / this.width);
    return Math.hypot(x2 - x1, y2 - y1);
  }

  private walkable(x: number, y: number): boolean {
    return (
      x >= 0 &&
      y >= 0 &&
      x < this.width &&
      y < this.height &&
      (this.costs[y * this.width + x] ?? 0) > 0
    );
  }
}

let width = 0;
let height = 0;
let pedestrianCosts: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
let policeCosts: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<RequestMessage>) => void) | null;
  postMessage(message: unknown): void;
};

scope.onmessage = (event): void => {
  const message = event.data;
  if (message.type === 'init') {
    width = message.width;
    height = message.height;
    pedestrianCosts = message.pedestrianCosts;
    policeCosts = message.policeCosts;
    scope.postMessage({ type: 'ready' });
    return;
  }
  if (width === 0 || height === 0) return;

  const startedAt = performance.now();
  const result = search(message.start, message.goal, message.profile);
  scope.postMessage({
    type: 'result',
    id: message.id,
    path: result?.path ?? null,
    complete: result?.complete ?? false,
    elapsedMs: performance.now() - startedAt,
  });
};

function search(
  start: number,
  goal: number,
  profile: NavAgentProfile,
): { path: number[]; complete: boolean } | null {
  const startX = start % width;
  const startY = Math.floor(start / width);
  const goalX = goal % width;
  const goalY = Math.floor(goal / width);

  for (const [margin, allowPartial] of [
    [WINDOW_MARGIN_TILES, false],
    [WINDOW_MARGIN_TILES * 2, true],
  ] as const) {
    const minX = clamp(
      Math.max(Math.min(startX, goalX) - margin, startX - MAX_WINDOW_HALF_TILES),
      0,
      width - 1,
    );
    const maxX = clamp(
      Math.min(Math.max(startX, goalX) + margin, startX + MAX_WINDOW_HALF_TILES),
      0,
      width - 1,
    );
    const minY = clamp(
      Math.max(Math.min(startY, goalY) - margin, startY - MAX_WINDOW_HALF_TILES),
      0,
      height - 1,
    );
    const maxY = clamp(
      Math.min(Math.max(startY, goalY) + margin, startY + MAX_WINDOW_HALF_TILES),
      0,
      height - 1,
    );
    const costs = profile === 'police' ? policeCosts : pedestrianCosts;
    const graph = new WorkerAgentGraph(width, height, costs, minX, minY, maxX, maxY);
    const result = findPath(graph, start, goal, { maxExpansions: MAX_EXPANSIONS, allowPartial });
    if (result && (result.complete || allowPartial)) return result;
  }
  return null;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export {};
