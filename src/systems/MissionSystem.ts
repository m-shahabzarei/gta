/**
 * MissionSystem — the scene-bound director for the game's mission chain.
 *
 * It turns the world-agnostic {@link MISSIONS} catalogue into a live progression:
 * on scene attach it assigns each mission a marker position (drawn round-robin
 * from the generated city's building entrances, falling back to random road
 * points) and pulses a {@link TextureKeys.MissionMarker} sprite over the next
 * un-completed mission. When the player loiters on that marker it offers the
 * mission; pressing interact starts it. From there the system tracks the active
 * mission's objectives — reaching a destination, racking up player kills,
 * stealing a car, or surviving a timer — advancing through them and paying out a
 * reward on completion. Player death or a bust fails the run.
 *
 * All runtime state is kept separate from the imported definitions (which are
 * never mutated), every cross-system dependency is resolved defensively through
 * the {@link ServiceLocator}, and completed-mission ids are persisted through
 * {@link ISerializable} so progression survives a save/load cycle.
 */
import Phaser from 'phaser';
import { BaseSceneManager } from '@/core/BaseSceneManager';
import { ServiceLocator } from '@/core/ServiceLocator';
import { ServiceKeys } from '@/config/ServiceKeys';
import { EventKeys } from '@/config/EventKeys';
import { DepthLayers } from '@/config/DepthLayers';
import { TextureKeys } from '@/config/AssetKeys';
import { MISSIONS } from '@/data';
import type { ISerializable } from '@/core/interfaces';
import type { Json, Vector2 } from '@/core/types';
import {
  getPlayerRef,
  ObjectiveKind,
  type MapData,
  type MissionDef,
  type ObjectiveDef,
} from '@/gameplay/types';

/** Distance (px) within which a marker offers, and interaction starts, a mission. */
const OFFER_RADIUS = 60;

/** Squared offer radius, precomputed to avoid per-frame square roots. */
const OFFER_RADIUS_SQ = OFFER_RADIUS * OFFER_RADIUS;

/** Fallback trigger radius (px) for a GoTo objective that omits its own. */
const DEFAULT_GOTO_RADIUS = 70;

/**
 * Minimal structural view of the world manager consumed here. The concrete class
 * is resolved at runtime, so only the fields used are declared and every access
 * is guarded.
 */
interface MissionWorldProvider {
  /** The generated city description, if the world has finished building. */
  readonly map?: MapData;
  /** A random world position that lies on a road. */
  randomRoadPoint?(): Vector2;
}

/** Live, mutable state for the mission the player is currently running. */
interface ActiveMissionState {
  /** The (immutable) definition being played. */
  readonly def: MissionDef;
  /** Index of the objective currently being tracked. */
  objectiveIndex: number;
  /** Per-objective GoTo destinations, aligned to `def.objectives` (null otherwise). */
  readonly destinations: ReadonlyArray<Vector2 | null>;
  /** Player kills counted toward the current Eliminate objective. */
  killProgress: number;
  /** Player vehicle-kills counted toward the current DestroyVehicles objective. */
  vehicleProgress: number;
  /** Remaining time (ms) for the current Survive objective. */
  surviveRemainingMs: number;
  /** Remaining time (ms) on the mission's overall limit (0 = no limit). */
  missionTimeMs: number;
}

export class MissionSystem extends BaseSceneManager implements ISerializable {
  /** Service-locator key for this system. */
  public readonly key = ServiceKeys.Mission;

  /** Stable id under which mission progress is stored in a save file. */
  public readonly saveId = 'mission';

  /** Ids of every mission the player has completed. */
  private readonly completedIds = new Set<string>();

  /** Runtime marker position assigned to each mission id on attach. */
  private readonly markerPositions = new Map<string, Vector2>();

  /** The mission currently being played, or `null` when idle. */
  private active: ActiveMissionState | null = null;

  /** Id of the mission most recently offered, to debounce repeat offers. */
  private offeredId: string | null = null;

  /** The pulsing world marker for the next un-completed mission. */
  private marker: Phaser.GameObjects.Sprite | null = null;

