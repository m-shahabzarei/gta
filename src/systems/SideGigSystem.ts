/**
 * SideGigSystem — the optional, repeatable vehicle gigs that live outside the
 * story-mission chain:
 *
 *  - **Taxi fares**: climb into a taxi and a passenger hails you; pick them up,
 *    then run them to a drop-off for a distance-scaled fare. Fares chain, so a
 *    good cabbie earns a steady wage.
 *  - **Street races**: interact at one of the checkered race flags scattered on
 *    the road network to start a checkpoint race against the clock; clear every
 *    gate in order before time runs out for a cash prize.
 *
 * Each gig drives the HUD through the shared objective/target/toast events, so
 * the same banner, compass arrow and minimap blip that serve story missions
 * serve the gigs too. All state is scene-scoped and every dependency is
 * resolved defensively, so the system degrades to a no-op when the player or
 * world service is unavailable.
 */
import Phaser from 'phaser';
import { BaseSceneManager } from '@/core/BaseSceneManager';
import { ServiceLocator } from '@/core/ServiceLocator';
import { ServiceKeys } from '@/config/ServiceKeys';
import { EventKeys } from '@/config/EventKeys';
import { DepthLayers } from '@/config/DepthLayers';
import { TextureKeys } from '@/config/AssetKeys';
import type { Vector2 } from '@/core/types';
import { getPlayerRef } from '@/gameplay/types';
import type { WorldManager } from '@/systems/WorldManager';
import type { Vehicle } from '@/entities/Vehicle';

/** Arrival radius (px) for a taxi passenger / drop-off / race checkpoint. */
const REACH_RADIUS = 60;

/** Squared arrival radius. */
const REACH_RADIUS_SQ = REACH_RADIUS * REACH_RADIUS;

/** Interaction range (px) to a race flag. */
const FLAG_RANGE = 52;

/** Base taxi fare, before distance. */
const FARE_BASE = 40;

/** Fare paid per 100px of drop-off distance. */
const FARE_PER_100PX = 14;

/** Cash prize for finishing a street race. */
const RACE_REWARD = 600;

/** Number of checkpoints in a street race. */
const RACE_CHECKPOINTS = 5;

/** Milliseconds granted per race checkpoint. */
const RACE_MS_PER_GATE = 16000;

/** A running taxi fare. */
interface TaxiFare {
  phase: 'pickup' | 'dropoff';
  target: Vector2;
  marker: Phaser.GameObjects.Sprite;
}

/** A running street race. */
interface Race {
  gates: Vector2[];
  index: number;
  timeMs: number;
  marker: Phaser.GameObjects.Sprite;
}

/** Minimal view of the player controller for reading the driven vehicle. */
interface DriverAccess {
  currentVehicle?: Vehicle | null;
}

export class SideGigSystem extends BaseSceneManager {
  /** Service-locator key for this system. */
  public readonly key = ServiceKeys.SideGig;

  /** Static race-flag sprites placed on the map. */
  private readonly flags: Phaser.GameObjects.Image[] = [];

  /** The active taxi fare, or `null`. */
  private taxi: TaxiFare | null = null;

  /** The active street race, or `null`. */
  private race: Race | null = null;

  /** Whether the player was in a taxi last frame (to detect boarding/leaving). */
  private wasInTaxi = false;

  /** Subscribe to interactions (race starts) and vehicle exit (fare cancel). */
  protected onInit(): void {
    this.subscribe(EventKeys.PlayerInteract, (p) => this.onInteract(p.x, p.y));
    this.subscribe(EventKeys.PlayerExitedVehicle, () => this.cancelTaxi('Fare cancelled'));
    this.subscribe(EventKeys.PlayerDied, () => this.abortAll());
    this.subscribe(EventKeys.PlayerBusted, () => this.abortAll());
  }

  /** Place the static race flags for the attached scene. */
  protected onAttach(scene: Phaser.Scene): void {
    const world = this.resolveWorld();
    for (const spot of world?.map.raceStarts ?? []) {
      const flag = scene.add.image(spot.x, spot.y, TextureKeys.RaceFlag);
      flag.setDepth(DepthLayers.GroundDetail);
      this.flags.push(flag);
    }
    this.wasInTaxi = false;
  }

  /** Tear down gig state on scene shutdown. */
  protected onDetach(_scene: Phaser.Scene): void {
    for (const flag of this.flags) flag.destroy();
    this.flags.length = 0;
    this.clearTaxiMarker();
    this.clearRaceMarker();
    this.taxi = null;
    this.race = null;
  }

  /** Per-frame: drive taxi fares and race timing. */
  public update(_time: number, delta: number): void {
    const playerPos = getPlayerRef()?.playerPosition ?? null;
    this.tickTaxi(playerPos);
    this.tickRace(delta, playerPos);
  }

  // ── Taxi ─────────────────────────────────────────────────────────────────────

