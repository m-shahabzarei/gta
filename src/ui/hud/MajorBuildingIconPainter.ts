import Phaser from 'phaser';
import type { MajorBuildingIcon } from '@/gameplay/types';

/** Draw a compact high-contrast pixel pictogram onto an existing graphics batch. */
export function paintMajorBuildingIcon(
  graphics: Phaser.GameObjects.Graphics,
  icon: MajorBuildingIcon,
  x: number,
  y: number,
  size: number,
): void {
  const unit = pixelUnit(size);
  if (icon === 'medical-cross') {
    drawPixelMask(graphics, x, y, unit, OCTAGON_MASK, 0x250c12);
    drawPixelMask(graphics, x, y, unit, OCTAGON_FILL_MASK, 0xb93342);
    drawPixelMask(graphics, x, y, unit, MEDICAL_CROSS_MASK, 0xffffff);
    return;
  }

  if (icon === 'police-badge') {
    drawPixelMask(graphics, x, y, unit, BADGE_OUTLINE_MASK, 0x07172d);
    drawPixelMask(graphics, x, y, unit, BADGE_FILL_MASK, 0x2368a2);
    drawPixelMask(graphics, x, y, unit, BADGE_GOLD_MASK, 0xf3c64d);
    drawPixelMask(graphics, x, y, unit, BADGE_HIGHLIGHT_MASK, 0x8dd7ff);
    return;
  }

  const color =
    icon === 'fire-shield'
      ? 0xb83b32
      : icon === 'fuel-pump'
        ? 0x318866
        : icon === 'shopping-bag'
          ? 0x8b5ea7
          : 0xb28a35;
  drawPixelMask(graphics, x, y, unit, SQUARE_OUTLINE_MASK, 0x111827);
  drawPixelMask(graphics, x, y, unit, SQUARE_FILL_MASK, color);
  drawPixelMask(graphics, x, y, unit, SMALL_CROSS_MASK, 0xffffff);
}

/** Screen-space hit radius matching the icon's rendered pixel bounds. */
export function majorBuildingIconHitRadius(size: number): number {
  return Math.max(8, Math.ceil((pixelUnit(size) * ICON_GRID_SIZE) / 2) + 4);
}

const ICON_GRID_SIZE = 9;

const OCTAGON_MASK = [
  '  #####  ',
  ' ####### ',
  '#########',
  '#########',
  '#########',
  '#########',
  '#########',
  ' ####### ',
  '  #####  ',
] as const;

const OCTAGON_FILL_MASK = [
  '         ',
  '  RRRRR  ',
  ' RRRRRRR ',
  ' RRRRRRR ',
  ' RRRRRRR ',
  ' RRRRRRR ',
  ' RRRRRRR ',
  '  RRRRR  ',
  '         ',
] as const;

const MEDICAL_CROSS_MASK = [
  '         ',
  '   WWW   ',
  '   WWW   ',
  ' WWWWWWW ',
  ' WWWWWWW ',
  ' WWWWWWW ',
  '   WWW   ',
  '   WWW   ',
  '         ',
] as const;

const BADGE_OUTLINE_MASK = [
  '   ###   ',
  ' ####### ',
  '#########',
  '#########',
  '#########',
  ' ####### ',
  '  #####  ',
  '   ###   ',
  '    #    ',
] as const;

const BADGE_FILL_MASK = [
  '         ',
  '   BBB   ',
  '  BBBBB  ',
  ' BBBBBBB ',
  ' BBBBBBB ',
  '  BBBBB  ',
  '   BBB   ',
  '    B    ',
  '         ',
] as const;

const BADGE_GOLD_MASK = [
  '         ',
  '         ',
  '    G    ',
  '   GGG   ',
  '  GGGGG  ',
  '   GGG   ',
  '    G    ',
  '         ',
  '         ',
] as const;

const BADGE_HIGHLIGHT_MASK = [
  '         ',
  '    H    ',
  '   H     ',
  '  H      ',
  '         ',
  '         ',
  '         ',
  '         ',
  '         ',
] as const;

const SQUARE_OUTLINE_MASK = [
  '#########',
  '#########',
  '#########',
  '#########',
  '#########',
  '#########',
  '#########',
  '#########',
  '#########',
] as const;

const SQUARE_FILL_MASK = [
  '         ',
  ' FFFFFFF ',
  ' FFFFFFF ',
  ' FFFFFFF ',
  ' FFFFFFF ',
  ' FFFFFFF ',
  ' FFFFFFF ',
  ' FFFFFFF ',
  '         ',
] as const;

const SMALL_CROSS_MASK = [
  '         ',
  '         ',
  '    W    ',
  '    W    ',
  '  WWWWW  ',
  '    W    ',
  '    W    ',
  '         ',
  '         ',
] as const;

function pixelUnit(size: number): number {
  return Math.max(1, Math.floor(size / 5));
}

function drawPixelMask(
  graphics: Phaser.GameObjects.Graphics,
  centerX: number,
  centerY: number,
  unit: number,
  rows: readonly string[],
  color: number,
): void {
  const left = Math.round(centerX - (ICON_GRID_SIZE * unit) / 2);
  const top = Math.round(centerY - (ICON_GRID_SIZE * unit) / 2);
  graphics.fillStyle(color, 1);
  for (let row = 0; row < rows.length; row += 1) {
    const pattern = rows[row] ?? '';
    for (let col = 0; col < ICON_GRID_SIZE; col += 1) {
      if (pattern.charAt(col) === ' ') continue;
      graphics.fillRect(left + col * unit, top + row * unit, unit, unit);
    }
  }
}
