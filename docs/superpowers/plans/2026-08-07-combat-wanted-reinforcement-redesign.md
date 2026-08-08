# Combat and Police Escalation Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make police fire lethal through the canonical combat pipeline and turn wanted levels one through five into bounded, coordinated response tiers with waves, strategic roadblocks, and fallible helicopter intelligence.

**Architecture:** `CombatSystem` becomes the single delivery boundary for all bullets, melee, fire, explosions, and impacts, while entities retain ownership of health, armor, animation, death, and HUD events. `WantedSystem` remains the police command authority but dispatches from immutable response profiles in timed waves, assigns tactical roles, plans roadblocks against the generated road graph, and owns one high-level helicopter whose observations update shared last-known intelligence.

**Tech Stack:** TypeScript 5, Phaser 3 Arcade Physics, Vite, existing entity/component services, road graph, traffic navigation, event bus, and object pools.

## Global Constraints

- Police and player weapons use the same `WeaponComponent -> CombatSystem -> Projectile -> IDamageable` path.
- Armor absorbs validated damage before HP and player vitals have one authoritative owner.
- Police response is capped, wave-based, and originates from patrols, police stations, or off-screen aerial approaches.
- Police may act on shared last-known intelligence, but never receive the live player position without line of sight.
- Roadblocks select generated road nodes ahead of travel and outside the immediate player safety radius.
- Helicopter support exists only at five stars and transitions from tracking to local search when vision is blocked.
- All frequent projectiles and response actors remain pooled or bounded by explicit engine limits.

---

### Task 1: Authoritative Damage Delivery and Diagnostics

**Files:**

- Modify: `src/gameplay/types/CombatTypes.ts`
- Modify: `src/systems/CombatSystem.ts`
- Modify: `src/entities/Character.ts`
- Modify: `src/ui/hud/GameplayDebugOverlay.ts`
- Modify: `scripts/gameplay-systems-validation.ts`

**Interfaces:**

- Produces: `CombatDebugSnapshot`, `CombatSystem.debugSnapshot()`, and one internal `deliverDamage(target, info, context)` path.
- Consumes: `IDamageable.applyDamage(info): DamageResult`, projectile attribution, factions, and entity kinds.

- [x] Route bullet, melee, explosion, fire, and vehicle hits through one delivery method.
- [x] Record requested/applied damage, armor absorption, source, target, and collision outcome without creating another health owner.
- [x] Keep hostility, self-hit, dead-target, and duplicate-pierce rejection explicit at collision validation.
- [x] Emit blood and hit confirmation only from successful delivery results.
- [x] Prove finite damage, armor overflow, ignored hits, fatal hits, and telemetry with deterministic checks.

### Task 2: Complete Player Death Lifecycle

**Files:**

- Modify: `src/config/EventKeys.ts`
- Modify: `src/core/types/EventTypes.ts`
- Modify: `src/entities/components/InventoryComponent.ts`
- Modify: `src/entities/Player.ts`
- Modify: `src/systems/PickupSystem.ts`
- Modify: `src/systems/WantedSystem.ts`
- Modify: `src/systems/PlayerController.ts`

**Interfaces:**

- Produces: `InventoryComponent.dropEquippedWeapon()`, `EventKeys.WeaponDropped`, and `PickupSystem.dropWeapon(...)`.
- Consumes: the existing `PlayerDied` flow, player inventory, pickup lifecycle, and `WantedSystem.clearWanted()`.

- [x] Disable movement/fire through existing dead-state control gates and preserve the death fade/respawn loop.
- [x] Remove a non-starting equipped weapon, publish its weapon/ammo/position payload, and materialize a bounded world pickup.
- [x] Clear wanted intelligence and recall response assets on player death before respawn.
- [x] Verify the body and controls remain disabled until respawn restores health and temporary invulnerability.

### Task 3: Escalation Profiles and Reinforcement Waves

**Files:**

- Modify: `src/gameplay/police/PoliceResponseRules.ts`
- Modify: `src/config/Constants.ts`
- Modify: `src/config/EngineLimits.ts`
- Modify: `src/systems/WantedSystem.ts`
- Modify: `src/systems/TrafficSystem.ts`
- Modify: `scripts/gameplay-systems-validation.ts`
- Modify: `scripts/police-validation.ts`

