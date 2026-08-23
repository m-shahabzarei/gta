# Economy and Directed Bus Stops Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start a new player with exactly $700 while preserving saved wallets, and make every bus serve a lane-backed, directional curb stop before continuing its route.

**Architecture:** `InventoryComponent` remains the sole wallet authority. `BusStopSite` is expanded from a visual platform plus loose approach point into a directed traffic-lane stop target (lane id, arc distance, stopping position, approach/resume data); `TrafficDriver` accepts that explicit lane target rather than reselecting the closest lane. `TransportationSystem` keeps one cached target stop per bus and drives a state machine through approach, alignment, dwell/boarding, and departure.

**Tech Stack:** TypeScript, Phaser 3, Vite, esbuild validation harness, Chrome DevTools Protocol smoke tests.

## Global Constraints

- New-game player money is exactly `700`; the saved `InventoryComponent` balance wins when a save is loaded.
- Money is never duplicated in HUD, taxi, shop, or vehicle-shop state.
- Buses use shared `TrafficNetwork` lanes and cached directed route targets; no teleporting, giant triggers, or per-frame A* / global stop scans.
- A bus is boardable only while stopped at its own target curb and its boarding phase is active.
- Dwell time remains configurable per route and is approximately five seconds.
- Route validation must report stop-specific invalid lane, stop-position, direction, and connectivity failures.

---

### Task 1: Establish and persist the new-game wallet

**Files:**

- Modify: `src/config/Constants.ts: PLAYER.START_MONEY`
- Modify: `src/systems/PlayerController.ts: createPlayer and deserialize`
- Modify: `src/ui/hud/GameHud.ts` or `src/core/types/HudState.ts`
- Test: `scripts/transit-validation.ts`

**Interfaces:**

- Consumes: `new InventoryComponent(PLAYER.START_MONEY)`, `InventoryComponent.setMoney(number)`, `PlayerController.deserialize(Json)`.
- Produces: a constructed player whose `inventory.money === 700`, an initial `MoneyChanged` event with that same value, and save restores that replace rather than reset it.

- [ ] **Step 1: Write failing wallet assertions**

```ts
check(PLAYER.START_MONEY === 700, 'new games must start with $700');
const wallet = new InventoryComponent(PLAYER.START_MONEY);
check(wallet.money === 700, 'new player wallet must own the HUD balance');
wallet.setMoney(615);
check(wallet.money === 615, 'saved wallet balance must not be reset to starting cash');
```

- [ ] **Step 2: Run the assertion harness and observe the `$0` failure**

Run: `npm run validate:transit`

Expected: failure stating that the new-game balance is not `$700`.

- [ ] **Step 3: Make the wallet source authoritative**

```ts
export const PLAYER = {
  // ...existing fields
  START_MONEY: 700,
} as const;

// after a Player is created, publish the actual inventory value rather than a HUD default
eventBus.emit(EventKeys.MoneyChanged, { total: player.inventory.money, delta: 0 });
```

Keep `PlayerController.deserialize` using `restoreInventory` / `setMoney`; do not write starting money during load.

- [ ] **Step 4: Re-run the harness and typecheck**

Run: `npm run validate:transit; npm run typecheck`

Expected: wallet initialization and saved-wallet assertions pass with no TypeScript errors.

- [ ] **Step 5: Verify the real taxi debit**

Run: `npm run smoke:transit`

Expected: the browser probe begins at `$700`, confirms one legal taxi quote, and observes exactly one debit equal to the quoted fare.

### Task 2: Represent a physical, directional bus stop target

**Files:**

- Modify: `src/gameplay/types/WorldTypes.ts: BusStopSite`
- Modify: `src/systems/WorldManager.ts: createBusStopCandidate, sampleBusStops, placeBusStops`
- Modify: `src/gameplay/transit/TransitTypes.ts`
- Test: `scripts/transit-validation.ts`

**Interfaces:**

- Consumes: `TrafficNetwork.lane(id)`, `TrafficNetwork.pointAt(lane, distance)`, generated road-edge lane geometry.
- Produces: `BusStopSite.stopPosition`, `stopLaneId`, `stopLaneDistance`, `approachPosition`, `resumePosition`, and a heading that all derive from the same directed lane.

- [ ] **Step 1: Write a failing directed-stop fixture assertion**

