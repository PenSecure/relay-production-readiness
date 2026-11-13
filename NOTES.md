SHIP WITH CONDITIONS

# relay: notes

The code as handed over couldn't start. Once I got it running, it lost
replays and ran out of memory at launch traffic, and the pipeline would have
pushed the local dev secret into production. All of that is fixed and tested
on kind at the 400 req/s peak. I'd ship Friday, but only with the four things
in section 3 done first, and most of those sit with other teams.

The load test I'm standing behind (400 req/s for 5 minutes, 5% replays, 3 pods):

```
total: sent=119980 status[201:113998 409:5982] errors[-] p50=7ms p95=12ms p99=31ms
```

Raw output for everything below, before and after, is in `docs/evidence/`.

A few calls I made where the brief was unclear:

- The README says the peak is 400 req/s and the handoff says 150. I went with 400.
- I kept the 409-on-replay behaviour, since the handoff says clients rely on it.
- For me, "production ready" meant it survives the launch peak, a deploy, a
  lost pod and a database blip without losing or duplicating events. It also
  had to stop leaking secrets and granting account-wide access, and someone
  on call had to be able to see when it's broken.

## 1. What I changed

Roughly in order of how much I'd argue for it.

1. **Secrets out of the image and the repo.** `app/.env` holds the staging DB
   password and signing secret. The Dockerfile copied it in and then ran
   `rm -f .env`, but the file was still sitting in an earlier layer. I pulled
   both values back out of the image to confirm. Now there's an allow-list
   `.dockerignore`, `.env` is gitignored, and it never entered history.
   Both values need rotating regardless.

2. **Idempotency moved into Postgres.** The dedupe was an in-memory `Map`
   per pod. With two replicas, 47% of replays returned 500 instead of 409,
   because a retry hitting the other pod went straight into the unique index.
   The same Map kept every 8KB payload forever, which is what caused the
   "couple of OOM restarts" in staging. Both pods died within about 6
   minutes at 150 req/s. Bumping the heap to 512MB above a 256Mi limit didn't
   help; it just meant the kernel killed the process before GC ran. It's now
   `INSERT ... ON CONFLICT DO NOTHING`, and memory stays flat at about 34MB.

3. **CI can't wreck prod any more.** The old workflow ran
   `kubectl apply -f k8s/`. That would have replaced the prod secret with
   `relay-local-pw` and started a throwaway Postgres in production. I split
   k8s into a base plus local and prod overlays, and CI checks that the prod
   render contains neither.

4. **`make up` works.** There were five separate blockers: no lockfile in
   the build, `:latest` forcing a pull from Docker Hub, a misnamed secret
   key, the app on 8080 with everything else on 3000, and an HPA with no CPU
   requests and no metrics-server. I hit each one in turn.

5. **The database connection budget.** 10 pods × 25 connections is 250
   against a limit of 100, so we'd have run the data team's database out of
   connections at 4 pods. It's now 8 pods max, a pool of 8, and surge of 1,
   which is 73 at worst. A query takes about 3ms, so 8 per pod is plenty.

6. **Probes.** Liveness used to hit the database with a 1s timeout, so any
   DB hiccup longer than 10s would restart every pod at once. Liveness is now
   process-only, and readiness checks the DB. I killed Postgres under load
   twice. The relay pods never restarted, clients got a retryable 503, and it
   recovered on its own.

7. **Deploys that don't drop requests.** Signals used to go to `sh`, which
   never passed them to node. Now node is PID 1. On SIGTERM it goes unready,
   waits for the endpoints to update, drains and exits. With
   `maxUnavailable: 0`, a PDB, and keep-alive longer than the ALB timeout, a
   full rolling restart at 400 req/s ran with zero errors across 48k requests.

8. **Two Terraform bugs that would have taken us down on day one.** The node
   security group allowed 8080, but the ALB sends to NodePort 30080, so no
   health check would ever pass. The nodes were also all in one AZ. No
   scanner flagged either of these.

