# City Architecture Pipeline Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every painted/fallback building with a planned, collidable, road-aligned architectural object and render professional GTA-2-style city blocks with coherent pixel-art volume, city identity, purposeful open space, and roof/detail layers.

**Architecture:** Keep the accepted road graph and tile raster as the runtime collision/navigation adapter, but make `PlannedBuilding` and planned block realms the only sources allowed to write building occupancy. A pure block grammar will generate program-aware lots, shapes, entrances, roof assets, and open-space plans; the renderer will consume those records at building scale through separate ground, shadow, wall, roof, and cutaway-roof layers. Static up-front rasterization preserves the existing traffic, pathfinding, sight, and streamed Arcade-physics contracts.

**Tech Stack:** TypeScript 5.4 strict mode, Phaser 3.80 Canvas/WebGL graphics, Vite 5, esbuild validation runners, PowerShell Chrome DevTools smoke harness.

## Global Constraints

- This phase adds no gameplay mechanics.
- Every visible building must have a `PlannedBuilding` owner and an exact ground-contact footprint in the authoritative tile raster.
- Preserve the top-down camera, 32 px native pixel grid, nearest-neighbour rendering, and classic GTA-2-inspired pixel-art identity.
- Keep roads fully navigable and do not change the accepted highway/traffic graph.
- Building shadows and projected walls are visual geometry; only the ground-contact footprint participates in terrain collision.
- Enterable service interiors keep their existing interactions, but their exterior roofs are visible outside and open only while the player is inside.
- Generation remains deterministic for seed `1337` and must pass existing world, traffic, police, gameplay, and highway gates.
- No photographs, realistic textures, filtered assets, or non-pixel rendering.

---

### Task 1: Rich Architecture Contracts and Pure Block Grammar

