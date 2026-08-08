import type { Vector2 } from '@/core/types';
import { ServiceLocator } from '@/core/ServiceLocator';
import { ServiceKeys } from '@/config/ServiceKeys';
import { Component } from '@/entities/Component';
import type { Vehicle } from '@/entities/Vehicle';
import type { TrafficSystem } from '@/systems/TrafficSystem';

/** Compatibility component for pursuit callers; all driving stays on the shared traffic runtime. */
export class PursuitAIComponent extends Component {
  public readonly name = 'ai';

  constructor(
    private readonly targetProvider: () => Vector2 | null,
    private readonly stopRange = 70,
  ) {
    super();
  }

  protected override onAttach(): void {
    this.system()?.configureDriver(this.vehicle, this.targetProvider, this.stopRange);
  }

  public override update(_time: number, _delta: number): void {
    this.system()?.configureDriver(this.vehicle, this.targetProvider, this.stopRange);
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
