'use strict';
// The edit proxy's routing of /__liivo/* to the bridge (design D26), its page-tag injection (D27), the
// bridge state in /__liivo/status and the signer's /bridge-token. A fake bridge and a fake preview
// listen on loopback; the forwarder under test is the real one.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const vm = require('node:vm');
const crypto = require('node:crypto');
const auth = require('./auth.js');
const inject = require('./inject.js');
const { createForwarder, listenOnSocket } = require('./preview-forwarder.js');

const KEY = crypto.randomBytes(32);
const HOST = 'tenant-proj.eyevinn-liivo-studio-space.auto.dev.osaas.io';
const GATEWAY = 'https://gw.example.test';
const nowS = () => Math.floor(Date.now() / 1000);
const COOKIE = `${auth.COOKIE_NAME}=${auth.signSession(KEY, { tenant: 'tenant', user: 'u1', instance: 'tenant-proj' }, nowS())}`;
const TAG = '<script src="/__liivo/client.js" defer></script>';

const sockets = new Set();
function listen(server, host = '127.0.0.1') {
  server.on('connection', (c) => {
    sockets.add(c);
    c.on('close', () => sockets.delete(c));
  });
  return new Promise((resolve) => server.listen(0, host, () => resolve(server.address().port)));
}

function request(port, { method = 'GET', path: p = '/', headers = {}, body, session = true, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const h = { Host: HOST, ...(session ? { Cookie: COOKIE } : {}), ...headers };
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: h, agent: false }, (res) => {
      const chunks = [];
      const times = [];
      res.on('data', (c) => { chunks.push(c); times.push(Date.now()); });
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders, buf, body: raw ? '' : buf.toString('utf8'), times });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// A raw HTTP/1.1 exchange (for request targets and upgrades a client library would normalise).
function rawExchange(port, text) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let buf = '';
    socket.on('error', reject);
    socket.on('connect', () => socket.write(text));
    socket.on('data', (d) => {
      buf += d.toString();
      if (buf.startsWith('HTTP/1.1 101') && buf.includes('\r\n\r\n') && !buf.includes('PONG-DONE')) {
        socket.write('ping');
      }
      if (buf.endsWith('PING')) socket.destroy();
    });
    socket.on('close', () => resolve(buf));
  });
}

const upgradeText = (p, headers = {}, withSession = true) =>
  `GET ${p} HTTP/1.1\r\nHost: ${HOST}\r\n${withSession ? `Cookie: ${COOKIE}\r\n` : ''}Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: abc\r\nSec-WebSocket-Version: 13\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n`;

let tmp;
let bridgeSeen = [];
let previewSeen = [];
let bridge;
let preview;
let fwd;
let fwdPort;
let downFwd;
let downPort;
let deadPreviewFwd;
let deadPreviewPort;
let stateFile;

const html = (body) => `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>\n`;

