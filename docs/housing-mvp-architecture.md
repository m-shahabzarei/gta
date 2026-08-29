# Pixel City housing MVP architecture

## Ownership and data flow

`WorldManager` remains the source of truth for city bounds, districts, finalized
building entrances, tiles, collision and chunk streaming. `HousingCatalog` only
projects immutable `PropertyDefinition` and `RealEstateOfficeDefinition` records
from those entrances. The generated `MapData` carries read-only `properties` and
`realEstateOffices` metadata for diagnostics/map consumers.

`HousingSystem` is the sole owner of the ownership set, active home, purchase
transaction and transition state. `RealEstateScene` contains no wallet or
ownership state; it queries `HousingSystem` on every render and asks it to visit
or buy. `InteriorScene` is the existing scene, extended with a Home payload and
the deterministic `HomeLayoutRegistry`.

## Catalog and styles

The catalog uses stable ids (`real-estate-office:<city>` and
`property:<city>:<ordinal>`), `cash` currency and validated non-road, non-solid
entrance geometry. Tehran properties use the dense modern apartment layout,
Yazd uses a warm adobe courtyard/windcatcher layout, and Gilan uses a cooler
timber/veranda/rain-garden layout. Home variation is seeded by
`hashHousingSeed(worldSeed, propertyId, layoutId)` (materialized as the
property's `deterministicSeed`); equal world seeds produce equal data.

## Event flow

InteractionSystem detects the nearest office or property entrance and emits
`RealEstateInteractionRequested` or `HomeEnterRequested`. HousingSystem handles
those requests and emits `RealEstateOpened`, preview started/ended, ownership
changed, home accepted/rejected/exited or transition failed. A purchase emits
`PropertyPurchaseRequested` before the atomic debit and ownership commit. The
only wallet mutation is `Player.inventory.spendMoney`; the only persistence
owner is `SaveManager` through the `housing` `ISerializable` provider.

## Purchase transaction

1. Resolve the immutable property and reject missing/invalid ids.
2. Reject duplicate ownership, missing player, wrong city or insufficient funds.
3. Debit the existing inventory wallet once.
4. Add the id to the deduplicated ownership set and emit `PropertyOwnershipChanged`.

No save or UI state is changed on any rejected path. Ownership serialization is
schema version 1. Legacy saves without a `housing` section invoke the provider
missing-section migration hook and become empty ownership. Unknown loaded ids
are retained in diagnostics, excluded from active use,
and never crash loading; invalid active homes become `null`.

## Preview camera flow

Visit snapshots player position, camera scroll/zoom, active scene, input mode and
pause state. It prepares the target through `WorldManager.prepareChunkAt`, stops
camera follow, centers on `previewWorldPosition` and applies a deterministic
preview zoom through `CameraManager` (the outdoor scene is paused, so a time-
based tween would not advance).
The player is never teleported. Back restores the exact camera snapshot, resumes
follow and prewarms the original chunk.

## Home state machine

```text
Closed -> Browsing -> Previewing -> Browsing
                    |                 |
                    +-> PurchasePending -> Browsing
                                      |
                                      +-> EnteringHome -> InHome
                                                         |
                                                         v
                                                      ExitingHome -> Closed
```

The implementation keeps these states in one `HousingSystem` enum. Enter checks
ownership, valid layout, interaction radius and transition exclusivity, then
snapshots outdoor state, disables the existing player body/movement, pauses the
GameManager (the established global lifecycle), and launches the existing
`InteriorScene` with `HomeInteriorPayload`. The interior scene draws an opaque
scrim, local static geometry and collision rectangles; no outdoor traffic,
vehicle or second physics system is instantiated.

Exit is idempotent: it stops the interior once, prepares the saved world chunk,
restores player body/position, camera bounds/scroll/zoom/follow and input, then
resumes GameManager. Failures emit `HomeTransitionFailed`, record diagnostics and
return to a safe outdoor state where possible.

## Collision and streaming policy

Outdoor collision remains the streamed `WorldManager` tile layers. Home collision
is the existing `InteriorScene` rectangle test used by service interiors. Preview
and exit call `prepareChunkAt` instead of bypassing the chunk streamer. No lane,
reservation, spawn, despawn, vehicle or traffic constants are changed.

## Performance and limitations

Catalog/layout construction occurs at initialization/scene creation. Interior
update only moves the existing marker and tests cached static rectangles using
reusable probes; it does not create graphics, textures, listeners or traffic
systems per frame. Real-estate listeners are removed on scene shutdown and
manager subscriptions are tracked by
`BaseManager`.

The current world has no first-class real-estate building archetype or separate
office footprint. Offices are therefore data-driven projections on existing
validated entrances and present an agent/desk in the modal. A future phase can
author dedicated office footprints/NPC entities if topology capacity and art
assets justify it. Rental economics, loans, free-form decoration, destruction
and multiplayer remain Phase 2 scope. The pure housing fixture validates nine
properties and three offices; a standalone Node probe cannot instantiate the
Phaser-dependent generator, so the exact live-map per-city count remains an
explicit runtime measurement to capture in browser smoke. Startup diagnostics
report any capacity shortfall instead of inventing locations.
