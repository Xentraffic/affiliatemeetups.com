#!/usr/bin/env node
// Init DB and insert test data with correct schema, then generate staged highlights

const { initDb, logMessage, getDailyStats, formatHighlights } = require('./tracker');

initDb();
console.log('DB initialized');

const today = '2026-04-18';
const baseTs = new Date('2026-04-18T12:00:00Z').getTime();

const testMessages = [
  { channel: 'amu', telegram_msg_id: 20001, user_id: '123456', username: 'jsmith_aff', display_name: 'Jake Smith', timestamp: baseTs, has_link: 0, is_reply: 0, reply_to_user_id: null, thread_id: null, is_thread_start: 1, text: 'Great call on EPC drops for the weekend' },
  { channel: 'amu', telegram_msg_id: 20002, user_id: '234567', username: 'affiliate_pro', display_name: 'Maria Torres', timestamp: baseTs + 120000, has_link: 1, is_reply: 1, reply_to_user_id: '123456', thread_id: 20001, is_thread_start: 0, text: 'Agreed https://forum.example.com/epc' },
  { channel: 'amu', telegram_msg_id: 20003, user_id: '345678', username: 'trafficmaster', display_name: 'Kevin Wu', timestamp: baseTs + 300000, has_link: 0, is_reply: 0, reply_to_user_id: null, thread_id: null, is_thread_start: 1, text: 'Anyone running Everflow webhooks for ShipOffers?' },
  { channel: 'amu', telegram_msg_id: 20004, user_id: '456789', username: 'newaffiliate99', display_name: 'Sam Chen', timestamp: baseTs + 360000, has_link: 0, is_reply: 1, reply_to_user_id: '345678', thread_id: 20003, is_thread_start: 0, text: 'Yes I can help DM me' },
  { channel: 'amu', telegram_msg_id: 20005, user_id: '123456', username: 'jsmith_aff', display_name: 'Jake Smith', timestamp: baseTs + 500000, has_link: 1, is_reply: 0, reply_to_user_id: null, thread_id: null, is_thread_start: 1, text: 'New offer live https://xentraffic.com/offers' },
  { channel: 'amu', telegram_msg_id: 20006, user_id: '567890', username: 'scaling_guru', display_name: 'Alex Rivera', timestamp: baseTs + 700000, has_link: 0, is_reply: 0, reply_to_user_id: null, thread_id: null, is_thread_start: 1, text: 'Meta CPMs dropping this week — good time to scale' },
  { channel: 'amu', telegram_msg_id: 20007, user_id: '678901', username: 'lander_wizard', display_name: 'Chris Park', timestamp: baseTs + 900000, has_link: 0, is_reply: 1, reply_to_user_id: '567890', thread_id: 20006, is_thread_start: 0, text: 'Seeing same — pushed budget 20% yesterday' },
  { channel: 'amu', telegram_msg_id: 20008, user_id: '789012', username: 'sup_affiliate', display_name: 'Dana Hill', timestamp: baseTs + 1100000, has_link: 0, is_reply: 0, reply_to_user_id: null, thread_id: null, is_thread_start: 1, text: 'Which supplement verticals are working best?' },
  { channel: 'amu', telegram_msg_id: 20009, user_id: '456789', username: 'newaffiliate99', display_name: 'Sam Chen', timestamp: baseTs + 1200000, has_link: 1, is_reply: 1, reply_to_user_id: '789012', thread_id: 20008, is_thread_start: 0, text: 'GLP-1 angle is hot https://industry.example.com/glp1' },
  { channel: 'amu', telegram_msg_id: 20010, user_id: '234567', username: 'affiliate_pro', display_name: 'Maria Torres', timestamp: baseTs + 1500000, has_link: 0, is_reply: 0, reply_to_user_id: null, thread_id: null, is_thread_start: 1, text: 'AMU Vegas recap — anyone have the slides?' },
  { channel: 'amu', telegram_msg_id: 20011, user_id: '123456', username: 'jsmith_aff', display_name: 'Jake Smith', timestamp: baseTs + 1800000, has_link: 0, is_reply: 1, reply_to_user_id: '234567', thread_id: 20010, is_thread_start: 0, text: 'Check the pinned messages' },
  { channel: 'amu', telegram_msg_id: 20012, user_id: '890123', username: 'night_runner', display_name: 'Morgan Lee', timestamp: baseTs + 82800000, has_link: 0, is_reply: 0, reply_to_user_id: null, thread_id: null, is_thread_start: 1, text: 'Late night check from EU timezone' },
];

for (const msg of testMessages) {
  try { logMessage(msg); } catch(e) { /* skip dupes */ }
}
console.log('Inserted test messages');

const stats = getDailyStats(today, 'amu');
console.log('\nStats:', JSON.stringify(stats, null, 2));

const text = formatHighlights(stats);
console.log('\n=== STAGED HIGHLIGHTS OUTPUT ===');
console.log(text);
