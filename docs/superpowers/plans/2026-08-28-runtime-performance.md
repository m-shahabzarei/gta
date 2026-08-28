# Runtime Performance Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve frame-time stability and runtime responsiveness in the existing Phaser 3 game while preserving simulation, traffic, collision, rendering, and mobile semantics.

**Architecture:** Establish a deterministic, wall-clock baseline from the existing telemetry and validation harnesses, then make bounded, allocation-free hot-path changes. Keep collision behavior and traffic cadence unchanged; expose before/after telemetry so each optimization is attributable and reversible.

**Tech Stack:** TypeScript strict mode, Phaser 3.80, Vite, Node validation scripts, browser smoke/profiling hooks.

## Global Constraints

- Performance-only phase; no new gameplay, content, traffic rules, vehicle behavior, or collision behavior.
- Preserve deterministic simulation, pooling, LOD, mobile support, and existing collision-system changes.
- Do not change global vehicle speed, traffic density, `MAX_TRAFFIC`, signal timings, route semantics, spawn logic, gameplay-critical LOD distances, or damage/impulse behavior.
- Measure real wall-clock timing before and after every material change.

### Task 1: Capture and document the baseline

**Files:**
- Create: `docs/performance/runtime-baseline-2026-08-28.json`
- Create: `scripts/runtime-performance-baseline.ts`
- Create: `scripts/run-runtime-performance-baseline.mjs`

**Interfaces:**
- Produces deterministic scenario summaries with frame-time percentiles, long-frame counts, system timers, memory and entity counts.

- [x] Inspect current git state and run `npm run typecheck`, traffic stress, and collision validation.
- [x] Add a Node harness that records wall-clock frame samples and existing profiler/traffic/collision telemetry without changing simulation constants.
- [x] Run the harness with a fixed seed and save JSON plus the exact commit hash.

### Task 2: Remove avoidable scheduler and traffic allocations

**Files:**
- Modify: `src/gameplay/traffic/TrafficUpdateScheduler.ts`
- Modify: `src/gameplay/traffic/TrafficPerceptionIndex.ts`

**Interfaces:**
- Preserve `schedule`, `stats`, `telemetry`, tier cadence, ordering and fairness fields.

- [x] Replace per-call temporary percentile/sort and execution maps with reusable buffers while retaining deterministic ordering and telemetry values.
- [x] Reuse perception obstacle/lane buffers and avoid rebuilding collections when contents are unchanged.
- [x] Run traffic validation and stress replay; compare update-age and fairness telemetry.

### Task 3: Optimize vehicle collision hot paths without behavior changes

**Files:**
- Modify: `src/gameplay/vehicle/VehicleCollisionRuntime.ts`
- Modify: `src/gameplay/vehicle/VehicleCollisionGeometry.ts`
- Modify: `src/gameplay/vehicle/VehicleCollisionTelemetry.ts`

**Interfaces:**
- Preserve contact ordering, impulse math, damage attribution, event/audio dispatch and telemetry schema.

- [x] Reuse candidate/contact records and cache pose axes/half-extents only when heading/size changes.
- [x] Keep broadphase pair limits and deterministic numeric-id ordering intact.
- [x] Run vehicle-collision validation and compare collision counts, damage and telemetry.

### Task 4: Reduce lifecycle and rendering churn

**Files:**
- Modify: `src/systems/EntityManager.ts`
- Modify: `src/systems/VehicleSystem.ts`
- Modify: `src/systems/WorldManager.ts`
- Modify: `src/systems/NavigationSystem.ts`
- Modify: `src/ui/hud/*` (only dirty-flag fixes where measured)

**Interfaces:**
- Preserve activation, pooling, world streaming order, collider readiness, navigation semantics and HUD output.

- [x] Gate repeated visibility/body/spatial-index writes on state changes.
- [x] Reuse bounded streaming work buffers and avoid duplicate chunk requests/rebuilds.
- [x] Gate unchanged HUD/minimap/debug redraws and keep developer overlays opt-in.
- [x] Run typecheck, lint, build, gameplay/highway/mobile validations and browser smoke where available.

### Task 5: Record before/after evidence and trade-offs

**Files:**
- Create: `docs/performance/runtime-performance-report-2026-08-28.md`

- [x] Run the baseline harness after changes using the same seed/scenarios.
- [x] Report measured bottleneck, current cost, improvement, correctness/visual/mobile risk, rollback and validation for each change.
- [x] Confirm no working-tree changes were overwritten and list remaining measurement limitations.
