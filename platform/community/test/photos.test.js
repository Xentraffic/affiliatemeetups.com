'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { startApp } = require('./helpers');

test('bot photos are served from site/photos and traversal is rejected', async () => {
  const ctx = await startApp();
  try {
    const page = await fetch(ctx.base + '/community');
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /src="photos\/bots-venue\.svg"/);
    assert.match(html, /data-photo="bots-venue\.svg"/);

    const svg = await fetch(ctx.base + '/photos/bots-venue.svg');
    assert.equal(svg.status, 200);
    assert.match(svg.headers.get('content-type') || '', /^image\/svg\+xml\b/);
    const csp = svg.headers.get('content-security-policy') || '';
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'none'/);
    assert.match(csp, /sandbox/);
    assert.doesNotMatch(csp, /unsafe-inline/);
    assert.doesNotMatch(csp, /script-src 'self'/);
    const body = await svg.text();
    assert.match(body, /<svg[\s>]/);
    assert.match(body, /Cartoon bots under neon arches/);

    const dinner = await fetch(ctx.base + '/photos/bots-dinner.svg');
    assert.equal(dinner.status, 200);
    assert.match(dinner.headers.get('content-type') || '', /^image\/svg\+xml\b/);
    assert.match(await dinner.text(), /<svg[\s>]/);

    const listing = await fetch(ctx.base + '/photos/');
    assert.equal(listing.status, 404);
    assert.doesNotMatch(await listing.text(), /bots-venue\.svg/);

    const bare = await fetch(ctx.base + '/photos');
    assert.equal(bare.status, 404);

    const traversal = await fetch(
      ctx.base + '/photos/..%2f..%2fplatform%2fcommunity%2fpackage.json',
    );
    const traversalBody = await traversal.text();
    assert.notEqual(traversal.status, 200);
    assert.ok(traversal.status === 400 || traversal.status === 404);
    assert.doesNotMatch(traversalBody, /amu-community/);
  } finally {
    await ctx.close();
  }

  const previous = process.env.COMMUNITY_BASE_PATH;
  process.env.COMMUNITY_BASE_PATH = '/staging';
  const staged = await startApp();
  try {
    const svg = await fetch(staged.base + '/staging/photos/bots-venue.svg');
    assert.equal(svg.status, 200);
    assert.match(svg.headers.get('content-type') || '', /^image\/svg\+xml\b/);
    assert.match(await svg.text(), /<svg[\s>]/);
    const outsidePrefix = await fetch(staged.base + '/photos/bots-venue.svg');
    assert.equal(outsidePrefix.status, 404);
  } finally {
    if (previous === undefined) delete process.env.COMMUNITY_BASE_PATH;
    else process.env.COMMUNITY_BASE_PATH = previous;
    await staged.close();
  }
});
