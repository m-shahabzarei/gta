# Modular Architecture and Urban Planning

## Architectural source of truth

`MapData.urbanPlan.buildings` is the only legal source of exterior structures.
Each planned structure owns a semantic kind, size class, massing shape, exact
tile footprint, entrances and roof assets. The footprint is rasterized into the
building-family tile mask as a compatibility adapter for Arcade collision,
navigation, line of sight and traffic clearance; the visible building is then
composed from the same plan.

The invariant is bidirectional:

- every planned exterior footprint cell has exactly one owner and a matching
  solid or deliberately carved interior cell;
- every building-family collision tile has exactly one planned owner.

Raw `TileType.Building*` rectangles and inferred/periodic renderer lots are
forbidden. The building tileset frames contain neutral foundation art only and
cannot substitute for an architectural module.

```text
road/block plan
      |
program-aware block grammar
      |---- planned public realm and fixture anchors
      `---- planned buildings (shape, footprint, entrance, roof assets)
                         |
                         |-- occupancy raster -> physics / nav / sight
                         `-- layered composer -> shadow / walls / roof / equipment
```

The city pipeline is road-first. `UrbanPlanner` produces an authoritative road
graph and the blocks enclosed by it before any final road or building tile is
committed. `CityGenerator` then parcels those finalized blocks, and
`ArchitectureComposer` renders each planned building from its shared metadata.

The final city is therefore generated in this order:

1. Plan road topology.
2. Derive intersections and buildable blocks from that topology.
3. Assign zoning, programs, density contracts and landmark roles.
4. Validate the complete road-and-block plan.
5. Rasterize the accepted roads, sidewalks, junctions and terminals.
6. Paint program surfaces and fill validated lots to their density contracts.
7. Regenerate unusable fragments as purposeful pocket or courtyard space.
8. Audit the exterior road/building raster, parcels, facades and skyline.
9. Adapt the same road plan to the existing runtime traffic data.

Buildings never decide where a road goes and cannot replace an accepted road.

## Compatibility boundary

- Core gameplay and on-foot navigation behavior remain unchanged. Architecture
  adds only a narrow vehicle-only blocker at pedestrian-sized interior doors;
  traffic also retains its motorway policy on generated highway carriageways.
- The tile taxonomy remains authoritative for collision and movement.
- `RoadNode`, traffic lights and intersection-control records keep their
  existing schemas. `RoadEdge` now carries optional highway component,
  carriageway direction and three-lane capacity metadata.
- Each accepted `PlannedRoadSegment` becomes one runtime graph edge; runtime
  roads are not inferred from asphalt, concrete or other drivable tiles.
- Planner intersection designs are urban-design metadata. They do not add a
  new traffic simulation model; for example, a visual roundabout retains a
  graph shape compatible with the existing traffic system.
- Generation and rendering remain deterministic for a given seed.

District assignment still uses deterministic map cells, and candidate road
axes are tile-aligned. Those cells are a planning scaffold, not an
authoritative repeating road lattice. Axis spacing varies by city, safe links
may be omitted to merge the urban rhythm, and designed branches and diagonal
connectors add non-grid forms. Only the accepted planner graph owns final road
space.

## Shared urban plan

`MapData.urbanPlan` carries the design layer used by validation, rendering and
the runtime adapter:

| Record          | Purpose                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------- |
| `roads`         | Authoritative centrelines, hierarchy, width, city/highway ownership and optional terminal metadata |
| `intersections` | Junction position, connected road IDs and visual/planning design                                   |
| `blocks`        | Exact disjoint footprint, tight bounds, zoning, program, density, landmark/open-space role and form |
| `buildings`     | Footprint and complete architectural blueprint for every planned structure                         |
| `spaces`        | Purposeful residual-land footprints, access points and owned public-realm feature anchors          |
| `quality`       | Pre-runtime urban quality report and any generation issues                                         |

This shared representation prevents the renderer and validator from inventing
different interpretations of the same building or street.

## Footprint, raster and runtime collision

`composeBlockArchitecture()` proposes semantic lots. `WorldManager` converts an
accepted lot into a `PlannedBuilding`, and `commitBuilding()` is the only final
writer of `TileType.Building`, `TileType.BuildingRes` or
`TileType.BuildingInd`. It rasterizes the union of the footprint rectangles;
the renderer never infers architecture back from those tiles.

The complete ownership flow is:

