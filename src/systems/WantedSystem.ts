import Phaser from 'phaser';
import { BaseSceneManager } from '@/core/BaseSceneManager';
import { ServiceLocator } from '@/core/ServiceLocator';
import { ServiceKeys } from '@/config/ServiceKeys';
import { EventKeys } from '@/config/EventKeys';
import { DepthLayers } from '@/config/DepthLayers';
import { TextureKeys } from '@/config/AssetKeys';
import { ENGINE_LIMITS } from '@/config/EngineLimits';
import { CRIME, PLAYER, WANTED } from '@/config/Constants';
import type { Json, Vector2 } from '@/core/types';
import type { ISerializable } from '@/core/interfaces';
import {
  type CrimeReport,
  type CompletedVehicleExit,
  type IWantedService,
  type PoliceDirective,
  type VehicleOccupantRecord,
  type WantedPhase,
  getPlayerRef,
  ENTITY_DATA_KEY,
} from '@/gameplay/types';
import {
  CRIME_HEAT,
  WANTED_HEAT_THRESHOLDS,
  desiredWantedLevel,
  nextWantedLevel,
} from '@/gameplay/crime/CrimeRules';
import {
  responseProfileForLevel,
  type PoliceResponseProfile,
  type PoliceUnitRole,
} from '@/gameplay/police/PoliceResponseRules';
import { roleForResponseSlot } from '@/gameplay/police/PoliceResponseRules';
import { planRoadblock as selectRoadblock } from '@/gameplay/police/RoadblockPlanner';
import { PoliceOfficer } from '@/entities/PoliceOfficer';
import { Helicopter, HELICOPTER_SIGHT_RANGE } from '@/entities/Helicopter';
import type { Vehicle } from '@/entities/Vehicle';
import type { VehicleSystem } from '@/systems/VehicleSystem';
import type { VehicleOccupantSystem } from '@/systems/VehicleOccupantSystem';
import type { TrafficSystem } from '@/systems/TrafficSystem';
import type { NavigationSystem } from '@/systems/NavigationSystem';
import type { WorldManager } from '@/systems/WorldManager';
import { EntityCategory, type EntityManager } from '@/systems/EntityManager';

type PatrolState =
  | 'patrol'
  | 'responding'
  | 'deploying'
  | 'engaging'
  | 'searching'
  | 'roadblock'
  | 'returning'
  | 'disabled';

interface DeployedOfficer {
  actor: PoliceOfficer;
  occupant: VehicleOccupantRecord;
  unitVehicleId: number;
  cover: Vector2;
  boarding: boolean;
  deadAt: number | null;
}

interface PatrolUnit {
  vehicle: Vehicle;
  role: PoliceUnitRole | 'patrol';
  state: PatrolState;
  target: Vector2 | null;
  stateSince: number;
  expectedCrew: number;
  officers: Map<number, DeployedOfficer>;
  searchIndex: number;
  nextSearchAt: number;
  assignedIncidentId: number | null;
  roadblockSpikes: Phaser.GameObjects.Image[];
  roadblockBarriers: Phaser.GameObjects.Image[];
  roadblockNodeId: number | null;
  roadblockHeading: number;
  obstacleId: string | null;
}

const DEFAULT_DIRECTIVE: PoliceDirective = {
  mode: 'patrol',
  target: null,
  cover: null,
  allowLethalForce: false,
  vehicleId: null,
};

const FLEET_CHECK_MS = 3200;
const RESPONSE_STOP_RANGE = 88;
const SEARCH_RETARGET_MS = 4200;
const BOARD_RANGE = 30;
const OFFICER_LINGER_MS = 8000;
const ROADBLOCK_MIN_DISTANCE = 460;
const ROADBLOCK_MAX_DISTANCE = 920;
const STATION_DISPATCH_ACTIVE_RADIUS = 1100;
const OFFICER_EXIT_SEARCH_RADIUS = 96;

/** Police awareness and real-unit lifecycle director. */
export class WantedSystem extends BaseSceneManager implements IWantedService, ISerializable {
  public readonly key = ServiceKeys.Wanted;
  public readonly saveId = 'wanted';

  private wantedLevel = 0;
  private heat = 0;
  private phaseValue: WantedPhase = 'clear';
  private lastKnownPosition: Vector2 | null = null;
  private lastKnownVelocity: Vector2 = { x: 0, y: 0 };
  private lastSightAt = -Infinity;
  private escalationElapsed = 0;
  private searchElapsed = 0;
  private fleetElapsed = FLEET_CHECK_MS;
  private nextWaveAt = Infinity;
  private lastWaveAt = -Infinity;
  private waveIndex = 0;
  private armedSuspect = false;
  private now = 0;
  private stationIndex = 0;

  private policeGroup: Phaser.Physics.Arcade.Group | null = null;
  private aircraftGroup: Phaser.Physics.Arcade.Group | null = null;
  private spikeGroup: Phaser.Physics.Arcade.Group | null = null;
  private barrierGroup: Phaser.Physics.Arcade.StaticGroup | null = null;
  private readonly units = new Map<number, PatrolUnit>();
  private readonly deployed = new Map<number, DeployedOfficer>();
  private readonly looseOfficers = new Map<number, PoliceOfficer>();
  private readonly directives = new Map<number, PoliceDirective>();
  private readonly processedReports = new Set<number>();
  private helicopter: Helicopter | null = null;

  protected onInit(): void {
    this.subscribe(EventKeys.CrimeReported, (report) => this.receiveReport(report));
    this.subscribe(EventKeys.VehicleRemoved, ({ vehicleId }) => this.removeUnit(vehicleId));
    this.subscribe(EventKeys.PlayerDied, () => this.clearWanted());
  }

  protected onAttach(scene: Phaser.Scene): void {
    this.policeGroup = scene.physics.add.group();
    this.aircraftGroup = scene.physics.add.group({ allowGravity: false });
    this.spikeGroup = scene.physics.add.group({ allowGravity: false, immovable: true });
    this.barrierGroup = scene.physics.add.staticGroup();
    this.now = scene.time.now;
    this.registerPatrolVehicles();
  }

