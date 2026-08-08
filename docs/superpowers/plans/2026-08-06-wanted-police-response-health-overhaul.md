# Wanted, Police Response, and Health Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every wanted star produce an observable, road-routed police response and make player HP, armor, death, HUD, and debug telemetry consume one authoritative vitals state.

**Architecture:** `WantedSystem` remains the owner of police awareness and real patrol-unit lifecycle, but all response behavior is selected from a pure wanted-level response profile rather than scattered thresholds. `HealthComponent` returns an atomic mutation result, while `Player` is the only publisher of the complete player-vitals snapshot consumed by the HUD, audio/feedback, persistence, and developer overlay.

**Tech Stack:** TypeScript 5, Phaser 3 Arcade Physics, Vite, the existing event bus, entity scheduler, shared navigation, fixed-step traffic runtime, and object pools.

## Global Constraints

- Police never teleport or read the player's live position unless a police observer currently has line of sight.
- Response vehicles travel through the existing road graph and originate from existing patrols or police stations.
- Wanted levels rise gradually and every level from one through five changes response behavior.
- Armor absorbs damage before HP; HP, max HP, armor, and death state have one owner.
- HUD changes are event-driven and initialized from the authoritative player snapshot.
- Debug telemetry is toggleable and refreshed at a bounded interval.
- Existing traffic, occupant, crime witness, and LOD budgets remain in force.

---

### Task 1: Atomic Damage and Player Vitals

**Files:**

- Modify: `src/gameplay/types/CombatTypes.ts`
- Modify: `src/gameplay/types/EntityTypes.ts`
- Modify: `src/entities/components/HealthComponent.ts`
- Modify: `src/entities/components/CharacterMovementComponent.ts`
- Modify: `src/entities/Character.ts`
- Modify: `src/entities/Player.ts`
- Modify: `src/entities/Vehicle.ts`
- Modify: `src/entities/Helicopter.ts`

**Interfaces:**

- Produces: `DamageResult`, `PlayerVitalsSnapshot`, `Player.vitals`, `Player.restoreVitals(...)`.
- Consumes: existing `DamageInfo`, `HealthComponent`, and `IDamageable` contracts.

- [x] Add a `DamageResult` value containing requested, armor-absorbed, HP-applied, remaining HP/armor, killed, and ignored fields.
- [x] Make every `HealthComponent` mutation clamp finite values and return its exact result.
- [x] Make `IDamageable.applyDamage` return `DamageResult` so combat effects only occur for validated hits.
- [x] Apply optional knockback through a short-lived movement impulse rather than directly fighting the movement tick.
- [x] Publish one complete player vitals snapshot after damage, healing, armor, restore, death, and respawn.
- [x] Route save restoration through `Player.restoreVitals` instead of mutating the component behind the player's event boundary.

### Task 2: Event-Driven HUD, Feedback, Death, and Respawn

**Files:**

- Modify: `src/config/EventKeys.ts`
- Modify: `src/core/types/EventTypes.ts`
- Modify: `src/ui/hud/GameHud.ts`
- Modify: `src/scenes/UIScene.ts`
- Modify: `src/systems/CombatSystem.ts`
- Modify: `src/systems/GameAudioSystem.ts`
- Modify: `src/systems/PlayerController.ts`

**Interfaces:**

- Consumes: `PlayerVitalsSnapshot` and `DamageResult` from Task 1.
- Produces: `EventKeys.PlayerVitalsChanged` and `GameHud.setVitals(...)`.

- [x] Add the atomic `PlayerVitalsChanged` event and switch both HUD bars to it.
- [x] Initialize the HUD directly from `Player.vitals` when the UI scene starts, removing the missed-initial-event window.
- [x] Spawn blood, hit confirmation, sound, flash, shake, and knockback only when a hit actually applies.
- [x] Add low-health feedback and a screen fade for death/respawn without adding another HP variable.
- [x] Keep movement and combat disabled from death until authoritative respawn completes.

### Task 3: Wanted-Level Response Profiles and Deterministic Police FSM

