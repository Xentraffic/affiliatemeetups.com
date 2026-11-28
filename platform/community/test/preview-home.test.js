'use strict';
// Preview mode only. The default suite leaves COMMUNITY_PREVIEW_SITE unset,
// so GET / stays a 404 there. This file is the one place that turns it on.
process.env.COMMUNITY_PREVIEW_SITE = '1';

const { test } = require('node:test');
const assert = require('node:assert');
const { startApp } = require('./helpers');

const CARTOONS = [
  'bots-venue.svg',
  'bots-hero.svg',
  'bots-dinner.svg',
  'bots-rooftop.svg',
  'bots-bangkok.svg',
];

test('preview / and /community share the campaign scenes and name sample data', async () => {
  const ctx = await startApp();
  try {
    const home = await fetch(ctx.base + '/');
    assert.equal(home.status, 200);
    const html = await home.text();
    assert.match(html, /class="preview-banner"/);
    assert.match(html, /sample data from a local database, not real community activity/);
    assert.match(html, /srcset="photos\/amu-scene-studio-day-640\.webp 640w, photos\/amu-scene-studio-day-1120\.webp 1120w"/);
    assert.match(html, /The people behind the performance\./);
    assert.match(html, /Quiet talks\. Loud numbers\./);
    assert.match(html, /Execution creates the ROI\./);
    assert.match(html, /class="illus">Illustration</);
    assert.match(html, /Join, connect your agent, then review and approve/);
    assert.doesNotMatch(html, /bots-/);
    assert.doesNotMatch(html, /claim a handle/);
    const again = await fetch(ctx.base + '/');
    assert.equal(await again.text(), html);

    const community = await fetch(ctx.base + '/community');
    assert.equal(community.status, 200);
    const shell = await community.text();
    assert.match(shell, /src="\/photos\/amu-scene-lounge-night-1120\.webp"/);
    assert.match(shell, /srcset="\/photos\/amu-scene-lounge-night-640\.webp 640w, \/photos\/amu-scene-lounge-night-1120\.webp 1120w"/);
    assert.match(shell, /srcset="\/photos\/amu-scene-rooftop-evening-640\.webp 640w, \/photos\/amu-scene-rooftop-evening-1120\.webp 1120w"/);
    assert.match(shell, /<figcaption>Illustration<\/figcaption>/);
    assert.match(shell, /Quiet talks\. Loud numbers\./);
    assert.match(shell, /Execution creates the ROI\./);
    assert.match(shell, /Builder integration/);
    assert.doesNotMatch(shell, /Developer integration/);
    assert.doesNotMatch(shell, /bots-/);
    for (const name of CARTOONS) assert.doesNotMatch(shell, new RegExp(name));

    const slashed = await fetch(ctx.base + '/community/', { redirect: 'follow' });
    assert.equal(slashed.status, 200);
    assert.equal(await slashed.text(), shell);
    const manual = await fetch(ctx.base + '/community/', { redirect: 'manual' });
    assert.equal(manual.status, 308);
    assert.equal(manual.headers.get('location'), '/community');
  } finally {
    await ctx.close();
  }
});
