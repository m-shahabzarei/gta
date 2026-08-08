/**
 * Central lifecycle and adaptive update scheduler for every simulated entity.
 *
 * Gameplay systems own population policy (when to spawn/retire), while this
 * manager exclusively owns per-entity ticking, dynamic spatial indexing,
 * physics activation and camera visibility. No registered entity needs an
 * independent scene update hook.
 */
import Phaser from 'phaser';
import { BaseSceneManager } from '@/core/BaseSceneManager';
import { ServiceKeys } from '@/config/ServiceKeys';
import { ENGINE_LIMITS } from '@/config/EngineLimits';
import { EngineDiagnostics } from '@/core/EngineDiagnostics';
import type { Entity } from '@/entities/Entity';
import { getPlayerRef } from '@/gameplay/types';
import { SpatialHashGrid } from '@/utils';

export enum EntityCategory {
  Player = 'player',
  Npc = 'npc',
  Vehicle = 'vehicle',
  Projectile = 'projectile',
  Particle = 'particle',
  Object = 'object',
}

export enum SimulationTier {
  Near = 'near',
  Medium = 'medium',
  Far = 'far',
  VeryFar = 'very-far',
  Dormant = 'dormant',
}

export enum AiLodLevel {
  Full = 0,
  MovementOnly = 1,
  Simple = 2,
  Frozen = 3,
}

interface LodDistances {
  near: number;
  medium: number;
  far: number;
  veryFar: number;
  streaming: number;
  physics: number;
  render: number;
}

const DEFAULT_LOD: Readonly<Record<EntityCategory, LodDistances>> = {
  [EntityCategory.Player]: {
    near: Infinity,
    medium: Infinity,
    far: Infinity,
    veryFar: Infinity,
    streaming: Infinity,
    physics: Infinity,
    render: Infinity,
  },
  [EntityCategory.Npc]: {
    near: 300,
    medium: 700,
    far: 1200,
    veryFar: 1600,
    streaming: 2100,
    physics: 520,
    render: 1100,
  },
  [EntityCategory.Vehicle]: {
    near: 420,
    medium: 800,
    far: 1200,
    veryFar: 1600,
    streaming: 2300,
    physics: 720,
    render: 1300,
  },
  [EntityCategory.Projectile]: {
    near: 1000,
    medium: 1400,
    far: 1800,
    veryFar: 2200,
    streaming: 2600,
    physics: 1800,
    render: 1800,
  },
  [EntityCategory.Particle]: {
    near: 500,
    medium: 800,
    far: 1100,
    veryFar: 1400,
    streaming: 1700,
    physics: 0,
    render: 1000,
  },
  [EntityCategory.Object]: {
    near: 450,
    medium: 800,
    far: 1200,
    veryFar: 1600,
    streaming: 2000,
    physics: 500,
    render: 1200,
  },
};

const MOVEMENT_COMPONENTS = ['health', 'movement', 'animator', 'lights', 'effects'] as const;
const FROZEN_COMPONENTS = ['health'] as const;
const CAMERA_MARGIN = 96;
const SPATIAL_CELL_SIZE = 128;

export interface EntityScheduleOptions {
  category: EntityCategory;
  alwaysActive?: boolean;
  distances?: Partial<LodDistances>;
  updateFull?: (time: number, delta: number) => void;
  updateMovement?: (time: number, delta: number) => void;
  updateSimple?: (time: number, delta: number) => void;
  updateVeryFar?: (time: number, delta: number) => void;
  canSimulatePhysics?: () => boolean;
  canRender?: () => boolean;
  canUpdate?: () => boolean;
  onTierChanged?: (tier: SimulationTier, aiLod: AiLodLevel) => void;
}

