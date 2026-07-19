# Mac mini home egress

This directory installs the final Trojan relay used behind the Cloudflare Worker.
The relay listens on the Mac's current default-interface address and sends all
accepted TCP and UDP traffic through the Mac's normal Internet connection.

See [LESSONS_LEARNED.md](./LESSONS_LEARNED.md) for the sanitized deployment,
GFW compatibility, Shadowrocket, cost, monitoring, and security conclusions
from operating this path in production.

## Local install

```sh
./deploy/macmini/install.sh
./deploy/macmini/status.sh
./deploy/macmini/test-local.sh
```

The installer stores the shared Trojan/Worker UUID in the macOS Keychain under
the `edgetunnel-home-egress` service. The generated sing-box configuration is
installed with mode `0600` at the Homebrew configuration path.
The local test starts a temporary SOCKS client, sends an HTTPS request through
the Trojan relay, and verifies that its public IP matches the Mac's direct
public IP without printing the address.

Reserve the Mac's LAN address in the home router before creating the Cloudflare
private route. The Worker `HOME_EGRESS` variable must contain the same address
and port printed by the installer.

## Cloudflare resources

This public repository does not track the active `wrangler.toml`. Create it
from the sanitized template before deployment and keep all real resource IDs
and endpoints in the ignored local file:

```sh
cp wrangler.example.toml wrangler.toml
```

Replace every example value, including the documentation-only TEST-NET relay
address. Store `ADMIN`, `UUID`, and other credentials with `wrangler secret`
rather than adding them to the TOML file.

1. Create a named Cloudflare Tunnel and run its connector on this Mac.
2. Enable private-network routing and route only the relay address as a `/32`.
3. Bind the Tunnel directly to the Worker as the `HOME_NET` VPC Network binding
   using its `tunnel_id`.
4. Set `HOME_EGRESS` to the relay address and port.
5. Set the Worker `UUID` secret from the Keychain credential.

Do not configure a public `PROXYIP`, SOCKS5 fallback, or a public route to port
19090. Home-egress mode is designed to fail closed when `HOME_NET` is down.

After completing both CLI logins, `configure-cloudflared.sh` can create or reuse
the named Tunnel, write the local connector configuration, and add the relay
address as a `/32` private route. It deliberately stops before installing the
LaunchAgent so the command can be run interactively:

```sh
wrangler login --use-keyring
cloudflared tunnel login
./deploy/macmini/configure-cloudflared.sh
./deploy/macmini/install-cloudflared-service.sh
```

After deploying the Worker, verify the complete Worker-to-Mac path:

```sh
HOME_EGRESS_WORKER_HOST=worker.example.com ./deploy/macmini/test-worker.sh
```

## Shadowrocket subscription

The Worker KV binding enables its subscription endpoint. Home-egress mode emits
VLESS-over-WebSocket-over-TLS nodes on the public side. Inside Cloudflare, the
Worker translates VLESS TCP requests to the private Trojan relay on the Mac.
VLESS UDP is deliberately not advertised so all supported traffic remains
fail-closed through the Mac mini.

The production Shadowrocket profile uses VLESS over WebSocket with certificate
verification, a Chrome fingerprint, randomized paths, ECH via Ali DoH and
`cloudflare-ech.com`, Shadowrocket TLS fragmentation, and 0-RTT disabled.
`PROXYIP=auto` may remain in the shared configuration, but forced home-egress
mode deliberately ignores it so traffic cannot bypass the Mac relay.

Append `&cnIspCode=all` to generate the mixed ingress profile. It combines
China Telecom, China Unicom, China Mobile, and official Cloudflare CIDR pools,
then adds nodes for the configured custom hostname on every supported TLS port.
These are route-diversity labels rather than fixed Cloudflare city locations
because Cloudflare anycast selects the actual ingress colo dynamically.

The domain-bound subscription token is stored in the macOS Keychain under the
`edgetunnel-shadowrocket-token` service. The separate
`edgetunnel-shadowrocket-subscription` item remains the static Worker `KEY`
used by its redirecting quick-subscription path. The direct token below avoids
that redirect and is regenerated whenever the public hostname changes.

Copy the subscription URL without printing its private path:

```sh
subscription_token="$(security find-generic-password \
  -s edgetunnel-shadowrocket-token \
  -a "$(id -un)" -w)"
worker_host="${HOME_EGRESS_WORKER_HOST:?set the Worker custom hostname}"
printf 'https://%s/sub?token=%s' \
  "$worker_host" "$subscription_token" | pbcopy
```

Append `&ech=0` to the subscription URL to generate a compatibility profile
without ECH. This is useful for isolating older Shadowrocket versions or access
networks where ECH negotiation succeeds during a latency test but proxied data
does not pass reliably. Omitting the parameter keeps the KV-configured default.

In Shadowrocket, add a server with type `Subscribe`, paste the URL, save it,
then update the subscription and select the fastest imported node.
