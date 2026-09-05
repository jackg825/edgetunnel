#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
CLOUDFLARED_BIN="$(command -v cloudflared)"
CONFIG_PATH="$HOME/.cloudflared/edgetunnel-macmini.json"
SERVICE_LABEL="com.edgetunnel.macmini.cloudflared"
PLIST_PATH="$HOME/Library/LaunchAgents/$SERVICE_LABEL.plist"
SERVICE_DOMAIN="gui/$(id -u)"
LOG_DIR="$HOME/Library/Logs/edgetunnel"

if [ -f "/Library/LaunchDaemons/$SERVICE_LABEL.plist" ]; then
	printf 'System service is installed. Update it with %s/install-system-services.sh.\n' "$SCRIPT_DIR" >&2
	exit 1
fi

if [ ! -f "$CONFIG_PATH" ]; then
	printf 'cloudflared configuration not found: %s\n' "$CONFIG_PATH" >&2
	printf 'Run %s/configure-cloudflared.sh first.\n' "$SCRIPT_DIR" >&2
	exit 1
fi

umask 077
mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"
TEMP_PLIST="$(mktemp "${TMPDIR:-/tmp}/edgetunnel-cloudflared-plist.XXXXXX")"
trap 'rm -f "$TEMP_PLIST"' EXIT HUP INT TERM
jq -n \
	--arg label "$SERVICE_LABEL" \
	--arg binary "$CLOUDFLARED_BIN" \
	--arg config "$CONFIG_PATH" \
	--arg log "$LOG_DIR/cloudflared.log" \
	'{Label: $label,
	  ProgramArguments: [$binary, "--no-autoupdate", "--config", $config, "tunnel", "run"],
	  RunAtLoad: true, KeepAlive: true, ThrottleInterval: 10,
	  StandardOutPath: $log, StandardErrorPath: $log}' > "$TEMP_PLIST"
plutil -convert xml1 "$TEMP_PLIST"
plutil -lint "$TEMP_PLIST" >/dev/null
install -m 600 "$TEMP_PLIST" "$PLIST_PATH"

launchctl bootout "$SERVICE_DOMAIN" "$PLIST_PATH" 2>/dev/null || true
launchctl bootstrap "$SERVICE_DOMAIN" "$PLIST_PATH"
launchctl kickstart -k "$SERVICE_DOMAIN/$SERVICE_LABEL"

printf '%s\n' "Project cloudflared LaunchAgent installed; it runs while this user is logged in."
