/**
 * Emergency response simulation.
 *
 * Civilian casualties create incidents. Bystanders are assumed to call it in;
 * an ambulance leaves the nearest hospital, follows the road graph, medics
 * treat or recover the victim, then the ambulance returns to the hospital.
 */
import Phaser from 'phaser';
import { BaseSceneManager } from '@/core/BaseSceneManager';
import { ServiceLocator } from '@/core/ServiceLocator';
import { ServiceKeys } from '@/config/ServiceKeys';
import { EventKeys } from '@/config/EventKeys';
import { ENGINE_LIMITS } from '@/config/EngineLimits';
import { EngineDiagnostics } from '@/core/EngineDiagnostics';
import { DepthLayers } from '@/config/DepthLayers';
import { TextureKeys } from '@/config/AssetKeys';
import type { Vector2 } from '@/core/types';
import type { Pedestrian } from '@/entities/Pedestrian';
import type { Vehicle } from '@/entities/Vehicle';
import { TrafficAIComponent } from '@/entities/components';
import type { VehicleSystem } from '@/systems/VehicleSystem';
import type { TrafficSystem } from '@/systems/TrafficSystem';
import type { WorldManager } from '@/systems/WorldManager';

interface PedProvider {
  readonly pedestrians?: readonly Pedestrian[];
  removeById?(id: number): boolean;
}

type IncidentState = 'dispatching' | 'treating' | 'returning';

interface EmergencyIncident {
  id: number;
  victimId: number | null;
  position: Vector2;
  hospital: Vector2;
  target: Vector2;
  fatal: boolean;
  state: IncidentState;
  timerMs: number;
  ambulance: Vehicle | null;
  routeAi: TrafficAIComponent | null;
  medics: Phaser.GameObjects.Sprite[];
  stretcher: Phaser.GameObjects.Rectangle | null;
}

const INCIDENT_DUP_RADIUS = 180;
const TREAT_MS = 4200;
const RETURN_STOP_RANGE = 72;

export class EmergencyResponseSystem extends BaseSceneManager {
  public readonly key = ServiceKeys.Emergency;

  private incidents: EmergencyIncident[] = [];
  private nextIncidentId = 1;

  protected onInit(): void {
    this.subscribe(EventKeys.PedestrianDowned, (payload) => {
      this.reportIncident(payload.position, payload.entityId, false);
    });
    this.subscribe(EventKeys.EntityKilled, (payload) => {
      if (payload.kind === 'pedestrian') {
        this.reportIncident(payload.position, payload.targetId, true);
      }
    });
  }

  protected onAttach(_scene: Phaser.Scene): void {}

  protected override onDetach(_scene: Phaser.Scene): void {
    for (const incident of this.incidents) this.cleanupIncident(incident, true);
    this.incidents = [];
  }

  public update(_time: number, delta: number): void {
    for (const incident of [...this.incidents]) {
      this.tickIncident(incident, delta);
    }
  }

  private reportIncident(position: Vector2, victimId: number | null, fatal: boolean): void {
    if (!this.scene || this.isDuplicate(position)) return;
    if (this.incidents.length >= ENGINE_LIMITS.MAX_AMBULANCE_DISPATCHES) {
      EngineDiagnostics.recordLimitExceeded(
        'MAX_AMBULANCE_DISPATCHES',
        this.incidents.length + 1,
        ENGINE_LIMITS.MAX_AMBULANCE_DISPATCHES,
        'rejected-emergency-incident',
        'EmergencyResponseSystem',
      );
      return;
    }
    const world = this.resolveWorld();
    const hospital = world?.nearestHospitalParking(position.x, position.y) ?? position;
    const incident: EmergencyIncident = {
      id: this.nextIncidentId++,
      victimId,
      position: { x: position.x, y: position.y },
      hospital,
      target: { x: position.x, y: position.y },
      fatal,
      state: 'dispatching',
      timerMs: 0,
      ambulance: null,
      routeAi: null,
      medics: [],
      stretcher: null,
    };
    this.incidents.push(incident);
    incident.target = this.nearestRoadTo(incident.position, this.resolveWorld());
    this.dispatchAmbulance(incident);
    this.bus.emit(EventKeys.UIToast, {
      message: fatal
        ? 'Bystanders call emergency services.'
        : 'Ambulance dispatched for injured civilian.',
    });
  }

  private dispatchAmbulance(incident: EmergencyIncident): void {
    const traffic = this.resolveTraffic();
    const world = this.resolveWorld();
    if (!traffic || !world) return;
    const start = this.nearestRoadTo(incident.hospital, world);
    const ambulance = traffic.spawnServiceVehicle('ambulance', start, () => incident.target, 66);
    if (!ambulance) return;
    const routeAi = ambulance.getComponent<TrafficAIComponent>('ai') ?? null;
    incident.ambulance = ambulance;
    incident.routeAi = routeAi;
  }

