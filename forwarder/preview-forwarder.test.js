'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { createForwarder } = require('./preview-forwarder.js');
const auth = require('./auth.js');

const KEY = crypto.randomBytes(32);
const COOKIE = `${auth.COOKIE_NAME}=${auth.signSession(KEY, { tenant: 't', user: 'u', instance: 't-p' }, Math.floor(Date.now() / 1000))}`;

const sockets = new Set();

function listen(server) {
  server.on('connection', (c) => {
    sockets.add(c);
    c.on('close', () => sockets.delete(c));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function request(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { Cookie: COOKIE, ...headers }, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

let upstream;
let upstreamPort;
let fwd;
let fwdPort;
let deadFwd;
let deadFwdPort;

before(async () => {
  upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(201, { 'X-Upstream': 'yes', 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          method: req.method,
          url: req.url,
          host: req.headers.host,
          custom: req.headers['x-custom'],
          body: Buffer.concat(chunks).toString(),
        })
      );
    });
  });
  // Minimal WebSocket-style upgrade: answer 101 and echo bytes back upper-cased.
  upstream.on('upgrade', (req, socket) => {
    const accept = crypto
      .createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nX-Path: ${req.url}\r\n\r\n`
    );
    socket.on('data', (d) => socket.write(d.toString().toUpperCase()));
  });
  upstreamPort = await listen(upstream);
  fwd = createForwarder({ previewPort: upstreamPort, handoffKey: KEY });
  fwdPort = await listen(fwd);

  // A port that nothing listens on.
  const tmp = net.createServer();
  const deadPort = await listen(tmp);
  await new Promise((r) => tmp.close(r));
  deadFwd = createForwarder({ previewPort: deadPort, handoffKey: KEY });
  deadFwdPort = await listen(deadFwd);
});

after(() => {
  for (const c of sockets) c.destroy();
  for (const s of [upstream, fwd, deadFwd]) s.close();
});

test('forwards method, path, query, headers and body', async () => {
  const res = await request(fwdPort, {
    method: 'POST',
    path: '/a/b?x=1&y=2',
    headers: { 'X-Custom': 'abc', 'Content-Type': 'text/plain' },
    body: 'hello body',
  });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.headers['x-upstream'], 'yes');
  const got = JSON.parse(res.body);
  assert.deepStrictEqual(got, {
    method: 'POST',
    url: '/a/b?x=1&y=2',
    host: `127.0.0.1:${fwdPort}`,
    custom: 'abc',
    body: 'hello body',
  });
});

test('forwards a WebSocket upgrade and relays bytes both ways', async () => {
  const key = crypto.randomBytes(16).toString('base64');
  const socket = net.connect(fwdPort, '127.0.0.1');
  const received = await new Promise((resolve, reject) => {
    let buf = '';
    let sent = false;
    socket.on('error', reject);
    socket.on('connect', () => {
      socket.write(
        `GET /ws?token=1 HTTP/1.1\r\nHost: x\r\nCookie: ${COOKIE}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
    });
    socket.on('data', (d) => {
      buf += d.toString();
      if (!sent && buf.includes('\r\n\r\n')) {
        sent = true;
        socket.write('ping');
      }
      if (buf.endsWith('PING')) resolve(buf);
    });
  });
  socket.destroy();
  assert.match(received, /^HTTP\/1\.1 101 /);
  assert.match(received, /x-path: \/ws\?token=1/i);
  assert.ok(received.endsWith('PING'));
});

test('answers 502 with the not-running page when nothing listens, and keeps serving', async () => {
  for (let i = 0; i < 2; i++) {
    const res = await request(deadFwdPort, { path: '/' });
    assert.strictEqual(res.status, 502);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.body, /preview is not running/);
  }
});

test('answers 502 on a WebSocket upgrade with no upstream', async () => {
  const socket = net.connect(deadFwdPort, '127.0.0.1');
  const data = await new Promise((resolve, reject) => {
    let buf = '';
    socket.on('error', reject);
    socket.on('connect', () =>
      socket.write(`GET /ws HTTP/1.1\r\nHost: x\r\nCookie: ${COOKIE}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: abc\r\nSec-WebSocket-Version: 13\r\n\r\n`)
    );
    socket.on('data', (d) => (buf += d.toString()));
    socket.on('close', () => resolve(buf));
  });
  assert.match(data, /^HTTP\/1\.1 502 /);
});

test('GET /__liivo/open answers 302 to /', async () => {
  for (const path of ['/__liivo/open', '/__liivo/open?next=%2Fx']) {
    const res = await request(fwdPort, { path });
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.location, '/');
  }
});

function raw(port, text, withSession = true) {
  if (withSession) text = text.replace('\r\n', `\r\nCookie: ${COOKIE}\r\n`);
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let buf = '';
    socket.on('error', reject);
    socket.on('connect', () => socket.write(text));
    socket.on('data', (d) => (buf += d.toString()));
    socket.on('close', () => resolve(buf));
  });
}

test('absolute-form, encoded, cased and dot-segment targets hit the reserved namespace', async () => {
  const targets = [
    'http://x/__liivo/other',
    'http://x/__LIIVO/other',
    '/%5f%5fliivo/other',
    '//__liivo/other',
    '/a/../__liivo/other',
    '/__liivo',
  ];
  for (const t of targets) {
    const out = await raw(fwdPort, `GET ${t} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
    assert.match(out, /^HTTP\/1\.1 404 /, t);
  }
  const open = await raw(fwdPort, 'GET http://x/__liivo/open HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
  assert.match(open, /^HTTP\/1\.1 302 /);
});

// The two guard tests that stood here ("a WebSocket upgrade on a /__liivo/ path answers 404 and is not
// forwarded", "other /__liivo/ paths are reserved and answer 404, never forwarded") pinned the behaviour
// before the bridge existed (W1 AC2, liivo-studio-space#3: not ADR-pinned). Since amendment 6 /__liivo/*
// goes to the bridge after the session check; bridge-routing.test.js has their replacements:
// /__liivo/ws reaches a fake bridge with the gateway's bearer only (F2: the session cookie is no credential for it) and
// /__liivo/chat.html is 404, /__liivo/bridge/x answers 404, /__liivo/open/x keeps its 404.
test('/__liivo/open/x and the forms of a request target that are not plain stay reserved and are not forwarded', async () => {
  for (const path of ['/__liivo/open/x', '/__liivo/status/x', '/__liivo/bridge/x', '/__liivo/']) {
    const res = await request(fwdPort, { path });
    assert.strictEqual(res.status, 404, path);
  }
});
