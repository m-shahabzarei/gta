# Pixel City Housing Foundation Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extend the Phase 1 HousingSystem into deterministic property progression, constrained interior customization, room unlocks, safe garage integration, neighborhood/mission adapters, safehouse policy, persistence and replay diagnostics without parallel ownership, economy, NPC, vehicle, traffic or physics systems.

**Architecture:** HousingSystem remains the single owner of property ownership and durable housing state. Focused additive adapters own only their domain projections: HousingProgressionSystem for upgrade definitions/effects, HomeCustomizationSystem for slot validation, GarageHousingAdapter for VehicleSystem calls, NeighborhoodSystem for PedestrianSystem materialization, HousingMissionProvider for deterministic offers, and SafehouseAdapter for public WantedSystem requests. InteriorScene renders a resolved snapshot and remains the only interior physics owner; SaveManager remains the persistence coordinator and EventBus the only cross-system channel.

**Tech Stack:** TypeScript 5, Phaser 3.80, existing BaseManager/ServiceLocator/ManagerRegistry, EventBus, SaveManager, Arcade collision, deterministic `hashHousingSeed`.

## Global Constraints

- Preserve TrafficSystem, TrafficDriver, signal, reservation, queue, spawn/despawn, VehicleSystem movement, collision and P0 telemetry behavior.
- Do not add a second physics, traffic, vehicle, pedestrian or player-update lifecycle.
- Keep all public APIs additive; UI never mutates money, wanted, mission or save state directly.
- Use stable ids, schema versions, simulation ticks and deterministic seeds; never use `Math.random`, wall-clock time or random UUIDs in simulation state.
- Reject invalid prerequisites, slots, collision overlaps, vehicles, transitions and stale state with typed results and diagnostics.

## Task 1: Contracts, upgrade catalog and replay snapshot

**Files:**
- Create: `src/gameplay/types/HousingPhase2Types.ts`
- Create: `src/gameplay/HousingUpgradeCatalog.ts`
- Modify: `src/gameplay/types/index.ts`
- Modify: `src/gameplay/types/HousingTypes.ts`
- Modify: `src/core/types/EventTypes.ts`
- Modify: `src/config/EventKeys.ts`
- Modify: `src/systems/HousingSystem.ts`

**Interfaces:**
- `PropertyUpgradeDefinition`, `PropertyUpgradeState`, `PropertyTier`, `PurchaseUpgradeResult`.
- `FurnitureSlotDefinition`, `FurniturePlacement`, `HomeCustomizationState`.
- `RoomDefinition`, `GarageSlotState`, `NeighborDefinition`, `NeighborRelationshipState`, `HousingMissionDefinition`, `SafehousePolicy`.
- `HousingReplaySnapshot` and `hashHousingReplaySnapshot(snapshot): string`.

- [ ] Add the typed contracts above with readonly fields, stable ids and schema versions.
- [ ] Define three tiers (`starter`, `improved`, `premium`) and deterministic per-city upgrade definitions. Every price is non-negative and every prerequisite id is resolvable.
- [ ] Add typed event keys/payloads for upgrade purchase, customization apply/cancel/rejection, room unlock, garage operations, neighbor interaction/affinity, housing mission offer/completion, safehouse use/denial, replay snapshot and telemetry diagnostics.
- [ ] Add a pure DAG validator and replay hash based on canonical sorted JSON; write its deterministic unit fixture before wiring managers.
- [ ] Run `npm run typecheck` and the new pure validation command; expected result is pass with no runtime scene required.

## Task 2: HousingProgressionSystem and durable state

**Files:**
- Create: `src/systems/HousingProgressionSystem.ts`
- Modify: `src/config/ServiceKeys.ts`
- Modify: `src/core/ManagerRegistry.ts`
- Modify: `src/systems/index.ts`
- Modify: `src/systems/HousingSystem.ts`

