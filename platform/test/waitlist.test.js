const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dbPath = path.join(os.tmpdir(), `amu-waitlist-${process.pid}.db`);
const mailPath = path.join(os.tmpdir(), `amu-waitlist-${process.pid}.log`);
process.env.WAITLIST_DB_PATH = dbPath;
process.env.EMAIL_LOG_PATH = mailPath;
process.env.EMAIL_MODE = 'log';
delete process.env.CYBERIMPACT_FORWARD;
process.env.WAITLIST_EMAIL_LIMIT = '3';

const { app, setCyberimpactForwarder } = require('../api-members');
const { getSignup } = require('../waitlist-store');

function request(method, pathName, { body, headers = {}, json = true } = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const payload = body == null ? null : (json ? JSON.stringify(body) : body);
      const req = http.request({
        port,
        method,
        path: pathName,
        headers: {
          ...(payload ? {
            'content-type': json ? 'application/json' : 'application/x-www-form-urlencoded',
            'content-length': Buffer.byteLength(payload),
          } : {}),
          ...headers,
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          server.close(() => {
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed = null;
            try { parsed = JSON.parse(text); } catch { /* html */ }
            resolve({ status: res.statusCode, json: parsed, text, headers: res.headers });
          });
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  });
}

function signup(extra = {}) {
  return {
    firstname: 'Ada',
    lastname: 'Lovelace',
    email: extra.email || `ada-${Date.now()}-${Math.random()}@acme.test`,
    company: 'Acme Media',
    role: 'Media buyer',
    country: 'Canada',
    website: 'https://acme.test',
    traffic: 'search, about 200 clicks a day',
    source: 'a chapter host',
    goal: 'a room that does not publish partner terms',
    ...extra,
  };
}

test('legacy join fields are stored locally and are not forwarded unless the flag is set', async () => {
  const calls = [];
  setCyberimpactForwarder(async (...args) => { calls.push(args); return { status: 200 }; });
  const body = signup({ email: 'legacy@acme.test', jobtitle: 'Buyer', role: undefined });
  const res = await request('POST', '/api/members/register', { body });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.stored, true);
  assert.equal(res.json.forwarded, false);
  assert.equal(calls.length, 0);
  const row = getSignup(res.json.id);
  assert.equal(row.company, 'Acme Media');
  assert.equal(row.role, 'Buyer');
  assert.equal(row.country, 'Canada');
  assert.equal(row.website, 'https://acme.test');
  assert.equal(row.traffic, 'search, about 200 clicks a day');
  assert.equal(row.source, 'a chapter host');
  assert.equal(row.goal, 'a room that does not publish partner terms');
  assert.equal(row.email, 'legacy@acme.test');
});

test('Cyberimpact forwarding stays email and name only, and only when enabled', async () => {
  const calls = [];
  setCyberimpactForwarder(async (email, groupId, firstname, lastname) => {
    calls.push({ email, groupId, firstname, lastname });
    return { status: 201 };
  });
  process.env.CYBERIMPACT_FORWARD = '1';
  const res = await request('POST', '/api/members/register', { body: signup({ email: 'forward@acme.test', company: 'Secret Co' }) });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.forwarded, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].groupId, '129');
  assert.equal(calls[0].email, 'forward@acme.test');
  assert.deepEqual(Object.keys(calls[0]).sort(), ['email', 'firstname', 'groupId', 'lastname']);
  delete process.env.CYBERIMPACT_FORWARD;
});

test('the same email is rate limited', async () => {
  const email = 'limited@acme.test';
  for (let i = 0; i < 3; i++) {
    const res = await request('POST', '/api/members/register', { body: signup({ email }) });
    assert.equal(res.status, 200, res.text);
  }
  const blocked = await request('POST', '/api/members/register', { body: signup({ email }) });
  assert.equal(blocked.status, 429);
  assert.ok(blocked.headers['retry-after']);
});

test('the waitlist form rejects a honeypot and accepts a normal submit', async () => {
  const page = await request('GET', '/api/members/join');
  assert.equal(page.status, 200);
  assert.match(page.text, /PLACEHOLDER/);
  const token = page.text.match(/name="form_token" value="([^"]+)"/)[1];
  const cookie = page.headers['set-cookie'].join(';').match(/amu_join=([^;]+)/)[1];
  const bot = await request('POST', '/api/members/register', {
    headers: { cookie: `amu_join=${cookie}` },
    body: signup({
      email: 'bot@acme.test',
      client: 'waitlist-form',
      form_token: token,
      started_at: Date.now() - 5000,
      company_url_2: 'http://spam.test',
    }),
  });
  assert.equal(bot.status, 400);
  const page2 = await request('GET', '/api/members/join');
  const token2 = page2.text.match(/name="form_token" value="([^"]+)"/)[1];
  const cookie2 = page2.headers['set-cookie'].join(';').match(/amu_join=([^;]+)/)[1];
  const ok = await request('POST', '/api/members/register', {
    headers: { cookie: `amu_join=${cookie2}` },
    body: signup({
      email: 'human@acme.test',
      client: 'waitlist-form',
      form_token: decodeURIComponent(token2),
      started_at: Date.now() - 5000,
    }),
  });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.stored, true);
  const log = fs.readFileSync(mailPath, 'utf8');
  assert.match(log, /PLACEHOLDER/);
  assert.doesNotMatch(log, /brevo/i);
});

test('log is the default mail mode and brevo is refused', async () => {
  const { sendMail } = require('../mailer');
  const result = await sendMail({ to: 'ada@acme.test', subject: 'n', text: 'hello' });
  assert.equal(result.mode, 'log');
  assert.equal(result.delivered, false);
  process.env.EMAIL_MODE = 'brevo';
  await assert.rejects(() => sendMail({ to: 'ada@acme.test', subject: 'n', text: 'hello' }), /not supported/);
  process.env.EMAIL_MODE = 'log';
});

test.after(() => {
  for (const file of [dbPath, mailPath]) {
    try { fs.unlinkSync(file); } catch { /* already gone */ }
  }
});
