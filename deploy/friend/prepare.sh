#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
RUNTIME_DIR="$SCRIPT_DIR/runtime"
SITE_INDEX="${FRIEND_SITE_INDEX:-}"
STTY_STATE=''

restore_terminal() {
	if [ -n "$STTY_STATE" ]; then
		stty "$STTY_STATE" 2>/dev/null || true
		STTY_STATE=''
	fi
}

trap restore_terminal EXIT HUP INT TERM

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
	printf '%s\n' 'Docker with the Compose plugin is required.' >&2
	exit 1
fi

case "$SITE_INDEX" in
	''|*[!0-9]*) printf '%s\n' 'Set FRIEND_SITE_INDEX to the owner-assigned number from 1 to 254.' >&2; exit 1 ;;
esac
if [ "$SITE_INDEX" -lt 1 ] || [ "$SITE_INDEX" -gt 254 ]; then
	printf '%s\n' 'FRIEND_SITE_INDEX must be between 1 and 254.' >&2
	exit 1
fi
if [ ! -t 0 ]; then
	printf '%s\n' 'Run this script from an interactive terminal so secrets are not passed as arguments.' >&2
	exit 1
fi

STTY_STATE="$(stty -g)"
printf '%s' 'Paste the tunnel-specific cloudflared token: '
stty -echo
IFS= read -r TUNNEL_TOKEN
stty "$STTY_STATE"
STTY_STATE=''
printf '\n'

STTY_STATE="$(stty -g)"
printf '%s' 'Paste the 64-character site relay password: '
stty -echo
IFS= read -r RELAY_PASSWORD
stty "$STTY_STATE"
STTY_STATE=''
printf '\n'

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
umask 077
mkdir -p "$RUNTIME_DIR"

printf '%s\n' "$TUNNEL_TOKEN" > "$RUNTIME_DIR/tunnel-token"
chmod 600 "$RUNTIME_DIR/tunnel-token"

TEMP_CONFIG="$(mktemp "${TMPDIR:-/tmp}/edgetunnel-friend-config.XXXXXX")"
TEMP_COMPOSE="$(mktemp "${TMPDIR:-/tmp}/edgetunnel-friend-compose.XXXXXX")"
cleanup() {
	restore_terminal
	rm -f "$TEMP_CONFIG" "$TEMP_COMPOSE"
}
trap cleanup EXIT HUP INT TERM

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
	"$SCRIPT_DIR/compose.yaml.template" > "$TEMP_COMPOSE"
install -m 600 "$TEMP_CONFIG" "$RUNTIME_DIR/sing-box.json"
install -m 600 "$TEMP_COMPOSE" "$RUNTIME_DIR/compose.yaml"
unset TUNNEL_TOKEN RELAY_PASSWORD

docker compose -f "$RUNTIME_DIR/compose.yaml" config --quiet
docker compose -f "$RUNTIME_DIR/compose.yaml" pull
docker compose -f "$RUNTIME_DIR/compose.yaml" run --rm --no-deps sing-box check -c /etc/sing-box/config.json

printf 'Prepared an isolated endpoint network at %s with relay %s:19090.\n' "$SITE_SUBNET" "$RELAY_IP"
printf 'Review the files, then start with: docker compose -f %s up -d\n' "$RUNTIME_DIR/compose.yaml"
