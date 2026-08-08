# Clean Six-Lane Highway Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the template-driven motorway/interchange system with a deterministic GTA 2-style road backbone made only from two symmetric three-lane carriageways, one continuous concrete median, simple at-grade city junctions, short service-area branches, and chunk-batched pixel-art rendering.

**Architecture:** `HighwayPlanner` owns the backbone before `UrbanPlanner` runs and emits one authoritative centreline, two symmetric carriageways, ordinary graph edges, simple city junction records, and rest-area branches. `HighwayGeometryIndex` converts only those records into cached chunk-local render geometry; `HighwayCanvasPainter` draws a small dedicated procedural tile vocabulary with a fixed cross-section, while the existing traffic graph consumes the same directed lane data.

**Tech Stack:** TypeScript 5.4, Phaser 3.80, Canvas 2D chunk textures, Vite, deterministic Node validation scripts, Chrome DevTools Protocol smoke/performance capture.

## Global Constraints

- Every intercity route has exactly two directions and exactly three equal-width lanes per direction.
- Every route uses one continuous concrete barrier median and outer-edge guard rails only.
- Route alignments contain only long horizontal/vertical runs and explicitly sampled large-radius quarter curves; arbitrary diagonal segments are forbidden.
- City connections are ordinary at-grade T/cross/priority intersections with no loops, flyovers, grade separation, roundabouts, cloverleafs, stacks, trumpets, SPUIs, or curved ramp mazes.
- Entry, exit, and service-area access use short single-lane branches with monotonic acceleration/deceleration tapers.
- Static highway art is rasterized once per streamed chunk, cached, culled, and rendered as one Phaser image per resident chunk.
- Traffic never reverses on highway-owned edges, crosses the median, spawns sideways/overlapping, or updates distant vehicles at full frequency.

---

### Task 1: Replace the interchange domain model with a simple-road contract

**Files:**

- Modify: `src/gameplay/types/WorldTypes.ts`
- Modify: `src/gameplay/highway/HighwayRenderTypes.ts`
- Rewrite: `src/generation/HighwayTransitionPlanner.ts`
- Test: `scripts/highway-validation.ts`

**Interfaces:**

- Consumes: `WorldCity`, `Vector2`, carriageway terminal graph points.
- Produces: `HighwayInterchangeKind = 't-junction' | 'cross' | 'priority-cross'`, ground-only `HighwayTransitionPath`, fixed `HighwayMedianType = 'concrete-barrier'`, and `HighwayTransitionPlanner.generate(input)`.

- [ ] **Step 1: Replace complex-template assertions with forbidden-feature assertions**

  Assert that the supported junction list is exactly `['t-junction', 'cross', 'priority-cross']`, all transitions are ground-level, no circulating path exists, no route uses a diagonal graph edge, and every carriageway reports three lanes.

- [ ] **Step 2: Run the highway validator and observe the old model fail**

  Run: `npm run validate:highways`

  Expected: FAIL because the generated network still exposes complex interchange kinds and two-lane carriageways.

- [ ] **Step 3: Narrow the shared types to the new contract**

  Use the following discriminants and retain the existing records only where runtime consumers need them:

  ```ts
  export type HighwayMedianType = 'concrete-barrier';
  export type HighwayInterchangeKind = 't-junction' | 'cross' | 'priority-cross';
  export type HighwayTransitionPathKind = 'transition-road';
  export interface HighwayCarriageway {
    id: string;
    direction: 'forward' | 'reverse';
    points: Vector2[];
    laneCount: 3;
    laneWidth: number;
    pavementWidth: number;
    shoulderWidth: number;
    roadSegmentIds: string[];
  }
  ```

- [ ] **Step 4: Replace template selection with one deterministic at-grade junction builder**

  `HighwayTransitionPlanner.generate` must emit two straight ground transition paths in legal direction, a shared city connection, no gore, no circulating road, no elevation, and priority metadata derived only from city size.

- [ ] **Step 5: Typecheck the reduced model**

  Run: `npm run typecheck`

  Expected: PASS after every consumer is updated to the reduced union.

### Task 2: Generate an orthogonal backbone with fixed large-radius curves

**Files:**

- Rewrite: `src/generation/HighwayPlanner.ts`
- Modify: `src/generation/UrbanPlanner.ts`
- Test: `scripts/highway-validation.ts`

**Interfaces:**

- Consumes: city definitions and deterministic route profiles.
- Produces: centreline samples, symmetric offsets, directed three-lane graph segments, city-first attachment anchors, and route quality metrics.

