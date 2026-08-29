# Housing Foundation Phase 2 precondition audit (2026-08-29)

## Gate result

The Phase 1 gate is **open**. The current workspace passes the required static and
headless checks before Phase 2 changes:

| Gate | Evidence | Result |
|---|---|---|
| TypeScript | `npm run typecheck` | pass |
| Lint | `npm run lint` | pass |
| Build | `npm run build` | pass |
| Phase 1 housing | `npm run validate:housing` — 9 properties, 3 offices, 63 checks | pass |
| Traffic invariants | `npm run validate:traffic` — 481,601 checks, 96,000 agent steps | pass |
| P0 telemetry | `npm run validate:traffic-telemetry` — 11 checks | pass |
| Traffic lifecycle | `npm run validate:traffic-lifecycle` — 10 cases | pass |
| Architecture | `npm run validate:architecture` — 416,759 assertions | pass |
| Major buildings | `npm run validate:major-buildings` — 710 checks | pass |

The browser major-building smoke currently fails during world-generation readiness
(`Main menu did not become ready after world generation`,
`scripts/major-buildings-browser-smoke.ps1:234`) before a housing interaction is
reached. This is recorded as an infrastructure/runtime limitation, not as a
Phase 2 gameplay failure.

## API audit

1. **Ownership and active home** — `src/systems/HousingSystem.ts` owns the
   immutable catalog projection, a deduplicated ownership `Set`, `activeHomeId`,
   atomic `purchaseProperty`, `setActiveHome`, `canEnterHome`, and Home entry/exit
   requests. UI calls this service and never mutates ownership or money.
2. **Save schema** — `src/managers/SaveManager.ts` gathers providers by stable
   `saveId`, serializes sections, and invokes additive
   `onMissingSaveSection()` hooks. Housing uses save id `housing`, schema version
   `1`, and migrates a missing section to empty ownership. Unknown ids are
   diagnosed and excluded; an invalid active home is nulled.
3. **Money transaction** — `Player.inventory.spendMoney()` is the only debit API;
   it floors, validates and emits `MoneyChanged`. No second wallet is allowed.
4. **Vehicle API** — `VehicleSystem` exposes a read-only vehicle registry,
   `spawnVehicle`, `removeVehicle`, and pool lifecycle. `ParkedVehicleManager` is
   private to `TrafficSystem` and has no garage storage API. `InventoryComponent`
   currently stores vehicle *kinds* (`addVehicle`, `ownedVehicles`), not stable
   vehicle entity ids or garage slots. A garage adapter therefore needs a
   constrained entity-id contract and must use the existing registry only.
5. **Wanted API** — `IWantedService` exposes read-only `level`, `isSearching`,
   `bustPlayer`, and police directives. There is no public heat-reduction or
   safehouse-cooldown API; adding a narrow additive `requestSafehouseReduction`
   method is required before a safehouse can alter wanted state.
6. **Mission API** — `MissionSystem` owns active/completed mission state and
   exposes only internal marker/offering flow. There is no public deterministic
   housing offer registration or prerequisite API; Phase 2 must provide a
   `HousingMissionProvider` that emits offer metadata while leaving mission state
   in `MissionSystem`.
7. **NPC lifecycle** — `PedestrianSystem` is the sole pedestrian owner and exposes
   `spawnAt`, `spawnProfileAt`, `spawnFromVehicleOccupant`, `removeById`, and a
   pooled `pedestrians` view. No resident/routine API exists; the adapter must
   materialize residents through these methods and never create another simulator.
8. **Interior lifecycle** — `InteriorScene` already accepts a typed Home payload,
   draws an opaque background and deterministic layout, uses cached local
   collision rectangles, and routes Home exit to `HousingSystem`. `GameScene` and
   `ManagerRegistry` pause the outdoor scene and all managers through the existing
   `GameManager` state; no second tick/physics owner is permitted.
9. **World/streaming** — `WorldManager.prepareChunkAt`, `cityAt`,
   `districtAt`, collision queries and generated `MapData` remain authoritative.
   No topology rewrite is needed for upgrades, furniture or garage metadata.
10. **Telemetry/replay** — traffic P0 telemetry and replay samples are validated
    by the existing scripts. A housing replay snapshot/hash provider is not yet
    present and must be additive; unmeasured browser frame/memory values remain
    `unknown`.

## Blockers and bounded decisions

- A first-class garage transfer is **blocked** by the absence of a public
  `VehicleSystem`/`ParkedVehicleManager` storage API and stable owned-vehicle ids.
  Phase 2 will implement a safe adapter over existing `VehicleSystem` only for
  vehicles explicitly marked `housing-storable`; mission, police, emergency,
  pursuit, player-critical, moving or destroyed vehicles are rejected. No vehicle
  is removed directly from a registry.
- A real wanted reduction is **blocked** by the absence of a public Wanted API.
  Phase 2 will add a narrow request/result method to `WantedSystem` and its
  interface; it will not clear wanted directly from Home/UI or delete police
  entities.
- Mission offers are **adapter-only** because `MissionSystem` has no public
  offer registration. The provider will expose deterministic definitions and
  emit an offer event; it will not duplicate mission completion state.
- Dedicated office buildings/NPCs remain a Phase 3 topology/art task. Phase 1
  offices are validated projections on existing entrances, so Phase 2 does not
  invent footprints or alter traffic topology.

## Safety constraints for implementation

All Phase 2 changes are additive. Traffic, signals, reservations, spawn/despawn,
vehicle movement, player-vehicle control, collision layers and world streaming
algorithms remain unchanged. State is versioned, deterministic seeds use
`hashHousingSeed(worldSeed, propertyId, subsystemId)`, and no simulation state uses
`Math.random`, wall-clock time or random UUIDs.
