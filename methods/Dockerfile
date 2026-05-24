# Methods v3 — pinned environment for reproducing the C2 benchmark + statistical analysis
#
# Build:  docker build -t mcp-token-savers-bench:v0.3 -f notes/mcp-stack-token-economy/methods_v3/Dockerfile .
# Run:    docker run --rm -v $PWD/results:/results mcp-token-savers-bench:v0.3
#
# Goal: anyone can clone the repo, build this image, and reproduce the exact
# numbers in statistical_analysis_v3.md. Pinned versions are the same as the
# 2026-05-24 measurement run on Greg's MacBook (recorded in provenance.md).

# Use the same Node version published in g-shevchenko/mcp-token-savers/package.json
# (Node 22.x LTS as of 2026-05-24).
FROM node:22.11.0-bookworm-slim AS sophon-builder

# Install mcp-sophon at the EXACT measured version (0.5.4)
RUN npm install -g mcp-sophon@0.5.4

FROM python:3.13.0-slim-bookworm

# Copy sophon binary from builder
COPY --from=sophon-builder /usr/local/lib/node_modules/mcp-sophon /opt/mcp-sophon
COPY --from=sophon-builder /usr/local/bin/sophon /usr/local/bin/sophon
ENV SOPHON_BIN=/usr/local/bin/sophon

# System deps for the harness (ripgrep for retrieval-mcp comparison runs)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ripgrep=14.* \
    nodejs \
    npm \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install context-prep-mcp CLI from npm (matching internal version measured 2026-05-24)
# NOTE: context-prep-mcp is shipped via the public mcp-token-savers tree; for the
# Docker build we use the npm-published version. If running against the in-repo
# source tree, mount the source and the entrypoint script will prefer the local copy.
RUN npm install -g @hwai/context-prep-mcp@1.0.0 || \
    echo "context-prep-mcp not in npm public yet — fallback to in-repo source"

WORKDIR /work

# Repo layout — expect the volume-mounted source to be the full mcp-token-savers
# repo or the internal monorepo at /work
VOLUME ["/work", "/results"]

# Default entrypoint runs the c2_bench + statistical analysis end-to-end
COPY notes/mcp-stack-token-economy/methods_v3/repro-entrypoint.sh /usr/local/bin/repro
RUN chmod +x /usr/local/bin/repro
ENTRYPOINT ["/usr/local/bin/repro"]
CMD []
