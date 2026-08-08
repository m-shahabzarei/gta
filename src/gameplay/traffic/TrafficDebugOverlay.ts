import Phaser from 'phaser';
import { IS_DEV } from '@/config/Constants';
import { DepthLayers } from '@/config/DepthLayers';
import type {
  TrafficDriverDebug,
  TrafficRuntimeStats,
  TrafficValidationReport,
} from './TrafficTypes';

export interface TrafficDebugSnapshot {
  readonly phase: string;
  readonly roads: number;
  readonly lanes: number;
  readonly intersections: number;
  readonly parkingSpaces: number;
  readonly stats: TrafficRuntimeStats;
  readonly validation: TrafficValidationReport;
  readonly selected: TrafficDriverDebug | null;
}

export interface TrafficDebugSource {
  trafficDebugSnapshot(): TrafficDebugSnapshot;
}

const REFRESH_INTERVAL_MS = 100;

/** Developer-only F7 telemetry panel and world-space predicted-path drawing. */
export class TrafficDebugOverlay {
  private element: HTMLPreElement | null = null;
  private graphics: Phaser.GameObjects.Graphics | null = null;
  private visibleValue = false;
  private refreshElapsed = 0;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly source: TrafficDebugSource,
  ) {
    if (!IS_DEV) return;
    scene.input.keyboard?.on('keydown-F7', this.toggle, this);
    this.create();
  }

  public update(delta: number): void {
    if (!this.visibleValue) return;
    this.refreshElapsed += delta;
    if (this.refreshElapsed < REFRESH_INTERVAL_MS) return;
    this.refreshElapsed = 0;
    this.refresh();
  }

  public destroy(): void {
    if (IS_DEV) this.scene.input.keyboard?.off('keydown-F7', this.toggle, this);
    this.element?.remove();
    this.graphics?.destroy();
    this.element = null;
    this.graphics = null;
    this.visibleValue = false;
  }

  private toggle(): void {
    this.visibleValue = !this.visibleValue;
    if (this.element) this.element.style.display = this.visibleValue ? 'block' : 'none';
    this.graphics?.setVisible(this.visibleValue);
    if (this.visibleValue) this.refresh();
  }

  private create(): void {
    if (typeof document === 'undefined') return;
    const element = document.createElement('pre');
    element.id = 'traffic-debug-overlay';
    element.setAttribute('role', 'status');
    element.setAttribute('aria-live', 'polite');
    Object.assign(element.style, {
      position: 'fixed',
      right: '8px',
      top: '8px',
      zIndex: '2147483647',
      display: 'none',
      width: 'min(430px, calc(100vw - 16px))',
      maxHeight: 'calc(100vh - 16px)',
      boxSizing: 'border-box',
      margin: '0',
      padding: '8px',
      border: '1px solid #475569',
      borderRadius: '4px',
      background: 'rgba(15, 23, 42, 0.96)',
      color: '#f8fafc',
      font: '12px/1.45 Inter, Consolas, "Courier New", monospace',
      fontVariantNumeric: 'tabular-nums',
      letterSpacing: '0',
      pointerEvents: 'none',
      userSelect: 'none',
      whiteSpace: 'pre-wrap',
      overflow: 'hidden',
      overflowWrap: 'anywhere',
    });
    document.body.appendChild(element);
    this.element = element;
    this.graphics = this.scene.add.graphics().setDepth(DepthLayers.DebugDraw).setVisible(false);
  }

  private refresh(): void {
    if (!this.element) return;
    const snapshot = this.source.trafficDebugSnapshot();
    const selected = snapshot.selected;
    const stats = snapshot.stats;
    const collision = selected?.collisionPrediction ?? null;
    const recovery = selected?.recovery;
    this.element.textContent = [
      'TRAFFIC SIMULATION',
      `SIGNAL ${snapshot.phase}`,
      `NETWORK  ${snapshot.roads} roads  ${snapshot.lanes} lanes  ${snapshot.intersections} junctions`,
      `PARKING  ${stats.parkedVehicles}/${snapshot.parkingSpaces}   QUEUED ${stats.queuedVehicles}`,
      `SIMULATED ${stats.simulatedVehicles}   VIRTUAL ${stats.virtualVehicles}   TOTAL ${stats.activeDrivers}`,
      `AI ${fixed(stats.trafficCpuMs)} ms  NAV ${fixed(stats.navigationCpuMs)} ms  STEER ${fixed(stats.steeringCpuMs)} ms  COLL ${fixed(stats.collisionCpuMs)} ms`,
      `SCHED ${Math.round(stats.schedulerLoad * 100)
        .toString()
        .padStart(
          3,
        )}%  DEFER ${stats.schedulerDeferredUpdates}  AVG ${fixed(stats.averageAiUpdateHz)} Hz  FRAME ${fixed(stats.frameTimeMs)} ms`,
      `BLOCKED ${stats.blockedDrivers}   RECOVERY ${stats.recoveries}`,
      `RESERVE  +${stats.reservationsGranted}  -${stats.reservationsDenied}   E-BRAKE ${stats.emergencyBrakes}`,
      `ROUTES   H ${stats.routeCacheHits}  M ${stats.routeCacheMisses}   SPAWN REJECT ${stats.safeSpawnRejects}`,
      `VALIDATE ${snapshot.validation.passed ? 'PASS' : `FAIL ${snapshot.validation.failures.length}`}`,
      '',
      selected
        ? `VEHICLE ${selected.vehicleId}  ${selected.personality.toUpperCase()}`
        : 'VEHICLE none nearby',
      selected ? `STATE    ${selected.state}` : '',
      selected ? `INTENT   ${selected.intention}` : '',
      selected ? `LANE     ${selected.laneId ?? 'none'}` : '',
      selected ? `TARGET   ${selected.targetLaneId ?? 'none'}` : '',
      selected ? `DEST     ${formatDestination(selected.destination)}` : '',
      selected
        ? `SPEED    ${fixed(selected.currentSpeed)} / ${fixed(selected.desiredSpeed)} px/s`
        : '',
      selected
        ? `STEER    ${fixed(selected.steeringAngle)}  HEADING ERR ${fixed(selected.headingError)}`
        : '',
      selected ? `LANE ERR ${fixed(selected.lateralError)} px` : '',
      selected
        ? `COLLISION ${collision ? `${collision.kind} ${fixed(collision.distance)} px  TTC ${formatTtc(collision.timeToCollision)}` : 'clear'}`
        : '',
      selected
        ? `RECOVERY ${recovery?.phase ?? 'none'}  ATTEMPT ${recovery?.attempt ?? 0}  BLOCKED ${fixed(recovery?.blockedSeconds ?? 0)} s`
        : '',
      selected ? `RESERVE  ${selected.reservationId ?? 'none'}` : '',
      selected
        ? `PATH     ${selected.predictedPath.length} samples  ${selected.route.length} lanes`
        : '',
    ]
      .filter((line) => line !== '')
      .join('\n');
    this.drawSelected(selected);
  }

  private drawSelected(selected: TrafficDriverDebug | null): void {
    const graphics = this.graphics;
    if (!graphics) return;
    graphics.clear();
    const path = selected?.predictedPath ?? [];
    if (path.length > 1) {
      graphics.lineStyle(2, 0x22c55e, 0.9);
      graphics.beginPath();
      const first = path[0];
      if (first) graphics.moveTo(first.x, first.y);
      for (let index = 1; index < path.length; index++) {
        const point = path[index];
        if (point) graphics.lineTo(point.x, point.y);
      }
      graphics.strokePath();
    }
    const collision = selected?.collisionPrediction;
    if (collision) {
      graphics.lineStyle(2, 0xef4444, 1);
      graphics.strokeCircle(collision.position.x, collision.position.y, 12);
      graphics.lineBetween(
        collision.position.x - 8,
        collision.position.y - 8,
        collision.position.x + 8,
        collision.position.y + 8,
      );
      graphics.lineBetween(
        collision.position.x + 8,
        collision.position.y - 8,
        collision.position.x - 8,
        collision.position.y + 8,
      );
    }
  }
}

function fixed(value: number): string {
  return value.toFixed(1).padStart(6);
}

function formatTtc(value: number | null): string {
  return value === null ? 'clear' : `${value.toFixed(1)}s`;
}

function formatDestination(destination: TrafficDriverDebug['destination']): string {
  if (!destination) return 'planning';
  return `${destination.purpose} ${Math.round(destination.position.x)},${Math.round(destination.position.y)} (${destination.laneId})`;
}