  protected onDetach(_scene: Phaser.Scene): void {
    this.removeHelicopter();
    for (const officer of this.deployed.values()) {
      this.entityManager()?.unregister(officer.actor);
      officer.actor.destroy();
    }
    this.deployed.clear();
    for (const unit of this.units.values()) this.clearRoadblock(unit);
    this.units.clear();
    this.directives.clear();
    for (const id of this.looseOfficers.keys()) this.entityManager()?.setAlwaysActive(id, false);
    this.looseOfficers.clear();
    this.processedReports.clear();
    this.policeGroup?.destroy(true);
    this.aircraftGroup?.destroy(true);
    this.spikeGroup?.destroy(true);
    this.barrierGroup?.destroy(true);
    this.policeGroup = null;
    this.aircraftGroup = null;
    this.spikeGroup = null;
    this.barrierGroup = null;
    this.resetAwareness();
  }

  public get group(): Phaser.Physics.Arcade.Group {
    if (!this.policeGroup) throw new Error('WantedSystem.group accessed before attach.');
    return this.policeGroup;
  }

  public get airGroup(): Phaser.Physics.Arcade.Group {
    if (!this.aircraftGroup) throw new Error('WantedSystem.airGroup accessed before attach.');
    return this.aircraftGroup;
  }

  public get hazardGroup(): Phaser.Physics.Arcade.Group {
    if (!this.spikeGroup) throw new Error('WantedSystem.hazardGroup accessed before attach.');
    return this.spikeGroup;
  }

  public get blockadeGroup(): Phaser.Physics.Arcade.StaticGroup {
    if (!this.barrierGroup) throw new Error('WantedSystem.blockadeGroup accessed before attach.');
    return this.barrierGroup;
  }

  public get level(): number {
    return this.wantedLevel;
  }

  public get isSearching(): boolean {
    return this.phaseValue === 'searching' || this.phaseValue === 'cooldown';
  }

  public get phase(): WantedPhase {
    return this.phaseValue;
  }

  public get knownSuspectPosition(): Vector2 | null {
    return this.lastKnownPosition ? { ...this.lastKnownPosition } : null;
  }

  public debugSnapshot(): {
    level: number;
    heat: number;
    phase: WantedPhase;
    patrols: number;
    deployedOfficers: number;
    activeResponders: number;
    primaryUnitState: string;
    primaryOfficerState: string;
    responseProfile: PoliceResponseProfile;
    states: Record<PatrolState, number>;
    roles: Record<PoliceUnitRole, number>;
    patrolVehicles: number;
    activePoliceUnits: number;
    roadblocksActive: number;
    helicopterActive: boolean;
    helicopterState: string;
    waveIndex: number;
    lastWaveMs: number;
    nextWaveMs: number;
  } {
    const states: Record<PatrolState, number> = {
      patrol: 0,
      responding: 0,
      deploying: 0,
      engaging: 0,
      searching: 0,
      roadblock: 0,
      returning: 0,
      disabled: 0,
    };
    const roles: Record<PoliceUnitRole, number> = {
      investigation: 0,
      pursuit: 0,
      interceptor: 0,
      containment: 0,
      roadblock: 0,
    };
    for (const unit of this.units.values()) {
      states[unit.state] += 1;
      if (unit.role !== 'patrol') roles[unit.role] += 1;
    }
    return {
      level: this.wantedLevel,
      heat: this.heat,
      phase: this.phaseValue,
      patrols: this.units.size,
      deployedOfficers: this.deployed.size,
      activeResponders: this.activeResponseCount(),
      primaryUnitState: this.primaryUnitState(),
      primaryOfficerState: this.primaryOfficerState(),
      responseProfile: responseProfileForLevel(this.wantedLevel),
      states,
      roles,
      patrolVehicles: this.units.size,
      activePoliceUnits: this.activeOfficerCount(),
      roadblocksActive: [...this.units.values()].filter(
        (unit) => unit.roadblockSpikes.length > 0 || unit.roadblockBarriers.length > 0,
      ).length,
      helicopterActive: this.helicopter !== null && !this.helicopter.isDead,
      helicopterState: this.helicopter?.state ?? 'inactive',
      waveIndex: this.waveIndex,
      lastWaveMs: Number.isFinite(this.lastWaveAt) ? Math.max(0, this.now - this.lastWaveAt) : 0,
      nextWaveMs: Number.isFinite(this.nextWaveAt) ? Math.max(0, this.nextWaveAt - this.now) : 0,
    };
  }

  public directiveForOfficer(officerId: number): PoliceDirective {
    return this.directives.get(officerId) ?? DEFAULT_DIRECTIVE;
  }

  public reportOfficerSighting(_officerId: number, position: Vector2): void {
    if (this.wantedLevel <= 0) return;
    this.recordSighting(position);
  }

  public materializeCarjackedOfficer(exit: CompletedVehicleExit): PoliceOfficer | null {
    const scene = this.scene;
    if (
      !scene ||
      !this.policeGroup ||
      this.activeOfficerCount() >= ENGINE_LIMITS.MAX_ACTIVE_POLICE_OFFICERS
    ) {
      return null;
    }
    const vehicle = this.vehicles()?.vehicles.find((candidate) => candidate.id === exit.vehicleId);
    const position = this.resolveSafeOfficerExit(
      { x: exit.x, y: exit.y },
      vehicle ? { x: vehicle.sprite.x, y: vehicle.sprite.y } : undefined,
    );
    if (!position) return null;
    const officer = new PoliceOfficer(scene, position.x, position.y, 'officer', true);
    this.policeGroup.add(officer.sprite);
    this.entityManager()?.register(officer, {
      category: EntityCategory.Npc,
      alwaysActive: true,
    });
    this.looseOfficers.set(officer.id, officer);
    const mode = this.wantedLevel > 0 ? (this.armedSuspect ? 'engage' : 'arrest') : 'respond';
    this.directives.set(officer.id, this.makeDirective(mode, this.lastKnownPosition, null, null));
    return officer;
  }

  public handleSpikeHit(vehicleObject: Phaser.GameObjects.GameObject): void {
    const entity = vehicleObject.getData(ENTITY_DATA_KEY) as unknown;
    if (entity && typeof entity === 'object' && 'punctureTires' in entity) {
      (entity as Vehicle).punctureTires();
    }
  }

  public update(time: number, delta: number): void {
    if (!this.policeGroup) return;
    this.now = time;
    this.registerPatrolVehicles();
    this.maintainPatrolFleet(delta);
    this.materializeCompletedExits();
    this.updateEscalation(delta);
    this.updateVehicleSight();
    this.updateHelicopterSupport();
    this.updatePhaseFromContact();
    this.ensureResponseCoverage();
    for (const unit of this.units.values()) this.updateUnit(unit);
    this.updateLooseOfficers();
    this.updateSearchDecay(delta);
    this.retireDeadOfficers();
  }

