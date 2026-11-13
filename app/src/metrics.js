'use strict';

const client = require('prom-client');

// One registry per process (or per test), so tests do not leak state.
function createMetrics({ pool } = {}) {
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });

  const httpDuration = new client.Histogram({
    name: 'relay_http_request_duration_seconds',
    help: 'HTTP request latency by route and status',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });

  const events = new client.Counter({
    name: 'relay_events_total',
    help: 'POST /events outcomes',
    labelNames: ['result'], // created | duplicate | rejected | error
    registers: [registry],
  });

  const archived = new client.Counter({
    name: 'relay_archive_total',
    help: 'Archive attempts to S3',
    labelNames: ['result'], // ok | error
    registers: [registry],
  });

  const archiveLag = new client.Gauge({
    name: 'relay_archive_oldest_pending_seconds',
    help: 'Age of the oldest event not yet archived (0 when caught up)',
    registers: [registry],
  });

  if (pool) {
    new client.Gauge({
      name: 'relay_db_pool_connections',
      help: 'Database pool connections by state',
      labelNames: ['state'],
      registers: [registry],
      collect() {
        this.set({ state: 'total' }, pool.totalCount);
        this.set({ state: 'idle' }, pool.idleCount);
        this.set({ state: 'waiting' }, pool.waitingCount);
      },
    });
  }

  return { registry, httpDuration, events, archived, archiveLag };
}

module.exports = { createMetrics };
