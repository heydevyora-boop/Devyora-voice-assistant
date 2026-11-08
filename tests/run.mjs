import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BASE } from './lib.mjs';

/**
 * Runs every suite in order against an already-running server.
 *
 * Start one first: `npm run dev`, or `npm run build && npm run preview`
 * with DEVYORA_TEST_URL pointing at the preview port.
 */
const here = dirname(fileURLToPath(import.meta.url));
const SUITES = ['orb.test.mjs', 'voice.test.mjs', 'surfaces.test.mjs', 'responsive.test.mjs'];

try {
  const res = await fetch(BASE, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(String(res.status));
} catch {
  console.error(`No server at ${BASE}. Start one with \`npm run dev\` first.`);
  process.exit(1);
}

let failed = 0;
for (const suite of SUITES) {
  console.log(`\n########## ${suite} ##########`);
  const code = await new Promise((resolve) => {
    spawn(process.execPath, [join(here, suite)], { stdio: 'inherit' }).on('close', resolve);
  });
  if (code !== 0) failed += 1;
}

console.log(`\n${failed === 0 ? 'All suites passed.' : `${failed} suite(s) failed.`}`);
process.exit(failed === 0 ? 0 : 1);
