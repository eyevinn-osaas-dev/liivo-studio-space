#!/usr/bin/env node
'use strict';
// Fetches the project's parameter store values from the gateway for the `liivo-env` wrapper
// (Eyevinn/liivo-studio-space#21). node:* only.
//
//   1. Ask the edit proxy's signer (~/.liivo/sign.sock, POST /env-token) for an `aud` env token. The signer
//      answers 409 until a handoff or status call has told the workspace who it belongs to; that is polled
//      every 2 s up to LIIVO_ENV_TENANT_WAIT seconds (default 300), then the reason is `tenant_unknown`.
//   2. GET <LIIVO_GATEWAY_URL>/api/project-env with the token (one bounded request).
//   3. Print the loaded values to stdout as NUL-separated `NAME=value` records, for the wrapper to export
//      without eval or source, write /tmp/liivo-env.state (mode 0600, never a value) and print one line
//      with the store name and the counts to stderr.
//
// Every failure ends the same way: no records, a state file with the reason, exit 0. The command still starts.
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

// Limits. The gateway is never stricter than these.
const MAX_NAMES = 100;
const MAX_VALUE_BYTES = 32 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024;
const MAX_BODY_BYTES = 1024 * 1024;

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Reserved names, compared upper-cased. A project can start from, or change, none of these through the store.
const RESERVED_EXACT = new Set(
  (
    'PATH HOME USER LOGNAME SHELL PWD TMPDIR HOST PORT PREVIEW_PORT PROJECT_DIR IFS PS4 ENV BASH_ENV SHELLOPTS BASHOPTS ' +
    'PROMPT_COMMAND BASH_XTRACEFD GCONV_PATH GLIBC_TUNABLES NODE_OPTIONS NODE_PATH NODE_TLS_REJECT_UNAUTHORIZED ' +
    'NODE_EXTRA_CA_CERTS SSL_CERT_FILE SSL_CERT_DIR REQUESTS_CA_BUNDLE CURL_CA_BUNDLE JAVA_TOOL_OPTIONS _JAVA_OPTIONS ' +
    'JDK_JAVA_OPTIONS PERL5OPT PERL5DB PERL5LIB RUBYOPT RUBYLIB BROWSER HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY ' +
    'HANDOFF_KEY CC CXX CPP CFLAGS CXXFLAGS CPPFLAGS LDFLAGS MAKEFLAGS MFLAGS GNUMAKEFLAGS MAKEFILES PS0 PS1 PS2 PS3 ' +
    'LESSOPEN LESSCLOSE GOFLAGS GOPROXY GOSUMDB GONOSUMDB GONOSUMCHECK GOINSECURE GOPRIVATE GONOPROXY GOTOOLCHAIN GOENV ' +
    'RUSTC RUSTC_WRAPPER RUSTFLAGS RUSTDOCFLAGS MAVEN_OPTS MAVEN_ARGS GRADLE_OPTS JAVA_OPTS PLAYWRIGHT_DOWNLOAD_HOST ' +
    'SASS_BINARY_SITE NODEJS_ORG_MIRROR NVM_NODEJS_ORG_MIRROR LOCPATH NLSPATH MALLOC_TRACE OPENSSL_CONF OPENSSL_MODULES ' +
    'OPENSSL_ENGINES DOTNET_STARTUP_HOOKS TERMINFO'
  ).split(' ')
);
const RESERVED_PREFIXES = [
  'BASH_FUNC_', 'LD_', 'PYTHON', 'NPM_CONFIG_', 'YARN_', 'PNPM_', 'PIP_', 'UV_', 'XDG_', 'GIT_', 'CODER_', 'CLAUDE_',
  'ANTHROPIC_', 'LIIVO_', 'OSC_', 'MISE_', 'COREPACK_', 'CARGO_', 'RUSTUP_', 'BUNDLE_', 'GEM_', 'RUBYGEMS_',
  'PUPPETEER_', 'CYPRESS_', 'CORECLR_',
];
const ALLOWED_DESPITE_PREFIX = new Set(['UV_THREADPOOL_SIZE', 'UV_USE_IO_URING']);

function isReserved(name) {
  const up = name.toUpperCase();
  if (ALLOWED_DESPITE_PREFIX.has(up)) return false;
  if (RESERVED_EXACT.has(up)) return true;
  if (up.startsWith('ELECTRON_') && up.includes('MIRROR')) return true;
  return RESERVED_PREFIXES.some((p) => up.startsWith(p));
}

