# Clean Six-Lane Highway System

## Design contract

The national network is intentionally a wide version of the city road system.
Every route has exactly:

- Direction A: three equal 24 px lanes;
- one 10 px outer shoulder and one 10 px median-side shoulder;
- one continuous 18 px concrete median;
- Direction B: the same three lanes and shoulders in reverse order;
- one continuous metal guard rail on each physical outside edge.

Each carriageway is 92 px wide. Its centre is 55 px from the route centreline,
so both directions remain perfectly symmetric and the opposing pavements never
overlap. There are no route-specific median variants and no random lane-width
changes.

## Backbone-first generation

`HighwayPlanner` runs before `UrbanPlanner`. It publishes the accepted highway
graph first; the city planner consumes its terminal anchors and reserves blocks,
buildings and streets around that graph. A city can attach to a highway but
cannot move, narrow or delete one.

The route grammar contains only long horizontal/vertical legs joined by sampled
large-radius 90-degree bends. It does not generate an arbitrary diagonal
centreline. The planner shortens both cardinal legs by at least ten tiles and
inserts a dense quadratic quarter bend, then derives the median, both
carriageways, road edges, markings and rails from the same tangent/normal field.
This keeps every visible edge continuous without square-tile stair steps.

The three deterministic corridors remain National 1 / Alborz, National 7 /
Central Desert and National 22 / Caspian Eastern. Regional character changes
only verge and scenery colors; it never changes road geometry.

## City connections

The old template interchange system has been deleted. The only legal connection
kinds are:

- `t-junction`;
- `cross`;
- `priority-cross`.

Both carriageways meet one normal primary-city-road graph node. A small flat
asphalt intersection deck covers the visual carriageway offsets, terminates the
median and outside rails, and adds restrained stop lines. The urban road remains
the crossing street. There are no transition ramps, collectors, gores,
circulating lanes, roundabouts, loops, flyovers or elevation layers.

The runtime world validator rejects a junction unless it owns both carriageway
terminals, a primary city road, no lower-order direct connection and no forbidden
ramp/interchange records.

## Rest areas and entry/exit lanes

Rest areas are optional one-way branches on the physical outside of one
carriageway. Each branch is a long parallel lay-by with:

1. one shallow deceleration connector;
2. one straight single-lane service frontage;
3. one shallow acceleration connector.

The access road never crosses the median and never forms a loop. Guard-rail
rendering and collision use the same branch endpoints to create exact entry and
exit openings.

Every one of the 17 generated rest areas contains fuel markings, car parking,
truck parking, an open rest area, EV charging and picnic space. Until a service
structure is emitted through the city architecture pipeline as an owned
`PlannedBuilding`, the highway system does not advertise or paint motels,
shops, restaurants, toilets, repair buildings or canopies. The highway painter
therefore owns only ground-safe parking rows, low pump/charger islands,
furniture and vegetation, without overwriting road asphalt or inventing a fake
roof silhouette.

The 153 authored parking bays are registered with `TrafficNetwork` and attached
to the nearest service lane. Visitor points are added to the pedestrian spawn
index, so parked vehicles and pedestrians stream through the existing pooled
population systems rather than becoming permanent map objects.

## Dedicated procedural tileset

`HighwayTileset.ts` is the single immutable visual vocabulary. It defines the
fixed cross-section, asphalt, shoulder, markings, median, rail, grass transition,
curve, intersection, merge, exit, service-area and bridge primitives.

`HighwayCanvasPainter` uses a deliberately restrained layer order:

1. regional verge and grass transition;
2. edge shadow and shoulders;
3. asphalt;
4. concrete median;
5. solid outer lines and two dashed separators per direction;
6. outside-only guard rails and posts;
7. service branches and flat city intersection decks;
8. sparse signs, rest-area art and regional scenery.

Lane-dash phase comes from full route arc distance, so it does not restart at a
chunk boundary. Every edge, shoulder, marking, median and rail is offset from the
same spline samples. Curves use rounded sampled joins; terminal and intersection
paint uses flat caps. The renderer contains no elevated-ramp ordering,
roundabout islands, gore hatching, random median selection, emergency-lane
decoration or dense crack/oil/debris clutter.

## Traffic policy

Highway graph edges preserve all three lanes and their one-way direction.
`TrafficNetwork` creates independent lane splines at stable offsets and
classifies the outermost lane separately from the two inner/passing lanes.

Drivers:

- cruise with highway headway on `carriageway` components;
- pass one lane to the left only after front/rear gap checks;
- return progressively to the rightmost available lane after clearing traffic;
- commit to the service exit without stopping on the mainline;
- yield while entering through the acceleration connector;
- never use reverse recovery on any highway-owned component;
- spawn from a cached lane pose with forward clearance and overlap checks.

