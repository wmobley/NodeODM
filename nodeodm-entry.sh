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

exec node /var/www/index.js "$@"
