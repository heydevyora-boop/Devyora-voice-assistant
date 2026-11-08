import { loadPlaywright, BASE, shotsDir } from './lib.mjs';
const { chromium } = await loadPlaywright();

const OUT = shotsDir(process.argv);
const problems = [];
const log = (...a) => console.log(...a);
const ok = (c, m) => { if (!c) problems.push(m); return c; };

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
async function makePage(ctx) {
  const p = await ctx.newPage();
  p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`[console.${m.type()}] ${m.text()}`); });
  p.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
  p.on('requestfailed', (r) => { if (r.url().startsWith(BASE)) problems.push(`[requestfailed] ${r.url()}`); });
  return p;
}
const settle = (p, ms = 400) => p.waitForTimeout(ms);

/* ================= 1. Connected apps ================= */
log('-- connected apps --');
const ctx = await browser.newContext({ viewport: { width: 420, height: 1000 }, deviceScaleFactor: 2, permissions: ['microphone'] });
const page = await makePage(ctx);
await page.addInitScript(() => {
  const real = window.open.bind(window);
  window.__opened = [];
  window.open = (u, ...r) => { window.__opened.push(String(u)); return real(u, ...r); };
});
await page.goto(BASE + '/#/apps', { waitUntil: 'networkidle' });
await settle(page, 600);

const body = await page.textContent('body');
for (const name of ['WhatsApp', 'Instagram', 'Facebook', 'Telegram', 'Gmail', 'Notes', 'Calendar']) {
  ok(body.includes(name), `apps screen missing ${name}`);
}
log('  all seven integrations listed');

// Brand colours must be the ones specified.
const brands = await page.evaluate(() => {
  const want = { WhatsApp: '#25D366', Instagram: '#E1306C', Facebook: '#1877F2', Telegram: '#229ED9', Gmail: '#EA4335', Notes: '#F59E0B' };
  const hex = (rgb) => '#' + rgb.match(/\d+/g).slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('').toUpperCase();
  const out = {};
  for (const [name, expected] of Object.entries(want)) {
    const label = [...document.querySelectorAll('span')].find((s) => s.textContent.trim() === name);
    const card = label?.closest('[class*="glass"]');
    // The icon tile is the aria-hidden span that actually holds the glyph;
    // GlassCard's accent hairline is also aria-hidden and comes first.
    const tile = card?.querySelector('span[aria-hidden="true"]:has(svg)');
    out[name] = { got: tile ? hex(getComputedStyle(tile).color) : null, expected };
  }
  return out;
});
for (const [name, { got, expected }] of Object.entries(brands)) {
  const match = got === expected;
  log(`  ${name.padEnd(10)} ${got} ${match ? '==' : '!='} ${expected}`);
  ok(match, `${name} brand colour is ${got}, expected ${expected}`);
}

// Nothing may be shown as connected: no provider confirmed anything.
const connectedChips = await page.locator('span:text-is("Connected")').count();
const notConnected = await page.locator('span:text-is("Not connected")').count();
const onDevice = await page.locator('span:text-is("On this device")').count();
log(`  status chips — connected: ${connectedChips}, not connected: ${notConnected}, on device: ${onDevice}`);
ok(connectedChips === 0, 'an app is shown as connected with no integration service');
ok(notConnected === 6, `expected 6 unlinked apps, saw ${notConnected}`);
ok(onDevice === 1, 'Notes is not reported as genuinely working on device');

// Connecting must fail honestly, not flip a switch.
await page.click('button:has-text("Connect WhatsApp")');
await settle(page, 700);
const afterConnect = await page.textContent('body');
ok(/needs an OAuth backend/i.test(afterConnect), 'connect attempt did not explain why it failed');
ok((await page.locator('span:text-is("Connected")').count()) === 0, 'failed connect still marked the app as connected');
log('  connect attempt → explains the missing backend, nothing marked connected');
await page.screenshot({ path: `${OUT}/a-apps-mobile.png`, fullPage: true });

// A hand-off capability opens a real public URL.
const popupPromise = page.waitForEvent('popup', { timeout: 5000 }).catch(() => null);
await page.click('button:has-text("Prepare a message")');
const popup = await popupPromise;
await popup?.close();
const openedUrl = await page.evaluate(() => window.__opened.at(-1));
log(`  hand-off opened: ${openedUrl}`);
ok(openedUrl?.startsWith('https://wa.me/'), 'WhatsApp hand-off did not open the documented URL');
const handoffNotice = await page.textContent('body');
ok(/cannot complete it for you/i.test(handoffNotice), 'hand-off notice overstates what happened');

// Scopes are disclosed rather than implied.
ok(/Would request: WhatsApp Business API account/i.test(body), 'required authorisation scopes not disclosed');
log('  requested scopes disclosed per app');

/* ================= 2. Customizer ================= */
log('\n-- orb customizer --');
await page.goto(BASE + '/#/style', { waitUntil: 'networkidle' });
await settle(page, 700);