before(async () => {
  tmp = fs.mkdtempSync(path.join('/tmp', 'lsr-'));
  stateFile = path.join(tmp, 'bridge-state.json');

  bridge = http.createServer((req, res) => {
    bridgeSeen.push({ method: req.method, url: req.url, headers: req.headers });
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`bridge saw ${req.url}`);
  });
  bridge.on('upgrade', (req, socket) => {
    bridgeSeen.push({ method: req.method, url: req.url, headers: req.headers, upgrade: true });
    const accept = crypto.createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on('data', (d) => socket.write(d.toString().toUpperCase()));
  });
  const bridgePort = await listen(bridge);

  const big = html(`<p>${'x'.repeat(9000)}</p>`);
  preview = http.createServer((req, res) => {
    previewSeen.push({ method: req.method, url: req.url, headers: req.headers });
    const u = req.url.split('?')[0];
    if (u === '/page') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': ['a=1; Path=/', 'b=2; Path=/'], etag: '"abc"', 'cache-control': 'max-age=60', 'content-length': Buffer.byteLength(html('<h1>hello</h1>')) });
      return res.end(html('<h1>hello</h1>'));
    }
    if (u === '/two-bodies') return res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body><script>var s = "</body>";</script><p>x</p></body></html>');
    if (u === '/no-body') return res.writeHead(200, { 'content-type': 'text/html' }).end('<h1>fragment</h1>');
    if (u === '/csp-header') return res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "default-src 'self'; script-src 'self' 'nonce-abcDEF123456'" }).end(html('x'));
    if (u === '/csp-meta') {
      return res.writeHead(200, { 'content-type': 'text/html' }).end(`<html><head><meta http-equiv="Content-Security-Policy" content="script-src 'nonce-metaNonce12345'"></head><body>x</body></html>`);
    }
    if (u === '/csp-hostile') {
      return res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': `script-src 'nonce-abcdefgh"onload="alert(1)'` }).end(html('x'));
    }
    if (u === '/gzip') return res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }).end(zlib.gzipSync(html('zipped')));
    if (u === '/json') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"a":"</body>"}');
    if (u === '/text') return res.writeHead(200, { 'content-type': 'text/plain' }).end('plain </body>');
    if (u === '/partial') return res.writeHead(206, { 'content-type': 'text/html', 'content-range': 'bytes 0-9/100' }).end('0123456789');
    if (u === '/has-tag') return res.writeHead(200, { 'content-type': 'text/html' }).end(html(TAG));
    if (u === '/big') return res.writeHead(200, { 'content-type': 'text/html', 'content-length': Buffer.byteLength(big), etag: '"big"' }).end(big);
    if (u === '/slow') {
      res.writeHead(200, { 'content-type': 'text/html', etag: '"slow"' });
      res.write('<html><body><p>first</p>');
      return setTimeout(() => res.end('<p>second</p></body></html>'), 700);
    }
    if (u === '/not-found') return res.writeHead(404, { 'content-type': 'text/html' }).end(html('<h1>404</h1>'));
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ method: req.method, url: req.url }));
  });
  preview.on('upgrade', (req, socket) => {
    previewSeen.push({ method: req.method, url: req.url, headers: req.headers, upgrade: true });
    const accept = crypto.createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on('data', (d) => socket.write(d.toString().toUpperCase()));
  });
  const previewPort = await listen(preview);

  fwd = createForwarder({
    previewPort, bridgePort, handoffKey: KEY, gatewayUrl: GATEWAY, instance: 'tenant-proj', projectDir: path.join(tmp, 'project'),
    bridgeStateFile: stateFile, injectMaxBytes: 4096, injectTimeoutMs: 250,
  });
  fwdPort = await listen(fwd);

  // a port that nothing listens on
  const tmpSrv = net.createServer();
  const deadPort = await listen(tmpSrv);
  await new Promise((r) => tmpSrv.close(r));
  downFwd = createForwarder({ previewPort, bridgePort: deadPort, handoffKey: KEY, gatewayUrl: GATEWAY, instance: 'tenant-proj' });
  downPort = await listen(downFwd);
  deadPreviewFwd = createForwarder({ previewPort: deadPort, bridgePort, handoffKey: KEY, gatewayUrl: GATEWAY, instance: 'tenant-proj' });
  deadPreviewPort = await listen(deadPreviewFwd);
});

