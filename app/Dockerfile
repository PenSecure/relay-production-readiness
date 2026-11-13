# syntax=docker/dockerfile:1.7

# ---- dependencies: full toolchain, production deps only
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ---- runtime: distroless. No shell, no package manager, runs as UID 65532.
# Pin by digest in CI (Dependabot/Renovate keeps it fresh).
FROM gcr.io/distroless/nodejs22-debian12:nonroot
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
