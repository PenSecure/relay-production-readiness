SHIP WITH CONDITIONS

# relay: production readiness

**Short version:** as received, relay could not start, would have lost
replays and OOM'd under launch traffic, and its pipeline would have
overwritten the production secret with dev values. Those are fixed and
proven on kind at the real launch peak. I would ship Friday **only if** the
conditions in section 3 are met. Most belong to other teams and are a
day's work each, not a rewrite.

Final load test, 400 req/s for 5 minutes with 5% client replays, 3 pods:

```
total: sent=119980 status[201:113998 409:5982] errors[-] p50=7ms p95=12ms p99=31ms
```

All raw outputs are in [`docs/evidence/`](docs/evidence/README.md), with baseline and after side by side.

**Decisions I made where the brief was ambiguous**
- **Peak is 400 req/s** (README), not 150 (handoff). I sized and tested for 400.
- **The `409` replay contract stays.** The handoff says clients depend on it.
- **"Ready for production" here means:** it survives launch peak, a deploy,
  a pod loss and a DB blip without losing or duplicating events; nothing
  ships that leaks secrets or grants account-wide access; and on-call can
  tell when it's broken.

---

## 1. What I changed, in the order I'd defend it

| # | Change | Why (evidence) |
|---|---|---|
| 1 | **Kept `app/.env` out of git and the image.** Allow-list `.dockerignore` | The old image had the staging DB password and signing secret recoverable from a layer, even after `rm -f .env`. Values redacted in evidence |
| 2 | **Idempotency moved to the database** (`INSERT … ON CONFLICT DO NOTHING`), and the in-memory `Map` deleted | At 2 replicas, **47% of replays returned 500** (`duplicate key`). The Map also kept every 8KB payload forever: **both pods were OOMKilled** in about 6 minutes at 150 req/s. Raising the heap to 512MB above a 256Mi limit only hid that. The memory problem was a leak, not the heap size |
| 3 | **The CI pipeline no longer applies `k8s/` wholesale to production.** Kustomize base + local/prod overlays, plus a CI guard | The old `kubectl apply -f k8s/` would have replaced the prod secret with `relay-local-pw` and started a Postgres on `emptyDir` in production |
| 4 | **Fixed what stopped `make up`**: missing lockfile, `:latest` pull policy, secret key name, port 3000 vs 8080, HPA without CPU requests or metrics-server | Each reproduced on its own (evidence §1, §3–6) |
| 5 | **DB connection budget**: `(8 max pods + 1 surge) × pool 8 + 1 migrator = 73` of 100 | It was `10 × 25 = 250`, so the data team's DB would run out of connections at 4 pods. At about 3ms per query, a pool of 8 per pod is plenty |
| 6 | **Probes split**: liveness never touches the DB; readiness does. DB errors return **503 + Retry-After** | Killed Postgres under load: 0 relay restarts, automatic recovery. The old liveness check (DB, 1s timeout, ×2) would have restarted every pod during any DB blip of more than 10s |
| 7 | **Graceful shutdown**: node runs as PID 1, SIGTERM → fail readiness → drain → close; `maxUnavailable: 0`; PDB; `keepAliveTimeout` > the ALB idle timeout | Rolling restart of every pod at 400 req/s: **47,991 requests, zero errors**. The old setup (`sh` → `npm` → `node`) never received SIGTERM |
| 8 | **Terraform: fixed two outage bugs.** The node security group allowed 8080 while the ALB targets NodePort 30080. Nodes were in a single AZ | The first would have failed every health check on day one. Neither is caught by scanners |
| 9 | **Terraform: least privilege.** The node role had `s3:*` + `secretsmanager:*` on `*`, with IMDSv1 open to pods. Now an IRSA role allowing `s3:PutObject` on `events/*`; IMDSv2 with hop limit 1; no SSH or bastion; private EKS API; KMS everywhere; HTTPS + WAF; no prod password in code or state | Any pod compromise used to mean reading every secret in the account. Trivy HIGH/CRITICAL went 22 → 3 (accepted, with reasons in `.trivyignore`) |
| 10 | **S3 archive moved to a transactional outbox** (`FOR UPDATE SKIP LOCKED`) | An S3 failure returned 500 for an event that was already stored. The client retried, got 409, and the event was never archived. S3 latency was also on every request |
| 11 | **Concurrency-safe migrations**: advisory lock, one transaction each, `lock_timeout`, a duplicate-key precheck. Run as an initContainer | Concurrent pods raced on `ALTER TABLE`. If staging holds duplicate keys (likely, after the OOM restarts wiped the Map), migration 3 fails. It now fails with a clear message |
| 12 | **CI/CD**: tests against real Postgres, Trivy (IaC, image, secrets), kubeconform, SHA-pinned actions, OIDC instead of access keys, release = `v*` tag → approval → deploy by digest → automatic rollback | The old pipeline used `@master` actions and pushed and deployed `:latest` on every push |
| 13 | **Image**: distroless Debian 13, non-root, read-only rootfs, Pod Security `restricted` | 717 → 0 HIGH/CRITICAL CVEs; 1.66GB → 257MB |
| 14 | **Observability**: Prometheus metrics, 3 SLOs with burn-rate alerts, runbook (`ops/`) | The handoff listed "no dashboards or alerts" |