after(() => {
  for (const c of sockets) c.destroy();
  for (const s of [bridge, preview, fwd, downFwd, deadPreviewFwd]) s.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const reset = () => { bridgeSeen = []; previewSeen = []; };

// ---- routing: the replacements of the lifted guard tests ----

test('/__liivo/vendor/modern-screenshot.js with a session reaches the bridge, with the host and without the session cookie or forwarded headers', async () => {
  reset();
  const res = await request(fwdPort, { path: '/__liivo/vendor/modern-screenshot.js?x=1', headers: { 'X-Forwarded-Host': 'evil.test', Cookie: `${COOKIE}; other=1` }, session: false });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body, 'bridge saw /__liivo/vendor/modern-screenshot.js?x=1');
  assert.strictEqual(bridgeSeen.length, 1);
  assert.strictEqual(bridgeSeen[0].headers.host, HOST, 'the public host reaches the bridge (its Origin check needs it)');
  assert.strictEqual(bridgeSeen[0].headers.cookie, 'other=1', 'the session cookie does not reach the bridge');
  assert.ok(!('x-forwarded-host' in bridgeSeen[0].headers));
  assert.strictEqual(previewSeen.length, 0);
});

test('nested bridge paths and HEAD are forwarded too', async () => {
  reset();
  assert.strictEqual((await request(fwdPort, { path: '/__liivo/vendor/modern-screenshot.js' })).status, 200);
  assert.strictEqual((await request(fwdPort, { path: '/__liivo/health' })).status, 200);
  assert.strictEqual((await request(fwdPort, { method: 'HEAD', path: '/__liivo/client.js' })).status, 200);
  assert.deepStrictEqual(bridgeSeen.map((r) => `${r.method} ${r.url}`), ['GET /__liivo/vendor/modern-screenshot.js', 'GET /__liivo/health', 'HEAD /__liivo/client.js']);
});

test('without a session a bridge file answers 401 (a navigation: 302), and nothing reaches the bridge', async () => {
  reset();
  const noSession = await request(fwdPort, { path: '/__liivo/health', session: false });
  assert.strictEqual(noSession.status, 401);
  const nav = await request(fwdPort, { path: '/__liivo/health', session: false, headers: { Accept: 'text/html' } });
  assert.strictEqual(nav.status, 302);
  assert.match(nav.headers.location, /\/w\/tenant-proj$/);
  assert.strictEqual(bridgeSeen.length, 0);
});

// ---- F2 (Eyevinn/liivo-studio#45, N1): the chat is not served here, and its socket answers the gateway's token only ----

const gatewayBearer = (over = {}) =>
  auth.signToken(KEY, { aud: 'gateway', host: HOST, tenant: 'tenant', user: 'u1', instance: 'tenant-proj', exp: nowS() + 30, ...over });
const socketText = (headers = {}, p = '/__liivo/ws') =>
  `GET ${p} HTTP/1.1\r\nHost: ${HOST}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n`;

test('/__liivo/ws with the gateway\'s bearer reaches the bridge with the public host as Host and Origin, no Authorization, no cookie, and relays bytes both ways', async () => {
  reset();
  const out = await rawExchange(fwdPort, socketText({ Authorization: `Bearer ${gatewayBearer()}`, Cookie: COOKIE, 'X-Forwarded-For': '1.2.3.4', 'Sec-WebSocket-Protocol': 'liivo.v1' }));
  assert.match(out, /^HTTP\/1\.1 101 /);
  assert.ok(out.endsWith('PING'), 'bytes flow both ways');
  assert.strictEqual(bridgeSeen.length, 1);
  const seen = bridgeSeen[0];
  assert.strictEqual(seen.url, '/__liivo/ws');
  assert.strictEqual(seen.headers.host, HOST);
  assert.strictEqual(seen.headers.origin, `https://${HOST}`, 'the bridge sees the Origin its own check compares');
  assert.strictEqual(seen.headers['sec-websocket-protocol'], 'liivo.v1');
  for (const h of ['authorization', 'cookie', 'x-forwarded-for']) assert.ok(!(h in seen.headers), `${h} does not reach the bridge`);
  assert.strictEqual(previewSeen.length, 0);
});

test('/__liivo/ws with only the edit-proxy session answers 401 and is not forwarded, with or without the page\'s own Origin (what a page script has)', async () => {
  reset();
  for (const headers of [{ Cookie: COOKIE, Origin: `https://${HOST}` }, { Cookie: COOKIE }, { Cookie: COOKIE, Origin: 'https://evil.test' }, {}]) {
    assert.match(await rawExchange(fwdPort, socketText(headers)), /^HTTP\/1\.1 401 /, JSON.stringify(Object.keys(headers)));
  }
  assert.strictEqual(bridgeSeen.length, 0);
  // the spelling does not matter either
  for (const p of ['/__LIIVO/WS', '/%5f%5fliivo/ws', '//__liivo/ws']) {
    assert.match(await rawExchange(fwdPort, socketText({ Cookie: COOKIE, Origin: `https://${HOST}` }, p)), /^HTTP\/1\.1 401 /, p);
  }
  assert.strictEqual(bridgeSeen.length, 0);
});

test('/__liivo/ws refuses a bearer that is not the gateway\'s for this instance: other audience, other key, expired, other instance, no host, a token in the URL', async () => {
  reset();
  const other = crypto.randomBytes(32);
  for (const [why, bearer] of [
    ['audience git', gatewayBearer({ aud: 'git' })], ['audience browser', gatewayBearer({ aud: 'browser' })], ['audience bridge', gatewayBearer({ aud: 'bridge' })],
    ['another key', auth.signToken(other, { aud: 'gateway', host: HOST, tenant: 'tenant', user: 'u1', instance: 'tenant-proj', exp: nowS() + 30 })],
    ['expired', gatewayBearer({ exp: nowS() - 5 })], ['too far ahead', gatewayBearer({ exp: nowS() + 600 })],
    ['another instance', gatewayBearer({ instance: 'other-proj' })], ['no host', gatewayBearer({ host: '' })], ['a host with a space', gatewayBearer({ host: 'a b' })],
  ]) {
    assert.match(await rawExchange(fwdPort, socketText({ Authorization: `Bearer ${bearer}` })), /^HTTP\/1\.1 401 /, why);
  }
  assert.match(await rawExchange(fwdPort, socketText({ Cookie: COOKIE }, `/__liivo/ws?token=${gatewayBearer()}`)), /^HTTP\/1\.1 401 /, 'a token in the URL is not a credential');
  assert.strictEqual(bridgeSeen.length, 0);
});

test('the chat\'s page, script, stylesheet and font are not served on this origin, session or not, and nothing is forwarded; a GET of the socket path is 404 too', async () => {
  reset();
  for (const f of ['chat.html', 'chat.js', 'chat.css', 'inter.woff2', 'ws', 'CHAT.HTML', 'Chat.Js']) {
    assert.strictEqual((await request(fwdPort, { path: `/__liivo/${f}` })).status, 404, `${f} with a session`);
    assert.strictEqual((await request(fwdPort, { method: 'HEAD', path: `/__liivo/${f}` })).status, 404, `HEAD ${f}`);
    assert.strictEqual((await request(fwdPort, { path: `/__liivo/${f}`, session: false })).status, 401, `${f} without one`);
  }
  assert.strictEqual(bridgeSeen.length, 0);
  // the files the picker still needs are served, as before
  for (const f of ['client.js', 'health', 'vendor/modern-screenshot.js']) assert.strictEqual((await request(fwdPort, { path: `/__liivo/${f}` })).status, 200, f);
});

test('another /__liivo/ upgrade is the proxy\'s own namespace: 404 with a session, 401 without, never forwarded', async () => {
  reset();
  assert.match(await rawExchange(fwdPort, upgradeText('/__liivo/other', { Origin: `https://${HOST}` })), /^HTTP\/1\.1 404 /);
  assert.match(await rawExchange(fwdPort, upgradeText('/__liivo/other', { Origin: `https://${HOST}` }, false)), /^HTTP\/1\.1 401 /);
  assert.strictEqual(bridgeSeen.length, 0);
});

test('/__liivo/bridge/* is reserved: 404, never forwarded, in any case and for upgrades', async () => {
  reset();
  for (const p of ['/__liivo/bridge/x', '/__liivo/bridge', '/__liivo/BRIDGE/x', '/__liivo/bridge/']) {
    assert.strictEqual((await request(fwdPort, { path: p })).status, 404, p);
  }
  const out = await rawExchange(fwdPort, upgradeText('/__liivo/bridge/x', { Origin: `https://${HOST}` }));
  assert.match(out, /^HTTP\/1\.1 404 /);
  assert.strictEqual(bridgeSeen.length, 0);
});

test('/__liivo/open keeps its answer (302 to /); /__liivo/open/x and /__liivo/status/x are 404; none is forwarded', async () => {
  reset();
  const open = await request(fwdPort, { path: '/__liivo/open' });
  assert.strictEqual(open.status, 302);
  assert.strictEqual(open.headers.location, '/');
  assert.strictEqual((await request(fwdPort, { path: '/__liivo/open/x' })).status, 404);
  assert.strictEqual((await request(fwdPort, { path: '/__liivo/status/x' })).status, 404);
  assert.strictEqual((await request(fwdPort, { path: '/__liivo/' })).status, 404);
  assert.strictEqual(bridgeSeen.length, 0);
});

test('only a plain request target is forwarded: encoded, dotted, doubled, absolute-form and odd-case forms are 404', async () => {
  reset();
  for (const t of ['http://x/__liivo/chat.html', '/%5f%5fliivo/chat.html', '//__liivo/chat.html', '/__liivo//chat.html', '/__liivo/../__liivo/chat.html', '/__liivo/./chat.html', '/__LIIVO/chat.html', '/__liivo/chat.html%00', '/__liivo/a\\b']) {
    const out = await rawExchange(fwdPort, `GET ${t} HTTP/1.1\r\nHost: ${HOST}\r\nCookie: ${COOKIE}\r\nConnection: close\r\n\r\n`);
    assert.match(out, /^HTTP\/1\.1 404 /, t);
  }
  assert.strictEqual(bridgeSeen.length, 0);
});

test('only GET and HEAD reach the bridge: a POST under /__liivo/ answers 405, and POST /preview goes to the project, never to the bridge', async () => {
  reset();
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const res = await request(fwdPort, { method, path: '/__liivo/health', body: method === 'DELETE' ? undefined : 'x' });
    assert.strictEqual(res.status, 405, method);
    assert.strictEqual(res.headers.allow, 'GET, HEAD');
  }
  assert.strictEqual(bridgeSeen.length, 0);
  // the bridge's /preview (Claude's own tools, loopback only) is not under /__liivo/ and is the project's own path here
  const res = await request(fwdPort, { method: 'POST', path: '/preview', body: '{"cmd":"open"}' });
  assert.strictEqual(res.status, 201);
  assert.deepStrictEqual(previewSeen.map((r) => `${r.method} ${r.url}`), ['POST /preview']);
  assert.strictEqual(bridgeSeen.length, 0);
});

