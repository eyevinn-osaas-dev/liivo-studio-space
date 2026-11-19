'use strict';
// Shell tests of the first-clone retry in osc-entrypoint.sh (issue #7). The real script runs against a stub
// `git` that takes its `clone` outcomes from a script (one per attempt, the last repeats) and delegates every
// other git command to the real git, and against stub `coder` and `node` programs. The backoff is shortened
// through LIIVO_CLONE_RETRY_* so a test takes about a second.
const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

const ENTRYPOINT = path.join(__dirname, '..', 'osc-entrypoint.sh');
const REAL_GIT = execFileSync('sh', ['-c', 'command -v git']).toString().trim();
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
    await sleep(20);
  }
}

const MESSAGES = {
  tenant:
    'echo "liivo-git-credential: no credentials: tenant not known yet: no handoff or status call has reached this workspace" >&2; echo "fatal: could not read Username for \'https://github.com\': No such device or address" >&2; rc=128',
  auth: 'echo "remote: Invalid username or password." >&2; echo "fatal: Authentication failed for \'https://github.com/o/r/\'" >&2; rc=128',
  notfound: 'echo "fatal: repository \'https://github.com/o/r/\' not found" >&2; rc=128',
  partial: 'mkdir -p "$target"; echo half > "$target/half.txt"; echo "fatal: early EOF" >&2; rc=128',
  ok: 'mkdir -p "$target/.liivo"; "$REAL" init -q "$target"; cp "$OUT/start.sh" "$target/.liivo/start.sh"; rc=0',
  silent: 'rc=1',
  // Hang modes. The lock is released when the stub ends (a TERM trap), or before a stub that SIGKILL ends.
  hang: `trap 'rmdir "$OUT/lock" 2>/dev/null; exit 143' TERM; /bin/sleep 60 & wait $!`,
  hangignore: 'rmdir "$OUT/lock"; trap "" TERM; while :; do /bin/sleep 0.2; done',
  hanggit: `mkdir -p "$target/.git"; echo "ref: refs/heads/x" > "$target/.git/HEAD"; trap 'rmdir "$OUT/lock" 2>/dev/null; exit 143' TERM; /bin/sleep 60 & wait $!`,
  killgit: 'mkdir -p "$target/.git"; echo "ref: refs/heads/x" > "$target/.git/HEAD"; rmdir "$OUT/lock"; kill -9 $$',
  exit128git: 'mkdir -p "$target/.git"; echo "ref: refs/heads/x" > "$target/.git/HEAD"; echo "fatal: early EOF" >&2; rc=128',
};

// gitScript: the outcome of each clone attempt in order ('tenant', 'auth', 'notfound', 'partial', 'ok'); the last repeats.
function setup({ gitScript = ['ok'], preExistingEmpty = false, files = null } = {}) {
  const dir = fs.mkdtempSync(path.join('/tmp', 'lscr-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'out');
  const bin = path.join(dir, 'bin');
  const lib = path.join(dir, 'lib');
  const home = path.join(dir, 'home');
  const project = path.join(dir, `proj-${crypto.randomBytes(4).toString('hex')}`);
  for (const d of [out, bin, lib, home]) fs.mkdirSync(d);
  if (preExistingEmpty) fs.mkdirSync(project);
  if (files) for (const [n, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(project, n)), { recursive: true });
    fs.writeFileSync(path.join(project, n), c);
  }
  for (const f of ['preview-forwarder.js', 'bridge-fetch.js']) fs.writeFileSync(path.join(lib, f), '');
  fs.writeFileSync(path.join(out, 'git-script'), `${gitScript.join('\n')}\n`);
  // The hook records what the project looked like when it ran.
  fs.writeFileSync(
    path.join(out, 'start.sh'),
    `echo "git=$([ -d .git ] && echo yes || echo no) marker=$([ -e "$HOME/.liivo/project-cloned" ] && echo yes || echo no) clones=$(cat "${out}/clone-count" 2>/dev/null)" > "${out}/hook"\n`
  );
  fs.writeFileSync(path.join(bin, 'coder'), `#!/bin/bash\nenv > "${out}/agent-env"\ndate +%s > "${out}/agent-started"\n`, { mode: 0o755 });
  fs.writeFileSync(
    path.join(bin, 'node'),
    `#!/bin/bash
case "$1" in
  *preview-forwarder.js) cat > /dev/null; exit 2 ;;
  *bridge-fetch.js) env > "${out}/fetcher-env"; echo vtest; exit 0 ;;
  *server.mjs) exec /bin/sleep 60 ;;
esac
`,
    { mode: 0o755 }
  );
  fs.writeFileSync(
    path.join(bin, 'git'),
    `#!/bin/bash
OUT="${out}"; REAL="${REAL_GIT}"
if [ "$1" != clone ]; then exec "$REAL" "$@"; fi
shift; [ "$1" = -- ] && shift
url="$1"; target="$2"
mkdir "$OUT/lock" 2>/dev/null || echo overlap >> "$OUT/overlap"
n=$(( $(cat "$OUT/clone-count" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$OUT/clone-count"
echo "$url" >> "$OUT/clone-urls"
mode="$(sed -n "\${n}p" "$OUT/git-script")"; [ -n "$mode" ] || mode="$(tail -n1 "$OUT/git-script")"
/bin/sleep 0.05
rc=0
case "$mode" in
${Object.entries(MESSAGES)
  .map(([k, v]) => `  ${k}) ${v} ;;`)
  .join('\n')}
esac
rmdir "$OUT/lock"
exit $rc
`,
    { mode: 0o755 }
  );
  return { dir, out, bin, lib, home, project, count: () => Number(read(path.join(out, 'clone-count')) || 0) };
}

