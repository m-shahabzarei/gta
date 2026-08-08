/**
 * CityLifeSystem — the ambient-life director that makes the streets feel lived-in.
 *
 * Around the player it streams:
 *  - **Animals** (dogs, cats) that trot the sidewalks and bolt from danger,
 *    using the same wander/flee brain as pedestrians;
 *  - **Beat cops** that walk patrol routes at ease and fold into the pursuit
 *    once the player earns heat (they share the police AI);
 *  - **Bird flocks** that periodically flap across the view (pure scenery);
 *  - **Street fights**, breaking two nearby civilians into a brawl now and then.
 *
 * Animals and patrol cops live in a single Arcade {@link group} so the scene can
 * wire their world/bullet/run-over collisions once. Birds are display-only and
 * never participate in physics. Everything is bounded and streamed, so the
 * living city costs a fixed budget regardless of world size.
 */
import Phaser from 'phaser';
import { BaseSceneManager } from '@/core/BaseSceneManager';
import { ServiceLocator } from '@/core/ServiceLocator';
import { ServiceKeys } from '@/config/ServiceKeys';
import { EventKeys } from '@/config/EventKeys';
import { DepthLayers } from '@/config/DepthLayers';
import { TextureKeys } from '@/config/AssetKeys';
import { PED } from '@/config/Constants';
import type { Vector2 } from '@/core/types';
import { getPlayerRef, getWorldQuery } from '@/gameplay/types';
import { ANIMAL_PROFILES } from '@/data';
import { Animal } from '@/entities/Animal';
import { PoliceOfficer } from '@/entities/PoliceOfficer';
import { Pedestrian } from '@/entities/Pedestrian';
import { Random } from '@/utils';
import { EntityCategory, type EntityManager } from '@/systems/EntityManager';

/** Maximum simultaneous ambient animals. */
const MAX_ANIMALS = 12;

/** Maximum simultaneous ambient patrol cops. */
const MAX_PATROLS = 5;

/** Distance (px) beyond which ambient life is despawned. */
const DESPAWN_RADIUS = PED.DESPAWN_RADIUS + 120;

/** Gap (ms) between ambient spawn attempts. */
const SPAWN_INTERVAL_MS = 900;

/** Gap (ms) between bird-flock fly-bys. */
const BIRD_INTERVAL_MS = 7000;

/** Gap (ms) between street-fight checks. */
const FIGHT_INTERVAL_MS = 12000;

/** Gap (ms) between paired-conversation checks. */
const CONVERSATION_INTERVAL_MS = 9000;

/** Gap (ms) between help-injured pairing checks. */
const HELP_INTERVAL_MS = 5000;

/** How close two idle pedestrians must be to strike up a paired conversation. */
const CONVERSATION_PAIR_RADIUS = 70;

/** How close an idle pedestrian must be to a downed one to be picked as a helper. */
const HELP_PAIR_RADIUS = 200;

/** How long (ms) a downed animal / cop lingers as a corpse. */
const CORPSE_LINGER_MS = 8000;

/** Structural view of the pedestrian system for triggering brawls. */
interface CrowdProvider {
  pedestrians: Pedestrian[];
}

export class CityLifeSystem extends BaseSceneManager {
  /** Service-locator key for this system. */
  public readonly key = ServiceKeys.CityLife;

  /** Deterministic RNG for spawn placement + event rolls. */
  private readonly rng = new Random(0x11fe0);

  /** Arcade group holding animals + patrol cops. */
  private lifeGroup: Phaser.Physics.Arcade.Group | null = null;

  /** Live ambient animals. */
  private readonly animals: Animal[] = [];

  /** Live ambient patrol cops. */
  private readonly patrols: PoliceOfficer[] = [];

  /** Death timestamps for corpse linger, keyed by entity id. */
  private readonly deadSince = new Map<number, number>();

  private spawnTimer = 0;
  private birdTimer = 0;
  private fightTimer = 0;
  private conversationTimer = 0;
  private helpTimer = 0;

  /** Create the ambient-life physics group. */
  protected onAttach(scene: Phaser.Scene): void {
    this.lifeGroup = scene.physics.add.group();
    this.spawnTimer = 0;
    this.birdTimer = 0;
    this.fightTimer = 0;
    this.conversationTimer = 0;
    this.helpTimer = 0;
  }

  /** Tear down all ambient life on scene shutdown. */
  protected onDetach(_scene: Phaser.Scene): void {
    for (const a of this.animals) {
      this.resolveEntityManager()?.unregister(a);
      a.destroy();
    }
    for (const p of this.patrols) {
      this.resolveEntityManager()?.unregister(p);
      p.destroy();
    }
    this.animals.length = 0;
    this.patrols.length = 0;
    this.deadSince.clear();
    this.lifeGroup?.destroy(true);
    this.lifeGroup = null;
  }

  /** Wire nearby-danger alarms so animals bolt from gunfire and explosions. */
  protected onInit(): void {
    this.subscribe(EventKeys.WeaponFired, (p) => this.alarmNear(p.x, p.y));
    this.subscribe(EventKeys.ExplosionSpawned, (p) => this.alarmNear(p.x, p.y));
  }

