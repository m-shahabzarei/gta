import type Phaser from 'phaser';
import { IS_DEV } from '@/config/Constants';
import { ServiceKeys } from '@/config/ServiceKeys';
import { ServiceLocator } from '@/core/ServiceLocator';
import type { PlayerController } from '@/systems/PlayerController';
import type { WantedSystem } from '@/systems/WantedSystem';
import type { CombatSystem } from '@/systems/CombatSystem';

const REFRESH_INTERVAL_MS = 100;

export class GameplayDebugOverlay {
  private element: HTMLPreElement | null = null;
  private visible = false;
  private elapsed = 0;

  constructor(private readonly scene: Phaser.Scene) {
    if (!IS_DEV) return;
    scene.input.keyboard?.on('keydown-F8', this.toggle, this);
    this.createElement();
  }

  public update(delta: number): void {
    if (!this.visible) return;
    this.elapsed += delta;
    if (this.elapsed < REFRESH_INTERVAL_MS) return;
    this.elapsed = 0;
    this.refresh();
  }

  public destroy(): void {
    if (IS_DEV) this.scene.input.keyboard?.off('keydown-F8', this.toggle, this);
    this.element?.remove();
    this.element = null;
    this.visible = false;
  }

  private toggle(): void {
    this.visible = !this.visible;
    if (this.element) this.element.style.display = this.visible ? 'block' : 'none';
    if (this.visible) this.refresh();
  }

  private createElement(): void {
    if (typeof document === 'undefined') return;
    const element = document.createElement('pre');
    element.id = 'gameplay-debug-overlay';
    element.setAttribute('role', 'status');
    element.setAttribute('aria-live', 'polite');
    Object.assign(element.style, {
      position: 'fixed',
      left: '8px',
      bottom: '8px',
      zIndex: '2147483647',
      display: 'none',
      width: 'min(390px, calc(100vw - 16px))',
      boxSizing: 'border-box',
      margin: '0',
      padding: '8px',
      border: '1px solid #64748b',
      borderRadius: '4px',
      background: 'rgba(10, 15, 20, 0.95)',
      color: '#f8fafc',
      font: '12px/1.45 Inter, Consolas, "Courier New", monospace',
      fontVariantNumeric: 'tabular-nums',
      letterSpacing: '0',
      pointerEvents: 'none',
      userSelect: 'none',
      whiteSpace: 'pre-wrap',
      overflowWrap: 'anywhere',
    });
    document.body.appendChild(element);
    this.element = element;
  }

  private refresh(): void {
    if (!this.element) return;
    const player = ServiceLocator.tryResolve<PlayerController>(ServiceKeys.Player)?.player ?? null;
    const wanted = ServiceLocator.tryResolve<WantedSystem>(ServiceKeys.Wanted) ?? null;
    const combat = ServiceLocator.tryResolve<CombatSystem>(ServiceKeys.Combat) ?? null;
    const vitals = player?.vitals ?? null;
    const police = wanted?.debugSnapshot() ?? null;
    const damage = combat?.debugSnapshot() ?? null;
    this.element.textContent = [
      'GAMEPLAY SYSTEMS',
      `HP       ${format(vitals?.currentHP)} / ${format(vitals?.maxHP)}`,
      `ARMOR    ${format(vitals?.armor)} / ${format(vitals?.maxArmor)}`,
      `DEAD     ${vitals?.dead === true ? 'YES' : 'NO'}`,
      `INCOMING ${format(damage?.incomingDamage)} requested`,
      `DAMAGE   ${format(damage?.appliedDamage)} HP / ${format(damage?.absorbedByArmor)} armor`,
      `SOURCE   ${damage?.lastDamageSource ?? 'none'}`,
      `POLICE   ${format(damage?.policeBulletDamage)} bullet damage`,
      `COLLIDE  ${damage?.collisionResult ?? 'none'}`,
      '',
      `WANTED   ${police?.level ?? 0} / 5`,
      `PHASE    ${police?.phase ?? 'clear'}`,
      `UNITS    ${police?.activePoliceUnits ?? 0} officers / ${police?.activeResponders ?? 0} response`,
      `PATROLS  ${police?.patrolVehicles ?? 0} vehicles`,
      `WAVE     ${police?.waveIndex ?? 0} / next ${format(police?.nextWaveMs)} ms`,
      `ROADBLK  ${police?.roadblocksActive ?? 0}`,
      `HELI     ${police?.helicopterActive === true ? police.helicopterState : 'inactive'}`,
      `STATE    ${police?.primaryUnitState ?? 'None'}`,
      `AI       ${police?.primaryOfficerState ?? 'None'}`,
      `TACTIC   ${police?.responseProfile.engagement ?? 'investigate'}`,
    ].join('\n');
  }
}

function format(value: number | undefined): string {
  return value === undefined ? '--' : Math.round(value).toString();
}