Vehicle impacts do not change that authority. The shared `VehicleCollisionRuntime`
temporarily adds external velocity, lateral motion and bounded yaw to a highway
vehicle, while `TrafficDriver` preserves the directed lane, route destination and
intersection state. Rejoining is gradual and world-validated; if the displaced
vehicle cannot safely return to its lane, the existing legal lane-change/replan
recovery path is used. Timeout escalation is one-shot, so protected service
vehicles continue bounded offset decay instead of re-entering a despawn loop.
The highway reverse-recovery prohibition remains active
through every impact state.

The at-grade city node uses the same reservation and priority system as a normal
city intersection. No special interchange behavior remains.

## Streaming and performance architecture

`HighwayGeometryIndex` preprocesses routes once and buckets only intersecting
geometry into 32x32-tile chunk keys. Corridor ownership is an O(1) tile mask;
navigation and lane splines are cached; no route scan or path rebuild runs every
frame.

Only a 3x3 player neighborhood is resident. One chunk operation is permitted per
frame under a 4 ms scheduling budget. Static highway art is rasterized into one
canvas texture per resident chunk, enlarged with nearest-neighbor sampling and
cached in a bounded 18-entry LRU. The raster atlas uses 0.4 native scale. Each
visible highway chunk is one draw call; markings, rails, signs and scenery never
become separate Phaser objects.

Near/medium art levels are streamed independently of the tilemap. Traffic and
NPCs retain the existing near/medium/far/dormant simulation tiers, physics sleep,
sprite culling and pooling. Guard rails use one sparse hidden tile mask with
openings at service connectors; all other highway decoration has no collider.
Full vehicle-pair narrow phase is limited to near/medium bodies through a bounded
uniform-grid broadphase. Active impact recovery remains alive until energy settles
so traffic cannot freeze when the player drives away.

## Rejection gates

Generation and world startup reject:

- anything other than two directions and three equal lanes per direction;
- any non-concrete or discontinuous median;
- asymmetric carriageway spacing or opposing pavement overlap;
- abrupt curve headings, broken edge samples, rails or dash phase;
- complex city transition paths, gores, loops, flyovers or overpass structures;
- a city junction that misses the primary street or either carriageway;
- incomplete or reversing rest-area access;
- missing core rest-area facilities, parking or visitor sites;
- a highway edge shorter than the runtime lane minimum;
- disconnected physical, traffic, navigation, emergency or city graphs;
- generated travel lanes with no legal exit.

## Verification evidence

Automated results for the redesigned system:

- `npm run validate:highways`: 25,926 deterministic assertions; 3 routes, 6
  three-lane carriageways, 6 simple city junctions, 17 rest areas, 0 city ramps,
  0 gores and 0 flyovers.
- `npm run validate:traffic`: 481,568 assertions over 96,000 agent steps (ten
  simulated minutes), including three-lane ordering, service exit/merge policy,
  lane containment, direction, spawn clearance, conflicts and recovery.
- Browser world audit: 2,828/2,828 connected road nodes, 4,853/4,853 connected
  edges, all three cities mutually reachable, no generated lane dead ends and
  runtime traffic validation passing.
- `npm run typecheck`, `npm run lint` and `npm run build`: pass.

GPU-enabled 1280x720 Chrome profiling (`highway-performance-redesign-final.json`):

| Scenario | FPS | Average frame | P95 | Highway build peak | Draw calls |
| --- | ---: | ---: | ---: | ---: | ---: |
| Alborz settled | 60.0 | 16.66 ms | 16.90 ms | 6.90 ms | 9 |
| Alborz driven chunk crossing | 60.0 | 16.66 ms | 17.00 ms | 6.90 ms | 9 |
| Desert settled | 60.0 | 16.67 ms | 16.80 ms | 6.90 ms | 9 |
| Caspian settled | 60.0 | 16.66 ms | 17.00 ms | 6.90 ms | 9 |

Normal driven crossing produced no frame over 33 ms. Full-map debug teleports
can still expose a browser/GC pause because they invalidate all nine resident
terrain chunks at once; the highway raster portion remained bounded at 6.9 ms
and normal driving remained at the 60 FPS target.

Representative inspected captures:

- `highway-redesign-alborz-midpoint.png`: six-lane large-radius bend;
- `highway-redesign-city-junction-final.png`: at-grade city T/cross connection;
- `highway-redesign-desert-service-final.png`: parallel service lay-by;
- `highway-redesign-perf-final-national-1-alborz.png`: final 0.4-scale tileset.
