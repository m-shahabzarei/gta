import Phaser from 'phaser';
import { BaseSceneManager } from '@/core/BaseSceneManager';
import { ServiceLocator } from '@/core/ServiceLocator';
import { ServiceKeys } from '@/config/ServiceKeys';
import { EngineDiagnostics, type EngineDiagnosticsSnapshot } from '@/core/EngineDiagnostics';
import { EntityCategory, SimulationTier, type EntityManager } from '@/systems/EntityManager';
import type { WorldManager } from '@/systems/WorldManager';
import type { NavigationSystem } from '@/systems/NavigationSystem';
import type { ParticleManager } from '@/managers/ParticleManager';

const SAMPLE_ALPHA = 0.12;
const DISPLAY_INTERVAL_MS = 250;
const GPU_QUERY_INTERVAL_FRAMES = 4;
const FRAME_SAMPLE_CAPACITY = 600;

interface GpuTimerExtension {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

interface PerformanceMemory {
  readonly usedJSHeapSize: number;
  readonly jsHeapSizeLimit: number;
}

interface DrawHooks {
  gl: WebGLRenderingContext | WebGL2RenderingContext;
  drawArrays: WebGLRenderingContext['drawArrays'];
  drawElements: WebGLRenderingContext['drawElements'];
  drawArraysInstanced?: WebGL2RenderingContext['drawArraysInstanced'];
  drawElementsInstanced?: WebGL2RenderingContext['drawElementsInstanced'];
}

export interface ProfilerSnapshot {
  fps: number;
  frameMs: number;
  frameP50Ms: number;
  frameP95Ms: number;
  frameP99Ms: number;
  framesOver20Ms: number;
  framesOver33Ms: number;
  framesOver50Ms: number;
  cpuMs: number;
  gpuMs: number | null;
  renderMs: number;
  physicsMs: number;
  memoryMb: number | null;
  drawCalls: number;
  loadedChunks: number;
  loadedNpcs: number;
  activeNpcs: number;
  sleepingNpcs: number;
  loadedVehicles: number;
  activeVehicles: number;
  sleepingVehicles: number;
  nearEntities: number;
  mediumEntities: number;
  farEntities: number;
  veryFarEntities: number;
  dormantEntities: number;
  physicsBodies: number;
  particleCount: number;
  audioChannels: number;
  aiMs: number;
  trafficMs: number;
  trafficAiMs: number;
  trafficNavigationMs: number;
  trafficCollisionMs: number;
  trafficNearVehicles: number;
  trafficMediumVehicles: number;
  trafficFarVehicles: number;
  trafficFrozenVehicles: number;
  statisticalTraffic: number;
  pathfindingMs: number;
  streamingMs: number;
  highwayChunkBuildMs: number;
  highwayMaximumBuildMs: number;
  highwayResidentChunks: number;
  highwayVisibleChunks: number;
  highwayCachedTextures: number;
  animationMs: number;
  audioMs: number;
  queuedPaths: number;
  pathCacheEntries: number;
  pathWorker: boolean;
  entities: number;
  gameState: string;
  engineDiagnostics: EngineDiagnosticsSnapshot;
  trafficState: string;
  aiSchedulerState: string;
  blockingSystem: string | null;
}

/** Low-overhead engine telemetry with an F3 developer overlay. */
export class ProfilerSystem extends BaseSceneManager {
  public readonly key = ServiceKeys.Profiler;

  private overlay: HTMLPreElement | null = null;
  private visibleValue = false;
  private displayTimer = 0;
  private frameNumber = 0;
  private lastStepAt = 0;
  private frameSampleCount = 0;
  private frameSampleCursor = 0;
  private readonly frameSamples = new Float64Array(FRAME_SAMPLE_CAPACITY);
  private cpuStartedAt = 0;
  private renderStartedAt = 0;
  private physicsStartedAt = 0;
  private rawDrawCalls = 0;

