# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /opt/src/agent-multiplex

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Keep the repository's v1 file dependency at the same relative path it has
# on the host. The caller supplies this narrowly scoped named build context.
COPY --from=p2prpc-core / /opt/src/p2prpc/packages/core/
COPY . .

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install \
      --prefix /opt/src/p2prpc/packages/core \
      --omit=dev \
      --no-package-lock \
    && npm ci --include=dev \
    && npm run build \
    && npm prune --omit=dev \
    && mkdir -p /home/arduano/.copilot /state /workspace/e2e \
    && chown -R 1000:100 /home/arduano /state /workspace

LABEL org.opencontainers.image.title="Agent Multiplex Copilot Interactive Docker E2E"
LABEL org.opencontainers.image.description="Shared acceptance image for the Multiplex host and interactive Copilot BYOK worker"