  /** The marker's looping pulse tween. */
  private markerTween: Phaser.Tweens.Tween | null = null;

  /** Subscribe to the events that offer, progress and fail missions. */
  protected onInit(): void {
    this.subscribe(EventKeys.PlayerInteract, (p) => this.onInteract(p.x, p.y));
    this.subscribe(EventKeys.EntityKilled, (p) => this.onEntityKilled(p.byPlayer));
    this.subscribe(EventKeys.VehicleDestroyed, (p) => this.onVehicleDestroyed(p.byPlayer));
    this.subscribe(EventKeys.PlayerEnteredVehicle, () => this.onVehicleEntered());
    this.subscribe(EventKeys.PlayerDied, () => this.failMission('You died'));
    this.subscribe(EventKeys.PlayerBusted, () => this.failMission('Busted'));
    this.log.debug('mission system ready');
  }

  /** Assign marker positions and raise the pulsing marker for the next mission. */
  protected onAttach(scene: Phaser.Scene): void {
    this.active = null;
    this.offeredId = null;
    this.assignMarkerPositions();

    const marker = scene.add.sprite(0, 0, TextureKeys.MissionMarker);
    marker.setDepth(DepthLayers.GroundDetail);
    marker.setVisible(false);
    this.marker = marker;

    this.markerTween = scene.tweens.add({
      targets: marker,
      scaleX: { from: 0.8, to: 1.2 },
      scaleY: { from: 0.8, to: 1.2 },
      alpha: { from: 0.65, to: 1 },
      duration: 700,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });

    this.refreshMarker();
  }

  /** Release the marker and reset scene-scoped runtime state. */
  protected override onDetach(_scene: Phaser.Scene): void {
    this.markerTween?.remove();
    this.markerTween = null;
    this.marker?.destroy();
    this.marker = null;
    this.markerPositions.clear();
    this.active = null;
    this.offeredId = null;
  }

  /**
   * Per-frame tick: offer the nearest mission when idle, otherwise advance the
   * active mission's current objective.
   * @param _time Absolute scene time in ms (unused).
   * @param delta Elapsed time since the last frame in ms.
   */
  public update(_time: number, delta: number): void {
    const playerPos = getPlayerRef()?.playerPosition ?? null;
    if (this.active) {
      this.tickObjective(delta, playerPos);
    } else {
      this.tickOffer(playerPos);
    }
  }

  // ── Marker placement ──────────────────────────────────────────────────────────

  /**
   * Assign every mission a marker position: building entrances round-robin, then
   * a random road point, then the definition's own (world-agnostic) coordinates.
   */
  private assignMarkerPositions(): void {
    const world = this.resolveWorld();
    const entrances = world?.map?.buildingEntrances ?? [];

    MISSIONS.forEach((mission, index) => {
      let pos: Vector2 | null = null;

      if (entrances.length > 0) {
        const entrance = entrances[index % entrances.length];
        if (entrance) {
          pos = { x: entrance.x, y: entrance.y };
        }
      }
      if (!pos) {
        pos = this.randomRoadPoint();
      }
      if (!pos) {
        pos = { x: mission.markerX, y: mission.markerY };
      }

      this.markerPositions.set(mission.id, pos);
    });
  }

  /** Show/hide and reposition the marker to the next un-completed mission. */
  private refreshMarker(): void {
    const marker = this.marker;
    if (!marker) {
      return;
    }
    if (this.active) {
      marker.setVisible(false);
      return;
    }
    const mission = this.nextMission();
    const pos = mission ? this.markerPositions.get(mission.id) : undefined;
    if (!mission || !pos) {
      marker.setVisible(false);
      return;
    }
    marker.setPosition(pos.x, pos.y);
    marker.setVisible(true);
  }

  /** Current mission marker used by the world map overlay, if any. */
  public get currentMapMarker(): Vector2 | null {
    if (this.active) {
      const dest = this.active.destinations[this.active.objectiveIndex] ?? null;
      if (dest) {
        return { x: dest.x, y: dest.y };
      }
    }
    const mission = this.nextMission();
    const pos = mission ? this.markerPositions.get(mission.id) : undefined;
    return pos ? { x: pos.x, y: pos.y } : null;
  }

