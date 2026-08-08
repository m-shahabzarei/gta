# Highway Rendering and Performance Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace flat, rebuild-heavy highway graphics with a professional procedural pixel-art renderer that streams and simulates at stable frame cost.

**Architecture:** `HighwayRenderSystem` will preprocess smooth sampled geometry into a chunk spatial index once, rasterize each nearby highway chunk into a single cached canvas texture, and expose build/query/render statistics to `WorldManager` and `ProfilerSystem`. `WorldManager` remains the stream owner and keeps its conservative tile collision layer; traffic remains owned by the existing entity and traffic LOD schedulers.

**Tech Stack:** TypeScript 5, Phaser 3.80, Canvas 2D raster textures, Vite, Chrome DevTools Protocol validation.

## Global Constraints

- Profile CPU, GPU, draw calls, collision, navigation, memory, chunk loading, and entity updates before and after the overhaul.
- Stream only nearby chunks, avoid invisible updates, and retain simplified tile/rail collision.
- Batch static highway visuals and generate deterministic sparse detail without thousands of game objects.
- Preserve the existing highway graph, route ownership, deterministic seed, and topology quality gates.
- Maintain smooth spline-aligned pavement, shoulders, markings, rails, and ramp tapers without stretched textures or sharp polygon corners.

---

### Task 1: Reproducible Highway Profiler

**Files:**

- Create: `scripts/highway-performance.ps1`
- Modify: `package.json`
- Modify: `src/systems/ProfilerSystem.ts`

**Interfaces:**

- Consumes: `ProfilerSystem.snapshot`, `WorldManager.highwayRenderStats`, `TrafficUpdateScheduler.stats`
- Produces: `npm run profile:highways` and a JSON before/transition/settled benchmark report

- [x] Add a CDP benchmark that starts the game, samples the profiler in a city, teleports to every highway midpoint, records frame deltas and long frames during chunk entry, then samples settled performance.
- [x] Include CPU, GPU, render, physics/collision, navigation, memory, draw calls, chunks, entity activity, traffic tiers, and highway chunk build timings in every report.
- [x] Run the benchmark against the current renderer and record the bottleneck in `docs/HIGHWAY_SYSTEM.md`.

### Task 2: Precomputed Smooth Highway Geometry

**Files:**

- Create: `src/gameplay/highway/HighwayGeometry.ts`
- Create: `src/gameplay/highway/HighwayRenderTypes.ts`
- Create: `src/gameplay/highway/index.ts`
- Modify: `src/generation/HighwayPlanner.ts`

**Interfaces:**

- Consumes: `MapData.highways`, `MapData.urbanPlan.roads`, `TILE_SIZE`
- Produces: `buildHighwayGeometry(map, chunkTiles): HighwayGeometryIndex`, chunk-local carriageway/ramp/site batches, spline sampling and offset helpers

- [x] Implement centripetal Catmull-Rom/resampled geometry with averaged normals and arc distance, preserving exact route endpoints.
- [x] Build smooth offset curves for road edges, shoulders, lane markings, rails, and medians from the same samples so all layers align.
- [x] Convert gateway and service roads into curved ramp paths with acceleration/deceleration tapers and no sudden width transition.
- [x] Bucket only intersecting geometry and sites into chunk keys during initialization; queries must not scan all routes or all samples.
- [x] Extend highway validation for sample continuity, taper monotonicity, curvature, and matching marking/rail lengths.

### Task 3: Batched Pixel-Art Highway Renderer

**Files:**

- Create: `src/gameplay/highway/HighwayRenderSystem.ts`
- Create: `src/gameplay/highway/HighwayCanvasPainter.ts`
- Modify: `src/systems/WorldManager.ts`

**Interfaces:**

- Consumes: `HighwayGeometryIndex.getChunk(key, lod)`
- Produces: `HighwayRenderSystem.acquireChunk(scene, key, lod)`, `releaseChunk(key)`, `stats`

- [x] Rasterize one texture per resident highway chunk with a shared palette and clipped local spline paths.
- [x] Paint verge/edge shadow, shoulder, asphalt, continuous road edges, dashed and faded lane paint, emergency-lane markings, merge arrows, rails, posts, and reflectors in ordered layers.
- [x] Add deterministic sparse asphalt aggregate, tonal variation, tire/skid marks, oil stains, repaired patches, expansion joints, cracks, drain covers, debris, distance markers, and signs.
- [x] Use rounded curve joins/caps and curve-specific edge stamps; place texture/detail stamps by arc length and tangent so they rotate without scaling.
- [x] Cache chunk textures with a bounded LRU and render each chunk as one static image; never create per-detail Phaser objects.
- [x] Replace `paintHighwayChunk`, full-route scans, and per-tile highway proximity loops in `WorldManager` with indexed corridor masks and the render-system batch.

### Task 4: Streaming, Culling, LOD, and Collision

**Files:**

- Modify: `src/systems/WorldManager.ts`
- Modify: `src/gameplay/highway/HighwayRenderSystem.ts`
- Modify: `src/config/EngineLimits.ts`

**Interfaces:**

- Consumes: camera world view, player chunk, indexed highway chunk bounds
- Produces: resident/visible/detailed highway counts and queue/build budgets

- [x] Prioritize unloads and nearest visible loads, enforce a millisecond chunk budget, and prevent detail-level rebuild churn at chunk borders.
- [x] Apply frustum plus distance culling to chunks and highway batches; medium LOD omits small debris/cracks, far LOD omits furniture and reflectors.
- [x] Keep collision on the streamed tile layer only; do not add colliders for paint, patches, debris, signs, lights, or scenery.
- [x] Represent any rail blocking through coarse corridor segments or existing conservative solid tiles, never per-post colliders.
- [x] Verify tree, furniture, sign, light, and decoration creation remains limited to the detailed visible range.

### Task 5: Entity and Traffic Range Policy

**Files:**

- Modify: `src/gameplay/traffic/TrafficUpdateScheduler.ts`
- Modify: `src/systems/EntityManager.ts`
- Modify: `src/systems/ProfilerSystem.ts`

**Interfaces:**

- Consumes: player distance, camera bounds, entity category
- Produces: full/coarse/statistical/dormant counts and per-tier CPU metrics

- [x] Confirm near vehicles run full AI, medium vehicles run staggered movement, far vehicles run coarse simulation, and very distant traffic is statistical/frozen.
- [x] Ensure vehicle/NPC bodies sleep outside physics range and sprites cull outside the camera while state remains available for reactivation.
- [x] Report tier counts and collision/navigation costs so range-policy regressions are visible in the overlay and benchmark.

### Task 6: Validation and Visual QA

**Files:**

- Modify: `scripts/highway-validation.ts`
- Modify: `scripts/run-highway-validation.mjs`
- Modify: `docs/HIGHWAY_SYSTEM.md`

**Interfaces:**

- Consumes: generated geometry, render statistics, CDP benchmark output and screenshots
- Produces: build/quality/performance acceptance gates

- [x] Add deterministic assertions for indexed chunk occupancy, batch counts, detail density, ramp tapers, lane/rail alignment, and zero decorative colliders.
- [x] Run `npm run validate:highways`, `npm run validate:traffic`, `npm run lint`, and `npm run build`.
- [x] Run GPU-enabled desktop and mobile-size highway transitions; reject long frames, unbounded chunk builds, excessive draw calls, or inactive-entity updates.
- [x] Capture representative Alborz, desert, and Caspian highway screenshots and inspect curves, edges, markings, ramps, texture density, and occlusion at actual gameplay zoom.
- [x] Document measured baseline, final metrics, architecture, LOD thresholds, cache limits, and validation commands.
