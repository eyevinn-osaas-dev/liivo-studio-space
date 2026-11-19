'use strict';
// Tests of the default start (issue #18): the real osc-entrypoint.sh and the real default-start.js run against a
// stub `git` that lays down a fixture repository, stub package managers (npm, pnpm, yarn) that record argv and
// environment and start a stub dev server, and stub `coder` and `node` programs for everything else.
const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync, execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const ENTRYPOINT = path.join(ROOT, 'osc-entrypoint.sh');
const DEFAULT_START = path.join(ROOT, 'default-start.js');
const REAL_GIT = execFileSync('sh', ['-c', 'command -v git']).toString().trim();
const REAL_NODE = process.execPath;
const HAS_SETSID = spawnSync('sh', ['-c', 'command -v setsid']).status === 0;
const cleanups = [];
afterEach(() => {
  while (cleanups.length) {
    try {
      cleanups.pop()();
    } catch {
      // best effort
    }
  }
});

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 20000) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const NEXT_PKG = JSON.stringify({
  name: 'web-hello-world',
  scripts: { dev: 'next dev --turbopack', build: 'next build', start: 'next start' },
});
const NEXT_FILES = {
  'package.json': NEXT_PKG,
  'package-lock.json': '{"lockfileVersion":3}\n',
  '.gitignore': '/node_modules\n/.next/\nnext-env.d.ts\n',
  'README.md': 'hello\n',
};
const pkgWith = (scripts) => JSON.stringify({ name: 'x', scripts });

const SERVER_JS = `const net = require('node:net');
require('node:fs').writeFileSync(process.env.OUT_DIR + '/server-pid', String(process.pid));
net.createServer((s) => s.on('error', () => {}).end('HTTP/1.1 200 OK\\r\\nContent-Length: 11\\r\\nConnection: close\\r\\n\\r\\nstub-server')).listen(Number(process.env.PORT), '127.0.0.1');
`;

// One stub for npm, pnpm and yarn. Modes come from files in $OUT: install-mode, build-mode, dev-mode.
const PM_STUB = (out) => `#!/bin/bash
OUT="${out}"; T="$(basename "$0")"
N=$(( $(cat "$OUT/n" 2>/dev/null || echo 0) + 1 )); echo "$N" > "$OUT/n"
echo "$T $*" >> "$OUT/calls"
env | sort > "$OUT/env-$N"
if [ "$1" = --version ]; then cat "$OUT/yarn-version" 2>/dev/null || echo 1.22.0; exit 0; fi
mode() { cat "$OUT/$1-mode" 2>/dev/null || echo ok; }
STATE="/tmp/liivo-start-$(basename "$PWD").state"
case "$1" in
  ci|install)
    cp "$STATE" "$OUT/state-at-install" 2>/dev/null
    cat "/tmp/liivo-start-$(basename "$PWD").pid" > "$OUT/pid-at-install" 2>/dev/null
    ps -o pgid= -p $$ | tr -d ' ' > "$OUT/pgid-at-install"
    echo $$ > "$OUT/install-pid"
    echo "stub install output"
    case "$(mode install)" in
      ok) mkdir -p node_modules/.bin; echo x > node_modules/dep.txt; exit 0 ;;
      fail) echo "install boom"; exit 1 ;;
      hang) trap 'exit 143' TERM; /bin/sleep 60 & wait $! ;;
      hangignore) trap '' TERM; while :; do /bin/sleep 0.2; done ;;
    esac ;;
  run)
    case "$2" in
      build) [ "$(mode build)" = ok ] && { echo "stub build output"; exit 0; }; echo "build boom"; exit 1 ;;
      *)
        cp "$STATE" "$OUT/state-at-dev" 2>/dev/null
        case "$(mode dev)" in
          ok) OUT_DIR="$OUT" exec "${REAL_NODE}" "$OUT/server.js" ;;
          nolisten) trap 'exit 143' TERM; /bin/sleep 60 & wait $! ;;
          exit3) echo "dev boom"; exit 3 ;;
        esac ;;
    esac ;;
esac
`;

