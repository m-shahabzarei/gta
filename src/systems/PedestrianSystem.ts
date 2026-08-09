/**
 * PedestrianSystem — the ambient crowd director.
 *
 * It keeps a living population of civilian {@link Pedestrian} entities streaming
 * around the player: spawning fresh pedestrians just off-screen on the nearest
 * sidewalks, retiring those that wander too far away (or have been dead long
 * enough to fade out), and advancing every survivor each frame. It also relays
 * nearby danger — weapon fire, kills and explosions — to the crowd by calling
 * {@link Pedestrian.alarm} on any pedestrian close to the event, so the streets
 * visibly panic when violence erupts.
 *
 * The system owns a single Arcade physics {@link Phaser.Physics.Arcade.Group}
 * so the scene can wire crowd-vs-world (and crowd-vs-bullet) collisions once and
 * have every spawned pedestrian participate automatically.
 */
import Phaser from 'phaser';
import { BaseSceneManager } from '@/core/BaseSceneManager';
import { ServiceLocator } from '@/core/ServiceLocator';
import { ServiceKeys } from '@/config/ServiceKeys';
import { EventKeys } from '@/config/EventKeys';
import { PED } from '@/config/Constants';
import { ENGINE_LIMITS } from '@/config/EngineLimits';
import { EngineDiagnostics } from '@/core/EngineDiagnostics';
import { DepthLayers } from '@/config/DepthLayers';
import { WeatherMode } from '@/config/Settings';
import type { Vector2 } from '@/core/types';
import {
  getPlayerRef,
  getWorldQuery,
  type IWorldQuery,
  type NpcPersonality,
  type PedProfile,
  type VehicleOccupantRecord,
} from '@/gameplay/types';
import { PED_PROFILES } from '@/data';
import { random } from '@/utils/Random';
import { responseProfileForLevel } from '@/gameplay/police/PoliceResponseRules';
import { Pedestrian } from '@/entities/Pedestrian';
import { EntityCategory, type EntityManager } from '@/systems/EntityManager';

/** Radius (px) around a danger event within which pedestrians are alarmed. */
const ALARM_RADIUS = 260;

/** Minimum gap (ms) between successive spawn attempts, to smooth streaming. */
const SPAWN_INTERVAL_MS = 120;

/** How long (ms) a corpse lingers before it is despawned. */
const CORPSE_LINGER_MS = 9000;

/** Fraction of the spawn radius inside which we refuse to spawn (on-screen). */
const MIN_SPAWN_FACTOR = 0.5;

/** How many candidate sidewalk points to sample per spawn attempt. */
const SPAWN_ATTEMPTS = 12;
const PED_POOL_LIMIT = 128;
const CITY_ALERT_RADIUS = 620;
const CITY_ALERT_PULSE_MS = 3200;

export class PedestrianSystem extends BaseSceneManager {
  /** Service-locator key for this system. */
  public readonly key = ServiceKeys.Pedestrian;

  /** Physics group holding every live pedestrian sprite. */
  private pedGroup: Phaser.Physics.Arcade.Group | null = null;

  /** All currently live pedestrians, in spawn order. */
  private readonly peds: Pedestrian[] = [];
  private readonly pedPool = new Map<string, Pedestrian[]>();
  private pooledPedCount = 0;

  /** Timestamps (ms) at which each dead pedestrian died, for linger timing. */
  private readonly deadSince = new Map<number, number>();

  /** Rain umbrellas attached visually to pedestrians, keyed by entity id. */
  private readonly umbrellas = new Map<number, Phaser.GameObjects.Arc>();

  private weatherMode: WeatherMode = WeatherMode.Clear;

  /** Accumulated time (ms) since the last spawn attempt. */
  private spawnTimer = 0;
  private wantedLevel = 0;
  private alertPulseMs = 0;

  /** Create the scene-scoped physics group the crowd lives in. */
  protected onAttach(scene: Phaser.Scene): void {
    this.pedGroup = scene.physics.add.group();
    this.alertPulseMs = 0;
  }

  /** Tear down the crowd and release the group when leaving the scene. */
  protected onDetach(_scene: Phaser.Scene): void {
    this.clearUmbrellas();
    for (const ped of this.peds) {
      this.resolveEntityManager()?.unregister(ped);
      ped.destroy();
    }
    this.peds.length = 0;
    for (const bucket of this.pedPool.values()) {
      for (const ped of bucket) ped.destroy();
    }
    this.pedPool.clear();
    this.pooledPedCount = 0;
    this.deadSince.clear();
    this.pedGroup?.destroy(true);
    this.pedGroup = null;
    this.spawnTimer = 0;
    this.wantedLevel = 0;
    this.alertPulseMs = 0;
  }