9. **Terraform permissions.** The node role had `s3:*` and `secretsmanager:*`
   on everything, and IMDSv1 was reachable from pods. That meant one bad pod
   could read every secret in the account. The app now gets its own IRSA role
   that can only `PutObject` under `events/`. I also turned on IMDSv2, and
   removed SSH and the bastion in favour of SSM. The EKS API is now private,
   KMS is on throughout, there's HTTPS and WAF, and the prod DB password is
   no longer a variable default sitting in git. Trivy went from 22
   high/critical findings to 3, and I've noted why each of those is
   acceptable in `.trivyignore`.

10. **S3 archiving out of the request path.** When S3 failed, the client got
    a 500 for an event that had already been saved. The retry then got a 409,
    and the event never made it to S3. It's now an outbox: rows are marked
    unarchived and a background loop picks them up.

11. **Migrations.** These are safe to run from several pods at once now, using
    an advisory lock with each migration in its own transaction. I also
    added a precheck for duplicate keys before the unique index, because
    after all those OOM restarts I'd expect staging to have some.

12. **CI/CD.** There are tests against a real Postgres, Trivy scans (IaC,
    image and secrets) and kubeconform. Actions are pinned to SHAs, and the
    pipeline uses OIDC instead of access keys. Deploys only run from a `v*`
    tag, need an approval, deploy by digest, and roll back automatically if
    the rollout doesn't go healthy.

13. **Image.** It's distroless, non-root, with a read-only root filesystem.
    It went from 1.66GB with 717 high/critical CVEs to 257MB with none.

14. **Alerts.** There are three SLOs with burn-rate alerts, and a short
    runbook in `ops/`. The handoff said there was nothing there.

There are 12 integration tests (`make test`), including the cross-pod
replay and 30 requests racing on one key.

## 2. What I found and left alone

- **No authentication on `POST /events`.** Anyone who can reach it gets their
  payload signed by us, which makes the signature meaningless. How to fix it
  depends on who the clients are, so I've made it condition 1 rather than
  guessing. WAF and rate limiting help, but they aren't authentication.
- **Signatures can't be checked against what we store.** We sign
  `JSON.stringify(body)`, but `jsonb` reorders keys, so what `GET` returns
  doesn't match the signature. Fixing that changes the contract, so I need
  to know who verifies signatures first.
- **A replay with a different body still gets 409.** That's the documented
  behaviour, so I left it, but it should probably be 422.
- **The Terraform has never been applied.** It still has placeholder
  values. I'd also move to the AWS Load Balancer Controller with IP targets,
  tighten node egress, and add RDS Proxy before we grow past 8 pods.
- **Migrations run as an initContainer.** That's fine with the lock, but a
  pre-deploy job is tidier long term. Either way, schema changes have to be
  backwards compatible, which I've written into the runbook.
- **No CPU limit, on purpose.** It would only add throttling.
- **No tracing or dashboards yet.** The alerts are real and validated with
  promtool.
- **`k8s/postgres.yaml` is untouched.** Because it runs as root, Pod Security
  is only enforced in the prod overlay.

## 3. Friday

What's fixed is relay itself, plus the pipeline and the permissions. What I'd
need before going live:

1. **Auth.** Someone needs to tell me who calls this. If it's the public
   internet, we need at least per-client API keys. If it's partners, lock
   the ALB down to their IP ranges. I wouldn't go live with neither.
2. **Platform team.** Get the Terraform applied to a non-prod account by
   Thursday so I can rerun the load test against a real ALB and RDS. kind
   can't tell me whether the ALB, NodePort and IRSA pieces actually work
   together. I'd also need External Secrets, the Prometheus operator, a
   certificate, a CI runner that can reach the private EKS API, and the
   GitHub OIDC provider.
3. **Data team.** Agree to the 73 connections, turn on
   `sslmode=verify-full`, and check staging for duplicate idempotency keys
   before migration 3 runs there.
4. **Security.** Rotate the staging DB password and signing secret.

If item 2 slips, I'd rather launch small than slip the date: one partner, or
a WAF cap on traffic.

## 4. Questions I'd have asked

1. Who are the clients, how do they authenticate, and who checks the signatures?
2. Is 400 req/s a sustained peak or a spike? Past about 8 pods we need a connection pooler.
3. How long do we keep events and the S3 copies, and is there PII in them?
4. Should idempotency keys be per client? Right now two clients can collide.
5. What are the RPO and RTO for the database, and who tests restores?
6. Are staging and prod on the same Postgres major version?
