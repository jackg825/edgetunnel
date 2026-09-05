# Mac mini home egress

This directory installs the Trojan relay used behind the Cloudflare Worker.
sing-box accepts Trojan on loopback and sends TCP and UDP traffic through the
Mac's normal Internet connection. The Cloudflare Tunnel advertises only
`127.0.0.1/32`, so the connector reaches sing-box without exposing the relay to
the LAN.

The loopback route avoids a macOS 26.6 failure affecting TCP connections whose
source and destination are the same non-loopback address. It also removes the
need for a local TCP forwarder, preserving the shortest path and highest
available throughput.

See [LESSONS_LEARNED.md](./LESSONS_LEARNED.md) for the sanitized deployment,
GFW compatibility, Shadowrocket, cost, monitoring, and security conclusions
from operating this path in production.

## Local install

Prerequisites: Homebrew, sing-box, cloudflared, jq, Node.js, and Wrangler. Run
the scripts as the user who owns the relay configuration and Tunnel credentials.

```sh
./deploy/macmini/install.sh
./deploy/macmini/test-local.sh
```

The installer stores this site's relay-only Trojan password in the macOS
Keychain under the `edgetunnel-home-egress` service. This value must not be used
as the public VLESS UUID. The generated sing-box configuration is installed
with mode `0600` at the Homebrew configuration path.
The local test starts a temporary SOCKS client, sends an HTTPS request through
the loopback Trojan relay, and verifies that its public IP matches the Mac's
direct public IP without printing the address.
Both direct-IP baselines explicitly use IPv4 to match the relay, and tests
override shell proxy exclusions so `NO_PROXY` cannot bypass the tested proxy.

The Mac entry in `EGRESS_SITES` should use `127.0.0.1:19090`. Do not use the
Mac's LAN address for a connector and origin running on the same macOS host.

## Local-network isolation

The generated sing-box configuration resolves destination hostnames before
routing, then rejects non-public, loopback, RFC 1918, link-local, CGNAT,
benchmark, documentation, multicast, reserved, and IPv6 destination ranges.
Friends using the public VLESS endpoint can therefore reach public IPv4
Internet services but cannot use the Mac relay to connect to the Mac itself,
the home router, other LAN devices, or a hostname that resolves to one of those
addresses. `test-worker.sh` verifies loopback IP, hostname-based, and LAN-bound
attempts against temporary HTTP listeners that are removed after the test.

Keep router port forwarding, UPnP, and NAT-PMP disabled for Mac services that
must remain private. An intentionally published service on the router's public
WAN address is outside this destination-range policy and should have its own
authentication and firewall controls.

## Cloudflare resources

This public repository does not track the active `wrangler.toml`. Create it
from the sanitized template before deployment and keep all real resource IDs
and endpoints in the ignored local file:

```sh
cp wrangler.example.toml wrangler.toml
```

Replace the example resource IDs and site-specific values, including the
documentation-only TEST-NET NAS address. Keep the Mac address at
`127.0.0.1:19090` when cloudflared and sing-box run on the same host. Store
`ADMIN`, `UUID`, and other credentials with `wrangler secret` rather than adding
them to the TOML file.

1. Create a named Cloudflare Tunnel and run its connector on this Mac.
2. Enable private-network routing and route only `127.0.0.1/32` through this
   Tunnel.
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
the named Tunnel, write the local connector configuration, and add
`127.0.0.1/32` as the private route. The project configuration is
`~/.cloudflared/edgetunnel-macmini.json`; the project service label is
`com.edgetunnel.macmini.cloudflared`. Existing `~/.cloudflared/config.yml` and
`com.cloudflare.cloudflared` services are preserved.

For an interactive deployment that runs while this user is logged in:

```sh
wrangler login --use-keyring
cloudflared tunnel login
./deploy/macmini/configure-cloudflared.sh
./deploy/macmini/install-cloudflared-service.sh
./deploy/macmini/status.sh
```

### Run before GUI login

For an unattended Mac mini, run the following **as the existing relay owner,
without prefixing the script with sudo**, after the local relay and Tunnel
configuration are ready:

```sh
./deploy/macmini/install-system-services.sh
./deploy/macmini/status.sh
```

The installer requests sudo only to install and register two root-owned
`/Library/LaunchDaemons/com.edgetunnel.macmini.{sing-box,cloudflared}.plist`
files. Both daemons use `UserName` to run as the invoking user, reuse the existing
relay configuration and Tunnel credentials, and restart after process exits.
No Keychain prompt is needed at service startup: sing-box reads its existing
`0600` configuration. The installer unregisters the user's Homebrew sing-box
job and this project's cloudflared LaunchAgent to prevent duplicate processes.
It refuses to replace a pre-existing system Homebrew sing-box job.

After switching to system services, `install.sh` restarts the system relay when
updating its configuration. Use `install-system-services.sh` to update the
system jobs; the user cloudflared installer will refuse to create a duplicate.
Run diagnostics as the same relay owner. If launchd inspection is denied,
`status.sh` fails explicitly instead of treating an installed system job as absent.

There are two OS-level limits to unattended recovery:

