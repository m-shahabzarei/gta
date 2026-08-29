# Housing Foundation Phase 2 architecture

## Scope and preconditions

Phase 2 extends the Phase 1 HousingSystem. The precondition audit is recorded in
[`housing-phase2-audit.md`](housing-phase2-audit.md); all static/headless Phase 1
gates passed before implementation. Traffic, VehicleSystem movement, player
vehicle control, collision layers, world streaming algorithms and P0 telemetry
remain unchanged.

## Ownership and state flow

`HousingSystem` is still the only owner of property ownership and active-home
selection. `HousingProgressionSystem` owns only property-scoped upgrade state;
`HomeCustomizationSystem` owns slot placements and room unlock validation;
`GarageHousingAdapter` owns garage slot metadata while resolving live vehicles
through the existing VehicleSystem registry; `NeighborhoodSystem` owns resident
relationship history and materializes residents through the existing pooled
PedestrianSystem; `HousingMissionProvider` produces deterministic offers while
MissionSystem remains the mission-state owner; `SafehouseAdapter` requests a
time-delayed reduction through WantedSystem's additive public API.

SaveManager remains the persistence coordinator. Providers use stable save ids:

| Provider | Save id | Schema |
|---|---|---:|
| HousingSystem | `housing` | 1 (Phase 1 compatible) |
| HousingProgressionSystem | `housing-progression` | 2 |
| HomeCustomizationSystem | `housing-customization` | 2 |
| GarageHousingAdapter | `housing-garage` | 2 |
| NeighborhoodSystem | `housing-neighborhood` | 1 |
| HousingMissionProvider | `housing-missions` | 1 |
| SafehouseAdapter | `housing-safehouse` | 1 |

Missing sections migrate to empty defaults. Unknown property, upgrade,
furniture, neighbor or vehicle ids are retained in diagnostics and excluded from
active state. Duplicate ownership, upgrade and garage vehicle entries are
deduplicated deterministically.

## Upgrade model

Every property receives the same immutable, property-scoped catalog with stable
ids. Categories are `space`, `storage`, `garage`, `security`, `comfort`,
`workshop` and `safehouse`. Definitions expose level, price, prerequisites,
feature flags and numeric/string effects. The prerequisite graph is validated by
Kahn's algorithm at startup; a purchase validates ownership, property scope,
prerequisite closure, wallet balance and a re-entrant transaction guard before
calling `Player.inventory.spendMoney()` exactly once. State is committed only
after the debit succeeds and a typed `PropertyUpgradeChanged` event is emitted.
Tier is derived (`starter`, `improved`, `premium`) from purchased levels and is
never stored as a second mutable source of truth.

## Customization and rooms

`HomeLayoutRegistry` now provides deterministic room and furniture-slot data for
Tehran's compact apartment, Yazd's courtyard/adobe house and Gilan's timber
veranda home. A placement must target a known slot, an unlocked room, an allowed
category, a known variant and a legal rotation; bounds and occupied-slot checks
reject invalid data. `beginPreview` is ephemeral. `applyPreview` increments a
revision atomically; `cancelPreview` deletes only the preview and cannot mutate
SaveManager state. InteriorScene reads the resolved placement snapshot during
`create`, draws static decoration once, and continues to use its cached local
collision rectangles in `update`.

## Garage and vehicle lifecycle

Garage slots are deterministic (`<propertyId>:garage:<ordinal>`) and capacity is
the authored capacity plus purchased garage effects. The adapter never creates a
vehicle or physics system and never reaches into ParkedVehicleManager internals.
Store/remove operations resolve a live VehicleSystem entity by id, reject
mission/pursuit/police/emergency/transit/player-driven/moving/damaged vehicles,
and preserve existing heading/collision ownership. Metadata is persisted with
duplicate and destroyed-entity repair diagnostics. Exact live vehicle transfer
to a private interior bay is deferred because VehicleSystem has no public garage
transport API; the adapter therefore records an explicit, auditable storage
state without changing traffic topology.

## Neighbors and missions

One deterministic neighbor definition is projected per property. Routine ids are
city-specific (`commercial-commute`, `local-market`, `rain-garden`) and resident
sprites are materialized only through PedestrianSystem's existing pool. Affinity
and interaction history are versioned and cooldown-gated. HousingMissionProvider
offers deterministic material-delivery, garage and safehouse metadata keyed by
property/city/district/tier; MissionSystem remains the only owner of active and
completed mission state and rewards.

## Safehouse policy

Safehouse use requires ownership, the purchased `safehouse:enabled` upgrade,
available per-day uses, no adapter cooldown, and no active pursuit/boarding
transition. Use starts a simulation-tick cooldown. On expiry the adapter calls
`WantedSystem.requestSafehouseReduction(seconds)`, which applies the reduction
inside WantedSystem's existing state machine; the home/UI never sets wanted to
zero and no police or mission vehicle is deleted.

## Replay and telemetry

`HousingReplaySnapshot` captures world/simulation seeds, simulation tick,
ownership, upgrades, customization, garage, neighbors, safehouse uses and event
count. `createHousingReplaySnapshot` canonicalizes sorted arrays and computes an
FNV-derived deterministic hash via `hashHousingSeed`. Housing event payloads and
`HousingTelemetry` include simulation tick/clock, seeds, city/district, property,
scene, active home, result/denial reason and a deterministic replay key. Values
not available in a runtime harness must be recorded as `unknown`.

## State machine and lifecycle

```text
Closed -> Browsing -> Previewing -> Browsing
                    -> PurchasePending -> Browsing
                    -> EnteringHome -> InHome -> ExitingHome -> Closed
```

The existing GameManager pause state suspends outdoor managers while InteriorScene
runs. InteriorScene remains opaque and uses one local collision implementation.
Home exit is idempotent: stop the scene once, prepare the saved world chunk,
restore player/camera/input/pause state, then resume the prior lifecycle. Any
failure records `HomeTransitionFailed` and restores the safest available outdoor
state.

## Performance and streaming

Catalogs, upgrade definitions, layouts, slots and static decoration are created
outside update loops. Interior movement uses cached probes; no graphics, texture,
listener, traffic or physics instances are allocated per frame. Preview, garage
and resident materialization use existing world/entity APIs and do not bypass
streaming. Browser measurements for Phase 2 home entry/exit spikes and heap
deltas are currently **unknown**; the headless traffic baseline remains the only
measured runtime baseline.

## Known limitations and Phase 3

The current topology still projects offices onto existing entrances and lacks a
public VehicleSystem garage-transfer operation, a full Pedestrian routine
planner, and a MissionSystem offer-registration API. Dedicated office footprints,
true vehicle relocation/garage visuals, richer neighbor dialogue, dynamic
mission registration, economy/sale policy, free-form decoration and multiplayer
are intentionally deferred to Phase 3. Phase 3 should begin with browser
instrumentation for transition frame/memory budgets and narrow public APIs for
vehicle parking and mission offers, validated against unchanged traffic and
player-vehicle metrics.
