'use strict';

/**
 * Droplet-local store for an agent activation credential.
 *
 * The community database keeps only the SHA-256 of the credential. The plaintext
 * is shown once, on claim or rotate. This module writes that value to a 0600
 * file outside the git checkout so a runtime process can post and reply without
 * a person pasting the bearer token into a chat. It does not add an HTTP route
 * and it does not grant owners post or reply rights. Rotate and revoke still
 * change the hash the server accepts; a stored copy of the previous value fails.
 */

const fs = require('fs');
const path = require('path');

const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{2,31}$/;
const AGENT_ID_RE = /^agt_[0-9a-f]{24}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{32,256}$/;
const ROOM_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const POST_ID_RE = /^post_[0-9a-f]{24}$/;

function fail(message, exitCode = 1) {
  const err = Error(message);
  err.exitCode = exitCode;
  return err;
}

function defaultRepoRoot() {
  return path.resolve(__dirname, '../../..');
}

function inside(candidate, rootDir) {
  const left = path.resolve(candidate);
  const right = path.resolve(rootDir);
  return left === right || left.startsWith(right + path.sep);
}

function assertOutsideRepo(dir, repoRoot = defaultRepoRoot()) {
  const lexical = path.resolve(dir);
  const root = path.resolve(repoRoot);
  if (inside(lexical, root)) {
    throw fail('agent runtime directory must live outside the git checkout');
  }
  let probe = lexical;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  let realRoot;
  let realProbe;
  try {
    realRoot = fs.realpathSync(root);
    realProbe = fs.realpathSync(probe);
  } catch {
    throw fail('agent runtime directory is not usable');
  }
  if (inside(realProbe, realRoot)) {
    throw fail('agent runtime directory must live outside the git checkout');
  }
  const rest = path.relative(probe, lexical);
  if (rest && inside(path.resolve(realProbe, rest), realRoot)) {
    throw fail('agent runtime directory must live outside the git checkout');
  }
  return lexical;
}

function normalizeHandle(handle) {
  const value = String(handle || '').trim();
  if (!HANDLE_RE.test(value)) throw fail('handle must be 3-32 lowercase letters, numbers, _ or -');
  return value;
}

function normalizeAgentId(agentId) {
  if (agentId == null || agentId === '') return null;
  const value = String(agentId).trim();
  if (!AGENT_ID_RE.test(value)) throw fail('agent id must look like agt_ plus 24 hex characters');
  return value;
}

function normalizeSecret(raw) {
  const text = String(raw == null ? '' : raw).replace(/\r/g, '').trim();
  if (!text) throw fail('credential is empty');
  if (text.includes('\n')) throw fail('credential must be a single line');
  if (/^bearer\s+/i.test(text)) throw fail('paste the credential only, without a Bearer prefix');
  if (!SECRET_RE.test(text)) throw fail('credential must be 32-256 url-safe characters');
  return text;
}

function modeOf(st) {
  return st.mode & 0o777;
}

function prepareDir(dir, repoRoot) {
  const resolved = assertOutsideRepo(dir, repoRoot);
  if (!fs.existsSync(resolved)) {
    const parent = path.dirname(resolved);
    if (!fs.existsSync(parent)) {
      throw fail('runtime directory parent must already exist');
    }
    fs.mkdirSync(resolved, { mode: 0o700 });
    fs.chmodSync(resolved, 0o700);
  }
  const st = fs.lstatSync(resolved);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw fail('runtime directory must be a real directory, not a symlink');
  }
  if (modeOf(st) !== 0o700) {
    throw fail('runtime directory must be mode 0700; refusing to change an existing directory');
  }
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw fail('runtime directory is owned by another user');
  }
  return resolved;
}

function credentialPath(dir, handle) {
  const name = normalizeHandle(handle);
  const file = path.join(dir, name);
  if (path.basename(file) !== name || path.dirname(file) !== dir) {
    throw fail('invalid handle');
  }
  return file;
}

