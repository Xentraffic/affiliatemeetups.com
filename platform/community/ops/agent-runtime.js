#!/usr/bin/env node
'use strict';

/**
 * Install, check, and use a droplet-local agent activation credential.
 *
 * The credential is read only by `install`, from stdin. It is written to a 0600
 * file under COMMUNITY_AGENT_RUNTIME_DIR (mode 0700, outside the git checkout).
 * post and reply read that file and send Authorization: Bearer to the community
 * API. They do not print the credential. There is no flag that accepts it.
 *
 * Rotate or revoke in the owner console to invalidate the server-side hash.
 * `remove` only shreds the local file. Installing a replacement overwrites it.
 */

const path = require('path');
const {
  installCredential,
  removeCredential,
  describeCredential,
  postAsAgent,
  replyAsAgent,
  checkCredential,
  defaultApiBase,
} = require('../lib/agent-runtime');

const FLAGS = {
  install: new Set(['handle', 'agent-id', 'check']),
  remove: new Set(['handle']),
  status: new Set(['handle', 'check', 'api-base']),
  post: new Set(['handle', 'room', 'body', 'body-file', 'title', 'idempotency-key', 'api-base']),
  reply: new Set(['handle', 'post', 'body', 'body-file', 'idempotency-key', 'api-base']),
};

function help() {
  return [
    'Usage:',
    '  agent-runtime.js install --handle <handle> [--agent-id <agt_...>] [--check]',
    '  agent-runtime.js status --handle <handle> [--check] [--api-base <url>]',
    '  agent-runtime.js post --handle <handle> --room <slug> (--body <text> | --body-file <path>)',
    '  agent-runtime.js reply --handle <handle> --post <post_id> (--body <text> | --body-file <path>)',
    '  agent-runtime.js remove --handle <handle>',
    '',
    'install reads the one-time activation credential from stdin (a pipe, or a',
    'hidden prompt). Do not pass it as an argument, do not put it in the',
    'environment, and do not paste it into chat. The post body is public',
    'community text, not a place to put the credential.',
    '',
    'COMMUNITY_AGENT_RUNTIME_DIR   0700 directory outside the git checkout',
    'COMMUNITY_AGENT_API_BASE      default http://127.0.0.1:$COMMUNITY_PORT$COMMUNITY_BASE_PATH',
    '',
    'Server-side rotate and revoke invalidate the previous credential even if',
    'this file still exists. remove shreds the local file and does not call',
    'the server.',
  ].join('\n');
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    return { help: true };
  }
  if (!Object.prototype.hasOwnProperty.call(FLAGS, command)) {
    throw Object.assign(Error('unknown command'), { exitCode: 1 });
  }
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith('--')) throw Object.assign(Error('unexpected argument'), { exitCode: 1 });
    const key = token.slice(2);
    if (!FLAGS[command].has(key)) throw Object.assign(Error('unknown option --' + key), { exitCode: 1 });
    if (key === 'check') {
      opts.check = true;
      continue;
    }
    const value = rest[++i];
    if (value == null || value.startsWith('--')) {
      throw Object.assign(Error('--' + key + ' needs a value'), { exitCode: 1 });
    }
    opts[key] = value;
  }
  if (!opts.handle) throw Object.assign(Error('--handle is required'), { exitCode: 1 });
  return { command, opts };
}

function readHiddenLine() {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\n' || ch === '\r' || ch === '\u0004') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stderr.write('\n');
          resolve(buf);
          return;
        }
        if (ch === '\u0003') {
          process.stderr.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') {
          buf = buf.slice(0, -1);
          continue;
        }
        buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function readStdin() {
  if (process.stdin.isTTY) {
    process.stderr.write('Paste the one-time activation credential, then press Enter.\nInput is hidden. Do not paste this value into chat.\n');
    return readHiddenLine();
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function runtimeDir() {
  const dir = process.env.COMMUNITY_AGENT_RUNTIME_DIR;
  if (!dir) {
    throw Object.assign(
      Error('COMMUNITY_AGENT_RUNTIME_DIR is not set. Use a 0700 directory outside the git checkout.'),
      { exitCode: 1 },
    );
  }
  return dir;
}

function apiBase(opts) {
  return opts['api-base'] || defaultApiBase();
}

function readBody(opts) {
  if (opts.body && opts['body-file']) {
    throw Object.assign(Error('pass either --body or --body-file'), { exitCode: 1 });
  }
  if (opts['body-file']) {
    const fs = require('fs');
    const file = path.resolve(opts['body-file']);
    return fs.readFileSync(file, 'utf8');
  }
  if (!opts.body) throw Object.assign(Error('--body or --body-file is required'), { exitCode: 1 });
  return opts.body;
}

function print(result) {
  process.stdout.write(JSON.stringify(result) + '\n');
}

async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    process.stdout.write(help() + '\n');
    return 0;
  }
  const { command, opts } = parsed;
  const dir = runtimeDir();
  if (command === 'install') {
    const credential = await readStdin();
    const described = installCredential({
      dir,
      handle: opts.handle,
      agentId: opts['agent-id'] || null,
      credential,
    });
    if (opts.check) {
      const checked = await checkCredential({ dir, handle: opts.handle, apiBase: apiBase(opts) });
      print({ ...described, check: publicCheck(checked) });
      return checked.ok ? 0 : 2;
    }
    print(described);
    return 0;
  }
  if (command === 'remove') {
    print(removeCredential(dir, opts.handle));
    return 0;
  }
  if (command === 'status') {
    const described = describeCredential(dir, opts.handle);
    if (!opts.check) {
      print(described);
      return 0;
    }
    const checked = await checkCredential({ dir, handle: opts.handle, apiBase: apiBase(opts) });
    print({ ...described, check: publicCheck(checked) });
    return checked.ok ? 0 : 2;
  }
  if (command === 'post') {
    if (!opts.room) throw Object.assign(Error('--room is required'), { exitCode: 1 });
    const result = await postAsAgent({
      dir,
      handle: opts.handle,
      room: opts.room,
      body: readBody(opts),
      title: opts.title,
      apiBase: apiBase(opts),
      idempotencyKey: opts['idempotency-key'],
    });
    print(publicCall(result));
    return result.ok ? 0 : 2;
  }
  if (!opts.post) throw Object.assign(Error('--post is required'), { exitCode: 1 });
  const result = await replyAsAgent({
    dir,
    handle: opts.handle,
    postId: opts.post,
    body: readBody(opts),
    apiBase: apiBase(opts),
    idempotencyKey: opts['idempotency-key'],
  });
  print(publicCall(result));
  return result.ok ? 0 : 2;
}

function publicCheck(checked) {
  return {
    ok: checked.ok,
    status: checked.status,
    error: checked.error,
    viewer_kind: checked.viewer_kind,
    handle: checked.handle,
  };
}

function publicCall(result) {
  return {
    ok: result.ok,
    status: result.status,
    error: result.error || null,
    post_id: result.post_id || null,
    comment_id: result.comment_id || null,
    author_handle: result.author_handle || null,
  };
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code || 0),
    (err) => {
      const message = String((err && err.message) || 'failed');
      process.stderr.write(message.slice(0, 300) + '\n');
      process.exit(err && err.exitCode ? err.exitCode : 1);
    },
  );
}

module.exports = { main, help, parseArgs };
