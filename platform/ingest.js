#!/usr/bin/env node

/**
 * AMU Platform — Message Ingestion (L4.1 updated)
 * Logs messages + extracts links for L4.5/L4.6
 */

const { logMessage } = require('./tracker');
const Database = require('better-sqlite3');

const DB_PATH = '/home/xenhive/amu-platform/stats.db';
const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi;

function getDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  return db;
}

function extractLinks(text) {
  if (!text) return [];
  const matches = text.match(URL_REGEX) || [];
  return [...new Set(matches)]; // dedupe
}

function logLinks(data, links) {
  if (!links.length) return;
  const db = getDb();
  const date = new Date(data.timestamp).toISOString().slice(0, 10);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO links (channel, user_id, username, display_name, url, telegram_msg_id, timestamp, date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const url of links) {
    insert.run(data.channel, data.user_id, data.username, data.display_name, url, data.telegram_msg_id || null, data.timestamp, date);
  }
  db.close();
}

try {
  const raw = process.argv[2];
  if (!raw) { console.error('No data'); process.exit(1); }

  const data = JSON.parse(raw);
  const text = data.text || '';
  const links = extractLinks(text);

  const payload = {
    channel: data.channel,
    telegram_msg_id: data.telegram_msg_id || null,
    user_id: String(data.user_id),
    username: data.username || null,
    display_name: data.display_name || data.username || String(data.user_id),
    timestamp: data.timestamp || Date.now(),
    has_link: links.length > 0 ? 1 : 0,
    is_reply: data.reply_to_msg_id ? 1 : 0,
    reply_to_user_id: data.reply_to_user_id || null,
    thread_id: data.thread_id || null,
    is_thread_start: data.is_thread_start ? 1 : 0,
    text: text.slice(0, 1000), // cap at 1000 chars
  };

  logMessage(payload);
  if (links.length) logLinks(data, links);

  console.log('✅ logged' + (links.length ? ` + ${links.length} link(s)` : ''));
} catch(e) {
  console.error('ingest error:', e.message);
  process.exit(1);
}
