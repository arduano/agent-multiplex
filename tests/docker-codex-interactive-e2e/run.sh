#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/../.." && pwd)
P2PRPC_CORE=${AGENT_MULTIPLEX_P2PRPC_CORE:-"$REPO_ROOT/../p2prpc/packages/core"}
CODEX_SOURCE_CONFIG=${AGENT_MULTIPLEX_CODEX_SOURCE_CONFIG:-"${HOME}/.codex/config.toml"}
CODEX_SOURCE_KEY=${AGENT_MULTIPLEX_CODEX_SOURCE_KEY:-"${HOME}/.codex/codex-lb-api-key"}
RECEIPT_ROOT=${AGENT_MULTIPLEX_INTERACTIVE_E2E_RECEIPT_ROOT:-"$REPO_ROOT/receipts/codex-interactive-docker-e2e"}
INITIAL_MODEL=${AGENT_MULTIPLEX_INTERACTIVE_E2E_MODEL:-gpt-5.6-sol}

for tool in docker jq node curl sha256sum awk sed perl rg timeout stat; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "interactive Docker Codex E2E: required tool '$tool' is unavailable" >&2
    exit 1
  fi
done

if [[ ! -f "$P2PRPC_CORE/package.json" || ! -d "$P2PRPC_CORE/dist" ]]; then
  echo "interactive Docker Codex E2E: p2prpc core with built dist is required at $P2PRPC_CORE" >&2
  exit 1
fi
if [[ ! -r "$CODEX_SOURCE_CONFIG" ]]; then
  echo "interactive Docker Codex E2E: Codex source config is not readable: $CODEX_SOURCE_CONFIG" >&2
  exit 1
fi
if [[ ! -r "$CODEX_SOURCE_KEY" ]]; then
  echo "interactive Docker Codex E2E: codex-lb source key is not readable: $CODEX_SOURCE_KEY" >&2
  exit 1
fi

random_hex() {
  node -e 'process.stdout.write(require("node:crypto").randomBytes(6).toString("hex"))'
}

