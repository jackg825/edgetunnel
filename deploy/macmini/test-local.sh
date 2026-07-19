#!/bin/sh
set -eu

KEYCHAIN_SERVICE="edgetunnel-home-egress"
KEYCHAIN_ACCOUNT="$(id -un)"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
BREW_PREFIX="$(brew --prefix)"
SERVER_CONFIG="$BREW_PREFIX/etc/sing-box/config.json"
CLIENT_PORT="${HOME_EGRESS_TEST_PORT:-19091}"
RELAY_ADDRESS="$(jq -r '.inbounds[0].listen' "$SERVER_CONFIG")"
RELAY_PORT="$(jq -r '.inbounds[0].listen_port' "$SERVER_CONFIG")"
RELAY_PASSWORD="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" -w)"
CLIENT_CONFIG="$(mktemp "${TMPDIR:-/tmp}/edgetunnel-client.XXXXXX")"
CLIENT_LOG="$(mktemp "${TMPDIR:-/tmp}/edgetunnel-client-log.XXXXXX")"
CLIENT_PID=''

cleanup() {
	if [ -n "$CLIENT_PID" ]; then
		kill "$CLIENT_PID" >/dev/null 2>&1 || true
		wait "$CLIENT_PID" >/dev/null 2>&1 || true
	fi
	rm -f "$CLIENT_CONFIG" "$CLIENT_LOG"
}
trap cleanup EXIT HUP INT TERM

jq -n \
	--arg server "$RELAY_ADDRESS" \
	--argjson server_port "$RELAY_PORT" \
	--arg password "$RELAY_PASSWORD" \
	--argjson client_port "$CLIENT_PORT" \
	'{
		log: { level: "warn" },
		inbounds: [{ type: "mixed", tag: "local-test", listen: "127.0.0.1", listen_port: $client_port }],
		outbounds: [{ type: "trojan", tag: "home-relay", server: $server, server_port: $server_port, password: $password }],
		route: { final: "home-relay" }
	}' > "$CLIENT_CONFIG"

sing-box check -c "$CLIENT_CONFIG"
sing-box run -c "$CLIENT_CONFIG" > "$CLIENT_LOG" 2>&1 &
CLIENT_PID=$!

attempt=0
while ! lsof -nP -iTCP:"$CLIENT_PORT" -sTCP:LISTEN >/dev/null 2>&1; do
	attempt=$((attempt + 1))
	if [ "$attempt" -ge 50 ]; then
		printf '%s\n' "Local test client did not start" >&2
		cat "$CLIENT_LOG" >&2
		exit 1
	fi
	sleep 0.1
done

DIRECT_TRACE="$(curl --silent --show-error --max-time 10 https://www.cloudflare.com/cdn-cgi/trace)"
RELAY_TRACE="$(curl --silent --show-error --max-time 10 --proxy "socks5h://127.0.0.1:$CLIENT_PORT" https://www.cloudflare.com/cdn-cgi/trace)"
node "$SCRIPT_DIR/socks-udp-dns.mjs" "$CLIENT_PORT"
DIRECT_IP="$(printf '%s\n' "$DIRECT_TRACE" | awk -F= '$1 == "ip" { print $2 }')"
RELAY_IP="$(printf '%s\n' "$RELAY_TRACE" | awk -F= '$1 == "ip" { print $2 }')"
RELAY_LOCATION="$(printf '%s\n' "$RELAY_TRACE" | awk -F= '$1 == "loc" { print $2 }')"

if [ -z "$DIRECT_IP" ] || [ "$DIRECT_IP" != "$RELAY_IP" ]; then
	printf '%s\n' "Relay egress IP did not match the Mac's direct egress IP" >&2
	exit 1
fi

printf 'Local Trojan relay test passed; egress location=%s\n' "$RELAY_LOCATION"