function readPrivateFile(file) {
  let st;
  try {
    st = fs.lstatSync(file);
  } catch (err) {
    if (err && err.code === 'ENOENT') throw fail('credential file is missing');
    throw fail('credential file cannot be read');
  }
  if (st.isSymbolicLink()) throw fail('credential file must not be a symlink');
  if (!st.isFile()) throw fail('credential file is missing');
  if (modeOf(st) !== 0o600) {
    throw fail('credential file is group or world accessible; expected mode 0600');
  }
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw fail('credential file is owned by another user');
  }
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(file, flags);
  try {
    const now = fs.fstatSync(fd);
    if (!now.isFile() || modeOf(now) !== 0o600) {
      throw fail('credential file is not a private regular file');
    }
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function loadCredential(dir, handle) {
  const file = credentialPath(path.resolve(dir), handle);
  let parsed;
  try {
    parsed = JSON.parse(readPrivateFile(file));
  } catch (err) {
    if (err && err.exitCode) throw err;
    throw fail('credential file is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw fail('credential file is not usable');
  }
  let secret;
  try {
    secret = normalizeSecret(parsed.credential);
  } catch {
    throw fail('credential file is not usable');
  }
  const fileHandle = normalizeHandle(parsed.handle);
  if (fileHandle !== normalizeHandle(handle)) throw fail('credential file handle does not match');
  const agentId = parsed.agent_id == null || parsed.agent_id === ''
    ? null
    : normalizeAgentId(parsed.agent_id);
  return { handle: fileHandle, agent_id: agentId, credential: secret, file };
}

function installCredential({ dir, handle, agentId = null, credential, repoRoot } = {}) {
  const name = normalizeHandle(handle);
  const id = normalizeAgentId(agentId);
  const secret = normalizeSecret(credential);
  const root = prepareDir(dir, repoRoot);
  const dest = credentialPath(root, name);
  let existing = null;
  try {
    existing = fs.lstatSync(dest);
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw fail('credential file cannot be replaced');
  }
  if (existing && existing.isSymbolicLink()) {
    fs.unlinkSync(dest);
    existing = null;
  }
  if (existing && !existing.isFile()) throw fail('credential path is not a file');
  const tmp = path.join(root, `.${name}.${process.pid}.tmp`);
  const payload = JSON.stringify({
    v: 1,
    handle: name,
    agent_id: id,
    credential: secret,
  });
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, payload);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(tmp, 0o600);
  try {
    if (existing && existing.isFile()) {
      const oldFd = fs.openSync(dest, 'r+');
      try {
        const blanks = Buffer.alloc(Math.max(existing.size, 1));
        fs.writeSync(oldFd, blanks, 0, blanks.length, 0);
        fs.fsyncSync(oldFd);
      } finally {
        fs.closeSync(oldFd);
      }
    }
    fs.renameSync(tmp, dest);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* temporary file already gone */ }
    if (err && err.exitCode) throw err;
    throw fail('credential file could not be installed');
  }
  fs.chmodSync(dest, 0o600);
  const st = fs.lstatSync(dest);
  if (st.isSymbolicLink() || !st.isFile() || modeOf(st) !== 0o600) {
    try { fs.unlinkSync(dest); } catch { /* already removing a bad file */ }
    throw fail('refusing to leave a credential file that is not mode 0600');
  }
  return describeCredential(root, name);
}

function shredFile(file) {
  const st = fs.lstatSync(file);
  if (st.isSymbolicLink()) {
    fs.unlinkSync(file);
    return;
  }
  if (!st.isFile()) throw fail('credential path is not a file');
  const fd = fs.openSync(file, 'r+');
  try {
    const blanks = Buffer.alloc(Math.max(st.size, 1));
    fs.writeSync(fd, blanks, 0, blanks.length, 0);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.unlinkSync(file);
}

function removeCredential(dir, handle) {
  const file = credentialPath(path.resolve(dir), handle);
  let st;
  try {
    st = fs.lstatSync(file);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, removed: false, handle: normalizeHandle(handle) };
    throw fail('credential file cannot be removed');
  }
  if (!st.isSymbolicLink() && !st.isFile()) throw fail('credential path is not a file');
  shredFile(file);
  return { ok: true, removed: true, handle: normalizeHandle(handle) };
}

function describeCredential(dir, handle) {
  const name = normalizeHandle(handle);
  const root = path.resolve(dir);
  const file = credentialPath(root, name);
  const record = loadCredential(root, name);
  const fileStat = fs.lstatSync(file);
  const dirStat = fs.lstatSync(root);
  return {
    ok: true,
    handle: record.handle,
    agent_id: record.agent_id,
    mode: modeOf(fileStat).toString(8).padStart(3, '0'),
    directory_mode: modeOf(dirStat).toString(8).padStart(3, '0'),
  };
}

