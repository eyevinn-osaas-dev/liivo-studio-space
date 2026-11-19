'use strict';
// Shell tests of osc-entrypoint.sh for amendment 6: the git author, the bridge supervisor and the start.sh
// pid file. The real script runs against stub `coder`, `node` and `sleep` programs; the stub `node` stands in
// for the forwarder, the fetcher and the bridge and records what each was started with.
const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync, execFileSync } = require('node:child_process');

const ENTRYPOINT = path.join(__dirname, '..', 'osc-entrypoint.sh');
const KEY = crypto.randomBytes(32).toString('base64');
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
async function until(fn, what, ms = 15000) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

// fetchRcs: the exit codes of successive fetcher runs (the last repeats); bridgeRuns: 'stay' keeps the bridge up, 'exit' ends it at once.
function setup({ fetchRcs = [0], bridge = 'stay', agentScript = '', libFiles = true, files = {} } = {}) {
  const dir = fs.mkdtempSync(path.join('/tmp', 'lsbe-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'out');
  const bin = path.join(dir, 'bin');
  const lib = path.join(dir, 'lib');
  const home = path.join(dir, 'home');
  const project = path.join(dir, `proj-${crypto.randomBytes(4).toString('hex')}`);
  for (const d of [out, bin, lib, home]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(out, 'fetch-rcs'), `${fetchRcs.join('\n')}\n`);
  if (libFiles) for (const f of ['preview-forwarder.js', 'bridge-fetch.js']) fs.writeFileSync(path.join(lib, f), '');
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(project, name)), { recursive: true });
    fs.writeFileSync(path.join(project, name), content, { mode: 0o755 });
  }
  fs.writeFileSync(path.join(bin, 'coder'), `#!/bin/bash\nenv > "${out}/agent-env"\n${agentScript}\n`, { mode: 0o755 });
  // sleep: records its argument and waits a moment, so a backoff of 60 s costs nothing
  fs.writeFileSync(path.join(bin, 'sleep'), `#!/bin/bash\necho "$1" >> "${out}/sleeps"\nexec /bin/sleep 0.05\n`, { mode: 0o755 });
  // curl: stands in for the bridge's loopback /health. The file `health` holds the answer: a JSON body, `none` (no
  // answer, exit 7) or `500` (an HTTP error, exit 22 under -f).
  fs.writeFileSync(path.join(out, 'health'), '{"ok":true,"busy":false}');
  fs.writeFileSync(
    path.join(bin, 'curl'),
    `#!/bin/bash
echo "$*" >> "${out}/curl-calls"
h="$(cat "${out}/health")"
[ "$h" = none ] && exit 7
[ "$h" = 500 ] && exit 22
echo "$h"
`,
    { mode: 0o755 }
  );
  fs.writeFileSync(
    path.join(bin, 'node'),
    `#!/bin/bash
case "$1" in
  *preview-forwarder.js) cat > /dev/null; exit 2 ;;
  *bridge-fetch.js)
    echo run >> "${out}/fetch-runs"
    rc="$(head -n1 "${out}/fetch-rcs")"
    if [ "$(wc -l < "${out}/fetch-rcs")" -gt 1 ]; then tail -n +2 "${out}/fetch-rcs" > "${out}/fetch-rcs.next"; mv "${out}/fetch-rcs.next" "${out}/fetch-rcs"; fi
    if [ "$rc" = block ]; then exec /bin/sleep 60; fi
    [ "$rc" = 0 ] && echo vtest
    exit "$rc" ;;
  *server.mjs)
    env > "${out}/bridge-env.$$"
    echo "$1" > "${out}/bridge-argv"
    ${bridge === 'stay' ? 'exec /bin/sleep 60' : 'exit 3'} ;;
esac
`,
    { mode: 0o755 }
  );
  return { dir, out, bin, lib, home, project };
}

