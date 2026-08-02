#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
RUNTIME_DIR="$SCRIPT_DIR/runtime"
SITE_INDEX="${EGRESS_SITE_INDEX:-}"
STTY_STATE=''

restore_terminal() {
	if [ -n "$STTY_STATE" ]; then
		stty "$STTY_STATE" 2>/dev/null || true
		STTY_STATE=''
	fi
}

cleanup() {
	restore_terminal
	if [ -n "${TEMP_CONFIG:-}" ]; then rm -f "$TEMP_CONFIG"; fi
	if [ -n "${TEMP_COMPOSE:-}" ]; then rm -f "$TEMP_COMPOSE"; fi
}

trap cleanup EXIT HUP INT TERM

if ! command -v docker >/dev/null 2>&1; then
	printf '%s\n' 'Docker Engine is required.' >&2
	exit 1
fi
if docker compose version >/dev/null 2>&1; then
	compose() { docker compose "$@"; }
elif command -v docker-compose >/dev/null 2>&1 && docker-compose version >/dev/null 2>&1; then
	compose() { docker-compose "$@"; }
else
	printf '%s\n' 'Docker Compose v2 or docker-compose is required.' >&2
	exit 1
fi

DOCKER_ARCH="$(docker version --format '{{.Server.Arch}}' 2>/dev/null || true)"
case "$DOCKER_ARCH" in
	amd64|arm64) ;;
	'') printf '%s\n' 'Cannot reach the Docker daemon.' >&2; exit 1 ;;
	*) printf 'Unsupported NAS Docker architecture: %s (requires amd64 or arm64).\n' "$DOCKER_ARCH" >&2; exit 1 ;;
esac

case "$SITE_INDEX" in
	''|*[!0-9]*) printf '%s\n' 'Set EGRESS_SITE_INDEX to the owner-assigned number from 1 to 254.' >&2; exit 1 ;;
esac
if [ "$SITE_INDEX" -lt 1 ] || [ "$SITE_INDEX" -gt 254 ]; then
	printf '%s\n' 'EGRESS_SITE_INDEX must be between 1 and 254.' >&2
	exit 1
fi
if [ ! -t 0 ]; then
	printf '%s\n' 'Run this script from an interactive terminal so secrets are not passed as arguments.' >&2
	exit 1
fi

read_secret() {
	printf '%s' "$2"
	STTY_STATE="$(stty -g)"
	stty -echo
	IFS= read -r "$1"
	restore_terminal
	printf '\n'
}

read_secret TUNNEL_TOKEN 'Paste the tunnel-specific cloudflared token: '
read_secret RELAY_PASSWORD 'Paste the 64-character site relay password: '

if [ "${#TUNNEL_TOKEN}" -lt 100 ]; then
	printf '%s\n' 'The tunnel token is unexpectedly short.' >&2
	exit 1
fi
case "$TUNNEL_TOKEN" in
	*[[:space:]]*) printf '%s\n' 'The tunnel token must not contain whitespace.' >&2; exit 1 ;;
esac
if [ "${#RELAY_PASSWORD}" -ne 64 ]; then
	printf '%s\n' 'The site relay password must be a 64-character hexadecimal value.' >&2
	exit 1
fi
case "$RELAY_PASSWORD" in
	*[!0-9a-fA-F]*) printf '%s\n' 'The site relay password must be hexadecimal.' >&2; exit 1 ;;
esac

SITE_SUBNET="172.30.$SITE_INDEX.0/29"
RELAY_IP="172.30.$SITE_INDEX.2"
CLOUDFLARED_IP="172.30.$SITE_INDEX.3"
umask 077
mkdir -p "$RUNTIME_DIR"

printf '%s\n' "$TUNNEL_TOKEN" > "$RUNTIME_DIR/tunnel-token"
chmod 600 "$RUNTIME_DIR/tunnel-token"

TEMP_CONFIG="$(mktemp "${TMPDIR:-/tmp}/edgetunnel-nas-config.XXXXXX")"
TEMP_COMPOSE="$(mktemp "${TMPDIR:-/tmp}/edgetunnel-nas-compose.XXXXXX")"

while IFS= read -r TEMPLATE_LINE || [ -n "$TEMPLATE_LINE" ]; do
	case "$TEMPLATE_LINE" in
		*__RELAY_PASSWORD__*)
			LINE_PREFIX="${TEMPLATE_LINE%%__RELAY_PASSWORD__*}"
			LINE_SUFFIX="${TEMPLATE_LINE#*__RELAY_PASSWORD__}"
			printf '%s%s%s\n' "$LINE_PREFIX" "$RELAY_PASSWORD" "$LINE_SUFFIX"
			;;
		*) printf '%s\n' "$TEMPLATE_LINE" ;;
	esac
done < "$SCRIPT_DIR/sing-box.json.template" > "$TEMP_CONFIG"
sed \
	-e "s|__SITE_SUBNET__|$SITE_SUBNET|g" \
	-e "s|__RELAY_IP__|$RELAY_IP|g" \
	-e "s|__CLOUDFLARED_IP__|$CLOUDFLARED_IP|g" \
	"$SCRIPT_DIR/compose.yaml.template" > "$TEMP_COMPOSE"
install -m 600 "$TEMP_CONFIG" "$RUNTIME_DIR/sing-box.json"
install -m 600 "$TEMP_COMPOSE" "$RUNTIME_DIR/compose.yaml"
unset TUNNEL_TOKEN RELAY_PASSWORD

compose -f "$RUNTIME_DIR/compose.yaml" config --quiet
compose -f "$RUNTIME_DIR/compose.yaml" pull
compose -f "$RUNTIME_DIR/compose.yaml" run --rm --no-deps sing-box check -c /etc/sing-box/config.json

printf 'Prepared NAS bridge %s (relay %s, cloudflared %s).\n' "$SITE_SUBNET" "$RELAY_IP" "$CLOUDFLARED_IP"
printf 'Review the files, then start with: docker compose -f %s up -d\n' "$RUNTIME_DIR/compose.yaml"
