'use strict';

/**
 * Browser origin and session-cookie rules.
 *
 * Staging operators open the UI through an SSH tunnel, so the browser's Origin
 * is http://127.0.0.1:8080 or http://localhost:8080 while COMMUNITY_ORIGIN stays
 * the public HTTPS site. Those tunnel origins are allowed only when they are
 * listed in COMMUNITY_TUNNEL_ORIGINS. The list cannot name a public host.
 * Unset, the check is COMMUNITY_ORIGIN and its www sibling, and nothing else.
 *
 * The www sibling is why signup returned origin_not_allowed in production:
 * affiliatemeetups.com and www.affiliatemeetups.com both serve the site on the
 * same certificate with no redirect between them, so a visitor who landed on
 * www sent Origin: https://www.affiliatemeetups.com while COMMUNITY_ORIGIN was
 * the apex, and every POST was rejected. The pair is derived from
 * COMMUNITY_ORIGIN alone - same scheme, same port, the host with or without a
 * single leading "www." - so no configuration can widen it to a third host and
 * the check stays fail-closed. A redirect in nginx would also fix the symptom,
 * but the app must not depend on a server rule it cannot see.
 *
 * A mutation that carries a cookie and no Origin is still rejected.
 *
 * Secure cookies are kept for the HTTPS origin. An allowlisted HTTP loopback
 * page only gets a non-Secure cookie when the request host is loopback too.
 * SameSite stays lax (owner) or strict (admin). Browsers do not reliably store
 * a Secure cookie for http://127.0.0.1, so leaving Secure on would drop the
 * session after the origin check had already succeeded.
 */

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function primaryOrigin(env = process.env) {
  return env.COMMUNITY_ORIGIN || 'https://affiliatemeetups.com';
}

/**
 * The configured origin plus its www sibling, and nothing else.
 *
 * Same scheme and same port; only the single leading "www." label differs. An
 * unparseable COMMUNITY_ORIGIN yields the literal string on its own, so a
 * misconfiguration narrows the allowlist instead of widening it.
 *
 * @returns {string[]}
 */
function siteOrigins(env = process.env) {
  const primary = primaryOrigin(env);
  const url = parseOrigin(primary);
  if (!url) return [primary];
  const host = url.hostname.toLowerCase();
  // A loopback or bare host has no www sibling to pair with.
  if (isLoopbackHost(host) || !host.includes('.')) return [primary];
  const sibling = host.startsWith('www.') ? host.slice(4) : 'www.' + host;
  if (!sibling.includes('.')) return [primary];
  const other = new URL(primary);
  other.hostname = sibling;
  return primary === other.origin ? [primary] : [primary, other.origin];
}

function parseOrigin(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.origin !== value) return null;
  if (url.username || url.password) return null;
  return url;
}

function isLoopbackHost(host) {
  if (!host || typeof host !== 'string') return false;
  return LOOPBACK.has(host.toLowerCase());
}

/**
 * @returns {{ origins: string[], errors: string[] }}
 * One rejected entry discards the whole extra list (fail closed).
 */
function tunnelOriginList(env = process.env) {
  const raw = env.COMMUNITY_TUNNEL_ORIGINS;
  if (raw == null || String(raw).trim() === '') return { origins: [], errors: [] };
  const errors = [];
  const origins = [];
  const seen = new Set();
  for (const part of String(raw).split(',')) {
    const entry = part.trim();
    if (!entry) continue;
    const url = parseOrigin(entry);
    const loopback = url && isLoopbackHost(url.hostname);
    const schemeOk = url && (url.protocol === 'http:' || url.protocol === 'https:');
    if (!url || !schemeOk || !loopback || !url.port) {
      if (errors.length === 0) {
        errors.push(
          'COMMUNITY_TUNNEL_ORIGINS only accepts loopback http(s) origins with an explicit port (127.0.0.1, localhost, or ::1). Public hosts stay on COMMUNITY_ORIGIN.',
        );
      }
      continue;
    }
    if (!seen.has(url.origin)) {
      seen.add(url.origin);
      origins.push(url.origin);
    }
  }
  if (errors.length) return { origins: [], errors };
  return { origins, errors };
}

function allowedOriginSet(env = process.env) {
  const site = siteOrigins(env);
  const { origins, errors } = tunnelOriginList(env);
  if (errors.length) return new Set(site);
  return new Set([...site, ...origins]);
}

function originAllowed(originHeader, env = process.env) {
  if (!originHeader) return false;
  return allowedOriginSet(env).has(originHeader);
}

function assertTunnelOrigins(env = process.env) {
  return tunnelOriginList(env).errors;
}

function requestOrigin(req) {
  if (req && typeof req.get === 'function') return req.get('origin');
  const headers = (req && req.headers) || {};
  return headers.origin || headers.Origin || '';
}

function sessionCookieSecure(req, env = process.env) {
  const origin = parseOrigin(requestOrigin(req));
  const host = (req && req.hostname) || '';
  if (
    origin &&
    origin.protocol === 'http:' &&
    isLoopbackHost(origin.hostname) &&
    isLoopbackHost(host) &&
    originAllowed(origin.origin, env)
  ) {
    return false;
  }
  return true;
}

function ownerCookieOptions(req, env = process.env) {
  return {
    httpOnly: true,
    secure: sessionCookieSecure(req, env),
    sameSite: 'lax',
    path: '/',
  };
}

function adminCookieOptions(req, env = process.env) {
  return {
    httpOnly: true,
    secure: sessionCookieSecure(req, env) ? env.NODE_ENV !== 'test' : false,
    sameSite: 'strict',
    path: '/',
  };
}

module.exports = {
  primaryOrigin,
  siteOrigins,
  parseOrigin,
  isLoopbackHost,
  tunnelOriginList,
  allowedOriginSet,
  originAllowed,
  assertTunnelOrigins,
  sessionCookieSecure,
  ownerCookieOptions,
  adminCookieOptions,
};
