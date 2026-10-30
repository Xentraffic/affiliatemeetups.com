'use strict';

/**
 * Authorization boundaries. These exist because the inspected platform had no
 * authz layer at all, and one live consequence: an existing endpoint trusted a
 * member identifier straight from its URL. Each test below is a boundary we do
 * not want to rediscover in production.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, call, provisionClaimedAgent, capturedCodes, ADMIN_AUTH } = require('./helpers');

describe('authorization boundaries', () => {
  let ctx;
  before(async () => { ctx = await startApp(); });
  after(async () => { await ctx.close(); });

  test('an owner cannot act on another owner\'s agent', async () => {
    const a = await provisionClaimedAgent(ctx.base, {
      handle: 'agent-alpha', display_name: 'Alpha', owner_email: 'alpha@example.com',
    });
    const b = await provisionClaimedAgent(ctx.base, {
      handle: 'agent-beta', display_name: 'Beta', owner_email: 'beta@example.com',
    });

    // Beta's owner may not claim, patch, verify or inspect Alpha's agent.
    for (const [method, pathname] of [
      ['POST', `/api/community/console/agents/${a.agent_id}/claim`],
      ['POST', `/api/community/console/agents/${a.agent_id}/verify`],
      ['PATCH', `/api/community/console/agents/${a.agent_id}`],
      ['GET', `/api/community/console/agents/${a.agent_id}/verification-history`],
      ['POST', `/api/community/console/agents/${a.agent_id}/credential/rotate`],
    ]) {
      const res = await call(ctx.base, method, pathname, {
        auth: b.ownerAuth, body: { display_name: 'hijacked' },
      });
      assert.equal(res.status, 404, `${method} ${pathname} must not be actionable cross-owner`);
      assert.equal(res.body.error, 'agent_not_found');
    }

    // And the console listing is scoped.
    const list = await call(ctx.base, 'GET', '/api/community/console/agents', { auth: b.ownerAuth });
    assert.equal(list.body.count, 1);
    assert.equal(list.body.agents[0].agent_id, b.agent_id);
  });

  test('rotating a credential invalidates the previous one', async () => {
    const a = await provisionClaimedAgent(ctx.base, {
      handle: 'rotate-bot', display_name: 'Rotate', owner_email: 'rotate@example.com',
    });
    await call(ctx.base, 'POST', `/api/community/console/agents/${a.agent_id}/verify`, { auth: a.ownerAuth });

    const first = await call(ctx.base, 'POST', '/api/community/rooms/amu/posts', {
      auth: a.agentAuth, body: { body: 'before rotation' },
    });
    assert.equal(first.status, 201);

    const rot = await call(ctx.base, 'POST', `/api/community/console/agents/${a.agent_id}/credential/rotate`, {
      auth: a.ownerAuth,
    });
    assert.equal(rot.status, 200);
    assert.notEqual(rot.body.activation_credential, a.credential);

    const stale = await call(ctx.base, 'POST', '/api/community/rooms/amu/posts', {
      auth: a.agentAuth, body: { body: 'with the old credential' },
    });
    assert.equal(stale.status, 401);

    const fresh = await call(ctx.base, 'POST', '/api/community/rooms/amu/posts', {
      auth: `Bearer ${rot.body.activation_credential}`, body: { body: 'with the new credential' },
    });
    assert.equal(fresh.status, 201);
  });

  test('an unclaimed agent has no credential and cannot post', async () => {
    const reg = await call(ctx.base, 'POST', '/api/community/agents', {
      body: { handle: 'never-claimed', display_name: 'Never', owner_email: 'nc@example.com' },
    });
    const row = ctx.db.prepare('SELECT credential_hash FROM agents WHERE agent_id = ?')
      .get(reg.body.agent.agent_id);
    assert.equal(row.credential_hash, null);

    const res = await call(ctx.base, 'POST', '/api/community/rooms/amu/posts', {
      auth: 'Bearer not-a-real-credential', body: { body: 'nope' },
    });
    assert.equal(res.status, 401);
  });

  test('a claimed but unverified agent can read and cannot write', async () => {
    const a = await provisionClaimedAgent(ctx.base, {
      handle: 'unverified-bot', display_name: 'Unverified', owner_email: 'unv@example.com',
    });
    const write = await call(ctx.base, 'POST', '/api/community/rooms/amu/posts', {
      auth: a.agentAuth, body: { body: 'should not land' },
    });
    assert.equal(write.status, 403);
    assert.equal(write.body.error, 'agent_not_verified');

    const read = await call(ctx.base, 'GET', '/api/community/rooms/amu/posts', { auth: a.agentAuth });
    assert.equal(read.status, 200);
  });

  test('admin routes reject owner sessions and bad tokens', async () => {
    const a = await provisionClaimedAgent(ctx.base, {
      handle: 'admin-target', display_name: 'Target', owner_email: 'target@example.com',
    });
    for (const auth of [a.ownerAuth, a.agentAuth, 'Admin wrong-token', undefined]) {
      const res = await call(
        ctx.base, 'POST', `/api/community/admin/agents/${a.agent_id}/verification/grant`, { auth },
      );
      assert.equal(res.status, 403, `admin route must reject auth=${auth}`);
    }
    const ok = await call(
      ctx.base, 'POST', `/api/community/admin/agents/${a.agent_id}/verification/grant`,
      { auth: ADMIN_AUTH },
    );
    assert.equal(ok.status, 200);
  });

  test('sign-in does not leak whether an address is known', async () => {
    const known = await call(ctx.base, 'POST', '/api/community/owners/login/start', {
      body: { email: 'alpha@example.com' },
    });
    const unknown = await call(ctx.base, 'POST', '/api/community/owners/login/start', {
      body: { email: 'nobody-here@example.com' },
    });
    assert.equal(known.status, unknown.status);
    assert.deepEqual(known.body, unknown.body);
    assert.equal(capturedCodes().filter(c => c.email === 'nobody-here@example.com').length, 0);
  });

  test('a wrong sign-in code is rejected and attempts are capped', async () => {
    const email = 'alpha@example.com';
    await call(ctx.base, 'POST', '/api/community/owners/login/start', { body: { email } });
    for (let i = 0; i < 5; i++) {
      const res = await call(ctx.base, 'POST', '/api/community/owners/login/complete', {
        body: { email, code: '000000' },
      });
      assert.equal(res.status, 401);
    }
    const locked = await call(ctx.base, 'POST', '/api/community/owners/login/complete', {
      body: { email, code: '000000' },
    });
    assert.equal(locked.status, 429);
  });

  test('a revoked session stops working', async () => {
    const a = await provisionClaimedAgent(ctx.base, {
      handle: 'logout-bot', display_name: 'Logout', owner_email: 'logout@example.com',
    });
    const before = await call(ctx.base, 'GET', '/api/community/console/agents', { auth: a.ownerAuth });
    assert.equal(before.status, 200);
    await call(ctx.base, 'POST', '/api/community/owners/logout', { auth: a.ownerAuth });
    const after = await call(ctx.base, 'GET', '/api/community/console/agents', { auth: a.ownerAuth });
    assert.equal(after.status, 401);
  });

  test('unknown owner-writable fields are rejected rather than ignored', async () => {
    const a = await provisionClaimedAgent(ctx.base, {
      handle: 'fields-bot', display_name: 'Fields', owner_email: 'fields@example.com',
    });
    const res = await call(ctx.base, 'PATCH', `/api/community/console/agents/${a.agent_id}`, {
      auth: a.ownerAuth, body: { nickname: 'whatever' },
    });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body.fields, ['nickname']);

    const ok = await call(ctx.base, 'PATCH', `/api/community/console/agents/${a.agent_id}`, {
      auth: a.ownerAuth, body: { display_name: 'Renamed' },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.agent.display_name, 'Renamed');
  });
});
