/**
 * On-foot police officer entity.
 *
 * A {@link Character} configured for the police faction. Two ranks share the
 * class: regular officers (sidearm, standard health) and SWAT operators
 * (armored, automatic weapon), selected via {@link OfficerRank}. Weapons are
 * self-managed by the {@link WeaponComponent}, which pauses to reload when a
 * magazine runs dry, so officers fire in realistic bursts. The
 * {@link PoliceAIComponent} chases, shoots and busts the player while there is
 * heat — and walks a beat when there is none.
 */
import type Phaser from 'phaser';
import { Character } from '@/entities/Character';
import { PoliceAIComponent, WeaponComponent } from '@/entities/components';
import { WEAPONS, POLICE_WEAPON, SWAT_WEAPON } from '@/data';
import {
  damageAttribution,
  EntityKind,
  Faction,
  isPlayerResponsible,
  type DamageInfo,
  type DamageResult,
} from '@/gameplay/types';
import { TextureKeys } from '@/config/AssetKeys';
import { PLAYER, WANTED } from '@/config/Constants';
import { EventKeys } from '@/config/EventKeys';
import { eventBus } from '@/core/EventBus';

/** Police ranks with distinct gear and durability. */
export type OfficerRank = 'officer' | 'swat';

export class PoliceOfficer extends Character {
  /** Weapon component driving the officer's return fire. */
  private readonly weapon: WeaponComponent;

  /** AI component that chases, shoots and busts the player. */
  private readonly aiComp: PoliceAIComponent;

  /** This officer's rank (drives gear + durability). */
  public readonly rank: OfficerRank;

  /**
   * @param scene Owning Phaser scene.
   * @param x Spawn x in world pixels.
   * @param y Spawn y in world pixels.
   * @param rank Officer rank; SWAT operators are tougher and carry an SMG.
   * @param engagesPlayer Whether this unit hunts the player (beat cops don't).
   */
  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    rank: OfficerRank = 'officer',
    engagesPlayer = true,
  ) {
    super(scene, x, y, {
      textureKey: rank === 'swat' ? TextureKeys.CharSwat : TextureKeys.CharPolice,
      faction: Faction.Police,
      kind: EntityKind.Police,
      damageableKind: 'police',
      maxHealth: rank === 'swat' ? WANTED.SWAT_HEALTH : WANTED.POLICE_HEALTH,
      walkSpeed: WANTED.POLICE_SPEED,
      runSpeed: WANTED.POLICE_SPEED,
      radius: PLAYER.RADIUS,
    });
    this.rank = rank;

    // Officers self-manage their magazines (burst fire + reload pauses).
    this.weapon = this.addComponent(new WeaponComponent(Faction.Police, false));
    this.weapon.equip(WEAPONS[rank === 'swat' ? SWAT_WEAPON : POLICE_WEAPON]);

    this.aiComp = this.addComponent(new PoliceAIComponent(engagesPlayer));
  }

  /** The officer's weapon component. */
  public get weaponComp(): WeaponComponent {
    return this.weapon;
  }

  /** The officer's AI component. */
  public get ai(): PoliceAIComponent {
    return this.aiComp;
  }

  protected override onDamaged(info: DamageInfo, _result: DamageResult): void {
    if (!this.healthComp.isDead && isPlayerResponsible(info)) {
      eventBus.emit(EventKeys.CrimeCommitted, {
        crime: 'police-assault',
        position: this.position,
        attribution:
          this.healthComp.lastDamage?.attribution ??
          info.attribution ??
          damageAttribution('unknown', true),
      });
    }
  }

  /**
   * Report killing an officer as assaulting the police so the wanted system
   * escalates hard. Non-player kills (e.g. crossfire) raise no crime.
   *
   * @param info The fatal blow's ownership chain.
   */
  protected override onKilled(info: DamageInfo): void {
    if (isPlayerResponsible(info)) {
      eventBus.emit(EventKeys.CrimeCommitted, {
        crime: 'police-assault',
        position: this.position,
        attribution:
          this.healthComp.lastDamage?.attribution ??
          info.attribution ??
          damageAttribution('unknown', true),
      });
    }
  }
}
