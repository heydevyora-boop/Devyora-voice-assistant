import { loadPlaywright, BASE, shotsDir } from './lib.mjs';
const { chromium, devices } = await loadPlaywright();

const OUT = shotsDir(process.argv);
const problems = [];
const log = (...a) => console.log(...a);

// A real microphone is now opened on activation, so the regression run needs
// a fake device and granted permission to reach `listening` at all.
const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});

async function newPage(ctx) {
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`[console.${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));
  return page;
}

/* ---------- 1. State machine + interaction, via the real UI ---------- */
const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 2, permissions: ['microphone'] });
const page = await newPage(ctx);
await page.goto(BASE + '/#/', { waitUntil: 'networkidle' });

const stageState = () => page.getAttribute('.orb-stage', 'data-state');
const heading = () => page.textContent('h1');

log('initial state      :', await stageState(), '|', await heading());
if (await stageState() !== 'idle') problems.push('initial state is not idle');

// click to activate
await page.click('.orb-core', { force: true });
await page.waitForTimeout(250);
log('after 1st click    :', await stageState(), '|', await heading());
if (await stageState() !== 'listening') problems.push('click did not enter listening');

// the visualiser must be mounted while listening, and gone otherwise
log('waveform bars      :', await page.locator('.orb-waveform span').count());

// double-activation guard: immediate second click must be swallowed
await page.click('.orb-core', { force: true });
await page.waitForTimeout(60);
const afterRapid = await stageState();
log('rapid 2nd click    :', afterRapid, '(guard should keep it listening)');
if (afterRapid !== 'listening') problems.push('double-tap guard failed: a quick second tap cut the turn short');

// A second tap asks the recogniser to stop. The engine decides when it
// actually finishes, so the guarantee under test is that the user is never
// stranded: Escape always returns to idle.
await page.waitForTimeout(400);
await page.click('.orb-core', { force: true });
await page.waitForTimeout(250);
const afterStop = await stageState();
log('click after wait   :', afterStop, '(stop requested; no speech was made)');
if (!['listening', 'error', 'idle'].includes(afterStop)) problems.push(`unexpected state after stop: ${afterStop}`);
await page.keyboard.press('Escape');
await page.waitForTimeout(500);
if (await stageState() === 'error') { await page.click('button:has-text("Dismiss")', { force: true }); await page.waitForTimeout(400); }
log('recovered          :', await stageState());
if (await stageState() !== 'idle') problems.push('could not return to idle after a stop request');
if (await page.locator('.orb-waveform').count() !== 0) problems.push('waveform still mounted when idle');

// Escape cancels
await page.click('.orb-core', { force: true }); await page.waitForTimeout(300);
await page.keyboard.press('Escape'); await page.waitForTimeout(200);
log('Escape from listen :', await stageState());
if (await stageState() !== 'idle') problems.push('Escape did not cancel');

// keyboard activation
await page.waitForTimeout(400);
await page.focus('.orb-core');
await page.keyboard.press('Enter'); await page.waitForTimeout(250);
log('Enter key          :', await stageState());
if (await stageState() !== 'listening') problems.push('Enter did not activate');
await page.waitForTimeout(400);
await page.keyboard.press(' '); await page.waitForTimeout(250);
log('Space key          :', await stageState(), '(stop requested)');
await page.keyboard.press('Escape'); await page.waitForTimeout(500);
if (await stageState() === 'error') { await page.click('button:has-text("Dismiss")', { force: true }); await page.waitForTimeout(400); }
if (await stageState() !== 'idle') problems.push('Space then Escape did not return to idle');

// cancel control appears only while engaged
await page.waitForTimeout(400);
await page.click('.orb-core', { force: true }); await page.waitForTimeout(250);
const cancelVisible = await page.locator('button:has-text("Cancel")').count();
log('cancel control     :', cancelVisible ? 'shown while listening' : 'MISSING');
if (!cancelVisible) problems.push('cancel control missing in listening');
await page.click('button:has-text("Cancel")', { force: true }); await page.waitForTimeout(400);
if (await stageState() !== 'idle') problems.push('Cancel button did not cancel');
if (await page.locator('button:has-text("Cancel")').count() !== 0) problems.push('controls persist when idle');
await page.evaluate(() => window.__voice.getState().resetTurn());

/* ---------- 2. Drive every state through the store (pipeline events) ---------- */
log('\n-- full state machine walk --');
const send = async (e) => {
  await page.evaluate((ev) => window.__orb.getState().send(ev), e);
  await page.waitForTimeout(200);
  return stageState();
};
const reset = () => page.evaluate(() => window.__orb.getState().reset());

const walk = [
  [{ type: 'ACTIVATE' },        'listening'],
  [{ type: 'SPEECH_CAPTURED' }, 'processing'],
  [{ type: 'NEEDS_APPROVAL' },  'confirmation'],
  [{ type: 'APPROVE' },         'executing'],
  [{ type: 'COMPLETED' },       'success'],
];
await reset();
for (const [ev, expected] of walk) {
  const got = await send(ev);
  const ok = got === expected;
  log(`  ${ev.type.padEnd(16)} -> ${String(got).padEnd(13)} ${ok ? 'OK' : 'EXPECTED ' + expected}`);
  if (!ok) problems.push(`transition ${ev.type} gave ${got}, expected ${expected}`);
}
// success auto-dismisses back to idle (presentational timer)
await page.waitForTimeout(2700);
const afterSuccess = await stageState();
log(`  success auto-dismiss -> ${afterSuccess}`);
if (afterSuccess !== 'idle') problems.push('success did not auto-dismiss to idle');

// error path + retry
await reset();
await send({ type: 'ACTIVATE' });
await send({ type: 'SPEECH_CAPTURED' });
const errState = await send({ type: 'FAILED', reason: 'Speech service unreachable' });
log(`  FAILED           -> ${errState}`);
if (errState !== 'error') problems.push('FAILED did not reach error');
const reasonShown = await page.textContent('h1 + p');
log(`  error reason shown: "${reasonShown}"`);
if (!reasonShown.includes('unreachable')) problems.push('error reason not surfaced');
const retryBtn = await page.locator('button:has-text("Retry")').count();
if (!retryBtn) problems.push('retry control missing in error state');
await page.click('button:has-text("Retry")', { force: true }); await page.waitForTimeout(250);
log(`  Retry            -> ${await stageState()}`);
if (await stageState() !== 'listening') problems.push('retry did not resume listening');

// locked states ignore orb taps
await reset();
await send({ type: 'ACTIVATE' });
await send({ type: 'SPEECH_CAPTURED' });   // processing (locked)
await page.waitForTimeout(400);
await page.click('.orb-core', { force: true });
await page.waitForTimeout(250);
const lockedState = await stageState();
log(`  tap while processing -> ${lockedState} (must stay processing)`);
if (lockedState !== 'processing') problems.push('locked state was interruptible by orb tap');

// confirmation controls
await reset();
await send({ type: 'ACTIVATE' });
await send({ type: 'SPEECH_CAPTURED' });
await send({ type: 'NEEDS_APPROVAL' });
// With no plan attached (the machine was driven directly), the confirmation
// phase must still offer an exit rather than stranding the user.
const exitCount = await page.locator('button:has-text("Cancel")').count();
log(`  confirmation with no plan offers an exit: ${exitCount > 0}`);
if (exitCount === 0) problems.push('confirmation with no plan is a dead end');

/* ---------- 3. Screenshots of every state ---------- */
log('\n-- capturing state screenshots --');
const STATES = ['idle','listening','processing','confirmation','executing','success','error'];
for (const st of STATES) {
  await reset();
  // reach the state directly through the store for a clean capture
  await page.evaluate((s) => {
    const store = window.__orb.getState();
    const path = {
      idle: [], listening: ['ACTIVATE'],
      processing: ['ACTIVATE','SPEECH_CAPTURED'],
      confirmation: ['ACTIVATE','SPEECH_CAPTURED','NEEDS_APPROVAL'],
      executing: ['ACTIVATE','SPEECH_CAPTURED','NEEDS_APPROVAL','APPROVE'],
      success: ['ACTIVATE','SPEECH_CAPTURED','NEEDS_APPROVAL','APPROVE','COMPLETED'],
      error: ['ACTIVATE','SPEECH_CAPTURED','FAILED'],
    }[s];
    for (const t of path) store.send({ type: t, reason: 'Speech service unreachable' });
  }, st);
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/state-${st}.png` });
}
await reset();

