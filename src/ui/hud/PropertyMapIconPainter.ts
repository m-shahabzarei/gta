import Phaser from 'phaser';
import type { PropertyMapStatus } from '@/gameplay/HousingMapPresentation';

/** Status colors are deliberately distinct from mission, police, and hospital markers. */
export const PROPERTY_MAP_COLORS: Readonly<Record<PropertyMapStatus, number>> = Object.freeze({
  'for-sale': 0xffb020,
  owned: 0x2dd4bf,
  active: 0x86efac,
});

export const REAL_ESTATE_OFFICE_COLOR = 0xa78bfa;

/** Draw a crisp screen-space house marker with a non-color status detail. */
export function paintPropertyMapIcon(
  graphics: Phaser.GameObjects.Graphics,
  status: PropertyMapStatus,
  x: number,
  y: number,
  size: number,
): void {
  const radius = Math.max(9, Math.round(size));
  const accent = PROPERTY_MAP_COLORS[status];
  const left = Math.round(x - radius);
  const top = Math.round(y - radius);
  const diameter = radius * 2;

  if (status === 'active') {
    graphics.lineStyle(2, accent, 0.8);
    graphics.strokeCircle(x, y, radius + 4);
  }

  graphics.fillStyle(0x070a12, 0.92);
  graphics.fillRoundedRect(left, top, diameter, diameter, 5);
  graphics.lineStyle(status === 'active' ? 2.5 : 2, accent, 1);
  graphics.strokeRoundedRect(left, top, diameter, diameter, 5);

  const roofY = Math.round(y - radius * 0.46);
  const wallTop = Math.round(y - radius * 0.03);
  const wallWidth = Math.round(radius * 1.08);
  const wallHeight = Math.max(6, Math.round(radius * 0.72));

  graphics.fillStyle(accent, 1);
  graphics.beginPath();
  graphics.moveTo(x, roofY - Math.round(radius * 0.34));
  graphics.lineTo(x + Math.round(radius * 0.72), roofY + Math.round(radius * 0.28));
  graphics.lineTo(x - Math.round(radius * 0.72), roofY + Math.round(radius * 0.28));
  graphics.closePath();
  graphics.fillPath();
  graphics.fillRoundedRect(Math.round(x - wallWidth / 2), wallTop, wallWidth, wallHeight, 1);

  graphics.fillStyle(0x071018, 1);
  graphics.fillRect(
    Math.round(x - radius * 0.13),
    Math.round(y + radius * 0.24),
    Math.max(3, Math.round(radius * 0.26)),
    Math.max(4, Math.round(radius * 0.43)),
  );

  if (status === 'for-sale') {
    const tagX = x + Math.round(radius * 0.62);
    const tagY = y - Math.round(radius * 0.62);
    graphics.fillStyle(0xfff7df, 1);
    graphics.fillCircle(tagX, tagY, Math.max(2, Math.round(radius * 0.2)));
    graphics.fillStyle(0x7a4100, 1);
    graphics.fillRect(tagX - 1, tagY - 2, 2, 4);
  } else if (status === 'owned') {
    drawCheck(graphics, x + radius * 0.45, y + radius * 0.49, radius * 0.32, 0xffffff);
  } else {
    const crownY = y - radius * 0.7;
    graphics.fillStyle(0xffffff, 1);
    graphics.beginPath();
    graphics.moveTo(x, crownY - 3);
    graphics.lineTo(x + 3, crownY);
    graphics.lineTo(x, crownY + 3);
    graphics.lineTo(x - 3, crownY);
    graphics.closePath();
    graphics.fillPath();
  }
}

/** Stable screen-space hit radius; the scene expands this to 22px on touch layouts. */
export function propertyMapIconHitRadius(size: number): number {
  return Math.max(16, Math.ceil(size) + 5);
}

/** Draw a compact storefront marker for the city real-estate agent. */
export function paintRealEstateOfficeIcon(
  graphics: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  size: number,
): void {
  const radius = Math.max(9, Math.round(size));
  const left = Math.round(x - radius);
  const top = Math.round(y - radius);
  const diameter = radius * 2;

  graphics.fillStyle(0x070a12, 0.94);
  graphics.fillRoundedRect(left, top, diameter, diameter, 5);
  graphics.lineStyle(2, REAL_ESTATE_OFFICE_COLOR, 1);
  graphics.strokeRoundedRect(left, top, diameter, diameter, 5);

  const shopLeft = Math.round(x - radius * 0.62);
  const shopTop = Math.round(y - radius * 0.32);
  const shopWidth = Math.round(radius * 1.24);
  const shopHeight = Math.round(radius * 0.96);
  graphics.fillStyle(0xe9ddff, 1);
  graphics.fillRect(shopLeft, shopTop, shopWidth, shopHeight);
  graphics.fillStyle(REAL_ESTATE_OFFICE_COLOR, 1);
  graphics.fillRect(shopLeft - 1, shopTop - Math.round(radius * 0.35), shopWidth + 2, 4);
  for (let stripe = 0; stripe < 3; stripe += 1) {
    graphics.fillRect(shopLeft + stripe * 6, shopTop - 1, 3, 4);
  }

  graphics.fillStyle(0x241238, 1);
  graphics.fillRect(
    Math.round(x - radius * 0.09),
    Math.round(y + radius * 0.07),
    Math.max(3, Math.round(radius * 0.3)),
    Math.max(5, Math.round(radius * 0.48)),
  );
  graphics.fillStyle(0x57d8ff, 1);
  graphics.fillRect(
    Math.round(x - radius * 0.48),
    Math.round(y - radius * 0.16),
    Math.max(3, Math.round(radius * 0.3)),
    Math.max(3, Math.round(radius * 0.28)),
  );
}

function drawCheck(
  graphics: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  size: number,
  color: number,
): void {
  graphics.lineStyle(Math.max(2, size * 0.42), color, 1);
  graphics.beginPath();
  graphics.moveTo(x - size, y);
  graphics.lineTo(x - size * 0.2, y + size * 0.75);
  graphics.lineTo(x + size, y - size * 0.75);
  graphics.strokePath();
}
