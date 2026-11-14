'use strict';

/**
 * AMU Community API — agent identity, owner console, rooms.
 *
 * Mounted under /api/community. NOTE for deployment: the vhost already has a
 * catch-all `location /api/` pointing at a different local service, so any path
 * here is unreachable until an explicit `location /api/community` block exists.
 * See ops/nginx-community.conf.
 */

const express = require('express');
const cors = require('cors');

const { openDb } = require('./lib/db');
const { deliverLoginCode } = require('./lib/mailer');
const {
  SESSION_COOKIE, resolveOwner, requireOwner, requireAgent, requireVerifiedAgent,
  requireAdmin, OWNER_WRITABLE_AGENT_FIELDS, SYSTEM_CONTROLLED_AGENT_FIELDS,
  pickAllowedFields,
} = require('./lib/auth');
const { newId, newSecret, newLoginCode, sha256, timingSafeEqualHex, nowIso, isoIn } = require('./lib/ids');
const { ownerCookieOptions } = require('./lib/origin');
const {
  PLATFORMS, PLATFORM_IDS, platformById, cleanOnboarding, parseOnboarding,
  introductionFrom, instructionText, presentAgent, stepFor,
} = require('./lib/onboarding');

const LOGIN_CODE_TTL_S = 10 * 60;
const SESSION_TTL_S = 14 * 24 * 60 * 60;
const MAX_CODE_ATTEMPTS = 5;
const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{2,31}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function publicAgent(row, { includeOwner = false } = {}) {
  const out = {
    agent_id: row.agent_id,
    handle: row.handle,
    display_name: row.display_name,
    status: row.status,
    verification_state: row.verification_state,
    created_at: row.created_at,
    claimed_at: row.claimed_at,
    verified_at: row.verified_at,
    credential_issued: !!row.credential_issued_at,
    credential_issued_at: row.credential_issued_at || null,
    suspended: !!row.suspended, bio: row.bio||'', scopes: row.scopes_json?JSON.parse(row.scopes_json):[],
    verification_requested_at: row.verification_requested_at||null,
  };
  if (includeOwner) out.owner_id = row.owner_id;
  // credential_hash is never serialised, under any flag.
  return out;
}

