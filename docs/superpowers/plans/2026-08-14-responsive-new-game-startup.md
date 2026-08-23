# Responsive New Game Startup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Starting a new game must return control to the browser immediately while transit routes are prepared incrementally in the background.

**Architecture:** `GameScene.create()` will queue its dependency-ordered service attachments one per frame, allowing the browser to paint between world/traffic setup operations. `TransportationSystem` will replace its synchronous startup route resolution with a queue that resolves one authored route per frame; each completed route is published atomically and becomes eligible for bus spawning. This preserves the shared `TrafficNetwork` exact-route validation while preventing candidate-route A* searches from monopolising the main thread.

**Tech Stack:** TypeScript, Phaser 3, Vite, existing PowerShell Chrome smoke test, esbuild validation scripts.

## Global Constraints

- Keep all existing transit routes, exact directed lane validation, and taxi behaviour intact.
- Do not start or duplicate a game scene more than once from one menu interaction.
- No synchronous route-authoring loop may run from `TransportationSystem.onAttach`.
- Keep per-frame startup work below the 20 ms manager warning budget in `src/config/EngineLimits.ts`.
- Preserve the user's current unrelated worktree changes.

---

### Task 1: Guard a menu transition and stage scene composition

**Files:**
- Modify: `src/scenes/MainMenuScene.ts:45-150`
- Modify: `src/scenes/GameScene.ts:40-140,330-345`
- Test: `scripts/browser-smoke.ps1`

**Interfaces:**
- Produces: `MainMenuScene.onNewGame(): void`, idempotent while its scene is transitioning.
- Produces: `GameScene.queueSystemAttachments(): void`, preserving the original service order while attaching one service per scene frame.
- Consumes: `GameManager.startNewGame()` and `ScenePlugin.start(SceneKeys.Game)`.

- [ ] **Step 1: Add a failing browser smoke assertion**

In the CDP evaluation after starting the game, call the menu action twice in the same task and assert that exactly one active `GameScene` is present and that the scene becomes ready.

```powershell
$snapshot.ready -and ($snapshot.scenes | Where-Object { $_ -eq 'GameScene' }).Count -eq 1
```

- [ ] **Step 2: Run the browser smoke test to verify the current startup path is not protected**

Run: `powershell -ExecutionPolicy Bypass -File scripts/browser-smoke.ps1 -Url http://127.0.0.1:5173 -Screenshot new-game-before.png`

Expected: the test exposes a blocked or duplicate startup path before the guard and startup scheduling fixes.

- [ ] **Step 3: Add the minimal scene-transition flag**

```ts
private isStartingGame = false;

private onNewGame(): void {
  if (this.isStartingGame) return;
  this.isStartingGame = true;
  this.playConfirm();
  ServiceLocator.resolve<GameManager>(ServiceKeys.Game).startNewGame();
  this.scene.start(SceneKeys.Game);
}
```

- [ ] **Step 4: Queue GameScene service attachment one per frame**

```ts
private attachNextSystem(): void {
  const key = this.attachmentQueue.shift();
  if (!key) return this.completeSystemAttachments();
  this.attach(key);
  this.events.once(Phaser.Scenes.Events.POST_UPDATE, this.attachNextSystem, this);
}
```

Keep the existing dependency order exactly. Call `wireColliders()` only from `completeSystemAttachments()` after Player and Interaction have attached.

- [ ] **Step 5: Run type-checking**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/scenes/MainMenuScene.ts src/scenes/GameScene.ts scripts/browser-smoke.ps1
git commit -m "fix: keep new game startup responsive"
```

### Task 2: Incrementally resolve authored transit routes

**Files:**
- Modify: `src/systems/TransportationSystem.ts:100-190,527-564,759-872`
- Test: `scripts/transit-validation.ts`

**Interfaces:**
- Produces: `TransportationSystem.initializeRuntime(): void`, which schedules route work without synchronously resolving all routes.
- Produces: `TransportationSystem.processRouteInitialization(budgetMs: number): void`, which processes a bounded number of configured routes and marks the runtime ready only after the queue drains.
- Consumes: `TrafficSystem.roadNetwork`, `TrafficNetwork.findCompleteRoute()`, and `CITY_TRANSIT_CONFIG`.

- [ ] **Step 1: Add a failing startup-budget validation**

Add a deterministic route-work queue fixture to `scripts/transit-validation.ts` that verifies a queue consumes one route at a time and does not report ready before every route is processed.

```ts
const queue = new RouteInitializationQueue(['T1', 'T2']);
check(queue.takeNext() === 'T1', 'startup route queue must preserve configured order');
check(!queue.complete, 'startup route queue must not report ready before all routes finish');
check(queue.takeNext() === 'T2' && queue.complete, 'startup route queue must finish after the final route');
```

- [ ] **Step 2: Run the transit validation to verify it fails**

Run: `npm run validate:transit`

Expected: FAIL because `RouteInitializationQueue` does not yet exist.

- [ ] **Step 3: Queue route resolution instead of performing it in `onAttach`**

```ts
protected onAttach(_scene: Phaser.Scene): void {
  this.resetRuntime();
  this.resolveServices();
  this.beginRouteInitialization();
}