interface ManagedEntity {
  readonly entity: Entity;
  readonly category: EntityCategory;
  alwaysActive: boolean;
  readonly distances: LodDistances;
  readonly updateFull: (time: number, delta: number) => void;
  readonly updateMovement: (time: number, delta: number) => void;
  readonly updateSimple: (time: number, delta: number) => void;
  readonly updateVeryFar: (time: number, delta: number) => void;
  readonly canSimulatePhysics: () => boolean;
  readonly canRender: () => boolean;
  readonly canUpdate: () => boolean;
  readonly onTierChanged: ((tier: SimulationTier, aiLod: AiLodLevel) => void) | null;
  tier: SimulationTier;
  lastUpdateAt: number;
  accumulatedDelta: number;
  visitFrame: number;
  registered: boolean;
}

export interface EntityManagerStats {
  total: number;
  active: number;
  sleeping: number;
  physicsBodies: number;
  byCategory: Record<EntityCategory, number>;
  byTier: Record<SimulationTier, number>;
  activeByCategory: Record<EntityCategory, number>;
  sleepingByCategory: Record<EntityCategory, number>;
}

export class EntityManager extends BaseSceneManager {
  public readonly key = ServiceKeys.Entity;

  private readonly records: ManagedEntity[] = [];
  private readonly byId = new Map<number, ManagedEntity>();
  private readonly spatial = new SpatialHashGrid<ManagedEntity>(SPATIAL_CELL_SIZE);
  private activeRecords: ManagedEntity[] = [];
  private nextActiveRecords: ManagedEntity[] = [];
  private readonly alwaysActiveRecords: ManagedEntity[] = [];
  private readonly categoryTotals = emptyCategoryCounts();
  private frame = 0;
  private statsValue: EntityManagerStats = emptyStats();
  private detailedProfiling = false;
  private readonly updateMsByCategory = emptyCategoryCounts();

  protected onInit(): void {}

  protected onAttach(_scene: Phaser.Scene): void {
    this.frame = 0;
  }

  protected override onDetach(_scene: Phaser.Scene): void {
    for (const record of this.records) this.applyActivation(record, false, false);
    this.records.length = 0;
    this.byId.clear();
    this.spatial.clear();
    this.activeRecords.length = 0;
    this.nextActiveRecords.length = 0;
    this.alwaysActiveRecords.length = 0;
    for (const category of Object.values(EntityCategory)) this.categoryTotals[category] = 0;
    this.statsValue = emptyStats();
    this.frame = 0;
  }

  public register(entity: Entity, options: EntityScheduleOptions): void {
    if (this.byId.has(entity.id)) return;
    const categoryLimit =
      options.category === EntityCategory.Npc
        ? ENGINE_LIMITS.MAX_ACTIVE_NPCS
        : options.category === EntityCategory.Vehicle
          ? ENGINE_LIMITS.MAX_ACTIVE_VEHICLES
          : null;
    if (categoryLimit !== null && this.categoryTotals[options.category] >= categoryLimit) {
      EngineDiagnostics.recordLimitExceeded(
        options.category === EntityCategory.Npc ? 'MAX_ACTIVE_NPCS' : 'MAX_ACTIVE_VEHICLES',
        this.categoryTotals[options.category] + 1,
        categoryLimit,
        'registered-over-category-limit',
        `entity:${entity.id}`,
      );
    }
    const defaults = DEFAULT_LOD[options.category];
    const distances: LodDistances = { ...defaults, ...options.distances };
    const record: ManagedEntity = {
      entity,
      category: options.category,
      alwaysActive: options.alwaysActive === true,
      distances,
      updateFull: options.updateFull ?? ((time, delta) => entity.update(time, delta)),
      updateMovement:
        options.updateMovement ??
        ((time, delta) => entity.updateComponents(time, delta, MOVEMENT_COMPONENTS)),
      updateSimple:
        options.updateSimple ??
        ((time, delta) => entity.updateComponents(time, delta, MOVEMENT_COMPONENTS)),
      updateVeryFar:
        options.updateVeryFar ??
        ((time, delta) => entity.updateComponents(time, delta, FROZEN_COMPONENTS)),
      canSimulatePhysics:
        options.canSimulatePhysics ??
        (() => {
          const state = entity as unknown as { isDead?: boolean; isDestroyed?: boolean };
          return state.isDead !== true && state.isDestroyed !== true;
        }),
      canRender: options.canRender ?? (() => entity.sprite.active),
      canUpdate: options.canUpdate ?? (() => entity.sprite.active),
      onTierChanged: options.onTierChanged ?? null,
      tier: SimulationTier.Dormant,
      lastUpdateAt: 0,
      accumulatedDelta: 0,
      visitFrame: 0,
      registered: true,
    };
    this.records.push(record);
    this.byId.set(entity.id, record);
    this.categoryTotals[record.category] += 1;
    if (record.alwaysActive) this.alwaysActiveRecords.push(record);
    this.spatial.insert(entity.id, record, entity.sprite.x, entity.sprite.y);
    // Registration is dormant by default. Directors run before this scheduler,
    // so nearby actors are activated later in the same engine step.
    this.applyActivation(record, false, false);
  }