  // ── Offering & starting ───────────────────────────────────────────────────────

  /**
   * Offer the next un-completed mission once the player is on its marker, emitting
   * an offer + prompt exactly once per approach.
   * @param playerPos Current player position, or null if unavailable.
   */
  private tickOffer(playerPos: Vector2 | null): void {
    if (!playerPos) {
      return;
    }
    const mission = this.nextMission();
    const pos = mission ? this.markerPositions.get(mission.id) : undefined;
    if (!mission || !pos) {
      this.offeredId = null;
      return;
    }

    const within =
      Phaser.Math.Distance.Squared(playerPos.x, playerPos.y, pos.x, pos.y) <= OFFER_RADIUS_SQ;

    if (within) {
      if (this.offeredId !== mission.id) {
        this.offeredId = mission.id;
        this.bus.emit(EventKeys.MissionOffered, { missionId: mission.id, title: mission.title });
        this.bus.emit(EventKeys.UIToast, { message: `Press E to start ${mission.title}` });
      }
    } else if (this.offeredId === mission.id) {
      this.offeredId = null;
    }
  }

  /**
   * Handle an interaction: start the offered mission when the interaction lands on
   * its marker.
   * @param x World x of the interaction.
   * @param y World y of the interaction.
   */
  private onInteract(x: number, y: number): void {
    if (this.active) {
      return;
    }
    const mission = this.nextMission();
    const pos = mission ? this.markerPositions.get(mission.id) : undefined;
    if (!mission || !pos) {
      return;
    }
    if (Phaser.Math.Distance.Squared(x, y, pos.x, pos.y) <= OFFER_RADIUS_SQ) {
      this.startMission(mission);
    }
  }

  /**
   * Begin a mission: resolve live GoTo destinations, prime the first objective and
   * announce the start.
   * @param def The mission definition to play.
   */
  private startMission(def: MissionDef): void {
    const destinations = def.objectives.map((objective) =>
      objective.kind === ObjectiveKind.GoTo ? this.randomRoadPoint() : null,
    );

    const state: ActiveMissionState = {
      def,
      objectiveIndex: 0,
      destinations,
      killProgress: 0,
      vehicleProgress: 0,
      surviveRemainingMs: 0,
      missionTimeMs: def.timeLimitMs ?? 0,
    };
    this.active = state;
    this.offeredId = null;

    this.bus.emit(EventKeys.MissionStarted, { missionId: def.id, title: def.title });
    this.bus.emit(EventKeys.UIToast, { message: `Mission started: ${def.title}` });
    this.refreshMarker();

    const first = def.objectives[0];
    if (!first) {
      this.completeMission();
      return;
    }
    this.initObjective(state, first);
    this.emitObjective(first, this.objectiveProgress(state, first), this.objectiveTotal(first));
    this.emitTarget(state);
  }

  // ── Objective tracking ────────────────────────────────────────────────────────

  /** The objective the active mission is currently tracking, or `null`. */
  private get currentObjective(): ObjectiveDef | null {
    const state = this.active;
    if (!state) {
      return null;
    }
    return state.def.objectives[state.objectiveIndex] ?? null;
  }

  /**
   * Advance the timed/positional objectives that are evaluated each frame.
   * @param delta Elapsed time since the last frame in ms.
   * @param playerPos Current player position, or null if unavailable.
   */
  private tickObjective(delta: number, playerPos: Vector2 | null): void {
    const state = this.active;
    const objective = this.currentObjective;
    if (!state || !objective) {
      return;
    }

    // Overall mission time limit (if any) runs down across all objectives.
    if (state.missionTimeMs > 0) {
      state.missionTimeMs -= delta;
      if (state.missionTimeMs <= 0) {
        this.failMission('Out of time');
        return;
      }
    }

    if (objective.kind === ObjectiveKind.Survive) {
      state.surviveRemainingMs -= delta;
      if (state.surviveRemainingMs <= 0) {
        state.surviveRemainingMs = 0;
        this.advanceObjective();
      }
    } else if (objective.kind === ObjectiveKind.GoTo) {
      if (!playerPos) {
        return;
      }
      const dest = state.destinations[state.objectiveIndex] ?? null;
      if (!dest) {
        this.advanceObjective();
        return;
      }
      const radius = objective.radius ?? DEFAULT_GOTO_RADIUS;
      const distSq = Phaser.Math.Distance.Squared(playerPos.x, playerPos.y, dest.x, dest.y);
      if (distSq <= radius * radius) {
        this.advanceObjective();
      }
    }
  }

