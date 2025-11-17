#!/usr/bin/env bash
# Quick idev test runner for NodeODM with Apptainer
set -euo pipefail
module load tacc-apptainer
# Avoid bash-completion nounset issues on LS6
BASH_COMPLETION_DEBUG=${BASH_COMPLETION_DEBUG:-}
# Defaults (can be overridden via env)
BASE=${BASE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
IMAGE=${NODEODM_IMAGE:-ghcr.io/wmobley/nodeodm:latest}
USE_OVERLAY=${USE_OVERLAY:-1}          # 1=use local nodeodm-source overlay, 0=image code only
PORT=${PORT:-3001}
LOG_LEVEL=${NODEODM_LOG_LEVEL:-silly}

# GHCR creds if image is private:
# export APPTAINER_DOCKER_USERNAME=wmobley
# export APPTAINER_DOCKER_PASSWORD=<PAT with read:packages>

WORK_DIR=$(mktemp -d /tmp/nodeodm-idev-XXXX)
RUNTIME="$WORK_DIR/runtime"
mkdir -p "$RUNTIME"

if [ "$USE_OVERLAY" -eq 1 ]; then
    if [ ! -f "$BASE/index.js" ]; then
        echo "nodeodm-source missing at $BASE (expected index.js); set BASE=... or set USE_OVERLAY=0" >&2
        exit 1
    fi
    rsync -a "$BASE"/ "$RUNTIME"/
    BIND_ARGS="--bind $RUNTIME:/var/www:rw"
else
    mkdir -p "$RUNTIME"/{data,tmp,logs}
    BIND_ARGS="--bind $RUNTIME/data:/var/www/data:rw --bind $RUNTIME/tmp:/var/www/tmp:rw --bind $RUNTIME/logs:/var/www/logs:rw"
fi

cat > "$WORK_DIR/nodeodm-config.json" <<EOF
{
  "port": $PORT,
  "timeout": 0,
  "maxConcurrency": 4,
  "maxImages": 0,
  "cleanupTasksAfter": 2880,
  "token": "",
  "parallelQueueProcessing": 1,
  "maxParallelTasks": 4,
  "odm_path": "/code",
  "logger": { "level": "$LOG_LEVEL", "logDirectory": "/var/www/logs" }
}
EOF

LOG="$WORK_DIR/nodeodm.startup.log"

echo "Working dir: $WORK_DIR"
echo "Image: $IMAGE"
echo "Overlay source: $USE_OVERLAY (BASE=$BASE)"

apptainer exec \
  --writable-tmpfs \
  --bind "$WORK_DIR/nodeodm-config.json":/tmp/nodeodm-config.json \
  $BIND_ARGS \
  docker://$IMAGE \
  sh -xc '
    NODE_BIN=$(command -v node || command -v nodejs || find /usr/local/nvm -type f -path "*bin/node" 2>/dev/null | head -n1)
    [ -z "$NODE_BIN" ] && [ -x /usr/local/bin/node.sh ] && NODE_BIN=/usr/local/bin/node.sh
    PATH=$(dirname "$NODE_BIN"):$PATH; export PATH
    echo "Using node:" $(node -v); echo "npm:" $(npm -v)
    cd /var/www && mkdir -p tmp data logs && \
      if [ ! -d node_modules ] || [ ! -f node_modules/winston/package.json ]; then
        echo "Installing NodeODM dependencies (npm install --production)..."
        npm install --production || exit 1
      fi && \
      exec "$NODE_BIN" index.js --config /tmp/nodeodm-config.json --log_level '"$LOG_LEVEL"'
  ' > "$LOG" 2>&1 &

echo "Tailing log: $LOG"
tail -f "$LOG"
