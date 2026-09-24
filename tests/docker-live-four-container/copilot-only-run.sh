#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/../.." && pwd)
DOCKER_NPMRC=${AGENT_MULTIPLEX_DOCKER_NPMRC:-}
SOURCE_CONFIG=${AGENT_MULTIPLEX_COPILOT_ONLY_SOURCE_CONFIG:-"${HOME}/.codex/config.toml"}
SOURCE_KEY=${AGENT_MULTIPLEX_COPILOT_ONLY_SOURCE_KEY:-"${HOME}/.codex/codex-lb-api-key"}
RECEIPT_ROOT=${AGENT_MULTIPLEX_COPILOT_ONLY_RECEIPT_ROOT:-"$REPO_ROOT/receipts/protocol-v6-copilot-only"}
TIMEOUT_MS=${AGENT_MULTIPLEX_COPILOT_ONLY_TIMEOUT_MS:-600000}
LIVE_OPT_IN=${AGENT_MULTIPLEX_COPILOT_ONLY_RUN:-}
LOCAL_BIND=${AGENT_MULTIPLEX_COPILOT_ONLY_LOCAL_BIND:-0}
ISOLATED_SUBNET=${AGENT_MULTIPLEX_COPILOT_ONLY_SUBNET:-10.250.254.0/28}
BUILD_MODE=container-build
MODEL=gpt-6-luna

note() { printf '[copilot-only-v6] %s\n' "$*" >&2; }
fail() { note "FAILED: $*"; return 1; }
random_hex() { node -e 'process.stdout.write(require("node:crypto").randomBytes(6).toString("hex"))'; }

static_validation() {
  bash -n "$SCRIPT_DIR/copilot-only-run.sh"
  node --check "$SCRIPT_DIR/copilot-only-driver.mjs"
  node --check "$SCRIPT_DIR/copilot-only-provider-proxy.mjs"
  node --check "$SCRIPT_DIR/copilot-only-static.mjs"
  node "$SCRIPT_DIR/copilot-only-static.mjs"
}

case ${1:-} in
  --static)
    [[ $# == 1 ]] || { echo "usage: $0 --static" >&2; exit 2; }
    static_validation
    exit 0
    ;;
  "") ;;
  *) echo "usage: $0 [--static]" >&2; exit 2 ;;
esac

# Running the live branch is deliberately explicit: it sends exactly one
# synthetic prompt to the real provider. Static validation never reaches here.
if [[ "$LIVE_OPT_IN" != I_UNDERSTAND_ONE_GPT_6_LUNA_REQUEST ]]; then
  echo "copilot-only-v6: refusing live run without AGENT_MULTIPLEX_COPILOT_ONLY_RUN=I_UNDERSTAND_ONE_GPT_6_LUNA_REQUEST" >&2
  exit 2
fi
if [[ ! "$TIMEOUT_MS" =~ ^[1-9][0-9]*$ ]]; then
  echo "copilot-only-v6: timeout must be a positive integer" >&2
  exit 2
fi
[[ "$LOCAL_BIND" == 0 || "$LOCAL_BIND" == 1 ]] || { echo "copilot-only-v6: LOCAL_BIND must be 0 or 1" >&2; exit 2; }
for tool in docker git jq node npm curl sha256sum awk perl rg timeout find ip systemctl systemd-run; do
  command -v "$tool" >/dev/null 2>&1 || { echo "copilot-only-v6: required tool '$tool' is unavailable" >&2; exit 1; }