  /** Offer/advance a taxi fare while the player drives a taxi. */
  private tickTaxi(playerPos: Vector2 | null): void {
    const inTaxi = this.isDrivingTaxi();

    // On boarding a taxi with no race running, offer the first fare.
    if (inTaxi && !this.wasInTaxi && !this.race && !this.taxi) {
      this.offerFare(playerPos);
    }
    this.wasInTaxi = inTaxi;

    const fare = this.taxi;
    if (!fare || !inTaxi || !playerPos) return;

    if (Phaser.Math.Distance.Squared(playerPos.x, playerPos.y, fare.target.x, fare.target.y) <= REACH_RADIUS_SQ) {
      if (fare.phase === 'pickup') {
        this.beginDropoff(fare, playerPos);
      } else {
        this.completeFare(fare, playerPos);
      }
    }
  }

  /** Offer a fresh fare: a passenger waiting nearby. */
  private offerFare(playerPos: Vector2 | null): void {
    const world = this.resolveWorld();
    const scene = this.scene;
    if (!world || !scene || !playerPos) return;

    const pickup = this.pointNear(playerPos, 200, 500, () => world.randomSidewalkPoint());
    if (!pickup) return;

    const marker = this.makeMarker(scene, pickup, 0x53d769);
    this.taxi = { phase: 'pickup', target: pickup, marker };
    this.bus.emit(EventKeys.MissionObjectiveChanged, { text: 'Taxi: collect the fare', progress: 0, total: 0 });
    this.bus.emit(EventKeys.MissionTargetChanged, { target: { ...pickup } });
    this.bus.emit(EventKeys.UIToast, { message: 'Taxi fare available — pick up the passenger' });
  }

  /** Passenger boarded — head for the drop-off. */
  private beginDropoff(fare: TaxiFare, playerPos: Vector2): void {
    const world = this.resolveWorld();
    const scene = this.scene;
    if (!world || !scene) {
      this.cancelTaxi('');
      return;
    }
    const dest = this.pointNear(playerPos, 400, 1100, () => world.randomRoadPoint());
    if (!dest) {
      this.cancelTaxi('');
      return;
    }
    fare.phase = 'dropoff';
    fare.target = dest;
    fare.marker.setPosition(dest.x, dest.y);
    fare.marker.setTint(0xffcc33);
    this.bus.emit(EventKeys.MissionObjectiveChanged, { text: 'Taxi: drop off the passenger', progress: 0, total: 0 });
    this.bus.emit(EventKeys.MissionTargetChanged, { target: { ...dest } });
    this.bus.emit(EventKeys.UIToast, { message: 'Passenger aboard — drive to the destination' });
  }

  /** Fare delivered — pay out and offer the next. */
  private completeFare(fare: TaxiFare, playerPos: Vector2): void {
    const dist = Phaser.Math.Distance.Between(playerPos.x, playerPos.y, fare.target.x, fare.target.y);
    const pay = Math.round(FARE_BASE + (dist / 100) * FARE_PER_100PX);
    this.rewardPlayer(pay);
    this.bus.emit(EventKeys.UIToast, { message: `Fare delivered! +$${pay}` });
    this.clearTaxiMarker();
    this.taxi = null;
    this.bus.emit(EventKeys.MissionTargetChanged, { target: null });
    // Chain into the next fare shortly.
    if (this.isDrivingTaxi()) {
      this.offerFare(playerPos);
    }
  }

  /** Abandon the current fare (left the taxi, died, …). */
  private cancelTaxi(message: string): void {
    if (!this.taxi) return;
    this.clearTaxiMarker();
    this.taxi = null;
    this.bus.emit(EventKeys.MissionTargetChanged, { target: null });
    if (message) this.bus.emit(EventKeys.UIToast, { message });
  }

  // ── Race ─────────────────────────────────────────────────────────────────────

  /** Start a race if the interaction landed on a race flag. */
  private onInteract(x: number, y: number): void {
    if (this.race) return;
    const world = this.resolveWorld();
    if (!world) return;
    for (const spot of world.map.raceStarts) {
      if (Phaser.Math.Distance.Squared(x, y, spot.x, spot.y) <= FLAG_RANGE * FLAG_RANGE) {
        this.startRace(spot);
        return;
      }
    }
  }

  /** Build a checkpoint race from a start flag. */
  private startRace(start: Vector2): void {
    const world = this.resolveWorld();
    const scene = this.scene;
    if (!world || !scene) return;

    const gates: Vector2[] = [];
    let from = start;
    for (let i = 0; i < RACE_CHECKPOINTS; i++) {
      const gate = this.pointNear(from, 260, 700, () => world.randomRoadPoint());
      if (!gate) break;
      gates.push(gate);
      from = gate;
    }
    if (gates.length === 0) return;

    const first = gates[0];
    if (!first) return;
    const marker = this.makeMarker(scene, first, 0x3a6cff);
    this.race = { gates, index: 0, timeMs: gates.length * RACE_MS_PER_GATE, marker };
    this.cancelTaxi('');
    this.bus.emit(EventKeys.MissionStarted, { missionId: 'race', title: 'Street Race' });
    this.bus.emit(EventKeys.MissionObjectiveChanged, {
      text: 'Race: hit the checkpoints',
      progress: 0,
      total: gates.length,
    });
    this.bus.emit(EventKeys.MissionTargetChanged, { target: { ...first } });
    this.bus.emit(EventKeys.UIToast, { message: 'Street race! Hit every checkpoint before time runs out' });
  }

