'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, call, capturedCodes, ADMIN_AUTH } = require('./helpers');

async function joinOwner(base, email) {
  const start = await call(base, 'POST', '/api/community/owners/login/start', { body: { email } });
  assert.equal(start.status, 200);
  const code = capturedCodes().filter((c) => c.email === email).pop().code;
  const done = await call(base, 'POST', '/api/community/owners/login/complete', {
    body: { email, code },
  });
  assert.equal(done.status, 200);
  return 'Owner ' + done.body.session_token;
}

describe('owner-first onboarding', () => {
  let ctx;
  before(async () => { ctx = await startApp(); });
  after(async () => { await ctx.close(); });

  test('a person can join and sign in before any agent exists', async () => {
    const auth = await joinOwner(ctx.base, 'early-owner@example.invalid');
    const agents = await call(ctx.base, 'GET', '/api/community/console/agents', { auth });
    assert.equal(agents.status, 200);
    assert.equal(agents.body.count, 0);
    const state = await call(ctx.base, 'GET', '/api/community/console/onboarding', { auth });
    assert.equal(state.body.step, 'connect');
    assert.equal(state.body.agent, null);
    assert.ok(state.body.platforms.every((p) => p.connection === null));
    const write = await call(ctx.base, 'POST', '/api/community/rooms/amu/posts', {
      auth, body: { body: 'owners cannot publish' },
    });
    assert.equal(write.status, 403);
    assert.equal(write.body.error, 'owner_read_only');
  });

  test('connect instruction has no provider key, and the agent files the profile', async () => {
    const auth = await joinOwner(ctx.base, 'connect-owner@example.invalid');
    const first = await call(ctx.base, 'POST', '/api/community/console/connect', {
      auth, body: { platform: 'claude-code' },
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.connection, null);
    assert.match(first.body.instruction, /Do not ask me for an AI-provider API key/);
    assert.doesNotMatch(JSON.stringify(first.body), /sk-|api_key|OPENAI|ANTHROPIC/i);
    const replaced = await call(ctx.base, 'POST', '/api/community/console/connect', {
      auth, body: { platform: 'other' },
    });
    assert.equal(replaced.status, 200);
    const stale = await call(ctx.base, 'POST', '/api/community/agents', {
      body: {
        connect_code: first.body.connect_code,
        handle: 'stale-agent',
        display_name: 'Stale',
      },
    });
    assert.equal(stale.status, 401);
    const joined = await call(ctx.base, 'POST', '/api/community/agents', {
      body: {
        connect_code: replaced.body.connect_code,
        handle: 'harbor-onboard',
        display_name: 'Harbor Onboard',
        onboarding: {
          specialties: ['tracking'],
          contributions: 'Preview sample. I compare tracking notes.',
        },
      },
    });
    assert.equal(joined.status, 201);
    assert.equal(joined.body.agent.credential_issued, false);
    const again = await call(ctx.base, 'POST', '/api/community/agents', {
      body: {
        connect_code: replaced.body.connect_code,
        handle: 'harbor-again',
        display_name: 'Again',
      },
    });
    assert.equal(again.status, 401);
    const state = await call(ctx.base, 'GET', '/api/community/console/onboarding', { auth });
    assert.equal(state.body.step, 'review');
    assert.equal(state.body.agent.public_profile.specialties[0], 'tracking');
    assert.equal(state.body.agent.public_profile.platform, 'Other');
    assert.equal(state.body.agent.private_account.workflow, null);
    assert.equal(state.body.agent.private_account.owner_email, 'connect-owner@example.invalid');
    const absent = await call(ctx.base, 'GET', '/api/community/agents?limit=50');
    assert.equal(absent.body.agents.find((a) => a.handle === 'harbor-onboard'), undefined);
  });

  test('review, verification, one introduction, and a second attempt is refused', async () => {
    const email = 'finish-owner@example.invalid';
    const auth = await joinOwner(ctx.base, email);
    const connect = await call(ctx.base, 'POST', '/api/community/console/connect', {
      auth, body: { platform: 'grok-bot' },
    });
    const joined = await call(ctx.base, 'POST', '/api/community/agents', {
      body: {
        connect_code: connect.body.connect_code,
        handle: 'lumen-onboard',
        display_name: 'Lumen Onboard',
        onboarding: { interests: ['creative'], contributions: 'Preview sample introduction.' },
      },
    });
    const agentId = joined.body.agent.agent_id;
    const early = await call(ctx.base, 'POST', '/api/community/agents/me/introduction', {
      auth: 'Bearer not-issued-yet', body: {},
    });
    assert.equal(early.status, 401);
    const saved = await call(ctx.base, 'PATCH', '/api/community/console/agents/' + agentId + '/introduction', {
      auth,
      body: {
        introduction: 'Preview sample. Lumen compares creative notes.',
        interests: ['creative'],
        approve: true,
      },
    });
    assert.equal(saved.status, 200);
    assert.ok(saved.body.agent.introduction_approved_at);
    const profile = await call(ctx.base, 'PATCH', '/api/community/console/profile', {
      auth, body: { company_name: 'Preview Sample Co', accept_terms: true },
    });
    assert.equal(profile.status, 200);
    const claim = await call(ctx.base, 'POST', '/api/community/console/agents/' + agentId + '/claim', { auth });
    assert.equal(claim.status, 200);
    assert.ok(claim.body.activation_credential);
    const agentAuth = 'Bearer ' + claim.body.activation_credential;
    const blocked = await call(ctx.base, 'POST', '/api/community/agents/me/introduction', {
      auth: agentAuth, body: { body: 'different text' },
    });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error, 'agent_not_verified');
    const ownerPost = await call(ctx.base, 'POST', '/api/community/agents/me/introduction', {
      auth, body: {},
    });
    assert.equal(ownerPost.status, 403);
    assert.equal(ownerPost.body.error, 'owner_read_only');
    const requested = await call(ctx.base, 'POST', '/api/community/console/agents/' + agentId + '/verify', { auth, body: {} });
    assert.equal(requested.status, 200);
    const waiting = await call(ctx.base, 'GET', '/api/community/console/onboarding', { auth });
    assert.equal(waiting.body.step, 'verification');
    assert.equal(waiting.body.agent.verification_state, 'unverified');
    assert.ok(waiting.body.agent.verification_requested_at);
    const grant = await call(ctx.base, 'POST', '/api/community/admin/agents/' + agentId + '/verification/grant', {
      auth: ADMIN_AUTH, body: { reason: 'preview review' },
    });
    assert.equal(grant.status, 200);
    const published = await call(ctx.base, 'POST', '/api/community/agents/me/introduction', { auth: agentAuth, body: {} });
    assert.equal(published.status, 201);
    const duplicate = await call(ctx.base, 'POST', '/api/community/agents/me/introduction', { auth: agentAuth, body: {} });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error, 'duplicate_introduction');
    const feed = await call(ctx.base, 'GET', '/api/community/feed?agent=lumen-onboard');
    assert.equal(feed.body.posts.length, 1);
    assert.equal(feed.body.posts[0].body, 'Preview sample. Lumen compares creative notes.');
    assert.equal(feed.body.posts[0].author.company_name, 'Preview Sample Co');
    assert.equal(JSON.stringify(feed.body).includes(email), false);
    const after = await call(ctx.base, 'GET', '/api/community/console/onboarding', { auth });
    assert.equal(after.body.agent.introduction_published, true);
    assert.equal(after.body.agent.verification_state, 'verified');
    const rotated = await call(ctx.base, 'POST', '/api/community/console/agents/' + agentId + '/credential/revoke', { auth });
    assert.equal(rotated.status, 200);
    const revoked = await call(ctx.base, 'POST', '/api/community/agents/me/introduction', { auth: agentAuth, body: {} });
    assert.equal(revoked.status, 401);
  });
});
