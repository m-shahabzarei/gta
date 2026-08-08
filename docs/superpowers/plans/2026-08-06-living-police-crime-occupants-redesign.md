# Living Police, Crime, and Vehicle Occupants Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace automatic wanted heat and empty traffic with a witness-driven crime ecosystem, persistent vehicle occupants, physical carjacking, and police patrols that respond, search, disembark, arrest, and return.

**Architecture:** Raw gameplay actions create immutable crime incidents. `CrimeSystem` owns perception, civilian reactions, report delay, and deduplication; only completed reports enter `WantedSystem`, which owns police awareness and unit assignments but not road movement. `VehicleOccupantSystem` owns persistent seat records and batched rendering, while the existing traffic and navigation runtimes continue to own legal vehicle routing and bounded pathfinding.

**Tech Stack:** TypeScript 5, Phaser 3 Arcade Physics, existing event bus/service locator, fixed-step traffic graph, queued navigation, entity LOD scheduler, Vite.

## Global Constraints

- Crimes create wanted heat only after an actual witness completes a report.
- Police use reported or last-seen positions; no unit receives the player's live position without line of sight.
- Existing patrols respond first; fallback units originate at police stations, never beside the player.
- Every active moving vehicle has persistent visible occupants.
- Police and carjacking entry/exit use timed door and body transitions, never instant pose changes.
- Police response uses the shared traffic graph and pedestrian navigation queue.
- Occupant rendering is batched; witnesses use spatial queries; distant AI remains LOD-scheduled or virtual.
- Wanted level is capped at five stars and may rise by at most one star per escalation interval.

---

### Task 1: Domain Contracts and Tuning

**Files:**
- Create: `src/gameplay/types/CrimeTypes.ts`
- Create: `src/gameplay/types/OccupantTypes.ts`
- Modify: `src/gameplay/types/index.ts`
- Modify: `src/core/types/EventTypes.ts`
- Modify: `src/config/EventKeys.ts`
- Modify: `src/config/ServiceKeys.ts`
- Modify: `src/config/Constants.ts`
- Modify: `src/config/EngineLimits.ts`

**Interfaces:**
- Produces: `CrimeIncident`, `CrimeReport`, `WitnessKind`, `WitnessReaction`, `NpcPersonality`, `VehicleOccupantRecord`, `VehicleSeat`, `PoliceDirective`.
- Produces events: `CrimeCreated`, `CrimeObserved`, `CrimeReported`, `VehicleSpawned`, `VehicleRemoved`, `VehicleOccupancyChanged`.

- [x] **Step 1: Define immutable incident/report and occupant/personality types.**
- [x] **Step 2: Extend the typed event catalogue with raw incident lifecycle and vehicle lifecycle payloads.**
- [x] **Step 3: Add `Crime` and `Occupants` service keys and five-star tuning constants.**
- [x] **Step 4: Run `npm run typecheck`; expect existing emitters to identify every contract that must be migrated.**

### Task 2: Witness-Based Crime Pipeline

**Files:**
- Create: `src/systems/CrimeSystem.ts`
- Modify: `src/core/ManagerRegistry.ts`
- Modify: `src/scenes/GameScene.ts`
- Modify: `src/systems/index.ts`
- Modify: `src/systems/PedestrianSystem.ts`
- Modify: `src/entities/Pedestrian.ts`
- Modify: `src/entities/PoliceOfficer.ts`

**Interfaces:**
- Consumes: `CrimeCommitted` as a raw, player-attributed action.
- Produces: `CrimeCreated` immediately and `CrimeReported` only after direct-police or delayed-civilian reporting.
- Produces: `CrimeSystem.reportSuspectSighting(position, witnessId)` for actual police reacquisition.

- [x] **Step 1: Build a bounded incident ledger with expiry, duplicate suppression, and stable ids.**
- [x] **Step 2: Query nearby entity and occupant witnesses, applying range, field of view, and navigation line-of-sight.**
- [x] **Step 3: Select reactions from deterministic personality traits; police report quickly and civilians call after a reaction delay.**
- [x] **Step 4: Remove the previous bystander-generated `witnessed-violence` crime and route crowd reactions from the actual incident.**
- [x] **Step 5: Register and attach `CrimeSystem` before `WantedSystem`; typecheck.**

### Task 3: Persistent Visible Vehicle Occupants

**Files:**
- Create: `src/systems/VehicleOccupantSystem.ts`
- Modify: `src/entities/Vehicle.ts`
- Modify: `src/systems/VehicleSystem.ts`
- Modify: `src/core/ManagerRegistry.ts`
- Modify: `src/scenes/GameScene.ts`
- Modify: `src/systems/index.ts`

**Interfaces:**
- Produces: `occupantsFor(vehicle)`, `witnessesNear(position, radius, visitor)`, `beginCrewExit(vehicle)`, `drainCompletedExits()`, `beginBoarding(...)`, `beginCarjack(vehicle)`.
- Consumes: vehicle spawn/removal events and active traffic state.

- [x] **Step 1: Assign seat manifests by vehicle kind: drivers for all vehicles, passengers for taxis/buses/vans/sedans, and two-to-four officers for police vehicles.**
- [x] **Step 2: Render near occupants through one `Graphics` batch using rotated seat offsets; skip distant/virtual vehicles.**
- [x] **Step 3: Implement timed door, exit, fall, boarding, and seated transitions with pooled records and no per-frame allocation.**
- [x] **Step 4: Make vehicle pooling clear and regenerate occupancy without leaking people across reused vehicles.**
- [x] **Step 5: Typecheck and verify every active traffic driver has an occupant record.**