```text
PlannedUrbanBlock + city/zone/program + seed
                    |
                    v
          PlannedBlockComposition
              |              |
              v              v
      PlannedBuilding   PlannedUrbanSpace
              |
              +-- commitBuilding() --> Building* ground-contact raster
              |                              |
              |                              +-- shared solid collision
              |                              +-- pedestrian navigation
              |                              +-- sight/projectile blocking
              |
              +-- ArchitectureComposer --> foundation / shadow / wall / roof / fixtures
              |
              `-- BuildingEntrance.buildingId --> service selection --> optional interior carve
```

The ownership audit runs after exterior rasterization and again after service
interiors are carved. It proves that every `Building*` cell has one plan owner,
that every planned footprint cell is represented by a building-family or owned
interior tile, and that each carved `InteriorFloor`, `InteriorWall` and
`InteriorDoor` remains associated through `BuildingInterior.buildingId`.
Browser smoke requires zero unowned building tiles, footprint mismatches and
inaccessible entrances in the final post-carve world.

Projected wall depth, parapets, roof lift and cast shadows are visual geometry.
They do not enlarge the ground-contact collision footprint. This keeps roads,
sidewalks and entrance aprons navigable while allowing a top-down building to
read as tall.

## Block-first parceling

Blocks are derived only after the road graph has been accepted. Variable axis
spacing produces short, long and rectangular proportions; omitted links,
designed branches, mixed treatments and diagonal connectors break the visual
cadence. A block that is too small is rejected before parceling.

Elementary cells separated by an intentionally omitted street are unioned into
one block before parceling. Every `PlannedUrbanBlock.footprint` is an exact set
of disjoint rectangles; `bounds` is only its tight composition/index envelope.
Irregular or road-divided parcels therefore cannot claim cells that belong to a
neighboring block. Planner audits reject invalid/self-overlapping footprints,
cross-block overlaps and absent roads represented as fictional boundaries.

Building candidates are selected by program and district, first in planned
frontage lots and then with deterministic coverage-driven infill. Infill tries
large road-facing bars before small residual modules. Normal entrance access is
bounded to three tiles; an eight-step dogleg is permitted only when closing a
small residual density gap in an already urbanized block. Placement respects
the exact block footprint and land-use-specific setbacks. A candidate is rejected
if any footprint part:

- leaves the map or its planned parcel;
- collides with another planned building;
- touches reserved roads, sidewalks, crossings or runways;
- overlaps water, rock, docks or existing interior tiles.

`TileType.Concrete` is a developable program surface unless an accepted road,
sidewalk, runway or other reservation owns it. It is never rejected merely
because the runtime taxonomy also treats concrete as drivable in other
contexts.

One or more rectangles describe each footprint. This supports varied
rectangles as well as L-shaped, U-shaped and courtyard-like forms without
reducing the building to a repeated square lot.

## Zoning and block grammar

The grammar consumes the finalized block's city, district, land use, program,
bounds, density target and deterministic seed. It chooses a site template,
frontage, setbacks, size, shape and semantic building kind before any occupancy
tile is written. Residential, commercial, industrial, government/civic,
recreation, park and suburban programs therefore produce different site plans
instead of drawing from one random rectangle pool.

Program families include housing and apartments; restaurant rows, markets,
shopping and financial centres; factories, warehouses and loading yards;
government, police, fire, hospital, school, university and mosque compounds;
sports halls and stadiums; parking, plazas, parks, playgrounds, gardens,
waterfront uses and rural/farm edges. The footprint vocabulary includes
rectangles, L/U/T forms, corners, courtyards, paired or connected masses,
podium-towers, arcades and shed clusters in small, medium, large and huge size
classes.

Road ownership always wins. Candidate fronts and entrances face exposed road
edges, setbacks reserve sidewalks and access aprons, and placement rejects any
overlap with accepted roads, crossings, runways, protected geography or another
building. A rejected lot becomes residual public realm or deterministic infill;
it cannot silently stamp a fallback building.

## Planned building blueprint

Every `PlannedBuilding` has a stable ID and block ID plus:

- city and district identity;
- inherited land use, program and landmark role;
- footprint rectangles and aggregate bounds;
- archetype and setback;
- floor count;
- glass, brick, concrete, stone, wood, steel or adobe material;
- flat, sloped, mechanical, green, solar, industrial, roof-garden, helipad,
  water-tanks or satellite roof treatment;
- a facade signature containing window, balcony, entrance and detail modules;
- residential, restaurant, coffee shop, market, bank, gym, clinic, bookstore,
  pharmacy, electronics, supermarket, office or parking ground-floor use;
- a complete repetition signature used by quality control.

Floor selection follows the district skyline: downtown can select towers and
tall commercial forms, residential districts use a middle range, luxury and
historic areas stay lower, and industrial districts favor broad low-rise
footprints. Nearby candidates are steered away from identical heights.

## Planned-building renderer

`ArchitectureComposer` builds an anchor-chunk index and an exact footprint-owner
index from `map.urbanPlan.buildings`. Each building is emitted once by the chunk
that owns its anchor, while exposed-edge and public-realm clipping queries use
the same footprint ownership.

For planned structures:

- geometry caching uses the planned building ID, and the union of its footprint
  rectangles determines exposed edges and roof modules;
- floor count controls shadow and facade depth;
- material selects roof and surface treatment;
- `roofStyle` selects the authored roof module instead of a random tile
  decoration;
- facade tokens select window spacing, balcony form, entrance form and details
  such as columns, awnings, canopies, corner glass, light bands and stone trim;
- `groundFloorUse` selects storefront, signage, glazing and entrance treatment;
- footprint-aware anchors place one coherent roof feature and frontage module
  even on L-shaped or U-shaped buildings.

The former periodic lot partition and unplanned-building compatibility fallback
have been removed. An unowned building tile is a generation error, not
renderable input.

## City identity

- **Tehran:** concrete, stone, steel and blue glass; high-rise financial lots,
  mixed-use commercial blocks, apartments, villas, civic campuses, terminals
  and industrial sheds. Required city-scale reservations materialize a
  financial tower, government compound and stadium as planned buildings. The
  financial tower is explicitly glass; the government building must have at
  least a seven-tile short axis and a U-shaped civic mass.
- **Yazd:** warm adobe, brick and stone; low courtyard compounds, bazaars,
  public buildings, windcatchers, workshops, water tanks and solar roofs. Its
  reserved mosque remains part of the civic block grammar and owns explicit
  adobe material, mosque-court records, and enlarged turquoise dome and
  projected minaret modules whose apparent height does not alter collision.
- **Gilan:** wood, brick and stone with pitched or green roofs; villas,
  apartments, resorts, farm buildings and waterfront work sheds, with more
  gardens and vegetation between structures.

These identities are inputs to the same modular grammar rather than separate
finite sprite catalogues.

## Public realm

`MapData.urbanPlan.spaces` is the visual source of truth for non-building block
land. Each `PlannedUrbanSpace` owns a semantic kind, residual footprint, access
points and `PlannedGroundFeature` anchors. `ArchitectureComposer` clips these
records to safe residual terrain and draws parking and loading bays, plazas,
courtyards, markets, parks and gardens, schoolyards and playgrounds, sports
fields and courts, service yards, waterfront treatments and farm uses.

Runtime reconciliation intersects proposed space footprints with the residual
cells left by accepted buildings, partitions any unclaimed connected regions,
recompresses them into disjoint rectangles and recalculates tight bounds.
Feature dimensions are retained when a legal placement exists, so courts,
paths, parking runs and similar modules are not collapsed into token points.

Planned features own paths, gates, fences and walls, trees and planters, street
lights, benches, bins, bike racks, utility boxes, signs, hydrants, mailboxes,
market stalls, parking/service markings and program-specific equipment. Bench
and bus-stop gameplay records are rendered at their exact interactive sites;
ambient cracks, leaves and puddles may remain decorative because they do not
claim architectural ownership or block access.

Entrance corridors distinguish physical fixtures from paint-only ground
language. Walls, fences, trees, benches and other physical modules remain off
the corridor, while paths, court lines, parking/service markings and similar
non-solid graphics may cross it. Tiny residual spaces receive a deterministic
path marker rather than becoming unprogrammed concrete.

## Rendering and depth ownership

`ArchitectureComposer` owns five logical pixel-art planes derived from the same
building plan:

1. foundation/contact treatment at `GroundDetail`, below actors;
2. stepped south-east cast shadow at `Shadows`, below vehicles and actors;
3. extruded south/east walls and facade detail at `BuildingsLow`, above actors;
4. the coherent roof shell and parapet at `BuildingsHigh`, above actors;
5. roof assets and silhouette accents, painted after the roof on its high plane.

Cars and characters can pass through a projected shadow, but a closed roof and
its wall extrusion visually occlude them. This is deliberate painter's-order
occlusion, not additional physics geometry. A building crossing a streaming
boundary is emitted only by its anchor chunk, and all of its graphics are
destroyed with that chunk so shadows and roof edges are not double-painted.

## Enterable roofs

Exterior rendering remains plan-driven after an interior replaces some of the
underlying collision tiles. `ArchitectureComposer` maps each
`BuildingInterior.buildingId` back to its planned building and registers a
dedicated roof graphics object under the interior ID. Outside, all such roofs
are visible. `WorldInteriorSystem` evaluates `interiorAt(playerPosition)` every
update and passes only that ID to `WorldManager.setInteriorRoofOpen()`; the
matching streamed roof is hidden, then restored immediately when the player
leaves. Neighboring roofs remain closed.

The browser harness performs a dedicated ownership cycle on the closest two
distinct enterable buildings: both roofs start closed, only the selected roof
opens, its neighbor remains visible, and the selected roof is restored on exit.
The probe also verifies that its temporary player and camera positions are
restored before the requested capture.

## Pedestrian and vehicle collision semantics

Exterior footprint cells use the building-family tile set and are solid to the
player, NPCs, vehicles, bullets and sight. Carved `InteriorWall` cells remain
solid. `InteriorFloor` is walkable, and `InteriorDoor` is deliberately omitted
from both `SOLID_TILE_TYPES` and `PEDESTRIAN_BLOCKED_TILE_TYPES`, allowing the
player and on-foot NPCs to cross the entrance.

An `InteriorDoor` is too narrow for a vehicle. Each streamed chunk therefore
creates a hidden door-only collision layer using
`VEHICLE_ONLY_SOLID_TILE_TYPES = [TileType.InteriorDoor]`. `GameScene` attaches
that layer only to the vehicle physics group; pedestrians, police, city-life
actors and the player continue to use the shared collision layer. The layer is
created and destroyed with its chunk.

Interior ambient actors use validated seeds as well as ordinary collision.
Police-compound and dealership NPC seed points keep their complete jitter
envelope clear of solid tiles, preventing a nominally valid center point from
occasionally spawning an actor inside a wall.

## Quality gates

Urban quality is checked before runtime systems consume the map. The audits
cover:

- graph connectivity and hierarchy presence;
- minimum routable segment length and modeled highway crossings;
- intentional degree-one terminals;
- explicit asphalt along every accepted centreline;
- road-reservation and building-footprint overlap;
- invalid/self-overlapping or cross-block-overlapping exact block footprints;
- block and facade signature repetition;
- footprint and height proportions;
- excessive equal-height adjacency;
- oversized, vacant or unprogrammed urban blocks;
- blocks below their net-developable coverage contract;
- meaningless road endings or streets leading to empty land;
- repetitive district programs/forms and landmark coverage gaps;
- the aggregate meaningfully urbanized-block ratio;
- exact correspondence between planned roads and runtime graph edges.

Generation stops with reported issues if an accepted road is interrupted or
the final urban plan fails validation. Invalid candidate branches and parcels
are never committed as unfinished streets or overlapping buildings.

## Validation commands

Run the static, architecture and regression gates from the project root:

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

Capture the three city profiles under matching camera and lighting conditions:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/browser-smoke.ps1 -City tehran -NoOverlay -Hour 8 -Zoom 1.0 -Screenshot architecture-rework-tehran.png
powershell -ExecutionPolicy Bypass -File scripts/browser-smoke.ps1 -City yazd -NoOverlay -Hour 8 -Zoom 1.0 -Screenshot architecture-rework-yazd.png
powershell -ExecutionPolicy Bypass -File scripts/browser-smoke.ps1 -City gilan -NoOverlay -Hour 8 -Zoom 1.0 -Screenshot architecture-rework-gilan.png
```