  private fpsValue = 60;
  private frameMsValue = 16.67;
  private cpuMsValue = 0;
  private renderMsValue = 0;
  private physicsMsValue = 0;
  private gpuMsValue: number | null = null;
  private drawCallsValue = 0;

  private readonly systemMs = new Map<ServiceKeys, number>();
  private drawHooks: DrawHooks | null = null;
  private gpu: {
    gl: WebGL2RenderingContext;
    ext: GpuTimerExtension;
    active: WebGLQuery | null;
    pending: WebGLQuery[];
  } | null = null;

  protected onInit(): void {
    this.game.events.on(Phaser.Core.Events.PRE_STEP, this.onPreStep, this);
    this.game.events.on(Phaser.Core.Events.PRE_RENDER, this.onPreRender, this);
    this.game.events.on(Phaser.Core.Events.POST_RENDER, this.onPostRender, this);
    this.installDrawCounter();
    this.installGpuTimer();
    const target = globalThis as typeof globalThis & {
      __engineProfiler?: () => ProfilerSnapshot;
    };
    target.__engineProfiler = () => this.snapshot;
  }

  protected override onDestroy(): void {
    this.game.events.off(Phaser.Core.Events.PRE_STEP, this.onPreStep, this);
    this.game.events.off(Phaser.Core.Events.PRE_RENDER, this.onPreRender, this);
    this.game.events.off(Phaser.Core.Events.POST_RENDER, this.onPostRender, this);
    this.restoreDrawCounter();
    this.releaseGpuQueries();
    const target = globalThis as typeof globalThis & {
      __engineProfiler?: () => ProfilerSnapshot;
    };
    delete target.__engineProfiler;
    super.onDestroy();
  }

  protected onAttach(scene: Phaser.Scene): void {
    scene.input.keyboard?.on('keydown-F3', this.toggle, this);
    scene.events.on(Phaser.Scenes.Events.PRE_UPDATE, this.onScenePreUpdate, this);
    scene.events.on(Phaser.Scenes.Events.POST_UPDATE, this.onScenePostUpdate, this);
    this.createOverlay();
  }

  protected override onDetach(scene: Phaser.Scene): void {
    scene.input.keyboard?.off('keydown-F3', this.toggle, this);
    scene.events.off(Phaser.Scenes.Events.PRE_UPDATE, this.onScenePreUpdate, this);
    scene.events.off(Phaser.Scenes.Events.POST_UPDATE, this.onScenePostUpdate, this);
    this.overlay?.remove();
    this.overlay = null;
    this.visibleValue = false;
    this.setDetailedEntityProfiling(false);
    this.lastStepAt = 0;
    this.frameSampleCount = 0;
    this.frameSampleCursor = 0;
  }

  public update(_time: number, delta: number): void {
    if (!this.visibleValue) return;
    this.displayTimer += delta;
    if (this.displayTimer < DISPLAY_INTERVAL_MS) return;
    this.displayTimer = 0;
    this.refreshOverlay();
  }

  public recordSystemSample(key: ServiceKeys, elapsedMs: number): void {
    const previous = this.systemMs.get(key) ?? elapsedMs;
    this.systemMs.set(key, smooth(previous, elapsedMs));
  }

  public get visible(): boolean {
    return this.visibleValue;
  }

