# Traffic P0 Telemetry and Deterministic Stress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add non-invasive traffic telemetry, deterministic replay capture, lifecycle diagnostics, and bounded stress baselines without changing traffic behavior.

**Architecture:** Keep `TrafficSystem`, `TrafficDriver`, `TrafficNetwork`, `TrafficUpdateScheduler`, `IntersectionReservationController`, `VehicleSystem`, and `EventBus` as the owners of simulation behavior. Add a focused telemetry collector with immutable snapshots and JSON serialization, then instrument existing decision points only. Add a Node-level deterministic runner for headless measurements and make the browser harness preserve partial telemetry while distinguishing CDP failures from gameplay failures.

**Tech Stack:** TypeScript strict, Phaser 3 runtime, Node 20 ESM scripts, esbuild validation bundles, PowerShell CDP harness, existing deterministic `Random` utility.

## Global Constraints

- No traffic behavior, speed, capacity, signal duration, recovery timeout, or distance threshold changes.
- No teleport, signal bypass, collision disablement, random deletion, or second physics integrator.
- Preserve the existing traffic architecture and public APIs.
- Instrumentation must not remove vehicles or alter lifecycle decisions.
- Metrics that cannot be measured must be serialized as `"unknown"`, never guessed.
- Every stress stage has its own deadline; browser infrastructure failure is not a gameplay failure.

---

### Task 1: Define telemetry schemas and collector

**Files:**
- Create: `src/gameplay/traffic/TrafficTelemetry.ts`
- Modify: `src/gameplay/traffic/TrafficTypes.ts`
- Modify: `src/gameplay/traffic/index.ts`
- Test: `scripts/traffic-telemetry-validation.ts`

**Interfaces:**
- `TrafficTelemetryCollector` owns bounded event buffers, counters, histograms, and deterministic JSON snapshots.
- `TrafficTelemetryCollector.beginFrame(realNowMs, simulationNowMs, fixedStep)` starts a frame sample without modifying simulation state.
- `TrafficTelemetryCollector.recordDriverSnapshot(snapshot)` records a driver observation.
- `TrafficTelemetryCollector.recordStopEpisode(episode)` records a completed stop episode.
- `TrafficTelemetryCollector.recordLifecycle(event)` records spawn/materialize/virtualize/despawn observations.
- `TrafficTelemetryCollector.recordScheduler(sample)` and `recordIntersection(sample)` record subsystem samples.
- `TrafficTelemetryCollector.snapshot()` returns a JSON-safe `TrafficTelemetrySnapshot`.
- `TrafficTelemetryCollector.reset()` clears only telemetry buffers and counters.

- [ ] **Step 1: Write schema tests** for JSON-safe serialization, bounded event retention, `unknown` values, percentile calculation, and deterministic ordering by tick then vehicle id.
- [ ] **Step 2: Run the schema tests** through the existing Node/esbuild pattern and verify they fail before the collector exists.
- [ ] **Step 3: Add explicit types** for replay header, driver sample, stop episode, scheduler sample, junction sample, lifecycle event, baseline metrics, and scenario result.
- [ ] **Step 4: Implement the collector** with numeric aggregates, p50/p95 helpers, per-tier counters, update-age histogram buckets, and a configurable bounded event limit.
- [ ] **Step 5: Add a deterministic JSON serializer** that sorts maps/records by stable ids and emits `unknown` for unavailable values.
- [ ] **Step 6: Run the schema tests** and confirm deterministic output for identical input sequences.

### Task 2: Instrument driver snapshots and stop episodes

**Files:**
- Modify: `src/gameplay/traffic/TrafficDriver.ts`
- Modify: `src/gameplay/traffic/TrafficTypes.ts`
- Modify: `src/systems/TrafficSystem.ts`
- Test: `scripts/traffic-telemetry-validation.ts`

**Interfaces:**
- Add an optional telemetry sink to the existing `TrafficDriver` context; the sink is observational only.
- Add `TrafficDriver.telemetrySnapshot(now, tier)` returning the requested replay fields without changing `fixedUpdate` behavior.
- Add stop episode bookkeeping around existing state/desired-speed transitions; do not alter state transitions.

