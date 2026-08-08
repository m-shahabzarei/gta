# Pixel Art Direction

The game renders at a 1280×720 logical canvas with nearest-neighbour scaling,
32 px terrain modules and 32 px humanoid frames. Art must land on the native
pixel grid. Do not introduce vector assets, filtered textures, high-resolution
sprites or realistic rendering.

## Visual language

- Camera: top-down with a slight south-east material/shadow plane.
- Light direction: upper-left; cast shadows fall down and right.
- Shapes: readable silhouettes first, internal texture second.
- Contrast: darkest values are reserved for silhouettes, wheels, deep window
  glass and contact shadows. Surface noise stays below gameplay contrast.
- Texture: use clustered chips, repairs, seams and material patches. Avoid
  evenly distributed single-pixel noise and perfect repeated grids.
- Animation: preserve named character frames and rotate the full sprite for
  continuous turning. All effects remain pixel-grid raster textures.

## Architectural volume

Buildings are world objects, never finished terrain tiles. The solid building
tile families are neutral collision/foundation adapters; only a planned
building module may draw walls, a roof, entrances or rooftop equipment.

Each structure is composed in five pixel-locked planes:

1. foundation/contact edge on the ground plane;
2. stepped south-east cast shadow below vehicles and people;
3. south/east wall faces with entrances, windows and service openings;
4. roof/parapet above vehicles and people;
5. roof equipment and silhouette accents above the main roof.

These planes have strict ownership. Foundations may meet the terrain but must
not resemble miniature roofs. Shadows may cross safe ground because they are
non-colliding light shapes. Wall extrusion, roofs and roof assets belong to the
planned building and render above cars and characters; a closed building must
therefore hide any actor beneath its visual volume. Equipment is drawn after
the roof so HVAC, tanks, panels, vents, dishes and access structures remain
legible without becoming separate floating props.

Floor count is expressed through discrete wall depth, roof inset, corner
highlights and shadow steps. It does not skew the camera or introduce smooth
3D projection. Roofs must read as one coherent mass across an entire footprint;
per-tile miniature roofs, repeated facade stripes and photographic texture are
forbidden.

The collision silhouette is only the exact ground-contact footprint. South/east
wall projection, roof lift, parapets, overhangs and shadows may extend beyond
that silhouette visually, but they must never write collision into a road,
sidewalk or entrance apron. This separation creates perceived height without
changing the top-down camera or making cars collide with a shadow.

Enterable service buildings retain a closed exterior roof when viewed from
outside. Only the roof directly above the player opens while they are inside,
so indoor NPCs and furniture never appear to stand on an exterior roof.
Opening means hiding the complete roof shell for the active interior, not
making all roofs transparent. On exit it closes immediately, and adjacent
buildings remain fully roofed throughout the transition.

## City colour script

| City | Architecture | Ground and atmosphere | Key accents |
| --- | --- | --- | --- |
| Tehran | cool concrete, steel, blue glass, civic stone | charcoal asphalt, neutral paving, dry green parks | amber lamps, taxi yellow, restrained neon |
| Yazd | ochre adobe, courtyards, windcatchers, bazaar cloth | sun-bleached asphalt, warm sand, dusty stone | turquoise, carmine, saffron |
| Gilan | timber houses, red/green pitched roofs, moss | wet blue-gray asphalt, cool paving, dense green | leaf highlights, puddle blue, warm windows |

Massing reinforces the colour script:

- Tehran favours dense street walls, apartment slabs, podium towers, office
  crowns, broad civic compounds and commercial frontage.
- Yazd favours low adobe courtyard compounds, U/L forms, bazaars, arcades,
  domes, parapets and windcatchers.
- Gilan favours detached timber homes, villas, paired houses, strong pitched
  ridges, roof overhangs, gardens and vegetation between structures.

## City architecture profiles

| City | Primary materials | Massing and frontage | Roof/detail signature |
| --- | --- | --- | --- |
| Tehran | cool concrete, civic stone, steel and blue glass | dense apartment slabs, continuous shopfronts, podium towers, office crowns and broad government/sports compounds | flat and mechanical roofs, HVAC banks, water tanks, solar panels, helipads, billboards and restrained light bands |
| Yazd | ochre adobe, warm brick and stone with limited concrete | low courtyard, L/U and arcade forms; bazaars, workshops and inward-looking civic compounds | parapets, domes, minarets, windcatchers, water tanks, solar panels, vents and small roof access rooms |
| Gilan | timber, weathered brick, stone and muted concrete | detached or paired houses, villas, garden apartments, markets and broad waterfront/farm sheds | pitched or green roofs, strong ridges and overhangs, chimneys, vents, dishes, moss accents and small service equipment |

Semantic buildings must remain recognizable before labels are read. A mosque
needs its court and skyline modules; a stadium needs stands and field; a school
needs a yard; a hospital needs an approach and service roof; industrial sites
need broad sheds and loading logic. City colour alone is not enough to turn a
generic rectangle into a local building.

## Public-realm hierarchy

Open land is composed from most functional to least important:

1. entrance apron, gate and unobstructed access path;
2. circulation and safety space beside roads, sidewalks and crossings;
3. the site's primary use, such as parking bays, market lane, court, field,
   garden, playground, loading yard or plaza;
4. deliberate fixture clusters such as trees, planters, benches, lights, bins,
   signs, hydrants, bike racks and utility boxes;
5. low-contrast ambient wear such as cracks, leaves, dust and puddles.

The first three levels establish why the space exists. Decorative props must
support that reading and may not block doors, gates, parking access, pedestrian
routes or vehicle clearance. Avoid evenly spaced one-of-everything prop rows;
cluster detail around paths, edges and activity nodes while retaining quiet
negative space.

## Collision readability

The art must communicate the same occupancy used by simulation. Every exterior
footprint cell reads as solid wall/roof volume, and walkable gaps must be visible
as real entrances or open courtyards. NPCs and vehicles never gain permission
to enter a footprint because a wall face is visually offset from its contact
edge.

`InteriorDoor` is the one intentional body-size distinction: it is visually and
logically open to the player and pedestrians, while a hidden vehicle-only
collision layer keeps cars out. Door art should therefore read as a narrow
pedestrian opening, never as a garage-width vehicle route.

## Compatibility contract

- `TileType` values, solid/drivable classifications and world generation are
  authoritative for gameplay. Regional roof art is a visual overlay.
- Vehicle canvas dimensions and the `ok`/`damaged` frame names remain aligned
  to the existing physics catalogue.
- Humanoids retain the existing frame order (`idle`, `walk`, `run`, `aim`,
  `shoot`, `reload`, `death`) and 32×32 frame size.
- All generated textures keep the canonical `TextureKeys` used by consumers.

## Character roster

The civilian variants are authored identities rather than arbitrary recolours:
doctor, paramedic, construction worker, businessman, taxi driver, tourist,
student, mechanic, shopkeeper, elder, office worker, courier, heavy-set casual
pedestrian and bazaar vendor. The player uses a distinct teal jacket, gold scarf,
brown backpack, equipment belt and visible holster.
