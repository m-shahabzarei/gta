/**
 * NavigationSystem — pathfinding and local-avoidance service for AI.
 *
 * Implements {@link INavigationService}. For each request it builds a small
 * tile-grid graph windowed to the start/goal bounding box (so search cost
 * stays proportional to how far an agent is actually travelling, not the
 * whole 1920x1408 world), searches it with the generic {@link findPath} A*,
 * widening the window once if the goal isn't reached, and simplifies the
 * result into a short waypoint list. Requests are queued and drained a few at
 * a time per frame so a burst (e.g. a crowd panicking from one explosion)
 * spreads its cost across frames instead of spiking.
 *
 * `queryNearby` is a plain per-call scan over the pedestrian/city-life/police/
 * vehicle groups — with population bounded to roughly a hundred live agents,
 * there is no need for a persistent spatial index.
 *
 * Currently only serves pedestrians; the windowed-graph/queue machinery is
 * generic enough that a future vehicle profile can reuse it over the
 * (already-existing but currently unused) road-node graph.
 */
import Phaser from 'phaser';
import { BaseSceneManager } from '@/core/BaseSceneManager';
import { ServiceLocator } from '@/core/ServiceLocator';
import { ServiceKeys } from '@/config/ServiceKeys';
import { ENGINE_LIMITS } from '@/config/EngineLimits';
import { EngineDiagnostics } from '@/core/EngineDiagnostics';
import { DepthLayers } from '@/config/DepthLayers';
import { DebugFlags } from '@/config/DebugFlags';
import { TILE_SIZE, WORLD_TILES_X, WORLD_TILES_Y } from '@/config/Constants';
import type { Vector2 } from '@/core/types';
import type {
  INavigationService,
  IWorldQuery,
  MapData,
  NavAgentProfile,
  NavPathCallback,
  NavPathResult,
  NeighbourInfo,
} from '@/gameplay/types';
import type { AStarResult, IPathGraph } from '@/utils';
import { findPath, LruCache, simplifyWaypoints } from '@/utils';
import { EntityCategory, type EntityManager } from '@/systems/EntityManager';

/** Hard request-count and wall-time limits prevent crowd replans from spiking a frame. */
const MAX_REQUESTS_PER_FRAME = 8;
const REQUEST_BUDGET_MS = 1.5;

/** Shared pedestrian paths are immutable in the cache and materialized per request. */
const PATH_CACHE_CAPACITY = 512;
const MAX_WORKER_IN_FLIGHT = ENGINE_LIMITS.MAX_PATHFINDING_IN_FLIGHT;

/** Margin (tiles) added around the start/goal bounding box for the first search attempt. */
const WINDOW_MARGIN_TILES = 8;

/**
 * Largest half-extent (tiles), from the start node, the search window may
 * ever grow to. Kept modest relative to how far any pedestrian destination
 * actually is in practice (wander/flee/bench/entrance targets are all well
 * under 300px) — every expansion is a generator invocation plus several
 * Map/heap entries, so a search that burns its full budget in a worst case
 * (e.g. many pedestrians re-planning at once after a crowd panic) should stay
 * cheap rather than scale up to searching a huge window.
 */
const MAX_WINDOW_HALF_TILES = 24;

/** Expansion budget per A* attempt (see {@link MAX_WINDOW_HALF_TILES} for the reasoning). */
const MAX_EXPANSIONS = 900;

/** Sampling step (px) used by line-of-sight / path-simplification checks. */
const LOS_SAMPLE_STEP_PX = 8;

/** Structural view of the world manager exposing the generated map (for debug draw). */
interface WorldMapProvider extends IWorldQuery {
  readonly map: MapData;
}

/** A queued path request awaiting its turn under the per-frame budget. */
interface QueuedRequest {
  id: number;
  from: Vector2;
  to: Vector2;
  profile: NavAgentProfile;
  priority: number;
  onResult: NavPathCallback;
  cancelled: boolean;
  queuedAt: number;
  sentAt: number | null;
}

interface WorkerResultMessage {
  type: 'ready' | 'result';
  id?: number;
  path?: number[] | null;
  complete?: boolean;
  elapsedMs?: number;
}

/** A windowed tile-grid graph for on-foot pathfinding; nodes are packed `ty * WORLD_TILES_X + tx`. */
class WindowedAgentGraph implements IPathGraph<number> {
  constructor(
    private readonly world: IWorldQuery,
    private readonly profile: NavAgentProfile,
    private readonly minTx: number,
    private readonly minTy: number,
    private readonly maxTx: number,
    private readonly maxTy: number,
  ) {}

