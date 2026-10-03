#!/usr/bin/env node
/**
 * AMU Platform — Link summarizer (Phase L4, "Link Feed … with AI summary").
 *
 * L4.6 wired the ingest so every URL shared in AMU lands in the `links` table, but
 * left `ai_summary` as a declared-and-never-populated column — the plan's own
 * follow-up. This fills it.
 *
 * Design notes:
 *  - Summarizes by DISTINCT url, not per row: the same link shared twice is one
 *    fetch and one model call, written back to every row carrying that URL.
 *  - Idempotent: only picks up rows with no summary. A URL that failed stamps
 *    `summarized_at` without a summary, so it is retried on the next run only
 *    after RETRY_AFTER_DAYS instead of being hammered every hour.
 *  - Page fetch is capped (bytes, redirects, time) and failures are non-fatal:
 *    a dead link must not take the whole batch down.
 *
 * Usage: node summarize-links.js [--limit N] [--dry]
 */
const https = require('https');
const http = require('http');
const Database = require('better-sqlite3');
const { getProvider, callClaude, MODEL } = require('./anthropic-lib');

const DB_PATH = '/home/xenhive/amu-platform/stats.db';
const MAX_BYTES = 200_000;      // stop reading a page after this much HTML
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 4;
const RETRY_AFTER_DAYS = 7;
const MAX_TEXT_CHARS = 6_000;   // what we hand to the model

function fetchPage(url, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    let mod;
    try {
      mod = new URL(url).protocol === 'http:' ? http : https;
    } catch (e) { return reject(new Error('bad url')); }

    const req = mod.get(url, {
      timeout: FETCH_TIMEOUT_MS,
      headers: { 'User-Agent': 'AMU-LinkSummarizer/1.0 (+https://affiliatemeetups.com)' },
    }, (res) => {
      const loc = res.headers.location;
      if (res.statusCode >= 300 && res.statusCode < 400 && loc) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('too many redirects'));
        return resolve(fetchPage(new URL(loc, url).toString(), redirectsLeft - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const type = res.headers['content-type'] || '';
      if (!/text\/html|text\/plain|application\/xhtml/i.test(type)) {
        res.resume();
        return reject(new Error(`not a page (${type.split(';')[0] || 'unknown'})`));
      }
      let data = '';
      res.on('data', (c) => {
        data += c;
        if (data.length > MAX_BYTES) { data = data.slice(0, MAX_BYTES); res.destroy(); }
      });
      res.on('end', () => resolve(data));
      res.on('close', () => resolve(data));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

function extract(html) {
  const pick = (re) => (html.match(re) || [])[1];
  const title = pick(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const desc = pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
    || pick(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    title: (title || '').replace(/\s+/g, ' ').trim(),
    desc: (desc || '').trim(),
    text: text.slice(0, MAX_TEXT_CHARS),
  };
}

function buildPrompt(url, page) {
  return `You are writing one-line summaries for a link feed in an affiliate-marketing community (AMU).

URL: ${url}
Page title: ${page.title || '(none)'}
Meta description: ${page.desc || '(none)'}

Page text (truncated):
"""
${page.text || '(no readable text)'}
"""

Write ONE sentence (max 25 words) saying what this link is and why an affiliate marketer would open it. Be concrete and factual — no marketing language, no "this article discusses". If the page content is unusable (login wall, error page, empty), reply exactly: UNUSABLE

Reply with the sentence only, nothing else.`;
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const limIdx = args.indexOf('--limit');
  const limit = limIdx !== -1 ? parseInt(args[limIdx + 1], 10) : 50;

  const provider = getProvider();
  if (!provider) { console.error('FATAL — no Anthropic provider resolved'); process.exit(1); }

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  const cutoff = new Date(Date.now() - RETRY_AFTER_DAYS * 86400000).toISOString();
  const urls = db.prepare(`
    SELECT url, COUNT(*) AS rows_
    FROM links
    WHERE ai_summary IS NULL
      AND (summarized_at IS NULL OR summarized_at < ?)
    GROUP BY url
    ORDER BY MAX(timestamp) DESC
    LIMIT ?
  `).all(cutoff, limit);

  if (!urls.length) { console.log('nothing to summarize'); db.close(); return; }
  console.log(`${urls.length} distinct URL(s) to summarize with ${MODEL} via ${provider.baseUrl}${dry ? ' (dry run)' : ''}`);

  const write = db.prepare(
    'UPDATE links SET ai_summary = ?, summarized_at = ? WHERE url = ? AND ai_summary IS NULL'
  );
  const stamp = db.prepare(
    'UPDATE links SET summarized_at = ? WHERE url = ? AND ai_summary IS NULL'
  );

  let ok = 0, skipped = 0;
  for (const { url, rows_ } of urls) {
    const now = new Date().toISOString();
    try {
      const page = extract(await fetchPage(url));
      if (!page.title && !page.desc && !page.text) throw new Error('empty page');
      const summary = (await callClaude(buildPrompt(url, page), provider, 200)).trim();
      if (!summary || /^UNUSABLE$/i.test(summary)) throw new Error('model says unusable');
      if (dry) { console.log(`  [dry] ${url}\n        ${summary}`); ok++; continue; }
      const res = write.run(summary, now, url);
      ok++;
      console.log(`  ✅ ${url} (${res.changes}/${rows_} row(s))\n     ${summary}`);
    } catch (e) {
      skipped++;
      // Stamp the attempt so a permanently dead link isn't retried every run.
      if (!dry) stamp.run(now, url);
      console.log(`  ⏭️  ${url} — ${e.message}`);
    }
  }

  const left = db.prepare('SELECT COUNT(*) c FROM links WHERE ai_summary IS NULL').get().c;
  console.log(`done: ${ok} summarized, ${skipped} skipped; ${left} row(s) still without a summary`);
  db.close();
}

main().catch((e) => { console.error('FATAL —', e.message); process.exit(1); });
