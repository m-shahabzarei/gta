# Highway-to-City Transition Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace direct highway portal connections with deterministic, engineered interchange systems that carry continuous road hierarchy, smooth authored geometry, credible city-gate land use, and traffic-safe merges.

**Architecture:** `HighwayTransitionPlanner` will select a terrain/city/traffic-appropriate template and emit the single authoritative transition model: render splines, graph segments, gore geometry, design metrics, and gate-zone sites. `HighwayPlanner` will incorporate those records into each route; the geometry index, canvas painter, traffic network, driver, and validators will consume the same data instead of inferring unrelated ramp shapes.

**Tech Stack:** TypeScript 5.4, Phaser 3.80, Canvas 2D chunk rasterization, deterministic procedural generation, Node/esbuild validation scripts.

## Global Constraints

- Do not connect a highway carriageway directly to a local, residential, alley, or access street.
- Preserve the hierarchy `highway -> ramp -> collector -> primary -> secondary -> local` in the authored graph.
- Ramp centreline curvature must stay at or above the configured minimum design radius and below the maximum heading-change rate.
- Acceleration/deceleration lanes, lane width, shoulders, and gore tapers must be explicit data and validated before world generation continues.
- Interchanges must remain deterministic for a world seed and must not increase the chunk renderer's retained-object count.
- Vehicles must not reverse on a carriageway, ramp, slip road, collector, or transition road.
- Reject invalid geometry rather than cosmetically hiding it.

---

### Task 1: Shared Transition Engineering Model

**Files:**
- Modify: `src/gameplay/types/WorldTypes.ts`
- Create: `src/generation/HighwayTransitionPlanner.ts`
- Test: `scripts/highway-validation.ts`

**Interfaces:**
- Consumes: `WorldCity`, `PlannedRoadSegment`, `HighwayCarriagewayDirection`, `Vector2`.
- Produces: `HighwayInterchangeKind`, `HighwayTransitionPath`, `HighwayGoreArea`, `HighwayCityGateZone`, `HighwayInterchange`, and `HighwayTransitionPlanner.generate(input): HighwayTransitionPlanningResult`.

- [ ] **Step 1: Add failing schema/selection assertions**

Add validation assertions that every generated endpoint has a supported interchange kind, a city-size/terrain selection reason, explicit entry/exit/collector/transition paths, and stable output for the same seed.

- [ ] **Step 2: Verify the validation fails**

Run: `npm run validate:highways`

Expected: TypeScript bundling fails because transition paths and selection metadata do not exist.

- [ ] **Step 3: Define the engineering records**

Add discriminated records for the seven interchange kinds, road path roles, design speeds, lane/shoulder widths, merge/taper distances, per-path road segment IDs, gore polygons, guardrail/crash-attenuator flags, and city-gate sites.

- [ ] **Step 4: Implement deterministic template selection**

Use city footprint, route character, endpoint traffic demand, available approach length, and a seeded tie-breaker. Keep roundabouts limited to small cities, directional T/trumpet layouts for constrained terrain, and SPUI/folded diamond layouts for high-demand urban portals.

- [ ] **Step 5: Verify deterministic coverage**

Run: `npm run validate:highways`

Expected: Selection/schema checks pass; later geometry checks may still fail until Task 2.

### Task 2: Authored Ramp, Collector, and Transition Geometry

**Files:**
- Modify: `src/generation/HighwayPlanner.ts`
- Modify: `src/generation/HighwayTransitionPlanner.ts`
- Modify: `src/generation/UrbanPlanner.ts`
- Test: `scripts/highway-validation.ts`

**Interfaces:**
- Consumes: carriageway merge nodes, city portal frame, selected `HighwayInterchangeKind`.
- Produces: smooth transition paths and matching `PlannedRoadSegment[]` with `laneTransition`, `designSpeed`, and `transitionPathId` metadata.

- [ ] **Step 1: Add failing hierarchy and geometry assertions**

Assert no carriageway/local adjacency, minimum five-tile graph edges, minimum ramp length, minimum radius, bounded curvature change, continuous lane/shoulder widths, valid merge/deceleration spans, and unique road ownership.

