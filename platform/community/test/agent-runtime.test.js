'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const {
  installCredential,
  loadCredential,
  removeCredential,
  describeCredential,
  postAsAgent,
  replyAsAgent,
  checkCredential,
  apiUrl,
  assertOutsideRepo,
} = require('../lib/agent-runtime');
const { startApp, call, provisionClaimedAgent, ADMIN_AUTH } = require('./helpers');

const FAKE = 'fake-runtime-credential-not-a-secret';
const REPO = path.resolve(__dirname, '../../..');
const CLI = path.join(__dirname, '../ops/agent-runtime.js');

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Error('cli timed out'));
    }, 10000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

function privateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'amu-agent-runtime-'));
}

function agentId(char) {
  return 'agt_' + char.repeat(24);
}

test('API base joins the staging prefix and refuses embedded credentials', () => {
  assert.equal(
    apiUrl('http://127.0.0.1:3861/staging', '/api/community/session'),
    'http://127.0.0.1:3861/staging/api/community/session',
  );
  assert.equal(
    apiUrl('http://127.0.0.1:3861', '/api/community/rooms/amu/posts'),
    'http://127.0.0.1:3861/api/community/rooms/amu/posts',
  );
  assert.throws(() => apiUrl('http://user:pass@127.0.0.1:3861', '/api/community/session'), /credentials/);
});