  public bustPlayer(): void {
    const position = getPlayerRef()?.playerPosition ?? this.lastKnownPosition ?? { x: 0, y: 0 };
    this.heat = 0;
    this.setLevel(0);
    this.beginCooldown();
    this.bus.emit(EventKeys.PlayerBusted, { position: { ...position } });
  }

  public clearWanted(): void {
    this.heat = 0;
    this.setLevel(0);
    this.beginCooldown();
  }

  public serialize(): Json {
    return {
      level: this.wantedLevel,
      heat: this.heat,
      phase: this.phaseValue,
      lastKnownX: this.lastKnownPosition?.x ?? null,
      lastKnownY: this.lastKnownPosition?.y ?? null,
    };
  }

  public deserialize(data: Json): void {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return;
    const level =
      typeof data.level === 'number'
        ? Phaser.Math.Clamp(Math.round(data.level), 0, WANTED.MAX_LEVEL)
        : 0;
    this.heat =
      typeof data.heat === 'number' ? Math.max(0, data.heat) : (WANTED_HEAT_THRESHOLDS[level] ?? 0);
    const x = data.lastKnownX;
    const y = data.lastKnownY;
    this.lastKnownPosition = typeof x === 'number' && typeof y === 'number' ? { x, y } : null;
    this.setLevel(level);
    this.setPhase(level > 0 && this.lastKnownPosition ? 'searching' : 'clear');
  }

  private receiveReport(report: CrimeReport): void {
    if (this.processedReports.has(report.incidentId)) return;
    this.processedReports.add(report.incidentId);
    this.heat += CRIME_HEAT[report.crime];
    this.lastKnownPosition = { ...report.position };
    this.armedSuspect =
      this.armedSuspect ||
      report.crime === 'gunfire' ||
      report.crime === 'explosion' ||
      report.crime === 'police-assault';
    this.searchElapsed = 0;
    this.escalationElapsed = 0;
    if (this.wantedLevel === 0) this.setLevel(1);
    this.setPhase(report.witnessKind === 'civilian' ? 'responding' : 'pursuit');
    if (report.witnessKind !== 'civilian') {
      this.lastSightAt = this.now;
    }
    this.recruitWitnessOfficer(report);
    this.dispatchNearestUnits(report);
  }

  private recruitWitnessOfficer(report: CrimeReport): void {
    if (report.witnessKind !== 'police-officer') return;
    const entity = this.entityManager()?.getEntity(report.witnessId);
    if (!(entity instanceof PoliceOfficer) || !entity.isAlive) return;
    this.looseOfficers.set(entity.id, entity);
    this.entityManager()?.setAlwaysActive(entity.id, true);
    this.directives.set(
      entity.id,
      this.makeDirective('respond', this.lastKnownPosition, null, null),
    );
  }

  private updateEscalation(delta: number): void {
    const desired = Math.min(WANTED.MAX_LEVEL, desiredWantedLevel(this.heat));
    if (desired <= this.wantedLevel) {
      this.escalationElapsed = 0;
      return;
    }
    this.escalationElapsed += delta;
    if (this.escalationElapsed < WANTED.ESCALATION_INTERVAL_MS) return;
    this.escalationElapsed = 0;
    this.setLevel(nextWantedLevel(this.wantedLevel, this.heat));
  }

  private updatePhaseFromContact(): void {
    if (this.wantedLevel <= 0) return;
    if (
      this.phaseValue === 'pursuit' &&
      this.now - this.lastSightAt >= WANTED.IDENTIFICATION_LOST_MS
    ) {
      this.setPhase('searching');
      this.searchElapsed = 0;
      for (const unit of this.units.values()) {
        if (unit.state === 'engaging' || unit.state === 'deploying') {
          unit.state = 'searching';
          unit.stateSince = this.now;
        }
      }
    }
  }

  private updateSearchDecay(delta: number): void {
    if (this.wantedLevel <= 0 || this.phaseValue !== 'searching') return;
    this.searchElapsed += delta;
    if (this.searchElapsed < responseProfileForLevel(this.wantedLevel).searchStarMs) return;
    this.searchElapsed = 0;
    const next = Math.max(0, this.wantedLevel - 1);
    this.heat = next === 0 ? 0 : Math.min(this.heat, (WANTED_HEAT_THRESHOLDS[next] ?? 1) + 1);
    this.setLevel(next);
    if (next === 0) this.beginCooldown();
  }

  private recordSighting(position: Vector2): void {
    if (this.lastKnownPosition && Number.isFinite(this.lastSightAt)) {
      const elapsed = Math.max(0.05, (this.now - this.lastSightAt) / 1000);
      this.lastKnownVelocity = {
        x: (position.x - this.lastKnownPosition.x) / elapsed,
        y: (position.y - this.lastKnownPosition.y) / elapsed,
      };
    }
    this.lastSightAt = this.now;
    this.lastKnownPosition = { ...position };
    this.searchElapsed = 0;
    this.setPhase('pursuit');
    for (const unit of this.units.values()) {
      if (unit.state === 'searching' || unit.state === 'responding') {
        unit.target = this.coordinatedTarget(unit.role, position, unit.vehicle.id);
        if (unit.officers.size > 0) unit.state = 'engaging';
      }
    }
  }

  private dispatchNearestUnits(report: CrimeReport): void {
    this.registerPatrolVehicles();
    const preferred = this.occupants()?.vehicleForOccupant(report.witnessId);
    this.dispatchWave(report.position, report.incidentId, preferred?.id ?? null);
  }

  private ensureResponseCoverage(): void {
    if (this.wantedLevel <= 0 || !this.lastKnownPosition) return;
    const profile = responseProfileForLevel(this.wantedLevel);
    this.recallExcessResponse(profile.maxActiveUnits);
    if (this.activeResponseCount() >= profile.maxActiveUnits || this.now < this.nextWaveAt) return;
    this.dispatchWave(this.lastKnownPosition, null, null);
  }

