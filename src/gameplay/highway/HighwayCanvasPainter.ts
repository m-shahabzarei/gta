import { TILE_SIZE } from '@/config/Constants';
import type { Vector2 } from '@/core/types';
import type { HighwaySceneryKind } from '@/gameplay/types';
import { highwayRampWidthAt } from './HighwayGeometry';
import type {
  HighwayChunkGeometry,
  HighwayMainlineSection,
  HighwayMedianSection,
  HighwayRampSection,
  HighwayRenderLod,
  HighwaySplineSample,
} from './HighwayRenderTypes';
import { HIGHWAY_TILESET } from './HighwayTileset';

const { colors: COLOR, metrics: METRIC } = HIGHWAY_TILESET;

export interface HighwayPaintResult {
  details: number;
}

/** Rasterize one complete, static, pixel-art highway chunk. */
export function paintHighwayCanvas(
  context: CanvasRenderingContext2D,
  geometry: HighwayChunkGeometry,
  originX: number,
  originY: number,
  textureSize: number,
  bleed: number,
  lod: HighwayRenderLod,
  renderScale = 1,
): HighwayPaintResult {
  context.clearRect(0, 0, textureSize, textureSize);
  context.imageSmoothingEnabled = false;
  context.save();
  context.scale(renderScale, renderScale);
  context.translate(bleed - originX, bleed - originY);
  context.lineJoin = 'round';
  context.lineCap = 'round';

  let details = 0;
  for (const mainline of geometry.mainlines) paintMainlineVerge(context, mainline);
  for (const branch of geometry.ramps) paintServiceVerge(context, branch);
  for (const mainline of geometry.mainlines) paintMainlineBase(context, mainline);
  for (const branch of geometry.ramps) paintServiceBranch(context, branch);
  for (const median of geometry.medians) paintConcreteMedian(context, median);
  for (const mainline of geometry.mainlines) {
    paintMainlineMarkings(context, mainline, lod);
    details += paintAsphaltGrain(context, mainline, lod);
    details += paintOuterGuardRail(context, mainline, geometry.ramps, lod);
  }
  for (const branch of geometry.ramps) details += paintServiceMarkings(context, branch, lod);
  for (const junction of geometry.gateZones) {
    // The ordinary city cross street owns the terminal paint. Drawing it
    // after rails/median removes visual road caps without adding ramp geometry.
    paintJunctionDeck(context, junction.center, junction.heading);
    details += paintJunctionMarkings(context, junction.center, junction.heading, lod);
    if (lod === 'near') details += paintJunctionContext(context, junction.sites);
  }

  if (lod !== 'far') {
    details += paintFurniture(context, geometry, lod);
    details += paintStructures(context, geometry);
  }
  if (lod === 'near') {
    details += paintRestAreas(context, geometry);
    details += paintScenery(context, geometry);
  }

  context.restore();
  return { details };
}

function paintMainlineVerge(
  context: CanvasRenderingContext2D,
  mainline: HighwayMainlineSection,
): void {
  const [outer, inner] = vergeColors(mainline.character);
  strokeSamples(context, mainline.points, mainline.pavementWidth + 70, outer);
  strokeSamples(context, mainline.points, mainline.pavementWidth + 46, inner);
}

function paintServiceVerge(
  context: CanvasRenderingContext2D,
  branch: HighwayRampSection,
): void {
  const [outer, inner] = vergeColors(branch.character);
  fillVariableRibbon(context, branch, 42, outer);
  fillVariableRibbon(context, branch, 25, inner);
}

function paintMainlineBase(
  context: CanvasRenderingContext2D,
  mainline: HighwayMainlineSection,
): void {
  context.save();
  context.lineCap = 'butt';
  const travelWidth = mainline.laneWidth * mainline.laneCount;
  strokeSamples(context, mainline.points, mainline.pavementWidth + 8, COLOR.edgeShadow);
  strokeSamples(context, mainline.points, mainline.pavementWidth, COLOR.shoulder);
  strokeSamples(context, mainline.points, travelWidth, asphaltColor(mainline.character));
  const shoulderCenter = travelWidth * 0.5 + mainline.shoulderWidth * 0.5;
  strokeSamples(
    context,
    offsetPoints(mainline.points, -shoulderCenter),
    1,
    COLOR.shoulderEdge,
  );
  strokeSamples(context, offsetPoints(mainline.points, shoulderCenter), 1, COLOR.shoulderEdge);
  context.restore();
}

