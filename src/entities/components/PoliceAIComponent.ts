import Phaser from 'phaser';
import { Component } from '@/entities/Component';
import { ServiceLocator } from '@/core/ServiceLocator';
import { ServiceKeys } from '@/config/ServiceKeys';
import { WANTED } from '@/config/Constants';
import type { Vector2 } from '@/core/types';
import {
  Faction,
  getNavigationService,
  getPlayerRef,
  getWantedService,
  getWorldQuery,
  type INavigationService,
  type IPlayerRef,
  type IWantedService,
  type PoliceDirective,
} from '@/gameplay/types';
import type { CharacterMovementComponent } from './CharacterMovementComponent';
import type { WeaponComponent } from './WeaponComponent';
import { EntityCategory, type EntityManager } from '@/systems/EntityManager';

export type PoliceState =
  'Patrol' | 'Investigate' | 'Respond' | 'FootChase' | 'Combat' | 'Search' | 'ReturnToVehicle';

const PATROL_ARRIVE_RADIUS = 14;
const PATH_ARRIVE_RADIUS = 12;
const REPATH_MS = 1100;
const FRIENDLY_FIRE_CORRIDOR = 13;
const SEPARATION_RADIUS = 30;

/** On-foot police execution of explicit, knowledge-bounded directives. */
export class PoliceAIComponent extends Component {
  public readonly name = 'ai';

  private movement: CharacterMovementComponent | null = null;
  private weapon: WeaponComponent | null = null;
  private playerRef: IPlayerRef | null = null;
  private wanted: IWantedService | null = null;
  private navigation: INavigationService | null = null;
  private state: PoliceState = 'Patrol';
  private patrolTarget: Vector2 | null = null;
  private patrolPauseMs = 0;
  private path: Vector2[] = [];
  private pathIndex = 0;
  private pathRequestId: number | null = null;
  private pathTarget: Vector2 | null = null;
  private repathMs = 0;
  private hasBusted = false;
  private destroyed = false;

  constructor(private readonly respondsToDirectives = true) {
    super();
  }

  public get currentState(): string {
    return this.state;
  }

  protected override onAttach(): void {
    this.movement = this.entity.getComponent<CharacterMovementComponent>('movement') ?? null;
    this.weapon = this.entity.getComponent<WeaponComponent>('weapon') ?? null;
  }

  public override update(_time: number, delta: number): void {
    const movement = this.movement;
    if (!movement) return;
    this.repathMs = Math.max(0, this.repathMs - delta);
    const wanted = this.resolveWanted();
    const directive = wanted?.directiveForOfficer(this.entity.id) ?? null;
    if (
      !this.respondsToDirectives ||
      !wanted ||
      !directive ||
      (wanted.level <= 0 && directive.mode !== 'return') ||
      directive.mode === 'patrol'
    ) {
      this.hasBusted = false;
      this.state = 'Patrol';
      this.updatePatrol(movement, delta);
      return;
    }

    const player = this.resolvePlayer();
    const playerPosition = player?.playerAlive ? player.playerPosition : null;
    const seesPlayer = playerPosition ? this.sees(playerPosition) : false;
    if (seesPlayer && playerPosition) wanted.reportOfficerSighting(this.entity.id, playerPosition);

    switch (directive.mode) {
      case 'investigate':
        this.state = 'Investigate';
        this.updateInvestigation(directive, playerPosition, seesPlayer, movement, delta);
        return;
      case 'respond':
        this.state = 'Respond';
        this.moveTo(directive.target, movement, delta, true);
        return;
      case 'search':
        this.state = 'Search';
        this.moveTo(directive.target, movement, delta, false);
        return;
      case 'return':
        this.state = 'ReturnToVehicle';
        this.moveTo(directive.target, movement, delta, false);
        return;
      case 'take-cover':
        this.state = directive.allowLethalForce ? 'Combat' : 'FootChase';
        if (directive.cover && !this.within(directive.cover, 11)) {
          this.moveTo(directive.cover, movement, delta, true);
          return;
        }
        movement.stop();
        this.faceKnownTarget(directive, movement);
        if (seesPlayer && playerPosition && directive.allowLethalForce) {
          this.fireIfClear(playerPosition, movement);
        }
        return;
      case 'arrest':
        this.state = 'FootChase';
        this.updateArrest(directive, player, playerPosition, seesPlayer, movement, delta);
        return;
      case 'engage':
        this.state = 'Combat';
        this.updateEngagement(directive, playerPosition, seesPlayer, movement, delta);
        return;
      default:
        this.state = 'Patrol';
        this.updatePatrol(movement, delta);
    }
  }

