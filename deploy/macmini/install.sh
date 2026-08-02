#!/bin/sh
set -eu

KEYCHAIN_SERVICE="edgetunnel-home-egress"
KEYCHAIN_ACCOUNT="$(id -un)"
RELAY_PORT="${HOME_EGRESS_PORT:-19090}"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
TEMPLATE_PATH="$SCRIPT_DIR/sing-box.json.template"
DEFAULT_INTERFACE="$(route -n get default | awk '/interface:/{print $2; exit}')"
LISTEN_ADDRESS="${HOME_EGRESS_LISTEN:-$(ipconfig getifaddr "$DEFAULT_INTERFACE")}"
BREW_PREFIX="$(brew --prefix)"
CONFIG_DIR="$BREW_PREFIX/etc/sing-box"
CONFIG_PATH="$CONFIG_DIR/config.json"

if [ -z "$DEFAULT_INTERFACE" ] || [ -z "$LISTEN_ADDRESS" ]; then
	printf '%s\n' "Unable to determine the default interface address" >&2
	exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
	brew install jq
fi

if ! security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" -w >/dev/null 2>&1; then
	RELAY_PASSWORD="$(uuidgen | tr '[:upper:]' '[:lower:]')"
	security add-generic-password -U -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" -w "$RELAY_PASSWORD" >/dev/null
else
	RELAY_PASSWORD="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" -w)"
fi

mkdir -p "$CONFIG_DIR"
TEMP_CONFIG="$(mktemp "${TMPDIR:-/tmp}/edgetunnel-sing-box.XXXXXX")"
trap 'rm -f "$TEMP_CONFIG"' EXIT HUP INT TERM

jq \
	--arg listen "$LISTEN_ADDRESS" \
	--argjson port "$RELAY_PORT" \
	--arg password "$RELAY_PASSWORD" \
	'.inbounds[0].listen = $listen
	 | .inbounds[0].listen_port = $port
	 | .inbounds[0].users[0].password = $password' \
	"$TEMPLATE_PATH" > "$TEMP_CONFIG"

sing-box check -c "$TEMP_CONFIG"
install -m 600 "$TEMP_CONFIG" "$CONFIG_PATH"
brew services restart sing-box >/dev/null

printf 'sing-box relay is listening on %s:%s\n' "$LISTEN_ADDRESS" "$RELAY_PORT"
printf 'Site relay credential is stored in macOS Keychain service: %s\n' "$KEYCHAIN_SERVICE"