// Runs the entrypoint (its own process group, output to a file: the retry and the hooks outlive it) and waits for it to exit.
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
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret-1',
      PORT: '8080',
      PROJECT_DIR: w.project,
      LIIVO_LIB_DIR: w.lib,
      REPO_URL: 'https://github.com/o/r.git',
      LIIVO_GIT_AUTHOR_NAME: 'Liivo Studio',
      LIIVO_GIT_AUTHOR_EMAIL: 'noreply@liivo.ai',
      LIIVO_CLONE_RETRY_DELAYS: '0.05 0.05',
      LIIVO_CLONE_RETRY_STEADY: '0.05',
      LIIVO_CLONE_RETRY_BUDGET: '30',
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

const attemptLines = (log) => log.split('\n').filter((l) => /git clone attempt \d+ failed/.test(l));
const marker = (w) => path.join(w.home, '.liivo', 'project-cloned');
const hook = (w) => path.join(w.out, 'hook');

test('a first clone that fails twice with the helper\'s tenant-not-known message succeeds on the third attempt: marker, hook after the clone, attempts logged', async () => {
  const w = setup({ gitScript: ['tenant', 'tenant', 'ok'] });
  const r = await run(w);
  assert.strictEqual(r.status, 0, r.log());
  await until(() => read(hook(w)), 'the hook');
  assert.strictEqual(w.count(), 3);
  assert.ok(fs.existsSync(path.join(w.project, '.git')));
  assert.ok(fs.existsSync(marker(w)), 'project-cloned is written by the retry that succeeded');
  assert.match(read(hook(w)), /git=yes marker=yes clones=3/, 'the hook ran after the clone, never against an empty directory');
  const log = r.log();
  assert.strictEqual(attemptLines(log).length, 2);
  assert.match(attemptLines(log)[0], /the edit proxy does not know its tenant yet/);
  assert.match(log, /git clone succeeded on attempt 3/);
  const cloneLog = read(path.join(w.home, 'liivo-clone.log'));
  assert.strictEqual((cloneLog.match(/^=== attempt \d+ at \d{4}-\d\d-\d\dT[\d:]+Z$/gm) || []).length, 3, 'every attempt carries its time');
  assert.strictEqual(read(path.join(w.out, 'overlap')), '', 'two clones never ran at the same time');
});

test('the agent does not wait for the retries, and the hooks do', async () => {
  const w = setup({ gitScript: ['tenant'] });
  const r = await run(w, { LIIVO_CLONE_RETRY_DELAYS: '1', LIIVO_CLONE_RETRY_STEADY: '1', LIIVO_CLONE_RETRY_BUDGET: '30' });
  assert.strictEqual(r.status, 0, r.log());
  assert.ok(fs.existsSync(path.join(w.out, 'agent-env')), 'exec coder agent ran with the first clone failed and retries pending');
  assert.ok(!fs.existsSync(path.join(w.home, 'liivo-run.log')), 'the hooks have not started while the retries run');
  assert.ok(!fs.existsSync(hook(w)));
  assert.match(r.log(), /git clone failed \(the edit proxy does not know its tenant yet\).*retrying in the background/);
});

