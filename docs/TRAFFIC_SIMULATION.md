# Traffic Simulation Architecture

## Ownership

`TrafficSystem` is the only simulation clock and lifecycle owner for autonomous road vehicles. `TrafficAIComponent` and `PursuitAIComponent` are compatibility boundaries that register destination providers; they do not steer or integrate movement.

The runtime is split into eight responsibilities:

- `TrafficNetwork`: immutable road segments, lane splines, typed junctions, legal connectors, conflict sets, and parking spaces.
- `TrafficDriver`: destination, route, intention, finite state machine, longitudinal dynamics, perception, lane changes, and recovery.
- `TrafficUpdateScheduler`: fixed CPU budget, deterministic update groups, distance tiers, and layer cadence.
- `TrafficPerceptionIndex`: traffic-only spatial hash and lane buckets for bounded neighbour queries.
- `IntersectionReservationController`: per-junction queues, signal/priority rules, downstream-capacity checks, and spatial reservations.
- `ParkedVehicleManager`: legal curb-space ownership and parked-vehicle streaming.
- `TrafficValidator`: runtime invariant monitoring.
- `TrafficDebugOverlay`: developer-only F7 telemetry and predicted-path rendering.

`VehicleMovementComponent` remains the player vehicle integrator. Autonomous traffic gives it an authoritative interpolated pose, so entity update cadence and Arcade Physics cannot produce a second, competing traffic motion model.

## Road Model

World generation supplies a compact road-node authoring graph. `TrafficNetwork` expands it once into:

- physical bidirectional road segments;
- directed travel lanes with width, speed limit, direction, entry/exit nodes, permissions, and priority;
- cubic Bezier connector lanes for straight, left, right, and legal dead-end U-turn movements;
- typed intersection, turn, merge, exit, and roundabout-capable nodes;
- connector conflict sets used by reservations;
- legal curb parking spaces kept outside travel lanes and intersection clearances.

Runtime driving never queries a tile to choose direction. Tile queries are safety assertions only: predicted spline samples are checked for temporary world geometry changes.

## Time-Sliced Simulation

Traffic uses a deterministic 50 ms fixed step with render interpolation. `TrafficUpdateScheduler` owns the work budget for every fixed step and defers due low-priority work instead of allowing a long traffic frame.

| Distance tier | Cadence   | Simulation work                                                                                          |
| ------------- | --------- | -------------------------------------------------------------------------------------------------------- |
| Near          | 20 Hz     | Full route-aware perception, local steering, intersection reservations, and smooth visual interpolation. |
| Medium        | 10 Hz     | The same full decisions at a lower cadence; interpolation preserves visual smoothness.                   |
| Far           | 4 Hz      | Lane following, lane-local lead vehicle search, and intersection approach handling.                      |
| Virtual       | No entity | Lightweight directed-lane record; no sprite, body, components, or local avoidance.                       |

The layers are independent:

1. Strategic destination and route refresh runs on destination/replan events and at a bounded safety cadence. Long graph searches yield legal partial routes and continue from their terminal lane instead of monopolizing a frame.
2. Lane navigation owns legal transitions, lane changes, destination approach, and intersection requests.
3. Local steering and high-precision prediction run only for near and medium traffic.
4. Visual interpolation is the only per-frame traffic operation, and skips culled sprites.

Each fixed step builds one persistent traffic spatial index. Drivers stream nearby candidates and lane-local followers from that index, so collision prediction is bounded by local density rather than total city population. Only vehicles inside the intersection approach distance submit reservation requests.

Drivers cannot enter a connector without a reservation. A request is ineligible until its outgoing lane has enough space to clear the intersection.

## Streaming

Materialized vehicles become virtual lane records outside the simulation ring. A virtual record continues on the directed network at low cost, retires outside the virtual range, and materializes from its exact lane distance before it can enter the visible ring. Vehicle pooling handles the sprite/body lifecycle, so this handoff does not create an active entity outside the streaming range.

## Driver Contract

Every active driver has one destination, one intention, one route, and exactly one state:

`Spawning`, `Finding Lane`, `Following Lane`, `Preparing Turn`, `Turning`, `Changing Lane`, `Stopping`, `Waiting`, `Yielding`, `Avoiding Obstacle`, `Reversing`, `Recovering`, `Parking`, or `Despawning`.

Profiles tune preferred speed, variation, acceleration, comfortable/emergency braking, reaction time, minimum gap, time headway, lane-change desire, overtaking bias, politeness, risk, and intersection priority. Supported profiles are careful, normal, aggressive, taxi, bus, truck, police, and ambulance.

Recovery escalates through wait, safe reverse, legal lane change, route recalculation, raised intersection priority, and finally safe despawn. A recovery timer makes permanent recovery states invalid.

## Extension Points

- Use `TrafficSystem.spawnServiceVehicle` for any new autonomous vehicle. Direct arbitrary-heading spawns are not allowed.
- Use `registerTemporaryObstacle` and `removeTemporaryObstacle` for construction, incidents, closures, or scripted hazards.
- Add authored roundabout metadata at the world road-node boundary; the lane and reservation types already support roundabout connectors and priority.
- Add new profiles in `TrafficPersonality.ts`; do not branch on vehicle kind inside driver decisions.

## Validation

Run `npm run validate:traffic`. The deterministic suite simulates ten minutes and fails on wrong direction, lane departure, invalid spawn orientation, conflicting reservations, missing downstream capacity, intersection blocking, unexplained stops, or recovery timeout.

In a development build, press F7 for live state, lane, target lane, destination, speeds, steering, lane/heading error, predicted path, collision prediction, recovery, queue/reservation, and validation status. The overlay also reports traffic CPU, navigation CPU, steering CPU, collision CPU, simulated/virtual counts, average AI update frequency, scheduler load/deferred work, and frame time.
