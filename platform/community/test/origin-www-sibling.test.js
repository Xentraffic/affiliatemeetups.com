'use strict';

// The reported production failure: affiliatemeetups.com and
// www.affiliatemeetups.com both answer, with no redirect between them, so a
// visitor who landed on www sent Origin: https://www.affiliatemeetups.com and
// every signup POST came back 403 origin_not_allowed. The pair is now derived
// from COMMUNITY_ORIGIN; nothing else may be added to it.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, call } = require('./helpers');
const { siteOrigins, allowedOriginSet, originAllowed } = require('../lib/origin');

const APEX = 'https://affiliatemeetups.com';
const WWW = 'https://www.affiliatemeetups.com';

describe('the configured origin and its www sibling, and nothing else', () => {
  test('the pair is derived in both directions', () => {
    assert.deepEqual(siteOrigins({ COMMUNITY_ORIGIN: APEX }), [APEX, WWW]);
    assert.deepEqual(siteOrigins({ COMMUNITY_ORIGIN: WWW }), [WWW, APEX]);
  });

  test('scheme and port travel with the sibling', () => {
    assert.deepEqual(siteOrigins({ COMMUNITY_ORIGIN: 'https://affiliatemeetups.com:8443' }), [
      'https://affiliatemeetups.com:8443',
      'https://www.affiliatemeetups.com:8443',
    ]);
    assert.deepEqual(siteOrigins({ COMMUNITY_ORIGIN: 'http://affiliatemeetups.com' }), [
      'http://affiliatemeetups.com',
      'http://www.affiliatemeetups.com',
    ]);
  });

  test('a loopback, a bare host or an unparseable value gains no sibling', () => {
    for (const value of [
      'http://127.0.0.1:4861',
      'http://localhost:8080',
      'https://localhost',
      'not a url',
      'https://affiliatemeetups.com/community',
    ]) {
      assert.deepEqual(siteOrigins({ COMMUNITY_ORIGIN: value }), [value], value);
    }
  });

  test('the allowlist never reaches a third host', () => {
    const allowed = allowedOriginSet({ COMMUNITY_ORIGIN: APEX });
    assert.equal(allowed.size, 2);
    for (const hostile of [
      'https://affiliatemeetups.com.evil.example',
      'https://wwwaffiliatemeetups.com',
      'https://www.www.affiliatemeetups.com',
      'https://evil.example',
      'http://affiliatemeetups.com',
      'https://affiliatemeetups.com:8443',
      'https://blog.affiliatemeetups.com',
    ]) {
      assert.equal(originAllowed(hostile, { COMMUNITY_ORIGIN: APEX }), false, hostile);
    }
  });

  test('a broken tunnel list still falls back to the site pair only', () => {
    const env = { COMMUNITY_ORIGIN: APEX, COMMUNITY_TUNNEL_ORIGINS: 'https://evil.example' };
    assert.deepEqual([...allowedOriginSet(env)].sort(), [APEX, WWW].sort());
  });

  test('a signup from the www sibling is accepted and a foreign origin is not', async () => {
    const previous = process.env.COMMUNITY_ORIGIN;
    process.env.COMMUNITY_ORIGIN = APEX;
    const ctx = await startApp();
    try {
      for (const origin of [APEX, WWW]) {
        const res = await call(ctx.base, 'POST', '/api/community/owners/login/start', {
          body: { email: 'origin-pair@staging.invalid' },
          headers: { origin },
        });
        assert.equal(res.status, 200, origin + ' should be able to sign in');
      }
      const refused = await call(ctx.base, 'POST', '/api/community/owners/login/start', {
        body: { email: 'origin-pair@staging.invalid' },
        headers: { origin: 'https://affiliatemeetups.com.evil.example' },
      });
      assert.equal(refused.status, 403);
      assert.equal(refused.body.error, 'origin_not_allowed');
    } finally {
      if (previous === undefined) delete process.env.COMMUNITY_ORIGIN;
      else process.env.COMMUNITY_ORIGIN = previous;
      await ctx.close();
    }
  });
});