test('a clone that never works: the budget ends, one line per attempt names the cause, the hooks then run, the agent is up', async () => {
  const w = setup({ gitScript: ['auth'], preExistingEmpty: true });
  const r = await run(w, { LIIVO_CLONE_RETRY_BUDGET: '1' });
  assert.strictEqual(r.status, 0, r.log());
  assert.ok(fs.existsSync(path.join(w.out, 'agent-env')));
  await until(() => /giving up/.test(r.log()) && fs.existsSync(path.join(w.home, 'liivo-run.log')), 'the budget to end and the hooks to run');
  const log = r.log();
  const attempts = attemptLines(log);
  assert.ok(w.count() >= 3, `attempts were made (${w.count()})`);
  assert.strictEqual(attempts.length, w.count(), 'one log line per attempt');
  for (const l of attempts) assert.match(l, /authentication failed/);
  assert.match(log, /still failing after the retry budget \(1s\), giving up: authentication failed; restart the workspace or run git clone by hand/);
  assert.ok(!fs.existsSync(marker(w)));
  assert.ok(!log.includes('oauth-secret-1') && !log.includes('agent-token-value'));
});

test('a permanent failure is retried the same bounded way and logs its own cause', async () => {
  const w = setup({ gitScript: ['notfound'] });
  const r = await run(w, { LIIVO_CLONE_RETRY_BUDGET: '1' });
  await until(() => /giving up/.test(r.log()), 'the budget to end');
  const attempts = attemptLines(r.log());
  assert.strictEqual(attempts.length, w.count());
  for (const l of attempts) assert.match(l, /repository not found/);
});

test('a failed attempt removes only what it created: the directory it made, or what it put into the empty one it found', async () => {
  let w = setup({ gitScript: ['partial'] });
  let r = await run(w, { LIIVO_CLONE_RETRY_BUDGET: '1' });
  await until(() => /giving up/.test(r.log()), 'the budget to end');
  assert.ok(!fs.existsSync(w.project), 'the partial directory the failed clone created is gone');
  w = setup({ gitScript: ['partial'], preExistingEmpty: true });
  r = await run(w, { LIIVO_CLONE_RETRY_BUDGET: '1' });
  await until(() => /giving up/.test(r.log()), 'the budget to end');
  assert.ok(fs.existsSync(w.project) && fs.readdirSync(w.project).length === 0, 'the empty directory stays, empty');
});

test('a non-empty project directory is never cloned into or touched', async () => {
  const w = setup({ gitScript: ['ok'], files: { 'keep.txt': 'mine' } });
  const r = await run(w);
  assert.strictEqual(r.status, 0, r.log());
  assert.match(r.log(), /is not a git checkout, skipping clone/);
  assert.strictEqual(w.count(), 0);
  assert.strictEqual(read(path.join(w.project, 'keep.txt')), 'mine');
});

test('files that appear in the directory while the retry waits end the retry and stay', async () => {
  const w = setup({ gitScript: ['tenant', 'ok'] });
  const r = await run(w, { LIIVO_CLONE_RETRY_DELAYS: '1', LIIVO_CLONE_RETRY_STEADY: '1' });
  assert.strictEqual(w.count(), 1);
  fs.mkdirSync(w.project, { recursive: true });
  fs.writeFileSync(path.join(w.project, 'keep.txt'), 'mine');
  await until(() => /no longer empty, not cloning/.test(r.log()), 'the retry to notice');
  await sleep(200);
  assert.strictEqual(w.count(), 1, 'no second clone');
  assert.strictEqual(read(path.join(w.project, 'keep.txt')), 'mine');
  assert.ok(!fs.existsSync(marker(w)));
});

