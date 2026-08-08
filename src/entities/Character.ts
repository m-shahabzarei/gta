/**
 * On-foot character entity: the shared base for the player, pedestrians and
 * police officers.
 *
 * A `Character` binds an Arcade sprite (with a centred circular body) to the
 * three components that every walking actor needs — {@link HealthComponent},
 * {@link CharacterMovementComponent} and {@link CharacterAnimatorComponent} —
 * and implements the {@link IDamageable} contract so the combat system can hurt
 * and kill any character uniformly. Concrete subclasses add faction-specific
 * behaviour (inventory/weapons for the player, AI for NPCs) and override the
 * protected {@link Character.onDamaged} / {@link Character.onKilled} hooks.
 */
import type Phaser from 'phaser';
import { Entity } from '@/entities/Entity';
import {
  CharacterAnimatorComponent,
  CharacterMovementComponent,
  HealthComponent,
} from '@/entities/components';
import type { CharacterRig } from '@/graphics/CharacterRig';
import { DepthLayers } from '@/config/DepthLayers';
import { EventKeys } from '@/config/EventKeys';
import { eventBus } from '@/core/EventBus';
import {
  damageAttribution,
  isPlayerResponsible,
  type DamageInfo,
  type DamageResult,
  type EntityKind,
  type Faction,
  type IDamageable,
} from '@/gameplay/types';

/** How a character reports itself in combat events. */
export type CharacterDamageableKind = 'player' | 'pedestrian' | 'police' | 'animal';

/** Immutable construction parameters for a {@link Character}. */
export interface CharacterConfig {
  /** Texture key for the character sprite sheet (authored facing UP). */
  textureKey: string;
  /** Allegiance group used for hostility checks. */
  faction: Faction;
  /** Concrete entity taxonomy value. */
  kind: EntityKind;
  /** How this character labels itself in {@link EventKeys.EntityDamaged}. */
  damageableKind: CharacterDamageableKind;
  /** Starting and maximum hit points. */
  maxHealth: number;
  /** Ground speed while walking, in px/sec. */
  walkSpeed: number;
  /** Ground speed while running, in px/sec. */
  runSpeed: number;
  /** Radius of the circular physics body, in px. */
  radius: number;
  /** Optional flat tint applied over the sprite sheet. */
  tint?: number;
  /** Optional animation rig; defaults to the humanoid rig. */
  rig?: CharacterRig;
}

export abstract class Character extends Entity implements IDamageable {
  /** Which entity kind this character is (player / pedestrian / police). */
  public readonly entityKind: EntityKind;

  /** {@link IDamageable} id; mirrors the entity's stable {@link Entity.id}. */
  public get entityId(): number {
    return this.id;
  }

  /** This character's allegiance. */
  public readonly faction: Faction;

  /** How this character labels itself in combat events. */
  protected readonly damageableKind: CharacterDamageableKind;

  /** Health component; owns hit points, death and invulnerability. */
  private readonly health: HealthComponent;

  /** Locomotion component; translates move requests into body velocity. */
  private readonly movementComp: CharacterMovementComponent;

  /** Cosmetic animator; facing, walk bob, damage flash and corpse pose. */
  private readonly animator: CharacterAnimatorComponent;

  /**
   * @param scene Owning Phaser scene (provides the physics factory).
   * @param x Initial world x position.
   * @param y Initial world y position.
   * @param config Immutable character parameters.
   */
  constructor(scene: Phaser.Scene, x: number, y: number, config: CharacterConfig) {
    const sprite = scene.physics.add.sprite(x, y, config.textureKey);
    super(sprite);

    this.entityKind = config.kind;
    this.faction = config.faction;
    this.damageableKind = config.damageableKind;

    // Multi-frame sheets register their whole strip as the base frame; snap to
    // the idle frame FIRST so the body maths below sees one frame's size.
    if (sprite.texture.has('idle0')) {
      sprite.setFrame('idle0');
    }

    sprite.setDepth(DepthLayers.Characters);
    sprite.setCollideWorldBounds(true);

    // Centre the circular body on the sprite: setCircle anchors the circle at
    // the body's top-left, so offset by half the frame minus the radius.
    const body = sprite.body as Phaser.Physics.Arcade.Body;
    const offsetX = sprite.width / 2 - config.radius;
    const offsetY = sprite.height / 2 - config.radius;
    body.setCircle(config.radius, offsetX, offsetY);

    this.health = this.addComponent(new HealthComponent(config.maxHealth));
    this.movementComp = this.addComponent(
      new CharacterMovementComponent(config.walkSpeed, config.runSpeed),
    );
    this.animator = this.addComponent(new CharacterAnimatorComponent(config.rig));
    // Route the tint through the animator so damage flashes restore it.
    this.animator.setBaseTint(config.tint ?? null);
  }

