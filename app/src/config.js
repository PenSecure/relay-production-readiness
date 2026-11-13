'use strict';

// All configuration comes from the environment. Invalid values fail fast at
// startup rather than surfacing as odd behaviour under load.

function fail(message) {
  console.error(JSON.stringify({ level: 'fatal', msg: message }));
  process.exit(1);
}

function required(name) {
  const value = process.env[name];
  if (!value) fail(`missing required environment variable ${name}`);
  return value;
}

function int(name, fallback, { min = 0 } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    fail(`environment variable ${name} must be an integer >= ${min}, got "${raw}"`);
  }
  return n;
}

function load() {
  return {
    // The platform network policy only allows 8080, so that is the default too.
    port: int('PORT', 8080, { min: 1 }),
    databaseUrl: required('DATABASE_URL'),
    signingSecret: required('SIGNING_SECRET'),

    // Connection budget: the managed database allows 100 connections in total.
    // (HPA maxReplicas x PG_POOL_MAX) must stay below that with headroom for
    // migrations, the data team and break-glass access. See k8s/base/hpa.yaml.
    poolMax: int('PG_POOL_MAX', 10, { min: 1 }),
    pgConnectTimeoutMs: int('PG_CONNECT_TIMEOUT_MS', 2000, { min: 1 }),
    pgStatementTimeoutMs: int('PG_STATEMENT_TIMEOUT_MS', 5000, { min: 1 }),

    // Payloads are documented as up to 8KB. 32KB leaves headroom without
    // letting a client make us buffer arbitrarily large bodies.
    bodyLimit: process.env.BODY_LIMIT || '32kb',

    // On SIGTERM: report not-ready, keep serving for this long so the
    // endpoint is removed from Service/ALB rotation, then drain and exit.
    shutdownDelayMs: int('SHUTDOWN_DELAY_MS', 10000),
    shutdownTimeoutMs: int('SHUTDOWN_TIMEOUT_MS', 20000, { min: 1 }),

    // Archiving is asynchronous (transactional outbox). Unset = disabled.
    archiveBucket: process.env.ARCHIVE_BUCKET || '',
    archiveIntervalMs: int('ARCHIVE_INTERVAL_MS', 1000, { min: 10 }),
    archiveBatchSize: int('ARCHIVE_BATCH_SIZE', 50, { min: 1 }),
  };
}

module.exports = { load };