  public key(node: number): number {
    return node;
  }

  public *neighbours(node: number): Iterable<number> {
    const tx = node % WORLD_TILES_X;
    const ty = Math.floor(node / WORLD_TILES_X);

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = tx + dx;
        const ny = ty + dy;
        if (nx < this.minTx || nx > this.maxTx || ny < this.minTy || ny > this.maxTy) continue;

        if (!this.isWalkableTile(nx, ny)) continue;

        // Prevent corner-cutting: a diagonal step is only valid when both
        // orthogonal flanking cells are walkable too.
        if (dx !== 0 && dy !== 0) {
          if (!this.isWalkableTile(tx + dx, ty) || !this.isWalkableTile(tx, ty + dy)) continue;
        }

        yield ny * WORLD_TILES_X + nx;
      }
    }
  }

  public cost(from: number, to: number): number {
    const tx1 = from % WORLD_TILES_X;
    const ty1 = Math.floor(from / WORLD_TILES_X);
    const tx2 = to % WORLD_TILES_X;
    const ty2 = Math.floor(to / WORLD_TILES_X);
    const diagonal = tx1 !== tx2 && ty1 !== ty2;
    const base = diagonal ? Math.SQRT2 : 1;
    return base * this.world.pedestrianTileCost(tileCentreX(tx2), tileCentreY(ty2));
  }

  public heuristic(node: number, goal: number): number {
    const tx1 = node % WORLD_TILES_X;
    const ty1 = Math.floor(node / WORLD_TILES_X);
    const tx2 = goal % WORLD_TILES_X;
    const ty2 = Math.floor(goal / WORLD_TILES_X);
    return Math.hypot(tx2 - tx1, ty2 - ty1);
  }

  private isWalkableTile(tx: number, ty: number): boolean {
    if (tx < 0 || ty < 0 || tx >= WORLD_TILES_X || ty >= WORLD_TILES_Y) return false;
    const x = tileCentreX(tx);
    const y = tileCentreY(ty);
    return this.profile === 'police'
      ? !this.world.isSolidAtWorld(x, y)
      : this.world.isPedestrianWalkableAtWorld(x, y);
  }
}

function tileCentreX(tx: number): number {
  return tx * TILE_SIZE + TILE_SIZE / 2;
}
function tileCentreY(ty: number): number {
  return ty * TILE_SIZE + TILE_SIZE / 2;
}
/**
 * Pack a world position into a tile-node id. Clamped into the valid tile
 * range so an out-of-bounds coordinate degrades to the nearest edge tile
 * instead of silently aliasing to a different, unrelated tile (packing
 * `ty * WORLD_TILES_X + tx` has no natural bounds-check of its own — a
 * negative `tx` would borrow into `ty`'s bits on unpack).
 */
function worldToTileIndex(x: number, y: number): number {
  const tx = clampInt(Math.floor(x / TILE_SIZE), 0, WORLD_TILES_X - 1);
  const ty = clampInt(Math.floor(y / TILE_SIZE), 0, WORLD_TILES_Y - 1);
  return ty * WORLD_TILES_X + tx;
}

export class NavigationSystem extends BaseSceneManager implements INavigationService {
  /** Service-locator key for this system. */
  public readonly key = ServiceKeys.Navigation;

  /** Pending path requests, drained a few at a time per frame. */
  private readonly queue: QueuedRequest[] = [];

  /** Monotonic id source for queued requests. */
  private nextRequestId = 1;

  /** Cached world reference; resolved lazily and memoised. */
  private world: WorldMapProvider | null = null;

  /** Central dynamic spatial index shared with physics, interaction and traffic. */
  private entityManager: EntityManager | null = null;

  /** Bounded shared navigation cache; paths are cloned before delivery. */
  private readonly pathCache = new LruCache<string, NavPathResult>(PATH_CACHE_CAPACITY);
  private cacheHitsValue = 0;
  private cacheMissesValue = 0;
  private lastPathfindingMsValue = 0;
  private worker: Worker | null = null;
  private workerReady = false;
  private readonly workerPending = new Map<number, QueuedRequest>();

  /** Lazily-created debug overlay graphics, only while {@link DebugFlags.navigation} is on. */
  private debugGraphics: Phaser.GameObjects.Graphics | null = null;

