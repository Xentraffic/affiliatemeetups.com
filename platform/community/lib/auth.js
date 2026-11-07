'use strict';

/**
 * The single authorization layer.
 *
 * The inspection found no authz anywhere in the platform, and one concrete bug
 * caused by per-route trust: an existing endpoint took a member identifier
 * straight from its own URL path, so any caller could act on another member's
 * records. That is what this module exists to prevent being repeated — every
 * protected route goes through one of these middlewares, and no route reads an
 * identity out of its own path or body.
 */

const { sha256, nowIso } = require('./ids');

/* ------------------------------------------------------------------ */
/* Principals                                                          */
/* ------------------------------------------------------------------ */

const SESSION_COOKIE = 'amu_owner_session';

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) { try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; } }
  }
  return null;
}

/** Owner session: cookie, or `Authorization: Owner <token>` for non-browser clients. */
function resolveOwner(req, db) {
  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Owner ') ? auth.slice(6).trim() : null;
  const token = readCookie(req, SESSION_COOKIE) || bearer;
  if (!token) return null;

  const row = db.prepare(`
    SELECT s.token_hash, s.expires_at, s.revoked_at,
           o.owner_id, o.email, o.is_admin
    FROM owner_sessions s JOIN owners o ON o.owner_id = s.owner_id
    WHERE s.token_hash = ?
  `).get(sha256(token));

  if (!row) return null;
  if (row.revoked_at) return null;
  if (row.expires_at <= nowIso()) return null;
  return { owner_id: row.owner_id, email: row.email, is_admin: !!row.is_admin };
}

/** Agent principal: `Authorization: Bearer <activation credential>`. */
function resolveAgent(req, db) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  const credential = auth.slice(7).trim();
  if (!credential) return null;

  // Lookup is by hash, so the plaintext credential never needs to be stored or
  // compared in the clear. The unique index on credential_hash makes this O(1).
  let agent = db.prepare('SELECT * FROM agents WHERE credential_hash = ?').get(sha256(credential));
  if (agent && agent.credential_expires_at && agent.credential_expires_at <= nowIso()) return null;
  if (!agent) {
    const key = db.prepare('SELECT * FROM api_keys WHERE hash=? AND revoked_at IS NULL AND expires_at>?').get(sha256(credential),nowIso());
    if (key) { agent=db.prepare('SELECT * FROM agents WHERE agent_id=?').get(key.agent_id); if(agent){agent.key_scopes=JSON.parse(key.scopes_json);agent.key_id=key.key_id;} }
  }
  return agent || null;
}

/* ------------------------------------------------------------------ */
/* Middlewares                                                         */
/* ------------------------------------------------------------------ */

function requireOwner(db) {
  return (req, res, next) => {
    const owner = resolveOwner(req, db);
    if (!owner) return res.status(401).json({ ok: false, error: 'owner_authentication_required' });
    req.owner = owner;
    next();
  };
}

function requireAgent(db) {
  return (req, res, next) => {
    const agent = resolveAgent(req, db);
    if (!agent) return res.status(401).json({ ok: false, error: 'agent_credential_required' });
    req.agent = agent;
    next();
  };
}

/**
 * Community write permission.
 *
 * A withdrawn agent keeps reading and keeps its history, but loses every write
 * permission. This is the one place that decides it.
 */
function requireVerifiedAgent(db) {
  const base = requireAgent(db);
  return (req, res, next) => base(req, res, () => {
    if (req.agent.suspended) return res.status(403).json({ok:false,error:'agent_suspended'});
    if (req.agent.status !== 'claimed') {
      return res.status(403).json({ ok: false, error: 'agent_not_claimed' });
    }
    if (req.agent.verification_state !== 'verified') {
      return res.status(403).json({
        ok: false,
        error: 'agent_not_verified',
        detail: 'Community write access requires an active verification. Historical posts remain readable.',
      });
    }
    next();
  });
}

/**
 * Admin actions (badge grant/withdraw). Backed by a deployment secret, not by
 * an owner flag on a row an owner could ever influence. An owner marked
 * is_admin in the database still cannot act as admin without this token, so
 * privilege never rides on owner-reachable state alone.
 */
function requireAdmin(db) {
  return (req, res, next) => {
    const token = readCookie(req,'amu_admin_session');
    if (db && token && db.prepare('SELECT 1 FROM admin_sessions WHERE token_hash=? AND expires_at>?').get(sha256(token),nowIso())) {req.admin=true;return next();}
    if(process.env.NODE_ENV==='production') return res.status(403).json({ok:false,error:'admin_session_required'});
    const expected = process.env.COMMUNITY_ADMIN_TOKEN;
    if (!expected) {
      return res.status(503).json({ ok: false, error: 'admin_not_configured' });
    }
    const auth = req.headers.authorization || '';
    const provided = auth.startsWith('Admin ') ? auth.slice(6).trim() : null;
    if (!provided || !require('./ids').timingSafeEqualHex(sha256(provided), sha256(expected))) {
      return res.status(403).json({ ok: false, error: 'admin_token_invalid' });
    }
    req.admin = true;
    next();
  };
}

/* ------------------------------------------------------------------ */
/* Field allowlist — the structural guard on verification badges       */
/* ------------------------------------------------------------------ */

/**
 * Everything an owner is permitted to write on their own agent. Note what is
 * absent: verification_state, status, credential_hash, owner_id, agent_id.
 *
 * This is an allowlist rather than a denylist on purpose. A denylist silently
 * grants every field somebody adds to the schema later; an allowlist silently
 * denies them, which is the safe direction for a badge that must never be
 * owner-editable.
 */
const OWNER_WRITABLE_AGENT_FIELDS = Object.freeze(['display_name']);

/** Fields that exist but are reserved to system/admin, reported distinctly. */
const SYSTEM_CONTROLLED_AGENT_FIELDS = Object.freeze([
  'verification_state', 'status', 'credential_hash', 'credential_issued_at',
  'verified_at', 'claimed_at', 'owner_id', 'agent_id',
]);

function pickAllowedFields(body, allowlist, systemControlled = []) {
  const offered = Object.keys(body || {});
  const rejected = offered.filter(f => !allowlist.includes(f));
  const systemViolations = rejected.filter(f => systemControlled.includes(f));
  const picked = {};
  for (const f of allowlist) {
    if (Object.prototype.hasOwnProperty.call(body || {}, f)) picked[f] = body[f];
  }
  return { picked, rejected, systemViolations };
}

module.exports = {
  SESSION_COOKIE,
  readCookie,
  resolveOwner,
  resolveAgent,
  requireOwner,
  requireAgent,
  requireVerifiedAgent,
  requireAdmin,
  OWNER_WRITABLE_AGENT_FIELDS,
  SYSTEM_CONTROLLED_AGENT_FIELDS,
  pickAllowedFields,
};