test('install writes a 0600 file outside the repo and never echoes the credential', () => {
  const dir = privateDir();
  try {
    const described = installCredential({
      dir,
      handle: 'scout',
      agentId: agentId('a'),
      credential: FAKE,
      repoRoot: REPO,
    });
    assert.equal(described.handle, 'scout');
    assert.equal(described.agent_id, agentId('a'));
    assert.equal(described.mode, '600');
    assert.equal(described.directory_mode, '700');
    assert.equal(JSON.stringify(described).includes(FAKE), false);
    const file = path.join(dir, 'scout');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    const loaded = loadCredential(dir, 'scout');
    assert.equal(loaded.credential, FAKE);
    fs.chmodSync(file, 0o644);
    assert.throws(() => loadCredential(dir, 'scout'), /0600/);
    try {
      loadCredential(dir, 'scout');
    } catch (err) {
      assert.equal(String(err.message).includes(FAKE), false);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a world-readable symlink and an in-repo directory are refused', () => {
  const dir = privateDir();
  const outside = path.join(dir, 'leaked');
  try {
    fs.writeFileSync(outside, JSON.stringify({ handle: 'scout', credential: FAKE }), { mode: 0o644 });
    fs.symlinkSync(outside, path.join(dir, 'scout'));
    assert.throws(() => loadCredential(dir, 'scout'), /symlink/);
    const inside = path.join(REPO, 'platform', 'community', 'agent-runtime-must-not-exist');
    assert.throws(() => assertOutsideRepo(inside, REPO), /outside the git checkout/);
    assert.equal(fs.existsSync(inside), false);
    assert.throws(
      () => installCredential({ dir: inside, handle: 'scout', credential: FAKE, repoRoot: REPO }),
      /outside the git checkout/,
    );
    assert.equal(fs.existsSync(inside), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('remove shreds the local file and does not call the network', async () => {
  const dir = privateDir();
  try {
    installCredential({ dir, handle: 'scout', credential: FAKE, repoRoot: REPO });
    const file = path.join(dir, 'scout');
    assert.equal(fs.existsSync(file), true);
    const removed = removeCredential(dir, 'scout');
    assert.equal(removed.removed, true);
    assert.equal(fs.existsSync(file), false);
    let called = false;
    await assert.rejects(
      () => postAsAgent({
        dir,
        handle: 'scout',
        room: 'amu',
        body: 'should not send',
        apiBase: 'http://127.0.0.1:9',
        fetchImpl: async () => {
          called = true;
          throw Error('fetch should not run');
        },
      }),
      /missing/,
    );
    assert.equal(called, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI install path does not print the credential or accept it as a flag', () => {
  const dir = privateDir();
  try {
    const installed = spawnSync(process.execPath, [
      CLI, 'install', '--handle', 'scout', '--agent-id', agentId('b'),
    ], {
      input: FAKE + '\n',
      encoding: 'utf8',
      env: { ...process.env, COMMUNITY_AGENT_RUNTIME_DIR: dir },
    });
    assert.equal(installed.status, 0, installed.stderr);
    assert.equal(installed.stdout.includes(FAKE), false);
    assert.equal(installed.stderr.includes(FAKE), false);
    const described = JSON.parse(installed.stdout);
    assert.equal(described.ok, true);
    assert.equal(described.mode, '600');
    assert.equal(loadCredential(dir, 'scout').credential, FAKE);

    const status = spawnSync(process.execPath, [CLI, 'status', '--handle', 'scout'], {
      encoding: 'utf8',
      env: { ...process.env, COMMUNITY_AGENT_RUNTIME_DIR: dir, COMMUNITY_AGENT_CREDENTIAL: FAKE },
    });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(status.stdout.includes(FAKE), false);
    assert.equal(JSON.parse(status.stdout).agent_id, agentId('b'));

    const flagged = spawnSync(process.execPath, [
      CLI, 'install', '--handle', 'scout', '--credential', FAKE,
    ], {
      input: FAKE + '\n',
      encoding: 'utf8',
      env: { ...process.env, COMMUNITY_AGENT_RUNTIME_DIR: dir },
    });
    assert.equal(flagged.status, 1);
    assert.equal(flagged.stderr.includes(FAKE), false);
    assert.match(flagged.stderr, /unknown option/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('stored credential posts as the agent and dies when the server revokes it', { concurrency: 1 }, () => {
  let ctx;
  let dir;
  before(async () => {
    ctx = await startApp();
    dir = privateDir();
  });
  after(async () => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    if (ctx) await ctx.close();
  });

  test('an owner session token in the store cannot post', async () => {
    const owner = await provisionClaimedAgent(ctx.base, {
      handle: 'runtime-owner-token',
      display_name: 'Owner Token',
      owner_email: 'runtime-owner@example.com',
    });
    const token = owner.ownerAuth.slice('Owner '.length);
    installCredential({
      dir,
      handle: 'not-an-agent',
      agentId: agentId('c'),
      credential: token,
      repoRoot: REPO,
    });
    const before = ctx.db.prepare('SELECT COUNT(*) n FROM posts').get().n;
    const result = await postAsAgent({
      dir,
      handle: 'not-an-agent',
      room: 'amu',
      body: 'An owner token must not publish.',
      apiBase: ctx.base,
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.equal(result.error, 'agent_credential_required');
    assert.equal(JSON.stringify(result).includes(token), false);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM posts').get().n, before);
    const checked = await checkCredential({ dir, handle: 'not-an-agent', apiBase: ctx.base });
    assert.equal(checked.ok, false);
    assert.equal(checked.viewer_kind, 'public');
  });

  test('a verified agent posts and replies, then rotate and revoke invalidate the file', async () => {
    const agent = await provisionClaimedAgent(ctx.base, {
      handle: 'runtime-scout',
      display_name: 'Runtime Scout',
      owner_email: 'runtime-scout@example.com',
    });
    installCredential({
      dir,
      handle: 'runtime-scout',
      agentId: agent.agent_id,
      credential: agent.credential,
      repoRoot: REPO,
    });
    const unverified = await postAsAgent({
      dir,
      handle: 'runtime-scout',
      room: 'amu',
      body: 'Unverified agents still cannot write.',
      apiBase: ctx.base,
    });
    assert.equal(unverified.status, 403);
    assert.equal(unverified.error, 'agent_not_verified');

    const grant = await call(ctx.base, 'POST', `/api/community/admin/agents/${agent.agent_id}/verification/grant`, {
      auth: ADMIN_AUTH,
    });
    assert.equal(grant.status, 200);
    const posted = await postAsAgent({
      dir,
      handle: 'runtime-scout',
      room: 'amu',
      body: 'Posted from the local runtime store.',
      apiBase: ctx.base,
    });
    assert.equal(posted.ok, true, JSON.stringify(posted));
    assert.equal(posted.status, 201);
    assert.equal(posted.author_handle, 'runtime-scout');
    assert.equal(JSON.stringify(posted).includes(agent.credential), false);
    const reply = await replyAsAgent({
      dir,
      handle: 'runtime-scout',
      postId: posted.post_id,
      body: 'Reply from the same stored credential.',
      apiBase: ctx.base,
    });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.ok(reply.comment_id);
    const row = ctx.db.prepare('SELECT agent_id FROM posts WHERE post_id=?').get(posted.post_id);
    assert.equal(row.agent_id, agent.agent_id);

    const rotated = await call(ctx.base, 'POST', `/api/community/console/agents/${agent.agent_id}/credential/rotate`, {
      auth: agent.ownerAuth,
    });
    assert.equal(rotated.status, 200);
    const stale = await postAsAgent({
      dir,
      handle: 'runtime-scout',
      room: 'amu',
      body: 'The previous credential must fail.',
      apiBase: ctx.base,
    });
    assert.equal(stale.status, 401);
    installCredential({
      dir,
      handle: 'runtime-scout',
      agentId: agent.agent_id,
      credential: rotated.body.activation_credential,
      repoRoot: REPO,
    });
    const fresh = await postAsAgent({
      dir,
      handle: 'runtime-scout',
      room: 'amu',
      body: 'The replacement credential works.',
      apiBase: ctx.base,
    });
    assert.equal(fresh.status, 201);
    const described = describeCredential(dir, 'runtime-scout');
    assert.equal(JSON.stringify(described).includes(rotated.body.activation_credential), false);

    const revoked = await call(ctx.base, 'POST', `/api/community/console/agents/${agent.agent_id}/credential/revoke`, {
      auth: agent.ownerAuth,
    });
    assert.equal(revoked.status, 200);
    const dead = await postAsAgent({
      dir,
      handle: 'runtime-scout',
      room: 'amu',
      body: 'A revoked credential must fail.',
      apiBase: ctx.base,
    });
    assert.equal(dead.status, 401);
    // spawnSync would block the server's event loop and deadlock the request.
    const cli = await runCli([
      'post', '--handle', 'runtime-scout', '--room', 'amu', '--body', 'CLI after revoke',
      '--api-base', ctx.base,
    ], { ...process.env, COMMUNITY_AGENT_RUNTIME_DIR: dir });
    assert.equal(cli.status, 2, cli.stderr);
    assert.equal(cli.stdout.includes(rotated.body.activation_credential), false);
    assert.equal(cli.stderr.includes(rotated.body.activation_credential), false);
    assert.equal(JSON.parse(cli.stdout).error, 'agent_credential_required');
  });
});
