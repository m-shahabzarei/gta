# Traffic Startup Freeze Root Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make New Game enter gameplay promptly by removing the all-parking-by-all-lanes scan from TrafficNetwork construction.

**Architecture:** Build the immutable lane spatial index immediately after lane and junction creation. Validate generated and authored parking against nearby indexed lanes, then build the parking index only after all filtering and bus-stop reservation are complete.

**Tech Stack:** TypeScript, Phaser 3, existing esbuild traffic validation, Vite.

## Global Constraints

- Preserve geometric parking clearance and bus-stop curb reservation behavior.
- Preserve the current directed lane graph and route APIs.
- Keep the user's unrelated worktree changes intact.
- TrafficNetwork startup validation must exercise hundreds of nodes and thousands of lanes/parking checks.

---

### Task 1: Add a large-network startup regression

**Files:**
- Modify: `scripts/traffic-validation.ts`
- Test: `npm run validate:traffic`

**Interfaces:**
- Produces: `validateLargeNetworkStartupBudget(): void`.
- Consumes: `TrafficNetwork(nodes, lights)` and `performance.now()`.

- [x] **Step 1: Add the deterministic grid fixture**

Create an 18 by 14 bidirectional road grid with 384-pixel spacing and cardinal neighbor lists, construct a TrafficNetwork, assert it contains more than 1,000 lanes, and assert construction completes within 8,000 ms even under concurrent build load.

```ts
const startedAt = performance.now();
const largeNetwork = new TrafficNetwork(nodes, []);
const elapsedMs = performance.now() - startedAt;
check(largeNetwork.laneCount > 1_000, 'startup fixture is too small');
check(elapsedMs < 8_000, `large traffic startup took ${elapsedMs.toFixed(1)} ms`);
```

- [x] **Step 2: Run the regression before the fix**

Run: `npm run validate:traffic`

Expected: FAIL or exceed the command deadline because parking clearance falls back to a full lane scan before `laneIndex` exists.

### Task 2: Build lane and parking indexes in dependency order

**Files:**
- Modify: `src/gameplay/traffic/TrafficNetwork.ts:136-156,1254-1274`
- Test: `npm run validate:traffic`

**Interfaces:**
- Produces: `buildLaneSpatialIndex(): void` and `buildParkingSpatialIndex(): void`.
- Consumes: `vehicleFootprintHasTravelClearance()`, which automatically uses `laneIndex` when populated.

- [x] **Step 1: Split the combined index builder**

Move the lane loop into `buildLaneSpatialIndex()` and the parking loop into `buildParkingSpatialIndex()` without changing cell size, sampling, or bucket contents.

- [x] **Step 2: Reorder TrafficNetwork construction**

After `buildConflictSets()`, call `buildLaneSpatialIndex()`; then filter generated parking, add authored parking, reserve bus-stop spans, construct the lane graph, and finally call `buildParkingSpatialIndex()`.

```ts
this.buildLaneSpatialIndex();
this.removeParkingThatConflictsWithTrafficLanes();
this.addAuthoredParkingSpaces(authoredParkingSites);
this.reserveParkingAtBusStops(reservedBusStops);
this.graph = new LaneGraph(this.lanesById);
this.buildParkingSpatialIndex();
```

- [x] **Step 3: Run validation**

Run: `npm run validate:traffic`

Expected: PASS, including the large-network startup budget and existing 481,000-plus traffic invariants.

- [x] **Step 4: Run typecheck and production build**

Run: `npm run typecheck`
Expected: PASS.

Run: `npm run build`
Expected: PASS.

## Self-Review

1. **Spec coverage:** Task 1 reproduces constructor-scale startup work; Task 2 eliminates the quadratic fallback while retaining every clearance check.
2. **Placeholder scan:** no deferred or unspecified implementation steps remain.
3. **Type consistency:** both new methods are parameterless private methods over the existing lane and parking collections.

## Execution Handoff

The user explicitly requested an immediate root fix, so this plan is executed inline in the current session.
