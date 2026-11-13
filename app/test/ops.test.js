'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client, Pool } = require('pg');
const { DATABASE_URL, resetDatabase, startInstance } = require('./helpers');
const { migrate } = require('../src/migrate');
const { createArchiver } = require('../src/archiver');
const { createMetrics } = require('../src/metrics');

beforeEach(resetDatabase);

test('liveness does not depend on the database; readiness does, without leaking errors', async () => {
  const broken = { query: async () => { throw new Error('connect ECONNREFUSED 10.0.0.5:5432'); } };
  const inst = await startInstance({ pool: broken });
  try {
    assert.equal((await fetch(`${inst.base}/livez`)).status, 200);
    const ready = await fetch(`${inst.base}/readyz`);
    assert.equal(ready.status, 503);
    const text = await ready.text();
    assert.ok(!text.includes('10.0.0.5'), 'readiness must not expose driver errors');
  } finally {
    await inst.close();
  }
});

test('readiness fails while shutting down so traffic drains first', async () => {
  let draining = false;
  const inst = await startInstance({ isShuttingDown: () => draining });
  try {
    assert.equal((await fetch(`${inst.base}/readyz`)).status, 200);
    draining = true;
    assert.equal((await fetch(`${inst.base}/readyz`)).status, 503);
    assert.equal((await fetch(`${inst.base}/livez`)).status, 200);
  } finally {
    await inst.close();
  }
});

test('migrations are safe to run from many pods at once', async () => {
  const c = new Client({ connectionString: DATABASE_URL });
  await c.connect();
  await c.query('DROP TABLE IF EXISTS events, schema_migrations');
  await c.end();

  const clients = await Promise.all(
    Array.from({ length: 5 }, async () => {
      const cl = new Client({ connectionString: DATABASE_URL });
      await cl.connect();
      return cl;
    }),
  );
  await Promise.all(clients.map((cl) => migrate(cl)));
  const { rows } = await clients[0].query('SELECT version FROM schema_migrations ORDER BY version');
  assert.deepEqual(rows.map((r) => r.version), [1, 2, 3, 4]);
  await Promise.all(clients.map((cl) => cl.end()));
});

test('archiver uploads each event once across replicas and retries failures', async () => {
  const inst = await startInstance();
  const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
  try {
    for (let i = 0; i < 20; i++) {
      assert.equal((await inst.post({ i }, { 'Idempotency-Key': crypto.randomUUID() })).status, 201);
    }

    const uploads = [];
    let failNext = true;
    const put = async (bucket, key) => {
      if (failNext) { failNext = false; throw new Error('SlowDown'); }
      uploads.push(key);
    };
    const mk = () => createArchiver({ pool, bucket: 'b', intervalMs: 10, batchSize: 50, metrics: createMetrics(), put });

    // First cycle hits an S3 error and commits nothing.
    assert.equal(await mk().tick(), 0);
    // Two "replicas" race. SKIP LOCKED means each row goes to exactly one.
    const [x, y] = await Promise.all([mk().tick(), mk().tick()]);
    assert.equal(x + y, 20);
    assert.equal(new Set(uploads).size, 20);
    assert.equal(uploads.length, 20);

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM events WHERE archived_at IS NULL');
    assert.equal(rows[0].n, 0);
  } finally {
    await inst.close();
    await pool.end();
  }
});
