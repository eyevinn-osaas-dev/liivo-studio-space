'use strict';
// Tests for the edit proxy's session, handoff, status endpoint and git
// credential helper (design D8). Stubs refuse what the real service refuses.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const auth = require('./auth.js');
const { createForwarder, parseGatewayUrl, listenOnSocket } = require('./preview-forwarder.js');

const KEY = crypto.randomBytes(32);
const OTHER_KEY = crypto.randomBytes(32);
const HOST = 'tenant-proj.eyevinn-liivo-studio-space.auto.dev.osaas.io';
const GATEWAY = 'https://gw.example.test';
const NO_BRIDGE = { version: null, state: 'unavailable' };
let clock = 1_800_000_000;
const now = () => clock;

const sockets = new Set();
function listen(server) {
  server.on('connection', (c) => {
    sockets.add(c);
    c.on('close', () => sockets.delete(c));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { Host: HOST, ...headers }, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function rawUpgrade(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let buf = '';
    let pinged = false;
    socket.on('error', reject);
    socket.on('connect', () => {
      let head = `GET /ws HTTP/1.1\r\nHost: ${HOST}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: abc\r\nSec-WebSocket-Version: 13\r\n`;
      for (const [k, v] of Object.entries(headers)) head += `${k}: ${v}\r\n`;
      socket.write(`${head}\r\n`);
    });
    socket.on('data', (d) => {
      buf += d.toString();
      if (buf.startsWith('HTTP/1.1 101') && !pinged && buf.includes('\r\n\r\n')) {
        pinged = true;
        socket.write('ping');
      }
      if (buf.endsWith('PING')) {
        socket.destroy();
        resolve(buf);
      }
    });
    socket.on('close', () => resolve(buf));
  });
}

function browserToken(over = {}) {
  return auth.signToken(KEY, {
    aud: 'browser',
    host: HOST,
    tenant: 'tenant',
    user: 'u1',
    instance: 'tenant-proj',
    exp: clock + 30,
    ...over,
  });
}
const gatewayToken = (over = {}) =>
  auth.signToken(KEY, { aud: 'gateway', host: '', tenant: 'tenant', user: '', instance: 'tenant-proj', exp: clock + 30, ...over });

function cookieFrom(res) {
  return String(res.headers['set-cookie']).split(';')[0];
}

async function handoff(token = browserToken(), host = HOST) {
  return request(fwdPort, { path: `/?__liivo=${token}`, headers: { Host: host, Accept: 'text/html' } });
}

async function sessionCookie() {
  const res = await handoff();
  assert.strictEqual(res.status, 302);
  return cookieFrom(res);
}

let upstream;
let upstreamHits = 0;
let upstreamSeen = [];
let fwd;
let fwdPort;
let noKeyFwd;
let noKeyPort;
let noGatewayFwd;
let noGatewayPort;
let tmp;
let identityFile;
let projectDir;
let signSocket;

before(async () => {
  tmp = fs.mkdtempSync(path.join('/tmp', 'lsp-'));
  identityFile = path.join(tmp, 'identity.json');
  projectDir = path.join(tmp, 'project');
  upstream = http.createServer((req, res) => {
    upstreamHits++;
    upstreamSeen.push(req.headers);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ url: req.url, headers: req.headers }));
  });
  upstream.on('upgrade', (req, socket) => {
    upstreamHits++;
    upstreamSeen.push(req.headers);
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Seen: ${Buffer.from(JSON.stringify(req.headers)).toString('base64')}\r\n\r\n`
    );
    socket.on('data', (d) => socket.write(d.toString().toUpperCase()));
  });
  const upstreamPort = await listen(upstream);

  fwd = createForwarder({
    previewPort: upstreamPort,
    handoffKey: KEY,
    gatewayUrl: GATEWAY,
    instance: 'tenant-proj',
    projectDir,
    identityFile,
    now,
  });
  fwdPort = await listen(fwd);
  signSocket = path.join(tmp, 's.sock');
  await listenOnSocket(fwd.signer, signSocket);

  noKeyFwd = createForwarder({ previewPort: upstreamPort, handoffKey: null, gatewayUrl: GATEWAY, now });
  noKeyPort = await listen(noKeyFwd);
  noGatewayFwd = createForwarder({ previewPort: upstreamPort, handoffKey: KEY, gatewayUrl: '', instance: 'tenant-proj', now });
  noGatewayPort = await listen(noGatewayFwd);
});

after(() => {
  for (const c of sockets) c.destroy();
  for (const s of [upstream, fwd, fwd.signer, noKeyFwd, noGatewayFwd]) s.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const resetUpstream = () => {
  upstreamHits = 0;
  upstreamSeen = [];
};

// ---- configuration and token primitives ----

test('parseKey accepts base64 of exactly 32 bytes only', () => {
  assert.ok(auth.parseKey(KEY.toString('base64')));
  assert.ok(auth.parseKey(`${KEY.toString('base64')}\n`));
  for (const bad of [undefined, '', 'not base64!', crypto.randomBytes(31).toString('base64'), crypto.randomBytes(33).toString('base64')]) {
    assert.strictEqual(auth.parseKey(bad), null, String(bad));
  }
});

test('parseGatewayUrl keeps http(s) URLs without credentials and drops the rest', () => {
  assert.strictEqual(parseGatewayUrl('https://gw.example.test/'), 'https://gw.example.test');
  assert.strictEqual(parseGatewayUrl('https://gw.example.test/base/'), 'https://gw.example.test/base');
  for (const bad of ['', 'javascript:alert(1)', 'https://u:p@gw.example.test', 'gw.example.test', 'ftp://x']) {
    assert.strictEqual(parseGatewayUrl(bad), '', bad);
  }
});

// ---- no session ----

test('a navigation without a session on / and on a deep path answers 302 to the gateway, nothing is forwarded', async () => {
  resetUpstream();
  for (const p of ['/', '/a/b/c.html?x=1', '/__liivo/open', '/__liivo/other']) {
    for (const method of ['GET', 'HEAD']) {
      const res = await request(fwdPort, { method, path: p, headers: { Accept: 'text/html,application/xhtml+xml' } });
      assert.strictEqual(res.status, 302, `${method} ${p}`);
      assert.strictEqual(res.headers.location, `${GATEWAY}/w/tenant-proj`);
    }
  }
  assert.strictEqual(upstreamHits, 0);
});

test('a navigation is also redirected when the Host is the cluster-internal address', async () => {
  const res = await request(fwdPort, {
    path: '/',
    headers: { Host: 'tenant-proj.eyevinn-liivo-studio-space.svc.cluster.local:8080', Accept: 'text/html' },
  });
  assert.strictEqual(res.status, 302);
});

test('XHR and other non-navigation requests without a session answer 401', async () => {
  resetUpstream();
  const cases = [
    { path: '/api/data', headers: { Accept: 'application/json' } },
    { path: '/', headers: {} },
    { path: '/x.js', headers: { Accept: '*/*' } },
    { method: 'POST', path: '/', headers: { Accept: 'text/html' }, body: 'x' },
    { path: '/__liivo/open', headers: { Accept: 'application/json' } },
  ];
  for (const c of cases) {
    const res = await request(fwdPort, c);
    assert.strictEqual(res.status, 401, `${c.method || 'GET'} ${c.path}`);
  }
  assert.strictEqual(upstreamHits, 0);
});

test('a WebSocket upgrade without a session answers 401 and is not forwarded', async () => {
  resetUpstream();
  assert.match(await rawUpgrade(fwdPort), /^HTTP\/1\.1 401 /);
  assert.match(await rawUpgrade(fwdPort, { Cookie: 'other=1' }), /^HTTP\/1\.1 401 /);
  assert.strictEqual(upstreamHits, 0);
});

test('forged, foreign-key, expired and token-as-cookie sessions are refused', async () => {
  resetUpstream();
  const good = auth.signSession(KEY, { tenant: 't', user: 'u', instance: 'i' }, clock);
  const cookies = [
    `${auth.COOKIE_NAME}=${auth.signSession(OTHER_KEY, { tenant: 't', user: 'u', instance: 'i' }, clock)}`,
    `${auth.COOKIE_NAME}=${auth.signSession(KEY, { tenant: 't', user: 'u', instance: 'i' }, clock - 13 * 3600)}`,
    `${auth.COOKIE_NAME}=${browserToken()}`,
    `${auth.COOKIE_NAME}=${good.slice(0, -2)}xx`,
    `${auth.COOKIE_NAME}=${good.replace(/^s1\./, 'v1.')}`,
    `liivo=${good}`,
  ];
  for (const Cookie of cookies) {
    assert.strictEqual((await request(fwdPort, { path: '/api', headers: { Cookie } })).status, 401, Cookie.slice(0, 30));
  }
  assert.strictEqual(upstreamHits, 0);
});

test('with no LIIVO_GATEWAY_URL a navigation answers 401 instead of a redirect', async () => {
  const res = await request(noGatewayPort, { path: '/', headers: { Accept: 'text/html' } });
  assert.strictEqual(res.status, 401);
});

// ---- handoff, passing path ----

test('a valid handoff sets the session cookie and answers 302 to /__liivo/open, the token is not forwarded', async () => {
  resetUpstream();
  const res = await handoff(browserToken({ nonce: 'handoff-ok-1' }));
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.location, '/__liivo/open');
  const setCookie = String(res.headers['set-cookie']);
  assert.match(setCookie, /^__Host-liivo=s1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+; Max-Age=43200; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
  assert.doesNotMatch(setCookie, /Domain=/i);
  const session = auth.verifySession(KEY, setCookie.split(';')[0].split('=').slice(1).join('='), clock);
  assert.deepStrictEqual(
    { tenant: session.tenant, user: session.user, instance: session.instance, exp: session.exp },
    { tenant: 'tenant', user: 'u1', instance: 'tenant-proj', exp: clock + 12 * 3600 }
  );
  assert.strictEqual(res.headers['cache-control'], 'no-store');
  assert.strictEqual(upstreamHits, 0);
});

test('after the handoff the cookie works for navigations, XHR, /__liivo/open and a WebSocket upgrade', async () => {
  resetUpstream();
  const Cookie = await sessionCookie();
  const open = await request(fwdPort, { path: '/__liivo/open', headers: { Cookie, Accept: 'text/html' } });
  assert.strictEqual(open.status, 302);
  assert.strictEqual(open.headers.location, '/');
  const page = await request(fwdPort, { path: '/deep/path?q=1', headers: { Cookie, Accept: 'text/html' } });
  assert.strictEqual(page.status, 201);
  assert.strictEqual(JSON.parse(page.body).url, '/deep/path?q=1');
  const xhr = await request(fwdPort, { method: 'POST', path: '/api', headers: { Cookie, 'Content-Type': 'text/plain' }, body: 'hello' });
  assert.strictEqual(xhr.status, 201);
  const ws = await rawUpgrade(fwdPort, { Cookie });
  assert.match(ws, /^HTTP\/1\.1 101 /);
  assert.ok(ws.endsWith('PING'));
  assert.strictEqual(upstreamHits, 3);
});

test('the session cookie expires after 12 hours', async () => {
  const Cookie = await sessionCookie();
  assert.strictEqual((await request(fwdPort, { path: '/x', headers: { Cookie } })).status, 201);
  clock += 12 * 3600 + 1;
  try {
    assert.strictEqual((await request(fwdPort, { path: '/x', headers: { Cookie } })).status, 401);
  } finally {
    clock -= 12 * 3600 + 1;
  }
});

// ---- handoff, refusals ----

test('a reused nonce answers 401, also with a fresh signature around the same nonce', async () => {
  const first = browserToken({ nonce: 'reuse-me' });
  assert.strictEqual((await handoff(first)).status, 302);
  assert.strictEqual((await handoff(first)).status, 401);
  assert.strictEqual((await handoff(browserToken({ nonce: 'reuse-me', exp: clock + 31 }))).status, 401);
});

test('a nonce is remembered until the token expires and then forgotten', () => {
  const store = auth.createNonceStore();
  assert.ok(store.use('n1', 100, 50));
  assert.ok(!store.use('n1', 100, 99));
  assert.ok(store.use('n1', 160, 100));
  assert.strictEqual(store.size(), 1);
});

test('a token for another host answers 401', async () => {
  resetUpstream();
  assert.strictEqual((await handoff(browserToken({ host: 'other.example.test' }))).status, 401);
  assert.strictEqual((await handoff(browserToken(), 'evil.example.test')).status, 401);
  assert.strictEqual((await handoff(browserToken({ host: '' }), '')).status, 401);
  assert.strictEqual(upstreamHits, 0);
});

test('expired, too-far-ahead, wrong-audience, wrongly signed and malformed tokens answer 401', async () => {
  const good = browserToken();
  const tokens = [
    browserToken({ exp: clock }),
    browserToken({ exp: clock - 5 }),
    browserToken({ exp: clock + 61 }),
    browserToken({ exp: clock + 3600 }),
    browserToken({ exp: 'soon' }),
    browserToken({ nonce: '' }),
    gatewayToken(),
    browserToken({ aud: 'git' }),
    auth.signToken(OTHER_KEY, { aud: 'browser', host: HOST, tenant: 't', user: 'u', instance: 'i', exp: clock + 30 }),
    `${good.slice(0, -2)}xx`,
    good.replace(/^v1\./, 'v2.'),
    good.split('.').slice(0, 2).join('.'),
    'v1..',
    'garbage',
  ];
  for (const t of tokens) {
    assert.strictEqual((await handoff(t)).status, 401, t.slice(0, 40));
  }
  // the 60 second edge is accepted
  assert.strictEqual((await handoff(browserToken({ exp: clock + 60 }))).status, 302);
});

test('two __liivo parameters or a POST do not start a session', async () => {
  const a = browserToken();
  const b = browserToken();
  assert.strictEqual((await request(fwdPort, { path: `/?__liivo=${a}&__liivo=${b}` })).status, 401);
  const post = await request(fwdPort, { method: 'POST', path: `/?__liivo=${browserToken()}`, body: 'x' });
  assert.strictEqual(post.status, 401);
  assert.strictEqual(post.headers['set-cookie'], undefined);
  // a handoff on a deep path is not a handoff
  const deep = await request(fwdPort, { path: `/app?__liivo=${browserToken()}`, headers: { Accept: 'text/html' } });
  assert.strictEqual(deep.status, 302);
  assert.strictEqual(deep.headers['set-cookie'], undefined);
});

test('the handoff learns the tenant and instance and keeps them in a private file', async () => {
  await handoff(browserToken({ tenant: 'tenant', instance: 'tenant-proj', user: 'u9' }));
  const saved = JSON.parse(fs.readFileSync(identityFile, 'utf8'));
  assert.deepStrictEqual(saved, { tenant: 'tenant', user: 'u9', instance: 'tenant-proj' });
  assert.strictEqual(fs.statSync(identityFile).mode & 0o777, 0o600);
});

// ---- header handling ----

test('X-Forwarded-*, Forwarded, X-Real-IP and the session cookie are not passed on; Host and other cookies are', async () => {
  const session = await sessionCookie();
  resetUpstream();
  const res = await request(fwdPort, {
    path: '/h',
    headers: {
      Cookie: `a=1; ${session}; b=2`,
      'X-Forwarded-Host': 'evil.example.test',
      'X-Forwarded-For': '6.6.6.6',
      'X-Forwarded-Proto': 'http',
      Forwarded: 'for=6.6.6.6',
      'X-Real-IP': '6.6.6.6',
      'X-Custom': 'kept',
    },
  });
  assert.strictEqual(res.status, 201);
  const seen = JSON.parse(res.body).headers;
  assert.strictEqual(seen.cookie, 'a=1; b=2');
  assert.strictEqual(seen.host, HOST);
  assert.strictEqual(seen['x-custom'], 'kept');
  for (const h of ['x-forwarded-host', 'x-forwarded-for', 'x-forwarded-proto', 'forwarded', 'x-real-ip']) {
    assert.strictEqual(seen[h], undefined, h);
  }
  // only the session cookie: no Cookie header at all
  const only = await request(fwdPort, { path: '/h', headers: { Cookie: session } });
  assert.strictEqual(JSON.parse(only.body).headers.cookie, undefined);
});

test('the same header rules apply to a WebSocket upgrade', async () => {
  const session = await sessionCookie();
  resetUpstream();
  const out = await rawUpgrade(fwdPort, { Cookie: `a=1; ${session}`, 'X-Forwarded-For': '6.6.6.6', 'X-Real-IP': '6.6.6.6' });
  assert.match(out, /^HTTP\/1\.1 101 /);
  const seen = upstreamSeen[0];
  assert.strictEqual(seen.cookie, 'a=1');
  assert.strictEqual(seen['x-forwarded-for'], undefined);
  assert.strictEqual(seen['x-real-ip'], undefined);
});

test('a cross-origin POST or WebSocket upgrade carrying a valid cookie answers 401, a same-origin one is forwarded', async () => {
  const Cookie = await sessionCookie();
  resetUpstream();
  for (const Origin of ['https://evil.example.test', 'null']) {
    assert.strictEqual((await request(fwdPort, { method: 'POST', path: '/api', headers: { Cookie, Origin }, body: 'x' })).status, 401);
    assert.match(await rawUpgrade(fwdPort, { Cookie, Origin }), /^HTTP\/1\.1 401 /);
  }
  assert.strictEqual(upstreamHits, 0);
  const own = `https://${HOST}`;
  assert.strictEqual((await request(fwdPort, { method: 'POST', path: '/api', headers: { Cookie, Origin: own }, body: 'x' })).status, 201);
  assert.match(await rawUpgrade(fwdPort, { Cookie, Origin: own }), /^HTTP\/1\.1 101 /);
  // a cross-origin GET is not a state change: it is forwarded and the browser's CORS rules apply
  assert.strictEqual((await request(fwdPort, { path: '/api', headers: { Cookie, Origin: 'https://other.example.test' } })).status, 201);
});

