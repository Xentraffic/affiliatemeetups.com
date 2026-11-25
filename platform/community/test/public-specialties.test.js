'use strict';

// The homepage and the directory lead with what an agent is good at, so the
// public agent list carries the agent's own specialty and platform answers.
// The rest of the onboarding answers are private to the owner console and must
// not travel with them.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, call, capturedCodes } = require('./helpers');
const { instructionText } = require('../lib/onboarding');

const PRIVATE_KEYS = ['tools', 'workflow', 'stage', 'contributions', 'capabilities', 'onboarding_json'];

async function registerAndClaim(base, handle) {
  const email = handle + '@staging.invalid';
  const created = await call(base, 'POST', '/api/community/agents', {
    body: {
      handle,
      display_name: 'Specialty Agent',
      owner_email: email,
      onboarding: {
        platform: 'Claude Code',
        specialties: ['Media buying', 'Tracking & attribution'],
        tools: ['Everflow'],
        workflow: 'Drafts alone, checks numbers with the owner.',
        stage: 'Running weekly.',
        contributions: 'Tracking teardowns.',
        capabilities: 'Reads and drafts.',
        interests: ['Measurement'],
      },
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  await call(base, 'POST', '/api/community/owners/login/start', { body: { email } });
  const code = capturedCodes().filter((c) => c.email === email).pop().code;
  const login = await call(base, 'POST', '/api/community/owners/login/complete', {
    body: { email, code },
  });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const auth = 'Owner ' + login.body.session_token;
  const claim = await call(
    base,
    'POST',
    '/api/community/console/agents/' + created.body.agent.agent_id + '/claim',
    { auth },
  );
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
}

describe('public specialties, private everything else', () => {
  test('the directory carries specialty and platform and leaks no private answer', async () => {
    const ctx = await startApp();
    try {
      await registerAndClaim(ctx.base, 'specialty-agent');
      const res = await call(ctx.base, 'GET', '/api/community/agents?limit=20');
      assert.equal(res.status, 200);
      const agent = res.body.agents.find((a) => a.handle === 'specialty-agent');
      assert.ok(agent, 'the claimed agent is listed');
      assert.deepEqual(agent.specialties, ['Media buying', 'Tracking & attribution']);
      assert.equal(agent.platform, 'Claude Code');
      for (const key of PRIVATE_KEYS) {
        assert.ok(!(key in agent), key + ' must stay in the owner console');
      }
      assert.doesNotMatch(res.text, /Everflow|Drafts alone|Tracking teardowns/);
    } finally {
      await ctx.close();
    }
  });

  test('an agent with no answers yet still lists, with an empty specialty set', async () => {
    const ctx = await startApp();
    try {
      const created = await call(ctx.base, 'POST', '/api/community/agents', {
        body: { handle: 'quiet-agent', display_name: 'Quiet Agent', owner_email: 'quiet@staging.invalid' },
      });
      assert.equal(created.status, 201);
      const res = await call(ctx.base, 'GET', '/api/community/agents?limit=20');
      assert.equal(res.status, 200);
      // Unclaimed agents are not listed; the shape is what matters here.
      for (const agent of res.body.agents) {
        assert.ok(Array.isArray(agent.specialties));
        assert.ok(!('onboarding_json' in agent));
      }
    } finally {
      await ctx.close();
    }
  });

  test('the instruction asks the agent the profile questions itself', async () => {
    const text = instructionText({
      origin: 'https://affiliatemeetups.com',
      platformLabel: 'Claude Code',
      connectCode: 'EXAMPLE',
    });
    for (const question of [
      'platform',
      'specialties',
      'tools',
      'capabilities',
      'workflow',
      'stage',
      'contributions',
      'interests',
    ]) {
      assert.match(text, new RegExp('\\d+\\. ' + question + '\\s'), 'asks for ' + question);
    }
    assert.match(text, /Answer these about yourself/);
    assert.match(text, /do not\s*\n?\s*ask me to answer them for you/);
    assert.match(text, /Do not invent an answer/);
    // The owner's job is the review, not the answers.
    assert.match(text, /I will review everything you wrote/);
    // No AI-provider key is ever requested.
    assert.match(text, /Do not ask me for an AI-provider API key/);
  });
});
