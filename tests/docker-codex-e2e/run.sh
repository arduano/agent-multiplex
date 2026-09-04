#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/../.." && pwd)
P2PRPC_CORE=${AGENT_MULTIPLEX_P2PRPC_CORE:-"$REPO_ROOT/../p2prpc/packages/core"}
CODEX_SOURCE_CONFIG=${AGENT_MULTIPLEX_CODEX_SOURCE_CONFIG:-"${HOME}/.codex/config.toml"}
CODEX_SOURCE_KEY=${AGENT_MULTIPLEX_CODEX_SOURCE_KEY:-"${HOME}/.codex/codex-lb-api-key"}
RECEIPT_ROOT=${AGENT_MULTIPLEX_E2E_RECEIPT_ROOT:-"$REPO_ROOT/receipts/codex-docker-e2e"}
MODEL=${AGENT_MULTIPLEX_E2E_MODEL:-gpt-5.6-sol}

for tool in docker jq node curl sha256sum awk sed perl rg timeout stat cmp; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "docker Codex E2E: required tool '$tool' is unavailable" >&2
    exit 1
  fi
done

if [[ ! -f "$P2PRPC_CORE/package.json" || ! -d "$P2PRPC_CORE/dist" ]]; then
  echo "docker Codex E2E: p2prpc core with built dist is required at $P2PRPC_CORE" >&2
  exit 1
fi
if [[ ! -r "$CODEX_SOURCE_CONFIG" ]]; then
  echo "docker Codex E2E: Codex source config is not readable: $CODEX_SOURCE_CONFIG" >&2
  exit 1
fi
if [[ ! -r "$CODEX_SOURCE_KEY" ]]; then
  echo "docker Codex E2E: codex-lb source key is not readable: $CODEX_SOURCE_KEY" >&2
  exit 1
fi

random_hex() {
  node -e 'process.stdout.write(require("node:crypto").randomBytes(6).toString("hex"))'
}

