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
  const unit = Math.max(1, size / 8);
  const outline = Math.max(1, Math.round(unit));
  if (icon === 'medical-cross') {
    graphics.fillStyle(0xa72f38, 1);
    graphics.lineStyle(outline, 0xffffff, 0.95);
    graphics.fillCircle(x, y, size);
    graphics.strokeCircle(x, y, size);
    graphics.fillStyle(0xffffff, 1);
    graphics.fillRect(x - unit * 1.35, y - size * 0.68, unit * 2.7, size * 1.36);
    graphics.fillRect(x - size * 0.68, y - unit * 1.35, size * 1.36, unit * 2.7);
    return;
  }

  if (icon === 'police-badge') {
    graphics.fillStyle(0x255d88, 1);
    graphics.lineStyle(outline, 0xffffff, 0.95);
    graphics.beginPath();
    graphics.moveTo(x, y - size);
    graphics.lineTo(x + size * 0.82, y - size * 0.52);
    graphics.lineTo(x + size * 0.66, y + size * 0.52);
    graphics.lineTo(x, y + size);
    graphics.lineTo(x - size * 0.66, y + size * 0.52);
    graphics.lineTo(x - size * 0.82, y - size * 0.52);
    graphics.closePath();
    graphics.fillPath();
    graphics.strokePath();
    graphics.fillStyle(0xf4cf5b, 1);
    graphics.fillRect(x - unit, y - size * 0.45, unit * 2, size * 0.9);
    graphics.fillRect(x - size * 0.45, y - unit, size * 0.9, unit * 2);
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
  graphics.fillStyle(color, 1);
  graphics.lineStyle(outline, 0xffffff, 0.95);
  graphics.fillRect(x - size * 0.75, y - size * 0.75, size * 1.5, size * 1.5);
  graphics.strokeRect(x - size * 0.75, y - size * 0.75, size * 1.5, size * 1.5);
  graphics.fillStyle(0xffffff, 0.9);
  graphics.fillRect(x - size * 0.45, y - unit, size * 0.9, unit * 2);
}
