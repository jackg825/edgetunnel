#!/bin/sh
set -eu

KEYCHAIN_SERVICE="edgetunnel-worker-uuid"
KEYCHAIN_ACCOUNT="$(id -un)"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
WORKER_HOST="${HOME_EGRESS_WORKER_HOST:-}"
WORKER_SERVER="${HOME_EGRESS_WORKER_SERVER:-$WORKER_HOST}"
CLIENT_PORT="${HOME_EGRESS_WORKER_TEST_PORT:-19092}"
SITE_ID="${HOME_EGRESS_SITE_ID:-}"
WORKER_PATH="/"

if [ -z "$WORKER_HOST" ]; then
	printf '%s\n' "Set HOME_EGRESS_WORKER_HOST to the Worker custom hostname" >&2
	exit 1
fi

if [ -n "$SITE_ID" ]; then
	case "$SITE_ID" in
		*[!a-z0-9_-]*|'') printf '%s\n' "HOME_EGRESS_SITE_ID contains invalid characters" >&2; exit 1 ;;
	esac
	WORKER_PATH="/egress=$SITE_ID"
fi

WORKER_UUID="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" -w)"
CLIENT_CONFIG="$(mktemp "${TMPDIR:-/tmp}/edgetunnel-worker-client.XXXXXX")"
CLIENT_LOG="$(mktemp "${TMPDIR:-/tmp}/edgetunnel-worker-client-log.XXXXXX")"
PROBE_LOG="$(mktemp "${TMPDIR:-/tmp}/edgetunnel-worker-probe-log.XXXXXX")"
CLIENT_PID=''
PROBE_PID=''
PROBE_PORT="${HOME_EGRESS_ISOLATION_TEST_PORT:-19095}"
LAN_PROBE_PORT="${HOME_EGRESS_LAN_ISOLATION_TEST_PORT:-19096}"
DEFAULT_INTERFACE="$(route -n get default | awk '/interface:/{print $2; exit}')"
LAN_ADDRESS="${HOME_EGRESS_LAN_TEST_ADDRESS:-$(ipconfig getifaddr "$DEFAULT_INTERFACE")}"

cleanup() {
	if [ -n "$PROBE_PID" ]; then
		kill "$PROBE_PID" >/dev/null 2>&1 || true
		wait "$PROBE_PID" >/dev/null 2>&1 || true
	fi
	if [ -n "$CLIENT_PID" ]; then
		kill "$CLIENT_PID" >/dev/null 2>&1 || true
		wait "$CLIENT_PID" >/dev/null 2>&1 || true
	fi
	rm -f "$CLIENT_CONFIG" "$CLIENT_LOG" "$PROBE_LOG"
}
trap cleanup EXIT HUP INT TERM

jq -n \
	--arg server "$WORKER_HOST" \
	--arg connect_server "$WORKER_SERVER" \
	--arg password "$WORKER_UUID" \
	--arg worker_path "$WORKER_PATH" \
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
			transport: { type: "ws", path: $worker_path, headers: { Host: $server } }
		}],
		route: { final: "worker-relay" }
	}' > "$CLIENT_CONFIG"

sing-box check -c "$CLIENT_CONFIG"
sing-box run -c "$CLIENT_CONFIG" > "$CLIENT_LOG" 2>&1 &
CLIENT_PID=$!

attempt=0
while ! lsof -nP -a -p "$CLIENT_PID" "-iTCP@127.0.0.1:$CLIENT_PORT" -sTCP:LISTEN >/dev/null 2>&1; do
	attempt=$((attempt + 1))
	if ! kill -0 "$CLIENT_PID" 2>/dev/null || [ "$attempt" -ge 50 ]; then
		printf '%s\n' "Worker test client did not start" >&2
		cat "$CLIENT_LOG" >&2
		exit 1
	fi
	sleep 0.1
done

