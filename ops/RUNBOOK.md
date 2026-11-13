# relay runbook

**What it does:** clients `POST /events` with an `Idempotency-Key`. We sign
the payload, store it in Postgres (source of truth, including for
idempotency), and archive it to S3 asynchronously. A `409` on a replay is
correct behaviour, not an error.

**Dependencies:** managed Postgres (data team, `max_connections=100`), S3
archive bucket (via IRSA), ALB + WAF.

## SLOs

| SLO | Target | Signal |
|---|---|---|
| Availability | 99.9% of `POST /events` non-5xx, 30 days | `relay_http_request_duration_seconds_count` |
| Latency | 99% of `POST /events` < 250ms | same histogram, `le="0.25"` |
| Archive freshness | events in S3 within 5 min | `relay_archive_oldest_pending_seconds` |

## Endpoints

| Path | Purpose |
|---|---|
| `/livez` | process is alive. **Never** checks the DB (that would restart every pod during a DB blip) |
| `/readyz` (`/health`) | DB reachable and not draining. ALB + readiness probe |
| `/metrics` | Prometheus. Blocked at the ALB |

## 5xx errors

1. `kubectl -n relay logs -l app=relay -c relay --since=10m | grep '"level":"(warn|error)"'`
2. Mostly **503** with `database unavailable`: the DB is down or unreachable.
   Pods stay alive and recover on their own. Escalate to the data team.
   Clients retry safely (same key -> 409 once stored).
3. **500** with `unhandled request error`: an app bug. Roll back:
   `kubectl -n relay rollout undo deploy/relay`.
4. No pods ready: `kubectl -n relay describe pods -l app=relay`. Check the
   `migrate` initContainer logs first: `kubectl -n relay logs <pod> -c migrate`.

## Latency

Check the DB first (`relay_db_pool_connections{state="waiting"}`), then CPU
(`kubectl top pods -n relay`, HPA status). p99 was 31ms at 400 req/s on
3 pods in load testing (docs/evidence).

## Archive lag

Rows with `archived_at IS NULL` are retried every second by every pod
(`FOR UPDATE SKIP LOCKED`). Look for `archive upload failed` in logs:
- `AccessDenied`: IRSA role / bucket policy / KMS key policy.
- `SlowDown`: S3 throttling. It backs off on its own; check the backlog drains.
Nothing is lost while lagging. The DB is the source of truth.

## DB pool / connection budget

Worst case `(maxReplicas 8 + maxSurge 1) x PG_POOL_MAX 8 + 1 migrator = 73`
of the database's 100. **Do not raise `maxReplicas` or `PG_POOL_MAX` on
their own.** If more capacity is needed: put RDS Proxy / PgBouncer in front
of the database, or lower the pool per pod (at ~3ms per query, one
connection serves ~300 req/s).

## Restarts

`kubectl -n relay get pods -l app=relay -o jsonpath='{..lastState.terminated.reason}'`
- `OOMKilled`: memory was flat at ~34MB under 400 req/s, so this means a
  regression. Capture a heap snapshot in staging and roll back.

## Deploy / rollback

Release = push a `v*` tag. CI tests, scans, pushes by digest, waits for
approval on the `production` environment, deploys, and rolls back
automatically if the rollout does not become healthy.
Manual rollback: `kubectl -n relay rollout undo deploy/relay`.

Schema changes must be **backward compatible** (expand, then contract).
Old and new pods run side by side during a rollout, and migrations run
before the new pods start.