function paintConcreteMedian(
  context: CanvasRenderingContext2D,
  median: HighwayMedianSection,
): void {
  strokeSamples(context, median.points, median.width + 6, COLOR.concreteDark);
  strokeSamples(context, median.points, median.width, COLOR.concrete);
  strokeSamples(
    context,
    offsetPoints(median.points, -median.width * 0.28),
    2,
    COLOR.concreteLight,
  );
  strokeSamples(
    context,
    offsetPoints(median.points, median.width * 0.3),
    2,
    COLOR.concreteDark,
  );
}

function paintMainlineMarkings(
  context: CanvasRenderingContext2D,
  mainline: HighwayMainlineSection,
  lod: HighwayRenderLod,
): void {
  const travelWidth = mainline.laneWidth * mainline.laneCount;
  const edge = travelWidth * 0.5;
  strokeSamples(context, offsetPoints(mainline.points, -edge), METRIC.edgeLineWidth, COLOR.marking);
  strokeSamples(context, offsetPoints(mainline.points, edge), METRIC.edgeLineWidth, COLOR.marking);
  for (const offset of [-mainline.laneWidth * 0.5, mainline.laneWidth * 0.5]) {
    dashedSamples(
      context,
      offsetPoints(mainline.points, offset),
      METRIC.laneLineWidth,
      lod === 'near' ? COLOR.markingFaded : COLOR.marking,
      METRIC.dashLength,
      METRIC.dashGap,
    );
  }
}

function paintOuterGuardRail(
  context: CanvasRenderingContext2D,
  mainline: HighwayMainlineSection,
  branches: readonly HighwayRampSection[],
  lod: HighwayRenderLod,
): number {
  const outer = offsetPoints(mainline.points, -mainline.pavementWidth * 0.5 - 5);
  const accessPoints = branches.flatMap((branch) => {
    const first = branch.points[0];
    const last = branch.points[branch.points.length - 1];
    return [first, last].filter((point): point is HighwaySplineSample => point !== undefined);
  });
  const runs = splitClearRuns(outer, accessPoints, TILE_SIZE * 2.2, TILE_SIZE * 1.4);
  let details = 0;
  for (const run of runs) {
    strokeSamples(context, run, 7, COLOR.railDark);
    strokeSamples(context, run, METRIC.railWidth, COLOR.rail);
    if (lod === 'far') continue;
    forEachDistance(run, lod === 'near' ? METRIC.railPostSpacing : 72, 8, (point, ordinal) => {
      drawOriented(context, point, () => {
        context.fillStyle = COLOR.railDark;
        context.fillRect(-2, -4, 4, 8);
        context.fillStyle = COLOR.railHighlight;
        context.fillRect(-1, -3, 2, 5);
        if (ordinal % 2 === 0) {
          context.fillStyle = COLOR.reflector;
          context.fillRect(-1, -5, 3, 2);
        }
      });
      details++;
    });
  }
  return details;
}

function paintServiceBranch(
  context: CanvasRenderingContext2D,
  branch: HighwayRampSection,
): void {
  fillVariableRibbon(context, branch, 8, COLOR.edgeShadow);
  fillVariableRibbon(context, branch, 4, COLOR.shoulder);
  fillVariableRibbon(context, branch, 0, asphaltColor(branch.character));
}

function paintServiceMarkings(
  context: CanvasRenderingContext2D,
  branch: HighwayRampSection,
  lod: HighwayRenderLod,
): number {
  strokeSamples(context, variableOffsetPoints(branch, -0.43), 2, COLOR.marking);
  strokeSamples(context, variableOffsetPoints(branch, 0.43), 2, COLOR.marking);
  if (lod === 'far') return 0;
  const merge = branch.points[Math.floor(branch.points.length * 0.24)];
  const exit = branch.points[Math.floor(branch.points.length * 0.76)];
  if (merge) drawLaneArrow(context, merge, false);
  if (exit) drawLaneArrow(context, exit, true);
  return Number(Boolean(merge)) + Number(Boolean(exit));
}