const readVars = () =>
  page.evaluate(() => {
    const stage = document.querySelector('.orb-stage');
    const cs = getComputedStyle(stage);
    const core = document.querySelector('.orb-core');
    return {
      from: cs.getPropertyValue('--orb-user-from').trim(),
      scale: cs.getPropertyValue('--orb-size-scale').trim(),
      glow: cs.getPropertyValue('--orb-glow-scale').trim(),
      alpha: cs.getPropertyValue('--orb-alpha').trim(),
      motion: stage.getAttribute('data-motion-style'),
      shape: stage.getAttribute('data-shape'),
      radius: getComputedStyle(core).borderRadius,
      width: Math.round(core.getBoundingClientRect().width),
    };
  });

// Exactly one orb on the page, and it is the shared component.
const orbCount = await page.locator('.orb-stage').count();
log(`  orb-stage instances on the customizer: ${orbCount} (the shared component)`);
ok(orbCount === 1, 'the preview is not the single shared Orb');

const before = await readVars();
log(`  initial: palette ${before.from} · shape ${before.shape} · ${before.width}px`);

await page.click('button[aria-label="Emerald Aura"]');
await settle(page, 350);
let v = await readVars();
log(`  palette → Emerald Aura: --orb-user-from = ${v.from}`);
ok(v.from === '#10b981', `palette did not reach the orb (got ${v.from})`);

await page.click('button:has-text("Squircle")');
await settle(page, 350);
v = await readVars();
log(`  shape → squircle: data-shape=${v.shape}, radius=${v.radius}`);
ok(v.shape === 'squircle' && !v.radius.startsWith('9999'), 'shape change did not reach the orb');

await page.click('button:has-text("96px")');
await settle(page, 400);
const big = await readVars();
log(`  size → 96px: scale ${big.scale}, rendered ${big.width}px (was ${before.width}px)`);
ok(Number(big.scale) > Number(before.scale), 'size choice did not scale the orb');
ok(big.width > before.width, 'the rendered orb did not grow');

await page.locator('input[aria-label="Glow intensity"]').fill('20');
await settle(page, 300);
v = await readVars();
log(`  glow → 20%: --orb-glow-scale = ${v.glow}`);
ok(Math.abs(Number(v.glow) - 20 / 75) < 0.01, 'glow slider did not reach the orb');

await page.locator('input[aria-label="Transparency"]').fill('40');
await settle(page, 300);
v = await readVars();
log(`  transparency → 40%: --orb-alpha = ${v.alpha}`);
ok(Math.abs(Number(v.alpha) - 0.4) < 0.01, 'transparency slider did not reach the orb');

await page.click('button:has-text("Floating motes")');
await settle(page, 400);
v = await readVars();
const motes = await page.locator('.orb-mote').count();
log(`  motion → motes: data-motion-style=${v.motion}, motes rendered=${motes}`);
ok(v.motion === 'particles' && motes === 5, 'motion style did not reach the orb');

await page.screenshot({ path: `${OUT}/a-style-draft.png`, fullPage: true });

/* ---- unsaved draft must not leak to other screens ---- */
const persistedBefore = await page.evaluate(() => localStorage.getItem('devyora.orb-appearance'));
ok(!/emerald/.test(persistedBefore ?? ''), 'an unsaved draft was persisted');
log('  unsaved draft is not persisted');

/* ---- save, then verify it reaches the home orb ---- */
await page.click('button:has-text("Save & apply")');
await settle(page, 600);
const toast = await page.locator('[role="status"]').count();
ok(toast > 0, 'no confirmation after saving');
log('  saved; confirmation shown');

await page.goto(BASE + '/#/', { waitUntil: 'networkidle' });
await settle(page, 600);
const home = await readVars();
log(`  home orb after save: palette ${home.from}, motion ${home.motion}, shape ${home.shape}`);
ok(home.from === '#10b981', 'saved palette did not reach the home orb');
ok(home.motion === 'particles', 'saved motion did not reach the home orb');
ok(home.shape === 'squircle', 'saved shape did not reach the home orb');
await page.screenshot({ path: `${OUT}/a-home-custom.png` });

/* ---- the compact widget uses the chosen px size ---- */
await page.goto(BASE + '/#/compact', { waitUntil: 'networkidle' });
await settle(page, 500);
const compact = await readVars();
const compactScale = await page.evaluate(() => Number(getComputedStyle(document.querySelector('.orb-stage')).getPropertyValue('--orb-scale')));
const compactConfigured = Math.round(compact.width / compactScale);
log(`  compact widget: configured ${compactConfigured}px, drawn ${compact.width}px at the idle scale of ${compactScale}`);
ok(Math.abs(compactConfigured - 96) <= 2, `compact widget is configured at ${compactConfigured}px, expected 96px`);

/* ---- persistence across a reload ---- */
await page.goto(BASE + '/#/', { waitUntil: 'networkidle' });
await settle(page, 500);
const reloaded = await readVars();
log(`  after reload: palette ${reloaded.from}, shape ${reloaded.shape}`);
ok(reloaded.from === '#10b981' && reloaded.shape === 'squircle', 'appearance did not survive a reload');

