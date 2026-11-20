'use strict';
// git credential helper for https://github.com and the project's managed-Gitea host in the Liivo
// Studio workspace. github.com is configured at build time
// (`git config --system credential.https://github.com.helper '!node <this file>'`); the managed-Gitea
// host is configured by the entrypoint at start (`git config --global credential.https://<host>.helper
// '!node <this file> --host=<host>'`). It answers for github.com and for each `--host=<h>` argument,
// compared exactly and case-insensitively (no prefix, suffix or port matching); any other host gets no
// output and no gateway call.
//
// git calls it as `<helper> [--host=<h>] get` (the action is the LAST argument) with key=value lines on stdin. The helper asks
// the edit proxy on a unix socket to sign an `aud` git token (the handoff key
// never leaves the proxy), sends that token to ${LIIVO_GATEWAY_URL}/api/git-token
// and prints what the gateway returns. If anything fails it prints nothing, so
// git proceeds unauthenticated (public repos still clone), and writes one line
// to stderr naming the cause. The token is never written to stderr or to a file.
const http = require('node:http');
const path = require('node:path');

const SOCKET = process.env.LIIVO_SOCKET || path.join(process.env.HOME || '/home/coder', '.liivo', 'sign.sock');

function fail(cause) {
  process.stderr.write(`liivo-git-credential: no credentials: ${cause}\n`);
  process.exit(0);
}

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (buf += c));
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(buf));
  });
}

function signToken() {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: SOCKET, path: '/git-token', method: 'POST', timeout: 5000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          // handled below
        }
        if (res.statusCode === 200 && body.token && body.gatewayUrl) resolve(body);
        else reject(new Error(body.error || `edit proxy answered ${res.statusCode}`));
      });
    });
    req.on('timeout', () => req.destroy(new Error('edit proxy did not answer')));
    req.on('error', (e) => reject(new Error(`edit proxy not reachable (${e.code || e.message})`)));
    req.end();
  });
}

function allowedHosts(args) {
  const hosts = new Set(['github.com']);
  for (const a of args) if (a.startsWith('--host=') && a.length > 7) hosts.add(a.slice(7).toLowerCase());
  return hosts;
}

async function main() {
  const args = process.argv.slice(2);
  if (args[args.length - 1] !== 'get') return;
  const attrs = {};
  for (const line of (await readStdin()).split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) attrs[line.slice(0, i)] = line.slice(i + 1);
  }
  if (attrs.protocol !== 'https' || !allowedHosts(args).has(String(attrs.host).toLowerCase())) return;

  let signed;
  try {
    signed = await signToken();
  } catch (e) {
    fail(e.message);
  }
  let res;
  try {
    res = await fetch(`${signed.gatewayUrl}/api/git-token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${signed.token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    fail(`gateway not reachable (${e.cause && e.cause.code ? e.cause.code : e.name})`);
  }
  if (res.status === 404) fail('gateway has no repository access bound to this project (public repo?)');
  if (!res.ok) fail(`gateway refused with status ${res.status}`);
  let body;
  try {
    body = await res.json();
  } catch {
    fail('gateway answered with invalid JSON');
  }
  if (!body || typeof body.token !== 'string' || !body.token || /[\r\n\0]/.test(body.token)) {
    fail('gateway answered without a usable token');
  }
  process.stdout.write(`username=x-access-token\npassword=${body.token}\n`);
}

main().catch((e) => fail(e.message));