  /** Subscribe to the danger events that make the crowd panic. */
  protected onInit(): void {
    this.subscribe(EventKeys.WeaponFired, (p) => this.alarmNear(p.x, p.y));
    this.subscribe(EventKeys.EntityKilled, (p) => this.alarmNear(p.position.x, p.position.y));
    this.subscribe(EventKeys.ExplosionSpawned, (p) => this.alarmNear(p.x, p.y));
    this.subscribe(EventKeys.WantedChanged, ({ level }) => {
      this.wantedLevel = level;
      this.alertPulseMs = 0;
      this.pulseCityAlert();
    });
    this.subscribe(EventKeys.WeatherChanged, (p) => {
      this.weatherMode = p.weather;
      if (!this.isWetWeather()) this.clearUmbrellas();
    });
  }

  /** The physics group containing every live pedestrian sprite. */
  public get group(): Phaser.Physics.Arcade.Group {
    if (!this.pedGroup) {
      throw new Error('PedestrianSystem.group accessed before attach.');
    }
    return this.pedGroup;
  }

  /** A snapshot of the currently live pedestrians. */
  public get pedestrians(): Pedestrian[] {
    return this.peds.slice();
  }

  /**
   * Spawn a normal pedestrian at an explicit world point. Used by real
   * interiors and ambient events that need the standard NPC system rather than
   * static decorative sprites.
   */
  public spawnAt(x: number, y: number): Pedestrian | null {
    return this.spawn({ x, y });
  }

  /** Spawn an authored service appearance while retaining pooling and shared AI. */
  public spawnProfileAt(x: number, y: number, profile: PedProfile): Pedestrian | null {
    return this.spawn({ x, y }, undefined, profile);
  }

  public spawnFromVehicleOccupant(
    occupant: VehicleOccupantRecord,
    x: number,
    y: number,
  ): Pedestrian | null {
    return this.spawn({ x, y }, occupant.personality);
  }

  /** Remove a pedestrian by id, used when emergency services load a victim. */
  public removeById(id: number): boolean {
    const index = this.peds.findIndex((ped) => ped.id === id);
    const ped = this.peds[index];
    if (!ped) return false;
    this.deadSince.delete(ped.id);
    this.resolveEntityManager()?.unregister(ped);
    this.umbrellas.get(ped.id)?.destroy();
    this.umbrellas.delete(ped.id);
    this.recyclePedestrian(ped);
    this.peds.splice(index, 1);
    return true;
  }

  /**
   * Advance the crowd: update every pedestrian, retire the distant/expired ones
   * and stream in replacements around the player.
   * @param time Absolute scene time in ms.
   * @param delta Elapsed time since the last frame in ms.
   */
  public update(time: number, delta: number): void {
    if (!this.pedGroup) return;

    const playerPos = getPlayerRef()?.playerPosition ?? null;
    if (responseProfileForLevel(this.wantedLevel).pedestrianPanic) {
      this.alertPulseMs -= delta;
      if (this.alertPulseMs <= 0) this.pulseCityAlert();
    }
    this.retire(time, playerPos);
    this.stream(delta, playerPos);
    this.updateUmbrellas();
  }

  /**
   * Spook every live pedestrian within {@link ALARM_RADIUS} of a danger point,
   * then give exactly one of them a chance to report the incident — rolling
   * the witness chance per-pedestrian instead would let one incident get
   * reported (and add heat) once per nearby pedestrian instead of once.
   * @param x World x of the danger source.
   * @param y World y of the danger source.
   */
  private alarmNear(x: number, y: number, radius = ALARM_RADIUS): void {
    const visit = (ped: Pedestrian): void => {
      if (!ped.isAlive) return;
      ped.alarm(x, y);
    };

    const entities = this.resolveEntityManager();
    if (entities) {
      entities.forEachNearby(
        x,
        y,
        radius,
        (entity) => {
          if (entity instanceof Pedestrian) visit(entity);
        },
        EntityCategory.Npc,
      );
    } else {
      const rangeSq = radius * radius;
      for (const ped of this.peds) {
        const pos = ped.position;
        if (Phaser.Math.Distance.Squared(x, y, pos.x, pos.y) <= rangeSq) visit(ped);
      }
    }
  }

  private pulseCityAlert(): void {
    if (!responseProfileForLevel(this.wantedLevel).pedestrianPanic) return;
    const player = getPlayerRef()?.playerPosition;
    if (!player) return;
    this.alertPulseMs = CITY_ALERT_PULSE_MS;
    this.alarmNear(player.x, player.y, CITY_ALERT_RADIUS);
  }

