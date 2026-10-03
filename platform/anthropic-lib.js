/**
 * Shared Anthropic access for the AMU platform.
 *
 * Extracted from generate-digest.js so the link summarizer reuses one code path
 * instead of a second copy that could drift — and because the original was broken
 * in two ways that made it fail silently. Both are fixed here:
 *
 * 1. KEY LOOKUP. It did `for (const p of providers)`, but `models.providers` in
 *    openclaw.json is an OBJECT keyed by provider name ("anthropic",
 *    "anthropic-hawk", "groq", …), not an array. `for…of` on an object throws
 *    TypeError, the surrounding try/catch swallowed it, and the function returned
 *    null. Consequence: the Daily Digest NEVER called Claude — every summary since
 *    April was the hardcoded "N messages from M members" fallback and
 *    key_takeaways was always []. It logged "✅ Digest generated" regardless.
 *
 * 2. ENDPOINT. It posted straight to api.anthropic.com. Every fleet provider entry
 *    carries a placeholder key (`sk-ant-unused-…`) and a baseUrl pointing at
 *    BRAINSTEM (:29800), which injects the real credential and records the spend.
 *    Calling the API directly would have worked only via the one `anthropic-direct`
 *    profile and would have made this usage invisible to the cost dashboards. We
 *    honour whatever baseUrl the chosen provider declares.
 *
 * ⚠️ Model is claude-haiku-4-5 — the project's existing choice for summarization,
 * kept deliberately. Change it here and both callers follow.
 */
const https = require('https');
const http = require('http');
const { URL } = require('url');

const CONFIG_FILE = '/home/xenhive/.openclaw/openclaw.json';
const MODEL = 'claude-haiku-4-5';
const DEFAULT_PROVIDER = 'anthropic';

/**
 * Resolve {apiKey, baseUrl} for a provider. Accepts both the object-keyed shape
 * used today and a plain array, so a future config normalization can't re-break it.
 */
function getProvider(name = DEFAULT_PROVIDER) {
  try {
    const config = JSON.parse(require('fs').readFileSync(CONFIG_FILE, 'utf8'));
    const providers = (config.models || {}).providers || {};
    const entries = Array.isArray(providers)
      ? providers.map(p => [p.provider || p.name, p])
      : Object.entries(providers);
    const found = entries.find(([n, p]) => n === name && p && p.apiKey);
    if (found) {
      const p = found[1];
      return { apiKey: p.apiKey, baseUrl: p.baseUrl || p.baseURL || 'https://api.anthropic.com' };
    }
  } catch (e) { /* fall through to env */ }
  if (process.env.ANTHROPIC_API_KEY) {
    return { apiKey: process.env.ANTHROPIC_API_KEY, baseUrl: 'https://api.anthropic.com' };
  }
  return null;
}

/** Back-compat with the original signature. */
function getAnthropicKey(name = DEFAULT_PROVIDER) {
  const p = getProvider(name);
  return p ? p.apiKey : null;
}

function callClaude(prompt, provider, maxTokens = 1024) {
  // Accept either a {apiKey, baseUrl} object or a bare key string (old call shape).
  const { apiKey, baseUrl } = typeof provider === 'string'
    ? { apiKey: provider, baseUrl: 'https://api.anthropic.com' }
    : provider;

  return new Promise((resolve, reject) => {
    const target = new URL('/v1/messages', baseUrl);
    const mod = target.protocol === 'http:' ? http : https;
    const body = JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    });
    const req = mod.request({
      hostname: target.hostname,
      port: target.port || undefined,
      path: target.pathname,
      method: 'POST',
      timeout: 60_000,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); }
        catch (e) { return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 160)}`)); }
        // Surface API errors instead of returning '' — the original swallowed them,
        // which is exactly how a dead key reads as "the model had nothing to say".
        if (parsed.type === 'error' || res.statusCode >= 400) {
          return reject(new Error(`${parsed.error?.type || res.statusCode}: ${parsed.error?.message || data.slice(0, 160)}`));
        }
        resolve(parsed.content?.[0]?.text || '');
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = { getProvider, getAnthropicKey, callClaude, MODEL, DEFAULT_PROVIDER };
