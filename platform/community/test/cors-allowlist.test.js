'use strict';

// The CORS allowlist and the mutation origin check must name the same origins.
// They were two separate lists: api.js held a literal one that included
// http://localhost:3000 and ignored COMMUNITY_ORIGIN, while originAllowed
// derived COMMUNITY_ORIGIN plus its www sibling plus the configured tunnel
// origins. A page on localhost:3000 could therefore read credentialed GET
// responses while every write came back origin_not_allowed.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { originAllowed } = require('../lib/origin');
const { startApp } = require('./helpers');

const PUBLIC_GET = '/api/community/agents';
const SITE = 'https://affiliatemeetups.com';
const WWW = 'https://www.affiliatemeetups.com';
const DEV = 'http://localhost:3000';
const TUNNEL = 'http://127.0.0.1:8080';
const EVIL = 'https://evil.example';

async function acao(base, origin, { method = 'GET' } = {}) {
  const res = await fetch(base + PUBLIC_GET, {
    method,
    headers: origin
      ? { Origin: origin, ...(method === 'OPTIONS' ? { 'Access-Control-Request-Method': 'POST' } : {}) }
      : {},
  });
  await res.text();
  return { header: res.headers.get('access-control-allow-origin'), status: res.status };
}

test('CORS answers for exactly the origins originAllowed accepts', async () => {
  const ctx = await startApp();
  const previous = process.env.COMMUNITY_TUNNEL_ORIGINS;
  delete process.env.COMMUNITY_TUNNEL_ORIGINS;
  try {
    const site = await acao(ctx.base, SITE);
    assert.equal(site.header, SITE, 'the site origin is allowed');
    assert.equal(site.status, 200);

    const www = await acao(ctx.base, WWW);
    assert.equal(www.header, WWW, 'the www sibling is allowed');

    // The drift this test exists for.
    const dev = await acao(ctx.base, DEV);
    assert.equal(dev.header, null, 'localhost:3000 is not an allowed origin');
    assert.equal(originAllowed(DEV), false);

    const evil = await acao(ctx.base, EVIL);
    assert.equal(evil.header, null, 'an unknown origin gets no CORS header');

    const preflight = await acao(ctx.base, EVIL, { method: 'OPTIONS' });
    assert.equal(preflight.header, null, 'the preflight is not answered either');

    // Same-origin and non-browser callers send no Origin and need no header.
    const bare = await acao(ctx.base, null);
    assert.equal(bare.status, 200, 'a request without an Origin still works');
    assert.equal(bare.header, null);

    // One sweep holding the two sides together, including a tunnel origin
    // before and after it is configured.
    for (const origin of [SITE, WWW, DEV, TUNNEL, EVIL, 'http://127.0.0.1:1', 'https://affiliatemeetups.com.evil.example']) {
      const seen = await acao(ctx.base, origin);
      assert.equal(
        seen.header !== null,
        originAllowed(origin),
        'CORS and originAllowed disagree about ' + origin,
      );
    }

    process.env.COMMUNITY_TUNNEL_ORIGINS = TUNNEL;
    const tunnel = await acao(ctx.base, TUNNEL);
    assert.equal(tunnel.header, TUNNEL, 'a configured tunnel origin is allowed by CORS too');
    assert.equal(originAllowed(TUNNEL), true);
    const stillEvil = await acao(ctx.base, EVIL);
    assert.equal(stillEvil.header, null, 'configuring a tunnel origin widens nothing else');
  } finally {
    if (previous === undefined) delete process.env.COMMUNITY_TUNNEL_ORIGINS;
    else process.env.COMMUNITY_TUNNEL_ORIGINS = previous;
    await ctx.close();
  }
});

test('a write from a disallowed origin is refused and uncorsed in the same breath', async () => {
  const ctx = await startApp();
  try {
    const res = await fetch(ctx.base + '/api/community/agents', {
      method: 'POST',
      headers: { Origin: DEV, 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: 'cors-probe', display_name: 'CORS probe' }),
    });
    const body = await res.json().catch(() => ({}));
    assert.equal(res.status, 403);
    assert.equal(body.error, 'origin_not_allowed');
    assert.equal(
      res.headers.get('access-control-allow-origin'),
      null,
      'the browser must not be told it may read this response either',
    );
  } finally {
    await ctx.close();
  }
});