- [ ] **Step 2: Move mainline terminals away from the city boundary**

Increase terminal clearance enough to fit a full design-speed deceleration lane, ramp curve, collector, and transition road before the primary boulevard portal.

- [ ] **Step 3: Generate template-specific spline paths**

Build all templates from portal tangent/normal frames using cubic Bezier paths and arc-length resampling. Diamond, folded-diamond, SPUI, and directional-T templates use long direct ramps; parclo and trumpet templates use broad loop quadrants; small-city roundabouts use yield-controlled approach arcs.

- [ ] **Step 4: Emit a continuous hierarchy graph**

Split each spline into routable graph edges. Entry direction follows `primary -> transition -> collector -> entry/slip ramp -> carriageway`; exit direction reverses the hierarchy through its paired one-way path. Set explicit component, lane count, design speed, direction, and transition metadata on every edge.

- [ ] **Step 5: Integrate city primary anchors**

Make `UrbanPlanner.highwayAnchors()` use each interchange's `cityConnection` rather than raw route endpoints, ensuring the primary boulevard meets only the transition road.

- [ ] **Step 6: Verify topology and engineering limits**

Run: `npm run validate:highways && npm run typecheck`

Expected: all template, graph, radius, hierarchy, continuity, and deterministic checks pass.

### Task 3: Gore Areas and City-Gate Districts

**Files:**
- Modify: `src/generation/HighwayTransitionPlanner.ts`
- Modify: `src/generation/HighwayPlanner.ts`
- Test: `scripts/highway-validation.ts`

**Interfaces:**
- Consumes: ramp/mainline divergence samples and `WorldCity` demand profile.
- Produces: proportioned gore polygons, crash-attenuator/furniture records, landscaping records, and land-use-focused gate-zone sites.

- [ ] **Step 1: Add failing gore and gate-zone assertions**

Assert gore length/width ratio, taper angle, tip setback, non-overlap, crash attenuator presence, optional chevrons, and at least one mobility/logistics use plus engineered landscaping per gate zone.

- [ ] **Step 2: Derive gore geometry from lane width**

Build the triangle from the mainline/ramp tangent field with a narrow tip and a taper length tied to design speed. Place the crash attenuator behind the tip and guard rails only on exposed outer edges.

- [ ] **Step 3: Generate functional transition districts**

Select industrial logistics, truck terminal, warehouse, fuel, commercial, park-and-ride, bus terminal, or checkpoint programs by city/route demand. Place signs, lights, drainage, embankments, retaining walls, noise barriers, fences, trees, bushes, rocks, and small hills in intentional bands outside road clear zones.

- [ ] **Step 4: Verify authored sites remain clear**

Run: `npm run validate:highways`

Expected: no gate site intersects pavement/gore clear zones and every interchange meets program and landscaping coverage.

### Task 4: Transition Rendering From Authoritative Geometry

**Files:**
- Modify: `src/gameplay/highway/HighwayRenderTypes.ts`
- Modify: `src/gameplay/highway/HighwayGeometry.ts`
- Modify: `src/gameplay/highway/HighwayCanvasPainter.ts`
- Test: `scripts/highway-validation.ts`

**Interfaces:**
- Consumes: `HighwayTransitionPath[]`, `HighwayGoreArea[]`, and `HighwayCityGateZone[]`.
- Produces: chunk-bucketed transition/gore/site geometry rendered in existing static highway canvases.

- [ ] **Step 1: Add failing render-index assertions**

Require one indexed render path per authored transition path, preserved full-path arc distance, stable merge/taper intervals across chunks, and one indexed gore per authored gore.

- [ ] **Step 2: Replace inferred two-point ramp construction**

Index the authored spline directly and retain full-path distance while clipping it into chunks. Keep service-area ramp inference isolated from city interchange paths.

- [ ] **Step 3: Paint consistent transition cross-sections**

Use the mainline asphalt, shoulder, edge-line, dashed-line, and guardrail language with lane-width-scaled strokes. Preserve lane lines through the full diverge/merge and avoid terminal caps inside the interchange.

- [ ] **Step 4: Paint restrained gore and engineering details**

