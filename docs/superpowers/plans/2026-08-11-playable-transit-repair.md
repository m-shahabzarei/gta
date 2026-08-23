# Playable Transit Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the existing bus and taxi systems so visible world vehicles, stop fixtures, passenger transitions, and road-based taxi trips work in the running game.

**Architecture:** Keep buses and taxis as `TrafficSystem` vehicles and retain the shared road graph, driver, occupant, player, and map systems. Strengthen `TransportationSystem` as the service-state owner: it will choose lane-backed curb targets, transition only after robust stopped-at-target confirmation, and expose only context-valid interactions. WorldManager will render recognizable, chunk-streamed bus-stop fixtures from the existing generated stop data.

**Tech Stack:** TypeScript, Phaser 3, Vite, the existing TrafficNetwork/TrafficDriver, VehicleOccupantSystem, and browser-CDP smoke checks.

## Global Constraints

- Do not rewrite the traffic, vehicle, pedestrian, map, or player systems.
- Use the existing directed road network for every bus and taxi route.
- Do not teleport buses, taxis, passengers, or the player between service states.
- Do not render global or debug-only transit prompts.
- Keep interaction queries bounded to cached service-vehicle and generated-stop collections.
- Preserve driver ownership and require the taxi rider seat to be `rear-right`.

---

### Task 1: Audit and Lock Down Transit Invariants

**Files:**
- Modify: `scripts/transit-validation.ts`
- Modify: `src/gameplay/transit/TransitTypes.ts`

**Interfaces:**
- Consumes: existing transit service snapshots and `passengerSeatsFor`.
- Produces: deterministic taxi state names and static invariant coverage for state transitions and service constraints.

- [x] **Step 1: Write failing state and interaction invariants**

```ts
check(TAXI_SERVICE_STATES.includes('WAITING_FOR_PASSENGER'), 'taxi must expose a distinct pickup wait state');
check(passengerSeatsFor('taxi')[0] === 'rear-right', 'taxi rider must use rear passenger seat');
```

- [x] **Step 2: Run validation to verify it fails before the state repair**

Run: `node scripts/run-transit-validation.mjs`
Expected: FAIL with the missing `WAITING_FOR_PASSENGER` state invariant.

- [x] **Step 3: Define the complete service state union**

```ts
export type TaxiState =
  | 'AVAILABLE'
  | 'APPROACHING_PICKUP'
  | 'WAITING_FOR_PASSENGER'
  | 'PASSENGER_BOARDING'
  | 'DESTINATION_SELECTION'
  | 'FARE_CONFIRMATION'
  | 'IN_SERVICE'
  | 'ARRIVING'
  | 'PASSENGER_EXITING'
  | 'RETURNING_TO_SERVICE'
  | 'UNAVAILABLE';
```

- [x] **Step 4: Run static transit validation**

Run: `node scripts/run-transit-validation.mjs`
Expected: PASS with all city configuration, seat, fare, and state checks.

### Task 2: Make Bus Stops and Buses Readable In-World

**Files:**
- Modify: `src/systems/WorldManager.ts:7487-7540`
- Modify: `src/graphics/VehicleTextureFactory.ts:622-654`
- Test: `scripts/transit-browser-smoke.ps1`

**Interfaces:**
- Consumes: `BusStopSite` curb/platform/heading coordinates and `TextureKeys.VehBus`.
- Produces: clear bus-stop props placed on platforms and a bus-specific texture that remains recognizable at gameplay zoom.

- [x] **Step 1: Add visual smoke assertions for a streamed stop and a bus texture**

```js
result.bus.visibleFixture = world.map.busStops.some(stop =>
  Math.hypot(stop.x - player.position.x, stop.y - player.position.y) < 900,
);
result.bus.serviceVehicleKind = bus.vehicle.def.kind === 'bus';
```

- [x] **Step 2: Run browser smoke to capture the present failure**

Run: `powershell -ExecutionPolicy Bypass -File scripts/transit-browser-smoke.ps1`
Expected: failure or timeout in the current runtime flow, with a captured scene for visual comparison.

- [x] **Step 3: Render a platform-sized shelter, curb bay, sign pole, bench, route panel, and queue area**

```ts
fixture.setPosition(stop.x, stop.y).setRotation(stop.heading);
// Draw on the generated sidewalk platform; keep the actual stopping lane unobstructed.
fixture.fillRect(-30, -18, 60, 5); // roof
fixture.fillRect(-26, -14, 52, 20); // glass back
fixture.fillRect(-34, -9, 3, 32); // sign pole
```

- [x] **Step 4: Expand the bus livery with windshield, repeated passenger windows, door, axle detail, and route strip**

```ts
this.busWindows(g, ox, bx, bw, 18, 38);
g.fillStyle(0xf4c85a, 1).fillRect(ox + bx + 2, 13, bw - 4, 3);
g.fillStyle(PALETTE.glass, 1).fillRect(ox + bx + bw - 4, 39, 2, 13);
```

- [x] **Step 5: Run the browser smoke and inspect its screenshot**

Run: `powershell -ExecutionPolicy Bypass -File scripts/transit-browser-smoke.ps1`
Expected: visible, non-placeholder bus and streamed stop fixture beside a road.

### Task 3: Repair Bus Stop Service and Passenger Boarding

**Files:**
- Modify: `src/systems/TransportationSystem.ts:650-900`
- Modify: `src/systems/TransportationSystem.ts:920-1120`
- Test: `scripts/transit-browser-smoke.ps1`

**Interfaces:**
- Consumes: `TrafficDriver.arrived`, `BusStopSite.approachPosition`, `VehicleOccupantSystem`, and `PlayerController` passenger transitions.
- Produces: a bus whose board/exit interactions require a stopped bus at an assigned stop and whose NPC plans board and exit visibly.