- [ ] **Step 1: Add tests** that feed synthetic driver snapshots/state transitions into the sink and assert one episode per continuous stop, with no `unexplained-stop` when a valid reason exists.
- [ ] **Step 2: Implement stop reason classification** from existing state, intention, collision prediction, reservation decision, destination purpose, recovery phase, and external stop flag. Preserve all existing branches and values.
- [ ] **Step 3: Capture episode start/end, lane, intersection, blocker, desired/actual speed, tier, update age, reservation state, downstream-clear flag, and before/after states.
- [ ] **Step 4: Close open episodes** on movement, despawn, destruction, or driver release; emit the final event only to telemetry.
- [ ] **Step 5: Add replay samples** containing world/simulation seed placeholders, tick, fixed-step, clock, city/district, route progress, pose, speed, state, intention, recovery, ownership, and current stop data.
- [ ] **Step 6: Run typecheck and telemetry validation** and verify vehicle motion and state transitions are byte-for-byte unchanged in the existing fixture.

### Task 3: Instrument scheduler execution and real frame timing

**Files:**
- Modify: `src/gameplay/traffic/TrafficUpdateScheduler.ts`
- Modify: `src/systems/TrafficSystem.ts`
- Modify: `src/core/ManagerRegistry.ts`
- Test: `scripts/traffic-telemetry-validation.ts`

**Interfaces:**
- Extend scheduler stats with per-tier scheduled/deferred counts, queue lengths, oldest deferred vehicle, max/average/p95 update age, near-deferred count, and per-driver execution samples.
- `TrafficUpdateScheduler.schedule()` keeps its existing queue order, budget, and execution behavior; instrumentation wraps execution only.
- `ManagerRegistry` passes real wall-clock frame start/end to diagnostics without changing the update order or delta clamp.

- [ ] **Step 1: Add tests** for a deliberately over-budget synthetic queue, asserting deferred counts and age metrics while the existing budget behavior remains identical.
- [ ] **Step 2: Measure each driver execution** with `performance.now()` and record the existing driver-reported navigation/steering/collision costs.
- [ ] **Step 3: Record pre/post queue lengths, per-tier counts, oldest deferred id, near deferred count, and catch-up delta buckets.
- [ ] **Step 4: Replace the misleading runtime `frameTimeMs = delta` assignment** with measured real frame wall time, while retaining the original simulation delta in a separately named telemetry field.
- [ ] **Step 5: Verify scheduler output and existing `TrafficRuntimeStats` behavior** remain unchanged except for additive telemetry fields.

### Task 4: Instrument intersection signals, queues, reservations, and divergence

**Files:**
- Modify: `src/gameplay/traffic/IntersectionReservationController.ts`
- Modify: `src/systems/TrafficSystem.ts`
- Modify: `src/systems/WorldManager.ts` only if a read-only visual/logical comparison hook cannot be added elsewhere
- Test: `scripts/traffic-telemetry-validation.ts`

**Interfaces:**
- Add observational callbacks for phase changes, queue insertion/removal, reservation grant/deny/release/timeout, connector entry/exit, and downstream-clear state.
- Add `IntersectionReservationController.telemetrySnapshot()` exposing current phase, queue ages, active reservations, and occupancy counters without changing decisions.

- [ ] **Step 1: Add tests** for grant, denial reasons, stale queue removal, timeout, release, connector entry/exit, and stable per-junction ordering.
- [ ] **Step 2: Record phase start/end and signal group** from the existing phase function; do not change constants or phase selection.
- [ ] **Step 3: Record queue length per incoming lane, oldest age, reservation status, denial reason, timeout, occupancy, downstream block duration, spillback depth, and deadlock candidates.
- [ ] **Step 4: Compare the existing visual `northSouth` flag with the existing logical heading-derived group** and record divergence only.
- [ ] **Step 5: Run reservation validation and confirm no grant/deny/release result changes.

### Task 5: Instrument lifecycle and ownership transitions

**Files:**
- Modify: `src/systems/TrafficSystem.ts`
- Modify: `src/systems/VehicleSystem.ts`
- Modify: `src/gameplay/traffic/ParkedVehicleManager.ts`
- Modify: `src/entities/Vehicle.ts` only if a non-mutating pool-transition hook is required
- Test: `scripts/traffic-telemetry-validation.ts`

**Interfaces:**
- Add lifecycle telemetry calls at existing accepted/rejected spawn, materialize, virtualize, retire, pending despawn, pool reuse, parking release, destruction, and player takeover points.
- Add explicit rejection reason values matching the P0 specification; classification must not change the existing boolean decision.
- Record current ownership metadata and state at each event.