Render a lane-scale triangle with diagonal hatching, a small crash attenuator, conditional chevrons/rails, drainage, embankments, fences, barriers, lighting, and gate facilities. Keep all elements in the static chunk canvas.

- [ ] **Step 5: Verify render indexing and build**

Run: `npm run validate:highways && npm run build`

Expected: render-path/gore assertions and production build pass.

### Task 5: Traffic-Aware Merges, Exits, and Speed Transitions

**Files:**
- Modify: `src/systems/WorldManager.ts`
- Modify: `src/gameplay/traffic/TrafficNetwork.ts`
- Modify: `src/gameplay/traffic/TrafficDriver.ts`
- Modify: `src/gameplay/traffic/TrafficValidator.ts`
- Modify: `src/gameplay/traffic/TrafficTypes.ts`
- Test: `scripts/traffic-validation.ts`

**Interfaces:**
- Consumes: road component, explicit design speed, transition type, connector priority.
- Produces: ramp/collector speed policy, merge-yield connectors, exit commitment, and no-reverse recovery policy.

- [ ] **Step 1: Add failing component-policy assertions**

Assert component speed limits descend from mainline to primary boulevard, entry connectors yield to mainline, exit connectors never yield on the mainline, and transition components cannot enter reversing recovery.

- [ ] **Step 2: Map authored speeds into runtime edges**

Use `PlannedRoadSegment.designSpeed` for carriageway, ramps, collectors, slip roads, and transition roads; retain existing defaults only for ordinary urban streets.

- [ ] **Step 3: Classify transition connectors**

Treat ramp-to-mainline links as merge lanes, mainline-to-ramp links as exits, roundabout approaches as yielding connectors, and collector/transition continuations as non-stopping priority movement.

- [ ] **Step 4: Extend driver policy**

Use route look-ahead to reduce speed before the ramp, retain highway speed until the deceleration lane, accelerate through entry paths, reserve a safe downstream gap before merging, and disallow reversing on every transition component.

- [ ] **Step 5: Extend runtime validation**

Report stopped-in-merge, transition reversal, unsafe merge, and route-confusion failures with component/lane context.

- [ ] **Step 6: Run deterministic traffic simulation**

Run: `npm run validate:traffic`

Expected: zero wrong-direction, unexplained-stop, stopped-in-merge, transition-reversal, collision, or recovery-timeout failures.

### Task 6: Hard Rejection, Documentation, and Visual QA

**Files:**
- Modify: `scripts/highway-validation.ts`
- Modify: `src/generation/HighwayPlanner.ts`
- Modify: `src/systems/WorldManager.ts`
- Modify: `docs/HIGHWAY_SYSTEM.md`

**Interfaces:**
- Consumes: per-interchange design metrics and world road graph.
- Produces: expanded `HighwayQualityReport` and end-to-end validation evidence.

- [ ] **Step 1: Reject every requested failure class**

Aggregate sharp curvature, overlapping markings/gores, short merge lanes, direct local connections, oversized gores, road-edge intersections, incomplete hierarchy, missing gate zones, and transition graph dead ends into `HighwayQualityReport.issues`.

- [ ] **Step 2: Audit the final world graph**

Verify every authored transition edge reaches both its primary city boulevard and the legal carriageway direction, and that no forbidden reverse movement or local adjacency exists after rasterization.

- [ ] **Step 3: Update engineering documentation**

Document template selection, geometry standards, hierarchy ownership, traffic behavior, gate-zone programs, and the expanded rejection gates.

- [ ] **Step 4: Run all automated checks**

Run: `npm run typecheck && npm run build && npm run validate:highways && npm run validate:traffic`

Expected: all commands pass.

- [ ] **Step 5: Inspect representative layouts in the browser**

Start Vite on a free local port, capture desktop views of at least an urban high-demand, constrained-terrain, and small-city transition, and verify curves, paint, hierarchy, facilities, clear zones, and vehicle flow without overlaps or visual artifacts.

- [ ] **Step 6: Record verification results**

Update `docs/HIGHWAY_SYSTEM.md` with measured assertion counts, traffic steps, build result, representative selected templates, and any remaining performance figures.
