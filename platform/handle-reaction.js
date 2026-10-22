#!/usr/bin/env node

/**
 * AMU Platform — Reaction Handler (L4.7)
 * Called when a user reacts to a message in AMU
 * 🥰 reaction → saves the message to user's profile
 * 
 * Usage: node handle-reaction.js '<json>'
 * JSON: { user_id, username, emoji, channel, telegram_msg_id, message_text, from_username }
 */

const https = require('https');

const BOT_TOKEN = process.env.AMU_BOT_TOKEN;
const SAVE_EMOJI = '🥰';

function postToSaved(data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = https.request({
      hostname: '127.0.0.1',
      port: 3852,
      path: '/saved',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({}); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sendDm(user_id, text) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: user_id, text, parse_mode: 'Markdown' });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve()); });
    req.on('error', () => resolve());
    req.write(body);
    req.end();
  });
}

(async () => {
  try {
    const data = JSON.parse(process.argv[2] || '{}');
    if (data.emoji !== SAVE_EMOJI) process.exit(0);

    const result = await postToSaved({
      user_id: data.user_id,
      channel: data.channel || 'amu',
      telegram_msg_id: data.telegram_msg_id,
      message_text: data.message_text || null,
      from_username: data.from_username || null
    });

    if (result.success) {
      // Send confirmation DM
      await sendDm(data.user_id,
        `🥰 Saved! Find your bookmarks at *affiliatemeetups.com/profile*`
      );
      console.log(`✅ Saved message ${data.telegram_msg_id} for user ${data.user_id}`);
    }
  } catch(e) {
    console.error('reaction handler error:', e.message);
  }
})();