  private dispatchWave(
    target: Vector2,
    incidentId: number | null,
    preferredVehicleId: number | null,
  ): void {
    const profile = responseProfileForLevel(this.wantedLevel);
    const capacity = profile.maxActiveUnits - this.activeResponseCount();
    const waveSize = Math.min(profile.waveSize, capacity);
    if (waveSize <= 0) return;
    const candidates = [...this.units.values()]
      .filter((unit) => unit.state === 'patrol' && this.unitAvailable(unit))
      .sort((a, b) => {
        if (a.vehicle.id === preferredVehicleId) return -1;
        if (b.vehicle.id === preferredVehicleId) return 1;
        return this.distanceSq(a.vehicle, target) - this.distanceSq(b.vehicle, target);
      });
    let assigned = 0;
    for (const unit of candidates) {
      if (assigned >= waveSize) break;
      if (
        this.policeOfficerCommitment() + Math.max(1, unit.expectedCrew) >
        ENGINE_LIMITS.MAX_ACTIVE_POLICE_OFFICERS
      ) {
        continue;
      }
      const role = this.nextMissingRole(profile);
      if (role === 'roadblock') this.assignRoadblock(unit, incidentId);
      else this.assignUnit(unit, target, incidentId, role);
      assigned += 1;
    }
    if (assigned > 0) {
      this.waveIndex += 1;
      this.lastWaveAt = this.now;
      this.nextWaveAt = this.now + profile.waveCooldownMs;
    } else {
      this.nextWaveAt = this.now + Math.min(1500, profile.waveCooldownMs);
    }
  }

  private nextMissingRole(profile: PoliceResponseProfile): PoliceUnitRole {
    const active = [...this.units.values()].filter(
      (unit) => unit.state !== 'patrol' && unit.state !== 'returning' && unit.state !== 'disabled',
    );
    for (let slot = 0; slot < profile.maxActiveUnits; slot++) {
      const role = roleForResponseSlot(profile, slot);
      const assigned = active.reduce((count, unit) => count + (unit.role === role ? 1 : 0), 0);
      if (assigned < profile.roles[role]) return role;
    }
    return profile.engagement === 'investigate' ? 'investigation' : 'pursuit';
  }

  private recallExcessResponse(maxActive: number): void {
    const active = [...this.units.values()].filter(
      (unit) => unit.state !== 'patrol' && unit.state !== 'returning' && unit.state !== 'disabled',
    );
    const profile = responseProfileForLevel(this.wantedLevel);
    const roadblocks = active.filter((unit) => unit.role === 'roadblock');
    while (roadblocks.length > profile.roadblockCount) {
      const unit = roadblocks.pop();
      if (unit) this.beginUnitReturn(unit);
    }
    const remaining = active.filter((unit) => unit.state !== 'returning');
    while (remaining.length > maxActive) {
      const unit = remaining.pop();
      if (unit) this.beginUnitReturn(unit);
    }
  }

  private coordinatedTarget(
    role: PoliceUnitRole | 'patrol',
    known: Vector2,
    seed: number,
  ): Vector2 {
    if (role === 'investigation' || role === 'pursuit' || role === 'patrol') return { ...known };
    const speed = Math.hypot(this.lastKnownVelocity.x, this.lastKnownVelocity.y);
    if (speed < 8) return { ...known };
    const direction = { x: this.lastKnownVelocity.x / speed, y: this.lastKnownVelocity.y / speed };
    if (role === 'interceptor') {
      const lead = Phaser.Math.Clamp(speed * 3.6, 240, 540);
      return this.clampWorld({ x: known.x + direction.x * lead, y: known.y + direction.y * lead });
    }
    const side = seed % 2 === 0 ? 1 : -1;
    const radius = responseProfileForLevel(this.wantedLevel).searchRadius * 0.62;
    return this.clampWorld({
      x: known.x + direction.x * 90 - direction.y * radius * side,
      y: known.y + direction.y * 90 + direction.x * radius * side,
    });
  }

  private clampWorld(position: Vector2): Vector2 {
    const map = this.world()?.map;
    if (!map) return position;
    return {
      x: Phaser.Math.Clamp(position.x, 16, map.widthTiles * map.tileSize - 16),
      y: Phaser.Math.Clamp(position.y, 16, map.heightTiles * map.tileSize - 16),
    };
  }

  private assignUnit(
    unit: PatrolUnit,
    target: Vector2,
    incidentId: number | null,
    role: Exclude<PoliceUnitRole, 'roadblock'>,
  ): void {
    unit.role = role;
    unit.state = 'responding';
    unit.stateSince = this.now;
    unit.target = this.coordinatedTarget(role, target, unit.vehicle.id);
    unit.assignedIncidentId = incidentId;
    unit.vehicle.sprite.setData('policeResponseActive', true);
    this.traffic()?.configureDriver(unit.vehicle, () => unit.target, RESPONSE_STOP_RANGE, false);
  }

  private assignRoadblock(unit: PatrolUnit, incidentId: number | null): void {
    const world = this.world();
    if (!this.lastKnownPosition || !world) return;
    const usedNodeIds = new Set(
      [...this.units.values()]
        .map((candidate) => candidate.roadblockNodeId)
        .filter((nodeId): nodeId is number => nodeId !== null),
    );
    const plan = selectRoadblock({
      origin: this.lastKnownPosition,
      velocity: this.lastKnownVelocity,
      roadNodes: world.map.roadNodes,
      roadEdges: world.map.roadEdges,
      intersections: world.map.intersections,
      landmarks: world.map.landmarks,
      usedNodeIds,
      minDistance: ROADBLOCK_MIN_DISTANCE,
      maxDistance: ROADBLOCK_MAX_DISTANCE,
    });
    if (!plan) {
      this.assignUnit(unit, this.lastKnownPosition, incidentId, 'containment');
      return;
    }
    unit.role = 'roadblock';
    unit.roadblockNodeId = plan.nodeId;
    unit.roadblockHeading = plan.heading;
    unit.target = { ...plan.position };
    unit.state = 'roadblock';
    unit.stateSince = this.now;
    unit.assignedIncidentId = incidentId;
    unit.vehicle.sprite.setData('policeResponseActive', true);
    this.traffic()?.configureDriver(unit.vehicle, () => unit.target, 54, false);
  }

  private updateUnit(unit: PatrolUnit): void {
    if (unit.vehicle.isDestroyed || unit.vehicle.isPlayerDriven) {
      unit.state = 'disabled';
      unit.vehicle.sprite.setData('policeResponseActive', false);
      return;
    }
    switch (unit.state) {
      case 'patrol':
        return;
      case 'responding':
        this.tickResponding(unit);
        return;
      case 'deploying':
        if (unit.officers.size > 0 && this.now - unit.stateSince > CRIME.POLICE_REPORT_DELAY_MS) {
          if (this.phaseValue !== 'pursuit') this.setPhase('searching');
          unit.state = this.phaseValue === 'pursuit' ? 'engaging' : 'searching';
          unit.stateSince = this.now;
        }
        return;
      case 'engaging':
        this.commandEngagement(unit);
        return;
      case 'searching':
        this.commandSearch(unit);
        return;
      case 'roadblock':
        this.tickRoadblock(unit);
        return;
      case 'returning':
        this.commandReturn(unit);
        return;
      case 'disabled':
        return;
    }
  }

