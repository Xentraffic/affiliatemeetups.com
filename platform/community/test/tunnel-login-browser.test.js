'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('node:os');
const http = require('node:http');
const path = require('node:path');
const { startApp, call, capturedCodes } = require('./helpers');

const PRIMARY = 'https://affiliatemeetups.com';
let chromium = null;
try {
  ({ chromium } = require('playwright-core'));
} catch {
  chromium = null;
}

/**
 * Find a Chrome to drive.
 *
 * The playwright-core in this repository asks for one exact browser revision
 * and refuses anything else, so on a host that has a different revision cached
 * this suite skipped silently and the tunnel guarantees below went unchecked
 * for as long as that was true. Look in the Playwright cache as well, newest
 * revision first, so "no browser" means no browser rather than no match.
 */
function chromePath() {
  const cached = [];
  const root = path.join(os.homedir(), '.cache', 'ms-playwright');
  try {
    for (const entry of fs.readdirSync(root)) {
      if (!/^chromium(_headless_shell)?-\d+$/.test(entry)) continue;
      for (const layout of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-linux/headless_shell']) {
        const candidate = path.join(root, entry, layout);
        if (fs.existsSync(candidate)) cached.push([Number(entry.split('-').pop()), candidate]);
      }
    }
  } catch { /* no Playwright cache on this host */ }
  cached.sort((a, b) => b[0] - a[0]);
  const candidates = [
    process.env.COMMUNITY_CHROME,
    '/usr/local/bin/google-chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    ...cached.map(([, candidate]) => candidate),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

const chrome = chromePath();
const skipBrowser = !chromium || !chrome
  ? 'playwright-core or a local Chrome binary is not available'
  : false;

async function register(base, handle, email) {
  const res = await call(base, 'POST', '/staging/api/community/agents', {
    body: { handle, display_name: 'Tunnel Browser', owner_email: email },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
}

describe('browser owner login through a loopback origin', { concurrency: 1 }, () => {
  let ctx;
  let browser;
  const previous = {};

  before(async () => {
    if (skipBrowser) return;
    previous.COMMUNITY_ORIGIN = process.env.COMMUNITY_ORIGIN;
    previous.COMMUNITY_TUNNEL_ORIGINS = process.env.COMMUNITY_TUNNEL_ORIGINS;
    previous.COMMUNITY_BASE_PATH = process.env.COMMUNITY_BASE_PATH;
    process.env.COMMUNITY_ORIGIN = PRIMARY;
    delete process.env.COMMUNITY_TUNNEL_ORIGINS;
    process.env.COMMUNITY_BASE_PATH = '/staging';
    ctx = await startApp();
    browser = await chromium.launch({
      executablePath: chrome,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
  });

  after(async () => {
    if (browser) await browser.close();
    if (previous.COMMUNITY_ORIGIN === undefined) delete process.env.COMMUNITY_ORIGIN;
    else process.env.COMMUNITY_ORIGIN = previous.COMMUNITY_ORIGIN;
    if (previous.COMMUNITY_TUNNEL_ORIGINS === undefined) delete process.env.COMMUNITY_TUNNEL_ORIGINS;
    else process.env.COMMUNITY_TUNNEL_ORIGINS = previous.COMMUNITY_TUNNEL_ORIGINS;
    if (previous.COMMUNITY_BASE_PATH === undefined) delete process.env.COMMUNITY_BASE_PATH;
    else process.env.COMMUNITY_BASE_PATH = previous.COMMUNITY_BASE_PATH;
    if (ctx) await ctx.close();
  });

  test('the tunnel origin is rejected until it is allowlisted', { skip: skipBrowser, timeout: 60000 }, async () => {
    const email = 'browser-rejected@example.com';
    await register(ctx.base, 'browser-rejected', email);
    const page = await browser.newPage();
    try {
      await page.goto(ctx.base + '/staging/community?view=console', { waitUntil: 'domcontentloaded' });
      await page.locator('#login-start input[name=email]').fill(email);
      const response = page.waitForResponse(
        (res) => res.url().includes('/owners/login/start') && res.request().method() === 'POST',
      );
      await page.locator('#login-start button').click();
      const start = await response;
      // Login start has no cookie. A missing Origin would be allowed, so 403
      // means the browser sent an Origin other than COMMUNITY_ORIGIN. Chrome
      // does not surface that header to Playwright.
      assert.equal(start.status(), 403);
      await page.locator('#notice').waitFor({ state: 'visible' });
      assert.match(await page.locator('#notice').innerText(), /origin_not_allowed/);
      const cookies = await page.context().cookies();
      assert.equal(cookies.some((item) => item.name === 'amu_owner_session'), false);
    } finally {
      await page.close();
    }
  });

  test('login, code entry, owner console, and logout work on the tunnel origin', { skip: skipBrowser, timeout: 60000 }, async () => {
    const email = 'browser-owner@example.com';
    await register(ctx.base, 'browser-owner', email);
    process.env.COMMUNITY_TUNNEL_ORIGINS = ctx.base + ',http://localhost:' + new URL(ctx.base).port;
    const page = await browser.newPage();
    try {
      await page.goto(ctx.base + '/staging/community?view=console', { waitUntil: 'domcontentloaded' });
      await page.locator('#login-start input[name=email]').fill(email);
      const started = page.waitForResponse(
        (res) => res.url().includes('/owners/login/start') && res.request().method() === 'POST',
      );
      await page.locator('#login-start button').click();
      const start = await started;
      assert.equal(start.status(), 200);
      const code = capturedCodes().filter((item) => item.email === email).pop().code;
      assert.match(code, /^\d{6}$/);
      await page.locator('#login-complete').waitFor({ state: 'visible' });
      await page.locator('#login-complete input[name=code]').fill(code);
      const completed = page.waitForResponse(
        (res) => res.url().includes('/owners/login/complete') && res.request().method() === 'POST',
      );
      await page.locator('#login-complete button').click();
      const done = await completed;
      assert.equal(done.status(), 200);
      await page.locator('h1', { hasText: 'Your agents' }).waitFor();
      assert.match(await page.locator('main').innerText(), new RegExp(email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(await page.locator('main').innerText(), /read-only in the community/i);
      assert.match(await page.locator('main').innerText(), /@browser-owner/);

      const cookies = await page.context().cookies();
      const session = cookies.find((item) => item.name === 'amu_owner_session');
      assert.ok(session, 'browser did not store the owner session');
      assert.equal(session.httpOnly, true);
      assert.equal(session.secure, false);
      assert.equal(String(session.sameSite).toLowerCase(), 'lax');

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('h1', { hasText: 'Your agents' }).waitFor();

      await page.locator('#logout').click();
      await page.locator('#login-start').waitFor();
      const after = await page.context().cookies();
      const leftover = after.find((item) => item.name === 'amu_owner_session' && item.value);
      assert.equal(leftover, undefined);
    } finally {
      await page.close();
    }
  });

  /**
   * Allowlisting the tunnel must not open the door to anyone else.
   *
   * The Origin here is a real browser Origin, not a spoofed header: the page
   * is served from a second loopback port that is NOT in
   * COMMUNITY_TUNNEL_ORIGINS, so Chrome stamps that port on the request.
   *
   * The assertion is on the outcome rather than on one status code, because
   * the browser may refuse at the preflight and never send the POST at all.
   * Either way the only acceptable result is the same: no sign-in starts.
   */
  test('a foreign browser origin stays refused while the tunnel is allowlisted', { skip: skipBrowser, timeout: 60000 }, async () => {
    assert.ok(
      process.env.COMMUNITY_TUNNEL_ORIGINS && process.env.COMMUNITY_TUNNEL_ORIGINS.includes(new URL(ctx.base).port),
      'this case is only meaningful while the tunnel origin is allowlisted',
    );
    const email = 'foreign-origin@example.com';
    const target = ctx.base + '/staging/api/community/owners/login/start';
    const foreign = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>foreign</title><body>foreign origin</body>');
    });
    await new Promise((resolve) => foreign.listen(0, '127.0.0.1', resolve));
    const foreignBase = 'http://127.0.0.1:' + foreign.address().port;
    assert.notEqual(foreignBase, ctx.base);
    const page = await browser.newPage();
    const seen = [];
    page.on('response', (res) => {
      if (res.url().startsWith(ctx.base)) seen.push({ method: res.request().method(), status: res.status() });
    });
    try {
      await page.goto(foreignBase + '/', { waitUntil: 'domcontentloaded' });
      const outcome = await page.evaluate(async (url) => {
        try {
          const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'foreign-origin@example.com' }),
          });
          return { reached: true, status: r.status };
        } catch (e) {
          return { reached: false, error: String(e && e.message) };
        }
      }, target);
      await page.waitForTimeout(500);

      // However the browser refused - at the preflight or on the reply - the
      // page must not have been handed a usable sign-in.
      assert.notEqual(outcome.status, 200, 'the foreign origin must not read a successful sign-in start');
      const approved = seen.filter((r) => r.status >= 200 && r.status < 300);
      assert.deepEqual(approved, [], 'no request from the foreign origin may be answered 2xx: ' + JSON.stringify(seen));
      const cookies = await page.context().cookies();
      assert.equal(cookies.some((item) => item.name === 'amu_owner_session'), false);
      assert.equal(capturedCodes().filter((item) => item.email === email).length, 0, 'no sign-in code may be minted');

      // The check above is satisfied by the CORS allowlist alone, which would
      // still hold if the origin check were removed. Send a request the
      // browser does NOT preflight - a text/plain POST is a CORS "simple"
      // request - so it genuinely reaches the handler carrying the foreign
      // Origin, and the 403 can only come from the origin check itself.
      const simple = page.waitForResponse(
        (res) => res.url() === target && res.request().method() === 'POST',
      );
      await page.evaluate(async (url) => {
        try {
          await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: JSON.stringify({ email: 'foreign-origin@example.com' }),
            mode: 'no-cors',
          });
        } catch { /* the reply is opaque; the status is read off the network */ }
      }, target);
      const direct = await simple;
      assert.equal(direct.status(), 403, 'the origin check itself must refuse a foreign Origin');
      assert.equal(capturedCodes().filter((item) => item.email === email).length, 0, 'still no sign-in code');
    } finally {
      await page.close();
      await new Promise((resolve) => foreign.close(resolve));
    }
  });
});
