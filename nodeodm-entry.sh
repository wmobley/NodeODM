#!/bin/sh
set -e

echo "[ENTRY] env dump:"
env | sort

echo "[ENTRY] ls -la /var/www:"
ls -la /var/www || true

echo "[ENTRY] node version:"
(node --version && which node) || true

echo "[ENTRY] npm version:"
npm --version || true

echo "[ENTRY] head -n 40 /var/www/index.js:"
head -n 40 /var/www/index.js || true

echo "[ENTRY] incoming args: $*"

# Always execute from /var/www so relative paths (package.json) resolve
cd /var/www || {
  echo "[ENTRY] ERROR: failed to cd /var/www"
  exit 1
}
echo "[ENTRY] pwd: $(pwd)"

exec node index.js "$@"