  private tickIncident(incident: EmergencyIncident, delta: number): void {
    const ambulance = incident.ambulance;
    if (!ambulance || ambulance.isDestroyed) {
      this.cleanupIncident(incident, false);
      return;
    }

    if (incident.state === 'dispatching') {
      if (incident.routeAi?.arrived) {
        incident.state = 'treating';
        incident.timerMs = TREAT_MS;
        this.spawnMedics(incident);
      }
      return;
    }

    if (incident.state === 'treating') {
      incident.timerMs -= delta;
      if (incident.timerMs > 0) return;
      this.stabilizeVictim(incident);
      this.beginReturn(incident);
      return;
    }

    if (incident.state === 'returning' && incident.routeAi?.arrived) {
      this.bus.emit(EventKeys.UIToast, { message: 'Ambulance returned to the hospital.' });
      this.cleanupIncident(incident, false);
    }
  }

  private beginReturn(incident: EmergencyIncident): void {
    incident.state = 'returning';
    incident.target = { ...this.nearestRoadTo(incident.hospital, this.resolveWorld()) };
    incident.routeAi?.setStopRange(RETURN_STOP_RANGE);
    incident.routeAi?.forceReplan();
    this.destroyResponders(incident);
    this.bus.emit(EventKeys.UIToast, {
      message: 'Victim loaded. Ambulance returning to hospital.',
    });
  }

  private spawnMedics(incident: EmergencyIncident): void {
    const scene = this.scene;
    if (!scene) return;
    for (const offset of [-12, 12]) {
      const medic = scene.add.sprite(
        incident.position.x + offset,
        incident.position.y + 18,
        TextureKeys.CharPed,
      );
      if (medic.texture.has('idle0')) medic.setFrame('idle0');
      medic.setTint(0xffffff);
      medic.setDepth(DepthLayers.Characters);
      incident.medics.push(medic);
    }
    const stretcher = scene.add.rectangle(
      incident.position.x,
      incident.position.y + 8,
      34,
      12,
      0xd8dde7,
      0.95,
    );
    stretcher.setDepth(DepthLayers.GroundDetail + 4);
    stretcher.setStrokeStyle(1, 0x5d6b78, 0.8);
    incident.stretcher = stretcher;
  }

  private stabilizeVictim(incident: EmergencyIncident): void {
    const pedestrians = this.resolvePedestrians();
    const victim = pedestrians?.pedestrians?.find((ped) => ped.id === incident.victimId);
    if (victim && victim.isAlive) {
      const target = victim.healthComp.maxHealth * 0.65;
      const need = target - victim.healthComp.health;
      if (need > 0) victim.healthComp.heal(need);
      pedestrians?.removeById?.(victim.id);
    }
  }

  private destroyResponders(incident: EmergencyIncident): void {
    for (const medic of incident.medics) medic.destroy();
    incident.medics.length = 0;
    incident.stretcher?.destroy();
    incident.stretcher = null;
  }

  private cleanupIncident(incident: EmergencyIncident, destroyVehicle: boolean): void {
    this.destroyResponders(incident);
    if (destroyVehicle && incident.ambulance) {
      this.resolveVehicles()?.removeVehicle(incident.ambulance);
    } else if (incident.ambulance && incident.state === 'returning') {
      this.resolveVehicles()?.removeVehicle(incident.ambulance);
    }
    this.incidents = this.incidents.filter((item) => item !== incident);
  }

  private isDuplicate(position: Vector2): boolean {
    const maxSq = INCIDENT_DUP_RADIUS * INCIDENT_DUP_RADIUS;
    return this.incidents.some((incident) => {
      const dx = incident.position.x - position.x;
      const dy = incident.position.y - position.y;
      return dx * dx + dy * dy <= maxSq;
    });
  }

  private nearestRoadTo(point: Vector2, world: WorldManager | null): Vector2 {
    if (!world) return point;
    let best: Vector2 | null = null;
    let bestSq = Infinity;
    for (const road of world.map.roadSpawns) {
      const dx = road.x - point.x;
      const dy = road.y - point.y;
      const d = dx * dx + dy * dy;
      if (d < bestSq) {
        best = road;
        bestSq = d;
      }
    }
    return best ? { x: best.x, y: best.y } : { x: point.x, y: point.y };
  }

  private resolveVehicles(): VehicleSystem | null {
    return ServiceLocator.tryResolve<VehicleSystem>(ServiceKeys.Vehicle);
  }

  private resolveTraffic(): TrafficSystem | null {
    return ServiceLocator.tryResolve<TrafficSystem>(ServiceKeys.Traffic);
  }

  private resolveWorld(): WorldManager | null {
    return ServiceLocator.tryResolve<WorldManager>(ServiceKeys.World);
  }

  private resolvePedestrians(): PedProvider | null {
    return (
      (ServiceLocator.tryResolve(ServiceKeys.Pedestrian) as unknown as PedProvider | null) ?? null
    );
  }
}
