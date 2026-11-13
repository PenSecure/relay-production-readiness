'use strict';

const { Pool } = require('pg');

function createPool(config, { applicationName = 'relay' } = {}) {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.poolMax,
    connectionTimeoutMillis: config.pgConnectTimeoutMs,
    idleTimeoutMillis: 30000,
    // Server-side cap so one slow query cannot hold a connection forever.
    statement_timeout: config.pgStatementTimeoutMs,
    // Client-side cap in case the server or network stops responding.
    query_timeout: config.pgStatementTimeoutMs + 1000,
    application_name: applicationName,
  });

  // An idle client erroring (e.g. the DB restarted) must not crash the process.
  pool.on('error', (err) => {
    console.error(JSON.stringify({ level: 'error', msg: 'idle database client error', err: err.message }));
  });

  return pool;
}

module.exports = { createPool };