  public unregister(entityOrId: Entity | number): boolean {
    const id = typeof entityOrId === 'number' ? entityOrId : entityOrId.id;
    const record = this.byId.get(id);
    if (!record) return false;
    record.registered = false;
    this.byId.delete(id);
    this.categoryTotals[record.category] = Math.max(0, this.categoryTotals[record.category] - 1);
    this.spatial.remove(id);
    const index = this.records.indexOf(record);
    if (index !== -1) {
      const last = this.records.pop();
      if (last && index < this.records.length) this.records[index] = last;
    }
    if (record.alwaysActive) {
      const alwaysIndex = this.alwaysActiveRecords.indexOf(record);
      if (alwaysIndex !== -1) this.alwaysActiveRecords.splice(alwaysIndex, 1);
    }
    return true;
  }

  public setAlwaysActive(entityOrId: Entity | number, alwaysActive: boolean): boolean {
    const id = typeof entityOrId === 'number' ? entityOrId : entityOrId.id;
    const record = this.byId.get(id);
    if (!record || record.alwaysActive === alwaysActive) return record !== undefined;
    record.alwaysActive = alwaysActive;
    if (alwaysActive) {
      this.alwaysActiveRecords.push(record);
    } else {
      const index = this.alwaysActiveRecords.indexOf(record);
      if (index !== -1) this.alwaysActiveRecords.splice(index, 1);
    }
    return true;
  }

  public update(time: number, delta: number): void {
    this.frame += 1;
    const player = getPlayerRef()?.playerPosition ?? null;
    const nextStats = mutableEmptyStats();
    nextStats.total = this.byId.size;
    nextStats.sleeping = nextStats.total;
    nextStats.byTier[SimulationTier.Dormant] = nextStats.total;
    for (const category of Object.values(EntityCategory)) {
      nextStats.byCategory[category] = this.categoryTotals[category];
      nextStats.sleepingByCategory[category] = this.categoryTotals[category];
    }
    if (this.detailedProfiling) {
      for (const category of Object.values(EntityCategory)) this.updateMsByCategory[category] = 0;
    }

    this.nextActiveRecords.length = 0;
    const processRecord = (record: ManagedEntity, distanceSq: number): void => {
      if (!record.registered || record.visitFrame === this.frame || !record.canUpdate()) return;
      const tier = record.alwaysActive ? SimulationTier.Near : this.tierFor(record, distanceSq);
      if (tier === SimulationTier.Dormant) return;
      record.visitFrame = this.frame;
      this.nextActiveRecords.push(record);
      const sprite = record.entity.sprite;
      if (!sprite.scene) return;
      const aiLod = aiLodFor(tier);
      if (tier !== record.tier) {
        record.tier = tier;
        record.onTierChanged?.(tier, aiLod);
      }

      const simulatePhysics =
        record.canSimulatePhysics() &&
        (record.alwaysActive || distanceSq <= record.distances.physics ** 2);
      const visible =
        record.canRender() &&
        (record.alwaysActive || distanceSq <= record.distances.render ** 2) &&
        this.inCamera(sprite.x, sprite.y);
      this.applyActivation(record, simulatePhysics, visible);

      record.accumulatedDelta = Math.min(1000, record.accumulatedDelta + delta);
      if (this.shouldUpdate(record, tier, time)) {
        const accumulated = record.accumulatedDelta;
        record.accumulatedDelta = 0;
        record.lastUpdateAt = time;
        try {
          if (this.detailedProfiling) {
            const startedAt = performance.now();
            this.tickRecord(record, tier, time, accumulated);
            this.updateMsByCategory[record.category] += performance.now() - startedAt;
          } else {
            this.tickRecord(record, tier, time, accumulated);
          }
          this.spatial.update(record.entity.id, sprite.x, sprite.y);
        } catch (error) {
          this.quarantineRecord(record, error);
          return;
        }
      }

      nextStats.byTier[SimulationTier.Dormant] -= 1;
      nextStats.byTier[tier] += 1;
      nextStats.active += 1;
      nextStats.sleeping -= 1;
      if (tier === SimulationTier.Near || tier === SimulationTier.Medium) {
        nextStats.activeByCategory[record.category] += 1;
        nextStats.sleepingByCategory[record.category] -= 1;
      }
      if (simulatePhysics) nextStats.physicsBodies += 1;
    };

    for (const record of this.alwaysActiveRecords) processRecord(record, 0);
    if (player) {
      this.spatial.forEachInRadius(
        player.x,
        player.y,
        this.maxStreamingDistance,
        (record, distanceSq) => {
          processRecord(record, distanceSq);
        },
      );
    }

    for (const record of this.activeRecords) {
      if (!record.registered || record.visitFrame === this.frame) continue;
      if (record.tier !== SimulationTier.Dormant) {
        record.tier = SimulationTier.Dormant;
        record.onTierChanged?.(SimulationTier.Dormant, AiLodLevel.Frozen);
      }
      if (record.entity.sprite.scene) this.applyActivation(record, false, false);
    }
    const previous = this.activeRecords;
    this.activeRecords = this.nextActiveRecords;
    this.nextActiveRecords = previous;
    this.statsValue = nextStats;
  }