public update(time: number, delta: number): void {
  this.resolveServices();
  this.initializeRuntime();
  this.processRouteInitialization(4);
  if (!this.runtimeReady) return;
  // Existing service update code remains unchanged.
}
```

`beginRouteInitialization()` must flatten the configured city/route pairs in stable city and config order. `processRouteInitialization()` must resolve at most one route per frame, use the existing `resolveRouteStops`, `buildResolvedBusRoute`, and `logRouteValidation` functions, then add the result to its city's `resolvedRoutes` map. It must set `runtimeReady` only after all routes have been resolved.

- [ ] **Step 4: Ensure failed routes are still recorded**

```ts
const stops = this.resolveRouteStops(cityId, config, traffic);
const route = this.buildResolvedBusRoute(cityId, config, stops);
this.resolvedRoutes.set(cityId, [...(this.resolvedRoutes.get(cityId) ?? []), route]);
this.logRouteValidation(route);
```

This keeps invalid authoring visible in diagnostics and prevents an empty result from hiding a configuration regression.

- [ ] **Step 5: Run static validations**

Run: `npm run validate:transit`

Expected: PASS with all existing lane-route and passenger invariants intact.

- [ ] **Step 6: Commit**

```bash
git add src/systems/TransportationSystem.ts scripts/transit-validation.ts
git commit -m "fix: schedule transit route startup across frames"
```

### Task 3: Verify an actual New Game remains responsive

**Files:**
- Modify: `scripts/browser-smoke.ps1`
- Test: `scripts/browser-smoke.ps1`

**Interfaces:**
- Consumes: `MainMenuScene.onNewGame()`, `GameScene`, and the transit debug snapshot.
- Produces: a smoke-test failure if the Game scene does not activate within the test deadline or if startup emits a browser error.

- [ ] **Step 1: Capture the activation deadline before calling New Game**

```powershell
$newGameStartedAt = [Diagnostics.Stopwatch]::StartNew()
```

- [ ] **Step 2: Assert the scene activates before full transit initialization**

```powershell
if (-not $snapshot.ready) { throw 'New Game did not activate GameScene.' }
if ($newGameStartedAt.Elapsed.TotalSeconds -gt 8) {
  throw "New Game activation exceeded responsiveness budget: $($newGameStartedAt.Elapsed.TotalSeconds)s"
}
```

- [ ] **Step 3: Run the full browser smoke test**

Run: `powershell -ExecutionPolicy Bypass -File scripts/browser-smoke.ps1 -Url http://127.0.0.1:5173 -Screenshot new-game-responsive.png`

Expected: PASS; `GameScene` activates promptly and subsequent startup work finishes without browser errors.

- [ ] **Step 4: Run the build**

Run: `npm run build`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/browser-smoke.ps1
git commit -m "test: cover responsive new game startup"
```

## Self-Review

1. **Spec coverage:** Task 1 prevents duplicate New Game activation; Task 2 removes the synchronous all-route A* burst that blocks the main thread; Task 3 verifies activation timing and a complete production build.
2. **Placeholder scan:** no TBD, TODO, or unspecified implementation/test instructions remain.
3. **Type consistency:** the startup queue only uses existing `CityId`, `BusRouteConfig`, `ResolvedBusRoute`, `TrafficSystem`, and `TrafficNetwork` interfaces. The queued result is appended to the same `resolvedRoutes` map read by spawning and diagnostics.
