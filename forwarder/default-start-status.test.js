'use strict';
// The status line of the default start on the "Preview not running" page (issue #18): the state file is
// untrusted input, so each way it can be wrong gives today's page.
const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createForwarder } = require('./preview-forwarder.js');
const auth = require('./auth.js');
const { defaultStartStatus } = require('./default-start-status.js');

const KEY = crypto.randomBytes(32);
const COOKIE = `${auth.COOKIE_NAME}=${auth.signSession(KEY, { tenant: 't', user: 'u', instance: 't-p' }, Math.floor(Date.now() / 1000))}`;
const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dss-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const project = path.join(dir, 'proj');
  fs.mkdirSync(project);
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir);
  const file = path.join(stateDir, 'liivo-start-proj.state');
  return { dir, project, stateDir, file, set: (obj) => fs.writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj)) };
}

async function page(w, { withForwarder = true } = {}) {
  const fwd = createForwarder({ previewPort: 1, handoffKey: KEY, projectDir: w.project, startStateDir: w.stateDir });
  await new Promise((r) => fwd.listen(0, '127.0.0.1', r));
  cleanups.push(() => fwd.close());
  const { port } = fwd.address();
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/', headers: { Cookie: COOKIE }, agent: false }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const PLAIN = /<title>Preview not running<\/title>.*<h1>Preview not running<\/h1><p>The project's preview is not running\.<\/p>/s;

test('no state file: the page is the one from before, with no status and no reload', async () => {
  const w = setup();
  const r = await page(w);
  assert.strictEqual(r.status, 502);
  assert.match(r.body, PLAIN);
  assert.ok(!/refresh/.test(r.body));
  assert.ok(r.body.startsWith('<!doctype html><html><head><meta charset="utf-8"><title>Preview not running</title></head>'));
});

for (const [state, reason, text, reloads] of [
  ['installing', undefined, /Installing dependencies/, true],
  ['starting', undefined, /Starting the dev server/, true],
  ['failed', 'install failed (exit 1)', /default start failed: install failed \(exit 1\)\. See \/tmp\/liivo-start-proj\.log/, false],
  ['none', 'no dev or start script in package.json', /Nothing to start: no dev or start script in package\.json.*\.liivo\/start\.sh/, false],
]) {
  test(`state ${state}: the heading and the chat tag stay, the status line shows${reloads ? ' and the page reloads itself' : ''}`, async () => {
    const w = setup();
    w.set({ state, ...(reason ? { reason } : {}) });
    const r = await page(w);
    assert.match(r.body, PLAIN);
    assert.match(r.body, text);
    assert.match(r.body, /<script/, 'the chat tag is still on the page');
    assert.strictEqual(/http-equiv="refresh"/.test(r.body), reloads);
  });
}

test('state running adds nothing', async () => {
  const w = setup();
  w.set({ state: 'running' });
  assert.strictEqual(defaultStartStatus(w.project, w.stateDir), null);
});

test('a state file that is not trusted gives the page from before', async () => {
  const w = setup();
  for (const bad of ['not json', '[]', '{"state":"exploded"}', '{"state":5}', JSON.stringify({ state: 'failed', reason: 'x'.repeat(5000) })]) {
    w.set(bad);
    const r = await page(w);
    if (bad.includes('xxxx')) continue; // over the size cap: checked below
    assert.ok(!/default start|Nothing to start|Installing|Starting the dev/.test(r.body), bad);
  }
  w.set(JSON.stringify({ state: 'failed', reason: 'x'.repeat(5000) }));
  assert.strictEqual(defaultStartStatus(w.project, w.stateDir), null, 'above the size cap');
  fs.rmSync(w.file);
  const target = path.join(w.dir, 'elsewhere.json');
  fs.writeFileSync(target, '{"state":"installing"}');
  fs.symlinkSync(target, w.file);
  assert.strictEqual(defaultStartStatus(w.project, w.stateDir), null, 'a symlink is not read');
});

test('a reason is escaped and capped, and no log content is rendered', async () => {
  const w = setup();
  w.set({ state: 'failed', reason: `<script>alert(1)</script>${'a'.repeat(400)}` });
  fs.writeFileSync(path.join(w.stateDir, 'liivo-start-proj.log'), 'SECRET-LOG-CONTENT');
  const r = await page(w);
  assert.ok(!r.body.includes('<script>alert(1)'));
  assert.match(r.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.ok(!r.body.includes('a'.repeat(250)));
  assert.ok(!r.body.includes('SECRET-LOG-CONTENT'));
});

test('with an own .liivo/start.sh the state file is ignored and the page is the one from before', async () => {
  const w = setup();
  fs.mkdirSync(path.join(w.project, '.liivo'));
  fs.writeFileSync(path.join(w.project, '.liivo', 'start.sh'), 'true\n');
  w.set({ state: 'failed', reason: 'install failed (exit 1)' });
  const r = await page(w);
  assert.ok(!/default start/.test(r.body));
  assert.match(r.body, PLAIN);
});
