# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /opt/src/agent-multiplex

# Keep the repository's v1 file dependency at the same relative path it has
# on the host. The caller supplies this narrowly scoped named build context.
COPY --from=p2prpc-core / /opt/src/p2prpc/packages/core/
COPY . .

RUN npm install \
      --prefix /opt/src/p2prpc/packages/core \
      --omit=dev \
      --no-package-lock \
    && npm ci --include=dev \
    && npm run build \
    && npm prune --omit=dev \
    && mkdir -p /home/arduano/.codex /state /workspace/e2e \
    && chown -R 1000:100 /home/arduano /state /workspace

COPY --chmod=0755 tests/docker-codex-e2e/runtime-node-entrypoint.sh \
  /usr/local/bin/agent-multiplex-e2e-runtime-node

LABEL org.opencontainers.image.title="Agent Multiplex Codex Docker E2E"
LABEL org.opencontainers.image.description="Shared acceptance image for the Multiplex control node and Codex runtime node"
