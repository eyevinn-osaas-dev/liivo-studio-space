'use strict';
// Edit proxy and preview forwarder for the Liivo Studio workspace block. Listens
// on 0.0.0.0:PORT (the only non-loopback listener in the instance) and forwards
// HTTP requests and WebSocket upgrades to the project's preview on
// 127.0.0.1:PREVIEW_PORT, but only for a caller with this proxy's own session
// (design D8): every request, `/` and upgrades included, on every address.
// A session starts only from a gateway handoff token (forwarder/auth.js).
// After the session check, GET/HEAD and WebSocket requests under /__liivo/ (except
// open, status and bridge/) go to the Liivo Studio bridge on 127.0.0.1:4777, and
// page navigations to the preview get the bridge's client script tag (inject.js).
// node:http, node:net, node:crypto, node:fs only, no dependencies.
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const auth = require('./auth.js');
const { workspaceStatus } = require('./workspace-status.js');
const inject = require('./inject.js');
const { defaultStartStatus } = require('./default-start-status.js');

const RESERVED_PREFIX = '/__liivo/';
const OPEN_PATH = '/__liivo/open';
const STATUS_PATH = '/__liivo/status';
const RELOAD_PATH = '/__liivo/bridge/reload';
const HANDOFF_PARAM ='__liivo';
const DEFAULT_BRIDGE_PORT = 4777;
// What of the /__liivo/ namespace the bridge may serve: a plain path of letters, digits, dots, dashes and
// underscores, no dot segment, and not the proxy's own (`open`, `status`) or the reserved `bridge/`.
const BRIDGE_PATH_RE = /^\/__liivo\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const PROXY_OWN = new Set(['open', 'status', 'bridge']);
const BRIDGE_STATES = new Set(['running', 'starting', 'unavailable']);
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BRIDGE_STARTING = '{"bridge":"starting"}\n';
const BRIDGE_TOKEN_SECONDS = 45;

const PAGE_503 =
  '<!doctype html><html><head><meta charset="utf-8"><title>Project must be recreated</title></head>' +
  '<body><h1>Project must be recreated</h1><p>This workspace has no valid access key and refuses all requests. ' +
  'Recreate the project.</p></body></html>\n';

const PAGE_401 =
  '<!doctype html><html><head><meta charset="utf-8"><title>Sign in required</title></head>' +
  '<body><h1>Sign in required</h1><p>Open this project from Liivo Studio.</p></body></html>\n';

// The page for a preview that does not answer. With a status of the default start (default-start.js) it adds one
// status line and, while the default start is installing or starting, reloads itself.
function page502(status = null) {
  const refresh = status && status.refresh ? '<meta http-equiv="refresh" content="4">' : '';
  return (
    `<!doctype html><html><head><meta charset="utf-8">${refresh}<title>Preview not running</title></head>` +
    `<body><h1>Preview not running</h1><p>The project's preview is not running.</p>${status ? status.html : ''}${inject.tagFor('')}</body></html>\n`
  );
}

// Normalised path of a request target, for the /__liivo/ checks only (the
// forwarded target is never rewritten). Handles absolute-form targets
// (`GET http://x/__liivo/..`), dot segments, percent-encoding, repeated slashes
// and case.
function pathOf(url) {
  let p;
  try {
    // Leading slashes are collapsed first: `//host/p` would otherwise parse as
    // a protocol-relative URL and hide the path.
    p = new URL(url.replace(/^\/{2,}/, '/'), 'http://x').pathname;
  } catch {
    p = url;
  }
  try {
    p = decodeURIComponent(p);
  } catch {
    // keep the undecoded path
  }
  return p.replace(/\/{2,}/g, '/').toLowerCase();
}

function isReserved(url) {
  const p = pathOf(url);
  return p === '/__liivo' || p.startsWith(RESERVED_PREFIX);
}

// Normalised path plus query parameters of a request target.
function targetOf(url) {
  try {
    const u = new URL(url.replace(/^\/{2,}/, '/'), 'http://x');
    return { path: pathOf(url), params: u.searchParams };
  } catch {
    return { path: pathOf(url), params: new URLSearchParams() };
  }
}

// LIIVO_GATEWAY_URL: an http(s) URL without credentials, no trailing slash.
// Returns '' for anything else (navigations then answer 401 instead of 302).
function parseGatewayUrl(value) {
  try {
    const u = new URL(String(value || ''));
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) return '';
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return '';
  }
}