RUN_ID=${AGENT_MULTIPLEX_E2E_RUN_ID:-"$(date -u +%Y%m%dT%H%M%SZ)-$(random_hex)"}
if [[ ! "$RUN_ID" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "docker Codex E2E: run id must contain only letters, digits, dot, underscore, or dash" >&2
  exit 1
fi

RECEIPT_DIR="$RECEIPT_ROOT/$RUN_ID"
if [[ -e "$RECEIPT_DIR" ]]; then
  echo "docker Codex E2E: receipt directory already exists: $RECEIPT_DIR" >&2
  exit 1
fi
mkdir -p \
  "$RECEIPT_DIR/logs" \
  "$RECEIPT_DIR/rpc" \
  "$RECEIPT_DIR/screenshots" \
  "$RECEIPT_DIR/workspace"

RUNTIME_DIR=$(mktemp -d "${TMPDIR:-/tmp}/agent-multiplex-codex-e2e.XXXXXXXX")
WORKSPACE_DIR="$RUNTIME_DIR/workspace"
mkdir -p "$WORKSPACE_DIR"

NAME_SUFFIX=$(printf '%s' "$RUN_ID" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9' | tail -c 24)
HOST_CONTAINER="agent-multiplex-e2e-host-$NAME_SUFFIX"
WORKER_CONTAINER="agent-multiplex-e2e-runtime-node-$NAME_SUFFIX"
NETWORK_NAME="agent-multiplex-e2e-$NAME_SUFFIX"
IMAGE_TAG="agent-multiplex-e2e:$NAME_SUFFIX"
WORKER_NAME="docker-codex-worker-$NAME_SUFFIX"
SESSION_TITLE="Codex Docker E2E $RUN_ID"
NONCE=$(printf '%s' "$(random_hex)" | tr '[:lower:]' '[:upper:]')
PHASE1_MARKER="AGENT_MULTIPLEX_E2E_PHASE1_$NONCE"
PHASE2_MARKER="AGENT_MULTIPLEX_E2E_PHASE2_$NONCE"
PROOF_LINE_1="agent-multiplex docker codex e2e verified"
PROOF_LINE_2="run $RUN_ID"
SHARED_SECRET=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(48).toString("base64url"))')
RUN_STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

HOST_STARTED=0
WORKER_STARTED=0
NETWORK_CREATED=0
IMAGE_BUILT=0
LOGS_CAPTURED=0
COMPLETED=0
WATCH_PID=""
P2P_TICKET=""
PROVIDER_URL=""
API_KEY_LITERAL=""

note() {
  printf '[codex-docker-e2e] %s\n' "$*" >&2
}

fail() {
  note "FAILED: $*"
  return 1
}

redact_stream() {
  AM_REDACT_SHARED="$SHARED_SECRET" \
  AM_REDACT_TICKET="$P2P_TICKET" \
  AM_REDACT_KEY="$API_KEY_LITERAL" \
  AM_REDACT_PROVIDER="$PROVIDER_URL" \
    perl -0pe '
      BEGIN {
        @pairs = (
          [$ENV{AM_REDACT_SHARED} // "", "<redacted-shared-secret>"],
          [$ENV{AM_REDACT_TICKET} // "", "<redacted-p2p-ticket>"],
          [$ENV{AM_REDACT_KEY} // "", "<redacted-codex-lb-key>"],
          [$ENV{AM_REDACT_PROVIDER} // "", "<redacted-provider-endpoint>"],
        );
      }
      for $pair (@pairs) {
        ($value, $replacement) = @$pair;
        s/\Q$value\E/$replacement/g if length($value);
      }
    '
}

capture_logs() {
  if (( LOGS_CAPTURED == 1 )); then
    return
  fi
  local raw_host="$RUNTIME_DIR/host.raw.log"
  local raw_worker="$RUNTIME_DIR/worker.raw.log"
  if (( HOST_STARTED == 1 )); then
    docker logs "$HOST_CONTAINER" >"$raw_host" 2>&1 || true
    awk '
      redact_next { print "<redacted-locator>"; redact_next = 0; next }
      /^P2P ticket \(/ { print; redact_next = 1; next }
      { print }
    ' "$raw_host" | redact_stream >"$RECEIPT_DIR/logs/host.log"
  fi
  if (( WORKER_STARTED == 1 )); then
    docker logs "$WORKER_CONTAINER" >"$raw_worker" 2>&1 || true
    redact_stream <"$raw_worker" >"$RECEIPT_DIR/logs/worker.log"
  fi
  LOGS_CAPTURED=1
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  if [[ -n "$WATCH_PID" ]] && kill -0 "$WATCH_PID" 2>/dev/null; then
    kill "$WATCH_PID" 2>/dev/null
    wait "$WATCH_PID" 2>/dev/null
  fi
  capture_logs
  if (( WORKER_STARTED == 1 )); then
    docker rm --force "$WORKER_CONTAINER" >/dev/null 2>&1
  fi
  if (( HOST_STARTED == 1 )); then
    docker rm --force "$HOST_CONTAINER" >/dev/null 2>&1
  fi
  if (( NETWORK_CREATED == 1 )); then
    docker network rm "$NETWORK_NAME" >/dev/null 2>&1
  fi
  if (( IMAGE_BUILT == 1 )) && [[ ${AGENT_MULTIPLEX_E2E_KEEP_IMAGE:-0} != 1 ]]; then
    docker image rm "$IMAGE_TAG" >/dev/null 2>&1
  fi
  if [[ -n "$RUNTIME_DIR" && -d "$RUNTIME_DIR" && "$RUNTIME_DIR" != "/" && \
        "$(basename -- "$RUNTIME_DIR")" == agent-multiplex-codex-e2e.* ]]; then
    rm -rf -- "$RUNTIME_DIR"
  fi
  if (( COMPLETED == 0 )); then
    printf 'The Docker Codex E2E run failed. Inspect logs/ and any partial RPC receipts.\n' \
      >"$RECEIPT_DIR/FAILED.txt"
  fi
  if (( status == 0 && COMPLETED == 1 )); then
    note "PASS: receipts saved to $RECEIPT_DIR"
  else
    note "Run failed; partial receipts saved to $RECEIPT_DIR"
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

assert_json() {
  local description=$1
  local filter=$2
  local file=$3
  shift 3
  if ! jq -e "$@" "$filter" "$file" >/dev/null; then
    fail "$description (see ${file#"$RECEIPT_DIR/"})"
  fi
}

cli_raw() {
  timeout 180s docker exec "$HOST_CONTAINER" \
    node /opt/src/agent-multiplex/apps/cli/dist/main.js \
    --host http://127.0.0.1:4317/trpc \
    --json "$@"
}

run_cli() {
  local destination=$1
  shift
  local temporary="$RUNTIME_DIR/cli-output.json"
  local errors="$RUNTIME_DIR/cli-errors.log"
  : >"$errors"
  {
    printf '$ agent-multiplex --json'
    printf ' %q' "$@"
    printf '\n'
  } >>"$RECEIPT_DIR/logs/cli-transcript.log"
  if ! cli_raw "$@" >"$temporary" 2>"$errors"; then
    redact_stream <"$errors" >>"$RECEIPT_DIR/logs/cli-transcript.log"
    fail "CLI command failed: $*"
  fi
  if ! jq -e . "$temporary" >/dev/null; then
    redact_stream <"$temporary" >>"$RECEIPT_DIR/logs/cli-transcript.log"
    fail "CLI command did not return valid JSON: $*"
  fi
  mv "$temporary" "$destination"
  printf 'receipt: %s\n\n' "${destination#"$RECEIPT_DIR/"}" \
    >>"$RECEIPT_DIR/logs/cli-transcript.log"
}

wait_for_host_startup() {
  local attempt logs
  for attempt in $(seq 1 90); do
    if [[ $(docker inspect --format '{{.State.Running}}' "$HOST_CONTAINER" 2>/dev/null) != true ]]; then
      docker logs "$HOST_CONTAINER" 2>&1 \
        | awk '
            redact_next { print "<redacted-locator>"; redact_next = 0; next }
            /^P2P ticket \(/ { print; redact_next = 1; next }
            { print }
          ' \
        | redact_stream >&2 || true
      fail "host container exited during startup"
      return
    fi
    logs=$(docker logs "$HOST_CONTAINER" 2>&1 || true)
    if grep -q '^P2P ID:' <<<"$logs" && grep -q '^P2P ticket (' <<<"$logs"; then
      return
    fi
    if (( attempt % 15 == 0 )); then
      note "waiting for host endpoint and P2P ticket (${attempt}s)"
    fi
    sleep 1
  done
  fail "timed out waiting for host startup"
}

wait_for_worker() {
  local attempt temporary="$RUNTIME_DIR/workers-poll.json"
  for attempt in $(seq 1 180); do
    if [[ $(docker inspect --format '{{.State.Running}}' "$WORKER_CONTAINER" 2>/dev/null) != true ]]; then
      docker logs "$WORKER_CONTAINER" 2>&1 | redact_stream >&2 || true
      fail "worker container exited during registration"
      return
    fi
    if cli_raw workers >"$temporary" 2>/dev/null && jq -e \
      --arg name "$WORKER_NAME" '
        any(.[];
          .name == $name and
          .presence == "online" and
          any(.harnesses[]; .harness == "codex" and .available == true)
        )
      ' "$temporary" >/dev/null; then
      mv "$temporary" "$RECEIPT_DIR/rpc/workers.json"
      return
    fi
    if (( attempt % 15 == 0 )); then
      note "waiting for worker registration and Codex readiness (${attempt}s)"
    fi
    sleep 1
  done
  fail "timed out waiting for the Codex worker"
}

wait_for_watch() {
  local attempt
  for attempt in $(seq 1 60); do
    if grep -q '^watch connected$' "$RECEIPT_DIR/logs/watch.log" 2>/dev/null; then
      return
    fi
    if ! kill -0 "$WATCH_PID" 2>/dev/null; then
      fail "fleet watch exited before connecting"
      return
    fi
    sleep 1
  done
  fail "timed out waiting for fleet watch connection"
}

wait_for_completed_turns() {
  local wanted=$1
  local attempt count failed
  for attempt in $(seq 1 900); do
    failed=$(jq -s '[.[] | select(
      .kind == "native" and
      .nativeType == "turn/completed" and
      .payload.turn.status == "failed"
    )] | length' "$RECEIPT_DIR/logs/fleet-events.ndjson" 2>/dev/null || printf '0')
    if (( failed > 0 )); then
      fail "Codex reported a failed turn in the native event stream"
      return
    fi
    count=$(jq -s '[.[] | select(
      .kind == "native" and
      .nativeType == "turn/completed" and
      .payload.turn.status == "completed"
    )] | length' "$RECEIPT_DIR/logs/fleet-events.ndjson" 2>/dev/null || printf '0')
    if (( count >= wanted )); then
      return
    fi
    if ! kill -0 "$WATCH_PID" 2>/dev/null; then
      fail "fleet watch exited while waiting for turn completion"
      return
    fi
    if (( attempt % 15 == 0 )); then
      note "waiting for native Codex turn completion ($count/$wanted, ${attempt}s)"
    fi
    sleep 1
  done
  fail "timed out waiting for $wanted completed Codex turn(s)"
}

capture_dashboard() {
  local phase=$1
  local screenshot=$2
  local receipt=$3
  if ! timeout 60s node "$SCRIPT_DIR/capture.mjs" \
    "$DASHBOARD_URL" \
    "$screenshot" \
    "$RECEIPT_DIR/logs/browser-console.txt" \
    "$WORKER_NAME" \
    "$SESSION_TITLE" \
    "$phase" >"$receipt" 2>>"$RECEIPT_DIR/logs/playwright.log"; then
    fail "Playwright dashboard capture failed during $phase"
  fi
  if [[ ! -s "$screenshot" ]]; then
    fail "Playwright did not create the $phase screenshot"
  fi
}

note "preparing isolated codex-lb runtime configuration"
API_KEY_LITERAL=$(tr -d '\r\n' <"$CODEX_SOURCE_KEY")
if (( ${#API_KEY_LITERAL} < 16 )); then
  fail "codex-lb key file is unexpectedly short"
fi
PROVIDER_URL=$(awk '
  /^\[model_providers\.codex-lb\]$/ { in_provider = 1; next }
  in_provider && /^\[/ { exit }
  in_provider && /^[[:space:]]*base_url[[:space:]]*=/ {
    sub(/^[^=]*=[[:space:]]*/, ""); gsub(/^"|"$/, ""); print; exit
  }
' "$CODEX_SOURCE_CONFIG")
if [[ -z "$PROVIDER_URL" ]]; then
  fail "codex-lb provider base_url was not found in the source config"
fi

MINIMAL_CONFIG_RAW="$RUNTIME_DIR/config.raw.toml"
MINIMAL_CONFIG="$RUNTIME_DIR/config.toml"
awk '
  /^[[:space:]]*model_provider[[:space:]]*=/ {
    if ($0 ~ /"codex-lb"/) print
    next
  }
  /^[[:space:]]*model[[:space:]]*=/ { print; next }
  /^\[model_providers\.codex-lb\]$/ { in_provider = 1; print; next }
  in_provider && /^\[/ {
    if ($0 == "[model_providers.codex-lb.auth]") { print; next }
    in_provider = 0
  }
  in_provider { print }
' "$CODEX_SOURCE_CONFIG" >"$MINIMAL_CONFIG_RAW"
sed -E \
  's#^([[:space:]]*args[[:space:]]*=[[:space:]]*)\["[^"]*codex-lb-api-key"\]#\1["/home/arduano/.codex/codex-lb-api-key"]#' \
  "$MINIMAL_CONFIG_RAW" >"$MINIMAL_CONFIG"
printf '\n[projects."/workspace/e2e"]\ntrust_level = "trusted"\n' >>"$MINIMAL_CONFIG"
chmod 600 "$MINIMAL_CONFIG"
if ! grep -q '^model_provider = "codex-lb"$' "$MINIMAL_CONFIG" || \
   ! grep -q '^\[model_providers.codex-lb.auth\]$' "$MINIMAL_CONFIG" || \
   ! grep -q '/home/arduano/.codex/codex-lb-api-key' "$MINIMAL_CONFIG"; then
  fail "generated minimal codex-lb config did not pass validation"
fi

note "building the shared host/worker image"
if ! docker build \
  --progress=plain \
  --build-context "p2prpc-core=$P2PRPC_CORE" \
  --file "$SCRIPT_DIR/Dockerfile" \
  --tag "$IMAGE_TAG" \
  "$REPO_ROOT" >"$RECEIPT_DIR/logs/docker-build.log" 2>&1; then
  tail -n 80 "$RECEIPT_DIR/logs/docker-build.log" >&2 || true
  fail "Docker image build failed"
fi
IMAGE_BUILT=1
IMAGE_ID=$(docker image inspect --format '{{.Id}}' "$IMAGE_TAG")

docker network create --driver bridge "$NETWORK_NAME" >/dev/null
NETWORK_CREATED=1

note "starting canonical Multiplex host container"
docker run --detach \
  --name "$HOST_CONTAINER" \
  --hostname multiplex-host \
  --network "$NETWORK_NAME" \
  --init \
  --user 1000:100 \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --tmpfs /state:rw,nosuid,nodev,mode=0700,uid=1000,gid=100 \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777 \
  --publish 127.0.0.1::4317 \
  --env AGENT_MULTIPLEX_SHARED_SECRET="$SHARED_SECRET" \
  --env AGENT_MULTIPLEX_ALLOW_ENROLLMENT=1 \
  --env AGENT_MULTIPLEX_HOST_STATE=/state/host.sqlite \
  --env AGENT_MULTIPLEX_HOST_IDENTITY=/state/host.identity \
  --env AGENT_MULTIPLEX_HTTP_BIND=0.0.0.0 \
  --env AGENT_MULTIPLEX_HTTP_PORT=4317 \
  --env AGENT_MULTIPLEX_WORKER_STALE_MS=120000 \
  "$IMAGE_TAG" \
  node apps/host/dist/main.js >/dev/null
HOST_STARTED=1
wait_for_host_startup

HOST_LOGS=$(docker logs "$HOST_CONTAINER" 2>&1)
P2P_ENDPOINT_ID=$(sed -n 's/^P2P ID:[[:space:]]*//p' <<<"$HOST_LOGS" | tail -n 1)
P2P_TICKET=$(awk '/^P2P ticket \(/ { getline; print; exit }' <<<"$HOST_LOGS")
if [[ ! "$P2P_ENDPOINT_ID" =~ ^[a-z2-7]{52}$ ]]; then
  fail "host emitted an invalid P2P endpoint ID"
fi
if (( ${#P2P_TICKET} < 20 || ${#P2P_TICKET} > 8192 )) || \
   [[ "$P2P_TICKET" =~ [[:space:]] ]]; then
  fail "host emitted an invalid P2P ticket"
fi
P2P_TICKET_SHA256=$(printf '%s' "$P2P_TICKET" | sha256sum | awk '{print $1}')

PORT_MAPPING=$(docker port "$HOST_CONTAINER" 4317/tcp | tail -n 1)
DASHBOARD_PORT=${PORT_MAPPING##*:}
if [[ ! "$DASHBOARD_PORT" =~ ^[0-9]+$ ]]; then
  fail "could not resolve the host-published dashboard port"
fi
DASHBOARD_URL="http://127.0.0.1:$DASHBOARD_PORT/"
for attempt in $(seq 1 30); do
  if curl --fail --silent --show-error "$DASHBOARD_URL" >/dev/null; then
    break
  fi
  if (( attempt == 30 )); then
    fail "dashboard did not become reachable"
  fi
  sleep 1
done

note "starting worker container, then copying only codex-lb auth material into it"
WORKER_CREATED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
docker run --detach \
  --name "$WORKER_CONTAINER" \
  --hostname codex-worker \
  --network "$NETWORK_NAME" \
  --init \
  --user 1000:100 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --security-opt seccomp=unconfined \
  --tmpfs /state:rw,nosuid,nodev,mode=0700,uid=1000,gid=100 \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777 \
  --mount "type=bind,src=$WORKSPACE_DIR,dst=/workspace/e2e" \
  --env HOME=/home/arduano \
  --env CODEX_HOME=/home/arduano/.codex \
  --env XDG_CACHE_HOME=/tmp/cache \
  --env AGENT_MULTIPLEX_SHARED_SECRET="$SHARED_SECRET" \
  --env AGENT_MULTIPLEX_CONTROL_NODE_ENDPOINT_ID="$P2P_ENDPOINT_ID" \
  --env AGENT_MULTIPLEX_CONTROL_NODE_TICKET="$P2P_TICKET" \
  --env 'AGENT_MULTIPLEX_RUNTIME_NODE_ALLOWED_ROOTS=["/workspace/e2e"]' \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_STATE_DIR=/state/runtime-node \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_NAME="$WORKER_NAME" \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_HARNESSES=codex \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_HEARTBEAT_MS=2000 \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_INVENTORY_REFRESH_MS=5000 \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_RECONNECT_MAX_MS=5000 \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_CODEX_BINARY=/opt/src/agent-multiplex/node_modules/.bin/codex \
  "$IMAGE_TAG" \
  /usr/local/bin/agent-multiplex-e2e-runtime-node >/dev/null
WORKER_STARTED=1

# The key is copied from the host only after the worker container exists. The
# config is copied last, allowing the entrypoint's two-file readiness gate to
# release only when both files are in the fresh container-local CODEX_HOME.
docker cp -a "$CODEX_SOURCE_KEY" \
  "$WORKER_CONTAINER:/home/arduano/.codex/codex-lb-api-key"
docker cp -a "$MINIMAL_CONFIG" \
  "$WORKER_CONTAINER:/home/arduano/.codex/config.toml"
AUTH_COPIED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

docker exec "$WORKER_CONTAINER" node -e '
  const fs = require("node:fs");
  const paths = [
    "/home/arduano/.codex/config.toml",
    "/home/arduano/.codex/codex-lb-api-key",
  ];
  const files = Object.fromEntries(paths.map((path) => {
    const stat = fs.statSync(path);
    return [path, {
      present: stat.isFile(),
      mode: (stat.mode & 0o777).toString(8).padStart(3, "0"),
      uid: stat.uid,
      gid: stat.gid,
    }];
  }));
  process.stdout.write(JSON.stringify({ files }, null, 2));
' >"$RUNTIME_DIR/auth-stat.json"
jq -n \
  --arg createdAt "$WORKER_CREATED_AT" \
  --arg copiedAt "$AUTH_COPIED_AT" \
  --slurpfile stat "$RUNTIME_DIR/auth-stat.json" '
    {
      source: "host codex-lb provider config/key only",
      method: "docker cp -a after worker creation",
      isolatedCodexHome: true,
      authJsonCopied: false,
      workerCreatedAt: $createdAt,
      copiedAt: $copiedAt,
      files: $stat[0].files
    }
  ' >"$RECEIPT_DIR/auth-copy-proof.json"
assert_json "copied Codex auth modes/ownership are incorrect" '
  .authJsonCopied == false and
  all(.files[]; .present == true and .mode == "600" and .uid == 1000 and .gid == 100)
' "$RECEIPT_DIR/auth-copy-proof.json"

wait_for_worker
note "worker is online and reports Codex 0.152 ready"

run_cli "$RECEIPT_DIR/rpc/catalog.json" catalog "$WORKER_NAME"
assert_json "Codex catalog entry is not available" '
  any(.[]; .harness == "codex" and .available == true and .runtimeVersion == "0.152.0")
' "$RECEIPT_DIR/rpc/catalog.json"

run_cli "$RECEIPT_DIR/rpc/models.json" models "$WORKER_NAME" codex
assert_json "Codex native model list is empty" 'type == "array" and length > 0' \
  "$RECEIPT_DIR/rpc/models.json"

METADATA_ASSIGNMENT="agent.title=$(jq -Rn --arg value "$SESSION_TITLE" '$value')"
note "spawning a real Codex thread through the Multiplex API"
run_cli "$RECEIPT_DIR/rpc/spawn.json" \
  spawn "$WORKER_NAME" codex /workspace/e2e \
  --model "$MODEL" \
  --approval-policy never \
  --sandbox read-only \
  --metadata "$METADATA_ASSIGNMENT"
assert_json "Codex spawn was not acknowledged" '
  .state == "succeeded" and
  (.sessionId | type == "string") and
  (.result.vendorSessionId | type == "string")
' "$RECEIPT_DIR/rpc/spawn.json"
SESSION_ID=$(jq -r '.sessionId' "$RECEIPT_DIR/rpc/spawn.json")
VENDOR_SESSION_ID=$(jq -r '.result.vendorSessionId' "$RECEIPT_DIR/rpc/spawn.json")

: >"$RECEIPT_DIR/logs/fleet-events.ndjson"
: >"$RECEIPT_DIR/logs/watch.log"
timeout 1200s docker exec "$HOST_CONTAINER" \
  node /opt/src/agent-multiplex/apps/cli/dist/main.js \
  --host http://127.0.0.1:4317/trpc \
  --json watch "$SESSION_ID" \
  >"$RECEIPT_DIR/logs/fleet-events.ndjson" \
  2>"$RECEIPT_DIR/logs/watch.log" &
WATCH_PID=$!
wait_for_watch

note "sending phase 1 prompt and waiting for native turn/completed"
run_cli "$RECEIPT_DIR/rpc/send-phase1.json" \
  send "$SESSION_ID" "Reply with exactly $PHASE1_MARKER and nothing else."
assert_json "phase 1 turn/start was not acknowledged" '.state == "succeeded"' \
  "$RECEIPT_DIR/rpc/send-phase1.json"
PHASE1_TURN_ID=$(jq -r '.result.turn.id' "$RECEIPT_DIR/rpc/send-phase1.json")
wait_for_completed_turns 1
if ! jq -e --arg sid "$SESSION_ID" --arg tid "$PHASE1_TURN_ID" '
  select(
    .kind == "native" and
    .sessionId == $sid and
    .nativeType == "turn/completed" and
    .payload.turn.id == $tid and
    .payload.turn.status == "completed"
  )
' "$RECEIPT_DIR/logs/fleet-events.ndjson" >/dev/null; then
  fail "phase 1 native completion did not match its accepted turn ID"
fi

run_cli "$RECEIPT_DIR/rpc/native-history-phase1.json" history "$SESSION_ID"
assert_json "phase 1 marker is absent from native thread/read history" '
  .harness == "codex" and .complete == true and
  any(.payload.thread.turns[].items[]?;
    .type == "agentMessage" and .text == $marker)
' "$RECEIPT_DIR/rpc/native-history-phase1.json" --arg marker "$PHASE1_MARKER"

run_cli "$RECEIPT_DIR/rpc/sessions-phase1.json" sessions --worker "$WORKER_NAME" --harness codex
assert_json "phase 1 session is not active and idle" '
  any(.[];
    .sessionId == $sid and
    .availability == "active" and
    .runtimeStatus == "idle" and
    .metadata.values["agent.title"] == $title)
' "$RECEIPT_DIR/rpc/sessions-phase1.json" --arg sid "$SESSION_ID" --arg title "$SESSION_TITLE"
PHASE1_RUNTIME_EPOCH=$(jq -r --arg sid "$SESSION_ID" '.[] | select(.sessionId == $sid) | .runtimeEpoch' \
  "$RECEIPT_DIR/rpc/sessions-phase1.json")
BINDING_REVISION=$(jq -r --arg sid "$SESSION_ID" '.[] | select(.sessionId == $sid) | .bindingRevision' \
  "$RECEIPT_DIR/rpc/sessions-phase1.json")

capture_dashboard \
  active-idle \
  "$RECEIPT_DIR/screenshots/dashboard-active-idle.png" \
  "$RECEIPT_DIR/rpc/playwright-active-idle.json"

note "stopping, refreshing native inventory, and proving the thread is resumable"
run_cli "$RECEIPT_DIR/rpc/stop-phase1.json" stop "$SESSION_ID"
assert_json "phase 1 stop was not acknowledged" '.state == "succeeded"' \
  "$RECEIPT_DIR/rpc/stop-phase1.json"
run_cli "$RECEIPT_DIR/rpc/refresh-after-stop.json" refresh "$WORKER_NAME"
assert_json "stopped native thread was not classified as resumable" '
  any(.sessions[];
    .vendorSessionId == $vendor and
    .availability == "resumable" and
    .runtimeStatus == "stopped" and
    .runtimeEpoch == null)
' "$RECEIPT_DIR/rpc/refresh-after-stop.json" --arg vendor "$VENDOR_SESSION_ID"
run_cli "$RECEIPT_DIR/rpc/sessions-stopped.json" sessions --worker "$WORKER_NAME" --harness codex
assert_json "canonical session did not converge to resumable/stopped" '
  any(.[];
    .sessionId == $sid and
    .vendorSessionId == $vendor and
    .availability == "resumable" and
    .runtimeStatus == "stopped" and
    .runtimeEpoch == null)
' "$RECEIPT_DIR/rpc/sessions-stopped.json" --arg sid "$SESSION_ID" --arg vendor "$VENDOR_SESSION_ID"

note "resuming the same native Codex thread and logical Multiplex session"
run_cli "$RECEIPT_DIR/rpc/resume.json" \
  resume "$WORKER_NAME" codex "$VENDOR_SESSION_ID" \
  --cwd /workspace/e2e \
  --model "$MODEL" \
  --approval-policy never \
  --sandbox workspace-write
assert_json "Codex resume did not preserve the logical/native identity" '
  .state == "succeeded" and
  .sessionId == $sid and
  .result.sessionId == $sid and
  .result.vendorSessionId == $vendor
' "$RECEIPT_DIR/rpc/resume.json" --arg sid "$SESSION_ID" --arg vendor "$VENDOR_SESSION_ID"

run_cli "$RECEIPT_DIR/rpc/sessions-resumed.json" sessions --worker "$WORKER_NAME" --harness codex
assert_json "resumed session is not active" '
  any(.[];
    .sessionId == $sid and
    .availability == "active" and
    .runtimeEpoch != null and
    .bindingRevision == $revision)
' "$RECEIPT_DIR/rpc/sessions-resumed.json" --arg sid "$SESSION_ID" --argjson revision "$BINDING_REVISION"
PHASE2_RUNTIME_EPOCH=$(jq -r --arg sid "$SESSION_ID" '.[] | select(.sessionId == $sid) | .runtimeEpoch' \
  "$RECEIPT_DIR/rpc/sessions-resumed.json")
if [[ "$PHASE1_RUNTIME_EPOCH" == "$PHASE2_RUNTIME_EPOCH" ]]; then
  fail "resume did not establish a fresh runtime epoch"
fi

SECOND_PROMPT=$(printf '%s\n' \
  "Create /workspace/e2e/codex-adapter-proof.txt containing exactly these two lines, including a final newline:" \
  "$PROOF_LINE_1" \
  "$PROOF_LINE_2" \
  "Do not modify any other file. Read the file back and verify its exact bytes. If creation or verification fails, reply with exactly FILE_WRITE_FAILED. Otherwise reply with exactly $PHASE2_MARKER and nothing else.")
note "sending phase 2 workspace-write prompt through the resumed session"
run_cli "$RECEIPT_DIR/rpc/send-phase2.json" send "$SESSION_ID" "$SECOND_PROMPT"
assert_json "phase 2 turn/start was not acknowledged" '.state == "succeeded"' \
  "$RECEIPT_DIR/rpc/send-phase2.json"
PHASE2_TURN_ID=$(jq -r '.result.turn.id' "$RECEIPT_DIR/rpc/send-phase2.json")
wait_for_completed_turns 2
if ! jq -e --arg sid "$SESSION_ID" --arg tid "$PHASE2_TURN_ID" '
  select(
    .kind == "native" and
    .sessionId == $sid and
    .nativeType == "turn/completed" and
    .payload.turn.id == $tid and
    .payload.turn.status == "completed"
  )
' "$RECEIPT_DIR/logs/fleet-events.ndjson" >/dev/null; then
  fail "phase 2 native completion did not match its accepted turn ID"
fi

run_cli "$RECEIPT_DIR/rpc/native-history-final.json" history "$SESSION_ID"
assert_json "native thread/read history does not contain both exact agent replies" '
  .harness == "codex" and .complete == true and
  ([.payload.thread.turns[] | select(.status == "completed")] | length) >= 2 and
  any(.payload.thread.turns[].items[]?;
    .type == "agentMessage" and .text == $phase1) and
  any(.payload.thread.turns[].items[]?;
    .type == "agentMessage" and .text == $phase2)
' "$RECEIPT_DIR/rpc/native-history-final.json" \
  --arg phase1 "$PHASE1_MARKER" --arg phase2 "$PHASE2_MARKER"

EXPECTED_PROOF="$RUNTIME_DIR/expected-proof.txt"
printf '%s\n%s\n' "$PROOF_LINE_1" "$PROOF_LINE_2" >"$EXPECTED_PROOF"
if [[ ! -f "$WORKSPACE_DIR/codex-adapter-proof.txt" ]] || \
   ! cmp --silent "$EXPECTED_PROOF" "$WORKSPACE_DIR/codex-adapter-proof.txt"; then
  fail "Codex workspace-write proof file does not have the exact expected bytes"
fi
cp "$WORKSPACE_DIR/codex-adapter-proof.txt" \
  "$RECEIPT_DIR/workspace/codex-adapter-proof.txt"
PROOF_SHA256=$(sha256sum "$RECEIPT_DIR/workspace/codex-adapter-proof.txt" | awk '{print $1}')
printf 'sha256  %s\nbytes   %s\n' \
  "$PROOF_SHA256" \
  "$(stat -c %s "$RECEIPT_DIR/workspace/codex-adapter-proof.txt")" \
  >"$RECEIPT_DIR/workspace/file-proof.txt"

run_cli "$RECEIPT_DIR/rpc/sessions-phase2.json" sessions --worker "$WORKER_NAME" --harness codex
assert_json "phase 2 session is not active and idle" '
  any(.[];
    .sessionId == $sid and
    .availability == "active" and
    .runtimeStatus == "idle" and
    .runtimeEpoch == $epoch)
' "$RECEIPT_DIR/rpc/sessions-phase2.json" --arg sid "$SESSION_ID" --arg epoch "$PHASE2_RUNTIME_EPOCH"

docker exec "$WORKER_CONTAINER" node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const current = process.pid;
  const processes = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry) || Number(entry) === current) continue;
    try {
      const args = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0").filter(Boolean);
      const encoded = args.join(" ");
      if (!encoded.includes("app-server") || !encoded.toLowerCase().includes("codex")) continue;
      processes.push({
        pid: Number(entry),
        executable: path.basename(args[0] ?? "unknown"),
        role: "codex app-server",
      });
    } catch {}
  }
  processes.sort((left, right) => left.pid - right.pid);
  process.stdout.write(JSON.stringify({ processes }, null, 2));
' >"$RECEIPT_DIR/codex-process-proof.json"
assert_json "worker does not have a live Codex app-server process" \
  '.processes | length >= 1' "$RECEIPT_DIR/codex-process-proof.json"

capture_dashboard \
  resumed-idle \
  "$RECEIPT_DIR/screenshots/dashboard-resumed-idle.png" \
  "$RECEIPT_DIR/rpc/playwright-resumed-idle.json"

note "performing final stop and inventory reconciliation"
run_cli "$RECEIPT_DIR/rpc/stop-final.json" stop "$SESSION_ID"
assert_json "final stop was not acknowledged" '.state == "succeeded"' \
  "$RECEIPT_DIR/rpc/stop-final.json"
run_cli "$RECEIPT_DIR/rpc/refresh-final.json" refresh "$WORKER_NAME"
run_cli "$RECEIPT_DIR/rpc/sessions-final.json" sessions --worker "$WORKER_NAME" --harness codex
assert_json "final session state is not resumable/stopped" '
  any(.[];
    .sessionId == $sid and
    .vendorSessionId == $vendor and
    .availability == "resumable" and
    .runtimeStatus == "stopped" and
    .runtimeEpoch == null)
' "$RECEIPT_DIR/rpc/sessions-final.json" --arg sid "$SESSION_ID" --arg vendor "$VENDOR_SESSION_ID"

if [[ -n "$WATCH_PID" ]] && kill -0 "$WATCH_PID" 2>/dev/null; then
  kill "$WATCH_PID" 2>/dev/null || true
  wait "$WATCH_PID" 2>/dev/null || true
fi
WATCH_PID=""

NETWORK_CONTAINER_COUNT=$(docker network inspect --format '{{len .Containers}}' "$NETWORK_NAME")
if [[ "$NETWORK_CONTAINER_COUNT" != 2 ]]; then
  fail "expected exactly two application containers on the E2E network, saw $NETWORK_CONTAINER_COUNT"
fi
HOST_CONTAINER_ID=$(docker inspect --format '{{.Id}}' "$HOST_CONTAINER")
WORKER_CONTAINER_ID=$(docker inspect --format '{{.Id}}' "$WORKER_CONTAINER")
if [[ "$HOST_CONTAINER_ID" == "$WORKER_CONTAINER_ID" ]]; then
  fail "host and worker unexpectedly resolved to the same container"
fi
if [[ -n $(docker port "$WORKER_CONTAINER" 2>/dev/null) ]]; then
  fail "worker unexpectedly publishes a host port"
fi

NODE_VERSION=$(docker exec "$HOST_CONTAINER" node --version | tr -d '\r\n')
CODEX_VERSION=$(docker exec "$WORKER_CONTAINER" \
  /opt/src/agent-multiplex/node_modules/.bin/codex --version | tr -d '\r\n')
DOCKER_VERSION=$(docker version --format '{{.Server.Version}}')
COMPOSE_VERSION=$(docker compose version --short 2>/dev/null || printf 'not-used')
P2PRPC_REVISION=$(git -C "$P2PRPC_CORE" rev-parse HEAD 2>/dev/null || printf 'unavailable')
SOURCE_DIGEST=$(
  cd "$REPO_ROOT"
  find . -type f \
    ! -path './node_modules/*' \
    ! -path '*/node_modules/*' \
    ! -path '*/dist/*' \
    ! -path './receipts/*' \
    ! -path './.agent-multiplex/*' \
    -print0 \
    | sort -z \
    | xargs -0 sha256sum \
    | sha256sum \
    | awk '{print $1}'
)

capture_logs

jq -n \
  --arg hostName "$HOST_CONTAINER" \
  --arg hostId "$HOST_CONTAINER_ID" \
  --arg workerName "$WORKER_CONTAINER" \
  --arg workerId "$WORKER_CONTAINER_ID" \
  --arg network "$NETWORK_NAME" \
  --arg image "$IMAGE_ID" \
  --arg dashboard "$DASHBOARD_URL" \
  --arg endpoint "$P2P_ENDPOINT_ID" \
  --arg ticketDigest "$P2P_TICKET_SHA256" '
    {
      applicationContainerCount: 2,
      sharedImageId: $image,
      network: { name: $network, driver: "bridge" },
      containers: [
        {
          name: $hostName,
          id: $hostId,
          role: "canonical metadata host + tRPC/HTTP dashboard",
          publishedDashboard: $dashboard
        },
        {
          name: $workerName,
          id: $workerId,
          role: "Multiplex runtime node + Codex app-server child",
          publishedPorts: []
        }
      ],
      transport: {
        protocol: "p2prpc v1 over Iroh",
        hostEndpointId: $endpoint,
        ticketRecorded: false,
        ticketSha256: $ticketDigest
      },
      browserRunsOnDockerHost: true
    }
  ' >"$RECEIPT_DIR/topology.json"

RUN_COMPLETED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
jq -n \
  --arg runId "$RUN_ID" \
  --arg startedAt "$RUN_STARTED_AT" \
  --arg completedAt "$RUN_COMPLETED_AT" \
  --arg docker "$DOCKER_VERSION" \
  --arg compose "$COMPOSE_VERSION" \
  --arg node "$NODE_VERSION" \
  --arg codex "$CODEX_VERSION" \
  --arg model "$MODEL" \
  --arg image "$IMAGE_ID" \
  --arg sourceDigest "$SOURCE_DIGEST" \
  --arg p2prpcRevision "$P2PRPC_REVISION" \
  --arg sessionId "$SESSION_ID" \
  --arg vendorSessionId "$VENDOR_SESSION_ID" \
  --arg phase1TurnId "$PHASE1_TURN_ID" \
  --arg phase2TurnId "$PHASE2_TURN_ID" \
  --arg phase1RuntimeEpoch "$PHASE1_RUNTIME_EPOCH" \
  --arg phase2RuntimeEpoch "$PHASE2_RUNTIME_EPOCH" \
  --argjson bindingRevision "$BINDING_REVISION" '
    {
      runId: $runId,
      status: "passed",
      startedAt: $startedAt,
      completedAt: $completedAt,
      versions: {
        dockerServer: $docker,
        dockerComposeAvailable: $compose,
        nodeInImage: $node,
        codex: $codex,
        multiplexProtocol: 1,
        p2prpcRevision: $p2prpcRevision
      },
      model: $model,
      imageId: $image,
      sourceTreeSha256: $sourceDigest,
      identities: {
        logicalSessionId: $sessionId,
        codexThreadId: $vendorSessionId,
        bindingRevision: $bindingRevision,
        phase1TurnId: $phase1TurnId,
        phase2TurnId: $phase2TurnId,
        phase1RuntimeEpoch: $phase1RuntimeEpoch,
        phase2RuntimeEpoch: $phase2RuntimeEpoch
      },
      credentialMaterialRecorded: false
    }
  ' >"$RECEIPT_DIR/manifest.json"

jq -n \
  --arg proofSha256 "$PROOF_SHA256" '
    {
      passed: true,
      topology: {
        exactlyTwoApplicationContainers: true,
        distinctHostAndWorker: true,
        workerPublishesNoPorts: true,
        playwrightRanOnDockerHost: true
      },
      codexAdapter: {
        catalogAvailable: true,
        nativeModelsListed: true,
        spawnAcknowledged: true,
        phase1NativeTurnCompleted: true,
        phase1ExactReplyInNativeThreadRead: true,
        stopConvergedToResumable: true,
        resumedSameLogicalAndVendorSession: true,
        resumeCreatedFreshRuntimeEpoch: true,
        bindingRevisionPreserved: true,
        phase2NativeTurnCompleted: true,
        bothRepliesInNativeThreadRead: true,
        exactWorkspaceWrite: true,
        liveAppServerProcessObserved: true,
        finalStopConvergedToResumable: true
      },
      proofFileSha256: $proofSha256,
      screenshotsCaptured: 2,
      credentials: {
        hostCodexLbKeyCopiedAtRuntime: true,
        authJsonCopied: false,
        providerConfigRecorded: false,
        keyRecorded: false,
        leakScanPassed: true
      }
    }
  ' >"$RECEIPT_DIR/checks.json"

{
  printf '# Codex adapter two-container E2E receipt\n\n'
  printf 'Status: **PASS**\n\n'
  printf 'Run: `%s`\n\n' "$RUN_ID"
  printf 'This run used exactly two application containers: one canonical Agent Multiplex host, and one worker running the real Codex 0.152 app-server. Playwright ran on the Docker host.\n\n'
  printf 'The worker started with a fresh Codex home in its disposable container layer. After container creation, the runner copied only the host codex-lb provider key and a minimal provider config into it. No auth.json, host histories, Codex databases, shared fleet secret, provider endpoint, raw P2P ticket, or key is present in this receipt.\n\n'
  printf '## Verified behavior\n\n'
  printf -- '- Worker registration, Codex catalog availability, and native model listing.\n'
  printf -- '- Real phase-1 inference: accepted turn/start, multiplexed native turn/completed, and the exact final marker in native thread/read history.\n'
  printf -- '- Stop and native inventory refresh converging to resumable/stopped.\n'
  printf -- '- Resume preserving logical session, Codex thread, and binding revision while creating a fresh runtime epoch.\n'
  printf -- '- Real phase-2 inference and an exact workspace-write proof file (SHA-256 `%s`).\n' "$PROOF_SHA256"
  printf -- '- Final stop returning the thread to resumable/stopped.\n'
  printf -- '- Dashboard screenshots while the original and resumed runtime were active and idle.\n\n'
  printf 'The dashboard is intentionally read-only; screenshots prove fleet/session visibility. `logs/fleet-events.ndjson` and the two native `thread/read` receipts prove model execution and output.\n\n'
  printf '## Primary evidence\n\n'
  printf -- '- `topology.json` and `auth-copy-proof.json`\n'
  printf -- '- `rpc/spawn.json`, `rpc/send-phase1.json`, and `rpc/send-phase2.json`\n'
  printf -- '- `logs/fleet-events.ndjson`\n'
  printf -- '- `rpc/native-history-phase1.json` and `rpc/native-history-final.json`\n'
  printf -- '- `workspace/codex-adapter-proof.txt` and `workspace/file-proof.txt`\n'
  printf -- '- `screenshots/dashboard-active-idle.png` and `screenshots/dashboard-resumed-idle.png`\n'
  printf -- '- Sanitized `logs/host.log` and `logs/worker.log`\n'
} >"$RECEIPT_DIR/README.md"

for forbidden in "$SHARED_SECRET" "$P2P_TICKET" "$API_KEY_LITERAL" "$PROVIDER_URL"; do
  if [[ -n "$forbidden" ]] && rg --text --fixed-strings --quiet -- "$forbidden" "$RECEIPT_DIR"; then
    fail "credential/provider material leaked into the receipt directory"
  fi
done

(
  cd "$RECEIPT_DIR"
  find . -type f ! -name SHA256SUMS -print0 \
    | sort -z \
    | xargs -0 sha256sum \
    >SHA256SUMS
  sha256sum --check SHA256SUMS >/dev/null
)

COMPLETED=1
