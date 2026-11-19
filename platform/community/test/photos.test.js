'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { startApp } = require('./helpers');

async function pageHtml(base, pathname) {
  const res = await fetch(base + pathname, { redirect: 'follow' });
  assert.equal(res.status, 200, pathname + ' should serve the community page');
  return res.text();
}

function assertPhotoSrc(html, src) {
  assert.ok(html.includes('src="' + src + '"'), 'expected img src ' + src);
  assert.match(html, /data-photo="bots-venue\.svg"/);
  assert.doesNotMatch(html, /src="photos\//);
  assert.doesNotMatch(html, /__COMMUNITY_PHOTO_BASE__/);
}

async function assertPhotosSecurity(base, prefix) {
  const root = base + prefix;
  const svg = await fetch(root + '/photos/bots-venue.svg');
  assert.equal(svg.status, 200);
  assert.match(svg.headers.get('content-type') || '', /^image\/svg\+xml\b/);
  assert.equal(svg.headers.get('x-content-type-options'), 'nosniff');
  const csp = svg.headers.get('content-security-policy') || '';
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'none'/);
  assert.match(csp, /sandbox/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  assert.doesNotMatch(csp, /script-src 'self'/);
  const body = await svg.text();
  assert.match(body, /<svg[\s>]/);
  assert.match(body, /Cartoon bots under neon arches/);

  const dinner = await fetch(root + '/photos/bots-dinner.svg');
  assert.equal(dinner.status, 200);
  assert.match(dinner.headers.get('content-type') || '', /^image\/svg\+xml\b/);
  assert.match(await dinner.text(), /<svg[\s>]/);

  const listing = await fetch(root + '/photos/');
  assert.equal(listing.status, 404);
  assert.doesNotMatch(await listing.text(), /bots-venue\.svg/);

  const bare = await fetch(root + '/photos');
  assert.equal(bare.status, 404);

  const unknown = await fetch(root + '/photos/no-such-file.svg');
  assert.equal(unknown.status, 404);

  const traversal = await fetch(
    root + '/photos/..%2f..%2fplatform%2fcommunity%2fpackage.json',
  );
  const traversalBody = await traversal.text();
  assert.notEqual(traversal.status, 200);
  assert.ok(traversal.status === 400 || traversal.status === 404);
  assert.doesNotMatch(traversalBody, /amu-community/);

  const alias = await fetch(root + '/community/photos/bots-venue.svg', {
    redirect: 'manual',
  });
  assert.notEqual(alias.status, 200);
}

test('bot photos are served from site/photos and traversal is rejected', async () => {
  const ctx = await startApp();
  try {
    const html = await pageHtml(ctx.base, '/community');
    assertPhotoSrc(html, '/photos/bots-venue.svg');
    const slashed = await pageHtml(ctx.base, '/community/');
    assertPhotoSrc(slashed, '/photos/bots-venue.svg');
    await assertPhotosSecurity(ctx.base, '');
  } finally {
    await ctx.close();
  }

  const previous = process.env.COMMUNITY_BASE_PATH;
  process.env.COMMUNITY_BASE_PATH = '/staging';
  const staged = await startApp();
  try {
    const html = await pageHtml(staged.base, '/staging/community');
    assertPhotoSrc(html, '/staging/photos/bots-venue.svg');
    const slashed = await pageHtml(staged.base, '/staging/community/');
    assertPhotoSrc(slashed, '/staging/photos/bots-venue.svg');
    await assertPhotosSecurity(staged.base, '/staging');
    const outsidePrefix = await fetch(staged.base + '/photos/bots-venue.svg');
    assert.equal(outsidePrefix.status, 404);
  } finally {
    if (previous === undefined) delete process.env.COMMUNITY_BASE_PATH;
    else process.env.COMMUNITY_BASE_PATH = previous;
    await staged.close();
  }
});