// Headers that describe the client or the hop are set by the ingress, not by the
// caller, and this proxy never trusts them: they are dropped before forwarding.
// `Host` is passed on unchanged and is used for no decision except the
// handoff's host binding. The session cookie is removed from the Cookie header.
function isUntrustedHeader(name) {
  const n = name.toLowerCase();
  return n === 'forwarded' || n === 'x-real-ip' || n.startsWith('x-forwarded-');
}

function forwardHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (isUntrustedHeader(name)) continue;
    if (name.toLowerCase() === 'cookie') {
      const kept = auth.stripSessionCookie(value);
      if (kept) out[name] = kept;
      continue;
    }
    out[name] = value;
  }
  return out;
}

function isNavigation(req) {
  return (req.method === 'GET' || req.method === 'HEAD') && /text\/html/i.test(req.headers.accept || '');
}

// The path a request for the bridge asks for, or null when it is not one the bridge may serve. Only a request
// target that is already in its plain form qualifies (nothing is rewritten on the way): no percent-encoding, no
// repeated slash, no dot segment, no absolute-form target, and not `open`, `status` or `bridge/...` in any case.
function bridgePathOf(url) {
  const raw = String(url).split('?')[0];
  if (!BRIDGE_PATH_RE.test(raw)) return null;
  const parts = raw.split('/').slice(2);
  if (parts.some((p) => p === '.' || p === '..')) return null;
  if (PROXY_OWN.has(parts[0].toLowerCase())) return null;
  return raw;
}

// What the supervisor wrote to ~/.liivo/bridge/state.json, validated: the volume is writable by project code.
function readBridgeState(file) {
  const unavailable = { version: null, state: 'unavailable' };
  if (!file) return unavailable;
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!s || !BRIDGE_STATES.has(s.state)) return unavailable;
    return { version: typeof s.version === 'string' && VERSION_RE.test(s.version) ? s.version : null, state: s.state };
  } catch {
    return unavailable;
  }
}

// A browser request from another origin (a sibling *.osaas.io app is the same
// site, so SameSite does not stop it) must not ride the session cookie when it
// can change state or open a WebSocket.
function crossOrigin(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return false;
  try {
    return new URL(origin).host.toLowerCase() !== String(req.headers.host || '').toLowerCase();
  } catch {
    return true;
  }
}

function bearer(req) {
  const m = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization || '');
  return m ? m[1] : '';
}

