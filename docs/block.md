# Block definition notes

This file records what the OSC catalog entry for this repo is meant to look like.
Nothing here is registered yet. The maker takes the repo contents (`Dockerfile.osc`
is used in preference to `Dockerfile`, see `osaas-maker/src/job.ts`) and the
service definition from the maker order, so the options, memory size and volume
are set when the block is imported, not by a file in this repo.

Expected service id: `eyevinn-liivo-studio-space` (the maker derives it as
`<owner>-<name>` in lower case, see `serviceIdFromOrder` in `osaas-maker`). This
is unverified until the import has run.

## Intended options

Each option maps to one environment variable of the container (`optionMapping`
in the maker order). `osc-entrypoint.sh` reads exactly these names.

| Option | Env var | Type | Required | Sensitive | Notes |
|---|---|---|---|---|---|
| `name` | none | string | yes | no | Instance name, supplied by OSC. |
| `RepoUrl` | `REPO_URL` | string | no | no | Git URL cloned into `/home/coder/project` on first start. Do not embed credentials. |
| `RepoBranch` | `REPO_BRANCH` | string | no | no | Checked out after the clone, created if missing. |
| `AgentUrl` | `CODER_AGENT_URL` | string | yes | no | Public URL of the Coder instance (the `coder-coder` block). |
| `AgentToken` | `CODER_AGENT_TOKEN` | string | yes | yes | Coder agent token. Pass as a `{{secrets.x}}` reference. |
| `PreviewPort` | `PREVIEW_PORT` | number | no | no | Port of the project's dev server. Default 3000. |
| `HandoffKey` | `HANDOFF_KEY` | string | no | yes | Base64 of 32 bytes: the key the edit proxy checks handoff tokens and its session cookie against. Missing or invalid: the proxy answers 503 to every request (fail closed). |
| `GatewayUrl` | `LIIVO_GATEWAY_URL` | string | no | no | Base URL of the Liivo Studio gateway: where a navigation without a session is redirected, where the git credential helper asks for a token and where the bridge is fetched. Missing: navigations answer 401, the helper returns no credentials and no bridge is fetched. |
| `ClaudeCodeOauthToken` | `CLAUDE_CODE_OAUTH_TOKEN` | string | no | yes | The tenant's Claude OAuth token, passed as a `{{secrets.x}}` reference. The literal `unset` (or empty) means the tenant has none. |
| `AnthropicApiKey` | `ANTHROPIC_API_KEY` | string | no | yes | The tenant's Anthropic API key, same rules. |

The option mapping rows for `HandoffKey`, `GatewayUrl`, `ClaudeCodeOauthToken`
and `AnthropicApiKey` are requested from the Supply team in
Eyevinn/agent-team-supply#306. Until they exist the image treats all four as
absent: the edit proxy fails closed (503) and no Claude credential is set.

The LLM proxy is dropped: `PROXY_URL` and `PROXY_TOKEN` are no longer read and
no longer map to `ANTHROPIC_BASE_URL` or `ANTHROPIC_AUTH_TOKEN`.

**Claude credentials are readable by code running in the workspace.** The
entrypoint exports `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` (each only
when it is non-empty and not the literal `unset`, otherwise it unsets it) into
the environment of the Coder agent, so the terminal, Claude Code and any project
process started from it inherit them. This is the same exposure an Agent Tasks
runner has for the same credential. The entrypoint never prints either value and
removes both from the environment of `.liivo/setup.sh` and `.liivo/start.sh`.

Whether the maker honours a sensitive flag on an option mapping, or whether
sensitivity is set in the catalog entry afterwards, was not verified. Check it
at import time: `AgentToken`, `HandoffKey`, `ClaudeCodeOauthToken` and
`AnthropicApiKey` must not be readable in plain text from the instance
description.

## Variables set by the platform

The orchestrator injects `OSC_HOSTNAME` only (osaas-lib-orchestrator
`containers.ts`, `k8s.ts`). It does not set `PORT`: the main container port is
fixed at 8080 (`name: http`) and the Service targets it. The image therefore sets
`ENV PORT=8080` and the entrypoint defaults `PORT` to 8080. The entrypoint uses
`OSC_HOSTNAME` for `LIIVO_EDIT_URL`.

## Order values to choose at import

- Persistent volume: the architecture note proposes a volume at `/home/coder`.
  Storage is per block (one size for every instance) and is deleted with the
  instance. If no volume is configured, the home directory is the image copy and
  everything is lost on restart.
- Memory: fixed per block, not per instance. Pick one size or import two blocks.
- `public-paths: ^/$` on the block's orchestrator (design D8): `/` is the only
  path that reaches the edit proxy without the OSC login gate, which is where the
  gateway's handoff lands. The edit proxy's own session check is the tenant
  boundary on every path. This is a deploy-manager setting applied after import,
  not part of this repo.