**Interfaces:**

- Produces: profile fields `maxActiveUnits`, `waveSize`, `waveCooldownMs`, `roadblockCount`, `helicopter`, and tactical role counts.
- Consumes: patrol registry, station spawns, response unit lifecycle, and wanted-level changes.

- [x] Give every star a distinct vehicle cap, wave cadence, search radius, aggression, and tactical composition.
- [x] Dispatch only one bounded wave when due; defeated units become eligible for replacement after the profile cooldown.
- [x] Keep ambient fleet replenishment separate from response assignment and cap active vehicles/officers globally.
- [x] Expose wave index, next-wave delay, active officer/vehicle totals, and unit roles in the wanted snapshot.

### Task 4: Coordinated Ground Tactics and Strategic Roadblocks

**Files:**

- Create: `src/gameplay/police/RoadblockPlanner.ts`
- Modify: `src/gameplay/police/index.ts`
- Modify: `src/systems/WantedSystem.ts`
- Modify: `src/config/AssetKeys.ts`
- Modify: `src/graphics/PropTextureFactory.ts`
- Modify: `src/scenes/GameScene.ts`
- Modify: `scripts/gameplay-systems-validation.ts`

**Interfaces:**

- Produces: `planRoadblock(input): RoadblockPlan | null`, tactical unit roles, `WantedSystem.blockadeGroup`, and physical road-barrier assets.
- Consumes: `MapData.roadNodes`, road edges/intersections, last-known velocity, traffic temporary obstacles, and patrol routing.

- [x] Assign pursuit, interceptor, containment, and roadblock roles instead of sending every car to one point.
- [x] Predict the likely route, score major intersections/highway ramps/bridges/exits, and reject nodes inside the player safety radius.
- [x] Deploy stopped police vehicles, concrete barriers, bounded spike strips, and armed cover officers at the selected node.
- [x] Register temporary traffic obstacles and physical vehicle/barrier collision, then remove both during recall.
- [x] Prove roadblock candidates are ahead, off-screen-safe, major-road-biased, and capped per profile.

### Task 5: Five-Star Helicopter Intelligence

**Files:**

- Modify: `src/entities/Helicopter.ts`
- Modify: `src/systems/WantedSystem.ts`
- Modify: `src/gameplay/police/PoliceResponseRules.ts`
- Modify: `scripts/gameplay-systems-validation.ts`
- Modify: `scripts/police-browser-smoke.ps1`

**Interfaces:**

- Produces: `Helicopter.reportVisualContact(...)`, `Helicopter.loseVisualContact()`, search/track state, and helicopter debug data.
- Consumes: wanted-owned line-of-sight checks, last-known position, world bounds, and shared combat service.

- [x] Dispatch one helicopter only at five stars from a station or off-screen approach and register it with the entity scheduler.
- [x] Let wanted command evaluate distance/building occlusion and publish only confirmed observations to the helicopter and ground command.
- [x] Circle and fire only while tracking; on lost sight, search around the last visual contact without reading live player coordinates.
- [x] Recall and destroy the helicopter below five stars, on wanted clear, player death, or scene teardown.

### Task 6: Runtime Debugging and End-to-End Verification

**Files:**

- Modify: `src/ui/hud/GameplayDebugOverlay.ts`
- Modify: `scripts/police-browser-smoke.ps1`
- Modify: `docs/POLICE_CRIME_OCCUPANTS.md`
- Modify: `package.json`

**Interfaces:**

- Consumes: `CombatSystem.debugSnapshot()`, `WantedSystem.debugSnapshot()`, player vitals, and live Phaser groups.
- Produces: the complete F8 diagnostics requested by the specification and browser assertions for lethal police fire/high-tier response.

- [x] Show HP, armor, incoming/applied damage, source, police bullet damage, collision result, wanted level, officers, patrols, wave, helicopter, roadblocks, and police state.
- [x] Make the browser scenario remove armor, wait for a real police projectile to reduce HP, and sustain fire until death/respawn.
- [x] Force levels one through five and assert distinct caps/tactics, bounded waves, level-four roadblocks, and five-star helicopter-only dispatch.
- [x] Run typecheck, lint, build, deterministic gameplay/police/traffic validation, and desktop/mobile browser smoke without runtime errors.
