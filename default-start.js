#!/usr/bin/env node
'use strict';
// Default start for a repository without .liivo/start.sh (Eyevinn/liivo-studio-space#18).
// Run by osc-entrypoint.sh as the leader of its own process group (the same wrapper as an own start.sh,
// so /tmp/liivo-start-<dir>.pid names this process), in the hooks' stripped environment, with stdout and
// stderr appended to /tmp/liivo-start-<dir>.log. Install, build and the dev server are children in the
// same group, so a SIGTERM to the group (the bridge's restart) stops all of them.
// Node built-ins only. Nothing is written into the repository except the package manager's install
// output and, when git does not ignore node_modules, one line in .git/info/exclude.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const projectDir = path.resolve(process.env.PROJECT_DIR || process.cwd());
const dirName = path.basename(projectDir);
const home = process.env.HOME || '/home/coder';
const port = Number(process.env.LIIVO_PREVIEW_PORT || process.env.PREVIEW_PORT || 3000);
const installLimitMs = Number(process.env.LIIVO_DEFAULT_INSTALL_TIMEOUT || 900) * 1000;
const startLimitMs = Number(process.env.LIIVO_DEFAULT_START_TIMEOUT || 300) * 1000;
const killGraceMs = Number(process.env.LIIVO_DEFAULT_KILL_GRACE || 10) * 1000;
const stateFile = `/tmp/liivo-start-${dirName}.state`;
const recordFile = path.join(home, '.liivo', `default-start-${dirName}.install`);

let stopping = false; // a SIGTERM from outside: no state is written, the replacing start owns it
let selfStop = false; // this process ends the group itself, after it wrote the outcome
let child = null;

function log(msg) {
  process.stdout.write(`${msg}\n`);
}
function header(step) {
  log(`=== ${new Date().toISOString().replace(/\.\d+Z$/, 'Z')} default start: ${step}`);
}
function writeState(state, reason) {
  if (stopping) return;
  const body = JSON.stringify(reason ? { state, reason } : { state });
  const tmp = `${stateFile}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${body}\n`);
    fs.renameSync(tmp, stateFile);
  } catch (err) {
    log(`default start: could not write ${stateFile}: ${err.message}`);
  }
}

// The group this process leads (it is the leader when the entrypoint or the bridge started it).
function isLeader() {
  try {
    process.kill(-process.pid, 0);
    return true;
  } catch {
    return false;
  }
}
function signalGroup(sig) {
  try {
    if (isLeader()) process.kill(-process.pid, sig);
    else if (child) process.kill(child.pid, sig);
  } catch {
    // gone already
  }
}

process.on('SIGTERM', () => {
  if (selfStop) return;
  stopping = true;
  if (child) {
    try {
      child.kill('SIGTERM');
    } catch {
      // gone already
    }
  }
  process.exit(143);
});

// Ends the group after the outcome is written: SIGTERM, then SIGKILL after the grace.
function finish(code) {
  selfStop = true;
  signalGroup('SIGTERM');
  const t = setTimeout(() => {
    signalGroup('SIGKILL');
    process.exit(code);
  }, killGraceMs);
  const done = () => {
    clearTimeout(t);
    process.exit(code);
  };
  if (child && child.exitCode === null && child.signalCode === null) child.once('exit', done);
  else done();
}

let ended = false;
function fail(reason, code = 1) {
  if (ended) return;
  ended = true;
  log(`default start: ${reason}`);
  writeState('failed', reason);
  finish(code);
}

function exitText(code, signal) {
  return signal ? `signal ${signal}` : `exit ${code}`;
}

const childEnv = {
  ...process.env,
  PORT: String(port),
  HOST: '127.0.0.1',
  COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
};

