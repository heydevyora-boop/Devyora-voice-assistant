import { loadPlaywright, BASE, shotsDir } from './lib.mjs';
const { chromium } = await loadPlaywright();

const OUT = shotsDir(process.argv);
const problems = [];
const log = (...a) => console.log(...a);
const ok = (cond, msg) => { if (!cond) problems.push(msg); return cond; };

// Fake audio device so getUserMedia succeeds and the AnalyserNode sees real samples.
const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});

async function makePage(ctx) {
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`[console.${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', (r) => {
    const u = r.url();
    if (u.startsWith(BASE)) problems.push(`[requestfailed] ${u} ${r.failure()?.errorText}`);
  });
  return page;
}

const st = (p) => p.getAttribute('.orb-stage', 'data-state');
const settle = (p, ms = 400) => p.waitForTimeout(ms);

/* ============ 1. Microphone granted: real levels drive the waveform ============ */
log('-- microphone capture --');
const ctxMic = await browser.newContext({ viewport: { width: 420, height: 900 }, permissions: ['microphone'] });
const page = await makePage(ctxMic);
await page.addInitScript(() => {
  const real = window.open.bind(window);
  window.__opened = [];
  window.open = (url, ...rest) => {
    window.__opened.push(String(url));
    return real(url, ...rest);
  };
});
await page.goto(BASE + '/#/', { waitUntil: 'networkidle' });
await settle(page);

await page.click('.orb-core', { force: true });
await settle(page, 1200);
const stateAfterActivate = await st(page);
log(`  activate -> ${stateAfterActivate}`);

const waveLive = await page.getAttribute('.orb-waveform', 'data-live').catch(() => null);
const micActive = await page.evaluate(() => window.__voice?.getState().micActive ?? null);
log(`  mic active: ${micActive} · waveform data-live: ${waveLive}`);
ok(micActive === true, 'microphone did not open with permission granted');
ok(waveLive === 'true', 'waveform not marked as driven by live audio');

// Levels must actually vary, not be a constant. They travel on the audio
// bus rather than through React state, so they are sampled from there.
const sampled = await page.evaluate(async () => {
  const seen = [];
  for (let i = 0; i < 12; i += 1) {
    seen.push(window.__levels.current()?.[4] ?? null);
    await new Promise((r) => setTimeout(r, 70));
  }
  return seen;
});
const distinct = new Set(sampled.filter((v) => v !== null)).size;
log(`  distinct level samples from fake device: ${distinct}/${sampled.length}`);
ok(distinct > 1, 'microphone levels never changed — meter is not reading audio');

await page.keyboard.press('Escape');
await settle(page, 500);
log(`  Escape -> ${await st(page)}`);
ok((await st(page)) === 'idle', 'Escape did not cancel listening');
const levelsAfter = await page.evaluate(() => window.__levels.current());
ok(levelsAfter === null, 'levels not cleared after cancel (stream may still be open)');

/* ============ 2. Typed command: local action runs end to end ============ */
log('\n-- typed command: note (no confirmation) --');
await page.click('button:has-text("Type instead")');
await page.fill('input[aria-label="Type a command"]', 'save a note buy oat milk');
await page.press('input[aria-label="Type a command"]', 'Enter');
await settle(page, 900);
log(`  state -> ${await st(page)} · heading "${await page.textContent('h1')}"`);
ok((await st(page)) === 'success', 'local note action did not reach success');
const noteStored = await page.evaluate(() => JSON.parse(localStorage.getItem('devyora.notes') || '[]'));
log(`  stored notes: ${noteStored.length} · last: "${noteStored.at(-1)?.text}"`);
ok(noteStored.at(-1)?.text === 'buy oat milk', 'note was not actually written to storage');
await settle(page, 2600);
ok((await st(page)) === 'idle', 'success did not auto-dismiss');

/* ============ 3. WhatsApp: clarification -> confirmation -> handoff ============ */
log('\n-- WhatsApp: clarify, confirm, hand off --');
await page.evaluate(() => window.__voice.getState().resetTurn());
await page.click('button:has-text("Type instead")');
await page.fill('input[aria-label="Type a command"]', 'send a WhatsApp message to Rahul saying I will reach in 10 minutes');
await page.press('input[aria-label="Type a command"]', 'Enter');
await settle(page, 900);

log(`  state -> ${await st(page)}`);
ok((await st(page)) === 'confirmation', 'ambiguous recipient did not pause for confirmation');
const clarQ = await page.textContent('text=/Who is/').catch(() => null);
log(`  clarification: "${clarQ}"`);
ok(Boolean(clarQ), 'no clarification shown for an unresolved contact');
await page.screenshot({ path: `${OUT}/v-clarification.png` });

await page.click('button:has-text("Use “Rahul”")');
await settle(page, 600);
log(`  after answering -> ${await st(page)}`);

const cardText = await page.textContent('[role="group"]');
for (const needle of ['WhatsApp', 'Rahul', 'I will reach in 10 minutes', 'Cancel', 'Edit', 'Open WhatsApp']) {
  ok(cardText.includes(needle), `confirmation card missing "${needle}"`);
}
log(`  card shows app / recipient / message / Edit / Cancel / primary: yes`);
await page.screenshot({ path: `${OUT}/v-confirmation.png` });

// Edit mode must expose the message for change.
await page.click('button:has-text("Edit")');
await settle(page, 200);
const editable = await page.locator('textarea[aria-label="Message"]').count();
log(`  edit mode exposes the message field: ${editable === 1}`);
ok(editable === 1, 'Edit did not expose the message for editing');
await page.click('button:has-text("Done")');
await settle(page, 200);

// Approve -> executor opens WhatsApp -> handoff, NOT success.
const popupPromise = page.waitForEvent('popup', { timeout: 5000 }).catch(() => null);
await page.click('button:has-text("Open WhatsApp")');
const popup = await popupPromise;
await settle(page, 900);
log(`  popup opened: ${popup ? popup.url().slice(0, 48) + '…' : 'none'}`);
ok(Boolean(popup), 'WhatsApp draft window was not opened');
const requested = await page.evaluate(() => window.__opened.at(-1));
log(`  requested URL: ${requested?.slice(0, 64)}…`);
ok(requested?.startsWith('https://wa.me/?text='), 'handoff did not target a WhatsApp draft URL');
ok(decodeURIComponent(requested ?? '').includes('I will reach in 10 minutes'),
   'the draft URL does not carry the message text');
await popup?.close();

const afterApprove = await st(page);
const outcomeStatus = await page.evaluate(() => window.__voice.getState().outcome?.status);
log(`  orb -> ${afterApprove} · outcome status -> ${outcomeStatus}`);
ok(outcomeStatus === 'handoff', 'an unsendable message was not reported as a handoff');
ok(afterApprove !== 'success', 'a message that was never sent was reported as success');
const noticeText = await page.textContent('text=/Handed over/').catch(() => null);
ok(Boolean(noticeText), 'no handoff notice shown');
const detail = await page.textContent('body');
ok(/cannot send it for you/i.test(detail), 'handoff notice does not state the message was not sent');
log(`  notice states the message was not sent: yes`);
await page.screenshot({ path: `${OUT}/v-handoff.png` });
await page.click('button[aria-label="Dismiss"]');
await settle(page, 400);

/* ============ 4. Cancel from confirmation ============ */
log('\n-- cancel from confirmation --');
await page.click('button:has-text("Type instead")');
await page.fill('input[aria-label="Type a command"]', 'send a WhatsApp message to Priya saying running late');
await page.press('input[aria-label="Type a command"]', 'Enter');
await settle(page, 700);
await page.click('button:has-text("Use “Priya”")');
await settle(page, 500);
await page.click('button:has-text("Cancel")');
await settle(page, 500);
log(`  cancel -> ${await st(page)}`);
ok((await st(page)) === 'idle', 'cancelling a confirmation did not return to idle');

/* ============ 5. Reminder + open app + unsupported ============ */
log('\n-- other command kinds --');
const runTyped = async (text) => {
  await page.evaluate(() => window.__voice.getState().resetTurn());
  const btn = page.locator('button:has-text("Type instead")');
  if (await btn.count()) await btn.click();
  await page.fill('input[aria-label="Type a command"]', text);
  await page.press('input[aria-label="Type a command"]', 'Enter');
  await settle(page, 900);
  return st(page);
};

log(`  "remind me to call mum at 6pm" -> ${await runTyped('remind me to call mum at 6pm')}`);
const reminders = await page.evaluate(() => JSON.parse(localStorage.getItem('devyora.reminders') || '[]'));
ok(reminders.length === 1 && /call mum/i.test(reminders[0].text), 'reminder was not stored');
log(`  stored reminders: ${reminders.length} · "${reminders[0]?.text}" at "${reminders[0]?.at}"`);
await settle(page, 2600);

const popup2 = page.waitForEvent('popup', { timeout: 5000 }).catch(() => null);
log(`  "open gmail" -> ${await runTyped('open gmail')}`);
const p2 = await popup2;
await p2?.close();
const openOutcome = await page.evaluate(() => window.__voice.getState().outcome?.status);
log(`  open-app outcome -> ${openOutcome} (launch cannot be verified, so not 'completed')`);
ok(openOutcome === 'handoff', 'opening an app claimed more certainty than it has');
await page.locator('button[aria-label="Dismiss"]').click().catch(() => {});
await settle(page, 300);

log(`  "what is the weather tomorrow" -> ${await runTyped('what is the weather tomorrow')}`);
ok((await st(page)) === 'error', 'an unhandled command did not surface as an error state');
const unsup = await page.textContent('text=/Not handled yet/').catch(() => null);
ok(Boolean(unsup), 'no unsupported notice for an unknown command');
log(`  unsupported notice shown: yes`);
await page.screenshot({ path: `${OUT}/v-unsupported.png` });
await page.locator('button:has-text("Dismiss")').first().click();
await settle(page, 400);

/* ============ 6. Confirmation timeout ============ */
log('\n-- confirmation timeout --');
await page.evaluate(() => window.__settings.getState().setConfirmTimeoutSeconds(2));
await runTyped('send a WhatsApp message to Sam saying hello');
await page.click('button:has-text("Use “Sam”")');
await settle(page, 400);
ok((await st(page)) === 'confirmation', 'did not reach confirmation before timeout test');
const countdown = await page.textContent('text=/Expires in/').catch(() => null);
log(`  countdown shown: ${countdown ? 'yes' : 'no'}`);
ok(Boolean(countdown), 'no timeout countdown on the confirmation card');
await settle(page, 2600);
log(`  after timeout -> ${await st(page)}`);
ok((await st(page)) === 'idle', 'confirmation timeout did not abandon the turn');
const timeoutErr = await page.evaluate(() => window.__voice.getState().error?.code);
ok(timeoutErr === 'timeout', 'timeout did not record a timeout reason');
await page.evaluate(() => window.__settings.getState().setConfirmTimeoutSeconds(90));
await page.locator('button:has-text("Dismiss")').first().click().catch(() => {});
await settle(page, 400);

/* ============ 7. Scripted source is labelled, captures no audio ============ */
log('\n-- scripted source --');
await page.evaluate(() => window.__settings.getState().setSttChoice('scripted'));
await page.goto(BASE + '/#/', { waitUntil: 'networkidle' });
await settle(page, 400);
await page.click('.orb-core', { force: true });
await settle(page, 600);
const scriptedMic = await page.evaluate(() => window.__voice.getState().micActive);
log(`  mic opened while scripted: ${scriptedMic} (must be false)`);
ok(scriptedMic === false, 'scripted source opened the microphone');
const badge = await page.textContent('text=/^test$/').catch(() => null);
log(`  transcript labelled as test: ${badge ? 'yes' : 'no'}`);
await settle(page, 2500);
log(`  scripted turn -> ${await st(page)}`);
ok(['confirmation', 'processing'].includes(await st(page)), 'scripted phrase did not drive the pipeline');
await page.screenshot({ path: `${OUT}/v-scripted.png` });
await page.evaluate(() => window.__settings.getState().setSttChoice('browser'));

/* ============ 8. Interruption and repetition ============ */
log('\n-- interruption and repetition --');
await page.goto(BASE + '/#/', { waitUntil: 'networkidle' });
await settle(page, 400);
for (let i = 0; i < 4; i += 1) {
  await page.click('.orb-core', { force: true });
  await page.waitForTimeout(420);
  await page.click('.orb-core', { force: true });
  await page.waitForTimeout(420);
}
const afterChurn = await st(page);
log(`  4 start/stop cycles -> ${afterChurn}`);
// Whatever the engine did, the orb must always be recoverable.
await page.keyboard.press('Escape');
await settle(page, 600);
const recovered = await st(page);
log(`  Escape after churn -> ${recovered}`);
ok(recovered === 'idle', `orb was not recoverable after repeated activation: ${recovered}`);
const leakedStreams = await page.evaluate(() => window.__levels.current());
ok(leakedStreams === null, 'microphone levels still flowing after the turn ended');

// Cancel mid-processing must not be overtaken by a late result.
await page.evaluate(() => window.__voice.getState().resetTurn());
await page.click('button:has-text("Type instead")');
await page.fill('input[aria-label="Type a command"]', 'save a note interrupted command');
await page.press('input[aria-label="Type a command"]', 'Enter');
await page.waitForTimeout(40);
await page.keyboard.press('Escape');
await settle(page, 900);
log(`  cancelled mid-flight -> ${await st(page)}`);
ok((await st(page)) === 'idle', 'cancelling mid-flight left the orb engaged');

/* ============ 9. Microphone denied ============ */
log('\n-- microphone denied --');
const ctxDenied = await browser.newContext({ viewport: { width: 420, height: 900 }, permissions: [] });
await ctxDenied.grantPermissions([]);
const denied = await makePage(ctxDenied);
await denied.addInitScript(() => {
  navigator.mediaDevices.getUserMedia = () =>
    Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
});
await denied.goto(BASE + '/#/', { waitUntil: 'networkidle' });
await settle(denied, 400);
await denied.click('.orb-core', { force: true });
await settle(denied, 900);
log(`  denied -> ${await st(denied)}`);
ok((await st(denied)) === 'error', 'denied microphone did not surface an error');
const deniedText = await denied.textContent('body');
ok(/Microphone blocked/i.test(deniedText), 'no clear microphone-blocked message');
ok(/Try again/i.test(deniedText), 'no retry offered after a microphone denial');
log(`  shows "Microphone blocked" + retry: yes`);
await denied.screenshot({ path: `${OUT}/v-mic-denied.png` });
await ctxDenied.close();

/* ============ 10. Responsive ============ */
log('\n-- responsive --');
for (const [name, w, h] of [['mobile', 390, 844], ['tablet', 834, 1112], ['desktop', 1440, 900]]) {
  const c = await browser.newContext({ viewport: { width: w, height: h }, permissions: ['microphone'], deviceScaleFactor: 2 });
  const p = await makePage(c);
  await p.goto(BASE + '/#/', { waitUntil: 'networkidle' });
  await settle(p, 400);
  await p.click('button:has-text("Type instead")');
  await p.fill('input[aria-label="Type a command"]', 'send a WhatsApp message to Rahul saying I will reach in 10 minutes');
  await p.press('input[aria-label="Type a command"]', 'Enter');
  await settle(p, 800);
  await p.click('button:has-text("Use “Rahul”")');
  await settle(p, 600);
  const docW = await p.evaluate(() => document.documentElement.scrollWidth);
  const overflow = docW > w + 1;
  log(`  ${name.padEnd(8)} ${w}x${h} · confirmation visible · h-scroll: ${overflow ? 'YES (BAD)' : 'no'}`);
  ok(!overflow, `${name}: horizontal overflow (${docW} > ${w})`);
  await p.screenshot({ path: `${OUT}/v-layout-${name}.png` });
  await c.close();
}

/* ============ 11. Voice setup screen ============ */
log('\n-- voice setup screen --');
const vp = await makePage(await browser.newContext({ viewport: { width: 420, height: 1100 }, deviceScaleFactor: 2 }));
await vp.goto(BASE + '/#/voice', { waitUntil: 'networkidle' });
await settle(vp, 500);
const vText = await vp.textContent('body');
for (const needle of ['Speech source', 'Scripted phrase', 'Command understanding', 'Wake word', 'Confirmation timeout']) {
  ok(vText.includes(needle), `voice screen missing "${needle}"`);
}
ok(/Nothing is listening in the background/i.test(vText),
   'voice screen does not state that nothing is listening');
log('  sections present; wake word reported as not bundled');
await vp.screenshot({ path: `${OUT}/v-voice-screen.png`, fullPage: true });
await vp.context().close();

await browser.close();

log('\n==================== RESULT ====================');
if (problems.length === 0) log('All checks passed. No console errors, no failed requests.');
else { log(`${problems.length} problem(s):`); problems.forEach((p) => log('  - ' + p)); }
process.exit(problems.length ? 1 : 0);