```ts
const lane = network.lane(stop.laneId);
check(lane?.kind === 'travel', 'stop must reference a travel lane');
check(distance(stop.stopPosition, network.pointAt(lane!, stop.laneDistance).point) < 1,
  'stop position must be sampled from its named lane');
check(dot(stop.approachDirection, network.pointAt(lane!, stop.laneDistance).tangent) > 0.99,
  'stop approach direction must match lane direction');
```

- [ ] **Step 2: Run the fixture validation and observe missing explicit-stop data**

Run: `npm run validate:transit`

Expected: type or assertion failure until every fixture stop has directed stop metadata.

- [ ] **Step 3: Generate the stop from the traffic lane, not hand-built coordinates**

```ts
const lane = network.lane(candidate.laneId)!;
const pose = network.pointAt(lane, candidate.laneDistance);
return {
  ...platformFields,
  laneId: lane.id,
  stopPosition: { ...pose.point },
  approachPosition: network.pointAt(lane, Math.max(0, candidate.laneDistance - approachDistance)).point,
  resumePosition: network.pointAt(lane, Math.min(lane.spline.length, candidate.laneDistance + resumeDistance)).point,
  approachDirection: { ...pose.tangent },
};
```

Render the sign/bench at the pedestrian platform and the curb-bay stripe adjacent to `stopPosition`; keep their separation within the bus-side visual tolerance.

- [ ] **Step 4: Re-run fixture validation**

Run: `npm run validate:transit`

Expected: every fixture stop has a valid lane, exact lane sampling, curb clearance, and a directional approach.

### Task 3: Route buses to an explicit lane stop and add a stop state machine

**Files:**

- Modify: `src/gameplay/traffic/TrafficTypes.ts` (if a typed explicit destination is needed)
- Modify: `src/gameplay/traffic/TrafficDriver.ts: configure, refreshDestination, destinationSpeedLimit, reachedExplicitDestination`
- Modify: `src/systems/TrafficSystem.ts: configureDriver / service target overload`
- Modify: `src/systems/TransportationSystem.ts: BusRuntime, updateBus, bus target helpers`
- Test: `scripts/transit-validation.ts`

**Interfaces:**

- Consumes: `BusStopSite.laneId`, `BusStopSite.laneDistance`, cached route lane ids, `TrafficDriver.arrived`.
- Produces: `FOLLOWING_ROUTE | APPROACHING_STOP | ALIGNING_WITH_STOP | STOPPED_AT_STOP | BOARDING | DEPARTING_STOP | RECOVERING` bus states and a driver that only reports arrival on the named lane at the named stop distance.

- [ ] **Step 1: Write a failing target-lane regression test**

```ts
const target = { position: stop.stopPosition, laneId: stop.laneId, laneDistance: stop.laneDistance };
check(network.findCompleteRoute(origin.id, target.laneId) !== null,
  'bus must route to the stop lane, not whichever lane is nearest to its visual point');
check(target.laneId !== oppositeDirectionLane.id,
  'opposite-direction curb must not satisfy this stop target');
```

- [ ] **Step 2: Run the test and observe closest-lane target selection**

Run: `npm run validate:transit`

Expected: regression fails until driver destination selection honors `laneId`.

- [ ] **Step 3: Add a typed lane-bound target to traffic navigation**

```ts
export interface TrafficStopTarget {
  position: Vector2;
  laneId: string;
  laneDistance: number;
  heading: number;
}

// destination selection
const goal = target.laneId ? network.lane(target.laneId) : network.nearestLane(target.position, undefined, true);
// arrival requires route/current lane, forward progress, range, low speed, and heading alignment
```

Use `laneDistance` to calculate braking distance so buses slow before the stop. Cache/reuse route paths and invoke `forceReplan()` only on target changes or recovery attempts.

- [ ] **Step 4: Drive each bus through explicit state transitions**

```ts
FOLLOWING_ROUTE -> APPROACHING_STOP -> ALIGNING_WITH_STOP -> STOPPED_AT_STOP
STOPPED_AT_STOP -> BOARDING -> DEPARTING_STOP -> FOLLOWING_ROUTE
```

`STOPPED_AT_STOP` requires matching route id, named stop lane, decreasing/progressed approach, stop-radius check, low speed, and heading alignment. Only that state opens player/NPC boarding; its configurable timer transitions to `DEPARTING_STOP`, clears boarding, targets the resume segment, then advances the cached next-stop index.

