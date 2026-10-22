#!/usr/bin/env node

/**
 * AMU Platform — Ingest HTTP Server (L4.1)
 * Listens on port 3007 for Telegram webhook events from n8n
 * n8n catches all Telegram messages and POSTs them here
 */

const http = require('http');
const { logMessage } = require('./tracker');
const { startOnboarding, handleReply } = require('./onboarding');

const PORT = 3007;
const URL_REGEX = /https?:\/\/[^\s]+/i;

const AMU_ID = '-1001892904354';
const XT_ID = '-1002055907504';

const CHANNEL_MAP = {
  [AMU_ID]: 'amu',
  [String(AMU_ID).replace('-', '')]: 'amu',
  '1001892904354': 'amu',
  [XT_ID]: 'xentraffic',
  [String(XT_ID).replace('-', '')]: 'xentraffic',
  '1002055907504': 'xentraffic',
};

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end('Method not allowed');
    return;
  }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      const update = JSON.parse(body);
      const msg = update.message || update.edited_message || update.channel_post;

      if (!msg) {
        res.writeHead(200);
        res.end('ok');
        return;
      }

      const chat_id = String(msg.chat?.id || '');
      const channel = CHANNEL_MAP[chat_id] || CHANNEL_MAP[chat_id.replace('-', '')];

      // L4.3 — a DM is never a tracked group (its chat.id is the user's), so the
      // guard below used to drop every onboarding answer. Handle private chats
      // before it. Failures are logged, never thrown: the ingest must keep
      // acknowledging Telegram whatever the questionnaire does.
      if (msg.chat?.type === 'private' && msg.from?.id) {
        const from = msg.from;
        const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || String(from.id);
        Promise.resolve(handleReply(String(from.id), from.username || null, name, msg.text || ''))
          .catch(e => console.error('onboarding reply failed:', e.message));
        res.writeHead(200);
        res.end('ok');
        return;
      }

      if (!channel) {
        // Not a tracked group — ignore silently
        res.writeHead(200);
        res.end('ok');
        return;
      }

      // L4.3 — someone just joined a tracked group: open the questionnaire in DM.
      // Bots are skipped, and startOnboarding is itself idempotent (it returns
      // early if the member already completed it).
      if (Array.isArray(msg.new_chat_members) && msg.new_chat_members.length) {
        for (const m of msg.new_chat_members) {
          if (m.is_bot) continue;
          const name = [m.first_name, m.last_name].filter(Boolean).join(' ') || m.username || String(m.id);
          Promise.resolve(startOnboarding(String(m.id), m.username || null, name))
            .catch(e => console.error('onboarding start failed:', e.message));
        }
        res.writeHead(200);
        res.end('ok');
        return;
      }

      const from = msg.from || {};
      const text = msg.text || msg.caption || '';
      const timestamp = (msg.date || Math.floor(Date.now() / 1000)) * 1000;
      const is_reply = !!(msg.reply_to_message);
      const reply_to_user_id = is_reply
        ? String(msg.reply_to_message?.from?.id || '')
        : null;

      // is_thread_start: top-level message, not a reply, no message_thread_id
      const is_thread_start = !is_reply && !msg.message_thread_id ? 1 : 0;

      const payload = {
        channel,
        telegram_msg_id: msg.message_id || null,
        user_id: String(from.id || 'unknown'),
        username: from.username || null,
        display_name: [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || String(from.id),
        timestamp,
        has_link: URL_REGEX.test(text) ? 1 : 0,
        is_reply: is_reply ? 1 : 0,
        reply_to_user_id,
        thread_id: msg.message_thread_id || null,
        is_thread_start,
        text: text || null,
      };

      logMessage(payload);
      res.writeHead(200);
      res.end('ok');
    } catch (e) {
      console.error('ingest-webhook error:', e.message);
      res.writeHead(200); // Always 200 to Telegram
      res.end('ok');
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`✅ AMU ingest webhook listening on 127.0.0.1:${PORT}`);
});
