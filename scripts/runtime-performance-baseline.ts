import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface StressResult {
  schemaVersion: number;
  scenario: {
    id: string;
    city: string;
    district: string;
    density: string;
    seed: number;
    durationSeconds: number;
  };
  fixtureCoverage: string;
  baselineMetrics: Record<string, unknown>;
  diagnostics: Record<string, unknown>;
  validation: Record<string, unknown>;
  wallClockMs: number;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const outputDir = resolve(process.argv[2] ?? '.traffic-stress-p0-baseline');
const outputPath = resolve(process.argv[3] ?? 'docs/performance/runtime-baseline-2026-08-28.json');
const results = JSON.parse(readFileSync(resolve(outputDir, 'index.json'), 'utf8')) as StressResult[];
const scenarios = results.map((result) => {
  const metrics = result.baselineMetrics;
  return {
    id: result.scenario.id,
    city: result.scenario.city,
    district: result.scenario.district,
    density: result.scenario.density,
    seed: result.scenario.seed,
    durationSeconds: result.scenario.durationSeconds,
    fixtureCoverage: result.fixtureCoverage,
    frameTimeMs: {
      average: numberOrNull(metrics.realFrameTimeMs),
      p50: numberOrNull(metrics.frameP50Ms),
      p95: numberOrNull(metrics.frameP95Ms),
      p99: numberOrNull(metrics.frameP99Ms),
      over20: numberOrNull(metrics.framesOver20Ms),
      over33: numberOrNull(metrics.framesOver33Ms),
      over50: numberOrNull(metrics.framesOver50Ms),
    },
    traffic: {
      activeVehicles: numberOrNull(metrics.activeCount),
      virtualVehicles: numberOrNull(metrics.virtualCount),
      parkedVehicles: numberOrNull(metrics.parkedCount),
      trafficCpuMs: numberOrNull(metrics.trafficCpuMs),
      deferredUpdates: numberOrNull(metrics.deferredUpdate),
      maximumUpdateAgeMs: numberOrNull(metrics.maximumUpdateAgeMs),
    },
    wallClockMs: result.wallClockMs,
    correctness: result.validation,
    diagnostics: result.diagnostics,
  };
});

const baseline = {
  schemaVersion: 1,
  capturedAt: new Date().toISOString(),
  commit: process.env.GIT_COMMIT ?? 'unknown',
  source: 'scripts/traffic-stress.ts (deterministic headless-network harness)',
  notes: [
    'Wall-clock frame samples are measured with performance.now() around each simulated frame.',
    'This harness covers traffic, highway transition, pause/resume, bus/taxi, and 15/30-minute stability scenarios.',
    'Browser-only rendering, GPU, heap, input-latency, weather, interior and mobile metrics require the browser smoke scripts and are recorded as unavailable here.',
  ],
  scenarios,
};

writeFileSync(outputPath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ outputPath, commit: baseline.commit, scenarios: scenarios.length }, null, 2));