  private updateInvestigation(
    directive: PoliceDirective,
    playerPosition: Vector2 | null,
    seesPlayer: boolean,
    movement: CharacterMovementComponent,
    delta: number,
  ): void {
    const target = seesPlayer && playerPosition ? playerPosition : directive.target;
    if (seesPlayer && playerPosition && this.distance(playerPosition) <= 72) {
      movement.stop();
      movement.setFacingAngle(this.angleTo(playerPosition));
      return;
    }
    this.moveTo(target, movement, delta, true);
  }

  public override destroy(): void {
    this.destroyed = true;
    if (this.pathRequestId !== null) this.resolveNavigation()?.cancelRequest(this.pathRequestId);
    this.pathRequestId = null;
    this.path.length = 0;
    this.movement = null;
    this.weapon = null;
    this.playerRef = null;
    this.wanted = null;
    this.navigation = null;
    super.destroy();
  }

  private updateArrest(
    directive: PoliceDirective,
    player: IPlayerRef | null,
    playerPosition: Vector2 | null,
    seesPlayer: boolean,
    movement: CharacterMovementComponent,
    delta: number,
  ): void {
    if (seesPlayer && playerPosition) {
      const distance = this.distance(playerPosition);
      movement.setFacingAngle(this.angleTo(playerPosition));
      if (!player?.playerInVehicle && distance <= WANTED.POLICE_ARREST_RANGE) {
        movement.stop();
        if (!this.hasBusted) {
          this.hasBusted = true;
          this.resolveWanted()?.bustPlayer();
        }
        return;
      }
      this.moveTo(playerPosition, movement, delta, true);
      return;
    }
    this.hasBusted = false;
    this.moveTo(directive.target, movement, delta, true);
  }

  private updateEngagement(
    directive: PoliceDirective,
    playerPosition: Vector2 | null,
    seesPlayer: boolean,
    movement: CharacterMovementComponent,
    delta: number,
  ): void {
    if (!seesPlayer || !playerPosition) {
      this.moveTo(directive.target, movement, delta, true);
      return;
    }
    if (
      directive.cover &&
      !this.within(directive.cover, 12) &&
      (this.resolveNavigation()?.hasLineOfSight(directive.cover, playerPosition) ?? false)
    ) {
      this.moveTo(directive.cover, movement, delta, true);
      return;
    }
    const distance = this.distance(playerPosition);
    const weaponRange = Math.min(
      WANTED.POLICE_SHOOT_RANGE,
      this.weapon?.weapon?.range ?? WANTED.POLICE_SHOOT_RANGE,
    );
    if (distance > weaponRange * 0.88) {
      this.moveTo(playerPosition, movement, delta, true);
      return;
    }
    movement.stop();
    this.fireIfClear(playerPosition, movement);
  }

  private fireIfClear(target: Vector2, movement: CharacterMovementComponent): void {
    const angle = this.angleTo(target);
    movement.setFacingAngle(angle);
    if (!this.hasFriendlyInLine(target)) this.weapon?.tryFire(angle);
  }

  private moveTo(
    target: Vector2 | null,
    movement: CharacterMovementComponent,
    delta: number,
    run: boolean,
  ): void {
    if (!target) {
      movement.stop();
      return;
    }
    if (this.within(target, PATH_ARRIVE_RADIUS)) {
      movement.stop();
      return;
    }
    const navigation = this.resolveNavigation();
    const position = this.entity.position;
    if (navigation?.isClearLine(position, target, 'police')) {
      this.cancelPath();
      const desired = this.separatedDirection(target, navigation);
      movement.setMoveVector(desired.x, desired.y, run);
      return;
    }
    this.requestPath(target, navigation);
    if (!navigation) {
      movement.stop();
      return;
    }
    const waypoint = this.path[this.pathIndex];
    if (!waypoint) {
      movement.stop();
      return;
    }
    if (this.within(waypoint, PATH_ARRIVE_RADIUS)) {
      this.pathIndex += 1;
      this.moveTo(target, movement, delta, run);
      return;
    }
    const desired = this.separatedDirection(waypoint, navigation);
    movement.setMoveVector(desired.x, desired.y, run);
    void delta;
  }

  private requestPath(target: Vector2, navigation: INavigationService | null): void {
    if (!navigation || this.pathRequestId !== null) return;
    const changed =
      !this.pathTarget ||
      Phaser.Math.Distance.Squared(this.pathTarget.x, this.pathTarget.y, target.x, target.y) >
        42 * 42;
    if (!changed && this.path.length > 0 && this.repathMs > 0) return;
    this.pathTarget = { ...target };
    this.repathMs = REPATH_MS;
    const requestId = navigation.requestPath(
      this.entity.position,
      target,
      'police',
      (result) => {
        if (this.destroyed || this.pathRequestId !== requestId) return;
        this.pathRequestId = null;
        this.path = result.waypoints?.map((point) => ({ ...point })) ?? [];
        this.pathIndex = this.path.length > 1 ? 1 : 0;
      },
      1,
    );
    this.pathRequestId = requestId;
  }

