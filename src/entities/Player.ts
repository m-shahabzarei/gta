/**
 * The player avatar: a {@link Character} extended with an inventory, a weapon,
 * an armor pool and the player-specific combat, firing, reloading and respawn
 * behaviour.
 *
 * The base {@link Character} already supplies health, movement and animation;
 * this subclass layers on the wallet/armoury ({@link InventoryComponent}), the
 * firing + reload pipeline ({@link WeaponComponent}) and the HUD-facing events
 * the rest of the game listens for (damage, health, armor, death). All world
 * interaction (aiming, spawning, wanted level) is driven by systems that call
 * the public API below.
 */
import type Phaser from 'phaser';
import { Character } from '@/entities/Character';
import {
  InventoryComponent,
  WeaponComponent,
  CharacterAnimatorComponent,
} from '@/entities/components';
import { TextureKeys } from '@/config/AssetKeys';
import { EventKeys } from '@/config/EventKeys';
import { eventBus } from '@/core/EventBus';
import { PLAYER } from '@/config/Constants';
import { EntityKind, Faction } from '@/gameplay/types';
import type { DamageInfo } from '@/gameplay/types';
import type {
  DamageResult,
  PlayerVitalsChangeReason,
  PlayerVitalsSnapshot,
} from '@/gameplay/types';

export class Player extends Character {
  /** Wallet and armoury; the single source of truth for money and ammo. */
  private readonly inv: InventoryComponent;

  /** Firing pipeline; gated by the inventory's ammo. */
  private readonly weapon: WeaponComponent;

  /**
   * @param scene Owning Phaser scene.
   * @param x Spawn x in world pixels.
   * @param y Spawn y in world pixels.
   */
  constructor(scene: Phaser.Scene, x: number, y: number) {
    super(scene, x, y, {
      textureKey: TextureKeys.CharPlayer,
      faction: Faction.Player,
      kind: EntityKind.Player,
      damageableKind: 'player',
      maxHealth: PLAYER.MAX_HEALTH,
      walkSpeed: PLAYER.WALK_SPEED,
      runSpeed: PLAYER.RUN_SPEED,
      radius: PLAYER.RADIUS,
    });

    this.inv = this.addComponent(new InventoryComponent(PLAYER.START_MONEY));
    this.weapon = this.addComponent(new WeaponComponent(Faction.Player, true));

    // Armor pool: starts empty, capped at the configured maximum.
    this.healthComp.setArmor(0, PLAYER.MAX_ARMOR);

    // Gate firing on ammunition and spend a round on every successful shot;
    // route reloads through the inventory's magazine/reserve transfer.
    this.weapon.setGates(
      () => this.inv.hasAmmo(),
      () => this.inv.consumeAmmo(),
    );
    this.weapon.setReloadGates(
      () => this.inv.canReload(),
      () => this.inv.performReload(),
    );
    this.weapon.equip(this.inv.currentWeapon);
  }

  /** The player's inventory (money, owned weapons, ammo). */
  public get inventory(): InventoryComponent {
    return this.inv;
  }

  /** The player's weapon/firing component. */
  public get weaponComp(): WeaponComponent {
    return this.weapon;
  }

  /** Current armor points. */
  public get armor(): number {
    return this.healthComp.armor;
  }

  public get currentHP(): number {
    return this.healthComp.health;
  }

  public get maxHP(): number {
    return this.healthComp.maxHealth;
  }

  public get deadState(): boolean {
    return this.healthComp.isDead;
  }

  public get vitals(): PlayerVitalsSnapshot {
    return {
      currentHP: this.healthComp.health,
      maxHP: this.healthComp.maxHealth,
      armor: this.healthComp.armor,
      maxArmor: this.healthComp.maxArmor,
      dead: this.healthComp.isDead,
    };
  }

  /**
   * Grant armor points (pickup / shop purchase) and notify the HUD.
   * @param amount Armor points to add.
   */
  public giveArmor(amount: number): void {
    const before = this.healthComp.armor;
    this.healthComp.addArmor(amount);
    if (this.healthComp.armor !== before) this.publishVitals('armor');
  }