function paintJunctionDeck(
  context: CanvasRenderingContext2D,
  center: Vector2,
  heading: number,
): void {
  drawOrientedAt(context, center.x, center.y, heading, () => {
    const width = METRIC.pavementWidth * 2 + METRIC.medianWidth + 14;
    context.fillStyle = COLOR.asphalt;
    context.fillRect(-48, -width * 0.5, 96, width);
  });
}

function paintJunctionMarkings(
  context: CanvasRenderingContext2D,
  center: Vector2,
  heading: number,
  lod: HighwayRenderLod,
): number {
  drawOrientedAt(context, center.x, center.y, heading, () => {
    context.fillStyle = COLOR.marking;
    for (const side of [-1, 1]) {
      const laneBand = METRIC.laneWidth * METRIC.lanesPerDirection;
      const centerY = side * (METRIC.medianWidth * 0.5 + METRIC.pavementWidth * 0.5);
      context.fillRect(-8, centerY - laneBand * 0.5, 3, laneBand);
    }
  });
  return lod === 'near' ? 2 : 2;
}

function paintJunctionContext(
  context: CanvasRenderingContext2D,
  sites: HighwayChunkGeometry['gateZones'][number]['sites'],
): number {
  for (const site of sites) {
    drawOrientedAt(context, site.position.x, site.position.y, site.heading, () => {
      if (site.kind === 'direction-sign') {
        drawSign(context, 30, 14, COLOR.signGreen);
      } else if (site.kind === 'lighting') {
        context.fillStyle = '#252b2c';
        context.fillRect(-1, -13, 3, 16);
        context.fillStyle = '#f2d98a';
        context.fillRect(-4, -14, 8, 3);
      } else if (site.kind === 'fence') {
        context.strokeStyle = '#555f57';
        context.lineWidth = 2;
        context.beginPath();
        context.moveTo(-site.width * 0.5, 0);
        context.lineTo(site.width * 0.5, 0);
        context.stroke();
      } else if (site.kind === 'decorative-rocks') {
        context.fillStyle = '#746b59';
        pixelCircle(context, -5, 1, 5);
        pixelCircle(context, 4, -1, 4);
      } else {
        drawTreeOrBush(context, site.kind === 'tree-belt');
      }
    });
  }
  return sites.length;
}

function paintAsphaltGrain(
  context: CanvasRenderingContext2D,
  mainline: HighwayMainlineSection,
  lod: HighwayRenderLod,
): number {
  if (lod === 'far') return 0;
  let count = 0;
  const interval = lod === 'near' ? 92 : 160;
  forEachDistance(mainline.points, interval, 37, (point, ordinal) => {
    const seed = hash(`${mainline.id}:${Math.floor(point.distance / interval)}:${ordinal}`);
    const lateral = (seed - 0.5) * mainline.laneWidth * 2.4;
    const site = shifted(point, lateral);
    context.fillStyle = seed > 0.5 ? COLOR.asphaltGrainLight : COLOR.asphaltGrainDark;
    context.fillRect(Math.round(site.x), Math.round(site.y), lod === 'near' ? 2 : 1, 1);
    count++;
  });
  return count;
}

function paintFurniture(
  context: CanvasRenderingContext2D,
  geometry: HighwayChunkGeometry,
  lod: HighwayRenderLod,
): number {
  let count = 0;
  for (const site of geometry.furniture) {
    if (lod === 'medium' && site.kind === 'reflector') continue;
    drawOrientedAt(context, site.position.x, site.position.y, site.heading, () => {
      if (site.kind === 'reflector') {
        context.fillStyle = COLOR.railDark;
        context.fillRect(-1, -4, 2, 8);
        context.fillStyle = COLOR.reflector;
        context.fillRect(-2, -5, 4, 2);
      } else if (site.kind === 'direction-sign' || site.kind === 'distance-sign' || site.kind === 'exit-sign') {
        drawSign(context, 38, 18, COLOR.signGreen);
      } else if (site.kind === 'speed-limit') {
        context.fillStyle = '#e8e7dc';
        pixelCircle(context, 0, -7, 8);
        context.strokeStyle = '#a7473b';
        context.lineWidth = 2;
        pixelCircleStroke(context, 0, -7, 7);
        context.fillStyle = '#303536';
        context.fillRect(-1, 1, 2, 10);
      } else {
        drawSign(context, 20, 12, COLOR.signBlue);
      }
    });
    count++;
  }
  return count;
}

