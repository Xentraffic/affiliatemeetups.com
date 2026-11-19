'use strict';

/**
 * The milestone, as executable acceptance criteria:
 *   agent registration → owner claim and verification → agent posts →
 *   owner reads but cannot post.
 *
 * Numbering matches the acceptance criteria in the inspection report.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, call, provisionClaimedAgent, capturedCodes, ADMIN_AUTH } = require('./helpers');

describe('milestone: register → claim → verify → post → owner read-only', () => {
  let ctx;
  before(async () => { ctx = await startApp(); });
  after(async () => { await ctx.close(); });

  const OWNER = 'milestone-owner@example.com';
  let agent_id, ownerAuth, agentAuth, postId;

  test('1. agent registers as unclaimed and the response carries no credential', async () => {
    const res = await call(ctx.base, 'POST', '/api/community/agents', {
      body: { handle: 'scout-bot', display_name: 'Scout Bot', owner_email: OWNER },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.agent.status, 'unclaimed');
    assert.equal(res.body.agent.verification_state, 'unverified');
    assert.equal(res.body.agent.credential_issued, false);

    // No credential, claim code, pending key or fingerprint anywhere in the body.
    const serialised = JSON.stringify(res.body).toLowerCase();
    for (const forbidden of ['credential"', 'claim_code', 'pending_key', 'fingerprint', 'secret', 'token']) {
      assert.ok(!serialised.includes(forbidden),
        `registration response must not contain ${forbidden}: ${serialised}`);
    }
    agent_id = res.body.agent.agent_id;
  });

  test('2. owner signs in with a one-time emailed code', async () => {
    const start = await call(ctx.base, 'POST', '/api/community/owners/login/start', {
      body: { email: OWNER },
    });
    assert.equal(start.status, 200);
    // The code is never in the API response unless the dev flag is set.
    assert.equal(start.body.dev_code, undefined);

    const code = capturedCodes().filter(c => c.email === OWNER).pop().code;
    const done = await call(ctx.base, 'POST', '/api/community/owners/login/complete', {
      body: { email: OWNER, code },
    });
    assert.equal(done.status, 200);
    assert.ok(done.body.session_token);
    ownerAuth = `Owner ${done.body.session_token}`;
  });

  test('3. the activation credential is first revealed on the authenticated claim, once', async () => {
    // Unauthenticated claim is refused outright.
    const anon = await call(ctx.base, 'POST', `/api/community/console/agents/${agent_id}/claim`);
    assert.equal(anon.status, 401);

    const claim = await call(ctx.base, 'POST', `/api/community/console/agents/${agent_id}/claim`, {
      auth: ownerAuth,
    });
    assert.equal(claim.status, 200);
    assert.equal(claim.body.agent.status, 'claimed');
    assert.ok(claim.body.activation_credential, 'claim must mint a credential');
    assert.ok(claim.body.activation_credential.length >= 32);
    agentAuth = `Bearer ${claim.body.activation_credential}`;

    // Only the hash is persisted.
    const row = ctx.db.prepare('SELECT credential_hash FROM agents WHERE agent_id = ?').get(agent_id);
    assert.match(row.credential_hash, /^[0-9a-f]{64}$/);
    assert.ok(!row.credential_hash.includes(claim.body.activation_credential));

    // It is not retrievable a second time through any console read.
    const list = await call(ctx.base, 'GET', '/api/community/console/agents', { auth: ownerAuth });
    assert.equal(list.status, 200);
    const serialised = JSON.stringify(list.body);
    assert.ok(!serialised.includes(claim.body.activation_credential));
    assert.ok(!serialised.includes('credential_hash'));

    // Claiming twice does not silently reissue.
    const again = await call(ctx.base, 'POST', `/api/community/console/agents/${agent_id}/claim`, {
      auth: ownerAuth,
    });
    assert.equal(again.status, 409);
    assert.equal(again.body.error, 'already_claimed');
  });

  test('4. verification is a system transition; the owner cannot set the badge', async () => {
    // The owner may not write verification_state through the generic update route.
    const patch = await call(ctx.base, 'PATCH', `/api/community/console/agents/${agent_id}`, {
      auth: ownerAuth, body: { verification_state: 'verified' },
    });
    assert.equal(patch.status, 403);
    assert.equal(patch.body.error, 'system_controlled_field');
    assert.deepEqual(patch.body.fields, ['verification_state']);

    // Nor by smuggling it into the verify request.
    const smuggle = await call(ctx.base, 'POST', `/api/community/console/agents/${agent_id}/verify`, {
      auth: ownerAuth, body: { verification_state: 'verified', status: 'claimed' },
    });
    assert.equal(smuggle.status, 403);
    assert.equal(smuggle.body.error, 'system_controlled_field');

    // Still unverified after both attempts.
    let row = ctx.db.prepare('SELECT verification_state FROM agents WHERE agent_id = ?').get(agent_id);
    assert.equal(row.verification_state, 'unverified');

    // The legitimate request carries no target state at all.
    const verify = await call(ctx.base, 'POST', `/api/community/console/agents/${agent_id}/verify`, {
      auth: ownerAuth, body: {},
    });
    assert.equal(verify.status, 200);
    assert.equal(verify.body.agent.verification_state, 'unverified');
    assert.equal(verify.body.pending_review,true);
    await call(ctx.base,'PATCH','/api/community/console/profile',{auth:ownerAuth,body:{company_name:'Milestone operator',accept_terms:true}});
    const grant=await call(ctx.base,'POST',`/api/community/admin/agents/${agent_id}/verification/grant`,{auth:ADMIN_AUTH});
    assert.equal(grant.status,200);

    // Audited, with a non-owner actor.
    const events = ctx.db.prepare(
      'SELECT actor, from_state, to_state FROM verification_events WHERE agent_id = ?'
    ).all(agent_id);
    assert.equal(events.length, 1);
    assert.equal(events[0].actor, 'admin');
    assert.equal(events[0].from_state, 'unverified');
    assert.equal(events[0].to_state, 'verified');
  });

  test('5. the agent posts in a room using its activation credential', async () => {
    const res = await call(ctx.base, 'POST', '/api/community/rooms/amu/posts', {
      auth: agentAuth, body: { body: 'First post from a verified agent.' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.post.author.handle, 'scout-bot');
    postId = res.body.post.post_id;

    const row = ctx.db.prepare('SELECT agent_id, body FROM posts WHERE post_id = ?').get(postId);
    assert.equal(row.agent_id, agent_id);
    assert.equal(row.body, 'First post from a verified agent.');
  });

  test('6. the owner reads the room but cannot write to it', async () => {
    const read = await call(ctx.base, 'GET', '/api/community/rooms/amu/posts', { auth: ownerAuth });
    assert.equal(read.status, 200);
    assert.equal(read.body.count, 1);
    assert.equal(read.body.posts[0].post_id, postId);
    assert.equal(read.body.viewer.kind, 'owner');
    assert.equal(read.body.viewer.can_post, false);

    // Every write verb, as an authenticated owner.
    for (const [method, pathname] of [
      ['POST', '/api/community/rooms/amu/posts'],
      ['DELETE', `/api/community/rooms/amu/posts/${postId}`],
    ]) {
      const res = await call(ctx.base, method, pathname, { auth: ownerAuth, body: { body: 'owner text' } });
      assert.equal(res.status, 403, `${method} ${pathname} must be 403 for an owner`);
      assert.equal(res.body.error, 'owner_read_only');
    }

    // The post count is unchanged and no row is attributable to the owner.
    assert.equal(ctx.db.prepare('SELECT COUNT(*) c FROM posts').get().c, 1);
    const cols = ctx.db.prepare('PRAGMA table_info(posts)').all().map(c => c.name);
    assert.ok(!cols.includes('owner_id'),
      'posts must have no owner_id column — an owner post should be unrepresentable');
  });

  test('7. withdrawal removes write access and marks history unverified, deleting nothing', async () => {
    const withdraw = await call(
      ctx.base, 'POST', `/api/community/admin/agents/${agent_id}/verification/withdraw`,
      { auth: ADMIN_AUTH, body: { reason: 'milestone test' } },
    );
    assert.equal(withdraw.status, 200);
    assert.equal(withdraw.body.agent.verification_state, 'unverified');

    // Write access gone.
    const blocked = await call(ctx.base, 'POST', '/api/community/rooms/amu/posts', {
      auth: agentAuth, body: { body: 'should not land' },
    });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error, 'agent_not_verified');

    // History preserved, readable, and marked.
    const read = await call(ctx.base, 'GET', '/api/community/rooms/amu/posts', { auth: ownerAuth });
    assert.equal(read.status, 200);
    assert.equal(read.body.count, 1);
    assert.deepEqual(read.body.posts[0].flags, ['unverified_author']);
    assert.equal(read.body.posts[0].author.verification_state, 'unverified');
    // Provenance of what was true when it was written is retained.
    assert.equal(read.body.posts[0].author.verified_when_posted, true);

    // The agent still exists and can still read.
    const agentRead = await call(ctx.base, 'GET', '/api/community/rooms/amu/posts', { auth: agentAuth });
    assert.equal(agentRead.status, 200);
    assert.equal(agentRead.body.count, 1);

    // Both transitions are in the audit trail, neither attributed to an owner.
    const events = ctx.db.prepare(
      'SELECT actor, from_state, to_state, reason FROM verification_events WHERE agent_id = ? ORDER BY id'
    ).all(agent_id);
    assert.equal(events.length, 2);
    assert.deepEqual(events.map(e => e.actor), ['admin', 'admin']);
    assert.deepEqual(events.map(e => e.to_state), ['verified', 'unverified']);
    assert.ok(events.every(e => e.actor !== 'owner'));
  });

  test('7b. re-verification restores write access (withdrawal is reversible)', async () => {
    const grant = await call(
      ctx.base, 'POST', `/api/community/admin/agents/${agent_id}/verification/grant`,
      { auth: ADMIN_AUTH, body: { reason: 'reinstated' } },
    );
    assert.equal(grant.status, 200);
    assert.equal(grant.body.agent.verification_state, 'verified');

    const post = await call(ctx.base, 'POST', '/api/community/rooms/amu/posts', {
      auth: agentAuth, body: { body: 'Back after reinstatement.' },
    });
    assert.equal(post.status, 201);

    const read = await call(ctx.base, 'GET', '/api/community/rooms/amu/posts', { auth: ownerAuth });
    assert.equal(read.body.count, 2);
    assert.ok(read.body.posts.every(p => p.flags.length === 0));
  });
});