test('a first clone that succeeds is not retried, and the hooks run as before', async () => {
  const w = setup({ gitScript: ['ok'] });
  const r = await run(w);
  assert.strictEqual(r.status, 0, r.log());
  await until(() => read(hook(w)), 'the hook');
  assert.strictEqual(w.count(), 1);
  assert.strictEqual(attemptLines(r.log()).length, 0);
  assert.doesNotMatch(r.log(), /retrying in the background/);
  assert.ok(fs.existsSync(marker(w)));
  assert.match(read(hook(w)), /git=yes marker=yes clones=1/);
});

test('an already cloned project is left alone and not cloned again', async () => {
  const w = setup({ gitScript: ['ok'] });
  fs.mkdirSync(path.join(w.project, '.git'), { recursive: true });
  const r = await run(w);
  assert.strictEqual(r.status, 0, r.log());
  assert.strictEqual(w.count(), 0);
  assert.match(r.log(), /project already checked out/);
});

test('the clone log never holds the agent token or the Claude credential, and the URL is masked in the entrypoint log', async () => {
  const w = setup({ gitScript: ['tenant', 'ok'] });
  const r = await run(w, { REPO_URL: 'https://user:s3cret@github.com/o/r.git' });
  await until(() => read(hook(w)), 'the hook');
  assert.ok(!r.log().includes('s3cret'));
  assert.match(r.log(), /cloning https:\/\/\*\*\*@github.com\/o\/r.git/);
});