  /** The physics group containing ambient animals + patrol cops. */
  public get group(): Phaser.Physics.Arcade.Group {
    if (!this.lifeGroup) {
      throw new Error('CityLifeSystem.group accessed before attach.');
    }
    return this.lifeGroup;
  }

  /** Advance ambient life: tick entities, retire, stream, and fire events. */
  public update(time: number, delta: number): void {
    if (!this.lifeGroup) return;
    const playerPos = getPlayerRef()?.playerPosition ?? null;
    this.retire(time, playerPos);
    this.stream(delta, playerPos);
    this.tickBirds(delta, playerPos);
    this.tickStreetFights(delta, playerPos);
    this.tickConversations(delta, playerPos);
    this.tickHelpInjured(delta, playerPos);
  }

  // ── Streaming ──────────────────────────────────────────────────────────────

  /** Retire distant survivors and lingered corpses. */
  private retire(time: number, playerPos: Vector2 | null): void {
    const despawnSq = DESPAWN_RADIUS * DESPAWN_RADIUS;

    const sweep = (list: { id: number; isAlive: boolean; position: Vector2; destroy(): void }[]): void => {
      for (let i = list.length - 1; i >= 0; i--) {
        const e = list[i];
        if (!e) continue;
        let remove = false;
        if (!e.isAlive) {
          const since = this.deadSince.get(e.id);
          if (since === undefined) this.deadSince.set(e.id, time);
          else if (time - since >= CORPSE_LINGER_MS) remove = true;
        } else if (playerPos) {
          const pos = e.position;
          if (Phaser.Math.Distance.Squared(playerPos.x, playerPos.y, pos.x, pos.y) > despawnSq) {
            remove = true;
          }
        }
        if (remove) {
          this.deadSince.delete(e.id);
          this.resolveEntityManager()?.unregister(e.id);
          e.destroy();
          list.splice(i, 1);
        }
      }
    };

    sweep(this.animals);
    sweep(this.patrols);
  }

  /** Top the ambient population up around the player. */
  private stream(delta: number, playerPos: Vector2 | null): void {
    this.spawnTimer += delta;
    if (this.spawnTimer < SPAWN_INTERVAL_MS) return;
    this.spawnTimer = 0;
    if (!playerPos) return;

    if (this.animals.length < MAX_ANIMALS && this.rng.chance(0.7)) {
      const point = this.spawnPoint(playerPos, false);
      if (point) this.spawnAnimal(point);
    }
    if (this.patrols.length < MAX_PATROLS && this.rng.chance(0.4)) {
      const point = this.spawnPoint(playerPos, false);
      if (point) this.spawnPatrol(point);
    }
  }

  /** Sample a walkable spawn point in the off-screen ring around the player. */
  private spawnPoint(playerPos: Vector2, _road: boolean): Vector2 | null {
    const world = getWorldQuery();
    if (!world) return null;
    const maxSq = PED.SPAWN_RADIUS * PED.SPAWN_RADIUS;
    const minSq = (PED.SPAWN_RADIUS * 0.5) ** 2;
    for (let i = 0; i < 6; i++) {
      const point =
        world.randomSidewalkPointNear(playerPos.x, playerPos.y, PED.SPAWN_RADIUS) ??
        world.randomSidewalkPoint();
      const distSq = Phaser.Math.Distance.Squared(playerPos.x, playerPos.y, point.x, point.y);
      if (distSq >= minSq && distSq <= maxSq) return point;
    }
    return null;
  }

  /** Spawn one ambient animal. */
  private spawnAnimal(point: Vector2): void {
    const scene = this.scene;
    if (!scene || !this.lifeGroup) return;
    const profile = this.rng.pick(ANIMAL_PROFILES);
    if (!profile) return;
    const animal = new Animal(scene, point.x, point.y, profile);
    this.lifeGroup.add(animal.sprite);
    this.animals.push(animal);
    this.resolveEntityManager()?.register(animal, { category: EntityCategory.Npc });
  }

  /** Spawn one ambient beat cop (patrols until the player earns heat). */
  private spawnPatrol(point: Vector2): void {
    const scene = this.scene;
    if (!scene || !this.lifeGroup) return;
    const officer = new PoliceOfficer(scene, point.x, point.y, 'officer', true);
    this.lifeGroup.add(officer.sprite);
    this.patrols.push(officer);
    this.resolveEntityManager()?.register(officer, { category: EntityCategory.Npc });
  }

  // ── Ambient events ─────────────────────────────────────────────────────────

