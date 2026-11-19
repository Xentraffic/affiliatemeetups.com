'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const {
  tunnelOriginList,
  originAllowed,
  ownerCookieOptions,
  adminCookieOptions,
} = require('../lib/origin');
const { validateRuntime } = require('../lib/config');
const { startApp, call, capturedCodes } = require('./helpers');

const PRIMARY = 'https://affiliatemeetups.com';
const TUNNEL = 'http://127.0.0.1:8080';
const LOCALHOST = 'http://localhost:8080';
const ALLOW = TUNNEL + ',' + LOCALHOST;

function productionEnv(extra = {}) {
  return {
    NODE_ENV: 'production',
    COMMUNITY_ADMIN_TOKEN: 'a'.repeat(32),
    COMMUNITY_RATE_SECRET: 'b'.repeat(32),
    COMMUNITY_ADMIN_TOTP_SECRET: 'JBSWY3DPEHPK3PXP',
    COMMUNITY_ORIGIN: PRIMARY,
    COMMUNITY_MAIL_MODE: 'smtp',
    COMMUNITY_SMTP_HOST: 'smtp.example.invalid',
    COMMUNITY_SMTP_USER: 'example',
    COMMUNITY_SMTP_PASSWORD: 'example',
    COMMUNITY_MAIL_FROM: 'test@example.invalid',
    ...extra,
  };
}

function fakeReq(origin, hostname) {
  return { hostname, get: (name) => (name === 'origin' ? origin : undefined) };
}

test('tunnel origins are loopback-only and fail closed', () => {
  assert.deepEqual(tunnelOriginList({}).origins, []);
  assert.deepEqual(tunnelOriginList({ COMMUNITY_TUNNEL_ORIGINS: '  ' }).origins, []);
  assert.deepEqual(tunnelOriginList({ COMMUNITY_TUNNEL_ORIGINS: ALLOW }).origins, [TUNNEL, LOCALHOST]);
  assert.deepEqual(
    tunnelOriginList({ COMMUNITY_TUNNEL_ORIGINS: 'http://[::1]:8080' }).origins,
    ['http://[::1]:8080'],
  );
  for (const bad of [
    'https://evil.example',
    'http://127.0.0.1',
    'http://127.0.0.1:8080/staging',
    'http://user:pass@127.0.0.1:8080',
    'http://127.0.0.1:8080/',
    ALLOW + ',https://evil.example',
  ]) {
    const parsed = tunnelOriginList({ COMMUNITY_TUNNEL_ORIGINS: bad });
    assert.equal(parsed.origins.length, 0, bad);
    assert.ok(parsed.errors.length, bad);
    assert.equal(originAllowed(TUNNEL, { COMMUNITY_ORIGIN: PRIMARY, COMMUNITY_TUNNEL_ORIGINS: bad }), false);
  }
  assert.equal(originAllowed(PRIMARY, { COMMUNITY_ORIGIN: PRIMARY }), true);
  assert.equal(originAllowed(TUNNEL, { COMMUNITY_ORIGIN: PRIMARY }), false);
  assert.equal(originAllowed(TUNNEL, { COMMUNITY_ORIGIN: PRIMARY, COMMUNITY_TUNNEL_ORIGINS: ALLOW }), true);
  assert.equal(originAllowed('http://127.0.0.1:9999', { COMMUNITY_ORIGIN: PRIMARY, COMMUNITY_TUNNEL_ORIGINS: ALLOW }), false);
  assert.equal(originAllowed('https://evil.example', { COMMUNITY_ORIGIN: PRIMARY, COMMUNITY_TUNNEL_ORIGINS: ALLOW }), false);
  assert.equal(originAllowed('null', { COMMUNITY_ORIGIN: PRIMARY, COMMUNITY_TUNNEL_ORIGINS: ALLOW }), false);
});

test('production startup accepts the staging tunnel list and rejects a public one', () => {
  assert.doesNotThrow(() => validateRuntime(productionEnv()));
  assert.doesNotThrow(() => validateRuntime(productionEnv({ COMMUNITY_TUNNEL_ORIGINS: '' })));
  assert.doesNotThrow(() => validateRuntime(productionEnv({ COMMUNITY_TUNNEL_ORIGINS: ALLOW })));
  assert.throws(
    () => validateRuntime(productionEnv({ COMMUNITY_TUNNEL_ORIGINS: 'https://evil.example' })),
    /COMMUNITY_TUNNEL_ORIGINS/,
  );
  assert.throws(
    () => validateRuntime(productionEnv({ COMMUNITY_TUNNEL_ORIGINS: ALLOW + ',https://evil.example' })),
    /COMMUNITY_TUNNEL_ORIGINS/,
  );
});