Capture the exact reserved building rather than its world-map marker:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/browser-smoke.ps1 -ArchitectureLandmark tehran-tower -NoOverlay -Hour 8 -Zoom 1.0 -Screenshot architecture-reserved-tehran-tower.png
powershell -ExecutionPolicy Bypass -File scripts/browser-smoke.ps1 -ArchitectureLandmark tehran-government -NoOverlay -Hour 8 -Zoom 1.0 -Screenshot architecture-reserved-tehran-government.png
powershell -ExecutionPolicy Bypass -File scripts/browser-smoke.ps1 -ArchitectureLandmark tehran-stadium -NoOverlay -Hour 8 -Zoom 1.0 -Screenshot architecture-reserved-tehran-stadium.png
powershell -ExecutionPolicy Bypass -File scripts/browser-smoke.ps1 -ArchitectureLandmark yazd-mosque -NoOverlay -Hour 8 -Zoom 1.0 -Screenshot architecture-reserved-yazd-mosque.png
```

The browser smoke gate checks urban ownership/access counters, city-style
constraints, non-empty space records, shape/size/kind distribution, required
landmarks, roof assets and entrances in addition to traffic/highway health.
For seed `1337`, the final browser audit records 1,909 exact blocks, 4,084 owned
buildings, 3,744 purposeful spaces, a `0.999476` meaningfully urbanized ratio,
and zero density, ownership, access, road/building, site-content, dead-end,
skyline or city-style failures.