// Runs the entrypoint in its own process group with output to a file (the supervisor outlives it), waits for it to finish.
async function run(w, extraEnv = {}) {
  const logFd = fs.openSync(path.join(w.dir, 'entrypoint.log'), 'w');
  const child = spawn('bash', [ENTRYPOINT], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      PATH: `${w.bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: w.home,
      GIT_CONFIG_NOSYSTEM: '1',
      CODER_AGENT_URL: 'https://coder.example.test',
      CODER_AGENT_TOKEN: 'agent-token-value',
      HANDOFF_KEY: KEY,
      PORT: '8080',
      PROJECT_DIR: w.project,
      LIIVO_LIB_DIR: w.lib,
      LIIVO_GATEWAY_URL: 'https://studio.example.test',
      OSC_HOSTNAME: 'tenant-proj.example.test',
      ...extraEnv,
    },
  });
  cleanups.push(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // gone already
    }
    fs.closeSync(logFd);
  });
  const status = await new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return { status, log: () => read(path.join(w.dir, 'entrypoint.log')) };
}

const envOf = (file) => Object.fromEntries(read(file).split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const bridgeEnvFile = (w) => () => fs.readdirSync(w.out).map((n) => path.join(w.out, n)).find((n) => /bridge-env\./.test(n));

// ---- git author ----

const AUTHOR = { LIIVO_GIT_AUTHOR_NAME: 'Liivo Studio', LIIVO_GIT_AUTHOR_EMAIL: 'noreply@liivo.ai' };
const COMMIT = 'cd "$PROJECT_DIR" && git init -q && git commit -q --allow-empty -m first && git log -1 --format="%an <%ae>" > "$OUT_DIR/author"';

test('a fresh home with no git identity: after the entrypoint\'s git step a commit succeeds, as Liivo Studio', async () => {
  const w = setup();
  fs.writeFileSync(path.join(w.bin, 'coder'), `#!/bin/bash\n${COMMIT.replace('$OUT_DIR', w.out)}\nenv > "${w.out}/agent-env"\n`, { mode: 0o755 });
  const r = await run(w, AUTHOR);
  assert.strictEqual(r.status, 0, r.log());
  assert.strictEqual(read(path.join(w.out, 'author')).trim(), 'Liivo Studio <noreply@liivo.ai>');
  assert.strictEqual(execFileSync('git', ['config', '--global', 'user.name'], { env: { HOME: w.home, PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1' } }).toString().trim(), 'Liivo Studio');
});

test('an identity the home volume already has is left alone, name and email', async () => {
  const w = setup();
  fs.writeFileSync(path.join(w.home, '.gitconfig'), '[user]\n\tname = Existing Person\n\temail = person@example.test\n');
  fs.writeFileSync(path.join(w.bin, 'coder'), `#!/bin/bash\n${COMMIT.replace('$OUT_DIR', w.out)}\n`, { mode: 0o755 });
  const r = await run(w, AUTHOR);
  assert.strictEqual(r.status, 0, r.log());
  assert.strictEqual(read(path.join(w.out, 'author')).trim(), 'Existing Person <person@example.test>');
  assert.ok(!/Liivo Studio/.test(read(path.join(w.home, '.gitconfig'))));
});

test('no author configured and none in the environment: the entrypoint warns and still starts the agent', async () => {
  const w = setup();
  const r = await run(w);
  assert.strictEqual(r.status, 0, r.log());
  assert.match(r.log(), /WARNING: no git author is configured/);
  assert.ok(fs.existsSync(path.join(w.out, 'agent-env')));
});

// ---- supervisor ----

const EXPECTED_BRIDGE_ENV = [
  'PATH', 'HOME', 'LANG', 'LIIVO_REPO_DIR', 'LIIVO_PREVIEW_PORT', 'LIIVO_GATEWAY_URL', 'LIIVO_INSTANCE', 'OSC_HOSTNAME',
  'LIIVO_PREVIEW_URL', 'LIIVO_BRIDGE_PORT', 'LIIVO_DEFAULT_START', 'DISABLE_UPDATES', 'DISABLE_AUTOUPDATER',
];
// what bash itself adds to a script's environment
const SHELL_ADDED = new Set(['PWD', 'SHLVL', '_', 'OLDPWD']);

test('the bridge runs with env -i and the minimal list: the Claude credential and nothing of the agent or other secrets', async () => {
  const w = setup();
  const r = await run(w, {
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret-1',
    ANTHROPIC_API_KEY: 'unset',
    GITHUB_TOKEN: 'ghp-secret',
    SOME_TENANT_SECRET: 'tenant-secret',
  });
  assert.strictEqual(r.status, 0, r.log());
  const file = await until(bridgeEnvFile(w), 'the bridge to start');
  const env = envOf(file);
  for (const k of SHELL_ADDED) delete env[k];
  assert.deepStrictEqual(Object.keys(env).sort(), [...EXPECTED_BRIDGE_ENV, 'CLAUDE_CODE_OAUTH_TOKEN'].sort());
  assert.strictEqual(env.CLAUDE_CODE_OAUTH_TOKEN, 'oauth-secret-1');
  assert.strictEqual(env.DISABLE_UPDATES, '1');
  assert.strictEqual(env.DISABLE_AUTOUPDATER, '1');
  assert.strictEqual(env.LIIVO_BRIDGE_PORT, '4777');
  assert.strictEqual(env.LIIVO_DEFAULT_START, path.join(w.lib, 'default-start.js'), 'the installed default start, for the bridge');
  assert.strictEqual(env.LIIVO_REPO_DIR, w.project);
  assert.strictEqual(env.LIIVO_INSTANCE, 'tenant-proj');
  assert.strictEqual(env.LIIVO_GATEWAY_URL, 'https://studio.example.test');
  assert.strictEqual(env.LIIVO_PREVIEW_URL, 'https://tenant-proj.example.test');
  for (const k of ['HANDOFF_KEY', 'CODER_AGENT_TOKEN', 'CODER_AGENT_URL', 'CODER_AGENT_AUTH', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'SOME_TENANT_SECRET', 'PORT', 'PROJECT_DIR']) assert.ok(!(k in env), k);
  assert.ok(!JSON.stringify(env).includes(KEY), 'the handoff key is nowhere in it');
  assert.strictEqual(read(path.join(w.out, 'bridge-argv')).trim(), path.join(w.home, '.liivo', 'bridge', 'current', 'package', 'server.mjs'));
});

test('with the API key as the credential it is passed, and the OAuth token is not', async () => {
  const w = setup();
  await run(w, { ANTHROPIC_API_KEY: 'api-secret-2', CLAUDE_CODE_OAUTH_TOKEN: 'unset' });
  const env = envOf(await until(bridgeEnvFile(w), 'the bridge to start'));
  assert.strictEqual(env.ANTHROPIC_API_KEY, 'api-secret-2');
  assert.ok(!('CLAUDE_CODE_OAUTH_TOKEN' in env));
});

test('state.json and running.json describe the supervisor: starting before anything, running with the version and pid', async () => {
  const w = setup();
  const r = await run(w);
  assert.strictEqual(r.status, 0, r.log());
  await until(bridgeEnvFile(w), 'the bridge to start');
  const state = JSON.parse(read(path.join(w.home, '.liivo', 'bridge', 'state.json')));
  assert.deepStrictEqual(state, { state: 'running', version: 'vtest' });
  const running = JSON.parse(read(path.join(w.home, '.liivo', 'bridge', 'running.json')));
  assert.strictEqual(running.version, 'vtest');
  assert.ok(Number.isInteger(running.pid) && running.pid > 1);
  assert.match(running.startedAt, /^\d{4}-\d\d-\d\dT/);
});

test('a state left on the volume by an earlier run is not reported: it is reset to starting before the proxy starts', async () => {
  const w = setup({ fetchRcs: ['block'] });
  fs.mkdirSync(path.join(w.home, '.liivo', 'bridge'), { recursive: true });
  fs.writeFileSync(path.join(w.home, '.liivo', 'bridge', 'state.json'), '{"state":"running","version":"old"}');
  const r = await run(w);
  assert.strictEqual(r.status, 0, r.log());
  assert.deepStrictEqual(JSON.parse(read(path.join(w.home, '.liivo', 'bridge', 'state.json'))), { state: 'starting', version: null });
});

test('the gateway being unavailable backs the fetch off 5, 10, 20, 40, then 60 s, writes unavailable, and runs no bridge until it succeeds', async () => {
  const w = setup({ fetchRcs: [3, 3, 3, 3, 3, 3, 0] });
  const r = await run(w);
  assert.strictEqual(r.status, 0, r.log());
  await until(bridgeEnvFile(w), 'the bridge to start after the sixth failure');
  assert.deepStrictEqual(read(path.join(w.out, 'sleeps')).trim().split('\n'), ['5', '10', '20', '40', '60', '60']);
  assert.strictEqual(read(path.join(w.out, 'fetch-runs')).trim().split('\n').length, 7);
  assert.match(r.log(), /no verified bridge \(fetcher exit 3\)/);
  assert.strictEqual(JSON.parse(read(path.join(w.home, '.liivo', 'bridge', 'state.json'))).state, 'running');
});

test('with no verified bridge the state is unavailable and no bridge process was started', async () => {
  const w = setup({ fetchRcs: [3] });
  await run(w);
  await until(() => read(path.join(w.out, 'sleeps')).split('\n').length > 3, 'a few retries');
  assert.strictEqual(JSON.parse(read(path.join(w.home, '.liivo', 'bridge', 'state.json'))).state, 'unavailable');
  assert.ok(!bridgeEnvFile(w)());
});

test('a fetcher configuration error (exit 2) stops the supervisor and does not retry', async () => {
  const w = setup({ fetchRcs: [2] });
  const r = await run(w);
  await until(() => /not restarting/.test(r.log()), 'the supervisor to stop');
  await sleep(300);
  assert.strictEqual(read(path.join(w.out, 'fetch-runs')).trim().split('\n').length, 1);
  assert.strictEqual(JSON.parse(read(path.join(w.home, '.liivo', 'bridge', 'state.json'))).state, 'unavailable');
});

test('a bridge that exits is restarted with a backoff of 1, 2, 4, 8 s; the gateway is not asked again', async () => {
  const w = setup({ bridge: 'exit' });
  await run(w);
  await until(() => read(path.join(w.out, 'sleeps')).trim().split('\n').length >= 4, 'four restarts');
  assert.deepStrictEqual(read(path.join(w.out, 'sleeps')).trim().split('\n').slice(0, 4), ['1', '2', '4', '8']);
  assert.strictEqual(read(path.join(w.out, 'fetch-runs')).trim().split('\n').length, 1, 'one fetch for all those runs');
});

test('the clone, the hooks and the agent are never delayed by the fetcher: the agent starts while the fetch is still blocked', async () => {
  const w = setup({ fetchRcs: ['block'], files: { '.liivo/start.sh': '#!/bin/bash\necho started > "$PROJECT_DIR/../started"\n' } });
  const t0 = Date.now();
  const r = await run(w);
  assert.strictEqual(r.status, 0, r.log());
  assert.ok(Date.now() - t0 < 10000, 'the entrypoint ended (it exec\'s the agent) long before the 60 s fetch');
  assert.ok(fs.existsSync(path.join(w.out, 'agent-env')));
  await until(() => fs.existsSync(path.join(w.dir, 'started')), 'the project hook to run');
  assert.ok(!bridgeEnvFile(w)());
});

test('no supervisor, and state unavailable, when the preview forwarder or the fetcher is not there', async () => {
  const w = setup({ libFiles: false });
  const r = await run(w);
  assert.strictEqual(r.status, 0, r.log());
  assert.match(r.log(), /no bridge supervisor/);
  assert.strictEqual(JSON.parse(read(path.join(w.home, '.liivo', 'bridge', 'state.json'))).state, 'unavailable');
  assert.ok(!fs.existsSync(path.join(w.out, 'fetch-runs')));
});

// ---- start.sh pid file ----

test('the hooks\' start.sh runs as its own process group leader and its id is in /tmp/liivo-start-<dir>.pid', async () => {
  const w = setup({
    files: { '.liivo/start.sh': '#!/bin/bash\necho "$$" > "$PROJECT_DIR/../start-pid"\nexec /bin/sleep 60\n' },
  });
  const pidFile = `/tmp/liivo-start-${path.basename(w.project)}.pid`;
  cleanups.push(() => fs.rmSync(pidFile, { force: true }));
  const r = await run(w);
  assert.strictEqual(r.status, 0, r.log());
  const own = Number((await until(() => read(path.join(w.dir, 'start-pid')).trim(), 'start.sh to run')));
  await until(() => read(pidFile), 'the pid file');
  assert.strictEqual(Number(read(pidFile)), own, 'the file holds the id start.sh really has');
  const hasSetsid = spawnSync('sh', ['-c', 'command -v setsid'], { env: { PATH: `${w.bin}:/usr/bin:/bin:/usr/sbin:/sbin` } }).status === 0;
  if (hasSetsid) {
    const pgid = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(own)]).toString().trim());
    assert.strictEqual(pgid, own, 'so that the bridge\'s kill of -pid reaches start.sh and what it started');
  }
  const env = envOf(path.join(w.out, 'agent-env'));
  assert.ok(!('HOST' in env), 'HOST=127.0.0.1 is for the hooks only');
});

test('start.sh still gets loopback, and none of the agent variables or the Claude credential', async () => {
  const w = setup({ files: { '.liivo/start.sh': '#!/bin/bash\nenv > "$PROJECT_DIR/../start-env"\n' } });
  const pidFile = `/tmp/liivo-start-${path.basename(w.project)}.pid`;
  cleanups.push(() => fs.rmSync(pidFile, { force: true }));
  await run(w, { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret-1' });
  await until(() => read(path.join(w.dir, 'start-env')), 'start.sh to run');
  const env = envOf(path.join(w.dir, 'start-env'));
  assert.strictEqual(env.HOST, '127.0.0.1');
  for (const k of ['CODER_AGENT_TOKEN', 'CODER_AGENT_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'HANDOFF_KEY']) assert.ok(!(k in env), k);
});

// ---- bridge reload (POST /__liivo/bridge/reload: the supervisor's side) ----

const bridgeDir = (w) => path.join(w.home, '.liivo', 'bridge');
const requestFile = (w) => path.join(bridgeDir(w), 'reload-request');
const bridgeStarts = (w) => fs.readdirSync(w.out).filter((n) => /^bridge-env\./.test(n)).length;
const fetchRuns = (w) => read(path.join(w.out, 'fetch-runs')).trim().split('\n').filter(Boolean).length;
const stateOf = (w) => JSON.parse(read(path.join(bridgeDir(w), 'state.json')));

test('reload with an idle bridge: the bridge is stopped without a crash backoff, the fetcher runs again, a new bridge starts, the request is gone', async () => {
  const w = setup();
  const r = await run(w);
  await until(() => bridgeStarts(w) === 1, 'the first bridge');
  assert.strictEqual(fetchRuns(w), 1);
  fs.writeFileSync(requestFile(w), '');
  await until(() => bridgeStarts(w) === 2, 'the bridge to be replaced');
  assert.strictEqual(fetchRuns(w), 2);
  assert.ok(!fs.existsSync(requestFile(w)));
  assert.match(r.log(), /bridge stopped for a reload/);
  assert.doesNotMatch(r.log(), /restarting in/);
  assert.ok(!fs.existsSync(path.join(w.out, 'sleeps')), 'no restart wait ran: a reload is not a crash');
  await until(() => stateOf(w).state === 'running', 'state running');
  assert.strictEqual(stateOf(w).version, 'vtest');
  assert.match(read(path.join(bridgeDir(w), 'running.json')), /"version":"vtest"/);
});

test('reload while the bridge is busy: pid unchanged, request kept, fetcher not re-run; when it turns idle the bridge is replaced', async () => {
  const w = setup();
  fs.writeFileSync(path.join(w.out, 'health'), '{"busy":true}');
  await run(w);
  await until(() => bridgeStarts(w) === 1, 'the first bridge');
  const pid1 = read(path.join(bridgeDir(w), 'running.json'));
  fs.writeFileSync(requestFile(w), '');
  await until(() => read(path.join(w.out, 'curl-calls')), 'a health read');
  await sleep(2500);
  assert.strictEqual(bridgeStarts(w), 1);
  assert.strictEqual(fetchRuns(w), 1);
  assert.ok(fs.existsSync(requestFile(w)), 'the request stays until it is honoured');
  assert.strictEqual(read(path.join(bridgeDir(w), 'running.json')), pid1);
  fs.writeFileSync(path.join(w.out, 'health'), '{"busy":false}');
  await until(() => bridgeStarts(w) === 2, 'the bridge to be replaced once idle');
  assert.strictEqual(fetchRuns(w), 2);
  assert.ok(!fs.existsSync(requestFile(w)));
  assert.notStrictEqual(read(path.join(bridgeDir(w), 'running.json')), pid1);
});

test('no answer, a 500 and a malformed body each keep the request and leave the bridge alone', async () => {
  for (const health of ['none', '500', 'not json', '{"ok":true}', '{"busy":"false"}']) {
    const w = setup();
    fs.writeFileSync(path.join(w.out, 'health'), health);
    await run(w);
    await until(() => bridgeStarts(w) === 1, 'the first bridge');
    fs.writeFileSync(requestFile(w), '');
    await until(() => read(path.join(w.out, 'curl-calls')), 'a health read');
    await sleep(1500);
    assert.strictEqual(bridgeStarts(w), 1, health);
    assert.strictEqual(fetchRuns(w), 1, health);
    assert.ok(fs.existsSync(requestFile(w)), health);
  }
});

test('a request older than the bound is deleted without acting: bridge unchanged, no fetch, no health read', async () => {
  const w = setup();
  const r = await run(w);
  await until(() => bridgeStarts(w) === 1, 'the first bridge');
  fs.writeFileSync(requestFile(w), '');
  const old = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(requestFile(w), old, old);
  await until(() => !fs.existsSync(requestFile(w)), 'the aged request to be deleted');
  await sleep(1200);
  assert.strictEqual(bridgeStarts(w), 1);
  assert.strictEqual(fetchRuns(w), 1);
  assert.ok(!fs.existsSync(path.join(w.out, 'curl-calls')));
  assert.match(r.log(), /expired/);
});

test('a request written while the bridge is down (state starting) makes the next step a fetch, not a restart of the cached bridge', async () => {
  const w = setup({ bridge: 'exit' });
  await run(w);
  await until(() => bridgeStarts(w) >= 1, 'the first bridge run');
  fs.writeFileSync(requestFile(w), '');
  await until(() => fetchRuns(w) >= 2, 'a second fetch');
  assert.ok(!fs.existsSync(requestFile(w)));
});

test('a request left on the volume by an earlier run is deleted by the entrypoint before the supervisor starts', async () => {
  const w = setup({ fetchRcs: ['block'] });
  fs.mkdirSync(bridgeDir(w), { recursive: true });
  fs.writeFileSync(requestFile(w), '');
  const r = await run(w);
  assert.strictEqual(r.status, 0, r.log());
  assert.ok(!fs.existsSync(requestFile(w)));
});
