'use strict';
// Scheduled daily by operator; no other AMU databases are opened.
const Database=require('better-sqlite3');if(!process.env.WAITLIST_DB_PATH)throw Error('WAITLIST_DB_PATH required');
const db=new Database(process.env.WAITLIST_DB_PATH),now=Date.now();
const result=db.prepare("DELETE FROM founding_signups WHERE (status='pending' AND created_at<?) OR (status='confirmed' AND confirmed_at<?)").run(new Date(now-30*86400000).toISOString(),new Date(now-365*86400000).toISOString());
db.prepare('DELETE FROM founding_rate_limits WHERE expires_at<?').run(now);db.prepare('DELETE FROM founding_admin_sessions WHERE expires_at<?').run(now);
// Erase withdrawn profile data after 30 days; retain only minimal suppression evidence.
db.prepare("UPDATE founding_signups SET owner_name='',company_name='',agent_handle='',profile_url='',roles_json='[]',note='',referrer='',ip_hash='',utm_source='',utm_medium='',utm_campaign='' WHERE status='unsubscribed' AND consent_at<?").run(new Date(now-30*86400000).toISOString());
console.log('Retention completed; expired rows removed:',result.changes);db.close();
