# Major Service Buildings Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the required four police stations and four hospitals into distinct, playable, data-driven landmarks shared by world generation, interiors, NPCs, gameplay, the world map, and the minimap.

**Architecture:** Extend the existing planned-building, in-world cutaway interior, pedestrian AI, traffic, wanted, health, and streaming systems. `MapData.majorBuildings` becomes the authoritative immutable registry; existing service arrays remain compatibility projections built from it, never independent marker data.

**Tech Stack:** TypeScript 5, Phaser 3.80, Vite, generated pixel-art `Graphics`, deterministic validation scripts, Chromium CDP smoke tests.

**Status:** Complete. Production build and architecture, gameplay, police,
traffic, major-building, and eight-location browser validations pass.

## Global Constraints

- Required distribution is Tehran `2 police / 2 hospital`, Yazd `1 / 1`, Gilan `1 / 1`.
- Police stations and hospitals must be real walkable in-world interiors, not popup scenes.
- Reuse the current NPC, navigation, collision, wanted, health, traffic, world generation, save/load, chunk streaming, and object-pool systems.
- Map and minimap markers must consume the same major-building source of truth and actual world positions.
- Pixel-art identity, city-specific architecture, bounded entities, proximity activation, and current gameplay behavior must remain intact.
- Add no unrelated building category unless the existing architecture supports functional behavior; this phase implements police and hospital only.

---

## Audit Summary

- `WorldManager` already plans semantic hospitals/police stations and carves walkable interior tiles into their real building footprints.
- `WorldInteriorSystem` opens only the owning streamed roof and seeds standard pooled `Pedestrian` entities near the player.
- Navigation uses the finalized collision raster and a queued worker; pedestrian placement already validates actor circles against solid tiles.
- Death respawns at the nearest hospital, arrest respawns at the nearest police station, ambulances dispatch from hospitals, and police patrols dispatch from stations.
- Service locations currently live in parallel arrays, map landmarks, minimap blips, and world glyph markers. Hospitals currently use the wrong required count (`4/1/1`, six total).
- Interiors use one generic fixed-offset layout per type, generic pedestrian skins, no role behavior, rectangle props, and no hard validation that every required service owns an interior.
- Exterior architecture already provides city palettes, program forms, emergency/police yards, ambulance/police parking features, roof cutaways, and chunk LOD; it needs service-specific identity and parked vehicle dressing rather than replacement.
- Baseline validation passes: typecheck, architecture (`416,759` assertions), gameplay (`84` checks), police (`45` checks). Browser baseline loads 19 total interiors, 9 chunks, and reports about 48 FPS during the capture probe.

---

### Task 1: Major Building Registry And Required Distribution

**Files:**
- Create: `src/gameplay/major-buildings/MajorBuildingRegistry.ts`
- Create: `src/gameplay/major-buildings/index.ts`
- Modify: `src/gameplay/types/WorldTypes.ts`
- Modify: `src/gameplay/types/index.ts`
- Modify: `src/systems/WorldManager.ts`
- Test: `scripts/major-buildings-validation.ts`

**Interfaces:**
- Produces: `MajorBuildingDefinition`, `MajorBuildingType`, `MajorBuildingIcon`, `MajorBuildingRegistry`, `MapData.majorBuildings`.
- Compatibility: `MapData.hospitals`, `policeStations`, `fireStations`, and other current service arrays continue to exist but required police/hospital arrays are projected from registry definitions.

- [x] Define immutable records with `id`, `type`, `city`, `buildingId`, `worldPosition`, `entrancePosition`, `exteriorBounds`, `interiorId`, `mapIcon`, `minimapIcon`, `size`, `architecturalVariant`, `npcProfile`, `parkingArea`, `services`, and `activeState`.
- [x] Reserve exactly the required eight compatible planned buildings before lower-priority service roles can claim them.
- [x] Generate stable identity names and distinct variants: Tehran metropolitan headquarters, Tehran district station, Yazd courtyard station, Gilan regional station, and four corresponding hospital variants.
- [x] Throw during generation when a required location lacks a compatible owner, interior, city assignment, primary entrance, or exact registry projection.
- [x] Add pure registry queries for type/city/id/nearest and verify no duplicate ids, owners, coordinates, or role claims.

### Task 2: Authored Playable Interior Layouts And Collision

