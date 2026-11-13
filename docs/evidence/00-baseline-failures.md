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