- [ ] **Step 5: Re-run validation and typecheck**

Run: `npm run validate:transit; npm run typecheck`

Expected: the target-lane, state-machine, and exact-stop checks pass.

### Task 4: Validate complete authored route connectivity and recover failures safely

**Files:**

- Modify: `src/systems/TransportationSystem.ts: resolveConfiguredRoutes, resolveRouteStops, recovery logging`
- Modify: `scripts/transit-validation.ts`
- Modify: `scripts/transit-browser-smoke.ps1`

**Interfaces:**

- Consumes: `TrafficNetwork.findCompleteRoute(startLaneId, stopLaneId)`, resolved route stop records.
- Produces: `validateBusRoutes()` diagnostics with stop-by-stop status and cached segment lane ids.

- [ ] **Step 1: Write failing route diagnostics fixtures**

```ts
check(report.stops[2]?.status === 'error', 'invalid stop lane must identify its stop index');
check(report.stops[2]?.reason === 'no valid road connection',
  'invalid stop must expose the route-connectivity reason');
check(report.connectivity === 'valid', 'a complete directed route loop must be declared valid');
```

- [ ] **Step 2: Run validation and observe that only broad route validity is reported**

Run: `npm run validate:transit`

Expected: tests fail until reports identify individual stops and route segments.

- [ ] **Step 3: Validate and cache every segment once at runtime initialization**

```ts
for (let index = 0; index < stops.length; index += 1) {
  const from = stops[index]!;
  const to = stops[(index + 1) % stops.length]!;
  const path = network.findCompleteRoute(from.laneId, to.laneId);
  reportSegment(index, path ? 'ok' : 'error', path ? undefined : 'no valid road connection');
}
```

On recovery, revalidate only the current target segment. Retry a bounded number of times; skip only that confirmed-unreachable stop and emit a development log including route id, stop id, lane id, and reason.

- [ ] **Step 4: Re-run validation and browser diagnostic output**

Run: `npm run validate:transit; npm run smoke:transit`

Expected: route reports show each line and stop as `OK`, with no skipped valid stops.

### Task 5: Remove illegal curb parking and use physical vehicle footprints for traffic avoidance

**Files:**

- Modify: `src/gameplay/traffic/TrafficNetwork.ts: parking-space generation and transit reservations`
- Modify: `src/gameplay/traffic/ParkedVehicleManager.ts: legal vehicle selection`
- Modify: `src/gameplay/traffic/TrafficDriver.ts: unmanaged-vehicle obstacle prediction`
- Modify: `src/systems/TrafficSystem.ts: pass resolved bus stops to parking validation`
- Modify: `scripts/transit-validation.ts`

**Interfaces:**

- Consumes: `ParkingSpace.width`, `ParkingSpace.length`, the adjacent directed lane, `BusStopSite.laneId/laneDistance`, and each parked vehicle's real `VehicleDef.width/height/heading`.
- Produces: only parking spaces whose full parked footprint clears every travel-lane swept envelope, no parked vehicle that exceeds its bay dimensions, and collision avoidance that retains a real parked vehicle only when its oriented bounds intersect the bus's swept lane envelope.

- [ ] **Step 1: Write the parking-clearance regression assertions**

```ts
const narrowLocalRoad = new TrafficNetwork(fixtureNodes(), [], [localEdge(0, 1)]);
check(
  narrowLocalRoad.parkingSpaces().length === 0,
  'a three-tile road without a dedicated bay must not publish overlapping curb parking',
);
for (const space of network.parkingSpaces()) {
  check(
    network.parkingSpaceHasTravelClearance(space, space.width, space.length),
    `${space.id}: parking footprint must clear every travel lane`,
  );
}
```

- [ ] **Step 2: Run the assertions and observe the overlapping curb-space failure**

Run: `npm run validate:transit`

Expected: the old `PARKING_OFFSET = 39` publishes slots only 9.5 px from the outer-lane centre, which fails the combined lane/vehicle-width clearance check.

- [ ] **Step 3: Publish parking only in actual bays and reserve each directed stop curb**

