# Building-Safe Actor Placement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guarantee that player, civilian, and police bodies are never enabled or constructed inside finalized base-solid city geometry during vehicle transitions, occupant exits, interior seeding, or save restoration.

**Architecture:** Add deterministic, radius-aware grid placement and swept-segment checks as pure world utilities, then expose them through `IWorldQuery` and `WorldManager`. Player and police systems consume that single authority before disabling, enabling, or constructing character bodies; authored interior seeds remain data-driven but are moved onto verified floor cells.

**Tech Stack:** TypeScript 5.4, Phaser 3 Arcade Physics, existing esbuild-backed validation scripts, ESLint.

## Global Constraints

- This phase adds no gameplay and preserves existing vehicle-entry, vehicle-exit, occupant, respawn, and save interactions.
- Safety covers `Building`, `BuildingRes`, `BuildingInd`, `InteriorWall`, and every other tile in `SOLID_TILE_TYPES`.
- Placement and candidate ordering must be deterministic.
- Do not add public-realm or highway decorative-fixture collision in this task.
- Do not modify `ArchitectureComposer.ts` or `ArchitectureGrammar.ts`.
- The workspace has no Git metadata, so commit steps are intentionally omitted.

---

### Task 1: Pure radius-safe grid placement

**Files:**
- Create: `src/gameplay/world/SafePedestrianPlacement.ts`
- Modify: `src/gameplay/types/Services.ts`
- Test: `scripts/gameplay-systems-validation.ts`

**Interfaces:**
- Produces: `SafePedestrianPlacementOptions`, `isCircleClearOnGrid`, `isCircleSegmentClearOnGrid`, and `resolveCirclePositionOnGrid`.
- Produces on `IWorldQuery`: `isPedestrianClearAtWorld(x, y, radius)`, `isPedestrianSegmentClear(from, to, radius)`, and `resolveSafePedestrianPosition(requested, radius, options?)`.

- [ ] **Step 1: Add failing validation cases**

  Validate a circle rejected at building/interior-wall cells, radius clearance across tile boundaries, deterministic nearest-cell relocation, a swept segment rejected across a one-tile wall, and a clear segment accepted.

- [ ] **Step 2: Run the focused gate and verify the new imports/functions fail**

  Run: `npm run validate:gameplay`

- [ ] **Step 3: Implement the pure grid algorithms**

  Use exact circle-versus-tile-AABB overlap, sample swept segments at no more than half-radius spacing, and sort relocation candidates by squared distance followed by `y` and `x`. Accept an optional `segmentStart` and bounded `maxDistance`; an omitted maximum searches the finalized map for the nearest clear cell.

- [ ] **Step 4: Expose the narrow world-query contracts and rerun validation**

  Run: `npm run validate:gameplay`

### Task 2: WorldManager adapter

**Files:**
- Modify: `src/systems/WorldManager.ts`

**Interfaces:**
- Consumes: pure safe-placement functions from Task 1.
- Produces: concrete `IWorldQuery` methods operating on `map.tiles`, `TILE_SIZE`, and `SOLID_TILE_TYPES`.

- [ ] **Step 1: Implement radius and segment checks against finalized base tiles**

  Out-of-bounds cells are solid; only the immutable generated tile raster is queried.

- [ ] **Step 2: Implement deterministic requested-position relocation**

  Preserve an already-clear requested coordinate exactly. Otherwise inspect tile-center candidates in deterministic nearest-first order, optionally requiring a clear swept segment from `segmentStart`.

- [ ] **Step 3: Run TypeScript and focused lint**

  Run: `npm run typecheck`

  Run: `npx eslint src/gameplay/world/SafePedestrianPlacement.ts src/gameplay/types/Services.ts src/systems/WorldManager.ts`

### Task 3: Player and occupant materialization

**Files:**
- Modify: `src/systems/PlayerController.ts`

**Interfaces:**
- Consumes: the three safe-placement methods on `IWorldQuery`.
- Produces: cached validated entry/exit transition targets and one private resolver used by player exits, civilian exits, police carjack exits, and save restoration.

- [ ] **Step 1: Validate entry before disabling the player body**

  Require the driver-door circle and both player-to-door and door-to-seat swept segments to be clear. Abort entry without changing movement/body state when any check fails.

- [ ] **Step 2: Resolve normal and forced exits before body enable**

  Search deterministically near the preferred driver side with a vehicle-center segment constraint. Abort a voluntary exit if no local candidate exists; forced exits may use the nearest global finalized safe cell as a last resort.

- [ ] **Step 3: Make cancelled entry return to a safe version of the original start**

  Never use an unchecked door coordinate when restoring the player body.

- [ ] **Step 4: Resolve completed civilian and carjacked-police exits through the same helper**

  Construct no actor when no safe finalized position can be found.

- [ ] **Step 5: Relocate stale save coordinates**

  Keep valid saved coordinates unchanged; otherwise restore at the nearest safe finalized cell, then fall back to the generated player start.

### Task 4: Police deployment and interior seed correction

**Files:**
- Modify: `src/systems/WantedSystem.ts`
- Modify: `src/systems/WorldManager.ts`
- Modify: `src/systems/WorldInteriorSystem.ts` only if runtime seed validation is required after the data correction.

**Interfaces:**
- Consumes: `IWorldQuery.resolveSafePedestrianPosition`.
- Produces: safe police deployment positions and hospital NPC points on `InteriorFloor` cells.

- [ ] **Step 1: Resolve every completed police deployment before construction**

  Use the unit vehicle center as `segmentStart`, the police actor radius, and deterministic local search; skip construction rather than violating solidity.

- [ ] **Step 2: Move hospital patient/pharmacist seeds off partition cells**

  Author points whose full jitter envelope remains on interior floor tiles.

- [ ] **Step 3: Add a generation validation for all authored interior NPC seed jitter positions**

  Assert each realized seed point is circle-clear against the final tile raster so future room-layout edits cannot reintroduce the bug.

### Task 5: Verification

**Files:**
- Test: `scripts/gameplay-systems-validation.ts`
- Test: `scripts/architecture-validation.ts`

- [ ] **Step 1: Run the focused gameplay gate**

  Run: `npm run validate:gameplay`

- [ ] **Step 2: Run relevant world/architecture gates**

  Run: `npm run validate:architecture`

  Run: `npm run validate:police`

- [ ] **Step 3: Run TypeScript and focused lint**

  Run: `npm run typecheck`

  Run: `npx eslint src/gameplay/world/SafePedestrianPlacement.ts src/gameplay/types/Services.ts src/systems/WorldManager.ts src/systems/PlayerController.ts src/systems/WantedSystem.ts src/systems/WorldInteriorSystem.ts scripts/gameplay-systems-validation.ts`

- [ ] **Step 4: Review every body construction/enable path**

  Search `enableBody`, `new Pedestrian`, and `new PoliceOfficer` call sites and confirm each scoped transition is guarded by the shared resolver.
