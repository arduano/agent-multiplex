#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/../.." && pwd)
DOCKER_NPMRC=${AGENT_MULTIPLEX_DOCKER_NPMRC:-}
RECEIPT_ROOT=${AGENT_MULTIPLEX_SCALE_RECEIPT_ROOT:-"$REPO_ROOT/receipts/protocol-v4-mock-docker-scale"}
RUNTIME_NODE_COUNT=10
SESSIONS_PER_RUNTIME_NODE=10
TOTAL_SESSIONS=$(( RUNTIME_NODE_COUNT * SESSIONS_PER_RUNTIME_NODE ))
CHUNK_COUNT=${AGENT_MULTIPLEX_RUNTIME_NODE_MOCK_CHUNK_COUNT:-32}
# Keep the deterministic native turn long enough for all 100 independently
# routed sends to start even on a busy developer machine. The driver proves
# overlap from source-emission timestamps, not observer delivery time.
CHUNK_INTERVAL_MS=${AGENT_MULTIPLEX_SCALE_CHUNK_INTERVAL_MS:-100}
TIMEOUT_MS=${AGENT_MULTIPLEX_SCALE_TIMEOUT_MS:-180000}
SOAK_MS=${AGENT_MULTIPLEX_SCALE_SOAK_MS:-15000}
DISCONNECT_MS=${AGENT_MULTIPLEX_SCALE_DISCONNECT_MS:-800}

for value_name in CHUNK_COUNT CHUNK_INTERVAL_MS TIMEOUT_MS SOAK_MS DISCONNECT_MS; do
  value=${!value_name}
  if [[ ! "$value" =~ ^[0-9]+$ ]] || (( value < 1 )); then
    echo "mock Docker scale: $value_name must be a positive integer" >&2
    exit 1
  fi
done
if (( CHUNK_COUNT < 8 )); then
  echo "mock Docker scale: CHUNK_COUNT must be at least 8 for reconnect coverage" >&2
  exit 1
fi
if (( SOAK_MS < 2000 )); then
  echo "mock Docker scale: SOAK_MS must be at least 2000" >&2
  exit 1
fi

for tool in docker jq node npm curl sha256sum awk sed perl rg timeout find sort xargs; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "mock Docker scale: required tool '$tool' is unavailable" >&2
    exit 1
  fi
done
if [[ -z "$DOCKER_NPMRC" ]]; then
  DOCKER_NPMRC=$(npm config get userconfig)
fi
if [[ ! -f "$DOCKER_NPMRC" || ! -r "$DOCKER_NPMRC" ]]; then
  echo "mock Docker scale: a readable npm user config is required for the GitHub Packages build secret" >&2
  exit 1
fi

random_hex() {
  node -e 'process.stdout.write(require("node:crypto").randomBytes(6).toString("hex"))'
}