test('an upgrade outside /__liivo/ (the preview\'s own HMR) is tunnelled to the preview as before', async () => {
  reset();
  const out = await rawExchange(fwdPort, upgradeText('/_next/webpack-hmr'));
  assert.match(out, /^HTTP\/1\.1 101 /);
  assert.deepStrictEqual(previewSeen.map((r) => r.url), ['/_next/webpack-hmr']);
  assert.strictEqual(bridgeSeen.length, 0);
});

// ---- the bridge is not there ----

test('while the bridge is down: client.js is the placeholder, health is 503 starting, everything else 503, an upgrade 503', async () => {
  const client = await request(downPort, { path: '/__liivo/client.js' });
  assert.strictEqual(client.status, 200);
  assert.match(client.headers['content-type'], /javascript/);
  assert.strictEqual(client.headers['cache-control'], 'no-store');
  assert.match(client.body, /Chatten startar/);
  assert.match(client.body, /\/__liivo\/health/);
  assert.match(client.body, /f\\u00f6rhandsvisningen fungerar \\u00e4nd\\u00e5/i);
  assert.ok(client.body.includes('300000'), 'gives up the pill after five minutes');
  const health = await request(downPort, { path: '/__liivo/health' });
  assert.strictEqual(health.status, 503);
  assert.deepStrictEqual(JSON.parse(health.body), { bridge: 'starting' });
  assert.strictEqual((await request(downPort, { path: '/__liivo/vendor/modern-screenshot.js' })).status, 503);
  assert.strictEqual((await request(downPort, { method: 'HEAD', path: '/__liivo/health' })).status, 503);
  const ws = await rawExchange(downPort, socketText({ Authorization: `Bearer ${gatewayBearer()}` }));
  assert.match(ws, /^HTTP\/1\.1 503 /);
  // and the placeholder needs the session like everything else
  assert.strictEqual((await request(downPort, { path: '/__liivo/client.js', session: false })).status, 401);
});

