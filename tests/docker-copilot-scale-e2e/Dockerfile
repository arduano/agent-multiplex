# syntax=docker/dockerfile:1.7

FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df

ENV NODE_ENV=production
WORKDIR /opt/src/agent-multiplex

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Preserve the v1 repository-relative file dependency without putting the
# surrounding p2prpc checkout into the build context.
COPY --from=p2prpc-core / /opt/src/p2prpc/packages/core/
COPY . .

RUN npm install \
      --prefix /opt/src/p2prpc/packages/core \
      --omit=dev \
      --no-package-lock \
    && npm ci --include=dev \
    && npm run build \
    && npm prune --omit=dev \
    && mkdir -p /home/arduano/.copilot /state /workspace \
    && chown -R 1000:100 /home/arduano /state /workspace

LABEL org.opencontainers.image.title="Agent Multiplex real Copilot scale acceptance"
LABEL org.opencontainers.image.description="Credential-free shared image for one host and ten Copilot BYOK workers"
