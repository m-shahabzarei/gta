# Public Transportation System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a road-network-driven, city-specific bus and taxi service that players and pedestrians can use without teleportation or duplicate navigation systems.

**Architecture:** `TransportationSystem` will be a scene-bound gameplay system that consumes `WorldManager` stop/landmark data and `TrafficSystem`'s existing directed lane graph. Bus loops, taxis, passengers, interaction state, fares, map data, and lightweight persistence remain data-driven; vehicles continue to be owned by `VehicleSystem`, driven by `TrafficSystem`, and seated through `VehicleOccupantSystem`.

**Tech Stack:** TypeScript, Phaser 3, existing `TrafficNetwork` A*, Arcade Physics, existing `NavigationSystem`, existing event bus and save providers.

## Global Constraints

- Buses and taxis must use the existing directed traffic-lane network; no point-to-point movement or vehicle teleportation.
- Every transit vehicle is a normal `VehicleSystem` entity and an existing `TrafficSystem` driver.
- Stop placement must be curb-side, sidewalk-accessible, clear of intersections, lane-backed, and physically collidable.
- Tehran must expose four distinct configured lines; Yazd and Gilan need smaller, distinct networks and fare/taxi populations.
- Passenger and taxi transitions must use existing seat/door animation states and the player economy must charge a confirmed fare exactly once.
- Maintain existing traffic LOD, routing cache, intersection reservation, recovery, physics, and police behavior.

---

### Task 1: Authoritative Transit Stops

**Files:**
- Modify: `src/gameplay/types/WorldTypes.ts`
- Modify: `src/gameplay/types/Services.ts`
- Modify: `src/systems/WorldManager.ts`
- Test: `scripts/transit-validation.ts`

**Interfaces:**
- Produces `BusStopSite` records with `id`, `cityId`, directed outer `laneId`, approach point, platform/wait positions, and bounded waiting capacity.
- Produces `IWorldQuery.busStopWaitingPosition(stop, entityId)` for pedestrian placement.

- [ ] **Step 1: Write failing transit-stop assertions**

```ts
check(stop.cityId === 'tehran' || stop.cityId === 'yazd' || stop.cityId === 'gilan');
check(stop.waitingPositions.length === stop.capacity);
check(stop.laneDistance > 80 && stop.laneDistance < stop.laneLength - 80);
```

- [ ] **Step 2: Run the validation to verify it fails**

Run: `npm run validate:transit`
Expected: FAIL because lane-backed transit-stop fields do not exist.

- [ ] **Step 3: Generate stops from verified road edges**

```ts
const laneId = `lane:${fromNodeId}>${toNodeId}:${outerLaneIndex}`;
const approach = pointOnDirectedOuterLane(from, to, outerLaneIndex, laneDistance);
const platform = findAdjacentSidewalk(tiles, approach, heading);
if (platform && clearOfJunctions(approach, from, to)) stops.push(stop);
```

- [ ] **Step 4: Update waiting claims and world fixtures**

```ts
public claimBusStop(stop: BusStopSite, entityId: number): boolean {
  if (stop.waitingEntityIds.includes(entityId) || stop.waitingEntityIds.length >= stop.capacity) return false;
  stop.waitingEntityIds.push(entityId);
  return true;
}
```

- [ ] **Step 5: Run validation and world generation checks**

Run: `npm run validate:transit && npm run validate:traffic`
Expected: PASS with no stop on an inaccessible sidewalk, intersection, or non-road lane.

### Task 2: Transit Data and Shared Road Queries

**Files:**
- Create: `src/gameplay/transit/TransitTypes.ts`
- Create: `src/gameplay/transit/TransitConfig.ts`
- Create: `src/gameplay/transit/index.ts`
- Modify: `src/systems/TrafficSystem.ts`
- Test: `scripts/transit-validation.ts`

**Interfaces:**
- Produces `CITY_TRANSIT_CONFIG` with route anchors, stop duration, capacities, taxi density, service area, and fare terms by city.
- Produces `TrafficSystem.roadNetwork` and `TrafficSystem.routePreview(from, to)` using cached lane routes.

- [ ] **Step 1: Write config/fare tests**

```ts
check(config.tehran.busRoutes.length === 4);
check(calculateTaxiFare(config.tehran.taxi, 3.2).total > config.tehran.taxi.baseFare);
```

- [ ] **Step 2: Add city-specific data**

```ts
tehran: { busRoutes: [T1, T2, T3, T4], taxi: { population: 9, baseFare: 20, perKm: 11 } },
yazd: { busRoutes: [Y1, Y2], taxi: { population: 3, baseFare: 14, perKm: 8 } },
gilan: { busRoutes: [G1, G2], taxi: { population: 4, baseFare: 16, perKm: 9 } },
```

- [ ] **Step 3: Expose only read-only traffic route queries**