test('the placeholder script runs: a pill, one poll of /__liivo/health, one reload when it answers 200', () => {
  const log = [];
  const timers = [];
  const doc = {
    readyState: 'complete',
    body: { appendChild: (el) => log.push(['append', el.textContent]) },
    getElementById: () => null,
    createElement: () => ({ style: {}, setAttribute() {}, textContent: '' }),
  };
  const win = { __liivoPlaceholder: false };
  let answer = { ok: false };
  const sandbox = {
    window: win,
    document: doc,
    location: { reload: () => log.push(['reload']) },
    fetch: (u) => { log.push(['fetch', u]); return Promise.resolve(answer); },
    setTimeout: (fn, ms) => timers.push([fn, ms]),
    Date,
    Math,
  };
  vm.runInNewContext(inject.PLACEHOLDER_CLIENT, sandbox);
  assert.deepStrictEqual(log[0], ['append', 'Chatten startar…']);
  assert.strictEqual(timers[0][1], 2000);
  timers.shift()[0]();
  return new Promise((r) => setImmediate(r)).then(() => {
    assert.deepStrictEqual(log.slice(1), [['fetch', '/__liivo/health']]);
    assert.ok(timers.length === 1 && timers[0][1] === 3000, 'not ok: poll again, a little later');
    answer = { ok: true };
    timers.shift()[0]();
    return new Promise((r) => setImmediate(r));
  }).then(() => {
    assert.deepStrictEqual(log.slice(-1), [['reload']]);
  });
});

