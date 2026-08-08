/**
 * Ambient animal entity (dogs and cats).
 *
 * A lightweight {@link Character} using the compact quadruped rig and the
 * standard {@link PedestrianAIComponent} brain, so animals wander the
 * sidewalks, scatter from danger and can be run over or shot like any other
 * soft target. Killing an animal raises no crime — it just isn't a murder —
 * but nearby pedestrians still panic from the gunfire itself.
 */
import type Phaser from 'phaser';
import { Character } from '@/entities/Character';
import { PedestrianAIComponent } from '@/entities/components/PedestrianAIComponent';
import { ANIMAL_RIG } from '@/graphics/CharacterRig';
import { EntityKind, Faction } from '@/gameplay/types';
import type { AnimalProfile } from '@/gameplay/types';

/** Multiplier applied to an animal's trot speed when it bolts. */
const BOLT_SPEED_FACTOR = 2.4;

/** Physics body radius (px) for animals. */
const ANIMAL_RADIUS = 6;

export class Animal extends Character {
  /** The wander/flee brain shared with pedestrians. */
  private readonly aiComponent: PedestrianAIComponent;

  /** The species profile this animal was built from. */
  public readonly profile: AnimalProfile;

  /**
   * @param scene Owning Phaser scene.
   * @param x Initial world x position.
   * @param y Initial world y position.
   * @param profile Species profile (texture, speed, health).
   */
  constructor(scene: Phaser.Scene, x: number, y: number, profile: AnimalProfile) {
    super(scene, x, y, {
      textureKey: profile.textureKey,
      faction: Faction.Civilian,
      kind: EntityKind.Animal,
      damageableKind: 'animal',
      maxHealth: profile.health,
      walkSpeed: profile.speed,
      runSpeed: profile.speed * BOLT_SPEED_FACTOR,
      radius: ANIMAL_RADIUS,
      rig: ANIMAL_RIG,
    });
    this.profile = profile;
    this.aiComponent = this.addComponent(
      new PedestrianAIComponent({ canSit: false, canConverse: false, canWitness: false }),
    );
  }

  /** Spook this animal into bolting away from a danger point. */
  public alarm(x: number, y: number): void {
    this.aiComponent.alarm(x, y);
  }
}
