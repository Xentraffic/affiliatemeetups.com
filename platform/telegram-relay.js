#!/usr/bin/env node
/**
 * AMU Telegram Relay
 * Polls Telegram Bot API for updates and forwards to amu-tracker ingest (port 3007)
 * Bypasses n8n. Runs as PM2 process "amu-relay".
 * 
 * Works alongside OpenClaw Telegram — we share the same bot token but use
 * getUpdates (long-polling) with a shared offset stored in /tmp/amu-relay-offset.json
 * 
 * NOTE: If OpenClaw (or n8n) has set a webhook, getUpdates won't work.
 * This relay first clears any webhook, then polls.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');

const BOT_TOKEN = process.env.AMU_BOT_TOKEN;
const INGEST_URL = 'http://127.0.0.1:3007';
const AMU_CHAT_ID = '-1001892904354';
const XT_CHAT_ID = '-1002055907504';
const OFFSET_FILE = '/tmp/amu-relay-offset.json';
const POLL_TIMEOUT = 30; // seconds

function tgGet(method, params = {}) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams(params).toString();
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}?${qs}`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function postIngest(body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port: 3007,
      path: '/',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', (e) => { console.error('[relay] ingest error:', e.message); resolve(0); });
    req.write(data);
    req.end();
  });
}

function loadOffset() {
  try { return JSON.parse(fs.readFileSync(OFFSET_FILE, 'utf8')).offset || 0; }
  catch { return 0; }
}

function saveOffset(offset) {
  fs.writeFileSync(OFFSET_FILE, JSON.stringify({ offset }));
}

async function poll() {
  let offset = loadOffset();
  console.log('[relay] starting poll from offset', offset);

  while (true) {
    try {
      const resp = await tgGet('getUpdates', {
        offset,
        timeout: POLL_TIMEOUT,
        allowed_updates: JSON.stringify(['message', 'edited_message'])
      });

      if (!resp.ok || !resp.result) {
        console.error('[relay] bad response:', JSON.stringify(resp).slice(0, 200));
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      for (const update of resp.result) {
        const msg = update.message || update.edited_message;
        const chatId = String(msg?.chat?.id || '');
        
        if (chatId === AMU_CHAT_ID || chatId === XT_CHAT_ID) {
          const status = await postIngest(update);
          const user = msg?.from?.username || msg?.from?.first_name || '?';
          console.log(`[relay] forwarded update ${update.update_id} from ${chatId} user:${user} -> HTTP ${status}`);
        }
        
        offset = update.update_id + 1;
        saveOffset(offset);
      }
    } catch (e) {
      console.error('[relay] poll error:', e.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// Clear webhook first (getUpdates requires no webhook)
async function main() {
  console.log('[relay] checking webhook status...');
  const info = await tgGet('getWebhookInfo');
  if (info.result?.url) {
    console.log('[relay] clearing existing webhook:', info.result.url);
    await tgGet('deleteWebhook', { drop_pending_updates: false });
    console.log('[relay] webhook cleared');
  } else {
    console.log('[relay] no webhook set, polling mode OK');
  }
  await poll();
}

main().catch(e => { console.error('[relay] fatal:', e); process.exit(1); });
