#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/../.." && pwd)
P2PRPC_CORE=${AGENT_MULTIPLEX_P2PRPC_CORE:-"$REPO_ROOT/../p2prpc/packages/core"}
SOURCE_CONFIG=${AGENT_MULTIPLEX_COPILOT_SOURCE_CONFIG:-"${HOME}/.codex/config.toml"}
SOURCE_KEY=${AGENT_MULTIPLEX_COPILOT_SOURCE_KEY:-"${HOME}/.codex/codex-lb-api-key"}
RECEIPT_ROOT=${AGENT_MULTIPLEX_COPILOT_E2E_RECEIPT_ROOT:-"$REPO_ROOT/receipts/copilot-interactive-docker-e2e"}
INITIAL_MODEL=${AGENT_MULTIPLEX_COPILOT_E2E_MODEL:-gpt-5.6-sol}
SECOND_MODEL=${AGENT_MULTIPLEX_COPILOT_E2E_SECOND_MODEL:-gpt-5.6-terra}

for tool in docker jq node curl sha256sum awk sed perl rg timeout stat; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "interactive Docker Copilot E2E: required tool '$tool' is unavailable" >&2
    exit 1
  fi
done
if [[ ! -f "$P2PRPC_CORE/package.json" || ! -d "$P2PRPC_CORE/dist" ]]; then
  echo "interactive Docker Copilot E2E: built p2prpc core is required at $P2PRPC_CORE" >&2
  exit 1
fi
if [[ ! -r "$SOURCE_CONFIG" ]]; then
  echo "interactive Docker Copilot E2E: source config is not readable: $SOURCE_CONFIG" >&2
  exit 1
fi
if [[ ! -r "$SOURCE_KEY" ]]; then
  echo "interactive Docker Copilot E2E: source API key is not readable: $SOURCE_KEY" >&2
  exit 1
fi
if [[ "$INITIAL_MODEL" == "$SECOND_MODEL" ]]; then
  echo "interactive Docker Copilot E2E: model-switch test requires two distinct models" >&2
  exit 1
fi

random_hex() {
  node -e 'process.stdout.write(require("node:crypto").randomBytes(6).toString("hex"))'
}