  private tickResponding(unit: PatrolUnit): void {
    const target = unit.target;
    if (!target) return;
    if (this.vehicleHasSight(unit.vehicle)) {
      const player = getPlayerRef()?.playerPosition;
      if (player) this.recordSighting(player);
    }
    if (this.distanceSq(unit.vehicle, target) > RESPONSE_STOP_RANGE ** 2) return;
    this.traffic()?.setDriverStopped(unit.vehicle, true);
    unit.state = 'deploying';
    unit.stateSince = this.now;
    unit.expectedCrew = this.occupants()?.beginCrewExit(unit.vehicle) ?? 0;
    if (unit.expectedCrew === 0) unit.state = 'disabled';
  }

  private commandEngagement(unit: PatrolUnit): void {
    if (this.wantedLevel <= 0) {
      this.beginUnitReturn(unit);
      return;
    }
    if (this.phaseValue === 'searching') {
      unit.state = 'searching';
      unit.stateSince = this.now;
      return;
    }
    const profile = responseProfileForLevel(this.wantedLevel);
    for (const deployed of unit.officers.values()) {
      const mode =
        profile.engagement === 'investigate'
          ? 'investigate'
          : profile.engagement === 'combat' || this.armedSuspect
            ? 'engage'
            : 'arrest';
      this.directives.set(
        deployed.actor.id,
        this.makeDirective(mode, this.lastKnownPosition, deployed.cover, unit.vehicle.id),
      );
    }
  }

  private commandSearch(unit: PatrolUnit): void {
    if (this.wantedLevel <= 0) {
      this.beginUnitReturn(unit);
      return;
    }
    if (this.phaseValue === 'pursuit') {
      unit.state = 'engaging';
      return;
    }
    if (!this.lastKnownPosition) return;
    if (this.now >= unit.nextSearchAt) {
      unit.nextSearchAt = this.now + SEARCH_RETARGET_MS;
      unit.searchIndex += 1;
    }
    let index = 0;
    for (const deployed of unit.officers.values()) {
      const angle = ((unit.searchIndex + index * 2 + unit.vehicle.id) % 8) * (Math.PI / 4);
      const radius =
        responseProfileForLevel(this.wantedLevel).searchRadius *
        (0.55 + ((unit.vehicle.id + index) % 3) * 0.22);
      const target = {
        x: this.lastKnownPosition.x + Math.cos(angle) * radius,
        y: this.lastKnownPosition.y + Math.sin(angle) * radius,
      };
      this.directives.set(
        deployed.actor.id,
        this.makeDirective('search', target, null, unit.vehicle.id),
      );
      index += 1;
    }
  }

  private tickRoadblock(unit: PatrolUnit): void {
    const target = unit.target;
    if (!target) return;
    if (unit.roadblockSpikes.length === 0 && this.distanceSq(unit.vehicle, target) <= 62 * 62) {
      this.traffic()?.setDriverStopped(unit.vehicle, true);
      this.deployRoadblock(unit);
      unit.expectedCrew = this.occupants()?.beginCrewExit(unit.vehicle) ?? 0;
      unit.stateSince = this.now;
    }
    if (unit.roadblockSpikes.length > 0 && unit.officers.size > 0) {
      for (const deployed of unit.officers.values()) {
        this.directives.set(
          deployed.actor.id,
          this.makeDirective('take-cover', this.lastKnownPosition, deployed.cover, unit.vehicle.id),
        );
      }
    }
    if (this.wantedLevel <= 0) this.beginUnitReturn(unit);
  }

  private beginUnitReturn(unit: PatrolUnit): void {
    this.clearRoadblock(unit);
    unit.role = 'patrol';
    unit.state = 'returning';
    unit.stateSince = this.now;
    unit.target = { x: unit.vehicle.sprite.x, y: unit.vehicle.sprite.y };
    unit.vehicle.sprite.setData('policeResponseActive', false);
    for (const deployed of unit.officers.values()) {
      this.directives.set(
        deployed.actor.id,
        this.makeDirective('return', unit.target, null, unit.vehicle.id),
      );
    }
  }

  private commandReturn(unit: PatrolUnit): void {
    const occupantSystem = this.occupants();
    if (!occupantSystem) return;
    const living = [...unit.officers.values()].filter((deployed) => deployed.actor.isAlive);
    if (living.length > 0 && !living.some((deployed) => deployed.occupant.seat === 'driver')) {
      const replacement = living[0];
      if (replacement) replacement.occupant.seat = 'driver';
    }
    for (const deployed of living) {
      const pos = deployed.actor.position;
      const dx = unit.vehicle.sprite.x - pos.x;
      const dy = unit.vehicle.sprite.y - pos.y;
      this.directives.set(
        deployed.actor.id,
        this.makeDirective(
          'return',
          { x: unit.vehicle.sprite.x, y: unit.vehicle.sprite.y },
          null,
          unit.vehicle.id,
        ),
      );
      if (dx * dx + dy * dy > BOARD_RANGE * BOARD_RANGE || deployed.boarding) continue;
      deployed.boarding = true;
      occupantSystem.beginBoarding(unit.vehicle, deployed.occupant, pos);
      this.removeOfficerActor(deployed);
      unit.officers.delete(deployed.actor.id);
    }
    const seatedCrew = occupantSystem
      .occupantsFor(unit.vehicle)
      .filter(
        (occupant) =>
          occupant.state === 'seated' &&
          (occupant.role === 'police-officer' || occupant.role === 'police-supervisor'),
      );
    if (unit.officers.size > 0 || seatedCrew.length === 0) return;
    unit.state = 'patrol';
    unit.stateSince = this.now;
    unit.target = null;
    unit.assignedIncidentId = null;
    unit.vehicle.sprite.setData('policeResponseActive', false);
    this.traffic()?.configureDriver(unit.vehicle, null, 56, false);
    if (
      this.wantedLevel === 0 &&
      [...this.units.values()].every(
        (candidate) => candidate.state === 'patrol' || candidate.state === 'disabled',
      )
    ) {
      this.setPhase('clear');
    }
  }