**Interfaces:**
- `getUpgradeDefinitions(propertyId): readonly PropertyUpgradeDefinition[]`.
- `isUpgradePurchased(propertyId, upgradeId): boolean`.
- `canPurchaseUpgrade(propertyId, upgradeId): boolean`.
- `purchaseUpgrade(propertyId, upgradeId): PurchaseUpgradeResult`.
- `getEffectivePropertyFeatures(propertyId): readonly string[]`.
- `getPropertyTier(propertyId): PropertyTier`.

- [ ] Register one manager after HousingSystem and before UI; resolve ownership and money through HousingSystem/PlayerController.
- [ ] Implement atomic, idempotent purchase: validate ownership, property scope, prerequisite closure, price, and transaction guard; debit `spendMoney` once; commit state only after debit; emit success/denial and diagnostics.
- [ ] Compute tier/effects from sorted purchased upgrades without mutating catalog definitions.
- [ ] Serialize/deserialize schema version 2, migrate Phase 1 housing to empty upgrades and repair unknown/duplicate ids with diagnostics.
- [ ] Add tests for success, insufficient funds, missing prerequisite, duplicate, wrong property, rollback, migration and deterministic result.

## Task 3: Slot-based customization and room unlocks

**Files:**
- Create: `src/systems/HomeCustomizationSystem.ts`
- Modify: `src/gameplay/HomeLayoutRegistry.ts`
- Modify: `src/scenes/InteriorScene.ts`
- Modify: `src/config/ServiceKeys.ts`
- Modify: `src/core/ManagerRegistry.ts`
- Modify: `src/systems/index.ts`

**Interfaces:**
- `getSlots(propertyId, roomId?): readonly FurnitureSlotDefinition[]`.
- `validatePlacement(propertyId, placement): FurniturePlacementResult`.
- `beginPreview(propertyId): HomeCustomizationState`.
- `applyPreview(propertyId, placements): CustomizationResult`.
- `cancelPreview(propertyId): void`.
- `getRooms(propertyId): readonly RoomDefinition[]` and `isRoomUnlocked(propertyId, roomId): boolean`.

- [ ] Extend each city layout with stable rooms, anchors, slots, collision bounds and unlock conditions; keep base layout deterministic.
- [ ] Validate category, maxItems, bounds and collision against cached static geometry; reject overlap/out-of-slot placements without allocating in update.
- [ ] Keep preview state separate from durable state; Apply increments revision atomically and Cancel leaves SaveManager state unchanged.
- [ ] Make InteriorScene resolve one layout snapshot plus placements during `create`, render static furniture once, and gate locked-room entry without a second collision system.
- [ ] Add deterministic placement, collision, Apply/Cancel, room unlock, save/load and listener-duplication tests.

## Task 4: GarageHousingAdapter

**Files:**
- Create: `src/systems/GarageHousingAdapter.ts`
- Modify: `src/gameplay/types/HousingPhase2Types.ts`
- Modify: `src/config/ServiceKeys.ts`
- Modify: `src/core/ManagerRegistry.ts`
- Modify: `src/systems/index.ts`
- Modify: `src/systems/VehicleSystem.ts` only if a narrow public query is required; do not change movement algorithms.

**Interfaces:**
- `getGarageSlots(propertyId): readonly GarageSlotState[]`.
- `canStoreVehicle(propertyId, vehicleId): boolean`.
- `storeVehicle(propertyId, vehicleId): GarageOperationResult`.
- `removeVehicle(propertyId, vehicleId): GarageOperationResult`.
- `setActiveVehicleFromGarage(propertyId, vehicleId): boolean`.

- [ ] Use only existing VehicleSystem registry and explicit `housingStorable` metadata; reject mission/pursuit/emergency/player-critical/moving/collision/transition vehicles.
- [ ] Enforce upgraded capacity, duplicate vehicle id prevention, legal world clearance and deterministic slot order. Never call private ParkedVehicleManager or remove a vehicle directly from arrays.
- [ ] Persist slot ids, vehicle ids, active vehicle and schema; repair destroyed/unknown/duplicate vehicles with diagnostics.
- [ ] Add pool reuse, capacity, duplicate, protected vehicle, destruction, stream, save/load and round-trip tests; traffic metrics must remain unchanged.

## Task 5: NeighborhoodSystem and HousingMissionProvider

