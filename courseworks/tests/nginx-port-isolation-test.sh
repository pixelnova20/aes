#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="$ROOT/scripts/nginx-courseworks.conf"

grep -Fq 'listen 10001;' "$CONFIG"
grep -Fq 'root /var/lib/aes/www;' "$CONFIG"
grep -Fq 'proxy_pass http://127.0.0.1:3000/api/;' "$CONFIG"
if grep -Fq '127.0.0.1:3001' "$CONFIG"; then
  printf 'AES port 10001 must not proxy to the old Courseworks backend.\n' >&2
  exit 1
fi
if grep -Fq 'courseworks-favicon.svg' "$CONFIG"; then
  printf 'AES port 10001 must not use the old Courseworks favicon.\n' >&2
  exit 1
fi
if grep -Fq 'listen 8090;' "$CONFIG" \
    || grep -Fq 'retired-courseworks' "$CONFIG"; then
  printf 'Retired Courseworks port 8090 must not remain in the AES Nginx configuration.\n' >&2
  exit 1
fi

printf 'Nginx AES-only endpoint test passed.\n'