  /**
   * Count a kill toward the current Eliminate objective.
   * @param byPlayer Whether the kill was ultimately caused by the player.
   */
  private onEntityKilled(byPlayer: boolean): void {
    if (!byPlayer) {
      return;
    }
    const state = this.active;
    const objective = this.currentObjective;
    if (!state || !objective || objective.kind !== ObjectiveKind.Eliminate) {
      return;
    }

    state.killProgress += 1;
    const total = objective.target ?? 1;
    if (state.killProgress >= total) {
      this.advanceObjective();
    } else {
      this.emitObjective(objective, state.killProgress, total);
    }
  }

  /** Satisfy the current StealVehicle objective when the player boards a car. */
  private onVehicleEntered(): void {
    const objective = this.currentObjective;
    if (!this.active || !objective || objective.kind !== ObjectiveKind.StealVehicle) {
      return;
    }
    this.advanceObjective();
  }

  /**
   * Count a vehicle destruction toward the current DestroyVehicles objective.
   * @param byPlayer Whether the destruction was caused by the player.
   */
  private onVehicleDestroyed(byPlayer: boolean): void {
    if (!byPlayer) {
      return;
    }
    const state = this.active;
    const objective = this.currentObjective;
    if (!state || !objective || objective.kind !== ObjectiveKind.DestroyVehicles) {
      return;
    }
    state.vehicleProgress += 1;
    const total = objective.target ?? 1;
    if (state.vehicleProgress >= total) {
      this.advanceObjective();
    } else {
      this.emitObjective(objective, state.vehicleProgress, total);
    }
  }

  /** Move to the next objective, or complete the mission when none remain. */
  private advanceObjective(): void {
    const state = this.active;
    if (!state) {
      return;
    }

    state.objectiveIndex += 1;
    const next = state.def.objectives[state.objectiveIndex];
    if (!next) {
      this.completeMission();
      return;
    }

    this.initObjective(state, next);
    this.emitObjective(next, this.objectiveProgress(state, next), this.objectiveTotal(next));
    this.emitTarget(state);
  }

  /**
   * Reset the per-objective counters as an objective becomes current.
   * @param state The active mission state.
   * @param objective The objective now being tracked.
   */
  private initObjective(state: ActiveMissionState, objective: ObjectiveDef): void {
    if (objective.kind === ObjectiveKind.Survive) {
      state.surviveRemainingMs = objective.target ?? 0;
    } else if (objective.kind === ObjectiveKind.Eliminate) {
      state.killProgress = 0;
    } else if (objective.kind === ObjectiveKind.DestroyVehicles) {
      state.vehicleProgress = 0;
    }
  }

  /**
   * Emit the world position the HUD compass/minimap should point at for the
   * active objective: the GoTo destination, or null for non-positional ones.
   * @param state The active mission state.
   */
  private emitTarget(state: ActiveMissionState): void {
    const dest = state.destinations[state.objectiveIndex] ?? null;
    this.bus.emit(EventKeys.MissionTargetChanged, {
      target: dest ? { x: dest.x, y: dest.y } : null,
    });
  }

  // ── Completion & failure ──────────────────────────────────────────────────────

  /** Complete the active mission: pay out, mark done and advance the marker. */
  private completeMission(): void {
    const state = this.active;
    if (!state) {
      return;
    }
    const { id, title, reward } = state.def;

    this.completedIds.add(id);
    this.active = null;
    this.offeredId = null;

    this.bus.emit(EventKeys.MissionTargetChanged, { target: null });
    this.bus.emit(EventKeys.MissionCompleted, { missionId: id, reward });
    this.bus.emit(EventKeys.UIToast, { message: `Mission complete: ${title} (+$${reward})` });
    this.refreshMarker();
  }