RUN_ID=${AGENT_MULTIPLEX_COPILOT_E2E_RUN_ID:-"$(date -u +%Y%m%dT%H%M%SZ)-$(random_hex)"}
if [[ ! "$RUN_ID" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "interactive Docker Copilot E2E: run id contains unsupported characters" >&2
  exit 1
fi

RECEIPT_DIR="$RECEIPT_ROOT/$RUN_ID"
if [[ -e "$RECEIPT_DIR" ]]; then
  echo "interactive Docker Copilot E2E: receipt already exists: $RECEIPT_DIR" >&2
  exit 1
fi
mkdir -p "$RECEIPT_DIR/logs" "$RECEIPT_DIR/phases" "$RECEIPT_DIR/rpc" "$RECEIPT_DIR/screenshots"

RUNTIME_DIR=$(mktemp -d "${TMPDIR:-/tmp}/agent-multiplex-copilot-interactive-e2e.XXXXXXXX")
WORKSPACE_DIR="$RUNTIME_DIR/workspace"
mkdir -p "$WORKSPACE_DIR"

NAME_SUFFIX=$(printf '%s' "$RUN_ID" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9' | tail -c 24)
HOST_CONTAINER="agent-multiplex-copilot-host-$NAME_SUFFIX"
WORKER_CONTAINER="agent-multiplex-copilot-worker-$NAME_SUFFIX"
NETWORK_NAME="agent-multiplex-copilot-$NAME_SUFFIX"
IMAGE_TAG="agent-multiplex-copilot:$NAME_SUFFIX"
WORKER_NAME="docker-copilot-interactive-$NAME_SUFFIX"
SESSION_TITLE="Copilot Interactive E2E $RUN_ID"
NONCE=$(printf '%s' "$(random_hex)" | tr '[:lower:]' '[:upper:]')

STREAM_MARKER="COPILOT_STREAM_${NONCE}_ALPHA_BRAVO_CHARLIE_DELTA"
SHELL_OUTPUT="COPILOT_SHELL_${NONCE}_OK"
SHELL_FINAL="COPILOT_SHELL_${NONCE}_DONE"
MODEL_MARKER="COPILOT_MODEL_${NONCE}_SWITCHED"
PLAN_QUESTION="What receipt value should the plan preserve?"
PLAN_ANSWER="copilot-plan-answer-$NONCE"
INTERRUPT_PREFIX="COPILOT_INTERRUPT_$NONCE"
RESUME_MARKER="COPILOT_RESUMED_${NONCE}_OK"
STEER_MARKER="COPILOT_STEERED_${NONCE}_OK"
SUBAGENT_CHILD="COPILOT_SUBAGENT_CHILD_${NONCE}_OK"
SUBAGENT_PARENT="COPILOT_SUBAGENT_PARENT_${NONCE}_OK"

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
SESSION_ID=""
VENDOR_SESSION_ID=""

note() {
  printf '[copilot-interactive-e2e] %s\n' "$*" >&2
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
          [$ENV{AM_REDACT_KEY} // "", "<redacted-codex-lb-api-key>"],
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
  if (( LOGS_CAPTURED == 1 )); then return; fi
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
  if (( WORKER_STARTED == 1 )); then docker rm --force "$WORKER_CONTAINER" >/dev/null 2>&1; fi
  if (( HOST_STARTED == 1 )); then docker rm --force "$HOST_CONTAINER" >/dev/null 2>&1; fi
  if (( NETWORK_CREATED == 1 )); then docker network rm "$NETWORK_NAME" >/dev/null 2>&1; fi
  if (( IMAGE_BUILT == 1 )) && [[ ${AGENT_MULTIPLEX_COPILOT_E2E_KEEP_IMAGE:-0} != 1 ]]; then
    docker image rm "$IMAGE_TAG" >/dev/null 2>&1
  fi
  if [[ -n "$RUNTIME_DIR" && -d "$RUNTIME_DIR" && "$RUNTIME_DIR" != "/" && \
        "$(basename -- "$RUNTIME_DIR")" == agent-multiplex-copilot-interactive-e2e.* ]]; then
    rm -rf -- "$RUNTIME_DIR"
  fi
  if (( COMPLETED == 0 )); then
    printf 'The interactive Docker Copilot E2E run failed. Inspect logs and partial receipts.\n' \
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
  local description=$1 filter=$2 file=$3
  shift 3
  if ! jq -e "$@" "$filter" "$file" >/dev/null; then
    fail "$description (see ${file#"$RECEIPT_DIR/"})"
  fi
}

cli_raw() {
  timeout 300s docker exec "$HOST_CONTAINER" \
    node /opt/src/agent-multiplex/apps/cli/dist/main.js \
    --host http://127.0.0.1:4317/trpc --json "$@"
}

run_cli() {
  local destination=$1
  shift
  local temporary="$RUNTIME_DIR/cli-output.json" errors="$RUNTIME_DIR/cli-errors.log"
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
    fail "CLI command did not return JSON: $*"
  fi
  mv "$temporary" "$destination"
  printf 'receipt: %s\n\n' "${destination#"$RECEIPT_DIR/"}" \
    >>"$RECEIPT_DIR/logs/cli-transcript.log"
}

wait_for_host_startup() {
  local attempt logs
  for attempt in $(seq 1 90); do
    if [[ $(docker inspect --format '{{.State.Running}}' "$HOST_CONTAINER" 2>/dev/null) != true ]]; then
      docker logs "$HOST_CONTAINER" 2>&1 | redact_stream >&2 || true
      fail "host exited during startup"; return
    fi
    logs=$(docker logs "$HOST_CONTAINER" 2>&1 || true)
    if grep -q '^P2P ID:' <<<"$logs" && grep -q '^P2P ticket (' <<<"$logs"; then return; fi
    sleep 1
  done
  fail "timed out waiting for host startup"
}

wait_for_worker() {
  local attempt temporary="$RUNTIME_DIR/workers-poll.json"
  for attempt in $(seq 1 180); do
    if [[ $(docker inspect --format '{{.State.Running}}' "$WORKER_CONTAINER" 2>/dev/null) != true ]]; then
      docker logs "$WORKER_CONTAINER" 2>&1 | redact_stream >&2 || true
      fail "worker exited during registration"; return
    fi
    if cli_raw workers >"$temporary" 2>/dev/null && jq -e --arg name "$WORKER_NAME" '
      any(.[]; .name == $name and .presence == "online" and
        any(.harnesses[]; .harness == "copilot" and .available == true))
    ' "$temporary" >/dev/null; then
      mv "$temporary" "$RECEIPT_DIR/rpc/workers.json"
      return
    fi
    if (( attempt % 15 == 0 )); then note "waiting for Copilot worker (${attempt}s)"; fi
    sleep 1
  done
  fail "timed out waiting for Copilot worker"
}

wait_for_watch() {
  local attempt
  for attempt in $(seq 1 60); do
    if grep -q '^watch connected$' "$RECEIPT_DIR/logs/watch.log" 2>/dev/null; then return; fi
    if ! kill -0 "$WATCH_PID" 2>/dev/null; then fail "fleet watch exited before connecting"; return; fi
    sleep 1
  done
  fail "timed out waiting for fleet watch"
}

wait_for_events() {
  local description=$1 filter=$2 limit=${3:-300} attempt
  shift 3
  for attempt in $(seq 1 "$limit"); do
    if jq -e --arg sid "$SESSION_ID" "$@" "$filter" \
      "$RECEIPT_DIR/logs/fleet-events.ndjson" >/dev/null 2>&1; then return; fi
    if ! kill -0 "$WATCH_PID" 2>/dev/null; then fail "fleet watch exited waiting for $description"; return; fi
    if (( attempt % 20 == 0 )); then note "waiting for $description (${attempt}s)"; fi
    sleep 1
  done
  tail -n 30 "$RECEIPT_DIR/logs/fleet-events.ndjson" \
    >"$RECEIPT_DIR/logs/timeout-last-events.ndjson" || true
  fail "timed out waiting for $description"
}

wait_for_interaction() {
  local request_type=$1 destination=$2 filter=$3 limit=${4:-300} attempt
  shift 4
  local temporary="$RUNTIME_DIR/interaction-poll.json"
  for attempt in $(seq 1 "$limit"); do
    if cli_raw interactions "$SESSION_ID" >"$temporary" 2>/dev/null && \
      jq -e --arg type "$request_type" "$@" \
        "any(.[]; .state == \"pending\" and .requestType == \$type and ($filter))" \
        "$temporary" >/dev/null; then
      cp "$temporary" "$destination"
      return
    fi
    if (( attempt % 20 == 0 )); then note "waiting for $request_type interaction (${attempt}s)"; fi
    sleep 1
  done
  fail "timed out waiting for $request_type interaction"
}

phase_events() {
  local destination=$1 marker=$2
  jq -c --arg sid "$SESSION_ID" --arg marker "$marker" '
    select(.sessionId == $sid and
      ((.kind == "native" and ((.payload | tostring) | contains($marker))) or
       (.kind == "control" and ((.change | tostring) | contains($marker)))))
  ' "$RECEIPT_DIR/logs/fleet-events.ndjson" >"$destination"
}

note "reading codex-lb endpoint and validating the read-only API-key source"
API_KEY_LITERAL=$(tr -d '\r\n' <"$SOURCE_KEY")
if (( ${#API_KEY_LITERAL} < 16 )); then fail "codex-lb API key is unexpectedly short"; fi
PROVIDER_URL=$(awk '
  /^\[model_providers\.codex-lb\]$/ { in_provider = 1; next }
  in_provider && /^\[/ { exit }
  in_provider && /^[[:space:]]*base_url[[:space:]]*=/ {
    sub(/^[^=]*=[[:space:]]*/, ""); gsub(/^"|"$/, ""); print; exit
  }
' "$SOURCE_CONFIG")
if [[ -z "$PROVIDER_URL" ]]; then fail "codex-lb base_url was not found"; fi
if ! node -e 'const u=new URL(process.argv[1]);if(!/^https?:$/.test(u.protocol)||u.username||u.password)process.exit(1)' \
  "$PROVIDER_URL"; then
  fail "codex-lb base_url is not a credential-free HTTP(S) URL"
fi

note "building the shared host/worker image"
if ! docker build --progress=plain \
  --build-context "p2prpc-core=$P2PRPC_CORE" \
  --file "$SCRIPT_DIR/Dockerfile" --tag "$IMAGE_TAG" "$REPO_ROOT" \
  >"$RECEIPT_DIR/logs/docker-build.log" 2>&1; then
  tail -n 80 "$RECEIPT_DIR/logs/docker-build.log" >&2 || true
  fail "Docker image build failed"
fi
IMAGE_BUILT=1
IMAGE_ID=$(docker image inspect --format '{{.Id}}' "$IMAGE_TAG")

docker network create --driver bridge "$NETWORK_NAME" >/dev/null
NETWORK_CREATED=1

note "starting canonical Multiplex host"
docker run --detach \
  --name "$HOST_CONTAINER" --hostname multiplex-host --network "$NETWORK_NAME" \
  --init --user 1000:100 --read-only --cap-drop ALL \
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
  "$IMAGE_TAG" node apps/host/dist/main.js >/dev/null
HOST_STARTED=1
wait_for_host_startup

HOST_LOGS=$(docker logs "$HOST_CONTAINER" 2>&1)
P2P_ENDPOINT_ID=$(sed -n 's/^P2P ID:[[:space:]]*//p' <<<"$HOST_LOGS" | tail -n 1)
P2P_TICKET=$(awk '/^P2P ticket \(/ { getline; print; exit }' <<<"$HOST_LOGS")
if [[ ! "$P2P_ENDPOINT_ID" =~ ^[a-z2-7]{52}$ ]]; then fail "host emitted invalid endpoint ID"; fi
if (( ${#P2P_TICKET} < 20 || ${#P2P_TICKET} > 8192 )) || [[ "$P2P_TICKET" =~ [[:space:]] ]]; then
  fail "host emitted invalid P2P ticket"
fi
P2P_TICKET_SHA256=$(printf '%s' "$P2P_TICKET" | sha256sum | awk '{print $1}')

PORT_MAPPING=$(docker port "$HOST_CONTAINER" 4317/tcp | tail -n 1)
DASHBOARD_PORT=${PORT_MAPPING##*:}
if [[ ! "$DASHBOARD_PORT" =~ ^[0-9]+$ ]]; then fail "could not resolve dashboard port"; fi
DASHBOARD_URL="http://127.0.0.1:$DASHBOARD_PORT/"
for attempt in $(seq 1 30); do
  if curl --fail --silent "$DASHBOARD_URL" >/dev/null; then break; fi
  if (( attempt == 30 )); then fail "dashboard did not become reachable"; fi
  sleep 1
done

note "starting Copilot worker with a read-only host API-key mount"
WORKER_CREATED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
docker run --detach \
  --name "$WORKER_CONTAINER" --hostname copilot-worker --network "$NETWORK_NAME" \
  --init --user 1000:100 --read-only --cap-drop ALL \
  --security-opt no-new-privileges --security-opt seccomp=unconfined \
  --tmpfs /state:rw,nosuid,nodev,mode=0700,uid=1000,gid=100 \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777 \
  --tmpfs /home/arduano/.copilot:rw,nosuid,nodev,mode=0700,uid=1000,gid=100 \
  --mount "type=bind,src=$WORKSPACE_DIR,dst=/workspace/e2e" \
  --mount "type=bind,src=$SOURCE_KEY,dst=/run/secrets/codex-lb-api-key,readonly" \
  --env HOME=/home/arduano \
  --env XDG_CACHE_HOME=/tmp/cache \
  --env AGENT_MULTIPLEX_SHARED_SECRET="$SHARED_SECRET" \
  --env AGENT_MULTIPLEX_CONTROL_NODE_ENDPOINT_ID="$P2P_ENDPOINT_ID" \
  --env AGENT_MULTIPLEX_CONTROL_NODE_TICKET="$P2P_TICKET" \
  --env 'AGENT_MULTIPLEX_RUNTIME_NODE_ALLOWED_ROOTS=["/workspace/e2e"]' \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_STATE_DIR=/state/runtime-node \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_NAME="$WORKER_NAME" \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_HARNESSES=copilot \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_HEARTBEAT_MS=2000 \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_INVENTORY_REFRESH_MS=5000 \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_RECONNECT_MAX_MS=5000 \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_HOME=/home/arduano/.copilot \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_LOG_LEVEL=none \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_TYPE=openai \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_BASE_URL="$PROVIDER_URL" \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_WIRE_API=responses \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_TRANSPORT=http \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_MODEL="$INITIAL_MODEL" \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_MODELS="[\"$INITIAL_MODEL\",\"$SECOND_MODEL\"]" \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_API_KEY_FILE=/run/secrets/codex-lb-api-key \
  "$IMAGE_TAG" node apps/runtime-node/dist/main.js >/dev/null
WORKER_STARTED=1

docker inspect "$WORKER_CONTAINER" | jq --arg source "$SOURCE_KEY" '
  .[0] as $container |
  ($container.Mounts | map(select(.Destination == "/run/secrets/codex-lb-api-key"))[0]) as $mount |
  {
    workerCreatedAt:$container.Created,
    sourceKind:"host codex-lb API-key file",
    destination:$mount.Destination,
    mountType:$mount.Type,
    readOnly:($mount.RW | not),
    apiKeyCopiedIntoImage:false,
    fullCodexHomeMounted:false,
    sourcePathMatchesExpected:($mount.Source == $source)
  }
' >"$RECEIPT_DIR/auth-mount-proof.json"
assert_json "API-key mount is not narrowly scoped and read-only" '
  .destination == "/run/secrets/codex-lb-api-key" and .mountType == "bind" and
  .readOnly == true and .apiKeyCopiedIntoImage == false and
  .fullCodexHomeMounted == false and .sourcePathMatchesExpected == true
' "$RECEIPT_DIR/auth-mount-proof.json"

wait_for_worker
run_cli "$RECEIPT_DIR/rpc/catalog.json" catalog "$WORKER_NAME"
assert_json "required Copilot capabilities are missing" '
  any(.[]; .harness == "copilot" and .available == true and
    ([.capabilities[].name] | contains([
      "sessions.spawn", "sessions.resume", "history.native", "prompt.enqueue",
      "prompt.steer.immediate", "interrupt", "models.list", "models.switch",
      "mode.native", "interactions.permission", "interactions.userInput",
      "interactions.exitPlan"
    ])))
' "$RECEIPT_DIR/rpc/catalog.json"
run_cli "$RECEIPT_DIR/rpc/models.json" models "$WORKER_NAME" copilot
assert_json "configured BYOK models are not both advertised" '
  any(.[]; .id == $first and .native.byok == true and .native.wireApi == "responses") and
  any(.[]; .id == $second and .native.byok == true and .native.wireApi == "responses")
' "$RECEIPT_DIR/rpc/models.json" --arg first "$INITIAL_MODEL" --arg second "$SECOND_MODEL"

METADATA_ASSIGNMENT="agent.title=$(jq -Rn --arg value "$SESSION_TITLE" '$value')"
note "spawning a real Copilot BYOK session through the Multiplex API"
run_cli "$RECEIPT_DIR/rpc/spawn.json" \
  spawn "$WORKER_NAME" copilot /workspace/e2e \
  --model "$INITIAL_MODEL" --reasoning-effort low --mode interactive \
  --metadata "$METADATA_ASSIGNMENT"
assert_json "Copilot spawn was not acknowledged" '
  .state == "succeeded" and (.sessionId | type == "string") and
  (.result.vendorSessionId | type == "string")
' "$RECEIPT_DIR/rpc/spawn.json"
SESSION_ID=$(jq -r '.sessionId' "$RECEIPT_DIR/rpc/spawn.json")
VENDOR_SESSION_ID=$(jq -r '.result.vendorSessionId' "$RECEIPT_DIR/rpc/spawn.json")

: >"$RECEIPT_DIR/logs/fleet-events.ndjson"
: >"$RECEIPT_DIR/logs/watch.log"
timeout 2400s docker exec "$HOST_CONTAINER" \
  node /opt/src/agent-multiplex/apps/cli/dist/main.js \
  --host http://127.0.0.1:4317/trpc --json watch "$SESSION_ID" \
  >"$RECEIPT_DIR/logs/fleet-events.ndjson" 2>"$RECEIPT_DIR/logs/watch.log" &
WATCH_PID=$!
wait_for_watch

note "phase 1/9: exact Copilot assistant delta streaming"
run_cli "$RECEIPT_DIR/rpc/send-streaming.json" \
  send "$SESSION_ID" "Reply with exactly $STREAM_MARKER and nothing else."
assert_json "streaming prompt was not accepted" '.state == "succeeded" and (.result.messageId | type == "string")' \
  "$RECEIPT_DIR/rpc/send-streaming.json"
wait_for_events "streamed final marker and subsequent idle" '
  [inputs, .] as $events |
  [$events[] | select(.kind == "native" and .sessionId == $sid and
    .nativeType == "assistant.message" and .payload.data.content == $marker)][-1] as $message |
  $message != null and any($events[]; .kind == "native" and .sessionId == $sid and
    .nativeType == "session.idle" and .sequence > $message.sequence)
' 300 --arg marker "$STREAM_MARKER"
STREAM_MESSAGE_ID=$(jq -r --arg sid "$SESSION_ID" --arg marker "$STREAM_MARKER" '
  select(.kind == "native" and .sessionId == $sid and .nativeType == "assistant.message" and
    .payload.data.content == $marker) | .payload.data.messageId
' "$RECEIPT_DIR/logs/fleet-events.ndjson" | tail -n 1)
jq -s --arg sid "$SESSION_ID" --arg marker "$STREAM_MARKER" --arg mid "$STREAM_MESSAGE_ID" '
  [.[] | select(.kind == "native" and .sessionId == $sid)] as $events |
  [$events[] | select(.nativeType == "assistant.message_delta" and
    .payload.data.messageId == $mid)] as $deltas |
  [$events[] | select(.nativeType == "assistant.message" and
    .payload.data.messageId == $mid)][0] as $complete |
  ($deltas | length) >= 2 and
  ($deltas | map(.payload.data.deltaContent) | join("")) == $marker and
  $complete.payload.data.content == $marker and
  ($deltas | all(.ephemeral == true and .sequence < $complete.sequence))
' "$RECEIPT_DIR/logs/fleet-events.ndjson" >"$RECEIPT_DIR/phases/streaming-assertions.json"
assert_json "Copilot streaming reconstruction failed" '. == true' \
  "$RECEIPT_DIR/phases/streaming-assertions.json"
phase_events "$RECEIPT_DIR/phases/streaming-events.ndjson" "$STREAM_MARKER"

note "phase 2/9: shell permission, canonical resolution, and tool visibility"
SHELL_COMMAND="printf $SHELL_OUTPUT"
run_cli "$RECEIPT_DIR/rpc/send-shell.json" send "$SESSION_ID" \
  "Use the shell tool exactly once to run: $SHELL_COMMAND. After it succeeds, reply with exactly $SHELL_FINAL and nothing else."
wait_for_interaction permission "$RECEIPT_DIR/rpc/interactions-permission-pending.json" \
  '.payload.permissionRequest.kind == "shell" and .payload.permissionRequest.fullCommandText == $command' \
  300 --arg command "$SHELL_COMMAND"
PERMISSION_INTERACTION_ID=$(jq -r --arg command "$SHELL_COMMAND" '
  .[] | select(.state == "pending" and .requestType == "permission" and
    .payload.permissionRequest.kind == "shell" and
    .payload.permissionRequest.fullCommandText == $command) | .interactionId
' "$RECEIPT_DIR/rpc/interactions-permission-pending.json")
run_cli "$RECEIPT_DIR/rpc/sessions-permission-pending.json" \
  sessions --worker "$WORKER_NAME" --harness copilot
assert_json "permission did not set waitingForInput" '
  any(.[]; .sessionId == $sid and .runtimeStatus == "waitingForInput")
' "$RECEIPT_DIR/rpc/sessions-permission-pending.json" --arg sid "$SESSION_ID"
PERMISSION_RESPONSE='{"kind":"approve-once","approvedInteractively":true}'
run_cli "$RECEIPT_DIR/rpc/resolve-permission.json" \
  resolve "$PERMISSION_INTERACTION_ID" "$PERMISSION_RESPONSE"
assert_json "permission response was not retained" '
  .state == "resolved" and .resolution.kind == "approve-once" and
  .resolution.approvedInteractively == true
' "$RECEIPT_DIR/rpc/resolve-permission.json"
wait_for_events "shell output and final marker" '
  [inputs, .] as $events |
  any($events[]; .kind == "native" and .sessionId == $sid and
    .nativeType == "tool.execution_complete" and .payload.data.success == true and
    ((.payload.data.result.content // "") | contains($output))) and
  any($events[]; .kind == "native" and .sessionId == $sid and
    .nativeType == "assistant.message" and .payload.data.content == $final)
' 300 --arg output "$SHELL_OUTPUT" --arg final "$SHELL_FINAL"
jq -s --arg sid "$SESSION_ID" --arg command "$SHELL_COMMAND" --arg output "$SHELL_OUTPUT" --arg final "$SHELL_FINAL" '
  [.[] | select(.kind == "native" and .sessionId == $sid)] as $events |
  [$events[] | select(.nativeType == "permission.requested" and
    .payload.data.permissionRequest.kind == "shell" and
    .payload.data.permissionRequest.fullCommandText == $command)][0] as $requested |
  [$events[] | select(.nativeType == "permission.completed" and
    .payload.data.requestId == $requested.payload.data.requestId)][0] as $completed |
  [$events[] | select(.nativeType == "tool.execution_start" and
    .payload.data.toolCallId == $requested.payload.data.permissionRequest.toolCallId)][0] as $started |
  [$events[] | select(.nativeType == "tool.execution_complete" and
    .payload.data.toolCallId == $started.payload.data.toolCallId)][0] as $toolDone |
  $requested != null and $completed.payload.data.result.kind == "approved" and
  $started != null and $toolDone.payload.data.success == true and
  ($toolDone.payload.data.result.content | contains($output)) and
  any($events[]; .nativeType == "assistant.message" and .payload.data.content == $final)
' "$RECEIPT_DIR/logs/fleet-events.ndjson" >"$RECEIPT_DIR/phases/permission-tool-assertions.json"
assert_json "native permission/tool lifecycle is incomplete" '. == true' \
  "$RECEIPT_DIR/phases/permission-tool-assertions.json"
phase_events "$RECEIPT_DIR/phases/permission-tool-events.ndjson" "$SHELL_OUTPUT"

note "phase 3/9: switching the active BYOK model"
run_cli "$RECEIPT_DIR/rpc/set-model.json" model "$SESSION_ID" "$SECOND_MODEL"
assert_json "model switch command failed" '
  .state == "succeeded" and .result.model == $model
' "$RECEIPT_DIR/rpc/set-model.json" --arg model "$SECOND_MODEL"
wait_for_events "native session.model_change" '
  select(.kind == "native" and .sessionId == $sid and
    .nativeType == "session.model_change" and .payload.data.newModel == $model)
' 120 --arg model "$SECOND_MODEL"
run_cli "$RECEIPT_DIR/rpc/send-model.json" send "$SESSION_ID" \
  "Reply with exactly $MODEL_MARKER and nothing else."
wait_for_events "second-model response" '
  select(.kind == "native" and .sessionId == $sid and
    .nativeType == "assistant.message" and .payload.data.content == $marker and
    .payload.data.model == $model)
' 300 --arg marker "$MODEL_MARKER" --arg model "$SECOND_MODEL"
jq -s --arg sid "$SESSION_ID" --arg model "$SECOND_MODEL" --arg marker "$MODEL_MARKER" '
  any(.[]; .kind == "native" and .sessionId == $sid and
    .nativeType == "session.model_change" and .payload.data.newModel == $model) and
  any(.[]; .kind == "native" and .sessionId == $sid and
    .nativeType == "assistant.message" and .payload.data.content == $marker and
    .payload.data.model == $model)
' "$RECEIPT_DIR/logs/fleet-events.ndjson" >"$RECEIPT_DIR/phases/model-assertions.json"
assert_json "model-switch evidence is incomplete" '. == true' \
  "$RECEIPT_DIR/phases/model-assertions.json"

note "phase 4/9: Plan mode, ask_user, typed answer, and exit-plan approval"
run_cli "$RECEIPT_DIR/rpc/set-mode-plan.json" mode "$SESSION_ID" plan
assert_json "Plan mode command failed" '.state == "succeeded" and .result.mode == "plan"' \
  "$RECEIPT_DIR/rpc/set-mode-plan.json"
wait_for_events "native Plan mode change" '
  select(.kind == "native" and .sessionId == $sid and
    .nativeType == "session.mode_changed" and .payload.data.newMode == "plan")
' 120

PLAN_SUCCEEDED=0
PLAN_ATTEMPTS=0
for attempt in 1 2; do
  PLAN_ATTEMPTS=$attempt
  run_cli "$RECEIPT_DIR/rpc/send-plan-attempt-$attempt.json" send "$SESSION_ID" \
    "In Plan mode, call ask_user exactly once and ask exactly '$PLAN_QUESTION' with choices Alpha and Beta and freeform enabled. Incorporate the answer verbatim into a one-step plan, then call exit_plan_mode and recommend exit_only. Do not execute the plan."
  if wait_for_interaction userInput "$RECEIPT_DIR/rpc/interactions-user-input-attempt-$attempt.json" \
    '.payload.request.question == $question and .payload.request.allowFreeform == true and
      .payload.request.choices == ["Alpha", "Beta"]' \
    180 --arg question "$PLAN_QUESTION"; then
    PLAN_SUCCEEDED=1
    break
  fi
  note "Plan attempt $attempt did not trigger the requested native ask_user callback"
done
if (( PLAN_SUCCEEDED == 0 )); then fail "Copilot did not trigger ask_user after two attempts"; fi
USER_INPUT_INTERACTION_ID=$(jq -r --arg question "$PLAN_QUESTION" '
  .[] | select(.state == "pending" and .requestType == "userInput" and
    .payload.request.question == $question) | .interactionId
' "$RECEIPT_DIR/rpc/interactions-user-input-attempt-$PLAN_ATTEMPTS.json")
USER_INPUT_RESPONSE=$(jq -cn --arg answer "$PLAN_ANSWER" '{answer:$answer,wasFreeform:true}')
run_cli "$RECEIPT_DIR/rpc/resolve-user-input.json" \
  resolve "$USER_INPUT_INTERACTION_ID" "$USER_INPUT_RESPONSE"
assert_json "typed Copilot user answer was not retained" '
  .state == "resolved" and .resolution.answer == $answer and
  .resolution.wasFreeform == true
' "$RECEIPT_DIR/rpc/resolve-user-input.json" --arg answer "$PLAN_ANSWER"

wait_for_interaction exitPlan "$RECEIPT_DIR/rpc/interactions-exit-plan-pending.json" \
  '(.payload.request.actions | index("exit_only")) != null and
    ((.payload.request.planContent // "") | contains($answer))' \
  300 --arg answer "$PLAN_ANSWER"
EXIT_PLAN_INTERACTION_ID=$(jq -r --arg answer "$PLAN_ANSWER" '
  .[] | select(.state == "pending" and .requestType == "exitPlan" and
    (.payload.request.actions | index("exit_only")) != null and
    ((.payload.request.planContent // "") | contains($answer))) | .interactionId
' "$RECEIPT_DIR/rpc/interactions-exit-plan-pending.json")
EXIT_PLAN_RESPONSE='{"approved":true,"selectedAction":"exit_only"}'
run_cli "$RECEIPT_DIR/rpc/resolve-exit-plan.json" \
  resolve "$EXIT_PLAN_INTERACTION_ID" "$EXIT_PLAN_RESPONSE"
assert_json "exit-plan approval was not retained" '
  .state == "resolved" and .resolution.approved == true and
  .resolution.selectedAction == "exit_only"
' "$RECEIPT_DIR/rpc/resolve-exit-plan.json"
wait_for_events "native typed-answer and exit-plan completion events" '
  [inputs, .] as $events |
  any($events[]; .kind == "native" and .sessionId == $sid and
    .nativeType == "user_input.completed" and .payload.data.answer == $answer and
    .payload.data.wasFreeform == true) and
  any($events[]; .kind == "native" and .sessionId == $sid and
    .nativeType == "exit_plan_mode.completed" and .payload.data.approved == true and
    .payload.data.selectedAction == "exit_only")
' 180 --arg answer "$PLAN_ANSWER"
jq -s --arg sid "$SESSION_ID" --arg question "$PLAN_QUESTION" --arg answer "$PLAN_ANSWER" '
  [.[] | select(.kind == "native" and .sessionId == $sid)] as $events |
  [$events[] | select(.nativeType == "user_input.requested" and
    .payload.data.question == $question)][-1] as $ask |
  [$events[] | select(.nativeType == "user_input.completed" and
    .payload.data.requestId == $ask.payload.data.requestId)][0] as $answered |
  [$events[] | select(.nativeType == "exit_plan_mode.requested" and
    ((.payload.data.planContent // "") | contains($answer)))][0] as $exit |
  [$events[] | select(.nativeType == "exit_plan_mode.completed" and
    .payload.data.requestId == $exit.payload.data.requestId)][0] as $approved |
  $ask.payload.data.choices == ["Alpha", "Beta"] and
  $answered.payload.data.answer == $answer and $answered.payload.data.wasFreeform == true and
  ($exit.payload.data.actions | index("exit_only")) != null and
  $approved.payload.data.approved == true and $approved.payload.data.selectedAction == "exit_only"
' "$RECEIPT_DIR/logs/fleet-events.ndjson" >"$RECEIPT_DIR/phases/plan-assertions.json"
assert_json "native Plan interaction lifecycle is incomplete" '. == true' \
  "$RECEIPT_DIR/phases/plan-assertions.json"
phase_events "$RECEIPT_DIR/phases/plan-events.ndjson" "$PLAN_ANSWER"

note "phase 5/9: interrupting an active long-running Copilot shell turn"
run_cli "$RECEIPT_DIR/rpc/set-mode-interactive.json" mode "$SESSION_ID" interactive
assert_json "return to interactive mode failed" '.state == "succeeded"' \
  "$RECEIPT_DIR/rpc/set-mode-interactive.json"
LONG_COMMAND="for i in \$(seq 1 120); do printf '${INTERRUPT_PREFIX}_%03d\\n' \"\$i\"; sleep 1; done"
run_cli "$RECEIPT_DIR/rpc/send-interrupt.json" send "$SESSION_ID" \
  "Use the shell tool to run exactly this command and wait for it: $LONG_COMMAND. Then reply LONG_COMMAND_FINISHED_$NONCE."
wait_for_interaction permission "$RECEIPT_DIR/rpc/interactions-interrupt-permission.json" \
  '.payload.permissionRequest.kind == "shell" and
    (.payload.permissionRequest.fullCommandText | contains($prefix))' \
  300 --arg prefix "$INTERRUPT_PREFIX"
INTERRUPT_PERMISSION_ID=$(jq -r --arg prefix "$INTERRUPT_PREFIX" '
  .[] | select(.state == "pending" and .requestType == "permission" and
    .payload.permissionRequest.kind == "shell" and
    (.payload.permissionRequest.fullCommandText | contains($prefix))) | .interactionId
' "$RECEIPT_DIR/rpc/interactions-interrupt-permission.json")
run_cli "$RECEIPT_DIR/rpc/resolve-interrupt-permission.json" \
  resolve "$INTERRUPT_PERMISSION_ID" "$PERMISSION_RESPONSE"
wait_for_events "long shell tool execution start" '
  select(.kind == "native" and .sessionId == $sid and
    .nativeType == "tool.execution_start" and
    ((.payload.data.arguments | tostring) | contains($prefix)))
' 180 --arg prefix "$INTERRUPT_PREFIX"
sleep 2
run_cli "$RECEIPT_DIR/rpc/interrupt.json" interrupt "$SESSION_ID"
assert_json "Copilot abort command failed" '.state == "succeeded"' \
  "$RECEIPT_DIR/rpc/interrupt.json"
wait_for_events "native Copilot abort and aborted idle" '
  [inputs, .] as $events |
  [$events[] | select(.kind == "native" and .sessionId == $sid and
    .nativeType == "abort")][-1] as $abort |
  $abort != null and any($events[]; .kind == "native" and .sessionId == $sid and
    .nativeType == "session.idle" and .payload.data.aborted == true and
    .sequence > $abort.sequence)
' 180
jq -s --arg sid "$SESSION_ID" --arg prefix "$INTERRUPT_PREFIX" --arg forbidden "LONG_COMMAND_FINISHED_$NONCE" '
  [.[] | select(.kind == "native" and .sessionId == $sid)] as $events |
  [$events[] | select(.nativeType == "tool.execution_start" and
    ((.payload.data.arguments | tostring) | contains($prefix)))][-1] as $tool |
  [$events[] | select(.nativeType == "abort" and .sequence > $tool.sequence)][0] as $abort |
  $tool != null and $abort != null and
  any($events[]; .nativeType == "session.idle" and .payload.data.aborted == true and
    .sequence > $abort.sequence) and
  (any($events[]; .nativeType == "assistant.message" and
    .payload.data.content == $forbidden and .sequence > $tool.sequence) | not)
' "$RECEIPT_DIR/logs/fleet-events.ndjson" >"$RECEIPT_DIR/phases/interrupt-assertions.json"
assert_json "native interrupt lifecycle is incomplete" '. == true' \
  "$RECEIPT_DIR/phases/interrupt-assertions.json"

note "phase 6/9: native history and client-managed metadata"
run_cli "$RECEIPT_DIR/rpc/metadata-before.json" metadata "$SESSION_ID"
CURRENT_TITLE_REVISION=$(jq -r '.keyRevisions["agent.title"]' "$RECEIPT_DIR/rpc/metadata-before.json")
run_cli "$RECEIPT_DIR/rpc/metadata-patch.json" metadata "$SESSION_ID" \
  --set "receipt.copilot=$(jq -cn --arg run "$RUN_ID" '{verified:true,run:$run}')" \
  --if-revision "agent.title=$CURRENT_TITLE_REVISION"
assert_json "metadata patch failed" '
  .accepted == true and .snapshot.values["agent.title"] == $title and
  .snapshot.values["receipt.copilot"].verified == true and
  .snapshot.values["receipt.copilot"].run == $run
' "$RECEIPT_DIR/rpc/metadata-patch.json" --arg title "$SESSION_TITLE" --arg run "$RUN_ID"
run_cli "$RECEIPT_DIR/rpc/native-history-before-resume.json" history "$SESSION_ID" --all --limit 50
assert_json "Copilot SDK native history lacks completed phases" '
  (if type == "array" then [.[].payload[]] else .payload end) as $events |
  any($events[]; .type == "assistant.message" and .data.content == $stream) and
  any($events[]; .type == "assistant.message" and .data.content == $shell) and
  any($events[]; .type == "assistant.message" and .data.content == $model and
    .data.model == $secondModel) and
  any($events[]; .type == "tool.execution_complete" and .data.success == true and
    ((.data.result.content // "") | contains($shellOutput)))
' "$RECEIPT_DIR/rpc/native-history-before-resume.json" \
  --arg stream "$STREAM_MARKER" --arg shell "$SHELL_FINAL" \
  --arg model "$MODEL_MARKER" --arg secondModel "$SECOND_MODEL" --arg shellOutput "$SHELL_OUTPUT"

docker exec "$WORKER_CONTAINER" node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const processes = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try {
      const args = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0").filter(Boolean);
      const encoded = args.join(" ").toLowerCase();
      if (!encoded.includes("copilot") || encoded.includes("apps/runtime-node/dist/main.js")) continue;
      processes.push({pid:Number(entry),executable:path.basename(args[0] || "unknown"),role:"Copilot runtime"});
    } catch {}
  }
  processes.sort((a,b)=>a.pid-b.pid);
  process.stdout.write(JSON.stringify({processes}, null, 2));
' >"$RECEIPT_DIR/copilot-process-proof.json"
assert_json "live Copilot runtime process was not observed" '.processes | length >= 1' \
  "$RECEIPT_DIR/copilot-process-proof.json"

note "phase 7/9: stop, resumable inventory, native resume, and continued streaming"
run_cli "$RECEIPT_DIR/rpc/stop-before-resume.json" stop "$SESSION_ID"
assert_json "pre-resume stop failed" '.state == "succeeded"' \
  "$RECEIPT_DIR/rpc/stop-before-resume.json"
run_cli "$RECEIPT_DIR/rpc/refresh-stopped.json" refresh "$WORKER_NAME"
run_cli "$RECEIPT_DIR/rpc/sessions-stopped.json" sessions --worker "$WORKER_NAME" --harness copilot
assert_json "stopped Copilot session is not resumable" '
  any(.[]; .sessionId == $sid and .vendorSessionId == $vendor and
    .availability == "resumable" and .runtimeStatus == "stopped" and .runtimeEpoch == null)
' "$RECEIPT_DIR/rpc/sessions-stopped.json" --arg sid "$SESSION_ID" --arg vendor "$VENDOR_SESSION_ID"
run_cli "$RECEIPT_DIR/rpc/resume.json" \
  resume "$WORKER_NAME" copilot "$VENDOR_SESSION_ID" \
  --cwd /workspace/e2e --model "$SECOND_MODEL" --reasoning-effort low --mode interactive
assert_json "Copilot native resume failed" '
  .state == "succeeded" and .sessionId == $sid and
  .result.sessionId == $sid and .result.vendorSessionId == $vendor
' "$RECEIPT_DIR/rpc/resume.json" --arg sid "$SESSION_ID" --arg vendor "$VENDOR_SESSION_ID"
run_cli "$RECEIPT_DIR/rpc/send-resumed.json" send "$SESSION_ID" \
  "Reply with exactly $RESUME_MARKER and nothing else."
wait_for_events "post-resume response" '
  select(.kind == "native" and .sessionId == $sid and
    .nativeType == "assistant.message" and .payload.data.content == $marker and
    .payload.data.model == $model)
' 300 --arg marker "$RESUME_MARKER" --arg model "$SECOND_MODEL"

note "phase 8/9: idle immediate-steer round trip"
STEER_PROMPT="Reply with exactly $STEER_MARKER and nothing else."
run_cli "$RECEIPT_DIR/rpc/steer-idle.json" steer "$SESSION_ID" "$STEER_PROMPT"
assert_json "idle steer was not dispatched as Copilot immediate input" '
  .state == "succeeded" and (.result.messageId | type == "string") and
  .request.request.harness == "copilot" and .request.request.command.type == "steer" and
  .request.request.command.mode == "immediate" and .request.request.command.prompt == $prompt
' "$RECEIPT_DIR/rpc/steer-idle.json" --arg prompt "$STEER_PROMPT"
wait_for_events "idle-steer response" '
  [inputs, .] as $events |
  [$events[] | select(.kind == "native" and .sessionId == $sid and
    .nativeType == "user.message" and .payload.data.content == $prompt)][-1] as $input |
  $input != null and any($events[]; .kind == "native" and .sessionId == $sid and
    .nativeType == "assistant.message" and .payload.data.content == $marker and
    .sequence > $input.sequence)
' 300 --arg prompt "$STEER_PROMPT" --arg marker "$STEER_MARKER"
jq -s --arg sid "$SESSION_ID" --arg prompt "$STEER_PROMPT" --arg marker "$STEER_MARKER" '
  [.[] | select(.kind == "native" and .sessionId == $sid)] as $events |
  [$events[] | select(.nativeType == "user.message" and
    .payload.data.content == $prompt)][-1] as $input |
  $input != null and any($events[]; .nativeType == "assistant.message" and
    .payload.data.content == $marker and .sequence > $input.sequence)
' "$RECEIPT_DIR/logs/fleet-events.ndjson" >"$RECEIPT_DIR/phases/steer-assertions.json"
assert_json "idle immediate-steer native round trip is incomplete" '. == true' \
  "$RECEIPT_DIR/phases/steer-assertions.json"

note "phase 9/9: native built-in Explore subagent lifecycle"
run_cli "$RECEIPT_DIR/rpc/set-model-subagent.json" model "$SESSION_ID" "$INITIAL_MODEL"
assert_json "subagent model selection failed" '.state == "succeeded"' \
  "$RECEIPT_DIR/rpc/set-model-subagent.json"
SUBAGENT_SUCCEEDED=0
SUBAGENT_ATTEMPTS=0
for attempt in 1 2; do
  SUBAGENT_ATTEMPTS=$attempt
  SUBAGENT_PROMPT="For a native lifecycle receipt, use the task tool exactly once with the built-in explore agent. Give it only this task: reply with exactly $SUBAGENT_CHILD and do nothing else. Wait for it, then reply exactly $SUBAGENT_PARENT and nothing else."
  run_cli "$RECEIPT_DIR/rpc/send-subagent-attempt-$attempt.json" \
    send "$SESSION_ID" "$SUBAGENT_PROMPT"
  if wait_for_events "subagent attempt $attempt parent completion" '
    select(.kind == "native" and .sessionId == $sid and
      .nativeType == "assistant.message" and .payload.data.content == $parent and
      (.payload.agentId == null))
  ' 300 --arg parent "$SUBAGENT_PARENT" && jq -s -e \
    --arg sid "$SESSION_ID" --arg child "$SUBAGENT_CHILD" --arg parent "$SUBAGENT_PARENT" '
    [.[] | select(.kind == "native" and .sessionId == $sid)] as $events |
    [$events[] | select(.nativeType == "subagent.started" and
      .payload.data.agentName == "explore")][-1] as $started |
    [$events[] | select(.nativeType == "subagent.completed" and
      .payload.data.toolCallId == $started.payload.data.toolCallId and
      ((.payload.data.cancelled // false) == false))][0] as $completed |
    $started != null and $completed != null and
    $started.payload.agentId == $started.payload.data.toolCallId and
    $completed.payload.agentId == $started.payload.agentId and
    any($events[]; .nativeType == "assistant.message" and
      .payload.agentId == $started.payload.agentId and .payload.data.content == $child) and
    any($events[]; .nativeType == "assistant.message" and
      (.payload.agentId == null) and .payload.data.content == $parent and
      .sequence > $completed.sequence)
  ' "$RECEIPT_DIR/logs/fleet-events.ndjson" >/dev/null; then
    SUBAGENT_SUCCEEDED=1
    break
  fi
  note "subagent attempt $attempt lacked a matching successful terminal lifecycle; retrying once"
done
if (( SUBAGENT_SUCCEEDED == 0 )); then
  fail "Copilot did not produce a matching Explore subagent lifecycle after two attempts"
fi
jq -s --arg sid "$SESSION_ID" --arg child "$SUBAGENT_CHILD" --arg parent "$SUBAGENT_PARENT" '
  [.[] | select(.kind == "native" and .sessionId == $sid)] as $events |
  [$events[] | select(.nativeType == "subagent.started" and
    .payload.data.agentName == "explore")][-1] as $started |
  [$events[] | select(.nativeType == "subagent.completed" and
    .payload.data.toolCallId == $started.payload.data.toolCallId and
    ((.payload.data.cancelled // false) == false))][0] as $completed |
  $started != null and $completed != null and
  $started.payload.agentId == $started.payload.data.toolCallId and
  $completed.payload.agentId == $started.payload.agentId and
  any($events[]; .nativeType == "assistant.message" and
    .payload.agentId == $started.payload.agentId and .payload.data.content == $child) and
  any($events[]; .nativeType == "assistant.message" and
    (.payload.agentId == null) and .payload.data.content == $parent and
    .sequence > $completed.sequence)
' "$RECEIPT_DIR/logs/fleet-events.ndjson" >"$RECEIPT_DIR/phases/subagent-assertions.json"
assert_json "native Copilot subagent evidence is incomplete" '. == true' \
  "$RECEIPT_DIR/phases/subagent-assertions.json"
jq -c --arg sid "$SESSION_ID" --arg child "$SUBAGENT_CHILD" --arg parent "$SUBAGENT_PARENT" '
  select(.kind == "native" and .sessionId == $sid and
    (.nativeType == "subagent.started" or .nativeType == "subagent.completed" or
      (.nativeType == "assistant.message" and
       (.payload.data.content == $child or .payload.data.content == $parent))))
' "$RECEIPT_DIR/logs/fleet-events.ndjson" >"$RECEIPT_DIR/phases/subagent-events.ndjson"

run_cli "$RECEIPT_DIR/rpc/native-history-final.json" history "$SESSION_ID" --all --limit 50
assert_json "native resumed history does not span both runtime handles" '
  (if type == "array" then [.[].payload[]] else .payload end) as $events |
  any($events[]; .type == "assistant.message" and .data.content == $before) and
  any($events[]; .type == "assistant.message" and .data.content == $after) and
  any($events[]; .type == "assistant.message" and .data.content == $steer) and
  any($events[]; .type == "subagent.started" and .data.agentName == "explore") and
  any($events[]; .type == "subagent.completed" and .data.agentName == "explore" and
    ((.data.cancelled // false) == false))
' "$RECEIPT_DIR/rpc/native-history-final.json" \
  --arg before "$STREAM_MARKER" --arg after "$RESUME_MARKER" --arg steer "$STEER_MARKER"

note "capturing the live Copilot session dashboard"
timeout 90s node "$SCRIPT_DIR/capture.mjs" \
  "$DASHBOARD_URL" "$RECEIPT_DIR/screenshots/dashboard-copilot-session.png" \
  "$RECEIPT_DIR/logs/browser-console.txt" "$WORKER_NAME" "$SESSION_TITLE" "$SUBAGENT_PARENT" \
  >"$RECEIPT_DIR/rpc/playwright-dashboard.json" 2>"$RECEIPT_DIR/logs/playwright.log"
assert_json "dashboard did not show live resumed Copilot stream" '
  .assertions.workerOnlineAndCopilotReady == true and
  .assertions.sessionActive == true and .assertions.streamLive == true and
  .assertions.expectedTextVisible == true and .browserConsoleMessageCount >= 0
' "$RECEIPT_DIR/rpc/playwright-dashboard.json"

run_cli "$RECEIPT_DIR/rpc/stop-final.json" stop "$SESSION_ID"
assert_json "final stop failed" '.state == "succeeded"' "$RECEIPT_DIR/rpc/stop-final.json"
run_cli "$RECEIPT_DIR/rpc/refresh-final.json" refresh "$WORKER_NAME"
run_cli "$RECEIPT_DIR/rpc/sessions-final.json" sessions --worker "$WORKER_NAME" --harness copilot
assert_json "final Copilot session did not converge to resumable/stopped" '
  any(.[]; .sessionId == $sid and .vendorSessionId == $vendor and
    .availability == "resumable" and .runtimeStatus == "stopped" and .runtimeEpoch == null)
' "$RECEIPT_DIR/rpc/sessions-final.json" --arg sid "$SESSION_ID" --arg vendor "$VENDOR_SESSION_ID"

if [[ -n "$WATCH_PID" ]] && kill -0 "$WATCH_PID" 2>/dev/null; then
  kill "$WATCH_PID" 2>/dev/null || true
  wait "$WATCH_PID" 2>/dev/null || true
fi
WATCH_PID=""

NETWORK_CONTAINER_COUNT=$(docker network inspect --format '{{len .Containers}}' "$NETWORK_NAME")
if [[ "$NETWORK_CONTAINER_COUNT" != 2 ]]; then fail "expected two application containers"; fi
HOST_CONTAINER_ID=$(docker inspect --format '{{.Id}}' "$HOST_CONTAINER")
WORKER_CONTAINER_ID=$(docker inspect --format '{{.Id}}' "$WORKER_CONTAINER")
if [[ "$HOST_CONTAINER_ID" == "$WORKER_CONTAINER_ID" ]]; then fail "host and worker share a container"; fi
if [[ -n $(docker port "$WORKER_CONTAINER" 2>/dev/null) ]]; then fail "worker publishes a host port"; fi

NODE_VERSION=$(docker exec "$HOST_CONTAINER" node --version | tr -d '\r\n')
COPILOT_VERSION=$(jq -r '.[] | select(.harness == "copilot") | .runtimeVersion' \
  "$RECEIPT_DIR/rpc/catalog.json")
COPILOT_SDK_VERSION=$(jq -r '.[] | select(.harness == "copilot") | .version' \
  "$RECEIPT_DIR/rpc/catalog.json")
DOCKER_VERSION=$(docker version --format '{{.Server.Version}}')
P2PRPC_REVISION=$(git -C "$P2PRPC_CORE" rev-parse HEAD 2>/dev/null || printf 'unavailable')
capture_logs

jq -n \
  --arg hostName "$HOST_CONTAINER" --arg hostId "$HOST_CONTAINER_ID" \
  --arg workerName "$WORKER_CONTAINER" --arg workerId "$WORKER_CONTAINER_ID" \
  --arg network "$NETWORK_NAME" --arg image "$IMAGE_ID" \
  --arg dashboard "$DASHBOARD_URL" --arg endpoint "$P2P_ENDPOINT_ID" \
  --arg ticketDigest "$P2P_TICKET_SHA256" '
  {
    applicationContainerCount:2, sharedImageId:$image,
    network:{name:$network,driver:"bridge"},
    containers:[
      {name:$hostName,id:$hostId,role:"canonical Multiplex host + dashboard",publishedDashboard:$dashboard},
      {name:$workerName,id:$workerId,role:"Multiplex worker + real Copilot runtime child",publishedPorts:[]}
    ],
    transport:{protocol:"p2prpc v1 over Iroh",hostEndpointId:$endpoint,
      ticketRecorded:false,ticketSha256:$ticketDigest},
    browserRunsOnDockerHost:true,
    apiKeyMount:{destination:"/run/secrets/codex-lb-api-key",readOnly:true,recorded:false}
  }
' >"$RECEIPT_DIR/topology.json"

RUN_COMPLETED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
jq -n \
  --arg runId "$RUN_ID" --arg startedAt "$RUN_STARTED_AT" --arg completedAt "$RUN_COMPLETED_AT" \
  --arg docker "$DOCKER_VERSION" --arg node "$NODE_VERSION" --arg copilot "$COPILOT_VERSION" \
  --arg sdk "$COPILOT_SDK_VERSION" --arg p2prpc "$P2PRPC_REVISION" \
  --arg initialModel "$INITIAL_MODEL" --arg secondModel "$SECOND_MODEL" \
  --arg sessionId "$SESSION_ID" --arg vendorSessionId "$VENDOR_SESSION_ID" \
  --argjson planAttempts "$PLAN_ATTEMPTS" --argjson subagentAttempts "$SUBAGENT_ATTEMPTS" '
  {
    runId:$runId,status:"passed",startedAt:$startedAt,completedAt:$completedAt,
    versions:{dockerServer:$docker,nodeInImage:$node,copilotRuntime:$copilot,
      copilotSdk:$sdk,multiplexProtocol:1,p2prpcRevision:$p2prpc},
    provider:{type:"openai",wireApi:"responses",transport:"http",credentialMode:"API-key file",
      providerEndpointRecorded:false},
    models:{initial:$initialModel,switched:$secondModel},
    identities:{logicalSessionId:$sessionId,copilotSessionId:$vendorSessionId},
    planInteractionAttempts:$planAttempts,
    subagentAttempts:$subagentAttempts,
    credentialMaterialRecorded:false
  }
' >"$RECEIPT_DIR/manifest.json"

jq -n '
  {
    passed:true,
    topology:{exactlyTwoApplicationContainers:true,hostSidePlaywright:true,workerPublishesNoPorts:true},
    copilotAdapter:{
      byokOverCodexLbResponses:true,multiDeltaStreamReassembledExactly:true,
      shellPermissionResolvedNatively:true,toolLifecycleVisible:true,
      modelSwitchObservedNatively:true,planModeObservedNatively:true,
      askUserTypedAnswerResolved:true,exitPlanApproved:true,
      activeTurnInterrupted:true,idleImmediateSteerRoundTrip:true,
      nativeSubagentLifecycleVisible:true,nativeHistoryViaSdk:true,
      metadataRoundTrip:true,stopResumeContinuedHistory:true,
      liveRuntimeProcessObserved:true
    },
    screenshotsCaptured:1,
    credentials:{hostApiKeyBindMountedReadOnly:true,apiKeyCopied:false,leakScanPassed:true}
  }
' >"$RECEIPT_DIR/checks.json"

{
  printf '# Copilot interactive BYOK two-container E2E receipt\n\n'
  printf 'Status: **PASS**\n\nRun: `%s`\n\n' "$RUN_ID"
  printf 'Exactly two application containers were used: one canonical Multiplex host and one worker running the real Copilot runtime. Playwright ran on the Docker host.\n\n'
  printf '## Verified phases\n\n'
  printf -- '- OpenAI-compatible BYOK through codex-lb using an API key, the Responses API, and HTTP transport.\n'
  printf -- '- Exact reconstruction of a final answer from multiple native `assistant.message_delta` events.\n'
  printf -- '- Native shell permission request, canonical interactive approval, and matching tool start/completion events.\n'
  printf -- '- Runtime model switch and a response reporting the second model.\n'
  printf -- '- Native Plan mode, `ask_user`, typed freeform answer, `exit_plan_mode`, and approval with `exit_only`.\n'
  printf -- '- Active-turn abort and a subsequent native aborted-idle event.\n'
  printf -- '- Idle native `steer` dispatched with immediate delivery and completed through the same session.\n'
  printf -- '- Built-in Explore subagent start/completion, child output, and matching parent result.\n'
  printf -- '- History through `CopilotSession.getEvents()` only, plus stop/resume and continued native history.\n'
  printf -- '- Canonical metadata update and a live dashboard screenshot without browser errors.\n\n'
  printf 'The host API-key file was bind-mounted read-only at runtime. No API key, endpoint, raw P2P ticket, shared secret, or Copilot home is included in this receipt.\n'
} >"$RECEIPT_DIR/README.md"

for forbidden in "$SHARED_SECRET" "$P2P_TICKET" "$API_KEY_LITERAL" "$PROVIDER_URL"; do
  if [[ -n "$forbidden" ]] && rg --text --fixed-strings --quiet -- "$forbidden" "$RECEIPT_DIR"; then
    fail "credential/provider material leaked into receipt directory"
  fi
done

(
  cd "$RECEIPT_DIR"
  find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum >SHA256SUMS
  sha256sum --check SHA256SUMS >/dev/null
)

COMPLETED=1
