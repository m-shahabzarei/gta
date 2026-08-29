# World Map Property UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display every valid home and real-estate office on the full-screen world map and make the map guide, marker feedback, and controls substantially clearer and more usable.

**Architecture:** Keep `MapScene` as the owner of paused-map interaction and add a small pure presentation helper plus dedicated screen-space home and real-estate-office icons. Housing data comes read-only from `HousingSystem`; map clicks only set a waypoint to the home entrance or city agent, preserving the existing purchase flow.

**Tech Stack:** TypeScript 5, Phaser 3.80, Vite 5, existing service locator and housing catalog, browser-based visual QA.

## Global Constraints

- Preserve the existing generated world, waypoint, taxi, major-building, public-transport, and pause/resume flows.
- Render home and real-estate-office markers in screen space so icons and hit targets stay usable at every zoom level.
- Distinguish for-sale, owned, and active-home markers by both shape/detail and color.
- Keep desktop controls at least 32px high and mobile controls at least 44px high.
- Use the existing pixel-art visual language and `Courier New` typography; do not add network fonts or new runtime dependencies.
- The final implementation must pass TypeScript, housing validation, production build, and browser visual checks.

---

### Task 1: Property map presentation model and icon

**Files:**
- Create: `src/gameplay/HousingMapPresentation.ts`
- Create: `src/ui/hud/PropertyMapIconPainter.ts`
- Modify: `src/ui/hud/index.ts`
- Modify: `scripts/housing-validation.ts`

**Interfaces:**
- Consumes: `PropertyDefinition.id`, `HousingOwnershipState.ownedPropertyIds`, and `HousingOwnershipState.activeHomeId`.
- Produces: `PropertyMapStatus`, `classifyPropertyMapStatus(propertyId, ownedIds, activeHomeId)`, `paintPropertyMapIcon(graphics, status, x, y, size)`, and `propertyMapIconHitRadius(size)`.

- [ ] **Step 1: Add failing state-classification assertions**

```ts
check(classifyPropertyMapStatus('a', [], null) === 'for-sale', 'unowned property state');
check(classifyPropertyMapStatus('a', ['a'], null) === 'owned', 'owned property state');
check(classifyPropertyMapStatus('a', ['a'], 'a') === 'active', 'active property state');
```

- [ ] **Step 2: Run validation to verify the helper is missing**

Run: `npm run validate:housing`
Expected: FAIL because `HousingMapPresentation` does not exist.

- [ ] **Step 3: Implement the pure classifier and pixel house marker**

```ts
export type PropertyMapStatus = 'for-sale' | 'owned' | 'active';

export function classifyPropertyMapStatus(
  propertyId: string,
  ownedPropertyIds: readonly string[],
  activeHomeId: string | null,
): PropertyMapStatus {
  if (activeHomeId === propertyId) return 'active';
  return ownedPropertyIds.includes(propertyId) ? 'owned' : 'for-sale';
}
```

The painter renders a stable house silhouette with an amber sale tag, cyan owned check, or green active-home halo.

- [ ] **Step 4: Run the housing validation**

Run: `npm run validate:housing`
Expected: PASS, including the three property-map state assertions.

### Task 2: Interactive property layer and detail card

**Files:**
- Modify: `src/scenes/MapScene.ts`

**Interfaces:**
- Consumes: `HousingSystem.catalog`, `HousingSystem.ownershipState`, property painter interfaces from Task 1, and the existing waypoint API.
- Produces: screen-space home and office targets, hover/selection behavior, a `debugPropertySnapshot()` browser-validation surface, and contextual detail-card content.

- [ ] **Step 1: Resolve the housing catalog and create property target state**

Add cached property screen targets plus hovered and selected property ids. Only valid catalog entries are rendered.

- [ ] **Step 2: Render status-aware home and office markers**

Redraw homes and the three city real-estate offices alongside major POIs after pan/zoom and when ownership state changes. Keep hit targets at least 28px on desktop and 44px on mobile.

- [ ] **Step 3: Add hover and click behavior**

On hover, show the property name and state. On click, select the property, set the waypoint to `entranceWorldPosition`, and clear any selected major POI.

- [ ] **Step 4: Expand the detail card**

Show name, city/district, sale or ownership state, localized cash price, distance, parking capacity, and the route action. Ensure the card remains inside the map viewport.

- [ ] **Step 5: Run TypeScript and housing checks**

Run: `npm run typecheck && npm run validate:housing`
Expected: PASS.

### Task 3: Rework the map guide and controls

**Files:**
- Modify: `src/scenes/MapScene.ts`

**Interfaces:**
- Consumes: live property counts and ownership state from Task 2.
- Produces: grouped navigation/property/place legend sections, visible marker counts, concise interaction help, current-city context, and existing map buttons with clearer labels.

- [ ] **Step 1: Replace the flat legend with a grouped map guide**

Use `NAVIGATION`, `PROPERTIES`, and `PLACES + ROUTES` groups. Display for-sale, owned, and active-home icon samples with counts so color is never the only status cue.

- [ ] **Step 2: Add a compact interaction guide**

Show `DRAG Pan`, `WHEEL / +/- Zoom`, `CLICK Marker: set route`, and `BACKSPACE Clear route` without covering the map.

- [ ] **Step 3: Improve control labels and hierarchy**

Keep Locate, zoom, close, and clear-route controls, with one primary map action and no overlapping interaction zones at 1280×720.

- [ ] **Step 4: Run production checks**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: PASS with no new warnings or errors.

### Task 4: Documentation and visual QA loop

**Files:**
- Modify: `docs/WORLD_MAP.md`
- Create: `map-ui-audit/04-property-map-desktop.png`
- Create: `map-ui-audit/05-property-map-zoomed.png`
- Create: `map-ui-audit/06-property-map-small.png`

**Interfaces:**
- Consumes: the completed map UI and browser debug snapshots.
- Produces: documented property-map semantics and evidence of desktop, zoomed, and smaller-viewport usability.

- [ ] **Step 1: Document property map semantics**

Describe property states, click-to-route behavior, read-only relationship with housing ownership, and the debug snapshot fields.

- [ ] **Step 2: Capture desktop overview and inspect marker clarity**

Run the local game at a 1440×900 browser viewport, open a new game, press `M`, and capture the full map. Verify all valid catalog properties are represented and the guide remains readable.

- [ ] **Step 3: Capture a zoomed interaction state**

Zoom into Tehran, hover and click a property, then capture the marker, tooltip/detail card, and waypoint route together.

- [ ] **Step 4: Capture a smaller-viewport state**

Repeat at a compact landscape viewport. Verify no guide/control overlap, clipped text, hidden map actions, or unusable hit targets.

- [ ] **Step 5: Complete the final validation pass**

Run: `npm run validate:housing && npm run typecheck && npm run lint && npm run build`
Expected: all commands PASS; browser console contains no new map or housing errors.