// ---- injection ----

const nav = { 'Sec-Fetch-Dest': 'document', Accept: 'text/html' };
const countTags = (s) => s.split('/__liivo/client.js').length - 1;

test('a navigation gets exactly one tag before the last </body>, no-store, and no stale validators', async () => {
  reset();
  const res = await request(fwdPort, { path: '/page', headers: nav });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body, html('<h1>hello</h1>').replace('</body>', `${TAG}</body>`));
  assert.strictEqual(countTags(res.body), 1);
  assert.strictEqual(res.headers['cache-control'], 'no-store');
  assert.ok(!('etag' in res.headers) && !('content-length' in res.headers) || Number(res.headers['content-length']) === res.buf.length);
  assert.ok(!('etag' in res.headers));
  const two = await request(fwdPort, { path: '/two-bodies', headers: nav });
  assert.strictEqual(two.body, '<html><body><script>var s = "</body>";</script><p>x</p>' + TAG + '</body></html>');
  const none = await request(fwdPort, { path: '/no-body', headers: nav });
  assert.strictEqual(none.body, `<h1>fragment</h1>${TAG}`);
  const already = await request(fwdPort, { path: '/has-tag', headers: nav });
  assert.strictEqual(countTags(already.body), 1, 'a page that has the tag does not get a second');
  const nf = await request(fwdPort, { path: '/not-found', headers: nav });
  assert.strictEqual(nf.status, 404);
  assert.strictEqual(countTags(nf.body), 1, 'an error page of the project is a page too');
});

test('Set-Cookie headers are all kept, and the upstream was asked for identity, with no Range or conditional headers', async () => {
  reset();
  const res = await request(fwdPort, {
    path: '/page',
    headers: { ...nav, Range: 'bytes=0-9', 'If-None-Match': '"abc"', 'If-Modified-Since': 'Wed, 21 Oct 2015 07:28:00 GMT', 'If-Range': '"abc"', 'Accept-Encoding': 'gzip, br' },
  });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.headers['set-cookie'], ['a=1; Path=/', 'b=2; Path=/']);
  assert.strictEqual(countTags(res.body), 1);
  const h = previewSeen[0].headers;
  assert.strictEqual(h['accept-encoding'], 'identity');
  for (const name of ['range', 'if-none-match', 'if-modified-since', 'if-range', 'if-match', 'if-unmodified-since']) assert.ok(!(name in h), name);
});

test('what makes a request a navigation: Sec-Fetch-Dest first, Accept: text/html only without it and for GET/HEAD', async () => {
  const tagged = async (headers, method = 'GET') => countTags((await request(fwdPort, { method, path: '/page', headers, body: method === 'POST' ? 'x' : undefined })).body) === 1;
  assert.strictEqual(await tagged({ 'Sec-Fetch-Dest': 'document', Accept: '*/*' }), true, 'document wins over Accept');
  assert.strictEqual(await tagged({ 'Sec-Fetch-Dest': 'document' }, 'POST'), true, 'a form post that navigates');
  assert.strictEqual(await tagged({ Accept: 'text/html,application/xhtml+xml' }), true, 'no Sec-Fetch-Dest: Accept');
  assert.strictEqual(await tagged({ 'Sec-Fetch-Dest': 'iframe', Accept: 'text/html' }), false, 'an iframe is not asked');
  assert.strictEqual(await tagged({ 'Sec-Fetch-Dest': 'empty', Accept: 'text/html' }), false, 'a fetch() is not');
  assert.strictEqual(await tagged({ Accept: '*/*' }), false);
  assert.strictEqual(await tagged({ Accept: 'text/html' }, 'POST'), false, 'without Sec-Fetch-Dest only GET and HEAD');
});