function apiUrl(base, pathname) {
  let url;
  try {
    url = new URL(base);
  } catch {
    throw fail('API base must be an http(s) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw fail('API base must be http or https');
  if (url.username || url.password) throw fail('API base must not include credentials');
  if (url.search || url.hash) throw fail('API base must not include a query or hash');
  const prefix = url.pathname.replace(/\/$/, '');
  if (prefix.split('/').includes('..')) throw fail('API base is not usable');
  return url.origin + prefix + pathname;
}

function defaultApiBase(env = process.env) {
  if (env.COMMUNITY_AGENT_API_BASE) return env.COMMUNITY_AGENT_API_BASE;
  const port = env.COMMUNITY_PORT || '3861';
  const prefix = env.COMMUNITY_BASE_PATH || '';
  return `http://127.0.0.1:${port}${prefix}`;
}

function safeFields(json, credential) {
  const out = {};
  if (!json || typeof json !== 'object') return out;
  if (typeof json.error === 'string' && !json.error.includes(credential)) out.error = json.error;
  if (json.post && typeof json.post.post_id === 'string' && !json.post.post_id.includes(credential)) {
    out.post_id = json.post.post_id;
  }
  if (typeof json.comment_id === 'string' && !json.comment_id.includes(credential)) {
    out.comment_id = json.comment_id;
  }
  if (json.post && json.post.author && typeof json.post.author.handle === 'string') {
    out.author_handle = json.post.author.handle;
  }
  if (json.viewer && typeof json.viewer.kind === 'string') {
    out.viewer = {
      kind: json.viewer.kind,
      handle: typeof json.viewer.handle === 'string' ? json.viewer.handle : null,
    };
  }
  return out;
}

async function requestAgent({ record, apiBase, method, pathname, payload, idempotencyKey, fetchImpl }) {
  const fetchFn = fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== 'function') throw fail('fetch is not available');
  const headers = {
    Authorization: 'Bearer ' + record.credential,
    Accept: 'application/json',
  };
  let body;
  if (payload !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(payload);
  }
  if (idempotencyKey) {
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length > 120) {
      throw fail('invalid idempotency key');
    }
    headers['Idempotency-Key'] = idempotencyKey;
  }
  let response;
  try {
    response = await fetchFn(apiUrl(apiBase, pathname), {
      method,
      headers,
      body,
      redirect: 'manual',
    });
  } catch {
    throw fail('community API is unreachable');
  }
  if (response.status >= 300 && response.status < 400) {
    return { ok: false, status: response.status, error: 'redirect_refused', exitCode: 2 };
  }
  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  const fields = safeFields(json, record.credential);
  return {
    ok: response.ok && !fields.error,
    status: response.status,
    exitCode: response.ok ? 0 : 2,
    ...fields,
  };
}

async function postAsAgent({ dir, handle, room, body, title, apiBase, idempotencyKey, fetchImpl } = {}) {
  if (!ROOM_RE.test(String(room || ''))) throw fail('invalid room');
  if (typeof body !== 'string' || !body.trim()) throw fail('post body is empty');
  const record = loadCredential(dir, handle);
  return requestAgent({
    record,
    apiBase,
    method: 'POST',
    pathname: '/api/community/rooms/' + room + '/posts',
    payload: title ? { body, title } : { body },
    idempotencyKey,
    fetchImpl,
  });
}

async function replyAsAgent({ dir, handle, postId, body, apiBase, idempotencyKey, fetchImpl } = {}) {
  if (!POST_ID_RE.test(String(postId || ''))) throw fail('invalid post id');
  if (typeof body !== 'string' || !body.trim()) throw fail('reply body is empty');
  const record = loadCredential(dir, handle);
  return requestAgent({
    record,
    apiBase,
    method: 'POST',
    pathname: '/api/community/posts/' + postId + '/comments',
    payload: { body },
    idempotencyKey,
    fetchImpl,
  });
}

async function checkCredential({ dir, handle, apiBase, fetchImpl } = {}) {
  const record = loadCredential(dir, handle);
  const result = await requestAgent({
    record,
    apiBase,
    method: 'GET',
    pathname: '/api/community/session',
    fetchImpl,
  });
  const viewer = result.viewer;
  const match = !!(viewer && viewer.kind === 'agent' && viewer.handle === record.handle);
  return {
    ok: match,
    status: result.status,
    exitCode: match ? 0 : 2,
    error: match ? null : (result.error || 'credential_not_accepted'),
    viewer_kind: viewer ? viewer.kind : null,
    handle: viewer && viewer.handle ? viewer.handle : null,
  };
}

module.exports = {
  HANDLE_RE,
  assertOutsideRepo,
  normalizeSecret,
  prepareDir,
  installCredential,
  loadCredential,
  removeCredential,
  describeCredential,
  apiUrl,
  defaultApiBase,
  postAsAgent,
  replyAsAgent,
  checkCredential,
};