  public get snapshot(): ProfilerSnapshot {
    const entities = ServiceLocator.tryResolve<EntityManager>(ServiceKeys.Entity);
    const world = ServiceLocator.tryResolve<WorldManager>(ServiceKeys.World);
    const navigation = ServiceLocator.tryResolve<NavigationSystem>(ServiceKeys.Navigation);
    const particles = ServiceLocator.tryResolve<ParticleManager>(ServiceKeys.Particle);
    const gameManager = ServiceLocator.tryResolve(ServiceKeys.Game) as { state?: unknown } | null;
    const traffic = ServiceLocator.tryResolve(ServiceKeys.Traffic) as {
      trafficDebugSnapshot?(): {
        phase: string;
        stats: {
          schedulerLoad: number;
          schedulerDeferredUpdates: number;
          activeDrivers: number;
          virtualVehicles: number;
          trafficCpuMs: number;
          navigationCpuMs: number;
          collisionCpuMs: number;
          nearSimulationVehicles: number;
          mediumSimulationVehicles: number;
          farSimulationVehicles: number;
          frozenSimulationVehicles: number;
        };
      };
    } | null;
    const trafficSnapshot = traffic?.trafficDebugSnapshot?.() ?? null;
    const diagnostics = EngineDiagnostics.snapshot;
    const stats = entities?.stats;
    const highway = world?.highwayRenderStats;
    const npcUpdates = entities?.updateTimeFor(EntityCategory.Npc) ?? 0;
    const vehicleUpdates = entities?.updateTimeFor(EntityCategory.Vehicle) ?? 0;
    const frameStats = this.frameTimingStats();

    return {
      fps: this.fpsValue,
      frameMs: this.frameMsValue,
      frameP50Ms: frameStats.p50,
      frameP95Ms: frameStats.p95,
      frameP99Ms: frameStats.p99,
      framesOver20Ms: frameStats.over20,
      framesOver33Ms: frameStats.over33,
      framesOver50Ms: frameStats.over50,
      cpuMs: this.cpuMsValue,
      gpuMs: this.gpuMsValue,
      renderMs: this.renderMsValue,
      physicsMs: this.physicsMsValue,
      memoryMb: this.memoryUsageMb(),
      drawCalls: this.drawCallsValue,
      loadedChunks: world?.loadedChunkCount ?? 0,
      loadedNpcs: stats?.byCategory[EntityCategory.Npc] ?? 0,
      activeNpcs: stats?.activeByCategory[EntityCategory.Npc] ?? 0,
      sleepingNpcs: stats?.sleepingByCategory[EntityCategory.Npc] ?? 0,
      loadedVehicles: stats?.byCategory[EntityCategory.Vehicle] ?? 0,
      activeVehicles: stats?.activeByCategory[EntityCategory.Vehicle] ?? 0,
      sleepingVehicles: stats?.sleepingByCategory[EntityCategory.Vehicle] ?? 0,
      nearEntities: stats?.byTier[SimulationTier.Near] ?? 0,
      mediumEntities: stats?.byTier[SimulationTier.Medium] ?? 0,
      farEntities: stats?.byTier[SimulationTier.Far] ?? 0,
      veryFarEntities: stats?.byTier[SimulationTier.VeryFar] ?? 0,
      dormantEntities: stats?.byTier[SimulationTier.Dormant] ?? 0,
      physicsBodies: stats?.physicsBodies ?? this.arcadeBodyCount(),
      particleCount: particles?.activeParticleCount ?? 0,
      audioChannels: this.audioChannelCount(),
      aiMs: npcUpdates,
      trafficMs:
        vehicleUpdates +
        this.systemTime(ServiceKeys.Traffic) +
        this.systemTime(ServiceKeys.Vehicle),
      trafficAiMs: trafficSnapshot?.stats.trafficCpuMs ?? 0,
      trafficNavigationMs: trafficSnapshot?.stats.navigationCpuMs ?? 0,
      trafficCollisionMs: trafficSnapshot?.stats.collisionCpuMs ?? 0,
      trafficNearVehicles: trafficSnapshot?.stats.nearSimulationVehicles ?? 0,
      trafficMediumVehicles: trafficSnapshot?.stats.mediumSimulationVehicles ?? 0,
      trafficFarVehicles: trafficSnapshot?.stats.farSimulationVehicles ?? 0,
      trafficFrozenVehicles: trafficSnapshot?.stats.frozenSimulationVehicles ?? 0,
      statisticalTraffic: trafficSnapshot?.stats.virtualVehicles ?? 0,
      pathfindingMs: navigation?.lastPathfindingMs ?? this.systemTime(ServiceKeys.Navigation),
      streamingMs: this.systemTime(ServiceKeys.World),
      highwayChunkBuildMs: highway?.lastBuildMs ?? 0,
      highwayMaximumBuildMs: highway?.maximumBuildMs ?? 0,
      highwayResidentChunks: highway?.residentChunks ?? 0,
      highwayVisibleChunks: highway?.visibleChunks ?? 0,
      highwayCachedTextures: highway?.cachedTextures ?? 0,
      animationMs: this.systemTime(ServiceKeys.Animation),
      audioMs:
        this.systemTime(ServiceKeys.GameAudio) +
        this.systemTime(ServiceKeys.Sound) +
        this.systemTime(ServiceKeys.Music),
      queuedPaths: navigation?.queuedRequests ?? 0,
      pathCacheEntries: navigation?.cacheSize ?? 0,
      pathWorker: navigation?.usingWorker ?? false,
      entities: stats?.total ?? 0,
      gameState: String(gameManager?.state ?? 'unknown'),
      engineDiagnostics: diagnostics,
      trafficState: trafficSnapshot?.phase ?? 'offline',
      aiSchedulerState: trafficSnapshot
        ? `load ${(trafficSnapshot.stats.schedulerLoad * 100).toFixed(0)}%, deferred ${trafficSnapshot.stats.schedulerDeferredUpdates}, drivers ${trafficSnapshot.stats.activeDrivers}, virtual ${trafficSnapshot.stats.virtualVehicles}`
        : 'offline',
      blockingSystem: diagnostics.blockingSystem,
    };
  }