  private materializeCompletedExits(): void {
    const exits = this.occupants()?.drainCompletedExits('police-deploy') ?? [];
    const scene = this.scene;
    if (!scene || !this.policeGroup) return;
    for (const exit of exits) {
      const unit = this.units.get(exit.vehicleId);
      if (!unit) continue;
      const position = this.resolveSafeOfficerExit(
        { x: exit.x, y: exit.y },
        { x: unit.vehicle.sprite.x, y: unit.vehicle.sprite.y },
      );
      if (!position) continue;
      const rank =
        exit.occupant.role === 'police-supervisor' && this.wantedLevel >= WANTED.SWAT_LEVEL
          ? 'swat'
          : 'officer';
      const officer = new PoliceOfficer(scene, position.x, position.y, rank, true);
      this.policeGroup.add(officer.sprite);
      const cover = this.coverPosition(unit.vehicle, unit.officers.size);
      const deployed: DeployedOfficer = {
        actor: officer,
        occupant: exit.occupant,
        unitVehicleId: exit.vehicleId,
        cover,
        boarding: false,
        deadAt: null,
      };
      unit.officers.set(officer.id, deployed);
      this.deployed.set(officer.id, deployed);
      this.directives.set(
        officer.id,
        this.makeDirective('take-cover', this.lastKnownPosition, cover, exit.vehicleId),
      );
      this.entityManager()?.register(officer, {
        category: EntityCategory.Npc,
        alwaysActive: true,
      });
    }
  }

  private updateLooseOfficers(): void {
    for (const [id, officer] of this.looseOfficers) {
      if (!officer.isAlive || this.wantedLevel <= 0) {
        this.entityManager()?.setAlwaysActive(id, false);
        this.directives.delete(id);
        this.looseOfficers.delete(id);
        continue;
      }
      const profile = responseProfileForLevel(this.wantedLevel);
      const mode =
        this.phaseValue === 'searching'
          ? 'search'
          : profile.engagement === 'investigate'
            ? 'investigate'
            : profile.engagement === 'combat' || this.armedSuspect
              ? 'engage'
              : 'arrest';
      this.directives.set(id, this.makeDirective(mode, this.lastKnownPosition, null, null));
    }
  }

  private retireDeadOfficers(): void {
    for (const deployed of [...this.deployed.values()]) {
      if (deployed.actor.isAlive) continue;
      if (deployed.deadAt === null) {
        deployed.deadAt = this.now;
        this.directives.delete(deployed.actor.id);
        continue;
      }
      if (this.now - deployed.deadAt < OFFICER_LINGER_MS) continue;
      const unit = this.units.get(deployed.unitVehicleId);
      unit?.officers.delete(deployed.actor.id);
      this.removeOfficerActor(deployed);
    }
  }

  private removeOfficerActor(deployed: DeployedOfficer): void {
    this.directives.delete(deployed.actor.id);
    this.deployed.delete(deployed.actor.id);
    this.entityManager()?.unregister(deployed.actor);
    this.policeGroup?.remove(deployed.actor.sprite, false, false);
    deployed.actor.destroy();
  }

  private registerPatrolVehicles(): void {
    const vehicles = this.vehicles();
    const occupantSystem = this.occupants();
    if (!vehicles || !occupantSystem) return;
    vehicles.forEachVehicle((vehicle) => {
      if (vehicle.def.kind !== 'police' && vehicle.def.kind !== 'policeSuv') return;
      if (vehicle.isDestroyed || vehicle.isPlayerDriven || !occupantSystem.hasPoliceCrew(vehicle)) {
        return;
      }
      if (this.units.has(vehicle.id)) return;
      const crew = occupantSystem
        .occupantsFor(vehicle)
        .filter(
          (occupant) => occupant.role === 'police-officer' || occupant.role === 'police-supervisor',
        );
      this.units.set(vehicle.id, {
        vehicle,
        role: 'patrol',
        state: 'patrol',
        target: null,
        stateSince: this.now,
        expectedCrew: crew.length,
        officers: new Map(),
        searchIndex: 0,
        nextSearchAt: this.now,
        assignedIncidentId: null,
        roadblockSpikes: [],
        roadblockBarriers: [],
        roadblockNodeId: null,
        roadblockHeading: 0,
        obstacleId: null,
      });
      vehicle.sprite.setData('policeResponseActive', false);
    });
  }

  private maintainPatrolFleet(delta: number): void {
    this.fleetElapsed += delta;
    if (this.fleetElapsed < FLEET_CHECK_MS) return;
    this.fleetElapsed = 0;
    const active = [...this.units.values()].filter((unit) => unit.state !== 'disabled').length;
    const target = Math.min(
      Math.max(
        WANTED.AMBIENT_PATROL_COUNT,
        responseProfileForLevel(this.wantedLevel).maxActiveUnits +
          responseProfileForLevel(this.wantedLevel).waveSize,
      ),
      ENGINE_LIMITS.MAX_ACTIVE_POLICE_PATROLS,
    );
    if (active >= target) return;
    const stations = this.world()?.majorBuildings.ofType('police-station') ?? [];
    const traffic = this.traffic();
    if (!traffic) return;
    const kind = responseProfileForLevel(this.wantedLevel).swat ? 'policeSuv' : 'police';
    const anchor = this.lastKnownPosition ?? getPlayerRef()?.playerPosition ?? null;
    let spawned: Vehicle | null = null;
    for (let offset = 0; offset < stations.length; offset++) {
      const index = (this.stationIndex + offset) % stations.length;
      const station = stations[index];
      if (!station) continue;
      const dispatchPoint = station.parkingArea.position;
      if (anchor) {
        const dx = dispatchPoint.x - anchor.x;
        const dy = dispatchPoint.y - anchor.y;
        if (dx * dx + dy * dy > STATION_DISPATCH_ACTIVE_RADIUS ** 2) continue;
      }
      spawned = traffic.spawnServiceVehicle(kind, dispatchPoint, null, 56);
      if (!spawned) continue;
      this.stationIndex = index + 1;
      break;
    }
    if (!spawned && anchor) {
      spawned = traffic.spawnServiceVehicleOnRoute(kind, anchor, null, 56);
    }
    if (spawned) this.registerPatrolVehicles();
  }

