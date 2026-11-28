'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { startApp } = require('./helpers');

// Runs fn with COMMUNITY_BASE_PATH set to value, then restores it.
async function withBase(value, fn) {
  const previous = process.env.COMMUNITY_BASE_PATH;
  if (value === undefined) delete process.env.COMMUNITY_BASE_PATH;
  else process.env.COMMUNITY_BASE_PATH = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.COMMUNITY_BASE_PATH;
    else process.env.COMMUNITY_BASE_PATH = previous;
  }
}

async function manual(base, pathname) {
  return fetch(base + pathname, { redirect: 'manual' });
}

// Spec §4.3: redirect, empty base path.
test('GET /community/ redirects with 308 and keeps the query string (empty base)', async () => {
  await withBase(undefined, async () => {
    const ctx = await startApp();
    try {
      const plain = await manual(ctx.base, '/community/');
      assert.equal(plain.status, 308);
      assert.equal(plain.headers.get('location'), '/community');

      const q = '?ref=x&utm_source=moltbook&amu_attr=a%20b';
      const withQuery = await manual(ctx.base, '/community/' + q);
      assert.equal(withQuery.status, 308);
      assert.equal(withQuery.headers.get('location'), '/community' + q);

      // After following, the final URL still carries the query and the page renders.
      const followed = await fetch(ctx.base + '/community/' + q, { redirect: 'follow' });
      assert.equal(followed.status, 200);
      assert.equal(new URL(followed.url).pathname, '/community');
      assert.equal(new URL(followed.url).search, q);
      assert.match(await followed.text(), /src="\/photos\/amu-scene-lounge-night-1120\.webp"/);

      // The canonical path itself is not redirected.
      const canonical = await manual(ctx.base, '/community');
      assert.equal(canonical.status, 200);

      // Only the exact page path is redirected: no photos alias is created.
      const alias = await manual(ctx.base, '/community/photos/amu-scene-lounge-night-1120.webp');
      assert.notEqual(alias.status, 200);
      assert.notEqual(alias.status, 308);
    } finally {
      await ctx.close();
    }
  });
});

// Spec §4.4: redirect, staged base path.
test('GET /staging/community/ redirects with 308, no double slash, query kept (staged base)', async () => {
  for (const env of ['/staging', '/staging/deep']) {
    await withBase(env, async () => {
      const ctx = await startApp();
      try {
        const plain = await manual(ctx.base, env + '/community/');
        assert.equal(plain.status, 308, env);
        assert.equal(plain.headers.get('location'), env + '/community', env);

        const q = '?ref=x&utm_campaign=amu';
        const withQuery = await manual(ctx.base, env + '/community/' + q);
        assert.equal(withQuery.status, 308, env);
        assert.equal(withQuery.headers.get('location'), env + '/community' + q, env);
        assert.doesNotMatch(withQuery.headers.get('location'), /\/\//, env);

        const followed = await fetch(ctx.base + env + '/community/' + q, { redirect: 'follow' });
        assert.equal(followed.status, 200, env);
        assert.equal(new URL(followed.url).pathname, env + '/community', env);
        assert.equal(new URL(followed.url).search, q, env);
        assert.match(await followed.text(), new RegExp('src="' + env.replace(/\//g, '\\/') + '\\/photos\\/amu-scene-lounge-night-1120\\.webp"'));
      } finally {
        await ctx.close();
      }
    });
  }
});

// Follow-up (c): COMMUNITY_BASE_PATH is written into src="..." so it is allowlisted.
test('unsafe COMMUNITY_BASE_PATH values are rejected at startup', async () => {
  const unsafe = [
    '/x"onerror="alert(1)',
    '/x<script>',
    "/x'y",
    '/a b',
    '/../x',
    '/./x',
    '//evil.example',
    'staging',
    'https://evil.example',
  ];
  for (const env of unsafe) {
    await withBase(env, async () => {
      let ctx = null;
      try {
        await assert.rejects(async () => {
          ctx = await startApp();
        }, /COMMUNITY_BASE_PATH/, JSON.stringify(env));
      } finally {
        if (ctx) await ctx.close();
      }
    });
  }
});

test('safe COMMUNITY_BASE_PATH values are accepted', async () => {
  for (const env of [undefined, '', '/staging', '/a/b-c_d.e~f']) {
    await withBase(env, async () => {
      const ctx = await startApp();
      await ctx.close();
    });
  }
});