  private toggle(): void {
    this.visibleValue = !this.visibleValue;
    if (this.overlay) this.overlay.style.display = this.visibleValue ? 'block' : 'none';
    this.setDetailedEntityProfiling(this.visibleValue);
    if (this.visibleValue) this.refreshOverlay();
  }

  private setDetailedEntityProfiling(enabled: boolean): void {
    ServiceLocator.tryResolve<EntityManager>(ServiceKeys.Entity)?.setDetailedProfiling(enabled);
  }

  private onPreStep(_time: number, delta: number): void {
    const now = performance.now();
    this.cpuStartedAt = now;
    this.frameNumber += 1;
    // Phaser's delta is simulation time and can be capped. Measure the actual
    // wall-clock interval between engine steps for hitch and FPS diagnostics.
    const wallDelta = this.lastStepAt > 0 ? Math.max(0, now - this.lastStepAt) : Math.max(0.1, delta);
    this.lastStepAt = now;
    this.frameSamples[this.frameSampleCursor] = wallDelta;
    this.frameSampleCursor = (this.frameSampleCursor + 1) % FRAME_SAMPLE_CAPACITY;
    this.frameSampleCount = Math.min(this.frameSampleCount + 1, FRAME_SAMPLE_CAPACITY);
    this.frameMsValue = smooth(this.frameMsValue, wallDelta);
    this.fpsValue = smooth(this.fpsValue, 1000 / Math.max(0.1, wallDelta));
  }

  private frameTimingStats(): {
    p50: number;
    p95: number;
    p99: number;
    over20: number;
    over33: number;
    over50: number;
  } {
    const count = this.frameSampleCount;
    if (count === 0) return { p50: 0, p95: 0, p99: 0, over20: 0, over33: 0, over50: 0 };
    const ordered = new Array<number>(count);
    const start = count === FRAME_SAMPLE_CAPACITY ? this.frameSampleCursor : 0;
    let over20 = 0;
    let over33 = 0;
    let over50 = 0;
    for (let index = 0; index < count; index += 1) {
      const value = this.frameSamples[(start + index) % FRAME_SAMPLE_CAPACITY] ?? 0;
      ordered[index] = value;
      if (value > 20) over20 += 1;
      if (value > 33.34) over33 += 1;
      if (value > 50) over50 += 1;
    }
    ordered.sort((a, b) => a - b);
    const at = (p: number): number => ordered[Math.min(count - 1, Math.ceil(count * p) - 1)] ?? 0;
    return { p50: at(0.5), p95: at(0.95), p99: at(0.99), over20, over33, over50 };
  }