  /**
   * Remove pedestrians that have lingered as corpses past their fade time or
   * strayed beyond the despawn radius from the player.
   * @param time Absolute scene time in ms.
   * @param playerPos Current player position, or null if unavailable.
   */
  private retire(time: number, playerPos: Vector2 | null): void {
    const despawnSq = PED.DESPAWN_RADIUS * PED.DESPAWN_RADIUS;

    for (let i = this.peds.length - 1; i >= 0; i--) {
      const ped = this.peds[i];
      if (!ped) continue;

      let remove = false;
      if (ped.wantsDespawn) {
        // Finished fading out after walking into a building — remove now,
        // rather than lingering invisibly until the distance despawn catches it.
        remove = true;
      } else if (!ped.isAlive) {
        const since = this.deadSince.get(ped.id);
        if (since === undefined) {
          this.deadSince.set(ped.id, time);
        } else if (time - since >= CORPSE_LINGER_MS) {
          remove = true;
        }
      } else if (playerPos) {
        const pos = ped.position;
        if (Phaser.Math.Distance.Squared(playerPos.x, playerPos.y, pos.x, pos.y) > despawnSq) {
          remove = true;
        }
      }

      if (remove) {
        this.deadSince.delete(ped.id);
        this.resolveEntityManager()?.unregister(ped);
        this.umbrellas.get(ped.id)?.destroy();
        this.umbrellas.delete(ped.id);
        this.recyclePedestrian(ped);
        this.peds.splice(i, 1);
      }
    }
  }

  /**
   * Throttle-gated spawner: periodically tops the crowd back up to
   * {@link PED.MAX_ACTIVE} on sidewalk points just outside the player's view.
   * @param delta Elapsed time since the last frame in ms.
   * @param playerPos Current player position, or null if unavailable.
   */
  private stream(delta: number, playerPos: Vector2 | null): void {
    this.spawnTimer += delta;
    if (this.spawnTimer < SPAWN_INTERVAL_MS) return;
    this.spawnTimer = 0;

    if (!playerPos || this.peds.length >= this.activePopulationCap()) return;

    const point = this.findSpawnPoint(playerPos);
    if (point) this.spawn(point);
  }

  /**
   * Sample sidewalk points until one lands in the spawn ring: within
   * {@link PED.SPAWN_RADIUS} of the player but at least half that distance away,
   * so it appears off-screen.
   * @param playerPos Current player position.
   * @returns A valid spawn position, or null if none was found this frame.
   */
  private findSpawnPoint(playerPos: Vector2): Vector2 | null {
    const world = getWorldQuery();
    if (!world) return null;

    const maxSq = PED.SPAWN_RADIUS * PED.SPAWN_RADIUS;
    const minSq = (PED.SPAWN_RADIUS * MIN_SPAWN_FACTOR) ** 2;

    for (let attempt = 0; attempt < SPAWN_ATTEMPTS; attempt++) {
      const point =
        world.randomSidewalkPointNear(playerPos.x, playerPos.y, PED.SPAWN_RADIUS) ??
        world.randomSidewalkPoint();
      const distSq = Phaser.Math.Distance.Squared(playerPos.x, playerPos.y, point.x, point.y);
      if (distSq >= minSq && distSq <= maxSq) return point;
    }
    return null;
  }

  /** Time-of-day population demand: busy rush hours, thinner but alive nights. */
  private activePopulationCap(): number {
    const clock = ServiceLocator.tryResolve(ServiceKeys.DayNight) as { hour?: number } | null;
    const hour = clock?.hour ?? 12;
    const factor =
      hour >= 7 && hour <= 9
        ? 1.12
        : hour >= 16 && hour <= 19
          ? 1.18
          : hour >= 22 || hour < 5
            ? 0.52
            : hour >= 11 && hour <= 14
              ? 1
              : 0.82;
    const world = getWorldQuery() as
      | (IWorldQuery & {
          pedestrianDensityAt?(x: number, y: number): number;
        })
      | null;
    const position = getPlayerRef()?.playerPosition ?? null;
    const regionalDensity =
      position && world?.pedestrianDensityAt
        ? world.pedestrianDensityAt(position.x, position.y)
        : 1;
    const minimum = regionalDensity < 0.4 ? 18 : 34;
    return Phaser.Math.Clamp(
      Math.floor(PED.MAX_ACTIVE * factor * regionalDensity),
      minimum,
      Math.min(240, ENGINE_LIMITS.MAX_ACTIVE_NPCS),
    );
  }

