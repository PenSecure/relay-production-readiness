# Baseline: what `make up` did with the code as received

Captured on kind v0.33 (Kubernetes v1.37), before any fixes. Each blocker was
patched live (`kubectl patch`) only to expose the next one.

## 1. Image build fails

```
Dockerfile:9
   8 |     COPY package.json .
   9 | >>> RUN npm ci --omit=dev
ERROR: failed to build: process "/bin/sh -c npm ci --omit=dev" did not complete successfully: exit code: 1
```
`npm ci` needs `package-lock.json`, which is never copied.

## 2. Staging secrets baked into the image

With the lockfile copied in (the only change), the image is 1.66GB, runs as
root, and `app/.env` is still readable from an earlier layer despite
`RUN rm -f .env`:

```
FOUND app/.env in layer blobs/sha256/bfc9ed05...
DATABASE_URL=postgres://relay:<REDACTED>@relay-stg.internal.example.com:5432/relay
SIGNING_SECRET=<REDACTED>
uid=0(root) gid=0(root) groups=0(root)
```

Values redacted here on purpose. Both were recovered in plaintext from the
layer tarball (`docker save` + `tar -xOf <layer> app/.env`).

## 3. Image pull fails

`:latest` defaults to `imagePullPolicy: Always`, so the image kind loaded is ignored:

```
Failed to pull image "relay:latest": ... pull access denied, repository does not exist
Error: ImagePullBackOff
```

## 4. Secret key mismatch

```
Error: couldn't find key database-url in Secret relay/relay-secrets
```

## 5. Port mismatch: app on 8080, probe on 3000

```
relay listening on :8080 (pool max 25)
Liveness probe failed: Get "http://10.244.2.3:3000/health": dial tcp 10.244.2.3:3000: connect: connection refused
Container relay failed liveness probe, will be restarted
```

## 6. HPA cannot scale

```
NAME    REFERENCE          TARGETS              MINPODS   MAXPODS
relay   Deployment/relay   cpu: <unknown>/70%   1         10
```
No CPU request on the container and no metrics-server in kind.

## 7. Original app under load (2 replicas, ports patched, 150 req/s)

Raw output: `baseline-load-150rps.txt`, `baseline-load-150rps-run2.txt`.

```
run 1 (240s) total: sent=35992 status[201:34193 409:958 500:841] errors[-] p50=5ms p95=11ms p99=18ms
run 2 (150s) total: sent=22499 status[201:21411 409:730 500:322] errors[ECONNRESET:36] p50=6ms p95=11ms p99=18ms
```

- **47% of replays returned 500, not 409.** Idempotency is an in-process
  `Map`, so a retry that lands on the other pod misses it and hits the unique
  index: `841 failed to store event: duplicate key value violates unique constraint "events_idempotency_key"`.
- **Both pods OOMKilled.** Memory was 216MB / 195MB of a 256Mi limit after run 1
  and did not fall at idle. During run 2:
  `relay-...-hrg7k restarts=1 last=OOMKilled exit=137` (both pods).
  The 36 `ECONNRESET`s are in-flight requests lost when the pods died. The
  `seen` map is unbounded and keeps every 8KB payload. `--max-old-space-size=512`
  sits above the 256Mi container limit, so V8 never collects before the kernel
  kills the process. That is the "OOM restarts" from the handoff: a leak, not a
  sizing problem.
- **Both replicas landed in zone `local-a`.** The spread constraint is only
  checked at scheduling time and counted the outgoing ReplicaSet's pods during
  the rollout.

---

# After the fixes

| Test | Result |
|---|---|
| `make up` on a fresh kind cluster | works, 3 pods across both zones, HPA reading CPU |
| 400 req/s x 300s, 5% replays (`load-400rps.txt`) | `total: sent=119980 status[201:113998 409:5982] errors[-] p50=7ms p95=12ms p99=31ms`; 0 restarts; ~34MB/pod flat; ~42% CPU of request on 3 pods (`load-400rps-cluster.txt`) |
| Rolling restart of all pods at 400 req/s (`rollout-under-load-*.txt`) | `total: sent=47991 status[201:45655 409:2336] errors[-]`: zero failed requests |
| Postgres killed under 100 req/s, ~1s outage (`db-outage-*.txt`) | 76 fast failures in one 5s window, 0 relay restarts, automatic recovery |
| Same, ~12s outage, after the 503 change (`db-outage-100rps-after-503.txt`) | `status[201:3255 409:164 503:1079]`: retryable 503 + Retry-After, bounded at ~2s; 0 relay restarts; recovered in one window. The original DB-backed liveness probe (2 x 5s) would have restarted every pod |
| NetworkPolicy (ephemeral debug container) | postgres:5432 open, 1.1.1.1:80 blocked: enforced by kindnet |
| Image scan, HIGH/CRITICAL | original 717 (1.66GB, root) -> 0 (257MB, uid 65532) |
| Terraform scan, HIGH/CRITICAL | 22 -> 3, all accepted with reasons in `.trivyignore` |