  /**
   * Restore health points (pickup / hospital service) and notify the HUD.
   * @param amount Hit points to restore.
   */
  public giveHealth(amount: number): void {
    const before = this.healthComp.health;
    this.healthComp.heal(amount);
    if (this.healthComp.health !== before) this.publishVitals('healing');
  }

  public restoreVitals(health: number, armor: number): void {
    this.healthComp.restore(health, armor);
    this.publishVitals('restore');
  }

  /**
   * Attempt to fire the equipped weapon along an aim angle.
   *
   * @param angle Aim angle in radians (0 = east).
   * @returns Whether a shot was actually dispatched.
   */
  public fireAt(angle: number): boolean {
    return this.weapon.tryFire(angle);
  }

  /** Begin reloading the equipped weapon (no-op when impossible). */
  public startReload(): boolean {
    return this.weapon.startReload();
  }

  /**
   * Cycle the selected weapon and re-equip it in the firing pipeline.
   *
   * @param dir +1 to advance to the next weapon, -1 for the previous.
   */
  public switchWeapon(dir: 1 | -1): void {
    if (dir === 1) {
      this.inv.switchNext();
    } else {
      this.inv.switchPrev();
    }
    this.weapon.equip(this.inv.currentWeapon);
  }

  /** Re-equip the inventory's current weapon (after external switches). */
  public refreshEquippedWeapon(): void {
    this.weapon.equip(this.inv.currentWeapon);
  }

  /**
   * Revive the player at a new location: refill health, reposition and
   * re-enable the physics body, grant brief spawn invulnerability and resume
   * control.
   *
   * @param x Respawn x in world pixels.
   * @param y Respawn y in world pixels.
   */
  public respawn(x: number, y: number): void {
    this.healthComp.reset(PLAYER.MAX_HEALTH);
    this.healthComp.setArmor(0, PLAYER.MAX_ARMOR);
    this.sprite.enableBody(true, x, y, true, true);
    this.healthComp.setInvulnerable(PLAYER.RESPAWN_INVULN_MS);
    this.getComponent<CharacterAnimatorComponent>('animator')?.reset();
    this.movement.setEnabled(true);
    this.publishVitals('respawn');
  }

  /**
   * Broadcast damage taken so the HUD can react to the hit, the new health
   * total and the (possibly drained) armor.
   *
   * @param info The damage that was just applied.
   */
  protected override onDamaged(info: DamageInfo, result: DamageResult): void {
    const critical = this.healthComp.healthRatio <= 0.25;
    const flashColor =
      info.type === 'explosion'
        ? 0xffaa33
        : info.type === 'fire'
          ? 0xff6633
          : info.type === 'vehicle'
            ? 0x5da9ff
            : 0xff3355;
    eventBus.emit(EventKeys.CameraFlash, {
      durationMs: critical ? 140 : 80,
      color: flashColor,
    });
    if (critical) {
      eventBus.emit(EventKeys.CameraShake, {
        durationMs: 110,
        intensity: 0.004,
      });
    }
    eventBus.emit(EventKeys.PlayerDamaged, {
      amount: result.absorbedByArmor + result.appliedToHealth,
      health: this.healthComp.health,
    });
    this.publishVitals('damage');
  }

  /**
   * Announce the player's death so the game-flow / wanted systems can respond.
   *
   * @param _info Unused; the player never kills themselves via this path.
   */
  protected override onKilled(_info: DamageInfo): void {
    const dropped = this.inv.dropEquippedWeapon();
    if (dropped) {
      this.weapon.equip(this.inv.currentWeapon);
      eventBus.emit(EventKeys.WeaponDropped, { ...dropped, position: this.position });
    }
    eventBus.emit(EventKeys.PlayerDied, { position: this.position });
  }

  public publishInitialVitals(): void {
    this.publishVitals('spawn');
  }

  private publishVitals(reason: PlayerVitalsChangeReason): void {
    eventBus.emit(EventKeys.PlayerVitalsChanged, { ...this.vitals, reason });
  }
}