- [ ] **Step 1: Add fixed-cross-section and alignment checks**

  Assert `laneWidth === 32`, `laneCount === 3`, both carriageways have equal `pavementWidth`, the median is `24` pixels wide, outer shoulders are equal, and each raw alignment leg is cardinal or belongs to a sampled quarter curve with radius at least `8 * TILE_SIZE`.

- [ ] **Step 2: Build routes from cardinal legs and quarter-curve corners**

  Use explicit city portal points, choose horizontal-first or vertical-first routing per profile, shorten both legs by the fixed curve radius, and insert a 90-degree circular arc sampled every `TILE_SIZE / 2`. Reject any direct diagonal segment.

- [ ] **Step 3: Offset the same centreline symmetrically**

  Compute both carriageways at `±(medianWidth / 2 + pavementWidth / 2)` from the same tangent/normal field, reverse only the legal-driving order of Direction B, and publish three lanes with `laneWidth = TILE_SIZE`.

- [ ] **Step 4: Emit graph edges before city planning**

  Resample at a stable graph interval, emit one-way `carriageway` edges with `laneCount: 3`, connect terminal transitions to primary-city anchors, and call `UrbanPlanner.generate` only after the accepted highway plan exists.

- [ ] **Step 5: Validate deterministic topology**

  Run: `npm run validate:highways && npm run typecheck`

  Expected: three routes, six three-lane carriageways, six simple city junctions, zero diagonal edges, and bidirectional city reachability.

### Task 3: Rebuild rest areas and short entry/exit branches

**Files:**

- Modify: `src/generation/HighwayPlanner.ts`
- Modify: `src/systems/WorldManager.ts`
- Test: `scripts/highway-validation.ts`

**Interfaces:**

- Consumes: centreline arc distance and carriageway side.
- Produces: recurring `HighwayServiceArea` records and three-edge deceleration/parking/acceleration loops.

- [ ] **Step 1: Assert complete service programs and legal access**

  Require every area to contain `fuel`, `parking`, `toilets`, `coffee`, and `truck-parking`, have visitor and vehicle spawn points, and own one deceleration, one service, and one acceleration edge.

- [ ] **Step 2: Place areas at stable long intervals**

  Sample route distances outside city clear zones, alternate carriageway sides, and skip sites whose clear rectangle intersects a curve or another road corridor.

- [ ] **Step 3: Generate short parallel access geometry**

  Build a cardinal offset branch with two large-radius corner samples, a parking/service segment parallel to the carriageway, and monotonic taper metadata; never emit a loop, overpass, or diagonal connector.

- [ ] **Step 4: Paint functional rest-area pads**

  Keep the existing tile-grid pad ownership, but stamp one fuel building, café/restroom building, car parking rows, truck bays, signs, NPC vehicle spawns, and pedestrian spawns without overwriting graph asphalt.

- [ ] **Step 5: Validate access continuity**

  Run: `npm run validate:highways`

  Expected: every rest-area access path enters and leaves the legal carriageway direction without a dead end or reverse edge.

### Task 4: Create the dedicated highway tile vocabulary and clean chunk painter

**Files:**

- Create: `src/gameplay/highway/HighwayTileset.ts`
- Rewrite: `src/gameplay/highway/HighwayCanvasPainter.ts`
- Modify: `src/gameplay/highway/HighwayGeometry.ts`
- Modify: `src/gameplay/highway/index.ts`
- Test: `scripts/highway-validation.ts`

**Interfaces:**

- Consumes: chunk-local mainline, median, junction, service-road, furniture, and scenery records.
- Produces: one static canvas texture per chunk using `HIGHWAY_TILESET`, plus seamless edge/curve continuity statistics.

- [ ] **Step 1: Define one pixel-art palette and cross-section**

  Export immutable asphalt, shoulder, marking, concrete, rail, verge, shadow, and reflector colors with `laneWidth = 32`, `shoulderWidth = 12`, `medianWidth = 24`, `edgeLineWidth = 2`, `laneDash = [18, 14]`, and integer-aligned render dimensions.

- [ ] **Step 2: Paint layers in a single consistent order**

  Draw verge, edge shadow, shoulders, asphalt, concrete median, white edges, two dashed separators per direction, outer guard rail, short service branches, simple intersection deck/stop line, then sparse scenery. Use the same sampled path for every offset layer.

- [ ] **Step 3: Remove forbidden visual systems**

  Delete elevated-ramp ordering, circulating-road islands, giant gore hatching, city-gate megastructures, random median styles, emergency-lane decoration, and dense asphalt clutter.