test('a nonce is copied from a CSP header and from a <meta http-equiv>; a hostile nonce value is not', async () => {
  const header = await request(fwdPort, { path: '/csp-header', headers: nav });
  assert.ok(header.body.includes('<script src="/__liivo/client.js" defer nonce="abcDEF123456"></script>'), header.body);
  const meta = await request(fwdPort, { path: '/csp-meta', headers: nav });
  assert.ok(meta.body.includes('<script src="/__liivo/client.js" defer nonce="metaNonce12345"></script>'), meta.body);
  const hostile = await request(fwdPort, { path: '/csp-hostile', headers: nav });
  assert.ok(hostile.body.includes(TAG), 'no nonce, the plain tag');
  assert.ok(!hostile.body.includes('nonce="'), 'the hostile value never lands in an attribute');
});

test('compressed, JSON, plain text and partial answers pass untouched', async () => {
  const gz = await request(fwdPort, { path: '/gzip', headers: nav });
  assert.strictEqual(gz.headers['content-encoding'], 'gzip');
  assert.strictEqual(zlib.gunzipSync(gz.buf).toString(), html('zipped'));
  const json = await request(fwdPort, { path: '/json', headers: nav });
  assert.strictEqual(json.body, '{"a":"</body>"}');
  const text = await request(fwdPort, { path: '/text', headers: nav });
  assert.strictEqual(text.body, 'plain </body>');
  const part = await request(fwdPort, { path: '/partial', headers: nav });
  assert.strictEqual(part.status, 206);
  assert.strictEqual(part.body, '0123456789');
  assert.strictEqual(part.headers['content-range'], 'bytes 0-9/100');
  const head = await request(fwdPort, { method: 'HEAD', path: '/page', headers: nav });
  assert.strictEqual(head.status, 200);
  assert.strictEqual(head.headers.etag, '"abc"', 'a HEAD answer is not touched');
});

test('a page over the buffer limit is streamed as the upstream sent it: whole, untagged, with its own headers', async () => {
  const res = await request(fwdPort, { path: '/big', headers: nav });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(countTags(res.body), 0);
  assert.strictEqual(res.buf.length, Buffer.byteLength(html(`<p>${'x'.repeat(9000)}</p>`)));
  assert.strictEqual(res.headers.etag, '"big"');
  assert.ok(res.body.endsWith('</p></body></html>\n'));
});

test('a slow page is flushed once the buffer time has passed and the rest is streamed, untagged', async () => {
  const t0 = Date.now();
  const res = await request(fwdPort, { path: '/slow', headers: nav });
  assert.strictEqual(res.body, '<html><body><p>first</p><p>second</p></body></html>');
  assert.strictEqual(countTags(res.body), 0);
  assert.ok(res.times.length >= 2, 'it arrived in more than one piece');
  assert.ok(res.times[0] - t0 >= 200 && res.times[0] - t0 < 600, `the first piece was flushed at the buffer time (${res.times[0] - t0} ms)`);
  assert.ok(res.times[res.times.length - 1] - t0 >= 650, 'the rest followed when the upstream sent it');
  assert.strictEqual(res.headers.etag, '"slow"');
});

test('the "Preview not running" page carries the tag and keeps its heading', async () => {
  const res = await request(deadPreviewPort, { path: '/', headers: nav });
  assert.strictEqual(res.status, 502);
  assert.match(res.body, /<h1>Preview not running<\/h1>/);
  assert.strictEqual(countTags(res.body), 1);
  assert.ok(res.body.includes(`${TAG}</body>`));
  assert.strictEqual(Number(res.headers['content-length']), res.buf.length);
});

test('the sign-in and recreate pages carry no tag', async () => {
  const noSession = await request(fwdPort, { path: '/', session: false });
  assert.strictEqual(noSession.status, 401);
  assert.strictEqual(countTags(noSession.body), 0);
});