## Known platform limits

- No Docker engine in the workspace and no sudo. Instances cannot run privileged
  containers. Project dependencies (Postgres, Valkey) become separate OSC instances,
  or run as plain processes started through mise or `.liivo/start.sh`.
- Memory is fixed per block and CPU is not limited.
- Storage is lost when the instance is deleted. When an instance is suspended or
  restarted without a persistent volume, the checkout is cloned again from git on
  the next start, so uncommitted work is lost. Commit and push.
- The preview is served on the instance's own OSC hostname
  (`<name>.<serviceId>.auto.<env>.osaas.io`) by the preview forwarder (see
  "Preview forwarder and loopback contract" below). Whether the orchestrator
  needs a listener on `PORT` for the instance to count as ready is unverified.
- Credentials arrive only as environment variables from OSC secrets.

## Preview forwarder and loopback contract

`osc-entrypoint.sh` starts a small forwarder (`forwarder/preview-forwarder.js`,
installed at `/usr/local/lib/liivo/preview-forwarder.js`, `node:http` and
`node:net` only) on `0.0.0.0:$PORT`. It forwards every HTTP request and
WebSocket upgrade to `127.0.0.1:$PREVIEW_PORT`, answers 502 with a short page
when nothing listens on the preview port, and is restarted by a loop in the
entrypoint if it exits (backoff 1s doubling to 30s; exit code 2, a configuration
error, is not retried). It is started with a clean environment (`env -i` with
`PATH`, `HOME`, `PORT`, `PREVIEW_PORT`, `PROJECT_DIR`, `LIIVO_INSTANCE` and
`LIIVO_GATEWAY_URL`, none of them secret), so it never sees tokens. It is not started when
`PORT` (default 8080) equals `PREVIEW_PORT`. The handoff key is the one value it
needs that is secret: the entrypoint pipes it to the forwarder's stdin (the
forwarder reads it once at start), so it is in no environment block.

The forwarder passes `Host` through unchanged and drops `Forwarded`,
`X-Forwarded-*` and `X-Real-IP` from the request before forwarding, because the
caller can set them. The preview app sees no client address headers, must not
trust any such header, and never sees the `__Host-liivo` session cookie (it is
removed from the `Cookie` header; other cookies pass).

- `GET /__liivo/open` answers 302 to `/` (with a session; see below. The gateway
  links here so the browser passes the OSC gate on a gated path before an SPA's
  root loads).
- `GET /__liivo/status` is the status endpoint (see below).
- `POST /__liivo/bridge/reload` is the bridge reload (see "Bridge reload" below). It is the one
  exception to the 404 for `/__liivo/bridge/*`: it is handled before the session check, like
  `/__liivo/status`, so a browser, a page on the previewed origin and any request without a
  valid `aud` `gateway` token get 401.
- `GET` and `HEAD` requests under `/__liivo/` (the picker's `client.js`, its vendor file and
  `health`) go to the bridge on `127.0.0.1:4777`, after the session check (see "The bridge"
  below). Any other method answers 405 and is not forwarded.
- **The chat is not served on this origin (F2, N1).** `/__liivo/chat.html`, `chat.js`,
  `chat.css` and `inter.woff2` answer 404, session or not: the gateway serves the chat from
  its own origin. `/__liivo/ws`, the chat's WebSocket, answers **the gateway's bearer token
  only** (`Authorization: Bearer <aud gateway token>` for this instance, with the workspace's
  public host in its `host` claim): the edit-proxy session cookie is not a credential for it,
  with or without a matching `Origin`, because scripts of the previewed page ride that cookie.
  The upgrade goes to the bridge with `Host` and `Origin` set to that public host, and no
  `Authorization`, cookie or forwarded header. Every other `/__liivo/` upgrade is 404.
- Every other `/__liivo/bridge/*` path, `/__liivo/open/x`, `/__liivo/status/x`, `/__liivo/` and any
  target that is not already in plain form (percent-encoded, dot segments, a
  doubled slash, absolute-form, another letter case) are reserved and answer 404
  (with a session), whatever the bridge does.

## Edit proxy session (tenant boundary, design D8)

The OSC gate in front of the instance only proves "some signed-in OSC user", and
the cluster-internal address bypasses it. The forwarder is therefore the tenant
boundary: **every** request on **every** address needs its own session, `/` and
WebSocket upgrades included. The session starts only from a gateway handoff.

**Fail closed.** With `HANDOFF_KEY` missing or not 32 bytes of base64, every
request (also status and upgrades) answers 503 with a page saying the project
must be recreated, and the entrypoint and the forwarder log why. Nothing is
served unauthenticated. With `LIIVO_GATEWAY_URL` missing, navigations without a
session answer 401 instead of the redirect, and git credentials are unavailable.

