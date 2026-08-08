import Phaser from 'phaser';
import { BaseSceneManager } from '@/core/BaseSceneManager';
import { ServiceLocator } from '@/core/ServiceLocator';
import { ServiceKeys } from '@/config/ServiceKeys';
import { EventKeys } from '@/config/EventKeys';
import { CRIME } from '@/config/Constants';
import { ENGINE_LIMITS } from '@/config/EngineLimits';
import { EngineDiagnostics } from '@/core/EngineDiagnostics';
import type { Vector2 } from '@/core/types';
import {
  civilianReaction,
  reactionWillReport,
  witnessReportDelay,
} from '@/gameplay/crime/CrimeRules';
import { EntityCategory, type EntityManager } from '@/systems/EntityManager';
import { Pedestrian } from '@/entities/Pedestrian';
import { PoliceOfficer } from '@/entities/PoliceOfficer';
import type { PlayerController } from '@/systems/PlayerController';
import type { NavigationSystem } from '@/systems/NavigationSystem';
import type { VehicleOccupantSystem, VehicleWitness } from '@/systems/VehicleOccupantSystem';
import {
  isPlayerResponsible,
  type CrimeIncident,
  type CrimeObservation,
  type CrimeReport,
  type NpcPersonality,
  type WitnessKind,
  type WitnessReaction,
} from '@/gameplay/types';

interface PendingReport {
  observation: CrimeObservation;
  incident: CrimeIncident;
  vehicleWitness: boolean;
}

/** Converts raw player actions into police knowledge only through real witnesses. */
export class CrimeSystem extends BaseSceneManager {
  public readonly key = ServiceKeys.Crime;

  private readonly incidents: CrimeIncident[] = [];
  private readonly pendingReports: PendingReport[] = [];
  private nextIncidentId = 1;
  private now = 0;

  protected onInit(): void {
    this.subscribe(EventKeys.CrimeCommitted, (payload) => {
      if (!isPlayerResponsible({ fromPlayer: false, attribution: payload.attribution })) return;
      this.createIncident(payload.crime, payload.position, payload.attribution);
    });
  }

  protected onAttach(scene: Phaser.Scene): void {
    this.now = scene.time.now;
  }

  protected onDetach(_scene: Phaser.Scene): void {
    this.incidents.length = 0;
    this.pendingReports.length = 0;
    this.nextIncidentId = 1;
    this.now = 0;
  }

  public update(time: number, _delta: number): void {
    this.now = time;
    for (let i = this.pendingReports.length - 1; i >= 0; i--) {
      const pending = this.pendingReports[i];
      if (!pending || pending.observation.reportDueAt === null) continue;
      if (time < pending.observation.reportDueAt) continue;
      this.completeReport(pending);
      const index = this.pendingReports.indexOf(pending);
      if (index >= 0) this.pendingReports.splice(index, 1);
    }
    for (let i = this.incidents.length - 1; i >= 0; i--) {
      const incident = this.incidents[i];
      if (incident && time - incident.occurredAt > CRIME.INCIDENT_LIFETIME_MS) {
        this.incidents.splice(i, 1);
      }
    }
  }

  public get activeIncidents(): readonly CrimeIncident[] {
    return this.incidents;
  }

  public get pendingReportCount(): number {
    return this.pendingReports.length;
  }

  public debugSnapshot(): {
    incidents: number;
    pendingReports: number;
    nextIncidentId: number;
  } {
    return {
      incidents: this.incidents.length,
      pendingReports: this.pendingReports.length,
      nextIncidentId: this.nextIncidentId,
    };
  }

  private createIncident(
    crime: CrimeIncident['crime'],
    position: Vector2,
    attribution: CrimeIncident['attribution'],
  ): void {
    const duplicate = this.incidents.find(
      (incident) =>
        incident.crime === crime &&
        this.now - incident.occurredAt <= CRIME.DUPLICATE_WINDOW_MS &&
        Phaser.Math.Distance.Squared(
          incident.position.x,
          incident.position.y,
          position.x,
          position.y,
        ) <=
          24 * 24,
    );
    if (duplicate) return;
    if (this.incidents.length >= ENGINE_LIMITS.MAX_ACTIVE_CRIME_INCIDENTS) {
      this.incidents.shift();
      EngineDiagnostics.recordLimitExceeded(
        'MAX_ACTIVE_CRIME_INCIDENTS',
        ENGINE_LIMITS.MAX_ACTIVE_CRIME_INCIDENTS + 1,
        ENGINE_LIMITS.MAX_ACTIVE_CRIME_INCIDENTS,
        'retired-oldest-crime-incident',
        this.key,
      );
    }
    const incident: CrimeIncident = {
      id: this.nextIncidentId++,
      crime,
      position: { ...position },
      occurredAt: this.now,
      attribution,
      suspectEntityId: attribution.sourceId ?? attribution.lastAttackerId ?? null,
      suspectVehicleId: attribution.vehicleOwnerId ?? null,
    };
    this.incidents.push(incident);
    this.bus.emit(EventKeys.CrimeCreated, incident);
    this.perceiveIncident(incident);
  }

