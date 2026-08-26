# Snapp Pickup and Boarding Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep every Snapp pickup on the passenger's nearest physical street and make rear-right passenger boarding reliable, diagnostic, and transactional through the existing transportation stack.

**Architecture:** TransportationSystem remains the sole booking/taxi coordinator. A small pure pickup-ranking module supplies deterministic same-road/outer-lane ordering, while TransportationSystem validates and persists the authoritative lane stop and boarding approach; PlayerController returns a typed result for the existing controlled passenger transition instead of an opaque boolean.

**Tech Stack:** TypeScript (strict), Phaser 3, existing TrafficNetwork/TrafficSystem, VehicleOccupantSystem, PlayerController, EventBus, and Node validation scripts.

## Global Constraints

- Preserve the existing booking state machine, assigned turquoise taxi entity, traffic driver, payment/refund logic, tracking, and two-minute pickup window.
- Never teleport the taxi or player and never create a parallel route, booking, taxi, or simulation loop.
- Use the stored exact `roadSegmentId`, `laneId`, `laneDistance`, pose, curb side, and boarding approach throughout quote, dispatch, recovery, and save/load.
- All Phone, E, F, Enter, and gamepad boarding attempts target the exact active `bookingId` and `assignedVehicleId` through one method.
- Do not weaken generic pedestrian, vehicle-exit, collision, or carjacking validation.

---

### Task 1: Deterministic pickup candidate ordering

**Files:**
- Create: `src/gameplay/transit/SnappPickupResolver.ts`
- Modify: `src/gameplay/transit/index.ts`
- Modify: `src/gameplay/transit/TransitConfig.ts`
- Test: `scripts/run-transit-validation.mjs`

**Interfaces:**
- Consumes: `TrafficLane.roadSegmentId`, `TrafficLane.role`, projected lane position/distance/heading, request position.
- Produces: pure `compareSnappPickupCandidates(...)`, `selectSnappPickupCandidate(...)`, and named pickup/boarding configuration values.

- [x] **Step 1: Add failing ranking tests**

Add assertions proving a valid candidate on the nearest road wins regardless of a shorter driver route, a curb-facing outer lane wins among same-road candidates, and candidates beyond the strict displacement limit are rejected.

- [x] **Step 2: Run the focused validator and confirm failure**

Run: `npm run validate:transit`

Expected: FAIL because deterministic Snapp pickup ranking exports do not yet exist.

- [x] **Step 3: Implement lexicographic ranking**

Define candidate diagnostic data and compare in this exact order: nearest `roadSegmentId`, curb-facing outer lane, request displacement (within epsilon), usable rear-right approach, graph reachability, then route distance as a tie-break only.

- [x] **Step 4: Run the focused validator**

Run: `npm run validate:transit`

Expected: PASS for same-road, outer-lane, and displacement assertions.

### Task 2: Persist one authoritative pickup anchor

**Files:**
- Modify: `src/gameplay/transit/SnappTypes.ts`
- Modify: `src/systems/TransportationSystem.ts`
- Test: `scripts/run-transit-validation.mjs`

**Interfaces:**
- Consumes: deterministic ranking helpers plus `TrafficNetwork.nearestLane`, `nearbyTravelLanes`, `projectPoint`, `pointAt`, `road`, and TrafficSystem route previews.
- Produces: `SnappPickupAnchor` with `position`, `roadSegmentId`, `laneId`, `laneDistance`, `heading`, `displacementPx`, `curbSide`, and `boardingApproach`; save snapshot version 3 with v1/v2 migration.

- [x] **Step 1: Add failing snapshot/migration assertions**

Validate that a v3 booking retains all lane/approach fields and legacy bookings normalize safely without inventing a different anchor during Phone lifecycle operations.

- [x] **Step 2: Implement `resolveSnappPickupAnchor(requestPosition)`**

Resolve the physically nearest travel road first, enumerate only that road's travel lanes, prefer curb-facing outer lanes, move only the minimum required junction clearance along the same lane, validate exterior approach clearance, log each rejected candidate reason, and return the clear same-street failure message when none qualifies.