// ---- status ----

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}

async function status(token) {
  return request(fwdPort, { path: '/__liivo/status', headers: token === undefined ? {} : { Authorization: `Bearer ${token}` } });
}

test('status refuses a missing, wrong-audience, expired or far-future bearer with 401', async () => {
  for (const t of [undefined, '', browserToken(), auth.signToken(KEY, { aud: 'git', exp: clock + 30 }), gatewayToken({ exp: clock - 1 }), gatewayToken({ exp: clock + 61 }), 'junk']) {
    const res = await status(t);
    assert.strictEqual(res.status, 401, String(t).slice(0, 30));
    assert.strictEqual(res.headers['www-authenticate'], 'Bearer');
  }
  // the session cookie does not open the status endpoint
  const Cookie = await sessionCookie();
  assert.strictEqual((await request(fwdPort, { path: '/__liivo/status', headers: { Cookie } })).status, 401);
  // neither do the normalised spellings of the path
  for (const p of ['/__LIIVO/status', '/%5f%5fliivo/status', '/a/../__liivo/status']) {
    assert.strictEqual((await request(fwdPort, { path: p })).status, 401, p);
  }
});

test('status with a gateway token is not single use and reports no checkout, then the git state', async () => {
  const t = gatewayToken({ nonce: 'same' });
  let res = await status(t);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(JSON.parse(res.body), { checkout: false, clean: true, unpushed: 0, branch: null, bridge: NO_BRIDGE });
  assert.strictEqual((await status(t)).status, 200);

  // files that are not a git checkout count as work that would be lost
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'notes.txt'), 'x');
  assert.deepStrictEqual(JSON.parse((await status(gatewayToken())).body), { checkout: false, clean: false, unpushed: 0, branch: null, bridge: NO_BRIDGE });
  fs.rmSync(path.join(projectDir, 'notes.txt'));

  // an upstream and a checkout with one commit pushed
  const bare = path.join(tmp, 'origin.git');
  git(tmp, 'init', '--bare', '-b', 'main', bare);
  git(projectDir, 'init', '-b', 'main');
  git(projectDir, 'remote', 'add', 'origin', bare);
  res = await status(gatewayToken());
  assert.deepStrictEqual(JSON.parse(res.body), { checkout: true, clean: true, unpushed: 0, branch: 'main', bridge: NO_BRIDGE });

  fs.writeFileSync(path.join(projectDir, 'a.txt'), 'a');
  git(projectDir, 'add', '.');
  git(projectDir, 'commit', '-m', 'one');
  // a branch with no upstream: the commit is on no remote
  assert.deepStrictEqual(JSON.parse((await status(gatewayToken())).body), { checkout: true, clean: true, unpushed: 1, branch: 'main', bridge: NO_BRIDGE });
  git(projectDir, 'push', '-u', 'origin', 'main');
  assert.deepStrictEqual(JSON.parse((await status(gatewayToken())).body), { checkout: true, clean: true, unpushed: 0, branch: 'main', bridge: NO_BRIDGE });

  fs.writeFileSync(path.join(projectDir, 'a.txt'), 'changed');
  assert.deepStrictEqual(JSON.parse((await status(gatewayToken())).body), { checkout: true, clean: false, unpushed: 0, branch: 'main', bridge: NO_BRIDGE });
  git(projectDir, 'commit', '-am', 'two');
  fs.writeFileSync(path.join(projectDir, 'untracked.txt'), 'u');
  assert.deepStrictEqual(JSON.parse((await status(gatewayToken())).body), { checkout: true, clean: false, unpushed: 1, branch: 'main', bridge: NO_BRIDGE });
});