  private deployRoadblock(unit: PatrolUnit): void {
    const scene = this.scene;
    if (!scene || !this.spikeGroup || !this.barrierGroup) return;
    const center = unit.target ?? { x: unit.vehicle.sprite.x, y: unit.vehicle.sprite.y };
    const crossHeading = unit.roadblockHeading + Math.PI / 2;
    for (let i = -1; i <= 1; i++) {
      const spike = scene.physics.add.image(
        center.x + Math.cos(crossHeading) * i * 28,
        center.y + Math.sin(crossHeading) * i * 28,
        TextureKeys.SpikeStrip,
      );
      spike.setDepth(DepthLayers.RoadMarkings + 1).setRotation(crossHeading);
      (spike.body as Phaser.Physics.Arcade.Body).setImmovable(true);
      this.spikeGroup.add(spike);
      unit.roadblockSpikes.push(spike);
    }
    for (const side of [-1, 1] as const) {
      const barrier = this.barrierGroup.create(
        center.x + Math.cos(crossHeading) * side * 64,
        center.y + Math.sin(crossHeading) * side * 64,
        TextureKeys.RoadBarrier,
      ) as Phaser.Physics.Arcade.Image;
      barrier.setDepth(DepthLayers.RoadMarkings + 2).setRotation(crossHeading);
      barrier.refreshBody();
      unit.roadblockBarriers.push(barrier);
    }
    unit.obstacleId = `police-roadblock:${unit.vehicle.id}`;
    this.traffic()?.registerTemporaryObstacle({
      id: unit.obstacleId,
      kind: 'temporary-obstacle',
      position: { ...center },
      radius: 92,
      expiresAt: null,
    });
  }

  private clearRoadblock(unit: PatrolUnit): void {
    for (const spike of unit.roadblockSpikes) spike.destroy();
    unit.roadblockSpikes.length = 0;
    for (const barrier of unit.roadblockBarriers) barrier.destroy();
    unit.roadblockBarriers.length = 0;
    unit.roadblockNodeId = null;
    unit.roadblockHeading = 0;
    if (unit.obstacleId) this.traffic()?.removeTemporaryObstacle(unit.obstacleId);
    unit.obstacleId = null;
  }

  private updateVehicleSight(): void {
    if (this.wantedLevel <= 0) return;
    for (const unit of this.units.values()) {
      if (unit.state === 'patrol' || unit.state === 'returning' || unit.state === 'disabled') {
        continue;
      }
      if (!this.occupants()?.hasPoliceCrew(unit.vehicle)) continue;
      if (!this.vehicleHasSight(unit.vehicle)) continue;
      const player = getPlayerRef()?.playerPosition;
      if (player) this.recordSighting(player);
      return;
    }
  }

  private updateHelicopterSupport(): void {
    const profile = responseProfileForLevel(this.wantedLevel);
    if (!profile.helicopter || this.wantedLevel < WANTED.HELI_LEVEL) {
      this.removeHelicopter();
      return;
    }
    if (!this.helicopter || this.helicopter.isDead) {
      this.removeHelicopter();
      this.dispatchHelicopter();
    }
    const helicopter = this.helicopter;
    if (!helicopter || helicopter.isDead) return;
    const player = getPlayerRef();
    const position = player?.playerAlive ? player.playerPosition : null;
    if (!position) {
      helicopter.loseVisualContact();
      helicopter.setSearchCenter(this.lastKnownPosition);
      return;
    }
    const dx = position.x - helicopter.sprite.x;
    const dy = position.y - helicopter.sprite.y;
    const inRange = dx * dx + dy * dy <= HELICOPTER_SIGHT_RANGE ** 2;
    const visible =
      inRange && (this.navigation()?.hasLineOfSight(helicopter.position, position) ?? false);
    if (visible) {
      helicopter.reportVisualContact(position);
      this.recordSighting(position);
    } else {
      helicopter.loseVisualContact();
      helicopter.setSearchCenter(this.lastKnownPosition);
    }
  }

  private dispatchHelicopter(): void {
    const scene = this.scene;
    const group = this.aircraftGroup;
    const center = this.lastKnownPosition;
    const world = this.world();
    if (!scene || !group || !center || !world) return;
    const station = world.majorBuildings.nearest('police-station', center);
    const bearing = station
      ? Math.atan2(
          station.parkingArea.position.y - center.y,
          station.parkingArea.position.x - center.x,
        )
      : (this.waveIndex * 1.91) % (Math.PI * 2);
    const spawn = this.clampWorld({
      x: center.x + Math.cos(bearing) * WANTED.SPAWN_RADIUS,
      y: center.y + Math.sin(bearing) * WANTED.SPAWN_RADIUS,
    });
    const helicopter = new Helicopter(scene, spawn.x, spawn.y);
    helicopter.setSearchCenter(center);
    group.add(helicopter.sprite);
    this.entityManager()?.register(helicopter, {
      category: EntityCategory.Npc,
      alwaysActive: true,
    });
    this.helicopter = helicopter;
  }

  private removeHelicopter(): void {
    const helicopter = this.helicopter;
    if (!helicopter) return;
    this.entityManager()?.unregister(helicopter);
    this.aircraftGroup?.remove(helicopter.sprite, false, false);
    helicopter.destroy();
    this.helicopter = null;
  }

  private vehicleHasSight(vehicle: Vehicle): boolean {
    const player = getPlayerRef()?.playerPosition;
    if (!player) return false;
    const dx = player.x - vehicle.sprite.x;
    const dy = player.y - vehicle.sprite.y;
    if (dx * dx + dy * dy > CRIME.POLICE_SIGHT_RANGE ** 2) return false;
    return (
      this.navigation()?.hasLineOfSight({ x: vehicle.sprite.x, y: vehicle.sprite.y }, player) ??
      false
    );
  }

  private beginCooldown(): void {
    this.setPhase('cooldown');
    this.removeHelicopter();
    this.armedSuspect = false;
    this.lastKnownPosition = null;
    this.nextWaveAt = Infinity;
    for (const unit of this.units.values()) {
      if (unit.state !== 'patrol' && unit.state !== 'disabled') this.beginUnitReturn(unit);
    }
    for (const id of this.looseOfficers.keys()) {
      this.directives.delete(id);
      this.entityManager()?.setAlwaysActive(id, false);
    }
    this.looseOfficers.clear();
    if (
      [...this.units.values()].every((unit) => unit.state === 'patrol' || unit.state === 'disabled')
    ) {
      this.setPhase('clear');
    }
  }

