#!/usr/bin/env node
// Insert realistic test data for 2026-04-18 highlights test

const Database = require('better-sqlite3');
const db = new Database('./stats.db');

const today = '2026-04-18';
const baseTs = new Date('2026-04-18T12:00:00Z').getTime();

const insert = db.prepare(`
  INSERT OR IGNORE INTO messages (channel, telegram_msg_id, user_id, username, display_name, timestamp, has_link, is_reply, reply_to_user_id, thread_id, is_thread_start, date, text)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const testMessages = [
  ['amu', 10001, '123456', 'jsmith_aff', 'Jake Smith', baseTs, 0, 0, null, null, 1, today, 'Great call on EPC drops for the weekend'],
  ['amu', 10002, '234567', 'affiliate_pro', 'Maria Torres', baseTs + 120000, 1, 1, '123456', null, 0, today, 'Agreed, thread on that https://forum.example.com/epc'],
  ['amu', 10003, '345678', 'trafficmaster', 'Kevin Wu', baseTs + 300000, 0, 0, null, null, 1, today, 'Anyone running Everflow webhooks for ShipOffers?'],
  ['amu', 10004, '456789', 'newaffiliate99', 'Sam Chen', baseTs + 360000, 0, 1, '345678', null, 0, today, 'Yes I can help — DM me'],
  ['amu', 10005, '123456', 'jsmith_aff', 'Jake Smith', baseTs + 500000, 1, 0, null, null, 1, today, 'New offer live https://xentraffic.com/offers'],
  ['amu', 10006, '567890', 'scaling_guru', 'Alex Rivera', baseTs + 700000, 0, 0, null, null, 1, today, 'Meta CPMs dropping this week — good time to scale'],
  ['amu', 10007, '678901', 'lander_wizard', 'Chris Park', baseTs + 900000, 0, 1, '567890', null, 0, today, 'Seeing same — pushed budget 20% yesterday'],
  ['amu', 10008, '789012', 'sup_affiliate', 'Dana Hill', baseTs + 1100000, 0, 0, null, null, 1, today, 'Which supplement verticals are working best right now?'],
  ['amu', 10009, '456789', 'newaffiliate99', 'Sam Chen', baseTs + 1200000, 1, 1, '789012', null, 0, today, 'GLP-1 angle is hot https://industry.example.com/glp1'],
  ['amu', 10010, '234567', 'affiliate_pro', 'Maria Torres', baseTs + 1500000, 0, 0, null, null, 1, today, 'AMU Vegas event recap — anyone have the slides?'],
  ['amu', 10011, '123456', 'jsmith_aff', 'Jake Smith', baseTs + 1800000, 0, 1, '234567', null, 0, today, 'Check the AMU Telegram pinned messages'],
  ['amu', 10012, '890123', 'night_runner', 'Morgan Lee', baseTs + 82800000, 0, 0, null, null, 1, today, 'Late night check from EU timezone'],
];

const insertMany = db.transaction((rows) => {
  for (const row of rows) insert.run(...row);
});
insertMany(testMessages);

const count = db.prepare('SELECT COUNT(*) as n FROM messages WHERE date = ?').get(today);
console.log('Messages for', today + ':', count.n);
