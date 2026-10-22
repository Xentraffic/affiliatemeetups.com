#!/usr/bin/env node
/**
 * BuyGoods / ClickCRM affiliate API client (zero dependencies, Node 18+).
 *
 * Credentials come from the environment (see .env.example):
 *   BUYGOODS_ACCOUNT_ID  (defaults to config.json account_id)
 *   BUYGOODS_TOKEN       raw, URL-decoded token
 *
 * Module usage:
 *   const bg = require('./integrations/buygoods/client');
 *   const rows = await bg.salesByDay({ dateFrom: '2026-07-19', dateTo: '2026-09-16' });
 *
 * CLI usage:
 *   node integrations/buygoods/client.js <report> --from YYYY-MM-DD --to YYYY-MM-DD [--csv] [--all]
 *   reports: customers | conversions | commissions-legacy | byday | byhour | bysubid | bysubid2 | commissions
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

// Minimal .env loader (no dotenv dependency). Does not override existing env.
function loadDotEnv() {
  const candidates = [path.join(__dirname, '..', '..', '.env'), path.join(process.cwd(), '.env')];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
      if (!m || line.trim().startsWith('#')) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
    return;
  }
}
loadDotEnv();

function credentials() {
  const token = process.env[CONFIG.token_env];
  if (!token) {
    throw new Error(
      `${CONFIG.token_env} is not set. Copy .env.example to .env and add the BuyGoods token, ` +
        `or export it in the environment.`
    );
  }
  const accountId = process.env[CONFIG.account_id_env] || CONFIG.account_id;
  return { token, accountId };
}

function assertDate(label, value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) {
    throw new Error(`${label} must be YYYY-MM-DD, got: ${value}`);
  }
}

async function request(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json, text/csv;q=0.9, */*;q=0.8' } });
  const text = await res.text();
  if (!res.ok) throw new Error(`BuyGoods API ${res.status} for ${url.split('token=')[0]}token=***: ${text.slice(0, 300)}`);
  const type = res.headers.get('content-type') || '';
  if (type.includes('json') || /^\s*[\[{]/.test(text)) {
    try {
      return JSON.parse(text);
    } catch {
      /* fall through to raw text */
    }
  }
  return text;
}

/** Legacy BuyGoods API (api.buygoods.com). Returns parsed JSON or raw text. */
async function legacy(endpointKey, { dateFrom, dateTo }) {
  const api = CONFIG.apis.legacy;
  const file = api.endpoints[endpointKey];
  if (!file) throw new Error(`Unknown legacy endpoint: ${endpointKey}`);
  assertDate('dateFrom', dateFrom);
  assertDate('dateTo', dateTo);
  const { token, accountId } = credentials();
  const qs = new URLSearchParams({ [api.account_param]: accountId, token, date_from: dateFrom, date_to: dateTo });
  return request(`${api.base_url}/${file}?${qs}`);
}

/**
 * ClickCRM API (api.clickcrm.com). Fetches ONE page.
 * Returns { data, nextPage, raw } where data is the record array (JSON) or CSV string.
 */
async function clickcrmPage(endpointKey, { dateFrom, dateTo, format = 'json', nextPage } = {}) {
  const api = CONFIG.apis.clickcrm;
  const ep = api.endpoints[endpointKey];
  if (!ep) throw new Error(`Unknown clickcrm endpoint: ${endpointKey}`);
  if (!ep.formats.includes(format)) throw new Error(`${endpointKey} does not support format ${format}`);
  assertDate('dateFrom', dateFrom);
  assertDate('dateTo', dateTo);
  const { token, accountId } = credentials();
  const qs = new URLSearchParams({
    [api.account_param]: accountId,
    token,
    date_from: dateFrom,
    date_to: dateTo,
    response_type: format,
  });
  if (nextPage) qs.set(api.pagination.cursor_param, String(nextPage));
  const raw = await request(`${api.base_url}/${ep.path}?${qs}`);
  if (typeof raw === 'string') return { data: raw, nextPage: null, raw };
  const cursor = raw[api.pagination.cursor_property] ?? raw.meta?.[api.pagination.cursor_property] ?? null;
  const data = Array.isArray(raw) ? raw : raw.data ?? raw.results ?? raw.rows ?? raw;
  return { data, nextPage: cursor || null, raw };
}

/** ClickCRM API: follows next_page until exhausted (JSON only). Returns all records. */
async function clickcrmAll(endpointKey, opts = {}) {
  const all = [];
  let nextPage = opts.nextPage;
  let guard = 0;
  do {
    const page = await clickcrmPage(endpointKey, { ...opts, format: 'json', nextPage });
    if (Array.isArray(page.data)) all.push(...page.data);
    else all.push(page.data);
    nextPage = page.nextPage;
    if (++guard > 10000) throw new Error('Pagination guard tripped (10k pages)');
  } while (nextPage);
  return all;
}

// Convenience wrappers ----------------------------------------------------
const customers = (o) => legacy('customers', o);
const conversions = (o) => legacy('conversions', o);
const commissionsLegacy = (o) => legacy('commissions', o);
const salesByDay = (o) => clickcrmAll('sales_by_day', o);
const salesByHour = (o) => clickcrmAll('sales_by_hour', o);
const salesBySubid = (o) => clickcrmAll('sales_by_subid', o);
const salesBySubid2 = (o) => clickcrmAll('sales_by_subid2', o);
const commissions = (o) => clickcrmAll('commissions', o);

module.exports = {
  CONFIG,
  credentials,
  legacy,
  clickcrmPage,
  clickcrmAll,
  customers,
  conversions,
  commissionsLegacy,
  salesByDay,
  salesByHour,
  salesBySubid,
  salesBySubid2,
  commissions,
};

// CLI ---------------------------------------------------------------------
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const report = args[0];
    const flag = (name) => {
      const i = args.indexOf(name);
      return i >= 0 ? args[i + 1] : undefined;
    };
    const today = new Date().toISOString().slice(0, 10);
    const dateTo = flag('--to') || today;
    const dateFrom = flag('--from') || new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);
    const csv = args.includes('--csv');
    const all = args.includes('--all');

    const legacyMap = { customers: 'customers', conversions: 'conversions', 'commissions-legacy': 'commissions' };
    const newMap = {
      byday: 'sales_by_day',
      byhour: 'sales_by_hour',
      bysubid: 'sales_by_subid',
      bysubid2: 'sales_by_subid2',
      commissions: 'commissions',
    };

    if (!report || (!legacyMap[report] && !newMap[report])) {
      console.error(
        'Usage: node client.js <report> --from YYYY-MM-DD --to YYYY-MM-DD [--csv] [--all]\n' +
          `Reports: ${[...Object.keys(legacyMap), ...Object.keys(newMap)].join(' | ')}`
      );
      process.exit(2);
    }

    let out;
    if (legacyMap[report]) {
      out = await legacy(legacyMap[report], { dateFrom, dateTo });
    } else if (all && !csv) {
      out = await clickcrmAll(newMap[report], { dateFrom, dateTo });
    } else {
      const page = await clickcrmPage(newMap[report], { dateFrom, dateTo, format: csv ? 'csv' : 'json' });
      out = csv ? page.data : page.raw;
    }
    process.stdout.write(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
    process.stdout.write('\n');
  })().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