function createForwarder({
  previewPort,
  upstreamHost = '127.0.0.1',
  handoffKey = null,
  gatewayUrl = '',
  instance = '',
  projectDir = '',
  // Where default-start.js writes its state file (/tmp in the workspace; a test points it elsewhere).
  startStateDir = '/tmp',
  identityFile = '',
  bridgePort = DEFAULT_BRIDGE_PORT,
  bridgeStateFile = '',
  // Existence-only request file the supervisor (osc-entrypoint.sh) polls; next to state.json unless given.
  reloadRequestFile = bridgeStateFile ? path.join(path.dirname(bridgeStateFile), 'reload-request') : '',
  // Deadline of the loopback /health read, below the gateway's 5 s abort of its reload call.
  idleReadTimeoutMs = 2000,
  injectMaxBytes = 8 * 1024 * 1024,
  injectTimeoutMs = 10000,
  now = () => Math.floor(Date.now() / 1000),
}) {
  const nonces = auth.createNonceStore();
  // Who the gateway said this workspace belongs to, learned from verified
  // tokens only. Not secret. Kept on disk so a restart remembers it.
  let identity = { tenant: '', user: '', instance: instance || '' };
  if (identityFile) {
    try {
      const saved = JSON.parse(fs.readFileSync(identityFile, 'utf8'));
      if (saved && typeof saved.tenant === 'string' && typeof saved.instance === 'string') {
        identity = { tenant: saved.tenant, user: String(saved.user || ''), instance: saved.instance };
      }
    } catch {
      // none saved yet
    }
  }
  // Once the identity has been learned from a verified token, a token naming
  // another instance is refused (defence in depth: the key is per project).
  // Before the first handoff nothing is known, so the first one teaches it.
  function instanceMismatch(claims) {
    return Boolean(identity.tenant) && claims.instance !== identity.instance;
  }
  function learn(claims) {
    if (!claims.tenant || !claims.instance) return;
    if (identity.tenant === claims.tenant && identity.instance === claims.instance && (!claims.user || identity.user === claims.user)) return;
    identity = { tenant: claims.tenant, user: claims.user || identity.user, instance: claims.instance };
    if (identityFile) {
      try {
        fs.writeFileSync(identityFile, JSON.stringify(identity), { mode: 0o600 });
      } catch {
        // best effort
      }
    }
  }

  function text(res, status, type, body, extra = {}) {
    res.writeHead(status, {
      'Content-Type': type,
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      ...extra,
    });
    res.end(body);
  }

  // No valid session: a navigation is sent to the gateway, everything else is 401.
  function deny(req, res) {
    const inst = identity.instance || instance;
    if (isNavigation(req) && gatewayUrl && inst) {
      res.writeHead(302, {
        Location: `${gatewayUrl}/w/${encodeURIComponent(inst)}`,
        'Content-Length': '0',
        'Cache-Control': 'no-store',
      });
      res.end();
      return;
    }
    text(res, 401, 'text/html; charset=utf-8', req.method === 'HEAD' ? '' : PAGE_401);
  }

  function handoff(req, res, tokens) {
    const refuse = () => text(res, 401, 'text/plain', 'Unauthorized\n', { 'Referrer-Policy': 'no-referrer' });
    if (tokens.length !== 1) return refuse();
    const t = now();
    const v = auth.verifyToken(handoffKey, tokens[0], 'browser', t);
    if (!v.ok) return refuse();
    const host = String(req.headers.host || '').toLowerCase();
    if (!host || v.claims.host.toLowerCase() !== host) return refuse();
    if (instanceMismatch(v.claims)) return refuse();
    if (!v.claims.nonce || !nonces.use(v.claims.nonce, v.claims.exp, t)) return refuse();
    learn(v.claims);
    res.writeHead(302, {
      Location: OPEN_PATH,
      'Set-Cookie': auth.setCookieHeader(auth.signSession(handoffKey, v.claims, t)),
      'Content-Length': '0',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    });
    res.end();
  }

  async function status(req, res) {
    const v = auth.verifyToken(handoffKey, bearer(req), 'gateway', now());
    if (!v.ok) {
      return text(res, 401, 'application/json', '{"error":"unauthorized"}\n', { 'WWW-Authenticate': 'Bearer' });
    }
    if (instanceMismatch(v.claims)) {
      return text(res, 401, 'application/json', '{"error":"unauthorized"}\n', { 'WWW-Authenticate': 'Bearer' });
    }
    learn(v.claims);
    if (req.method !== 'GET') {
      return text(res, 405, 'application/json', '{"error":"method not allowed"}\n', { Allow: 'GET' });
    }
    try {
      const st = { ...(await workspaceStatus(projectDir)), bridge: readBridgeState(bridgeStateFile) };
      text(res, 200, 'application/json', `${JSON.stringify(st)}\n`);
    } catch (e) {
      text(res, 500, 'application/json', `${JSON.stringify({ error: e.message })}\n`);
    }
  }

  // One GET of the bridge's loopback /health. Resolves true only for a 200 JSON answer with boolean busy === false,
  // false for busy === true, and null for every other outcome (no answer, timeout, non-200, malformed body).
  function readIdle() {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (!done) {
          done = true;
          resolve(v);
        }
      };
      const r = http.get({ host: '127.0.0.1', port: bridgePort, path: '/health', agent: false, timeout: idleReadTimeoutMs }, (hr) => {
        const chunks = [];
        let size = 0;
        hr.on('data', (c) => {
          size += c.length;
          if (size > 65536) {
            hr.destroy();
            finish(null);
          } else chunks.push(c);
        });
        hr.on('error', () => finish(null));
        hr.on('end', () => {
          if (hr.statusCode !== 200) return finish(null);
          try {
            const b = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            finish(b && typeof b.busy === 'boolean' ? !b.busy : null);
          } catch {
            finish(null);
          }
        });
      });
      r.on('timeout', () => {
        r.destroy();
        finish(null);
      });
      r.on('error', () => finish(null));
    });
  }

  // Records a request for the supervisor, atomically (tmp file, then rename). False when it cannot be written.
  function recordReload() {
    if (!reloadRequestFile) return false;
    const tmp = `${reloadRequestFile}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, '', { mode: 0o600 });
      fs.renameSync(tmp, reloadRequestFile);
      return true;
    } catch {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // nothing to clean up
      }
      return false;
    }
  }

  // POST /__liivo/bridge/reload, gateway token only (same channel as /__liivo/status). Honoured only when the bridge
  // is idle: 202 after recording the request for the supervisor (which checks idle again right before it stops the
  // bridge), 409 otherwise with nothing changed. The answer never waits for the stop or the fetch.
  async function reload(req, res) {
    const unauthorized = () => text(res, 401, 'application/json', '{"error":"unauthorized"}\n', { 'WWW-Authenticate': 'Bearer' });
    const v = auth.verifyToken(handoffKey, bearer(req), 'gateway', now());
    if (!v.ok || instanceMismatch(v.claims)) return unauthorized();
    learn(v.claims);
    if (req.method !== 'POST') {
      return text(res, 405, 'application/json', '{"error":"method not allowed"}\n', { Allow: 'POST' });
    }
    const refuse = (reason) => text(res, 409, 'application/json', `${JSON.stringify({ reload: 'refused', reason })}\n`);
    let idle = await readIdle();
    if (idle === null && readBridgeState(bridgeStateFile).state === 'starting') idle = true;
    if (idle === false) return refuse('busy');
    if (idle !== true) return refuse('unknown');
    if (!recordReload()) return refuse('unknown');
    text(res, 202, 'application/json', '{"reload":"started"}\n');
  }

  const server = http.createServer((req, res) => {
    if (!handoffKey) {
      // Fail closed: nothing is served without a key to check sessions against.
      req.resume();
      text(res, 503, 'text/html; charset=utf-8', req.method === 'HEAD' ? '' : PAGE_503);
      return;
    }
    const target = targetOf(req.url);
    if (target.path === STATUS_PATH) {
      req.resume();
      status(req, res);
      return;
    }
    if (target.path === RELOAD_PATH) {
      req.resume();
      reload(req, res);
      return;
    }
    if (req.method === 'GET' && target.path === '/' && target.params.has(HANDOFF_PARAM)) {
      req.resume();
      handoff(req, res, target.params.getAll(HANDOFF_PARAM));
      return;
    }
    if (!auth.sessionFromCookieHeader(handoffKey, req.headers.cookie, now())) {
      req.resume();
      deny(req, res);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && crossOrigin(req)) {
      req.resume();
      text(res, 401, 'text/plain', 'Unauthorized\n');
      return;
    }
    if (target.path === OPEN_PATH) {
      req.resume();
      res.writeHead(302, { Location: '/', 'Content-Length': '0', 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    if (isReserved(req.url)) {
      const bridgePath = bridgePathOf(req.url);
      if (bridgePath && (req.method === 'GET' || req.method === 'HEAD')) {
        toBridge(req, res);
        return;
      }
      req.resume();
      if (bridgePath) {
        // The bridge's POST endpoint (/preview, for Claude's own tools) is loopback only and is never reached from here.
        text(res, 405, 'text/plain', 'Method not allowed\n', { Allow: 'GET, HEAD' });
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain', 'Content-Length': '10' });
      res.end('Not found\n');
      return;
    }
    toPreview(req, res);
  });

  // /__liivo/* to the bridge on loopback, GET and HEAD only. The bridge is not running (or not yet): the page script
  // is replaced by the placeholder, everything else answers 503.
  function toBridge(req, res) {
    const up = http.request(
      { host: '127.0.0.1', port: bridgePort, method: req.method, path: req.url, headers: forwardHeaders(req.headers), agent: false },
      (upRes) => {
        res.writeHead(upRes.statusCode, upRes.statusMessage, upRes.headers);
        upRes.pipe(res);
        upRes.on('error', () => res.destroy());
      }
    );
    up.on('error', () => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (bridgePathOf(req.url) === inject.CLIENT_SRC) {
        const body = inject.PLACEHOLDER_CLIENT;
        text(res, 200, 'text/javascript; charset=utf-8', req.method === 'HEAD' ? '' : body, { 'Content-Length': Buffer.byteLength(body) });
        return;
      }
      text(res, 503, 'application/json', req.method === 'HEAD' ? '' : BRIDGE_STARTING, { 'Retry-After': '2' });
    });
    res.on('close', () => up.destroy());
    req.resume();
    up.end();
  }

  // Everything else to the project's preview. A page navigation gets the client script tag (design D27).
  function toPreview(req, res) {
    const navigation = inject.isNavigationRequest(req);
    const upstream = http.request(
      {
        host: upstreamHost,
        port: previewPort,
        method: req.method,
        path: req.url,
        headers: navigation ? inject.navigationHeaders(forwardHeaders(req.headers)) : forwardHeaders(req.headers),
        agent: false,
      },
      (upRes) => {
        if (navigation && inject.isTaggable(req.method, upRes.statusCode, upRes.headers)) {
          tagged(upRes, res);
          return;
        }
        res.writeHead(upRes.statusCode, upRes.statusMessage, upRes.headers);
        upRes.pipe(res);
        upRes.on('error', () => res.destroy());
      }
    );
    upstream.on('error', () => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const page = page502(defaultStartStatus(projectDir, startStateDir));
      res.writeHead(502, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(page),
      });
      res.end(page);
    });
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  }

  // Buffers an HTML answer up to injectMaxBytes and injectTimeoutMs and sends it with the tag. When it is larger or
  // slower than that, what is held is sent as the upstream gave it (its own headers, no tag) and the rest is streamed.
  function tagged(upRes, res) {
    const held = [];
    let size = 0;
    let settled = false;
    const timer = setTimeout(passThrough, injectTimeoutMs);
    function onData(chunk) {
      held.push(chunk);
      size += chunk.length;
      if (size > injectMaxBytes) passThrough();
    }
    function passThrough() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      upRes.removeListener('data', onData);
      upRes.removeListener('end', onEnd);
      res.writeHead(upRes.statusCode, upRes.statusMessage, upRes.rawHeaders);
      for (const c of held) res.write(c);
      upRes.pipe(res);
    }
    function onEnd() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const body = Buffer.concat(held);
      const nonce = inject.findNonce(upRes.headers['content-security-policy'], body.toString('latin1'));
      res.writeHead(upRes.statusCode, upRes.statusMessage, inject.taggedHeaders(upRes.rawHeaders));
      res.end(inject.insertTag(body, nonce));
    }
    upRes.on('data', onData);
    upRes.on('end', onEnd);
    upRes.on('error', () => {
      clearTimeout(timer);
      res.destroy();
    });
    res.on('close', () => clearTimeout(timer));
  }

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    const reply = (line) => socket.end(`HTTP/1.1 ${line}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    if (!handoffKey) {
      reply('503 Service Unavailable');
      return;
    }
    if (!auth.sessionFromCookieHeader(handoffKey, req.headers.cookie, now()) || crossOrigin(req)) {
      reply('401 Unauthorized');
      return;
    }
    // /__liivo/ws and the like go to the bridge, in the same tunnel as the preview's own upgrades (its HMR).
    const toBridge = Boolean(bridgePathOf(req.url));
    if (isReserved(req.url) && !toBridge) {
      reply('404 Not Found');
      return;
    }
    const upstream = toBridge ? net.connect(bridgePort, '127.0.0.1') : net.connect(previewPort, upstreamHost);
    let established = false;
    upstream.on('error', () => {
      // Never write a 502 page into a stream that is already past the handshake.
      if (established) {
        socket.destroy();
      } else if (toBridge && socket.writable) {
        socket.end(`HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\nRetry-After: 2\r\n\r\n`);
      } else if (socket.writable) {
        const page = page502(defaultStartStatus(projectDir, startStateDir));
        socket.end(
          'HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Type: text/html; charset=utf-8\r\n' +
            `Content-Length: ${Buffer.byteLength(page)}\r\n\r\n${page}`
        );
      } else {
        socket.destroy();
      }
    });
    upstream.on('connect', () => {
      established = true;
      let rawHead = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i];
        let value = req.rawHeaders[i + 1];
        if (isUntrustedHeader(name)) continue;
        if (name.toLowerCase() === 'cookie') {
          value = auth.stripSessionCookie(value);
          if (!value) continue;
        }
        rawHead += `${name}: ${value}\r\n`;
      }
      upstream.write(`${rawHead}\r\n`);
      if (head && head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    // Half-close first so data still in flight is flushed, then destroy.
    upstream.on('end', () => socket.end());
    socket.on('end', () => upstream.end());
    upstream.on('close', () => setTimeout(() => socket.destroy(), 1000).unref());
    socket.on('close', () => setTimeout(() => upstream.destroy(), 1000).unref());
  });

  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });

  // Signs an `aud` git token for the git credential helper. Served only on a
  // unix socket (mode 0600) in the home directory: the helper runs inside the
  // workspace, and the key itself never leaves this process.
  server.signer = http.createServer((req, res) => {
    req.resume();
    const inst = identity.instance || instance;
    const refuse = (status, msg) => text(res, status, 'application/json', `${JSON.stringify({ error: msg })}\n`);
    // /git-token: the credential helper (audience git, 60 s); /bridge-token: the bridge fetcher (audience bridge, 45 s,
    // the browser tokens' slack for clock skew).
    let audience = null;
    if (req.method === 'POST' && req.url === '/git-token') audience = ['git', 60];
    if (req.method === 'POST' && req.url === '/bridge-token') audience = ['bridge', BRIDGE_TOKEN_SECONDS];
    if (!audience) return refuse(404, 'not found');
    if (!handoffKey) return refuse(503, 'HANDOFF_KEY is not set');
    if (!gatewayUrl) return refuse(503, 'LIIVO_GATEWAY_URL is not set');
    if (!identity.tenant || !inst) {
      return refuse(409, 'tenant not known yet: no handoff or status call has reached this workspace');
    }
    const token = auth.signToken(handoffKey, {
      aud: audience[0],
      host: '',
      tenant: identity.tenant,
      user: identity.user,
      instance: inst,
      exp: now() + audience[1],
    });
    text(res, 200, 'application/json', `${JSON.stringify({ token, gatewayUrl })}\n`);
  });

  return server;
}