  /** Periodically send a bird flock flapping across the view. */
  private tickBirds(delta: number, playerPos: Vector2 | null): void {
    this.birdTimer += delta;
    if (this.birdTimer < BIRD_INTERVAL_MS) return;
    this.birdTimer = 0;
    const scene = this.scene;
    if (!scene || !playerPos) return;

    const count = this.rng.intRange(3, 6);
    const dir = this.rng.chance(0.5) ? 1 : -1;
    const startX = playerPos.x - dir * 520;
    const baseY = playerPos.y + this.rng.range(-260, 260);
    for (let i = 0; i < count; i++) {
      const bird = scene.add.sprite(
        startX + this.rng.range(-40, 40),
        baseY + this.rng.range(-30, 30),
        TextureKeys.AnimalBird,
        'fly0',
      );
      bird.setDepth(DepthLayers.AirUnits);
      bird.setFlipX(dir < 0);
      // Flap by toggling the two frames while gliding across the view.
      scene.tweens.add({
        targets: bird,
        x: startX + dir * 1100,
        y: baseY + this.rng.range(-40, 40),
        duration: this.rng.range(3200, 4600),
        ease: 'Sine.easeInOut',
        onUpdate: () => {
          bird.setFrame(scene.time.now % 200 < 100 ? 'fly0' : 'fly1');
        },
        onComplete: () => bird.destroy(),
      });
    }
  }

  /** Occasionally break two nearby civilians into a street fight. */
  private tickStreetFights(delta: number, playerPos: Vector2 | null): void {
    this.fightTimer += delta;
    if (this.fightTimer < FIGHT_INTERVAL_MS) return;
    this.fightTimer = 0;
    if (!playerPos) return;

    const nearby = this.nearbyPedestrians(playerPos, 420, (ped) => ped.isAlive);
    if (nearby.length < 2) return;

    const a = this.rng.pick(nearby);
    const b = this.rng.pick(nearby.filter((p) => p !== a));
    if (!a || !b) return;
    a.ai.brawlWith(b);
    b.ai.brawlWith(a);
  }

  /** Occasionally pair up two nearby idle civilians into a paused, facing-each-other chat. */
  private tickConversations(delta: number, playerPos: Vector2 | null): void {
    this.conversationTimer += delta;
    if (this.conversationTimer < CONVERSATION_INTERVAL_MS) return;
    this.conversationTimer = 0;
    if (!playerPos) return;

    const candidates = this.nearbyPedestrians(
      playerPos,
      420,
      (ped) => ped.isAlive && ped.ai.isIdleAvailable,
    );
    if (candidates.length < 2) return;

    const pairRadiusSq = CONVERSATION_PAIR_RADIUS * CONVERSATION_PAIR_RADIUS;
    for (let i = 0; i < candidates.length; i++) {
      const a = candidates[i];
      if (!a) continue;
      for (let j = i + 1; j < candidates.length; j++) {
        const b = candidates[j];
        if (!b) continue;
        const distSq = Phaser.Math.Distance.Squared(a.position.x, a.position.y, b.position.x, b.position.y);
        if (distSq <= pairRadiusSq) {
          a.ai.talkWith(b.ai);
          b.ai.talkWith(a.ai);
          return;
        }
      }
    }
  }

  /** Occasionally route a nearby idle civilian to stand with a downed one. */
  private tickHelpInjured(delta: number, playerPos: Vector2 | null): void {
    this.helpTimer += delta;
    if (this.helpTimer < HELP_INTERVAL_MS) return;
    this.helpTimer = 0;
    if (!playerPos) return;

    const downed = this.nearbyPedestrians(
      playerPos,
      480,
      (ped) => ped.isAlive && ped.ai.isDowned,
    );
    const target = this.rng.pick(downed);
    if (!target) return;

    const helpers = this.nearbyPedestrians(
      target.position,
      HELP_PAIR_RADIUS,
      (ped) => ped !== target && ped.isAlive && ped.ai.isIdleAvailable,
    );
    const helper = this.rng.pick(helpers);
    if (!helper) return;
    helper.ai.helpInjured(target.ai);
  }

  private nearbyPedestrians(
    centre: Vector2,
    radius: number,
    predicate: (pedestrian: Pedestrian) => boolean,
  ): Pedestrian[] {
    const result: Pedestrian[] = [];
    const entities = this.resolveEntityManager();
    if (entities) {
      entities.forEachNearby(
        centre.x,
        centre.y,
        radius,
        (entity) => {
          if (entity instanceof Pedestrian && predicate(entity)) result.push(entity);
        },
        EntityCategory.Npc,
      );
      return result;
    }

    const crowd = ServiceLocator.tryResolve(
      ServiceKeys.Pedestrian,
    ) as unknown as CrowdProvider | null;
    const radiusSq = radius * radius;
    for (const ped of crowd?.pedestrians ?? []) {
      if (!predicate(ped)) continue;
      const pos = ped.position;
      if (Phaser.Math.Distance.Squared(centre.x, centre.y, pos.x, pos.y) <= radiusSq) {
        result.push(ped);
      }
    }
    return result;
  }

  /** Bolt every animal within range of a danger point. */
  private alarmNear(x: number, y: number): void {
    const rangeSq = 260 * 260;
    for (const animal of this.animals) {
      if (!animal.isAlive) continue;
      const pos = animal.position;
      if (Phaser.Math.Distance.Squared(x, y, pos.x, pos.y) <= rangeSq) {
        animal.alarm(x, y);
      }
    }
  }

  private resolveEntityManager(): EntityManager | null {
    return ServiceLocator.tryResolve<EntityManager>(ServiceKeys.Entity);
  }
}
