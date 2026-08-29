# Housing MVP stage-zero audit (2026-08-29)

## Current source-of-truth findings

- Interaction: `InteractionSystem` subscribes to `PlayerInteract` and chooses the nearest target from `WorldManager.map` service points, major-building entrances, doors and pedestrians. `ShopSystem` consumes service interactions through its own `PlayerInteract` subscription. NPC interaction currently emits a toast; the NPC line selection uses `Math.random`, but housing paths will not use it.
- Existing interior flow: `GameManager.openInterior(kind)` emits `GameInteriorRequested`; `WorldInteriorSystem` listens and focuses the nearest stamped `BuildingInterior`. `GameScene` currently stops a stale `InteriorScene` on this event but does not launch it. `InteriorScene` is a reusable modal scene for hospital/police/gunstore/dealership layouts, with local movement/collision and an opaque background, but it has no property payload or home mode.
- Pause/lifecycle: `ManagerRegistry` is the single global STEP tick. When `GameManager.state === Paused`, no managers tick (except the documented phone exception). `GameScene` pauses itself on `GamePaused`, launches overlays, and resumes/stops overlays on `GameResumed`. This is the safe suspension mechanism for Home mode; no second tick or physics integration is needed.
- Wallet: `Player` owns one `InventoryComponent`; `InventoryComponent.spendMoney()` floors, validates and emits `MoneyChanged`. `PlayerController` exposes the live `player`/inventory and serializes money with player state. Housing transactions must call this API and never maintain another balance.
- Persistence: `SaveManager` collects `ISerializable` services/providers by stable `saveId`, writes `SaveData.sections` to localStorage and best-effort deserializes malformed sections. Providers may opt into an additive missing-section migration hook; `HousingSystem` uses that hook to reset a legacy save with no housing section to an empty schema-versioned state.
- Typed events: `EventKeys` plus `EventPayloadMap` are the only event contract. `BaseManager.subscribe()` tracks unsubs through manager destruction, preventing repeated listeners.
- World/topology: `WorldManager` deterministically generates `MapData` (seed 1337), including three city bounds (`tehran`, `yazd`, `gilan`), finalized tile collision, road graph, `buildingEntrances`, `buildingInteriors`, service points and `MajorBuildingRegistry`. `cityAt`, `districtAt`, `isSolidAtWorld`, `isDrivableAtWorld`, and `isPedestrianWalkableAtWorld` are authoritative geometry queries. No housing/property field exists yet.
- Major buildings/NPCs: major-building definitions are generated from real planned entrances and include stable building/interior ids, NPC profiles and parking. The existing world architecture therefore supports adding office/property records as data projections without inventing a second map or collision graph.
- Camera/input: `CameraManager` binds the active scene camera and `InputManager` owns gameplay actions. `PlayerController` owns player position and camera follow; a Home transition must snapshot and restore those authorities rather than teleporting or recreating the player.

## Risks and mitigation

1. `InteriorScene` is registered but not launched by current game flow. Extend it additively with a Home payload and launch it only through `HousingSystem`/`GameScene`.
2. Outdoor systems are manager-ticked globally, while `GameScene` is paused for overlays. Use existing `GameManager` paused state and scene lifecycle so traffic/vehicle logic is suspended without modifying their algorithms.
3. Generated map geometry is authoritative and large/streamed. Property/office positions must be selected from validated city sidewalks/building entrances and checked against solid/drivable tiles at initialization.
4. Save loads can contain stale property ids. Keep them out of active ownership, emit diagnostics, and make invalid active homes null; do not crash load.
5. Existing `InteriorScene` has service-specific controls. Home mode must bypass those controls and use a deterministic `HomeLayoutRegistry`, while retaining existing service behavior untouched.

## Topology conclusion

The current topology already exposes valid city bounds, planned buildings, entrances, collision and chunk streaming. No world-topology rewrite is required for the MVP. Housing records will be derived from existing valid geometry and connected through additive metadata/query methods.
