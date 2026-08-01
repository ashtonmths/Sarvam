#!/usr/bin/env bash
#
# Bring the monitoring stack up locally, or take it down.
#
#   pnpm obs:up
#   pnpm obs:down
#
# The base compose file assumes production: an external network Traefik also
# joins, three credential files, and two env vars with no defaults. None of
# that exists on a laptop, and the gap is exactly why the stack was written,
# verified once, and then never opened again by anyone.
#
# This script closes the gap without weakening the production file. Everything
# it creates is dev-only, gitignored, and idempotent, so it is safe to re-run.

set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
obs="$repo/ops/observability"
compose=(docker compose
  -f "$obs/docker-compose.observability.yml"
  -f "$obs/docker-compose.local.yml")

if [[ "${1:-up}" == "down" ]]; then
  # Volumes are kept: dropping them throws away Alloy's read positions, and the
  # next start then replays every container log file it can still see.
  "${compose[@]}" down
  echo "monitoring stack stopped. Volumes kept - 'docker volume ls' to see them."
  exit 0
fi

# --------------------------------------------------------------- the network
#
# Declared `external: true` in the base file because in production the API
# stack joins a network it does not own. Compose will not create an external
# network, so without this the stack fails to start with a message that reads
# like a bug rather than like a missing step.
if ! docker network inspect sadhak-obs >/dev/null 2>&1; then
  docker network create sadhak-obs >/dev/null
  echo "created the sadhak-obs network"
fi

# ------------------------------------------------------------- the API token
#
# /metrics returns 404 unless METRICS_TOKEN is set and presented as a bearer
# token, so Prometheus scrapes nothing until the same value exists in two
# places: the API's .env and the file Prometheus reads it from.
#
# The token is read from .env when it is already there, so re-running this
# never invalidates a scrape that was working.
env_file="$repo/.env"
touch "$env_file"

metrics_token="$(grep -E '^METRICS_TOKEN=' "$env_file" | tail -1 | cut -d= -f2- || true)"
if [[ -z "$metrics_token" ]]; then
  metrics_token="dev-$(openssl rand -hex 16)"
  printf '\n# Added by scripts/obs-local.sh - lets Prometheus scrape /metrics locally.\nMETRICS_TOKEN=%s\n' \
    "$metrics_token" >>"$env_file"
  echo "wrote METRICS_TOKEN into .env"
fi
printf '%s' "$metrics_token" >"$obs/prometheus/metrics-token"

# ----------------------------------------------------------------- the spans
#
# Tracing is off unless this is set - the SDK never starts without an endpoint.
# Setting it is the entire change needed to turn traces on, which was the point
# of writing the spans before a collector existed.
if ! grep -qE '^OTEL_EXPORTER_OTLP_ENDPOINT=' "$env_file"; then
  printf '\n# Added by scripts/obs-local.sh - sends spans to the local Tempo.\nOTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318\n' \
    >>"$env_file"
  echo "wrote OTEL_EXPORTER_OTLP_ENDPOINT into .env"
fi

# ------------------------------------------------------- the two URL secrets
#
# Alertmanager reads both from files and does no variable expansion. Locally
# there is no Slack webhook and no heartbeat monitor, so these get the .example
# placeholders: the config loads, alerts group and route and show up in the
# Alertmanager UI, and only the final delivery hop is missing. That is the
# honest local shape, and it is stated again at the end of this script.
for name in alertmanager/slack-webhook-url alertmanager/watchdog-url; do
  [[ -f "$obs/$name" ]] || cp "$obs/$name.example" "$obs/$name"
done

# --------------------------------------------------------------- the env vars
#
# Both are `:?` in the base file - fail fast rather than start Grafana with a
# blank admin password. Dev defaults, overridable from the caller's shell.
export GF_SECURITY_ADMIN_PASSWORD="${GF_SECURITY_ADMIN_PASSWORD:-sadhak-dev}"
export POSTGRES_EXPORTER_DSN="${POSTGRES_EXPORTER_DSN:-postgres://sadhak:sadhak@host.docker.internal:5432/sadhak?sslmode=disable}"

"${compose[@]}" up -d

cat <<EOF

monitoring stack up.

  Grafana        http://localhost:3002    admin / $GF_SECURITY_ADMIN_PASSWORD
  Prometheus     http://localhost:9090    /targets and /alerts
  Alertmanager   http://localhost:9093

Four dashboards are provisioned: api-health, database-jobs, agents-llm, host.

Loki (:3100) and Tempo (:3200) ship no web UI, so opening either root in a
browser correctly returns 404. Grafana is their interface - use Explore, and
pick the Loki or Tempo datasource. The ports are published for curl and for
health checks:

  curl http://localhost:3100/ready
  curl http://localhost:3200/ready
  curl -G http://localhost:3100/loki/api/v1/query_range \\
    --data-urlencode 'query={service="n8n"}' --data-urlencode 'limit=5'

Restart 'pnpm dev' if it is already running - the API reads METRICS_TOKEN and
OTEL_EXPORTER_OTLP_ENDPOINT at boot, and both were just written to .env.

Three things still will not work locally, and none of them is a bug:

  - Alerts route and group correctly and appear at localhost:9093, but the
    Slack hop needs a real webhook in ops/observability/alertmanager/slack-webhook-url
  - The blackbox job probes the public sadhak.online URLs, not localhost, so it
    reports on production from here
  - Loki collects container logs through the Docker socket. The API runs on the
    host under 'pnpm dev', so its logs go to your terminal rather than to Loki
EOF