**Files:**

- Create: `src/gameplay/police/PoliceResponseRules.ts`
- Create: `src/gameplay/police/index.ts`
- Modify: `src/gameplay/types/CrimeTypes.ts`
- Modify: `src/gameplay/types/index.ts`
- Modify: `src/systems/WantedSystem.ts`
- Modify: `src/entities/components/PoliceAIComponent.ts`
- Modify: `src/config/Constants.ts`

**Interfaces:**

- Produces: `PoliceResponseProfile`, `responseProfileForLevel(level)`, explicit patrol/officer state names, and expanded `WantedSystem.debugSnapshot()`.
- Consumes: reported incident/last-known positions, real patrol units, shared navigation, occupant transitions, and traffic routing.

- [x] Define immutable profiles for stars one through five with unit counts, engagement policy, search radius, persistence, and roadblock eligibility.
- [x] Dispatch or reinforce units whenever the profile changes, sourcing shortages from police stations and never from the player's vicinity.
- [x] Keep vehicle targets knowledge-bounded while updating them on actual vehicle/officer sightings.
- [x] Map patrol lifecycle and on-foot directives to deterministic Patrol, Investigate, Respond, DriveToTarget, ExitVehicle, FootChase, Combat, Search, ReturnToVehicle, and ResumePatrol states.
- [x] Make arrest versus lethal engagement depend on the response profile and suspect behavior, with friendly-fire checks retained.
- [x] Expose active responder count, unit states, primary police state, and primary officer AI state.

### Task 4: Visible Emergency and City Response

**Files:**

- Modify: `src/entities/components/VehicleLightsComponent.ts`
- Modify: `src/systems/TrafficSystem.ts`
- Modify: `src/gameplay/traffic/TrafficDriver.ts`
- Modify: `src/systems/PedestrianSystem.ts`
- Modify: `src/systems/CityLifeSystem.ts`

**Interfaces:**

- Consumes: `WantedChanged`, patrol response activation data, and the current last-known danger point.
- Produces: response-only red/blue lightbar state and deterministic high-wanted crowd/traffic alert behavior.

- [x] Mark only dispatched police units as emergency-active and render alternating red/blue lightbar glows.
- [x] Give dispatched vehicles emergency road priority while preserving road navigation and collision avoidance.
- [x] At high wanted levels, push nearby civilian pedestrians into their existing flee state, including newly streamed pedestrians.
- [x] Increase civilian traffic urgency in a bounded deterministic way without replacing explicit service destinations.

### Task 5: Gameplay Debug Overlay and Validation

**Files:**

- Create: `src/ui/hud/GameplayDebugOverlay.ts`
- Modify: `src/ui/hud/index.ts`
- Modify: `src/scenes/UIScene.ts`
- Modify: `scripts/police-validation.ts`
- Create: `scripts/gameplay-systems-validation.ts`
- Create: `scripts/run-gameplay-systems-validation.mjs`
- Modify: `package.json`
- Modify: `docs/POLICE_CRIME_OCCUPANTS.md`

**Interfaces:**

- Consumes: `Player.vitals`, `WantedSystem.debugSnapshot()`, and `PoliceAIComponent.currentState`.
- Produces: an F8 overlay and `npm run validate:gameplay`.

- [x] Add a developer-only F8 overlay showing HP, max HP, armor, dead state, wanted level/phase, active responder count, unit state, and officer AI state.
- [x] Refresh the overlay no faster than ten times per second and release all DOM/listener resources on shutdown.
- [x] Validate armor-first damage, clamping, ignored damage, death-once behavior, restore/respawn, five distinct wanted response profiles, gradual escalation, and responder scaling.
- [x] Run `npm run typecheck`, `npm run lint`, `npm run build`, `npm run validate:police`, `npm run validate:traffic`, and `npm run validate:gameplay`.
- [x] Run desktop/mobile browser scenarios and verify pursuit, vehicle exit, engagement, search, decay, death/respawn, HUD synchronization, overlay data, no runtime errors, and stable frame rate.