  /** No headless state to prepare; everything is resolved lazily on attach/use. */
  protected onInit(): void {
    // Intentionally empty.
  }

  /** Wire the debug-draw hotkey for the attached scene. */
  protected override onAttach(scene: Phaser.Scene): void {
    this.world = null;
    this.entityManager = null;
    this.startWorker();
    scene.input.keyboard?.on('keydown-F6', this.toggleDebugDraw, this);
  }

  /** Release scene-scoped state and the debug overlay. */
  protected override onDetach(scene: Phaser.Scene): void {
    scene.input.keyboard?.off('keydown-F6', this.toggleDebugDraw, this);
    this.debugGraphics?.destroy();
    this.debugGraphics = null;
    this.queue.length = 0;
    this.world = null;
    this.entityManager = null;
    this.worker?.terminate();
    this.worker = null;
    this.workerReady = false;
    this.workerPending.clear();
    this.pathCache.clear();
    this.cacheHitsValue = 0;
    this.cacheMissesValue = 0;
    this.lastPathfindingMsValue = 0;
  }

  /** Drain the request queue under budget, then refresh the debug overlay. */
  public update(_time: number, _delta: number): void {
    this.recoverTimedOutWorkerRequests();
    this.processQueue();
    this.redrawDebug();
  }

  public get queuedRequests(): number {
    return this.queue.length + this.workerPending.size;
  }

  public get cacheSize(): number {
    return this.pathCache.size;
  }

  public get cacheHits(): number {
    return this.cacheHitsValue;
  }

  public get cacheMisses(): number {
    return this.cacheMissesValue;
  }

  public get lastPathfindingMs(): number {
    return this.lastPathfindingMsValue;
  }

  public get usingWorker(): boolean {
    return this.workerReady;
  }

  // ── INavigationService ──────────────────────────────────────────────────

  /** Queue a path request; `onResult` fires once it's processed (possibly a few frames later). */
  public requestPath(
    from: Vector2,
    to: Vector2,
    profile: NavAgentProfile,
    onResult: NavPathCallback,
    priority = 10,
  ): number {
    const id = this.nextRequestId++;
    if (this.queue.length + this.workerPending.size >= ENGINE_LIMITS.MAX_PATHFINDING_QUEUE) {
      EngineDiagnostics.recordLimitExceeded(
        'MAX_PATHFINDING_QUEUE',
        this.queue.length + this.workerPending.size + 1,
        ENGINE_LIMITS.MAX_PATHFINDING_QUEUE,
        'rejected-path-request',
        `${Math.round(from.x)},${Math.round(from.y)}>${Math.round(to.x)},${Math.round(to.y)}`,
      );
      onResult({ waypoints: null, complete: false });
      return id;
    }
    this.queue.push({
      id,
      from: { x: from.x, y: from.y },
      to: { x: to.x, y: to.y },
      profile,
      priority,
      onResult,
      cancelled: false,
      queuedAt: performance.now(),
      sentAt: null,
    });
    return id;
  }

  /** Cancel a previously queued request; safe to call after it already resolved. */
  public cancelRequest(requestId: number): void {
    const entry = this.queue.find((r) => r.id === requestId);
    if (entry) entry.cancelled = true;
    const pending = this.workerPending.get(requestId);
    if (pending) pending.cancelled = true;
  }

  /** Instant (unqueued) straight-line walkability check between two points. */
  public isClearLine(from: Vector2, to: Vector2, profile: NavAgentProfile): boolean {
    const world = this.resolveWorld();
    if (!world) return false;
    return this.hasWalkableLine(from, to, world, profile);
  }