test('status answers 405 to a method other than GET (after authentication)', async () => {
  const res = await request(fwdPort, { method: 'POST', path: '/__liivo/status', headers: { Authorization: `Bearer ${gatewayToken()}` }, body: 'x' });
  assert.strictEqual(res.status, 405);
  assert.strictEqual((await request(fwdPort, { method: 'POST', path: '/__liivo/status', body: 'x' })).status, 401);
});

// ---- fail closed without a key ----

test('without HANDOFF_KEY every request answers 503, including handoff, status, navigation and upgrade', async () => {
  resetUpstream();
  const cases = [
    { path: '/', headers: { Accept: 'text/html' } },
    { path: '/deep', headers: { Accept: 'application/json' } },
    { path: `/?__liivo=${browserToken()}` },
    { path: '/__liivo/status', headers: { Authorization: `Bearer ${gatewayToken()}` } },
    { path: '/__liivo/open', headers: { Cookie: `${auth.COOKIE_NAME}=${auth.signSession(KEY, { tenant: 't', user: 'u', instance: 'i' }, clock)}` } },
    { method: 'POST', path: '/api', body: 'x' },
  ];
  for (const c of cases) {
    const res = await request(noKeyPort, c);
    assert.strictEqual(res.status, 503, `${c.method || 'GET'} ${c.path.slice(0, 20)}`);
  }
  const page = await request(noKeyPort, { path: '/', headers: { Accept: 'text/html' } });
  assert.match(page.body, /must be recreated/);
  assert.match(await rawUpgrade(noKeyPort, { Cookie: `${auth.COOKIE_NAME}=${auth.signSession(KEY, { tenant: 't', user: 'u', instance: 'i' }, clock)}` }), /^HTTP\/1\.1 503 /);
  assert.strictEqual(upstreamHits, 0);
});

