# NAS egress site

Use this guide to add a NAS as a separately selectable household egress site.
The NAS may reuse an existing `cloudflared` installation, but it needs its own
Named Tunnel and a local authenticated TCP egress relay.

`cloudflared` is only the private-network connector. It does not parse VLESS or
Trojan and cannot replace the relay that opens each requested Internet TCP
connection from the NAS location.

## 1. Run a local relay

Run sing-box or an equivalent relay on the NAS LAN address. The existing
[`sing-box.json.template`](../macmini/sing-box.json.template) is portable: set
its listen address, listen port, and Trojan password using the NAS secret
management mechanism.

The Trojan password must equal this site's dedicated Worker secret referenced
by `secret_env`. It must not equal the public VLESS `UUID` or another site's
relay password. Do not commit the rendered relay configuration.

Do not expose the relay port through the router or NAS public firewall. Reserve
the NAS LAN address so its private `/32` route stays stable.

## 2. Create a separate Tunnel

Create a new Named Tunnel for this site rather than adding the NAS as a replica
of the Mac Tunnel:

```sh
cloudflared tunnel create edgetunnel-nas-egress
cloudflared tunnel route ip add <nas-relay-ip>/32 edgetunnel-nas-egress
```

Enable private routing in the NAS cloudflared configuration:

```yaml
tunnel: <nas-tunnel-id>
credentials-file: <nas-tunnel-credentials-file>
warp-routing:
  enabled: true
protocol: auto
```

The NAS network should permit cloudflared's outbound QUIC traffic on UDP port
7844. With `auto`, cloudflared can use HTTP/2 over TCP 7844 if UDP is blocked.
No inbound Internet port is required.

## 3. Add the Worker binding and site

Copy [`wrangler.example.toml`](../../wrangler.example.toml) to the ignored
`wrangler.toml`. Add a VPC Network binding for the NAS Tunnel and reference the
same binding name from `EGRESS_SITES`:

```toml
EGRESS_SITES = '''
[
  { "id": "mac", "name": "Taiwan Mac mini", "binding": "EGRESS_MAC_NET", "address": "<mac-relay-ip>:19090", "secret_env": "EGRESS_MAC_RELAY_PASSWORD" },
  { "id": "nas", "name": "Site B NAS", "binding": "EGRESS_NAS_NET", "address": "<nas-relay-ip>:19090", "secret_env": "EGRESS_NAS_RELAY_PASSWORD" }
]
'''
DEFAULT_EGRESS = "mac"
EGRESS_PROTOCOL = "vless"

[[vpc_networks]]
binding = "EGRESS_NAS_NET"
tunnel_id = "<nas-tunnel-id>"
remote = true
```

Actual tunnel IDs, relay addresses, UUIDs, tokens, and credentials belong only
in the ignored deployment configuration or secret stores.

If this NAS belongs to a friend, do not give them `cloudflared tunnel login`,
Wrangler, an API token, or your account `cert.pem`. Use the remotely-managed,
tunnel-specific workflow in [`deploy/friend/README.md`](../friend/README.md)
instead.

## 4. Verify without fallback

Update the Shadowrocket subscription. It should contain site-prefixed node
names for both `mac` and `nas`; each node carries its own `egress` selector in
the WebSocket path.

Verify a NAS node with a real HTTPS page and confirm the observed public IP
matches the NAS location. Then stop the NAS relay and repeat: the NAS node must
fail, while the Worker must not use the Mac binding or Cloudflare public egress.
The Mac node remains available only when selected explicitly.
