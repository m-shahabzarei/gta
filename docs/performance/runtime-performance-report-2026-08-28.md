# Runtime Performance Report — 2026-08-28

Baseline commit: `5335cc2b989d0f97375e9264c9f34bb7e26dac0d`.

## Evidence

The deterministic headless traffic harness was run with the same seeds before and after the changes. Baseline data is in [runtime-baseline-2026-08-28.json](./runtime-baseline-2026-08-28.json); the repeat is in [runtime-after-2026-08-28.json](./runtime-after-2026-08-28.json). The post-change harness now retains real wall-clock frame samples and reports p50/p95/p99 and long-frame counts.

Across the 14 traffic/highway/pause/long-session scenarios:

| Metric | Before | After | Change |
|---|---:|---:|---:|
| Mean reported frame cost | 0.260 ms | 0.166 ms | -36.1% |
| Mean harness wall-clock cost | 1095.2 ms | 837.6 ms | -23.5% |
| Deterministic speed/throughput/stop outputs | baseline | identical | preserved |

Representative post-change real-frame distributions (headless harness): Tehran medium p50/p95/p99 `0.165/0.415/1.486 ms`; bus/taxi `0.147/0.280/0.717 ms`; 30-minute idle `0.116/0.236/0.566 ms`, with 3 frames over 20 ms, 1 over 33 ms and none over 50 ms. These are CPU harness measurements, not GPU/browser measurements.

The clean-commit harness output did not retain individual frame samples, so the baseline JSON intentionally reports null p50/p95/p99 and long-frame counters; its mean frame and wall-clock totals are still directly comparable. The updated harness records those distributions for all future baselines.

## Changes and trade-offs

| Bottleneck measured | Change | Risk / rollback | Validation |
|---|---|---|---|
| Per-frame EntityManager nested stats and enum-array allocations; redundant spatial-index writes | Reuse the live stats object, stable category/tier arrays, and skip index updates below a 1 px displacement | Spatial queries can lag by less than 1 px; revert the threshold block if a caller requires sub-pixel indexing | Typecheck, gameplay validation, mobile validation |
| Traffic scheduler created work objects, tier maps, percentile copies, histograms and four deferred closures per fixed step | Reuse work slots, queues, counters, samples and histogram; compute age aggregates in one pass; preserve cadence, staleness ordering and budget | Telemetry requires immutable history, so `TrafficTelemetryCollector` copies scheduler samples at the observation boundary; revert scheduler pooling as one unit | Traffic validation, telemetry/lifecycle validation, deterministic stress replay |
| Snapp force-near check performed a driver snapshot plus a linear vehicle scan for every driver | Refresh a stable Snapp-id set once per fixed step and use O(1) membership | Set is rebuilt each fixed step; no semantic change; revert `snappDriverIds` path | Traffic stress outputs and transit validation |
| Phone-open traffic tick repeated the same linear Snapp lookup for every rendered driver and allocated predicates | Reuse the fixed-step Snapp-id set and stable predicates for near-forcing, rendering and bounded recovery filtering | The set is refreshed before each phone render; booking ownership semantics are unchanged; revert the stable callbacks if modal behavior changes | Typecheck, traffic/transit validation, phone-modal browser smoke |
| Vehicle collision narrow phase recalculated sin/cos for the same pose across every candidate pair | Cache OBB local axes on reusable poses, invalidated by heading changes | Cache is optional on public pose inputs and collision math is unchanged; remove `ensurePoseAxes` and cache fields to roll back | 33 collision scenarios / 78 tolerance checks |
| VehicleSystem allocated a stale list and sliced it during every update | Reuse bounded stale worklist and index only the removal prefix | Worklist is cleared at frame start; revert `staleVehicles` change | Typecheck, collision/traffic/gameplay validation |
| World queue used `shift()` while staged chunk operations drained | Add a queue head cursor and reset only after drain | Queue order and one-operation-per-frame budget unchanged; revert cursor fields/logic | Build and highway validation; browser smoke recommended |
| HUD/minimap rewrote unchanged text/transforms and allocated blip records/callbacks every frame | Dirty guards for speed, compass and region; reusable minimap blip records and stable service-blip callback | Compass updates use a 1e-4 radian epsilon; remove guards if visual QA finds a requirement for sub-epsilon updates | Typecheck, lint, build, mobile validation |
| Existing profiler exposed smoothed simulation delta rather than wall-clock distribution | Add a 600-sample wall-clock ring with p50/p95/p99 and >20/33/50 ms counters | Diagnostic-only fields; no simulation timing changed | Build and stress harness output |

### Cost and expected-improvement notes

The deterministic harness provides the aggregate before/after cost above; the browser-only per-system timings remain available through `ProfilerSystem`. For each change, the measured current operation and expected improvement were:

| Change | Measured current cost | Expected improvement |
|---|---|---|
| EntityManager stats/indexing | Three nested stats records plus enum-array enumeration and a spatial-index call on each eligible update | Reuse one stats view and stable arrays; skip sub-pixel index work |
| Traffic scheduler | Per-fixed-step work records, tier maps, percentile copy, histogram and deferred closures | Reuse bounded records/collections while preserving cadence, staleness ordering and budget |
| Snapp checks | Driver snapshot plus linear vehicle scan per driver | One set build per fixed step plus O(1) membership checks |
| Collision geometry | Repeated `sin`/`cos` for unchanged pose headings across candidate pairs | Cached local axes eliminate redundant trigonometry; collision outputs remain identical |
| Vehicle/world queues | Per-update stale-list copy and `shift()` array compaction | Reused removal list and queue head cursor remove those copies/compactions |
| HUD/minimap | Unchanged Phaser text/transforms and fresh blip records/callbacks each frame | Dirty guards and reusable records suppress property writes and allocations |

No standalone GPU, heap/GC or input-latency baseline was available in the headless harness; those metrics are explicitly called out in the coverage section rather than inferred.

## Coverage limits

The headless harness does not expose Phaser GPU time, browser heap/GC pauses, input-to-update latency, or real mobile rendering. A local headless Chrome smoke did pass the mobile interaction/layout matrix (landscape viewport `844x390`, smallest touch target `46px`, no gameplay runtime errors). A short desktop Chrome stress sample also captured real browser timings, but is not a release target: GPU-enabled headless Chrome averaged `54.6 ms` per sampled frame (`p95 72.7 ms`, maximum `99.5 ms`, 22.4 FPS) and reported the existing `TrafficSystem`/`TransportationSystem` blocker diagnostics plus headless pointer-lock warnings. The sample ran under a constrained automation host and the traffic validator reported failures during that run, so it is retained as a follow-up signal rather than a before/after claim. Full GPU, heap/GC, input-latency and representative-device runs remain available through `ProfilerSystem`, `browser-stress.ps1`, `highway-performance.ps1`, and `mobile-browser-smoke.ps1` before release.

No traffic density, speed, route semantics, collision impulse/damage behavior, spawn rules, or gameplay-critical LOD distances were changed.
