'use strict';

const crypto = require('node:crypto');
const express = require('express');

// Printable ASCII, no spaces, bounded. Keys are stored, indexed and logged,
// so arbitrary bytes or very long values are refused at the edge.
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const { log } = require('./log');

// Database unreachable / restarting / overloaded. These are transient, so
// answer 503 + Retry-After: the client retries with the same
// Idempotency-Key, which is safe by design.
function isTransientDbError(err) {
  return (
    ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN'].includes(err.code) ||
    /^08|^57P0[1-3]$|^53300$/.test(err.code || '') || // connection exception, admin shutdown, too_many_connections
    /timeout exceeded when trying to connect|Connection terminated|Query read timeout/i.test(err.message || '')
  );
}

/**
 * Build the HTTP app. Dependencies are injected so tests can run it against a
 * real database without starting a server or touching process signals.
 *
 * @param {object} deps
 * @param {import('pg').Pool} deps.pool
 * @param {string} deps.signingSecret
 * @param {string} deps.bodyLimit
 * @param {ReturnType<import('./metrics').createMetrics>} deps.metrics
 * @param {() => boolean} [deps.isShuttingDown]
 */
function createApp({ pool, signingSecret, bodyLimit = '32kb', metrics, isShuttingDown = () => false }) {
  const app = express();
  app.disable('x-powered-by');

  // Access log + latency metric. Use the route pattern, not the raw path, so
  // /events/:id does not create one metric series per event.
  app.use((req, res, next) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      const route = req.route ? req.baseUrl + req.route.path : 'unmatched';
      metrics.httpDuration.observe({ method: req.method, route, status: res.statusCode }, seconds);
      if (route === '/livez' || route === '/readyz' || route === '/metrics') return;
      log('info', 'request', {
        method: req.method,
        route,
        status: res.statusCode,
        ms: Math.round(seconds * 1000),
        key: req.get('Idempotency-Key') || null,
        request_id: req.get('X-Amzn-Trace-Id') || req.get('X-Request-Id') || null,
      });
    });
    // While draining, ask keep-alive clients (and the ALB) to reconnect elsewhere.
    if (isShuttingDown()) res.set('Connection', 'close');
    next();
  });

  // ---------------------------------------------------------------- health

  // Liveness: is this process able to serve at all? It deliberately does NOT
  // touch the database. If it did, a database blip would make Kubernetes
  // restart every pod at once, which turns a dependency outage into our outage.
  app.get('/livez', (req, res) => res.json({ status: 'ok' }));

  // Readiness: should this pod receive traffic right now?
  async function ready(req, res) {
    if (isShuttingDown()) return res.status(503).json({ status: 'shutting down' });
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok' });
    } catch (err) {
      // Details go to our logs, not to whoever is probing from the internet.
      log('warn', 'readiness check failed', { err: err.message });
      res.status(503).json({ status: 'unavailable' });
    }
  }
  app.get('/readyz', ready);
  app.get('/health', ready); // kept for existing ALB / staging configuration

  app.get('/metrics', async (req, res) => {
    res.set('Content-Type', metrics.registry.contentType);
    res.send(await metrics.registry.metrics());
  });

  // ---------------------------------------------------------------- events

  app.post(
    '/events',
    (req, res, next) => {
      if (!req.is('application/json')) {
        metrics.events.inc({ result: 'rejected' });
        return res.status(415).json({ error: 'Content-Type must be application/json' });
      }
      next();
    },
    express.json({ limit: bodyLimit }),
    async (req, res, next) => {
      const key = req.get('Idempotency-Key');
      if (!key || !IDEMPOTENCY_KEY.test(key)) {
        metrics.events.inc({ result: 'rejected' });
        return res.status(400).json({ error: 'Idempotency-Key header is required (1-255 printable ASCII characters)' });
      }

      const payload = req.body;
      const id = crypto.randomUUID();
      const signature = crypto.createHmac('sha256', signingSecret).update(JSON.stringify(payload)).digest('hex');

      try {
        // The unique index is the source of truth for idempotency. It holds
        // across replicas and restarts and has no race between "check" and
        // "insert", unlike the per-process Map it replaces.
        const inserted = await pool.query(
          `INSERT INTO events (id, idempotency_key, payload, signature)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (idempotency_key) DO NOTHING
           RETURNING id`,
          [id, key, payload, signature],
        );
        if (inserted.rowCount === 1) {
          metrics.events.inc({ result: 'created' });
          return res.status(201).json({ id, signature });
        }

        const existing = await pool.query('SELECT id FROM events WHERE idempotency_key = $1', [key]);
        metrics.events.inc({ result: 'duplicate' });
        return res.status(409).json({ id: existing.rows[0]?.id ?? null, duplicate: true });
      } catch (err) {
        metrics.events.inc({ result: 'error' });
        next(err);
      }
    },
  );

  app.get('/events/:id', async (req, res, next) => {
    if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'not found' });
    try {
      const { rows } = await pool.query(
        'SELECT id, idempotency_key, payload, signature, received_at FROM events WHERE id = $1',
        [req.params.id],
      );
      if (rows.length === 0) return res.status(404).json({ error: 'not found' });
      res.json(rows[0]);
    } catch (err) {
      next(err);
    }
  });

  app.use((req, res) => res.status(404).json({ error: 'not found' }));

  // JSON errors only; never leak stack traces or driver messages to clients.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'payload too large' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'malformed JSON' });
    if (isTransientDbError(err)) {
      log('warn', 'database unavailable', { route: req.route?.path, err: err.message, code: err.code });
      return res.status(503).set('Retry-After', '1').json({ error: 'temporarily unavailable, retry' });
    }
    log('error', 'unhandled request error', { route: req.route?.path, err: err.message, code: err.code });
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}

module.exports = { createApp };