  /**
   * Fail the active mission (if any) and surface the reason.
   * @param reason Short player-facing failure reason.
   */
  private failMission(reason: string): void {
    const state = this.active;
    if (!state) {
      return;
    }
    const { id, title } = state.def;

    this.active = null;
    this.offeredId = null;

    this.bus.emit(EventKeys.MissionTargetChanged, { target: null });
    this.bus.emit(EventKeys.MissionFailed, { missionId: id, reason });
    this.bus.emit(EventKeys.UIToast, { message: `Mission failed: ${title}` });
    this.refreshMarker();
  }

  // ── Progress reporting ────────────────────────────────────────────────────────

  /**
   * Emit an objective-changed event for the HUD.
   * @param objective The objective now being reported.
   * @param progress Units completed so far.
   * @param total Units required to satisfy the objective.
   */
  private emitObjective(objective: ObjectiveDef, progress: number, total: number): void {
    this.bus.emit(EventKeys.MissionObjectiveChanged, {
      text: objective.description,
      progress,
      total,
    });
  }

  /**
   * The completion target for an objective (kills for Eliminate, ms for Survive,
   * a single step otherwise).
   * @param objective The objective to size.
   */
  private objectiveTotal(objective: ObjectiveDef): number {
    switch (objective.kind) {
      case ObjectiveKind.Eliminate:
      case ObjectiveKind.DestroyVehicles:
        return objective.target ?? 1;
      case ObjectiveKind.Survive:
        return objective.target ?? 0;
      default:
        return 1;
    }
  }

  /**
   * Current progress toward an objective, matching {@link objectiveTotal}'s units.
   * @param state The active mission state.
   * @param objective The objective to measure.
   */
  private objectiveProgress(state: ActiveMissionState, objective: ObjectiveDef): number {
    switch (objective.kind) {
      case ObjectiveKind.Eliminate:
        return state.killProgress;
      case ObjectiveKind.DestroyVehicles:
        return state.vehicleProgress;
      case ObjectiveKind.Survive:
        return (objective.target ?? 0) - state.surviveRemainingMs;
      default:
        return 0;
    }
  }

  // ── Mission selection & world resolution ──────────────────────────────────────

  /** The first mission not yet completed, or `null` when all are done. */
  private nextMission(): MissionDef | null {
    for (const mission of MISSIONS) {
      if (!this.completedIds.has(mission.id)) {
        return mission;
      }
    }
    return null;
  }

  /** A random road point from the world query, or `null` when unavailable. */
  private randomRoadPoint(): Vector2 | null {
    const world = this.resolveWorld();
    if (world && typeof world.randomRoadPoint === 'function') {
      const point = world.randomRoadPoint();
      return { x: point.x, y: point.y };
    }
    return null;
  }

  /** Resolve the world manager as its structural mission view, or `null`. */
  private resolveWorld(): MissionWorldProvider | null {
    const service = ServiceLocator.tryResolve(ServiceKeys.World);
    return service ? (service as unknown as MissionWorldProvider) : null;
  }

  // ── ISerializable ─────────────────────────────────────────────────────────────

  /** Snapshot the set of completed mission ids. */
  public serialize(): Json {
    return { completedIds: Array.from(this.completedIds) };
  }

  /**
   * Restore completed-mission progress from a snapshot. Any active run is dropped
   * and the marker re-seated; malformed data is ignored field by field so a
   * corrupt save can never crash the load.
   * @param data A value previously returned by {@link serialize}.
   */
  public deserialize(data: Json): void {
    this.completedIds.clear();
    this.active = null;
    this.offeredId = null;

    if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
      const ids = (data as { [key: string]: Json }).completedIds;
      if (Array.isArray(ids)) {
        for (const id of ids) {
          if (typeof id === 'string') {
            this.completedIds.add(id);
          }
        }
      }
    }

    this.refreshMarker();
  }
}