**Files:**
- Create: `src/systems/NeighborhoodSystem.ts`
- Create: `src/systems/HousingMissionProvider.ts`
- Modify: `src/config/ServiceKeys.ts`
- Modify: `src/core/ManagerRegistry.ts`
- Modify: `src/systems/index.ts`
- Modify: `src/core/types/EventTypes.ts`

**Interfaces:**
- `getNeighbors(propertyId): readonly NeighborDefinition[]`.
- `getRelationship(neighborId): NeighborRelationshipState`.
- `interact(neighborId): NeighborInteractionResult`.
- `getMissionOffers(propertyId, tick): readonly HousingMissionDefinition[]`.

- [ ] Materialize only scoped resident NPCs through PedestrianSystem pooling and EntityManager; derive routines from `hashHousingSeed` and current simulation tick.
- [ ] Persist affinity/history with schema repair and emit one interaction/affinity event per accepted interaction.
- [ ] Generate deterministic offers from property city/district/tier/upgrades; call MissionSystem only through its public event/interaction path and never duplicate mission state or rewards.
- [ ] Add deterministic routine, spawn/despawn, affinity round-trip, offer prerequisite/cooldown and duplicate-reward tests.

## Task 6: SafehouseAdapter and Wanted API

**Files:**
- Create: `src/systems/SafehouseAdapter.ts`
- Modify: `src/gameplay/types/Services.ts`
- Modify: `src/systems/WantedSystem.ts` (narrow public request/result only)
- Modify: `src/config/ServiceKeys.ts`
- Modify: `src/core/ManagerRegistry.ts`
- Modify: `src/systems/index.ts`

**Interfaces:**
- `canUseSafehouse(propertyId): SafehouseDecision`.
- `useSafehouse(propertyId): SafehouseResult`.
- `IWantedService.requestSafehouseReduction(seconds): WantedReductionResult`.

- [ ] Add a policy-checked Wanted request that changes heat only through WantedSystem internals; do not call `clearWanted`, delete police entities, bypass collision or signals, or alter pursuit logic.
- [ ] Enforce arrest/boarding/transition/combat conditions, simulation-time cooldown and per-day use limit; ordinary homes remain ordinary homes.
- [ ] Persist cooldown/use counters and emit use/denial/result telemetry.
- [ ] Add tests for high wanted, pursuit, arrest transition, cooldown, overuse, save/load, safe exit and no police/mission vehicle deletion.

## Task 7: UI, save migration, telemetry and validation

**Files:**
- Create: `src/scenes/HomeManagementScene.ts`
- Create: `src/scenes/HomeCustomizationScene.ts`
- Create: `src/scenes/GarageScene.ts`
- Modify: `src/scenes/InteriorScene.ts`
- Modify: `src/Game.ts`
- Modify: `src/scenes/index.ts`
- Modify: `src/config/SceneKeys.ts`
- Modify: `src/managers/SaveManager.ts`
- Create: `scripts/housing-phase2-validation.ts`
- Create: `scripts/run-housing-phase2-validation.mjs`
- Modify: `package.json`
- Create: `docs/housing-phase2-architecture.md`

- [ ] Build stateless management/customization/garage/safehouse panels with existing Button/Panel/Label components; all actions call adapters and disable buttons while a transaction is pending.
- [ ] Ensure Escape/Back/touch close safely, scrim blocks click-through, and scene/listener counts remain one across repeated open/close.
- [ ] Upgrade SaveManager section aggregation to include the additive versioned providers; migrate Phase 1 saves idempotently and retain diagnostics for unknown state.
- [ ] Add pure deterministic validation for upgrades, slots, rooms, garage, neighbors, missions, safehouse, replay and transition guards.
- [ ] Document architecture, state flow, migration, city differences, collision/streaming policy, telemetry, measured/unknown performance and Phase 3 limits.
- [ ] Run `npm run typecheck`, `npm run lint`, `npm run build`, `npm run validate:housing-phase2`, all Phase 1 validators, and report browser smoke/frame/memory metrics as measured or `unknown`.