// { env: [[name, value]], skipped: [{ name, reason }] } from the gateway's `values`. Pure: no I/O.
function selectValues(values, gatewaySkipped) {
  const env = [];
  const skipped = [];
  let total = 0;
  for (const s of Array.isArray(gatewaySkipped) ? gatewaySkipped : []) {
    if (s && typeof s.name === 'string' && typeof s.reason === 'string') {
      skipped.push({ name: s.name.slice(0, 128), reason: s.reason.slice(0, 64) });
    }
  }
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== 'string') skipped.push({ name, reason: 'not_a_string' });
    else if (!NAME_RE.test(name)) skipped.push({ name: name.slice(0, 128), reason: 'invalid_name' });
    else if (isReserved(name)) skipped.push({ name, reason: 'reserved_name' });
    else if (value.includes('\0')) skipped.push({ name, reason: 'nul_in_value' });
    else if (Buffer.byteLength(value) > MAX_VALUE_BYTES) skipped.push({ name, reason: 'value_too_long' });
    else if (env.length >= MAX_NAMES) skipped.push({ name, reason: 'too_many_names' });
    else if (total + Buffer.byteLength(name) + Buffer.byteLength(value) > MAX_TOTAL_BYTES) skipped.push({ name, reason: 'total_too_large' });
    else {
      total += Buffer.byteLength(name) + Buffer.byteLength(value);
      env.push([name, value]);
    }
  }
  return { env, skipped };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function signerToken(socketPath, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.request({ socketPath, path: '/env-token', method: 'POST', timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          // handled by the status
        }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ status: 0, missing: e.code === 'ENOENT' || e.code === 'ECONNREFUSED', body: {} }));
    req.end();
  });
}

function getJson(urlText, token, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(urlText);
    } catch {
      return resolve({ status: 0, body: null });
    }
    const lib = u.protocol === 'https:' ? https : http;
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    const req = lib.request(u, { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          req.destroy();
          finish({ status: res.statusCode, body: null, malformed: true });
        } else chunks.push(c);
      });
      res.on('end', () => {
        let body = null;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          // body stays null: malformed
        }
        finish({ status: res.statusCode, body });
      });
      res.on('error', () => finish({ status: 0, body: null }));
    });
    // A hard bound over the whole exchange, a gateway that accepts and never answers included.
    const timer = setTimeout(() => {
      req.destroy();
      finish({ status: 0, body: null, timeout: true });
    }, timeoutMs);
    timer.unref();
    req.on('error', () => finish({ status: 0, body: null }));
    req.end();
  });
}

const cleanReason = (r) => (typeof r === 'string' && /^[A-Za-z0-9_. -]{1,64}$/.test(r) ? r : null);

// Runs the whole load. Returns { env, state }; never throws.
async function load({ home, gatewayUrl, tenantWaitMs, signerWaitMs, requestMs, pollMs, now }) {
  const state = { time: new Date(now()).toISOString(), store: null, loaded: [], skipped: [], error: null };
  const fail = (reason) => {
    state.error = reason;
    return { env: [], state };
  };
  if (!gatewayUrl) return fail('no_gateway_url');
  const socketPath = path.join(home || '', '.liivo', 'sign.sock');
  const start = Date.now();
  let signed = null;
  for (;;) {
    const r = await signerToken(socketPath, 5000);
    if (r.status === 200 && typeof r.body.token === 'string') {
      signed = r.body.token;
      break;
    }
    if (r.status === 409 || r.missing) {
      const limit = r.status === 409 ? tenantWaitMs : signerWaitMs;
      if (Date.now() - start >= limit) return fail(r.status === 409 ? 'tenant_unknown' : 'no_signer');
      await sleep(pollMs);
      continue;
    }
    return fail(`signer_${r.status}`);
  }
  const res = await getJson(`${gatewayUrl.replace(/\/+$/, '')}/api/project-env`, signed, requestMs);
  if (res.timeout) return fail('gateway_timeout');
  if (res.status === 0) return fail('gateway_unreachable');
  if (res.status !== 200) return fail(cleanReason(res.body && res.body.reason) || `gateway_${res.status}`);
  const b = res.body;
  if (!b || typeof b !== 'object' || typeof b.bound !== 'boolean') return fail('malformed_response');
  if (!b.bound) return fail('not_bound');
  if (!b.values || typeof b.values !== 'object' || Array.isArray(b.values)) return fail('malformed_response');
  const sel = selectValues(b.values, b.skipped);
  state.store = typeof b.store === 'string' && /^[A-Za-z0-9_. -]{1,128}$/.test(b.store) ? b.store : '(unnamed)';
  state.loaded = sel.env.map(([n]) => n);
  state.skipped = sel.skipped;
  return { env: sel.env, state };
}

function writeState(file, state) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // nothing left
    }
  }
}

async function main() {
  const e = process.env;
  const secs = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 && v !== undefined && v !== '' ? Number(v) : d) * 1000;
  const { env, state } = await load({
    home: e.HOME,
    gatewayUrl: e.LIIVO_GATEWAY_URL,
    tenantWaitMs: secs(e.LIIVO_ENV_TENANT_WAIT, 300),
    signerWaitMs: secs(e.LIIVO_ENV_SIGNER_WAIT, 15),
    requestMs: secs(e.LIIVO_ENV_TIMEOUT, 10),
    pollMs: secs(e.LIIVO_ENV_POLL, 2),
    now: Date.now,
  });
  writeState(e.LIIVO_ENV_STATE_FILE || '/tmp/liivo-env.state', state);
  if (state.error) {
    // not_bound is the normal case of a project with no store: nothing to say.
    if (state.error !== 'not_bound') process.stderr.write(`liivo-env: no values loaded (${state.error})\n`);
  } else {
    process.stderr.write(`liivo-env: store ${state.store}: ${state.loaded.length} loaded, ${state.skipped.length} skipped\n`);
  }
  const out = env.map(([n, v]) => `${n}=${v}\0`).join('');
  process.stdout.write(out);
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    () => process.exit(0)
  );
}

module.exports = { selectValues, isReserved, load };