test('cookies are Secure on the public origin and not Secure on an allowlisted HTTP loopback', () => {
  const env = { NODE_ENV: 'production', COMMUNITY_ORIGIN: PRIMARY, COMMUNITY_TUNNEL_ORIGINS: ALLOW };
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const pub = ownerCookieOptions(fakeReq(PRIMARY, 'affiliatemeetups.com'), env);
    assert.equal(pub.secure, true);
    assert.equal(pub.httpOnly, true);
    assert.equal(pub.sameSite, 'lax');
    const tunnel = ownerCookieOptions(fakeReq(TUNNEL, '127.0.0.1'), env);
    assert.equal(tunnel.secure, false);
    assert.equal(tunnel.sameSite, 'lax');
    const local = ownerCookieOptions(fakeReq(LOCALHOST, 'localhost'), env);
    assert.equal(local.secure, false);
    const downgrade = ownerCookieOptions(fakeReq(TUNNEL, 'affiliatemeetups.com'), env);
    assert.equal(downgrade.secure, true, 'public host keeps Secure even if Origin is the tunnel');
    const unlisted = ownerCookieOptions(fakeReq('http://127.0.0.1:9999', '127.0.0.1'), env);
    assert.equal(unlisted.secure, true);
    const adminPublic = adminCookieOptions(fakeReq(PRIMARY, 'affiliatemeetups.com'), env);
    assert.equal(adminPublic.secure, true);
    assert.equal(adminPublic.sameSite, 'strict');
    const adminTunnel = adminCookieOptions(fakeReq(TUNNEL, '127.0.0.1'), env);
    assert.equal(adminTunnel.secure, false);
    assert.equal(adminTunnel.sameSite, 'strict');
  } finally {
    process.env.NODE_ENV = previous;
  }
});

function sessionCookie(setCookie) {
  const line = (setCookie || []).find((item) => item.startsWith('amu_owner_session='));
  assert.ok(line, 'missing owner session cookie');
  return { line, header: 'amu_owner_session=' + /amu_owner_session=([^;]+)/.exec(line)[1] };
}

