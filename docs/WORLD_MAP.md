# Seamless Country Map

## Scale and layout

The generated country is `1920 x 1408` tiles (`61,440 x 45,056` world pixels).
Tehran occupies the southern metropolitan region, Gilan the north-west Caspian
coast, and Yazd the isolated eastern desert. The cities share one coordinate
space, road graph and streamed scene; travel does not use city-specific loading
screens or teleport boundaries.

Intercity routes and their drive times are generation outputs rather than
hard-coded documentation values. The current values are available in
`MapData.validation.intercityDriveSeconds`, and generation rejects an invalid
or implausibly short intercity connection.

## Authoritative road-first pipeline

Final roads no longer come from a repeated road tile pattern, and the runtime
graph is never reconstructed from whichever tiles happen to be drivable.
`UrbanPlanner` owns the topology before final rasterization:

1. Create city, district and regional-terrain metadata.
2. Generate smooth divided corridors, independent one-way carriageways,
   interchanges, service loops, structures, furniture and scenery in
   `HighwayPlanner`.
3. Build variable-spaced, tile-aligned city axes around city bounds and highway
   attachment anchors.
4. Start with connected city road graphs. Remove a candidate local link only
   when both endpoint degrees remain valid and the city stays connected.
5. Add district-aware alley or access branches with intentional terminal
   metadata, plus bounded diagonal connectors.
6. Inject the already accepted highway graph; the urban planner cannot reshape it.
7. Derive intersection designs and exact disjoint block footprints from that
   accepted graph. Assign every block a land use, concrete program, density
   contract, landmark role and explicit purposeful-open-space flag.
8. Run topology quality checks. Failed topology is rejected before final road
   or building tiles are painted.
9. Clear the old seed raster's urban roads and buildings, restore protected
   geography, and rasterize the accepted roads, sidewalks, intersections and
   terminal areas.
10. Paint each exact block footprint's program surface, then compose
    zoning-aware frontage lots. A deterministic infill scan tries large
    frontage bars before small residual modules until net developable coverage
    reaches the block's density contract.
11. Regenerate unusable road/geography fragments as named pocket spaces and
    road-divided residual parcels as intentional courtyard/passage blocks.
12. Validate the completed urban fabric and highway system, then translate the accepted plan into
    the existing runtime road, traffic and navigation records.

District cells and the legacy base pass still provide deterministic geography
and tile alignment. They are not final road ownership. The only authoritative
road records are `MapData.urbanPlan.roads`.

## Road hierarchy and width

`halfWidth` is the asphalt brush radius on each side of a planned centreline.
The nominal cross-section below is `2 * halfWidth + 1` tiles; diagonal sampling
feathers corners while preserving the same reservation scale.

| Planning hierarchy        | Half-width | Nominal asphalt width | Existing runtime class                   |
| ------------------------- | ---------: | --------------------: | ---------------------------------------- |
| Highway carriageway       |    2 tiles |               5 tiles | one-way `highway`                        |
| Primary avenue            |    2 tiles |               5 tiles | `arterial`                               |
| Secondary road            |     1 tile |               3 tiles | `collector`                              |
| Residential street        |     1 tile |               3 tiles | `local` or district-appropriate `scenic` |
| Alley                     |    0 tiles |                1 tile | `local` or district-appropriate `scenic` |
| Parking/industrial access |    0 tiles |                1 tile | `service`                                |

Non-highway urban roads receive a sidewalk reservation outside the asphalt
brush. Road hierarchy also maps through the existing policy adapter to lane
count, speed limit, priority, surface, shoulder, lighting and access flags.
Highway carriageways explicitly request two independent one-way lanes. Ramps
and service frontage roads request one lane. Primary avenues retain the urban
taper rules. See `HIGHWAY_SYSTEM.md` for the motorway-only runtime policy.

## Continuity and intentional endings

Every planned segment owns two graph endpoints and becomes one runtime edge.
Neighbour lists are derived from those accepted edges and must be reciprocal.
A road may not disappear into a building, sidewalk or generic concrete tile.
The final audit samples every planned centreline and requires explicit asphalt
ownership along its full length.

