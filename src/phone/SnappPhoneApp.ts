import Phaser from 'phaser';
import type { PhoneAppDefinition } from './PhoneTypes';
import { SnappPhoneView } from '@/ui/phone/SnappPhoneView';

/** Stable Store id for the first real installable Phone application. */
export const SNAPP_APP_ID = 'snapp';

function renderSnappIcon(graphics: Phaser.GameObjects.Graphics, size: number): void {
  const s = Math.max(6, size);
  graphics.clear();
  graphics.fillStyle(0x13c8bc, 1);
  graphics.fillRoundedRect(-s, -s * 0.42, s * 2, s * 0.9, Math.max(2, s * 0.16));
  graphics.fillStyle(0x071a1d, 1);
  graphics.fillCircle(-s * 0.55, s * 0.45, s * 0.18);
  graphics.fillCircle(s * 0.55, s * 0.45, s * 0.18);
  graphics.fillStyle(0xf2ffff, 1);
  graphics.fillRect(-s * 0.55, -s * 0.15, s * 1.1, Math.max(2, s * 0.16));
}

/** Snapp is catalog-installed and never seeded into Home by default. */
export const SnappPhoneApp: PhoneAppDefinition = {
  id: SNAPP_APP_ID,
  title: 'Snapp',
  titleKey: 'phoneSnapp',
  sortOrder: 10,
  systemApp: false,
  installable: true,
  pauseGameplay: true,
  renderIcon: renderSnappIcon,
  createView: (context) => new SnappPhoneView(context.scene, context),
};
