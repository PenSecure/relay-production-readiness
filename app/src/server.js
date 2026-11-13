'use strict';

const config = require('./config').load();
const { createPool } = require('./db');
const { createApp } = require('./app');
const { log } = require('./log');
const { createMetrics } = require('./metrics');
const { createArchiver, s3Put } = require('./archiver');

const pool = createPool(config);
const metrics = createMetrics({ pool });

let shuttingDown = false;
const app = createApp({
  pool,
  signingSecret: config.signingSecret,
  bodyLimit: config.bodyLimit,
  metrics,
  isShuttingDown: () => shuttingDown,
});

const server = app.listen(config.port, () => {
  log('info', 'relay listening', { port: config.port, pool_max: config.poolMax, archive: Boolean(config.archiveBucket) });
});

// The ALB idle timeout defaults to 60s. Node's keep-alive timeout must be
// longer, otherwise Node can close a socket just as the ALB reuses it, which
// shows up as sporadic 502s.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.requestTimeout = 30_000;

const archiver = config.archiveBucket
  ? createArchiver({
      pool,
      bucket: config.archiveBucket,
      intervalMs: config.archiveIntervalMs,
      batchSize: config.archiveBatchSize,
      metrics,
      put: s3Put(),
    })
  : null;
archiver?.start();

// ----------------------------------------------------------- graceful stop
//
// Kubernetes removes a terminating pod from endpoints at the same time as it
// sends SIGTERM, but kube-proxy and the ALB take a few seconds to notice. So:
//   1. fail readiness and keep serving for SHUTDOWN_DELAY_MS;
//   2. stop accepting connections and let in-flight requests finish;
//   3. stop the archiver, close the pool, exit.
// SHUTDOWN_DELAY_MS + SHUTDOWN_TIMEOUT_MS must be < terminationGracePeriodSeconds.

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', 'shutdown started', { signal, delay_ms: config.shutdownDelayMs });

  const hardStop = setTimeout(() => {
    log('error', 'shutdown timed out, exiting');
    process.exit(1);
  }, config.shutdownDelayMs + config.shutdownTimeoutMs);
  hardStop.unref();

  await new Promise((r) => setTimeout(r, config.shutdownDelayMs));
  await new Promise((r) => {
    server.close(r);
    server.closeIdleConnections();
  });
  await archiver?.stop();
  await pool.end();
  log('info', 'shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (err) => {
  log('error', 'unhandled rejection', { err: err?.message ?? String(err) });
});
