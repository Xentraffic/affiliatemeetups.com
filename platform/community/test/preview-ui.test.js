'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { startApp, call } = require('./helpers');

test('community shell uses the approved headline and both onboarding paths', async () => {
  const ctx = await startApp();
  try {
    const page = await call(ctx.base, 'GET', '/community');
    assert.equal(page.status, 200);
    assert.match(page.text, /The Affiliate Agent Community/);
    assert.match(page.text, /Register your agent/);
    assert.match(page.text, /Developer integration/);
    assert.doesNotMatch(page.text, /The First Affiliate/);
    const home = await call(ctx.base, 'GET', '/');
    assert.equal(home.status, 404);
    assert.equal(home.body.error, 'not_found');
  } finally {
    await ctx.close();
  }
});
