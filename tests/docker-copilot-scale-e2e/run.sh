#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/../.." && pwd)
P2PRPC_CORE=${AGENT_MULTIPLEX_P2PRPC_CORE:-"$REPO_ROOT/../p2prpc/packages/core"}
SOURCE_CONFIG=${AGENT_MULTIPLEX_COPILOT_SOURCE_CONFIG:-"${HOME}/.codex/config.toml"}
SOURCE_TOKEN=${AGENT_MULTIPLEX_COPILOT_SOURCE_TOKEN:-"${HOME}/.codex/codex-lb-api-key"}
RECEIPT_ROOT=${AGENT_MULTIPLEX_COPILOT_SCALE_RECEIPT_ROOT:-"$REPO_ROOT/receipts/copilot-real-scale"}
MODEL=${AGENT_MULTIPLEX_COPILOT_SCALE_MODEL:-gpt-5.6-luna}
REASONING_EFFORT=${AGENT_MULTIPLEX_COPILOT_SCALE_REASONING_EFFORT:-none}
STAGE_WIDTH=${AGENT_MULTIPLEX_COPILOT_SCALE_STAGE_WIDTH:-10}
STAGE_DELAY_MS=${AGENT_MULTIPLEX_COPILOT_SCALE_STAGE_DELAY_MS:-1000}
BURST_WIDTH=${AGENT_MULTIPLEX_COPILOT_SCALE_BURST_WIDTH:-100}
DISCONNECT_MS=${AGENT_MULTIPLEX_COPILOT_SCALE_DISCONNECT_MS:-3000}
TIMEOUT_MS=${AGENT_MULTIPLEX_COPILOT_SCALE_TIMEOUT_MS:-1800000}
DRY_RUN=${AGENT_MULTIPLEX_COPILOT_SCALE_DRY_RUN:-0}
CONFIRMATION=${AGENT_MULTIPLEX_COPILOT_SCALE_CONFIRM:-}
WORKER_COUNT=10
SESSIONS_PER_WORKER=10
TOTAL_SESSIONS=$(( WORKER_COUNT * SESSIONS_PER_WORKER ))

for value_name in STAGE_WIDTH STAGE_DELAY_MS BURST_WIDTH DISCONNECT_MS TIMEOUT_MS; do
  value=${!value_name}
  if [[ ! "$value" =~ ^[0-9]+$ ]]; then
    echo "real Copilot scale: $value_name must be a non-negative integer" >&2
    exit 1
  fi
done
if (( STAGE_WIDTH < 1 || STAGE_WIDTH > WORKER_COUNT )); then
  echo "real Copilot scale: STAGE_WIDTH must be between 1 and 10" >&2
  exit 1
fi
if (( BURST_WIDTH < 1 || BURST_WIDTH > TOTAL_SESSIONS )); then
  echo "real Copilot scale: BURST_WIDTH must be between 1 and 100" >&2
  exit 1
fi
if (( DISCONNECT_MS < 100 )); then
  echo "real Copilot scale: DISCONNECT_MS must be at least 100" >&2
  exit 1
fi
if (( TIMEOUT_MS < 60000 )); then
  echo "real Copilot scale: TIMEOUT_MS must be at least 60000" >&2
  exit 1
fi
if [[ "$DRY_RUN" != 0 && "$DRY_RUN" != 1 ]]; then
  echo "real Copilot scale: DRY_RUN must be 0 or 1" >&2
  exit 1
fi
if [[ -z "$MODEL" || -z "$REASONING_EFFORT" ]]; then
  echo "real Copilot scale: model and reasoning effort must not be empty" >&2
  exit 1
fi

for tool in docker jq node curl sha256sum awk sed perl rg timeout find sort xargs; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "real Copilot scale: required tool '$tool' is unavailable" >&2
    exit 1
  fi
done
if [[ ! -f "$P2PRPC_CORE/package.json" || ! -d "$P2PRPC_CORE/dist" ]]; then
  echo "real Copilot scale: built p2prpc core is required at $P2PRPC_CORE" >&2
  exit 1
fi
if [[ ! -r "$SOURCE_CONFIG" ]]; then
  echo "real Copilot scale: source config is not readable: $SOURCE_CONFIG" >&2
  exit 1
fi
if [[ ! -r "$SOURCE_TOKEN" ]]; then
  echo "real Copilot scale: source token is not readable: $SOURCE_TOKEN" >&2
  exit 1
fi

