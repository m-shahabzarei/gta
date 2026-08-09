# Major Location Map Minimap POI Final Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make all eight required police-station and hospital locations discoverable on the full world map and in-game minimap from one authoritative major-building registry.

**Architecture:** Keep the existing service-building/interior pipeline intact. Expose map/minimap POI records from `MajorBuildingRegistry`, render both UIs from `map.majorBuildings`, and use `WorldMapState.setWaypoint()` for selection navigation.

**Tech Stack:** TypeScript, Phaser 3 Graphics, Vite, existing `MapData.majorBuildings` and `MajorBuildingDefinition` types.

## Global Constraints

Do not rebuild the building/interior system.
Do not redesign unrelated gameplay systems.
All 8 required locations must have proper map POIs: Tehran 2 police + 2 hospitals, Yazd 1 police + 1 hospital, Gilan 1 police + 1 hospital.
Full world map must use dedicated police and hospital pixel-art icons, not generic dots.
Minimap must consume the same POI definitions as the full map, not a separate manually maintained list.
Markers must be positioned from actual building world coordinates through map coordinate conversion.
Hover/select on the full map must show the POI name; selecting a POI should integrate with the existing waypoint state.
Minimap POIs must be readable at minimap scale and clipped to minimap bounds.
Player marker must remain visually distinct from POIs.
Avoid expensive per-frame POI loops; there are only 8 static POIs.

---

## File Structure

- Modify `src/gameplay/major-buildings/MajorBuildingRegistry.ts`: add POI projection helpers over existing definitions without changing generation.
- Modify `src/ui/hud/MajorBuildingIconPainter.ts`: provide reusable pixel-art icon drawing with full-map and minimap sizes.
- Modify `src/scenes/MapScene.ts`: draw service POIs in a screen-space overlay, add legend icons, hover/select label panel, and set waypoint from selected POI.
- Modify `src/ui/hud/MiniMap.ts`: draw major POIs from `MapData.majorBuildings` in the static minimap cache with icon sizing that remains readable.
- Modify `scripts/major-buildings-validation.ts`: validate the POI projection, icon assignments, labels, and same-source map/minimap data.
- Modify `scripts/major-buildings-browser-smoke.ps1`: verify full-map POI rendering, selection labels, waypoint integration, and minimap source data in the running game.

### Task 1: Registry POI projection

**Files:**
- Modify: `src/gameplay/major-buildings/MajorBuildingRegistry.ts`
- Modify: `scripts/major-buildings-validation.ts`

**Interfaces:**
- Consumes: `MajorBuildingDefinition`
- Produces: `MajorLocationPoi`, `MajorBuildingRegistry.pois()`, `MajorBuildingRegistry.poisForCity(city)`

- [ ] Add a `MajorLocationPoi` interface:

```ts
export interface MajorLocationPoi {
  id: string;
  type: MajorBuildingType;
  city: CityId;
  worldPosition: Vector2;
  entrancePosition: Vector2;
  mapIcon: MajorBuildingIcon;
  minimapIcon: MajorBuildingIcon;
  displayName: string;
  label: string;
  interiorId: string;
  buildingId: string;
}
```

- [ ] Add projection methods that copy nested vectors:

```ts
public pois(): readonly MajorLocationPoi[] {
  return this.definitions.map((definition) => this.toPoi(definition));
}

public poisForCity(city: CityId): readonly MajorLocationPoi[] {
  return this.definitions
    .filter((definition) => definition.city === city)
    .map((definition) => this.toPoi(definition));
}
```

- [ ] Validate that `pois()` returns 8 entries and that every hospital uses `medical-cross` while every police station uses `police-badge`.

### Task 2: Pixel-art icon rendering

**Files:**
- Modify: `src/ui/hud/MajorBuildingIconPainter.ts`