- [x] **Step 3: Use the stored lane target everywhere**

Create it in `beginSnappSelection`, retain it through quote changes, pass it unchanged to every dispatch candidate, configure the winning taxi through `configureDriverAtLaneStop`, and consume it on recovery without re-resolving loose coordinates.

- [x] **Step 4: Tighten arrival verification**

Require matching booking/vehicle/road/lane, bounded lane/world/heading errors, stopped speed, and completed traffic approach before `DRIVER_ARRIVED`; log measured errors.

- [x] **Step 5: Run TypeScript and transit validation**

Run: `npm run typecheck` and `npm run validate:transit`

Expected: PASS.

### Task 3: Typed rear-right passenger transition

**Files:**
- Modify: `src/systems/PlayerController.ts`
- Modify: `src/systems/TransportationSystem.ts`
- Modify: `src/config/Strings.ts`
- Modify: `src/ui/phone/SnappPhoneView.ts`
- Test: `scripts/run-transit-validation.mjs`

**Interfaces:**
- Produces: `PassengerBoardingResult`, including exact reason and optional remaining distance; `TransportationSystem.requestSnappBoarding(vehicleId)` returns that result.
- Consumes: the active booking's stored approach and the actual assigned entity's `VehicleOccupantSystem.doorWorldPosition(vehicle, 'rear-right', ...)`.

- [x] **Step 1: Add failing diagnostic mapping assertions**

Assert stable user messages for player unavailable, wrong booking/vehicle, driver not arrived, moving vehicle, too far from door, blocked door/path, unavailable seat/approach, and transition in progress.

- [x] **Step 2: Return typed PlayerController failures**

Keep validation for the exterior rear-right door and player-to-door path, remove only the semantically invalid static-world `door -> interior seat` segment test from controlled passenger entry, and return the exact guard that failed.

- [x] **Step 3: Make TransportationSystem boarding transactional**

Validate the exact booking/taxi/door first, measure to the actual door or stored approach using one named reach, reserve `rear-right`, create the PlayerController transition, release reservation on failure, and transition/emits only after acceptance.

- [x] **Step 4: Confirm the correct entry before starting the ride**

React only to `PlayerEnteredVehicle` for the exact assigned vehicle and passenger seat before configuring the passenger route and emitting `SnappRideStarted`; duplicate attempts remain recoverable and do not extend the pickup deadline.

- [x] **Step 5: Unify UI and gameplay inputs**

Phone, E, F, Enter, and gamepad resolve `interactionAt(...)` for the assigned Snapp taxi and call the same method. Show `ENTER SNAPP  E / F`, close Phone only on `ok: true`, and display the typed reason otherwise.

- [x] **Step 6: Run focused validations**

Run: `npm run typecheck`, `npm run lint`, `npm run validate:transit`, and `npm run validate:gameplay`.

Expected: PASS.

### Task 4: Full regression verification

**Files:**
- Re-read every changed file.
- No unrelated source changes.

**Interfaces:**
- Consumes: completed pickup and boarding changes.
- Produces: verification evidence and final root-cause report.

- [x] **Step 1: Check diffs and ownership**

Run: `git diff --check`, inspect `git diff`, and verify no duplicate events, input listeners, timers, taxi entities, seat reservations, or booking identities were introduced.

- [x] **Step 2: Run all relevant commands**

Run: `npm run typecheck`, `npm run lint`, `npm run validate:transit`, `npm run validate:traffic`, `npm run validate:gameplay`, `npm run validate:mobile`, `npm run validate:architecture`, and `npm run build`.

Expected: all commands PASS.

- [x] **Step 3: Exercise the browser build**

Use the local Vite game to request from sidewalks/intersections/opposite road sides, verify the same stored anchor through payment/dispatch, board with Phone/E/F/Enter, test typed failures and repeated rides, and record maximum observed request-to-anchor displacement and the actual previously rejecting guard.