done
static_validation >/dev/null
SOURCE_COMMIT=$(git -C "$REPO_ROOT" rev-parse --verify 'HEAD^{commit}')
[[ "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo "copilot-only-v6: cannot resolve HEAD" >&2; exit 1; }
# Fence the live source while allowing the parent's explicitly unrelated tmp/
# scratch. `--static` exits before this cleanliness check.
git -C "$REPO_ROOT" diff --quiet --exit-code HEAD -- . ':(exclude)tmp/**' || {
  echo "copilot-only-v6: tracked source outside tmp/ differs from HEAD" >&2; exit 1;
}
if git -C "$REPO_ROOT" status --porcelain=v1 --untracked-files=all -- . ':(exclude)tmp/**' | rg -q '.'; then
  echo "copilot-only-v6: untracked source outside tmp/ is present" >&2
  exit 1
fi
if [[ -z "$DOCKER_NPMRC" ]]; then DOCKER_NPMRC=$(npm config get userconfig); fi
if [[ "$LOCAL_BIND" == 0 ]]; then
  [[ -r "$DOCKER_NPMRC" ]] || { echo "copilot-only-v6: readable npm user config required" >&2; exit 1; }
fi
[[ -r "$SOURCE_CONFIG" ]] || { echo "copilot-only-v6: provider config unreadable" >&2; exit 1; }
[[ -r "$SOURCE_KEY" ]] || { echo "copilot-only-v6: provider key unreadable" >&2; exit 1; }

RUN_ID=${AGENT_MULTIPLEX_COPILOT_ONLY_RUN_ID:-"$(date -u +%Y%m%dT%H%M%SZ)-$(random_hex)"}
[[ "$RUN_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$ ]] || { echo "copilot-only-v6: invalid run ID" >&2; exit 2; }
SUFFIX=$(printf '%s' "$RUN_ID" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9' | tail -c 22)
CONTROL_CONTAINER="multiplex-copilot-only-control-$SUFFIX"
RUNTIME_CONTAINER="multiplex-copilot-only-runtime-$SUFFIX"
GATEWAY_CONTAINER="multiplex-copilot-only-gateway-$SUFFIX"
NATIVE_BUILD_CONTAINER="multiplex-copilot-only-native-build-$SUFFIX"
NETWORK_NAME="multiplex-copilot-only-net-$SUFFIX"
IMAGE_TAG="agent-multiplex-copilot-only:$SUFFIX"
RUNTIME_NAME="copilot-only-$SUFFIX"
PROXY_UNIT="agent-multiplex-copilot-only-provider-$SUFFIX.service"
RECEIPT_DIR="$RECEIPT_ROOT/$RUN_ID"
[[ ! -e "$RECEIPT_DIR" ]] || { echo "copilot-only-v6: receipt exists" >&2; exit 1; }
mkdir -p "$RECEIPT_DIR/logs" "$RECEIPT_DIR/rpc"
RUNTIME_DIR=$(mktemp -d "${TMPDIR:-/tmp}/agent-multiplex-copilot-only.XXXXXXXX")
mkdir -p "$RUNTIME_DIR/control-state" "$RUNTIME_DIR/runtime-state" "$RUNTIME_DIR/gateway-state" \
  "$RUNTIME_DIR/copilot-home" "$RUNTIME_DIR/workspace"
chmod 700 "$RUNTIME_DIR" "$RUNTIME_DIR"/*
SHARED_SECRET=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(48).toString("base64url"))')
ACCESS_TOKEN=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(48).toString("base64url"))')
printf '%s\n' "$ACCESS_TOKEN" >"$RUNTIME_DIR/access-token"
chmod 600 "$RUNTIME_DIR/access-token"

CONTROL_ID= RUNTIME_ID= GATEWAY_ID= NATIVE_BUILD_ID= NETWORK_ID= IMAGE_ID=
IMAGE_OWNED=1
LOCAL_RUN_ARGS=()
CONTROL_TICKET= PROVIDER_URL= PROVIDER_ORIGIN= PROXIED_PROVIDER_URL= API_KEY_LITERAL=
PROXY_READY="$RUNTIME_DIR/provider-proxy-ready.json"
PROXY_STARTED=0
CLEANUP_SAFE=1
COMPLETED=0

redact_stream() {
  AM_SHARED="$SHARED_SECRET" AM_ACCESS="$ACCESS_TOKEN" AM_TICKET="$CONTROL_TICKET" \
  AM_KEY="$API_KEY_LITERAL" AM_PROVIDER="$PROVIDER_URL" AM_PROVIDER_ORIGIN="$PROVIDER_ORIGIN" \
  AM_PROXY="$PROXIED_PROVIDER_URL" perl -0pe '
    BEGIN { @pairs = (
      [$ENV{AM_SHARED}//"", "<redacted-shared-secret>"],
      [$ENV{AM_ACCESS}//"", "<redacted-access-token>"],
      [$ENV{AM_TICKET}//"", "<redacted-p2p-ticket>"],
      [$ENV{AM_KEY}//"", "<redacted-provider-key>"],
      [$ENV{AM_PROVIDER}//"", "<redacted-provider-endpoint>"],
      [$ENV{AM_PROVIDER_ORIGIN}//"", "<redacted-provider-origin>"],
      [$ENV{AM_PROXY}//"", "<redacted-provider-relay-endpoint>"]
    ); }
    for $pair (@pairs) { ($v,$r)=@$pair; s/\Q$v\E/$r/g if length($v); }
    s/p2prpc3\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{80,}/<redacted-p2p-ticket>/g;
  '
}
secret_values_present_in_receipt() {
  local value
  for value in "$SHARED_SECRET" "$ACCESS_TOKEN" "$CONTROL_TICKET" "$API_KEY_LITERAL" \
    "$PROVIDER_URL" "$PROVIDER_ORIGIN" "$PROXIED_PROVIDER_URL"; do
    if [[ -n "$value" ]] && rg --text --fixed-strings --quiet -- "$value" "$RECEIPT_DIR"; then return 0; fi
  done
  rg --text --quiet 'p2prpc3\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{80,}' "$RECEIPT_DIR"
}
capture_log() {
  local name=$1 label=$2 raw
  raw="$RUNTIME_DIR/$label.raw.log"
  docker container inspect "$name" >/dev/null 2>&1 || return 0
  docker logs "$name" >"$raw" 2>&1 || true
  awk 'redact {print "<redacted-p2p-ticket>"; redact=0; next} /^P2P ticket \(/ {print; redact=1; next} {print}' "$raw" \
    | redact_stream >"$RECEIPT_DIR/logs/$label.log"
}
OBSERVATION=unknown
OBSERVED_ID=
observe_docker_resource() {
  local kind=$1 name=$2 listing candidate
  OBSERVATION=unknown; OBSERVED_ID=
  case "$kind" in
    container)
      if OBSERVED_ID=$(docker container inspect --format '{{.Id}}' "$name" 2>/dev/null); then OBSERVATION=present; return; fi
      listing=$(docker container ls --all --format '{{.Names}}' 2>/dev/null) || return ;;
    network)
      if OBSERVED_ID=$(docker network inspect --format '{{.Id}}' "$name" 2>/dev/null); then OBSERVATION=present; return; fi
      listing=$(docker network ls --format '{{.Name}}' 2>/dev/null) || return ;;
    image)
      if OBSERVED_ID=$(docker image inspect --format '{{.Id}}' "$name" 2>/dev/null); then OBSERVATION=present; return; fi
      listing=$(docker image ls --format '{{.Repository}}:{{.Tag}}' 2>/dev/null) || return ;;
    *) return ;;
  esac
  OBSERVATION=absent
  while IFS= read -r candidate; do
    if [[ "$candidate" == "$name" ]]; then OBSERVATION=unknown; return; fi
  done <<<"$listing"
}
remove_container_fenced() {
  local name=$1 expected=$2
  [[ -n "$expected" ]] || return 0
  observe_docker_resource container "$name"
  if [[ "$OBSERVATION" == absent ]]; then return 0; fi
  if [[ "$OBSERVATION" != present ]]; then note "cleanup could not inspect container $name"; CLEANUP_SAFE=0; return 0; fi
  if [[ "$OBSERVED_ID" != "$expected" ]]; then note "cleanup identity mismatch for container $name"; CLEANUP_SAFE=0; return 0; fi
  docker rm --force -- "$name" >/dev/null || CLEANUP_SAFE=0
}
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  capture_log "$CONTROL_CONTAINER" control-node
  capture_log "$RUNTIME_CONTAINER" copilot-runtime
  capture_log "$GATEWAY_CONTAINER" gateway
  capture_log "$NATIVE_BUILD_CONTAINER" native-build
  remove_container_fenced "$NATIVE_BUILD_CONTAINER" "$NATIVE_BUILD_ID"
  remove_container_fenced "$GATEWAY_CONTAINER" "$GATEWAY_ID"
  remove_container_fenced "$RUNTIME_CONTAINER" "$RUNTIME_ID"
  remove_container_fenced "$CONTROL_CONTAINER" "$CONTROL_ID"
  if (( PROXY_STARTED == 1 )); then
    local exec_start load_state
    load_state=$(systemctl --user show --property=LoadState --value "$PROXY_UNIT" 2>/dev/null)
    exec_start=$(systemctl --user show --property=ExecStart --value "$PROXY_UNIT" 2>/dev/null)
    if [[ "$load_state" == not-found ]]; then :
    elif [[ "$exec_start" == *"$SCRIPT_DIR/copilot-only-provider-proxy.mjs"* && "$exec_start" == *"$PROXY_READY"* ]]; then
      systemctl --user stop "$PROXY_UNIT" >/dev/null 2>&1 || CLEANUP_SAFE=0
      systemctl --user reset-failed "$PROXY_UNIT" >/dev/null 2>&1 || true
    else
      note "cleanup identity mismatch for provider relay"; CLEANUP_SAFE=0
    fi
  fi
  if [[ -n "$NETWORK_ID" ]]; then
    observe_docker_resource network "$NETWORK_NAME"
    if [[ "$OBSERVATION" == absent ]]; then :
    elif [[ "$OBSERVATION" != present ]]; then note "cleanup could not inspect network $NETWORK_NAME"; CLEANUP_SAFE=0
    elif [[ "$OBSERVED_ID" == "$NETWORK_ID" ]]; then docker network rm -- "$NETWORK_NAME" >/dev/null || CLEANUP_SAFE=0
    else note "cleanup identity mismatch for network $NETWORK_NAME"; CLEANUP_SAFE=0; fi
  fi
  if (( IMAGE_OWNED == 1 )) && [[ -n "$IMAGE_ID" ]]; then
    observe_docker_resource image "$IMAGE_TAG"
    if [[ "$OBSERVATION" == absent ]]; then :
    elif [[ "$OBSERVATION" != present ]]; then note "cleanup could not inspect image $IMAGE_TAG"; CLEANUP_SAFE=0
    elif [[ "$OBSERVED_ID" == "$IMAGE_ID" ]]; then docker image rm -- "$IMAGE_TAG" >/dev/null || CLEANUP_SAFE=0
    else note "cleanup identity mismatch for image $IMAGE_TAG"; CLEANUP_SAFE=0; fi
  fi
  if (( CLEANUP_SAFE == 1 )) && [[ -d "$RUNTIME_DIR" && ! -L "$RUNTIME_DIR" && "$(basename "$RUNTIME_DIR")" == agent-multiplex-copilot-only.* ]]; then
    find "$RUNTIME_DIR" -mindepth 1 -depth -delete && rmdir "$RUNTIME_DIR" || CLEANUP_SAFE=0
  else
    note "preserving runtime directory: $RUNTIME_DIR"
  fi
  jq -n --argjson completed "$COMPLETED" --argjson cleanupSafe "$CLEANUP_SAFE" \
    --arg completedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{testCompleted:($completed == 1),cleanupIdentityFencesHeld:($cleanupSafe == 1),completedAt:$completedAt}' \
    >"$RECEIPT_DIR/cleanup.json" 2>/dev/null || true
  if secret_values_present_in_receipt; then
    note "receipt secret scan failed; deleting unsafe receipt files"
    find "$RECEIPT_DIR" -mindepth 1 -type f -delete 2>/dev/null || true
    status=1
  fi
  (( status == 0 && COMPLETED == 1 && CLEANUP_SAFE == 1 )) || status=1
  exit "$status"
}
trap cleanup EXIT INT TERM

wait_for_log() {
  local container=$1 pattern=$2 description=$3
  for attempt in $(seq 1 120); do
    docker logs "$container" 2>&1 | rg -q "$pattern" && return 0
    if ! docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null | rg -q '^true$'; then
      docker logs "$container" 2>&1 | redact_stream >&2; fail "$description exited"
    fi
    sleep 0.5
  done
  fail "timed out waiting for $description"
}

if ! API_KEY_LITERAL=$(node -e '
  const fs=require("node:fs"); const raw=fs.readFileSync(process.argv[1],"utf8");
  if(!/^[^\r\n]+(?:\r?\n)?$/.test(raw)) process.exit(1);
  process.stdout.write(raw.replace(/\r?\n$/, ""));
' "$SOURCE_KEY"); then fail "provider key must be exactly one non-empty line"; fi
(( ${#API_KEY_LITERAL} >= 16 )) || fail "provider key is unexpectedly short"
PROVIDER_URL=$(awk '
  /^\[model_providers\.codex-lb\]$/ {inside=1; next}
  inside && /^\[/ {exit}
  inside && /^[[:space:]]*base_url[[:space:]]*=/ {sub(/^[^=]*=[[:space:]]*/,""); gsub(/^"|"$/,""); print; exit}
' "$SOURCE_CONFIG")
[[ -n "$PROVIDER_URL" ]] || fail "codex-lb base_url not found"
node -e 'const u=new URL(process.argv[1]); if(!/^https?:$/.test(u.protocol)||u.username||u.password||u.search||u.hash) process.exit(1)' "$PROVIDER_URL" \
  || fail "provider base URL must be credential-free HTTP(S) without query or fragment"
PROVIDER_ORIGIN=$(node -e 'process.stdout.write(new URL(process.argv[1]).origin)' "$PROVIDER_URL")

if [[ "$LOCAL_BIND" == 1 ]]; then
  # The host's node-pty binary targets Nix glibc 2.42, not Debian glibc 2.36.
  # Compile only that addon against the pinned container's Node headers in an
  # owned overlay. Source and all remaining dependencies stay read-only; no
  # GitHub Packages credential or copy of the production Copilot home is used.
  note "building credential-free native toolchain image for read-only checkout $SOURCE_COMMIT"
  docker build --progress=plain --file "$SCRIPT_DIR/copilot-only-local-Dockerfile" \
    --tag "$IMAGE_TAG" "$REPO_ROOT" >"$RECEIPT_DIR/logs/docker-build.log" 2>&1 \
    || { tail -n 60 "$RECEIPT_DIR/logs/docker-build.log" >&2; fail "local toolchain build failed"; }
  IMAGE_ID=$(docker image inspect --format '{{.Id}}' "$IMAGE_TAG")
  BUILD_MODE=read-only-local-bind-debian-pty
  CA_FILE=$(readlink -f /etc/ssl/certs/ca-certificates.crt)
  [[ -s "$CA_FILE" ]] || fail "host CA bundle unavailable for native Copilot TLS initialization"
  for entry in apps/control-node/dist/main.js apps/runtime-node/dist/main.js apps/gateway/dist/main.js; do
    [[ -s "$REPO_ROOT/$entry" ]] || fail "build local source before LOCAL_BIND: $entry"
  done
  NODE_PTY_DIR="$RUNTIME_DIR/node-pty"
  mkdir -m 700 "$NODE_PTY_DIR"
  cp -a "$REPO_ROOT/node_modules/node-pty/." "$NODE_PTY_DIR/"
  LOCAL_RUN_ARGS=(--mount "type=bind,src=$REPO_ROOT,dst=/opt/src/agent-multiplex,readonly"
    --mount "type=bind,src=$CA_FILE,dst=/run/ca-bundle.pem,readonly"
    --workdir /opt/src/agent-multiplex --env SSL_CERT_FILE=/run/ca-bundle.pem)
  note "rebuilding only node-pty under the disposable Debian runtime"
  docker run --detach --name "$NATIVE_BUILD_CONTAINER" --network none --init --user 1000:100 \
    --read-only --cap-drop ALL --security-opt no-new-privileges \
    "${LOCAL_RUN_ARGS[@]}" \
    --mount "type=bind,src=$NODE_PTY_DIR,dst=/opt/src/agent-multiplex/node_modules/node-pty" \
    --tmpfs /tmp:rw,exec,nosuid,nodev,mode=1777 --env HOME=/tmp \
    "$IMAGE_TAG" sh -c 'cd node_modules/node-pty && node ../node-gyp/bin/node-gyp.js rebuild --nodedir=/usr/local && cd ../.. && node -e "require(\"node-pty\")"' >/dev/null
  NATIVE_BUILD_ID=$(docker container inspect --format '{{.Id}}' "$NATIVE_BUILD_CONTAINER")
  BUILD_EXIT=$(docker wait "$NATIVE_BUILD_CONTAINER")
  if [[ "$BUILD_EXIT" != 0 ]]; then
    docker logs "$NATIVE_BUILD_CONTAINER" 2>&1 | tail -n 60 >&2
    fail "disposable node-pty rebuild failed"
  fi
  remove_container_fenced "$NATIVE_BUILD_CONTAINER" "$NATIVE_BUILD_ID"
  [[ "$CLEANUP_SAFE" == 1 ]] || fail "native build container cleanup identity failed"
  NATIVE_BUILD_ID=
  LOCAL_RUN_ARGS+=(--mount "type=bind,src=$NODE_PTY_DIR,dst=/opt/src/agent-multiplex/node_modules/node-pty,readonly")
else
  note "building fenced protocol-v6 Copilot-only image at $SOURCE_COMMIT"
  docker build --progress=plain --secret "id=npmrc,src=$DOCKER_NPMRC" \
    --file "$SCRIPT_DIR/copilot-only-Dockerfile" --tag "$IMAGE_TAG" "$REPO_ROOT" \
    >"$RECEIPT_DIR/logs/docker-build.log" 2>&1 || { tail -n 80 "$RECEIPT_DIR/logs/docker-build.log" >&2; fail "image build failed"; }
  IMAGE_ID=$(docker image inspect --format '{{.Id}}' "$IMAGE_TAG")
fi
# Docker's automatic pools can be exhausted on a busy NAS. Validate the
# explicitly bounded private /28 against both Docker IPAM and active host
# routes; never prune an existing network to make room for this test.
ISOLATED_SUBNET="$ISOLATED_SUBNET" node <<'NODE'
const {execFileSync}=require('node:child_process');
const cidr=process.env.ISOLATED_SUBNET;
const asRange=value=>{
  const [address,bits]=value.split('/'),parts=address.split('.').map(Number),prefix=bits===undefined?32:Number(bits);
  if(parts.length!==4||parts.some(part=>!Number.isInteger(part)||part<0||part>255)||!Number.isInteger(prefix)||prefix<0||prefix>32)throw Error('Invalid IPv4 route');
  const ip=parts.reduce((n,part)=>((n<<8)>>>0)+part,0)>>>0;
  const mask=prefix===0?0:(0xffffffff<<(32-prefix))>>>0;
  return {start:(ip&mask)>>>0,end:((ip&mask)|(~mask>>>0))>>>0,prefix};
};
const candidate=asRange(cidr);
if(candidate.prefix!==28||candidate.start!==asRange('10.250.254.0/28').start&&!(candidate.start>=asRange('10.250.0.0/16').start&&candidate.end<=asRange('10.250.0.0/16').end))throw Error('Test subnet must be a private 10.250.0.0/16 /28');
const ids=execFileSync('docker',['network','ls','-q'],{encoding:'utf8'}).trim().split(/\s+/).filter(Boolean);
const networks=ids.length?JSON.parse(execFileSync('docker',['network','inspect',...ids],{encoding:'utf8'})):[];
const routes=JSON.parse(execFileSync('ip',['-j','-4','route','show','table','all'],{encoding:'utf8'}));
const existing=[...networks.flatMap(net=>(net.IPAM?.Config??[]).map(row=>row.Subnet).filter(Boolean)),...routes.map(route=>route.dst).filter(dst=>dst&&dst!=='default')];
for(const raw of existing){let range;try{range=asRange(raw)}catch{continue}if(candidate.start<=range.end&&range.start<=candidate.end)throw Error('Test subnet overlaps an existing Docker network or host route')}
NODE
docker network create --driver bridge --subnet "$ISOLATED_SUBNET" "$NETWORK_NAME" >/dev/null
NETWORK_ID=$(docker network inspect --format '{{.Id}}' "$NETWORK_NAME")
BRIDGE_HOST=$(docker network inspect --format '{{(index .IPAM.Config 0).Gateway}}' "$NETWORK_NAME")
[[ -n "$BRIDGE_HOST" ]] || fail "isolated bridge has no gateway"

systemd-run --user --quiet --collect --unit "$PROXY_UNIT" \
  --property Type=simple --property KillMode=control-group --property NoNewPrivileges=yes --property UMask=0077 \
  --property "StandardOutput=append:$RUNTIME_DIR/provider-proxy.log" \
  --property "StandardError=append:$RUNTIME_DIR/provider-proxy.log" \
  --setenv "AGENT_MULTIPLEX_COPILOT_ONLY_PROXY_UPSTREAM=$PROVIDER_URL" \
  "$(command -v node)" "$SCRIPT_DIR/copilot-only-provider-proxy.mjs" "$BRIDGE_HOST" "$PROXY_READY"
PROXY_STARTED=1
for attempt in $(seq 1 100); do
  [[ -s "$PROXY_READY" ]] && break
  systemctl --user is-active --quiet "$PROXY_UNIT" || fail "provider relay exited"
  (( attempt < 100 )) || fail "provider relay did not become ready"
  sleep 0.1
done
PROXY_PORT=$(jq -er '.port | select(type=="number" and .>=1 and .<=65535)' "$PROXY_READY")
PROVIDER_PATH=$(node -e 'process.stdout.write(new URL(process.argv[1]).pathname)' "$PROVIDER_URL")
PROXIED_PROVIDER_URL="http://$BRIDGE_HOST:$PROXY_PORT$PROVIDER_PATH"

note "starting isolated authority"
docker run --detach --name "$CONTROL_CONTAINER" --hostname copilot-only-control --network "$NETWORK_NAME" \
  --init --user 1000:100 --read-only --cap-drop ALL --security-opt no-new-privileges \
  "${LOCAL_RUN_ARGS[@]}" \
  --mount type=bind,src="$RUNTIME_DIR/control-state",dst=/state --tmpfs /tmp:rw,nosuid,nodev,mode=1777 \
  --env AGENT_MULTIPLEX_SHARED_SECRET="$SHARED_SECRET" \
  --env AGENT_MULTIPLEX_CONTROL_NODE_NAME=copilot-only-authority \
  --env AGENT_MULTIPLEX_CONTROL_NODE_STATE=/state/control.sqlite \
  --env AGENT_MULTIPLEX_CONTROL_NODE_IDENTITY=/state/control.identity \
  --env AGENT_MULTIPLEX_CONTROL_NODE_HTTP_BIND=127.0.0.1 --env AGENT_MULTIPLEX_CONTROL_NODE_HTTP_PORT=4317 \
  --env AGENT_MULTIPLEX_CONTROL_NODE_P2P_BIND=0.0.0.0:49117 \
  --env AGENT_MULTIPLEX_CONTROL_NODE_ALLOW_RUNTIME_NODE_ENROLLMENT=1 \
  --env AGENT_MULTIPLEX_CONTROL_NODE_ALLOW_ACCESS_GATEWAY_ENROLLMENT=1 \
  --env 'AGENT_MULTIPLEX_CONTROL_NODE_ACCESS_GATEWAY_SCOPES=["read","agent-launch","agent-control"]' \
  --env AGENT_MULTIPLEX_CONTROL_NODE_RECONNECT_MAX_MS=1000 \
  "$IMAGE_TAG" node apps/control-node/dist/main.js >/dev/null
CONTROL_ID=$(docker container inspect --format '{{.Id}}' "$CONTROL_CONTAINER")
wait_for_log "$CONTROL_CONTAINER" '^P2P ticket \(' 'control node'
CONTROL_LOG=$(docker logs "$CONTROL_CONTAINER" 2>&1)
CONTROL_ENDPOINT_ID=$(sed -n 's/^P2P endpoint:[[:space:]]*//p' <<<"$CONTROL_LOG" | tail -n 1)
CONTROL_TICKET=$(awk '/^P2P ticket \(/ {getline; print; exit}' <<<"$CONTROL_LOG")
[[ "$CONTROL_ENDPOINT_ID" =~ ^[a-z2-7]{52}$ && -n "$CONTROL_TICKET" && ! "$CONTROL_TICKET" =~ [[:space:]] ]] \
  || fail "control node emitted invalid attachment material"

note "starting one real Copilot SDK runtime; no Codex runtime is created"
COPILOT_MODELS=$(jq -cn --arg model "$MODEL" '[$model]')
docker run --detach --name "$RUNTIME_CONTAINER" --hostname copilot-only-runtime --network "$NETWORK_NAME" \
  --init --user 1000:100 --read-only --cap-drop ALL --security-opt no-new-privileges \
  "${LOCAL_RUN_ARGS[@]}" \
  --mount type=bind,src="$RUNTIME_DIR/runtime-state",dst=/state \
  --mount type=bind,src="$RUNTIME_DIR/copilot-home",dst=/home/arduano/.copilot \
  --mount type=bind,src="$RUNTIME_DIR/workspace",dst=/workspace/project \
  --mount type=bind,src="$SOURCE_KEY",dst=/run/secrets/codex-lb-api-key,readonly \
  --tmpfs /tmp:rw,exec,nosuid,nodev,mode=1777 \
  --env HOME=/home/arduano --env XDG_CACHE_HOME=/tmp/cache \
  --env AGENT_MULTIPLEX_SHARED_SECRET="$SHARED_SECRET" \
  --env AGENT_MULTIPLEX_CONTROL_NODE_ENDPOINT_ID="$CONTROL_ENDPOINT_ID" \
  --env AGENT_MULTIPLEX_CONTROL_NODE_TICKET="$CONTROL_TICKET" \
  --env 'AGENT_MULTIPLEX_RUNTIME_NODE_ALLOWED_ROOTS=["/workspace/project"]' \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_STATE_DIR=/state/runtime-node \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_NAME="$RUNTIME_NAME" \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_HARNESSES=copilot \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_HEARTBEAT_MS=1000 \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_INVENTORY_REFRESH_MS=3000 \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_RECONNECT_MAX_MS=1000 \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_HOME=/home/arduano/.copilot \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_LOG_LEVEL=none \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_TYPE=openai \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_BASE_URL="$PROXIED_PROVIDER_URL" \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_WIRE_API=responses \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_TRANSPORT=http \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_MODEL="$MODEL" \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_MODELS="$COPILOT_MODELS" \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_API_KEY_FILE=/run/secrets/codex-lb-api-key \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_EXPERIMENTAL_UI_SERVER=0 \
  "$IMAGE_TAG" node apps/runtime-node/dist/main.js >/dev/null
RUNTIME_ID=$(docker container inspect --format '{{.Id}}' "$RUNTIME_CONTAINER")
wait_for_log "$RUNTIME_CONTAINER" '^Connected to control node ' 'Copilot runtime'

docker inspect "$RUNTIME_CONTAINER" | jq '
  .[0] as $c | ($c.Mounts | map(select(.Destination=="/run/secrets/codex-lb-api-key"))[0]) as $key |
  {readOnlyKeyMount:($key.Type=="bind" and ($key.RW|not)),isolatedCopilotHome:true,
   onlyHarness:(($c.Config.Env|map(select(startswith("AGENT_MULTIPLEX_RUNTIME_NODE_HARNESSES="))))==["AGENT_MULTIPLEX_RUNTIME_NODE_HARNESSES=copilot"]),
   providerEndpointRecorded:false,secretValuesRecorded:false}
' >"$RECEIPT_DIR/rpc/runtime-isolation.json"
jq -e '.readOnlyKeyMount and .isolatedCopilotHome and .onlyHarness' "$RECEIPT_DIR/rpc/runtime-isolation.json" >/dev/null \
  || fail "runtime isolation proof failed"

GATEWAY_SOURCES=$(jq -cn --arg endpoint "$CONTROL_ENDPOINT_ID" --arg ticket "$CONTROL_TICKET" '
 {version:1,sources:[{sourceId:"canonical",displayName:"Copilot-only authority",endpointId:$endpoint,
 locator:{kind:"ticket",ticket:$ticket},priority:100,enabled:true,requestedScopes:["read","agent-launch","agent-control"]}]}
')
note "starting zero-authority bearer gateway as the only published application port"
docker run --detach --name "$GATEWAY_CONTAINER" --hostname copilot-only-gateway --network "$NETWORK_NAME" \
  --init --user 1000:100 --read-only --cap-drop ALL --security-opt no-new-privileges \
  "${LOCAL_RUN_ARGS[@]}" \
  --mount type=bind,src="$RUNTIME_DIR/gateway-state",dst=/state \
  --mount type=bind,src="$RUNTIME_DIR/access-token",dst=/run/access-token,readonly \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777 --publish 127.0.0.1::4318 \
  --env AGENT_MULTIPLEX_SHARED_SECRET="$SHARED_SECRET" \
  --env AGENT_MULTIPLEX_ACCESS_GATEWAY_STATE=/state/gateway.sqlite \
  --env AGENT_MULTIPLEX_ACCESS_GATEWAY_IDENTITY=/state/gateway.identity \
  --env AGENT_MULTIPLEX_ACCESS_GATEWAY_SOURCES="$GATEWAY_SOURCES" \
  --env AGENT_MULTIPLEX_ACCESS_GATEWAY_HTTP_BIND=0.0.0.0 --env AGENT_MULTIPLEX_ACCESS_GATEWAY_HTTP_PORT=4318 \
  --env AGENT_MULTIPLEX_ACCESS_GATEWAY_BEARER_TOKEN_FILE=/run/access-token \
  --env 'AGENT_MULTIPLEX_ACCESS_GATEWAY_SCOPES=["read","agent-launch","agent-control"]' \
  --env AGENT_MULTIPLEX_ACCESS_GATEWAY_AUTH_SUBJECT=copilot-only-acceptance \
  --env AGENT_MULTIPLEX_ACCESS_GATEWAY_RECONNECT_MAX_MS=1000 \
  "$IMAGE_TAG" node apps/gateway/dist/main.js >/dev/null
GATEWAY_ID=$(docker container inspect --format '{{.Id}}' "$GATEWAY_CONTAINER")
wait_for_log "$GATEWAY_CONTAINER" '^Dashboard:' 'gateway'
GATEWAY_PORT=$(docker port "$GATEWAY_CONTAINER" 4318/tcp | tail -n 1); GATEWAY_PORT=${GATEWAY_PORT##*:}
[[ "$GATEWAY_PORT" =~ ^[0-9]+$ ]] || fail "gateway port missing"
TRPC_URL="http://127.0.0.1:$GATEWAY_PORT/trpc"
for attempt in $(seq 1 60); do
  curl --fail --silent --header "Authorization: Bearer $ACCESS_TOKEN" "$TRPC_URL/system.describe" >/dev/null && break
  (( attempt < 60 )) || fail "gateway did not become reachable"
  sleep 1
done
[[ $(docker network inspect --format '{{len .Containers}}' "$NETWORK_NAME") == 3 ]] || fail "network does not contain exactly three application containers"
for hidden in "$CONTROL_CONTAINER" "$RUNTIME_CONTAINER"; do [[ -z $(docker port "$hidden" 2>/dev/null) ]] || fail "$hidden publishes a host port"; done

note "dispatching the one authorized gpt-6-luna synthetic prompt"
env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy \
  NODE_USE_ENV_PROXY=0 AGENT_MULTIPLEX_COPILOT_ONLY_BEARER_TOKEN_FILE="$RUNTIME_DIR/access-token" \
  timeout "$((TIMEOUT_MS * 3 / 1000 + 120))s" node "$SCRIPT_DIR/copilot-only-driver.mjs" \
  "$TRPC_URL" "$RECEIPT_DIR" "$RUN_ID" "$RUNTIME_NAME" "$TIMEOUT_MS" \
  >"$RECEIPT_DIR/logs/driver.log" 2>&1 || { tail -n 100 "$RECEIPT_DIR/logs/driver.log" >&2; fail "driver failed"; }

jq -e '.passed == true and .protocolVersion == 6 and .model == "gpt-6-luna" and .promptDispatchCount == 1 and
  .checks.exactNativeAssistantReply and .checks.rootNativeIdleAfterReply and .checks.stopBecameResumable and
  .checks.resumeCreatedNewRuntimeEpoch and .checks.nativeHistoryAfterResume and .checks.finalStopBecameResumable' \
  "$RECEIPT_DIR/result.json" >/dev/null || fail "result assertions failed"
if rg --text --ignore-case 'harness["=: ]+codex|AGENT_MULTIPLEX_RUNTIME_NODE_HARNESSES=codex' \
  "$RECEIPT_DIR/result.json" "$RECEIPT_DIR/logs/native-events.ndjson"; then
  fail "receipt unexpectedly contains a Codex harness/model path"
fi
jq -n --arg runId "$RUN_ID" --arg sourceCommit "$SOURCE_COMMIT" --arg model "$MODEL" \
  --arg imageId "$IMAGE_ID" --arg buildMode "$BUILD_MODE" --arg completedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
  {schema:"protocol-v6-copilot-only-v1",runId:$runId,sourceCommit:$sourceCommit,buildMode:$buildMode,protocolVersion:6,
   topology:{applicationContainers:3,authority:1,gateway:1,copilotRuntimes:1,codexRuntimes:0},
   model:$model,maximumSyntheticPrompts:1,imageId:$imageId,credentialsRecorded:false,providerEndpointRecorded:false,
   completedAt:$completedAt}
' >"$RECEIPT_DIR/manifest.json"
find "$RECEIPT_DIR" -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum >"$RECEIPT_DIR/SHA256SUMS"
secret_values_present_in_receipt && fail "secret or provider endpoint leaked into receipt"
COMPLETED=1
note "PASS: $RECEIPT_DIR"
