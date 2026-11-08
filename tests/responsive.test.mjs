import { loadPlaywright, BASE, shotsDir, createReport, instrument, settle } from './lib.mjs';

const { chromium } = await loadPlaywright();
const OUT = shotsDir(process.argv);
const r = createReport('RESPONSIVE & QUALITY AUDIT');
const { log, ok, problems } = r;

/** The bands the product must work at, one representative size each. */
const VIEWPORTS = [
  ['small-phone', 320, 568],
  ['phone', 375, 812],
  ['large-phone', 414, 896],
  ['tablet-portrait', 768, 1024],
  ['tablet-landscape', 1024, 768],
  ['small-desktop', 1024, 800],
  ['desktop', 1280, 900],
  ['large-desktop', 1600, 1000],
  ['xl-desktop', 1920, 1080],
];

const SCREENS = [
  ['home', '/#/'],
  ['voice', '/#/voice'],
  ['apps', '/#/apps'],
  ['style', '/#/style'],
  ['settings', '/#/settings'],
  ['compact', '/#/compact'],
];

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});

/**
 * Everything measured in the page, in one pass:
 *  - horizontal overflow
 *  - any element wider than the viewport
 *  - interactive targets smaller than the 44px comfortable minimum
 *  - text clipped by its own box
 *  - interactive elements hidden behind the fixed header or nav
 */
async function auditPage(page, viewportWidth, touch) {
  return page.evaluate(
    ({ vw, touch }) => {
      const problems = [];
      const docW = document.documentElement.scrollWidth;
      if (docW > vw + 1) problems.push(`horizontal overflow: content is ${docW}px in a ${vw}px viewport`);

      const visible = (el) => {
        const s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
        const b = el.getBoundingClientRect();
        return b.width > 0 && b.height > 0;
      };

      // Elements sticking out past the right edge. Anything a fixed or
      // clipping ancestor already contains is not a layout problem — the
      // ambient glows are deliberately larger than their container.
      const clippedByAncestor = (el) => {
        for (let a = el.parentElement; a; a = a.parentElement) {
          const s = getComputedStyle(a);
          if (s.position === 'fixed') return true;
          if (s.overflowX !== 'visible' || s.overflow !== 'visible') return true;
        }
        return false;
      };
      for (const el of document.querySelectorAll('body *')) {
        if (!visible(el)) continue;
        if (getComputedStyle(el).position === 'fixed' || clippedByAncestor(el)) continue;
        const b = el.getBoundingClientRect();
        if (b.right > vw + 1) {
          problems.push(`overflows right edge by ${Math.round(b.right - vw)}px: <${el.tagName.toLowerCase()} class="${String(el.className).slice(0, 48)}">`);
          break; // one report per page is enough to act on
        }
      }

      // Touch targets. A control wrapped in a <label> is tapped through the
      // whole label, so that is the box the finger actually has to hit.
      if (touch) {
        const seen = new Set();
        for (const el of document.querySelectorAll('button, a, input[type="checkbox"], select, [role="switch"]')) {
          if (!visible(el)) continue;
          const target = el.closest('label') ?? el;
          const b = target.getBoundingClientRect();
          const label = (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 28);
          if (seen.has(label)) continue;
          seen.add(label);
          if (b.height < 44 || b.width < 44) {
            problems.push(`touch target too small (${Math.round(b.width)}x${Math.round(b.height)}): "${label}"`);
          }
        }
      }

      // Text clipped by its own box (excluding deliberate truncation).
      for (const el of document.querySelectorAll('p, h1, h2, h3, span, dd, dt, button, a')) {
        if (!visible(el) || el.children.length > 0) continue;
        const s = getComputedStyle(el);
        if (s.textOverflow === 'ellipsis' || s.overflow === 'hidden') continue;
        if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
          problems.push(`text clipped: "${el.textContent.trim().slice(0, 36)}"`);
          break;
        }
      }

      return problems;
    },
    { vw: viewportWidth, touch },
  );
}

/**
 * Controls that stay under the fixed header or bottom nav even with the page
 * scrolled all the way down — those are genuinely unreachable. Content that
 * merely passes beneath the nav while scrolling is normal and is not flagged.
 */
async function coveredAtScrollEnd(page) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(250);
  const found = await page.evaluate(() => {
    const out = [];
    const nav = document.querySelector('nav')?.getBoundingClientRect();
    for (const el of document.querySelectorAll('button, a, input, select')) {
      if (el.closest('header') || el.closest('nav')) continue;
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') continue;
      const b = el.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) continue;
      if (b.bottom < 0 || b.top > window.innerHeight) continue;
      const label = (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 28);
      // The midpoint is what a finger aims at.
      const mid = b.top + b.height / 2;
      // Only the bottom nav can hide something for good: anything under the
      // top header is revealed by scrolling up.
      if (nav && mid > nav.top && mid < nav.bottom) { out.push(`unreachable under the bottom nav: "${label}"`); break; }
    }
    return out;
  });
  await page.evaluate(() => window.scrollTo(0, 0));
  return found;
}

for (const [vpName, w, h] of VIEWPORTS) {
  const touch = w < 1024;
  const ctx = await browser.newContext({
    viewport: { width: w, height: h },
    permissions: ['microphone'],
    hasTouch: touch,
    isMobile: w < 768,
    deviceScaleFactor: 2,
  });
  const page = await instrument(ctx, problems);

  for (const [name, route] of SCREENS) {
    await page.goto(BASE + route, { waitUntil: 'networkidle' });
    await settle(page, 550);
    const found = await auditPage(page, w, touch);
    found.push(...(await coveredAtScrollEnd(page)));
    const mark = found.length === 0 ? 'ok' : `${found.length} issue(s)`;
    log(`  ${vpName.padEnd(17)} ${String(w).padStart(4)}x${h}  ${name.padEnd(9)} ${mark}`);
    found.forEach((f) => {
      log(`      · ${f}`);
      problems.push(`${vpName} ${name}: ${f}`);
    });
  }
  await ctx.close();
}