RUN_ID=${AGENT_MULTIPLEX_SCALE_RUN_ID:-"$(date -u +%Y%m%dT%H%M%SZ)-$(random_hex)"}
if [[ ! "$RUN_ID" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "mock Docker scale: run id may contain only letters, digits, dot, underscore, or dash" >&2
  exit 1
fi

RECEIPT_DIR="$RECEIPT_ROOT/$RUN_ID"
if [[ -e "$RECEIPT_DIR" ]]; then
  echo "mock Docker scale: receipt directory already exists: $RECEIPT_DIR" >&2
  exit 1
fi
mkdir -p \
  "$RECEIPT_DIR/logs/runtime-nodes" \
  "$RECEIPT_DIR/rpc" \
  "$RECEIPT_DIR/phases" \
  "$RECEIPT_DIR/coord" \
  "$RECEIPT_DIR/screenshots"

RUNTIME_DIR=$(mktemp -d "${TMPDIR:-/tmp}/agent-multiplex-mock-scale.XXXXXXXX")
NAME_SUFFIX=$(printf '%s' "$RUN_ID" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9' | tail -c 22)
CONTROL_NODE_CONTAINER="agent-multiplex-scale-control-$NAME_SUFFIX"
GATEWAY_CONTAINER="agent-multiplex-scale-gateway-$NAME_SUFFIX"
NETWORK_NAME="agent-multiplex-scale-$NAME_SUFFIX"
IMAGE_TAG="agent-multiplex-mock-scale:$NAME_SUFFIX"
RUNTIME_NODE_PREFIX="mock-runtime-$NAME_SUFFIX"
SHARED_SECRET=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(48).toString("base64url"))')
ACCESS_TOKEN=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(48).toString("base64url"))')
RUN_STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

declare -a RUNTIME_NODE_CONTAINERS=()
declare -a RUNTIME_NODE_NAMES=()
declare -a ALL_CONTAINERS=()
CONTROL_NODE_STARTED=0
GATEWAY_STARTED=0
RUNTIME_NODES_STARTED=0
NETWORK_CREATED=0
IMAGE_BUILT=0
LOGS_CAPTURED=0
COMPLETED=0
DRIVER_PID=""
RESOURCE_PID=""
CONTROL_NODE_TICKET=""
CONTROL_NODE_ENDPOINT_ID=""

note() {
  printf '[mock-docker-scale] %s\n' "$*" >&2
}

fail() {
  note "FAILED: $*"
  return 1
}

redact_stream() {
  AM_REDACT_SHARED="$SHARED_SECRET" \
  AM_REDACT_ACCESS="$ACCESS_TOKEN" \
  AM_REDACT_TICKET="$CONTROL_NODE_TICKET" \
    perl -0pe '
      BEGIN {
        @pairs = (
          [$ENV{AM_REDACT_SHARED} // "", "<redacted-shared-secret>"],
          [$ENV{AM_REDACT_ACCESS} // "", "<redacted-access-token>"],
          [$ENV{AM_REDACT_TICKET} // "", "<redacted-p2p-ticket>"],
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
  local raw_control="$RUNTIME_DIR/control-node.raw.log"
  if (( CONTROL_NODE_STARTED == 1 )); then
    docker logs "$CONTROL_NODE_CONTAINER" >"$raw_control" 2>&1 || true
    awk '
      redact_next { print "<redacted-locator>"; redact_next = 0; next }
      /^P2P ticket \(/ { print; redact_next = 1; next }
      { print }
    ' "$raw_control" | redact_stream >"$RECEIPT_DIR/logs/control-node.log"
  fi
  if (( GATEWAY_STARTED == 1 )); then
    docker logs "$GATEWAY_CONTAINER" 2>&1 \
      | redact_stream >"$RECEIPT_DIR/logs/access-gateway.log" || true
  fi
  local index container raw_runtime
  for (( index = 0; index < RUNTIME_NODES_STARTED; index++ )); do
    container=${RUNTIME_NODE_CONTAINERS[$index]}
    raw_runtime="$RUNTIME_DIR/runtime-node-$index.raw.log"
    docker logs "$container" >"$raw_runtime" 2>&1 || true
    redact_stream <"$raw_runtime" \
      >"$RECEIPT_DIR/logs/runtime-nodes/${RUNTIME_NODE_NAMES[$index]}.log"
  done
  LOGS_CAPTURED=1
}

remove_test_topology() {
  local container
  for container in "${RUNTIME_NODE_CONTAINERS[@]}"; do
    docker rm --force "$container" >/dev/null 2>&1 || true
  done
  RUNTIME_NODES_STARTED=0
  if (( GATEWAY_STARTED == 1 )); then
    docker rm --force "$GATEWAY_CONTAINER" >/dev/null 2>&1 || true
    GATEWAY_STARTED=0
  fi
  if (( CONTROL_NODE_STARTED == 1 )); then
    docker rm --force "$CONTROL_NODE_CONTAINER" >/dev/null 2>&1 || true
    CONTROL_NODE_STARTED=0
  fi
  if (( NETWORK_CREATED == 1 )); then
    docker network rm "$NETWORK_NAME" >/dev/null 2>&1 || true
    NETWORK_CREATED=0
  fi
  if (( IMAGE_BUILT == 1 )) && [[ ${AGENT_MULTIPLEX_SCALE_KEEP_IMAGE:-0} != 1 ]]; then
    docker image rm "$IMAGE_TAG" >/dev/null 2>&1 || true
    IMAGE_BUILT=0
  fi
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  if [[ -n "$DRIVER_PID" ]] && kill -0 "$DRIVER_PID" 2>/dev/null; then
    kill "$DRIVER_PID" 2>/dev/null
    wait "$DRIVER_PID" 2>/dev/null
  fi
  if [[ -n "$RESOURCE_PID" ]] && kill -0 "$RESOURCE_PID" 2>/dev/null; then
    kill "$RESOURCE_PID" 2>/dev/null
    wait "$RESOURCE_PID" 2>/dev/null
  fi
  capture_logs
  remove_test_topology
  if [[ -n "$RUNTIME_DIR" && -d "$RUNTIME_DIR" && "$RUNTIME_DIR" != "/" && \
        "$(basename -- "$RUNTIME_DIR")" == agent-multiplex-mock-scale.* ]]; then
    rm -rf -- "$RUNTIME_DIR"
  fi
  if (( COMPLETED == 0 )); then
    printf 'The mock Docker scale run failed. Inspect driver-failure.json and logs/.\n' \
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

wait_for_control_node_startup() {
  local attempt logs
  for attempt in $(seq 1 90); do
    if [[ $(docker inspect --format '{{.State.Running}}' "$CONTROL_NODE_CONTAINER" 2>/dev/null) != true ]]; then
      docker logs "$CONTROL_NODE_CONTAINER" 2>&1 \
        | awk '
            redact_next { print "<redacted-locator>"; redact_next = 0; next }
            /^P2P ticket \(/ { print; redact_next = 1; next }
            { print }
          ' \
        | redact_stream >&2 || true
      fail "control-node container exited during startup"
      return
    fi
    logs=$(docker logs "$CONTROL_NODE_CONTAINER" 2>&1 || true)
    if rg --quiet '^P2P endpoint:' <<<"$logs" && rg --quiet '^P2P ticket \(' <<<"$logs"; then
      return
    fi
    if (( attempt % 15 == 0 )); then
      note "waiting for control-node endpoint and P2P ticket (${attempt}s)"
    fi
    sleep 1
  done
  fail "timed out waiting for control-node startup"
}

sample_resources() {
  local sampled_at raw
  while [[ ! -e "$RECEIPT_DIR/coord/stop-resource-sampling" ]]; do
    sampled_at=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
    raw=$(timeout 25s docker stats --no-stream --format '{{json .}}' \
      "${ALL_CONTAINERS[@]}" 2>/dev/null || true)
    if [[ -n "$raw" ]]; then
      jq -c --arg sampledAt "$sampled_at" '. + {sampledAt: $sampledAt}' \
        <<<"$raw" >>"$RECEIPT_DIR/logs/docker-stats.ndjson" || true
    fi
    sleep 1
  done
}

assert_json() {
  local description=$1
  local filter=$2
  local file=$3
  shift 3
  if ! jq -e "$@" "$filter" "$file" >/dev/null; then
    fail "$description (see ${file#"$RECEIPT_DIR/"})"
  fi
}

note "building one immutable protocol-v4 application image"
if ! docker build \
  --progress=plain \
  --secret "id=npmrc,src=$DOCKER_NPMRC" \
  --file "$SCRIPT_DIR/Dockerfile" \
  --tag "$IMAGE_TAG" \
  "$REPO_ROOT" >"$RECEIPT_DIR/logs/docker-build.log" 2>&1; then
  tail -n 100 "$RECEIPT_DIR/logs/docker-build.log" >&2 || true
  fail "Docker image build failed"
fi
IMAGE_BUILT=1
IMAGE_ID=$(docker image inspect --format '{{.Id}}' "$IMAGE_TAG")

docker network create --driver bridge "$NETWORK_NAME" >/dev/null
NETWORK_CREATED=1

note "starting hidden canonical control-node container"
docker run --detach \
  --name "$CONTROL_NODE_CONTAINER" \
  --hostname multiplex-control-node \
  --network "$NETWORK_NAME" \
  --init \
  --user 1000:100 \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --tmpfs /state:rw,nosuid,nodev,mode=0700,uid=1000,gid=100 \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777 \
  --env AGENT_MULTIPLEX_SHARED_SECRET="$SHARED_SECRET" \
  --env AGENT_MULTIPLEX_CONTROL_NODE_NAME=scale-authority \
  --env AGENT_MULTIPLEX_CONTROL_NODE_STATE=/state/control-node.sqlite \
  --env AGENT_MULTIPLEX_CONTROL_NODE_IDENTITY=/state/control-node.identity \
  --env AGENT_MULTIPLEX_CONTROL_NODE_HTTP_BIND=127.0.0.1 \
  --env AGENT_MULTIPLEX_CONTROL_NODE_HTTP_PORT=4317 \
  --env AGENT_MULTIPLEX_CONTROL_NODE_RUNTIME_STALE_MS=120000 \
  --env AGENT_MULTIPLEX_CONTROL_NODE_ALLOW_RUNTIME_NODE_ENROLLMENT=1 \
  --env AGENT_MULTIPLEX_CONTROL_NODE_ALLOW_ACCESS_GATEWAY_ENROLLMENT=1 \
  --env 'AGENT_MULTIPLEX_CONTROL_NODE_ACCESS_GATEWAY_SCOPES=["read","agent-control","agent-launch","metadata-propose"]' \
  "$IMAGE_TAG" \
  node apps/control-node/dist/main.js >/dev/null
CONTROL_NODE_STARTED=1
ALL_CONTAINERS=("$CONTROL_NODE_CONTAINER")
wait_for_control_node_startup

CONTROL_NODE_LOGS=$(docker logs "$CONTROL_NODE_CONTAINER" 2>&1)
CONTROL_NODE_ENDPOINT_ID=$(sed -n 's/^P2P endpoint:[[:space:]]*//p' <<<"$CONTROL_NODE_LOGS" | tail -n 1)
CONTROL_NODE_TICKET=$(awk '/^P2P ticket \(/ { getline; print; exit }' <<<"$CONTROL_NODE_LOGS")
if [[ ! "$CONTROL_NODE_ENDPOINT_ID" =~ ^[a-z2-7]{52}$ ]]; then
  fail "control node emitted an invalid P2P endpoint ID"
fi
if (( ${#CONTROL_NODE_TICKET} < 20 || ${#CONTROL_NODE_TICKET} > 8192 )) || \
   [[ "$CONTROL_NODE_TICKET" =~ [[:space:]] ]]; then
  fail "control node emitted an invalid P2P ticket"
fi
CONTROL_NODE_TICKET_SHA256=$(printf '%s' "$CONTROL_NODE_TICKET" | sha256sum | awk '{print $1}')

printf '%s\n' "$ACCESS_TOKEN" >"$RUNTIME_DIR/access-token"
chmod 600 "$RUNTIME_DIR/access-token"
GATEWAY_SOURCES=$(jq -cn \
  --arg endpoint "$CONTROL_NODE_ENDPOINT_ID" \
  --arg ticket "$CONTROL_NODE_TICKET" '
  {
    version: 1,
    sources: [{
      sourceId: "canonical",
      displayName: "Scale authority",
      endpointId: $endpoint,
      locator: {kind: "ticket", ticket: $ticket},
      priority: 100,
      enabled: true,
      requestedScopes: ["read", "agent-control", "agent-launch", "metadata-propose"]
    }]
  }')

note "starting authenticated zero-authority access-gateway container"
docker run --detach \
  --name "$GATEWAY_CONTAINER" \
  --hostname multiplex-access-gateway \
  --network "$NETWORK_NAME" \
  --init \
  --user 1000:100 \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --tmpfs /state:rw,nosuid,nodev,mode=0700,uid=1000,gid=100 \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777 \
  --mount type=bind,src="$RUNTIME_DIR/access-token",dst=/run/access-token,readonly \
  --publish 127.0.0.1::4318 \
  --env AGENT_MULTIPLEX_SHARED_SECRET="$SHARED_SECRET" \
  --env AGENT_MULTIPLEX_ACCESS_GATEWAY_IDENTITY=/state/access-gateway.identity \
  --env AGENT_MULTIPLEX_ACCESS_GATEWAY_STATE=/state/access-gateway.sqlite \
  --env AGENT_MULTIPLEX_ACCESS_GATEWAY_SOURCES="$GATEWAY_SOURCES" \
  --env AGENT_MULTIPLEX_ACCESS_GATEWAY_HTTP_BIND=0.0.0.0 \
  --env AGENT_MULTIPLEX_ACCESS_GATEWAY_HTTP_PORT=4318 \
  --env AGENT_MULTIPLEX_ACCESS_GATEWAY_BEARER_TOKEN_FILE=/run/access-token \
  --env 'AGENT_MULTIPLEX_ACCESS_GATEWAY_SCOPES=["read","agent-control","agent-launch","metadata-propose"]' \
  --env AGENT_MULTIPLEX_ACCESS_GATEWAY_AUTH_SUBJECT=scale-driver \
  "$IMAGE_TAG" \
  node apps/gateway/dist/main.js >/dev/null
GATEWAY_STARTED=1
ALL_CONTAINERS+=("$GATEWAY_CONTAINER")

PORT_MAPPING=$(docker port "$GATEWAY_CONTAINER" 4318/tcp | tail -n 1)
DASHBOARD_PORT=${PORT_MAPPING##*:}
if [[ ! "$DASHBOARD_PORT" =~ ^[0-9]+$ ]]; then
  fail "could not resolve the published dashboard port"
fi
DASHBOARD_URL="http://127.0.0.1:$DASHBOARD_PORT/"
TRPC_URL="http://127.0.0.1:$DASHBOARD_PORT/trpc"
for attempt in $(seq 1 30); do
  if curl --fail --silent --show-error "$DASHBOARD_URL" >/dev/null; then
    break
  fi
  if (( attempt == 30 )); then
    fail "dashboard did not become reachable"
  fi
  sleep 1
done
UNAUTHENTICATED_STATUS=$(curl --silent --output /dev/null --write-out '%{http_code}' \
  "$TRPC_URL/system.describe")
if [[ "$UNAUTHENTICATED_STATUS" != 401 ]]; then
  fail "gateway accepted an unauthenticated tRPC request (HTTP $UNAUTHENTICATED_STATUS)"
fi
jq -n --argjson status "$UNAUTHENTICATED_STATUS" '
  {
    unauthenticatedSystemDescribeStatus: $status,
    unauthenticatedRejected: ($status == 401),
    bearerTokenRecorded: false
  }
' >"$RECEIPT_DIR/rpc/auth-boundary.json"

note "starting 10 isolated mock runtime-node containers"
for (( index = 0; index < RUNTIME_NODE_COUNT; index++ )); do
  suffix=$(printf '%02d' "$index")
  runtime_node_name="$RUNTIME_NODE_PREFIX-$suffix"
  runtime_node_container="agent-multiplex-scale-runtime-$NAME_SUFFIX-$suffix"
  RUNTIME_NODE_NAMES+=("$runtime_node_name")
  RUNTIME_NODE_CONTAINERS+=("$runtime_node_container")
  docker run --detach \
    --name "$runtime_node_container" \
    --hostname "mock-runtime-$suffix" \
    --network "$NETWORK_NAME" \
    --init \
    --user 1000:100 \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --tmpfs /state:rw,nosuid,nodev,mode=0700,uid=1000,gid=100 \
    --tmpfs /tmp:rw,nosuid,nodev,mode=1777 \
    --env AGENT_MULTIPLEX_SHARED_SECRET="$SHARED_SECRET" \
    --env AGENT_MULTIPLEX_CONTROL_NODE_ENDPOINT_ID="$CONTROL_NODE_ENDPOINT_ID" \
    --env AGENT_MULTIPLEX_CONTROL_NODE_TICKET="$CONTROL_NODE_TICKET" \
    --env 'AGENT_MULTIPLEX_RUNTIME_NODE_ALLOWED_ROOTS=["/workspace"]' \
    --env AGENT_MULTIPLEX_RUNTIME_NODE_STATE_DIR=/state/runtime-node \
    --env AGENT_MULTIPLEX_RUNTIME_NODE_NAME="$runtime_node_name" \
    --env AGENT_MULTIPLEX_RUNTIME_NODE_HARNESSES=codex \
    --env AGENT_MULTIPLEX_RUNTIME_NODE_ADAPTER_MODE=mock \
    --env AGENT_MULTIPLEX_RUNTIME_NODE_MOCK_CHUNK_COUNT="$CHUNK_COUNT" \
    --env AGENT_MULTIPLEX_RUNTIME_NODE_MOCK_STREAM_INTERVAL_MS="$CHUNK_INTERVAL_MS" \
    --env AGENT_MULTIPLEX_RUNTIME_NODE_HEARTBEAT_MS=500 \
    --env AGENT_MULTIPLEX_RUNTIME_NODE_INVENTORY_REFRESH_MS=1000 \
    --env AGENT_MULTIPLEX_RUNTIME_NODE_METADATA_FLUSH_MS=500 \
    --env AGENT_MULTIPLEX_RUNTIME_NODE_RECONNECT_MAX_MS=1000 \
    "$IMAGE_TAG" \
    node apps/runtime-node/dist/main.js >/dev/null
  RUNTIME_NODES_STARTED=$(( index + 1 ))
  ALL_CONTAINERS+=("$runtime_node_container")
done

: >"$RECEIPT_DIR/logs/docker-stats.ndjson"
sample_resources &
RESOURCE_PID=$!

note "creating 100 sessions, streaming 100 turns, and injecting reconnect faults"
DRIVER_TIMEOUT_SECONDS=$(( (TIMEOUT_MS * 4 + SOAK_MS) / 1000 + 120 ))
AGENT_MULTIPLEX_ACCEPTANCE_BEARER_TOKEN_FILE="$RUNTIME_DIR/access-token" \
timeout "${DRIVER_TIMEOUT_SECONDS}s" node "$SCRIPT_DIR/driver.mjs" \
  "$TRPC_URL" \
  "$RECEIPT_DIR" \
  "$RUN_ID" \
  "$RUNTIME_NODE_PREFIX" \
  "$RUNTIME_NODE_COUNT" \
  "$SESSIONS_PER_RUNTIME_NODE" \
  "$CHUNK_COUNT" \
  "$TIMEOUT_MS" \
  "$SOAK_MS" \
  >"$RECEIPT_DIR/driver-summary.json" \
  2>"$RECEIPT_DIR/logs/driver.log" &
DRIVER_PID=$!

for attempt in $(seq 1 $(( TIMEOUT_MS / 50 + 1 ))); do
  if [[ -s "$RECEIPT_DIR/coord/disconnect-request.json" ]]; then
    break
  fi
  if ! kill -0 "$DRIVER_PID" 2>/dev/null; then
    wait "$DRIVER_PID" || true
    DRIVER_PID=""
    fail "scale driver exited before requesting a runtime-node disconnect"
  fi
  sleep 0.05
done
if [[ ! -s "$RECEIPT_DIR/coord/disconnect-request.json" ]]; then
  fail "timed out waiting for the scale driver's runtime-node disconnect request"
fi

TARGET_RUNTIME_NODE_INDEX=$(jq -r '.runtimeNodeIndex' "$RECEIPT_DIR/coord/disconnect-request.json")
TARGET_RUNTIME_NODE_NAME=$(jq -r '.runtimeNodeName' "$RECEIPT_DIR/coord/disconnect-request.json")
if [[ ! "$TARGET_RUNTIME_NODE_INDEX" =~ ^[0-9]+$ ]] || (( TARGET_RUNTIME_NODE_INDEX >= RUNTIME_NODE_COUNT )); then
  fail "scale driver requested an invalid runtime-node index"
fi
if [[ "$TARGET_RUNTIME_NODE_NAME" != "${RUNTIME_NODE_NAMES[$TARGET_RUNTIME_NODE_INDEX]}" ]]; then
  fail "scale driver runtime-node name/index do not agree"
fi
TARGET_RUNTIME_NODE_CONTAINER=${RUNTIME_NODE_CONTAINERS[$TARGET_RUNTIME_NODE_INDEX]}
TARGET_RUNTIME_NODE_ID=$(docker inspect --format '{{.Id}}' "$TARGET_RUNTIME_NODE_CONTAINER")
DISCONNECTED_AT=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
docker network disconnect "$NETWORK_NAME" "$TARGET_RUNTIME_NODE_CONTAINER"
if docker inspect --format '{{json .NetworkSettings.Networks}}' "$TARGET_RUNTIME_NODE_CONTAINER" \
  | jq -e --arg network "$NETWORK_NAME" 'has($network)' >/dev/null; then
  fail "target runtime node still reported membership in the scale network"
fi
sleep "$(awk -v milliseconds="$DISCONNECT_MS" 'BEGIN { printf "%.3f", milliseconds / 1000 }')"
if [[ $(docker inspect --format '{{.State.Running}}' "$TARGET_RUNTIME_NODE_CONTAINER") != true ]]; then
  fail "target runtime node exited while isolated from the Docker network"
fi
RECONNECTED_AT=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
docker network connect "$NETWORK_NAME" "$TARGET_RUNTIME_NODE_CONTAINER"
for attempt in $(seq 1 100); do
  if docker inspect --format '{{json .NetworkSettings.Networks}}' "$TARGET_RUNTIME_NODE_CONTAINER" \
    | jq -e --arg network "$NETWORK_NAME" 'has($network)' >/dev/null; then
    break
  fi
  if (( attempt == 100 )); then
    fail "target runtime node did not rejoin the scale network"
  fi
  sleep 0.05
done
jq -n \
  --arg runtimeNodeName "$TARGET_RUNTIME_NODE_NAME" \
  --arg containerName "$TARGET_RUNTIME_NODE_CONTAINER" \
  --arg containerId "$TARGET_RUNTIME_NODE_ID" \
  --arg disconnectedAt "$DISCONNECTED_AT" \
  --arg reconnectedAt "$RECONNECTED_AT" \
  --argjson disconnectMs "$DISCONNECT_MS" '
    {
      runtimeNodeName: $runtimeNodeName,
      containerName: $containerName,
      containerId: $containerId,
      disconnectedAt: $disconnectedAt,
      reconnectedAt: $reconnectedAt,
      requestedIsolationMs: $disconnectMs,
      containerStayedRunning: true,
      absentDuringDisconnect: true,
      presentAfterReconnect: true
    }
  ' >"$RECEIPT_DIR/coord/disconnect-complete.json"

if ! wait "$DRIVER_PID"; then
  DRIVER_PID=""
  tail -n 100 "$RECEIPT_DIR/logs/driver.log" >&2 || true
  fail "scale driver failed"
fi
DRIVER_PID=""

touch "$RECEIPT_DIR/coord/stop-resource-sampling"
if [[ -n "$RESOURCE_PID" ]]; then
  wait "$RESOURCE_PID" || true
fi
RESOURCE_PID=""
rm "$RECEIPT_DIR/coord/stop-resource-sampling"

assert_json "driver summary did not pass" '
  .passed == true and
  .topology.controlNodes == 1 and
  .topology.gatewaySources == 1 and
  .topology.runtimeNodes == 10 and
  .topology.sessionsPerRuntimeNode == 10 and
  .topology.totalSessions == 100 and
  .commands.spawnSucceeded == 100 and
  .commands.sendSucceeded == 100 and
  .streaming.completedTurns == 100 and
  .streaming.nativeGaps == 0 and
  .streaming.duplicateEvents == 0 and
  .streaming.exactDeltaReassemblies == 100 and
  .streaming.contiguousPerSessionSequences == 100 and
  .reconnect.clientCursorReplayDeduplicated == true and
  .reconnect.runtimeNodeStreamReplayedWithoutGap == true and
  .metadata.staleCasRejectedWithoutMutation == true and
  .stability.allRuntimeNodesOnline == true and
  .stability.allSessionsActiveAndIdle == true
' "$RECEIPT_DIR/driver-summary.json"

note "capturing reference dashboard with all 10 runtime nodes and 100 sessions"
if ! AGENT_MULTIPLEX_ACCEPTANCE_BEARER_TOKEN_FILE="$RUNTIME_DIR/access-token" \
  timeout 90s node "$SCRIPT_DIR/capture.mjs" \
  "$DASHBOARD_URL" \
  "$RECEIPT_DIR/screenshots/dashboard-100-agents.png" \
  "$RECEIPT_DIR/logs/browser-console.txt" \
  "$RUNTIME_NODE_PREFIX" \
  "$RUN_ID" \
  "$RUNTIME_NODE_COUNT" \
  "$TOTAL_SESSIONS" \
  >"$RECEIPT_DIR/rpc/playwright-dashboard.json" \
  2>"$RECEIPT_DIR/logs/playwright.log"; then
  fail "Playwright dashboard capture failed"
fi
assert_json "dashboard did not render the complete fleet" '
  .assertions.exactRuntimeNodeCards == true and
  .assertions.everyRuntimeNodeOnline == true and
  .assertions.exactSessionCards == true and
  .assertions.everySessionActiveAndIdle == true and
  .assertions.fleetPinnedAndReachable == true and
  .assertions.sessionAndFleetScrollIndependently == true and
  .assertions.searchNarrowsToOneSession == true and
  .assertions.selectionRemainsInteractive == true and
  .assertions.stableSessionRowHeight == true and
  .assertions.conversationRemainsAvailable == true and
  .assertions.searchAndSelectionRespondWithinOneSecond == true and
  .assertions.noDocumentOverflow == true and
  .assertions.noSeriousOrCriticalAccessibilityViolations == true and
  .assertions.browserConsoleErrors == 0 and
  .visible.runtimeNodeCardCount == 10 and
  .visible.onlineRuntimeNodeCardCount == 10 and
  .visible.sessionCardCount == 100 and
  .visible.activeIdleSessionCardCount == 100
' "$RECEIPT_DIR/rpc/playwright-dashboard.json"
if [[ ! -s "$RECEIPT_DIR/screenshots/dashboard-100-agents.png" ]]; then
  fail "Playwright did not write the scale screenshot"
fi

if [[ $(docker network inspect --format '{{len .Containers}}' "$NETWORK_NAME") != 12 ]]; then
  fail "scale network does not contain one control node, one gateway, and ten runtime nodes"
fi
for container in "${ALL_CONTAINERS[@]}"; do
  if [[ $(docker inspect --format '{{.State.Running}}' "$container") != true ]]; then
    fail "$container is not running at the final topology check"
  fi
done
for container in "${RUNTIME_NODE_CONTAINERS[@]}"; do
  if [[ -n $(docker port "$container" 2>/dev/null) ]]; then
    fail "$container unexpectedly publishes a host port"
  fi
done
if [[ -n $(docker port "$CONTROL_NODE_CONTAINER" 2>/dev/null) ]]; then
  fail "the trusted-local control node unexpectedly publishes a host port"
fi

docker inspect --format \
  '{"name":"{{.Name}}","id":"{{.Id}}","image":"{{.Image}}","running":{{.State.Running}},"oomKilled":{{.State.OOMKilled}},"exitCode":{{.State.ExitCode}},"restartCount":{{.RestartCount}},"startedAt":"{{.State.StartedAt}}"}' \
  "${ALL_CONTAINERS[@]}" | jq -s 'map(.name |= ltrimstr("/"))' \
  >"$RECEIPT_DIR/container-lifecycle.json"
assert_json "a scale container failed its lifecycle check" '
  length == 12 and
  (map(.id) | unique | length) == 12 and
  all(.[];
    .image == $image and
    .running == true and
    .oomKilled == false and
    .exitCode == 0 and
    .restartCount == 0)
' "$RECEIPT_DIR/container-lifecycle.json" --arg image "$IMAGE_ID"

jq -s '
  def percent: sub("%$"; "") | tonumber;
  {
    sampleRows: length,
    sampleTimes: (map(.sampledAt) | unique | length),
    containers: (
      sort_by(.Name) | group_by(.Name) | map({
        name: .[0].Name,
        sampleCount: length,
        cpuPercent: {
          max: (map(.CPUPerc | percent) | max),
          average: ((map(.CPUPerc | percent) | add) / length)
        },
        memoryPercent: {
          max: (map(.MemPerc | percent) | max),
          average: ((map(.MemPerc | percent) | add) / length)
        },
        pids: {
          max: (map(.PIDs | tonumber) | max),
          average: ((map(.PIDs | tonumber) | add) / length)
        },
        final: {
          cpu: .[-1].CPUPerc,
          memory: .[-1].MemUsage,
          memoryPercent: .[-1].MemPerc,
          networkIo: .[-1].NetIO,
          blockIo: .[-1].BlockIO,
          pids: .[-1].PIDs
        }
      })
    )
  }
' "$RECEIPT_DIR/logs/docker-stats.ndjson" >"$RECEIPT_DIR/resource-summary.json"
assert_json "resource sampling did not cover every container" '
  .sampleTimes >= 2 and
  (.containers | length) == 12 and
  all(.containers[];
    .sampleCount >= 2 and
    (.cpuPercent.max | type == "number") and
    (.memoryPercent.max | type == "number") and
    (.pids.max | type == "number") and
    .pids.max >= 1)
' "$RECEIPT_DIR/resource-summary.json"

CONTROL_NODE_CONTAINER_ID=$(docker inspect --format '{{.Id}}' "$CONTROL_NODE_CONTAINER")
GATEWAY_CONTAINER_ID=$(docker inspect --format '{{.Id}}' "$GATEWAY_CONTAINER")
jq -n \
  --arg controlName "$CONTROL_NODE_CONTAINER" \
  --arg controlId "$CONTROL_NODE_CONTAINER_ID" \
  --arg gatewayName "$GATEWAY_CONTAINER" \
  --arg gatewayId "$GATEWAY_CONTAINER_ID" \
  --arg network "$NETWORK_NAME" \
  --arg image "$IMAGE_ID" \
  --arg dashboard "$DASHBOARD_URL" \
  --arg endpoint "$CONTROL_NODE_ENDPOINT_ID" \
  --arg ticketDigest "$CONTROL_NODE_TICKET_SHA256" \
  --argjson runtimeNodes "$(printf '%s\n' "${RUNTIME_NODE_CONTAINERS[@]}" | jq -Rsc 'split("\n")[:-1]')" '
    {
      applicationContainerCount: 12,
      controlNodeContainerCount: 1,
      accessGatewayContainerCount: 1,
      runtimeNodeContainerCount: 10,
      sessionsPerRuntimeNode: 10,
      totalMockSessions: 100,
      sharedImageId: $image,
      network: { name: $network, driver: "bridge", isolatedDuringTest: true },
      controlNode: {
        name: $controlName,
        id: $controlId,
        role: "canonical durable metadata authority",
        trustedLocalHttpPublished: false
      },
      accessGateway: {
        name: $gatewayName,
        id: $gatewayId,
        role: "zero-authority authenticated HTTP/WebSocket edge",
        publishedDashboard: $dashboard
      },
      runtimeNodes: ($runtimeNodes | map({
        name: ., role: "runtime node + deterministic in-process mock adapter",
        mockSessions: 10, publishedPorts: []
      })),
      transport: {
        protocol: "p2prpc v1 over Iroh",
        controlNodeEndpointId: $endpoint,
        ticketRecorded: false,
        ticketSha256: $ticketDigest
      },
      realAgentProcesses: 0,
      realInferenceRequests: 0,
      browserRunsOnDockerHost: true
    }
  ' >"$RECEIPT_DIR/topology.json"

NODE_VERSION=$(docker exec "$CONTROL_NODE_CONTAINER" node --version | tr -d '\r\n')
DOCKER_VERSION=$(docker version --format '{{.Server.Version}}')
IFS=$'\t' read -r P2PRPC_VERSION P2PRPC_INTEGRITY < <(
  node -e '
    const lock = require(process.argv[1]);
    const dependency = lock.packages?.["node_modules/@arduano/p2prpc-core"];
    if (!dependency?.version || !dependency?.integrity) process.exit(1);
    process.stdout.write(`${dependency.version}\t${dependency.integrity}\n`);
  ' "$REPO_ROOT/package-lock.json"
)
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

RUN_COMPLETED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
jq -n \
  --arg runId "$RUN_ID" \
  --arg startedAt "$RUN_STARTED_AT" \
  --arg completedAt "$RUN_COMPLETED_AT" \
  --arg docker "$DOCKER_VERSION" \
  --arg node "$NODE_VERSION" \
  --arg image "$IMAGE_ID" \
  --arg sourceDigest "$SOURCE_DIGEST" \
  --arg p2prpcVersion "$P2PRPC_VERSION" \
  --arg p2prpcIntegrity "$P2PRPC_INTEGRITY" \
  --argjson chunks "$CHUNK_COUNT" \
  --argjson intervalMs "$CHUNK_INTERVAL_MS" \
  --argjson soakMs "$SOAK_MS" '
    {
      runId: $runId,
      status: "passed",
      workloadType: "deterministic mock capacity/integration acceptance",
      startedAt: $startedAt,
      completedAt: $completedAt,
      versions: {
        dockerServer: $docker,
        nodeInImage: $node,
        multiplexProtocol: 4,
        p2prpcVersion: $p2prpcVersion,
        p2prpcIntegrity: $p2prpcIntegrity
      },
      topology: {
        controlNodeContainers: 1,
        accessGatewayContainers: 1,
        runtimeNodeContainers: 10,
        sessionsPerRuntimeNode: 10,
        sessionsTotal: 100
      },
      streamConfiguration: {
        chunksPerSession: $chunks,
        chunkIntervalMs: $intervalMs
      },
      soakMs: $soakMs,
      imageId: $image,
      sourceTreeSha256: $sourceDigest,
      realAgentProcesses: 0,
      realInferenceRequests: 0,
      credentialMaterialRecorded: false
    }
  ' >"$RECEIPT_DIR/manifest.json"

jq -n \
  --slurpfile driver "$RECEIPT_DIR/driver-summary.json" \
  --slurpfile resources "$RECEIPT_DIR/resource-summary.json" \
  --slurpfile topology "$RECEIPT_DIR/topology.json" \
  --slurpfile lifecycle "$RECEIPT_DIR/container-lifecycle.json" \
  --slurpfile dashboard "$RECEIPT_DIR/rpc/playwright-dashboard.json" \
  --slurpfile system "$RECEIPT_DIR/rpc/system-description.json" \
  --slurpfile sources "$RECEIPT_DIR/rpc/sources-initial.json" \
  --slurpfile controls "$RECEIPT_DIR/rpc/control-nodes-initial.json" \
  --slurpfile auth "$RECEIPT_DIR/rpc/auth-boundary.json" \
  --slurpfile disconnect "$RECEIPT_DIR/coord/disconnect-complete.json" \
  --slurpfile sessions "$RECEIPT_DIR/rpc/sessions-final.json" '
    ($sessions[0] | group_by(.runtimeNodeId)) as $sessionGroups |
    {
      topology: {
        exactlyOneCanonicalControlNodeContainer: ($topology[0].controlNodeContainerCount == 1),
        exactlyOneZeroAuthorityAccessGatewayContainer: ($topology[0].accessGatewayContainerCount == 1),
        exactlyTenRuntimeNodeContainers: ($topology[0].runtimeNodeContainerCount == 10),
        exactlyTenSessionsPerRuntimeNode: (
          ($sessionGroups | length) == 10 and
          ($sessionGroups | all(.[]; length == 10))
        ),
        exactlyOneHundredSessions: ($sessions[0] | length == 100),
        runtimeNodesPublishNoPorts: (
          $topology[0].runtimeNodes | length == 10 and all(.[]; .publishedPorts == [])
        ),
        sharedImmutableImage: (
          $lifecycle[0] | length == 12 and (map(.image) | unique | length) == 1
        ),
        gatewayHasNoDataAuthority: (
          $system[0].protocolVersion == 4 and
          $system[0].componentKind == "access-gateway" and
          $system[0].dataAuthority == "none"
        ),
        exactlyOneSelectedCanonicalSource: (
          ($sources[0] | length) == 1 and
          $sources[0][0].sourceId == "canonical" and
          $sources[0][0].state == "selected" and
          ($sources[0][0].manifest.coveredControlNodeIds | length) == 1
        ),
        controlNodeIsCanonicalAuthority: (
          ($controls[0] | length) == 1 and
          $controls[0][0].dataRole.role == "authority" and
          $controls[0][0].protocolVersion == 4
        ),
        unauthenticatedGatewayRpcRejected: ($auth[0].unauthenticatedRejected == true)
      },
      commands: {
        spawnSucceeded: $driver[0].commands.spawnSucceeded,
        sendSucceeded: $driver[0].commands.sendSucceeded
      },
      nativeStreaming: {
        completedTurns: $driver[0].streaming.completedTurns,
        nativeEvents: $driver[0].streaming.nativeEvents,
        exactDeltaReassemblies: $driver[0].streaming.exactDeltaReassemblies,
        contiguousSequenceSessions: $driver[0].streaming.contiguousPerSessionSequences,
        allOneHundredTurnsOverlapped: $driver[0].streaming.allOneHundredTurnsOverlapped,
        fullFleetOverlapMs: $driver[0].streaming.fullFleetOverlapMs,
        nativeGaps: $driver[0].streaming.nativeGaps,
        duplicateEvents: $driver[0].streaming.duplicateEvents
      },
      faultInjection: {
        clientWebSocketReconnectRecoveredByCursor: (
          $driver[0].reconnect.clientCursorReplayDeduplicated == true and
          $driver[0].reconnect.clientWebSocketOpenCount >= 2 and
          $driver[0].reconnect.clientWebSocketCloseCount >= 1
        ),
        isolatedRuntimeNodeStayedRunning: ($disconnect[0].containerStayedRunning == true),
        isolatedRuntimeNodeRejoinedNetwork: (
          $disconnect[0].absentDuringDisconnect == true and
          $disconnect[0].presentAfterReconnect == true
        ),
        runtimeNodeEventsReplayedWithoutGapOrDuplicate: (
          $driver[0].reconnect.runtimeNodeStreamReplayedWithoutGap == true and
          $driver[0].streaming.nativeGaps == 0 and
          $driver[0].streaming.duplicateEvents == 0
        )
      },
      metadata: {
        spawnMetadataVerifiedForAllSessions: (
          $driver[0].metadata.spawnMetadataVerified == 100
        ),
        threeClientCasRoundsForAllSessions: (
          $driver[0].metadata.clientCasSessions == 100 and
          $driver[0].metadata.successfulCasRounds == 3
        ),
        staleCasRejectedWithoutMutation: (
          $driver[0].metadata.staleCasRejectedWithoutMutation == true
        )
      },
      stability: {
        allRuntimeNodesOnlineThroughoutSoak: ($driver[0].stability.allRuntimeNodesOnline == true),
        allSessionsActiveAndIdleThroughoutSoak: (
          $driver[0].stability.allSessionsActiveAndIdle == true
        ),
        noContainerRestarted: (
          $lifecycle[0] | length == 12 and all(.[]; .restartCount == 0)
        ),
        noContainerOomKilled: (
          $lifecycle[0] | length == 12 and all(.[]; .oomKilled == false)
        ),
        resourceSampleRows: $resources[0].sampleRows,
        resourceSampleTimes: $resources[0].sampleTimes
      },
      dashboard: {
        runtimeNodeCards: $dashboard[0].visible.runtimeNodeCardCount,
        sessionCards: $dashboard[0].visible.sessionCardCount,
        fleetPinnedAndReachable: $dashboard[0].assertions.fleetPinnedAndReachable,
        sessionAndFleetScrollIndependently: $dashboard[0].assertions.sessionAndFleetScrollIndependently,
        stableSessionRowHeight: $dashboard[0].assertions.stableSessionRowHeight,
        searchAndSelectionResponsive: $dashboard[0].assertions.searchAndSelectionRespondWithinOneSecond,
        conversationRemainsAvailable: $dashboard[0].assertions.conversationRemainsAvailable,
        noDocumentOverflow: $dashboard[0].assertions.noDocumentOverflow,
        noSeriousOrCriticalAccessibilityViolations: $dashboard[0].assertions.noSeriousOrCriticalAccessibilityViolations,
        screenshotCaptured: (
          ($dashboard[0].screenshotPath | type) == "string" and
          ($dashboard[0].screenshotPath | length) > 0
        ),
        browserConsoleErrors: $dashboard[0].assertions.browserConsoleErrors
      },
      limitations: {
        mockWorkloadOnly: true,
        realAppServerProcessCostMeasured: false,
        realInferenceLatencyMeasured: false
      }
    } as $body |
    {
      passed: (
        ($body.topology | all(.[]; . == true)) and
        $body.commands.spawnSucceeded == 100 and
        $body.commands.sendSucceeded == 100 and
        $body.nativeStreaming.completedTurns == 100 and
        $body.nativeStreaming.nativeEvents == $driver[0].streaming.expectedNativeEvents and
        $body.nativeStreaming.exactDeltaReassemblies == 100 and
        $body.nativeStreaming.contiguousSequenceSessions == 100 and
        $body.nativeStreaming.allOneHundredTurnsOverlapped == true and
        $body.nativeStreaming.fullFleetOverlapMs >= 0 and
        $body.nativeStreaming.nativeGaps == 0 and
        $body.nativeStreaming.duplicateEvents == 0 and
        ($body.faultInjection | all(.[]; . == true)) and
        ($body.metadata | all(.[]; . == true)) and
        $body.stability.allRuntimeNodesOnlineThroughoutSoak == true and
        $body.stability.allSessionsActiveAndIdleThroughoutSoak == true and
        $body.stability.noContainerRestarted == true and
        $body.stability.noContainerOomKilled == true and
        $body.stability.resourceSampleRows >= 24 and
        $body.stability.resourceSampleTimes >= 2 and
        $body.dashboard.runtimeNodeCards == 10 and
        $body.dashboard.sessionCards == 100 and
        $body.dashboard.fleetPinnedAndReachable == true and
        $body.dashboard.sessionAndFleetScrollIndependently == true and
        $body.dashboard.stableSessionRowHeight == true and
        $body.dashboard.searchAndSelectionResponsive == true and
        $body.dashboard.conversationRemainsAvailable == true and
        $body.dashboard.noDocumentOverflow == true and
        $body.dashboard.noSeriousOrCriticalAccessibilityViolations == true and
        $body.dashboard.screenshotCaptured == true and
        $body.dashboard.browserConsoleErrors == 0
      )
    } + $body
  ' >"$RECEIPT_DIR/checks.json"
assert_json "derived receipt checks did not pass" '.passed == true' \
  "$RECEIPT_DIR/checks.json"

{
  printf '# Protocol-v4 100-session mock Docker scale receipt\n\n'
  printf 'Status: **PASS**\n\n'
  printf 'Run: `%s`\n\n' "$RUN_ID"
  printf 'This run used 12 application containers: one hidden canonical control node, one authenticated zero-authority access gateway, and 10 isolated runtime nodes. Each runtime node owned 10 active Codex-shaped mock sessions, for exactly 100 sessions. No real agent process, model-provider credential, model inference, or external model-provider API request was used.\n\n'
  printf '## What passed\n\n'
  printf -- '- All 100 durable launches succeeded under a 32-launch concurrency limit; all 100 send commands succeeded and their turns overlapped.\n'
  printf -- '- Every native stream had the exact configured event count, type order, runtime epoch, and sequence `0..N`; every delta stream reconstructed the expected output byte-for-byte.\n'
  printf -- '- There were zero native gaps and zero duplicate deliveries across all 100 turns.\n'
  printf -- '- The access-watch test client recovered through its committed cursor without duplicates after its WebSocket was deliberately terminated.\n'
  printf -- '- One runtime node was removed from the Docker network during native output, remained alive, rejoined, and replayed its event ring without gaps or duplicates.\n'
  printf -- '- Spawn metadata and three compare-and-set metadata rounds converged for all 100 sessions; a deliberately stale CAS was rejected without mutation.\n'
  printf -- '- All runtime nodes remained online and all sessions remained active/idle during the soak. No container restarted or was OOM-killed.\n'
  printf -- '- The authenticated reference dashboard rendered exactly 10 online runtime nodes and 100 active/idle session cards. Fleet stayed pinned and independently scrollable, rows stayed fixed-height, search and selection remained responsive, the conversation stayed usable, and there were no browser errors, horizontal overflow, or serious/critical axe findings.\n\n'
  printf '## Interpretation\n\n'
  printf 'This is strong evidence that the control-node catalog, authenticated gateway projection, p2prpc fan-in, runtime-node event rings, client cursors, metadata concurrency, and reference web surface reliably handle this deterministic 100-session workload on the recorded machine. It is not proof that 100 real Codex/Copilot app-server processes fit the same resource envelope: model subprocess memory, terminal workloads, network variability, and provider latency are deliberately absent.\n\n'
  printf '## Primary evidence\n\n'
  printf -- '- `checks.json`, `manifest.json`, and `topology.json`\n'
  printf -- '- `driver-summary.json` and `phases/stream-assertions.json`\n'
  printf -- '- `logs/fleet-events.ndjson` and `logs/client-states.ndjson`\n'
  printf -- '- `coord/disconnect-request.json` and `coord/disconnect-complete.json`\n'
  printf -- '- `rpc/metadata-initial.json`, `rpc/metadata-conflict.json`, and `logs/metadata-rounds.ndjson`\n'
  printf -- '- `resource-summary.json`, `logs/docker-stats.ndjson`, and `container-lifecycle.json`\n'
  printf -- '- `screenshots/dashboard-100-agents.png` and `rpc/playwright-dashboard.json`\n'
  printf -- '- Sanitized `logs/control-node.log`, `logs/access-gateway.log`, and per-runtime-node logs\n'
} >"$RECEIPT_DIR/README.md"

for forbidden in "$SHARED_SECRET" "$ACCESS_TOKEN" "$CONTROL_NODE_TICKET"; do
  if [[ -n "$forbidden" ]] && rg --text --fixed-strings --quiet -- "$forbidden" "$RECEIPT_DIR"; then
    fail "transport credential/locator leaked into the receipt directory"
  fi
done

note "removing all scale containers and the isolated network"
remove_test_topology
REMOVED_CONTAINERS=true
for container in "${ALL_CONTAINERS[@]}"; do
  if docker container inspect "$container" >/dev/null 2>&1; then
    REMOVED_CONTAINERS=false
  fi
done
NETWORK_REMOVED=true
if docker network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
  NETWORK_REMOVED=false
fi
jq -n \
  --argjson containersRemoved "$REMOVED_CONTAINERS" \
  --argjson networkRemoved "$NETWORK_REMOVED" \
  --arg containerTargetPrefix "agent-multiplex-scale-" \
  --arg networkTarget "$NETWORK_NAME" '
    {
      cleanupCompleted: ($containersRemoved and $networkRemoved),
      exactContainerTargetsRemoved: $containersRemoved,
      isolatedNetworkRemoved: $networkRemoved,
      containerTargetPrefix: $containerTargetPrefix,
      networkTarget: $networkTarget,
      recoverable: false,
      materialUserDataRemoved: false
    }
  ' >"$RECEIPT_DIR/cleanup.json"
assert_json "scale topology cleanup was incomplete" \
  '.cleanupCompleted == true' "$RECEIPT_DIR/cleanup.json"

(
  cd "$RECEIPT_DIR"
  find . -type f ! -name SHA256SUMS -print0 \
    | sort -z \
    | xargs -0 sha256sum \
    >SHA256SUMS
  sha256sum --check SHA256SUMS >/dev/null
)

COMPLETED=1