// ---- git signing socket and credential helper ----

function postSigner(socketPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: '/git-token', method: 'POST' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('the signing socket is private and signs an aud git token only once the tenant is known', async () => {
  assert.strictEqual(fs.statSync(signSocket).mode & 0o777, 0o600);
  const solo = createForwarder({ previewPort: 1, handoffKey: KEY, gatewayUrl: GATEWAY, instance: 'tenant-proj', now });
  const soloSock = path.join(tmp, 'solo.sock');
  await listenOnSocket(solo.signer, soloSock);
  try {
    const early = await postSigner(soloSock);
    assert.strictEqual(early.status, 409);
    assert.match(early.body.error, /tenant not known/);
  } finally {
    solo.signer.close();
  }
  await handoff(browserToken({ tenant: 'tenant', instance: 'tenant-proj', user: 'u1' }));
  const ok = await postSigner(signSocket);
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.gatewayUrl, GATEWAY);
  const v = auth.verifyToken(KEY, ok.body.token, 'git', clock);
  assert.ok(v.ok);
  assert.strictEqual(v.claims.tenant, 'tenant');
  assert.strictEqual(v.claims.instance, 'tenant-proj');
  assert.ok(!auth.verifyToken(OTHER_KEY, ok.body.token, 'git', clock).ok);
  assert.ok(!auth.verifyToken(KEY, ok.body.token, 'browser', clock).ok);
});

