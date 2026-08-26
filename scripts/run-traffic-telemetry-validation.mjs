import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, '.traffic-telemetry-validation.bundle.mjs');

try {
  await build({
    entryPoints: [join(root, 'scripts', 'traffic-telemetry-validation.ts')],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    alias: { '@': join(root, 'src') },
    logLevel: 'warning',
  });
  const result = spawnSync(process.execPath, [output], { cwd: root, stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(output, { force: true });
}