async function rawPost(base, pathname, { origin, host, cookie, json }) {
  const target = new URL(base);
  const body = JSON.stringify(json || {});
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...(origin ? { Origin: origin } : {}),
          ...(host ? { Host: host } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try { parsed = JSON.parse(text); } catch { /* non-JSON */ }
          resolve({
            status: res.statusCode,
            body: parsed,
            setCookie: res.headers['set-cookie'] || [],
          });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function ownerLogin(base, email, origin) {
  const start = await call(base, 'POST', '/api/community/owners/login/start', {
    body: { email },
    headers: { Origin: origin },
  });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  const code = capturedCodes().filter((item) => item.email === email).pop().code;
  const done = await call(base, 'POST', '/api/community/owners/login/complete', {
    body: { email, code },
    headers: { Origin: origin },
  });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  return done;
}

describe('staging tunnel origin on the HTTP API', { concurrency: 1 }, () => {
  let ctx;
  const previous = {};
  before(async () => {
    previous.COMMUNITY_ORIGIN = process.env.COMMUNITY_ORIGIN;
    previous.COMMUNITY_TUNNEL_ORIGINS = process.env.COMMUNITY_TUNNEL_ORIGINS;
    process.env.COMMUNITY_ORIGIN = PRIMARY;
    process.env.COMMUNITY_TUNNEL_ORIGINS = ALLOW;
    ctx = await startApp();
    await call(ctx.base, 'POST', '/api/community/agents', {
      body: { handle: 'tunnel-bot', display_name: 'Tunnel Bot', owner_email: 'tunnel-owner@example.com' },
    });
  });
  after(async () => {
    if (previous.COMMUNITY_ORIGIN === undefined) delete process.env.COMMUNITY_ORIGIN;
    else process.env.COMMUNITY_ORIGIN = previous.COMMUNITY_ORIGIN;
    if (previous.COMMUNITY_TUNNEL_ORIGINS === undefined) delete process.env.COMMUNITY_TUNNEL_ORIGINS;
    else process.env.COMMUNITY_TUNNEL_ORIGINS = previous.COMMUNITY_TUNNEL_ORIGINS;
    if (ctx) await ctx.close();
  });

  test('allows the configured origin and the tunnel, and rejects everything else', async () => {
    const email = 'tunnel-owner@example.com';
    for (const origin of [PRIMARY, TUNNEL, LOCALHOST]) {
      const res = await call(ctx.base, 'POST', '/api/community/owners/login/start', {
        body: { email },
        headers: { Origin: origin },
      });
      assert.equal(res.status, 200, origin);
      assert.equal(res.body.error, undefined);
    }
    for (const origin of ['https://evil.example', 'http://127.0.0.1:9999', 'null']) {
      const res = await call(ctx.base, 'POST', '/api/community/owners/login/start', {
        body: { email },
        headers: { Origin: origin },
      });
      assert.equal(res.status, 403, origin);
      assert.equal(res.body.error, 'origin_not_allowed');
    }
  });

  test('a bearer client with no Origin still works, and an evil Origin does not', async () => {
    const { provisionClaimedAgent, ADMIN_AUTH } = require('./helpers');
    const agent = await provisionClaimedAgent(ctx.base, {
      handle: 'tunnel-writer',
      display_name: 'Tunnel Writer',
      owner_email: 'tunnel-writer@example.com',
    });
    await call(ctx.base, 'POST', `/api/community/admin/agents/${agent.agent_id}/verification/grant`, {
      auth: ADMIN_AUTH,
    });
    const open = await call(ctx.base, 'POST', '/api/community/rooms/amu/posts', {
      auth: agent.agentAuth,
      body: { body: 'Bearer client, no Origin header.' },
    });
    assert.equal(open.status, 201);
    const evil = await call(ctx.base, 'POST', '/api/community/rooms/amu/posts', {
      auth: agent.agentAuth,
      headers: { Origin: 'https://evil.example' },
      body: { body: 'Bearer client, hostile Origin.' },
    });
    assert.equal(evil.status, 403);
    assert.equal(evil.body.error, 'origin_not_allowed');
  });

  test('an unset or malformed allowlist does not admit the tunnel', async () => {
    const email = 'tunnel-owner@example.com';
    delete process.env.COMMUNITY_TUNNEL_ORIGINS;
    try {
      const unset = await call(ctx.base, 'POST', '/api/community/owners/login/start', {
        body: { email },
        headers: { Origin: TUNNEL },
      });
      assert.equal(unset.status, 403);
      assert.equal(unset.body.error, 'origin_not_allowed');
      process.env.COMMUNITY_TUNNEL_ORIGINS = ALLOW + ',https://evil.example';
      const malformed = await call(ctx.base, 'POST', '/api/community/owners/login/start', {
        body: { email },
        headers: { Origin: TUNNEL },
      });
      assert.equal(malformed.status, 403);
      assert.equal(malformed.body.error, 'origin_not_allowed');
      const primary = await call(ctx.base, 'POST', '/api/community/owners/login/start', {
        body: { email },
        headers: { Origin: PRIMARY },
      });
      assert.equal(primary.status, 200);
    } finally {
      process.env.COMMUNITY_TUNNEL_ORIGINS = ALLOW;
    }
  });

  test('HTTP tunnel cookies omit Secure, HTTPS cookies keep it, and CSRF still requires Origin', async () => {
    const email = 'tunnel-owner@example.com';
    const tunnelLogin = await ownerLogin(ctx.base, email, TUNNEL);
    const tunnelCookie = sessionCookie(tunnelLogin.setCookie);
    assert.match(tunnelCookie.line, /HttpOnly/i);
    assert.match(tunnelCookie.line, /SameSite=Lax/i);
    assert.doesNotMatch(tunnelCookie.line, /Secure/i);

    const httpsLogin = await ownerLogin(ctx.base, email, PRIMARY);
    const httpsCookie = sessionCookie(httpsLogin.setCookie);
    assert.match(httpsCookie.line, /Secure/i);
    assert.match(httpsCookie.line, /SameSite=Lax/i);

    const spoofed = await rawPost(ctx.base, '/api/community/owners/login/start', {
      origin: TUNNEL,
      host: 'affiliatemeetups.com',
      json: { email },
    });
    assert.equal(spoofed.status, 200);
    const spoofCode = capturedCodes().filter((item) => item.email === email).pop().code;
    const spoofedDone = await rawPost(ctx.base, '/api/community/owners/login/complete', {
      origin: TUNNEL,
      host: 'affiliatemeetups.com',
      json: { email, code: spoofCode },
    });
    assert.equal(spoofedDone.status, 200);
    const spoofCookie = sessionCookie(spoofedDone.setCookie);
    assert.match(spoofCookie.line, /Secure/i, 'public Host must not receive a non-Secure cookie');

    const saved = await call(ctx.base, 'PATCH', '/api/community/console/profile', {
      cookie: tunnelCookie.header,
      headers: { Origin: TUNNEL },
      body: { company_name: 'Tunnel Operator', accept_terms: true },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));

    const missing = await call(ctx.base, 'PATCH', '/api/community/console/profile', {
      cookie: tunnelCookie.header,
      body: { company_name: 'Tunnel Operator', accept_terms: true },
    });
    assert.equal(missing.status, 403);
    assert.equal(missing.body.error, 'origin_not_allowed');

    const evil = await call(ctx.base, 'PATCH', '/api/community/console/profile', {
      cookie: tunnelCookie.header,
      headers: { Origin: 'https://evil.example' },
      body: { company_name: 'Tunnel Operator', accept_terms: true },
    });
    assert.equal(evil.status, 403);
    assert.equal(evil.body.error, 'origin_not_allowed');

    const session = await call(ctx.base, 'GET', '/api/community/session', { cookie: tunnelCookie.header });
    assert.equal(session.status, 200);
    assert.equal(session.body.viewer.kind, 'owner');
    assert.equal(session.body.viewer.email, email);

    const logout = await call(ctx.base, 'POST', '/api/community/owners/logout', {
      cookie: tunnelCookie.header,
      headers: { Origin: TUNNEL },
    });
    assert.equal(logout.status, 200);
    const cleared = (logout.setCookie || []).find((item) => item.startsWith('amu_owner_session='));
    assert.ok(cleared);
    assert.doesNotMatch(cleared, /Secure/i);
    const after = await call(ctx.base, 'GET', '/api/community/session', { cookie: tunnelCookie.header });
    assert.equal(after.body.viewer.kind, 'public');
  });
});

describe('tunnel login under /staging', { concurrency: 1 }, () => {
  let ctx;
  const previous = {};
  before(async () => {
    previous.COMMUNITY_ORIGIN = process.env.COMMUNITY_ORIGIN;
    previous.COMMUNITY_TUNNEL_ORIGINS = process.env.COMMUNITY_TUNNEL_ORIGINS;
    previous.COMMUNITY_BASE_PATH = process.env.COMMUNITY_BASE_PATH;
    process.env.COMMUNITY_ORIGIN = PRIMARY;
    process.env.COMMUNITY_TUNNEL_ORIGINS = ALLOW;
    process.env.COMMUNITY_BASE_PATH = '/staging';
    ctx = await startApp();
  });
  after(async () => {
    if (previous.COMMUNITY_ORIGIN === undefined) delete process.env.COMMUNITY_ORIGIN;
    else process.env.COMMUNITY_ORIGIN = previous.COMMUNITY_ORIGIN;
    if (previous.COMMUNITY_TUNNEL_ORIGINS === undefined) delete process.env.COMMUNITY_TUNNEL_ORIGINS;
    else process.env.COMMUNITY_TUNNEL_ORIGINS = previous.COMMUNITY_TUNNEL_ORIGINS;
    if (previous.COMMUNITY_BASE_PATH === undefined) delete process.env.COMMUNITY_BASE_PATH;
    else process.env.COMMUNITY_BASE_PATH = previous.COMMUNITY_BASE_PATH;
    if (ctx) await ctx.close();
  });

  test('owner login is prefix-safe and the unprefixed API stays closed', async () => {
    const email = 'prefix-owner@example.com';
    await call(ctx.base, 'POST', '/staging/api/community/agents', {
      body: { handle: 'prefix-bot', display_name: 'Prefix Bot', owner_email: email },
    });
    const start = await call(ctx.base, 'POST', '/staging/api/community/owners/login/start', {
      body: { email },
      headers: { Origin: TUNNEL },
    });
    assert.equal(start.status, 200, JSON.stringify(start.body));
    const code = capturedCodes().filter((item) => item.email === email).pop().code;
    const done = await call(ctx.base, 'POST', '/staging/api/community/owners/login/complete', {
      body: { email, code },
      headers: { Origin: TUNNEL },
    });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const cookie = sessionCookie(done.setCookie);
    assert.doesNotMatch(cookie.line, /Secure/i);
    const session = await call(ctx.base, 'GET', '/staging/api/community/session', { cookie: cookie.header });
    assert.equal(session.body.viewer.kind, 'owner');
    const bare = await call(ctx.base, 'POST', '/api/community/owners/login/start', {
      body: { email },
      headers: { Origin: TUNNEL },
    });
    assert.equal(bare.status, 404);
    const page = await fetch(ctx.base + '/staging/community?view=console');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Owner console/);
  });
});