  /** Optical visibility ray. Roads, water and other movement rules do not occlude sight. */
  public hasLineOfSight(from: Vector2, to: Vector2): boolean {
    const world = this.resolveWorld();
    if (!world) return false;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-3) return true;
    const steps = Math.max(1, Math.ceil(dist / LOS_SAMPLE_STEP_PX));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      if (world.blocksVisionAtWorld(from.x + dx * t, from.y + dy * t)) return false;
    }
    return true;
  }

  /** Nearby dynamic agents (peds/police/vehicles) for local avoidance/separation steering. */
  public queryNearby(x: number, y: number, radius: number, excludeId?: number): NeighbourInfo[] {
    const out: NeighbourInfo[] = [];
    const entities = this.resolveEntityManager();
    if (!entities) return out;
    entities.forEachNearby(x, y, radius, (entity, _distanceSq, category) => {
      if (entity.id === excludeId || category === EntityCategory.Projectile) return;
      const body = entity.sprite.body as Phaser.Physics.Arcade.Body | null;
      if (!body) return;
      out.push({
        entityId: entity.id,
        x: entity.sprite.x,
        y: entity.sprite.y,
        vx: body.velocity.x,
        vy: body.velocity.y,
        radius: body.isCircle ? body.radius : Math.max(body.width, body.height) / 2,
      });
    });
    return out;
  }

  // ── Request processing ───────────────────────────────────────────────────

  /** Sort by priority and resolve up to {@link MAX_REQUESTS_PER_FRAME} requests. */
  private processQueue(): void {
    this.lastPathfindingMsValue *= 0.96;
    if (this.queue.length === 0) return;
    if (this.worker && !this.workerReady) return;
    this.queue.sort((a, b) => a.priority - b.priority);

    const startedAt = performance.now();
    let processed = 0;
    while (processed < MAX_REQUESTS_PER_FRAME && this.queue.length > 0) {
      if (processed > 0 && performance.now() - startedAt >= REQUEST_BUDGET_MS) break;
      if (this.workerReady && this.workerPending.size >= MAX_WORKER_IN_FLIGHT) break;
      const request = this.queue.shift();
      if (!request) break;
      if (request.cancelled) continue;
      processed++;
      this.resolveRequest(request);
    }
    const elapsed = performance.now() - startedAt;
    this.lastPathfindingMsValue += (elapsed - this.lastPathfindingMsValue) * 0.2;
  }

  /** Resolve one request against the current world and invoke its callback. */
  private resolveRequest(request: QueuedRequest): void {
    const world = this.resolveWorld();
    if (!world) {
      request.onResult({ waypoints: null, complete: false });
      return;
    }
    const key = this.pathCacheKey(request.from, request.to, request.profile);
    const cached = this.pathCache.get(key);
    if (cached) {
      this.cacheHitsValue += 1;
      request.onResult(this.materializePath(cached, request.from, request.to));
      return;
    }
    this.cacheMissesValue += 1;
    if (this.workerReady && this.worker) {
      request.sentAt = performance.now();
      this.workerPending.set(request.id, request);
      this.worker.postMessage({
        type: 'path',
        id: request.id,
        start: worldToTileIndex(request.from.x, request.from.y),
        goal: worldToTileIndex(request.to.x, request.to.y),
        profile: request.profile,
      });
      return;
    }
    const result = this.search(request.from, request.to, world, request.profile);
    this.pathCache.set(key, this.clonePath(result));
    request.onResult(this.clonePath(result));
  }

  private pathCacheKey(from: Vector2, to: Vector2, profile: NavAgentProfile): string {
    return `${profile}:${worldToTileIndex(from.x, from.y)}:${worldToTileIndex(to.x, to.y)}`;
  }

  private materializePath(result: NavPathResult, from: Vector2, to: Vector2): NavPathResult {
    const materialized = this.clonePath(result);
    const points = materialized.waypoints;
    if (!points || points.length === 0) return materialized;
    points[0] = { x: from.x, y: from.y };
    if (materialized.complete) points[points.length - 1] = { x: to.x, y: to.y };
    return materialized;
  }

  private clonePath(result: NavPathResult): NavPathResult {
    return {
      complete: result.complete,
      waypoints: result.waypoints?.map((point) => ({ x: point.x, y: point.y })) ?? null,
    };
  }

  private startWorker(): void {
    if (typeof Worker === 'undefined') return;
    const world = this.resolveWorld();
    if (!world) return;
    try {
      const worker = new Worker(new URL('../workers/NavigationWorker.ts', import.meta.url), {
        type: 'module',
      });
      worker.onmessage = (event: MessageEvent<WorkerResultMessage>): void => {
        const message = event.data;
        if (message.type === 'ready') {
          this.workerReady = true;
          return;
        }
        const id = message.id;
        if (id === undefined) return;
        const request = this.workerPending.get(id);
        if (!request) return;
        this.workerPending.delete(id);
        const elapsed = message.elapsedMs ?? 0;
        this.lastPathfindingMsValue += (elapsed - this.lastPathfindingMsValue) * 0.2;
        if (request.cancelled) return;
        const currentWorld = this.resolveWorld();
        const nodes = message.path;
        const result =
          currentWorld && nodes && nodes.length > 0
            ? this.pathFromNodes(
                nodes,
                message.complete === true,
                request.from,
                request.to,
                currentWorld,
                request.profile,
              )
            : { waypoints: null, complete: false };
        this.pathCache.set(
          this.pathCacheKey(request.from, request.to, request.profile),
          this.clonePath(result),
        );
        request.onResult(this.clonePath(result));
      };
      worker.onerror = (): void => this.disableWorker();

      const pedestrianCosts = new Uint8Array(WORLD_TILES_X * WORLD_TILES_Y);
      const policeCosts = new Uint8Array(WORLD_TILES_X * WORLD_TILES_Y);
      for (let ty = 0; ty < WORLD_TILES_Y; ty++) {
        for (let tx = 0; tx < WORLD_TILES_X; tx++) {
          const x = tileCentreX(tx);
          const y = tileCentreY(ty);
          const index = ty * WORLD_TILES_X + tx;
          const cost = Phaser.Math.Clamp(Math.round(world.pedestrianTileCost(x, y) * 16), 1, 255);
          if (world.isPedestrianWalkableAtWorld(x, y)) pedestrianCosts[index] = cost;
          if (!world.isSolidAtWorld(x, y)) policeCosts[index] = cost;
        }
      }
      worker.postMessage(
        {
          type: 'init',
          width: WORLD_TILES_X,
          height: WORLD_TILES_Y,
          pedestrianCosts,
          policeCosts,
        },
        [pedestrianCosts.buffer, policeCosts.buffer],
      );
      this.worker = worker;
    } catch (error) {
      this.log.warn(`navigation worker unavailable: ${String(error)}`);
      this.worker = null;
      this.workerReady = false;
    }
  }

  private disableWorker(): void {
    this.worker?.terminate();
    this.worker = null;
    this.workerReady = false;
    for (const request of this.workerPending.values()) {
      if (!request.cancelled) this.queue.unshift(request);
    }
    this.workerPending.clear();
    this.log.warn('navigation worker failed; using synchronous budgeted fallback');
  }

  private recoverTimedOutWorkerRequests(): void {
    if (!this.workerReady || this.workerPending.size === 0) return;
    const now = performance.now();
    for (const request of this.workerPending.values()) {
      if (
        request.sentAt !== null &&
        now - request.sentAt >= ENGINE_LIMITS.PATHFINDING_REQUEST_TIMEOUT_MS
      ) {
        EngineDiagnostics.recordLimitExceeded(
          'PATHFINDING_REQUEST_TIMEOUT_MS',
          now - request.sentAt,
          ENGINE_LIMITS.PATHFINDING_REQUEST_TIMEOUT_MS,
          'restarted-navigation-worker',
          `request:${request.id}`,
        );
        this.disableWorker();
        return;
      }
    }
  }

  /**
   * Windowed A* search from `from` to `to`: a modest window first (strict —
   * must reach the goal within budget), widened once and allowed a
   * best-effort partial result if that fails, so an agent always makes
   * progress toward a destination instead of freezing.
   */
  private search(
    from: Vector2,
    to: Vector2,
    world: IWorldQuery,
    profile: NavAgentProfile,
  ): NavPathResult {
    const startNode = worldToTileIndex(from.x, from.y);
    const goalNode = worldToTileIndex(to.x, to.y);
    const startTx = startNode % WORLD_TILES_X;
    const startTy = Math.floor(startNode / WORLD_TILES_X);
    const goalTx = goalNode % WORLD_TILES_X;
    const goalTy = Math.floor(goalNode / WORLD_TILES_X);

    const buildWindow = (margin: number): [number, number, number, number] => {
      const minTx = clampInt(
        Math.max(Math.min(startTx, goalTx) - margin, startTx - MAX_WINDOW_HALF_TILES),
        0,
        WORLD_TILES_X - 1,
      );
      const maxTx = clampInt(
        Math.min(Math.max(startTx, goalTx) + margin, startTx + MAX_WINDOW_HALF_TILES),
        0,
        WORLD_TILES_X - 1,
      );
      const minTy = clampInt(
        Math.max(Math.min(startTy, goalTy) - margin, startTy - MAX_WINDOW_HALF_TILES),
        0,
        WORLD_TILES_Y - 1,
      );
      const maxTy = clampInt(
        Math.min(Math.max(startTy, goalTy) + margin, startTy + MAX_WINDOW_HALF_TILES),
        0,
        WORLD_TILES_Y - 1,
      );
      return [minTx, minTy, maxTx, maxTy];
    };

    let result: AStarResult<number> | null = null;
    for (const [margin, allowPartial] of [
      [WINDOW_MARGIN_TILES, false],
      [WINDOW_MARGIN_TILES * 2, true],
    ] as const) {
      const [minTx, minTy, maxTx, maxTy] = buildWindow(margin);
      const graph = new WindowedAgentGraph(world, profile, minTx, minTy, maxTx, maxTy);
      result = findPath(graph, startNode, goalNode, { maxExpansions: MAX_EXPANSIONS, allowPartial });
      if (result && (result.complete || allowPartial)) break;
    }

    if (!result) {
      return { waypoints: null, complete: false };
    }

    return this.pathFromNodes(result.path, result.complete, from, to, world, profile);
  }

  private pathFromNodes(
    nodes: readonly number[],
    complete: boolean,
    from: Vector2,
    to: Vector2,
    world: IWorldQuery,
    profile: NavAgentProfile,
  ): NavPathResult {
    const rawWaypoints = nodes.map((node) => ({
      x: tileCentreX(node % WORLD_TILES_X),
      y: tileCentreY(Math.floor(node / WORLD_TILES_X)),
    }));
    const waypoints = simplifyWaypoints(
      rawWaypoints,
      (x, y) =>
        profile === 'police'
          ? !world.isSolidAtWorld(x, y)
          : world.isPedestrianWalkableAtWorld(x, y),
      LOS_SAMPLE_STEP_PX,
    );

    if (waypoints.length === 0) {
      return { waypoints: null, complete: false };
    }
    if (waypoints.length === 1) {
      const only = complete ? to : from;
      return { waypoints: [{ x: only.x, y: only.y }], complete };
    }
    waypoints[0] = { x: from.x, y: from.y };
    if (complete) {
      waypoints[waypoints.length - 1] = { x: to.x, y: to.y };
    }
    return { waypoints, complete };
  }

  /** Whether every sampled point along `from` → `to` is pedestrian-walkable. */
  private hasWalkableLine(
    from: Vector2,
    to: Vector2,
    world: IWorldQuery,
    profile: NavAgentProfile,
  ): boolean {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-3) return true;
    const steps = Math.max(1, Math.ceil(dist / LOS_SAMPLE_STEP_PX));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = from.x + dx * t;
      const y = from.y + dy * t;
      const walkable =
        profile === 'police' ? !world.isSolidAtWorld(x, y) : world.isPedestrianWalkableAtWorld(x, y);
      if (!walkable) return false;
    }
    return true;
  }

  /** Resolve and cache the world reference (also exposing `.map` for debug draw). */
  private resolveWorld(): WorldMapProvider | null {
    if (!this.world) {
      this.world = ServiceLocator.tryResolve(ServiceKeys.World) as unknown as WorldMapProvider | null;
    }
    return this.world;
  }

  private resolveEntityManager(): EntityManager | null {
    if (!this.entityManager) {
      this.entityManager = ServiceLocator.tryResolve<EntityManager>(ServiceKeys.Entity);
    }
    return this.entityManager;
  }

  // ── Debug draw ───────────────────────────────────────────────────────────

  /** Flip the shared debug-draw flag and tear down the overlay when turning it off. */
  private toggleDebugDraw(): void {
    DebugFlags.navigation = !DebugFlags.navigation;
    if (!DebugFlags.navigation) {
      this.debugGraphics?.destroy();
      this.debugGraphics = null;
    }
  }

  /** Redraw the world-level nav overlay (benches, crossings) while debug draw is on. */
  private redrawDebug(): void {
    if (!DebugFlags.navigation || !this.scene) return;
    const world = this.resolveWorld();
    if (!world) return;

    if (!this.debugGraphics) {
      this.debugGraphics = this.scene.add.graphics();
      this.debugGraphics.setDepth(DepthLayers.DebugDraw);
    }
    const g = this.debugGraphics;
    g.clear();

    for (const bench of world.map.benches) {
      g.fillStyle(bench.occupiedBy === null ? 0x4ade80 : 0xef4444, 0.9);
      g.fillCircle(bench.x, bench.y, 5);
    }
    for (const crossing of world.map.crossings) {
      g.fillStyle(0x60a5fa, 0.6);
      g.fillCircle(crossing.x, crossing.y, 3);
    }
  }
}

/** Clamp an integer into `[lo, hi]`. */
function clampInt(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}