Plus 12 integration tests (`make test`), including the cross-pod replay and a 30-way same-key race.

## 2. Found and deliberately left

- **`POST /events` has no authentication.** Anyone who can reach the ALB can
  get any payload signed, so the signature proves nothing. The fix depends
  on who the clients are (see Questions). I added WAF + rate limiting, but
  that isn't authentication. **This is condition 1.**
- **Signatures can't be re-verified from stored data.** The HMAC is over
  `JSON.stringify(body)`, but `jsonb` reorders keys, so `GET /events/:id`
  returns a payload that no longer matches its signature. Fixing it
  (storing the raw body, or signing a canonical form) changes the contract
  for consumers, so I need to know who verifies signatures first.
- **A replay with a different body under the same key gets 409, not 422.**
  Kept, because it's the documented contract.
- **Terraform is fixed in code but has never been applied.** It still has
  placeholders (account ID, certificate, GitHub repo). Not addressed:
  instance targets on a NodePort (I'd move to the AWS Load Balancer
  Controller with IP targets); node egress `0.0.0.0/0`; no RDS Proxy.
- **Migrations run in an initContainer.** That's safe thanks to the lock, but
  a pre-deploy Job in CD is cleaner at scale. Schema changes must stay
  expand-then-contract either way (written in the runbook).
- **No CPU limit, on purpose.** It would only add throttling. Requests drive the HPA.
- **No tracing and no Grafana dashboards.** The alerts are real (validated
  with promtool); dashboards come after launch.
- `k8s/postgres.yaml` is untouched (out of scope). Pod Security is therefore
  only *enforced* in the prod overlay, because the stand-in runs as root.

## 3. Friday: ship with conditions

**Already fixed in this repo:** relay itself, i.e. correctness under load,
deploy safety, least privilege and the pipeline.

**Before Friday I need:**

1. **Product/security:** confirm who calls `/events`. If it's the public
   internet, put authentication in front (API keys per client at minimum)
   before launch. If it's internal or partner-only, restrict the ALB/WAF
   to their CIDRs instead. Without one of these, I would not ship.
2. **Platform:** apply the Terraform to a non-prod account by Thursday and
   rerun `make loadtest` against the real ALB + RDS. It has never been
   applied, and kind cannot prove ALB/NodePort/IRSA behaviour. Also needed:
   External Secrets Operator, the Prometheus Operator, an ACM certificate,
   a CI runner that can reach the private EKS API, and the GitHub OIDC
   provider.
3. **Data team:** confirm that relay may hold up to ~73 connections, set
   `sslmode=verify-full`, and **check staging for duplicate idempotency
   keys** before migration 3 runs there.
4. **Security:** rotate the staging DB password and signing secret. They
   sat in a plaintext `.env` and in a staging image layer.

If condition 2 slips, I'd still launch rather than miss the date, but behind
a smaller blast radius: one partner, or a traffic cap on the WAF.

## 4. Questions I would have asked

1. Who are the clients, and how do they authenticate? Who verifies the signatures, and how?
2. Is 400 req/s the sustained peak or a burst? What does growth look like? (Past ~8 pods we need RDS Proxy or a pooler.)
3. How long must events and the S3 archive be kept? Is there PII in payloads? (That drives lifecycle, encryption scope and logging.)
4. Should idempotency keys be scoped per client? Today two clients choosing the same key collide.
5. Is there an RPO/RTO for the database, and who owns restore drills?
6. Are the staging and prod databases the same Postgres major version?
