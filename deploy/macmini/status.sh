#!/bin/sh
set -eu

BREW_PREFIX="$(brew --prefix)"
CONFIG_PATH="$BREW_PREFIX/etc/sing-box/config.json"
TUNNEL_CONFIG="$HOME/.cloudflared/edgetunnel-macmini.json"
SERVICE_UID="$(id -u)"

service_pid() {
	SERVICE_NAME="$1"
	shift
	for SERVICE_TARGET do
		if SERVICE_INFO="$(launchctl print "$SERVICE_TARGET" 2>/dev/null)"; then
			SERVICE_STATE="$(printf '%s\n' "$SERVICE_INFO" | awk -F'= ' '/^[[:space:]]*state =/{print $2; exit}')"
			PID="$(printf '%s\n' "$SERVICE_INFO" | awk -F'= ' '/^[[:space:]]*pid =/{print $2; exit}')"
			if [ "$SERVICE_STATE" = running ] && [ -n "$PID" ]; then
				printf '%s\n' "$PID"
				return 0
			fi
			printf '%s is not running (%s).\n' "$SERVICE_NAME" "$SERVICE_TARGET" >&2
			return 1
		fi
		case "$SERVICE_TARGET" in
			system/*)
				if [ -f "/Library/LaunchDaemons/${SERVICE_TARGET#system/}.plist" ]; then
					printf 'Cannot inspect installed %s service (%s); check launchctl permissions and registration.\n' "$SERVICE_NAME" "$SERVICE_TARGET" >&2
					return 1
				fi
				;;
		esac
	done
	printf 'No readable %s service was found in the expected launchd domains.\n' "$SERVICE_NAME" >&2
	return 1
}

sing-box check -c "$CONFIG_PATH"
RELAY_ADDRESS="$(jq -er '.inbounds[0].listen' "$CONFIG_PATH")"
RELAY_PORT="$(jq -er '.inbounds[0].listen_port' "$CONFIG_PATH")"
RELAY_PID="$(service_pid sing-box system/com.edgetunnel.macmini.sing-box "gui/$SERVICE_UID/homebrew.mxcl.sing-box")"
if ! lsof -nP -a -p "$RELAY_PID" "-iTCP@$RELAY_ADDRESS:$RELAY_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
	printf '%s\n' 'The sing-box service does not own its configured relay listener.' >&2
	exit 1
fi

TUNNEL_PID="$(service_pid cloudflared system/com.edgetunnel.macmini.cloudflared "gui/$SERVICE_UID/com.edgetunnel.macmini.cloudflared")"
METRICS_ADDRESS="$(jq -er '.metrics | select(test("^127\\.0\\.0\\.1:[0-9]+$"))' "$TUNNEL_CONFIG")"
if ! lsof -nP -a -p "$TUNNEL_PID" "-iTCP@$METRICS_ADDRESS" -sTCP:LISTEN >/dev/null 2>&1; then
	printf '%s\n' 'The cloudflared service does not own its configured readiness listener.' >&2
	exit 1
fi
if ! READY="$(curl --fail --silent --show-error --max-time 5 --noproxy '*' "http://$METRICS_ADDRESS/ready")" ||
	! printf '%s\n' "$READY" | jq -e '.status == 200 and .readyConnections > 0' >/dev/null; then
	printf '%s\n' 'Cloudflare Tunnel has no ready connection.' >&2
	exit 1
fi

printf 'Relay listener is ready at %s:%s; Cloudflare Tunnel is connected.\n' "$RELAY_ADDRESS" "$RELAY_PORT"
