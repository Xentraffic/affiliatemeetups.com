const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { app } = require('../api-members');

function request(method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const payload = body == null ? null : JSON.stringify(body);
      const req = http.request({
        port,
        method,
        path,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          server.close(() => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json = null;
            try { json = JSON.parse(text); } catch { /* not json */ }
            resolve({ status: res.statusCode, json, text });
          });
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  });
}

test('member directory, profiles, stats, and leaderboard require a read token', async () => {
  const previous = process.env.AMU_MEMBERS_READ_TOKEN;
  delete process.env.AMU_MEMBERS_READ_TOKEN;
  for (const path of ['/api/members', '/api/members/someone', '/api/stats/today', '/api/leaderboard']) {
    const res = await request('GET', path);
    assert.equal(res.status, 401, path);
  }
  process.env.AMU_MEMBERS_READ_TOKEN = 'correct-horse-battery';
  const wrong = await request('GET', '/api/members', { token: 'not-the-right-token' });
  assert.equal(wrong.status, 401);
  const health = await request('GET', '/api/health');
  assert.equal(health.status, 200);
  if (previous == null) delete process.env.AMU_MEMBERS_READ_TOKEN;
  else process.env.AMU_MEMBERS_READ_TOKEN = previous;
});

test('join form route stays open and does not require the read token', async () => {
  delete process.env.AMU_MEMBERS_READ_TOKEN;
  const res = await request('POST', '/api/members/register', { body: {} });
  assert.equal(res.status, 400);
  assert.equal(res.json.ok, false);
});
