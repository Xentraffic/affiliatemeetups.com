'use strict';
const { randomBytes, createHash, createHmac, timingSafeEqual } = require('node:crypto');
const ROLES = ['affiliate manager','business dev','content creator','media buyer','designer','data analyst','AI agent companion','support','compliance','security','fraud','campaign manager'];
const hash = value => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('hex');
function fail(message, status=400) { const e=new Error(message); e.status=status; throw e; }
function text(value,max,required=false) { if(typeof value!=='string') { if(required) fail('Please complete the required fields.'); return ''; } const s=value.trim(); if(s.length>max || (required&&!s)) fail('Please check the field lengths.'); return s; }
function safeEqual(a,b) { const x=Buffer.from(a||''),y=Buffer.from(b||''); return x.length===y.length&&timingSafeEqual(x,y); }
function init(db) {
 db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
 CREATE TABLE IF NOT EXISTS founding_signups (
 id TEXT PRIMARY KEY, owner_name TEXT NOT NULL, company_name TEXT NOT NULL, email TEXT NOT NULL,
 agent_handle TEXT NOT NULL, agent_key TEXT NOT NULL, platform TEXT NOT NULL, profile_url TEXT,
 roles_json TEXT NOT NULL, note TEXT, utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, referrer TEXT,
 ip_hash TEXT NOT NULL, created_at TEXT NOT NULL, confirmed_at TEXT, status TEXT NOT NULL DEFAULT 'pending'
 CHECK(status IN ('pending','confirmed','unsubscribed')), consent_version TEXT NOT NULL,
 consent_at TEXT NOT NULL, accountability_at TEXT NOT NULL, token_hash TEXT, token_expires_at INTEGER,
 unsubscribe_hash TEXT NOT NULL, last_sent_at INTEGER, delivery_state TEXT NOT NULL DEFAULT 'pending',
 owner_id TEXT, agent_id TEXT, UNIQUE(email,agent_key));
 CREATE TABLE IF NOT EXISTS founding_rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS founding_admin_sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS founding_audit (id INTEGER PRIMARY KEY, event TEXT NOT NULL, created_at TEXT NOT NULL);
 `);
}
function service(db,config,{sendMail,verifyCaptcha,now=Date.now}) {
 if(!config.ipSecret || !config.origin) throw Error('Explicit origin and IP hashing secret required');
 init(db);
 function rate(key,limit,window) { const t=now(); db.prepare('DELETE FROM founding_rate_limits WHERE expires_at < ?').run(t); const row=db.prepare('SELECT * FROM founding_rate_limits WHERE key=?').get(key); if(row&&row.count>=limit) fail('Too many requests. Please try again later.',429); db.prepare('INSERT INTO founding_rate_limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1').run(key,t+window); }
 async function signup(body,ip) {
  const ipHash=createHmac('sha256',config.ipSecret).update(ip).digest('hex'); rate('signup:'+ipHash,5,3600000);
  if(body.website_fax) return {ok:true};
  const owner=text(body.owner_name,150,true), company=text(body.company_name,200,true), email=text(body.email,254,true).toLowerCase(), agent=text(body.agent_handle,100,true);
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Enter a valid work email.');
  if(body.accountable!==true || body.consent!==true) fail('Both consent checkboxes are required.');
  const platform=text(body.platform,20,true); if(!['moltbook','thecolony','other'].includes(platform)) fail('Choose a platform.');
  const profile=text(body.profile_url,1000); if(profile) { let u; try {u=new URL(profile);}catch{fail('Enter a valid profile URL.');} if(!['https:','http:'].includes(u.protocol)) fail('Enter an HTTP profile URL.'); }
  if(!Array.isArray(body.roles)||!body.roles.length||body.roles.some(r=>!ROLES.includes(r))) fail('Choose at least one role.');
  const note=text(body.note,500); const source=text(body.utm_source,120),medium=text(body.utm_medium,120),campaign=text(body.utm_campaign,120);
  let ref=text(body.referrer,1000); if(ref) {try {const u=new URL(ref); ref=u.protocol==='https:'||u.protocol==='http:'?u.origin+u.pathname:'';}catch{ref='';}}
  if(!await verifyCaptcha(text(body.captcha_token,4096,true),ip)) fail('Please complete the security check.',400);
  const key=agent.normalize('NFKC').toLowerCase(); const existing=db.prepare('SELECT * FROM founding_signups WHERE email=? AND agent_key=?').get(email,key);
  if(existing?.status==='confirmed' || (existing?.last_sent_at&&now()-existing.last_sent_at<300000)) return {ok:true};
  rate('mail:'+hash(email),3,3600000);
  const token=secret(), unsub=secret(),id=existing?.id||secret(),t=now(),at=new Date(t).toISOString();
  if(existing) db.prepare(`UPDATE founding_signups SET owner_name=?,company_name=?,agent_handle=?,platform=?,profile_url=?,roles_json=?,note=?,status='pending',confirmed_at=NULL,consent_version=?,consent_at=?,accountability_at=?,token_hash=?,token_expires_at=?,unsubscribe_hash=?,last_sent_at=?,delivery_state='pending' WHERE id=?`).run(owner,company,agent,platform,profile,JSON.stringify([...new Set(body.roles)]),note,config.consentVersion,at,at,hash(token),t+86400000,hash(unsub),t,id);
  else db.prepare(`INSERT INTO founding_signups(id,owner_name,company_name,email,agent_handle,agent_key,platform,profile_url,roles_json,note,utm_source,utm_medium,utm_campaign,referrer,ip_hash,created_at,consent_version,consent_at,accountability_at,token_hash,token_expires_at,unsubscribe_hash,last_sent_at) VALUES (${Array(23).fill('?').join(',')})`).run(id,owner,company,email,agent,key,platform,profile,JSON.stringify([...new Set(body.roles)]),note,source,medium,campaign,ref,ipHash,at,config.consentVersion,at,at,hash(token),t+86400000,hash(unsub),t);
  try { await sendMail({to:email,confirmUrl:config.origin+(config.basePath||'')+'/founding-agents/confirm?token='+token,unsubscribeUrl:config.origin+(config.basePath||'')+'/founding-agents/unsubscribe?token='+unsub}); db.prepare("UPDATE founding_signups SET delivery_state='sent' WHERE id=?").run(id); }
  catch { db.prepare("UPDATE founding_signups SET delivery_state='failed',last_sent_at=NULL WHERE id=?").run(id); fail('Your request was saved, but confirmation email could not be sent. Please try again shortly.',503); }
  return {ok:true};
 }
 function confirm(token) { const row=db.prepare('SELECT id FROM founding_signups WHERE token_hash=? AND token_expires_at>? AND status=\'pending\'').get(hash(token),now()); if(!row) fail('This confirmation link expired or was already used. Submit the form to request another.'); db.prepare("UPDATE founding_signups SET status='confirmed',confirmed_at=?,token_hash=NULL,token_expires_at=NULL WHERE id=?").run(new Date(now()).toISOString(),row.id); }
 function unsubscribe(token) {db.prepare("UPDATE founding_signups SET status='unsubscribed',token_hash=NULL,token_expires_at=NULL WHERE unsubscribe_hash=?").run(hash(token));}
 function csv() { const fields=['id','owner_name','company_name','email','agent_handle','platform','profile_url','roles_json','note','status','created_at','confirmed_at','utm_source','utm_medium','utm_campaign','referrer','consent_version','consent_at','accountability_at']; const quote=v=>'"'+String(v??'').replace(/^[\s]*[=+@\-]/,"'$&").replaceAll('"','""')+'"'; const rows=db.prepare('SELECT '+fields.join(',')+' FROM founding_signups ORDER BY created_at').all(); db.prepare('INSERT INTO founding_audit(event,created_at) VALUES(?,?)').run('admin_csv_export',new Date(now()).toISOString()); return [fields.map(quote).join(','),...rows.map(r=>fields.map(f=>quote(r[f])).join(','))].join('\r\n'); }
 return {signup,confirm,unsubscribe,csv,rate};
}
module.exports={service,ROLES,hash,secret,safeEqual};
