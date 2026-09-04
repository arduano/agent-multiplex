#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/../.." && pwd)
DOCKER_NPMRC=${AGENT_MULTIPLEX_DOCKER_NPMRC:-}
RECEIPT_ROOT=${AGENT_MULTIPLEX_TREE_RECEIPT_ROOT:-"$REPO_ROOT/receipts/protocol-v4-control-tree"}
TIMEOUT_MS=${AGENT_MULTIPLEX_TREE_TIMEOUT_MS:-180000}
CHUNK_COUNT=${AGENT_MULTIPLEX_TREE_CHUNK_COUNT:-12}

for value_name in TIMEOUT_MS CHUNK_COUNT; do
  value=${!value_name}
  if [[ ! "$value" =~ ^[0-9]+$ ]] || (( value < 1 )); then
    echo "protocol-v4 tree acceptance: $value_name must be a positive integer" >&2
    exit 1
  fi
done
for tool in docker jq node npm curl sha256sum awk sed perl rg timeout; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "protocol-v4 tree acceptance: required tool '$tool' is unavailable" >&2
    exit 1
  fi
done
if [[ -z "$DOCKER_NPMRC" ]]; then
  DOCKER_NPMRC=$(npm config get userconfig)
fi
if [[ ! -f "$DOCKER_NPMRC" || ! -r "$DOCKER_NPMRC" ]]; then
  echo "protocol-v4 tree acceptance: a readable npm user config is required for the GitHub Packages build secret" >&2
  exit 1
fi

random_hex() {
  node -e 'process.stdout.write(require("node:crypto").randomBytes(6).toString("hex"))'
}

