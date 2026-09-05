#!/bin/sh
set -eu

# Run as the owner of the existing relay configuration, not as root. Only
# installing and registering the system jobs requires elevated privileges.
if [ "$(id -u)" -eq 0 ]; then
	printf '%s\n' 'Run this script as the relay owner without sudo; it requests sudo only for launchd installation.' >&2
	exit 1
fi

SERVICE_USER="$(id -un)"
SERVICE_UID="$(id -u)"
BREW_PREFIX="$(brew --prefix)"
SING_BOX_BIN="$(command -v sing-box)"
CLOUDFLARED_BIN="$(command -v cloudflared)"
RELAY_CONFIG="$BREW_PREFIX/etc/sing-box/config.json"
TUNNEL_CONFIG="$HOME/.cloudflared/edgetunnel-macmini.json"
RELAY_LABEL="com.edgetunnel.macmini.sing-box"
TUNNEL_LABEL="com.edgetunnel.macmini.cloudflared"
LOG_DIR="$HOME/Library/Logs/edgetunnel"

sing-box check -c "$RELAY_CONFIG"
TUNNEL_CREDENTIALS="$(jq -er '."credentials-file"' "$TUNNEL_CONFIG")"
if [ ! -r "$TUNNEL_CREDENTIALS" ]; then
	printf '%s\n' 'Tunnel credentials are not readable by the service user; run configure-cloudflared.sh first.' >&2
	exit 1
fi

if [ -f /Library/LaunchDaemons/homebrew.mxcl.sing-box.plist ]; then
	printf '%s\n' 'An existing system Homebrew sing-box service must be reviewed and stopped before installing these jobs.' >&2
	exit 1
fi

umask 077
mkdir -p "$LOG_DIR"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/edgetunnel-system-services.XXXXXX")"
trap 'rm -rf "$TEMP_DIR"' EXIT HUP INT TERM

for SERVICE in sing-box cloudflared; do
	if [ "$SERVICE" = sing-box ]; then
		LABEL="$RELAY_LABEL"
		ARGUMENTS="$(jq -cn --arg binary "$SING_BOX_BIN" --arg config "$RELAY_CONFIG" '[$binary, "run", "-c", $config]')"
	else
		LABEL="$TUNNEL_LABEL"
		ARGUMENTS="$(jq -cn --arg binary "$CLOUDFLARED_BIN" --arg config "$TUNNEL_CONFIG" '[$binary, "--no-autoupdate", "--config", $config, "tunnel", "run"]')"
	fi
	jq -n \
		--arg label "$LABEL" \
		--arg user "$SERVICE_USER" \
		--arg home "$HOME" \
		--arg log "$LOG_DIR/$SERVICE.log" \
		--argjson arguments "$ARGUMENTS" \
		'{Label: $label, UserName: $user, ProgramArguments: $arguments,
		  EnvironmentVariables: {HOME: $home}, WorkingDirectory: $home,
		  RunAtLoad: true, KeepAlive: true, ThrottleInterval: 10,
		  StandardOutPath: $log, StandardErrorPath: $log}' > "$TEMP_DIR/$LABEL.plist"
	plutil -convert xml1 "$TEMP_DIR/$LABEL.plist"
	plutil -lint "$TEMP_DIR/$LABEL.plist" >/dev/null
done

# Authenticate before stopping either user job. The daemon processes continue
# to use SERVICE_USER and the existing protected configuration files.
sudo -v
for LABEL in "$RELAY_LABEL" "$TUNNEL_LABEL"; do
	sudo install -o root -g wheel -m 644 "$TEMP_DIR/$LABEL.plist" "/Library/LaunchDaemons/$LABEL.plist"
done

if [ -f "$HOME/Library/LaunchAgents/homebrew.mxcl.sing-box.plist" ]; then
	brew services stop sing-box >/dev/null
fi
USER_TUNNEL_PLIST="$HOME/Library/LaunchAgents/$TUNNEL_LABEL.plist"
if [ -f "$USER_TUNNEL_PLIST" ]; then
	launchctl bootout "gui/$SERVICE_UID" "$USER_TUNNEL_PLIST" 2>/dev/null || true
	rm -f "$USER_TUNNEL_PLIST"
fi

for LABEL in "$RELAY_LABEL" "$TUNNEL_LABEL"; do
	PLIST_PATH="/Library/LaunchDaemons/$LABEL.plist"
	sudo launchctl bootout "system/$LABEL" 2>/dev/null || true
	sudo launchctl bootstrap system "$PLIST_PATH"
	sudo launchctl kickstart -k "system/$LABEL"
done

printf 'System services installed to run as %s before GUI login.\n' "$SERVICE_USER"
printf '%s\n' 'FileVault must still unlock the startup disk after a cold boot. Verify status.sh and the documented recovery checks.'
