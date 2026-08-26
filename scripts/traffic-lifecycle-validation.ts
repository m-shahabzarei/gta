import { TrafficTelemetryCollector } from '@/gameplay/traffic/TrafficTelemetry';

interface LifecycleCase {
  readonly id: string;
  readonly kind: 'spawn-accepted' | 'spawn-rejected' | 'materialize-accepted' | 'materialize-rejected' | 'virtualize' | 'virtual-retire' | 'despawn' | 'protected-despawn-rejected' | 'pool-reuse' | 'orphan-detected';
  readonly reason: string | null;
  readonly ownershipClass: 'ambient' | 'parked' | 'transit' | 'service' | 'emergency' | 'pursuit' | 'mission' | 'player' | 'unknown';
}

const cases: readonly LifecycleCase[] = [
  { id: 'connector-before-virtualize', kind: 'virtualize', reason: 'connector-occupancy', ownershipClass: 'ambient' },
  { id: 'active-reservation', kind: 'virtualize', reason: 'reservation-active', ownershipClass: 'ambient' },
  { id: 'mission-owner', kind: 'protected-despawn-rejected', reason: 'mission-critical', ownershipClass: 'mission' },
  { id: 'emergency-owner', kind: 'protected-despawn-rejected', reason: 'emergency-response', ownershipClass: 'emergency' },
  { id: 'pursuit-owner', kind: 'protected-despawn-rejected', reason: 'pursuit-active', ownershipClass: 'pursuit' },
  { id: 'parked-to-player', kind: 'despawn', reason: 'player-takeover', ownershipClass: 'player' },
  { id: 'pool-reuse', kind: 'pool-reuse', reason: 'traffic:sedan', ownershipClass: 'unknown' },
  { id: 'world-stream-change', kind: 'orphan-detected', reason: 'stream-change-ordering', ownershipClass: 'ambient' },
  { id: 'nearby-materialize', kind: 'materialize-rejected', reason: 'vehicle-overlap', ownershipClass: 'ambient' },
  { id: 'destruction-despawn-race', kind: 'orphan-detected', reason: 'destruction-before-prune', ownershipClass: 'ambient' },
];

const telemetry = new TrafficTelemetryCollector({ scenarioId: 'lifecycle-validation', maxEvents: 32 });
for (const [index, item] of cases.entries()) {
  telemetry.recordLifecycle({
    kind: item.kind,
    atMs: index * 50,
    vehicleId: index + 1,
    driverId: index + 1,
    reason: item.reason,
    ownershipClass: item.ownershipClass,
    state: null,
    metadataLost: item.kind === 'virtualize' ? ['route', 'driver-profile', 'ownership-flags'] : [],
  });
}
const snapshot = telemetry.snapshot();
const failures: string[] = [];
for (const item of cases) {
  const count = snapshot.counters[`lifecycle.${item.kind}`] ?? 0;
  if (count < 1) failures.push(`${item.id}: lifecycle event was not retained`);
  const reasonCount = snapshot.counters[`lifecycle.reason.${item.reason}`] ?? 0;
  if (reasonCount < 1) failures.push(`${item.id}: lifecycle reason was not retained`);
}
const virtualEvent = snapshot.lifecycle.find((event) => event.kind === 'virtualize');
if (!virtualEvent || virtualEvent.metadataLost.length === 0) failures.push('virtualize metadata loss was not recorded');

if (failures.length > 0) {
  console.error(`Traffic lifecycle validation FAILED (${failures.length} failures)`);
  for (const failure of failures) console.error(` - ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Traffic lifecycle validation PASSED (${cases.length} cases)`);
}