```ts
public routePreview(from: Vector2, to: Vector2): TrafficRoutePreview | null {
  const start = this.network?.nearestLane(from, undefined, true);
  const goal = this.network?.nearestLane(to, undefined, true);
  const lanes = start && goal ? this.network?.findRoute(start.id, goal.id) : null;
  return lanes ? summarizeRoute(lanes, from, to) : null;
}
```

- [ ] **Step 4: Run config and route tests**

Run: `npm run validate:transit`
Expected: PASS; every configured route resolves to legal lane paths.

### Task 3: Bus and Taxi Runtime

**Files:**
- Create: `src/systems/TransportationSystem.ts`
- Modify: `src/config/ServiceKeys.ts`
- Modify: `src/core/ManagerRegistry.ts`
- Modify: `src/scenes/GameScene.ts`
- Modify: `src/systems/TrafficSystem.ts`
- Modify: `src/systems/VehicleSystem.ts`
- Test: `scripts/transit-validation.ts`

**Interfaces:**
- Produces buses with state `approaching | dwelling | recovering` and taxis with the documented availability/trip states.
- Produces debug snapshots for map/minimap, UI, smoke tests, and runtime diagnosis.

- [ ] **Step 1: Write lifecycle tests**

```ts
check(snapshot.busRoutes.tehran.length === 4);
check(snapshot.taxis.every((taxi) => taxi.hasDriver));
check(snapshot.buses.every((bus) => bus.usesTrafficDriver));
```

- [ ] **Step 2: Spawn scheduled buses on route lanes**

```ts
const vehicle = traffic.spawnServiceVehicle('bus', route.stops[0].approachPosition, () => next.approachPosition, 24);
vehicle.sprite.setData('persistentTransitService', true);
```

- [ ] **Step 3: Drive stop dwell and route progression**

```ts
if (driver.arrived) {
  traffic.setDriverStopped(bus.vehicle, true);
  bus.dwellRemainingMs = config.stopDurationMs;
}
if (bus.dwellRemainingMs <= 0) configureBusForNextStop(bus);
```

- [ ] **Step 4: Spawn roaming taxis and enforce taxi states**

```ts
if (taxi.state === 'AVAILABLE' && driver.arrived) taxi.roamTarget = chooseCityRoadTarget(taxi.cityId);
if (taxi.state === 'IN_SERVICE') traffic.configureDriver(taxi.vehicle, () => taxi.destination.approachPosition, 24);
```

- [ ] **Step 5: Protect only transit vehicles from normal stream retirement**

```ts
if (vehicle.sprite.getData('persistentTransitService') === true) continue;
```

- [ ] **Step 6: Run runtime/traffic tests**

Run: `npm run validate:transit && npm run validate:traffic`
Expected: PASS without changing civilian, emergency, or police route handling.

### Task 4: Passenger Seats and Player Passenger Transitions

**Files:**
- Modify: `src/gameplay/occupants/OccupantRules.ts`
- Modify: `src/gameplay/types/OccupantTypes.ts`
- Modify: `src/systems/VehicleOccupantSystem.ts`
- Modify: `src/entities/components/PedestrianAIComponent.ts`
- Modify: `src/systems/PedestrianSystem.ts`
- Modify: `src/systems/PlayerController.ts`
- Test: `scripts/transit-validation.ts`

**Interfaces:**
- Produces capacity-checked transit seat claims, transit exits, and passenger transition completion events.
- Produces player APIs `beginPassengerBoarding` and `beginPassengerExit` that animate instead of repositioning the player.

- [ ] **Step 1: Write occupancy tests**

```ts
check(occupants.availablePassengerSeats(bus).length === 5);
check(occupants.claimTransitPassenger(bus, personality, destination) !== null);
check(occupants.claimTransitPassenger(fullBus, personality, destination) === null);
```

- [ ] **Step 2: Reserve only drivers by default for service vehicles**

```ts
case 'taxi': return [['driver', 'taxi-driver']];
case 'bus': return [['driver', 'bus-driver']];
```

- [ ] **Step 3: Add pedestrian boarding state and standard exit materialization**

```ts
ped.ai.beginTransitBoarding(doorPosition);
if (ped.ai.transitBoardingReady) occupants.beginTransitBoarding(vehicle, passenger, doorPosition);
```

- [ ] **Step 4: Add player passenger transition state**

```ts
public beginPassengerBoarding(vehicle: Vehicle, seat: VehicleSeat): boolean { /* walk to door, enter seat */ }
public beginPassengerExit(target: Vector2): boolean { /* animate seat-to-curb exit */ }
```

- [ ] **Step 5: Run passenger lifecycle tests**

Run: `npm run validate:transit`
Expected: PASS; passengers board/exist through seats and retain normal pedestrian AI after exiting.