  private perceiveIncident(incident: CrimeIncident): void {
    let observed = 0;
    const entities = ServiceLocator.tryResolve<EntityManager>(ServiceKeys.Entity);
    const maxRange = Math.max(CRIME.CIVILIAN_SIGHT_RANGE, CRIME.POLICE_SIGHT_RANGE);
    entities?.forEachNearby(
      incident.position.x,
      incident.position.y,
      maxRange,
      (entity, distanceSq) => {
        if (observed >= CRIME.MAX_WITNESSES_PER_INCIDENT) return;
        if (entity instanceof PoliceOfficer && entity.isAlive) {
          if (
            distanceSq <= CRIME.POLICE_SIGHT_RANGE ** 2 &&
            this.canSee(entity.position, entity.movement.facingAngle, incident.position, true)
          ) {
            this.observe(incident, entity.id, 'police-officer', null, 'call-police', false);
            observed += 1;
          }
          return;
        }
        if (
          entity instanceof Pedestrian &&
          entity.isAlive &&
          distanceSq <= CRIME.CIVILIAN_SIGHT_RANGE ** 2
        ) {
          if (
            !this.canSee(entity.position, entity.movement.facingAngle, incident.position, false)
          ) {
            return;
          }
          const reaction = civilianReaction(entity.personality, incident.crime);
          entity.ai.reactToCrime(reaction, incident.position, this.playerDamageable());
          this.observe(incident, entity.id, 'civilian', entity.personality, reaction, false);
          observed += 1;
        }
      },
      EntityCategory.Npc,
    );

    const occupants = ServiceLocator.tryResolve<VehicleOccupantSystem>(ServiceKeys.Occupants);
    const seenPoliceVehicles = new Set<number>();
    occupants?.forEachWitnessNear(incident.position, CRIME.VEHICLE_SIGHT_RANGE, (witness) => {
      if (observed >= CRIME.MAX_WITNESSES_PER_INCIDENT) return;
      if (witness.kind === 'police-vehicle' && seenPoliceVehicles.has(witness.vehicle.id)) return;
      if (!this.vehicleWitnessCanSee(witness, incident.position)) return;
      if (witness.kind === 'police-vehicle') seenPoliceVehicles.add(witness.vehicle.id);
      const reaction =
        witness.kind === 'police-vehicle'
          ? 'call-police'
          : civilianReaction(witness.personality, incident.crime);
      this.observe(incident, witness.id, witness.kind, witness.personality, reaction, true);
      observed += 1;
    });
  }

  private observe(
    incident: CrimeIncident,
    witnessId: number,
    witnessKind: WitnessKind,
    personality: NpcPersonality | null,
    reaction: WitnessReaction,
    vehicleWitness: boolean,
  ): void {
    const police = witnessKind === 'police-officer' || witnessKind === 'police-vehicle';
    const reports = police || (personality !== null && reactionWillReport(reaction, personality));
    const delay = witnessReportDelay(
      police,
      personality,
      CRIME.CIVILIAN_REPORT_MIN_MS,
      CRIME.CIVILIAN_REPORT_MAX_MS,
      CRIME.POLICE_REPORT_DELAY_MS,
    );
    const observation: CrimeObservation = {
      incidentId: incident.id,
      witnessId,
      witnessKind,
      reaction,
      observedAt: this.now,
      reportDueAt: reports ? this.now + delay : null,
    };
    this.bus.emit(EventKeys.CrimeObserved, observation);
    if (!reports || this.pendingReports.length >= ENGINE_LIMITS.MAX_PENDING_CRIME_REPORTS) return;
    this.pendingReports.push({ observation, incident, vehicleWitness });
  }

  private completeReport(pending: PendingReport): void {
    const { incident, observation } = pending;
    if (!pending.vehicleWitness) {
      const witness = ServiceLocator.tryResolve<EntityManager>(ServiceKeys.Entity)?.getEntity(
        observation.witnessId,
      );
      if (
        !witness ||
        (witness instanceof Pedestrian && !witness.isAlive) ||
        (witness instanceof PoliceOfficer && !witness.isAlive)
      ) {
        return;
      }
    }
    const report: CrimeReport = {
      incidentId: incident.id,
      crime: incident.crime,
      position: { ...incident.position },
      witnessId: observation.witnessId,
      witnessKind: observation.witnessKind,
      reportedAt: this.now,
      attribution: incident.attribution,
      suspectEntityId: incident.suspectEntityId,
      suspectVehicleId: incident.suspectVehicleId,
    };
    this.bus.emit(EventKeys.CrimeReported, report);
    for (let i = this.pendingReports.length - 1; i >= 0; i--) {
      const other = this.pendingReports[i];
      if (other && other !== pending && other.incident.id === incident.id) {
        this.pendingReports.splice(i, 1);
      }
    }
  }

  private canSee(from: Vector2, facing: number, target: Vector2, police: boolean): boolean {
    const dx = target.x - from.x;
    const dy = target.y - from.y;
    const distanceSq = dx * dx + dy * dy;
    const range = police ? CRIME.POLICE_SIGHT_RANGE : CRIME.CIVILIAN_SIGHT_RANGE;
    if (distanceSq > range * range) return false;
    if (distanceSq > 80 * 80) {
      const angleDelta = Phaser.Math.Angle.Wrap(Math.atan2(dy, dx) - facing);
      if (Math.abs(angleDelta) > Phaser.Math.DegToRad(police ? 135 : 110)) return false;
    }
    return this.clearLine(from, target);
  }

  private vehicleWitnessCanSee(witness: VehicleWitness, target: Vector2): boolean {
    return this.canSee(
      witness.position,
      witness.vehicle.movement.heading,
      target,
      witness.kind === 'police-vehicle',
    );
  }

  private clearLine(from: Vector2, to: Vector2): boolean {
    const navigation = ServiceLocator.tryResolve<NavigationSystem>(ServiceKeys.Navigation);
    return navigation?.hasLineOfSight(from, to) ?? false;
  }

  private playerDamageable() {
    return ServiceLocator.tryResolve<PlayerController>(ServiceKeys.Player)?.player ?? null;
  }
}
