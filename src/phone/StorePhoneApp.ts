import type Phaser from 'phaser';
import type { PhoneAppDefinition } from './PhoneTypes';
import { PhoneStoreView } from '@/ui/phone/PhoneStoreView';

/** Stable id for the built-in Store system app. */
export const STORE_APP_ID = 'store';

function renderStoreIcon(graphics: Phaser.GameObjects.Graphics, size: number): void {
  const half = Math.max(6, size);
  graphics.clear();
  graphics.lineStyle(Math.max(2, Math.round(size * 0.14)), 0xffcc33, 1);
  graphics.strokeRoundedRect(-half, -half * 0.42, half * 2, half * 1.04, Math.max(2, size * 0.14));
  graphics.lineBetween(-half * 0.42, -half * 0.42, -half * 0.42, -half * 0.82);
  graphics.lineBetween(half * 0.42, -half * 0.42, half * 0.42, -half * 0.82);
  graphics.lineBetween(-half * 0.42, -half * 0.82, half * 0.42, -half * 0.82);
  graphics.fillStyle(0xffcc33, 1);
  graphics.fillRect(-half * 0.52, half * 0.06, half * 0.24, half * 0.22);
  graphics.fillRect(-half * 0.12, half * 0.06, half * 0.24, half * 0.22);
  graphics.fillRect(half * 0.28, half * 0.06, half * 0.24, half * 0.22);
}

/** Built-in app definition; the Store itself is never listed in its catalog. */
export const StorePhoneApp: PhoneAppDefinition = {
  id: STORE_APP_ID,
  title: 'Store',
  titleKey: 'phoneStore',
  sortOrder: -100,
  systemApp: true,
  installable: false,
  pauseGameplay: true,
  renderIcon: renderStoreIcon,
  createView: (context) => new PhoneStoreView(context.scene, context),
};