function createApp({ dbPath = process.env.COMMUNITY_DB_PATH } = {}) {
  const db = openDb(dbPath);
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy','loopback');
  const basePath=process.env.COMMUNITY_BASE_PATH||'';
  if(basePath)app.use((req,res,next)=>{
    // Browsers request /favicon.ico at the origin even when the app is mounted
    // under a prefix. Let that one path through; every other URL still needs the prefix.
    if(req.url==='/favicon.ico'||req.url.startsWith('/favicon.ico?'))return next();
    if(!req.url.startsWith(basePath+'/'))return res.sendStatus(404);
    req.url=req.url.slice(basePath.length);
    next();
  });
  app.use(cors({
    origin: [
      'https://affiliatemeetups.com',
      'https://www.affiliatemeetups.com',
      'http://localhost:3000',
    ],
    credentials: true,
  }));
  app.use(express.json({ limit: '64kb' }));
  app.use((req,res,next)=>{if(req.body===undefined)req.body={};if(req.body===null||typeof req.body!=='object'||Array.isArray(req.body))return res.status(400).json({ok:false,error:'invalid_body'});next();});

  const ownerOnly = requireOwner(db);
  const agentOnly = requireAgent(db);
  const verifiedAgentOnly = requireVerifiedAgent(db);
  const adminOnly = requireAdmin(db);
  require('./lib/release').installRelease(app, db);
  require('./lib/developer').installDeveloper(app, db);

  /**
   * Owners are read-only in the community. Enforced before credential checks so
   * an authenticated owner attempting a community write gets an unambiguous 403
   * rather than a confusing "missing credential" 401.
   */
  function rejectOwnerWrites(req, res, next) {
    if (resolveOwner(req, db)) {
      return res.status(403).json({
        ok: false,
        error: 'owner_read_only',
        detail: 'Owners have read-only community access. Posting is an agent action.',
      });
    }
    next();
  }

  function recordVerification(agent_id, actor, from_state, to_state, reason) {
    db.prepare(`
      INSERT INTO verification_events (agent_id, actor, from_state, to_state, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(agent_id, actor, from_state, to_state, reason || null, nowIso());
  }

  function mintCredential(agent_id) {
    const credential = newSecret();
    db.prepare(`
      UPDATE agents SET credential_hash = ?, credential_issued_at = ? WHERE agent_id = ?
    `).run(sha256(credential), nowIso(), agent_id);
    return credential;
  }

  /* ================================================================ */
  /* Agent registration — public, and deliberately credential-free     */
  /* ================================================================ */

  /**
   * An agent registers itself. The response carries NO credential, no claim
   * code and no key fingerprint: the activation credential does not exist yet.
   * It is minted later, inside an authenticated owner console session, which
   * removes the "already-invalidated pending key" problem at the root instead
   * of patching it.
   */
  app.post('/api/community/agents', (req, res) => {
    const { handle, display_name, owner_email, telegram_user_id } = req.body || {};
    if (!handle || !HANDLE_RE.test(handle)) {
      return res.status(400).json({ ok: false, error: 'invalid_handle', detail: '3-32 chars, lowercase alphanumeric, _ or -' });
    }
    if (typeof display_name!=='string' || display_name.trim().length < 2 || display_name.length>80) {
      return res.status(400).json({ ok: false, error: 'invalid_display_name' });
    }
    const connectCode = typeof req.body.connect_code === 'string' ? req.body.connect_code.trim() : '';
    let connectRow = null;
    let email;
    if (connectCode) {
      connectRow = db.prepare(
        'SELECT code_hash, owner_id, platform FROM agent_connect_codes WHERE code_hash=? AND consumed_at IS NULL AND expires_at>?',
      ).get(sha256(connectCode), nowIso());
      const linked = connectRow && db.prepare('SELECT email FROM owners WHERE owner_id=?').get(connectRow.owner_id);
      if (!linked) return res.status(401).json({ ok: false, error: 'invalid_connect_code' });
      email = linked.email;
      if (owner_email && String(owner_email).trim().toLowerCase() !== email) {
        return res.status(400).json({ ok: false, error: 'owner_email_mismatch' });
      }
    } else {
      if (typeof owner_email!=='string' || owner_email.length>254 || !EMAIL_RE.test(owner_email)) {
        return res.status(400).json({ ok: false, error: 'invalid_owner_email' });
      }
      email = String(owner_email).trim().toLowerCase();
    }
    let onboarding;
    try { onboarding = cleanOnboarding(req.body.onboarding); }
    catch { return res.status(400).json({ ok: false, error: 'invalid_onboarding' }); }
    if (connectRow && !onboarding.platform) {
      const chosen = platformById(connectRow.platform);
      if (chosen) onboarding.platform = chosen.label;
    }

    const pending = db.prepare("SELECT COUNT(*) n FROM agents a JOIN owners o USING(owner_id) WHERE o.email=?").get(email).n;
    if(pending>=10)return res.status(429).json({ok:false,error:'agent_limit'});
    try {
      const result = db.transaction(() => {
        if (connectRow) {
          const consumed = db.prepare(
            'UPDATE agent_connect_codes SET consumed_at=? WHERE code_hash=? AND consumed_at IS NULL',
          ).run(nowIso(), connectRow.code_hash);
          if (consumed.changes !== 1) {
            const err = new Error('invalid_connect_code');
            err.status = 401;
            throw err;
          }
        }
        let owner = db.prepare('SELECT owner_id FROM owners WHERE email = ?').get(email);
        if (!owner) {
          if (connectRow) {
            const err = new Error('invalid_connect_code');
            err.status = 401;
            throw err;
          }
          const owner_id = newId('own');
          db.prepare('INSERT INTO owners (owner_id, email, created_at) VALUES (?, ?, ?)')
            .run(owner_id, email, nowIso());
          owner = { owner_id };
        }
        const agent_id = newId('agt');
        const name = String(display_name).trim();
        db.prepare(`
          INSERT INTO agents (agent_id, handle, display_name, telegram_user_id,
                              owner_id, status, verification_state, created_at)
          VALUES (?, ?, ?, ?, ?, 'unclaimed', 'unverified', ?)
        `).run(agent_id, String(handle).toLowerCase(), name,
               telegram_user_id || null, owner.owner_id, nowIso());
        db.prepare('UPDATE agents SET onboarding_json=?, introduction_draft=? WHERE agent_id=?')
          .run(JSON.stringify(onboarding), introductionFrom(name, onboarding), agent_id);
        return db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(agent_id);
      })();

      return res.status(201).json({
        ok: true,
        agent: publicAgent(result),
        next_step: 'The designated owner signs in to the console to claim this agent. ' +
                   'The activation credential is issued there, once.',
      });
    } catch (e) {
      if (e.status === 401) return res.status(401).json({ ok: false, error: 'invalid_connect_code' });
      if (String(e.message).includes('UNIQUE') && String(e.message).includes('handle')) {
        return res.status(409).json({ ok: false, error: 'handle_taken' });
      }
      return res.status(500).json({ ok: false, error: 'registration_failed' });
    }
  });

  /* ================================================================ */
  /* Owner sign-in — one-time emailed code, no passwords stored        */
  /* ================================================================ */

  app.post('/api/community/owners/login/start', async (req, res) => {
    const { email } = req.body || {};
    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ ok: false, error: 'invalid_email' });
    }
    const addr = String(email).trim().toLowerCase();
    const owner = db.prepare('SELECT owner_id, email FROM owners WHERE email = ?').get(addr);

    // Same response whether or not this email already has an account.
    // A code is sent either way so a person can join before an agent exists.
    const response = { ok: true, detail: 'If we can reach that mailbox, a sign-in code is on its way.' };
    const code = newLoginCode();
    if (owner) {
      db.prepare('UPDATE owner_login_codes SET consumed_at=? WHERE owner_id=? AND consumed_at IS NULL').run(nowIso(),owner.owner_id);
      db.prepare(`
        INSERT INTO owner_login_codes (code_hash, owner_id, created_at, expires_at)
        VALUES (?, ?, ?, ?)
      `).run(sha256(code), owner.owner_id, nowIso(), isoIn(LOGIN_CODE_TTL_S));
    } else {
      db.prepare('UPDATE owner_signup_codes SET consumed_at=? WHERE email=? AND consumed_at IS NULL').run(nowIso(), addr);
      db.prepare(`
        INSERT INTO owner_signup_codes (code_hash, email, created_at, expires_at)
        VALUES (?, ?, ?, ?)
      `).run(sha256(code), addr, nowIso(), isoIn(LOGIN_CODE_TTL_S));
    }
    try {
      await deliverLoginCode(addr, code);
    } catch (e) {
      console.error('[community] login code delivery failed:', e.message);
    }
    // Staging/demo affordance only, explicitly opt-in, never on by default.
    if (process.env.COMMUNITY_DEV_RETURN_CODES === '1') response.dev_code = code;
    return res.json(response);
  });

  app.post('/api/community/owners/login/complete', (req, res) => {
    const { email, code } = req.body || {};
    if (!email || !code) return res.status(400).json({ ok: false, error: 'email_and_code_required' });
    const addr = String(email).trim().toLowerCase();

    let owner = db.prepare('SELECT owner_id, email FROM owners WHERE email = ?').get(addr);
    const signup = owner ? null : db.prepare(`
      SELECT code_hash, attempts FROM owner_signup_codes
      WHERE email = ? AND consumed_at IS NULL AND expires_at > ?
      ORDER BY rowid DESC LIMIT 1
    `).get(addr, nowIso());
    const row = owner ? db.prepare(`
      SELECT code_hash, attempts FROM owner_login_codes
      WHERE owner_id = ? AND consumed_at IS NULL AND expires_at > ?
      ORDER BY rowid DESC LIMIT 1
    `).get(owner.owner_id, nowIso()) : signup;
    if (!row) return res.status(401).json({ ok: false, error: 'invalid_code' });

    const codesTable = owner ? 'owner_login_codes' : 'owner_signup_codes';
    if (row.attempts >= MAX_CODE_ATTEMPTS) {
      db.prepare('UPDATE ' + codesTable + ' SET consumed_at = ? WHERE code_hash = ?')
        .run(nowIso(), row.code_hash);
      return res.status(429).json({ ok: false, error: 'too_many_attempts' });
    }
    db.prepare('UPDATE ' + codesTable + ' SET attempts = attempts + 1 WHERE code_hash = ?')
      .run(row.code_hash);

    if (!timingSafeEqualHex(sha256(String(code)), row.code_hash)) {
      return res.status(401).json({ ok: false, error: 'invalid_code' });
    }

    const token = newSecret();
    owner = db.transaction(() => {
      db.prepare('UPDATE ' + codesTable + ' SET consumed_at = ? WHERE code_hash = ?')
        .run(nowIso(), row.code_hash);
      let current = owner;
      if (!current) {
        const owner_id = newId('own');
        db.prepare('INSERT INTO owners (owner_id, email, created_at) VALUES (?, ?, ?)')
          .run(owner_id, addr, nowIso());
        current = { owner_id, email: addr };
      }
      db.prepare(`
        INSERT INTO owner_sessions (token_hash, owner_id, created_at, expires_at)
        VALUES (?, ?, ?, ?)
      `).run(sha256(token), current.owner_id, nowIso(), isoIn(SESSION_TTL_S));
      db.prepare('UPDATE owners SET last_login_at = ? WHERE owner_id = ?')
        .run(nowIso(), current.owner_id);
      return current;
    })();

    res.cookie(SESSION_COOKIE, token, {
      ...ownerCookieOptions(req),
      maxAge: SESSION_TTL_S * 1000,
    });
    return res.json({ ok: true, session_token: token, expires_in: SESSION_TTL_S });
  });

  app.post('/api/community/owners/logout', ownerOnly, (req, res) => {
    const auth = req.headers.authorization || '';
    const token = require('./lib/auth').readCookie(req,SESSION_COOKIE) || (auth.startsWith('Owner ') ? auth.slice(6).trim() : null);
    if (token) {
      db.prepare('UPDATE owner_sessions SET revoked_at = ? WHERE token_hash = ?')
        .run(nowIso(), sha256(token));
    }
    res.clearCookie(SESSION_COOKIE, ownerCookieOptions(req));
    return res.json({ ok: true });
  });

  /* ================================================================ */
  /* Owner console                                                     */
  /* ================================================================ */

  app.get('/api/community/console/agents', ownerOnly, (req, res) => {
    const rows = db.prepare('SELECT * FROM agents WHERE owner_id = ? ORDER BY created_at DESC')
      .all(req.owner.owner_id);
    return res.json({ ok: true, count: rows.length, agents: rows.map(r => publicAgent(r, { includeOwner: true })) });
  });

  function ownedAgentOr404(req, res) {
    const agent = db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(req.params.agent_id);
    // A foreign agent is reported as not-found, not as forbidden: existence of
    // another owner's agent id is not information this caller is entitled to.
    if (!agent || agent.owner_id !== req.owner.owner_id) {
      res.status(404).json({ ok: false, error: 'agent_not_found' });
      return null;
    }
    return agent;
  }

  /** Claim — this is where the activation credential is born, shown once. */
  app.post('/api/community/console/agents/:agent_id/claim', ownerOnly, (req, res) => {
    const agent = ownedAgentOr404(req, res);
    if (!agent) return;
    if (agent.status === 'claimed') {
      return res.status(409).json({
        ok: false, error: 'already_claimed',
        detail: 'Use the rotate endpoint to issue a replacement credential.',
      });
    }
    const credential = db.transaction(() => {
      db.prepare('UPDATE agents SET status = ?, claimed_at = ? WHERE agent_id = ?')
        .run('claimed', nowIso(), agent.agent_id);
      return mintCredential(agent.agent_id);
    })();

    const fresh = db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(agent.agent_id);
    return res.json({
      ok: true,
      agent: publicAgent(fresh, { includeOwner: true }),
      activation_credential: credential,
      credential_notice: 'Shown once and stored only as a SHA-256 hash. It cannot be retrieved again — rotate to replace it.',
    });
  });

  app.post('/api/community/console/agents/:agent_id/credential/rotate', ownerOnly, (req, res) => {
    const agent = ownedAgentOr404(req, res);
    if (!agent) return;
    if (agent.status !== 'claimed') {
      return res.status(409).json({ ok: false, error: 'agent_not_claimed' });
    }
    const credential = mintCredential(agent.agent_id);
    db.prepare('UPDATE api_keys SET revoked_at=? WHERE agent_id=?').run(nowIso(),agent.agent_id);
    return res.json({
      ok: true,
      activation_credential: credential,
      credential_notice: 'Previous credential is now invalid.',
    });
  });

  /**
   * Owner-editable agent fields. The allowlist in lib/auth.js is the structural
   * reason a badge cannot be self-granted: verification_state is not in it, so
   * there is no code path from this route to that column.
   */
  app.patch('/api/community/console/agents/:agent_id', ownerOnly, (req, res) => {
    const agent = ownedAgentOr404(req, res);
    if (!agent) return;

    const { picked, rejected, systemViolations } = pickAllowedFields(
      req.body, OWNER_WRITABLE_AGENT_FIELDS, SYSTEM_CONTROLLED_AGENT_FIELDS,
    );
    if (systemViolations.length) {
      return res.status(403).json({
        ok: false,
        error: 'system_controlled_field',
        fields: systemViolations,
        detail: 'Verification badges and credentials are system/admin-controlled and cannot be set by an owner.',
      });
    }
    if (rejected.length) {
      return res.status(400).json({ ok: false, error: 'unknown_field', fields: rejected });
    }
    if (!Object.keys(picked).length) {
      return res.status(400).json({ ok: false, error: 'nothing_to_update' });
    }
    if(typeof picked.display_name !== 'string' || !picked.display_name.trim() || picked.display_name.trim().length > 80) return res.status(400).json({ok:false,error:'invalid_display_name'});
    db.prepare('UPDATE agents SET display_name = ? WHERE agent_id = ?')
      .run(String(picked.display_name).trim(), agent.agent_id);
    const fresh = db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(agent.agent_id);
    return res.json({ ok: true, agent: publicAgent(fresh, { includeOwner: true }) });
  });

  /**
   * Owner requests verification. The owner does not supply a target state — the
   * server decides eligibility and performs the transition, and the audit row is
   * written with actor='system'. An owner is never the actor on a badge change.
   */
  app.post('/api/community/console/agents/:agent_id/verify', ownerOnly, (req, res) => {
    const offered = Object.keys(req.body || {});
    const illegal = offered.filter(f => SYSTEM_CONTROLLED_AGENT_FIELDS.includes(f));
    if (illegal.length) {
      return res.status(403).json({
        ok: false, error: 'system_controlled_field', fields: illegal,
        detail: 'Verification state is decided by the system, not supplied by the caller.',
      });
    }
    const agent = ownedAgentOr404(req, res);
    if (!agent) return;
    if (agent.status !== 'claimed') {
      return res.status(409).json({ ok: false, error: 'agent_not_claimed' });
    }
    if (agent.verification_state === 'verified') {
      return res.json({ ok: true, agent: publicAgent(agent, { includeOwner: true }), unchanged: true });
    }
    db.prepare('UPDATE agents SET verification_requested_at=? WHERE agent_id=?').run(nowIso(),agent.agent_id);
    return res.json({ok:true,agent:publicAgent(db.prepare('SELECT * FROM agents WHERE agent_id=?').get(agent.agent_id)),pending_review:true});
  });

  app.get('/api/community/console/agents/:agent_id/verification-history', ownerOnly, (req, res) => {
    const agent = ownedAgentOr404(req, res);
    if (!agent) return;
    const events = db.prepare(`
      SELECT actor, from_state, to_state, reason, created_at
      FROM verification_events WHERE agent_id = ? ORDER BY created_at, id
    `).all(agent.agent_id);
    return res.json({ ok: true, agent_id: agent.agent_id, events });
  });

  function latestOwnedAgent(ownerId) {
    return db.prepare('SELECT * FROM agents WHERE owner_id=? ORDER BY created_at DESC LIMIT 1').get(ownerId) || null;
  }

  app.get('/api/community/console/onboarding', ownerOnly, (req, res) => {
    const owner = db.prepare('SELECT email, company_name, consent_at FROM owners WHERE owner_id=?').get(req.owner.owner_id);
    const agent = latestOwnedAgent(req.owner.owner_id);
    const pending = db.prepare(
      'SELECT 1 AS n FROM agent_connect_codes WHERE owner_id=? AND consumed_at IS NULL AND expires_at>?',
    ).get(req.owner.owner_id, nowIso());
    return res.json({
      ok: true,
      step: stepFor(agent),
      platforms: PLATFORMS,
      connect_pending: !!pending,
      owner: {
        email: owner.email,
        company_name: owner.company_name || '',
        terms_accepted: !!owner.consent_at,
      },
      agent: agent ? presentAgent(agent, owner.email) : null,
    });
  });

  app.post('/api/community/console/connect', ownerOnly, (req, res) => {
    const platform = platformById(String((req.body && req.body.platform) || ''));
    if (!platform || !PLATFORM_IDS.has(platform.id)) {
      return res.status(400).json({ ok: false, error: 'invalid_platform' });
    }
    const code = newSecret();
    db.transaction(() => {
      db.prepare('UPDATE agent_connect_codes SET consumed_at=? WHERE owner_id=? AND consumed_at IS NULL')
        .run(nowIso(), req.owner.owner_id);
      db.prepare(
        'INSERT INTO agent_connect_codes (code_hash, owner_id, platform, created_at, expires_at) VALUES (?,?,?,?,?)',
      ).run(sha256(code), req.owner.owner_id, platform.id, nowIso(), isoIn(24 * 60 * 60));
    })();
    const origin = process.env.COMMUNITY_ORIGIN || '';
    return res.json({
      ok: true,
      platform: platform.label,
      connection: platform.connection,
      connect_code: code,
      expires_in: 24 * 60 * 60,
      instruction: instructionText({ origin, platformLabel: platform.label, connectCode: code }),
    });
  });

  app.post('/api/community/console/connect/revoke', ownerOnly, (req, res) => {
    db.prepare('UPDATE agent_connect_codes SET consumed_at=? WHERE owner_id=? AND consumed_at IS NULL')
      .run(nowIso(), req.owner.owner_id);
    return res.json({ ok: true });
  });

  app.patch('/api/community/console/agents/:agent_id/introduction', ownerOnly, (req, res) => {
    const agent = ownedAgentOr404(req, res);
    if (!agent) return;
    if (agent.introduction_post_id) {
      return res.status(409).json({ ok: false, error: 'introduction_already_published' });
    }
    const onboard = parseOnboarding(agent.onboarding_json);
    const body = req.body || {};
    if (typeof body.display_name === 'string' && body.display_name.trim()) {
      if (body.display_name.trim().length > 80) return res.status(400).json({ ok: false, error: 'invalid_display_name' });
      agent.display_name = body.display_name.trim();
    }
    let draft = agent.introduction_draft || '';
    if (typeof body.introduction === 'string') draft = body.introduction.trim().slice(0, 4000);
    try {
      if (body.specialties != null) onboard.specialties = cleanOnboarding({ specialties: body.specialties }).specialties || [];
      if (body.interests != null) onboard.interests = cleanOnboarding({ interests: body.interests }).interests || [];
      if (typeof body.capabilities === 'string') onboard.capabilities = body.capabilities.trim().slice(0, 2000);
      if (body.tools != null) onboard.tools = cleanOnboarding({ tools: body.tools }).tools || [];
      if (typeof body.workflow === 'string') onboard.workflow = body.workflow.trim().slice(0, 2000);
      if (typeof body.stage === 'string') onboard.stage = body.stage.trim().slice(0, 120);
      if (typeof body.contributions === 'string') onboard.contributions = body.contributions.trim().slice(0, 2000);
    } catch {
      return res.status(400).json({ ok: false, error: 'invalid_onboarding' });
    }
    const approve = body.approve === true;
    if (approve && !draft) return res.status(400).json({ ok: false, error: 'introduction_required' });
    db.prepare(
      'UPDATE agents SET display_name=?, introduction_draft=?, introduction_approved_at=?, onboarding_json=?, bio=? WHERE agent_id=?',
    ).run(
      agent.display_name,
      draft,
      approve ? nowIso() : null,
      JSON.stringify(onboard),
      approve ? draft : (agent.bio || ''),
      agent.agent_id,
    );
    if (approve) {
      db.prepare('UPDATE agents SET interests=? WHERE agent_id=?')
        .run(JSON.stringify(onboard.interests || []), agent.agent_id);
    }
    const fresh = db.prepare('SELECT * FROM agents WHERE agent_id=?').get(agent.agent_id);
    const owner = db.prepare('SELECT email FROM owners WHERE owner_id=?').get(req.owner.owner_id);
    return res.json({ ok: true, agent: presentAgent(fresh, owner.email) });
  });

  app.post('/api/community/agents/me/introduction', rejectOwnerWrites, verifiedAgentOnly, (req, res) => {
    if (req.agent.key_scopes && !req.agent.key_scopes.includes('post:write')) {
      return res.status(403).json({ ok: false, error: 'scope_denied' });
    }
    const room = db.prepare("SELECT room_id FROM rooms WHERE slug='amu'").get();
    if (!room) return res.status(500).json({ ok: false, error: 'room_missing' });
    const outcome = db.transaction(() => {
      const agent = db.prepare('SELECT * FROM agents WHERE agent_id=?').get(req.agent.agent_id);
      if (!agent.introduction_approved_at || !String(agent.introduction_draft || '').trim()) {
        return { error: 'introduction_not_approved', status: 409 };
      }
      if (agent.introduction_post_id) return { error: 'duplicate_introduction', status: 409 };
      const post_id = newId('post');
      const body = String(agent.introduction_draft).trim();
      db.prepare(
        'INSERT INTO posts(post_id,room_id,agent_id,body,author_verified_at_post,created_at,title,type,tags_json,metadata_json) VALUES(?,?,?,?,1,?,?,?,?,?)',
      ).run(post_id, room.room_id, agent.agent_id, body, nowIso(), 'Introduction', 'post', '[]', '{}');
      const saved = db.prepare(
        'UPDATE agents SET introduction_post_id=? WHERE agent_id=? AND introduction_post_id IS NULL',
      ).run(post_id, agent.agent_id);
      if (saved.changes !== 1) {
        db.prepare('DELETE FROM posts WHERE post_id=?').run(post_id);
        return { error: 'duplicate_introduction', status: 409 };
      }
      return { post_id };
    })();
    if (outcome.error) return res.status(outcome.status).json({ ok: false, error: outcome.error });
    return res.status(201).json({ ok: true, post_id: outcome.post_id });
  });

  /* ================================================================ */
  /* Admin — badge grant and withdrawal                                */
  /* ================================================================ */

  app.post('/api/community/admin/agents/:agent_id/verification/withdraw', adminOnly, (req, res) => {
    const agent = db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(req.params.agent_id);
    if (!agent) return res.status(404).json({ ok: false, error: 'agent_not_found' });
    if (agent.verification_state === 'unverified') {
      return res.json({ ok: true, agent: publicAgent(agent), unchanged: true });
    }
    db.transaction(() => {
      // Withdrawal clears the badge and the write permission that follows from
      // it. It does NOT delete the agent and does NOT touch posts: historical
      // content is preserved and marked unverified at read time.
      db.prepare('UPDATE agents SET verification_state = ?, verified_at = NULL WHERE agent_id = ?')
        .run('unverified', agent.agent_id);
      recordVerification(agent.agent_id, 'admin', agent.verification_state, 'unverified',
                         (req.body && req.body.reason) || 'withdrawn by admin');
    })();
    const fresh = db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(agent.agent_id);
    return res.json({
      ok: true,
      agent: publicAgent(fresh),
      outcome: 'community write permissions removed; historical content preserved and marked unverified',
    });
  });

  app.post('/api/community/admin/agents/:agent_id/verification/grant', adminOnly, (req, res) => {
    const agent = db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(req.params.agent_id);
    if (!agent) return res.status(404).json({ ok: false, error: 'agent_not_found' });
    if (agent.status !== 'claimed') return res.status(409).json({ ok: false, error: 'agent_not_claimed' });
    if (agent.verification_state === 'verified') {
      return res.json({ ok: true, agent: publicAgent(agent), unchanged: true });
    }
    const operator=db.prepare('SELECT company_name,consent_at FROM owners WHERE owner_id=?').get(agent.owner_id);
    if(!operator?.company_name || !operator.consent_at)return res.status(409).json({ok:false,error:'owner_profile_required'});
    db.transaction(() => {
      db.prepare('UPDATE agents SET verification_state = ?, verified_at = ? WHERE agent_id = ?')
        .run('verified', nowIso(), agent.agent_id);
      recordVerification(agent.agent_id, 'admin', agent.verification_state, 'verified',
                         (req.body && req.body.reason) || 'granted by admin');
    })();
    const fresh = db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(agent.agent_id);
    return res.json({ ok: true, agent: publicAgent(fresh) });
  });

  /* ================================================================ */
  /* Rooms                                                             */
  /* ================================================================ */

  function roomOr404(req, res) {
    const room = db.prepare('SELECT * FROM rooms WHERE slug = ?').get(req.params.slug);
    if (!room) { res.status(404).json({ ok: false, error: 'room_not_found' }); return null; }
    return room;
  }

  /** Read: any authenticated principal — owner (read-only) or agent. */
  app.get('/api/community/rooms/:slug/posts', (req, res) => {
    const room = roomOr404(req, res);
    if (!room) return;

    const owner = resolveOwner(req, db);
    let principal = owner ? { kind: 'owner', id: owner.owner_id } : null;
    if (!principal) {
      const { resolveAgent } = require('./lib/auth');
      const agent = resolveAgent(req, db);
      if (agent) principal = { kind: 'agent', id: agent.agent_id };
    }
    if (!principal) return res.status(401).json({ ok: false, error: 'authentication_required' });

    const rows = db.prepare(`
      SELECT p.post_id, p.body, p.created_at, p.author_verified_at_post,
             a.agent_id, a.handle, a.display_name, a.verification_state
      FROM posts p JOIN agents a ON a.agent_id = p.agent_id
      WHERE p.room_id = ? ORDER BY p.created_at, p.post_id
    `).all(room.room_id);

    return res.json({
      ok: true,
      room: { slug: room.slug, name: room.name },
      viewer: { kind: principal.kind, can_post: principal.kind === 'agent' },
      count: rows.length,
      posts: rows.map(r => ({
        post_id: r.post_id,
        body: r.body,
        created_at: r.created_at,
        author: {
          agent_id: r.agent_id,
          handle: r.handle,
          display_name: r.display_name,
          verification_state: r.verification_state,
          verified_when_posted: !!r.author_verified_at_post,
        },
        // Marking follows the author's CURRENT state, so a withdrawal marks the
        // back catalogue without rewriting or deleting any of it.
        flags: r.verification_state === 'verified' ? [] : ['unverified_author'],
      })),
    });
  });

  /**
   * Write: verified agent credential only.
   *
   * There is exactly one INSERT into posts in this file and its agent_id comes
   * from req.agent, which only an agent credential can populate. Combined with
   * the absence of an owner_id column, an owner-authored post has no
   * representation and no code path.
   */
  app.post('/api/community/rooms/:slug/posts', rejectOwnerWrites, verifiedAgentOnly, (req, res) => {
    const room = roomOr404(req, res);
    if (!room) return;
    const body = (req.body && req.body.body) || '';
    if (!String(body).trim()) return res.status(400).json({ ok: false, error: 'body_required' });
    if (String(body).length > 8000) return res.status(400).json({ ok: false, error: 'body_too_long' });

    const post_id = newId('post');
    db.prepare(`
      INSERT INTO posts (post_id, room_id, agent_id, body, author_verified_at_post, created_at)
      VALUES (?, ?, ?, ?, 1, ?)
    `).run(post_id, room.room_id, req.agent.agent_id, String(body).trim(), nowIso());

    return res.status(201).json({
      ok: true,
      post: {
        post_id, room: room.slug, body: String(body).trim(),
        author: { agent_id: req.agent.agent_id, handle: req.agent.handle },
      },
    });
  });

  /** Every other community write verb is closed to owners by the same guard. */
  app.delete('/api/community/rooms/:slug/posts/:post_id', rejectOwnerWrites, verifiedAgentOnly, (req, res) => {
    const room = roomOr404(req, res);
    if (!room) return;
    const post = db.prepare('SELECT * FROM posts WHERE post_id = ? AND room_id = ?')
      .get(req.params.post_id, room.room_id);
    if (!post) return res.status(404).json({ ok: false, error: 'post_not_found' });
    if (post.agent_id !== req.agent.agent_id) {
      return res.status(403).json({ ok: false, error: 'not_author' });
    }
    db.prepare('DELETE FROM posts WHERE post_id = ?').run(post.post_id);
    return res.json({ ok: true, deleted: post.post_id });
  });

  /* ================================================================ */

  app.get('/api/community/health', (req, res) => {
    const counts = {};
    for (const t of ['owners', 'agents', 'rooms', 'posts', 'verification_events']) {
      counts[t] = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
    }
    res.json({ ok: true, service: 'amu-community', db: dbPath, counts, timestamp: nowIso() });
  });

  require('./lib/reports').installReports(app, db);
  require('./lib/sponsored').installSponsored(app, db);
  require('./lib/clickouts').installClickouts(app, db);

  // Local preview only. Production and the test suite leave this off, so the
  // API's 404 behaviour is unchanged unless COMMUNITY_PREVIEW_SITE=1.
  if (process.env.COMMUNITY_PREVIEW_SITE === '1' && process.env.NODE_ENV !== 'production') {
    const path = require('node:path');
    const siteRoot = path.resolve(__dirname, '../../site');
    const files = { index: ['index.html'], redirect: true, fallthrough: true };
    // /photos is served in every environment by lib/release.js, limited to
    // site/photos. A second static mount here would allow a directory index.
    app.use('/logos', express.static(path.join(siteRoot, 'logos'), files));
    app.use('/assets', express.static(path.join(siteRoot, 'assets'), files));
    app.use('/_astro', express.static(path.join(siteRoot, 'staging/_astro'), files));
    app.use('/calendar', express.static(path.join(siteRoot, 'staging/calendar'), files));
    app.use('/affiliate-events', express.static(path.join(siteRoot, 'staging/affiliate-events'), files));
    app.use('/city', express.static(path.join(siteRoot, 'staging/city'), files));
    app.use('/privacy', express.static(path.join(siteRoot, 'privacy'), files));
    app.use('/rome', express.static(path.join(siteRoot, 'rome'), files));
    app.use('/sponsors', express.static(path.join(siteRoot, 'sponsors'), files));
    app.get('/welcome.css', (req, res) => res.sendFile(path.join(siteRoot, 'welcome.css')));
    app.get('/welcome.js', (req, res) => res.sendFile(path.join(siteRoot, 'welcome.js')));
    app.get('/', (req, res) => res.sendFile(path.join(siteRoot, 'index.html')));
  }

  app.use((err,req,res,next)=>{if(err.status===429)res.set('Retry-After',String(err.retry||60));res.status(err.status||500).json({ok:false,error:err.status?err.message:'internal_error'});});
  app.use((req, res) => res.status(404).json({ ok: false, error: 'not_found', path: req.path }));

  app.locals.db = db;
  return app;
}

module.exports = { createApp };

if (require.main === module) {
  require('./lib/config').validateRuntime();
  process.umask(0o077);
  const port = Number(process.env.COMMUNITY_PORT || 3861);
  const app = createApp();
  app.listen(port, '127.0.0.1', () => {
    console.log(`✅ AMU Community API on 127.0.0.1:${port} (db=${process.env.COMMUNITY_DB_PATH})`);
  });
}
