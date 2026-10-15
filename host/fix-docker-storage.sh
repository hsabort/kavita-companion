#!/usr/bin/env bash
# One-time root fix: overlayfs cannot extract multi-layer images on the idmapped btrfs root
# of this unprivileged Incus container ("failed to mount ... overlay ... invalid argument").
# Switch Docker to the btrfs storage driver.
# Run: sudo bash scripts/fix-docker-storage.sh
set -euo pipefail
if [ -s /etc/docker/daemon.json ]; then
  cp /etc/docker/daemon.json "/etc/docker/daemon.json.bak.$(date +%s)"
fi
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'EOF'
{
  "storage-driver": "btrfs"
}
EOF
systemctl restart docker
docker info --format 'Storage driver: {{.Driver}}'
