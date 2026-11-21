#!/bin/bash
# OSC entrypoint for the Liivo Studio workspace block.
# Maps OSC option variables to what the workspace needs, prepares the project
# checkout, then runs the Coder agent. Secret values are never printed.
set -eu

log() { echo "osc-entrypoint: $*" >&2; }
die() { log "ERROR: $*"; exit 1; }

# The agent cannot start without these. They are instance options (the token is
# a service secret), so a missing value means the instance was created wrong.
[ -n "${CODER_AGENT_URL:-}" ] || die "CODER_AGENT_URL is required (instance option AgentUrl: the public URL of the Coder instance)"
[ -n "${CODER_AGENT_TOKEN:-}" ] || die "CODER_AGENT_TOKEN is required (instance option AgentToken: the Coder agent token, normally a {{secrets.x}} reference)"

HOME="${HOME:-/home/coder}"
export HOME
PROJECT_DIR="${PROJECT_DIR:-$HOME/project}"
PREVIEW_PORT="${PREVIEW_PORT:-3000}"
case "$PREVIEW_PORT" in
  ''|*[!0-9]*) die "PREVIEW_PORT must be a number, got '$PREVIEW_PORT'" ;;
esac
[ "$PREVIEW_PORT" -ge 1 ] && [ "$PREVIEW_PORT" -le 65535 ] || die "PREVIEW_PORT out of range: $PREVIEW_PORT"

# Token auth for the agent, and the variables Liivo tooling in the project reads.
export CODER_AGENT_AUTH="${CODER_AGENT_AUTH:-token}"
export LIIVO_REPO_DIR="$PROJECT_DIR"
export LIIVO_PREVIEW_PORT="$PREVIEW_PORT"
if [ -n "${OSC_HOSTNAME:-}" ]; then
  export LIIVO_EDIT_URL="https://${OSC_HOSTNAME}"
fi

# Claude Code reads its credential from its own environment. The platform passes
# the tenant's credential as the options ClaudeCodeOauthToken and AnthropicApiKey
# (the Agent Tasks mechanism). The credential type the tenant does not have
# arrives as the literal "unset" (or empty). Never print either value. Code
# running in the workspace can read them (docs/block.md).
for claude_var in CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY; do
  claude_val="${!claude_var:-}"
  if [ -n "$claude_val" ] && [ "$claude_val" != "unset" ]; then
    export "${claude_var?}"
  else
    unset "$claude_var"
  fi
done
unset claude_var claude_val

# Edit proxy key (option HandoffKey): base64 of 32 bytes, read here once and
# unset, so the coder agent and everything it starts never inherit it. It
# reaches the edit proxy on stdin only (see below). A missing or malformed key
# is not fatal: the proxy then refuses every request with 503 (fail closed).
handoff_key="${HANDOFF_KEY:-}"
unset HANDOFF_KEY
if [ -z "$handoff_key" ]; then
  log "WARNING: HANDOFF_KEY is not set (option HandoffKey): the edit proxy answers 503 to every request until the project is recreated"
elif [ "$(printf '%s' "$handoff_key" | base64 -d 2>/dev/null | wc -c | tr -d ' ')" != "32" ]; then
  log "WARNING: HANDOFF_KEY is not 32 bytes of base64: the edit proxy answers 503 to every request until the project is recreated"
  handoff_key=""
fi
# The instance name is the first label of the public host. Only used for the
# redirect to the gateway before any handoff has told the proxy better.
osc_host="${OSC_HOSTNAME:-}"
LIIVO_INSTANCE="${osc_host%%.*}"

