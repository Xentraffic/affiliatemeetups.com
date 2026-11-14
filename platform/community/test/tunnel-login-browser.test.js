'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { startApp, call, capturedCodes } = require('./helpers');

const PRIMARY = 'https://affiliatemeetups.com';
let chromium = null;
try {
  ({ chromium } = require('playwright-core'));
} catch {
  chromium = null;
}

function chromePath() {
  const candidates = [
    process.env.COMMUNITY_CHROME,
    '/usr/local/bin/google-chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
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
      assert.match(await page.locator('main').innerText(), /Read-only community access/);
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
});
