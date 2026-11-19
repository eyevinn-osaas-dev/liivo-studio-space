'use strict';
// POST /__liivo/bridge/reload: gateway token only, honoured only when the bridge's loopback /health says
// busy === false. A fake bridge answers /health; the forwarder under test is the real one.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const auth = require('./auth.js');
const { createForwarder } = require('./preview-forwarder.js');

const KEY = crypto.randomBytes(32);
const HOST = 'tenant-proj.eyevinn-liivo-studio-space.auto.dev.osaas.io';
const nowS = () => Math.floor(Date.now() / 1000);
const RELOAD = '/__liivo/bridge/reload';

let tmp;
let stateFile;
let requestFile;
let healthReply = { status: 200, body: '{"ok":true,"busy":false}' };
let bridgeSeen = [];
let bridge;
let fwd;
let port;
let bridgePort;
const servers = new Set();

function listen(server) {
  servers.add(server);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function call({ method = 'POST', headers = {}, p = RELOAD, target = port } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: target, method, path: p, headers: { Host: HOST, ...headers }, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

const token = (over = {}) =>
  auth.signToken(KEY, { aud: 'gateway', host: '', tenant: 'tenant', user: '', instance: 'tenant-proj', exp: nowS() + 30, ...over });
const bearer = (t = token()) => ({ Authorization: `Bearer ${t}` });
const sessionCookie = () => `${auth.COOKIE_NAME}=${auth.signSession(KEY, { tenant: 'tenant', user: 'u1', instance: 'tenant-proj' }, nowS())}`;
const writeState = (state) => fs.writeFileSync(stateFile, JSON.stringify({ state, version: 'v1' }));
const requested = () => fs.existsSync(requestFile);

before(async () => {
  tmp = fs.mkdtempSync(path.join('/tmp', 'lsrl-'));
  stateFile = path.join(tmp, 'state.json');
  requestFile = path.join(tmp, 'reload-request');
  bridge = http.createServer((req, res) => {
    bridgeSeen.push(`${req.method} ${req.url}`);
    res.writeHead(healthReply.status, { 'content-type': 'application/json' });
    res.end(healthReply.body);
  });
  bridgePort = await listen(bridge);
  fwd = createForwarder({
    previewPort: 1, bridgePort, handoffKey: KEY, instance: 'tenant-proj', bridgeStateFile: stateFile, reloadRequestFile: requestFile, idleReadTimeoutMs: 300,
  });
  port = await listen(fwd);
});

after(() => {
  for (const s of servers) s.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const reset = (reply = { status: 200, body: '{"ok":true,"busy":false}' }, state = 'running') => {
  healthReply = reply;
  bridgeSeen = [];
  fs.rmSync(requestFile, { force: true });
  writeState(state);
};

test('idle bridge, gateway token: 202 {"reload":"started"} and the request file is recorded (passing path)', async () => {
  reset();
  const res = await call({ headers: bearer() });
  assert.strictEqual(res.status, 202);
  assert.deepStrictEqual(JSON.parse(res.body), { reload: 'started' });
  assert.ok(requested());
  assert.strictEqual(fs.statSync(requestFile).mode & 0o777, 0o600);
  assert.deepStrictEqual(bridgeSeen, ['GET /health']);
});

test('busy bridge: 409 refused with reason busy, no request file', async () => {
  reset({ status: 200, body: '{"busy":true}' });
  const res = await call({ headers: bearer() });
  assert.strictEqual(res.status, 409);
  assert.deepStrictEqual(JSON.parse(res.body), { reload: 'refused', reason: 'busy' });
  assert.ok(!requested());
});

test('busy missing or not a boolean: 409 reason unknown, no request file', async () => {
  for (const body of ['{"ok":true}', '{"busy":"false"}', '{"busy":null}', 'not json', '[]']) {
    reset({ status: 200, body });
    const res = await call({ headers: bearer() });
    assert.strictEqual(res.status, 409, body);
    assert.strictEqual(JSON.parse(res.body).reason, 'unknown');
    assert.ok(!requested(), body);
  }
});

test('non-200 health answer: refused, no request file', async () => {
  reset({ status: 500, body: '{"busy":false}' });
  const res = await call({ headers: bearer() });
  assert.strictEqual(res.status, 409);
  assert.ok(!requested());
});

test('no answer (a bridge that hangs) is refused within the deadline when the state is running', async () => {
  const hang = http.createServer(() => {});
  const hp = await listen(hang);
  const f = createForwarder({ previewPort: 1, bridgePort: hp, handoffKey: KEY, instance: 'tenant-proj', bridgeStateFile: stateFile, reloadRequestFile: requestFile, idleReadTimeoutMs: 200 });
  const fp = await listen(f);
  reset(undefined, 'running');
  const t0 = Date.now();
  const res = await call({ headers: bearer(), target: fp });
  assert.strictEqual(res.status, 409);
  assert.strictEqual(JSON.parse(res.body).reason, 'unknown');
  assert.ok(Date.now() - t0 < 2000);
  assert.ok(!requested());
  hang.closeAllConnections();
});

async function noAnswer(state) {
  const dead = net.createServer();
  const dp = await listen(dead);
  await new Promise((r) => dead.close(r));
  const f = createForwarder({ previewPort: 1, bridgePort: dp, handoffKey: KEY, instance: 'tenant-proj', bridgeStateFile: stateFile, reloadRequestFile: requestFile });
  const fp = await listen(f);
  reset(undefined, state);
  return call({ headers: bearer(), target: fp });
}

test('no answer from the bridge: state starting honours, running and unavailable refuse', async () => {
  const starting = await noAnswer('starting');
  assert.strictEqual(starting.status, 202);
  assert.ok(requested());
  const running = await noAnswer('running');
  assert.strictEqual(running.status, 409);
  assert.ok(!requested());
  const unavailable = await noAnswer('unavailable');
  assert.strictEqual(unavailable.status, 409);
  assert.ok(!requested());
});

test('a request file that cannot be written answers 409 unknown, never 202', async () => {
  reset();
  const f = createForwarder({ previewPort: 1, bridgePort, handoffKey: KEY, instance: 'tenant-proj', bridgeStateFile: stateFile, reloadRequestFile: path.join(tmp, 'no-such-dir', 'reload-request') });
  const fp = await listen(f);
  const res = await call({ headers: bearer(), target: fp });
  assert.strictEqual(res.status, 409);
  assert.strictEqual(JSON.parse(res.body).reason, 'unknown');
});

test('no token, malformed, expired, other key, browser and git audiences, another instance: 401 with WWW-Authenticate, bridge never asked', async () => {
  const cases = [
    {},
    bearer('garbage'),
    bearer(token({ exp: nowS() - 5 })),
    bearer(auth.signToken(crypto.randomBytes(32), { aud: 'gateway', host: '', tenant: 'tenant', user: '', instance: 'tenant-proj', exp: nowS() + 30 })),
    bearer(token({ aud: 'browser' })),
    bearer(token({ aud: 'git' })),
    { Cookie: sessionCookie() },
    { ...bearer(token({ aud: 'browser' })), Cookie: sessionCookie() },
  ];
  for (const headers of cases) {
    reset();
    const res = await call({ headers });
    assert.strictEqual(res.status, 401, JSON.stringify(headers));
    assert.strictEqual(res.headers['www-authenticate'], 'Bearer');
    assert.deepStrictEqual(JSON.parse(res.body), { error: 'unauthorized' });
    assert.ok(!requested());
    assert.deepStrictEqual(bridgeSeen, []);
  }
  // another instance, once the workspace knows its own
  reset();
  const f = createForwarder({ previewPort: 1, bridgePort, handoffKey: KEY, instance: 'tenant-proj', bridgeStateFile: stateFile, reloadRequestFile: requestFile });
  const fp = await listen(f);
  assert.strictEqual((await call({ headers: bearer(), target: fp })).status, 202);
  fs.rmSync(requestFile, { force: true });
  assert.strictEqual((await call({ headers: bearer(token({ instance: 'other-proj' })), target: fp })).status, 401);
  assert.ok(!requested());
});

test('a valid gateway token with another method: 405 Allow POST, nothing changed', async () => {
  for (const method of ['GET', 'PUT', 'DELETE']) {
    reset();
    const res = await call({ method, headers: bearer() });
    assert.strictEqual(res.status, 405, method);
    assert.strictEqual(res.headers.allow, 'POST');
    assert.ok(!requested());
    assert.deepStrictEqual(bridgeSeen, []);
  }
});

test('the route is matched on the normalised path; other /__liivo/bridge/* paths stay 404 for a session', async () => {
  reset();
  assert.strictEqual((await call({ headers: bearer(), p: '/__liivo/bridge//reload' })).status, 202);
  fs.rmSync(requestFile, { force: true });
  const other = await call({ headers: { Cookie: sessionCookie() }, p: '/__liivo/bridge/x' });
  assert.strictEqual(other.status, 404);
  const post = await call({ headers: { Cookie: sessionCookie(), ...bearer() }, p: '/__liivo/bridge/other' });
  assert.strictEqual(post.status, 404);
  assert.ok(!requested());
});

test('a WebSocket upgrade to the reload path is not answered by the route', async () => {
  reset();
  const out = await new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    let buf = '';
    s.on('error', reject);
    s.on('connect', () => s.write(`GET ${RELOAD} HTTP/1.1\r\nHost: ${HOST}\r\nAuthorization: Bearer ${token()}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: abc\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    s.on('data', (d) => (buf += d.toString()));
    s.on('close', () => resolve(buf));
  });
  assert.match(out, /^HTTP\/1\.1 401 /);
  assert.ok(!requested());
  assert.deepStrictEqual(bridgeSeen, []);
});