  private cancelPath(): void {
    if (this.pathRequestId !== null) this.resolveNavigation()?.cancelRequest(this.pathRequestId);
    this.pathRequestId = null;
    this.path.length = 0;
    this.pathIndex = 0;
  }

  private separatedDirection(target: Vector2, navigation: INavigationService): Vector2 {
    const position = this.entity.position;
    let dx = target.x - position.x;
    let dy = target.y - position.y;
    const neighbours = navigation.queryNearby(
      position.x,
      position.y,
      SEPARATION_RADIUS,
      this.entity.id,
    );
    for (const neighbour of neighbours) {
      const awayX = position.x - neighbour.x;
      const awayY = position.y - neighbour.y;
      const distanceSq = Math.max(16, awayX * awayX + awayY * awayY);
      dx += (awayX / distanceSq) * 150;
      dy += (awayY / distanceSq) * 150;
    }
    return { x: dx, y: dy };
  }

  private updatePatrol(movement: CharacterMovementComponent, delta: number): void {
    if (this.patrolPauseMs > 0) {
      this.patrolPauseMs -= delta;
      movement.stop();
      return;
    }
    if (!this.patrolTarget) {
      const point = getWorldQuery()?.randomSidewalkPointNear(
        this.entity.position.x,
        this.entity.position.y,
        320,
      );
      if (!point) {
        movement.stop();
        return;
      }
      this.patrolTarget = { ...point };
    }
    if (this.within(this.patrolTarget, PATROL_ARRIVE_RADIUS)) {
      this.patrolTarget = null;
      this.patrolPauseMs = 1000 + (this.entity.id % 5) * 420;
      movement.stop();
      return;
    }
    this.moveTo(this.patrolTarget, movement, delta, false);
  }

  private sees(target: Vector2): boolean {
    if (this.distance(target) > WANTED.SIGHT_RANGE) return false;
    return this.resolveNavigation()?.hasLineOfSight(this.entity.position, target) ?? false;
  }

  private hasFriendlyInLine(target: Vector2): boolean {
    const entities = ServiceLocator.tryResolve<EntityManager>(ServiceKeys.Entity);
    if (!entities) return false;
    const from = this.entity.position;
    const midpoint = { x: (from.x + target.x) / 2, y: (from.y + target.y) / 2 };
    const radius = this.distance(target) / 2 + FRIENDLY_FIRE_CORRIDOR;
    let blocked = false;
    entities.forEachNearby(
      midpoint.x,
      midpoint.y,
      radius,
      (entity) => {
        if (blocked || entity.id === this.entity.id) return;
        const faction = (entity as unknown as { faction?: Faction }).faction;
        if (faction !== Faction.Police) return;
        if (distanceToSegment(entity.position, from, target) <= FRIENDLY_FIRE_CORRIDOR) {
          blocked = true;
        }
      },
      EntityCategory.Npc,
    );
    return blocked;
  }

  private faceKnownTarget(directive: PoliceDirective, movement: CharacterMovementComponent): void {
    if (directive.target) movement.setFacingAngle(this.angleTo(directive.target));
  }

  private within(target: Vector2, radius: number): boolean {
    return this.distance(target) <= radius;
  }

  private distance(target: Vector2): number {
    const position = this.entity.position;
    return Math.hypot(target.x - position.x, target.y - position.y);
  }

  private angleTo(target: Vector2): number {
    const position = this.entity.position;
    return Math.atan2(target.y - position.y, target.x - position.x);
  }

  private resolvePlayer(): IPlayerRef | null {
    if (!this.playerRef) this.playerRef = getPlayerRef();
    return this.playerRef;
  }

  private resolveWanted(): IWantedService | null {
    if (!this.wanted) this.wanted = getWantedService();
    return this.wanted;
  }

  private resolveNavigation(): INavigationService | null {
    if (!this.navigation) this.navigation = getNavigationService();
    return this.navigation;
  }
}

function distanceToSegment(point: Vector2, start: Vector2, end: Vector2): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq <= 1e-6) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Phaser.Math.Clamp(
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq,
    0,
    1,
  );
  return Math.hypot(point.x - (start.x + dx * t), point.y - (start.y + dy * t));
}