/* ---------- 4. Responsive layouts ---------- */
log('\n-- responsive --');
const VIEWPORTS = [
  ['mobile',  390, 844],
  ['tablet',  834, 1112],
  ['desktop', 1440, 900],
];
for (const [name, w, h] of VIEWPORTS) {
  const c = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, permissions: ['microphone'] });
  const p = await newPage(c);
  await p.goto(BASE + '/#/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(500);
  const orbBox = await p.locator('.orb-core').boundingBox();
  const docW = await p.evaluate(() => document.documentElement.scrollWidth);
  const horizontalScroll = docW > w + 1;
  log(`  ${name.padEnd(8)} ${w}x${h}  orb ${Math.round(orbBox.width)}px  h-scroll: ${horizontalScroll ? 'YES (BAD)' : 'no'}`);
  if (horizontalScroll) problems.push(`${name}: horizontal overflow (${docW} > ${w})`);
  await p.screenshot({ path: `${OUT}/layout-${name}.png`, fullPage: false });
  await c.close();
}

/* ---------- 5. Layout-shift check across a state change ---------- */
log('\n-- layout stability --');
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(BASE + '/#/', { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
const before = await page.locator('h1').boundingBox();
await page.click('.orb-core', { force: true });
await page.waitForTimeout(900);
const after = await page.locator('h1').boundingBox();
const shift = Math.abs(before.y - after.y);
log(`  status heading y: ${before.y.toFixed(1)} -> ${after.y.toFixed(1)} (shift ${shift.toFixed(1)}px)`);
if (shift > 1) problems.push(`layout shift of ${shift.toFixed(1)}px when entering listening`);

/* ---------- 6. Reduced motion ---------- */
log('\n-- reduced motion --');
const rmCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', permissions: ['microphone'] });
const rmPage = await newPage(rmCtx);
await rmPage.goto(BASE + '/#/', { waitUntil: 'networkidle' });
await rmPage.click('.orb-core', { force: true });
await rmPage.waitForTimeout(400);
const anims = await rmPage.evaluate(() =>
  document.getAnimations().filter((a) => a.playState === 'running').length);
log(`  running animations under prefers-reduced-motion: ${anims}`);
if (anims > 0) problems.push(`${anims} animations still running under reduced motion`);
const rings = await rmPage.locator('.orb-ring').count();
log(`  sound rings rendered: ${rings} (expected 0)`);
if (rings !== 0) problems.push('sound rings rendered under reduced motion');
await rmPage.screenshot({ path: `${OUT}/reduced-motion.png` });
await rmCtx.close();

/* ---------- 7. Other routes ---------- */
log('\n-- routes --');
for (const r of ['/#/settings', '/#/voice', '/#/apps', '/#/style', '/#/compact', '/#/dev/states']) {
  const p = await newPage(await browser.newContext({ viewport: { width: 420, height: 900 }, permissions: ['microphone'] }));
  await p.goto(BASE + r, { waitUntil: 'networkidle' });
  await p.waitForTimeout(400);
  const h = await p.locator('h1').first().textContent().catch(() => '(none)');
  log(`  ${r.padEnd(16)} -> "${h}"`);
  if (r === '/#/compact') await p.screenshot({ path: `${OUT}/compact.png` });
  if (r === '/#/dev/states') await p.setViewportSize({width:1280,height:1400}), await p.waitForTimeout(400), await p.screenshot({ path: `${OUT}/dev-states.png`, fullPage: true });
  if (r === '/#/settings') await p.screenshot({ path: `${OUT}/settings.png` });
  await p.context().close();
}

/* ---------- 8. Touch device ---------- */
log('\n-- touch --');
const tctx = await browser.newContext({ ...devices['Pixel 7'], permissions: ['microphone'] });
const tpage = await newPage(tctx);
await tpage.goto(BASE + '/#/', { waitUntil: 'networkidle' });
await tpage.waitForTimeout(400);
await tpage.locator('.orb-core').tap({ force: true });
await tpage.waitForTimeout(300);
log(`  tap on Pixel 7 -> ${await tpage.getAttribute('.orb-stage','data-state')}`);
if (await tpage.getAttribute('.orb-stage','data-state') !== 'listening') problems.push('tap did not activate on touch device');
await tctx.close();

await browser.close();

log('\n==================== RESULT ====================');
if (problems.length === 0) log('All checks passed. No console errors, no failed requests.');
else { log(`${problems.length} problem(s):`); problems.forEach((p) => log('  - ' + p)); }
process.exit(problems.length ? 1 : 0);