  /** Visual rain reaction: most pedestrians carry a small umbrella while outside. */
  private updateUmbrellas(): void {
    if (!this.isWetWeather()) return;
    const scene = this.scene;
    if (!scene) return;
    const liveIds = new Set<number>();
    for (const ped of this.peds) {
      liveIds.add(ped.id);
      if (!ped.isAlive || ped.sprite.getData('interiorId') !== undefined) {
        this.umbrellas.get(ped.id)?.destroy();
        this.umbrellas.delete(ped.id);
        continue;
      }
      if (ped.id % 5 === 0) continue;
      let umbrella = this.umbrellas.get(ped.id);
      if (!umbrella) {
        const color = ped.id % 3 === 0 ? 0x3a6cff : ped.id % 3 === 1 ? 0xffcc33 : 0xe4405f;
        umbrella = scene.add.circle(ped.sprite.x, ped.sprite.y - 11, 11, color, 0.85);
        umbrella.setDepth(DepthLayers.Characters + 1);
        umbrella.setStrokeStyle(1, 0x111318, 0.65);
        this.umbrellas.set(ped.id, umbrella);
      }
      umbrella.setPosition(ped.sprite.x, ped.sprite.y - 11);
      umbrella.setVisible(ped.sprite.visible && ped.sprite.active);
    }

    for (const [id, umbrella] of Array.from(this.umbrellas)) {
      if (!liveIds.has(id)) {
        umbrella.destroy();
        this.umbrellas.delete(id);
      }
    }
  }

  private isWetWeather(): boolean {
    return this.weatherMode === WeatherMode.Rain || this.weatherMode === WeatherMode.Storm;
  }

  private clearUmbrellas(): void {
    for (const umbrella of this.umbrellas.values()) umbrella.destroy();
    this.umbrellas.clear();
  }

  /**
   * Instantiate a pedestrian from a random profile and enrol its sprite in the
   * crowd group.
   * @param point World position to spawn at.
   */
  private spawn(
    point: Vector2,
    personality?: NpcPersonality,
    profileOverride?: PedProfile,
  ): Pedestrian | null {
    const scene = this.scene;
    if (!scene || !this.pedGroup) return null;
    if (this.peds.length >= ENGINE_LIMITS.MAX_ACTIVE_NPCS) {
      EngineDiagnostics.recordLimitExceeded(
        'MAX_ACTIVE_NPCS',
        this.peds.length + 1,
        ENGINE_LIMITS.MAX_ACTIVE_NPCS,
        'rejected-pedestrian-spawn',
        'PedestrianSystem',
      );
      return null;
    }

    const baseProfile = profileOverride ?? random.pick(PED_PROFILES);
    const profile = baseProfile
      ? profileOverride
        ? baseProfile
        : this.profileForRegion(baseProfile, point)
      : null;
    if (!profile) return null;

    const bucket = this.pedPool.get(profile.id);
    const pooled = bucket?.pop();
    if (pooled) this.pooledPedCount -= 1;
    const ped = pooled ?? new Pedestrian(scene, point.x, point.y, profile, personality);
    if (pooled) ped.resetForReuse(point.x, point.y, profile, personality);
    this.pedGroup.add(ped.sprite);
    this.peds.push(ped);
    this.resolveEntityManager()?.register(ped, { category: EntityCategory.Npc });
    // Spawn points are usually in the medium tier. Seed a destination once so
    // movement-only LOD has an intent before the pedestrian first comes near.
    ped.ai.update(scene.time.now, 0);
    if (responseProfileForLevel(this.wantedLevel).pedestrianPanic) {
      const player = getPlayerRef()?.playerPosition;
      if (player) ped.alarm(player.x, player.y);
    }
    return ped;
  }

  private recyclePedestrian(ped: Pedestrian): void {
    this.pedGroup?.remove(ped.sprite, false, false);
    if (this.pooledPedCount >= PED_POOL_LIMIT) {
      ped.destroy();
      return;
    }
    ped.deactivateForPool();
    let bucket = this.pedPool.get(ped.profileId);
    if (!bucket) {
      bucket = [];
      this.pedPool.set(ped.profileId, bucket);
    }
    bucket.push(ped);
    this.pooledPedCount += 1;
  }

  /** Apply a subtle local wardrobe cast without changing the shared sprite catalogue. */
  private profileForRegion(profile: (typeof PED_PROFILES)[number], point: Vector2) {
    const world = getWorldQuery() as
      | (IWorldQuery & {
          cityAt?(x: number, y: number): { id: string } | null;
        })
      | null;
    const cityId = world?.cityAt?.(point.x, point.y)?.id;
    if (cityId === 'yazd') {
      return { ...profile, tint: profile.id.endsWith('0') ? 0xf3c98b : 0xe9b77a };
    }
    if (cityId === 'gilan') {
      return { ...profile, tint: profile.id.endsWith('0') ? 0x9dc7c6 : 0xa9c7df };
    }
    return profile;
  }

  private resolveEntityManager(): EntityManager | null {
    return ServiceLocator.tryResolve<EntityManager>(ServiceKeys.Entity);
  }
}
