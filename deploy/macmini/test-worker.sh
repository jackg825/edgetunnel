#!/bin/sh
set -eu

KEYCHAIN_SERVICE="edgetunnel-home-egress"
KEYCHAIN_ACCOUNT="$(id -un)"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
WORKER_HOST="${HOME_EGRESS_WORKER_HOST:-}"
WORKER_SERVER="${HOME_EGRESS_WORKER_SERVER:-$WORKER_HOST}"
CLIENT_PORT="${HOME_EGRESS_WORKER_TEST_PORT:-19092}"

if [ -z "$WORKER_HOST" ]; then
	printf '%s\n' "Set HOME_EGRESS_WORKER_HOST to the Worker custom hostname" >&2
	exit 1
fi

RELAY_PASSWORD="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" -w)"
CLIENT_CONFIG="$(mktemp "${TMPDIR:-/tmp}/edgetunnel-worker-client.XXXXXX")"
CLIENT_LOG="$(mktemp "${TMPDIR:-/tmp}/edgetunnel-worker-client-log.XXXXXX")"
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
	--arg server "$WORKER_HOST" \
	--arg connect_server "$WORKER_SERVER" \
	--arg password "$RELAY_PASSWORD" \
	--argjson client_port "$CLIENT_PORT" \
	'{
		log: { level: "warn" },
		inbounds: [{ type: "mixed", tag: "worker-test", listen: "127.0.0.1", listen_port: $client_port }],
		outbounds: [{
			type: "vless",
			tag: "worker-relay",
			server: $connect_server,
			server_port: 443,
			uuid: $password,
			tls: { enabled: true, server_name: $server },
			transport: { type: "ws", path: "/", headers: { Host: $server } }
		}],
		route: { final: "worker-relay" }
	}' > "$CLIENT_CONFIG"

sing-box check -c "$CLIENT_CONFIG"
sing-box run -c "$CLIENT_CONFIG" > "$CLIENT_LOG" 2>&1 &
CLIENT_PID=$!

attempt=0
while ! lsof -nP -iTCP:"$CLIENT_PORT" -sTCP:LISTEN >/dev/null 2>&1; do
	attempt=$((attempt + 1))
	if [ "$attempt" -ge 50 ]; then
		printf '%s\n' "Worker test client did not start" >&2
		cat "$CLIENT_LOG" >&2
		exit 1
	fi
	sleep 0.1
done

DIRECT_TRACE="$(curl --silent --show-error --max-time 15 https://www.cloudflare.com/cdn-cgi/trace)"
WORKER_TRACE="$(curl --silent --show-error --max-time 20 --proxy "socks5h://127.0.0.1:$CLIENT_PORT" https://www.cloudflare.com/cdn-cgi/trace)"
DIRECT_IP="$(printf '%s\n' "$DIRECT_TRACE" | awk -F= '$1 == "ip" { print $2 }')"
WORKER_IP="$(printf '%s\n' "$WORKER_TRACE" | awk -F= '$1 == "ip" { print $2 }')"
WORKER_LOCATION="$(printf '%s\n' "$WORKER_TRACE" | awk -F= '$1 == "loc" { print $2 }')"

if [ -z "$DIRECT_IP" ] || [ "$DIRECT_IP" != "$WORKER_IP" ]; then
	printf '%s\n' "Worker egress IP did not match the Mac's direct egress IP" >&2
	cat "$CLIENT_LOG" >&2
	exit 1
fi

printf 'VLESS Worker-to-Mac TCP egress test passed; egress location=%s\n' "$WORKER_LOCATION"