// ---- status ----

function status(port = fwdPort) {
  return request(port, { path: '/__liivo/status', session: false, headers: { Authorization: `Bearer ${auth.signToken(KEY, { aud: 'gateway', host: '', tenant: 'tenant', user: '', instance: 'tenant-proj', exp: nowS() + 30 })}` } });
}

test('/__liivo/status adds bridge: {version, state} from the supervisor\'s state file, and keeps every earlier field', async () => {
  fs.rmSync(stateFile, { force: true });
  let res = await status();
  assert.strictEqual(res.status, 200);
  let body = JSON.parse(res.body);
  assert.deepStrictEqual(Object.keys(body).sort(), ['branch', 'bridge', 'checkout', 'clean', 'unpushed']);
  assert.deepStrictEqual(body.bridge, { version: null, state: 'unavailable' }, 'no state file: the supervisor never ran');
  for (const [file, want] of [
    [{ state: 'running', version: 'abc123' }, { version: 'abc123', state: 'running' }],
    [{ state: 'starting', version: null }, { version: null, state: 'starting' }],
    [{ state: 'unavailable', version: null }, { version: null, state: 'unavailable' }],
  ]) {
    fs.writeFileSync(stateFile, JSON.stringify(file));
    body = JSON.parse((await status()).body);
    assert.deepStrictEqual(body.bridge, want);
  }
  // the state file is on a volume project code can write: anything that is not a state is not reported
  for (const bad of ['not json', '{"state":"disabled","version":"x"}', '{"state":"running","version":"../x"}', '{"state":"running","version":{"a":1}}', '[]', 'null']) {
    fs.writeFileSync(stateFile, bad);
    const b = JSON.parse((await status()).body).bridge;
    assert.ok(b.state === 'unavailable' || (b.state === 'running' && b.version === null), bad);
    assert.ok(b.version === null, bad);
  }
});

// ---- the signer's /bridge-token ----

function postSigner(socketPath, p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: p, method: 'POST' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('POST /bridge-token on the signer: 409 until the identity is known, then an aud bridge token that lives 45 s', async () => {
  const sock = path.join(tmp, 'sign.sock');
  let clock = 1_800_000_000;
  const f = createForwarder({ previewPort: 1, handoffKey: KEY, gatewayUrl: GATEWAY, instance: 'tenant-proj', projectDir: path.join(tmp, 'project'), now: () => clock });
  await listenOnSocket(f.signer, sock);
  try {
    const early = await postSigner(sock, '/bridge-token');
    assert.strictEqual(early.status, 409);
    // the gateway's status call teaches the workspace who it belongs to
    const port = await listen(f);
    const token = auth.signToken(KEY, { aud: 'gateway', host: '', tenant: 'tenant', user: 'u1', instance: 'tenant-proj', exp: clock + 30 });
    const learned = await request(port, { path: '/__liivo/status', session: false, headers: { Authorization: `Bearer ${token}` } });
    assert.strictEqual(learned.status, 200);
    const ok = await postSigner(sock, '/bridge-token');
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body.gatewayUrl, GATEWAY);
    const [prefix, payload, sig] = ok.body.token.split('.');
    assert.strictEqual(prefix, 'v1');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    assert.strictEqual(claims.aud, 'bridge');
    assert.strictEqual(claims.tenant, 'tenant');
    assert.strictEqual(claims.instance, 'tenant-proj');
    assert.strictEqual(claims.exp, clock + 45);
    const expected = crypto.createHmac('sha256', KEY).update(`v1.${payload}`).digest('base64url');
    assert.strictEqual(sig, expected, 'signed under the HandoffKey');
    // a bridge token opens nothing else: not a handoff, not a git token, not a gateway call
    for (const aud of ['browser', 'git', 'gateway']) assert.ok(!auth.verifyToken(KEY, ok.body.token, aud, clock).ok, aud);
    // the git route still signs aud git for 60 s
    const git = await postSigner(sock, '/git-token');
    assert.strictEqual(auth.verifyToken(KEY, git.body.token, 'git', clock).claims.exp, clock + 60);
    assert.strictEqual((await postSigner(sock, '/other-token')).status, 404);
  } finally {
    f.signer.close();
    f.close();
  }
});
