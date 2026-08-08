/**
 * Compatibility boundary for autonomous road vehicles.
 *
 * Public callers keep the historic `ai` component and its methods, while the
 * implementation registers configuration with TrafficSystem's fixed-step
 * runtime. The component never advances movement itself.
 */
import type { Vector2 } from '@/core/types';
import { ServiceLocator } from '@/core/ServiceLocator';
import { ServiceKeys } from '@/config/ServiceKeys';
import { Component } from '@/entities/Component';
import type { Vehicle } from '@/entities/Vehicle';
import type { TrafficDriverDebug } from '@/gameplay/traffic';
import type { TrafficSystem } from '@/systems/TrafficSystem';

export class TrafficAIComponent extends Component {
  public readonly name = 'ai';

  private targetProvider: (() => Vector2 | null) | null;
  private stopRange: number;
  private externallyStopped = false;

  constructor(targetProvider: (() => Vector2 | null) | null = null, stopRange = 56) {
    super();
    this.targetProvider = targetProvider;
    this.stopRange = stopRange;
  }

  public get arrived(): boolean {
    return this.system()?.driverFor(this.vehicle)?.arrived ?? false;
  }

  public get approachingIntersection(): { x: number; y: number; distance: number } | null {
    const approach = this.system()?.driverFor(this.vehicle)?.approachingIntersection ?? null;
    return approach ? { x: approach.x, y: approach.y, distance: approach.distance } : null;
  }

  public get debug(): TrafficDriverDebug | null {
    return this.system()?.driverFor(this.vehicle)?.debug ?? null;
  }

  /** Reconfigure a pooled vehicle without changing the component's public contract. */
  public configure(
    targetProvider: (() => Vector2 | null) | null,
    stopRange = this.stopRange,
  ): void {
    this.targetProvider = targetProvider;
    this.stopRange = stopRange;
    this.system()?.configureDriver(this.vehicle, targetProvider, stopRange, this.externallyStopped);
  }

  /** Preserve the legacy arrival-radius API used by emergency dispatch. */
  public setStopRange(stopRange: number): void {
    this.stopRange = stopRange;
    this.system()?.configureDriver(
      this.vehicle,
      this.targetProvider,
      stopRange,
      this.externallyStopped,
    );
  }

  public setStopped(stopped: boolean): void {
    this.externallyStopped = stopped;
    this.system()?.setDriverStopped(this.vehicle, stopped);
  }

  public forceReplan(): void {
    this.system()?.driverFor(this.vehicle)?.forceReplan();
  }

  protected override onAttach(): void {
    this.system()?.configureDriver(
      this.vehicle,
      this.targetProvider,
      this.stopRange,
      this.externallyStopped,
    );
  }

  public override update(_time: number, _delta: number): void {
    // Configuration is event-driven (attach/configure/stop/replan). The
    // traffic scheduler is the sole simulation clock, so a per-frame service
    // lookup here would only duplicate work for every autonomous vehicle.
  }

  /** Far traffic is still advanced by the same authoritative fixed-step runtime. */
  public updateCoarse(_time: number, _delta: number): void {
    // Far traffic remains registered with the central scheduler; no entity
    // component tick is required to keep its route or destination alive.
  }

  public override destroy(): void {
    this.system()?.releaseDriver(this.vehicle.id);
    super.destroy();
  }

  private get vehicle(): Vehicle {
    return this.entity as Vehicle;
  }

  private system(): TrafficSystem | null {
    return ServiceLocator.tryResolve<TrafficSystem>(ServiceKeys.Traffic);
  }
}
