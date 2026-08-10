/**
 * Contextual interaction prompts and light-weight generic interactions.
 *
 * Specific gameplay systems still own their real actions: missions start in
 * MissionSystem, shops transact in ShopSystem, pickups collect in PickupSystem,
 * and vehicle boarding remains in PlayerController. This system centralises
 * the question "what is the player close to?" so the HUD can display one clear
 * prompt and generic targets such as NPC conversations can respond to E.
 */
import Phaser from 'phaser';
import { BaseSceneManager } from '@/core/BaseSceneManager';
import { ServiceLocator } from '@/core/ServiceLocator';
import { ServiceKeys } from '@/config/ServiceKeys';
import { EventKeys } from '@/config/EventKeys';
import { PLAYER, VEHICLE } from '@/config/Constants';
import type { SaveManager } from '@/managers/SaveManager';
import type { Vector2 } from '@/core/types';
import type { InteractionKind } from '@/gameplay/types';
import type { WorldManager } from '@/systems/WorldManager';
import type { PlayerController } from '@/systems/PlayerController';
import type { VehicleSystem } from '@/systems/VehicleSystem';
import type { MissionSystem } from '@/systems/MissionSystem';
import type { TransportationSystem } from '@/systems/TransportationSystem';
import { Pedestrian } from '@/entities/Pedestrian';
import { EntityCategory, type EntityManager } from '@/systems/EntityManager';

interface InteractionTarget {
  kind: InteractionKind;
  prompt: string;
  distanceSq: number;
  priority: number;
}

interface CrowdProvider {
  readonly pedestrians?: readonly Pedestrian[];
}

interface InteriorInteractionProvider {
  nearestInteraction(pos: Vector2, range?: number): { prompt: string; distanceSq: number } | null;
}

const RANGE = PLAYER.INTERACT_RANGE;
const RANGE_SQ = RANGE * RANGE;
const NPC_RANGE_SQ = 48 * 48;
const DOOR_RANGE_SQ = 34 * 34;

const NPC_LINES = [
  'Nice night for a walk.',
  'Traffic has been rough today.',
  'Watch yourself out there.',
  'The cops are everywhere lately.',
  'I heard there is work near the marker.',
] as const;

export class InteractionSystem extends BaseSceneManager {
  /** Service-locator key for this system. */
  public readonly key = ServiceKeys.Interaction;

  private lastPrompt: string | null = null;
  private lastKind: InteractionKind | null = null;

  /** Subscribe to the player's E-key interaction. */
  protected onInit(): void {
    this.subscribe(EventKeys.PlayerInteract, (p) => this.onInteract(p));
  }

  /** Scene scoped objects are not required. */
  protected onAttach(_scene: Phaser.Scene): void {}

  /** Update the HUD prompt from the nearest current target. */
  public update(_time: number, _delta: number): void {
    const player = this.resolvePlayer();
    const pos = player?.playerPosition ?? null;
    if (!pos) {
      this.emitPrompt(null);
      return;
    }
    this.emitPrompt(this.findTarget(pos));
  }

  /** Respond to generic E-key targets that do not already have owners. */
  private onInteract(pos: Vector2): void {
    const target = this.findTarget(pos);
    if (!target) return;

    if (target.kind === 'npc') {
      const line = NPC_LINES[Math.floor(Math.random() * NPC_LINES.length)] ?? NPC_LINES[0];
      this.bus.emit(EventKeys.UIToast, { message: line, durationMs: 2200 });
      return;
    }

    // Transportation owns its own door, passenger and fare transitions. Its
    // EventKeys.PlayerInteract subscriber receives this same input event.
    if (target.kind === 'transit') return;

    if (target.kind === 'safehouse') {
      const ok = ServiceLocator.tryResolve<SaveManager>(ServiceKeys.Save)?.save(0, 'Safe House') ?? false;
      this.bus.emit(EventKeys.UIToast, {
        message: ok ? 'Saved at safe house' : 'Safe house save failed',
      });
      return;
    }

    if (target.kind === 'vehicle') {
      this.bus.emit(EventKeys.UIToast, { message: 'Use F to enter or exit vehicles' });
      return;
    }

    if (target.kind === 'interior') {
      return;
    }

    if (target.kind === 'door') {
      this.bus.emit(EventKeys.UIToast, { message: 'The door is locked' });
    }
  }