function paintStructures(
  context: CanvasRenderingContext2D,
  geometry: HighwayChunkGeometry,
): number {
  let count = 0;
  for (const structure of geometry.structures) {
    const sample = nearestMainlineSample(geometry.mainlines, structure.position);
    if (!sample) continue;
    drawOriented(context, sample, () => {
      if (structure.kind === 'bridge' || structure.kind === 'causeway') {
        context.strokeStyle = COLOR.concreteLight;
        context.lineWidth = 2;
        context.beginPath();
        context.moveTo(-3, -112);
        context.lineTo(-3, 112);
        context.moveTo(3, -112);
        context.lineTo(3, 112);
        context.stroke();
      } else if (structure.kind === 'tunnel') {
        context.strokeStyle = '#4b4740';
        context.lineWidth = 8;
        context.beginPath();
        context.arc(0, 0, 58, Math.PI, 0);
        context.stroke();
      } else {
        context.fillStyle = 'rgba(94, 89, 76, 0.5)';
        context.fillRect(-3, -96, 6, 192);
      }
    });
    count++;
  }
  return count;
}

function paintRestAreas(
  context: CanvasRenderingContext2D,
  geometry: HighwayChunkGeometry,
): number {
  let count = 0;
  for (const area of geometry.serviceAreas) {
    const branch = geometry.ramps.find((candidate) => candidate.id === `${area.id}:access`);
    const sample = branch?.points[Math.floor(branch.points.length * 0.5)];
    const heading = sample ? Math.atan2(sample.tangentY, sample.tangentX) : 0;
    drawOrientedAt(context, area.position.x, area.position.y, heading, () => {
      context.fillStyle = '#555a57';
      context.fillRect(-128, -78, 256, 156);
      context.fillStyle = '#77776d';
      context.fillRect(-122, -72, 244, 144);

      // This canvas is a ground/detail plane, not an architecture source.
      // Parking, charging, fuel markings and picnic furniture are deliberate
      // public realm; walls, roofs, shops, motels and canopies are forbidden
      // unless they are backed by a collidable PlannedBuilding.
      context.fillStyle = '#d8d2bd';
      for (let slot = -4; slot <= 4; slot++) context.fillRect(slot * 22 - 1, 18, 2, 38);

      // Open-air picnic garden.
      context.fillStyle = '#465f48';
      context.fillRect(-114, -64, 76, 42);
      context.fillStyle = '#6c815d';
      context.fillRect(-111, -61, 70, 36);
      for (const tableX of [-100, -76, -52]) {
        context.fillStyle = '#4a3d32';
        context.fillRect(tableX, -47, 14, 4);
        context.fillRect(tableX + 2, -51, 2, 12);
        context.fillRect(tableX + 10, -51, 2, 12);
      }
      context.fillStyle = '#31543c';
      pixelCircle(context, -105, -30, 5);
      pixelCircle(context, -45, -56, 5);

      // Fuel/EV bays are pavement markings and low islands, never a canopy.
      context.strokeStyle = '#d5bc58';
      context.lineWidth = 2;
      context.strokeRect(-30, -62, 62, 38);
      context.fillStyle = '#3c4447';
      context.fillRect(-22, -48, 5, 14);
      context.fillRect(16, -48, 5, 14);
      context.fillStyle = '#4d93a7';
      context.fillRect(44, -62, 62, 3);
      context.fillRect(44, -59, 3, 35);
      context.fillRect(103, -59, 3, 35);
      context.fillStyle = '#d8e4dc';
      context.fillRect(54, -51, 3, 12);
      context.fillRect(92, -51, 3, 12);
      context.fillStyle = COLOR.signGreen;
      context.fillRect(108, -66, 16, 12);
    });
    count += 15;
  }
  return count;
}

