# Pixel City Housing MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add one deterministic housing subsystem that connects existing interaction, world, scene, UI, player-wallet and save lifecycles without creating parallel traffic/physics or ownership authorities.

**Architecture:** `HousingSystem` is the only owner of immutable property/office catalog, ownership state, purchase transactions and home transition state. `RealEstateScene` is a stateless presentation overlay; the existing `InteriorScene` is extended with a Home payload and deterministic city layout renderer. `WorldManager` remains authoritative for geometry/city queries and `SaveManager` remains the persistence coordinator.

**Tech Stack:** TypeScript 5, Phaser 3.80, existing EventBus/ServiceLocator/ManagerRegistry, Arcade Physics and project UI components.

## Global Constraints

- Preserve existing TrafficSystem, VehicleSystem, reservation, spawn/despawn, collision and P0 telemetry behavior.
- Catalog and layout generation are deterministic; no `Math.random` in housing paths.
- No second physics, traffic, vehicle or player-update lifecycle.
- Existing APIs remain available; additions are typed and additive.
- UI never mutates wallet or save state directly.

### Task 1: Audit, data contracts and deterministic catalog

**Files:**
- Create: `docs/housing-mvp-audit.md`
- Create: `src/gameplay/types/HousingTypes.ts`
- Create: `src/gameplay/HousingCatalog.ts`
- Modify: `src/gameplay/types/index.ts`
- Modify: `src/gameplay/types/InteractionTypes.ts`
- Modify: `src/gameplay/types/WorldTypes.ts`

- [ ] Record the current interaction, interior, pause, wallet, save, event, world topology and camera risks with file/line evidence.
- [ ] Add `PropertyDefinition`, `RealEstateOfficeDefinition`, `HousingOwnershipState`, `PropertyPurchaseResult`, `HomeInteriorPayload`, `HomeEntrySnapshot` using `Vector2`, `Rect`, `CityId` and existing enums.
- [ ] Build a frozen three-city catalog from valid city centers/sidewalk geometry, with stable ids, three properties per city, one office per city, distinct styles and `hash(seed, propertyId, layoutId)`.
- [ ] Add `real-estate` and `home` interaction kinds without changing existing meanings.

### Task 2: Typed events and HousingSystem

**Files:**
- Modify: `src/config/EventKeys.ts`
- Modify: `src/core/types/EventTypes.ts`
- Create: `src/systems/HousingSystem.ts`
- Modify: `src/config/ServiceKeys.ts`
- Modify: `src/core/ManagerRegistry.ts`
- Modify: `src/systems/index.ts`

- [ ] Add all requested housing event keys and payloads.
- [ ] Implement catalog lookup, immutable ownership, atomic wallet debit through `PlayerController.player.inventory.spendMoney`, active-home validation, diagnostics for invalid loaded ids, and `ISerializable` schema versioning.
- [ ] Subscribe to interaction and transition request events exactly once through `BaseManager`.
- [ ] Expose semantic API (`getProperty`, `getPropertiesForCity`, `isOwned`, `purchaseProperty`, `setActiveHome`, `canEnterHome`, `requestEnterHome`, `requestExitHome`).

### Task 3: World and interaction integration

**Files:**
- Modify: `src/systems/InteractionSystem.ts`
- Modify: `src/scenes/GameScene.ts`
- Modify: `src/systems/WorldManager.ts`
- Modify: `src/gameplay/major-buildings/MajorBuildingRegistry.ts`

- [ ] Resolve the current city and office from HousingSystem; emit real-estate interaction request when the player is in office radius.
- [ ] Preserve existing building entrance and collision handling; expose a read-only property/office query from WorldManager backed by the generated valid map.
- [ ] Launch/stop only the existing modal/home scene keys and suspend/resume through current GameManager/GameScene lifecycle.

### Task 4: Real-estate UI

**Files:**
- Create: `src/scenes/RealEstateScene.ts`
- Modify: `src/config/SceneKeys.ts`
- Modify: `src/Game.ts`

- [ ] Render city title, property cards, owned/price/features/parking/style, Visit/Buy/Back controls using `Panel`, `Label`, `Button`.
- [ ] Keep ownership in HousingSystem, prevent click-through, support Escape and repeated open/close without duplicate listeners.
- [ ] Implement preview request/restore without changing player position or buying.

### Task 5: Home interior mode and lifecycle

**Files:**
- Modify: `src/scenes/InteriorScene.ts`
- Modify: `src/scenes/GameScene.ts`
- Modify: `src/systems/HousingSystem.ts`
- Create: `src/gameplay/HomeLayoutRegistry.ts`

- [ ] Add Home payload mode to the existing scene, opaque scrim, deterministic Tehran/Yazd/Gilan layouts, static decorations and collision rectangles.
- [ ] Snapshot camera/input/player/pause state before enter; ensure only one transition and one scene instance.
- [ ] Suspend existing outdoor simulation via current scene/GameManager pause semantics and restore camera, input, world stream and player entrance on exit; emit accepted/rejected/failed/exited events.

### Task 6: Persistence, validation and tests/docs

**Files:**
- Create: `scripts/housing-validation.ts`
- Create: `scripts/run-housing-validation.mjs`
- Modify: `package.json`
- Create: `docs/housing-mvp-architecture.md`

- [ ] Add deterministic pure validation for offices, catalog ids/positions, purchase/migration/active-home, preview non-teleport, transition guards and layout determinism.
- [ ] Run typecheck, lint, build, housing validation and existing traffic/architecture/major-building validators; report unknown metrics rather than guessing.
- [ ] Document final state machine, event flow, save migration, city layouts, streaming/collision policy, performance observations and Phase 2 limits.
