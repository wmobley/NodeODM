#!/usr/bin/env bash
# Minimal idev runner (no wrapping/tailing)
set -euo pipefail

JOBDIR=${JOBDIR:-/scratch/06659/wmobley/nodeodm/nodeodm-ls6}
WORK_DIR=${WORK_DIR:-$(ls -d "$JOBDIR"/nodeodm_workdir_*admin* 2>/dev/null | head -n1)}
NODEODM_RUNTIME_DIR=${NODEODM_RUNTIME_DIR:-"$WORK_DIR/runtime"}
IMAGE=${NODEODM_IMAGE:-ghcr.io/wmobley/nodeodm:latest}

if [ -z "${WORK_DIR:-}" ] || [ ! -f "$WORK_DIR/nodeodm-config.json" ]; then
  echo "WORK_DIR/nodeodm-config.json not found. Set WORK_DIR or run the job once to create it." >&2
  exit 1
fi

SKIP_TAP_SETUP=1 NODEODM_USE_IMAGE_SOURCE=0 NODEODM_LOG_LEVEL=silly \
apptainer exec \
  --writable-tmpfs \
  --bind "$WORK_DIR/nodeodm-config.json":/tmp/nodeodm-config.json \
  --bind "$NODEODM_RUNTIME_DIR":/var/www:rw \
  docker://"$IMAGE" \
  sh -xc '
    set -x
    export PIP_BREAK_SYSTEM_PACKAGES=1
    NODE_BIN=$(command -v node || command -v nodejs || find /usr/local/nvm -type f -path "*bin/node" 2>/dev/null | head -n1)
    [ -z "$NODE_BIN" ] && [ -x /usr/local/bin/node.sh ] && NODE_BIN=/usr/local/bin/node.sh
    PATH=$(dirname "$NODE_BIN"):$PATH; export PATH
    # Ensure Python deps (vmem and friends) via any available pip
    if command -v pip >/dev/null 2>&1; then
      pip install --no-cache-dir python-dateutil repoze.lru psutil vmem || true
    elif command -v pip3 >/dev/null 2>&1; then
      pip3 install --no-cache-dir python-dateutil repoze.lru psutil vmem || true
    elif command -v python3 >/dev/null 2>&1; then
      python3 -m pip install --no-cache-dir python-dateutil repoze.lru psutil vmem || true
    else
      echo "pip not found; skipping Python dep install"
    fi
    node -v; npm -v
    cd /var/www && mkdir -p tmp data logs && \
      if [ ! -d node_modules ] || [ ! -f node_modules/winston/package.json ]; then
        npm install --production || exit 1
      fi
    exec "$NODE_BIN" index.js --config /tmp/nodeodm-config.json --log_level silly
  '
