'use strict';
const express=require('express'), path=require('node:path');
const {service,hash,secret,safeEqual}=require('./core');
const ROOT=path.join(__dirname,'public');
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function createApp(db,config,dependencies) {
 const app=express(),svc=service(db,config,dependencies);
 const prefix=config.basePath||'';
 if(prefix)app.use((req,res,next)=>{if(!req.url.startsWith(prefix+'/'))return res.sendStatus(404);req.url=req.url.slice(prefix.length);next();});
 function sendFile(res,name){const mime=name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':'text/html';let data=require('node:fs').readFileSync(path.join(ROOT,name),'utf8');if(prefix)data=data.replaceAll('/api/founding-agents',prefix+'/api/founding-agents').replaceAll('/founding-agents',prefix+'/founding-agents').replaceAll(prefix+'/api'+prefix+'/founding-agents',prefix+'/api/founding-agents');return res.type(mime).send(data);} app.disable('x-powered-by');
 // Only trust the loopback nginx hop; never trust arbitrary X-Forwarded-For.
 app.set('trust proxy','loopback');
 app.use((req,res,next)=>{res.set({'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; style-src 'self'; img-src 'self' data:; connect-src 'self' https://challenges.cloudflare.com; frame-ancestors 'none'; form-action 'self'; base-uri 'none'"});next();});
 app.use(express.json({limit:'16kb'}));app.use(express.urlencoded({extended:false,limit:'16kb'}));
 app.use((req,res,next)=>{ if(['POST','DELETE','PATCH'].includes(req.method)&&req.get('origin')!==config.origin) return res.status(403).json({error:'origin_not_allowed'});next(); });
 app.get('/api/founding-agents/config',(req,res)=>res.json({siteKey:config.siteKey,operator:config.operator,address:config.address,contact:config.contact}));
 app.post('/api/founding-agents/signup',async(req,res,next)=>{try{res.json(await svc.signup(req.body,req.ip));}catch(e){next(e);}});
 function actionPage(title,token,action) {return '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="'+prefix+'/founding-agents/style.css"><title>'+title+'</title><main class="message"><p class="eyebrow">AFFILIATEMEETUPS / FOUNDING AGENTS</p><h1>'+title+'</h1><form method="post" action="'+action+'"><input type="hidden" name="token" value="'+escape(token)+'"><button>Confirm</button></form></main></html>';}
 app.get('/founding-agents/confirm',(req,res)=>res.type('html').send(actionPage('Confirm your place on the founding list',req.query.token||'',prefix+'/founding-agents/confirm')));
 app.post('/founding-agents/confirm',(req,res,next)=>{try{svc.confirm(String(req.body.token||''));res.redirect(303,prefix+'/founding-agents/thanks');}catch(e){next(e);}});
 app.get('/founding-agents/unsubscribe',(req,res)=>res.type('html').send(actionPage('Unsubscribe from AffiliateMeetups emails',req.query.token||'',prefix+'/founding-agents/unsubscribe')));
 app.post('/founding-agents/unsubscribe',(req,res)=>{svc.unsubscribe(String(req.body.token||''));res.type('html').send('<p>You have been unsubscribed.</p>');});
 app.get('/founding-agents/thanks',(req,res)=>sendFile(res,'thanks.html'));
 app.get('/founding-agents/admin',(req,res)=>sendFile(res,'admin.html'));
 app.post('/api/founding-agents/admin/login',(req,res,next)=>{try {svc.rate('admin:'+hash(req.ip),5,900000); if(!safeEqual(req.body.password,config.adminSecret))return res.status(401).json({error:'Invalid credentials'});const token=secret();db.prepare('DELETE FROM founding_admin_sessions WHERE expires_at<?').run(Date.now());db.prepare('INSERT INTO founding_admin_sessions VALUES(?,?)').run(hash(token),Date.now()+1800000);res.cookie('amu_waitlist_admin',token,{httpOnly:true,secure:!config.local,sameSite:'strict',path:prefix+'/api/founding-agents/admin',maxAge:1800000});res.json({ok:true});}catch(e){next(e);}});
 function admin(req,res,next) {const token=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('amu_waitlist_admin='))?.split('=')[1];if(!token||!db.prepare('SELECT 1 FROM founding_admin_sessions WHERE token_hash=? AND expires_at>?').get(hash(token),Date.now()))return res.status(401).json({error:'Authentication required'});next();}
 app.get('/api/founding-agents/admin/export.csv',admin,(req,res)=>{res.set('Content-Disposition','attachment; filename="founding-agents.csv"');res.type('text/csv').send(svc.csv());});
 app.post('/api/founding-agents/admin/logout',admin,(req,res)=>{const token=(req.headers.cookie||'').match(/amu_waitlist_admin=([^;]+)/)?.[1];db.prepare('DELETE FROM founding_admin_sessions WHERE token_hash=?').run(hash(token||''));res.clearCookie('amu_waitlist_admin',{path:prefix+'/api/founding-agents/admin'});res.json({ok:true});});
 app.get('/founding-agents/privacy',(req,res)=>sendFile(res,'privacy.html'));
 app.get('/founding-agents/terms',(req,res)=>sendFile(res,'terms.html'));
 app.get('/founding-agents', (req,res)=>sendFile(res,'index.html'));
 app.get('/founding-agents/:asset',(req,res,next)=>{if(!['style.css','form.js','admin.js','legal.js'].includes(req.params.asset))return next();sendFile(res,req.params.asset);});
 app.use((err,req,res,next)=>{const status=err.status||500;res.status(status).json({error:status<500||status===503?err.message:'Request could not be completed.'});});
 return app;
}
async function main() {
 const e=process.env,local=e.WAITLIST_LOCAL==='1';process.umask(0o077);
 for(const key of ['WAITLIST_DB_PATH','WAITLIST_ORIGIN','WAITLIST_IP_SECRET','WAITLIST_ADMIN_SECRET','WAITLIST_OPERATOR','WAITLIST_ADDRESS','WAITLIST_CONTACT'])if(!e[key])throw Error(key+' is required');
 if(e.WAITLIST_ADMIN_SECRET.length<32||e.WAITLIST_IP_SECRET.length<32)throw Error('Secrets must have at least 32 characters');
 if(!local&&(!e.WAITLIST_TURNSTILE_SITE_KEY||!e.WAITLIST_TURNSTILE_SECRET||!e.WAITLIST_SMTP_HOST||!e.WAITLIST_SMTP_USER||!e.WAITLIST_SMTP_PASSWORD||!e.WAITLIST_MAIL_FROM))throw Error('Captcha and SMTP must be configured before staging launch');
 if(!local&&!e.WAITLIST_ORIGIN.startsWith('https://'))throw Error('HTTPS origin required');
 if(!path.isAbsolute(e.WAITLIST_DB_PATH)||path.basename(e.WAITLIST_DB_PATH)==='stats.db')throw Error('Use an explicit isolated waitlist DB path');
 const Database=require('better-sqlite3'),db=new Database(e.WAITLIST_DB_PATH);require('node:fs').chmodSync(e.WAITLIST_DB_PATH,0o600);
 const config={origin:e.WAITLIST_ORIGIN.replace(/\/$/,''),ipSecret:e.WAITLIST_IP_SECRET,adminSecret:e.WAITLIST_ADMIN_SECRET,operator:e.WAITLIST_OPERATOR,address:e.WAITLIST_ADDRESS,contact:e.WAITLIST_CONTACT,basePath:e.WAITLIST_BASE_PATH||'',siteKey:e.WAITLIST_TURNSTILE_SITE_KEY||'',consentVersion:'founding-v1',local};
 let smtp;if(!local)smtp=require('nodemailer').createTransport({host:e.WAITLIST_SMTP_HOST,port:Number(e.WAITLIST_SMTP_PORT||587),secure:e.WAITLIST_SMTP_PORT==='465',requireTLS:e.WAITLIST_SMTP_PORT!=='465',auth:{user:e.WAITLIST_SMTP_USER,pass:e.WAITLIST_SMTP_PASSWORD}});
 const deps={verifyCaptcha:async(token,ip)=>{if(local)return token==='local-test';const r=await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',{method:'POST',body:new URLSearchParams({secret:e.WAITLIST_TURNSTILE_SECRET,response:token,remoteip:ip}),signal:AbortSignal.timeout(10000)});const data=await r.json();return data.success===true&&data.hostname===new URL(config.origin).hostname&&data.action==='founding_signup';},sendMail:async({to,confirmUrl,unsubscribeUrl})=>{if(local)throw Error('Local mode does not deliver mail');await smtp.sendMail({from:e.WAITLIST_MAIL_FROM,to,subject:'Confirm your AffiliateMeetups founding-list signup',text:`Confirm your email and place on the founding list:\n${confirmUrl}\n\nThis link expires in 24 hours. If you did not request it, ignore this email.\n\n${config.operator}\n${config.address}\n${config.contact}\n\nUnsubscribe: ${unsubscribeUrl}`});}};
 createApp(db,config,deps).listen(Number(e.WAITLIST_PORT||3863),'127.0.0.1',()=>console.log('AMU waitlist listening on loopback'));
}
if(require.main===module)main().catch(()=>{console.error('Waitlist startup failed; check required configuration.');process.exitCode=1;});
module.exports={createApp};