### Task 4: Physical Carjacking and Civilian Reactions

**Files:**
- Modify: `src/systems/PlayerController.ts`
- Modify: `src/systems/VehicleOccupantSystem.ts`
- Modify: `src/systems/PedestrianSystem.ts`
- Modify: `src/entities/Pedestrian.ts`
- Modify: `src/entities/components/PedestrianAIComponent.ts`
- Modify: `src/entities/components/pedestrian/PedestrianTypes.ts`
- Modify: `src/entities/components/pedestrian/PedestrianReactiveStates.ts`

**Interfaces:**
- Consumes: `VehicleOccupantSystem.beginCarjack(vehicle)`.
- Produces: a single `vehicle-theft` raw crime at the forced-entry phase and physical world pedestrians after exit.

- [x] **Step 1: Replace immediate boarding with `approach -> open -> pull -> fall -> enter -> close -> start` phases.**
- [x] **Step 2: Keep the player body disabled only during the transition and drive its visible sprite along door positions.**
- [x] **Step 3: Materialize the driver/passengers at their completed exits and apply run, call, freeze, surrender, or fight reactions from personality.**
- [x] **Step 4: Reject unsafe high-speed entry and preserve normal animated entry for empty vehicles.**
- [x] **Step 5: Confirm vehicle theft remains unknown when `CrimeSystem` finds no observer.**

### Task 5: Police Awareness and Unit State Machines

**Files:**
- Replace: `src/systems/WantedSystem.ts`
- Replace: `src/entities/components/PoliceAIComponent.ts`
- Modify: `src/entities/PoliceOfficer.ts`
- Modify: `src/gameplay/types/Services.ts`
- Modify: `src/systems/EntityManager.ts`

**Interfaces:**
- Consumes: `CrimeReported` only.
- Produces: `PoliceDirective` per officer and patrol unit states `patrol`, `respond`, `deploy`, `engage`, `search`, `roadblock`, `return`, `board`.
- Uses: `TrafficSystem.configureDriver`, `NavigationSystem.requestPath`, `VehicleOccupantSystem` crew transitions.

- [x] **Step 1: Replace direct crime-to-heat handling with report-to-awareness handling and gradual five-star heat thresholds.**
- [x] **Step 2: Maintain a real patrol fleet at police stations and recruit nearest existing ambient cruisers before dispatching fallback units.**
- [x] **Step 3: Route response vehicles to report/last-known positions, stop, open doors, and materialize assigned officers after the exit animation.**
- [x] **Step 4: Give officers queued paths, arrest-first rules, armed-suspect escalation, cover offsets, collision separation, and friendly-fire checks.**
- [x] **Step 5: Update last-known position only from direct unit line-of-sight; assign bounded search sectors when contact is lost.**
- [x] **Step 6: Turn an arrived patrol into a roadblock at high heat instead of spawning a roadblock near the player.**
- [x] **Step 7: On cooldown, order officers back to their own vehicle, animate boarding, and resume traffic patrol.**

### Task 6: Raw Crime Source Migration

**Files:**
- Modify: `src/systems/CombatSystem.ts`
- Modify: `src/systems/PlayerController.ts`
- Modify: `src/entities/Pedestrian.ts`
- Modify: `src/entities/PoliceOfficer.ts`
- Modify: `src/entities/Vehicle.ts`
- Modify: `src/systems/EmergencyResponseSystem.ts`

**Interfaces:**
- Produces raw incidents for gunfire, assault, murder, explosion, hit-and-run, vehicle theft, and police assault exactly once each.

- [x] **Step 1: Ensure weapon fire creates gunfire, player damage creates assault, fatal damage creates murder/police assault, and player explosions create explosion incidents.**
- [x] **Step 2: Preserve forensic attribution through vehicle collision and explosion chains.**
- [x] **Step 3: Stop emergency medical dispatch from creating magical police awareness; police securing follows reported incidents.**
- [x] **Step 4: Search all `CrimeCommitted` emitters and verify each represents an action, never a witness report or wanted shortcut.**

### Task 7: Deterministic Validation and Runtime QA

**Files:**
- Create: `scripts/police-validation.ts`
- Create: `scripts/run-police-validation.mjs`
- Modify: `package.json`
- Create: `docs/POLICE_CRIME_OCCUPANTS.md`

**Interfaces:**
- Produces: `npm run validate:police`.

- [x] **Step 1: Validate no-witness/no-report, civilian delay, direct-police report, one-star-per-step escalation, search decay, mandatory moving-driver, police crew minimums, and return-to-patrol transitions.**
- [x] **Step 2: Run `npm run validate:police`, `npm run validate:traffic`, `npm run typecheck`, and `npm run build`.**
- [x] **Step 3: Start Vite and run the existing browser smoke/stress harness with profiler telemetry.**
- [x] **Step 4: Capture desktop and mobile screenshots; inspect occupant visibility, door transitions, HUD stars, and overlap-free rendering.**
- [x] **Step 5: Update this plan's checkboxes and document verified behavior and performance limits.**