// Runs one step as a child; resolves { code, signal, timedOut }. A step that outlives its limit is
// stopped (SIGTERM, then SIGKILL after the grace) and the outcome is known: stopped.
function runStep(step, cmd, args, limitMs) {
  header(`${step}: ${[cmd, ...args].join(' ')}`);
  return new Promise((resolve) => {
    let timedOut = false;
    child = spawn(cmd, args, { cwd: projectDir, env: childEnv, stdio: ['ignore', 'inherit', 'inherit'] });
    const timer = setTimeout(() => {
      timedOut = true;
      const c = child;
      try {
        c.kill('SIGTERM');
      } catch {
        // gone already
      }
      setTimeout(() => {
        try {
          c.kill('SIGKILL');
        } catch {
          // gone already
        }
      }, killGraceMs).unref();
    }, limitMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      log(`default start: could not run ${cmd}: ${err.message}`);
      resolve({ code: 127, signal: null, timedOut: false });
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut });
    });
  });
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readPackage() {
  let raw;
  try {
    raw = fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8');
  } catch {
    return { error: 'no package.json in the repository root' };
  }
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return { error: 'package.json is not valid JSON' };
  }
  if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) return { error: 'package.json is not a JSON object' };
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts) ? pkg.scripts : {};
  const isScript = (n) => typeof scripts[n] === 'string' && scripts[n].trim() !== '';
  const script = isScript('dev') ? 'dev' : isScript('start') ? 'start' : null;
  if (!script) return { error: 'no dev or start script in package.json' };
  return { script, command: scripts[script].trim(), hasBuild: isScript('build') };
}

// Precedence: pnpm, yarn, npm (package-lock or shrinkwrap), npm without a lockfile. bun is not supported.
function detectManager() {
  const has = (f) => fs.existsSync(path.join(projectDir, f));
  const found = [];
  if (has('pnpm-lock.yaml')) found.push(['pnpm', 'pnpm-lock.yaml']);
  if (has('yarn.lock')) found.push(['yarn', 'yarn.lock']);
  if (has('package-lock.json')) found.push(['npm', 'package-lock.json']);
  else if (has('npm-shrinkwrap.json')) found.push(['npm', 'npm-shrinkwrap.json']);
  if (found.length === 0) {
    const bun = ['bun.lock', 'bun.lockb'].find(has);
    if (bun) return { error: `${bun} is a bun lockfile, bun is not supported, add .liivo/start.sh` };
    return { pm: 'npm', lockfile: null };
  }
  if (found.length > 1) {
    log(`default start: more than one lockfile, using ${found[0][1]}, ignoring ${found.slice(1).map((f) => f[1]).join(', ')}`);
  }
  return { pm: found[0][0], lockfile: found[0][1] };
}

function yarnInstallArgs() {
  const r = spawnSync('yarn', ['--version'], { cwd: projectDir, env: childEnv, encoding: 'utf8', timeout: 60000 });
  const major = Number(String(r.stdout || '').trim().split('.')[0]);
  // Yarn 1 (classic) freezes with --frozen-lockfile, yarn 2 and later (berry) with --immutable.
  return major >= 2 ? ['install', '--immutable'] : ['install', '--frozen-lockfile'];
}

function installArgs(pm, lockfile) {
  if (pm === 'pnpm') return ['install', '--frozen-lockfile'];
  if (pm === 'yarn') return yarnInstallArgs();
  return lockfile ? ['ci'] : ['install', '--no-package-lock'];
}

// git must not see dependencies: the bridge commits with `git add -A`. Local exclude, never committed.
function excludeNodeModules() {
  const git = (args) => spawnSync('git', args, { cwd: projectDir, encoding: 'utf8' });
  const info = path.join(projectDir, '.git', 'info');
  if (!fs.existsSync(path.join(projectDir, '.git'))) return;
  if (git(['check-ignore', '-q', 'node_modules/.liivo-probe']).status === 0) return;
  try {
    fs.mkdirSync(info, { recursive: true });
    const file = path.join(info, 'exclude');
    const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    fs.appendFileSync(file, `${cur === '' || cur.endsWith('\n') ? '' : '\n'}/node_modules/\n`);
    log('default start: node_modules is not ignored by git, added /node_modules/ to .git/info/exclude');
  } catch (err) {
    log(`default start: could not update .git/info/exclude: ${err.message}`);
  }
}