test('without a gateway URL the signer refuses', async () => {
  const s = createForwarder({ previewPort: 1, handoffKey: KEY, gatewayUrl: '', instance: 'i', now });
  const sock = path.join(tmp, 'nogw.sock');
  await listenOnSocket(s.signer, sock);
  try {
    assert.strictEqual((await postSigner(sock)).status, 503);
  } finally {
    s.signer.close();
  }
});

function runHelper(args, input, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'git-credential-liivo.js'), ...args], {
      env: { PATH: process.env.PATH, HOME: tmp, LIIVO_SOCKET: signSocket, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

const GITHUB = 'protocol=https\nhost=github.com\n\n';

test('the git credential helper signs a git token, calls the gateway and returns what it gets', async () => {
  await handoff(browserToken({ tenant: 'tenant', instance: 'tenant-proj' }));
  const calls = [];
  const gateway = http.createServer((req, res) => {
    const bearerToken = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    const v = bearerToken && auth.verifyToken(KEY, bearerToken[1], 'git', clock);
    calls.push({ method: req.method, url: req.url, ok: Boolean(v && v.ok), tenant: v && v.ok && v.claims.tenant });
    if (!v || !v.ok || req.method !== 'POST' || req.url !== '/api/git-token') {
      res.writeHead(401);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ token: 'ghs_testtoken', expiresAt: '2026-11-18T12:00:00Z' }));
  });
  const gwPort = await listen(gateway);
  // the proxy that answers the helper signs for this gateway
  const withGateway = createForwarder({ previewPort: 1, handoffKey: KEY, gatewayUrl: `http://127.0.0.1:${gwPort}`, instance: 'tenant-proj', identityFile, now });
  const sock = path.join(tmp, 'gw.sock');
  await listenOnSocket(withGateway.signer, sock);
  try {
    const ok = await runHelper(['get'], GITHUB, { LIIVO_SOCKET: sock });
    assert.strictEqual(ok.code, 0);
    assert.strictEqual(ok.stdout, 'username=x-access-token\npassword=ghs_testtoken\n');
    assert.strictEqual(ok.stderr, '');
    assert.deepStrictEqual(calls, [{ method: 'POST', url: '/api/git-token', ok: true, tenant: 'tenant' }]);

    // not github.com, or not a "get": no call, no output
    calls.length = 0;
    for (const [args, input] of [
      [['get'], 'protocol=https\nhost=gitlab.com\n\n'],
      [['get'], 'protocol=http\nhost=github.com\n\n'],
      [['store'], `${GITHUB}username=x\npassword=y\n`],
      [['erase'], GITHUB],
    ]) {
      const r = await runHelper(args, input, { LIIVO_SOCKET: sock });
      assert.strictEqual(r.stdout, '');
      assert.strictEqual(r.code, 0);
    }
    assert.strictEqual(calls.length, 0);
  } finally {
    withGateway.signer.close();
    gateway.close();
  }
});

