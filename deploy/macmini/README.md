# Mac mini home egress

This directory installs the Trojan relay used behind the Cloudflare Worker.
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

The installer stores this site's relay-only Trojan password in the macOS
Keychain under the `edgetunnel-home-egress` service. This value must not be used
as the public VLESS UUID. The generated sing-box configuration is installed
with mode `0600` at the Homebrew configuration path.
The local test starts a temporary SOCKS client, sends an HTTPS request through
the Trojan relay, and verifies that its public IP matches the Mac's direct
public IP without printing the address.

Reserve the Mac's LAN address in the home router before creating the Cloudflare
private route. Its entry in `EGRESS_SITES` must contain the same address and
port printed by the installer.

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
3. Add the site to `EGRESS_SITES` with an ID, display name, VPC binding name,
   relay address, and a unique `secret_env` name.
4. Bind this Tunnel directly to the Worker under the matching VPC Network
   binding name using its `tunnel_id`.
5. Set `DEFAULT_EGRESS` to this site ID if the Mac should remain the default.
6. Copy the relay password from the `edgetunnel-home-egress` Keychain item into
   the Worker's site-specific secret, such as `EGRESS_MAC_RELAY_PASSWORD`.
7. Store a different UUIDv4 in the `edgetunnel-worker-uuid` Keychain item and
   set it as the Worker `UUID` secret. Only this public UUID is used by clients.

Do not configure a public `PROXYIP`, SOCKS5 fallback, or a public route to port
19090. Egress mode is designed to fail closed when the selected VPC binding is
down. It never tries another site unless the client explicitly selects it.

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

`test-worker.sh` reads the public VLESS UUID from the
`edgetunnel-worker-uuid` Keychain item. It never reads or prints the site's
relay password.

For a multi-site deployment, set the explicit site ID so the test cannot pass
through the default by accident:

```sh
HOME_EGRESS_WORKER_HOST=worker.example.com \
HOME_EGRESS_SITE_ID=mac \
./deploy/macmini/test-worker.sh
```

## Shadowrocket subscription

The Worker KV binding enables its subscription endpoint. Egress mode emits
VLESS-over-WebSocket-over-TLS nodes on the public side. Inside Cloudflare, the
Worker translates VLESS TCP requests to the private Trojan relay at the site
selected by the node's `/egress=<site-id>` path segment. VLESS UDP is
deliberately not advertised so all supported traffic remains fail-closed
through that site. The selector is a path segment rather than a query
parameter so it survives every transport, including gRPC, whose `serviceName`
discards everything after `?`.

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
then update the subscription and select the desired site node. Every ingress
route is duplicated for each configured egress site; the original route name is
preserved after the site name, and no flag emoji is added.

`HOME_EGRESS` plus `HOME_NET` remain supported as a single-site compatibility
configuration. New deployments should use `EGRESS_SITES`, `DEFAULT_EGRESS`,
`EGRESS_PROTOCOL`, and one VPC binding per site as shown in
[`wrangler.example.toml`](../../wrangler.example.toml).
