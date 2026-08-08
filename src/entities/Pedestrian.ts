/**
 * Ambient civilian pedestrian entity.
 *
 * A {@link Character} specialised for the wandering, panicking crowd that fills
 * the city sidewalks. It wires up the pedestrian-flavoured configuration
 * (health, speed, radius and the profile's own generated sprite sheet) and
 * attaches a {@link PedestrianAIComponent} to drive ambient behaviour. When a
 * pedestrian is gunned down by the player it reports a `murder` crime on the
 * {@link eventBus} so the wanted system can react.
 */
import type Phaser from 'phaser';
import { eventBus } from '@/core/EventBus';
import { EventKeys } from '@/config/EventKeys';
import { PED } from '@/config/Constants';
import {
  damageAttribution,
  EntityKind,
  Faction,
  isPlayerResponsible,
  type DamageInfo,
  type DamageResult,
  type NpcPersonality,
  type PedProfile,
} from '@/gameplay/types';
import { personalityFromSeed } from '@/gameplay/crime/CrimeRules';
import { Character } from '@/entities/Character';
import { PedestrianAIComponent } from '@/entities/components/PedestrianAIComponent';

/** Multiplier applied to a profile's walk speed to obtain its panic-run speed. */
const RUN_SPEED_FACTOR = 2.2;

/**
 * A civilian pedestrian: an AI-driven character with its own generated look
 * that roams the streets and flees from danger.
 */
export class Pedestrian extends Character {
  /** Ambient behaviour brain attached to this pedestrian. */
  private readonly aiComponent: PedestrianAIComponent;
  private readonly profileIdValue: string;
  private personalityValue: NpcPersonality;

  /**
   * Construct a pedestrian from a behavioural/appearance profile.
   * @param scene Owning Phaser scene.
   * @param x Initial world x position.
   * @param y Initial world y position.
   * @param profile Profile supplying the sprite sheet and walk speed.
   */
  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    profile: PedProfile,
    personality?: NpcPersonality,
  ) {
    super(scene, x, y, {
      textureKey: profile.textureKey,
      faction: Faction.Civilian,
      kind: EntityKind.Pedestrian,
      damageableKind: 'pedestrian',
      maxHealth: PED.MAX_HEALTH,
      walkSpeed: profile.speed,
      runSpeed: profile.speed * RUN_SPEED_FACTOR,
      radius: PED.RADIUS,
      tint: profile.tint,
    });
    this.profileIdValue = profile.id;
    this.personalityValue = personality ?? personalityFromSeed(this.id * 2654435761);
    this.aiComponent = this.addComponent(new PedestrianAIComponent());
  }

  public get profileId(): string {
    return this.profileIdValue;
  }

  public get personality(): NpcPersonality {
    return this.personalityValue;
  }

  /** The pedestrian's ambient behaviour brain. */
  public get ai(): PedestrianAIComponent {
    return this.aiComponent;
  }

  /** Whether this pedestrian walked into a building and can be removed. */
  public get wantsDespawn(): boolean {
    return this.aiComponent.wantsDespawn;
  }

  /**
   * Spook this pedestrian into fleeing away from a danger point.
   * @param x World x of the danger source.
   * @param y World y of the danger source.
   */
  public alarm(x: number, y: number): void {
    this.aiComponent.alarm(x, y);
  }

  public resetForReuse(
    x: number,
    y: number,
    profile: PedProfile,
    personality?: NpcPersonality,
  ): void {
    this.resetCharacter(x, y, profile.tint ?? null);
    this.personalityValue = personality ?? personalityFromSeed(this.id * 2654435761 + x + y);
    this.sprite.data?.remove('interiorId');
    this.aiComponent.reset();
  }

  public deactivateForPool(): void {
    this.aiComponent.reset();
    this.deactivateCharacter();
  }

  protected override onDamaged(info: DamageInfo, _result: DamageResult): void {
    if (!this.healthComp.isDead && isPlayerResponsible(info)) {
      eventBus.emit(EventKeys.CrimeCommitted, {
        crime: 'assault',
        position: this.position,
        attribution:
          this.healthComp.lastDamage?.attribution ??
          info.attribution ??
          damageAttribution('unknown', true),
      });
    }
  }

  /**
   * Report a murder crime when the killing blow came from the player.
   * @param info The fatal damage's ownership chain.
   */
  protected override onKilled(info: DamageInfo): void {
    if (isPlayerResponsible(info)) {
      eventBus.emit(EventKeys.CrimeCommitted, {
        crime: 'murder',
        position: this.position,
        attribution:
          this.healthComp.lastDamage?.attribution ??
          info.attribution ??
          damageAttribution('unknown', true),
      });
    }
  }
}