- [ ] **Step 1: Add tests** for every lifecycle case listed by the user, including connector/reservation, mission/emergency/pursuit, parked-to-player, pool reuse, stream change, update-order race, nearby materialization, and destruction/despawn overlap.
- [ ] **Step 2: Refactor `isSpawnClear` only enough to return an observational rejection reason alongside its existing boolean result; preserve all conditions and order.
- [ ] **Step 3: Record virtual-record metadata loss** in telemetry without changing `VirtualTrafficRecord`.
- [ ] **Step 4: Record protected-despawn rejection and orphan/race detection** when VehicleSystem removes a traffic vehicle before TrafficSystem can dematerialize it.
- [ ] **Step 5: Run lifecycle tests and existing traffic/highway validators.

### Task 6: Add deterministic Node stress runner and JSON baseline output

**Files:**
- Create: `scripts/traffic-stress.ts`
- Create: `scripts/run-traffic-stress.mjs`
- Modify: `package.json`
- Create: `scripts/traffic-stress-scenarios.json`
- Create: `scripts/traffic-stress-validation.ts`

**Interfaces:**
- Scenario configuration includes stable seed, world seed, simulation seed, city/district, density, weather, wanted level, obstacle mode, transit mode, player traversal mode, duration, and deadline.
- Runner output is one JSON object per scenario with replay header, telemetry summary, baseline metrics, failures, and `unknown` values where the headless fixture cannot measure a metric.
- The runner must use the existing `Random` class and existing network/controller/driver fixtures; it must not invent a second traffic simulation.

- [ ] **Step 1: Define the 14 requested scenarios** with explicit seeds and durations; make 15-minute and 30-minute no-input runs bounded by wall-clock deadlines.
- [ ] **Step 2: Implement the headless runner** around the existing deterministic traffic validation fixture and telemetry collector.
- [ ] **Step 3: Implement junction crossing counters, speed/stop distributions, delay percentiles, update-age metrics, lifecycle counts, and invariant failures.
- [ ] **Step 4: Emit stable JSON files** under a generated output directory ignored by git, preserving partial output on failure.
- [ ] **Step 5: Add an npm script** and run a short smoke scenario, then the full deterministic scenario matrix.

### Task 7: Bound browser stress deadlines and preserve telemetry on failure

**Files:**
- Modify: `scripts/browser-stress.ps1`
- Modify: `scripts/traffic-stress-validation.ts` if browser JSON normalization is shared

**Interfaces:**
- Every CDP receive, command, readiness phase, sampling phase, and finalization phase has an independent finite deadline.
- Partial samples are written before throwing; infrastructure failures use a distinct status such as `infrastructure-timeout`.
- Gameplay errors remain in the telemetry payload and are not conflated with CDP transport errors.

- [ ] **Step 1: Add a deadline helper** that creates a linked cancellation token per phase without infinite timeout.
- [ ] **Step 2: Capture the last successful telemetry sample** before any timeout exception and write it to a deterministic output path.
- [ ] **Step 3: Return structured status** separating `passed`, `gameplay-failure`, `infrastructure-timeout`, and `not-started`.
- [ ] **Step 4: Run the harness with a short duration** and verify that a forced CDP timeout preserves the sample tail and exits within the deadline.

### Task 8: Verification, baseline report, and scope audit

**Files:**
- Create: `docs/traffic-p0-baseline.json` only if generated baseline is small and reviewable
- Create: `docs/TRAFFIC_P0_TELEMETRY.md`
- No behavioral traffic files beyond Tasks 1–5

- [ ] **Step 1: Run `npm run typecheck`.**
- [ ] **Step 2: Run `npm run lint`.**
- [ ] **Step 3: Run `npm run validate:traffic`.**
- [ ] **Step 4: Run `npm run validate:highways`.**
- [ ] **Step 5: Run the deterministic stress matrix and record only measured values.
- [ ] **Step 6: Run browser stress/smoke with bounded deadlines and record infrastructure status separately.
- [ ] **Step 7: Diff all changed files and verify that no speed, cap, signal, reservation, spawn, virtualize, despawn, collision, or recovery constants changed.
- [ ] **Step 8: Document file changes, schema, seeds, baseline table, top five measured stop/throughput causes, maximum update/queue ages, divergence, race/orphan counts, limitations, and data-backed P1 recommendations.

