import Phaser from 'phaser';
import { COLORS, GAME_WIDTH } from '@/config/Constants';
import type { TransitRideSnapshot } from '@/gameplay/transit';
import { UIComponent } from '@/ui/UIComponent';

/** Compact in-world transit status, deliberately styled like the existing pixel HUD. */
export class TransitHud extends UIComponent {
  private readonly background: Phaser.GameObjects.Graphics;
  private readonly title: Phaser.GameObjects.Text;
  private readonly details: Phaser.GameObjects.Text;
  private mobileMode: boolean;

  constructor(scene: Phaser.Scene, mobileMode = false) {
    super(scene, GAME_WIDTH - 336, 116);
    this.mobileMode = mobileMode;
    this.setScrollFactor(0);
    this.background = scene.add.graphics();
    this.title = scene.add.text(12, 8, '', {
      fontFamily: 'Courier New',
      fontSize: '13px',
      fontStyle: 'bold',
      color: '#f8d36e',
    });
    this.details = scene.add.text(12, 28, '', {
      fontFamily: 'Courier New',
      fontSize: '11px',
      color: '#e6edf6',
      lineSpacing: 3,
      wordWrap: { width: 294 },
    });
    this.add([this.background, this.title, this.details]);
    this.setVisible(false);
  }

  public setRide(ride: TransitRideSnapshot | null): void {
    if (!ride) {
      this.setVisible(false);
      return;
    }
    this.setVisible(true);
    this.redraw(318, ride.kind === 'bus' ? 92 : 72, ride.kind === 'bus' ? 0x38bdf8 : 0xf6c453);
    if (ride.kind === 'bus') {
      this.title.setText(ride.routeName ?? 'CITY BUS');
      this.details.setText(
        [
          `${ride.status ?? 'In service'}  ${ride.canExit ? 'E Exit' : ''}`,
          `Now: ${ride.currentStop ?? '--'}`,
          `Next: ${ride.nextStop ?? '--'}`,
        ].join('\n'),
      );
      return;
    }
    this.title.setText('TAXI');
    this.details.setText(
      [
        ride.status ?? 'In service',
        `Destination: ${ride.destination ?? '--'}`,
        ride.fareTotal !== undefined ? `Paid: $${ride.fareTotal}` : '',
        ride.canExit ? 'E Exit' : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  public setMobileLayout(width: number, height: number, safe: { top: number; right: number }): void {
    if (!this.mobileMode) return;
    this.setPosition(Math.max(safe.right + 12, width - 330), Math.max(safe.top + 92, height - 302));
  }

  private redraw(width: number, height: number, accent: number): void {
    this.background.clear();
    this.background.fillStyle(0x0a0d14, 0.92);
    this.background.fillRect(0, 0, width, height);
    this.background.lineStyle(2, accent, 0.95);
    this.background.strokeRect(0, 0, width, height);
    this.background.fillStyle(COLORS.UI_PANEL, 0.75);
    this.background.fillRect(0, 0, 5, height);
  }
}