**Token format** (shared with the gateway tickets G4, G6 and G8):
`v1.<payload>.<sig>`. `payload` is base64url of JSON
`{aud, host, tenant, user, instance, exp, nonce}`; `sig` is base64url of
HMAC-SHA256 under the 32 byte `HANDOFF_KEY` over the string `v1.<payload>`.
`aud` is `browser`, `gateway` or `git` (the proxy verifies these three; the
fourth, `bridge`, is only ever signed here and verified by the gateway, so a
bridge token opens nothing in the workspace); `exp` is Unix seconds; `nonce` is 16
random bytes in base64url. The signature is compared in constant time
(`crypto.timingSafeEqual`). There is no lookup table: the key is derived per
project by the gateway, so a token proves "signed for this project".

**Requirements on the gateway** (this image relies on them):

- The `HandoffKey` is derived per workspace (bound to the instance), never per
  tenant and never global, and is standard base64 of exactly 32 bytes.
- The token `host` is the bare lowercase hostname (no port, no scheme) that the
  browser sends as `Host`.
- The token `instance` equals the string this proxy uses in the redirect
  `/w/<instance>` (the first label of the instance's public host).
- Code running in the workspace can read its own key, so it can mint its own
  `git` token. The gateway must therefore select the verification key by the
  claimed `instance`, and must scope any GitHub token it returns to this
  project's repository only.

Defence in depth: once the workspace has learned its instance (from the first
verified handoff or status token, kept in `$HOME/.liivo/identity.json`), a
handoff or status token whose `instance` differs answers 401. The first
handoff teaches it.

**Without a valid session cookie:**

- a navigation (`GET` or `HEAD` with `Accept: text/html`), to any path, answers
  302 to `${LIIVO_GATEWAY_URL}/w/<instance>`;
- every other request, WebSocket upgrades included, answers 401.

**Handoff.** `GET /?__liivo=<token>` (path `/` exactly, one `__liivo`
parameter) is accepted when the token has `aud` `browser`, a `host` equal to the
request's `Host`, an `exp` that has not passed and is at most 60 s ahead, and a
nonce not seen before (kept in memory until the token's `exp`). It answers 302 to
`/__liivo/open` (a gated path, so the OSC gate's own round trip happens after the
handoff) and sets the cookie. A reused, expired, foreign-host, wrong-audience or
badly signed token answers 401. The token is never forwarded to the preview and
never logged.

**Session cookie:** `__Host-liivo=s1.<payload>.<sig>; Max-Age=43200; Path=/;
HttpOnly; Secure; SameSite=Lax` (no `Domain`, so it is host-only). `payload` is
base64url of `{tenant, user, instance, exp}` (the claims of the handoff token,
`exp` 12 hours ahead) and `sig` is HMAC-SHA256 under `HANDOFF_KEY` over
`s1.<payload>`. The `s1` prefix keeps a token from ever being a valid cookie and
the other way round. A request that can change state (anything but `GET` or
`HEAD`) or open a WebSocket and carries an `Origin` other than the request's own
host is refused with 401 even with a valid cookie, because a sibling
`*.osaas.io` app is the same site and `SameSite` does not stop it.

**Status.** `GET /__liivo/status` with `Authorization: Bearer <token aud=gateway>`
(not single use, `exp` at most 60 s ahead) answers 200 JSON
`{"checkout": bool, "clean": bool, "unpushed": number, "branch": string|null,
"bridge": {"version": string|null, "state": "running"|"starting"|"unavailable"}}`:
a git checkout exists in the project directory; the working tree has no
uncommitted or untracked files (with no checkout: the directory is empty);
commits not on the upstream branch (or on no remote when the branch has no
upstream); the current branch; the bridge's state as the supervisor last wrote it
to `$HOME/.liivo/bridge/state.json` (`unavailable` when the file is missing or not
a state: the file is on a volume project code can write, so it is validated).
`bridge` is additive: the gateway reads the named fields it knows. Without a valid
bearer: 401. If git itself fails: 500, never "clean".

**Git credential helper.** The image sets
`credential.https://github.com.helper` (system config) to
`forwarder/git-credential-liivo.js`. The entrypoint adds the same helper for the
project's managed-Gitea host (see "Managed-Gitea host" below). For `https://github.com`
and that host it asks the
forwarder, over a unix socket (`$HOME/.liivo/sign.sock`, mode 0600, so the key
never leaves the forwarder), for an `aud` `git` token (60 s, `tenant`, `user`,
`instance` as last learned from a verified handoff or status token and kept in
`$HOME/.liivo/identity.json`), calls `POST ${LIIVO_GATEWAY_URL}/api/git-token`
with `Authorization: Bearer <git token>` and returns the `token` it receives as
the password (user name `x-access-token`). If the gateway refuses, is
unreachable, or the tenant is not known yet, it returns nothing, git goes on
unauthenticated (public repositories still clone) and the helper writes one line
to stderr naming the cause. The token is never in a URL, argument, file or
environment variable. The tenant is learned from the first handoff or status
call, which reaches a new instance a moment after the entrypoint's first clone, so
a private repository fails that first attempt. The entrypoint therefore retries
the clone in the background (see "First clone and retry" below).

### Managed-Gitea host

When `REPO_URL` is `https://<tenant>-<tenant>git.go-gitea-gitea.auto.<env>.osaas.io/...`
(https, no user name or password, no port, the tenant part repeated, compared in lower
case), the entrypoint writes
`git config --global credential.https://<host>.helper '!node <lib>/git-credential-liivo.js --host=<host>'`
before the first clone, and passes the host to the bridge as `LIIVO_GIT_HOST`. The
helper answers exactly like for `github.com` (user name `x-access-token`), for that
host only: the `host` attribute is compared exactly and case-insensitively, so
another managed-Gitea host, an unrelated host, a port or a suffix gets no output and
no gateway call. The entry is rewritten at every start (one entry after any number of
starts) and an entry for another host left by an earlier start is removed. Any other
`REPO_URL` writes no entry and the bridge gets no `LIIVO_GIT_HOST`, so a public
repository on any other host clones unauthenticated. If the config write fails the
entrypoint logs one `WARNING` and goes on; the clone then runs unauthenticated. Until
the gateway answers for a Gitea project (404), git goes on unauthenticated.

### First clone and retry

The entrypoint clones `REPO_URL` into the project directory once, only when that
directory has no checkout and no files. When that first attempt fails it logs one
line naming the cause and retries in the background after 5, 10, 20 and 40 s, then
every 60 s, until the clone succeeds or 10 minutes have passed since the first
failure. Every attempt is one sequential step,
so two clones never run at once; an attempt is skipped, and the retry ends, as soon
as the directory holds a checkout or any file; a failed attempt removes only what it
created (the directory it made, or the files it put into the empty directory it
found). Every attempt is logged in `~/liivo-clone.log` with its time and in the
entrypoint log with its cause (the tenant is not known yet, authentication failed,
repository not found, invalid URL, timed out). The cause is read from that
attempt's own output, so an attempt that names no cause says "see
`~/liivo-clone.log`" and never repeats an earlier attempt's cause. A permanent
failure is retried the same way, so the log says why. The URL is masked in the
log.

Every attempt, the first one and each retry, runs under a time limit of 120 s. A git
that does not stop at the limit is killed 10 s later. An attempt stopped this way
counts as a failed attempt: `~/liivo-clone.log` records that it timed out after N s,
the entrypoint log gives "timed out after Ns" as its cause, and the retry goes on
as usual. The first attempt runs before the agent starts, so a hung first attempt
delays the agent by at most the limit plus the 10 s. The hooks start no later than
the retry budget, plus one steady delay (60 s), plus the limit, plus the 10 s after
the first failure. A failed attempt that git ended by the time limit or by a signal
owns what it left, so it also removes a partial `.git` from the empty directory. An
attempt that exited by itself and left a `.git/HEAD` leaves the directory alone,
because that can be a checkout made by hand; the retry then ends with "no longer
empty, not cloning". A clone that needs more than the limit never finishes through
the retry, because git starts from zero on every attempt; clone it by hand in that
case. When the clone succeeds,
`~/.liivo/project-cloned` is written. `.liivo/setup.sh` and `.liivo/start.sh` run
after the clone succeeded or the budget is spent, never against an empty directory
while a retry is pending; the agent and the edit proxy start at once and do not
wait. If the repository is still unreachable after the budget, restart the
workspace or run `git clone` or `git pull` by hand. The delays and budget can be
changed with `LIIVO_CLONE_RETRY_DELAYS`, `LIIVO_CLONE_RETRY_STEADY` and
`LIIVO_CLONE_RETRY_BUDGET` (seconds; used by the tests). The time limit is
`LIIVO_CLONE_TIMEOUT` (default 120) and the grace before the kill is
`LIIVO_CLONE_KILL_GRACE` (default 10), both in seconds. They are variables of the
entrypoint, not options in the maker order.

**Default start (a repository without `.liivo/start.sh`).**

When the repository has no `.liivo/start.sh`, the entrypoint runs `default-start.js`
(installed as `/usr/local/lib/liivo/default-start.js`, mode 755, Node built-ins only)
through the same `setsid` wrapper as an own start.sh, so `/tmp/liivo-start-<dir>.pid`
holds its group leader from the first moment and install, build and the dev server are
in that group. A repository's own `.liivo/start.sh` always wins (any file, executable
or not): nothing of the default runs, the state file is never read, the page is the
unchanged one. Nothing is generated into the repository.

- **Detection.** `package.json` in the root; the script is `scripts.dev`, else
  `scripts.start`. Neither (or no or invalid `package.json`): nothing starts and the
  state is `none` with the reason. Lockfile order: `pnpm-lock.yaml` (pnpm), `yarn.lock`
  (yarn), `package-lock.json` or `npm-shrinkwrap.json` (npm), none (npm). With several,
  the first wins and the log names the others. Only a bun lockfile: `failed`, add
  `.liivo/start.sh`. Other stacks and monorepo workspaces are out of scope.
- **Install never writes a tracked file.** npm `ci`; pnpm `install --frozen-lockfile`;
  yarn `install --frozen-lockfile` (yarn 1) or `--immutable` (yarn 2 and later, read
  from `yarn --version`); no lockfile: `npm install --no-package-lock`. A frozen install
  that fails is a failure, never retried with a lockfile-writing install. The install
  runs when there is no record, the lockfile hash (of `package.json` without a lockfile)
  differs from the record in `~/.liivo/default-start-<dir>.install`, or `node_modules`
  is missing. A failed, stopped or timed-out install records nothing.
- **Clean tree.** When git does not ignore `node_modules`, `/node_modules/` is added to
  `.git/info/exclude` (local, never committed) before the install, because the bridge
  commits with `git add -A`.
- **Build.** When the script is `start` and `package.json` has `build`, `build` runs
  before `start` on every start. `dev` never builds.
- **Port and host.** The port is `LIIVO_PREVIEW_PORT` (not `LIIVO_PORT`). Every script
  gets `PORT=<port>` and `HOST=127.0.0.1`. A single `next dev`, `next start`, `vite`,
  `vite dev`, `vite serve` or `vite preview` script also gets `-H 127.0.0.1 -p <port>`
  or `--host 127.0.0.1 --port <port> --strictPort` appended once (npm passes them after
  `--`). A compound command or a script with its own host or port flag gets only the
  environment and one log line.
- **Limits** (entrypoint variables, not maker options): `LIIVO_DEFAULT_INSTALL_TIMEOUT`
  (900 s, shared by install and build), `LIIVO_DEFAULT_START_TIMEOUT` (300 s until the
  port accepts a connection), `LIIVO_DEFAULT_KILL_GRACE` (10 s between SIGTERM and
  SIGKILL). A limit that fires stops the work it timed.
- **Log and state.** Output and one `=== <UTC time> default start: <step and command>`
  line per step go to `/tmp/liivo-start-<dir>.log`; `~/liivo-run.log` names that file.
  `/tmp/liivo-start-<dir>.state` is JSON `{"state","reason"}` with state `installing`,
  `starting`, `running`, `failed` or `none`. A SIGTERM (a bridge restart) writes nothing.
  The entrypoint removes a leftover state file at start.
- **Page.** While installing or starting, the 502 page is a centered waiting page with a
  CSS-only spinner and the heading "Almost ready", the chat tag, and a reload every 4 s.
  Nothing from the state file is rendered on the waiting page. When the state is failed or
  none, the "Preview not running" page keeps its title, heading and chat tag and gets one
  status line (for failed the reason and the log path). With no state, an untrusted state
  file, a running state or a repository's own start.sh, the page is unchanged. The state
  file is untrusted input: a regular file below 2 KiB, a known state, an escaped and
  capped reason, no log content.
- **Refresh restart.** The entrypoint passes `LIIVO_DEFAULT_START` (the installed path)
  to the bridge. Until the bridge in Eyevinn/liivo-studio uses it, a refresh does not
  restart a default-started dev server (Next.js and Vite hot-reload), and a lockfile
  changed by a refresh is installed at the next workspace start.

**Bridge token.** The same socket answers `POST /bridge-token` with an `aud`
`bridge` token that lives 45 s (the browser tokens' slack for clock skew) and the
gateway URL, for the bridge fetcher only. Both routes answer 409 until the tenant
is known.

**Contract for a project's dev server:** bind to `127.0.0.1:$PREVIEW_PORT`, not
to `0.0.0.0`. The entrypoint exports `HOST=127.0.0.1` for `.liivo/setup.sh` and
`.liivo/start.sh`, which many tools honour. Flags for common servers:

- Vite: `vite --host 127.0.0.1 --port "$PREVIEW_PORT"`
- Next.js: `next dev -H 127.0.0.1 -p "$PREVIEW_PORT"`

The forwarder must be the only listener on a non-loopback address in the
instance. Check with `ss -ltn` (or `/proc/net/tcp`).

The entrypoint also sets `CODER_AGENT_DEVCONTAINERS_ENABLE=false`: the instance
has no Docker engine, and the agent's devcontainer detection otherwise logs
`docker: command not found` in a loop.

Tests: `node --test 'forwarder/*.test.js' 'test/*.test.js'` (the second pattern
runs the real `osc-entrypoint.sh` against a stub `coder`) and
`shellcheck osc-entrypoint.sh`.

## The bridge (chat and element picker, amendment 6)

The chat with Claude and the element picker in the previewed page come from the
**bridge**, a Node process the workspace fetches from the Liivo Studio gateway at
every start. Its source stays in the private `Eyevinn/liivo-studio` (`bridge/`); the
gateway image carries it as one tarball whose version is the gateway's build.

- **Port and reach.** The bridge listens on `127.0.0.1:4777` (`LIIVO_BRIDGE_PORT`),
  loopback only. The edit proxy forwards `GET`/`HEAD` and WebSocket requests under
  `/__liivo/` to it after its session check, and injects
  `<script src="/__liivo/client.js" defer>` into HTML page navigations. The bridge's
  `POST /preview` (Claude's own preview tools) is never forwarded.
- **Fetch** (`forwarder/bridge-fetch.js`, run by the supervisor in the entrypoint).
  It polls the signer (`POST /bridge-token`) every 2 s while it answers 409 (the
  gateway has not yet told the workspace who it belongs to), then reads
  `GET ${LIIVO_GATEWAY_URL}/api/bridge/manifest` (`{protocol, version, sha256, size}`,
  `protocol` 1 only, `size` at most 20 MiB). The tarball is reused from
  `~/.liivo/bridge/<version>.tgz` when its sha256 is the manifest's, else downloaded
  with a fresh token, cut off at the manifest's size, hashed while it is read and
  compared before it is stored. Every member is checked before anything is extracted
  (only `package/...`, no `..`, no absolute path, no link or device), the archive is
  extracted into a fresh directory, `VERSION.json` must name the same version, and
  `~/.liivo/bridge/current` points at it. The two newest tarballs are kept. **A file
  whose sha256 did not match is never extracted and never run.** The gateway is
  reached over https only.
- **Failure behaviour.** The gateway refusing (401, 429, any 503, another protocol, a
  bad manifest, a failed download) or not answering: the newest cached tarball whose
  recorded hash still matches its bytes runs, else the fetcher exits 3 and the
  supervisor tries again after 5, 10, 20, 40, then 60 s. While there is no bridge the
  page's script is a small placeholder ("Chatten startar…", which polls
  `/__liivo/health` and reloads once when the bridge answers, and after five minutes
  says that the preview works without the chat), `/__liivo/health` answers 503
  `{"bridge":"starting"}` and every other bridge path 503. The preview itself is
  never affected. A bridge that exits after running 60 s or longer is restarted from the cached copy after 1 to 30 s (doubling). A bridge that exits within 60 s of starting is not restarted from the cache: after the same wait the supervisor fetches the current bridge again (one more gateway request per quick exit, at the 1 to 30 s cadence), so a bad cached version is replaced.
- **Supervisor.** The clone, the hooks and `exec coder agent` never wait for it. The
  fetcher runs under `env -i` with `PATH`, `HOME` and `LANG` only. The
  bridge runs under `env -i` with `PATH`, `HOME`, `LANG`, `LIIVO_REPO_DIR`,
  `LIIVO_PREVIEW_PORT`, `LIIVO_GATEWAY_URL`, `LIIVO_INSTANCE`, `OSC_HOSTNAME`,
  `LIIVO_PREVIEW_URL` (the workspace's own public address), `LIIVO_BRIDGE_PORT`,
  `DISABLE_UPDATES=1`, `DISABLE_AUTOUPDATER=1` and the tenant's Claude credential
  (`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`, whichever it has) and nothing
  else: no `HANDOFF_KEY`, no `CODER_AGENT_*`, no other secret. `state.json` (state and
  version) and `running.json` (version, pid, start time) are written in
  `~/.liivo/bridge/`; `/__liivo/status` reports the state.
- **Bridge reload.** `POST /__liivo/bridge/reload` with `Authorization: Bearer <token
  aud=gateway>` (same token, instance check and `learn` as `/__liivo/status`; any other
  method with a valid token answers 405 `Allow: POST`; a WebSocket upgrade to the path is
  not answered by the route). It is honoured only when the bridge is idle (no Claude turn
  running and no pending permission request, which is `busy === false`):
  - The forwarder reads `GET http://127.0.0.1:4777/health` once (deadline 2 s, under the
    gateway's 5 s abort). 200 JSON with boolean `busy === false` is honoured: it writes the
    request file `~/.liivo/bridge/reload-request` (mode 0600, atomic rename, only its
    existence is read) and answers `202 {"reload":"started"}` at once, never waiting for the
    stop or the fetch. `busy === true` answers `409 {"reload":"refused","reason":"busy"}`.
    A 200 without a boolean `busy`, a non-200, a body that is not JSON, a request file
    that cannot be written: `409 {"reload":"refused","reason":"unknown"}`. A refusal
    changes nothing (no file, no signal, no fetch). 2xx means "recorded", not "the supervisor
    is alive"; the gateway (Eyevinn/liivo-studio#48) reads the status class only.
  - No answer from the bridge at all (refused, timeout) follows `state.json`: `starting`
    (the bridge exited, the supervisor will restart the cached one after a run of 60 s or more, or fetch the current one after a quick exit) is honoured, `running` (a
    live process that does not answer may be mid-turn) and `unavailable` are refused with
    reason `unknown`.
  - The supervisor polls once a second while the bridge runs. With a request present it reads
    the same `/health` itself (curl and jq, 2 s) right before it signals and sends SIGTERM to the
    bridge it started (never a pid from a file) only on a 200 JSON answer with boolean
    `busy === false`. Anything else (busy, no answer, non-200, malformed) keeps the request and
    touches nothing. The stop is not a crash: the 1 to 30 s restart wait and its doubling are
    untouched, no "restarting in" log. The fetcher then runs again so `current` points at the
    gateway's current version and that bridge starts (`state.json` is `starting` meanwhile, then
    `running` with the new version). A fetch that fails falls back as it always does (the newest
    verified cached bridge, or none and the 5 to 60 s backoff with state `unavailable`).
  - A request that exists when the supervisor leaves its restart wait after an exit makes the
    next step a fetch instead of a restart of the cached bridge. A request written during a fetch is
    satisfied by that fetch. No `/health` read is made when no bridge runs.
  - The entrypoint deletes any request file left on the volume before the supervisor starts. A
    request that the supervisor keeps (busy bridge) is deleted without acting once it is
    older than 300 s (`RELOAD_MAX_AGE` in `osc-entrypoint.sh`), so a request recorded during a long
    turn cannot reload the bridge at a much later idle moment; the gateway asks again at a
    later open (its own throttle, 10 minutes).
  - **What an idle read cannot see.** The interval between the supervisor's last read and the
    delivery of the signal; the bridge's change operations, which run with `busy` false (the
    commit and push after each turn, "Skicka in" and "Släng"), which is the typical case
    for a kept request's first idle read; and `refreshRepos` (its `update.sh` hook and `startRepo`).
    A SIGTERM cuts each of them. The drain that closes this lives in the bridge: Eyevinn/liivo-studio
    "Bridge: on SIGTERM wait for the work in flight (running turn, change operation, refreshRepos)
    before exiting" (#52), not here.
  - The same uid can write the request file, but it can only start a reload of a bridge that the
    supervisor reads as idle, which that code could already cause by killing the bridge.
- **`.liivo/start.sh`.** The entrypoint runs it as the leader of its own process
  group and writes its id to `/tmp/liivo-start-<project dir name>.pid`, which is how
  the bridge stops and restarts it after it moved the checkout to newer code.
- **Git author.** The image sets `LIIVO_GIT_AUTHOR_NAME=Liivo Studio` and
  `LIIVO_GIT_AUTHOR_EMAIL=noreply@liivo.ai`. When `git config --global user.email` is
  empty the entrypoint sets `user.name` and `user.email` from them; an identity the
  home volume already has is left alone. The bridge commits after every turn, which
  fails without an author.
- **Claude Code** is installed pinned (`ARG CLAUDE_CODE_VERSION` in `Dockerfile.osc`,
  at least 2.1.259; the bridge's flags are coupled to the version) and the bridge
  starts it with updates switched off. The binary is seeded into the home volume
  once: **a seeded home volume keeps its binary until a fresh volume** (a resumed or
  a new project), so a new pin reaches existing workspaces only then.
- **Secrecy.** "Private" means **private from the internet, not from tenant users.**
  Every Studio workspace receives the full, unminified bridge source on its home
  volume. Claude's tools, the project's scripts and any tenant member who reveals the
  project's `HandoffKey` service secret can read or download it. Nobody without a
  Studio project row can download it from the gateway. Do not put anything in
  `bridge/` that must stay secret from customers.
- **Origin of the chat.** The chat is served by the gateway on its own origin and its
  WebSocket is relayed by the gateway with its bearer token (F2, closes amendment 6 N1 for
  scripts in the previewed page, which no longer share the chat's origin and hold no
  credential for its socket). The same uid in the workspace can still reach the bridge's
  loopback port and its files.

## Project parameter store values (`liivo-env`)

`/usr/local/bin/liivo-env <command> [args]` runs the command with the values of the project's parameter store
added to its environment, on top of the environment it was called with, and replaces itself with the command
(`exec`: same pid, so the bridge's pid-file restart contract holds; the exit status is the command's). The
entrypoint runs `.liivo/setup.sh`, `.liivo/start.sh` and the default start through it, after the agent
variables and the Claude pair are unset. It is a no-op when the project has no store.

- **Flow.** `forwarder/liivo-env.js` asks the signer (`POST /env-token` on `~/.liivo/sign.sock`, audience `env`,
  60 s like `git`) for a token and calls `GET {LIIVO_GATEWAY_URL}/api/project-env` with it. 200 `{ "bound": false }`
  means no store; 200 `{ "bound": true, "store", "values", "skipped" }` carries the values; any other status with a
  `reason` means start without values. `auth.js` `AUDIENCES` is not widened: the forwarder refuses an `env` token,
  only the gateway verifies it.
- **No parsing by a shell.** The helper prints NUL-separated `NAME=value` records and the wrapper exports each
  with `export -- "$record"`. No value reaches `eval`, `source` or a shell for parsing.
- **Names and limits.** A name must match `^[A-Za-z_][A-Za-z0-9_]*$` and must not be reserved (the list is in
  `forwarder/liivo-env.js`, compared case-insensitively; `NODE_ENV`, `NODE_NO_WARNINGS`, `LANG`, `LC_*`, `TERM`, `TZ`,
  `DEBUG`, `CI`, `UV_THREADPOOL_SIZE` and `UV_USE_IO_URING` stay allowed). A value with a NUL, a value over 32 KiB,
  more than 100 names or more than 128 KiB in total is skipped by name with a reason. The command keeps the value
  it was called with for a reserved name. These limits are the single source of truth; the gateway is never stricter.
- **Fail soft.** Gateway unreachable, a non-200, a malformed body, `bound: false`, a rate refusal (its reason is
  recorded), no `LIIVO_GATEWAY_URL` or no signer: the command runs with the environment it was called with. The
  gateway request is bounded by `LIIVO_ENV_TIMEOUT` (10 s). While the signer answers 409 (no handoff or status call
  has reached the workspace yet) the helper polls every 2 s up to `LIIVO_ENV_TENANT_WAIT` seconds (300), then runs the
  command without values and records `tenant_unknown`. A missing signer socket is waited out for
  `LIIVO_ENV_SIGNER_WAIT` seconds (15), then `no_signer`. When setup.sh's load ended with `tenant_unknown` the
  entrypoint does not write the setup marker, so setup.sh runs again, with values, on the next start.
- **Status.** Each run writes `/tmp/liivo-env.state` (mode 0600, JSON `{time, store, loaded, skipped, error}`),
  names and reasons only, never a value, and nothing else to disk. The entrypoint removes a leftover file at start.
  The only output is one line on stderr with the store name and counts (nothing when the project has no store).
  Nothing is written into `$PROJECT_DIR`.
- **Residuals.** Every process in the workspace can read the values (same uid). Under Q3 a value printed by a command
  Claude runs (`liivo-env <cmd>`, `liivo-env env`) reaches Claude's context, the model provider and Claude Code's
  session transcript under `~/.claude` in the workspace (`claude` runs with `--resume`, `bridge/claude.mjs` 66); the
  bridge's redaction covers only browser-bound text and the chat history file. A store writer controls every
  non-reserved name. A value shorter than 8 characters is neither redacted nor caught by the commit guard. A tool not
  on the reserved list that reads its configuration, a wrapper command or a download mirror from the environment can
  still be steered by a store writer. Project output redirected to `~/liivo-run.log` and `/tmp/liivo-start-<dir>.log`
  can hold any value the project prints.

## Security notes

- The entrypoint removes `CODER_AGENT_TOKEN`, `CODER_AGENT_URL` and
  `CODER_AGENT_AUTH` from the environment of `.liivo/setup.sh` and
  `.liivo/start.sh`, so the hooks do not inherit them. This is hygiene, not
  isolation: the hooks run as the same uid (1000) as the Coder agent, so a hook
  can read the agent's `/proc/<pid>/environ` and get the token. The image has no
  sudo and runs as uid 1000, so the entrypoint cannot run the hooks as another
  uid. The token only grants access to this one workspace's agent endpoints, and
  the hooks are the workspace owner's own repo code. Writing the token to a file
  would not help, since the same uid can read it too.
- Do not embed credentials in `RepoUrl`. The entrypoint masks the userinfo part
  when it logs the URL, but the full URL is still passed to `git clone`, stored
  in the checkout's `.git/config` as the `origin` remote and visible in the
  instance options. Private repositories use the git credential helper above.
- `HANDOFF_KEY` is removed from the environment of the Coder agent and of every
  process it starts, and reaches the forwarder only on stdin. It is still in the
  original environment block of every process forked from the entrypoint's bash
  (the forwarder restart-loop subshell, the bridge supervisor subshell and the hooks subshell), PID 1 (tini)
  included: bash's `unset` does not rewrite the initial environ block that
  `/proc/<pid>/environ` reads, and code running as the same uid can read it
  there. So this is hygiene and not isolation either. What that code could do with the key it can already
  do (open its own workspace, ask for its own repository token); other
  workspaces use other keys, and members of the same tenant who can reveal
  service secrets can read the key (the OSC trust model for any instance).
