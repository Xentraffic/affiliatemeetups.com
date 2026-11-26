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
  assert.match(html, /data-photo="amu-agent-lounge-1120\.webp"/);
  assert.doesNotMatch(html, /src="photos\//);
  assert.doesNotMatch(html, /__COMMUNITY_PHOTO_BASE__/);
}

const CARTOON_PHOTOS = [
  'bots-venue.svg',
  'bots-hero.svg',
  'bots-dinner.svg',
  'bots-rooftop.svg',
  'bots-bangkok.svg',
];

async function assertPhotosSecurity(base, prefix) {
  const root = base + prefix;
  for (const name of CARTOON_PHOTOS) {
    const gone = await fetch(root + '/photos/' + name);
    assert.equal(gone.status, 404, name + ' should no longer be served');
    assert.doesNotMatch(await gone.text(), /<svg[\s>]/);
  }

  // SVG responses stay sandboxed. The probe is a test file, not a page asset,
  // and it is removed before the test returns.
  const fs = require('node:fs');
  const path = require('node:path');
  const probeName = 'csp-probe-' + process.pid + '.svg';
  const probePath = path.join(__dirname, '../../../site/photos', probeName);
  fs.writeFileSync(
    probePath,
    '<svg xmlns="http://www.w3.org/2000/svg"><title>CSP probe</title></svg>',
  );
  try {
    const svg = await fetch(root + '/photos/' + probeName);
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
    assert.doesNotMatch(body, /Cartoon bots/);
  } finally {
    fs.rmSync(probePath, { force: true });
  }

  // The shell's own photograph is a JPEG; it must be served and typed. The
  // probe above covers the hardened SVG path.
  const shellPhoto = await fetch(root + '/photos/amu-crowd-2.jpg');
  assert.equal(shellPhoto.status, 200);
  assert.match(shellPhoto.headers.get('content-type') || '', /^image\/jpeg\b/);
  assert.equal(shellPhoto.headers.get('x-content-type-options'), 'nosniff');

  // The shell's own photograph is now a WebP campaign scene; the flat photo
  // route has no subdirectories, so this also holds that the file was not
  // filed under one.
  const shellScene = await fetch(root + '/photos/amu-agent-lounge-1120.webp');
  assert.equal(shellScene.status, 200);
  assert.match(shellScene.headers.get('content-type') || '', /^image\/webp\b/);
  assert.equal(shellScene.headers.get('x-content-type-options'), 'nosniff');

  const nested = await fetch(root + '/photos/agents/amu-agent-lounge-1120.webp');
  assert.equal(nested.status, 404);

  const listing = await fetch(root + '/photos/');
  assert.equal(listing.status, 404);
  assert.doesNotMatch(await listing.text(), /amu-crowd-2\.jpg/);

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

  const shell = await fetch(root + '/community');
  const shellHtml = await shell.text();
  assert.doesNotMatch(shellHtml, /bots-/);
  assert.match(shellHtml, /srcset="[^"]*amu-agent-lounge-640\.webp 640w/);
  assert.match(shellHtml, /amu-agent-lounge-1120\.webp 1120w/);
  assert.match(shellHtml, /amu-agent-rooftop-640\.webp 640w/);
  assert.match(shellHtml, /<figcaption>Illustration<\/figcaption>/);
}

test('shell photos are served from site/photos and traversal is rejected', async () => {
  const ctx = await startApp();
  try {
    const html = await pageHtml(ctx.base, '/community');
    assertPhotoSrc(html, '/photos/amu-agent-lounge-1120.webp');
    const slashed = await pageHtml(ctx.base, '/community/');
    assertPhotoSrc(slashed, '/photos/amu-agent-lounge-1120.webp');
    await assertPhotosSecurity(ctx.base, '');
  } finally {
    await ctx.close();
  }

  const previous = process.env.COMMUNITY_BASE_PATH;
  process.env.COMMUNITY_BASE_PATH = '/staging';
  const staged = await startApp();
  try {
    const html = await pageHtml(staged.base, '/staging/community');
    assertPhotoSrc(html, '/staging/photos/amu-agent-lounge-1120.webp');
    const slashed = await pageHtml(staged.base, '/staging/community/');
    assertPhotoSrc(slashed, '/staging/photos/amu-agent-lounge-1120.webp');
    await assertPhotosSecurity(staged.base, '/staging');
    const outsidePrefix = await fetch(staged.base + '/photos/bots-venue.svg');
    assert.equal(outsidePrefix.status, 404);
    const home = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '../../../site/index.html'),
      'utf8',
    );
    assert.doesNotMatch(home, /bots-/);
    assert.match(home, /photos\/amu-agent-cafe-640\.webp 640w/);
    assert.match(home, /The people behind the performance\./);
    assert.match(home, /Quiet talks\. Loud numbers\./);
    assert.match(home, /Execution creates the ROI\./);
    assert.match(home, /class="illus">Illustration</);
  } finally {
    if (previous === undefined) delete process.env.COMMUNITY_BASE_PATH;
    else process.env.COMMUNITY_BASE_PATH = previous;
    await staged.close();
  }
});
