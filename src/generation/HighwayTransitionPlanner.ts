import { TILE_SIZE } from '@/config/Constants';
import type { Vector2 } from '@/core/types';
import type {
  HighwayCityGateSite,
  HighwayInterchange,
  HighwayInterchangeKind,
  HighwayRoute,
  WorldCity,
} from '@/gameplay/types';

/** The complete legal city-connection vocabulary. */
export const SUPPORTED_INTERCHANGE_KINDS: readonly HighwayInterchangeKind[] = [
  't-junction',
  'cross',
  'priority-cross',
] as const;

export interface HighwayTransitionPlanningInput {
  seed: number;
  routeId: string;
  routeCharacter: HighwayRoute['character'];
  city: WorldCity;
  gatewayWorld: Vector2;
  /** Highway centreline heading at the at-grade city boundary. */
  approachHeading: number;
  /** Physical terminal of Direction A followed by Direction B. */
  cityConnections: [Vector2, Vector2];
}

export interface HighwayTransitionPlanningResult {
  interchange: HighwayInterchange;
}

/**
 * Builds a normal at-grade road junction.
 *
 * There are deliberately no ramp templates, grade levels, loops, collectors,
 * gores or inferred curves here. Both carriageways terminate on the city grid
 * as ordinary primary-road anchors; UrbanPlanner owns the crossing street.
 */
export class HighwayTransitionPlanner {
  public static generate(input: HighwayTransitionPlanningInput): HighwayTransitionPlanningResult {
    const id = `${input.routeId}:junction:${input.city.id}`;
    const kind = chooseJunctionKind(input.city);
    const position = midpoint(input.cityConnections[0], input.cityConnections[1]);
    const heading = input.approachHeading;
    return {
      interchange: {
        id,
        cityId: input.city.id,
        position,
        cityConnection: { ...input.gatewayWorld },
        cityConnections: input.cityConnections.map((point) => ({ ...point })) as [Vector2, Vector2],
        kind,
        selectionReason:
          `${kind} selected as an ordinary at-grade city-road junction; ` +
          'complex ramps and grade separation are disabled by the highway grammar.',
        entryRampIds: [],
        exitRampIds: [],
        circulatingRoadIds: [],
        accelerationLane: false,
        decelerationLane: false,
        transitionPaths: [],
        goreAreas: [],
        gateZone: {
          id: `${id}:roadside`,
          kind: kind === 'priority-cross' ? 'controlled-entry' : 'commercial-mobility',
          center: { ...input.gatewayWorld },
          heading,
          radius: TILE_SIZE * 7,
          sites: roadsideSites(id, input, heading),
        },
        metrics: {
          minimumRampRadius: 0,
          shortestMergeLane: 0,
          maximumHeadingDelta: 0,
          laneWidthDeviation: 0,
          shoulderWidthDeviation: 0,
          edgeIntersections: 0,
          markingOverlaps: 0,
        },
      },
    };
  }
}

function chooseJunctionKind(city: WorldCity): HighwayInterchangeKind {
  if (city.trafficDensity >= 1.25) return 'priority-cross';
  if (city.bounds.width >= TILE_SIZE * 500) return 'cross';
  return 't-junction';
}

function roadsideSites(
  id: string,
  input: HighwayTransitionPlanningInput,
  heading: number,
): HighwayCityGateSite[] {
  const tangent = { x: Math.cos(heading), y: Math.sin(heading) };
  const normal = { x: -tangent.y, y: tangent.x };
  const kinds: HighwayCityGateSite['kind'][] = [
    'direction-sign',
    'lighting',
    input.routeCharacter === 'desert' ? 'decorative-rocks' : 'tree-belt',
    'bushes',
    'fence',
  ];
  return kinds.map((kind, index) => {
    const side = index % 2 === 0 ? 1 : -1;
    const longitudinal = (index - 2) * TILE_SIZE * 1.35;
    const lateral = TILE_SIZE * (4.2 + (index % 2) * 0.7) * side;
    return {
      id: `${id}:roadside:${kind}:${index}`,
      kind,
      position: {
        x: input.gatewayWorld.x + tangent.x * longitudinal + normal.x * lateral,
        y: input.gatewayWorld.y + tangent.y * longitudinal + normal.y * lateral,
      },
      heading,
      width: kind === 'fence' ? TILE_SIZE * 4 : TILE_SIZE,
      depth: kind === 'tree-belt' ? TILE_SIZE * 2 : TILE_SIZE,
    };
  });
}

function midpoint(first: Vector2, second: Vector2): Vector2 {
  return { x: (first.x + second.x) * 0.5, y: (first.y + second.y) * 0.5 };
}
