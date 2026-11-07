'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.NODE_ENV='test';
process.env.COMMUNITY_MAIL_MODE = 'capture';
process.env.COMMUNITY_ADMIN_TOKEN = process.env.COMMUNITY_ADMIN_TOKEN || 'test-admin-token';

const { migrate } = require('../lib/migrate');
const { createApp } = require('../api');
const { capturedCodes, clearCaptured } = require('../lib/mailer');

/** Fresh migrated staging database + listening app per test file. */
async function startApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amu-community-'));
  const dbPath = path.join(dir, 'staging.db');
  migrate(dbPath);
  clearCaptured();

  const app = createApp({ dbPath });
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    base, dbPath, app,
    db: app.locals.db,
    async close() {
      await new Promise(r => server.close(r));
      try { app.locals.db.close(); } catch { /* already closed */ }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Minimal HTTP client. `auth` is passed through as the Authorization header. */
async function call(base, method, pathname, { body, auth } = {}) {
  const headers = {};
  // fetch refuses a body on GET/HEAD; drop it so callers can pass one
  // uniformly when sweeping a list of methods.
  const sendBody = body !== undefined && !['GET', 'HEAD'].includes(method.toUpperCase());
  if (sendBody) headers['Content-Type'] = 'application/json';
  if (auth) headers.Authorization = auth;
  const res = await fetch(base + pathname, {
    method, headers,
    body: sendBody ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body: json };
}

/** Register an agent, sign its owner in, claim it. Returns credential + session. */
async function provisionClaimedAgent(base, {
  handle = 'test-agent', display_name = 'Test Agent', owner_email = 'owner@example.com',
} = {}) {
  const reg = await call(base, 'POST', '/api/community/agents', {
    body: { handle, display_name, owner_email },
  });
  const agent_id = reg.body.agent.agent_id;

  await call(base, 'POST', '/api/community/owners/login/start', { body: { email: owner_email } });
  const code = capturedCodes().filter(c => c.email === owner_email).pop().code;
  const login = await call(base, 'POST', '/api/community/owners/login/complete', {
    body: { email: owner_email, code },
  });
  const ownerAuth = `Owner ${login.body.session_token}`;
  await call(base,'PATCH','/api/community/console/profile',{auth:ownerAuth,body:{company_name:'Test operator',accept_terms:true}});

  const claim = await call(base, 'POST', `/api/community/console/agents/${agent_id}/claim`, {
    auth: ownerAuth,
  });

  return {
    agent_id, ownerAuth, owner_email,
    credential: claim.body.activation_credential,
    agentAuth: `Bearer ${claim.body.activation_credential}`,
    claimResponse: claim,
    registrationResponse: reg,
  };
}

const ADMIN_AUTH = `Admin ${process.env.COMMUNITY_ADMIN_TOKEN}`;

module.exports = { startApp, call, provisionClaimedAgent, capturedCodes, ADMIN_AUTH };