RUN_ID=${AGENT_MULTIPLEX_TREE_RUN_ID:-"$(date -u +%Y%m%dT%H%M%SZ)-$(random_hex)"}
if [[ ! "$RUN_ID" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "protocol-v4 tree acceptance: invalid run id" >&2
  exit 1
fi
RECEIPT_DIR="$RECEIPT_ROOT/$RUN_ID"
if [[ -e "$RECEIPT_DIR" ]]; then
  echo "protocol-v4 tree acceptance: receipt already exists: $RECEIPT_DIR" >&2
  exit 1
fi
mkdir -p "$RECEIPT_DIR/logs" "$RECEIPT_DIR/rpc" "$RECEIPT_DIR/phases" \
  "$RECEIPT_DIR/coord" "$RECEIPT_DIR/screenshots"

RUNTIME_DIR=$(mktemp -d "${TMPDIR:-/tmp}/agent-multiplex-v4-tree.XXXXXXXX")
mkdir -p "$RUNTIME_DIR/authority-state" "$RUNTIME_DIR/branch-state"
NAME_SUFFIX=$(printf '%s' "$RUN_ID" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9' | tail -c 22)
AUTHORITY_CONTAINER="multiplex-v4-authority-$NAME_SUFFIX"
BRANCH_CONTAINER="multiplex-v4-branch-$NAME_SUFFIX"
RUNTIME_CONTAINER="multiplex-v4-runtime-$NAME_SUFFIX"
GATEWAY_CONTAINER="multiplex-v4-gateway-$NAME_SUFFIX"
NETWORK_NAME="multiplex-v4-tree-$NAME_SUFFIX"
IMAGE_TAG="agent-multiplex-v4-tree:$NAME_SUFFIX"
RUNTIME_NODE_NAME="tree-runtime-$NAME_SUFFIX"
SHARED_SECRET=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(48).toString("base64url"))')
ACCESS_TOKEN=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(48).toString("base64url"))')
printf '%s\n' "$ACCESS_TOKEN" >"$RUNTIME_DIR/access-token"

declare -a CONTAINERS=()
NETWORK_CREATED=0
IMAGE_BUILT=0
DRIVER_PID=""
COMPLETED=0
AUTHORITY_TICKET=""
BRANCH_TICKET=""

note() { printf '[protocol-v4-tree] %s\n' "$*" >&2; }
fail() { note "FAILED: $*"; return 1; }

redact_stream() {
  AM_TREE_SHARED="$SHARED_SECRET" \
  AM_TREE_ACCESS="$ACCESS_TOKEN" \
  AM_TREE_AUTHORITY_TICKET="$AUTHORITY_TICKET" \
  AM_TREE_BRANCH_TICKET="$BRANCH_TICKET" \
    perl -0pe '
      BEGIN {
        @values = (
          [$ENV{AM_TREE_SHARED} // "", "<redacted-shared-secret>"],
          [$ENV{AM_TREE_ACCESS} // "", "<redacted-access-token>"],
          [$ENV{AM_TREE_AUTHORITY_TICKET} // "", "<redacted-authority-ticket>"],
          [$ENV{AM_TREE_BRANCH_TICKET} // "", "<redacted-branch-ticket>"],
        );
      }
      for $pair (@values) {
        ($value, $replacement) = @$pair;
        s/\Q$value\E/$replacement/g if length($value);
      }
      s/p2prpc3\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{80,}/<redacted-p2p-ticket>/g;
    '
}

capture_logs() {
  local container label raw
  for entry in \
    "$AUTHORITY_CONTAINER:authority-control-node" \
    "$BRANCH_CONTAINER:branch-control-node" \
    "$RUNTIME_CONTAINER:runtime-node" \
    "$GATEWAY_CONTAINER:access-gateway"; do
    container=${entry%%:*}
    label=${entry#*:}
    if docker inspect "$container" >/dev/null 2>&1; then
      raw="$RUNTIME_DIR/$label.raw.log"
      docker logs "$container" >"$raw" 2>&1 || true
      awk '
        redact_next { print "<redacted-p2p-ticket>"; redact_next = 0; next }
        /^P2P ticket \(/ { print; redact_next = 1; next }
        { print }
      ' "$raw" | redact_stream >"$RECEIPT_DIR/logs/$label.log"
    fi
  done
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  if [[ -n "$DRIVER_PID" ]] && kill -0 "$DRIVER_PID" 2>/dev/null; then
    kill "$DRIVER_PID" 2>/dev/null
    for _ in $(seq 1 20); do
      kill -0 "$DRIVER_PID" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$DRIVER_PID" 2>/dev/null; then
      kill -KILL "$DRIVER_PID" 2>/dev/null
    fi
    wait "$DRIVER_PID" 2>/dev/null
  fi
  capture_logs
  for container in "${CONTAINERS[@]}"; do
    docker rm --force "$container" >/dev/null 2>&1 || true
  done
  if (( NETWORK_CREATED == 1 )); then docker network rm "$NETWORK_NAME" >/dev/null 2>&1 || true; fi
  if (( IMAGE_BUILT == 1 )) && [[ ${AGENT_MULTIPLEX_TREE_KEEP_IMAGE:-0} != 1 ]]; then
    docker image rm "$IMAGE_TAG" >/dev/null 2>&1 || true
  fi
  if [[ -d "$RUNTIME_DIR" && "$(basename -- "$RUNTIME_DIR")" == agent-multiplex-v4-tree.* ]]; then
    rm -rf -- "$RUNTIME_DIR"
  fi
  if (( COMPLETED == 0 )); then
    printf 'Protocol-v4 tree acceptance failed. Inspect driver-failure.json and logs/.\n' \
      >"$RECEIPT_DIR/FAILED.txt"
  fi
  if (( status == 0 && COMPLETED == 1 )); then
    note "PASS: receipts saved to $RECEIPT_DIR"
  else
    note "partial receipts saved to $RECEIPT_DIR"
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

wait_for_log() {
  local container=$1 pattern=$2 description=$3 attempt logs
  for attempt in $(seq 1 120); do
    if [[ $(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null) != true ]]; then
      docker logs "$container" 2>&1 | redact_stream >&2 || true
      fail "$description container exited"
      return
    fi
    logs=$(docker logs "$container" 2>&1 || true)
    if rg --quiet "$pattern" <<<"$logs"; then return; fi
    if (( attempt % 20 == 0 )); then note "waiting for $description (${attempt}s)"; fi
    sleep 1
  done
  fail "timed out waiting for $description"
}

control_identity() {
  docker logs "$1" 2>&1 | sed -n 's/^Control node ID:[[:space:]]*//p' | tail -n 1
}

control_endpoint() {
  docker logs "$1" 2>&1 | sed -n 's/^P2P endpoint:[[:space:]]*//p' | tail -n 1
}

control_ticket() {
  docker logs "$1" 2>&1 | awk '
    capture { ticket = $0; capture = 0 }
    /^P2P ticket \(/ { capture = 1 }
    END { if (ticket != "") print ticket }
  '
}

wait_for_file() {
  local filename=$1 description=$2 attempt
  for attempt in $(seq 1 $(( TIMEOUT_MS / 100 + 1 ))); do
    [[ -s "$filename" ]] && return
    if [[ -n "$DRIVER_PID" ]] && ! kill -0 "$DRIVER_PID" 2>/dev/null; then
      wait "$DRIVER_PID" || true
      DRIVER_PID=""
      fail "driver exited while waiting for $description"
      return
    fi
    sleep 0.1
  done
  fail "timed out waiting for $description"
}

note "building immutable protocol-v4 image"
if ! docker build --progress=plain \
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

note "starting durable authority control node"
docker run --detach \
  --name "$AUTHORITY_CONTAINER" --hostname authority-control --network "$NETWORK_NAME" \
  --init --user 1000:100 --read-only --cap-drop ALL --security-opt no-new-privileges \
  --mount type=bind,src="$RUNTIME_DIR/authority-state",dst=/state \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777 \
  --env AGENT_MULTIPLEX_SHARED_SECRET="$SHARED_SECRET" \
  --env AGENT_MULTIPLEX_CONTROL_NODE_NAME=tree-authority \
  --env AGENT_MULTIPLEX_CONTROL_NODE_STATE=/state/control-node.sqlite \
  --env AGENT_MULTIPLEX_CONTROL_NODE_IDENTITY=/state/control-node.identity \
  --env AGENT_MULTIPLEX_CONTROL_NODE_HTTP_BIND=127.0.0.1 \
  --env AGENT_MULTIPLEX_CONTROL_NODE_P2P_BIND=0.0.0.0:49117 \
  --env AGENT_MULTIPLEX_CONTROL_NODE_ALLOW_CHILD_CONTROL_NODE_ENROLLMENT=1 \
  --env AGENT_MULTIPLEX_CONTROL_NODE_ALLOW_ACCESS_GATEWAY_ENROLLMENT=1 \
  --env 'AGENT_MULTIPLEX_CONTROL_NODE_ACCESS_GATEWAY_SCOPES=["read","agent-control","agent-launch","metadata-propose"]' \
  --env AGENT_MULTIPLEX_CONTROL_NODE_CHILD_STALE_MS=5000 \
  --env AGENT_MULTIPLEX_CONTROL_NODE_RECONNECT_MAX_MS=1000 \
  "$IMAGE_TAG" node apps/control-node/dist/main.js >/dev/null
CONTAINERS+=("$AUTHORITY_CONTAINER")
wait_for_log "$AUTHORITY_CONTAINER" '^P2P ticket \(' 'authority startup'
AUTHORITY_ID=$(control_identity "$AUTHORITY_CONTAINER")
AUTHORITY_ENDPOINT=$(control_endpoint "$AUTHORITY_CONTAINER")
AUTHORITY_TICKET=$(control_ticket "$AUTHORITY_CONTAINER")
if [[ -z "$AUTHORITY_ID" || ! "$AUTHORITY_ENDPOINT" =~ ^[a-z2-7]{52}$ || ${#AUTHORITY_TICKET} -lt 20 ]]; then
  fail "authority emitted invalid identity material"
fi

note "starting attached branch control node"
docker run --detach \
  --name "$BRANCH_CONTAINER" --hostname branch-control --network "$NETWORK_NAME" \
  --init --user 1000:100 --read-only --cap-drop ALL --security-opt no-new-privileges \
  --mount type=bind,src="$RUNTIME_DIR/branch-state",dst=/state \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777 \
  --env AGENT_MULTIPLEX_SHARED_SECRET="$SHARED_SECRET" \
  --env AGENT_MULTIPLEX_CONTROL_NODE_NAME=tree-branch \
  --env AGENT_MULTIPLEX_CONTROL_NODE_STATE=/state/control-node.sqlite \
  --env AGENT_MULTIPLEX_CONTROL_NODE_IDENTITY=/state/control-node.identity \
  --env AGENT_MULTIPLEX_CONTROL_NODE_HTTP_BIND=127.0.0.1 \
  --env AGENT_MULTIPLEX_CONTROL_NODE_P2P_BIND=0.0.0.0:49117 \
  --env AGENT_MULTIPLEX_CONTROL_NODE_UPSTREAM_ID="$AUTHORITY_ID" \
  --env AGENT_MULTIPLEX_CONTROL_NODE_UPSTREAM_ENDPOINT_ID="$AUTHORITY_ENDPOINT" \
  --env AGENT_MULTIPLEX_CONTROL_NODE_UPSTREAM_TICKET="$AUTHORITY_TICKET" \
  --env AGENT_MULTIPLEX_CONTROL_NODE_ALLOW_RUNTIME_NODE_ENROLLMENT=1 \
  --env AGENT_MULTIPLEX_CONTROL_NODE_ALLOW_ACCESS_GATEWAY_ENROLLMENT=1 \
  --env 'AGENT_MULTIPLEX_CONTROL_NODE_ACCESS_GATEWAY_SCOPES=["read","agent-control","agent-launch","metadata-propose"]' \
  --env AGENT_MULTIPLEX_CONTROL_NODE_UPSTREAM_HEARTBEAT_MS=500 \
  --env AGENT_MULTIPLEX_CONTROL_NODE_RECONNECT_MAX_MS=1000 \
  "$IMAGE_TAG" node apps/control-node/dist/main.js >/dev/null
CONTAINERS+=("$BRANCH_CONTAINER")
wait_for_log "$BRANCH_CONTAINER" '^P2P ticket \(' 'branch startup'
wait_for_log "$BRANCH_CONTAINER" '^Attached to upstream control node ' 'branch attachment'
BRANCH_ID=$(control_identity "$BRANCH_CONTAINER")
BRANCH_ENDPOINT=$(control_endpoint "$BRANCH_CONTAINER")
BRANCH_TICKET=$(control_ticket "$BRANCH_CONTAINER")
if [[ -z "$BRANCH_ID" || ! "$BRANCH_ENDPOINT" =~ ^[a-z2-7]{52}$ || ${#BRANCH_TICKET} -lt 20 ]]; then
  fail "branch emitted invalid identity material"
fi

note "starting branch-owned mock runtime node"
docker run --detach \
  --name "$RUNTIME_CONTAINER" --hostname tree-runtime --network "$NETWORK_NAME" \
  --init --user 1000:100 --read-only --cap-drop ALL --security-opt no-new-privileges \
  --tmpfs /state:rw,nosuid,nodev,mode=0700,uid=1000,gid=100 \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777 \
  --env AGENT_MULTIPLEX_SHARED_SECRET="$SHARED_SECRET" \
  --env AGENT_MULTIPLEX_CONTROL_NODE_ENDPOINT_ID="$BRANCH_ENDPOINT" \
  --env AGENT_MULTIPLEX_CONTROL_NODE_TICKET="$BRANCH_TICKET" \
  --env 'AGENT_MULTIPLEX_RUNTIME_NODE_ALLOWED_ROOTS=["/workspace"]' \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_STATE_DIR=/state/runtime-node \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_NAME="$RUNTIME_NODE_NAME" \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_HARNESSES=codex \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_ADAPTER_MODE=mock \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_MOCK_CHUNK_COUNT="$CHUNK_COUNT" \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_MOCK_STREAM_INTERVAL_MS=20 \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_HEARTBEAT_MS=500 \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_INVENTORY_REFRESH_MS=1000 \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_METADATA_FLUSH_MS=250 \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_RECONNECT_MAX_MS=1000 \
  "$IMAGE_TAG" node apps/runtime-node/dist/main.js >/dev/null
CONTAINERS+=("$RUNTIME_CONTAINER")
wait_for_log "$RUNTIME_CONTAINER" '^Connected to control node ' 'runtime attachment'

GATEWAY_SOURCES=$(jq -cn \
  --arg authorityEndpoint "$AUTHORITY_ENDPOINT" --arg authorityTicket "$AUTHORITY_TICKET" \
  --arg branchEndpoint "$BRANCH_ENDPOINT" --arg branchTicket "$BRANCH_TICKET" '
  {
    version: 1,
    sources: [
      {
        sourceId: "authority", displayName: "Tree authority",
        endpointId: $authorityEndpoint,
        locator: {kind: "ticket", ticket: $authorityTicket},
        priority: 100, enabled: true,
        requestedScopes: ["read", "agent-control", "agent-launch", "metadata-propose"]
      },
      {
        sourceId: "branch", displayName: "Tree branch warm standby",
        endpointId: $branchEndpoint,
        locator: {kind: "ticket", ticket: $branchTicket},
        priority: 50, enabled: true,
        requestedScopes: ["read", "agent-control", "agent-launch", "metadata-propose"]
      }
    ]
  }')

note "starting zero-authority gateway with overlapping sources"
docker run --detach \
  --name "$GATEWAY_CONTAINER" --hostname tree-gateway --network "$NETWORK_NAME" \
  --init --user 1000:100 --read-only --cap-drop ALL --security-opt no-new-privileges \
  --tmpfs /state:rw,nosuid,nodev,mode=0700,uid=1000,gid=100 \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777 \
  --mount type=bind,src="$RUNTIME_DIR/access-token",dst=/run/access-token,readonly \
  --publish 127.0.0.1::4318 \
  --env AGENT_MULTIPLEX_SHARED_SECRET="$SHARED_SECRET" \
  --env AGENT_MULTIPLEX_ACCESS_GATEWAY_STATE=/state/access-gateway.sqlite \
  --env AGENT_MULTIPLEX_ACCESS_GATEWAY_IDENTITY=/state/access-gateway.identity \
  --env AGENT_MULTIPLEX_ACCESS_GATEWAY_SOURCES="$GATEWAY_SOURCES" \
  --env AGENT_MULTIPLEX_ACCESS_GATEWAY_HTTP_BIND=0.0.0.0 \
  --env AGENT_MULTIPLEX_ACCESS_GATEWAY_HTTP_PORT=4318 \
  --env AGENT_MULTIPLEX_ACCESS_GATEWAY_BEARER_TOKEN_FILE=/run/access-token \
  --env 'AGENT_MULTIPLEX_ACCESS_GATEWAY_SCOPES=["read","agent-control","agent-launch","metadata-propose"]' \
  --env AGENT_MULTIPLEX_ACCESS_GATEWAY_AUTH_SUBJECT=tree-acceptance \
  --env AGENT_MULTIPLEX_ACCESS_GATEWAY_RECONNECT_MAX_MS=1000 \
  "$IMAGE_TAG" node apps/gateway/dist/main.js >/dev/null
CONTAINERS+=("$GATEWAY_CONTAINER")
wait_for_log "$GATEWAY_CONTAINER" '^Dashboard:' 'gateway startup'
PORT_MAPPING=$(docker port "$GATEWAY_CONTAINER" 4318/tcp | tail -n 1)
GATEWAY_PORT=${PORT_MAPPING##*:}
GATEWAY_URL="http://127.0.0.1:$GATEWAY_PORT/"
TRPC_URL="http://127.0.0.1:$GATEWAY_PORT/trpc"
for attempt in $(seq 1 60); do
  curl --fail --silent "$GATEWAY_URL" >/dev/null && break
  (( attempt == 60 )) && fail "gateway dashboard did not become reachable"
  sleep 1
done

UNAUTHENTICATED_STATUS=$(curl --silent --output /dev/null --write-out '%{http_code}' \
  "$TRPC_URL/system.describe")
[[ "$UNAUTHENTICATED_STATUS" == 401 ]] || fail "gateway accepted unauthenticated tRPC (HTTP $UNAUTHENTICATED_STATUS)"
jq -n --argjson status "$UNAUTHENTICATED_STATUS" \
  '{unauthenticatedStatus:$status,rejected:($status==401),tokenRecorded:false}' \
  >"$RECEIPT_DIR/rpc/auth-boundary.json"

note "running topology, routing, failover, and metadata convergence driver"
AGENT_MULTIPLEX_ACCEPTANCE_BEARER_TOKEN_FILE="$RUNTIME_DIR/access-token" \
timeout "$(( TIMEOUT_MS * 5 / 1000 + 120 ))s" node "$SCRIPT_DIR/driver.mjs" \
  "$TRPC_URL" "$RECEIPT_DIR" "$RUN_ID" "$RUNTIME_NODE_NAME" "$CHUNK_COUNT" "$TIMEOUT_MS" \
  >"$RECEIPT_DIR/summary.json" 2>"$RECEIPT_DIR/logs/driver.log" &
DRIVER_PID=$!

wait_for_file "$RECEIPT_DIR/rpc/spawn.json" 'initial spawn'
AGENT_MULTIPLEX_ACCEPTANCE_BEARER_TOKEN_FILE="$RUNTIME_DIR/access-token" \
  node "$SCRIPT_DIR/capture.mjs" "$GATEWAY_URL" \
    "$RECEIPT_DIR/screenshots/01-ancestor-selected.png" \
    "$RECEIPT_DIR/logs/browser-initial.log" selected suppressed "$RUN_ID" \
    >"$RECEIPT_DIR/phases/browser-initial.json"

wait_for_file "$RECEIPT_DIR/coord/stop-authority-request.json" 'authority stop request'
STOPPED_AT=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
docker stop --time 10 "$AUTHORITY_CONTAINER" >/dev/null
jq -n --arg stoppedAt "$STOPPED_AT" \
  '{stoppedAt:$stoppedAt,processStopped:true,dataRoleChanged:false}' \
  >"$RECEIPT_DIR/coord/stop-authority-complete.json"

wait_for_file "$RECEIPT_DIR/rpc/metadata-queued.json" 'branch-side queued metadata'
AGENT_MULTIPLEX_ACCEPTANCE_BEARER_TOKEN_FILE="$RUNTIME_DIR/access-token" \
  node "$SCRIPT_DIR/capture.mjs" "$GATEWAY_URL" \
    "$RECEIPT_DIR/screenshots/02-warm-branch-selected.png" \
    "$RECEIPT_DIR/logs/browser-failover.log" not-selected selected "$RUN_ID" \
    >"$RECEIPT_DIR/phases/browser-failover.json"

wait_for_file "$RECEIPT_DIR/coord/start-authority-request.json" 'authority restart request'
RESTARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
docker start "$AUTHORITY_CONTAINER" >/dev/null
wait_for_log "$AUTHORITY_CONTAINER" '^P2P ticket \(' 'authority restart'
RESTARTED_ENDPOINT=$(control_endpoint "$AUTHORITY_CONTAINER")
[[ "$RESTARTED_ENDPOINT" == "$AUTHORITY_ENDPOINT" ]] || fail "authority endpoint identity changed after restart"
jq -n --arg restartedAt "$RESTARTED_AT" --arg endpoint "$RESTARTED_ENDPOINT" \
  '{restartedAt:$restartedAt,processRunning:true,endpointIdentityPreserved:true,endpointId:$endpoint}' \
  >"$RECEIPT_DIR/coord/start-authority-complete.json"

if ! wait "$DRIVER_PID"; then
  DRIVER_PID=""
  tail -n 100 "$RECEIPT_DIR/logs/driver.log" >&2 || true
  fail "tree driver failed"
fi
DRIVER_PID=""
jq -e '.passed == true and .authority.noImplicitPromotion == true and
  .authority.queuedWhileDisconnected == true and
  .authority.settledAfterRecovery == true and
  .routing.exactNativeDeltaReassemblies == 3' "$RECEIPT_DIR/summary.json" >/dev/null \
  || fail "driver summary assertions failed"

AGENT_MULTIPLEX_ACCEPTANCE_BEARER_TOKEN_FILE="$RUNTIME_DIR/access-token" \
  node "$SCRIPT_DIR/capture.mjs" "$GATEWAY_URL" \
    "$RECEIPT_DIR/screenshots/03-ancestor-recovered.png" \
    "$RECEIPT_DIR/logs/browser-recovered.log" selected suppressed "$RUN_ID" \
    >"$RECEIPT_DIR/phases/browser-recovered.json"

capture_logs
if rg --fixed-strings --quiet "$SHARED_SECRET" "$RECEIPT_DIR" || \
   rg --fixed-strings --quiet "$ACCESS_TOKEN" "$RECEIPT_DIR" || \
   rg --fixed-strings --quiet "$AUTHORITY_TICKET" "$RECEIPT_DIR" || \
   rg --fixed-strings --quiet "$BRANCH_TICKET" "$RECEIPT_DIR"; then
  fail "secret or raw reachability ticket leaked into receipt"
fi
if rg --quiet 'p2prpc3\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{80,}' "$RECEIPT_DIR"; then
  fail "ticket-shaped locator leaked into receipt"
fi
if rg --quiet '(UnhandledPromiseRejection|uncaught exception|SQLITE_CORRUPT|database disk image is malformed)' \
  "$RECEIPT_DIR/logs"; then
  fail "fatal runtime error appeared in container logs"
fi
if rg --quiet '(metadata operation was never queued here|metadata operation .* stale or unrelated authority)' \
  "$RECEIPT_DIR/logs"; then
  fail "metadata settlement was rejected anywhere on the downstream path"
fi

note "removing the exact tree containers and isolated network"
for container in "${CONTAINERS[@]}"; do
  docker rm --force "$container" >/dev/null
done
docker network rm "$NETWORK_NAME" >/dev/null
NETWORK_CREATED=0

IMAGE_REMOVED=true
if [[ ${AGENT_MULTIPLEX_TREE_KEEP_IMAGE:-0} == 1 ]]; then
  IMAGE_REMOVED=false
else
  docker image rm "$IMAGE_TAG" >/dev/null
fi
IMAGE_BUILT=0

CONTAINERS_REMOVED=true
for container in "${CONTAINERS[@]}"; do
  if docker container inspect "$container" >/dev/null 2>&1; then
    CONTAINERS_REMOVED=false
  fi
done
NETWORK_REMOVED=true
if docker network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
  NETWORK_REMOVED=false
fi
jq -n \
  --argjson containersRemoved "$CONTAINERS_REMOVED" \
  --argjson networkRemoved "$NETWORK_REMOVED" \
  --argjson imageRemoved "$IMAGE_REMOVED" \
  --arg networkTarget "$NETWORK_NAME" \
  --arg authorityContainer "$AUTHORITY_CONTAINER" \
  --arg branchContainer "$BRANCH_CONTAINER" \
  --arg runtimeContainer "$RUNTIME_CONTAINER" \
  --arg gatewayContainer "$GATEWAY_CONTAINER" '
  {
    cleanupCompleted: ($containersRemoved and $networkRemoved),
    exactContainerTargetsRemoved: $containersRemoved,
    isolatedNetworkRemoved: $networkRemoved,
    imageRemoved: $imageRemoved,
    imageRetentionRequested: ($imageRemoved | not),
    containerTargets: [
      $authorityContainer,
      $branchContainer,
      $runtimeContainer,
      $gatewayContainer
    ],
    networkTarget: $networkTarget,
    recoverable: false,
    materialUserDataRemoved: false
  }
' >"$RECEIPT_DIR/cleanup.json"
jq -e '.cleanupCompleted == true' "$RECEIPT_DIR/cleanup.json" >/dev/null \
  || fail "tree topology cleanup was incomplete"

jq -n \
  --arg runId "$RUN_ID" --arg imageId "$IMAGE_ID" \
  --arg authorityId "$AUTHORITY_ID" --arg branchId "$BRANCH_ID" \
  --arg authorityEndpoint "$AUTHORITY_ENDPOINT" --arg branchEndpoint "$BRANCH_ENDPOINT" \
  --arg authorityTicketDigest "$(printf '%s' "$AUTHORITY_TICKET" | sha256sum | awk '{print $1}')" \
  --arg branchTicketDigest "$(printf '%s' "$BRANCH_TICKET" | sha256sum | awk '{print $1}')" '
  {
    runId:$runId,
    imageId:$imageId,
    passed:true,
    topology:{authorityControlNodeId:$authorityId,branchControlNodeId:$branchId,runtimeNodes:1,gatewaySources:2},
    endpointPins:{authority:$authorityEndpoint,branch:$branchEndpoint,preservedAcrossRestart:true},
    receiptSecurity:{rawSecretsRecorded:false,rawTicketsRecorded:false,
      authorityTicketSha256:$authorityTicketDigest,branchTicketSha256:$branchTicketDigest},
    evidence:{summary:"summary.json",logs:"logs/",rpc:"rpc/",phases:"phases/",screenshots:"screenshots/",cleanup:"cleanup.json",checksums:"SHA256SUMS"}
  }' >"$RECEIPT_DIR/manifest.json"

(
  cd "$RECEIPT_DIR"
  find . -type f ! -name SHA256SUMS -print0 \
    | sort -z \
    | xargs -0 sha256sum \
    >SHA256SUMS
  sha256sum --check SHA256SUMS >/dev/null
)

COMPLETED=1
note "all protocol-v4 control-tree assertions passed"
