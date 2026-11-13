# syntax=docker/dockerfile:1.7

# ---- dependencies: full toolchain, production deps only
FROM node:22-trixie-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ---- runtime: distroless. No shell, no package manager, runs as UID 65532.
# Debian 13 base: the Debian 12 variant carried unpatched libssl3 CVEs
# (1 CRITICAL, 6 HIGH at time of writing). Pinned by digest; Dependabot bumps it.
FROM gcr.io/distroless/nodejs22-debian13:nonroot@sha256:39c66687298417dbf3ff2fb8b6012c20554494e16414ef7afd07b9abbb45b501
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps --chown=65532:65532 /app/node_modules ./node_modules
COPY --chown=65532:65532 package.json ./
COPY --chown=65532:65532 src ./src

USER 65532:65532
EXPOSE 8080

# The base image's entrypoint is node, so node is PID 1 and receives SIGTERM
# directly (the old `sh entrypoint.sh` -> npm -> node chain swallowed it).
# Migrations are not run here. They run in an initContainer before the app
# starts, serialised across pods by a Postgres advisory lock: ["src/migrate.js"].
CMD ["src/server.js"]