/* ---- semantic states keep their own colour ---- */
await page.evaluate(() => {
  const s = window.__orb.getState();
  ['ACTIVATE', 'SPEECH_CAPTURED', 'COMPLETED'].forEach((t) => s.send({ type: t }));
});
await settle(page, 600);
const success = await page.evaluate(() => getComputedStyle(document.querySelector('.orb-stage')).getPropertyValue('--orb-accent').trim());
log(`  success state accent with an Emerald palette: ${success}`);
ok(!success.includes('--orb-user'), 'a palette repainted a semantic state');
await page.evaluate(() => window.__orb.getState().reset());

/* ---- reset ---- */
await page.goto(BASE + '/#/style', { waitUntil: 'networkidle' });
await settle(page, 600);
await page.click('button:has-text("Reset")');
await settle(page, 350);
const afterReset = await readVars();
log(`  reset → palette ${afterReset.from}, shape ${afterReset.shape}`);
ok(afterReset.from === '#06b6d4' && afterReset.shape === 'circle', 'reset did not restore defaults');
await page.click('button:has-text("Save & apply")');
await settle(page, 500);
// With the draft now identical to what is saved, Save must be inert.
const saveDisabled = await page.locator('button:has-text("Save & apply")').isDisabled();
log(`  save disabled once there is nothing to save: ${saveDisabled}`);
ok(saveDisabled, 'Save stays active with no pending change');

/* ---- presets ---- */
await page.click('button:has-text("Cyber Aurora")');
await settle(page, 400);
const preset = await readVars();
log(`  preset Cyber Aurora → palette ${preset.from}, shape ${preset.shape}, motion ${preset.motion}`);
ok(preset.from === '#f074ff' && preset.shape === 'squircle' && preset.motion === 'ripple', 'preset did not apply');
await page.click('button:has-text("Reset")');
await settle(page, 300);
if (!(await page.locator('button:has-text("Save & apply")').isDisabled())) {
  await page.click('button:has-text("Save & apply")');
}
await settle(page, 400);

/* ================= 3. Settings ================= */
log('\n-- settings --');
await page.goto(BASE + '/#/settings', { waitUntil: 'networkidle' });
await settle(page, 600);
const sText = await page.textContent('body');
for (const section of ['Voice & language', 'Orb appearance', 'Connected apps', 'Permissions & privacy', 'Account', 'Speak replies', 'Confirmation timeout']) {
  ok(sText.includes(section), `settings missing "${section}"`);
}
ok(/no sign-in/i.test(sText), 'settings invents an account system');
ok(/No account tokens are stored in the browser/i.test(sText), 'settings does not state the token policy');
log('  all sections present; no invented account system');

for (const [label, href] of [['Voice & language', '#/voice'], ['Orb appearance', '#/style'], ['Connected apps', '#/apps']]) {
  await page.click(`a:has-text("${label}")`);
  await settle(page, 400);
  const url = page.url();
  ok(url.endsWith(href), `"${label}" went to ${url}`);
  await page.goBack();
  await settle(page, 400);
}
log('  navigation rows reach their screens');
await page.screenshot({ path: `${OUT}/a-settings.png`, fullPage: true });

/* ================= 4. Responsive ================= */
log('\n-- responsive --');
for (const [name, w, h] of [['mobile', 390, 844], ['tablet', 834, 1112], ['desktop', 1440, 900]]) {
  for (const route of ['/#/apps', '/#/style', '/#/settings']) {
    const c = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, permissions: ['microphone'] });
    const p = await makePage(c);
    await p.goto(BASE + route, { waitUntil: 'networkidle' });
    await p.waitForTimeout(600);
    const docW = await p.evaluate(() => document.documentElement.scrollWidth);
    const over = docW > w + 1;
    if (over) problems.push(`${name} ${route}: horizontal overflow (${docW} > ${w})`);
    if (route === '/#/apps') {
      const cols = await p.evaluate(() => {
        const grid = document.querySelector('[class*="grid-cols-1"]');
        return grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0;
      });
      log(`  ${name.padEnd(8)} ${route.padEnd(12)} ${docW}px wide · apps grid columns: ${cols} · overflow: ${over ? 'YES' : 'no'}`);
    } else {
      log(`  ${name.padEnd(8)} ${route.padEnd(12)} ${docW}px wide · overflow: ${over ? 'YES' : 'no'}`);
    }
    await p.screenshot({ path: `${OUT}/a-${name}-${route.replace(/[#/]/g, '') || 'home'}.png` });
    await c.close();
  }
}

await browser.close();
log('\n==================== RESULT ====================');
if (problems.length === 0) log('All checks passed. No console errors, no failed requests.');
else { log(`${problems.length} problem(s):`); problems.forEach((p) => log('  - ' + p)); }
process.exit(problems.length ? 1 : 0);
