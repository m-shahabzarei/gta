# Runtime Transit Availability Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make physically spawned taxis and bus-stop fixtures reliably encounterable and visible in all three cities while preserving the existing traffic, occupant, and map systems.

**Architecture:** Keep `TransportationSystem` as the owner of service state, but add city hub-aware service spawn selection and runtime diagnostics. Keep `BusStopSite` as the single generated stop record, guarantee hub coverage during generation, and instantiate each streamed record through a keyed world fixture rather than a data-only route reference.

**Tech Stack:** TypeScript, Phaser 3, existing `TrafficSystem`, `TrafficNetwork`, `VehicleOccupantSystem`, and CDP browser smoke tests.

## Global Constraints

- Use only legal directed travel lanes for taxis and buses.
- Do not add global prompts, fake map positions, or player-visible debug overlays.
- Keep drivers seated and protect service vehicles from generic traffic retirement.
- Bound service checks to the existing throttled transit tick and spatial road queries.
- Verify live world visibility in Tehran, Yazd, and Gilan before completion.

---

### Task 1: Add Runtime Evidence for Service Population

**Files:**
- Modify: `src/gameplay/transit/TransitTypes.ts`
- Modify: `src/systems/TransportationSystem.ts`
- Modify: `scripts/transit-browser-smoke.ps1`

**Interfaces:**
- Consumes: live service vehicles, occupant manifests, `TrafficDriver.debug`, and player position.
- Produces: non-player-visible `debugSnapshot()` records containing city, position, state, driver/passenger status, navigation state, and distance from the player.

- [ ] **Step 1: Extend taxi snapshot diagnostics**

```ts
interface TaxiServiceSnapshot {
  position: Vector2;
  hasPassenger: boolean;
  navigationState: string | null;
  distanceToPlayer: number | null;
}
```

- [ ] **Step 2: Fail the browser smoke when the active city has no materialized available taxi near an approved service hub**

```js
const nearbyTaxi = snapshot.taxis.find(taxi =>
  taxi.cityId === playerCity && taxi.state === 'AVAILABLE' && taxi.hasDriver && taxi.distanceToPlayer < 900,
);
if (!nearbyTaxi) throw 'No encounterable available taxi in active city';
```

- [ ] **Step 3: Capture the fresh runtime output before changing spawn placement**

Run: `powershell -ExecutionPolicy Bypass -File scripts/transit-browser-smoke.ps1`

### Task 2: Make Taxis Encounterable, Not Merely Globally Spawned

**Files:**
- Modify: `src/gameplay/transit/TransitTypes.ts`
- Modify: `src/gameplay/transit/TransitConfig.ts`
- Modify: `src/systems/TransportationSystem.ts`
- Test: `scripts/transit-validation.ts`

**Interfaces:**
- Consumes: city-specific service hubs, player city/position, and legal road-lane projections.
- Produces: configurable city taxi populations with a bounded available-taxi encounter radius and lane-safe spawn/reposition targets.

- [ ] **Step 1: Add city taxi encounter configuration**

```ts
interface TaxiConfig {
  population: number;
  encounterRadius: number;
  guaranteedNearby: number;
}
```

- [ ] **Step 2: Select a legal local lane target from configured hubs and nearby lanes**

```ts
const target = this.resolveTaxiSpawnTarget(cityId, playerPosition, preferLocal);
const vehicle = traffic.spawnServiceVehicle('taxi', target.position, null, TAXI_STOP_RANGE);
```

- [ ] **Step 3: Maintain one available taxi near the player only when they are in that taxi's city**

```ts
if (cityId === playerCity && this.availableTaxiCountNear(playerPosition) < config.guaranteedNearby) {
  this.repositionOrSpawnAvailableTaxi(cityId, playerPosition);
}
```

- [ ] **Step 4: Preserve service identity and driver ownership on every spawn/reposition**

```ts
vehicle.sprite.setData('persistentTransitService', true);
vehicle.sprite.setData('transitServiceKind', 'taxi');
assert(this.hasServiceDriver(vehicle, 'taxi-driver'));
```

- [ ] **Step 5: Run static transit validation**

Run: `node scripts/run-transit-validation.mjs`

### Task 3: Guarantee Real Bus Stops at City Hubs and Stream Fixtures as World Objects

**Files:**
- Modify: `src/systems/WorldManager.ts`
- Modify: `src/gameplay/types/WorldTypes.ts` only if a fixture identifier is required
- Modify: `scripts/transit-browser-smoke.ps1`

**Interfaces:**
- Consumes: the legal lane-backed `BusStopSite`, city centers, and player start.
- Produces: at least one nearby hub stop for each city, keyed streamed fixtures, and the same stop record for world/map/minimap/route use.

- [ ] **Step 1: Reserve candidate stops closest to each city center before randomized coverage selection**

```ts
const hubCandidates = candidates.filter(candidate => distanceToCityCenter(candidate) < HUB_STOP_RADIUS);
selectStop(hubCandidates, cityId);
```

- [ ] **Step 2: Render each selected stop through a keyed `Phaser.Container` with shelter, sign, bench, curb bay, and route panel**

```ts
fixture.setData('busStopId', stop.id);
fixture.setData('cityId', stop.cityId);
fixture.setDepth(DepthLayers.GroundDetail + 4);
```

- [ ] **Step 3: Keep collision restricted to the platform-side fixture footprint**

```ts
transitStopCollisionLayer.setCollision([...VEHICLE_ONLY_SOLID_TILE_TYPES]);
```

- [ ] **Step 4: Assert streamed fixture identity and visual proximity in every city**

Run: `powershell -ExecutionPolicy Bypass -File scripts/transit-browser-smoke.ps1`

### Task 4: Live End-to-End Verification

**Files:**
- Modify: `scripts/transit-browser-smoke.ps1`
- Test: `npm run build`

**Interfaces:**
- Consumes: live Phaser scene and public transit diagnostics.
- Produces: repeatable visual/runtime proof of an encounterable taxi, driver, visible stops, and road-following service vehicles in each city.

- [ ] **Step 1: Verify city-local taxi encounter, driver, state, and lane validity for Tehran, Yazd, and Gilan**

```js
assert(cityDiagnostics.every(city => city.availableTaxi && city.driver && city.laneValid));
```

- [ ] **Step 2: Verify each city has a streamed named bus-stop fixture beside a legal approach lane**

```js
assert(cityDiagnostics.every(city => city.fixtureVisible && city.stopRoadOffset >= 24));
```

- [ ] **Step 3: Execute player taxi and bus interaction sequences against those live entities**

Run: `powershell -ExecutionPolicy Bypass -File scripts/transit-browser-smoke.ps1`

- [ ] **Step 4: Run production checks**

Run: `npx eslint "src/**/*.ts"`

Run: `npm run build`
