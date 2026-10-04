# edgetunnel fork guidance

This fork adds private home egress to the Cloudflare Worker in `_worker.js`, with administration helpers in `admin-egress.js` and `admin-session.js`. Preserve the fork's egress behavior when adapting upstream changes.

## Security and compatibility invariants

- Egress selection is explicit through `/egress=<site-id>`. If the selected VPC binding fails, fail closed; do not fall back to the public network or a different site.
- Keep relay credentials separate from the public client UUID. Never commit active `wrangler.toml`, real resource IDs, private endpoints, UUIDs, admin credentials, or subscription tokens; `wrangler.example.toml` and deployment templates must stay sanitized.
- Preserve destination-range isolation and hostname resolution checks. A public client must not gain access to the host, LAN, or reserved destinations through the relay.
- On the Mac connector, preserve the loopback relay address and narrow `127.0.0.1/32` route documented in `deploy/macmini/README.md`. Do not replace unrelated cloudflared services or configuration.

## Validation

`package.json` defines `npm test` as `node --test`; CI uses Node.js 22 on Linux and macOS. The configured checks are:

```sh
node --check _worker.js
node --check admin-egress.js
for script in deploy/macmini/*.sh deploy/nas/*.sh; do sh -n "$script"; done
npm test
```

Use affected test files during iteration and preserve the full CI checks for code changes. Instruction-only edits need reference and diff checks. There is no separate package build or lint script.

## Deployment references

Read the relevant `deploy/macmini/README.md`, `deploy/nas/README.md`, or `deploy/friend/README.md` before deployment changes. Mac operating constraints and prior failures are in `deploy/macmini/LESSONS_LEARNED.md`.

Deployment scripts can install services, read Keychain credentials, and change networking. `deploy/macmini/test-local.sh` and `test-worker.sh` exercise actual relays/network paths; they are not substitutes for the isolated Node test suite. Run those operations only within the requested environment and authorization.