  /** Find the current highest-priority target around a position. */
  private findTarget(pos: Vector2): InteractionTarget | null {
    const candidates: InteractionTarget[] = [];
    const transit = this.resolveTransit()?.interactionAt(pos);
    if (transit) {
      candidates.push({
        kind: 'transit',
        prompt: transit.prompt,
        distanceSq: transit.distanceSq,
        priority: -1,
      });
    }
    const interior = this.nearestInteriorInteraction(pos);
    if (interior) {
      candidates.push({
        kind: 'interior',
        prompt: interior.prompt,
        distanceSq: interior.distanceSq,
        priority: 0,
      });
    }

    const world = this.resolveWorld();
    if (world) {
      for (const building of world.map.majorBuildings) {
        const distanceSq = this.distanceSq(pos, building.entrancePosition);
        if (distanceSq > RANGE_SQ) continue;
        candidates.push({
          kind: building.type === 'hospital' ? 'hospital' : 'police',
          prompt: `E  ${building.name} entrance`,
          distanceSq,
          priority: 1,
        });
      }
      this.addNearest(candidates, 'gunshop', 'E  Gun store entrance', world.map.gunShops, pos, 1);
      this.addNearest(candidates, 'dealership', 'E  Dealership entrance', world.map.garages, pos, 1);
      this.addNearest(candidates, 'safehouse', 'E  Save at safe house', world.map.safeHouses, pos, 1);
      this.addNearest(candidates, 'gas', 'E  Use gas station', world.map.gasStations, pos, 1);

      const door = this.nearest(pos, world.map.buildingEntrances, DOOR_RANGE_SQ);
      if (door) {
        candidates.push({
          kind: 'door',
          prompt: 'E  Try door',
          distanceSq: door.distanceSq,
          priority: 6,
        });
      }
    }

    const mission = ServiceLocator.tryResolve<MissionSystem>(ServiceKeys.Mission)?.currentMapMarker;
    if (mission) {
      const d = this.distanceSq(pos, mission);
      if (d <= RANGE_SQ) {
        candidates.push({
          kind: 'mission',
          prompt: 'E  Mission',
          distanceSq: d,
          priority: 2,
        });
      }
    }

    const controller = ServiceLocator.tryResolve<PlayerController>(ServiceKeys.Player);
    if (controller?.currentVehicle) {
      candidates.push({
        kind: 'vehicle',
        prompt: 'F  Exit vehicle',
        distanceSq: 0,
        priority: 3,
      });
    } else {
      const vehicle = ServiceLocator.tryResolve<VehicleSystem>(ServiceKeys.Vehicle)?.nearestVehicle(
        pos.x,
        pos.y,
        VEHICLE.ENTER_RANGE,
      );
      if (vehicle) {
        candidates.push({
          kind: 'vehicle',
          prompt: 'F  Enter vehicle',
          distanceSq: this.distanceSq(pos, { x: vehicle.sprite.x, y: vehicle.sprite.y }),
          priority: 3,
        });
      }
    }

    const npc = this.nearestNpc(pos);
    if (npc) {
      candidates.push({
        kind: 'npc',
        prompt: 'E  Talk',
        distanceSq: npc.distanceSq,
        priority: 4,
      });
    }

    candidates.sort((a, b) => a.priority - b.priority || a.distanceSq - b.distanceSq);
    return candidates[0] ?? null;
  }

  /** Add the nearest service target from a point list. */
  private addNearest(
    out: InteractionTarget[],
    kind: InteractionKind,
    prompt: string,
    points: readonly Vector2[],
    pos: Vector2,
    priority: number,
  ): void {
    const found = this.nearest(pos, points, RANGE_SQ);
    if (!found) return;
    out.push({ kind, prompt, distanceSq: found.distanceSq, priority });
  }

  /** Nearest point within a squared range. */
  private nearest(
    pos: Vector2,
    points: readonly Vector2[],
    maxSq: number,
  ): { point: Vector2; distanceSq: number } | null {
    let best: { point: Vector2; distanceSq: number } | null = null;
    for (const point of points) {
      const distanceSq = this.distanceSq(pos, point);
      if (distanceSq <= maxSq && (!best || distanceSq < best.distanceSq)) {
        best = { point, distanceSq };
      }
    }
    return best;
  }

  /** Nearest living pedestrian. */
  private nearestNpc(pos: Vector2): { distanceSq: number } | null {
    const entities = ServiceLocator.tryResolve<EntityManager>(ServiceKeys.Entity);
    const crowd = ServiceLocator.tryResolve(ServiceKeys.Pedestrian) as CrowdProvider | null;
    let best: { distanceSq: number } | null = null;
    if (entities) {
      entities.forEachNearby(
        pos.x,
        pos.y,
        Math.sqrt(NPC_RANGE_SQ),
        (entity, distanceSq) => {
          if (!(entity instanceof Pedestrian) || !entity.isAlive) return;
          if (!best || distanceSq < best.distanceSq) best = { distanceSq };
        },
        EntityCategory.Npc,
      );
      return best;
    }
    for (const ped of crowd?.pedestrians ?? []) {
      if (!ped.isAlive) continue;
      const distanceSq = this.distanceSq(pos, ped.position);
      if (distanceSq <= NPC_RANGE_SQ && (!best || distanceSq < best.distanceSq)) {
        best = { distanceSq };
      }
    }
    return best;
  }

  private nearestInteriorInteraction(pos: Vector2): { prompt: string; distanceSq: number } | null {
    const interiors = ServiceLocator.tryResolve(ServiceKeys.Interior) as unknown as InteriorInteractionProvider | null;
    return interiors?.nearestInteraction(pos, RANGE) ?? null;
  }

  /** Emit only when the prompt changes. */
  private emitPrompt(target: InteractionTarget | null): void {
    const text = target?.prompt ?? null;
    const kind = target?.kind ?? null;
    if (text === this.lastPrompt && kind === this.lastKind) return;
    this.lastPrompt = text;
    this.lastKind = kind;
    this.bus.emit(EventKeys.InteractionPromptChanged, { text });
    this.bus.emit(EventKeys.InteractionContextChanged, {
      context: target ? { kind: target.kind, prompt: target.prompt } : null,
    });
  }

  private distanceSq(a: Vector2, b: Vector2): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy;
  }

  private resolvePlayer(): PlayerController | null {
    return ServiceLocator.tryResolve<PlayerController>(ServiceKeys.Player);
  }

  private resolveWorld(): WorldManager | null {
    return ServiceLocator.tryResolve<WorldManager>(ServiceKeys.World);
  }

  private resolveTransit(): TransportationSystem | null {
    return ServiceLocator.tryResolve<TransportationSystem>(ServiceKeys.Transportation);
  }
}