test('the git credential helper answers for a --host argument exactly and for no other host', async () => {
  await handoff(browserToken({ tenant: 'tenant', instance: 'tenant-proj' }));
  const calls = [];
  const gateway = http.createServer((req, res) => {
    calls.push(req.url);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ token: 'gitea_testtoken' }));
  });
  const gwPort = await listen(gateway);
  const proxy = createForwarder({ previewPort: 1, handoffKey: KEY, gatewayUrl: `http://127.0.0.1:${gwPort}`, instance: 'tenant-proj', identityFile, now });
  const sock = path.join(tmp, 'host.sock');
  await listenOnSocket(proxy.signer, sock);
  const project = 'acme-acmegit.go-gitea-gitea.auto.dev.osaas.io';
  const input = (host, proto = 'https') => `protocol=${proto}\nhost=${host}\n\n`;
  try {
    const ok = await runHelper([`--host=${project}`, 'get'], input(project), { LIIVO_SOCKET: sock });
    assert.strictEqual(ok.stdout, 'username=x-access-token\npassword=gitea_testtoken\n');
    const upper = await runHelper([`--host=${project}`, 'get'], input(project.toUpperCase()), { LIIVO_SOCKET: sock });
    assert.strictEqual(upper.stdout, 'username=x-access-token\npassword=gitea_testtoken\n');
    // github.com still answers when a --host is configured
    const gh = await runHelper([`--host=${project}`, 'get'], GITHUB, { LIIVO_SOCKET: sock });
    assert.strictEqual(gh.stdout, 'username=x-access-token\npassword=gitea_testtoken\n');
    assert.strictEqual(calls.length, 3);

    calls.length = 0;
    for (const [args, inp] of [
      [[`--host=${project}`, 'get'], input('other-othergit.go-gitea-gitea.auto.dev.osaas.io')],
      [[`--host=${project}`, 'get'], input('example.com')],
      [[`--host=${project}`, 'get'], input(`${project}.evil.example`)],
      [[`--host=${project}`, 'get'], input(`x${project}`)],
      [[`--host=${project}`, 'get'], input(`${project}:3000`)],
      [[`--host=${project}`, 'get'], input(project, 'http')],
      [[`--host=${project}`, 'store'], `${input(project)}username=x\npassword=y\n`],
      [[`--host=${project}`, 'erase'], input(project)],
      [['get'], input(project)], // no --host configured: not this host
    ]) {
      const r = await runHelper(args, inp, { LIIVO_SOCKET: sock });
      assert.strictEqual(r.stdout, '');
      assert.strictEqual(r.code, 0);
    }
    assert.strictEqual(calls.length, 0);
  } finally {
    proxy.signer.close();
    gateway.close();
  }
});

