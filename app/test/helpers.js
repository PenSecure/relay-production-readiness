'use strict';

// Integration tests run against a real Postgres. Nothing is mocked except S3.
//   docker run -d --rm -p 55432:5432 -e POSTGRES_PASSWORD=test postgres:16-alpine
//   TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/postgres npm test

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';

const { Client, Pool } = require('pg');
const { migrate } = require('../src/migrate');
const { createApp } = require('../src/app');
const { createMetrics } = require('../src/metrics');

const DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres:test@localhost:55432/postgres';
const SECRET = 'test-signing-secret';

async function resetDatabase() {
  const c = new Client({ connectionString: DATABASE_URL });
  await c.connect();
  await c.query('DROP TABLE IF EXISTS events, schema_migrations');
  await migrate(c);
  await c.end();
}

// Start an app instance on a random port. Each instance has its own pool,
// so two instances behave like two pods sharing one database.
async function startInstance({ pool, isShuttingDown } = {}) {
  const ownPool = !pool;
  pool = pool || new Pool({ connectionString: DATABASE_URL, max: 5 });
  const app = createApp({ pool, signingSecret: SECRET, metrics: createMetrics({ pool }), isShuttingDown });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    pool,
    post: (body, headers = {}) =>
      fetch(`${base}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      if (ownPool) await pool.end();
    },
  };
}

module.exports = { DATABASE_URL, SECRET, resetDatabase, startInstance };