  private onPreRender(): void {
    const now = performance.now();
    this.cpuMsValue = smooth(this.cpuMsValue, Math.max(0, now - this.cpuStartedAt));
    this.renderStartedAt = now;
    this.rawDrawCalls = 0;
    this.pollGpuQueries();
    if (this.gpu && this.frameNumber % GPU_QUERY_INTERVAL_FRAMES === 0 && !this.gpu.active) {
      const query = this.gpu.gl.createQuery();
      if (query) {
        this.gpu.gl.beginQuery(this.gpu.ext.TIME_ELAPSED_EXT, query);
        this.gpu.active = query;
      }
    }
  }

  private onPostRender(
    renderer: Phaser.Renderer.Canvas.CanvasRenderer | Phaser.Renderer.WebGL.WebGLRenderer,
  ): void {
    this.renderMsValue = smooth(this.renderMsValue, performance.now() - this.renderStartedAt);
    if (this.gpu?.active) {
      this.gpu.gl.endQuery(this.gpu.ext.TIME_ELAPSED_EXT);
      this.gpu.pending.push(this.gpu.active);
      this.gpu.active = null;
    }
    const canvasDraws = (renderer as unknown as { drawCount?: number }).drawCount;
    this.drawCallsValue = canvasDraws ?? this.rawDrawCalls;
  }

  private onScenePreUpdate(): void {
    this.physicsStartedAt = performance.now();
  }

  private onScenePostUpdate(): void {
    this.physicsMsValue = smooth(this.physicsMsValue, performance.now() - this.physicsStartedAt);
  }

  private createOverlay(): void {
    if (typeof document === 'undefined' || this.overlay) return;
    const overlay = document.createElement('pre');
    overlay.id = 'engine-profiler';
    Object.assign(overlay.style, {
      position: 'fixed',
      left: '8px',
      top: '8px',
      zIndex: '2147483647',
      display: 'none',
      minWidth: '340px',
      margin: '0',
      padding: '8px 10px',
      border: '1px solid rgba(103, 232, 249, 0.75)',
      borderRadius: '4px',
      background: 'rgba(7, 10, 14, 0.93)',
      color: '#e5edf5',
      font: '11px/1.35 Consolas, "Courier New", monospace',
      letterSpacing: '0',
      pointerEvents: 'none',
      userSelect: 'none',
      whiteSpace: 'pre',
    });
    document.body.appendChild(overlay);
    this.overlay = overlay;
  }