  /** Whether this character has died. */
  public get isDead(): boolean {
    return this.health.isDead;
  }

  /** Whether this character is still alive. */
  public get isAlive(): boolean {
    return !this.health.isDead;
  }

  /** Locomotion component for controllers and AI. */
  public get movement(): CharacterMovementComponent {
    return this.movementComp;
  }

  /** Health component for controllers and AI. */
  public get healthComp(): HealthComponent {
    return this.health;
  }

  /**
   * Apply a hit. Ignored once dead; otherwise damages health, flashes the
   * sprite, emits {@link EventKeys.EntityDamaged} and — if this hit was fatal —
   * routes into death handling.
   *
   * @param info Damage payload.
   */
  public applyDamage(info: DamageInfo): DamageResult {
    if (this.health.isDead) {
      return this.health.applyDamage(info);
    }
    const result = this.health.applyDamage(info);
    if (result.ignored !== null) return result;
    this.animator.damageFlash();
    if (info.knockback) this.movementComp.applyImpulse(info.knockback);

    const position = this.position;
    eventBus.emit(EventKeys.EntityDamaged, {
      targetId: this.id,
      kind: this.damageableKind,
      amount: result.absorbedByArmor + result.appliedToHealth,
      health: this.health.health,
      position,
    });

    this.onDamaged(info, result);

    if (this.health.isDead) {
      this.handleDeath(info);
    }
    return result;
  }

  /**
   * Drive movement this frame in a desired direction.
   *
   * @param x Desired x direction component (unnormalised is fine).
   * @param y Desired y direction component.
   * @param run Whether to move at run speed.
   */
  public moveDir(x: number, y: number, run: boolean): void {
    this.movementComp.setMoveVector(x, y, run);
  }

  /**
   * Force the facing angle for this frame.
   *
   * @param angle Facing angle in radians (0 = +x / east).
   */
  public face(angle: number): void {
    this.movementComp.setFacingAngle(angle);
  }

  /** Halt locomotion; the body stops on the next update. */
  public stopMoving(): void {
    this.movementComp.stop();
  }

  /** Restore common character state when a scene-local pool reuses this actor. */
  protected resetCharacter(x: number, y: number, tint: number | null): void {
    const sprite = this.sprite;
    sprite
      .setPosition(x, y)
      .setActive(true)
      .setVisible(true)
      .setAlpha(1)
      .setScale(1)
      .setRotation(0);
    this.health.reset();
    this.movementComp.reset();
    this.animator.setBaseTint(tint);
    this.animator.reset();
    const body = sprite.body as Phaser.Physics.Arcade.Body;
    body.enable = true;
    body.reset(x, y);
  }

  /** Stop simulation/rendering while retaining allocations in a scene-local pool. */
  protected deactivateCharacter(): void {
    this.movementComp.stop();
    const body = this.sprite.body as Phaser.Physics.Arcade.Body;
    body.setVelocity(0, 0);
    body.enable = false;
    this.sprite.setActive(false).setVisible(false);
  }

  /**
   * Resolve a fatal hit: play the death pose, freeze locomotion, disable the
   * physics body, emit {@link EventKeys.EntityKilled} and invoke the subclass
   * {@link Character.onKilled} hook.
   *
   * @param info The forensic record of the killing blow.
   */
  private handleDeath(info: DamageInfo): void {
    this.animator.playDeath();
    this.movementComp.setEnabled(false);

    const body = this.sprite.body as Phaser.Physics.Arcade.Body;
    body.setVelocity(0, 0);
    body.enable = false;

    eventBus.emit(EventKeys.EntityKilled, {
      targetId: this.id,
      kind: this.damageableKind,
      position: this.position,
      byPlayer: isPlayerResponsible(info),
      attribution:
        this.health.lastDamage?.attribution ??
        info.attribution ??
        damageAttribution('unknown', isPlayerResponsible(info)),
    });

    this.onKilled(info);
  }

  /**
   * Hook invoked after non-fatal damage is applied. Default is a no-op;
   * subclasses override to emit faction-specific events.
   *
   * @param _info Damage payload that was applied.
   */
  protected onDamaged(_info: DamageInfo, _result: DamageResult): void {}

  /**
   * Hook invoked once this character dies. Default is a no-op; subclasses
   * override to raise crimes, wanted level or player-death events.
   *
   * @param _info The source/ownership chain of the killing blow.
   */
  protected onKilled(_info: DamageInfo): void {}
}