test('the git credential helper returns nothing and names the cause when the gateway or the proxy refuses or is unreachable', async () => {
  await handoff(browserToken({ tenant: 'tenant', instance: 'tenant-proj' }));
  const statuses = [403, 404, 503];
  let next = 0;
  const gateway = http.createServer((req, res) => {
    res.writeHead(statuses[next++ % statuses.length], { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ token: 'ghs_must_not_be_used' }));
  });
  const gwPort = await listen(gateway);
  const proxy = createForwarder({ previewPort: 1, handoffKey: KEY, gatewayUrl: `http://127.0.0.1:${gwPort}`, instance: 'tenant-proj', identityFile, now });
  const sock = path.join(tmp, 'refuse.sock');
  await listenOnSocket(proxy.signer, sock);
  try {
    const causes = [/status 403/, /no repository access bound/, /status 503/];
    for (const cause of causes) {
      const r = await runHelper(['get'], GITHUB, { LIIVO_SOCKET: sock });
      assert.strictEqual(r.code, 0);
      assert.strictEqual(r.stdout, '');
      assert.strictEqual(r.stderr.trim().split('\n').length, 1);
      assert.match(r.stderr, cause);
      assert.doesNotMatch(r.stderr, /ghs_must_not_be_used/);
    }
  } finally {
    proxy.signer.close();
    gateway.close();
  }
  // gateway unreachable
  const dead = net.createServer();
  const deadPort = await listen(dead);
  await new Promise((r) => dead.close(r));
  const unreachable = createForwarder({ previewPort: 1, handoffKey: KEY, gatewayUrl: `http://127.0.0.1:${deadPort}`, instance: 'tenant-proj', identityFile, now });
  const sock2 = path.join(tmp, 'unreach.sock');
  await listenOnSocket(unreachable.signer, sock2);
  try {
    const r = await runHelper(['get'], GITHUB, { LIIVO_SOCKET: sock2 });
    assert.strictEqual(r.stdout, '');
    assert.match(r.stderr, /gateway not reachable/);
  } finally {
    unreachable.signer.close();
  }
  // edit proxy socket missing
  const r = await runHelper(['get'], GITHUB, { LIIVO_SOCKET: path.join(tmp, 'missing.sock') });
  assert.strictEqual(r.stdout, '');
  assert.strictEqual(r.code, 0);
  assert.match(r.stderr, /edit proxy not reachable/);
});