  private readonly maxStreamingDistance = Math.max(
    ...Object.values(DEFAULT_LOD)
      .map((lod) => lod.streaming)
      .filter(Number.isFinite),
  );

  public forEachNearby(
    x: number,
    y: number,
    radius: number,
    visitor: (entity: Entity, distanceSq: number, category: EntityCategory) => void,
    category?: EntityCategory,
  ): void {
    this.spatial.forEachInRadius(x, y, radius, (record, distanceSq) => {
      if (record.tier === SimulationTier.Dormant) return;
      if (category !== undefined && record.category !== category) return;
      visitor(record.entity, distanceSq, record.category);
    });
  }

  public get stats(): EntityManagerStats {
    return this.statsValue;
  }

  public getEntity(id: number): Entity | null {
    return this.byId.get(id)?.entity ?? null;
  }

  public get tierCounts(): Readonly<Record<SimulationTier, number>> {
    return this.statsValue.byTier;
  }

  public setDetailedProfiling(enabled: boolean): void {
    this.detailedProfiling = enabled;
  }

  public updateTimeFor(category: EntityCategory): number {
    return this.updateMsByCategory[category];
  }

  private tierFor(record: ManagedEntity, distanceSq: number): SimulationTier {
    const lod = record.distances;
    if (distanceSq <= lod.near ** 2) return SimulationTier.Near;
    if (distanceSq <= lod.medium ** 2) return SimulationTier.Medium;
    if (distanceSq <= lod.far ** 2) return SimulationTier.Far;
    if (distanceSq <= lod.streaming ** 2) return SimulationTier.VeryFar;
    return SimulationTier.Dormant;
  }

  private shouldUpdate(record: ManagedEntity, tier: SimulationTier, time: number): boolean {
    switch (tier) {
      case SimulationTier.Near:
        return true;
      case SimulationTier.Medium:
        return (this.frame + record.entity.id) % 3 === 0;
      case SimulationTier.Far:
        return (this.frame + record.entity.id) % 10 === 0;
      case SimulationTier.VeryFar:
        return time - record.lastUpdateAt >= 1000;
      case SimulationTier.Dormant:
      default:
        return false;
    }
  }

