#!/usr/bin/env bash
# Back up everything needed to rebuild this install except the media library:
# Kavita's database and settings, kavita-companion's database, Caddy's certificates and .env.
#
#   scripts/backup.sh [destination-folder]      (default: ./backups)
#
# Kavita and kavita-companion are stopped for a few seconds so their databases are consistent.
# The media library (MEDIA_ROOT) is not included: back it up separately (docs/operations.md).
set -euo pipefail
cd "$(dirname "$0")/.."

dest="${1:-./backups}"
set -a; . ./.env; set +a
data="${DATA_ROOT:-./data}"
mkdir -p "$dest"
archive="$dest/kavita-stack-$(date +%Y-%m-%d_%H%M%S).tar.gz"

echo "Stopping Kavita and kavita-companion..."
docker compose stop kavita kavita-companion >/dev/null
trap 'echo "Starting them again..."; docker compose start kavita kavita-companion >/dev/null' EXIT

tar -czf "$archive" .env "$data/kavita" "$data/companion" "$data/caddy"
chmod 600 "$archive"   # it contains .env (keys, passwords)
echo "Backup written: $archive ($(du -h "$archive" | cut -f1))"
