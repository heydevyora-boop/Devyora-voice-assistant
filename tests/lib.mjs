import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Resolve Playwright from the project if it is installed there, otherwise
 * from a global install. It is not a project dependency: the suites are an
 * end-to-end harness, and requiring a browser download to `npm install` the
 * app would be the wrong trade.
 */
export async function loadPlaywright() {
  const require = createRequire(import.meta.url);
  for (const id of ['playwright', '/opt/node-tools/node_modules/playwright/index.js']) {
    try {
      const mod = require(id);
      return mod.chromium ? mod : mod.default;
    } catch {
      /* try the next location */
    }
  }
  throw new Error(
    'Playwright not found. Install it with `npm i -D playwright` and run `npx playwright install chromium`.',
  );
}

export const BASE = process.env.DEVYORA_TEST_URL ?? 'http://localhost:5173';

export function shotsDir(argv) {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = argv[2] ?? join(here, '..', '.test-output');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Collects problems and prints a consistent verdict. */
export function createReport(title) {
  const problems = [];
  return {
    log: (...a) => console.log(...a),
    ok(condition, message) {
      if (!condition) problems.push(message);
      return condition;
    },
    fail(message) {
      problems.push(message);
    },
    finish() {
      console.log(`\n==================== ${title} ====================`);
      if (problems.length === 0) {
        console.log('All checks passed. No console errors, no failed requests.');
      } else {
        console.log(`${problems.length} problem(s):`);
        problems.forEach((p) => console.log('  - ' + p));
      }
      process.exit(problems.length ? 1 : 0);
    },
    problems,
  };
}

/** A page that reports console errors, page errors and failed requests. */
export async function instrument(context, problems) {
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`[console.${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', (r) => {
    if (r.url().startsWith(BASE)) problems.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`);
  });
  return page;
}

export const settle = (page, ms = 400) => page.waitForTimeout(ms);
