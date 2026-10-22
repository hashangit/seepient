# Self-hosting on a restricted network

How to start the stack on a host whose egress is restricted to one
digest-verified Hub mirror. The documented startup is exercised by
`infra/compose/mirror-startup-doc.smoke.sh` with a fake Docker CLI, so the
block below is executable documentation.

## Digest-verified Hub mirror startup

Run from the repository root with `infra/compose/.env` populated. Every image
is pinned to a digest that was verified out of band; startup refuses any
mirror response whose digest differs, and never starts containers with a
fresher pull than the pinned digests.

```bash
set -euo pipefail
cd "$(dirname "$0")"
# Older compose versions silently ignore --pull and would still reach the
# network at up time; require explicit support before doing anything else.
if ! docker compose up --help 2>/dev/null | grep -q -- '--pull'; then
  echo "docker compose does not support --pull; upgrade the compose plugin." >&2
  exit 1
fi
# Refresh through the mirror only; a failed pull must stop startup.
docker compose --env-file .env -f docker-compose.images.yml pull
# The mirror must serve exactly the digests that were verified out of band.
for image in \
  "ghcr.io/example/postgres@sha256:<trusted-postgres-digest>" \
  "registry.example.com/library/busybox@sha256:<trusted-busybox-digest>"; do
  reported="$(docker image inspect --format '{{index .RepoDigests 0}}' "$image")"
  if [[ "$reported" != "$image" ]]; then
    echo "digest mismatch for $image: mirror served $reported" >&2
    exit 1
  fi
done
# Start strictly from local content; --pull never keeps the daemon from
# re-resolving anything at up time.
docker compose --env-file .env -f docker-compose.images.yml up -d --pull never
```