- FileVault must unlock the startup disk before these daemons can run after a
  cold boot. A LaunchDaemon cannot bypass disk encryption. Keep an appropriate
  disk-unlock recovery procedure; installing these jobs does not remove that
  requirement or alter FileVault.
- In **System Settings → Energy**, enable **Prevent automatic sleeping when
  the display is off** and **Start up automatically after a power failure**
  where supported. The screen may sleep; the Mac must remain awake to carry
  traffic. Wake for network access alone does not keep the Tunnel continuously
  available. These settings are not changed by the installer.

See [Apple sleep settings](https://support.apple.com/guide/mac-help/mchle41a6ccd/mac)
and [FileVault startup protection](https://support.apple.com/guide/security/sec4c6dc1b6e/web).

### Upgrading the earlier shared cloudflared installation

Earlier versions used `~/.cloudflared/config.yml` and
`~/Library/LaunchAgents/com.cloudflare.cloudflared.plist`. The new installer
does not delete or stop either. Inspect that old configuration and its plist
first. **Only if they belong exclusively to this egress project**, unload the
old user job and move its plist out of `LaunchAgents` before starting the new
project service. If they serve another Tunnel, keep them. Regenerate the project
configuration with `configure-cloudflared.sh`; it reuses the named Tunnel and
existing credentials.

### Status, recovery and rollback

`status.sh` requires the correct relay process to own the configured listener,
and the project cloudflared process to own its loopback metrics listener. It
then checks `http://127.0.0.1:19094/ready` for an active Tunnel connection.
Missing, stopped, inaccessible or disconnected services return nonzero. Port
`19094` is reserved for this project's local metrics; it is never exposed to
the LAN. Cloudflare documents the [metrics listener](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/monitor-tunnels/metrics/),
and its [readiness handler](https://github.com/cloudflare/cloudflared/blob/master/metrics/readiness.go)
returns `503` when no edge connection is active. This local check does not
replace the Worker-to-Mac test below.

Service logs are in `~/Library/Logs/edgetunnel/`. If system installation fails,
inspect those logs and the corresponding `sudo launchctl print system/<label>`
output, fix the cause, and rerun the system installer. To restore the earlier
interactive mode, unload and remove **only these two project jobs**, then
reinstall the user services:

```sh
sudo launchctl bootout system/com.edgetunnel.macmini.cloudflared
sudo launchctl bootout system/com.edgetunnel.macmini.sing-box
sudo rm -f /Library/LaunchDaemons/com.edgetunnel.macmini.cloudflared.plist \
  /Library/LaunchDaemons/com.edgetunnel.macmini.sing-box.plist
./deploy/macmini/install.sh
./deploy/macmini/install-cloudflared-service.sh
./deploy/macmini/status.sh
```

A `bootout` error indicating a job is not loaded is expected after a partial
installation; proceed with removing the two project plist files. Configuration
and credentials remain available for reinstallation.

Before relying on unattended service, verify logout and reboot without GUI
login after disk unlock; disconnect and reconnect the network and verify
`status.sh` returns failure then success; and repeat a real proxied HTTPS request
from the Chinese client. In a scheduled maintenance window, stop the selected
relay and verify that its client node fails instead of switching egress, then
restart the relay and verify recovery. `test-worker.sh` verifies normal egress
and local-network isolation; it does not stop production services or simulate
a Tunnel outage.

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

## Management sessions and request privacy

Admin login now issues a random, server-recorded session that expires after
24 hours. Deploying this change invalidates the old deterministic cookies;
sign in again with the existing admin password. Client UUIDs, subscriptions,
and relay credentials do not change. Logout deletes the presented session
record before reporting success, including after a browser user-agent change.
Changing `ADMIN` or `KEY` also invalidates existing admin sessions.

Session records use the existing KV binding. Expiration is checked on every
authenticated request, and a KV failure denies access. Logout revocation is
subject to [KV propagation](https://developers.cloudflare.com/kv/concepts/how-kv-works/)
between Cloudflare locations; it is not globally instantaneous. No additional
session cache or storage binding is introduced.

Login, logout, reset, and configuration writes require a `POST` with an
`Origin` exactly matching the Worker origin. Browser controls supply this;
API clients must supply it explicitly. `GET /admin/init` returns `405` without
resetting data, and `GET /logout` displays a confirmation form. Administrative
configuration reads do not initialize missing configuration records.

When `URL` selects a third-party camouflage site, only public content headers
are forwarded. Authentication headers and cookies are omitted, response
cookies are removed, and redirects are not followed on the server. Third-party
documents receive a [CSP sandbox](https://www.w3.org/TR/CSP/#directive-sandbox)
without script or same-origin privileges; interactive camouflage pages that
need JavaScript or forms will no longer work. The built-in nginx page and
authenticated management pages are unaffected.

`OFF_LOG=true` or `OFF_LOG=1` disables both Telegram notifications and KV
logging. When logging is enabled, URL fields retain only the origin, excluding
paths, query strings, userinfo, and fragments. Existing KV URL fields are
sanitized on the next enabled log write; messages already sent to Telegram are
not recalled.

gRPC accepts uncompressed protobuf frames up to **1 MiB**, including protobuf
framing. Oversized lengths, invalid protobuf fields, and truncated frames close
the request and any relay connection. Multiple frames and fragmented HTTP
uploads remain supported.
