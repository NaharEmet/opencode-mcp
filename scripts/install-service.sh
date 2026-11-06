#!/usr/bin/env bash
# Build the server and install it as a systemd user service (port 7357).
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$unit_dir"
(cd "$repo" && pnpm build)
sed -e "s|%NODE%|$(command -v node)|" -e "s|%REPO%|$repo|" -e "s|%PATH%|$PATH|" \
  "$repo/scripts/opencode-worker-server.service" > "$unit_dir/opencode-worker-server.service"
systemctl --user daemon-reload
systemctl --user enable --now opencode-worker-server.service
systemctl --user restart opencode-worker-server.service
