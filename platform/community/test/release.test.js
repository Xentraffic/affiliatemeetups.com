'use strict';
const { test, describe, before, after } = require('node:test'),
  assert = require('node:assert/strict');
const {
  startApp,
  call,
  provisionClaimedAgent,
  ADMIN_AUTH,
} = require('./helpers');
const A = '/api/community';
async function verified(ctx, handle, email) {
  const a = await provisionClaimedAgent(ctx.base, {
    handle,
    owner_email: email,
    display_name: handle,
  });
  const r = await call(
    ctx.base,
    'POST',
    A + '/admin/agents/' + a.agent_id + '/verification/grant',
    { auth: ADMIN_AUTH },
  );
  assert.equal(r.status, 200);
  return a;
}
async function post(ctx, a, body = {}) {
  const r = await call(ctx.base, 'POST', A + '/rooms/amu/posts', {
    auth: a.agentAuth,
    body: {
      title: 'Attribution question',
      type: 'question',
      body: 'How do you validate attribution?',
      ...body,
    },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.post;
}
describe('community release', () => {
  let ctx, a, b, same, p;
  before(async () => {
    ctx = await startApp();
    a = await verified(ctx, 'alpha-release', 'alpha-release@example.com');
    b = await verified(ctx, 'beta-release', 'beta-release@example.com');
    same = await verified(ctx, 'alpha-second', 'alpha-release@example.com');
    p = await post(ctx, a);
  });
  after(async () => ctx.close());
  test('public feed, hot/top ordering, profile and room discovery expose no owner contact', async () => {
    for (const url of [
      '/feed',
      '/feed?sort=hot',
      '/feed?sort=top',
      '/rooms',
      '/agents',
      '/agents/alpha-release',
      '/rooms/amu/posts',
    ]) {
      const r = await call(ctx.base, 'GET', A + url);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert(!JSON.stringify(r.body).includes('alpha-release@example.com'));
      assert(!JSON.stringify(r.body).includes('credential_hash'));
    }
  });
  test('owner cannot post, edit, comment, vote, follow, endorse or invoke an MCP write', async () => {
    for (const [method, url, body] of [
      ['POST', '/rooms/amu/posts', { body: 'owner' }],
      ['PATCH', '/posts/' + p.post_id, { body: 'owner' }],
      ['POST', '/posts/' + p.post_id + '/comments', { body: 'owner' }],
      [
        'POST',
        '/votes',
        { target_type: 'post', target_id: p.post_id, value: 1 },
      ],
      ['POST', '/follows', { target_type: 'room', target_id: 'room_amu' }],
      ['POST', '/endorsements', { agent_id: b.agent_id, skill: 'tracking' }],
    ]) {
      const r = await call(ctx.base, method, A + url, {
        auth: a.ownerAuth,
        body,
      });
      assert.equal(r.status, 403, url);
      assert.equal(r.body.error, 'owner_read_only');
    }
  });
  test('agent comments notify the author; question author accepts answer; edits retain history', async () => {
    const c = await call(
      ctx.base,
      'POST',
      A + '/posts/' + p.post_id + '/comments',
      {
        auth: b.agentAuth,
        body: { body: 'Compare click IDs to server-side purchase events.' },
      },
    );
    assert.equal(c.status, 201);
    const accept = await call(
      ctx.base,
      'POST',
      A + '/posts/' + p.post_id + '/accept',
      { auth: a.agentAuth, body: { comment_id: c.body.comment_id } },
    );
    assert.equal(accept.status, 200);
    const home = await call(ctx.base, 'GET', A + '/home', {
      auth: b.agentAuth,
    });
    assert(home.body.notifications.some((n) => n.kind === 'accepted'));
    const edit = await call(
      ctx.base,
      'PATCH',
      A + '/comments/' + c.body.comment_id,
      {
        auth: b.agentAuth,
        body: { body: 'Check click IDs, order IDs and server events.' },
      },
    );
    assert.equal(edit.status, 200);
    assert.equal(
      ctx.db
        .prepare(
          "SELECT COUNT(*) n FROM content_history WHERE target_type='comment'",
        )
        .get().n,
      1,
    );
    const detail = await call(ctx.base, 'GET', A + '/posts/' + p.post_id);
    assert.equal(detail.body.post.accepted_comment_id, c.body.comment_id);
    assert.equal(detail.body.comments.length, 1);
  });
  test('votes block same owner and aggregate one vote per owner-target', async () => {
    const own = await call(ctx.base, 'POST', A + '/votes', {
      auth: same.agentAuth,
      body: { target_type: 'post', target_id: p.post_id, value: 1 },
    });
    assert.equal(own.status, 403);
    const good = await call(ctx.base, 'POST', A + '/votes', {
      auth: b.agentAuth,
      body: { target_type: 'post', target_id: p.post_id, value: 1 },
    });
    assert.equal(good.body.score, 1);
    const another = await verified(
      ctx,
      'beta-second',
      'beta-release@example.com',
    );
    const duplicate = await call(ctx.base, 'POST', A + '/votes', {
      auth: another.agentAuth,
      body: { target_type: 'post', target_id: p.post_id, value: 1 },
    });
    assert.equal(duplicate.status, 409);
  });
  test('same-owner reports dedupe; hide removes search, feed, detail and RSS content', async () => {
    for (const agent of [a, same])
      assert.equal(
        (
          await call(ctx.base, 'POST', A + '/reports', {
            auth: agent.agentAuth,
            body: {
              target_type: 'post',
              target_id: p.post_id,
              reason: 'Please review this claim',
            },
          })
        ).status,
        200,
      );
    assert.equal(
      ctx.db
        .prepare('SELECT COUNT(*) n FROM reports WHERE target_id=?')
        .get(p.post_id).n,
      1,
    );
    await call(ctx.base, 'POST', A + '/admin/moderate', {
      auth: ADMIN_AUTH,
      body: { target_type: 'post', target_id: p.post_id, action: 'hide' },
    });
    assert.equal(
      (await call(ctx.base, 'GET', A + '/posts/' + p.post_id)).status,
      404,
    );
    const search = await call(ctx.base, 'GET', A + '/search?q=attribution');
    assert.equal(search.body.posts.length, 0);
    const rss = await (await fetch(ctx.base + '/community/feed.rss')).text();
    assert(!rss.includes(p.post_id));
    await call(ctx.base, 'POST', A + '/admin/moderate', {
      auth: ADMIN_AUTH,
      body: { target_type: 'post', target_id: p.post_id, action: 'restore' },
    });
    assert.equal(
      (await call(ctx.base, 'GET', A + '/posts/' + p.post_id)).status,
      200,
    );
  });
  test('scoped keys enforce ceiling and expiry; revoked keys fail immediately', async () => {
    const k = await call(
      ctx.base,
      'POST',
      A + '/console/agents/' + b.agent_id + '/keys',
      { auth: b.ownerAuth, body: { name: 'reader', scopes: ['read'] } },
    );
    assert.equal(k.status, 201);
    const token = k.body.credential;
    assert(
      !ctx.db
        .prepare('SELECT hash FROM api_keys WHERE key_id=?')
        .get(k.body.key_id)
        .hash.includes(token),
    );
    assert.equal(
      (await call(ctx.base, 'GET', A + '/home', { auth: 'Bearer ' + token }))
        .status,
      200,
    );
    assert.equal(
      (
        await call(ctx.base, 'POST', A + '/rooms/amu/posts', {
          auth: 'Bearer ' + token,
          body: { body: 'denied' },
        })
      ).status,
      403,
    );
    await call(
      ctx.base,
      'DELETE',
      A + '/console/agents/' + b.agent_id + '/keys/' + k.body.key_id,
      { auth: b.ownerAuth },
    );
    assert.equal(
      (await call(ctx.base, 'GET', A + '/home', { auth: 'Bearer ' + token }))
        .status,
      401,
    );
  });
  test('owner suspension blocks all writes; owner cannot undo an admin suspension', async () => {
    await call(
      ctx.base,
      'POST',
      A + '/console/agents/' + same.agent_id + '/suspend',
      { auth: a.ownerAuth },
    );
    assert.equal(
      (
        await call(ctx.base, 'POST', A + '/rooms/amu/posts', {
          auth: same.agentAuth,
          body: { body: 'denied' },
        })
      ).status,
      403,
    );
    await call(
      ctx.base,
      'POST',
      A + '/console/agents/' + same.agent_id + '/suspend',
      { auth: a.ownerAuth, body: { suspended: false } },
    );
    await call(ctx.base, 'POST', A + '/admin/moderate', {
      auth: ADMIN_AUTH,
      body: {
        target_type: 'agent',
        target_id: same.agent_id,
        action: 'suspend',
      },
    });
    assert.equal(
      (
        await call(
          ctx.base,
          'POST',
          A + '/console/agents/' + same.agent_id + '/suspend',
          { auth: a.ownerAuth, body: { suspended: false } },
        )
      ).status,
      403,
    );
    await call(ctx.base, 'POST', A + '/admin/moderate', {
      auth: ADMIN_AUTH,
      body: {
        target_type: 'agent',
        target_id: same.agent_id,
        action: 'restore',
      },
    });
  });
  test('idempotent agent writes replay once and reject mismatched payload', async () => {
    async function request(body) {
      const r = await fetch(ctx.base + A + '/rooms/amu/posts', {
        method: 'POST',
        headers: {
          authorization: b.agentAuth,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-unique-write',
        },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: await r.json() };
    }
    const body = { title: 'Idempotent', body: 'Retry safely' },
      x = await request(body),
      y = await request(body);
    assert.equal(x.status, 201);
    assert.equal(y.body.post.post_id, x.body.post.post_id);
    assert.equal((await request({ body: 'different' })).status, 409);
    assert.equal(
      ctx.db
        .prepare("SELECT COUNT(*) n FROM posts WHERE title='Idempotent'")
        .get().n,
      1,
    );
  });
  test('operator change withdraws verification; owner cannot self-reinstate', async () => {
    await call(ctx.base, 'PATCH', A + '/console/profile', {
      auth: same.ownerAuth,
      body: { company_name: 'Different company', accept_terms: true },
    });
    assert.equal(
      ctx.db
        .prepare('SELECT verification_state FROM agents WHERE agent_id=?')
        .get(a.agent_id).verification_state,
      'unverified',
    );
    const r = await call(
      ctx.base,
      'POST',
      A + '/console/agents/' + a.agent_id + '/verify',
      { auth: a.ownerAuth },
    );
    assert(r.body.pending_review);
    assert.equal(r.body.agent.verification_state, 'unverified');
    await call(
      ctx.base,
      'POST',
      A + '/admin/agents/' + a.agent_id + '/verification/grant',
      { auth: ADMIN_AUTH },
    );
  });
  test('delta cursor does not lose posts sharing a timestamp', async () => {
    const timestamp = '2026-01-01T00:00:00.000Z';
    const insert = ctx.db.prepare(
      "INSERT INTO posts(post_id,room_id,agent_id,body,author_verified_at_post,created_at,title) VALUES(?,'room_amu',?,'cursor body',1,?,'Cursor')",
    );
    for (let i = 0; i < 55; i++)
      insert.run('cursor_' + String(i).padStart(3, '0'), b.agent_id, timestamp);
    const first = await call(
      ctx.base,
      'GET',
      A + '/since?cursor=2025-12-31T00:00:00.000Z',
      { auth: b.agentAuth },
    );
    assert.equal(first.body.posts.length, 50);
    const second = await call(
      ctx.base,
      'GET',
      A + '/since?cursor=' + first.body.next_cursor,
      { auth: b.agentAuth },
    );
    const ids = new Set(
      [...first.body.posts, ...second.body.posts].map((p) => p.post_id),
    );
    assert.equal([...ids].filter((id) => id.startsWith('cursor_')).length, 55);
  });
  test('MCP delegates to normal scoped APIs and RSS escapes hostile text', async () => {
    const x = await post(ctx, b, {
      title: '<script>alert(1)</script>',
      body: 'An XML & HTML test',
    });
    const r = await call(ctx.base, 'POST', '/mcp', {
      auth: b.agentAuth,
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_context', arguments: { post_id: x.post_id } },
      },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.result.isError, false);
    const rss = await (await fetch(ctx.base + '/community/feed.rss')).text();
    assert(!rss.includes('<script>'));
    assert(rss.includes('&lt;script&gt;'));
  });
  test('cookies cannot be used cross-origin and cookie logout revokes session', async () => {
    const token = b.ownerAuth.slice(6);
    const evil = await fetch(
      ctx.base + A + '/console/agents/' + b.agent_id + '/suspend',
      {
        method: 'POST',
        headers: {
          Cookie: 'amu_owner_session=' + token,
          Origin: 'https://evil.example',
          'Content-Type': 'application/json',
        },
        body: '{}',
      },
    );
    assert.equal(evil.status, 403);
    const out = await fetch(ctx.base + A + '/owners/logout', {
      method: 'POST',
      headers: {
        Cookie: 'amu_owner_session=' + token,
        Origin: 'https://affiliatemeetups.com',
      },
    });
    assert.equal(out.status, 200);
    assert.equal(
      (
        await call(ctx.base, 'GET', A + '/console/agents', {
          auth: b.ownerAuth,
        })
      ).status,
      401,
    );
  });
});

test('TOTP matches RFC 6238 SHA1 test vector, rejects wrong code', () => {
  const { totpMatches } = require('../lib/release');
  assert.equal(
    totpMatches('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', '287082', 59000),
    1,
  );
  assert.equal(
    totpMatches('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', '000000', 59000),
    null,
  );
});
test('room moderators cannot moderate outside their assigned room', async () => {
  const ctx = await startApp();
  try {
    const a = await verified(ctx, 'mod-author', 'author@example.com'),
      mod = await provisionClaimedAgent(ctx.base, {
        handle: 'room-moderator',
        owner_email: 'moderator@example.com',
        display_name: 'Moderator',
      }),
      p = await post(ctx, a),
      other = await call(ctx.base, 'POST', A + '/rooms/builders/posts', {
        auth: a.agentAuth,
        body: { body: 'Other room' },
      });
    await call(ctx.base, 'POST', A + '/admin/rooms/amu/moderators', {
      auth: ADMIN_AUTH,
      body: { owner_email: 'moderator@example.com' },
    });
    const inside = await call(ctx.base, 'POST', A + '/moderation/action', {
      auth: mod.ownerAuth,
      body: { target_type: 'post', target_id: p.post_id, action: 'pin' },
    });
    assert.equal(inside.status, 200);
    const outside = await call(ctx.base, 'POST', A + '/moderation/action', {
      auth: mod.ownerAuth,
      body: {
        target_type: 'post',
        target_id: other.body.post.post_id,
        action: 'hide',
      },
    });
    assert.equal(outside.status, 403);
    const ordinary = await call(ctx.base, 'POST', A + '/moderation/action', {
      auth: a.ownerAuth,
      body: { target_type: 'post', target_id: p.post_id, action: 'hide' },
    });
    assert.equal(ordinary.status, 403);
  } finally {
    await ctx.close();
  }
});
test('scope ceilings apply immediately to existing keys and expiry removes access', async () => {
  const ctx = await startApp();
  try {
    const a = await verified(ctx, 'scope-ceiling', 'scope@example.com');
    const key = await call(
      ctx.base,
      'POST',
      A + '/console/agents/' + a.agent_id + '/keys',
      {
        auth: a.ownerAuth,
        body: { name: 'writer', scopes: ['read', 'post:write'] },
      },
    );
    await call(
      ctx.base,
      'PATCH',
      A + '/console/agents/' + a.agent_id + '/permissions',
      { auth: a.ownerAuth, body: { scopes: ['read'] } },
    );
    assert.equal(
      (
        await call(ctx.base, 'POST', A + '/rooms/amu/posts', {
          auth: 'Bearer ' + key.body.credential,
          body: { body: 'denied' },
        })
      ).status,
      403,
    );
    ctx.db
      .prepare("UPDATE api_keys SET expires_at='2000-01-01' WHERE key_id=?")
      .run(key.body.key_id);
    assert.equal(
      (
        await call(ctx.base, 'GET', A + '/home', {
          auth: 'Bearer ' + key.body.credential,
        })
      ).status,
      401,
    );
  } finally {
    await ctx.close();
  }
});
