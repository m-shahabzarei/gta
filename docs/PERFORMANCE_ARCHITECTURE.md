# Performance Architecture

## Scope

This refactor changes engine scheduling, streaming, allocation, pathfinding, culling, and telemetry. It does not add gameplay features or intentionally change near-player gameplay behavior.

## Audit Baseline

Chromium was profiled for eight seconds in the active game before the refactor.

| Metric          | Baseline | Representative optimized run |
| --------------- | -------: | ---------------------------: |
| FPS             |    12.32 |                        60.00 |
| Frame time      | 81.16 ms |                     16.67 ms |
| Logic CPU       | 73.22 ms |                      4.40 ms |
| Render CPU      |  7.29 ms |                      8.14 ms |
| GPU             |  1.59 ms |          Extension-dependent |
| Draw calls      |     17.5 |                           15 |
| JavaScript heap |  96.8 MB |                     40-70 MB |
| Scene objects   |      892 |         Population-dependent |
| Physics bodies  |      288 |                           50 |
| Loaded chunks   |        9 |                            9 |
| NPCs            |      166 |                          104 |
| Vehicles        |       90 |                           83 |

The dominant baseline cost was `VehicleSystem`: 58.1 ms per frame on average and 147.6 ms maximum. Ambient traffic requested 1,030 A* routes in eight seconds on a 7,116-lane graph. A route search averaged 6.06 ms.

Secondary costs were duplicated LOD loops, whole-population scans, per-frame collection allocation and sorting, uncached pedestrian navigation, repeated actor/effect construction, and synchronous chunk replacement.

## Runtime Architecture

### Entity scheduling

`EntityManager` is the only per-entity update owner. Player, NPC, vehicle, projectile, and ambient actors register once and receive centrally scheduled component updates.

| Tier     | Cadence         | AI quality         | Physics               |
| -------- | --------------- | ------------------ | --------------------- |
| Near     | Every frame     | Full               | Enabled when eligible |
| Medium   | Every 3 frames  | Movement only      | Distance-gated        |
| Far      | Every 10 frames | Simple/coarse      | Disabled              |
| Very far | Once per second | Frozen/lightweight | Disabled              |
| Dormant  | No update       | Frozen             | Disabled              |

The scheduler queries the dynamic spatial hash around the streaming window. Dormant world population is not scanned every frame. It revisits only the spatial candidates and records that were active on the previous frame.

### Broad phase and rendering

- Dynamic actors use `SpatialHashGrid` for traffic avoidance, pedestrian separation, combat radius queries, interactions, and event pairing.
- Static chunks and decorations use `QuadTree` for camera-window rejection.
- Phaser Arcade Physics retains its broad-phase tree for enabled bodies.
- Camera frustum, category render distance, simulation distance, and physics distance are independent.
- Phaser WebGL automatically batches sprites; generated tilesets and sprite sheets already act as atlases.

### Traffic and navigation

- `TrafficUpdateScheduler` owns a fixed 3.5 ms traffic budget per 50 ms simulation step. Near traffic is first priority; medium and far groups are deterministic and due work is deferred when the budget is exhausted.
- Long uncached road searches are expansion-capped and return legal partial paths. A driver resumes planning from the terminal lane, turning an inter-city route into bounded strategic slices rather than one long A* stall.
- Traffic uses hierarchical work: strategic routes are event-driven/rate-limited, lane navigation is periodic, local steering is limited to near/medium traffic, and visual interpolation is the only frame-rate layer.
- `TrafficPerceptionIndex` maintains a traffic spatial hash plus lane buckets each simulation step. Vehicle perception is a bounded neighbour search rather than a complete-population scan.
- Materialized vehicles become no-entity virtual lane records outside the simulation ring and rematerialize from their lane pose before becoming visible.
- Ambient and service traffic route over immutable directed lane splines with a shared 4,096-entry LRU route cache.
- Perception uses persistent per-step agent snapshots, bounded predicted paths, and the entity spatial index for non-traffic obstacles.
- Pedestrian navigation uses a 512-entry shared tile-route cache.
- Path requests are priority queued and time-budgeted.
- A dedicated module worker runs pedestrian A* when supported; the synchronous implementation remains as a bounded fallback.
- Traffic and pedestrians receive one spawn-time intent seed so medium-tier movement never starts stationary.

### Streaming and lifetime

- The world retains a 3x3 terrain window with only the center chunk at full decoration detail.
- At most two tilemap operations run per frame during a stream transition.
- Incoming chunks are built before stale chunks are removed, preserving collision coverage.
- Collider recreation is batched after chunk operations.
- Entity directors retire actors outside their population radius; the central scheduler disables updates, rendering, and physics before retirement.
- `ResourceManager` exposes retain/release and unreferenced-cache eviction for streamed external resources.

### Allocation policy

- Projectiles use a preallocated wrapper/sprite pool.
- Civilian NPCs retain and reset their component graphs in a bounded scene-local pool.
- Vehicles pool by vehicle kind and behavior class so incompatible AI state cannot leak across reuse.
- The shared effect image pool handles blood, smoke, fire, explosions, shell casings, muzzle flashes, sparks, skid marks, and weather splashes.
- Every transient effect has an independent lease deadline in addition to its tween callback.
- Phaser particle emitters reuse their internal particle allocations.

## Developer Profiler

Press `F3` in the active game. The overlay reports:

- FPS, frame time, full update CPU, render CPU, and GPU time when timer queries are supported
- JavaScript heap, WebGL draw calls, chunks, entities, physics bodies, particles, and audio channels
- Loaded/active/sleeping NPC and vehicle counts
- AI, traffic, physics, rendering, streaming, pathfinding, animation, and audio time
- Navigation queue/cache size and worker state

The same data is available to automated tooling through `globalThis.__engineProfiler()`.

Press `F7` for the traffic-specific profiler. It exposes traffic/navigation/steering/collision CPU, materialized and virtual vehicle counts, average AI update rate, scheduler load, deferred updates, and frame time alongside the existing route/reservation diagnostics.

## Acceptance Results

- `npm run typecheck`: pass
- `npm run lint`: pass
- `npm run build`: pass, including the separate navigation-worker bundle
- Runtime console/page errors: none
- Ambient traffic: 54/65 moving, 210 px/s average after spawn
- Forced chunk transitions: 17.2 ms maximum frame, 59.98 minimum smoothed FPS, 1.15 ms maximum streaming sample
- 36-region memory cycle: +0.67 MB after forced garbage collection
- Logical population stress: 10,104 NPC records and 1,083 vehicle records at 59.99 FPS; 16.59 ms average frame, 16.8 ms p95, 18 ms maximum

The population stress intentionally keeps distant records dormant. Rendering or physically simulating all 11,000 actors at once is outside the streaming contract; only the nearby density is fully simulated.