Designed degree-one branches carry terminal metadata. Current district-aware
forms include:

- cul-de-sacs;
- parking areas;
- dead-end alleys with a hammerhead cap;
- industrial yards;
- residential courts;
- public squares and terminal roundabouts;
- harbor and airport entrances;
- checkpoints and highway ramps;
- forest trails and beach access.

A terminal on a multi-leg node is also invalid. If no valid branch attachment
can be created, the optional intervention is not committed. Block-regeneration
diagnostics are reserved for accepted parcels that actually require a new
purpose or courtyard treatment. An interrupted accepted road fails generation
instead of being silently omitted from the runtime graph.

## Intersections

Intersection records are derived from graph endpoints, never guessed from a
road tile neighborhood. The planner distinguishes cross and T junctions,
bends, terminals, offset and diagonal junctions, multi-lane junctions,
industrial and residential junctions, plazas and roundabouts.

Roundabout and plaza designs receive distinct raster treatments. Their
`design` is also attached to the matching runtime intersection record, while
signal, priority, yield and uncontrolled behavior continues to be selected by
the existing traffic-control pipeline. In particular, the visual roundabout
does not introduce a new circulating-lane AI system.

## Blocks and buildings

Buildable blocks are emitted only after road topology is finalized. Their
bounds account for road widths and sidewalk clearances. Variable axis spacing,
safe link removal, mixed treatments, branches and diagonals provide different
proportions and street relationships without giving buildings authority over
roads.

When a safe local link is removed, the elementary cells on both sides are
unioned before a block record is emitted. The resulting
`PlannedUrbanBlock.footprint` stores disjoint owned rectangles; `bounds` is only
the tight envelope used for composition and indexing. Validation rejects
self-overlapping/cross-block footprints and an open street seam represented as
two fictional enclosed blocks.

Each block first receives one zoning category and a concrete program: housing,
apartments, continuous retail, offices, financial uses, industry, education,
health, public service, hospitality, markets, parking, sports, plazas, parks,
harbor, airport or other infrastructure. Low building coverage is legal only
when `purposefulOpenSpace` explains it.

Building generation then selects program-aware archetypes, varied footprint
sizes, one- or multi-rectangle shapes, setbacks, floor counts, materials, roof
styles, facades and active ground-floor uses. A coverage-driven second pass
fills viable residual lots instead of stopping after a fixed candidate count.
Candidate footprints are checked against the road raster, sidewalks,
intersections, protected terrain and other buildings before being committed.
Entrances are subsequently derived from the real planned footprints rather
than a fixed-size lattice lot.

Concrete is a legal developable program surface when no graph-owned road,
sidewalk, runway or protected feature reserves it. Entrance routing normally
uses at most three tiles; an eight-step dogleg is limited to small residual
density gaps. Physical public-realm fixtures stay off those routes, while
non-solid path and parking/court markings may explain them visually.

The complete design layer is available in `MapData.urbanPlan` as roads,
intersections, blocks, buildings and an `UrbanQualityReport`.

## Runtime-system boundary

`WorldManager.buildRoadGraph()` directly adapts each planned segment:

- one endpoint position becomes one shared `RoadNode`;
- one planned segment becomes one `RoadEdge`;
- node neighbours come exclusively from finalized planned edges;
- planning hierarchy maps to the existing road classes and policy fields;
- planned intersection identity is carried separately from runtime control.

Pedestrian AI, navigation, emergency routing and gameplay systems continue
consuming their existing contracts. Traffic retains ordinary city behavior and
adds policy only while a driver occupies a highway carriageway.

## Validation

Validation runs in layers:

### Planner topology gate

- connected national road graph;
- required hierarchy levels present;
- segments long enough for the runtime lane builder;
- no unmodeled highway/local-road crossings;
- every degree-one node intentionally terminated;
- block-signature repetition below the planning threshold.

### Final urban-fabric gate

