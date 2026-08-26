import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, '.traffic-stress.bundle.mjs');
const outputDir = process.argv[2] ?? join(root, '.traffic-stress');

try {
  await build({
    entryPoints: [join(root, 'scripts', 'traffic-stress.ts')],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    alias: { '@': join(root, 'src') },
    logLevel: 'warning',
  });
  const result = spawnSync(process.execPath, [output, outputDir], {
    cwd: root,
    stdio: 'inherit',
  });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(output, { force: true });
}