  private tickRecord(
    record: ManagedEntity,
    tier: SimulationTier,
    time: number,
    delta: number,
  ): void {
    switch (tier) {
      case SimulationTier.Near:
        record.updateFull(time, delta);
        break;
      case SimulationTier.Medium:
        record.updateMovement(time, delta);
        break;
      case SimulationTier.Far:
        record.updateSimple(time, delta);
        break;
      case SimulationTier.VeryFar:
        record.updateVeryFar(time, delta);
        break;
      case SimulationTier.Dormant:
      default:
        break;
    }
  }

  private quarantineRecord(record: ManagedEntity, error: unknown): void {
    EngineDiagnostics.recordError(error, `entity-update:${record.category}`, this.key);
    EngineDiagnostics.recordRecovery(this.key, 'quarantined-entity-record');
    record.registered = false;
    this.byId.delete(record.entity.id);
    this.categoryTotals[record.category] = Math.max(0, this.categoryTotals[record.category] - 1);
    this.spatial.remove(record.entity.id);
    this.removeRecordReference(this.records, record);
    this.removeRecordReference(this.activeRecords, record);
    this.removeRecordReference(this.nextActiveRecords, record);
    if (record.alwaysActive) this.removeRecordReference(this.alwaysActiveRecords, record);
    if (record.entity.sprite.scene) this.applyActivation(record, false, false);
    console.error(`[EntityManager] quarantined entity ${record.entity.id}`, error);
  }

  private removeRecordReference(records: ManagedEntity[], record: ManagedEntity): void {
    const index = records.indexOf(record);
    if (index === -1) return;
    const last = records.pop();
    if (last && index < records.length) records[index] = last;
  }

  private applyActivation(record: ManagedEntity, simulatePhysics: boolean, visible: boolean): void {
    const sprite = record.entity.sprite;
    if (sprite.visible !== visible) sprite.setVisible(visible);
    const body = sprite.body as Phaser.Physics.Arcade.Body | null;
    if (!body || body.enable === simulatePhysics) return;
    if (simulatePhysics) body.reset(sprite.x, sprite.y);
    else body.setVelocity(0, 0);
    body.enable = simulatePhysics;
  }

  private inCamera(x: number, y: number): boolean {
    const view = this.scene?.cameras.main.worldView;
    if (!view) return true;
    return (
      x >= view.x - CAMERA_MARGIN &&
      x <= view.right + CAMERA_MARGIN &&
      y >= view.y - CAMERA_MARGIN &&
      y <= view.bottom + CAMERA_MARGIN
    );
  }
}

function aiLodFor(tier: SimulationTier): AiLodLevel {
  switch (tier) {
    case SimulationTier.Near:
      return AiLodLevel.Full;
    case SimulationTier.Medium:
      return AiLodLevel.MovementOnly;
    case SimulationTier.Far:
      return AiLodLevel.Simple;
    case SimulationTier.VeryFar:
    case SimulationTier.Dormant:
    default:
      return AiLodLevel.Frozen;
  }
}

function emptyCategoryCounts(): Record<EntityCategory, number> {
  return {
    [EntityCategory.Player]: 0,
    [EntityCategory.Npc]: 0,
    [EntityCategory.Vehicle]: 0,
    [EntityCategory.Projectile]: 0,
    [EntityCategory.Particle]: 0,
    [EntityCategory.Object]: 0,
  };
}

function emptyTierCounts(): Record<SimulationTier, number> {
  return {
    [SimulationTier.Near]: 0,
    [SimulationTier.Medium]: 0,
    [SimulationTier.Far]: 0,
    [SimulationTier.VeryFar]: 0,
    [SimulationTier.Dormant]: 0,
  };
}

function mutableEmptyStats(): EntityManagerStats {
  return {
    total: 0,
    active: 0,
    sleeping: 0,
    physicsBodies: 0,
    byCategory: emptyCategoryCounts(),
    byTier: emptyTierCounts(),
    activeByCategory: emptyCategoryCounts(),
    sleepingByCategory: emptyCategoryCounts(),
  };
}

function emptyStats(): EntityManagerStats {
  return mutableEmptyStats();
}