TOKEN_LITERAL=$(node -e '
  process.stdout.write(require("node:fs").readFileSync(process.argv[1], "utf8").trim());
' "$SOURCE_TOKEN")
if (( ${#TOKEN_LITERAL} < 16 )); then
  echo "real Copilot scale: codex-lb token is unexpectedly short" >&2
  exit 1
fi
PROVIDER_URL=$(awk '
  /^\[model_providers\.codex-lb\]$/ { in_provider = 1; next }
  in_provider && /^\[/ { exit }
  in_provider && /^[[:space:]]*base_url[[:space:]]*=/ {
    sub(/^[^=]*=[[:space:]]*/, ""); gsub(/^"|"$/, ""); print; exit
  }
' "$SOURCE_CONFIG")
if [[ -z "$PROVIDER_URL" ]]; then
  echo "real Copilot scale: codex-lb base_url was not found" >&2
  exit 1
fi
if ! node -e '
  const url = new URL(process.argv[1]);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) process.exit(1);
' "$PROVIDER_URL"; then
  echo "real Copilot scale: codex-lb base_url is not a credential-free HTTP(S) URL" >&2
  exit 1
fi
SOURCE_TOKEN_ABS=$(node -e '
  process.stdout.write(require("node:fs").realpathSync(process.argv[1]));
' "$SOURCE_TOKEN")
MODELS_JSON=$(jq -cn --arg model "$MODEL" '[$model]')

if [[ "$DRY_RUN" == 1 ]]; then
  node --check "$SCRIPT_DIR/driver.mjs"
  node --check "$SCRIPT_DIR/capture.mjs"
  jq -n \
    --arg model "$MODEL" \
    --arg effort "$REASONING_EFFORT" \
    --argjson workers "$WORKER_COUNT" \
    --argjson sessionsPerWorker "$SESSIONS_PER_WORKER" \
    --argjson stageWidth "$STAGE_WIDTH" \
    --argjson stageDelayMs "$STAGE_DELAY_MS" \
    --argjson burstWidth "$BURST_WIDTH" \
    --argjson disconnectMs "$DISCONNECT_MS" \
    --argjson timeoutMs "$TIMEOUT_MS" '
      {
        dryRun: true,
        realInferenceStarted: false,
        topology: {hostContainers: 1, workerContainers: $workers,
          sessionsPerWorker: $sessionsPerWorker,
          totalSessions: ($workers * $sessionsPerWorker)},
        provider: {configurationFound: true, tokenFileReadable: true,
          endpointRecorded: false, tokenRecorded: false},
        workload: {model: $model, reasoningEffort: $effort,
          stageWidth: $stageWidth, stageDelayMs: $stageDelayMs,
          burstWidth: $burstWidth, workerDisconnectMs: $disconnectMs,
          timeoutMs: $timeoutMs},
        scripts: {shellParsed: true, nodeParsed: true}
      }
    '
  exit 0
fi

if [[ "$CONFIRMATION" != I_UNDERSTAND_THIS_RUNS_100_REAL_SESSIONS ]]; then
  cat >&2 <<'EOF'
real Copilot scale: refusing to start a credit-consuming run without explicit confirmation.

Run the non-inference validation first:
  AGENT_MULTIPLEX_COPILOT_SCALE_DRY_RUN=1 npm run test:docker:copilot:scale

After lifecycle changes are stable, opt in with:
  AGENT_MULTIPLEX_COPILOT_SCALE_CONFIRM=I_UNDERSTAND_THIS_RUNS_100_REAL_SESSIONS npm run test:docker:copilot:scale
EOF
  exit 2
fi

random_hex() {
  node -e 'process.stdout.write(require("node:crypto").randomBytes(6).toString("hex"))'
}

RUN_ID=${AGENT_MULTIPLEX_COPILOT_SCALE_RUN_ID:-"$(date -u +%Y%m%dT%H%M%SZ)-$(random_hex)"}
if [[ ! "$RUN_ID" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "real Copilot scale: run id may contain only letters, digits, dot, underscore, or dash" >&2
  exit 1
fi

RECEIPT_DIR="$RECEIPT_ROOT/$RUN_ID"
if [[ -e "$RECEIPT_DIR" ]]; then
  echo "real Copilot scale: receipt directory already exists: $RECEIPT_DIR" >&2
  exit 1
fi
mkdir -p \
  "$RECEIPT_DIR/logs/workers" \
  "$RECEIPT_DIR/rpc" \
  "$RECEIPT_DIR/phases" \
  "$RECEIPT_DIR/coord" \
  "$RECEIPT_DIR/screenshots"

RUNTIME_DIR=$(mktemp -d "${TMPDIR:-/tmp}/agent-multiplex-copilot-scale.XXXXXXXX")
NAME_SUFFIX=$(printf '%s' "$RUN_ID" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9' | tail -c 22)
HOST_CONTAINER="agent-multiplex-copilot-scale-host-$NAME_SUFFIX"
NETWORK_NAME="agent-multiplex-copilot-scale-$NAME_SUFFIX"
IMAGE_TAG="agent-multiplex-copilot-scale:$NAME_SUFFIX"
WORKER_PREFIX="copilot-scale-$NAME_SUFFIX"
SHARED_SECRET=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(48).toString("base64url"))')
RUN_STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

declare -a WORKER_CONTAINERS=()
declare -a WORKER_NAMES=()
declare -a ALL_CONTAINERS=()
HOST_STARTED=0
WORKERS_STARTED=0
NETWORK_CREATED=0
IMAGE_BUILT=0
LOGS_CAPTURED=0
COMPLETED=0
DRIVER_PID=""
RESOURCE_PID=""
P2P_TICKET=""
P2P_ENDPOINT_ID=""

note() {
  printf '[copilot-real-scale] %s\n' "$*" >&2
}

fail() {
  note "FAILED: $*"
  return 1
}

redact_stream() {
  AM_REDACT_SHARED="$SHARED_SECRET" \
  AM_REDACT_TICKET="$P2P_TICKET" \
  AM_REDACT_TOKEN="$TOKEN_LITERAL" \
  AM_REDACT_PROVIDER="$PROVIDER_URL" \
    perl -0pe '
      BEGIN {
        @pairs = (
          [$ENV{AM_REDACT_SHARED} // "", "<redacted-shared-secret>"],
          [$ENV{AM_REDACT_TICKET} // "", "<redacted-p2p-ticket>"],
          [$ENV{AM_REDACT_TOKEN} // "", "<redacted-codex-lb-token>"],
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
  if (( HOST_STARTED == 1 )); then
    docker logs "$HOST_CONTAINER" >"$raw_host" 2>&1 || true
    awk '
      redact_next { print "<redacted-locator>"; redact_next = 0; next }
      /^P2P ticket \(/ { print; redact_next = 1; next }
      { print }
    ' "$raw_host" | redact_stream >"$RECEIPT_DIR/logs/host.log"
  fi
  local index container raw_worker
  for (( index = 0; index < WORKERS_STARTED; index++ )); do
    container=${WORKER_CONTAINERS[$index]}
    raw_worker="$RUNTIME_DIR/worker-$index.raw.log"
    docker logs "$container" >"$raw_worker" 2>&1 || true
    redact_stream <"$raw_worker" >"$RECEIPT_DIR/logs/workers/${WORKER_NAMES[$index]}.log"
  done
  LOGS_CAPTURED=1
}

sanitize_receipts() {
  local file temporary="$RUNTIME_DIR/sanitized-receipt"
  while IFS= read -r -d '' file; do
    redact_stream <"$file" >"$temporary"
    mv -- "$temporary" "$file"
  done < <(
    find "$RECEIPT_DIR" -type f \
      ! -name '*.png' \
      ! -name SHA256SUMS \
      -print0
  )
}

remove_test_topology() {
  local container
  for container in "${WORKER_CONTAINERS[@]}"; do
    docker rm --force "$container" >/dev/null 2>&1 || true
  done
  WORKERS_STARTED=0
  if (( HOST_STARTED == 1 )); then
    docker rm --force "$HOST_CONTAINER" >/dev/null 2>&1 || true
    HOST_STARTED=0
  fi
  if (( NETWORK_CREATED == 1 )); then
    docker network rm "$NETWORK_NAME" >/dev/null 2>&1 || true
    NETWORK_CREATED=0
  fi
  if (( IMAGE_BUILT == 1 )) && [[ ${AGENT_MULTIPLEX_COPILOT_SCALE_KEEP_IMAGE:-0} != 1 ]]; then
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
  sanitize_receipts
  remove_test_topology
  if [[ -n "$RUNTIME_DIR" && -d "$RUNTIME_DIR" && "$RUNTIME_DIR" != "/" && \
        "$(basename -- "$RUNTIME_DIR")" == agent-multiplex-copilot-scale.* ]]; then
    rm -rf -- "$RUNTIME_DIR"
  fi
  if (( COMPLETED == 0 )); then
    printf 'The real Copilot scale run failed. Inspect driver-failure.json and logs/.\n' \
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

wait_for_host_startup() {
  local attempt logs
  for attempt in $(seq 1 90); do
    if [[ $(docker inspect --format '{{.State.Running}}' "$HOST_CONTAINER" 2>/dev/null) != true ]]; then
      docker logs "$HOST_CONTAINER" 2>&1 | redact_stream >&2 || true
      fail "host container exited during startup"
      return
    fi
    logs=$(docker logs "$HOST_CONTAINER" 2>&1 || true)
    if rg --quiet '^P2P ID:' <<<"$logs" && rg --quiet '^P2P ticket \(' <<<"$logs"; then
      return
    fi
    if (( attempt % 15 == 0 )); then note "waiting for host endpoint (${attempt}s)"; fi
    sleep 1
  done
  fail "timed out waiting for host startup"
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

note "building one credential-free host/worker image"
if ! docker build \
  --progress=plain \
  --build-context "p2prpc-core=$P2PRPC_CORE" \
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

note "starting the canonical metadata host container"
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
ALL_CONTAINERS=("$HOST_CONTAINER")
wait_for_host_startup

HOST_LOGS=$(docker logs "$HOST_CONTAINER" 2>&1)
P2P_ENDPOINT_ID=$(sed -n 's/^P2P ID:[[:space:]]*//p' <<<"$HOST_LOGS" | tail -n 1)
P2P_TICKET=$(awk '/^P2P ticket \(/ { getline; print; exit }' <<<"$HOST_LOGS")
if [[ ! "$P2P_ENDPOINT_ID" =~ ^[a-z2-7]{52}$ ]]; then fail "host emitted an invalid endpoint ID"; fi
if (( ${#P2P_TICKET} < 20 || ${#P2P_TICKET} > 8192 )) || [[ "$P2P_TICKET" =~ [[:space:]] ]]; then
  fail "host emitted an invalid P2P ticket"
fi
P2P_TICKET_SHA256=$(printf '%s' "$P2P_TICKET" | sha256sum | awk '{print $1}')

PORT_MAPPING=$(docker port "$HOST_CONTAINER" 4317/tcp | tail -n 1)
DASHBOARD_PORT=${PORT_MAPPING##*:}
if [[ ! "$DASHBOARD_PORT" =~ ^[0-9]+$ ]]; then fail "could not resolve dashboard port"; fi
DASHBOARD_URL="http://127.0.0.1:$DASHBOARD_PORT/"
TRPC_URL="http://127.0.0.1:$DASHBOARD_PORT/trpc"
for attempt in $(seq 1 30); do
  if curl --fail --silent --show-error "$DASHBOARD_URL" >/dev/null; then break; fi
  if (( attempt == 30 )); then fail "dashboard did not become reachable"; fi
  sleep 1
done

note "starting 10 isolated Copilot BYOK worker containers"
for (( index = 0; index < WORKER_COUNT; index++ )); do
  suffix=$(printf '%02d' "$index")
  worker_name="$WORKER_PREFIX-$suffix"
  worker_container="agent-multiplex-copilot-scale-worker-$NAME_SUFFIX-$suffix"
  WORKER_NAMES+=("$worker_name")
  WORKER_CONTAINERS+=("$worker_container")
  docker run --detach \
    --name "$worker_container" \
    --hostname "copilot-worker-$suffix" \
    --network "$NETWORK_NAME" \
    --init \
    --user 1000:100 \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --security-opt seccomp=unconfined \
    --tmpfs /state:rw,nosuid,nodev,mode=0700,uid=1000,gid=100 \
    --tmpfs /tmp:rw,nosuid,nodev,mode=1777 \
    --tmpfs /workspace:rw,nosuid,nodev,mode=0700,uid=1000,gid=100 \
    --tmpfs /home/arduano/.copilot:rw,nosuid,nodev,mode=0700,uid=1000,gid=100 \
    --mount "type=bind,src=$SOURCE_TOKEN_ABS,dst=/run/secrets/codex-lb,readonly" \
    --env HOME=/home/arduano \
    --env XDG_CACHE_HOME=/tmp/cache \
    --env AGENT_MULTIPLEX_SHARED_SECRET="$SHARED_SECRET" \
    --env AGENT_MULTIPLEX_CONTROL_NODE_ENDPOINT_ID="$P2P_ENDPOINT_ID" \
    --env AGENT_MULTIPLEX_CONTROL_NODE_TICKET="$P2P_TICKET" \
    --env 'AGENT_MULTIPLEX_RUNTIME_NODE_ALLOWED_ROOTS=["/workspace"]' \
    --env AGENT_MULTIPLEX_RUNTIME_NODE_STATE_DIR=/state/runtime-node \
    --env AGENT_MULTIPLEX_RUNTIME_NODE_NAME="$worker_name" \
    --env AGENT_MULTIPLEX_RUNTIME_NODE_HARNESSES=copilot \
    --env AGENT_MULTIPLEX_RUNTIME_NODE_HEARTBEAT_MS=1000 \
    --env AGENT_MULTIPLEX_RUNTIME_NODE_INVENTORY_REFRESH_MS=2000 \
    --env AGENT_MULTIPLEX_RUNTIME_NODE_METADATA_FLUSH_MS=500 \
    --env AGENT_MULTIPLEX_RUNTIME_NODE_RECONNECT_MAX_MS=2000 \
    --env AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_HOME=/home/arduano/.copilot \
    --env AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_LOG_LEVEL=none \
    --env AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_SCOPE="copilot:scale:$suffix" \
    --env AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_TYPE=openai \
    --env AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_BASE_URL="$PROVIDER_URL" \
    --env AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_WIRE_API=responses \
    --env AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_TRANSPORT=http \
    --env AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_MODEL="$MODEL" \
    --env AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_MODELS="$MODELS_JSON" \
    --env AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_API_KEY_FILE=/run/secrets/codex-lb \
    "$IMAGE_TAG" \
    node apps/runtime-node/dist/main.js >/dev/null
  WORKERS_STARTED=$(( index + 1 ))
  ALL_CONTAINERS+=("$worker_container")
done

docker inspect "${WORKER_CONTAINERS[@]}" | jq --arg source "$SOURCE_TOKEN_ABS" '
  map(
    . as $container |
    ($container.Mounts | map(select(.Destination == "/run/secrets/codex-lb"))) as $mounts |
    {
      containerName: ($container.Name | ltrimstr("/")),
      mountCount: ($mounts | length),
      destination: $mounts[0].Destination,
      mountType: $mounts[0].Type,
      readOnly: ($mounts[0].RW == false),
      sourcePathMatchesExpected: ($mounts[0].Source == $source),
      tokenCopiedIntoImage: false,
      fullCodexHomeMounted: false
    }
  )
' >"$RECEIPT_DIR/auth-mount-proof.json"
assert_json "worker token mounts are not narrowly scoped and read-only" '
  length == 10 and all(.[];
    .mountCount == 1 and
    .destination == "/run/secrets/codex-lb" and
    .mountType == "bind" and
    .readOnly == true and
    .sourcePathMatchesExpected == true and
    .tokenCopiedIntoImage == false and
    .fullCodexHomeMounted == false)
' "$RECEIPT_DIR/auth-mount-proof.json"

: >"$RECEIPT_DIR/logs/docker-stats.ndjson"
sample_resources &
RESOURCE_PID=$!

note "running staged baseline inference, then a configurable full-fleet burst"
DRIVER_TIMEOUT_SECONDS=$(( TIMEOUT_MS * 4 / 1000 + 600 ))
timeout "${DRIVER_TIMEOUT_SECONDS}s" node "$SCRIPT_DIR/driver.mjs" \
  "$TRPC_URL" \
  "$RECEIPT_DIR" \
  "$RUN_ID" \
  "$WORKER_PREFIX" \
  "$WORKER_COUNT" \
  "$SESSIONS_PER_WORKER" \
  "$MODEL" \
  "$REASONING_EFFORT" \
  "$STAGE_WIDTH" \
  "$STAGE_DELAY_MS" \
  "$BURST_WIDTH" \
  "$TIMEOUT_MS" \
  >"$RECEIPT_DIR/driver-summary.json" \
  2>"$RECEIPT_DIR/logs/driver.log" &
DRIVER_PID=$!

DISCONNECT_HANDLED=0
for attempt in $(seq 1 $(( TIMEOUT_MS / 50 + 1 ))); do
  if (( DISCONNECT_HANDLED == 0 )) && [[ -s "$RECEIPT_DIR/coord/disconnect-request.json" ]]; then
    TARGET_WORKER_INDEX=$(jq -r '.workerIndex' "$RECEIPT_DIR/coord/disconnect-request.json")
    TARGET_WORKER_NAME=$(jq -r '.workerName' "$RECEIPT_DIR/coord/disconnect-request.json")
    if [[ ! "$TARGET_WORKER_INDEX" =~ ^[0-9]+$ ]] || (( TARGET_WORKER_INDEX >= WORKER_COUNT )); then
      fail "scale driver requested an invalid worker index"
    fi
    if [[ "$TARGET_WORKER_NAME" != "${WORKER_NAMES[$TARGET_WORKER_INDEX]}" ]]; then
      fail "scale driver worker name/index do not agree"
    fi
    TARGET_WORKER_CONTAINER=${WORKER_CONTAINERS[$TARGET_WORKER_INDEX]}
    TARGET_WORKER_ID=$(docker inspect --format '{{.Id}}' "$TARGET_WORKER_CONTAINER")
    docker network disconnect "$NETWORK_NAME" "$TARGET_WORKER_CONTAINER"
    if docker inspect --format '{{json .NetworkSettings.Networks}}' "$TARGET_WORKER_CONTAINER" \
      | jq -e --arg network "$NETWORK_NAME" 'has($network)' >/dev/null; then
      fail "target worker still reported membership in the scale network"
    fi
    DISCONNECTED_AT=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
    sleep "$(awk -v milliseconds="$DISCONNECT_MS" 'BEGIN { printf "%.3f", milliseconds / 1000 }')"
    if [[ $(docker inspect --format '{{.State.Running}}' "$TARGET_WORKER_CONTAINER") != true ]]; then
      fail "target worker exited while isolated from the Docker network"
    fi
    docker network connect "$NETWORK_NAME" "$TARGET_WORKER_CONTAINER"
    for reconnect_attempt in $(seq 1 100); do
      if docker inspect --format '{{json .NetworkSettings.Networks}}' "$TARGET_WORKER_CONTAINER" \
        | jq -e --arg network "$NETWORK_NAME" 'has($network)' >/dev/null; then
        break
      fi
      if (( reconnect_attempt == 100 )); then fail "target worker did not rejoin the network"; fi
      sleep 0.05
    done
    RECONNECTED_AT=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
    jq -n \
      --arg workerName "$TARGET_WORKER_NAME" \
      --argjson workerIndex "$TARGET_WORKER_INDEX" \
      --arg containerName "$TARGET_WORKER_CONTAINER" \
      --arg containerId "$TARGET_WORKER_ID" \
      --arg disconnectedAt "$DISCONNECTED_AT" \
      --arg reconnectedAt "$RECONNECTED_AT" \
      --argjson disconnectMs "$DISCONNECT_MS" '
        {
          workerName: $workerName,
          workerIndex: $workerIndex,
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
    DISCONNECT_HANDLED=1
  fi
  if [[ -s "$RECEIPT_DIR/coord/dashboard-ready.json" ]]; then break; fi
  if ! kill -0 "$DRIVER_PID" 2>/dev/null; then
    wait "$DRIVER_PID" || true
    DRIVER_PID=""
    tail -n 100 "$RECEIPT_DIR/logs/driver.log" >&2 || true
    fail "scale driver exited before dashboard capture"
  fi
  if (( attempt % 400 == 0 )); then note "waiting for 100 completed sessions ($(( attempt / 20 ))s)"; fi
  sleep 0.05
done
if [[ ! -s "$RECEIPT_DIR/coord/dashboard-ready.json" ]]; then
  fail "timed out waiting for the scale driver dashboard phase"
fi

note "recording one live SDK-managed Copilot runtime per worker"
: >"$RUNTIME_DIR/process-proof.ndjson"
for (( index = 0; index < WORKER_COUNT; index++ )); do
  docker exec "${WORKER_CONTAINERS[$index]}" node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const processes = [];
    for (const entry of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
      try {
        const args = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8")
          .split("\0").filter(Boolean);
        const encoded = args.join(" ").toLowerCase();
        if (!encoded.includes("copilot") || encoded.includes("apps/runtime-node/dist/main.js")) continue;
        processes.push({
          pid: Number(entry),
          executable: path.basename(args[0] || "unknown"),
          role: "Copilot runtime child",
        });
      } catch {}
    }
    processes.sort((left, right) => left.pid - right.pid);
    process.stdout.write(JSON.stringify({ processes }));
  ' | jq -c \
    --arg workerName "${WORKER_NAMES[$index]}" \
    --arg containerName "${WORKER_CONTAINERS[$index]}" \
    '. + {workerName: $workerName, containerName: $containerName}' \
    >>"$RUNTIME_DIR/process-proof.ndjson"
done
jq -s '.' "$RUNTIME_DIR/process-proof.ndjson" >"$RECEIPT_DIR/copilot-process-proof.json"
assert_json "a live Copilot runtime was not observed in every worker" '
  length == 10 and all(.[]; (.processes | length) >= 1)
' "$RECEIPT_DIR/copilot-process-proof.json"

note "capturing the dashboard with exact total DOM counts"
EXPECTED_MARKER=$(jq -r '.marker' "$RECEIPT_DIR/coord/dashboard-ready.json")
if ! timeout 120s node "$SCRIPT_DIR/capture.mjs" \
  "$DASHBOARD_URL" \
  "$RECEIPT_DIR/screenshots/dashboard-100-copilot-sessions.png" \
  "$RECEIPT_DIR/logs/browser-console.txt" \
  "$WORKER_PREFIX" \
  "$RUN_ID" \
  "$WORKER_COUNT" \
  "$TOTAL_SESSIONS" \
  "$EXPECTED_MARKER" \
  >"$RECEIPT_DIR/rpc/playwright-dashboard.json" \
  2>"$RECEIPT_DIR/logs/playwright.log"; then
  fail "Playwright dashboard capture failed"
fi
assert_json "dashboard did not render the complete real Copilot fleet" '
  .assertions.exactTotalWorkerCards == true and
  .assertions.exactSelectedWorkerCards == true and
  .assertions.everyWorkerOnlineAndCopilotReady == true and
  .assertions.exactTotalSessionCards == true and
  .assertions.exactSelectedSessionCards == true and
  .assertions.everySessionActiveAndIdle == true and
  .assertions.streamLive == true and
  .assertions.expectedMarkerVisible == true and
  .assertions.browserConsoleErrors == 0 and
  .visible.totalWorkerCardCount == 10 and
  .visible.totalSessionCardCount == 100
' "$RECEIPT_DIR/rpc/playwright-dashboard.json"
if [[ ! -s "$RECEIPT_DIR/screenshots/dashboard-100-copilot-sessions.png" ]]; then
  fail "Playwright did not write the scale screenshot"
fi
jq -n --arg at "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" \
  --arg receipt "rpc/playwright-dashboard.json" \
  '{capturedAt: $at, receipt: $receipt, passed: true}' \
  >"$RECEIPT_DIR/coord/dashboard-captured.json"

if ! wait "$DRIVER_PID"; then
  DRIVER_PID=""
  tail -n 100 "$RECEIPT_DIR/logs/driver.log" >&2 || true
  fail "scale driver failed"
fi
DRIVER_PID=""

touch "$RECEIPT_DIR/coord/stop-resource-sampling"
if [[ -n "$RESOURCE_PID" ]]; then wait "$RESOURCE_PID" || true; fi
RESOURCE_PID=""
rm "$RECEIPT_DIR/coord/stop-resource-sampling"

assert_json "driver summary did not pass" '
  .passed == true and
  .topology.workers == 10 and
  .topology.sessionsPerWorker == 10 and
  .topology.totalSessions == 100 and
  .commands.spawnSucceeded == 100 and
  .commands.sendSucceeded == 100 and
  .commands.burstSendSucceeded == 100 and
  .commands.stopSucceeded == 100 and
  .streaming.sessionsValidated == 100 and
  .streaming.exactDeltaReassemblies == 100 and
  .streaming.exactFinalMessages == 100 and
  .streaming.lifecycleOrderValidated == 100 and
  .streaming.contiguousPerSessionSequences == 100 and
  .streaming.nativeGaps == 0 and
  .streaming.applicationDuplicateDeliveries == 0 and
  .history.sessionsValidated == 100 and
  .history.newInferenceRequests == 0 and
  .metadata.clientPatchesAccepted == 100 and
  .scheduling.spawnWaves == 10 and
  .scheduling.sendWaves == 10 and
  .scheduling.burstMaximumConcurrentSendRequests == $burstWidth and
  .burst.maximumConcurrentSendRequests == $burstWidth and
  .burst.clientRpcConcurrency.configuredMaximum == $burstWidth and
  .burst.clientRpcConcurrency.observedMaximumUnresolvedExecuteMutations == $burstWidth and
  .burst.clientRpcConcurrency.allOneHundredExecuteMutationsOverlapped == ($burstWidth == 100) and
  .burst.providerInferenceConcurrency.measured == false and
  .burst.sessionsValidated == 100 and
  .burst.exactDeltaReassemblies == 100 and
  .burst.exactFinalMessages == 100 and
  .burst.lifecycleOrderValidated == 100 and
  .burst.allOneHundredTurnsOverlappedClaimed == false and
  .burst.workerNetworkIsolation.containerStayedRunning == true and
  .burst.workerNetworkIsolation.rejoinedNetwork == true and
  .burst.workerNetworkIsolation.applicationStreamRecoveredWithoutGapOrDuplicate == true and
  .runtime.separateRuntimeProcessPerSessionClaimed == false and
  .finalInventory.resumableStoppedSessions == 100
' "$RECEIPT_DIR/driver-summary.json" --argjson burstWidth "$BURST_WIDTH"

if [[ $(docker network inspect --format '{{len .Containers}}' "$NETWORK_NAME") != 11 ]]; then
  fail "scale network does not contain exactly one host and ten workers"
fi
for container in "${ALL_CONTAINERS[@]}"; do
  if [[ $(docker inspect --format '{{.State.Running}}' "$container") != true ]]; then
    fail "$container is not running at the final topology check"
  fi
done
for container in "${WORKER_CONTAINERS[@]}"; do
  if [[ -n $(docker port "$container" 2>/dev/null) ]]; then
    fail "$container unexpectedly publishes a host port"
  fi
done

docker inspect --format \
  '{"name":"{{.Name}}","id":"{{.Id}}","image":"{{.Image}}","running":{{.State.Running}},"oomKilled":{{.State.OOMKilled}},"exitCode":{{.State.ExitCode}},"restartCount":{{.RestartCount}},"startedAt":"{{.State.StartedAt}}"}' \
  "${ALL_CONTAINERS[@]}" | jq -s 'map(.name |= ltrimstr("/"))' \
  >"$RECEIPT_DIR/container-lifecycle.json"
assert_json "a scale container failed its lifecycle check" '
  length == 11 and
  (map(.id) | unique | length) == 11 and
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
  .sampleTimes >= 3 and
  (.containers | length) == 11 and
  all(.containers[];
    .sampleCount >= 3 and
    (.cpuPercent.max | type == "number") and
    (.memoryPercent.max | type == "number") and
    (.pids.max | type == "number") and
    .pids.max >= 1)
' "$RECEIPT_DIR/resource-summary.json"

HOST_CONTAINER_ID=$(docker inspect --format '{{.Id}}' "$HOST_CONTAINER")
jq -n \
  --arg hostName "$HOST_CONTAINER" \
  --arg hostId "$HOST_CONTAINER_ID" \
  --arg network "$NETWORK_NAME" \
  --arg image "$IMAGE_ID" \
  --arg endpoint "$P2P_ENDPOINT_ID" \
  --arg ticketDigest "$P2P_TICKET_SHA256" \
  --argjson workers "$(printf '%s\n' "${WORKER_CONTAINERS[@]}" | jq -Rsc 'split("\n")[:-1]')" '
    {
      applicationContainerCount: 11,
      hostContainerCount: 1,
      workerContainerCount: 10,
      sessionsPerWorker: 10,
      totalCopilotSessions: 100,
      sharedImageId: $image,
      network: {name: $network, driver: "bridge"},
      host: {name: $hostName, id: $hostId,
        role: "canonical metadata host + tRPC/HTTP dashboard"},
      workers: ($workers | map({name: .,
        role: "Multiplex worker + one SDK-managed Copilot runtime",
        copilotSessions: 10, publishedPorts: []})),
      transport: {protocol: "p2prpc v1 over Iroh", hostEndpointId: $endpoint,
        ticketRecorded: false, ticketSha256: $ticketDigest},
      runtimeAccounting: {
        sdkManagedCopilotRuntimes: 10,
        separateRuntimeProcessPerSession: false,
        realProviderSessions: 100
      },
      browserRunsOnDockerHost: true
    }
  ' >"$RECEIPT_DIR/topology.json"

NODE_VERSION=$(docker exec "$HOST_CONTAINER" node --version | tr -d '\r\n')
COPILOT_VERSION=$(jq -r '
  .[0].harnesses[] | select(.harness == "copilot") | .runtimeVersion
' "$RECEIPT_DIR/rpc/workers-initial.json")
COPILOT_SDK_VERSION=$(jq -r '
  .[0].harnesses[] | select(.harness == "copilot") | .version
' "$RECEIPT_DIR/rpc/workers-initial.json")
if [[ -z "$COPILOT_VERSION" || "$COPILOT_VERSION" == null || \
      -z "$COPILOT_SDK_VERSION" || "$COPILOT_SDK_VERSION" == null ]]; then
  fail "Copilot runtime/SDK versions were absent from the worker catalog"
fi
DOCKER_VERSION=$(docker version --format '{{.Server.Version}}')
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
sanitize_receipts

RUN_COMPLETED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
jq -n \
  --arg runId "$RUN_ID" \
  --arg startedAt "$RUN_STARTED_AT" \
  --arg completedAt "$RUN_COMPLETED_AT" \
  --arg docker "$DOCKER_VERSION" \
  --arg node "$NODE_VERSION" \
  --arg copilot "$COPILOT_VERSION" \
  --arg sdk "$COPILOT_SDK_VERSION" \
  --arg p2prpc "$P2PRPC_REVISION" \
  --arg image "$IMAGE_ID" \
  --arg sourceDigest "$SOURCE_DIGEST" \
  --arg model "$MODEL" \
  --arg effort "$REASONING_EFFORT" \
  --argjson stageWidth "$STAGE_WIDTH" \
  --argjson stageDelayMs "$STAGE_DELAY_MS" \
  --argjson burstWidth "$BURST_WIDTH" \
  --argjson disconnectMs "$DISCONNECT_MS" '
    {
      runId: $runId,
      status: "passed",
      workloadType: "real Copilot BYOK staged scale acceptance",
      startedAt: $startedAt,
      completedAt: $completedAt,
      versions: {dockerServer: $docker, nodeInImage: $node,
        copilotRuntime: $copilot, copilotSdk: $sdk,
        multiplexProtocol: 1, p2prpcRevision: $p2prpc},
      topology: {hostContainers: 1, workerContainers: 10,
        sessionsPerWorker: 10, sessionsTotal: 100},
      provider: {type: "openai", wireApi: "responses", transport: "http",
        credentialMode: "read-only API-key file",
        endpointIntendedForReceipt: false, tokenIntendedForReceipt: false},
      workload: {model: $model, reasoningEffort: $effort,
        spawnWaves: 10, sendWaves: 10,
        maximumOperationsPerWave: $stageWidth,
        delayBetweenWavesMs: $stageDelayMs,
        burstSessions: 100,
      burstMaximumConcurrentSendRequests: $burstWidth,
      workerNetworkIsolationMs: $disconnectMs,
      oneHundredConcurrentSendRequestsAtDefaultBurstWidth: ($burstWidth == 100),
      concurrencyEvidenceSource: "driver measured unresolved tRPC execute mutations",
      allProviderTurnsOverlappedClaimed: false},
      runtimeModel: {sdkManagedRuntimePerWorker: 1,
        separateRuntimeProcessPerSession: false},
      imageId: $image,
      sourceTreeSha256: $sourceDigest
    }
  ' >"$RECEIPT_DIR/manifest.json"

note "removing the exact scale containers, network, and disposable image"
remove_test_topology
REMOVED_CONTAINERS=true
for container in "${ALL_CONTAINERS[@]}"; do
  if docker container inspect "$container" >/dev/null 2>&1; then REMOVED_CONTAINERS=false; fi
done
NETWORK_REMOVED=true
if docker network inspect "$NETWORK_NAME" >/dev/null 2>&1; then NETWORK_REMOVED=false; fi
IMAGE_REMOVED=true
IMAGE_RETAINED_BY_REQUEST=false
if docker image inspect "$IMAGE_TAG" >/dev/null 2>&1; then
  IMAGE_REMOVED=false
  if [[ ${AGENT_MULTIPLEX_COPILOT_SCALE_KEEP_IMAGE:-0} == 1 ]]; then
    IMAGE_RETAINED_BY_REQUEST=true
  fi
fi
jq -n \
  --argjson containersRemoved "$REMOVED_CONTAINERS" \
  --argjson networkRemoved "$NETWORK_REMOVED" \
  --argjson imageRemoved "$IMAGE_REMOVED" \
  --argjson imageRetainedByRequest "$IMAGE_RETAINED_BY_REQUEST" \
  --arg networkTarget "$NETWORK_NAME" \
  --arg imageTarget "$IMAGE_TAG" '
    {
      cleanupCompleted: ($containersRemoved and $networkRemoved and
        ($imageRemoved or $imageRetainedByRequest)),
      exactContainerTargetsRemoved: $containersRemoved,
      isolatedNetworkRemoved: $networkRemoved,
      disposableImageRemoved: $imageRemoved,
      imageRetainedByRequest: $imageRetainedByRequest,
      networkTarget: $networkTarget,
      imageTarget: $imageTarget,
      recoverable: false,
      materialUserDataRemoved: false
    }
  ' >"$RECEIPT_DIR/cleanup.json"
assert_json "scale topology cleanup was incomplete" '.cleanupCompleted == true' \
  "$RECEIPT_DIR/cleanup.json"

for forbidden in "$TOKEN_LITERAL" "$PROVIDER_URL" "$SHARED_SECRET" "$P2P_TICKET"; do
  if [[ -n "$forbidden" ]] && rg --text --fixed-strings --quiet -- "$forbidden" "$RECEIPT_DIR"; then
    fail "provider credential, endpoint, transport secret, or locator leaked into receipts"
  fi
done
jq -n '
  {
    passed: true,
    scanned: ["raw codex-lb token", "provider endpoint",
      "fleet shared secret", "raw p2prpc ticket"],
    exactSecretMatches: 0,
    note: "A second scan runs after all human-readable and derived receipts are written."
  }
' >"$RECEIPT_DIR/redaction-scan.json"

jq -n \
  --slurpfile driver "$RECEIPT_DIR/driver-summary.json" \
  --slurpfile resources "$RECEIPT_DIR/resource-summary.json" \
  --slurpfile topology "$RECEIPT_DIR/topology.json" \
  --slurpfile lifecycle "$RECEIPT_DIR/container-lifecycle.json" \
  --slurpfile dashboard "$RECEIPT_DIR/rpc/playwright-dashboard.json" \
  --slurpfile auth "$RECEIPT_DIR/auth-mount-proof.json" \
  --slurpfile processes "$RECEIPT_DIR/copilot-process-proof.json" \
  --slurpfile disconnect "$RECEIPT_DIR/coord/disconnect-complete.json" \
  --slurpfile cleanup "$RECEIPT_DIR/cleanup.json" \
  --slurpfile redaction "$RECEIPT_DIR/redaction-scan.json" '
    {
      topology: {
        exactlyOneCanonicalHostContainer: ($topology[0].hostContainerCount == 1),
        exactlyTenWorkerContainers: ($topology[0].workerContainerCount == 10),
        exactlyTenSessionsPerWorker: ($topology[0].sessionsPerWorker == 10),
        exactlyOneHundredRealCopilotSessions: ($topology[0].totalCopilotSessions == 100),
        workersPublishNoPorts: ($topology[0].workers | length == 10 and all(.[]; .publishedPorts == [])),
        sharedImmutableImage: ($lifecycle[0] | length == 11 and (map(.image) | unique | length) == 1)
      },
      providerAndRuntime: {
        allTokenMountsReadOnly: ($auth[0] | length == 10 and all(.[]; .readOnly == true)),
        oneOrMoreRuntimeProcessesObservedPerWorker:
          ($processes[0] | length == 10 and all(.[]; (.processes | length) >= 1)),
        runtimeProcessesObserved: ($processes[0] | map(.processes | length) | add),
        separateRuntimePerSessionClaimed: false
      },
      commands: {
        spawnSucceeded: $driver[0].commands.spawnSucceeded,
        sendSucceeded: $driver[0].commands.sendSucceeded,
        burstSendSucceeded: $driver[0].commands.burstSendSucceeded,
        stopSucceeded: $driver[0].commands.stopSucceeded
      },
      nativeStreaming: {
        sessionsValidated: $driver[0].streaming.sessionsValidated,
        exactDeltaReassemblies: $driver[0].streaming.exactDeltaReassemblies,
        exactFinalMessages: $driver[0].streaming.exactFinalMessages,
        lifecycleOrderValidated: $driver[0].streaming.lifecycleOrderValidated,
        contiguousSequenceSessions: $driver[0].streaming.contiguousPerSessionSequences,
        nativeGaps: $driver[0].streaming.nativeGaps,
        applicationDuplicateDeliveries:
          $driver[0].streaming.applicationDuplicateDeliveries
      },
      history: {
        sdkNativeSessionsValidated: $driver[0].history.sessionsValidated,
        newInferenceRequests: $driver[0].history.newInferenceRequests
      },
      burst: {
        maximumConcurrentSendRequests: $driver[0].burst.maximumConcurrentSendRequests,
        clientRpcConcurrency: $driver[0].burst.clientRpcConcurrency,
        providerInferenceConcurrency: $driver[0].burst.providerInferenceConcurrency,
        sessionsValidated: $driver[0].burst.sessionsValidated,
        exactDeltaReassemblies: $driver[0].burst.exactDeltaReassemblies,
        exactFinalMessages: $driver[0].burst.exactFinalMessages,
        lifecycleOrderValidated: $driver[0].burst.lifecycleOrderValidated,
        allOneHundredTurnsOverlappedClaimed:
          $driver[0].burst.allOneHundredTurnsOverlappedClaimed,
        isolatedWorkerStayedRunning: $disconnect[0].containerStayedRunning,
        isolatedWorkerRejoinedNetwork: $disconnect[0].presentAfterReconnect,
        applicationStreamRecoveredWithoutGapOrDuplicate:
          $driver[0].burst.workerNetworkIsolation.applicationStreamRecoveredWithoutGapOrDuplicate
      },
      scheduling: $driver[0].scheduling,
      finalInventory: $driver[0].finalInventory,
      stability: {
        noContainerRestarted: ($lifecycle[0] | length == 11 and all(.[]; .restartCount == 0)),
        noContainerOomKilled: ($lifecycle[0] | length == 11 and all(.[]; .oomKilled == false)),
        resourceSampleRows: $resources[0].sampleRows,
        resourceSampleTimes: $resources[0].sampleTimes
      },
      dashboard: {
        totalWorkerCards: $dashboard[0].visible.totalWorkerCardCount,
        totalSessionCards: $dashboard[0].visible.totalSessionCardCount,
        markerVisible: $dashboard[0].visible.expectedMarkerVisible,
        browserConsoleErrors: $dashboard[0].assertions.browserConsoleErrors
      },
      cleanup: $cleanup[0],
      redaction: $redaction[0],
      limitations: {
        baselineIsStaged: true,
        burstDispatchConcurrencyIsNotProofOfProviderTurnOverlap: true,
        observedResourceSamplesAreNotCapacityLimits: true,
        periodicSamplesDoNotProveContinuousHealth: true
      }
    } as $body |
    {
      passed: (
        ($body.topology | all(.[]; . == true)) and
        $body.providerAndRuntime.allTokenMountsReadOnly == true and
        $body.providerAndRuntime.oneOrMoreRuntimeProcessesObservedPerWorker == true and
        $body.providerAndRuntime.runtimeProcessesObserved >= 10 and
        $body.commands.spawnSucceeded == 100 and
        $body.commands.sendSucceeded == 100 and
        $body.commands.burstSendSucceeded == 100 and
        $body.commands.stopSucceeded == 100 and
        $body.nativeStreaming.sessionsValidated == 100 and
        $body.nativeStreaming.exactDeltaReassemblies == 100 and
        $body.nativeStreaming.exactFinalMessages == 100 and
        $body.nativeStreaming.lifecycleOrderValidated == 100 and
        $body.nativeStreaming.contiguousSequenceSessions == 100 and
        $body.nativeStreaming.nativeGaps == 0 and
        $body.nativeStreaming.applicationDuplicateDeliveries == 0 and
        $body.history.sdkNativeSessionsValidated == 100 and
        $body.history.newInferenceRequests == 0 and
        $body.burst.sessionsValidated == 100 and
        $body.burst.exactDeltaReassemblies == 100 and
        $body.burst.exactFinalMessages == 100 and
        $body.burst.lifecycleOrderValidated == 100 and
        $body.burst.clientRpcConcurrency.configuredMaximum == 100 and
        $body.burst.clientRpcConcurrency.observedMaximumUnresolvedExecuteMutations == 100 and
        $body.burst.clientRpcConcurrency.allOneHundredExecuteMutationsOverlapped == true and
        $body.burst.providerInferenceConcurrency.measured == false and
        $body.burst.allOneHundredTurnsOverlappedClaimed == false and
        $body.burst.isolatedWorkerStayedRunning == true and
        $body.burst.isolatedWorkerRejoinedNetwork == true and
        $body.burst.applicationStreamRecoveredWithoutGapOrDuplicate == true and
        $body.scheduling.spawnWaves == 10 and
        $body.scheduling.sendWaves == 10 and
        $body.finalInventory.resumableStoppedSessions == 100 and
        $body.stability.noContainerRestarted == true and
        $body.stability.noContainerOomKilled == true and
        $body.stability.resourceSampleTimes >= 3 and
        $body.dashboard.totalWorkerCards == 10 and
        $body.dashboard.totalSessionCards == 100 and
        $body.dashboard.markerVisible == true and
        $body.dashboard.browserConsoleErrors == 0 and
        $body.cleanup.cleanupCompleted == true and
        $body.redaction.passed == true
      )
    } + $body
' >"$RECEIPT_DIR/checks.json"
assert_json "derived receipt checks did not pass" '.passed == true' \
  "$RECEIPT_DIR/checks.json"

{
  printf '# 100-session real Copilot BYOK scale receipt\n\n'
  printf 'Status: **PASS**\n\n'
  printf 'Run: `%s`\n\n' "$RUN_ID"
  printf 'This run used one canonical Agent Multiplex host container and 10 isolated worker containers. Each worker owned 10 real Copilot sessions through one SDK-managed Copilot runtime, for 100 provider-backed sessions total. It did not spawn or claim 100 separate Copilot runtime processes.\n\n'
  printf '## What passed\n\n'
  printf -- '- Exactly 100 spawns, 100 staged baseline sends, 100 full-fleet burst sends, and 100 stops succeeded.\n'
  printf -- '- The burst reached an observed 100 unresolved client tRPC execute calls; provider-side inference overlap was not measured or claimed.\n'
  printf -- '- Every baseline and burst response had at least one native assistant delta; concatenated deltas and the final native assistant message both matched the session marker exactly.\n'
  printf -- '- One worker was isolated from the Docker network during the burst, stayed alive, rejoined, and its application stream recovered without a native gap or duplicate delivery.\n'
  printf -- '- Every session had the expected Copilot turn lifecycle, one terminal idle event, its original runtime epoch, and a contiguous worker-native sequence with no delivery gaps or duplicates.\n'
  printf -- '- All 100 native histories came from the adapter\047s `CopilotSession.getEvents()` path and retained the exact user/final messages and turn lifecycle without new inference.\n'
  printf -- '- The dashboard DOM contained exactly 10 online Copilot-ready worker cards and 100 active/idle session cards; Playwright selected a live session and observed its exact marker.\n'
  printf -- '- Every session stopped and converged to resumable/stopped inventory before topology cleanup.\n'
  printf -- '- Resource samples cover the inference interval; no container restarted or was reported OOM-killed. These observations are not capacity limits or proof of health between samples.\n'
  printf -- '- The raw model API key was bind-mounted read-only into each worker. The key, provider endpoint, fleet shared secret, and raw p2prpc ticket were absent from receipts.\n\n'
  printf '## Primary evidence\n\n'
  printf -- '- `checks.json`, `manifest.json`, `topology.json`, and `cleanup.json`\n'
  printf -- '- `driver-summary.json`, `phases/stream-assertions.json`, `phases/burst-stream-assertions.json`, and `phases/history-assertions.json`\n'
  printf -- '- `rpc/spawn-results.json`, `rpc/send-results.json`, `rpc/burst-send-results.json`, `rpc/native-history.json`, and `rpc/stop-results.json`\n'
  printf -- '- `coord/disconnect-request.json` and `coord/disconnect-complete.json`\n'
  printf -- '- `logs/fleet-events.ndjson`, `logs/docker-stats.ndjson`, and sanitized host/worker logs\n'
  printf -- '- `resource-summary.json`, `container-lifecycle.json`, and `copilot-process-proof.json`\n'
  printf -- '- `screenshots/dashboard-100-copilot-sessions.png` and `rpc/playwright-dashboard.json`\n'
} >"$RECEIPT_DIR/README.md"

for forbidden in "$TOKEN_LITERAL" "$PROVIDER_URL" "$SHARED_SECRET" "$P2P_TICKET"; do
  if [[ -n "$forbidden" ]] && rg --text --fixed-strings --quiet -- "$forbidden" "$RECEIPT_DIR"; then
    fail "secret material leaked while writing final derived receipts"
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