function listenOnSocket(server, socketPath) {
  try {
    fs.unlinkSync(socketPath);
  } catch {
    // none left over
  }
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      fs.chmodSync(socketPath, 0o600);
      resolve();
    });
  });
}

function parsePort(name, value) {
  if (!/^[0-9]+$/.test(value || '')) throw new Error(`${name} must be a number, got '${value}'`);
  const n = Number(value);
  if (n < 1 || n > 65535) throw new Error(`${name} out of range: ${value}`);
  return n;
}

// The key arrives on stdin, never in the environment: the entrypoint starts this
// process with `env -i`, and an environment variable would also show up in
// /proc/<pid>/environ and in anything that inherits it.
function readStdin(timeoutMs = 5000) {
  return new Promise((resolve) => {
    const chunks = [];
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    setTimeout(done, timeoutMs).unref();
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

async function main() {
  const port = parsePort('PORT', process.env.PORT);
  const previewPort = parsePort('PREVIEW_PORT', process.env.PREVIEW_PORT || '3000');
  const handoffKey = auth.parseKey(await readStdin());
  const rawGateway = process.env.LIIVO_GATEWAY_URL || '';
  const gatewayUrl = parseGatewayUrl(rawGateway);
  const home = process.env.HOME || '/home/coder';
  if (!handoffKey) {
    console.error(
      'edit-proxy: HANDOFF_KEY is missing or not 32 bytes of base64: refusing every request (503). Recreate the project.'
    );
  }
  if (rawGateway && !gatewayUrl) console.error('edit-proxy: LIIVO_GATEWAY_URL is not a valid http(s) URL, ignored');
  if (!rawGateway) {
    console.error('edit-proxy: LIIVO_GATEWAY_URL is not set: navigations without a session answer 401, git credentials are unavailable');
  }
  // An unexpected error must never take the forwarder down.
  process.on('uncaughtException', (e) => console.error(`preview-forwarder: ${e.message}`));
  const server = createForwarder({
    previewPort,
    handoffKey,
    gatewayUrl,
    instance: process.env.LIIVO_INSTANCE || '',
    projectDir: process.env.PROJECT_DIR || path.join(home, 'project'),
    identityFile: path.join(home, '.liivo', 'identity.json'),
    bridgePort: process.env.LIIVO_BRIDGE_PORT ? parsePort('LIIVO_BRIDGE_PORT', process.env.LIIVO_BRIDGE_PORT) : DEFAULT_BRIDGE_PORT,
    bridgeStateFile: path.join(home, '.liivo', 'bridge', 'state.json'),
  });
  try {
    await listenOnSocket(server.signer, process.env.LIIVO_SOCKET || path.join(home, '.liivo', 'sign.sock'));
  } catch (e) {
    // The proxy still serves; only the git credential helper is unavailable.
    console.error(`edit-proxy: git signing socket not available: ${e.message}`);
  }
  server.listen(port, '0.0.0.0', () => {
    console.error(`preview-forwarder: 0.0.0.0:${port} -> 127.0.0.1:${previewPort}`);
  });
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`preview-forwarder: ${e.message}`);
    process.exit(2);
  });
}

module.exports = { createForwarder, parseGatewayUrl, listenOnSocket };