node -e '
	const http = require("node:http");
	const loopbackPort = Number(process.argv[1]);
	const lanAddress = process.argv[2];
	const lanPort = Number(process.argv[3]);
	const handler = (request, response) => {
		response.writeHead(200, { "Content-Type": "text/plain" });
		response.end("local-only\n");
	};
	const servers = [
		http.createServer(handler).listen(loopbackPort, "127.0.0.1"),
		http.createServer(handler).listen(lanPort, lanAddress)
	];
	process.on("SIGTERM", () => Promise.all(servers.map(server => new Promise(resolve => server.close(resolve)))).then(() => process.exit(0)));
' "$PROBE_PORT" "$LAN_ADDRESS" "$LAN_PROBE_PORT" > "$PROBE_LOG" 2>&1 &
PROBE_PID=$!

attempt=0
while ! lsof -nP -a -p "$PROBE_PID" "-iTCP@127.0.0.1:$PROBE_PORT" -sTCP:LISTEN >/dev/null 2>&1 || ! lsof -nP -a -p "$PROBE_PID" "-iTCP@$LAN_ADDRESS:$LAN_PROBE_PORT" -sTCP:LISTEN >/dev/null 2>&1; do
	attempt=$((attempt + 1))
	if ! kill -0 "$PROBE_PID" 2>/dev/null || [ "$attempt" -ge 50 ]; then
		printf '%s\n' "Local isolation probe did not start" >&2
		cat "$PROBE_LOG" >&2
		exit 1
	fi
	sleep 0.1
done

curl --noproxy '*' --fail --silent --show-error --max-time 3 "http://127.0.0.1:$PROBE_PORT/" >/dev/null
curl --noproxy '*' --fail --silent --show-error --max-time 3 "http://$LAN_ADDRESS:$LAN_PROBE_PORT/" >/dev/null

DIRECT_TRACE="$(curl --ipv4 --noproxy '*' --silent --show-error --max-time 15 https://www.cloudflare.com/cdn-cgi/trace)"
WORKER_TRACE="$(curl --noproxy '' --silent --show-error --max-time 20 --proxy "socks5h://127.0.0.1:$CLIENT_PORT" https://www.cloudflare.com/cdn-cgi/trace)"
DIRECT_IP="$(printf '%s\n' "$DIRECT_TRACE" | awk -F= '$1 == "ip" { print $2 }')"
WORKER_IP="$(printf '%s\n' "$WORKER_TRACE" | awk -F= '$1 == "ip" { print $2 }')"
WORKER_LOCATION="$(printf '%s\n' "$WORKER_TRACE" | awk -F= '$1 == "loc" { print $2 }')"

if [ -z "$DIRECT_IP" ] || [ "$DIRECT_IP" != "$WORKER_IP" ]; then
	printf '%s\n' "Worker egress IP did not match the Mac's direct egress IP" >&2
	cat "$CLIENT_LOG" >&2
	exit 1
fi

if curl --noproxy '' --silent --max-time 3 --output /dev/null --proxy "socks5h://127.0.0.1:$CLIENT_PORT" "http://127.0.0.1:$PROBE_PORT/"; then
	printf '%s\n' "Worker egress reached a loopback-only service" >&2
	exit 1
fi

if curl --noproxy '' --silent --max-time 3 --output /dev/null --proxy "socks5h://127.0.0.1:$CLIENT_PORT" "http://localhost:$PROBE_PORT/"; then
	printf '%s\n' "Worker egress reached a local service through a hostname" >&2
	exit 1
fi

if curl --noproxy '' --silent --max-time 3 --output /dev/null --proxy "socks5h://127.0.0.1:$CLIENT_PORT" "http://$LAN_ADDRESS:$LAN_PROBE_PORT/"; then
	printf '%s\n' "Worker egress reached a LAN-bound service" >&2
	exit 1
fi

printf 'VLESS Worker-to-Mac TCP egress test passed; egress location=%s\n' "$WORKER_LOCATION"
printf '%s\n' "Loopback IP, hostname, and LAN isolation tests passed"