/* ---- Every orb state at the narrowest supported width ---- */
log('\n-- all orb states at 320px --');
const narrow = await browser.newContext({
  viewport: { width: 320, height: 568 },
  permissions: ['microphone'],
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 2,
});
const np = await instrument(narrow, problems);
await np.goto(BASE + '/#/', { waitUntil: 'networkidle' });
await settle(np, 500);

const PATHS = {
  idle: [],
  listening: ['ACTIVATE'],
  processing: ['ACTIVATE', 'SPEECH_CAPTURED'],
  confirmation: ['ACTIVATE', 'SPEECH_CAPTURED', 'NEEDS_APPROVAL'],
  executing: ['ACTIVATE', 'SPEECH_CAPTURED', 'NEEDS_APPROVAL', 'APPROVE'],
  success: ['ACTIVATE', 'SPEECH_CAPTURED', 'NEEDS_APPROVAL', 'APPROVE', 'COMPLETED'],
  error: ['ACTIVATE', 'SPEECH_CAPTURED', 'FAILED'],
};
for (const [state, events] of Object.entries(PATHS)) {
  await np.evaluate(() => window.__orb.getState().reset());
  await np.evaluate((evs) => {
    const s = window.__orb.getState();
    evs.forEach((t) => s.send({ type: t, reason: 'Speech service unreachable' }));
  }, events);
  await settle(np, 600);
  const reached = await np.getAttribute('.orb-stage', 'data-state');
  const found = await auditPage(np, 320, true);
  log(`  ${state.padEnd(13)} reached ${String(reached).padEnd(13)} ${found.length === 0 ? 'ok' : found.length + ' issue(s)'}`);
  ok(reached === state, `could not reach ${state} at 320px (got ${reached})`);
  found.forEach((f) => {
    log(`      · ${f}`);
    problems.push(`320px ${state}: ${f}`);
  });
  await np.screenshot({ path: `${OUT}/r-320-${state}.png` });
}
await np.evaluate(() => window.__orb.getState().reset());

/* ---- A full confirmation turn at 320px must be reachable without scrolling ---- */
log('\n-- confirmation reachable at 320px --');
try {
  await np.goto(BASE + '/#/', { waitUntil: 'networkidle' });
  await settle(np, 500);
  await np.click('button:has-text("Type instead")', { timeout: 8000 });
  await np.fill('input[aria-label="Type a command"]', 'send a WhatsApp message to Rahul saying I will reach in 10 minutes');
  await np.press('input[aria-label="Type a command"]', 'Enter');
  await settle(np, 900);
  await np.click('button:has-text("Use “Rahul”")', { timeout: 8000 });
  await settle(np, 700);
  const confirmBox = await np.locator('button:has-text("Open WhatsApp")').boundingBox();
  log(`  primary action at y=${Math.round(confirmBox?.y ?? -1)} in a 568px viewport`);
  ok(confirmBox !== null, 'the confirmation primary action is not rendered at 320px');
  await np.screenshot({ path: `${OUT}/r-320-confirmation-turn.png` });
} catch (cause) {
  r.fail(`a confirmation turn could not be completed at 320px: ${cause.message.split('\n')[0]}`);
  await np.screenshot({ path: `${OUT}/r-320-confirmation-turn.png` }).catch(() => {});
}
await narrow.close();

/* ---- Tablet landscape keeps the orb prominent ---- */
log('\n-- orb prominence --');
for (const [name, w, h] of [['tablet-portrait', 768, 1024], ['tablet-landscape', 1024, 768], ['desktop', 1440, 900]]) {
  const c = await browser.newContext({ viewport: { width: w, height: h }, permissions: ['microphone'], deviceScaleFactor: 2 });
  const p = await instrument(c, problems);
  await p.goto(BASE + '/#/', { waitUntil: 'networkidle' });
  await settle(p, 600);
  const box = await p.locator('.orb-core').boundingBox();
  const share = ((box.width * box.height) / (w * h)) * 100;
  log(`  ${name.padEnd(17)} orb ${Math.round(box.width)}px · ${share.toFixed(1)}% of the viewport`);
  ok(box.width >= 150, `${name}: the orb is only ${Math.round(box.width)}px — not prominent enough`);
  await p.screenshot({ path: `${OUT}/r-${name}-home.png` });
  await c.close();
}

/* ---- Hover is desktop-only, press feedback is universal ---- */
log('\n-- pointer behaviour --');
const hoverCtx = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['microphone'] });
const hp = await instrument(hoverCtx, problems);
await hp.goto(BASE + '/#/', { waitUntil: 'networkidle' });
await settle(hp, 600);
const before = await hp.evaluate(() => getComputedStyle(document.querySelector('.orb-core')).transform);
await hp.hover('.orb-core', { force: true });
await hp.waitForTimeout(450);
const after = await hp.evaluate(() => getComputedStyle(document.querySelector('.orb-core')).transform);
log(`  desktop hover changes the orb transform: ${before !== after}`);
ok(before !== after, 'the orb has no hover feedback on a fine pointer');
await hoverCtx.close();

await browser.close();
r.finish();