function paintScenery(
  context: CanvasRenderingContext2D,
  geometry: HighwayChunkGeometry,
): number {
  let count = 0;
  for (const site of geometry.scenery) {
    drawOrientedAt(context, site.position.x, site.position.y, site.heading, () => {
      context.scale(site.scale, site.scale);
      if (isTreeScenery(site.kind)) {
        drawTreeOrBush(context, true);
      } else if (site.kind === 'power-lines' || site.kind === 'wind-turbines') {
        context.fillStyle = '#4b514d';
        context.fillRect(-2, -18, 4, 36);
        context.fillRect(-12, -14, 24, 3);
      } else if (
        site.kind === 'rock-formations' ||
        site.kind === 'sand-dunes' ||
        site.kind === 'caravan-ruins'
      ) {
        context.fillStyle = '#796c57';
        pixelCircle(context, -6, 2, 7);
        pixelCircle(context, 5, -1, 5);
      } else if (site.kind === 'billboard') {
        drawSign(context, 44, 20, COLOR.signBlue);
      } else if (site.kind === 'sound-barrier' || site.kind === 'concrete-wall') {
        context.fillStyle = site.kind === 'sound-barrier' ? '#59666a' : '#77766e';
        context.fillRect(-28, -3, 56, 6);
        context.fillStyle = '#a2a39b';
        context.fillRect(-28, -3, 56, 2);
      } else if (site.kind === 'construction') {
        context.fillStyle = '#d4782d';
        for (const x of [-12, 0, 12]) {
          context.fillRect(x - 2, -4, 4, 8);
          context.fillStyle = '#f1d58d';
          context.fillRect(x - 3, 2, 6, 2);
          context.fillStyle = '#d4782d';
        }
      } else if (site.kind === 'solar-farm') {
        context.fillStyle = '#203842';
        for (const y of [-9, 1]) context.fillRect(-22, y, 44, 7);
        context.fillStyle = '#5f8d99';
        for (const y of [-8, 2]) context.fillRect(-20, y, 40, 2);
      } else if (site.kind === 'cactus') {
        context.fillStyle = '#386244';
        context.fillRect(-2, -12, 5, 24);
        context.fillRect(-8, -4, 8, 4);
        context.fillRect(2, 2, 8, 4);
      } else if (site.kind === 'dust' || site.kind === 'fog-bank') {
        context.fillStyle = site.kind === 'dust' ? 'rgba(167,132,82,0.28)' : 'rgba(202,218,211,0.22)';
        context.fillRect(-24, -7, 48, 14);
      } else if (
        site.kind === 'dry-river' ||
        site.kind === 'river' ||
        site.kind === 'wetlands' ||
        site.kind === 'lake'
      ) {
        context.fillStyle = site.kind === 'dry-river' ? '#8a7456' : '#416f72';
        context.fillRect(-28, -6, 56, 12);
        context.fillStyle = site.kind === 'dry-river' ? '#b09469' : '#72a09a';
        context.fillRect(-18, -4, 32, 2);
      } else if (site.kind === 'rice-fields' || site.kind === 'tea-farm') {
        context.fillStyle = site.kind === 'rice-fields' ? '#61805b' : '#3f684c';
        context.fillRect(-24, -12, 48, 24);
        context.fillStyle = site.kind === 'rice-fields' ? '#9ab477' : '#71945e';
        for (let y = -9; y <= 9; y += 6) context.fillRect(-22, y, 44, 2);
      } else if (
        site.kind === 'industrial-buildings' ||
        site.kind === 'warehouses' ||
        site.kind === 'factory' ||
        site.kind === 'small-village'
      ) {
        // Legacy scenery names are retained for save/schema compatibility but
        // deliberately render nothing: unowned miniature buildings are illegal.
        return;
      }
    });
    count++;
  }
  return count;
}