- [ ] **Step 4: Preserve seamless chunk boundaries**

  Bucket full-distance spline samples with bleed, keep dash phase based on route arc distance, use round caps/joins only on curve samples, and require matching edge/median/rail sample counts.

- [ ] **Step 5: Validate render geometry**

  Run: `npm run validate:highways && npm run build`

  Expected: every route section enters the spatial index, all fixed-width layers share arc distance, and no forbidden ramp/gore/gate section exists.

### Task 5: Enforce highway-aware traffic behavior

**Files:**

- Modify: `src/systems/WorldManager.ts`
- Modify: `src/gameplay/traffic/TrafficNetwork.ts`
- Modify: `src/gameplay/traffic/TrafficDriver.ts`
- Modify: `src/gameplay/traffic/TrafficValidator.ts`
- Test: `scripts/traffic-validation.ts`

**Interfaces:**

- Consumes: three-lane one-way mainline edges, junction priority, short acceleration/deceleration edges, cached lane splines.
- Produces: lane-contained cruising, safe overtaking, merge/exit commitment, aligned non-overlapping spawns, and no-reverse recovery.

- [ ] **Step 1: Extend deterministic traffic assertions**

  Run highway agents through three-lane cruising, overtaking, junction approach, service exit, service re-entry, and congestion scenarios; assert lane containment, same-direction lane changes, downstream gap acceptance, zero median crossing, zero grass entry, zero reverse motion, and non-overlapping aligned spawns.

- [ ] **Step 2: Map the planner contract directly into runtime edges**

  Preserve `laneCount: 3`, design speed, priority, direction, junction id, and lane-transition metadata in `WorldManager.buildRoadEdge` without terminal single-lane tapering on mainline edges.

- [ ] **Step 3: Apply component state-machine policy**

  Cruise/overtake on mainline, commit before deceleration, yield only while merging, maintain priority through highway junctions, and disallow reversing for every highway-owned component.

- [ ] **Step 4: Reuse cached lane splines and perception buckets**

  Build navigation/lane geometry once per accepted road graph, query nearby vehicles through the existing spatial index, and keep all hot-loop arrays and component references allocation-free.

- [ ] **Step 5: Run the traffic simulation**

  Run: `npm run validate:traffic`

  Expected: ten simulated minutes pass with no wrong direction, unexplained stop, sideways/overlapping spawn, collision, median crossing, grass entry, or reverse recovery.

### Task 6: Verify streaming, batching, LOD, and visual quality

**Files:**

- Modify: `src/gameplay/highway/HighwayRenderSystem.ts`
- Modify: `src/systems/WorldManager.ts`
- Modify: `src/config/EngineLimits.ts`
- Modify: `src/systems/ProfilerSystem.ts`
- Modify: `scripts/highway-performance.ps1`
- Modify: `docs/HIGHWAY_SYSTEM.md`

**Interfaces:**

- Consumes: camera/player chunk, geometry index, texture cache, traffic scheduler tiers.
- Produces: bounded resident chunks, pooled static images, near/medium/far art, inactive distant AI, performance report, and screenshot evidence.

- [ ] **Step 1: Keep all static art chunk-batched**

  Acquire/release pooled chunk images, cache raster textures in the bounded LRU, allow at most one chunk operation per frame, and avoid per-marking/per-rail collision objects.

- [ ] **Step 2: Apply distance policy**

  Near chunks include rails, signs, rest-area actors, and sparse vegetation; medium chunks omit small props; far chunks retain only verge, road, markings, and median. Full/coarse/statistical/dormant traffic tiers remain distance-driven.

- [ ] **Step 3: Run all static checks**

  Run: `npm run typecheck && npm run lint && npm run build && npm run validate:highways && npm run validate:traffic`

  Expected: all commands pass.

- [ ] **Step 4: Capture representative routes in the browser**

  Start Vite on a free port and capture Alborz, desert, Caspian, a city junction, a large-radius curve, and a service area at gameplay zoom. Reject broken edges, stair steps, exposed terrain, missing rails, mismatched dash phase, overlapping asphalt, or procedural clutter.

- [ ] **Step 5: Profile highway traversal**

  Run: `npm run profile:highways`

  Expected: stable 60 FPS target, bounded chunk builds/cache, one batched draw per visible highway chunk, no full-route scans per frame, no decorative colliders, and distant traffic outside the full-update tier.

- [ ] **Step 6: Record the implemented contract and evidence**

  Update `docs/HIGHWAY_SYSTEM.md` with the fixed cross-section, route grammar, junction rules, rest-area rules, traffic policy, cache/LOD limits, validation counts, screenshots, and measured final performance.