**Files:**
- Create: `src/gameplay/major-buildings/MajorInteriorLayouts.ts`
- Modify: `src/gameplay/types/WorldTypes.ts`
- Modify: `src/systems/WorldManager.ts`
- Modify: `src/gameplay/world/InteriorNpcPlacement.ts`
- Test: `scripts/major-buildings-validation.ts`

**Interfaces:**
- Consumes: major-building variant, city, exact planned footprint, primary entrance.
- Produces: `BuildingInterior` rooms, doors, props, role anchors, activity routes, and collision partition tiles within the real footprint.

- [x] Replace generic fixed-offset hospital/police layouts with footprint-relative templates that fit the owning building and preserve a continuous entrance-to-room navigation spine.
- [x] Give every police layout reception, waiting/desks, offices, interrogation/evidence, locker/equipment, cells, and back/corridor areas.
- [x] Give every hospital layout reception, waiting, emergency/exam, patient rooms, nurses station, doctor area, procedure area, and pharmacy/storage.
- [x] Add detailed pixel-sized furnishings and logical room labels without blocking circulation or interaction ranges.
- [x] Validate every door aperture, actor-radius spawn envelope, object bounds, room bounds, room reachability, exit path, and wall/furniture collision before exposing the map.

### Task 3: Exterior Identity And Service-Site Dressing

**Files:**
- Modify: `src/graphics/ArchitectureComposer.ts`
- Modify: `src/generation/ArchitectureGrammar.ts`
- Modify: `src/systems/WorldManager.ts`
- Test: `scripts/major-buildings-validation.ts`

**Interfaces:**
- Consumes: planned building kind/city/service variant and exact planned urban spaces.
- Produces: recognizable facade/roof signage, entrances, windows, emergency/police site markings, lighting, security elements, landscaping, and parking anchors.

- [x] Render distinct police badge/light-bar/sign bands and hospital cross/emergency/ambulance entrance cues at building scale.
- [x] Preserve Tehran modern massing, Yazd earth-tone courtyard/arched language, and Gilan sloped-roof/green regional language.
- [x] Derive registry parking/service anchors from authored `police-parking` and `ambulance-bay` features, with safe fallback anchors on the owning purposeful space.
- [x] Replace single-letter world marker rectangles at required buildings with recognizable pixel-art sign assemblies tied to registry entries.
- [x] Keep every exterior object inside its planned site/chunk and off entrance access paths and roads.

### Task 4: Dedicated NPC Roles, Behavior, And Streaming

**Files:**
- Modify: `src/gameplay/types/WorldTypes.ts`
- Modify: `src/entities/Pedestrian.ts`
- Modify: `src/entities/components/PedestrianAIComponent.ts`
- Modify: `src/entities/components/pedestrian/PedestrianTypes.ts`
- Modify: `src/entities/components/pedestrian/PedestrianIdleStates.ts`
- Modify: `src/systems/PedestrianSystem.ts`
- Modify: `src/systems/WorldInteriorSystem.ts`
- Test: `scripts/major-buildings-validation.ts`

**Interfaces:**
- Consumes: authored role, appearance profile, anchor/activity route, home bounds, and active interior proximity.
- Produces: standard pooled pedestrians with role-specific tint/silhouette and bounded work, sit, wait, patrol, inspect, attend, and talk activity loops.

- [x] Extend `spawnAt` with optional role/profile data without creating a second NPC hierarchy.
- [x] Assign hospital doctors, nurses, patients, receptionists, paramedics, and security; assign reception, desk, corridor, detective, cell, and evidence officers in police buildings.
- [x] Constrain activities to validated interior route anchors so NPCs cannot leave the owning interior or path through walls/furniture.
- [x] Activate only interiors within the existing proximity radius, reuse the pedestrian pool, and explicitly retire owned NPCs after the player leaves the activation band.
- [x] Keep per-interior target counts bounded and ensure ordinary ambient spawns cannot enter closed interiors.

### Task 5: Gameplay And Service Vehicle Integration

**Files:**
- Modify: `src/systems/WorldInteriorSystem.ts`
- Modify: `src/systems/PlayerController.ts`
- Modify: `src/systems/WantedSystem.ts`
- Modify: `src/systems/EmergencyResponseSystem.ts`
- Modify: `src/systems/TrafficSystem.ts`
- Modify: `src/systems/WorldManager.ts`
- Test: `scripts/major-buildings-validation.ts`
- Test: `scripts/gameplay-systems-validation.ts`