function fillVariableRibbon(
  context: CanvasRenderingContext2D,
  branch: HighwayRampSection,
  extraWidth: number,
  color: string,
): void {
  const left: Vector2[] = [];
  const right: Vector2[] = [];
  for (const point of branch.points) {
    const halfWidth = highwayRampWidthAt(branch, point.distance) * 0.5 + extraWidth * 0.5;
    left.push({ x: point.x + point.normalX * halfWidth, y: point.y + point.normalY * halfWidth });
    right.push({ x: point.x - point.normalX * halfWidth, y: point.y - point.normalY * halfWidth });
  }
  if (left.length < 2 || right.length < 2) return;
  context.fillStyle = color;
  context.beginPath();
  context.moveTo(Math.round(left[0]?.x ?? 0), Math.round(left[0]?.y ?? 0));
  for (let index = 1; index < left.length; index++) {
    const point = left[index];
    if (point) context.lineTo(Math.round(point.x), Math.round(point.y));
  }
  for (let index = right.length - 1; index >= 0; index--) {
    const point = right[index];
    if (point) context.lineTo(Math.round(point.x), Math.round(point.y));
  }
  context.closePath();
  context.fill();
}

function variableOffsetPoints(
  branch: HighwayRampSection,
  factor: number,
): HighwaySplineSample[] {
  return branch.points.map((point) => {
    const offset = highwayRampWidthAt(branch, point.distance) * factor;
    return {
      ...point,
      x: point.x + point.normalX * offset,
      y: point.y + point.normalY * offset,
    };
  });
}

function splitClearRuns(
  points: readonly HighwaySplineSample[],
  exclusions: readonly HighwaySplineSample[],
  clearance: number,
  endClearance: number,
): HighwaySplineSample[][] {
  const maximum = points[points.length - 1]?.distance ?? 0;
  const runs: HighwaySplineSample[][] = [];
  let current: HighwaySplineSample[] = [];
  for (const point of points) {
    const blockedByEnd = point.distance < endClearance || maximum - point.distance < endClearance;
    const blockedByAccess = exclusions.some(
      (site) => Math.hypot(point.x - site.x, point.y - site.y) < clearance,
    );
    if (blockedByEnd || blockedByAccess) {
      if (current.length > 1) runs.push(current);
      current = [];
    } else {
      current.push(point);
    }
  }
  if (current.length > 1) runs.push(current);
  return runs;
}

function offsetPoints(
  points: readonly HighwaySplineSample[],
  offset: number,
): HighwaySplineSample[] {
  return points.map((point) => ({
    ...point,
    x: point.x + point.normalX * offset,
    y: point.y + point.normalY * offset,
  }));
}

function strokeSamples(
  context: CanvasRenderingContext2D,
  points: readonly Vector2[],
  width: number,
  color: string,
): void {
  if (points.length < 2 || width <= 0) return;
  context.strokeStyle = color;
  context.lineWidth = width;
  context.setLineDash([]);
  context.beginPath();
  context.moveTo(Math.round(points[0]?.x ?? 0), Math.round(points[0]?.y ?? 0));
  for (let index = 1; index < points.length; index++) {
    const point = points[index];
    if (point) context.lineTo(Math.round(point.x), Math.round(point.y));
  }
  context.stroke();
}

function dashedSamples(
  context: CanvasRenderingContext2D,
  points: readonly HighwaySplineSample[],
  width: number,
  color: string,
  dash: number,
  gap: number,
): void {
  if (points.length < 2) return;
  context.save();
  context.strokeStyle = color;
  context.lineWidth = width;
  context.setLineDash([dash, gap]);
  context.lineDashOffset = -((points[0]?.distance ?? 0) % (dash + gap));
  context.beginPath();
  context.moveTo(Math.round(points[0]?.x ?? 0), Math.round(points[0]?.y ?? 0));
  for (let index = 1; index < points.length; index++) {
    const point = points[index];
    if (point) context.lineTo(Math.round(point.x), Math.round(point.y));
  }
  context.stroke();
  context.restore();
}

function forEachDistance(
  points: readonly HighwaySplineSample[],
  interval: number,
  phase: number,
  visit: (point: HighwaySplineSample, ordinal: number) => void,
): void {
  let next = phase;
  let ordinal = 0;
  for (const point of points) {
    if (point.distance + 0.001 < next) continue;
    visit(point, ordinal++);
    next += interval;
  }
}

function shifted(point: HighwaySplineSample, offset: number): HighwaySplineSample {
  return {
    ...point,
    x: point.x + point.normalX * offset,
    y: point.y + point.normalY * offset,
  };
}