test('once the instance is learned, a handoff or status token naming another instance answers 401; the first handoff teaches it', async () => {
  const file = path.join(tmp, 'identity-pin.json');
  const pinned = createForwarder({ previewPort: 1, handoffKey: KEY, gatewayUrl: GATEWAY, instance: 'guess', projectDir: tmp, identityFile: file, now });
  const port = await listen(pinned);
  const hand = (t) => request(port, { path: `/?__liivo=${t}` });
  const stat = (t) => request(port, { path: '/__liivo/status', headers: { Authorization: `Bearer ${t}` } });
  try {
    // nothing learned yet: the first valid handoff is accepted whatever it names
    assert.strictEqual((await hand(browserToken({ instance: 'tenant-first' }))).status, 302);
    assert.strictEqual((await hand(browserToken({ instance: 'tenant-other' }))).status, 401);
    assert.strictEqual((await hand(browserToken({ instance: '' }))).status, 401);
    assert.strictEqual((await stat(gatewayToken({ instance: 'tenant-other' }))).status, 401);
    assert.strictEqual((await hand(browserToken({ instance: 'tenant-first' }))).status, 302);
    assert.strictEqual((await stat(gatewayToken({ instance: 'tenant-first' }))).status, 200);
  } finally {
    pinned.close();
  }
  // a restart remembers it from the identity file
  const again = createForwarder({ previewPort: 1, handoffKey: KEY, gatewayUrl: GATEWAY, projectDir: tmp, identityFile: file, now });
  const port2 = await listen(again);
  try {
    assert.strictEqual((await request(port2, { path: `/?__liivo=${browserToken({ instance: 'tenant-other' })}` })).status, 401);
  } finally {
    again.close();
  }
});