# The home directory may be an empty volume: seed it from the image once.
[ -w "$HOME" ] || die "$HOME is not writable by uid $(id -u)"
if [ ! -f "$HOME/.liivo-seeded" ] && [ -d /opt/home-skel ]; then
  # Copy the skeleton's children, not "/opt/home-skel/.": cp -a on "." tries to set the timestamps
  # and mode of the mounted volume root, which a non-owner cannot do (EPERM, the instance crash-loops).
  shopt -s dotglob nullglob
  cp -a --update=none /opt/home-skel/* "$HOME/"
  shopt -u dotglob nullglob
  touch "$HOME/.liivo-seeded"
fi
mkdir -p "$HOME/.liivo"
chmod 700 "$HOME/.liivo" 2>/dev/null || true

# Git author. The image configures none, and the bridge commits after every turn (a commit without an
# author fails). An identity the home volume already has is left alone: it is tested by the email, which
# is what git refuses to commit without. The values are image ENV (Dockerfile.osc).
if [ -z "$(git config --global user.email 2>/dev/null || true)" ]; then
  if [ -n "${LIIVO_GIT_AUTHOR_NAME:-}" ] && [ -n "${LIIVO_GIT_AUTHOR_EMAIL:-}" ]; then
    if git config --global user.name "$LIIVO_GIT_AUTHOR_NAME" && git config --global user.email "$LIIVO_GIT_AUTHOR_EMAIL"; then
      log "git author set to $LIIVO_GIT_AUTHOR_NAME"
    else
      log "WARNING: could not set the git author"
    fi
  else
    log "WARNING: no git author is configured and LIIVO_GIT_AUTHOR_NAME / LIIVO_GIT_AUTHOR_EMAIL are not set: commits in the workspace will fail"
  fi
fi

# The bridge (amendment 6): fetched from the gateway at every start, verified, cached under
# ~/.liivo/bridge and run by the supervisor below. The supervisor writes its state to state.json,
# which the edit proxy reports in /__liivo/status; the file is written before the proxy starts so a
# state left on the volume by an earlier run is never reported.
BRIDGE_DIR="$HOME/.liivo/bridge"
BRIDGE_PORT=4777
mkdir -p "$BRIDGE_DIR"
write_bridge_state() {
  local tmp="$BRIDGE_DIR/.state.$$"
  case "${2:-}" in
    '') printf '{"state":"%s","version":null}\n' "$1" > "$tmp" ;;
    *) printf '{"state":"%s","version":"%s"}\n' "$1" "$2" > "$tmp" ;;
  esac
  mv -f "$tmp" "$BRIDGE_DIR/state.json"
}
write_bridge_state starting
# A reload request recorded before this start (by the forwarder, for the bridge of an earlier run) is never acted on.
RELOAD_REQUEST="$BRIDGE_DIR/reload-request"
rm -f "$RELOAD_REQUEST"

# Edit proxy and preview forwarder on PORT. It is the tenant boundary: every
# request needs its own session (docs/block.md). It forwards to
# 127.0.0.1:$PREVIEW_PORT and is restarted by the loop if it exits. It starts
# before the clone so the git credential helper can reach its signing socket.
# It gets a clean environment (no tokens) and the handoff key on stdin, so the
# key is in no environment block that project processes could inherit.
LIB_DIR="${LIIVO_LIB_DIR:-/usr/local/lib/liivo}"
FORWARDER="$LIB_DIR/preview-forwarder.js"
FETCHER="$LIB_DIR/bridge-fetch.js"
# The default start for a repository without .liivo/start.sh (see run_hooks).
DEFAULT_START="$LIB_DIR/default-start.js"

# Git credential helper for the project's managed-Gitea host (Eyevinn/liivo-studio#62). The image
# configures the helper for github.com only (system config, build time); the Gitea host is known here.
# REPO_URL qualifies only when it is https, has no userinfo or port and its host is exactly
# <tenant>-<tenant>git.go-gitea-gitea.auto.<env>.osaas.io; that strict match is the only text that ever
# reaches the shell snippet git runs. An entry left by an earlier start for another host is removed, so
# one entry remains after any number of starts. Everything runs in `if` context because of `set -eu`.
git_helper_set() {
  local host="$1" key
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    [ "$key" = "credential.https://$host.helper" ] || git config --global --unset-all "$key" || return 1
  done < <(git config --global --name-only --get-regexp '^credential\.https://.*\.helper$' '/git-credential-liivo\.js --host=' 2> /dev/null || true)
  git config --global "credential.https://$host.helper" "!node $LIB_DIR/git-credential-liivo.js --host=$host"
}
GIT_HELPER_HOST=""
repo_lc="$(printf '%s' "${REPO_URL:-}" | tr '[:upper:]' '[:lower:]')"
if [[ "$repo_lc" =~ ^https://([a-z0-9]+)-([a-z0-9]+)git\.go-gitea-gitea\.auto\.[a-z0-9-]+\.osaas\.io(/|$) ]] \
  && [ "${BASH_REMATCH[1]}" = "${BASH_REMATCH[2]}" ]; then
  GIT_HELPER_HOST="${repo_lc#https://}"
  GIT_HELPER_HOST="${GIT_HELPER_HOST%%/*}"
fi
if [ -n "$GIT_HELPER_HOST" ]; then
  if git_helper_set "$GIT_HELPER_HOST"; then
    log "git credential helper configured for $GIT_HELPER_HOST"
  else
    log "WARNING: could not configure the git credential helper for $GIT_HELPER_HOST: the clone runs unauthenticated"
    GIT_HELPER_HOST=""
  fi
fi
forwarder_started=""
# The orchestrator does not set PORT: the instance's container port is fixed at 8080.
PORT="${PORT:-8080}"
if [ "$PORT" = "$PREVIEW_PORT" ]; then
  log "WARNING: PORT equals PREVIEW_PORT ($PORT), preview forwarder not started"
elif [ ! -f "$FORWARDER" ]; then
  log "WARNING: $FORWARDER not found, preview forwarder not started"
else
  (
    delay=1
    while true; do
      rc=0
      printf '%s' "$handoff_key" | env -i PATH="$PATH" HOME="$HOME" PORT="$PORT" PREVIEW_PORT="$PREVIEW_PORT" \
        PROJECT_DIR="$PROJECT_DIR" LIIVO_INSTANCE="$LIIVO_INSTANCE" LIIVO_GATEWAY_URL="${LIIVO_GATEWAY_URL:-}" \
        LIIVO_BRIDGE_PORT="$BRIDGE_PORT" \
        node "$FORWARDER" || rc=$?
      if [ "$rc" -eq 2 ]; then
        echo "osc-entrypoint: preview forwarder has a configuration error (exit 2), not restarting" >&2
        break
      fi
      echo "osc-entrypoint: preview forwarder exited ($rc), restarting in ${delay}s" >&2
      sleep "$delay"
      delay=$((delay * 2))
      [ "$delay" -le 30 ] || delay=30
    done
  ) < /dev/null &
  log "preview forwarder on port $PORT -> 127.0.0.1:$PREVIEW_PORT"
  forwarder_started=1
fi
unset handoff_key

# Bridge supervisor, in the background so the clone, the hooks and `exec coder agent` below are never
# delayed. bridge-fetch.js waits for the edit proxy's signer (409 until the gateway has told the
# workspace who it belongs to), fetches and verifies the bridge and prints its version (exit 3: no
# verified bridge now; exit 2: it cannot work at all). The bridge runs with `env -i` and the list
# below only: the Claude credential it needs, and nothing of the agent (no HANDOFF_KEY, no
# CODER_AGENT_*) or of the other secrets. A gateway failure backs off 5, 10, 20, 40, then 60 s; the
# bridge restarts after 1 to 30 s. The tenant's project code runs as the same uid and can reach the
# bridge's files and loopback port; docs/block.md says so.
# Reload (POST /__liivo/bridge/reload, recorded by the forwarder as $RELOAD_REQUEST, only its existence is read):
# while the bridge runs the supervisor polls once a second, reads the bridge's loopback /health itself and stops
# the bridge it started (SIGTERM, never a pid from a file) only on a 200 answer with boolean busy=false. Any other
# answer keeps the request; a request older than RELOAD_MAX_AGE seconds is deleted without acting. A stop for a
# reload is not a crash (run_delay untouched) and the fetcher runs again so the gateway's current version starts.
RELOAD_MAX_AGE=300
bridge_idle() {
  local body
  # No answer (curl fails, or says nothing) is never idle. jq -e alone would exit 0 on empty input.
  body="$(curl -fsS -m 2 "http://127.0.0.1:$BRIDGE_PORT/health" 2> /dev/null)" || return 1
  [ -n "$body" ] || return 1
  printf '%s' "$body" | jq -e '(.busy | type) == "boolean" and .busy == false' > /dev/null 2>&1
}
reload_expired() {
  local mtime
  mtime="$(stat -c %Y "$RELOAD_REQUEST" 2> /dev/null)" || return 1
  [ $(($(date +%s) - mtime)) -gt "$RELOAD_MAX_AGE" ]
}
supervise_bridge() {
  local gw_delay=5 run_delay=1 rc version started bpid reloaded ran quick
  local -a bridge_env
  # A fifo nothing writes to: `read -t 1` on it is a one second wait that is not a `sleep` call.
  mkfifo "$BRIDGE_DIR/.tick" && exec 9<> "$BRIDGE_DIR/.tick" && rm -f "$BRIDGE_DIR/.tick"
  while true; do
    rc=0
    # env -i: the fetcher needs only PATH (node, tar) and HOME (the signer socket and the cache); it gets
    # none of the agent's or the Claude credential's variables.
    version="$(env -i PATH="$PATH" HOME="$HOME" LANG="${LANG:-C.UTF-8}" node "$FETCHER")" || rc=$?
    # A request recorded while the fetch ran is satisfied by it.
    rm -f "$RELOAD_REQUEST"
    case "$version" in
      '' | *[!A-Za-z0-9._-]*) [ "$rc" -ne 0 ] || rc=3 ;;
    esac
    if [ "$rc" -eq 2 ]; then
      log "bridge fetcher has a configuration error (exit 2), not restarting"
      write_bridge_state unavailable
      return 0
    fi
    if [ "$rc" -ne 0 ]; then
      write_bridge_state unavailable
      log "no verified bridge (fetcher exit $rc), trying again in ${gw_delay}s"
      sleep "$gw_delay"
      gw_delay=$((gw_delay * 2))
      [ "$gw_delay" -le 60 ] || gw_delay=60
      continue
    fi
    gw_delay=5
    bridge_env=(PATH="$PATH" HOME="$HOME" LANG="${LANG:-C.UTF-8}"
      LIIVO_REPO_DIR="$PROJECT_DIR" LIIVO_PREVIEW_PORT="$PREVIEW_PORT"
      LIIVO_GATEWAY_URL="${LIIVO_GATEWAY_URL:-}" LIIVO_INSTANCE="$LIIVO_INSTANCE"
      OSC_HOSTNAME="${OSC_HOSTNAME:-}" LIIVO_PREVIEW_URL="${LIIVO_EDIT_URL:-}"
      LIIVO_BRIDGE_PORT="$BRIDGE_PORT" LIIVO_DEFAULT_START="$DEFAULT_START" DISABLE_UPDATES=1 DISABLE_AUTOUPDATER=1)
    [ -z "$GIT_HELPER_HOST" ] || bridge_env+=(LIIVO_GIT_HOST="$GIT_HELPER_HOST")
    [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] || bridge_env+=(CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN")
    [ -z "${ANTHROPIC_API_KEY:-}" ] || bridge_env+=(ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY")
    while true; do
      started="$(date +%s)"
      env -i "${bridge_env[@]}" node "$BRIDGE_DIR/current/package/server.mjs" &
      bpid=$!
      write_bridge_state running "$version"
      printf '{"version":"%s","pid":%s,"startedAt":"%s"}\n' "$version" "$bpid" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$BRIDGE_DIR/running.json"
      rc=0
      reloaded=""
      while kill -0 "$bpid" 2> /dev/null; do
        if [ -e "$RELOAD_REQUEST" ]; then
          if reload_expired; then
            rm -f "$RELOAD_REQUEST"
            log "bridge reload request expired without an idle bridge, deleted"
          elif bridge_idle; then
            kill -TERM "$bpid" 2> /dev/null && reloaded=1
            rm -f "$RELOAD_REQUEST"
            break
          fi
        fi
        read -r -t 1 -u 9 _ || true
      done
      wait "$bpid" || rc=$?
      write_bridge_state starting "$version"
      if [ -n "$reloaded" ]; then
        log "bridge stopped for a reload ($rc), fetching the current bridge"
        break
      fi
      ran=$(($(date +%s) - started))
      if [ "$ran" -lt 60 ]; then
        quick=1
        log "bridge exited ($rc) within ${ran}s, fetching the current bridge"
      else
        quick=""
        run_delay=1
        log "bridge exited ($rc), restarting in ${run_delay}s"
      fi
      sleep "$run_delay"
      run_delay=$((run_delay * 2))
      [ "$run_delay" -le 30 ] || run_delay=30
      [ -z "$quick" ] || break
      if [ -e "$RELOAD_REQUEST" ]; then
        rm -f "$RELOAD_REQUEST"
        log "bridge reload requested while the bridge was down, fetching the current bridge"
        break
      fi
    done
  done
}
if [ -n "$forwarder_started" ] && [ -f "$FETCHER" ]; then
  supervise_bridge < /dev/null &
  log "bridge supervisor started"
else
  log "WARNING: no bridge supervisor (the preview forwarder or $FETCHER is missing)"
  write_bridge_state unavailable
fi

# Never show credentials that may be embedded in a git URL. The userinfo part
# ends at the LAST '@' before the first '/' after the scheme, so a password that
# itself contains '@' is masked completely. URLs without a scheme (scp-style
# git@host:o/r.git) are left as they are.
mask_url() { echo "$1" | sed -E 's#^([a-zA-Z][a-zA-Z0-9+.-]*://)[^/]*@#\1***@#'; }

# Project checkout: clone on first start, leave it alone afterwards. A failed
# clone does not stop the agent, so the workspace stays reachable for debugging.
# A first clone that fails is retried in the background (clone_retry_loop below): a private
# repository needs the edit proxy to have learned its tenant, which the gateway's first status
# call teaches a moment after the first attempt has run.
CLONE_LOG="$HOME/liivo-clone.log"
clone_retry=""

# Every git clone attempt, the foreground first one and each retry, runs under a wall-clock limit
# (LIIVO_CLONE_TIMEOUT, 120 s). A git that ignores SIGTERM is killed by SIGKILL after the grace
# (LIIVO_CLONE_KILL_GRACE, 10 s), so no attempt can hold the entrypoint without end.
CLONE_TIMEOUT="${LIIVO_CLONE_TIMEOUT:-120}"
CLONE_KILL_GRACE="${LIIVO_CLONE_KILL_GRACE:-10}"

# Why the latest clone attempt failed, in a few words, read from that attempt's own part of the log:
# the text after the last "=== attempt" line, never an earlier attempt's output (the log never holds a
# credential: git does not print one and the helper prints only its cause).
clone_cause() {
  local text
  text="$(awk '/^=== attempt /{buf=""; next} {buf = buf $0 "\n"} END{printf "%s", buf}' "$CLONE_LOG" 2> /dev/null)"
  if printf '%s' "$text" | grep -q 'liivo-clone: timed out after'; then
    printf '%s' "$text" | grep -o 'timed out after [0-9]*s' | tail -n1
  elif printf '%s' "$text" | grep -qi 'tenant not known'; then
    echo "the edit proxy does not know its tenant yet"
  elif printf '%s' "$text" | grep -qiE 'could not read (Username|Password)|authentication failed|no credentials|terminal prompts disabled'; then
    echo "authentication failed"
  elif printf '%s' "$text" | grep -qiE 'not found|does not appear to be a git repository'; then
    echo "repository not found"
  elif printf '%s' "$text" | grep -qiE 'invalid|unable to find remote helper|protocol'; then
    echo "invalid repository URL"
  else
    echo "see $CLONE_LOG"
  fi
}

# One clone attempt; appends to the clone log with the time. Returns git's status. A failed attempt
# removes only what it created: the directory when it did not exist before, otherwise what the attempt
# put into the empty directory it found. An attempt that git ended by the time limit or by a signal
# (status 124, or above 128) owns whatever it left, a partial .git included. An attempt that exited by
# itself with .git/HEAD present leaves the directory alone: that can be a checkout made by hand.
clone_attempt() {
  local n="$1" existed="" rc=0 t0 elapsed_us killed=""
  [ ! -d "$PROJECT_DIR" ] || existed=1
  printf '=== attempt %s at %s\n' "$n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$CLONE_LOG"
  t0="${EPOCHREALTIME/./}"
  timeout -k "$CLONE_KILL_GRACE" "$CLONE_TIMEOUT" git clone -- "$REPO_URL" "$PROJECT_DIR" >> "$CLONE_LOG" 2>&1 || rc=$?
  if [ "$rc" -ne 0 ]; then
    elapsed_us=$((${EPOCHREALTIME/./} - t0))
    # timeout exits 124 on the limit and 137 when it needed SIGKILL; a git that killed itself also gives
    # 137, so that status counts as the limit only when the attempt ran for the whole limit.
    if [ "$rc" -eq 124 ] || { [ "$rc" -eq 137 ] && [ "$elapsed_us" -ge $((CLONE_TIMEOUT * 1000000)) ]; }; then
      printf 'liivo-clone: timed out after %ss, git was stopped\n' "$CLONE_TIMEOUT" >> "$CLONE_LOG"
    fi
    if [ "$rc" -eq 124 ] || [ "$rc" -gt 128 ]; then killed=1; fi
    if [ -z "$existed" ]; then
      rm -rf "$PROJECT_DIR"
    elif [ -d "$PROJECT_DIR" ] && { [ -n "$killed" ] || [ ! -e "$PROJECT_DIR/.git/HEAD" ]; }; then
      if [ -n "$killed" ] && [ -n "$(ls -A "$PROJECT_DIR" 2> /dev/null)" ]; then
        printf 'liivo-clone: removed the partial checkout the stopped attempt left in %s\n' "$PROJECT_DIR" >> "$CLONE_LOG"
      fi
      find "$PROJECT_DIR" -mindepth 1 -delete 2> /dev/null || true
    fi
    return "$rc"
  fi
  if [ -n "${REPO_BRANCH:-}" ]; then
    (cd "$PROJECT_DIR" && { git checkout "$REPO_BRANCH" 2>/dev/null || git checkout -b "$REPO_BRANCH"; }) \
      || log "WARNING: could not switch to branch $REPO_BRANCH"
  fi
  touch "$HOME/.liivo/project-cloned"
}

# True when a clone may start: no checkout and nothing in the project directory.
clone_wanted() {
  [ ! -d "$PROJECT_DIR/.git" ] && { [ ! -e "$PROJECT_DIR" ] || [ -z "$(ls -A "$PROJECT_DIR" 2>/dev/null)" ]; }
}

# Retries after the failed first attempt: waits LIIVO_CLONE_RETRY_DELAYS (default 5 10 20 40 s), then
# LIIVO_CLONE_RETRY_STEADY (60 s), until the clone works or LIIVO_CLONE_RETRY_BUDGET (600 s) has passed.
# One log line per attempt names the cause. It is one sequential loop, so two clones never run at once,
# and it ends without cloning as soon as the project directory holds anything.
CLONE_RETRY_DELAYS="${LIIVO_CLONE_RETRY_DELAYS:-5 10 20 40}"
CLONE_RETRY_STEADY="${LIIVO_CLONE_RETRY_STEADY:-60}"
CLONE_RETRY_BUDGET="${LIIVO_CLONE_RETRY_BUDGET:-600}"
clone_retry_loop() {
  local n=1 delay cause start="$SECONDS"
  local -a delays
  read -r -a delays <<< "$CLONE_RETRY_DELAYS"
  while true; do
    if [ "$n" -le "${#delays[@]}" ]; then delay="${delays[$((n - 1))]}"; else delay="$CLONE_RETRY_STEADY"; fi
    cause="$(clone_cause)"
    if [ $((SECONDS - start)) -ge "$CLONE_RETRY_BUDGET" ]; then
      log "git clone attempt $n failed: $cause"
      log "WARNING: git clone still failing after the retry budget (${CLONE_RETRY_BUDGET}s), giving up: $cause; restart the workspace or run git clone by hand (see $CLONE_LOG)"
      return 1
    fi
    log "git clone attempt $n failed: $cause; next attempt in ${delay}s"
    sleep "$delay"
    if ! clone_wanted; then
      log "$PROJECT_DIR is no longer empty, not cloning"
      return 0
    fi
    n=$((n + 1))
    if clone_attempt "$n"; then
      log "git clone succeeded on attempt $n"
      return 0
    fi
  done
}

if [ -n "${REPO_URL:-}" ]; then
  case "$REPO_URL" in
    -*) die "REPO_URL must not start with '-'" ;;
  esac
  if [ -d "$PROJECT_DIR/.git" ]; then
    log "project already checked out in $PROJECT_DIR"
  elif [ -e "$PROJECT_DIR" ] && [ -n "$(ls -A "$PROJECT_DIR" 2>/dev/null)" ]; then
    log "WARNING: $PROJECT_DIR exists and is not a git checkout, skipping clone"
  else
    log "cloning $(mask_url "$REPO_URL") into $PROJECT_DIR"
    : > "$CLONE_LOG"
    if ! clone_attempt 1; then
      log "WARNING: git clone failed ($(clone_cause)), see $CLONE_LOG; retrying in the background (the agent starts anyway)"
      clone_retry=1
    fi
  fi
else
  mkdir -p "$PROJECT_DIR"
  log "REPO_URL not set, empty project directory $PROJECT_DIR"
fi

# Project hooks run in the background so the workspace is usable at once.
# setup.sh runs once (marker file), start.sh on every start.
# Isolation limit: the unset below only keeps the agent variables out of the
# hooks' own environment (they are not inherited or printed by accident). It is
# not a security boundary. The hooks run as the same uid as the agent, so a hook
# can still read the agent's /proc/<pid>/environ. The entrypoint runs as uid 1000
# without sudo and cannot drop to another uid. The token only grants access to
# this one workspace's agent endpoints, and the hooks are the workspace owner's
# own repo code.
# The hooks start through liivo-env, which adds the project's parameter store values (docs/block.md). Without
# the wrapper on PATH they start as before.
LIIVO_ENV_STATE="${LIIVO_ENV_STATE_FILE:-/tmp/liivo-env.state}"
env_wrap=()
if command -v liivo-env >/dev/null 2>&1; then env_wrap=(liivo-env); fi
run_hooks() {
  cd "$PROJECT_DIR" || exit 0
  if command -v mise >/dev/null 2>&1; then
    mise trust -a >/dev/null 2>&1 || true
    mise install >/dev/null 2>&1 || true
  fi
  if [ -f .liivo/setup.sh ] && [ ! -f "$HOME/.liivo/setup.done" ]; then
    echo "running .liivo/setup.sh"
    if ${env_wrap[@]+"${env_wrap[@]}"} bash .liivo/setup.sh; then
      # A load that ended with tenant_unknown ran setup.sh without its values: it runs again on the next start.
      if grep -q '"error":"tenant_unknown"' "$LIIVO_ENV_STATE" 2>/dev/null; then
        echo "setup.sh ran without the project's values (tenant not known yet), it runs again on the next start"
      else
        touch "$HOME/.liivo/setup.done"
      fi
    else
      echo "setup.sh failed, it runs again on the next start"
    fi
  fi
  if [ -f .liivo/start.sh ]; then
    echo "running .liivo/start.sh"
    # The bridge stops and restarts start.sh through /tmp/liivo-start-<dir>.pid, which holds the id of a
    # process group (it kills the group). So start.sh runs as the leader of its own session and the
    # leader's id is written before it starts.
    start_pid_file="/tmp/liivo-start-$(basename "$PROJECT_DIR").pid"
    # shellcheck disable=SC2016 # $$ and $1 are for the inner bash, not this one
    if command -v setsid >/dev/null 2>&1; then
      setsid --wait bash -c 'printf "%s" "$$" > "$1"; shift; exec "$@"' _ "$start_pid_file" ${env_wrap[@]+"${env_wrap[@]}"} bash .liivo/start.sh \
        || echo "start.sh exited with an error"
    else
      bash -c 'printf "%s" "$$" > "$1"; shift; exec "$@"' _ "$start_pid_file" ${env_wrap[@]+"${env_wrap[@]}"} bash .liivo/start.sh \
        || echo "start.sh exited with an error"
    fi
  elif [ -f "$DEFAULT_START" ]; then
    # No own start.sh: the default start derives install and start from package.json and the lockfile
    # (docs/block.md). Same wrapper and pid file as an own start.sh, so the bridge's restart contract holds
    # from the first moment; its output goes to /tmp/liivo-start-<dir>.log, the file the bridge appends to.
    start_name="liivo-start-$(basename "$PROJECT_DIR")"
    echo "running the default start, output in /tmp/$start_name.log"
    # shellcheck disable=SC2016 # $$ and $1 are for the inner bash, not this one
    if command -v setsid >/dev/null 2>&1; then
      setsid --wait bash -c 'printf "%s" "$$" > "$1"; shift; exec "$@"' _ "/tmp/$start_name.pid" ${env_wrap[@]+"${env_wrap[@]}"} node "$DEFAULT_START" \
        >> "/tmp/$start_name.log" 2>&1 || echo "the default start ended with an error"
    else
      bash -c 'printf "%s" "$$" > "$1"; shift; exec "$@"' _ "/tmp/$start_name.pid" ${env_wrap[@]+"${env_wrap[@]}"} node "$DEFAULT_START" \
        >> "/tmp/$start_name.log" 2>&1 || echo "the default start ended with an error"
    fi
  fi
}
start_hooks() {
  [ -d "$PROJECT_DIR" ] || return 0
  (
    unset CODER_AGENT_TOKEN CODER_AGENT_URL CODER_AGENT_AUTH CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY
    # Project processes bind to loopback: the edit proxy is the only
    # listener on a non-loopback address (contract in docs/block.md).
    export HOST=127.0.0.1
    run_hooks
  ) < /dev/null > "$HOME/liivo-run.log" 2>&1
}
# A state left in /tmp by an earlier run of the default start is never shown.
rm -f "/tmp/liivo-start-$(basename "$PROJECT_DIR").state" "$LIIVO_ENV_STATE"
if [ -n "$clone_retry" ]; then
  # The first clone failed: the hooks wait for the retries (until the clone works or the budget is
  # spent), so a hook never runs against an empty directory. The agent below does not wait.
  ( clone_retry_loop || true; start_hooks ) < /dev/null &
else
  start_hooks &
fi

# No Docker engine in the instance: switch off the agent's devcontainer
# detection, which otherwise loops on "docker: command not found".
export CODER_AGENT_DEVCONTAINERS_ENABLE=false

log "starting coder agent against $CODER_AGENT_URL"
cd "$PROJECT_DIR" 2>/dev/null || cd "$HOME"
exec coder agent