test('the bridge fetcher runs with a clean environment: PATH and HOME, none of the agent or Claude variables', async () => {
  const w = setup({ gitScript: ['ok'] });
  await run(w, { HANDOFF_KEY: crypto.randomBytes(32).toString('base64') });
  const text = await until(() => read(path.join(w.out, 'fetcher-env')), 'the fetcher');
  const env = Object.fromEntries(text.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  assert.strictEqual(env.HOME, w.home);
  assert.ok(env.PATH.startsWith(w.bin));
  for (const k of ['CODER_AGENT_TOKEN', 'CODER_AGENT_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'HANDOFF_KEY', 'REPO_URL']) assert.ok(!(k in env), k);
});

// Per-attempt cause, time limit and cleanup of a killed attempt (issue #14). LIIVO_CLONE_TIMEOUT has a resolution of
// one second, so a limit of 1 s ends an attempt between 1 and 2 s.
const LIMIT = { LIIVO_CLONE_TIMEOUT: '1', LIIVO_CLONE_KILL_GRACE: '1' };
const cloneLog = (w) => read(path.join(w.home, 'liivo-clone.log'));

test('the cause of each attempt comes from that attempt only: tenant, then not found, then authentication, and the giving-up line names the last', async () => {
  const w = setup({ gitScript: ['tenant', 'notfound', 'auth'] });
  const r = await run(w, { LIIVO_CLONE_RETRY_BUDGET: '2' });
  await until(() => /giving up/.test(r.log()), 'the budget to end');
  const lines = attemptLines(r.log());
  assert.match(lines[0], /does not know its tenant yet/);
  assert.match(lines[1], /repository not found/);
  assert.match(lines[2], /authentication failed/);
  assert.match(r.log(), /giving up: authentication failed;/);
});

test("an attempt whose own output names no cause reports the default, not an earlier attempt's cause", async () => {
  const w = setup({ gitScript: ['auth', 'silent'] });
  const r = await run(w, { LIIVO_CLONE_RETRY_BUDGET: '2' });
  await until(() => /giving up/.test(r.log()), 'the budget to end');
  const lines = attemptLines(r.log());
  assert.match(lines[0], /authentication failed/);
  for (const l of lines.slice(1)) assert.match(l, /see .*liivo-clone\.log/);
  assert.match(r.log(), /giving up: see .*liivo-clone\.log;/);
});

test('(a) a first attempt that hangs is stopped after the limit: the agent starts, a retry is pending, the warning names the timeout', { timeout: 40000 }, async () => {
  const w = setup({ gitScript: ['hang', 'ok'] });
  const r = await run(w, { ...LIMIT, LIIVO_CLONE_RETRY_DELAYS: '30', LIIVO_CLONE_RETRY_STEADY: '30' });
  assert.strictEqual(r.status, 0, r.log());
  assert.ok(fs.existsSync(path.join(w.out, 'agent-env')), 'the agent is started');
  assert.match(r.log(), /git clone failed \(timed out after 1s\).*retrying in the background/);
  assert.match(cloneLog(w), /timed out after 1s/);
  assert.strictEqual(w.count(), 1);
  assert.ok(!fs.existsSync(hook(w)), 'the hooks wait for the retry');
  assert.ok(!fs.existsSync(path.join(w.out, 'lock')), 'the stopped attempt is gone');
});

test('(b) a retry that hangs is stopped and the next attempt clones: marker, hook after the clone, no overlap', { timeout: 40000 }, async () => {
  const w = setup({ gitScript: ['tenant', 'hang', 'ok'] });
  const r = await run(w, LIMIT);
  assert.strictEqual(r.status, 0, r.log());
  await until(() => read(hook(w)), 'the hook');
  assert.strictEqual(w.count(), 3);
  assert.match(attemptLines(r.log())[1], /git clone attempt 2 failed: timed out after 1s/);
  assert.ok(fs.existsSync(marker(w)));
  assert.match(read(hook(w)), /git=yes marker=yes clones=3/);
  assert.strictEqual(read(path.join(w.out, 'overlap')), '', 'two clones never ran at the same time');
});

test('(c) every attempt hangs: the budget ends, the giving-up line names the timeout, the hooks run and the agent is up', { timeout: 60000 }, async () => {
  const w = setup({ gitScript: ['hang'], preExistingEmpty: true });
  const r = await run(w, { ...LIMIT, LIIVO_CLONE_RETRY_BUDGET: '2' });
  assert.strictEqual(r.status, 0, r.log());
  assert.ok(fs.existsSync(path.join(w.out, 'agent-env')));
  await until(() => /giving up/.test(r.log()) && fs.existsSync(path.join(w.home, 'liivo-run.log')), 'the budget to end and the hooks to run', 30000);
  assert.match(r.log(), /giving up: timed out after 1s;/);
  assert.ok(w.count() >= 2);
  assert.ok(!fs.existsSync(marker(w)));
  assert.strictEqual(read(path.join(w.out, 'overlap')), '');
});

test('a git that ignores SIGTERM is killed after the grace, so the attempt cannot hold the entrypoint', { timeout: 40000 }, async () => {
  const w = setup({ gitScript: ['hangignore', 'ok'] });
  const r = await run(w, LIMIT);
  assert.strictEqual(r.status, 0, r.log());
  await until(() => read(hook(w)), 'the hook');
  assert.strictEqual(w.count(), 2);
  assert.match(cloneLog(w), /timed out after 1s/);
  assert.ok(fs.existsSync(marker(w)));
});

for (const [label, mode] of [
  ['stopped by the limit', 'hanggit'],
  ['killed by SIGKILL', 'killgit'],
]) {
  test(`(3a) an attempt ${label} that left .git/HEAD in the empty directory is cleaned, and the next attempt clones`, { timeout: 40000 }, async () => {
    const w = setup({ gitScript: [mode, 'ok'], preExistingEmpty: true });
    const r = await run(w, LIMIT);
    assert.strictEqual(r.status, 0, r.log());
    await until(() => read(hook(w)), 'the hook');
    assert.strictEqual(w.count(), 2);
    assert.strictEqual((cloneLog(w).match(/removed the partial checkout/g) || []).length, 1);
    assert.ok(fs.existsSync(marker(w)));
    assert.match(read(hook(w)), /git=yes marker=yes clones=2/);
    assert.ok(fs.existsSync(path.join(w.project, '.git', 'objects')), 'the .git is the complete one from the real init');
    assert.doesNotMatch(r.log(), /no longer empty/);
  });
}

test('(3b) an attempt that exits 128 by itself with .git/HEAD leaves the directory alone and the retry ends', async () => {
  const w = setup({ gitScript: ['exit128git', 'ok'], preExistingEmpty: true });
  const r = await run(w);
  assert.strictEqual(r.status, 0, r.log());
  await until(() => /no longer empty, not cloning/.test(r.log()), 'the retry to end');
  assert.strictEqual(w.count(), 1);
  assert.ok(fs.existsSync(path.join(w.project, '.git', 'HEAD')), 'the checkout is untouched');
  assert.doesNotMatch(cloneLog(w), /removed the partial checkout/);
});
