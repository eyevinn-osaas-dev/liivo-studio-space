'use strict';
// Shell test of osc-entrypoint.sh: the git credential helper entry for the project's managed-Gitea host.
// The real script runs against a stub `coder`; the entry is read back with `git config --global`.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const ENTRYPOINT = path.join(__dirname, '..', 'osc-entrypoint.sh');
const HOST = 'acme-acmegit.go-gitea-gitea.auto.dev.osaas.io';
const LIB = '/opt/test-lib';
const REAL_GIT = execFileSync('sh', ['-c', 'command -v git']).toString().trim();
// a git whose clone only creates the checkout, so no test depends on the network
const GIT_STUB = `#!/bin/bash
if [ "$1" = clone ]; then
  for a in "$@"; do d="$a"; done
  mkdir -p "$d/.git" && : > "$d/.git/HEAD"
  exit 0
fi
exec ${REAL_GIT} "$@"
`;

function setup() {
  const dir = fs.mkdtempSync(path.join('/tmp', 'lsgh-'));
  const bin = path.join(dir, 'bin');
  const home = path.join(dir, 'home');
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(bin, 'coder'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'git'), GIT_STUB, { mode: 0o755 });
  return { dir, bin, home };
}

function start(w, extraEnv = {}) {
  const res = spawnSync('bash', [ENTRYPOINT], {
    env: {
      PATH: `${w.bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: w.home,
      GIT_CONFIG_NOSYSTEM: '1',
      CODER_AGENT_URL: 'https://coder.example.test',
      CODER_AGENT_TOKEN: 'agent-token-value',
      PORT: '8080',
      PROJECT_DIR: path.join(w.dir, 'proj'),
      LIIVO_LIB_DIR: LIB,
      ...extraEnv,
    },
    encoding: 'utf8',
    timeout: 30000,
  });
  return { status: res.status, log: `${res.stdout}${res.stderr}` };
}

function entries(w) {
  const r = spawnSync('git', ['config', '--global', '--get-regexp', '^credential\\.'], { env: { HOME: w.home, PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8' });
  return r.stdout.split('\n').filter(Boolean);
}

function withHome(fn) {
  const w = setup();
  try {
    return fn(w);
  } finally {
    fs.rmSync(w.dir, { recursive: true, force: true });
  }
}

// REPO_URL values that must give no entry
const NO_ENTRY = [
  ['github.com', 'https://github.com/Eyevinn/x.git'],
  ['another public host', 'https://gitlab.com/a/b.git'],
  ['unset', undefined],
  ['userinfo', `https://u:p@${HOST}/o/r.git`],
  ['port', `https://${HOST}:3000/o/r.git`],
  ['http', `http://${HOST}/o/r.git`],
  ['tenant parts differ', 'https://acme-otehrgit.go-gitea-gitea.auto.dev.osaas.io/o/r.git'],
  ['shell metacharacters', 'https://acme-acme$(id)git.go-gitea-gitea.auto.dev.osaas.io/o/r.git'],
  ['quote in host', "https://acme-acme'git.go-gitea-gitea.auto.dev.osaas.io/o/r.git"],
  ['suffix after the host', `https://${HOST}.evil.example/o/r.git`],
  ['other domain', 'https://acme-acmegit.go-gitea-gitea.auto.dev.example.com/o/r.git'],
];

test('a managed-Gitea REPO_URL gives one helper entry for that exact host', () =>
  withHome((w) => {
    const r = start(w, { REPO_URL: `https://${HOST}/acme/site.git` });
    assert.strictEqual(r.status, 0, r.log);
    assert.deepStrictEqual(entries(w), [`credential.https://${HOST}.helper !node ${LIB}/git-credential-liivo.js --host=${HOST}`]);
  }));

test('an uppercase host is lowercased', () =>
  withHome((w) => {
    start(w, { REPO_URL: `https://${HOST.toUpperCase()}/acme/site.git` });
    assert.strictEqual(entries(w).length, 1);
    assert.ok(entries(w)[0].startsWith(`credential.https://${HOST}.helper `));
  }));

for (const [name, url] of NO_ENTRY) {
  test(`no helper entry for: ${name}`, () =>
    withHome((w) => {
      const extra = url === undefined ? {} : { REPO_URL: url };
      const r = start(w, extra);
      assert.strictEqual(r.status, 0, r.log);
      assert.deepStrictEqual(entries(w), []);
    }));
}

test('a second start leaves one entry', () =>
  withHome((w) => {
    start(w, { REPO_URL: `https://${HOST}/acme/site.git` });
    start(w, { REPO_URL: `https://${HOST}/acme/site.git` });
    assert.strictEqual(entries(w).length, 1);
  }));

test('an entry left by an earlier start for a different host is gone, other credential config stays', () =>
  withHome((w) => {
    const other = 'old-oldgit.go-gitea-gitea.auto.dev.osaas.io';
    fs.writeFileSync(path.join(w.home, '.gitconfig'), `[credential "https://${other}"]\n\thelper = !node ${LIB}/git-credential-liivo.js --host=${other}\n[credential "https://example.test"]\n\thelper = store\n`);
    start(w, { REPO_URL: `https://${HOST}/acme/site.git` });
    const e = entries(w);
    assert.strictEqual(e.length, 2);
    assert.ok(e.some((l) => l.startsWith(`credential.https://${HOST}.helper `)));
    assert.ok(e.includes('credential.https://example.test.helper store'));
    assert.ok(!e.some((l) => l.includes(other)));
  }));

test('a failing config write logs one WARNING and the entrypoint still starts the agent', () =>
  withHome((w) => {
    // a directory in place of ~/.gitconfig makes `git config --global` fail on write
    fs.mkdirSync(path.join(w.home, '.gitconfig'));
    const r = start(w, { REPO_URL: `https://${HOST}/acme/site.git` });
    const warnings = r.log.split('\n').filter((l) => /WARNING: could not configure the git credential helper/.test(l));
    assert.strictEqual(warnings.length, 1, r.log);
    assert.strictEqual(r.status, 0, r.log);
  }));

test('the helper entry runs the helper script with the host as an argument', () =>
  withHome((w) => {
    start(w, { REPO_URL: `https://${HOST}/acme/site.git` });
    const v = execFileSync('git', ['config', '--global', '--get', `credential.https://${HOST}.helper`], { env: { HOME: w.home, PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1' } }).toString().trim();
    assert.strictEqual(v, `!node ${LIB}/git-credential-liivo.js --host=${HOST}`);
  }));