function setup({ files = NEXT_FILES, own = null } = {}) {
  const dir = fs.mkdtempSync(path.join('/tmp', 'lsds-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'out');
  const bin = path.join(dir, 'bin');
  const lib = path.join(dir, 'lib');
  const home = path.join(dir, 'home');
  const fixture = path.join(out, 'fixture');
  const project = path.join(dir, `proj-${crypto.randomBytes(4).toString('hex')}`);
  for (const d of [out, bin, lib, home, fixture]) fs.mkdirSync(d);
  for (const [n, c] of Object.entries({ ...files, ...(own || {}) })) {
    fs.mkdirSync(path.dirname(path.join(fixture, n)), { recursive: true });
    fs.writeFileSync(path.join(fixture, n), c);
  }
  for (const f of ['preview-forwarder.js', 'bridge-fetch.js']) fs.writeFileSync(path.join(lib, f), '');
  fs.copyFileSync(DEFAULT_START, path.join(lib, 'default-start.js'));
  fs.chmodSync(path.join(lib, 'default-start.js'), 0o755);
  fs.writeFileSync(path.join(out, 'server.js'), SERVER_JS);
  fs.writeFileSync(path.join(bin, 'coder'), `#!/bin/bash\nenv > "${out}/agent-env"\n`, { mode: 0o755 });
  fs.writeFileSync(
    path.join(bin, 'node'),
    `#!/bin/bash
case "$1" in
  *default-start.js) exec "${REAL_NODE}" "$@" ;;
  *preview-forwarder.js) cat > /dev/null; exit 2 ;;
  *bridge-fetch.js) echo vtest; exit 0 ;;
  *server.mjs) env > "${out}/bridge-env"; exec /bin/sleep 60 ;;
esac
`,
    { mode: 0o755 }
  );
  fs.writeFileSync(
    path.join(bin, 'git'),
    `#!/bin/bash
if [ "$1" != clone ]; then exec "${REAL_GIT}" "$@"; fi
shift; [ "$1" = -- ] && shift
target="$2"
mkdir -p "$target"; cp -R "${fixture}/." "$target/"
"${REAL_GIT}" init -q "$target"
"${REAL_GIT}" -C "$target" add -A
"${REAL_GIT}" -C "$target" -c user.name=t -c user.email=t@t commit -q -m fixture
`,
    { mode: 0o755 }
  );
  for (const t of ['npm', 'pnpm', 'yarn']) fs.writeFileSync(path.join(bin, t), PM_STUB(out), { mode: 0o755 });
  const w = {
    dir, out, bin, lib, home, project,
    pidFile: `/tmp/liivo-start-${path.basename(project)}.pid`,
    stateFile: `/tmp/liivo-start-${path.basename(project)}.state`,
    logFile: `/tmp/liivo-start-${path.basename(project)}.log`,
    calls: () => read(path.join(out, 'calls')).split('\n').filter(Boolean),
    state: () => {
      try {
        return JSON.parse(read(w.stateFile));
      } catch {
        return null;
      }
    },
    mode: (k, v) => fs.writeFileSync(path.join(out, `${k}-mode`), v),
  };
  cleanups.push(() => {
    stopGroup(w);
    for (const f of [w.pidFile, w.stateFile, w.logFile]) fs.rmSync(f, { force: true });
  });
  return w;
}

function stopGroup(w) {
  const pid = Number(read(w.pidFile));
  if (pid > 1) {
    for (const sig of ['SIGTERM', 'SIGKILL']) {
      try {
        process.kill(-pid, sig);
      } catch {
        // gone
      }
      try {
        process.kill(pid, sig);
      } catch {
        // gone
      }
    }
  }
  const sp = Number(read(path.join(w.out, 'server-pid')));
  if (sp > 1) {
    try {
      process.kill(sp, 'SIGKILL');
    } catch {
      // gone
    }
  }
}

async function run(w, extraEnv = {}) {
  const port = extraEnv.PREVIEW_PORT ? Number(extraEnv.PREVIEW_PORT) : await freePort();
  w.port = port;
  const logFd = fs.openSync(path.join(w.dir, 'entrypoint.log'), 'a');
  const child = spawn('bash', [ENTRYPOINT], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      PATH: `${w.bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: w.home,
      GIT_CONFIG_NOSYSTEM: '1',
      CODER_AGENT_URL: 'https://coder.example.test',
      CODER_AGENT_TOKEN: 'agent-token-marker',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-marker',
      ANTHROPIC_API_KEY: 'apikey-marker',
      HANDOFF_KEY: 'handoff-marker',
      PORT: '8080',
      PREVIEW_PORT: String(port),
      PROJECT_DIR: w.project,
      LIIVO_LIB_DIR: w.lib,
      REPO_URL: 'https://github.com/o/r.git',
      LIIVO_GIT_AUTHOR_NAME: 'Liivo Studio',
      LIIVO_GIT_AUTHOR_EMAIL: 'noreply@liivo.ai',
      LIIVO_DEFAULT_INSTALL_TIMEOUT: '30',
      LIIVO_DEFAULT_START_TIMEOUT: '30',
      LIIVO_DEFAULT_KILL_GRACE: '0.3',
      ...extraEnv,
    },
  });
  cleanups.push(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // gone
    }
    fs.closeSync(logFd);
  });
  const status = await new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return { status, log: () => read(path.join(w.dir, 'entrypoint.log')) };
}

const finalState = (w, wanted) =>
  until(() => w.state() && wanted.includes(w.state().state) && w.state(), `state ${wanted}`).catch((err) => {
    err.message += `\nstate: ${read(w.stateFile)}\nlog: ${read(w.logFile)}\nentrypoint: ${read(path.join(w.dir, 'entrypoint.log'))}`;
    throw err;
  });
const envOf = (file) => Object.fromEntries(read(file).split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const porcelain = (w) => execFileSync(REAL_GIT, ['-C', w.project, 'status', '--porcelain']).toString();
const lastDev = (w) => w.calls().filter((c) => / run (?!build)/.test(c)).pop();

// ---------------------------------------------------------------- AC1

for (const executable of [true, false]) {
  test(`AC1 an own .liivo/start.sh (${executable ? 'executable' : 'not executable'}) runs as before and the default start does nothing`, async () => {
    const w = setup({ own: { '.liivo/start.sh': 'echo own-start-ran > "$HOME/own-ran"\nexec /bin/sleep 60\n' } });
    const r = await run(w);
    assert.strictEqual(r.status, 0, r.log());
    if (executable) fs.chmodSync(path.join(w.project, '.liivo', 'start.sh'), 0o755);
    await until(() => read(path.join(w.home, 'own-ran')), 'the own start.sh');
    await until(() => read(w.pidFile), 'the pid file');
    await sleep(300);
    assert.deepStrictEqual(w.calls(), [], 'no package manager was called');
    assert.ok(!fs.existsSync(w.stateFile), 'no state file');
    assert.ok(!fs.existsSync(w.logFile), 'no default-start log');
    assert.match(read(path.join(w.home, 'liivo-run.log')), /running \.liivo\/start\.sh/);
    assert.ok(!/default start/.test(read(path.join(w.home, 'liivo-run.log'))));
  });
}

// ---------------------------------------------------------------- AC2, AC6, AC8, AC10, AC11, AC12

test('AC2 passing path shaped like birme/web-hello-world: npm ci once, next dev with the flags appended once, running, group of the leader holds the dev server', async () => {
  const w = setup();
  const r = await run(w);
  assert.strictEqual(r.status, 0, r.log());
  await finalState(w, ['running']);
  assert.deepStrictEqual(w.calls(), ['npm ci', `npm run dev -- -H 127.0.0.1 -p ${w.port}`]);
  assert.strictEqual(read(path.join(w.project, 'package.json')), NEXT_PKG, 'package.json is untouched (--turbopack stays in the script)');
  const answer = await new Promise((resolve, reject) => {
    const s = net.connect(w.port, '127.0.0.1');
    let d = '';
    s.on('data', (c) => (d += c));
    s.on('end', () => resolve(d));
    s.on('error', reject);
  });
  assert.match(answer, /stub-server$/);
  // AC8: the states in order.
  assert.strictEqual(JSON.parse(read(path.join(w.out, 'state-at-install'))).state, 'installing');
  assert.strictEqual(JSON.parse(read(path.join(w.out, 'state-at-dev'))).state, 'starting');
  assert.strictEqual(porcelain(w), '', 'AC6 the tree is clean after install and start');
  if (HAS_SETSID) {
    const leader = Number(read(w.pidFile));
    const serverPid = Number(read(path.join(w.out, 'server-pid')));
    assert.strictEqual(Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(serverPid)]).toString().trim()), leader);
    process.kill(-leader, 'SIGTERM');
    await until(() => !alive(serverPid), 'SIGTERM to the group to stop the dev server');
    assert.strictEqual(w.state().state, 'running', 'a stopped start writes no state of its own');
  }
});

test('AC10 AC11 the log holds the headers and the output and no credential; install and dev run with the project environment only', async () => {
  const w = setup();
  const r = await run(w);
  await finalState(w, ['running']);
  const log = read(w.logFile);
  assert.match(log, /=== \d{4}-\d\d-\d\dT[\d:]+Z default start: install: npm ci/);
  assert.match(log, /=== .* default start: dev: npm run dev/);
  assert.match(log, /stub install output/);
  assert.match(read(path.join(w.home, 'liivo-run.log')), new RegExp(`output in ${w.logFile}`));
  for (const marker of ['oauth-marker', 'apikey-marker', 'agent-token-marker', 'handoff-marker']) {
    assert.ok(!log.includes(marker), `${marker} not in the default-start log`);
    assert.ok(!read(path.join(w.home, 'liivo-run.log')).includes(marker));
    assert.ok(!r.log().includes(marker));
  }
  for (const f of ['env-1', 'env-2']) {
    const env = envOf(path.join(w.out, f));
    assert.strictEqual(env.HOST, '127.0.0.1');
    assert.strictEqual(env.PORT, String(w.port));
    assert.strictEqual(env.LIIVO_PREVIEW_PORT, String(w.port));
    for (const k of Object.keys(env)) assert.ok(!/^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|HANDOFF_KEY|CODER_AGENT_.*)$/.test(k), `${k} leaked into the project env`);
  }
});

test('AC13 the bridge environment carries LIIVO_DEFAULT_START, the installed file, and the file is executable in the lib dir', async () => {
  const w = setup();
  await run(w);
  const env = envOf(await until(() => (fs.existsSync(path.join(w.out, 'bridge-env')) ? path.join(w.out, 'bridge-env') : ''), 'the bridge'));
  assert.strictEqual(env.LIIVO_DEFAULT_START, path.join(w.lib, 'default-start.js'));
  assert.ok(fs.statSync(DEFAULT_START).mode & 0o100, 'default-start.js is executable in the repository');
  assert.match(read(path.join(ROOT, 'Dockerfile.osc')), /COPY --chmod=755 default-start\.js \/usr\/local\/lib\/liivo\//);
});

test('AC12 the pid file is written before the install; SIGTERM to the group stops the install and writes no state; a bridge-style second start works the same', async () => {
  if (!HAS_SETSID) return;
  const w = setup();
  w.mode('install', 'hang');
  await run(w);
  await until(() => read(path.join(w.out, 'install-pid')), 'the install to start');
  const leader = Number(read(w.pidFile));
  assert.ok(leader > 1);
  assert.strictEqual(read(path.join(w.out, 'pid-at-install')), String(leader), 'the pid file was there when the install started');
  assert.strictEqual(read(path.join(w.out, 'pgid-at-install')).trim(), String(leader), 'the install is in the leader\'s group');
  process.kill(-leader, 'SIGTERM');
  await until(() => !alive(Number(read(path.join(w.out, 'install-pid')))), 'the install to stop');
  await sleep(200);
  assert.strictEqual(w.state().state, 'installing', 'the stopped start wrote nothing (not failed)');
  assert.ok(!fs.existsSync(path.join(w.home, '.liivo', `default-start-${path.basename(w.project)}.install`)), 'nothing recorded');

  // The way the bridge's startRepo starts it: detached, a projectEnv-shaped environment with LIIVO_PORT, appending to the same log.
  w.mode('install', 'ok');
  const logFd = fs.openSync(w.logFile, 'a');
  const child = spawn(path.join(w.lib, 'default-start.js'), [], {
    cwd: w.project,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { PATH: `${w.bin}:/usr/bin:/bin`, HOME: w.home, HOST: '127.0.0.1', LIIVO_PORT: '4999', LIIVO_PREVIEW_PORT: String(w.port), PROJECT_DIR: w.project },
  });
  fs.writeFileSync(w.pidFile, String(child.pid));
  cleanups.push(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // gone
    }
  });
  await finalState(w, ['running']);
  assert.ok(read(w.logFile).includes('default start: install'));
});

// ---------------------------------------------------------------- AC3

test('AC3 dev is chosen over start, and dev never builds', async () => {
  const w = setup();
  await run(w);
  await finalState(w, ['running']);
  assert.ok(!w.calls().some((c) => /run build/.test(c)));
  assert.match(lastDev(w), /run dev/);
});

test('AC3 only start: build runs first, then start', async () => {
  const w = setup({ files: { ...NEXT_FILES, 'package.json': pkgWith({ build: 'next build', start: 'next start' }) } });
  await run(w);
  await finalState(w, ['running']);
  assert.deepStrictEqual(w.calls().slice(0, 3), ['npm ci', 'npm run build', `npm run start -- -H 127.0.0.1 -p ${w.port}`]);
});

test('AC3 a failing build ends failed and start is not run', async () => {
  const w = setup({ files: { ...NEXT_FILES, 'package.json': pkgWith({ build: 'next build', start: 'next start' }) } });
  w.mode('build', 'fail');
  await run(w);
  const s = await finalState(w, ['failed']);
  assert.strictEqual(s.reason, 'build failed (exit 1)');
  assert.ok(!w.calls().some((c) => /run start/.test(c)));
  assert.match(read(w.logFile), /build boom/);
});

for (const [name, files, reason] of [
  ['no scripts', { ...NEXT_FILES, 'package.json': pkgWith({ test: 'jest' }) }, /no dev or start script/],
  ['no package.json', { 'README.md': 'x' }, /no package\.json/],
  ['invalid JSON', { ...NEXT_FILES, 'package.json': '{ nope' }, /not valid JSON/],
]) {
  test(`AC3 ${name}: nothing starts and the state is none with a reason`, async () => {
    const w = setup({ files });
    await run(w);
    const s = await finalState(w, ['none']);
    assert.match(s.reason, reason);
    assert.deepStrictEqual(w.calls(), []);
  });
}

// ---------------------------------------------------------------- AC4

const SCRIPTS = pkgWith({ dev: 'node server.js' });
for (const [name, lock, expected] of [
  ['pnpm', { 'pnpm-lock.yaml': 'x' }, ['pnpm install --frozen-lockfile']],
  ['yarn classic', { 'yarn.lock': 'x' }, ['yarn --version', 'yarn install --frozen-lockfile']],
  ['npm shrinkwrap', { 'npm-shrinkwrap.json': '{}' }, ['npm ci']],
  ['no lockfile', {}, ['npm install --no-package-lock']],
]) {
  test(`AC4 ${name}: the matching frozen or lockfile-free install`, async () => {
    const w = setup({ files: { 'package.json': SCRIPTS, '.gitignore': 'node_modules\n', ...lock } });
    await run(w);
    await finalState(w, ['running']);
    assert.deepStrictEqual(w.calls().slice(0, expected.length), expected);
    assert.ok(!fs.existsSync(path.join(w.project, 'package-lock.json')), 'no lockfile was written');
    assert.strictEqual(porcelain(w), '');
  });
}

test('AC4 yarn berry uses --immutable', async () => {
  const w = setup({ files: { 'package.json': SCRIPTS, 'yarn.lock': 'x', '.gitignore': 'node_modules\n' } });
  fs.writeFileSync(path.join(w.out, 'yarn-version'), '4.5.0\n');
  await run(w);
  await finalState(w, ['running']);
  assert.ok(w.calls().includes('yarn install --immutable'));
});

test('AC4 pnpm passes the flags without a -- separator, npm with one', async () => {
  const w = setup({ files: { 'package.json': pkgWith({ dev: 'next dev' }), 'pnpm-lock.yaml': 'x', '.gitignore': 'node_modules\n' } });
  await run(w);
  await finalState(w, ['running']);
  assert.strictEqual(lastDev(w), `pnpm run dev -H 127.0.0.1 -p ${w.port}`);
});

test('AC4 two lockfiles: the first in the documented order wins and the other is logged', async () => {
  const w = setup({ files: { 'package.json': SCRIPTS, 'package-lock.json': '{}', 'pnpm-lock.yaml': 'x', '.gitignore': 'node_modules\n' } });
  await run(w);
  await finalState(w, ['running']);
  assert.strictEqual(w.calls()[0], 'pnpm install --frozen-lockfile');
  assert.match(read(w.logFile), /using pnpm-lock\.yaml, ignoring package-lock\.json/);
});

test('AC4 only a bun lockfile: failed naming it, no package manager called', async () => {
  const w = setup({ files: { 'package.json': SCRIPTS, 'bun.lockb': 'x' } });
  await run(w);
  const s = await finalState(w, ['failed']);
  assert.match(s.reason, /bun\.lockb is a bun lockfile.*add \.liivo\/start\.sh/);
  assert.deepStrictEqual(w.calls(), []);
});

test('AC4 a frozen install that fails is a failure, never retried with a lockfile-writing install', async () => {
  const w = setup();
  w.mode('install', 'fail');
  await run(w);
  const s = await finalState(w, ['failed']);
  assert.strictEqual(s.reason, 'install failed (exit 1)');
  assert.deepStrictEqual(w.calls(), ['npm ci']);
  assert.match(read(w.logFile), /install boom/);
});

// ---------------------------------------------------------------- AC5

async function restart(w, extra = {}) {
  stopGroup(w);
  await sleep(300);
  fs.rmSync(path.join(w.out, 'server-pid'), { force: true });
  fs.rmSync(w.stateFile, { force: true });
  const r = await run(w, { PREVIEW_PORT: String(w.port), ...extra });
  return r;
}
const installs = (w) => w.calls().filter((c) => /^(npm ci|npm install|pnpm install|yarn install)/.test(c)).length;

test('AC5 install once; again when the lockfile changed; again when node_modules is gone', async () => {
  const w = setup();
  await run(w);
  await finalState(w, ['running']);
  assert.strictEqual(installs(w), 1);
  await restart(w);
  await finalState(w, ['running']);
  assert.strictEqual(installs(w), 1, 'same lockfile and node_modules present: no install');
  assert.match(lastDev(w), /run dev/);
  fs.appendFileSync(path.join(w.project, 'package-lock.json'), ' ');
  await restart(w);
  await finalState(w, ['running']);
  assert.strictEqual(installs(w), 2, 'changed lockfile bytes install again');
  fs.rmSync(path.join(w.project, 'node_modules'), { recursive: true, force: true });
  await restart(w);
  await finalState(w, ['running']);
  assert.strictEqual(installs(w), 3, 'removed node_modules installs again');
});

test('AC5 a failed install and a timed-out install record nothing, and the next start installs', async () => {
  const w = setup();
  w.mode('install', 'fail');
  await run(w);
  await finalState(w, ['failed']);
  const record = path.join(w.home, '.liivo', `default-start-${path.basename(w.project)}.install`);
  assert.ok(!fs.existsSync(record), 'a failed install records nothing');
  w.mode('install', 'hang');
  await restart(w, { LIIVO_DEFAULT_INSTALL_TIMEOUT: '1' });
  await finalState(w, ['failed']);
  assert.ok(!fs.existsSync(record), 'a timed-out install records nothing');
  w.mode('install', 'ok');
  await restart(w);
  await finalState(w, ['running']);
  assert.strictEqual(installs(w), 3);
  assert.ok(fs.existsSync(record));
});

// ---------------------------------------------------------------- AC6

test('AC6 node_modules not ignored by git: listed in .git/info/exclude and the tree stays clean', async () => {
  const w = setup({ files: { ...NEXT_FILES, '.gitignore': '/.next/\n' } });
  await run(w);
  await finalState(w, ['running']);
  assert.match(read(path.join(w.project, '.git', 'info', 'exclude')), /^\/node_modules\/$/m);
  assert.ok(fs.existsSync(path.join(w.project, 'node_modules')));
  assert.strictEqual(porcelain(w), '');
});

test('AC6 node_modules already ignored: the exclude file is not touched', async () => {
  const w = setup();
  await run(w);
  await finalState(w, ['running']);
  assert.ok(!/node_modules/.test(read(path.join(w.project, '.git', 'info', 'exclude'))));
});

// ---------------------------------------------------------------- AC7

for (const [script, expectedFlags] of [
  ['next dev', '-H 127.0.0.1 -p PORT'],
  ['next start', '-H 127.0.0.1 -p PORT'],
  ['vite', '--host 127.0.0.1 --port PORT --strictPort'],
  ['vite dev', '--host 127.0.0.1 --port PORT --strictPort'],
  ['vite serve', '--host 127.0.0.1 --port PORT --strictPort'],
  ['vite preview', '--host 127.0.0.1 --port PORT --strictPort'],
  ['node server.js', null],
  ['next dev && echo done', null],
  ['next dev -p 4000', null],
  ['vite --host 0.0.0.0', null],
]) {
  test(`AC7 script "${script}": ${expectedFlags ? 'flags appended once' : 'environment only'}`, async () => {
    const name = script.startsWith('next start') ? 'start' : 'dev';
    const w = setup({
      files: { ...NEXT_FILES, 'package.json': pkgWith({ [name]: script }), '.liivo/workspace.json': '{"port":4000}' },
    });
    await run(w);
    await finalState(w, ['running']);
    const expected = expectedFlags ? `npm run ${name} -- ${expectedFlags.replace('PORT', w.port)}` : `npm run ${name}`;
    assert.strictEqual(lastDev(w), expected);
    const env = envOf(path.join(w.out, `env-${w.calls().length}`));
    assert.strictEqual(env.PORT, String(w.port), 'LIIVO_PREVIEW_PORT, not the workspace.json port');
    assert.strictEqual(env.HOST, '127.0.0.1');
    if (!expectedFlags && /&&|-p 4000|--host/.test(script)) assert.match(read(w.logFile), new RegExp(`the preview expects port ${w.port} on 127\\.0\\.0\\.1`));
  });
}

// ---------------------------------------------------------------- AC9

test('AC9 an install that never ends is stopped after the limit', async () => {
  const w = setup();
  w.mode('install', 'hang');
  await run(w, { LIIVO_DEFAULT_INSTALL_TIMEOUT: '1' });
  const s = await finalState(w, ['failed']);
  assert.strictEqual(s.reason, 'install timed out after 1s');
  await until(() => !alive(Number(read(path.join(w.out, 'install-pid')))), 'the install to be gone');
});

test('AC9 an install that ignores SIGTERM is killed after the grace', async () => {
  const w = setup();
  w.mode('install', 'hangignore');
  await run(w, { LIIVO_DEFAULT_INSTALL_TIMEOUT: '1' });
  const s = await finalState(w, ['failed']);
  assert.strictEqual(s.reason, 'install timed out after 1s');
  await until(() => !alive(Number(read(path.join(w.out, 'install-pid')))), 'the stubborn install to be killed');
});

test('AC9 a dev server that never listens is stopped after the start limit and the state names the port', async () => {
  const w = setup();
  w.mode('dev', 'nolisten');
  await run(w, { LIIVO_DEFAULT_START_TIMEOUT: '1' });
  const s = await finalState(w, ['failed']);
  assert.strictEqual(s.reason, `not listening on 127.0.0.1:${w.port} after 1s`);
});

test('AC9 a dev server that exits gives failed with its exit code', async () => {
  const w = setup();
  w.mode('dev', 'exit3');
  await run(w);
  const s = await finalState(w, ['failed']);
  assert.strictEqual(s.reason, 'dev server exited (exit 3)');
  assert.match(read(w.logFile), /dev boom/);
});