```ts
// A generated roadside space is accepted only when the whole named bay is
// outside its adjacent travel lane's physical envelope. The current three-tile
// city street has no such bay, so its old overlapping curb slots are omitted.
if (!this.parkingSpaceHasTravelClearance(space, space.width, space.length)) return;

// During TrafficSystem construction, remove any authored parking position on
// the same directed lane within the bus + parked-vehicle physical span.
const overlapsStop =
  space.adjacentLaneId === stop.laneId &&
  Math.abs(this.projectPoint(space.position, lane).distance - stop.laneDistance) <=
    BUS_STOP_PARKING_RESERVATION;
```

Keep authored rest-area/lot parking only when its real footprint clears the nearby traffic lane. `ParkedVehicleManager` must choose only a vehicle whose `def.width <= space.width`, `def.height <= space.length`, and `network.parkingSpaceHasTravelClearance(space, def.width, def.height)`.

- [ ] **Step 4: Replace the circular parked-car heuristic with an oriented swept-envelope test**

```ts
const parkedFootprint = {
  heading: candidate.movement.heading,
  width: candidate.def.width,
  length: candidate.def.height,
};
const overlap = this.projectFootprintOntoPredictedPath(candidate.position, parkedFootprint, path);
if (!overlap) return; // parked object is physically beside, not inside, the bus corridor
inspectWorldObject(candidate.id, candidate.position, overlap.gap, kind, otherSpeed);
```

Project the oriented rectangle support (length and width on the path tangent/normal) instead of treating a 46-px-long luxury sedan as a 25-px circle. Do not exempt `parked` objects: a parked object whose real footprint overlaps the projected bus envelope must still stop the bus.

- [ ] **Step 5: Re-run static regressions and focused live blocker test**

Run: `npm run typecheck; npm run validate:transit; powershell -ExecutionPolicy Bypass -File scripts/transit-browser-smoke.ps1 -WatchBusSeconds 180`

Expected: the parked luxury vehicle can no longer spawn overlapping the T1 outer lane; a physically clear parked car is not reported as `stopped-traffic`, while a genuinely lane-blocking vehicle remains an obstacle.

### Task 6: Run the game and verify service behavior in the rendered world

**Files:**

- Modify: `scripts/transit-browser-smoke.ps1`
- Test: `scripts/transit-browser-smoke.ps1`, manual in-browser observation

**Interfaces:**

- Consumes: `TransportationSystem.debugSnapshot()` and development route report.
- Produces: a smoke result that records one complete line cycle, per-stop approach/stop/departure observations, actual wallet before/after taxi fare, and a screenshot.

- [ ] **Step 1: Add a failing runtime probe for a complete line cycle**

```js
const history = await sampleBus(bus.vehicleId, 90_000);
assert(history.every(stop => stop.approached && stop.stopped && stop.departed));
assert(history.every(stop => stop.distanceToStop <= stoppingRadius && stop.headingError <= headingTolerance));
```

- [ ] **Step 2: Run it against the pre-fix game**

Run: `npm run smoke:transit`

Expected: it identifies a passed stop or an invalid target lane instead of reporting a false success.

- [ ] **Step 3: Run final real-world verification**

Run: `npm run build; npm run validate:transit; npm run smoke:transit`

Expected: a new game starts with `$700`, taxi payment produces `700 - fare`, and a real Tehran bus reaches, aligns beside, dwells at, boards, departs from, and reaches every stop in one full route loop.

- [ ] **Step 4: Commit**

```bash
git add src/config/Constants.ts src/systems/PlayerController.ts src/gameplay/types/WorldTypes.ts src/gameplay/traffic src/gameplay/transit src/systems/TransportationSystem.ts src/systems/WorldManager.ts scripts/transit-validation.ts scripts/transit-browser-smoke.ps1 docs/superpowers/plans/2026-08-12-economy-bus-stop-repair.md
git commit -m "fix: initialize player cash and serve directed bus stops"
```

## Self-Review

- Spec coverage: Task 1 covers authoritative $700 and save preservation; Tasks 2-4 cover road-connected stop positions, directional routing, deceleration, state transitions, boarding, recovery, and diagnostics; Task 5 removes the physical parking/collision root cause that can prevent a valid route from reaching its next stop; Task 6 covers actual-world route and taxi verification.
- Placeholder scan: no task depends on a future unspecified function; the required target, route-report, and state interfaces are defined in the task that introduces them.
- Type consistency: `TrafficStopTarget` is produced in Task 3 from `BusStopSite` fields introduced in Task 2 and consumed by `TrafficDriver`, `TrafficSystem`, and `TransportationSystem` in Task 3.
