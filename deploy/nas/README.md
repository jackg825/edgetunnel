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

The Trojan password must equal the Worker's fixed `UUID` secret because the
Worker translates public VLESS TCP requests into that authenticated private
Trojan stream. Do not commit the rendered relay configuration.

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
protocol: quic
```

The NAS network must permit cloudflared's outbound QUIC traffic on UDP port
7844. No inbound Internet port is required.

## 3. Add the Worker binding and site

Copy [`wrangler.example.toml`](../../wrangler.example.toml) to the ignored
`wrangler.toml`. Add a VPC Network binding for the NAS Tunnel and reference the
same binding name from `EGRESS_SITES`:

```toml
EGRESS_SITES = '''
[
  { "id": "mac", "name": "Taiwan Mac mini", "binding": "EGRESS_MAC_NET", "address": "<mac-relay-ip>:19090" },
  { "id": "nas", "name": "Site B NAS", "binding": "EGRESS_NAS_NET", "address": "<nas-relay-ip>:19090" }
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

## 4. Verify without fallback

Update the Shadowrocket subscription. It should contain site-prefixed node
names for both `mac` and `nas`; each node carries its own `egress` selector in
the WebSocket path.

Verify a NAS node with a real HTTPS page and confirm the observed public IP
matches the NAS location. Then stop the NAS relay and repeat: the NAS node must
fail, while the Worker must not use the Mac binding or Cloudflare public egress.
The Mac node remains available only when selected explicitly.
