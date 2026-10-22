# Self-hosting

Notes for running the stack on your own host. See `docs/self-host-restricted-network.md`
for mirror-based installs whose egress reaches only a digest-verified Hub mirror.

## Computer egress restriction

Local Docker computers run on dedicated bridge networks. By default (`open`)
they can reach the host, the LAN, and link-local cloud-metadata endpoints. Set

```bash
# .env — the compose files pass this through to the supervisor
SANDBOX_COMPUTER_EGRESS=restricted
```

(`SANDBOX_COMPUTER_EGRESS=open|restricted`; see `.env.example` and
`infra/compose/.env.images.example`) to mark computer networks for restricted
egress. The flag only labels the networks — enforcement lives on the Docker
host. As root, install the host-side firewall rules once:

```bash
sudo bash infra/compose/restrict-computer-egress.sh --install
```

The installed unit drops computer-originated traffic to non-public
destinations (host, RFC1918/LAN, link-local metadata) on the deterministic
`seep-c*` bridge interfaces while keeping same-bridge peers (supervisor, web
screen proxy) reachable. Use `--print` to preview the rules without applying
them and `--remove` to uninstall. Without the host rules, `restricted` mode
marks the networks but does not enforce anything.