  /** Advance the active race clock + checkpoint progress. */
  private tickRace(delta: number, playerPos: Vector2 | null): void {
    const race = this.race;
    if (!race) return;

    race.timeMs -= delta;
    if (race.timeMs <= 0) {
      this.failRace();
      return;
    }
    if (!playerPos) return;

    const gate = race.gates[race.index];
    if (!gate) {
      this.finishRace();
      return;
    }
    if (Phaser.Math.Distance.Squared(playerPos.x, playerPos.y, gate.x, gate.y) <= REACH_RADIUS_SQ) {
      race.index += 1;
      const next = race.gates[race.index];
      if (!next) {
        this.finishRace();
        return;
      }
      race.marker.setPosition(next.x, next.y);
      this.bus.emit(EventKeys.MissionObjectiveChanged, {
        text: 'Race: hit the checkpoints',
        progress: race.index,
        total: race.gates.length,
      });
      this.bus.emit(EventKeys.MissionTargetChanged, { target: { ...next } });
    }
  }

  /** Win the race: pay out and clear. */
  private finishRace(): void {
    this.rewardPlayer(RACE_REWARD);
    this.bus.emit(EventKeys.MissionCompleted, { missionId: 'race', reward: RACE_REWARD });
    this.bus.emit(EventKeys.UIToast, { message: `Race won! +$${RACE_REWARD}` });
    this.clearRaceMarker();
    this.race = null;
    this.bus.emit(EventKeys.MissionTargetChanged, { target: null });
  }

  /** Lose the race (time out). */
  private failRace(): void {
    this.bus.emit(EventKeys.MissionFailed, { missionId: 'race', reason: 'Out of time' });
    this.bus.emit(EventKeys.UIToast, { message: 'Race failed — out of time' });
    this.clearRaceMarker();
    this.race = null;
    this.bus.emit(EventKeys.MissionTargetChanged, { target: null });
  }

  // ── Shared helpers ─────────────────────────────────────────────────────────────

  /** Abort every gig (death / bust). */
  private abortAll(): void {
    this.cancelTaxi('');
    if (this.race) {
      this.clearRaceMarker();
      this.race = null;
      this.bus.emit(EventKeys.MissionTargetChanged, { target: null });
    }
  }

  /** Whether the player is currently driving a taxi. */
  private isDrivingTaxi(): boolean {
    const controller = ServiceLocator.tryResolve(
      ServiceKeys.Player,
    ) as unknown as DriverAccess | null;
    const vehicle = controller?.currentVehicle ?? null;
    return vehicle !== null && vehicle.def.kind === 'taxi' && !vehicle.isDestroyed;
  }

  /** Credit the player's wallet via the player controller. */
  private rewardPlayer(amount: number): void {
    const controller = ServiceLocator.tryResolve(ServiceKeys.Player) as unknown as {
      giveReward?(n: number): void;
    } | null;
    controller?.giveReward?.(amount);
  }

  /** Sample a point within a distance band from `from`. */
  private pointNear(
    from: Vector2,
    minDist: number,
    maxDist: number,
    sampler: () => Vector2,
  ): Vector2 | null {
    const minSq = minDist * minDist;
    const maxSq = maxDist * maxDist;
    for (let i = 0; i < 12; i++) {
      const point = sampler();
      const distSq = Phaser.Math.Distance.Squared(from.x, from.y, point.x, point.y);
      if (distSq >= minSq && distSq <= maxSq) return { x: point.x, y: point.y };
    }
    return null;
  }

  /** Create a pulsing objective marker sprite. */
  private makeMarker(scene: Phaser.Scene, at: Vector2, tint: number): Phaser.GameObjects.Sprite {
    const marker = scene.add.sprite(at.x, at.y, TextureKeys.MissionMarker);
    marker.setDepth(DepthLayers.GroundDetail);
    marker.setTint(tint);
    scene.tweens.add({
      targets: marker,
      scaleX: { from: 0.8, to: 1.25 },
      scaleY: { from: 0.8, to: 1.25 },
      alpha: { from: 0.6, to: 1 },
      duration: 650,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
    return marker;
  }

  /** Destroy the taxi marker if present. */
  private clearTaxiMarker(): void {
    if (this.taxi?.marker) {
      this.scene?.tweens.killTweensOf(this.taxi.marker);
      this.taxi.marker.destroy();
    }
  }

  /** Destroy the race marker if present. */
  private clearRaceMarker(): void {
    if (this.race?.marker) {
      this.scene?.tweens.killTweensOf(this.race.marker);
      this.race.marker.destroy();
    }
  }

  /** Resolve the world manager, or `null`. */
  private resolveWorld(): WorldManager | null {
    return ServiceLocator.tryResolve<WorldManager>(ServiceKeys.World);
  }
}