  private refreshOverlay(): void {
    if (!this.overlay) return;
    const s = this.snapshot;
    const gpu = s.gpuMs === null ? '   n/a' : `${fixed(s.gpuMs)} ms`;
    const memory = s.memoryMb === null ? 'n/a' : `${s.memoryMb.toFixed(1)} MB`;
    this.overlay.textContent = [
      'ENGINE DIAGNOSTICS',
      `GAME ${s.gameState}   ENGINE ${s.engineDiagnostics.engineState}`,
      `FPS ${s.fps.toFixed(1).padStart(5)}   FRAME ${fixed(s.frameMs)} ms`,
      `FRAME p50 ${fixed(s.frameP50Ms)}  p95 ${fixed(s.frameP95Ms)}  p99 ${fixed(s.frameP99Ms)}  >20/>33/>50 ${s.framesOver20Ms}/${s.framesOver33Ms}/${s.framesOver50Ms}`,
      `CPU ${fixed(s.cpuMs)} ms   GPU ${gpu}`,
      `RENDER ${fixed(s.renderMs)} ms   PHYSICS ${fixed(s.physicsMs)} ms`,
      `PHASE ${s.engineDiagnostics.currentUpdatePhase}   SYSTEM ${s.engineDiagnostics.currentSystem ?? 'idle'}`,
      `LAST ${s.engineDiagnostics.lastCompletedSystem ?? 'none'}   BLOCKING ${s.blockingSystem ?? 'none'}`,
      `AI ${fixed(s.aiMs)} ms   TRAFFIC ${fixed(s.trafficMs)} ms`,
      `TRAFFIC AI ${fixed(s.trafficAiMs)} ms   NAV ${fixed(s.trafficNavigationMs)} ms   COLL ${fixed(s.trafficCollisionMs)} ms`,
      `TRAFFIC LOD near ${s.trafficNearVehicles}  mid ${s.trafficMediumVehicles}  far ${s.trafficFarVehicles}  frozen ${s.trafficFrozenVehicles}  statistical ${s.statisticalTraffic}`,
      `TRAFFIC ${s.trafficState}   SCHED ${s.aiSchedulerState}`,
      `PATH ${fixed(s.pathfindingMs)} ms   STREAM ${fixed(s.streamingMs)} ms`,
      `HIGHWAY BUILD ${fixed(s.highwayChunkBuildMs)} ms   MAX ${fixed(s.highwayMaximumBuildMs)} ms   resident ${s.highwayResidentChunks} visible ${s.highwayVisibleChunks} cache ${s.highwayCachedTextures}`,
      `ANIM ${fixed(s.animationMs)} ms   AUDIO ${fixed(s.audioMs)} ms`,
      `MEM ${memory.padStart(10)}   DRAWS ${String(s.drawCalls).padStart(4)}`,
      `CHUNKS ${String(s.loadedChunks).padStart(3)}   ENTITIES ${String(s.entities).padStart(5)}`,
      `ENTITY LOD near ${s.nearEntities}  mid ${s.mediumEntities}  far ${s.farEntities}  very-far ${s.veryFarEntities}  dormant ${s.dormantEntities}`,
      `NPC  loaded ${String(s.loadedNpcs).padStart(5)}  active ${String(s.activeNpcs).padStart(4)}  sleep ${String(s.sleepingNpcs).padStart(4)}`,
      `VEH  loaded ${String(s.loadedVehicles).padStart(5)}  active ${String(s.activeVehicles).padStart(4)}  sleep ${String(s.sleepingVehicles).padStart(4)}`,
      `BODIES ${String(s.physicsBodies).padStart(4)}   PARTICLES ${String(s.particleCount).padStart(4)}   AUDIO CH ${String(s.audioChannels).padStart(3)}`,
      `NAV QUEUE ${String(s.queuedPaths).padStart(3)}   CACHE ${String(s.pathCacheEntries).padStart(4)}   WORKER ${s.pathWorker ? 'ON' : 'OFF'}`,
      `EVENT ${s.engineDiagnostics.eventBus.activeEvent ?? 'idle'} depth ${s.engineDiagnostics.eventBus.depth} drops ${s.engineDiagnostics.eventBus.droppedEvents}`,
      `ERRORS ${String(s.engineDiagnostics.recentErrors.length).padStart(2)}   LIMITS ${String(s.engineDiagnostics.recentLimits.length).padStart(2)}`,
      `LAST ERROR ${s.engineDiagnostics.lastError?.message ?? 'none'}`,
    ].join('\n');
  }

  private systemTime(key: ServiceKeys): number {
    return this.systemMs.get(key) ?? 0;
  }

  private memoryUsageMb(): number | null {
    const memory = (performance as Performance & { memory?: PerformanceMemory }).memory;
    return memory ? memory.usedJSHeapSize / (1024 * 1024) : null;
  }

  private audioChannelCount(): number {
    const sounds = (this.game.sound as unknown as { sounds?: Array<{ isPlaying?: boolean }> })
      .sounds;
    return sounds?.reduce((count, sound) => count + (sound.isPlaying ? 1 : 0), 0) ?? 0;
  }