RUN_ID=${AGENT_MULTIPLEX_INTERACTIVE_E2E_RUN_ID:-"$(date -u +%Y%m%dT%H%M%SZ)-$(random_hex)"}
if [[ ! "$RUN_ID" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "interactive Docker Codex E2E: run id must contain only letters, digits, dot, underscore, or dash" >&2
  exit 1
fi

RECEIPT_DIR="$RECEIPT_ROOT/$RUN_ID"
if [[ -e "$RECEIPT_DIR" ]]; then
  echo "interactive Docker Codex E2E: receipt directory already exists: $RECEIPT_DIR" >&2
  exit 1
fi
mkdir -p \
  "$RECEIPT_DIR/logs" \
  "$RECEIPT_DIR/phases" \
  "$RECEIPT_DIR/rpc" \
  "$RECEIPT_DIR/screenshots"

RUNTIME_DIR=$(mktemp -d "${TMPDIR:-/tmp}/agent-multiplex-codex-interactive-e2e.XXXXXXXX")
WORKSPACE_DIR="$RUNTIME_DIR/workspace"
mkdir -p "$WORKSPACE_DIR"

NAME_SUFFIX=$(printf '%s' "$RUN_ID" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9' | tail -c 24)
HOST_CONTAINER="agent-multiplex-interactive-host-$NAME_SUFFIX"
WORKER_CONTAINER="agent-multiplex-interactive-worker-$NAME_SUFFIX"
NETWORK_NAME="agent-multiplex-interactive-$NAME_SUFFIX"
IMAGE_TAG="agent-multiplex-interactive:$NAME_SUFFIX"
WORKER_NAME="docker-codex-interactive-$NAME_SUFFIX"
SESSION_TITLE="Codex Interactive E2E $RUN_ID"
NONCE=$(printf '%s' "$(random_hex)" | tr '[:lower:]' '[:upper:]')

STREAM_MARKER="STREAM_${NONCE}_ALPHA_BRAVO_CHARLIE_DELTA_ECHO_FOXTROT"
MODEL_MARKER="MODEL_SWITCHED_$NONCE"
PLAN_ANSWER="typed-answer-$NONCE"
PLAN_FINAL="PLAN_ANSWER_${NONCE}:$PLAN_ANSWER"
STEER_ORIGINAL="UNSTEERED_$NONCE"
STEER_FINAL="STEERED_$NONCE"
STEER_PREFIX="STEER_WAIT_$NONCE"
STEER_OUTPUT_PREFIX="${STEER_PREFIX}_"
LONG_PREFIX="LONG_$NONCE"
LONG_SECOND_TICK="${LONG_PREFIX}_002"
SUBAGENT_CHILD="SUBAGENT_CHILD_$NONCE"
SUBAGENT_PARENT="SUBAGENT_PARENT_$NONCE"

SHARED_SECRET=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(48).toString("base64url"))')
RUN_STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

HOST_STARTED=0
WORKER_STARTED=0
NETWORK_CREATED=0
IMAGE_BUILT=0
LOGS_CAPTURED=0
COMPLETED=0
WATCH_PID=""
CAPTURE_PID=""
CAPTURE_SCREENSHOT=""
CAPTURE_RECEIPT=""
P2P_TICKET=""
PROVIDER_URL=""
API_KEY_LITERAL=""
SESSION_ID=""
SECOND_MODEL=""
MULTI_MODEL=""
MULTI_EFFORT=""

note() {
  printf '[codex-interactive-e2e] %s\n' "$*" >&2
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
  if [[ -n "$CAPTURE_PID" ]] && kill -0 "$CAPTURE_PID" 2>/dev/null; then
    kill "$CAPTURE_PID" 2>/dev/null
    wait "$CAPTURE_PID" 2>/dev/null
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
  if (( IMAGE_BUILT == 1 )) && [[ ${AGENT_MULTIPLEX_INTERACTIVE_E2E_KEEP_IMAGE:-0} != 1 ]]; then
    docker image rm "$IMAGE_TAG" >/dev/null 2>&1
  fi
  if [[ -n "$RUNTIME_DIR" && -d "$RUNTIME_DIR" && "$RUNTIME_DIR" != "/" && \
        "$(basename -- "$RUNTIME_DIR")" == agent-multiplex-codex-interactive-e2e.* ]]; then
    rm -rf -- "$RUNTIME_DIR"
  fi
  if (( COMPLETED == 0 )); then
    printf 'The interactive Docker Codex E2E run failed. Inspect logs/ and partial phase receipts.\n' \
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
  timeout 240s docker exec "$HOST_CONTAINER" \
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

wait_for_events() {
  local description=$1
  local filter=$2
  local limit=${3:-300}
  local attempt
  shift 3
  for attempt in $(seq 1 "$limit"); do
    if jq -e \
      --arg sid "$SESSION_ID" \
      --arg stream "$STREAM_MARKER" \
      --arg model "$SECOND_MODEL" \
      --arg modelMarker "$MODEL_MARKER" \
      --arg planAnswer "$PLAN_ANSWER" \
      --arg planFinal "$PLAN_FINAL" \
      --arg steerFinal "$STEER_FINAL" \
      --arg steerOriginal "$STEER_ORIGINAL" \
      --arg steerOutputPrefix "$STEER_OUTPUT_PREFIX" \
      --arg longPrefix "$LONG_PREFIX" \
      --arg longSecond "$LONG_SECOND_TICK" \
      --arg child "$SUBAGENT_CHILD" \
      --arg parent "$SUBAGENT_PARENT" \
      "$@" "$filter" "$RECEIPT_DIR/logs/fleet-events.ndjson" >/dev/null 2>&1; then
      return
    fi
    if ! kill -0 "$WATCH_PID" 2>/dev/null; then
      fail "fleet watch exited while waiting for $description"
      return
    fi
    if (( attempt % 20 == 0 )); then
      note "waiting for $description (${attempt}s)"
    fi
    sleep 1
  done
  tail -n 20 "$RECEIPT_DIR/logs/fleet-events.ndjson" \
    >"$RECEIPT_DIR/logs/timeout-last-events.ndjson" || true
  fail "timed out waiting for $description"
}

start_dashboard_capture() {
  local phase=$1
  local expected=$2
  local response_json=${3:-}
  local wait_seconds=${4:-30}
  if [[ -n "$CAPTURE_PID" ]]; then
    fail "a Playwright dashboard capture is already running"
  fi
  CAPTURE_SCREENSHOT="$RECEIPT_DIR/screenshots/$phase.png"
  CAPTURE_RECEIPT="$RECEIPT_DIR/rpc/playwright-$phase.json"
  AGENT_MULTIPLEX_CAPTURE_WAIT_MS="$((wait_seconds * 1000))" \
  timeout "$((wait_seconds + 30))s" node "$SCRIPT_DIR/capture.mjs" \
    "$DASHBOARD_URL" \
    "$CAPTURE_SCREENSHOT" \
    "$RECEIPT_DIR/logs/browser-console.txt" \
    "$WORKER_NAME" \
    "$SESSION_TITLE" \
    "$phase" \
    "$expected" \
    "$response_json" >"$CAPTURE_RECEIPT" 2>>"$RECEIPT_DIR/logs/playwright.log" &
  CAPTURE_PID=$!
}

finish_dashboard_capture() {
  local capture_pid=$CAPTURE_PID
  if [[ -z "$capture_pid" ]]; then
    fail "no Playwright dashboard capture is running"
  fi
  CAPTURE_PID=""
  if ! wait "$capture_pid"; then
    return 1
  fi
  [[ -s "$CAPTURE_SCREENSHOT" && -s "$CAPTURE_RECEIPT" ]]
}

cancel_dashboard_capture() {
  local capture_pid=$CAPTURE_PID
  CAPTURE_PID=""
  if [[ -n "$capture_pid" ]] && kill -0 "$capture_pid" 2>/dev/null; then
    kill "$capture_pid" 2>/dev/null || true
    wait "$capture_pid" 2>/dev/null || true
  fi
}

capture_dashboard() {
  start_dashboard_capture "$@"
  if ! finish_dashboard_capture; then
    fail "Playwright dashboard capture failed"
  fi
}

phase_events() {
  local turn_id=$1
  local destination=$2
  jq -c --arg sid "$SESSION_ID" --arg tid "$turn_id" '
    select(
      (.kind == "native" and .sessionId == $sid and
        (.payload.turnId == $tid or .payload.turn.id == $tid)) or
      (.kind == "control" and .change.interaction.sessionId == $sid and
        .change.interaction.payload.params.turnId == $tid)
    )
  ' "$RECEIPT_DIR/logs/fleet-events.ndjson" >"$destination"
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
  /usr/local/bin/agent-multiplex-interactive-e2e-runtime-node >/dev/null
WORKER_STARTED=1

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
run_cli "$RECEIPT_DIR/rpc/catalog.json" catalog "$WORKER_NAME"
assert_json "required interactive Codex capabilities are not all advertised" '
  any(.[];
    .harness == "codex" and .available == true and
    ([.capabilities[].name] | contains([
      "thread.start", "thread.read-native-history", "turn.steer", "turn.interrupt",
      "models.list", "models.switch", "reasoning-effort.switch",
      "collaboration-mode", "interactive-requests"
    ])))
' "$RECEIPT_DIR/rpc/catalog.json"

run_cli "$RECEIPT_DIR/rpc/models.json" models "$WORKER_NAME" codex
assert_json "requested initial model is absent" \
  'any(.[]; .id == $model)' "$RECEIPT_DIR/rpc/models.json" --arg model "$INITIAL_MODEL"
SECOND_MODEL=$(jq -r --arg current "$INITIAL_MODEL" '
  ([.[] | select(.id == "gpt-5.6-terra" and .id != $current and (.native.hidden // false) == false)] +
   [.[] | select(.id != $current and (.native.hidden // false) == false)])[0].id // empty
' "$RECEIPT_DIR/rpc/models.json")
if [[ -z "$SECOND_MODEL" ]]; then
  fail "model-switch receipt requires a second visible Codex model"
fi
MULTI_MODEL=$(jq -r '
  ([.[] | select(
      (.native.multiAgentVersion // "disabled") != "disabled" and
      any(.native.supportedReasoningEfforts[]?; .reasoningEffort == "ultra")
    )] +
   [.[] | select((.native.multiAgentVersion // "disabled") != "disabled")])[0].id // empty
' "$RECEIPT_DIR/rpc/models.json")
if [[ -z "$MULTI_MODEL" ]]; then
  fail "subagent receipt requires a model advertising native multi-agent support"
fi

METADATA_ASSIGNMENT="agent.title=$(jq -Rn --arg value "$SESSION_TITLE" '$value')"
note "spawning a real Codex thread through the Multiplex API"
run_cli "$RECEIPT_DIR/rpc/spawn.json" \
  spawn "$WORKER_NAME" codex /workspace/e2e \
  --model "$INITIAL_MODEL" \
  --effort low \
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
timeout 2400s docker exec "$HOST_CONTAINER" \
  node /opt/src/agent-multiplex/apps/cli/dist/main.js \
  --host http://127.0.0.1:4317/trpc \
  --json watch "$SESSION_ID" \
  >"$RECEIPT_DIR/logs/fleet-events.ndjson" \
  2>"$RECEIPT_DIR/logs/watch.log" &
WATCH_PID=$!
wait_for_watch

note "phase 1/6: proving lossless agent-message delta streaming"
run_cli "$RECEIPT_DIR/rpc/send-streaming.json" \
  send "$SESSION_ID" "Reply with exactly $STREAM_MARKER and nothing else."
assert_json "streaming turn was not accepted" '.state == "succeeded"' \
  "$RECEIPT_DIR/rpc/send-streaming.json"
STREAM_TURN_ID=$(jq -r '.result.turn.id' "$RECEIPT_DIR/rpc/send-streaming.json")
wait_for_events "streaming turn completion" '
  select(.kind == "native" and .sessionId == $sid and
    .nativeType == "turn/completed" and .payload.turn.id == $streamTurn and
    .payload.turn.status == "completed")
' 300 --arg streamTurn "$STREAM_TURN_ID"

wait_for_events "exact streamed final marker" '
  select(.kind == "native" and .sessionId == $sid and
    .nativeType == "item/completed" and
    .payload.item.type == "agentMessage" and .payload.item.text == $stream)
' 300
STREAM_ITEM_ID=$(jq -r --arg sid "$SESSION_ID" --arg tid "$STREAM_TURN_ID" '
  select(.kind == "native" and .sessionId == $sid and
    .nativeType == "item/completed" and .payload.turnId == $tid and
    .payload.item.type == "agentMessage") | .payload.item.id
' "$RECEIPT_DIR/logs/fleet-events.ndjson" | tail -n 1)
jq -s \
  --arg sid "$SESSION_ID" \
  --arg tid "$STREAM_TURN_ID" \
  --arg iid "$STREAM_ITEM_ID" \
  --arg marker "$STREAM_MARKER" '
    [.[] | select(.kind == "native" and .sessionId == $sid)] as $events |
    [$events[] | select(
      .nativeType == "item/agentMessage/delta" and
      .payload.turnId == $tid and .payload.itemId == $iid
    )] as $deltas |
    [$events[] | select(
      .nativeType == "item/completed" and .payload.turnId == $tid and
      .payload.item.id == $iid and .payload.item.type == "agentMessage"
    )][0] as $completed |
    [$events[] | select(
      .nativeType == "turn/completed" and .payload.turn.id == $tid
    )][0] as $turn |
    ($deltas | length) >= 2 and
    ($deltas | map(.payload.delta) | join("")) == $marker and
    $completed.payload.item.text == $marker and
    $turn.payload.turn.status == "completed" and
    ($deltas | all(.runtimeEpoch == $completed.runtimeEpoch)) and
    ($deltas | all(.sequence > 0 and .sequence < $completed.sequence)) and
    $completed.sequence < $turn.sequence
  ' "$RECEIPT_DIR/logs/fleet-events.ndjson" >"$RECEIPT_DIR/phases/streaming-assertions.json"
assert_json "streaming delta invariants failed" '. == true' \
  "$RECEIPT_DIR/phases/streaming-assertions.json"
phase_events "$STREAM_TURN_ID" "$RECEIPT_DIR/phases/streaming-events.ndjson"

note "phase 2/6: switching to a second native model"
run_cli "$RECEIPT_DIR/rpc/set-model.json" model "$SESSION_ID" "$SECOND_MODEL"
assert_json "model switch command failed" '.state == "succeeded"' "$RECEIPT_DIR/rpc/set-model.json"
wait_for_events "native model settings update" '
  select(.kind == "native" and .sessionId == $sid and
    .nativeType == "thread/settings/updated" and
    .payload.threadSettings.model == $model)
' 120
run_cli "$RECEIPT_DIR/rpc/send-model.json" \
  send "$SESSION_ID" "Reply with exactly $MODEL_MARKER and nothing else."
MODEL_TURN_ID=$(jq -r '.result.turn.id' "$RECEIPT_DIR/rpc/send-model.json")
wait_for_events "model-switch marker completion" '
  select(.kind == "native" and .sessionId == $sid and
    .nativeType == "item/completed" and .payload.item.type == "agentMessage" and
    .payload.item.text == $modelMarker)
' 300
wait_for_events "model-switch turn completion" '
  select(.kind == "native" and .sessionId == $sid and
    .nativeType == "turn/completed" and .payload.turn.id == $modelTurn and
    .payload.turn.status == "completed")
' 120 --arg modelTurn "$MODEL_TURN_ID"
phase_events "$MODEL_TURN_ID" "$RECEIPT_DIR/phases/model-events.ndjson"
jq -s --arg sid "$SESSION_ID" --arg model "$SECOND_MODEL" --arg tid "$MODEL_TURN_ID" --arg marker "$MODEL_MARKER" '
  any(.[]; .kind == "native" and .sessionId == $sid and
    .nativeType == "thread/settings/updated" and .payload.threadSettings.model == $model) and
  any(.[]; .kind == "native" and .sessionId == $sid and
    .nativeType == "turn/completed" and .payload.turn.id == $tid and
    .payload.turn.status == "completed" and
    any(.payload.turn.items[]?; .type == "agentMessage" and .text == $marker))
' "$RECEIPT_DIR/logs/fleet-events.ndjson" >"$RECEIPT_DIR/phases/model-assertions.json"
assert_json "model switch native evidence is incomplete" '. == true' \
  "$RECEIPT_DIR/phases/model-assertions.json"

note "phase 3/6: Plan mode, request_user_input, and a typed response"
run_cli "$RECEIPT_DIR/rpc/set-mode-plan.json" mode "$SESSION_ID" plan
assert_json "Plan mode command failed" '.state == "succeeded"' "$RECEIPT_DIR/rpc/set-mode-plan.json"
wait_for_events "Plan collaboration-mode settings update" '
  select(.kind == "native" and .sessionId == $sid and
    .nativeType == "thread/settings/updated" and
    .payload.threadSettings.collaborationMode.mode == "plan")
' 120
PLAN_PROMPT=$(printf '%s' \
  "This is an interactive transport receipt. In Plan mode, call request_user_input exactly once before replying. " \
  "Use question id receipt_choice, header Receipt, question 'Choose the receipt value', isOther true, and exactly two options Alpha and Beta. " \
  "After receiving the typed answer, reply with exactly PLAN_ANSWER_${NONCE}:<typed answer> and nothing else.")
run_cli "$RECEIPT_DIR/rpc/send-plan.json" send "$SESSION_ID" "$PLAN_PROMPT"
PLAN_TURN_ID=$(jq -r '.result.turn.id' "$RECEIPT_DIR/rpc/send-plan.json")

PLAN_INTERACTION_FILE="$RUNTIME_DIR/plan-interaction-poll.json"
PLAN_INTERACTION_READY=0
for attempt in $(seq 1 300); do
  if cli_raw interactions "$SESSION_ID" >"$PLAN_INTERACTION_FILE" 2>/dev/null && jq -e \
    --arg tid "$PLAN_TURN_ID" '
      any(.[];
        .state == "pending" and .requestType == "userInput" and
        .payload.method == "item/tool/requestUserInput" and
        .payload.params.turnId == $tid and
        any(.payload.params.questions[]?;
          .id == "receipt_choice" and .header == "Receipt" and
          .question == "Choose the receipt value" and .isOther == true and
          (.options | length) == 2 and
          (.options[0].label | startswith("Alpha")) and
          .options[1].label == "Beta")
      )
    ' "$PLAN_INTERACTION_FILE" >/dev/null; then
    PLAN_INTERACTION_READY=1
    break
  fi
  if jq -e --arg tid "$PLAN_TURN_ID" '
    select(.kind == "native" and .nativeType == "turn/completed" and .payload.turn.id == $tid)
  ' "$RECEIPT_DIR/logs/fleet-events.ndjson" >/dev/null 2>&1; then
    fail "Plan turn completed without producing the required request_user_input"
  fi
  if (( attempt % 20 == 0 )); then
    note "waiting for canonical Plan-mode interaction (${attempt}s)"
  fi
  sleep 1
done
if (( PLAN_INTERACTION_READY == 0 )); then
  fail "timed out waiting for canonical Plan-mode interaction"
fi
cp "$PLAN_INTERACTION_FILE" "$RECEIPT_DIR/rpc/interactions-plan-pending.json"
PLAN_INTERACTION_ID=$(jq -r --arg tid "$PLAN_TURN_ID" '
  .[] | select(.state == "pending" and .requestType == "userInput" and .payload.params.turnId == $tid) |
  .interactionId
' "$RECEIPT_DIR/rpc/interactions-plan-pending.json")
PLAN_NATIVE_REQUEST_ID=$(jq -r --arg iid "$PLAN_INTERACTION_ID" '
  .[] | select(.interactionId == $iid) | .nativeRequestId
' "$RECEIPT_DIR/rpc/interactions-plan-pending.json")
run_cli "$RECEIPT_DIR/rpc/sessions-plan-pending.json" \
  sessions --worker "$WORKER_NAME" --harness codex
assert_json "blocking user input did not set waitingForInput" '
  any(.[]; .sessionId == $sid and .runtimeStatus == "waitingForInput")
' "$RECEIPT_DIR/rpc/sessions-plan-pending.json" --arg sid "$SESSION_ID"
PLAN_RESPONSE=$(jq -cn --arg answer "$PLAN_ANSWER" \
  '{answers:{receipt_choice:{answers:[$answer]}}}')
capture_dashboard plan-pending "Choose the receipt value" "$PLAN_RESPONSE"
assert_json "Plan screenshot receipt lacks the typed pending response" '
  .assertions.expectedTextVisible == true and
  (.visible.pendingInteraction | contains("requestUserInput")) and
  (.visible.pendingResponse | fromjson |
    .answers.receipt_choice.answers == [$answer])
' "$RECEIPT_DIR/rpc/playwright-plan-pending.json" --arg answer "$PLAN_ANSWER"
run_cli "$RECEIPT_DIR/rpc/resolve-plan.json" \
  resolve "$PLAN_INTERACTION_ID" "$PLAN_RESPONSE"
assert_json "Plan interaction resolution failed" '
  .state == "resolved" and
  .resolution.answers.receipt_choice.answers == [$answer]
' "$RECEIPT_DIR/rpc/resolve-plan.json" --arg answer "$PLAN_ANSWER"
wait_for_events "typed Plan answer in the final reply" '
  select(.kind == "native" and .sessionId == $sid and
    .nativeType == "item/completed" and .payload.item.type == "agentMessage" and
    .payload.item.text == $planFinal)
' 300
wait_for_events "Plan turn completion" '
  select(.kind == "native" and .sessionId == $sid and
    .nativeType == "turn/completed" and .payload.turn.id == $planTurn and
    .payload.turn.status == "completed")
' 120 --arg planTurn "$PLAN_TURN_ID"
run_cli "$RECEIPT_DIR/rpc/interactions-plan-resolved.json" \
  interactions "$SESSION_ID" --all
assert_json "canonical Plan interaction did not remain resolved" '
  any(.[];
    .interactionId == $iid and .state == "resolved" and
    .resolution.answers.receipt_choice.answers == [$answer])
' "$RECEIPT_DIR/rpc/interactions-plan-resolved.json" \
  --arg iid "$PLAN_INTERACTION_ID" --arg answer "$PLAN_ANSWER"
wait_for_events "native serverRequest/resolved notification" '
  select(.kind == "native" and .sessionId == $sid and
    .nativeType == "serverRequest/resolved" and
    (.payload.requestId | tostring) == $requestId)
' 120 --arg requestId "$PLAN_NATIVE_REQUEST_ID"
phase_events "$PLAN_TURN_ID" "$RECEIPT_DIR/phases/plan-events.ndjson"

run_cli "$RECEIPT_DIR/rpc/set-mode-default.json" mode "$SESSION_ID" default
assert_json "return to default mode failed" '.state == "succeeded"' \
  "$RECEIPT_DIR/rpc/set-mode-default.json"

note "phase 4/6: steering an in-flight turn without starting a second turn"
STEER_COMMAND='for i in $(seq 1 20); do printf '\''STEER_WAIT_'"$NONCE"'_%02d\n'\'' "$i"; sleep 1; done'
STEER_PROMPT=$(printf '%s' \
  "Execute exactly this shell command and wait for it to finish: $STEER_COMMAND " \
  "Then reply with exactly $STEER_ORIGINAL and nothing else.")
run_cli "$RECEIPT_DIR/rpc/send-steer.json" send "$SESSION_ID" "$STEER_PROMPT"
STEER_TURN_ID=$(jq -r '.result.turn.id' "$RECEIPT_DIR/rpc/send-steer.json")
wait_for_events "steer command output" '
  select(.kind == "native" and .sessionId == $sid and
    .nativeType == "item/commandExecution/outputDelta" and
    (.payload.delta | contains($steerOutputPrefix)))
' 300
STEER_INPUT="Replace the final reply with exactly $STEER_FINAL and nothing else."
run_cli "$RECEIPT_DIR/rpc/steer.json" \
  steer "$SESSION_ID" "$STEER_INPUT" \
  --expected-turn "$STEER_TURN_ID"
assert_json "turn/steer did not acknowledge the expected active turn" '
  .state == "succeeded" and .result.turnId == $tid
' "$RECEIPT_DIR/rpc/steer.json" --arg tid "$STEER_TURN_ID"
wait_for_events "steered final marker" '
  select(.kind == "native" and .sessionId == $sid and
    .nativeType == "item/completed" and .payload.item.type == "agentMessage" and
    .payload.item.text == $steerFinal)
' 300
wait_for_events "steered turn completion" '
  select(.kind == "native" and .sessionId == $sid and
    .nativeType == "turn/completed" and .payload.turn.id == $steerTurn and
    .payload.turn.status == "completed")
' 120 --arg steerTurn "$STEER_TURN_ID"
phase_events "$STEER_TURN_ID" "$RECEIPT_DIR/phases/steer-events.ndjson"
jq -s --arg sid "$SESSION_ID" --arg tid "$STEER_TURN_ID" --arg final "$STEER_FINAL" --arg original "$STEER_ORIGINAL" --arg outputPrefix "$STEER_OUTPUT_PREFIX" --arg steerInput "$STEER_INPUT" '
  [.[] | select(.kind == "native" and .sessionId == $sid)] as $events |
  [$events[] | select(.nativeType == "item/commandExecution/outputDelta" and
    .payload.turnId == $tid and (.payload.delta | contains($outputPrefix)))] as $outputs |
  [$events[] | select(.nativeType == "item/started" and .payload.turnId == $tid and
    .payload.item.type == "userMessage" and
    any(.payload.item.content[]?; .type == "text" and .text == $steerInput))] as $steeredInputs |
  ([$events[] | select(.nativeType == "turn/started" and .payload.turn.id == $tid)] | length) == 1 and
  ($outputs | length) >= 1 and ($steeredInputs | length) == 1 and
  $outputs[0].sequence < $steeredInputs[0].sequence and
  any($events[]; .nativeType == "turn/completed" and .payload.turn.id == $tid and
    .payload.turn.status == "completed") and
  any($events[]; .nativeType == "item/completed" and .payload.turnId == $tid and
    .payload.item.type == "agentMessage" and .payload.item.text == $final) and
  (any($events[]; .nativeType == "item/completed" and .payload.turnId == $tid and
    .payload.item.type == "agentMessage" and .payload.item.text == $original) | not)
' "$RECEIPT_DIR/logs/fleet-events.ndjson" >"$RECEIPT_DIR/phases/steer-assertions.json"
assert_json "steer did not preserve the turn or replace its final answer" '. == true' \
  "$RECEIPT_DIR/phases/steer-assertions.json"

note "phase 5/6: interrupting a visible long-running command"
LONG_COMMAND='for i in $(seq 1 120); do printf '\''LONG_'"$NONCE"'_%03d\n'\'' "$i"; sleep 1; done'
LONG_PROMPT=$(printf '%s' \
  "Execute exactly this shell command and wait for it to finish: $LONG_COMMAND " \
  "After it finishes, reply with exactly LONG_FINISHED_$NONCE.")
start_dashboard_capture command-running "$LONG_SECOND_TICK" "" 120
run_cli "$RECEIPT_DIR/rpc/send-interrupt.json" send "$SESSION_ID" "$LONG_PROMPT"
INTERRUPT_TURN_ID=$(jq -r '.result.turn.id' "$RECEIPT_DIR/rpc/send-interrupt.json")
wait_for_events "at least two visible long-command ticks" '
  select(.kind == "native" and .sessionId == $sid and
    .nativeType == "item/commandExecution/outputDelta" and
    (.payload.delta | contains($longSecond)))
' 180
run_cli "$RECEIPT_DIR/rpc/sessions-interrupt-running.json" \
  sessions --worker "$WORKER_NAME" --harness codex
assert_json "session was not running before interrupt" '
  any(.[]; .sessionId == $sid and .runtimeStatus == "running")
' "$RECEIPT_DIR/rpc/sessions-interrupt-running.json" --arg sid "$SESSION_ID"
if ! finish_dashboard_capture; then
  fail "Playwright did not capture the command while output was streaming"
fi
assert_json "running-command screenshot receipt lacks the streamed second tick" '
  .assertions.expectedTextVisible == true and
  (.visible.eventCounts.commandExecution | test(" [1-9][0-9]*$")) and
  (any(.visible.recentEvents[]; contains($tick)))
' "$RECEIPT_DIR/rpc/playwright-command-running.json" --arg tick "$LONG_SECOND_TICK"
INTERRUPT_ITEM_ID=$(jq -r --arg sid "$SESSION_ID" --arg tid "$INTERRUPT_TURN_ID" --arg tick "$LONG_SECOND_TICK" '
  select(.kind == "native" and .sessionId == $sid and
    .nativeType == "item/commandExecution/outputDelta" and
    .payload.turnId == $tid and (.payload.delta | contains($tick))) |
  .payload.itemId
' "$RECEIPT_DIR/logs/fleet-events.ndjson" | tail -n 1)
run_cli "$RECEIPT_DIR/rpc/terminals-interrupt-running.json" \
  terminals "$SESSION_ID" --limit 100
assert_json "running command was absent from Codex background-terminal inventory" '
  .state == "succeeded" and
  any(.result.data[]?;
    .itemId == $itemId and (.processId | type == "string" and length > 0) and
    (.command | contains($prefix)))
' "$RECEIPT_DIR/rpc/terminals-interrupt-running.json" \
  --arg itemId "$INTERRUPT_ITEM_ID" --arg prefix "$LONG_PREFIX"
run_cli "$RECEIPT_DIR/rpc/interrupt.json" \
  interrupt "$SESSION_ID" --turn "$INTERRUPT_TURN_ID"
assert_json "turn/interrupt command failed" \
  '.state == "succeeded" and .result == {}' "$RECEIPT_DIR/rpc/interrupt.json"
wait_for_events "interrupted native turn completion" '
  select(.kind == "native" and .sessionId == $sid and
    .nativeType == "turn/completed" and .payload.turn.id == $interruptTurn and
    .payload.turn.status == "interrupted")
' 180 --arg interruptTurn "$INTERRUPT_TURN_ID"

INTERRUPT_OUTPUT_AT_COMPLETION=$(jq -s -r --arg sid "$SESSION_ID" --arg tid "$INTERRUPT_TURN_ID" '
  [.[] | select(.kind == "native" and .sessionId == $sid and
    .nativeType == "item/commandExecution/outputDelta" and .payload.turnId == $tid) |
    .payload.delta] | join("")
' "$RECEIPT_DIR/logs/fleet-events.ndjson")
INTERRUPT_MAX_AT_COMPLETION=$(printf '%s' "$INTERRUPT_OUTPUT_AT_COMPLETION" \
  | rg -o "${LONG_PREFIX}_[0-9]{3}" \
  | sed -E 's/.*_([0-9]{3})$/\1/' \
  | sort -n \
  | tail -n 1)

# Codex can publish turn/completed before its command runner finishes draining
# cancellation. Prove bounded convergence instead of assuming those two native
# lifecycles become terminal in the same stdout batch.
INTERRUPT_STABLE_POLLS=0
INTERRUPT_PREVIOUS_MAX=""
INTERRUPT_SETTLE_SECONDS=0
for attempt in $(seq 1 30); do
  INTERRUPT_SETTLE_SECONDS=$attempt
  INTERRUPT_CURRENT_MAX=$(jq -s -r --arg sid "$SESSION_ID" --arg tid "$INTERRUPT_TURN_ID" --arg prefix "$LONG_PREFIX" '
    [.[] | select(.kind == "native" and .sessionId == $sid and
      .nativeType == "item/commandExecution/outputDelta" and .payload.turnId == $tid) |
      .payload.delta | scan($prefix + "_[0-9]{3}") |
      capture("_(?<tick>[0-9]{3})$").tick | tonumber] | max // empty
  ' "$RECEIPT_DIR/logs/fleet-events.ndjson")
  if [[ -n "$INTERRUPT_CURRENT_MAX" && "$INTERRUPT_CURRENT_MAX" == "$INTERRUPT_PREVIOUS_MAX" ]]; then
    INTERRUPT_STABLE_POLLS=$((INTERRUPT_STABLE_POLLS + 1))
  else
    INTERRUPT_STABLE_POLLS=0
    INTERRUPT_PREVIOUS_MAX=$INTERRUPT_CURRENT_MAX
  fi
  if (( INTERRUPT_STABLE_POLLS >= 3 )); then
    break
  fi
  sleep 1
done
if (( INTERRUPT_STABLE_POLLS < 3 )); then
  fail "long command output did not stabilize within 30 seconds of interruption"
fi
INTERRUPT_OUTPUT_AFTER=$(jq -s -r --arg sid "$SESSION_ID" --arg tid "$INTERRUPT_TURN_ID" '
  [.[] | select(.kind == "native" and .sessionId == $sid and
    .nativeType == "item/commandExecution/outputDelta" and .payload.turnId == $tid) |
    .payload.delta] | join("")
' "$RECEIPT_DIR/logs/fleet-events.ndjson")
INTERRUPT_MAX_TICK=$(printf '%s' "$INTERRUPT_OUTPUT_AFTER" \
  | rg -o "${LONG_PREFIX}_[0-9]{3}" \
  | sed -E 's/.*_([0-9]{3})$/\1/' \
  | sort -n \
  | tail -n 1)
if [[ -z "$INTERRUPT_MAX_TICK" ]] || (( 10#$INTERRUPT_MAX_TICK < 2 || 10#$INTERRUPT_MAX_TICK >= 30 )); then
  fail "interrupt tick range was not a visible early termination"
fi
wait_for_events "interrupted command terminal item" '
  select(.kind == "native" and .sessionId == $sid and
    .nativeType == "item/completed" and .payload.turnId == $interruptTurn and
    .payload.item.type == "commandExecution" and
    .payload.item.status != "inProgress")
' 30 --arg interruptTurn "$INTERRUPT_TURN_ID"
jq -n \
  --arg atCompletion "$INTERRUPT_MAX_AT_COMPLETION" \
  --arg after "$INTERRUPT_MAX_TICK" \
  --argjson settleSeconds "$INTERRUPT_SETTLE_SECONDS" \
  --arg output "$INTERRUPT_OUTPUT_AFTER" '
  {
    outputStabilizedAfterInterrupt:true,
    requiredStablePolls:3,
    settleObservationSeconds:$settleSeconds,
    maximumTickAtTurnCompletion:($atCompletion|tonumber),
    maximumObservedTick:($after|tonumber),
    output:$output
  }
' >"$RECEIPT_DIR/phases/interrupt-output-proof.json"
phase_events "$INTERRUPT_TURN_ID" "$RECEIPT_DIR/phases/interrupt-events.ndjson"
jq -s --arg sid "$SESSION_ID" --arg tid "$INTERRUPT_TURN_ID" '
  any(.[]; .kind == "native" and .sessionId == $sid and
    .nativeType == "item/started" and .payload.turnId == $tid and
    .payload.item.type == "commandExecution" and .payload.item.status == "inProgress") and
  any(.[]; .kind == "native" and .sessionId == $sid and
    .nativeType == "turn/completed" and .payload.turn.id == $tid and
    .payload.turn.status == "interrupted") and
  any(.[]; .kind == "native" and .sessionId == $sid and
    .nativeType == "item/completed" and .payload.turnId == $tid and
    .payload.item.type == "commandExecution" and .payload.item.status != "inProgress")
' "$RECEIPT_DIR/logs/fleet-events.ndjson" >"$RECEIPT_DIR/phases/interrupt-assertions.json"
assert_json "interrupt lifecycle evidence is incomplete" '. == true' \
  "$RECEIPT_DIR/phases/interrupt-assertions.json"

note "phase 6/6: proving native subagent visibility"
run_cli "$RECEIPT_DIR/rpc/set-model-multiagent.json" model "$SESSION_ID" "$MULTI_MODEL"
assert_json "multi-agent model switch failed" '.state == "succeeded"' \
  "$RECEIPT_DIR/rpc/set-model-multiagent.json"
if jq -e --arg model "$MULTI_MODEL" '
  any(.[]; .id == $model and any(.native.supportedReasoningEfforts[]?; .reasoningEffort == "ultra"))
' "$RECEIPT_DIR/rpc/models.json" >/dev/null; then
  MULTI_EFFORT=ultra
  run_cli "$RECEIPT_DIR/rpc/set-effort-ultra.json" effort "$SESSION_ID" ultra
else
  MULTI_EFFORT=medium
  run_cli "$RECEIPT_DIR/rpc/set-effort-medium.json" effort "$SESSION_ID" medium
fi
EFFORT_RPC="$RECEIPT_DIR/rpc/set-effort-$MULTI_EFFORT.json"
assert_json "reasoning-effort switch failed" '.state == "succeeded"' "$EFFORT_RPC"
wait_for_events "native reasoning-effort settings update" '
  select(.kind == "native" and .sessionId == $sid and
    .nativeType == "thread/settings/updated" and
    .payload.threadSettings.model == $multiModel and
    .payload.threadSettings.effort == $effort and
    .payload.threadSettings.collaborationMode.settings.reasoning_effort == $effort)
' 180 --arg multiModel "$MULTI_MODEL" --arg effort "$MULTI_EFFORT"
jq -s \
  --arg sid "$SESSION_ID" \
  --arg multiModel "$MULTI_MODEL" \
  --arg effort "$MULTI_EFFORT" '
  any(.[]; .kind == "native" and .sessionId == $sid and
    .nativeType == "thread/settings/updated" and
    .payload.threadSettings.model == $multiModel and
    .payload.threadSettings.effort == $effort and
    .payload.threadSettings.collaborationMode.settings.reasoning_effort == $effort)
' "$RECEIPT_DIR/logs/fleet-events.ndjson" >"$RECEIPT_DIR/phases/effort-assertions.json"
assert_json "native reasoning-effort settings evidence is incomplete" '. == true' \
  "$RECEIPT_DIR/phases/effort-assertions.json"
jq -c \
  --arg sid "$SESSION_ID" \
  --arg multiModel "$MULTI_MODEL" \
  --arg effort "$MULTI_EFFORT" '
  select(.kind == "native" and .sessionId == $sid and
    .nativeType == "thread/settings/updated" and
    .payload.threadSettings.model == $multiModel and
    .payload.threadSettings.effort == $effort and
    .payload.threadSettings.collaborationMode.settings.reasoning_effort == $effort)
' "$RECEIPT_DIR/logs/fleet-events.ndjson" >"$RECEIPT_DIR/phases/effort-events.ndjson"

SUBAGENT_TURN_ID=""
SUBAGENT_ATTEMPTS=0
SUBAGENT_SCREENSHOT_READY=0
for attempt in 1 2; do
  SUBAGENT_ATTEMPTS=$attempt
  SUBAGENT_PROMPT=$(printf '%s' \
    "For this native collaboration receipt, use the spawn_agent collaboration tool exactly once. " \
    "Give the child the sole task of replying with exactly $SUBAGENT_CHILD and nothing else. " \
    "Wait for that child to complete, then reply as the parent with exactly $SUBAGENT_PARENT and nothing else. " \
    "Do not complete the child task yourself and do not spawn more than one child.")
  start_dashboard_capture subagent-completed "$SUBAGENT_PARENT" "" 420
  run_cli "$RECEIPT_DIR/rpc/send-subagent-attempt-$attempt.json" \
    send "$SESSION_ID" "$SUBAGENT_PROMPT"
  CANDIDATE_TURN_ID=$(jq -r '.result.turn.id' \
    "$RECEIPT_DIR/rpc/send-subagent-attempt-$attempt.json")
  wait_for_events "subagent attempt $attempt terminal event" '
    select(.kind == "native" and .sessionId == $sid and
      .nativeType == "turn/completed" and .payload.turn.id == $subTurn)
  ' 420 --arg subTurn "$CANDIDATE_TURN_ID"
  if jq -s -e \
    --arg sid "$SESSION_ID" \
    --arg tid "$CANDIDATE_TURN_ID" \
    --arg childMarker "$SUBAGENT_CHILD" \
    --arg parent "$SUBAGENT_PARENT" '
    [.[] | select(.kind == "native" and .sessionId == $sid)] as $events |
    [$events[] | select(.nativeType == "item/completed" and
      .payload.turnId == $tid and .payload.item.type == "subAgentActivity")] as $activity |
    [$activity[] | select(.payload.item.kind == "started") |
      .payload.item.agentThreadId] | unique as $started |
    [$activity[] | select(.payload.item.kind == "completed") |
      .payload.item.agentThreadId] | unique as $completed |
    ($started | length) >= 1 and
    any($completed[]; . as $completedChild | $started | index($completedChild) != null) and
    any($events[]; .nativeType == "item/completed" and
      .payload.item.type == "agentMessage" and .payload.item.text == $childMarker and
      (.payload.threadId as $childThread | $started | index($childThread) != null)) and
    any($events[]; .nativeType == "item/completed" and .payload.turnId == $tid and
      .payload.item.type == "agentMessage" and .payload.item.text == $parent)
  ' "$RECEIPT_DIR/logs/fleet-events.ndjson" >/dev/null; then
    SUBAGENT_TURN_ID=$CANDIDATE_TURN_ID
    if finish_dashboard_capture; then
      SUBAGENT_SCREENSHOT_READY=1
    fi
    break
  fi
  cancel_dashboard_capture
  note "subagent attempt $attempt lacked a full activity lifecycle or routed child marker; retrying once"
done
if [[ -z "$SUBAGENT_TURN_ID" ]]; then
  fail "Codex did not produce a complete native subagent lifecycle and routed child marker after two attempts"
fi
if (( SUBAGENT_SCREENSHOT_READY == 0 )); then
  fail "Playwright did not capture the successful native subagent turn"
fi
assert_json "subagent screenshot receipt lacks completed native collaboration visibility" '
  .assertions.expectedTextVisible == true and
  .visible.subagentCompletedVisible == true and
  (.visible.eventCounts.subAgentActivity | test(" [1-9][0-9]*$"))
' "$RECEIPT_DIR/rpc/playwright-subagent-completed.json"
wait_for_events "completed subagent activity" '
  select(.kind == "native" and .sessionId == $sid and
    .nativeType == "item/completed" and
    .payload.item.type == "subAgentActivity" and .payload.item.kind == "completed")
' 180

jq -s \
  --arg sid "$SESSION_ID" \
  --arg tid "$SUBAGENT_TURN_ID" \
  --arg childMarker "$SUBAGENT_CHILD" \
  --arg parent "$SUBAGENT_PARENT" '
  [.[] | select(.kind == "native" and .sessionId == $sid)] as $events |
  [$events[] | select(
    .nativeType == "item/completed" and .payload.turnId == $tid and
    .payload.item.type == "subAgentActivity"
  )] as $activity |
  [$activity[] | select(.payload.item.kind == "started") |
    .payload.item.agentThreadId] | unique as $started |
  [$activity[] | select(.payload.item.kind == "completed") |
    .payload.item.agentThreadId] | unique as $completed |
  ($started | length) >= 1 and
  any($completed[]; . as $completedChild | $started | index($completedChild) != null) and
  any($events[]; .nativeType == "item/completed" and
    .payload.item.type == "agentMessage" and .payload.item.text == $childMarker and
    (.payload.threadId as $childThread | $started | index($childThread) != null)) and
  any($events[]; .nativeType == "item/completed" and .payload.turnId == $tid and
    .payload.item.type == "agentMessage" and .payload.item.text == $parent) and
  any($events[]; .nativeType == "turn/completed" and .payload.turn.id == $tid and
    .payload.turn.status == "completed")
' "$RECEIPT_DIR/logs/fleet-events.ndjson" >"$RECEIPT_DIR/phases/subagent-assertions.json"
assert_json "native subagent lifecycle or routed child-message visibility is incomplete" '. == true' \
  "$RECEIPT_DIR/phases/subagent-assertions.json"

jq -s -c --arg sid "$SESSION_ID" --arg tid "$SUBAGENT_TURN_ID" '
  . as $items |
  [$items[] | select(.kind == "native" and .sessionId == $sid and
    .nativeType == "item/completed" and .payload.turnId == $tid and
    .payload.item.type == "subAgentActivity" and .payload.item.kind == "started") |
    .payload.item.agentThreadId] | unique as $children |
  $items[] | select(.sessionId == $sid and (
    (.kind == "native" and (
      .payload.turnId == $tid or .payload.turn.id == $tid or
      .payload.item.type == "subAgentActivity" or
      .payload.item.type == "collabAgentToolCall" or
      (.nativeType == "item/completed" and .payload.item.type == "agentMessage" and
        (.payload.threadId as $childThread | $children | index($childThread) != null))
    )) or .kind == "control"
  ))
' "$RECEIPT_DIR/logs/fleet-events.ndjson" >"$RECEIPT_DIR/phases/subagent-events.ndjson"

run_cli "$RECEIPT_DIR/rpc/native-history-final.json" history "$SESSION_ID"
assert_json "final native thread/read is incomplete" '
  .harness == "codex" and .complete == true and
  any(.payload.thread.turns[].items[]?; .type == "agentMessage" and .text == $stream) and
  any(.payload.thread.turns[].items[]?; .type == "agentMessage" and .text == $modelMarker) and
  any(.payload.thread.turns[].items[]?; .type == "agentMessage" and .text == $planFinal) and
  any(.payload.thread.turns[].items[]?; .type == "agentMessage" and .text == $steerFinal) and
  any(.payload.thread.turns[].items[]?; .type == "agentMessage" and .text == $parent)
' "$RECEIPT_DIR/rpc/native-history-final.json" \
  --arg stream "$STREAM_MARKER" \
  --arg modelMarker "$MODEL_MARKER" \
  --arg planFinal "$PLAN_FINAL" \
  --arg steerFinal "$STEER_FINAL" \
  --arg parent "$SUBAGENT_PARENT"

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
assert_json "worker does not contain a live Codex app-server process" \
  '.processes | length >= 1' "$RECEIPT_DIR/codex-process-proof.json"

note "performing final stop and topology proof"
run_cli "$RECEIPT_DIR/rpc/stop-final.json" stop "$SESSION_ID"
assert_json "final stop failed" '.state == "succeeded"' "$RECEIPT_DIR/rpc/stop-final.json"
run_cli "$RECEIPT_DIR/rpc/refresh-final.json" refresh "$WORKER_NAME"
run_cli "$RECEIPT_DIR/rpc/sessions-final.json" \
  sessions --worker "$WORKER_NAME" --harness codex
assert_json "final session did not converge to resumable/stopped" '
  any(.[];
    .sessionId == $sid and .vendorSessionId == $vendor and
    .availability == "resumable" and .runtimeStatus == "stopped" and
    .runtimeEpoch == null)
' "$RECEIPT_DIR/rpc/sessions-final.json" \
  --arg sid "$SESSION_ID" --arg vendor "$VENDOR_SESSION_ID"

if [[ -n "$WATCH_PID" ]] && kill -0 "$WATCH_PID" 2>/dev/null; then
  kill "$WATCH_PID" 2>/dev/null || true
  wait "$WATCH_PID" 2>/dev/null || true
fi
WATCH_PID=""

NETWORK_CONTAINER_COUNT=$(docker network inspect --format '{{len .Containers}}' "$NETWORK_NAME")
if [[ "$NETWORK_CONTAINER_COUNT" != 2 ]]; then
  fail "expected exactly two application containers, saw $NETWORK_CONTAINER_COUNT"
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
P2PRPC_REVISION=$(git -C "$P2PRPC_CORE" rev-parse HEAD 2>/dev/null || printf 'unavailable')

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
      network: {name:$network,driver:"bridge"},
      containers: [
        {name:$hostName,id:$hostId,role:"canonical Multiplex host + dashboard",publishedDashboard:$dashboard},
        {name:$workerName,id:$workerId,role:"Multiplex runtime node + Codex app-server child",publishedPorts:[]}
      ],
      transport: {
        protocol:"p2prpc v1 over Iroh",
        hostEndpointId:$endpoint,
        ticketRecorded:false,
        ticketSha256:$ticketDigest
      },
      browserRunsOnDockerHost:true
    }
  ' >"$RECEIPT_DIR/topology.json"

RUN_COMPLETED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
jq -n \
  --arg runId "$RUN_ID" \
  --arg startedAt "$RUN_STARTED_AT" \
  --arg completedAt "$RUN_COMPLETED_AT" \
  --arg docker "$DOCKER_VERSION" \
  --arg node "$NODE_VERSION" \
  --arg codex "$CODEX_VERSION" \
  --arg p2prpc "$P2PRPC_REVISION" \
  --arg initialModel "$INITIAL_MODEL" \
  --arg secondModel "$SECOND_MODEL" \
  --arg multiModel "$MULTI_MODEL" \
  --arg multiEffort "$MULTI_EFFORT" \
  --arg sessionId "$SESSION_ID" \
  --arg vendorSessionId "$VENDOR_SESSION_ID" \
  --arg streamTurn "$STREAM_TURN_ID" \
  --arg modelTurn "$MODEL_TURN_ID" \
  --arg planTurn "$PLAN_TURN_ID" \
  --arg steerTurn "$STEER_TURN_ID" \
  --arg interruptTurn "$INTERRUPT_TURN_ID" \
  --arg subagentTurn "$SUBAGENT_TURN_ID" \
  --argjson subagentAttempts "$SUBAGENT_ATTEMPTS" '
    {
      runId:$runId,status:"passed",startedAt:$startedAt,completedAt:$completedAt,
      versions:{dockerServer:$docker,nodeInImage:$node,codex:$codex,multiplexProtocol:1,p2prpcRevision:$p2prpc},
      models:{initial:$initialModel,switched:$secondModel,multiAgent:$multiModel},
      settings:{multiAgentReasoningEffort:$multiEffort},
      identities:{
        logicalSessionId:$sessionId,codexThreadId:$vendorSessionId,
        turns:{streaming:$streamTurn,model:$modelTurn,plan:$planTurn,steer:$steerTurn,interrupt:$interruptTurn,subagent:$subagentTurn}
      },
      subagentAttempts:$subagentAttempts,
      credentialMaterialRecorded:false
    }
  ' >"$RECEIPT_DIR/manifest.json"

jq -n --argjson maxTick "$((10#$INTERRUPT_MAX_TICK))" '
  {
    passed:true,
    topology:{exactlyTwoApplicationContainers:true,hostSidePlaywright:true,workerPublishesNoPorts:true},
    codexAdapter:{
      multiDeltaStreamReassembledExactly:true,
      modelSwitchObservedNatively:true,
      reasoningEffortSwitchObservedNatively:true,
      planModeRequestUserInputResolved:true,
      typedAnswerReachedFinalMessage:true,
      inFlightTurnSteeredWithoutSecondTurn:true,
      longCommandOutputVisible:true,
      interruptCompletedWithInterruptedStatus:true,
      outputStoppedAfterInterrupt:true,
      subagentLifecycleVisibleNatively:true,
      routedChildMessageVisibleNatively:true,
      nativeHistoryReadByAppServer:true,
      liveAppServerProcessObserved:true
    },
    maximumLongCommandTick:$maxTick,
    screenshotsCaptured:3,
    credentials:{hostCodexLbKeyCopiedAtRuntime:true,authJsonCopied:false,leakScanPassed:true}
  }
' >"$RECEIPT_DIR/checks.json"

{
  printf '# Codex interactive adapter two-container E2E receipt\n\n'
  printf 'Status: **PASS**\n\n'
  printf 'Run: `%s`\n\n' "$RUN_ID"
  printf 'Exactly two application containers were used: one canonical Multiplex host and one worker running the real Codex app-server. Playwright ran on the Docker host.\n\n'
  printf '## Verified phases\n\n'
  printf -- '- Exact reconstruction of a final answer from multiple native streaming deltas.\n'
  printf -- '- Runtime model switch plus native `thread/settings/updated` evidence.\n'
  printf -- '- Runtime reasoning-effort switch plus native settings evidence.\n'
  printf -- '- Plan mode, blocking `request_user_input`, typed resolution, and the typed value in the final answer.\n'
  printf -- '- Native `turn/steer` against the accepted in-flight turn, with no second `turn/started`.\n'
  printf -- '- Visible long command output followed by native interrupt and stopped output (last tick `%s`).\n' "$INTERRUPT_MAX_TICK"
  printf -- '- Native subagent started/completed activity, an exact child marker routed from the started child thread, and parent result visibility.\n'
  printf -- '- Final history obtained through Codex `thread/read`; no local history parsing.\n\n'
  printf 'The fresh worker received only a minimal codex-lb provider configuration and key after container creation. No auth.json, provider endpoint, raw key, raw P2P ticket, or shared secret is included.\n\n'
  printf 'Primary evidence is in `phases/`, `rpc/`, `logs/fleet-events.ndjson`, and the three screenshots under `screenshots/`.\n'
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