### Task 5: Interaction, Economy, and Taxi Destination Map

**Files:**
- Modify: `src/gameplay/types/InteractionTypes.ts`
- Modify: `src/systems/InteractionSystem.ts`
- Modify: `src/scenes/MapScene.ts`
- Modify: `src/config/EventKeys.ts`
- Modify: `src/core/types/EventTypes.ts`
- Test: `scripts/transit-validation.ts`

**Interfaces:**
- `TransportationSystem.interactionAt(position)` returns current bus/taxi/passenger actions.
- `MapScene` supports taxi destination selection, route quote, payment confirmation, and cancellation through `TransportationSystem`.

- [ ] **Step 1: Write fare charging tests**

```ts
check(confirmFare(walletWithExactFunds) === 'paid');
check(confirmFare(walletWithoutFunds) === 'insufficient-funds');
check(confirmFare(alreadyPaidTrip) === 'already-paid');
```

- [ ] **Step 2: Route E interactions to transit before generic targets**

```ts
const transitTarget = transit?.interactionAt(pos);
if (transitTarget) return transitTarget;
```

- [ ] **Step 3: Add real taxi map mode and confirmation UI**

```ts
const quote = transport.previewTaxiDestination(worldPoint, label);
fareText.setText(`Base $${quote.base}  Distance $${quote.distanceCost}  Total $${quote.total}`);
payButton.onClick = () => transport.confirmTaxiFare();
```

- [ ] **Step 4: Run fare and destination route tests**

Run: `npm run validate:transit`
Expected: PASS; a taxi starts only after one successful deduction and a valid lane route.

### Task 6: Transit Presentation and Collision Integration

**Files:**
- Create: `src/ui/hud/TransitHud.ts`
- Modify: `src/scenes/UIScene.ts`
- Modify: `src/ui/hud/MiniMap.ts`
- Modify: `src/scenes/MapScene.ts`
- Modify: `src/scenes/GameScene.ts`
- Modify: `src/systems/WorldManager.ts`

**Interfaces:**
- Produces pixel-styled bus/taxi ride status UI.
- Produces bus stop/routing map layers and minimized stop/taxi/bus visibility rules.
- Produces a static transit fixture collision group used by player, pedestrians, and vehicles.

- [ ] **Step 1: Draw non-placeholder stop fixtures and dedicated markers**

```ts
paintBusStopIcon(graphics, stop.x, stop.y, color);
minimap.drawTransitStop(stop.platformPosition, BUS_STOP_COLOR);
```

- [ ] **Step 2: Wire fixture collision with existing groups**

```ts
physics.collider(vehicles.group, transport.stopCollisionGroup);
physics.collider(peds.group, transport.stopCollisionGroup);
```

- [ ] **Step 3: Render ride status from snapshot data**

```ts
hud.setTransitState({ routeName, currentStop, nextStop, upcomingStops, canExit });
```

- [ ] **Step 4: Verify map and minimap layers**

Run: `npm run typecheck && npm run build`
Expected: PASS with bus stops and selected taxi destinations visible without minimap clutter.

### Task 7: Persistence, Tests, and Runtime Verification

**Files:**
- Create: `scripts/transit-validation.ts`
- Create: `scripts/run-transit-validation.mjs`
- Create: `scripts/transit-browser-smoke.ps1`
- Modify: `package.json`
- Modify: `src/systems/TransportationSystem.ts`

**Interfaces:**
- `TransportationSystem` implements `ISerializable` with `saveId = 'transport'` and persists only discovered stop IDs.
- Browser smoke collects bus/taxi state, fares, map availability, traffic status, and console errors for Tehran, Yazd, and Gilan.

- [ ] **Step 1: Persist only durable discovery state**

```ts
public serialize(): Json { return { discoveredStopIds: [...this.discoveredStopIds] }; }
public deserialize(data: Json): void { this.restoreDiscoveredStopIds(data); }
```

- [ ] **Step 2: Add deterministic checks and browser probes**

```ts
check(snapshot.cityConfigs.tehran.routes === 4);
check(snapshot.buses.every((bus) => bus.validLaneRoute));
check(snapshot.taxis.every((taxi) => taxi.hasDriver));
```

- [ ] **Step 3: Run full verification**

Run: `npm run typecheck && npm run lint && npm run build && npm run validate:traffic && npm run validate:transit`
Expected: PASS.

- [ ] **Step 4: Run actual-game smoke tests**

Run: `powershell -ExecutionPolicy Bypass -File scripts/transit-browser-smoke.ps1 -City tehran`
Run: `powershell -ExecutionPolicy Bypass -File scripts/transit-browser-smoke.ps1 -City yazd`
Run: `powershell -ExecutionPolicy Bypass -File scripts/transit-browser-smoke.ps1 -City gilan`
Expected: all city configurations materialize and report no browser errors.