**Interfaces:**
- Consumes: registry service queries and parking/service anchors.
- Produces: authoritative healing/HP updates, arrest/respawn points, station dispatch origins, ambulance dispatch origins, and proximity-streamed parked service vehicles.

- [x] Route healing through `Player.giveHealth` and preserve `PlayerVitalsChanged` HUD synchronization.
- [x] Keep arrest and death flows intact while selecting registry entrances for police/hospital placement.
- [x] Dispatch police and ambulance vehicles from the matching building parking/service anchor, falling back to the nearest legal road lane.
- [x] Stream a small bounded set of parked police cars and ambulances near active required sites through the existing vehicle/traffic lifecycle.
- [x] Keep save/load provider contracts unchanged; restored player positions continue through safe actor placement.

### Task 6: Shared World Map And Minimap Icons

**Files:**
- Create: `src/ui/hud/MajorBuildingIconPainter.ts`
- Modify: `src/ui/hud/MiniMap.ts`
- Modify: `src/scenes/UIScene.ts`
- Modify: `src/scenes/MapScene.ts`
- Modify: `src/systems/InteractionSystem.ts`
- Test: `scripts/major-buildings-validation.ts`

**Interfaces:**
- Consumes: `MapData.majorBuildings` only for required service markers.
- Produces: shared badge/cross icon geometry at actual building coordinates, scaled for full-map and minimap readability.

- [x] Draw recognizable police badge and medical cross icons with high-contrast outlines and stable pixel dimensions.
- [x] Replace landmark-derived police/hospital world-map dots with registry marker records.
- [x] Cache static major-building icons in `MiniMap.setMap`; keep the per-frame blip layer for moving entities/objectives only.
- [x] Derive interaction prompts and nearest-building waypoints from registry entrance positions.
- [x] Verify full-map and minimap coordinates match registry positions after zoom, pan, and city transitions.

### Task 7: In-World Presentation And Entrance Feedback

**Files:**
- Modify: `src/systems/WorldInteriorSystem.ts`
- Modify: `src/graphics/EnvironmentTextureFactory.ts`
- Modify: `src/graphics/TilesetFactory.ts`
- Test: `scripts/major-buildings-validation.ts`

**Interfaces:**
- Consumes: active interior, entrance/door records, room/prop data, and camera/player position.
- Produces: seamless doorway feedback, owning-roof cutaway, room floor accents, pixel-art furniture, labels/signage, and service ambience.

- [x] Keep physical walk-through entry/exit and automatically open only doors near the player; never launch `InteriorScene` for required buildings.
- [x] Render props as multi-part pixel-art silhouettes rather than unadorned colored rectangles.
- [x] Add restrained floor bands, room thresholds, window/light cues, wall trim, and role signage that remain readable beneath the cutaway.
- [x] Cull or hide interior props/labels outside the active streamed neighborhood while preserving collision tiles.

### Task 8: Eight-Location Validation And Visual Audit

**Files:**
- Create: `scripts/major-buildings-validation.ts`
- Create: `scripts/run-major-buildings-validation.mjs`
- Create: `scripts/major-buildings-browser-smoke.ps1`
- Modify: `package.json`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `GAMEPLAY.md`

**Interfaces:**
- Produces: `npm run validate:major-buildings` and browser screenshots/JSON for every required building.

- [x] Validate exact distribution, unique variants, semantic owner kinds, real interiors, room sets, dedicated NPC roles, entrance/exit reachability, object clearance, marker source equality, and parking anchors.
- [x] Browser-warp to all eight entrances and interiors, assert owning-roof isolation, active NPC bounds/behavior, door transitions, exit continuity, map/minimap marker projection, and no console errors.
- [x] Capture exterior and interior screenshots for all eight locations at a stable daytime hour and inspect every image for placeholders, overlaps, clipping, and unreadable signage.
- [x] Compare active chunks/entities and observed FPS against baseline; fix any material regression before completion.
- [x] Run `npm run build`, `validate:major-buildings`, `validate:architecture`, `validate:gameplay`, `validate:police`, `validate:traffic`, and the browser smoke suites.