// Extra flags for a single-command next or vite script, so it binds to loopback on the preview port.
function bindFlags(command) {
  const words = command.split(/\s+/);
  const own = /(^|\s)(-p\S*|--port\S*|-H\S*|--hostname\S*|--host\S*|--strictPort)(\s|$)/;
  if (/[&;|`$<>()]/.test(command) || own.test(command)) {
    log(`default start: the script is a compound command or names its own host or port, so only PORT and HOST are set: the preview expects port ${port} on 127.0.0.1`);
    return [];
  }
  const [bin, sub] = words;
  if (bin === 'next' && (sub === 'dev' || sub === 'start')) return ['-H', '127.0.0.1', '-p', String(port)];
  if (bin === 'vite' && (sub === undefined || ['dev', 'serve', 'preview'].includes(sub) || sub.startsWith('-'))) {
    return ['--host', '127.0.0.1', '--port', String(port), '--strictPort'];
  }
  return [];
}

function runArgs(pm, script, flags) {
  const args = ['run', script];
  if (flags.length) args.push(...(pm === 'npm' ? ['--'] : []), ...flags);
  return args;
}

function probe() {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
  });
}

async function main() {
  const pkg = readPackage();
  if (pkg.error) {
    log(`default start: nothing to start: ${pkg.error}`);
    writeState('none', pkg.error);
    return;
  }
  const mgr = detectManager();
  if (mgr.error) {
    fail(mgr.error);
    return;
  }
  const { pm, lockfile } = mgr;
  excludeNodeModules();

  const hashFile = path.join(projectDir, lockfile || 'package.json');
  const hash = sha256(hashFile);
  let recorded = '';
  try {
    recorded = fs.readFileSync(recordFile, 'utf8').trim();
  } catch {
    // no record
  }
  const deadline = Date.now() + installLimitMs;
  const needInstall = recorded !== hash || !fs.existsSync(path.join(projectDir, 'node_modules'));

  writeState('installing');
  if (needInstall) {
    const r = await runStep('install', pm, installArgs(pm, lockfile), Math.max(deadline - Date.now(), 1));
    if (r.timedOut) return fail(`install timed out after ${Math.round(installLimitMs / 1000)}s`);
    if (r.code !== 0) return fail(`install failed (${exitText(r.code, r.signal)})`);
    try {
      fs.mkdirSync(path.dirname(recordFile), { recursive: true });
      fs.writeFileSync(recordFile, `${hash}\n`);
    } catch (err) {
      log(`default start: could not record the install: ${err.message}`);
    }
  } else {
    log('default start: dependencies are installed and the lockfile is unchanged, no install');
  }

  writeState('starting');
  if (pkg.script === 'start' && pkg.hasBuild) {
    const r = await runStep('build', pm, ['run', 'build'], Math.max(deadline - Date.now(), 1));
    if (r.timedOut) return fail(`build timed out after ${Math.round(installLimitMs / 1000)}s`);
    if (r.code !== 0) return fail(`build failed (${exitText(r.code, r.signal)})`);
  }

  const args = runArgs(pm, pkg.script, bindFlags(pkg.command));
  header(`${pkg.script}: ${[pm, ...args].join(' ')}`);
  child = spawn(pm, args, { cwd: projectDir, env: childEnv, stdio: ['ignore', 'inherit', 'inherit'] });
  let exited = null;
  child.on('error', (err) => {
    log(`default start: could not run ${pm}: ${err.message}`);
    exited = { code: 127, signal: null };
    fail(`could not run ${pm}`, 127);
  });
  child.on('exit', (code, signal) => {
    exited = { code, signal };
    fail(`dev server exited (${exitText(code, signal)})`, code || 1);
  });
  const t0 = Date.now();
  while (exited === null && Date.now() - t0 < startLimitMs) {
    if (await probe()) {
      writeState('running');
      return; // stay alive as the group leader for the dev server's lifetime
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (exited === null) fail(`not listening on 127.0.0.1:${port} after ${Math.round(startLimitMs / 1000)}s`);
}

main().catch((err) => fail(`default start crashed: ${err.message}`));
