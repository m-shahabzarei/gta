import { SpatialHashGrid } from '@/utils';
import type { TrafficAgentSnapshot } from './TrafficTypes';
import type { TemporaryTrafficObstacle, TrafficPerceptionFrame } from './TrafficDriver';

const TRAFFIC_CELL_SIZE = 128;

/**
 * Per-step broad phase for traffic. Drivers stream only nearby candidates from
 * this index; they never iterate the complete traffic population.
 */
export class TrafficPerceptionIndex implements TrafficPerceptionFrame {
  public readonly managedVehicleIds = new Set<number>();
  public readonly temporaryObstacles: TemporaryTrafficObstacle[] = [];

  private readonly spatial = new SpatialHashGrid<TrafficAgentSnapshot>(TRAFFIC_CELL_SIZE);
  private readonly byLane = new Map<string, TrafficAgentSnapshot[]>();

  public beginFrame(obstacles: Iterable<TemporaryTrafficObstacle>): void {
    this.managedVehicleIds.clear();
    this.temporaryObstacles.length = 0;
    for (const obstacle of obstacles) this.temporaryObstacles.push(obstacle);
    for (const lane of this.byLane.values()) lane.length = 0;
  }

  public upsert(snapshot: TrafficAgentSnapshot): void {
    this.managedVehicleIds.add(snapshot.vehicleId);
    this.spatial.insert(snapshot.vehicleId, snapshot, snapshot.position.x, snapshot.position.y);
    let lane = this.byLane.get(snapshot.laneId);
    if (!lane) {
      lane = [];
      this.byLane.set(snapshot.laneId, lane);
    }
    lane.push(snapshot);
  }

  public remove(vehicleId: number): void {
    this.managedVehicleIds.delete(vehicleId);
    this.spatial.remove(vehicleId);
  }

  public clear(): void {
    this.managedVehicleIds.clear();
    this.temporaryObstacles.length = 0;
    this.byLane.clear();
    this.spatial.clear();
  }

  public forEachNearbyAgent(
    x: number,
    y: number,
    radius: number,
    visitor: (agent: TrafficAgentSnapshot) => void,
  ): void {
    this.spatial.forEachInRadius(x, y, radius, (agent) => visitor(agent));
  }

  public forEachAgentOnLane(laneId: string, visitor: (agent: TrafficAgentSnapshot) => void): void {
    const agents = this.byLane.get(laneId);
    if (!agents) return;
    for (const agent of agents) visitor(agent);
  }
}