function drawLaneArrow(
  context: CanvasRenderingContext2D,
  point: HighwaySplineSample,
  exiting: boolean,
): void {
  drawOriented(context, point, () => {
    context.strokeStyle = COLOR.marking;
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(-10, 0);
    context.lineTo(8, 0);
    context.lineTo(exiting ? 2 : 8, -5);
    context.moveTo(8, 0);
    context.lineTo(exiting ? 2 : 8, 5);
    context.stroke();
  });
}

function drawSign(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  color: string,
): void {
  context.fillStyle = COLOR.railDark;
  context.fillRect(-1, 0, 2, 13);
  context.fillStyle = color;
  context.fillRect(-width * 0.5, -height, width, height);
  context.strokeStyle = COLOR.signText;
  context.lineWidth = 1;
  context.strokeRect(-width * 0.5 + 1, -height + 1, width - 2, height - 2);
  context.fillStyle = COLOR.signText;
  context.fillRect(-width * 0.3, -height * 0.65, width * 0.6, 2);
}

function drawTreeOrBush(context: CanvasRenderingContext2D, tree: boolean): void {
  if (tree) {
    context.fillStyle = '#4b392d';
    context.fillRect(-2, 2, 4, 9);
  }
  context.fillStyle = tree ? '#28513a' : '#3b653f';
  pixelCircle(context, -4, 0, tree ? 7 : 4);
  pixelCircle(context, 4, -2, tree ? 8 : 5);
  context.fillStyle = tree ? '#3f7045' : '#56804a';
  pixelCircle(context, 0, -6, tree ? 7 : 4);
}

function nearestMainlineSample(
  mainlines: readonly HighwayMainlineSection[],
  position: Vector2,
): HighwaySplineSample | undefined {
  let best: HighwaySplineSample | undefined;
  let bestDistance = Infinity;
  for (const mainline of mainlines) {
    for (const point of mainline.points) {
      const candidate = Math.hypot(point.x - position.x, point.y - position.y);
      if (candidate >= bestDistance) continue;
      bestDistance = candidate;
      best = point;
    }
  }
  return best;
}

function drawOriented(
  context: CanvasRenderingContext2D,
  point: HighwaySplineSample,
  draw: () => void,
): void {
  drawOrientedAt(context, point.x, point.y, Math.atan2(point.tangentY, point.tangentX), draw);
}

function drawOrientedAt(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  heading: number,
  draw: () => void,
): void {
  context.save();
  context.translate(Math.round(x), Math.round(y));
  context.rotate(heading);
  draw();
  context.restore();
}

function pixelCircle(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
): void {
  context.beginPath();
  context.arc(Math.round(x), Math.round(y), radius, 0, Math.PI * 2);
  context.fill();
}

function pixelCircleStroke(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
): void {
  context.beginPath();
  context.arc(Math.round(x), Math.round(y), radius, 0, Math.PI * 2);
  context.stroke();
}

function vergeColors(
  character: HighwayMainlineSection['character'],
): readonly [string, string] {
  if (character === 'desert') return [COLOR.vergeDesert, COLOR.vergeDesertDark];
  if (character === 'mountain') return [COLOR.vergeMountain, COLOR.vergeDark];
  if (character === 'forest' || character === 'coastal') return [COLOR.vergeForest, COLOR.vergeDark];
  return [COLOR.verge, COLOR.vergeDark];
}

function asphaltColor(character: HighwayMainlineSection['character']): string {
  if (character === 'desert') return COLOR.asphaltWarm;
  if (character === 'forest' || character === 'coastal') return COLOR.asphaltCool;
  return COLOR.asphalt;
}

function isTreeScenery(kind: HighwaySceneryKind): boolean {
  return (
    kind === 'dense-forest' ||
    kind === 'tea-farm' ||
    kind === 'rice-fields' ||
    kind === 'wetlands' ||
    kind === 'cactus'
  );
}

function hash(value: string): number {
  let state = 2166136261;
  for (let index = 0; index < value.length; index++) {
    state ^= value.charCodeAt(index);
    state = Math.imul(state, 16777619);
  }
  return (state >>> 0) / 4294967296;
}
