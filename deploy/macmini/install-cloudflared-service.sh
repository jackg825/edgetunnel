#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
CLOUDFLARED_BIN="$(command -v cloudflared)"
CONFIG_PATH="$HOME/.cloudflared/config.yml"
PLIST_PATH="$HOME/Library/LaunchAgents/com.cloudflare.cloudflared.plist"
SERVICE_DOMAIN="gui/$(id -u)"

if [ ! -f "$CONFIG_PATH" ]; then
	printf 'cloudflared configuration not found: %s\n' "$CONFIG_PATH" >&2
	printf 'Run %s/configure-cloudflared.sh first.\n' "$SCRIPT_DIR" >&2
	exit 1
fi

if [ ! -f "$PLIST_PATH" ]; then
	cloudflared service install
fi

PROGRAM_ARGUMENTS="$(jq -cn \
	--arg binary "$CLOUDFLARED_BIN" \
	--arg config "$CONFIG_PATH" \
	'[$binary, "--no-autoupdate", "--config", $config, "tunnel", "run"]')"
plutil -replace ProgramArguments -json "$PROGRAM_ARGUMENTS" "$PLIST_PATH"

launchctl bootout "$SERVICE_DOMAIN" "$PLIST_PATH" 2>/dev/null || true
launchctl bootstrap "$SERVICE_DOMAIN" "$PLIST_PATH"
launchctl kickstart -k "$SERVICE_DOMAIN/com.cloudflare.cloudflared"

printf '%s\n' "cloudflared tunnel LaunchAgent installed and started."
