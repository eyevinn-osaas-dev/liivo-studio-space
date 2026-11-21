'use strict';
// Tests of `liivo-env` (issue #21): the real wrapper and the real forwarder/liivo-env.js against a fake signer
// on a unix socket and a fake gateway on loopback, plus the real entrypoint for the hook wiring.
const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { isReserved, selectValues } = require('../forwarder/liivo-env.js');

const ROOT = path.join(__dirname, '..');
const WRAPPER = path.join(ROOT, 'liivo-env');
const ENTRYPOINT = path.join(ROOT, 'osc-entrypoint.sh');
const cleanups = [];
afterEach(async () => {
  while (cleanups.length) {
    try {
      await cleanups.pop()();
    } catch {
      // best effort
    }
  }
});

function workspace() {
  const dir = fs.mkdtempSync(path.join('/tmp', 'lenv-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, '.liivo'), { recursive: true });
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, home, sock: path.join(home, '.liivo', 'sign.sock'), state: path.join(dir, 'state.json') };
}

// signerAnswers: array of statuses consumed per call, the last one repeats; 200 signs { token, gatewayUrl }.
async function fakeSigner(ws, answers) {
  const calls = [];
  const server = http.createServer((req, res) => {
    req.resume();
    calls.push(`${req.method} ${req.url}`);
    const status = answers.length > 1 ? answers.shift() : answers[0];
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(status === 200 ? { token: 'signed-env-token', gatewayUrl: 'x' } : { error: 'tenant not known yet' }));
  });
  await new Promise((r) => server.listen(ws.sock, r));
  cleanups.push(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  return calls;
}

async function fakeGateway(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    req.resume();
    seen.push({ url: req.url, auth: req.headers.authorization });
    handler(req, res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}
const json = (status, body) => (req, res) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const bound = (values, extra = {}) => json(200, { bound: true, store: 'proj-store', values, skipped: [], ...extra });

function runWrapper(ws, args, env = {}, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn('bash', [WRAPPER, ...args], {
      env: { PATH: process.env.PATH, HOME: ws.home, LIIVO_ENV_STATE_FILE: ws.state, LIIVO_ENV_POLL: '0.05', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: opts.cwd,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolve({ status, stdout, stderr, pid: child.pid }));
  });
}
const state = (ws) => JSON.parse(fs.readFileSync(ws.state, 'utf8'));
const printVar = (name) => ['node', '-e', `process.stdout.write(JSON.stringify(process.env[${JSON.stringify(name)}] ?? null))`];

// ---- passing path ----

test('the command sees the loaded values exactly, including spaces, quotes, $ and a newline, and the exit status is its own', async () => {
  const ws = workspace();
  await fakeSigner(ws, [200]);
  const weird = 'a b "q" \'s\' $HOME `x` \n second line';
  const gw = await fakeGateway(bound({ ALPHA: weird, BETA_2: 'two' }));
  const r = await runWrapper(ws, ['node', '-e', 'process.stdout.write(JSON.stringify([process.env.ALPHA, process.env.BETA_2])); process.exit(7)'], { LIIVO_GATEWAY_URL: gw.url });
  assert.strictEqual(r.status, 7);
  assert.deepStrictEqual(JSON.parse(r.stdout), [weird, 'two']);
  assert.strictEqual(gw.seen[0].url, '/api/project-env');
  assert.strictEqual(gw.seen[0].auth, 'Bearer signed-env-token');
});

test('the loaded values sit on top of the environment the wrapper was called with', async () => {
  const ws = workspace();
  await fakeSigner(ws, [200]);
  const gw = await fakeGateway(bound({ NEWVAR: 'n' }));
  const r = await runWrapper(ws, ['node', '-e', 'process.stdout.write([process.env.KEEP, process.env.NEWVAR].join())'], { LIIVO_GATEWAY_URL: gw.url, KEEP: 'kept' });
  assert.strictEqual(r.stdout, 'kept,n');
});

test('exec: the command has the wrapper\'s pid, the one a parent shell recorded in the pid file', async () => {
  const ws = workspace();
  await fakeSigner(ws, [200]);
  const gw = await fakeGateway(bound({ V: '1' }));
  const pidFile = path.join(ws.dir, 'start.pid');
  const r = await new Promise((resolve) => {
    const child = spawn('bash', ['-c', 'printf "%s" "$$" > "$1"; shift; exec "$@"', '_', pidFile, 'bash', WRAPPER, 'node', '-e', 'process.stdout.write(process.pid + ":" + process.env.V)'], {
      env: { PATH: process.env.PATH, HOME: ws.home, LIIVO_GATEWAY_URL: gw.url, LIIVO_ENV_STATE_FILE: ws.state },
    });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.on('close', () => resolve(out));
  });
  const [pid, v] = r.split(':');
  assert.strictEqual(pid, fs.readFileSync(pidFile, 'utf8'));
  assert.strictEqual(v, '1');
});

test('no value reaches eval, source or a shell: command substitutions arrive literally and run nothing', async () => {
  const ws = workspace();
  await fakeSigner(ws, [200]);
  fs.rmSync('/tmp/x1', { force: true });
  fs.rmSync('/tmp/x2', { force: true });
  const gw = await fakeGateway(bound({ SUB1: '$(touch /tmp/x1)', SUB2: '`touch /tmp/x2`' }));
  const r = await runWrapper(ws, ['node', '-e', 'process.stdout.write(JSON.stringify([process.env.SUB1, process.env.SUB2]))'], { LIIVO_GATEWAY_URL: gw.url });
  assert.deepStrictEqual(JSON.parse(r.stdout), ['$(touch /tmp/x1)', '`touch /tmp/x2`']);
  assert.strictEqual(fs.existsSync('/tmp/x1'), false);
  assert.strictEqual(fs.existsSync('/tmp/x2'), false);
});

// ---- names ----

const sel = (values) => selectValues(values, []);
const reasonOf = (name, value = 'v') => {
  const s = sel({ [name]: value });
  return s.skipped.length ? s.skipped[0].reason : 'loaded';
};

test('a name that is not a valid identifier is skipped by name', () => {
  for (const bad of ['1ABC', 'A-B', 'A B', 'A.B', '', 'A=B']) assert.strictEqual(reasonOf(bad), 'invalid_name', bad);
  assert.strictEqual(reasonOf('_OK1'), 'loaded');
});

test('a value with a NUL is skipped by name', () => {
  assert.strictEqual(reasonOf('A', 'x\0y'), 'nul_in_value');
  assert.strictEqual(reasonOf('A', 'xy'), 'loaded');
});

test('a value over the per-value limit and a store over the total limit are skipped by name', () => {
  assert.strictEqual(reasonOf('A', 'x'.repeat(32 * 1024 + 1)), 'value_too_long');
  assert.strictEqual(reasonOf('A', 'x'.repeat(32 * 1024)), 'loaded');
  const many = {};
  for (let i = 0; i < 5; i += 1) many[`K${i}`] = 'x'.repeat(30 * 1024);
  const s = sel(many);
  assert.strictEqual(s.env.length, 4);
  assert.strictEqual(s.skipped[0].reason, 'total_too_large');
  const names = {};
  for (let i = 0; i < 101; i += 1) names[`N${i}`] = 'v';
  assert.strictEqual(sel(names).skipped[0].reason, 'too_many_names');
});

test('a non-string value is skipped', () => {
  assert.strictEqual(reasonOf('A', 5), 'not_a_string');
});

const RESERVED_CLASSES = {
  exact: ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'PWD', 'TMPDIR', 'HOST', 'PORT', 'PREVIEW_PORT', 'PROJECT_DIR', 'IFS', 'PS4', 'ENV', 'BASH_ENV', 'SHELLOPTS', 'BASHOPTS', 'PROMPT_COMMAND', 'BASH_XTRACEFD', 'HANDOFF_KEY'],
  bashFunc: ['BASH_FUNC_foo', 'BASH_FUNC_x'],
  ld: ['LD_PRELOAD', 'LD_LIBRARY_PATH', 'GCONV_PATH', 'GLIBC_TUNABLES', 'LOCPATH', 'NLSPATH', 'MALLOC_TRACE'],
  node: ['NODE_OPTIONS', 'NODE_PATH', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS'],
  tls: ['SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'OPENSSL_CONF', 'OPENSSL_MODULES', 'OPENSSL_ENGINES'],
  java: ['JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'MAVEN_OPTS', 'MAVEN_ARGS', 'GRADLE_OPTS', 'JAVA_OPTS'],
  perl: ['PERL5OPT', 'PERL5DB', 'PERL5LIB'],
  python: ['PYTHONPATH', 'PYTHONHOME', 'PYTHONSTARTUP', 'PYTHONWARNINGS', 'PYTHONBREAKPOINT', 'PYTHONANYTHING'],
  ruby: ['RUBYOPT', 'RUBYLIB', 'BUNDLE_GEMFILE', 'GEM_HOME', 'RUBYGEMS_GEMDEPS'],
  browser: ['BROWSER'],
  pkg: ['npm_config_registry', 'NPM_CONFIG_REGISTRY', 'Npm_Config_Foo', 'YARN_NPM_REGISTRY_SERVER', 'PNPM_HOME', 'PIP_INDEX_URL', 'UV_INDEX_URL', 'UV_PYTHON'],
  xdg: ['XDG_CONFIG_HOME', 'XDG_DATA_DIRS'],
  proxy: ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'],
  platform: ['GIT_SSH_COMMAND', 'GIT_DIR', 'CODER_AGENT_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'LIIVO_GATEWAY_URL', 'OSC_ACCESS_TOKEN'],
  tools: ['MISE_DATA_DIR', 'COREPACK_HOME', 'CC', 'CXX', 'CPP', 'CFLAGS', 'CXXFLAGS', 'CPPFLAGS', 'LDFLAGS', 'MAKEFLAGS', 'MFLAGS', 'GNUMAKEFLAGS', 'MAKEFILES', 'PS0', 'PS1', 'PS2', 'PS3', 'LESSOPEN', 'LESSCLOSE'],
  go: ['GOFLAGS', 'GOPROXY', 'GOSUMDB', 'GONOSUMDB', 'GONOSUMCHECK', 'GOINSECURE', 'GOPRIVATE', 'GONOPROXY', 'GOTOOLCHAIN', 'GOENV'],
  rust: ['CARGO_HOME', 'CARGO_REGISTRIES_X_TOKEN', 'RUSTUP_HOME', 'RUSTC', 'RUSTC_WRAPPER', 'RUSTFLAGS', 'RUSTDOCFLAGS'],
  mirrors: ['PLAYWRIGHT_DOWNLOAD_HOST', 'PUPPETEER_DOWNLOAD_BASE_URL', 'CYPRESS_INSTALL_BINARY', 'ELECTRON_MIRROR', 'ELECTRON_CUSTOM_MIRROR_X', 'SASS_BINARY_SITE', 'NODEJS_ORG_MIRROR', 'NVM_NODEJS_ORG_MIRROR'],
  dotnet: ['DOTNET_STARTUP_HOOKS', 'CORECLR_ENABLE_PROFILING', 'TERMINFO'],
};
for (const [cls, names] of Object.entries(RESERVED_CLASSES)) {
  test(`reserved class ${cls}: every name is skipped as reserved_name, in any case`, () => {
    for (const n of names) {
      assert.strictEqual(reasonOf(n), 'reserved_name', n);
      assert.strictEqual(reasonOf(n.toLowerCase()), 'reserved_name', n.toLowerCase());
    }
  });
}

test('the names the parent keeps allowed load, each with a passing case', () => {
  for (const n of ['NODE_ENV', 'NODE_NO_WARNINGS', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ', 'DEBUG', 'CI', 'UV_THREADPOOL_SIZE', 'UV_USE_IO_URING', 'DATABASE_URL', 'ELECTRON_RUN_AS_NODE']) {
    assert.strictEqual(reasonOf(n), 'loaded', n);
    assert.strictEqual(isReserved(n), false, n);
  }
});

test('the command\'s own value for a reserved name is kept', async () => {
  const ws = workspace();
  await fakeSigner(ws, [200]);
  const gw = await fakeGateway(bound({ NODE_OPTIONS: '--require /evil.js', GIT_DIR: '/evil', OKAY: 'y' }));
  const r = await runWrapper(ws, ['node', '-e', 'process.stdout.write(JSON.stringify([process.env.NODE_OPTIONS ?? null, process.env.GIT_DIR, process.env.OKAY]))'], { LIIVO_GATEWAY_URL: gw.url, GIT_DIR: '/mine' });
  assert.deepStrictEqual(JSON.parse(r.stdout), [null, '/mine', 'y']);
  const st = state(await Promise.resolve(ws));
  assert.deepStrictEqual(st.loaded, ['OKAY']);
  assert.deepStrictEqual(st.skipped.map((s) => [s.name, s.reason]).sort(), [['GIT_DIR', 'reserved_name'], ['NODE_OPTIONS', 'reserved_name']]);
});

// ---- fail soft ----

async function failSoft(name, setup, expectReason, extraEnv = {}) {
  test(`fail soft: ${name}`, async () => {
    const ws = workspace();
    const env = await setup(ws);
    const t0 = Date.now();
    const r = await runWrapper(ws, [...printVar('SOMEVAR')], { ...env, ...extraEnv, SOMEVAR: 'called-with' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(JSON.parse(r.stdout), 'called-with');
    assert.ok(Date.now() - t0 < 8000, 'bounded wait');
    assert.strictEqual(state(ws).error, expectReason);
    assert.deepStrictEqual(state(ws).loaded, []);
    if (expectReason !== 'not_bound') assert.match(r.stderr, new RegExp(`liivo-env: no values loaded \\(${expectReason}\\)`));
  });
}
const TIGHT = { LIIVO_ENV_TIMEOUT: '1', LIIVO_ENV_TENANT_WAIT: '0.3', LIIVO_ENV_SIGNER_WAIT: '0.3' };
failSoft('the gateway is unreachable', async (ws) => { await fakeSigner(ws, [200]); return { LIIVO_GATEWAY_URL: 'http://127.0.0.1:1' }; }, 'gateway_unreachable', TIGHT);
failSoft('the gateway answers a non-200 with a reason', async (ws) => { await fakeSigner(ws, [200]); return { LIIVO_GATEWAY_URL: (await fakeGateway(json(500, { reason: 'store_down' }))).url }; }, 'store_down', TIGHT);
failSoft('the gateway answers a non-200 without a body', async (ws) => { await fakeSigner(ws, [200]); return { LIIVO_GATEWAY_URL: (await fakeGateway((q, s) => { s.writeHead(502); s.end('<html>'); })).url }; }, 'gateway_502', TIGHT);
failSoft('a rate refusal names the gateway reason', async (ws) => { await fakeSigner(ws, [200]); return { LIIVO_GATEWAY_URL: (await fakeGateway(json(429, { reason: 'rate_limited' }))).url }; }, 'rate_limited', TIGHT);
failSoft('a malformed body', async (ws) => { await fakeSigner(ws, [200]); return { LIIVO_GATEWAY_URL: (await fakeGateway((q, s) => { s.writeHead(200); s.end('not json'); })).url }; }, 'malformed_response', TIGHT);
failSoft('bound: false', async (ws) => { await fakeSigner(ws, [200]); return { LIIVO_GATEWAY_URL: (await fakeGateway(json(200, { bound: false }))).url }; }, 'not_bound', TIGHT);
failSoft('no LIIVO_GATEWAY_URL', async (ws) => { await fakeSigner(ws, [200]); return {}; }, 'no_gateway_url', TIGHT);
failSoft('no signer', async () => ({ LIIVO_GATEWAY_URL: 'http://127.0.0.1:1' }), 'no_signer', TIGHT);
failSoft('the signer refuses (not a 409)', async (ws) => { await fakeSigner(ws, [503]); return { LIIVO_GATEWAY_URL: 'http://127.0.0.1:1' }; }, 'signer_503', TIGHT);
failSoft('the gateway never answers: the command still starts within the bound', async (ws) => { await fakeSigner(ws, [200]); return { LIIVO_GATEWAY_URL: (await fakeGateway(() => {})).url }; }, 'gateway_timeout', TIGHT);

// ---- tenant not known yet ----

test('values load when the signer answers 409 twice and then signs', async () => {
  const ws = workspace();
  const calls = await fakeSigner(ws, [409, 409, 200]);
  const gw = await fakeGateway(bound({ LATE: 'loaded' }));
  const r = await runWrapper(ws, [...printVar('LATE')], { LIIVO_GATEWAY_URL: gw.url });
  assert.strictEqual(JSON.parse(r.stdout), 'loaded');
  assert.strictEqual(calls.length, 3);
  assert.deepStrictEqual(calls, ['POST /env-token', 'POST /env-token', 'POST /env-token']);
});

test('the wait for the tenant is bounded and ends with tenant_unknown', async () => {
  const ws = workspace();
  await fakeSigner(ws, [409]);
  const r = await runWrapper(ws, [...printVar('SOMEVAR')], { LIIVO_GATEWAY_URL: 'http://127.0.0.1:1', LIIVO_ENV_TENANT_WAIT: '0.4', SOMEVAR: 'x' });
  assert.strictEqual(JSON.parse(r.stdout), 'x');
  assert.strictEqual(state(ws).error, 'tenant_unknown');
});

// ---- status file and output ----

test('the status file is private, holds names and reasons and never a value', async () => {
  const ws = workspace();
  await fakeSigner(ws, [200]);
  const secret = 'super-secret-value-123';
  const gw = await fakeGateway(bound({ API_KEY: secret, PATH: secret + 'x', BAD: 'a\0b' }, { skipped: [{ name: 'GW', reason: 'too_long' }] }));
  await runWrapper(ws, ['true'], { LIIVO_GATEWAY_URL: gw.url });
  const text = fs.readFileSync(ws.state, 'utf8');
  assert.ok(!text.includes(secret));
  assert.strictEqual(fs.statSync(ws.state).mode & 0o777, 0o600);
  const st = JSON.parse(text);
  assert.deepStrictEqual(Object.keys(st).sort(), ['error', 'loaded', 'skipped', 'store', 'time']);
  assert.strictEqual(st.store, 'proj-store');
  assert.deepStrictEqual(st.loaded, ['API_KEY']);
  assert.deepStrictEqual(st.skipped.map((s) => s.name).sort(), ['BAD', 'GW', 'PATH']);
  assert.strictEqual(fs.readdirSync(ws.dir).filter((f) => f.endsWith('.tmp')).length, 0);
});

test('the only output is one line with the store name and the counts, on stderr, and no value', async () => {
  const ws = workspace();
  await fakeSigner(ws, [200]);
  const gw = await fakeGateway(bound({ A: 'secret-aaa-111', B: 'secret-bbb-222' }));
  const r = await runWrapper(ws, ['true'], { LIIVO_GATEWAY_URL: gw.url });
  assert.strictEqual(r.stdout, '');
  assert.strictEqual(r.stderr, 'liivo-env: store proj-store: 2 loaded, 0 skipped\n');
});

test('a project without a store prints nothing at all', async () => {
  const ws = workspace();
  await fakeSigner(ws, [200]);
  const gw = await fakeGateway(json(200, { bound: false }));
  const r = await runWrapper(ws, ['true'], { LIIVO_GATEWAY_URL: gw.url });
  assert.strictEqual(r.stdout + r.stderr, '');
});

test('nothing is written into the project directory', async () => {
  const ws = workspace();
  await fakeSigner(ws, [200]);
  const project = path.join(ws.dir, 'project');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'a.txt'), 'a');
  const gw = await fakeGateway(bound({ A: 'v' }));
  await runWrapper(ws, ['true'], { LIIVO_GATEWAY_URL: gw.url }, { cwd: project });
  assert.deepStrictEqual(fs.readdirSync(project), ['a.txt']);
});

test('no command is a usage error', async () => {
  const ws = workspace();
  const r = await runWrapper(ws, []);
  assert.strictEqual(r.status, 2);
});

// ---- the entrypoint ----

function entrypoint(files, { signerAnswers, gatewayValues, extraEnv = {} }) {
  return (async () => {
    const ws = workspace();
    const bin = path.join(ws.dir, 'bin');
    fs.mkdirSync(bin);
    fs.symlinkSync(WRAPPER, path.join(bin, 'liivo-env'));
    const out = path.join(ws.dir, 'hook-env.json');
    fs.writeFileSync(path.join(bin, 'coder'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
    const project = path.join(ws.dir, 'project');
    fs.mkdirSync(path.join(project, '.liivo'), { recursive: true });
    for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(project, '.liivo', n), c);
    await fakeSigner(ws, signerAnswers);
    const gw = await fakeGateway(bound(gatewayValues));
    const before = fs.readdirSync(project).sort();
    const res = await new Promise((resolve) => {
      const child = spawn('bash', [ENTRYPOINT], {
        env: {
          PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
          HOME: ws.home,
          CODER_AGENT_URL: 'https://coder.example.test',
          CODER_AGENT_TOKEN: 'agent-token-value',
          PROJECT_DIR: project,
          PORT: '8080',
          LIIVO_GATEWAY_URL: gw.url,
          LIIVO_ENV_STATE_FILE: ws.state,
          LIIVO_ENV_POLL: '0.05',
          HOOK_OUT: out,
          ...extraEnv,
        },
        stdio: 'ignore',
      });
      child.on('close', resolve);
    });
    // the hooks run in the background: wait for the output they write
    for (let i = 0; i < 200 && !fs.existsSync(out); i += 1) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 200));
    return { ws, project, out, before, res, setupDone: fs.existsSync(path.join(ws.home, '.liivo', 'setup.done')) };
  })();
}
const dump = 'node -e \'require("fs").appendFileSync(process.env.HOOK_OUT, JSON.stringify({ v: process.env.LOADED_VAR ?? null, t: process.env.CODER_AGENT_TOKEN ?? null }) + "\\n")\'\n';

test('the entrypoint runs start.sh through liivo-env: the hook sees a loaded variable and not CODER_AGENT_TOKEN, and the project tree is unchanged', async () => {
  const r = await entrypoint({ 'start.sh': dump }, { signerAnswers: [200], gatewayValues: { LOADED_VAR: 'from-store' } });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(r.out, 'utf8').trim().split('\n')[0]), { v: 'from-store', t: null });
  assert.deepStrictEqual(fs.readdirSync(path.join(r.project)).sort(), r.before);
  assert.deepStrictEqual(fs.readdirSync(path.join(r.project, '.liivo')).sort(), ['start.sh']);
});

test('the entrypoint runs setup.sh through liivo-env and writes the setup marker after a normal load', async () => {
  const r = await entrypoint({ 'setup.sh': dump }, { signerAnswers: [200], gatewayValues: { LOADED_VAR: 'for-setup' } });
  assert.strictEqual(JSON.parse(fs.readFileSync(r.out, 'utf8').trim().split('\n')[0]).v, 'for-setup');
  assert.strictEqual(r.setupDone, true);
});

test('the setup marker is not written after a tenant_unknown load, so setup.sh runs again with values', async () => {
  const r = await entrypoint({ 'setup.sh': dump }, { signerAnswers: [409], gatewayValues: { LOADED_VAR: 'x' }, extraEnv: { LIIVO_ENV_TENANT_WAIT: '0.3' } });
  assert.strictEqual(JSON.parse(fs.readFileSync(r.out, 'utf8').trim().split('\n')[0]).v, null);
  assert.strictEqual(JSON.parse(fs.readFileSync(r.ws.state, 'utf8')).error, 'tenant_unknown');
  assert.strictEqual(r.setupDone, false);
});

test('the pid file written for start.sh holds the pid of the process start.sh runs as', async () => {
  const script = 'printf "%s" "$$" > "$PIDOUT"\nnode -e \'require("fs").appendFileSync(process.env.HOOK_OUT, "x\\n")\'\n';
  const pidOut = path.join(os.tmpdir(), `lenv-pid-${process.pid}`);
  const r = await entrypoint({ 'start.sh': script }, { signerAnswers: [200], gatewayValues: { A: '1' }, extraEnv: { PIDOUT: pidOut } });
  const pidFile = `/tmp/liivo-start-project.pid`;
  assert.ok(fs.existsSync(r.out));
  assert.strictEqual(fs.readFileSync(pidFile, 'utf8'), fs.readFileSync(pidOut, 'utf8'));
  fs.rmSync(pidOut, { force: true });
  fs.rmSync(pidFile, { force: true });
});

test('Dockerfile.osc installs liivo-env on PATH and its helper next to the forwarder', () => {
  const d = fs.readFileSync(path.join(ROOT, 'Dockerfile.osc'), 'utf8');
  assert.match(d, /COPY --chmod=755 liivo-env \/usr\/local\/bin\/liivo-env/);
  assert.match(d, /forwarder\/liivo-env\.js[^\n]*\/usr\/local\/lib\/liivo\//);
  assert.strictEqual(spawnSync('bash', ['-n', WRAPPER]).status, 0);
});