- [x] **Step 1: Add explicit stopped-at-stop predicates**

```ts
private busIsAtAssignedStop(bus: BusRuntime): boolean {
  const stop = this.currentBusStop(bus);
  return Boolean(stop && this.isVehicleStoppedAt(bus.vehicle, stop.approachPosition, BUS_STOP_RANGE));
}
```

- [x] **Step 2: Use the predicate in board, exit, and passenger transfer paths**

```ts
if (bus.state !== 'dwelling' || !this.busIsAtAssignedStop(bus)) return false;
```

- [x] **Step 3: Keep the driver stopped until dwell and all accepted transfers are resolved**

```ts
if (bus.dwellRemainingMs > 0 || this.hasActiveBusTransfers(bus.vehicle.id)) return;
traffic.setDriverStopped(bus.vehicle, false);
```

- [x] **Step 4: Run the targeted browser bus sequence**

Run: `powershell -ExecutionPolicy Bypass -File scripts/transit-browser-smoke.ps1`
Expected: bus boards, exits, resumes on a legal lane route, and does not expose boarding while moving.

### Task 4: Repair the Taxi State Machine and Curb Pickup

**Files:**
- Modify: `src/systems/TransportationSystem.ts:65-1100`
- Modify: `src/gameplay/transit/TransitTypes.ts`
- Test: `scripts/transit-browser-smoke.ps1`

**Interfaces:**
- Consumes: `TrafficNetwork.nearestLane`, `TrafficNetwork.pointAt`, `TrafficSystem.configureDriver`, and `PlayerController.beginPassengerBoarding`.
- Produces: a deterministic `AVAILABLE -> APPROACHING_PICKUP -> WAITING_FOR_PASSENGER -> PASSENGER_BOARDING -> DESTINATION_SELECTION -> FARE_CONFIRMATION -> IN_SERVICE -> ARRIVING -> PASSENGER_EXITING -> RETURNING_TO_SERVICE` flow.

- [x] **Step 1: Add a failing direct runtime assertion for separate call and enter prompts**

```js
result.taxi.noGlobalCall = transit.interactionAt(farPoint) === null;
result.taxi.callPrompt = transit.interactionAt(availableTaxiDoor)?.prompt === 'CALL TAXI  E';
```

- [x] **Step 2: Resolve a safe lane-backed curb pickup point rather than using player coordinates**

```ts
const lane = traffic.roadNetwork?.nearestLane(playerPosition, undefined, true);
const pickup = lane ? traffic.roadNetwork.pointAt(lane, pickupDistance).point : null;
```

- [x] **Step 3: Require distance, low speed, and a stopped driver before pickup arrival**

```ts
if (this.isVehicleStoppedAt(taxi.vehicle, taxi.pickupPosition, TAXI_PICKUP_RANGE)) {
  taxi.state = 'WAITING_FOR_PASSENGER';
  traffic.setDriverStopped(taxi.vehicle, true);
}
```

- [x] **Step 4: Gate each interaction by range, ownership, driver, passenger seat, and state**

```ts
if (taxi.state === 'AVAILABLE' && this.isTaxiHireable(taxi) && nearby) return callTaxi;
if (taxi.state === 'WAITING_FOR_PASSENGER' && taxi.requestedByPlayer && nearby) return enterTaxi;
```

- [x] **Step 5: Make destination selection and payment explicit states, with idempotent charging**

```ts
taxi.state = 'FARE_CONFIRMATION';
if (taxi.farePaid) return 'already-paid';
if (!player.inventory.spendMoney(taxi.fare.total)) return 'insufficient-funds';
taxi.farePaid = true;
```

- [x] **Step 6: Run the complete browser taxi trip sequence**

Run: `powershell -ExecutionPolicy Bypass -File scripts/transit-browser-smoke.ps1`
Expected: pickup arrival, rear-seat boarding, map selection, single payment, legal road trip, safe exit, and return to service.

### Task 5: Verify and Document the Running Gameplay Result

**Files:**
- Modify: `scripts/transit-browser-smoke.ps1`
- Test: `node scripts/run-transit-validation.mjs`
- Test: `npm run typecheck`
- Test: `npm run lint`
- Test: `powershell -ExecutionPolicy Bypass -File scripts/transit-browser-smoke.ps1`

**Interfaces:**
- Consumes: public transit snapshots, interaction queries, map/fixture data, and the running Phaser scene.
- Produces: repeatable validation of the acceptance flow and a final concise technical report.

- [x] **Step 1: Assert all four Tehran lines, visible legal stop data, drivers, and map icon records**

```js
result.bus.tehranLines = snapshot.busRoutes.tehran.filter(route => route.valid).length === 4;
result.bus.stopIcons = world.map.busStops.filter(stop => stop.cityId === 'tehran').length > 0;
```

- [x] **Step 2: Assert no interaction at a location with no legal service target**

```js
check(transit.interactionAt({ x: invalid.x, y: invalid.y }) === null, 'transit prompt must be contextual');
```

- [x] **Step 3: Run static, type, lint, and browser validation**

Run: `node scripts/run-transit-validation.mjs`
Expected: PASS.

Run: `npm run typecheck`
Expected: PASS.

Run: `npm run lint`
Expected: PASS.

Run: `powershell -ExecutionPolicy Bypass -File scripts/transit-browser-smoke.ps1`
Expected: PASS with a gameplay screenshot and no browser errors.

- [x] **Step 4: Inspect the screenshot at desktop gameplay resolution**

```text
Verify bus stops sit on sidewalks, bus bodies are distinct from cars, taxis are yellow with drivers, and no permanent transit prompt appears.
```