**Files:**
- Create: `src/generation/ArchitectureGrammar.ts`
- Modify: `src/gameplay/types/WorldTypes.ts`
- Modify: `src/gameplay/types/index.ts`
- Create: `scripts/architecture-validation.ts`
- Create: `scripts/run-architecture-validation.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `PlannedUrbanBlock`, `PlannedBlockProgram`, `CityId`, `District`, deterministic integer seed.
- Produces: `composeBlockArchitecture(block, seed): PlannedBlockComposition`, `makeBuildingFootprint(lot, salt): PlannedBuilding['footprint']`, and `plannedRealmFor(block, seed): PlannedUrbanSpace`.
- Produces types `PlannedBuildingShape`, `PlannedBuildingSize`, `PlannedBuildingKind`, `PlannedEntrance`, `PlannedRoofAsset`, `PlannedUrbanSpace`, `PlannedGroundFeature`, and `PlannedBlockComposition`.

- [x] **Step 1: Add the architecture vocabulary to the world contract**

  Define discrete size categories (`small`, `medium`, `large`, `huge`), massing shapes (`rectangle`, `l`, `u`, `t`, `corner`, `courtyard`, `paired`, `podium-tower`, `arcade`, `shed-cluster`), semantic kinds (house, villa, apartment, office, tower, retail, market, factory, warehouse, government, mosque, school, university, hospital, police, sports hall, stadium, parking structure, hotel, terminal), entrance ownership/facing, rooftop assets, and planned open-space/ground-feature records. Extend `PlannedBuilding` without removing its existing material/facade fields, and add `spaces` to `UrbanPlanData`.

- [x] **Step 2: Implement program-specific block compositions**

  Make `ArchitectureGrammar.ts` choose a site template from block program, dimensions, city, district, and seed. Housing generates road-facing house/villa rows and gardens; apartments generate L/U/paired complexes and courtyards; retail creates continuous frontage plus rear service/parking; offices create podium/tower or campus arrangements; industry creates sheds, offices, loading yards, and gates; civic programs produce recognizable main buildings, wings, forecourts, schoolyards, hospital approaches, police yards, mosques, sports halls, and stadium stands. Rotate/reflect massing deterministically and cap every lot to block bounds.

- [x] **Step 3: Implement non-overlapping shape modules**

  Generate each shape as non-overlapping rectangles so footprint area, collision rasterization, and quality metrics agree. Ensure each component is at least 2×2 tiles, courtyard holes remain empty, entrances lie on exposed perimeter cells, and the planned apron/access path stays outside the footprint.

- [x] **Step 4: Add a pure architecture validation runner**

  The runner must generate representative small/medium/large blocks for all major programs in Tehran, Yazd, and Gilan and assert deterministic output, in-bounds/non-overlapping rectangles, at least eight shapes, four size categories, city-appropriate height limits, program-to-kind mappings, explicit entrances, roof assets, and purposeful realm records. Add `npm run validate:architecture` using the same esbuild bundle pattern as `validate:highways`.

- [x] **Step 5: Run the focused failing gate, then make it pass**

  Run `npm run validate:architecture`; expected before implementation: missing module/type failures. Expected after implementation: a summary with zero architecture grammar failures.

### Task 2: Single-Source Building Planning and Occupancy Raster

**Files:**
- Modify: `src/systems/WorldManager.ts`
- Modify: `src/generation/UrbanPlanner.ts`
- Modify: `src/gameplay/types/WorldTypes.ts`
- Modify: `scripts/browser-smoke.ps1`

**Interfaces:**
- Consumes: `composeBlockArchitecture()` output from Task 1 and the accepted road/block plan.
- Produces: one `PlannedBuilding` for every `TileType.Building*` cell, one `PlannedUrbanSpace` for every block's residual land, and an exact building-owner raster audit.

- [x] **Step 1: Replace random grid parcelization with block compositions**

  Change `planAndPaintBuildings()` to iterate grammar lots in planned order, instantiate program-aware candidates, validate them against reserved tiles, and use deterministic small infill only when a block remains below its density contract. Never force a dense lot back to a rectangle; preserve requested L/U/T/courtyard/podium/paired forms.

- [x] **Step 2: Generate authored entrances and rooftop equipment**

  Store the grammar entrance on each building, choose roof assets by semantic kind, roof area, city, and floor count, and make `buildEntrancesFromPlan()` consume the same planned entrance rather than inventing a north midpoint. Preserve the north-door convention only for rectangular enterable service components whose current interior raster requires it.

- [x] **Step 3: eliminate every unplanned building writer**

  Scrub legacy `Building*` terrain globally in `clearLegacyUrbanInfrastructure()`. Change `paintHighwayFacilities()` to paint only site ground, and generate its motel/shop/service structures as explicit planned buildings (or remove the structure if a legal footprint cannot be planned). Remove direct remote-settlement and regional `paintRect(..., TileType.Building*)` stamps or replace them with explicit planned records before rasterization.

- [x] **Step 4: make occupancy bidirectionally auditable**

  Build an owner index while committing footprints. Validate that every planned footprint cell is a building-family or owned interior cell, every building-family cell has exactly one owner, no footprint touches road/sidewalk/runway/water/rock, and every entrance apron is non-solid and reachable from the block edge. Add quality counters for unowned building tiles, footprint mismatches, inaccessible entrances, missing site content, and city-style violations; generation must throw on any non-zero hard failure.

- [x] **Step 5: keep collision and nav contracts intact**

  Continue writing building-family tiles for exterior footprint cells so `SOLID_TILE_TYPES`, pedestrian A*, sight blocking, bullets, player collision, and vehicle collision all consume the same geometry. Do not add independent runtime building colliders.

- [x] **Step 6: expose the new audit in browser smoke**

  Extend the existing urban-plan snapshot and assertions to require zero unowned/mismatched footprint cells, zero inaccessible entrances, non-empty planned spaces, and meaningful shape/kind/size distributions.

### Task 3: Building-Level Pixel Volume Renderer

**Files:**
- Replace: `src/graphics/ArchitectureComposer.ts`
- Modify: `src/config/DepthLayers.ts`
- Modify: `src/systems/WorldManager.ts`
- Modify: `src/graphics/TilesetFactory.ts`

**Interfaces:**
- Consumes: planned buildings, spaces, entrances, roof assets, and interior bounds from `MapData`.
- Produces: `ArchitectureChunkArt` containing ground/public-realm graphics, cast-shadow graphics, structure graphics, and individually controllable enterable-roof graphics.

- [x] **Step 1: remove tile-driven/legacy rendering**

  Delete the `legacy:` blueprint path, periodic `lotId()`, and any rule that treats an unowned `Building*` tile as architecture. Index buildings and blocks by chunk/owner so each planned object is composed once, even when it crosses a 32×32 stream boundary.

- [x] **Step 2: split visual planes by physical role**

  Draw foundations/public realm below actors, stepped cast shadows at `Shadows`, wall/facade planes at `BuildingsLow`, and coherent roofs/parapets/equipment at `BuildingsHigh`. Use `DepthLayers.BuildingsLow/High` so actors and cars cannot appear on top of closed roofs.

- [x] **Step 3: render one coherent mass per building**

  Fill the union footprint with a single building palette; detect exposed perimeter edges from the building owner mask; draw south/east wall extrusion, contact foundation, parapets, roof border, corner highlights, and 2–4 stepped shadow bands. Derive discrete visual height from floors without moving the collision footprint. Keep pixel coordinates integral.

- [x] **Step 4: render program/city-specific silhouettes**

  Tehran gets concrete/stone/glass slabs, towers with podium/crowns, dense apartments, commercial frontages, and civic campuses. Yazd gets low adobe compounds, visible courtyards, domes, arcades, parapets, and windcatchers. Gilan gets detached timber masses, roof overhangs, strong pitched ridges, villas, moss/green roofs, and garden separation. Industrial, hospital, school, police, mosque, market, office, sports, stadium, parking, and government kinds must have distinct roof/facade modules.

- [x] **Step 5: scale roof equipment to roof area**

  Place HVAC banks, water tanks, solar arrays, stairs, chimneys, vents, dishes, billboards, AC units, skylights, and access doors at planned anchors. Large roofs receive multiple non-overlapping assets; small roofs remain legible and uncluttered.

- [x] **Step 6: neutralize collision-tile artwork**

  Replace miniature roof art in the three `TilesetFactory` building frames with subdued foundation/contact material. These frames remain collision adapters and must never resemble finished buildings without the composer.

- [x] **Step 7: integrate chunk ownership and culling**

  Store all returned architecture objects in each `DecoChunk`, destroy them with the chunk, and use a cull margin large enough for a 24-tile building/shadow crossing a chunk edge. Verify no double-painted alpha seams at chunk boundaries.

### Task 4: Planned Public Realm and Ground Detail

**Files:**
- Modify: `src/graphics/ArchitectureComposer.ts`
- Modify: `src/systems/WorldManager.ts`
- Modify: `src/gameplay/types/WorldTypes.ts`

**Interfaces:**
- Consumes: `PlannedUrbanSpace` and `PlannedGroundFeature` records.
- Produces: block-coherent parking/plaza/park/court/yard/market/garden visuals and clearance-aware sprite fixtures.

- [x] **Step 1: replace periodic public-realm inference**

  Delete `publicPlan(info)` and the old local 7×7 cadence. Paint each non-building block cell from its planned realm: marked parking, loading bays, plaza paving, courtyards, schoolyards, playgrounds, football/basketball courts, markets, parks, gardens, forest pockets, farm rows, service yards, and stadium fields.

- [x] **Step 2: place deliberate ground features**

  Generate and render entrances paths, gates, fences/walls, parking bays, trees, planters, lights, bins, benches, bike racks, utilities, signs, hydrants, mailboxes, and service/loading markings from planned anchors. Reject anchors inside building footprints, road reservations, crossings, runways, or entrance-clearance corridors.

- [x] **Step 3: reconcile visible and interactive fixtures**

  Ensure gameplay bench/bus-stop locations render the corresponding visible prop instead of creating an unrelated random fixture. Keep ambient cracks/leaves/puddles probabilistic, but remove random architectural props that can block or visually contradict planned access.

- [x] **Step 4: enforce purposeful-space content**

  Require every zero/low-density block to contain a planned realm and at least one appropriate feature group. Parks need paths/vegetation, parking needs bays/access, sports blocks need a marked playing surface, industrial yards need loading/service content, and plazas/markets need furniture or stalls.

### Task 5: Exterior Roofs for Enterable Interiors

**Files:**
- Modify: `src/graphics/ArchitectureComposer.ts`
- Modify: `src/systems/WorldManager.ts`
- Modify: `src/systems/WorldInteriorSystem.ts`

**Interfaces:**
- Produces: `WorldManager.setInteriorRoofOpen(interiorId: string | null): void`.
- Consumes: `BuildingInterior.id/bounds` and the player position already tracked by `WorldInteriorSystem`.

- [x] **Step 1: render service exteriors from their plan despite interior tiles**

  The planned-building index, not the post-carve tile type, determines exterior ownership. Render the closed roof/walls even when the underlying footprint contains `InteriorFloor`, `InteriorWall`, or `InteriorDoor`.

- [x] **Step 2: make enterable roofs individually controllable**

  Put each enterable building roof on a dedicated `Graphics` object registered by interior ID. Keep it visible outside; fade/hide it only when `WorldInteriorSystem.interiorAt(player)` returns that interior, then restore it immediately on exit.

- [x] **Step 3: verify occupant occlusion**

  From outside, interior NPCs, furniture, and the player must be hidden by the high roof layer. Inside, only the active roof opens, while neighboring roofs remain closed. Terrain collision/interior doors remain unchanged.

### Task 6: Quality Gates, Documentation, and Visual Iteration

**Files:**
- Modify: `docs/MODULAR_ARCHITECTURE.md`
- Modify: `docs/ART_DIRECTION.md`
- Modify: `scripts/browser-smoke.ps1`
- Create/update: `architecture-rework-tehran.png`
- Create/update: `architecture-rework-yazd.png`
- Create/update: `architecture-rework-gilan.png`

**Interfaces:**
- Consumes: final runtime `MapData.urbanPlan` and fixed city smoke positions.
- Produces: reproducible architecture validation output and three reviewed visual captures.

- [x] **Step 1: run static and focused validation**

  Run `npm run typecheck`, `npm run lint`, `npm run validate:architecture`, and `npm run build`. Fix all failures rather than suppressing them.

- [x] **Step 2: run regression systems**

  Run `npm run validate:traffic`, `npm run validate:police`, `npm run validate:gameplay`, and `npm run validate:highways`. The redesign must not regress connected roads, lanes, emergency response, combat, or highway geometry.

- [x] **Step 3: capture all three cities at matching conditions**

  Run `scripts/browser-smoke.ps1` for Tehran, Yazd, and Gilan with `-NoOverlay -Hour 8 -Zoom 1.0`. Require no browser errors, passing urban/traffic quality, and stable chunk streaming.

- [x] **Step 4: visually review and iterate**

  Inspect each original-resolution capture for coherent object silhouettes, wall depth, road alignment, open-space purpose, city identity, rooftop scale, actor/roof occlusion, chunk seams, repetitive strips, and fake collision-tile exposure. Adjust grammar proportions/palettes/details and repeat captures until all three cities are clearly distinct and every visible structure reads as a volume.

- [x] **Step 5: profile rendering**

  Record runtime FPS/traffic CPU from the smoke harness. Building-level indexing must not add per-frame allocations or scanning; chunk composition happens only on stream changes. Target 60 FPS where the existing test environment can sustain it and do not regress the captured baseline.

- [x] **Step 6: document the new source-of-truth invariant**

  Update architecture/art docs with the block grammar, footprint→raster→render data flow, city profiles, public-realm planning, depth planes, cutaway-roof behavior, collision semantics, and validation commands. Explicitly state that legacy/unowned building tiles are forbidden.

## Self-Review

- Spec coverage: real walls/roofs/depth/entrances/foundations/shadows; fake-building removal; block programs/zoning; shape/size variety; Tehran/Yazd/Gilan identity; purposeful empty land; road/setback/sidewalk alignment; NPC/vehicle collision; rooftop and ground details; pixel-art height; procedural determinism; and visual iteration all map to Tasks 1–6.
- Placeholder scan: every task names concrete records, functions, files, commands, and acceptance behavior; no deferred implementation placeholders remain.
- Type consistency: the grammar produces the exact rich `PlannedBuilding`/`PlannedUrbanSpace` data consumed by the rasterizer and renderer; `ArchitectureChunkArt` is owned by `DecoChunk`; the interior system uses the single `setInteriorRoofOpen` runtime seam.

## Verification status

The implementation run recorded passing results for:

```powershell
npm run typecheck
npm run lint
npm run validate:architecture
npm run build
npm run validate:traffic
npm run validate:police
npm run validate:gameplay
npm run validate:highways
```

The latest focused architecture validation exercised 416,759 assertions,
including 260 synthetic buildings, 123 exact planned spaces, nine shapes, all
four sizes, 21 semantic kinds, 581 roof assets and 569 multi-tile ground
features.

The final seed-`1337` browser audit records 1,909 exact disjoint blocks, 4,084
owned buildings, 3,744 purposeful spaces and a `0.999476` meaningfully
urbanized ratio. Density, road/building overlap, unowned tiles, footprint
mismatches, inaccessible entrances, missing site content, unexplained dead
ends, skyline and city-style counters are all zero. The dedicated cutaway probe
cycles one roof closed/open/closed, keeps a distinct neighboring roof closed,
and restores its temporary player/camera position.

Matched `-NoOverlay -Hour 8 -Zoom 1.0` captures are
`architecture-final-tehran-zoom1.png`, `architecture-final-yazd-zoom1.png` and
`architecture-final-gilan-zoom1.png`. Reservation-aware captures use the exact
planned block/building rather than a separate world-map marker:
`architecture-reserved-tehran-tower-final.png`,
`architecture-reserved-tehran-government.png`,
`architecture-reserved-tehran-stadium.png` and
`architecture-reserved-yazd-mosque.png`.

The GPU-enabled headless capture samples ranged from 22.4 to 41.9 FPS at 1x
zoom with 33-50 active traffic drivers and nine streamed chunks. This records
the current test environment honestly; it is not a claim of a 60 FPS result.
Architecture composition remains stream-change work through chunk indexes and
does not scan the 4,084-building country per frame.
