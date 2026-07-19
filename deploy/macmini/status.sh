#!/bin/sh
set -eu

BREW_PREFIX="$(brew --prefix)"
CONFIG_PATH="$BREW_PREFIX/etc/sing-box/config.json"

sing-box check -c "$CONFIG_PATH"
brew services list | awk 'NR == 1 || $1 == "sing-box" || $1 == "cloudflared"'
CLOUDFLARED_STATE="$(launchctl print "gui/$(id -u)/com.cloudflare.cloudflared" 2>/dev/null | awk -F'= ' '/^[[:space:]]*state =/{print $2; exit}' || true)"
printf 'cloudflared LaunchAgent: %s\n' "${CLOUDFLARED_STATE:-not installed}"
lsof -nP -iTCP:19090 -sTCP:LISTEN
