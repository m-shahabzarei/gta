import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, '.runtime-performance-baseline.bundle.mjs');
const stressDir = process.argv[2] ?? join(root, '.traffic-stress-p0-baseline');
const baselinePath = process.argv[3] ?? join(root, 'docs/performance/runtime-baseline-2026-08-28.json');

try {
  if (process.env.REUSE_STRESS !== '1') {
    const stress = spawnSync(process.execPath, [join(root, 'scripts', 'run-traffic-stress.mjs'), stressDir], {
      cwd: root,
      stdio: 'inherit',
    });
    if ((stress.status ?? 1) !== 0) process.exitCode = stress.status ?? 1;
    if ((stress.status ?? 1) !== 0) process.exit();
  }
  await build({
    entryPoints: [join(root, 'scripts', 'runtime-performance-baseline.ts')],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'warning',
  });
  const result = spawnSync(process.execPath, [output, stressDir, baselinePath], {
    cwd: root,
    env: { ...process.env, GIT_COMMIT: process.env.GIT_COMMIT ?? '5335cc2b989d0f97375e9264c9f34bb7e26dac0d' },
    stdio: 'inherit',
  });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(output, { force: true });
}