- every centreline remains explicit asphalt after rasterization;
- terminal metadata matches endpoint degree;
- no building overlaps a road reservation;
- exact block footprints are positive, internally disjoint and mutually exclusive;
- realistic footprint and floor bounds;
- bounded block and facade repetition;
- no equal-height adjacency inside the skyline proximity threshold;
- no oversized or unexplained empty urban blocks;
- every occupied block meets its net-developable density contract;
- purposeful programs for parks, courts, campuses, yards and infrastructure;
- no street ending at unexplained empty land;
- program and block-form diversity inside every district;
- landmark coverage throughout each district;
- at least 96% meaningfully urbanized blocks;
- zero unowned building tiles, footprint mismatches, inaccessible entrances,
  missing site content or city-style violations after interior carving;
- rejected or retried block interventions reported.

### Runtime graph gate

- exact planned-edge to runtime-edge correspondence;
- reciprocal node neighbours and valid endpoint references;
- connected physical, directed-traffic, navigation and emergency graphs;
- every city reachable;
- highway segment preservation;
- independent one-way carriageways and passed highway-quality report;
- valid intersections and pedestrian crossings;
- `urbanQualityPassed` set only when the planning and raster gates pass.

Generation stops before gameplay if any required gate fails.
`TrafficNetwork` then performs its existing directed lane and connector audit
against the generated runtime graph.

## Streaming

Terrain and architecture stream in `32 x 32` tile chunks. A one-chunk radius
keeps a `3 x 3` neighborhood active around the player, with richer props in the
nearest detail chunk. Each chunk retains its owning city, highway, forest,
coast, mountain, desert or farmland zone while sharing the same coordinates and
continuous road graph.

`ArchitectureComposer` resolves planned buildings through a tile-spatial index,
so a streamed chunk can render irregular footprints and shared building IDs
without scanning every building in the country or reverting to periodic lot
identity.

## Full-screen navigation overlay

`MapScene` presents the generated country as a paused, full-screen navigation
surface. The map content is geometry-masked to the visible viewport, so terrain,
routes and city labels never paint over the guide or top controls while panning
or zooming. Major hospitals and police stations remain screen-space POIs, while
mission, waypoint, player, service and public-transport layers preserve their
existing behavior.

Each `HousingSystem.officesForWorld` entry is rendered as a purple storefront
marker at the real-estate agent position. Hovering identifies the city office;
clicking sets a route to the agent and shows the number of available listings
for that city.

Every valid `HousingSystem.catalog` entry is also projected at its authored
`entranceWorldPosition`. Property markers stay a constant screen size and use
both icon detail and color to distinguish:

- amber tagged house: available for sale;
- cyan checked house: owned home;
- green haloed house: active home.

Hovering a property shows its name, status and price. Selecting it opens a
detail card with city, district, price or ownership state, parking, a feature
summary and distance from the player. A click sets the normal waypoint to the
property entrance; it does not mutate ownership or bypass the real-estate
office purchase flow. In taxi destination mode the same marker is treated as a
normal reachable destination candidate.

The grouped `MAP GUIDE` keeps navigation, property, and place/route semantics
separate, includes live counts for the three property states, and exposes the
pan, zoom, fit, locate and marker-route controls without relying on color alone.
`MapScene.debugPropertySnapshot()` provides a read-only browser-audit surface
with catalog count, visible marker count, status counts, hit radii, screen
positions, entrance positions, office counts and real-estate agent positions.

## Verification

The browser smoke harness exposes `MapData.validation`, urban quality status,
active chunk count and active region counts. A representative run is:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/browser-smoke.ps1 `
  -Url http://127.0.0.1:5173 -OpenMap -Screenshot seamless-world-map-final.png
```

The deterministic traffic suite remains available through:

```powershell
npm run validate:traffic
```

The architecture harness can frame the physical reserved landmark instead of
the separate discoverable map marker:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/browser-smoke.ps1 `
  -ArchitectureLandmark yazd-mosque -NoOverlay -Hour 8 -Zoom 1.0 `
  -Screenshot architecture-reserved-yazd-mosque.png
```

For deterministic seed `1337`, the final browser audit records 1,909 exact
blocks, 4,084 owned buildings, 3,744 purposeful spaces and a `0.999476`
meaningfully urbanized ratio. The roof-cutaway probe also verifies that opening
one enterable building never opens its neighbor and that both camera and player
state are restored afterward.
