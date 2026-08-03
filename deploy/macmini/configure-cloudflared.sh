#!/bin/sh
set -eu

TUNNEL_NAME="${HOME_EGRESS_TUNNEL_NAME:-edgetunnel-macmini-egress}"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
TEMPLATE_PATH="$SCRIPT_DIR/cloudflared-config.json.template"
CLOUDFLARED_DIR="$HOME/.cloudflared"
CONFIG_PATH="$CLOUDFLARED_DIR/config.yml"
ROUTE_CIDR="${HOME_EGRESS_ROUTE_CIDR:-127.0.0.1/32}"

if ! wrangler whoami >/dev/null 2>&1; then
	printf '%s\n' "Wrangler is not authenticated. Run: wrangler login --use-keyring" >&2
	exit 1
fi

if [ ! -f "$CLOUDFLARED_DIR/cert.pem" ]; then
	printf '%s\n' "cloudflared is not authenticated. Run: cloudflared tunnel login" >&2
	exit 1
fi

mkdir -p "$CLOUDFLARED_DIR"
TUNNEL_ID="$(cloudflared tunnel list --output json | jq -r --arg name "$TUNNEL_NAME" '(. // [])[] | select(.name == $name and (.deleted_at == null or .deleted_at == "0001-01-01T00:00:00Z")) | .id' | head -n 1)"

if [ -z "$TUNNEL_ID" ]; then
	cloudflared tunnel create "$TUNNEL_NAME" >/dev/null
	TUNNEL_ID="$(cloudflared tunnel list --output json | jq -r --arg name "$TUNNEL_NAME" '(. // [])[] | select(.name == $name and (.deleted_at == null or .deleted_at == "0001-01-01T00:00:00Z")) | .id' | head -n 1)"
fi

if [ -z "$TUNNEL_ID" ]; then
	printf '%s\n' "Unable to resolve the Cloudflare Tunnel ID" >&2
	exit 1
fi

CREDENTIALS_PATH="$CLOUDFLARED_DIR/$TUNNEL_ID.json"
if [ ! -f "$CREDENTIALS_PATH" ]; then
	printf 'Tunnel credentials not found: %s\n' "$CREDENTIALS_PATH" >&2
	exit 1
fi

jq \
	--arg tunnel "$TUNNEL_ID" \
	--arg credentials "$CREDENTIALS_PATH" \
	'.tunnel = $tunnel | ."credentials-file" = $credentials' \
	"$TEMPLATE_PATH" > "$CONFIG_PATH"
chmod 600 "$CONFIG_PATH"

if ! cloudflared tunnel route ip show --output json | jq -e --arg cidr "$ROUTE_CIDR" --arg tunnel "$TUNNEL_ID" '(. // [])[] | select(.network == $cidr and .tunnel_id == $tunnel)' >/dev/null; then
	cloudflared tunnel route ip add "$ROUTE_CIDR" "$TUNNEL_ID" >/dev/null
fi

printf 'Tunnel %s is configured for private route %s\n' "$TUNNEL_ID" "$ROUTE_CIDR"
printf 'Run %s/install-cloudflared-service.sh while logged into the Mac to install its LaunchAgent.\n' "$SCRIPT_DIR"