**Interfaces:**
- Consumes: `MajorBuildingIcon`, `Phaser.GameObjects.Graphics`, screen/map positions
- Produces: `paintMajorBuildingIcon()` and `majorBuildingIconHitRadius()`

- [ ] Replace round/vector-looking service icons with high-contrast pixel-block icons built from `fillRect()` and integer-grid cells.
- [ ] Keep the same exported `paintMajorBuildingIcon(graphics, icon, x, y, size)` signature.
- [ ] Add `majorBuildingIconHitRadius(size: number): number` for hover/select hit tests.
- [ ] Ensure `medical-cross` and `police-badge` are visually distinct at sizes 7, 11, and 16.

### Task 3: Full world map POI overlay, legend, and selection

**Files:**
- Modify: `src/scenes/MapScene.ts`

**Interfaces:**
- Consumes: `map.majorBuildings`, `paintMajorBuildingIcon`, `majorBuildingIconHitRadius`, `setWaypoint`
- Produces: hover label, selected POI panel, POI click-to-waypoint integration

- [ ] Add a non-scaled `poiLayer` graphics object outside the panned map content.
- [ ] Draw POI icons by converting each `building.worldPosition` to screen coordinates:

```ts
private worldToMapScreen(point: Vector2): Vector2 {
  const scale = this.scalePerTile();
  return {
    x: this.offsetX + (point.x / TILE_SIZE) * scale,
    y: this.offsetY + (point.y / TILE_SIZE) * scale,
  };
}
```

- [ ] Do not draw hospital/police POIs in the scaled static marker layer.
- [ ] On pointer move, find the nearest service POI under `majorBuildingIconHitRadius(FULL_MAP_POI_SIZE)`, show name/city/type, and keep panning behavior intact.
- [ ] On click without drag over a POI, call `setWaypoint(building.entrancePosition)` and show selected info text. On click not over a POI, preserve existing custom waypoint placement.
- [ ] Replace generic legend dots for Hospital and Police with actual calls to `paintMajorBuildingIcon()`.

### Task 4: Minimap POIs from same data

**Files:**
- Modify: `src/ui/hud/MiniMap.ts`

**Interfaces:**
- Consumes: `map.majorBuildings`
- Produces: clipped, static minimap icons from the same `MajorBuildingDefinition` list

- [ ] Draw all service POIs in `MiniMap.setMap()` from `map.majorBuildings`.
- [ ] Use `building.worldPosition` and `building.minimapIcon`.
- [ ] Use small fixed pixel-art sizes: metropolitan 6px, other service buildings 5px.
- [ ] Keep player marker as the existing yellow accent centre dot; do not reuse service icons for the player.

### Task 5: Browser smoke verification

**Files:**
- Modify: `scripts/major-buildings-browser-smoke.ps1`

**Interfaces:**
- Consumes: live Phaser scene objects through CDP
- Produces: report fields proving map POI, minimap POI, labels, and waypoint behavior

- [ ] After opening the map, read `MapScene.debugMajorPoiSnapshot()` or equivalent public method.
- [ ] Validate 8 rendered POIs, 4 hospital icons, 4 police icons, all labels non-empty, all POI screen positions inside map view at whole-map zoom.
- [ ] Dispatch a click to one POI and validate that `getWaypoint()` equals that building entrance.
- [ ] Validate minimap uses the same `majorBuildings` list and has `majorPoiCount === 8`.
- [ ] Save screenshots for exterior/minimap and world map.

### Task 6: Final local verification

**Files:**
- No source changes unless tests reveal defects.

**Interfaces:**
- Consumes: `npm run validate:major-buildings`, `npm run build`, browser smoke script
- Produces: passing validation/build and visual artifacts

- [ ] Run `npm run validate:major-buildings`.
- [ ] Run `npm run build`.
- [ ] Start the dev server.
- [ ] Run the browser smoke script against the dev server.
- [ ] Inspect the generated world-map screenshot and at least one minimap/exterior screenshot for icon readability and anchoring.