  private setLevel(level: number): void {
    const next = Phaser.Math.Clamp(level, 0, WANTED.MAX_LEVEL);
    if (next === this.wantedLevel) return;
    const increased = next > this.wantedLevel;
    this.wantedLevel = next;
    if (increased) {
      this.fleetElapsed = FLEET_CHECK_MS;
      this.nextWaveAt = this.now;
    }
    this.bus.emit(EventKeys.WantedChanged, { level: next });
  }

  private setPhase(phase: WantedPhase): void {
    if (phase === this.phaseValue) return;
    const wasSearching = this.isSearching;
    this.phaseValue = phase;
    const searching = this.isSearching;
    if (searching !== wasSearching) this.bus.emit(EventKeys.WantedSearchChanged, { searching });
  }

  private resetAwareness(): void {
    this.wantedLevel = 0;
    this.heat = 0;
    this.phaseValue = 'clear';
    this.lastKnownPosition = null;
    this.lastKnownVelocity = { x: 0, y: 0 };
    this.lastSightAt = -Infinity;
    this.escalationElapsed = 0;
    this.searchElapsed = 0;
    this.fleetElapsed = FLEET_CHECK_MS;
    this.nextWaveAt = Infinity;
    this.lastWaveAt = -Infinity;
    this.waveIndex = 0;
    this.armedSuspect = false;
  }

  private removeUnit(vehicleId: number): void {
    const unit = this.units.get(vehicleId);
    if (!unit) return;
    unit.vehicle.sprite.setData('policeResponseActive', false);
    this.clearRoadblock(unit);
    for (const deployed of unit.officers.values()) this.removeOfficerActor(deployed);
    this.units.delete(vehicleId);
  }

  private unitAvailable(unit: PatrolUnit): boolean {
    return !unit.vehicle.isDestroyed && !unit.vehicle.isPlayerDriven && unit.state !== 'disabled';
  }

  private activeResponseCount(): number {
    let count = 0;
    for (const unit of this.units.values()) {
      if (unit.state !== 'patrol' && unit.state !== 'disabled' && unit.state !== 'returning') {
        count += 1;
      }
    }
    return count;
  }

  private activeOfficerCount(): number {
    let count = 0;
    for (const officer of this.deployed.values()) count += officer.actor.isAlive ? 1 : 0;
    for (const officer of this.looseOfficers.values()) count += officer.isAlive ? 1 : 0;
    return count;
  }

  private policeOfficerCommitment(): number {
    let count = this.looseOfficers.size;
    for (const unit of this.units.values()) {
      if (unit.state === 'patrol' || unit.state === 'returning' || unit.state === 'disabled') {
        continue;
      }
      count += Math.max(unit.expectedCrew, unit.officers.size);
    }
    return count;
  }

  private primaryUnitState(): string {
    const unit = [...this.units.values()].find(
      (candidate) => candidate.state !== 'patrol' && candidate.state !== 'disabled',
    );
    if (!unit) return this.units.size > 0 ? 'Patrol' : 'None';
    switch (unit.state) {
      case 'responding':
        return this.phaseValue === 'responding' ? 'Investigate' : 'DriveToTarget';
      case 'deploying':
        return 'ExitVehicle';
      case 'engaging':
        return responseProfileForLevel(this.wantedLevel).allowLethalForce ? 'Combat' : 'FootChase';
      case 'searching':
        return 'Search';
      case 'roadblock':
        return 'Respond';
      case 'returning':
        return 'ReturnToVehicle';
      case 'patrol':
        return 'Patrol';
      case 'disabled':
        return 'Disabled';
    }
  }

  private primaryOfficerState(): string {
    for (const deployed of this.deployed.values()) {
      if (deployed.actor.isAlive) return deployed.actor.ai.currentState;
    }
    for (const officer of this.looseOfficers.values()) {
      if (officer.isAlive) return officer.ai.currentState;
    }
    return 'None';
  }

  private distanceSq(vehicle: Vehicle, target: Vector2): number {
    const dx = vehicle.sprite.x - target.x;
    const dy = vehicle.sprite.y - target.y;
    return dx * dx + dy * dy;
  }

  private coverPosition(vehicle: Vehicle, index: number): Vector2 {
    const side = index % 2 === 0 ? 1 : -1;
    const angle = vehicle.movement.heading + (side * Math.PI) / 2;
    const longitudinal = index >= 2 ? -18 : 8;
    return {
      x:
        vehicle.sprite.x + Math.cos(angle) * 26 + Math.cos(vehicle.movement.heading) * longitudinal,
      y:
        vehicle.sprite.y + Math.sin(angle) * 26 + Math.sin(vehicle.movement.heading) * longitudinal,
    };
  }

  private makeDirective(
    mode: PoliceDirective['mode'],
    target: Vector2 | null,
    cover: Vector2 | null,
    vehicleId: number | null,
  ): PoliceDirective {
    return {
      mode,
      target: target ? { ...target } : null,
      cover: cover ? { ...cover } : null,
      allowLethalForce:
        this.armedSuspect || responseProfileForLevel(this.wantedLevel).allowLethalForce,
      vehicleId,
    };
  }

  /** Resolve one bounded, swept-safe materialization point beside a police vehicle. */
  private resolveSafeOfficerExit(requested: Vector2, segmentStart?: Vector2): Vector2 | null {
    return (
      this.world()?.resolveSafePedestrianPosition(requested, PLAYER.RADIUS, {
        maxDistance: OFFICER_EXIT_SEARCH_RADIUS,
        segmentStart,
      }) ?? null
    );
  }

  private vehicles(): VehicleSystem | null {
    return ServiceLocator.tryResolve<VehicleSystem>(ServiceKeys.Vehicle);
  }

  private occupants(): VehicleOccupantSystem | null {
    return ServiceLocator.tryResolve<VehicleOccupantSystem>(ServiceKeys.Occupants);
  }

  private traffic(): TrafficSystem | null {
    return ServiceLocator.tryResolve<TrafficSystem>(ServiceKeys.Traffic);
  }

  private navigation(): NavigationSystem | null {
    return ServiceLocator.tryResolve<NavigationSystem>(ServiceKeys.Navigation);
  }

  private world(): WorldManager | null {
    return ServiceLocator.tryResolve<WorldManager>(ServiceKeys.World);
  }

  private entityManager(): EntityManager | null {
    return ServiceLocator.tryResolve<EntityManager>(ServiceKeys.Entity);
  }
}
