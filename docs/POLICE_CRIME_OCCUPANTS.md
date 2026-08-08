# Police, Crime, and Vehicle Occupants

## Ownership

`CrimeSystem` owns raw incident identity, perception, witness reactions, and delayed reports. A `CrimeCommitted` event is evidence that an action occurred, not that police know about it. Only `CrimeReported` can add police awareness.

`WantedSystem` owns awareness heat, the five-star level, last-known suspect position, bounded reinforcement waves, tactical unit roles, search sectors, roadblocks, helicopter intelligence, and officer directives. It never consumes `CrimeCommitted` and never gives a unit the live player position unless an officer, occupied patrol vehicle, or helicopter has line of sight. `PoliceResponseRules` is the single source for active unit/officer caps, wave size/cooldown, tactical composition, engagement policy, search duration/radius, roadblock quota, and helicopter eligibility at each star.

`VehicleOccupantSystem` owns persistent seat records, personalities, occupant visibility, and timed door/exit/boarding transitions. It draws all seated and transitioning occupants in one graphics batch. Traffic continues to own road routing and intersection behavior; pedestrian navigation continues to own on-foot paths.

`Player` owns the authoritative current HP, maximum HP, armor, and dead state through its `HealthComponent`. Damage returns one exact `DamageResult`; the HUD, effects, audio, save loading, death, and respawn consume the atomic `PlayerVitalsChanged` snapshot rather than maintaining their own HP copies.

## Incident Flow

1. Combat, theft, gunfire, collision, or explosion emits a raw attributed incident.
2. Crime perception queries nearby active pedestrians, police officers, and vehicle occupants.
3. Range, facing, and an optical world line-of-sight check decide whether each candidate perceived it. Optical visibility is separate from pedestrian path clearance, so roads do not make witnesses blind while buildings and walls still occlude them.
4. Civilian personality selects ignore, run, panic, hide, call, scream, point, freeze, help, or fight.
5. Police radio after a short delay. Reporting civilians finish their reaction before their longer call delay.
6. The first completed report creates awareness at the incident position and cancels duplicate reports for that incident.

No candidate witness means no pending report and no wanted level.

## Police Lifecycle

Calm-world patrol vehicles carry at least a driver and front officer and use the normal traffic graph. Dispatch prefers a police station inside the active world ring; when every station is too distant, it uses a legal off-screen travel lane near the incident. This prevents station vehicles from being virtualized before police command can register them. A report assigns the nearest available patrol to the reported position. Units stop through traffic control, open doors, disembark their real crew, and receive arrest, cover, engagement, or search directives.

Police knowledge is a last-known position. Broken contact changes the response to sector search and starts star-by-star decay. Response vacancies are filled by capped reinforcement waves after a profile-specific cooldown rather than by immediately spawning replacements. Command assigns investigation, pursuit, interception, containment, and roadblock roles so units approach from different routes and perform different jobs.

At four and five stars, command predicts the suspect's route and scores generated major intersections, highway ramps, bridges, and city exits ahead of that motion. A site inside the player safety radius is rejected. A deployed roadblock uses an arrived patrol, armed officers, spike strips, physical concrete barriers, and a temporary traffic obstacle; clearing awareness removes all of them. At five stars only, one helicopter can establish visual contact, share its confirmed observation with ground command, and circle the target. Range or building occlusion breaks that contact and makes it search near its last observation instead of reading the live player position.

When awareness clears, surviving officers path back to their own vehicle, board through timed transitions, and the car returns to ambient patrol.

Dispatched officers are promoted out of ambient LOD sleeping until their response ends. Their shared-navigation `police` profile permits road crossings while retaining solid-world collision; civilians keep the stricter pedestrian profile. Active response vehicles are excluded from traffic virtualization and recovery despawn.

## Health and Damage

Player and police weapons share `WeaponComponent -> CombatSystem -> Projectile -> IDamageable`. `CombatSystem.deliverDamage(...)` is also the common delivery boundary for melee, explosions, fire, and vehicle impacts. It validates ownership, faction hostility, invulnerability, dead targets, and repeat penetration hits before the target's health component is allowed to mutate.

Pooled projectiles are always eligible for the entity scheduler while active. They cannot remain dormant at their pool parking coordinate after a distant launch. Ordinary Arcade overlaps use the same hit handler, while a bounded segment sweep closes the fast-projectile tunnelling gap and selects the nearest hostile body before delegating to that handler. A projectile records every pierced target once, so multiple overlap frames cannot apply repeated damage.

Armor absorbs validated damage before HP. A hit that is invalid, resisted, invulnerable, or targets an already dead entity produces no false blood, sound, shake, or hit feedback. Applied damage publishes vitals immediately, adds knockback and hit feedback, and enters the death/respawn flow exactly once when HP reaches zero. A dead player loses control, drops a non-starting equipped weapon, clears wanted response, fades, and respawns through the existing hospital flow. Healing and restore operations clamp to the same authoritative maximums and publish through the same event boundary.

The HUD initializes from live player vitals before subscribing to changes, so a scene transition cannot miss the initial state. Save loading calls `Player.restoreVitals(...)`; it never synthesizes damage to recreate saved health.

## Debugging

Press `F8` to toggle the gameplay systems overlay. It reports current/max HP, armor, dead state, requested/applied damage, armor absorption, last applied source, police bullet damage, collision result, wanted level and phase, active officers and patrols, wave timing, roadblocks, helicopter state, primary police unit state, and primary officer AI state. The overlay samples at a bounded rate and does not become another gameplay-state owner.

## Carjacking

Vehicle entry is a state machine: approach, door open, driver/passenger exit, driver pull/fall, player boarding, door close, and engine start. Ejected occupants materialize as normal world NPCs with the same personality they had in the vehicle. Re-entering the already stolen vehicle does not create a second theft incident.

## Performance

- Occupants use one batched graphics object rather than one physics entity per seat.
- Witness scans occur only when an incident is created and use the entity spatial hash.
- Police walking uses the shared queued navigation worker with a separate cached police cost grid.
- Police driving uses the fixed-step traffic scheduler, reservations, and virtual traffic lifecycle.
- Reinforcement waves, response vehicles, active officers, roadblocks, barriers, and the helicopter are bounded by response profiles and engine limits.
- Incident, report, occupant, patrol, and transition counts have hard engine limits.
- Distant pedestrians and vehicles continue to sleep or virtualize under the existing entity/traffic LOD systems.

Run `npm run validate:gameplay` for authoritative vitals, response profiles, reinforcement waves, tactical roles, roadblock planning, and helicopter gating; `npm run validate:police` for witness/occupant/police lifecycle invariants; and `npm run validate:traffic` for road-system invariants. `scripts/police-browser-smoke.ps1` exercises the live Phaser loop, unarmored HP loss and death from police projectiles, physical roadblock deployment, helicopter track/search transitions, cleanup, HUD synchronization, search/return, and carjacking transitions.