  private arcadeBodyCount(): number {
    const world = this.scene?.physics.world as unknown as
      { bodies?: { size?: number } } | undefined;
    return world?.bodies?.size ?? 0;
  }

  private installDrawCounter(): void {
    const candidate = this.game.renderer as unknown as {
      gl?: WebGLRenderingContext | WebGL2RenderingContext;
    };
    const gl = candidate.gl;
    if (!gl) return;
    const hooks: DrawHooks = {
      gl,
      drawArrays: gl.drawArrays,
      drawElements: gl.drawElements,
    };
    gl.drawArrays = (...args): void => {
      this.rawDrawCalls += 1;
      hooks.drawArrays.apply(gl, args);
    };
    gl.drawElements = (...args): void => {
      this.rawDrawCalls += 1;
      hooks.drawElements.apply(gl, args);
    };
    if (typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext) {
      hooks.drawArraysInstanced = gl.drawArraysInstanced;
      hooks.drawElementsInstanced = gl.drawElementsInstanced;
      gl.drawArraysInstanced = (...args): void => {
        this.rawDrawCalls += 1;
        hooks.drawArraysInstanced?.apply(gl, args);
      };
      gl.drawElementsInstanced = (...args): void => {
        this.rawDrawCalls += 1;
        hooks.drawElementsInstanced?.apply(gl, args);
      };
    }
    this.drawHooks = hooks;
  }

  private restoreDrawCounter(): void {
    const hooks = this.drawHooks;
    if (!hooks) return;
    hooks.gl.drawArrays = hooks.drawArrays;
    hooks.gl.drawElements = hooks.drawElements;
    if (
      typeof WebGL2RenderingContext !== 'undefined' &&
      hooks.gl instanceof WebGL2RenderingContext
    ) {
      if (hooks.drawArraysInstanced) hooks.gl.drawArraysInstanced = hooks.drawArraysInstanced;
      if (hooks.drawElementsInstanced) hooks.gl.drawElementsInstanced = hooks.drawElementsInstanced;
    }
    this.drawHooks = null;
  }

  private installGpuTimer(): void {
    const gl = (this.game.renderer as unknown as { gl?: WebGLRenderingContext }).gl;
    if (typeof WebGL2RenderingContext === 'undefined' || !(gl instanceof WebGL2RenderingContext)) {
      return;
    }
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as GpuTimerExtension | null;
    if (ext) this.gpu = { gl, ext, active: null, pending: [] };
  }

  private pollGpuQueries(): void {
    const gpu = this.gpu;
    if (!gpu || gpu.pending.length === 0) return;
    const disjoint = gpu.gl.getParameter(gpu.ext.GPU_DISJOINT_EXT) as boolean;
    while (gpu.pending.length > 0) {
      const query = gpu.pending[0];
      if (!query || !gpu.gl.getQueryParameter(query, gpu.gl.QUERY_RESULT_AVAILABLE)) break;
      gpu.pending.shift();
      if (!disjoint) {
        const elapsedNs = gpu.gl.getQueryParameter(query, gpu.gl.QUERY_RESULT) as number;
        this.gpuMsValue = smooth(this.gpuMsValue ?? elapsedNs / 1_000_000, elapsedNs / 1_000_000);
      }
      gpu.gl.deleteQuery(query);
    }
  }

  private releaseGpuQueries(): void {
    if (!this.gpu) return;
    if (this.gpu.active) {
      this.gpu.gl.endQuery(this.gpu.ext.TIME_ELAPSED_EXT);
      this.gpu.gl.deleteQuery(this.gpu.active);
    }
    for (const query of this.gpu.pending) this.gpu.gl.deleteQuery(query);
    this.gpu = null;
  }
}

function smooth(previous: number, current: number): number {
  return previous + (current - previous) * SAMPLE_ALPHA;
}

function fixed(value: number): string {
  return value.toFixed(2).padStart(6);
}
