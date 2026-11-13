'use strict';

// Schema migrations. Safe to run from many pods at once:
//  - a session advisory lock serialises runners, so only one applies changes
//    and the rest wait, then see everything applied and exit;
//  - each migration and its schema_migrations row commit in one transaction,
//    so a crash part-way leaves nothing half-applied;
//  - lock_timeout stops a migration queueing behind live traffic indefinitely
//    and blocking every write to the table behind it.

const { Client } = require('pg');

// Arbitrary constant shared by every relay migrator.
const LOCK_ID = 727_001;

const migrations = [
  {
    version: 1,
    name: 'create events',
    sql: `
      CREATE TABLE events (
        id              uuid PRIMARY KEY,
        idempotency_key text NOT NULL,
        payload         jsonb NOT NULL,
        received_at     timestamptz NOT NULL DEFAULT now()
      )`,
  },
  {
    version: 2,
    name: 'add signature and backfill',
    // The backfill takes a few seconds against production-sized data.
    // pg_sleep stands in for that here so local runs behave the same way.
    sql: `
      SELECT pg_sleep(2);
      ALTER TABLE events ADD COLUMN signature text;
      UPDATE events SET signature = '' WHERE signature IS NULL`,
  },
  {
    version: 3,
    name: 'unique idempotency key',
    // Before this index existed, dedupe was in memory and lost on every
    // restart, so a long-lived database can hold duplicate keys. Fail with an
    // actionable message rather than a bare constraint error.
    precheck: `
      SELECT count(*)::int AS n FROM (
        SELECT 1 FROM events GROUP BY idempotency_key HAVING count(*) > 1
      ) d`,
    precheckMessage: (n) =>
      `${n} idempotency keys are duplicated in events; dedupe them before applying the unique index`,
    sql: `CREATE UNIQUE INDEX events_idempotency_key ON events (idempotency_key)`,
  },
  {
    version: 4,
    name: 'archive outbox',
    // Rows that exist before this migration were archived inline by the old
    // code path, so mark them done. ADD COLUMN with a non-volatile default
    // is metadata-only on PG 11+ (no table rewrite). Dropping the default
    // afterwards means new rows start as NULL ("not yet archived").
    sql: `
      ALTER TABLE events ADD COLUMN archived_at timestamptz DEFAULT now();
      ALTER TABLE events ALTER COLUMN archived_at DROP DEFAULT;
      CREATE INDEX events_unarchived ON events (received_at) WHERE archived_at IS NULL`,
  },
];

async function migrate(client, { log = () => {} } = {}) {
  await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    integer PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const { rows } = await client.query('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.version));

    for (const m of migrations) {
      if (applied.has(m.version)) continue;
      log(`applying ${m.version} (${m.name})`);
      await client.query('BEGIN');
      try {
        await client.query("SET LOCAL lock_timeout = '5s'");
        if (m.precheck) {
          const { rows: [{ n }] } = await client.query(m.precheck);
          if (n > 0) throw new Error(m.precheckMessage(n));
        }
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [m.version]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${m.version} (${m.name}) failed: ${err.message}`);
      }
    }
    log('up to date');
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
  }
}

module.exports = { migrate, migrations };

if (require.main === module) {
  const config = require('./config').load();
  const log = (msg) => console.log(JSON.stringify({ level: 'info', component: 'migrate', msg }));
  const client = new Client({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: config.pgConnectTimeoutMs,
    application_name: 'relay-migrate',
  });
  client
    .connect()
    .then(() => migrate(client, { log }))
    .then(() => client.end())
    .catch((err) => {
      console.error(JSON.stringify({ level: 'fatal', component: 'migrate', msg: err.message }));
      process.exit(1);
    });
}
