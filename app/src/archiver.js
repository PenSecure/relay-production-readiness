'use strict';

// Transactional outbox for the S3 archive.
//
// Previously each request wrote to Postgres, then uploaded to S3, then replied.
// An S3 failure returned 500 for an event that was already stored. The client
// retried, got 409, and the event was never archived. S3 latency also landed
// directly on every request.
//
// Now the request only writes the row (archived_at IS NULL). This loop picks
// up unarchived rows with FOR UPDATE SKIP LOCKED, so any number of replicas can
// run it without double work, uploads them, and marks them archived in the same
// transaction. A failed upload rolls back and the row is retried next tick.
// The S3 key is derived from the event id, so a retry overwrites the same
// object. Delivery is at-least-once and idempotent.

const { log } = require('./log');

function createArchiver({ pool, bucket, intervalMs, batchSize, metrics, put }) {
  let timer = null;
  let running = null;
  let stopped = false;

  async function tick() {
    const client = await pool.connect();
    let processed = 0;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT id, payload FROM events
          WHERE archived_at IS NULL
          ORDER BY received_at
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [batchSize],
      );
      const done = [];
      for (const row of rows) {
        try {
          await put(bucket, `events/${row.id}.json`, JSON.stringify(row.payload));
          done.push(row.id);
          metrics.archived.inc({ result: 'ok' });
        } catch (err) {
          metrics.archived.inc({ result: 'error' });
          log('warn', 'archive upload failed', { id: row.id, err: err.message });
          break; // S3 is probably unhappy; back off until next tick
        }
      }
      if (done.length > 0) {
        await client.query('UPDATE events SET archived_at = now() WHERE id = ANY($1::uuid[])', [done]);
      }
      await client.query('COMMIT');
      processed = done.length;

      const lag = await client.query(
        `SELECT COALESCE(EXTRACT(EPOCH FROM now() - min(received_at)), 0)::float AS s
           FROM events WHERE archived_at IS NULL`,
      );
      metrics.archiveLag.set(lag.rows[0].s);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      log('warn', 'archive cycle failed', { err: err.message });
    } finally {
      client.release();
    }
    return processed;
  }

  function schedule(delay) {
    if (stopped) return;
    timer = setTimeout(() => {
      running = tick()
        .catch((err) => {
          // e.g. pool.connect() failed because the database is down. Keep looping.
          log('warn', 'archive cycle failed', { err: err.message });
          return 0;
        })
        // A full batch means there is a backlog: go again immediately.
        .then((n) => schedule(n === batchSize ? 0 : intervalMs))
        .finally(() => { running = null; });
    }, delay);
    timer.unref();
  }

  return {
    tick,
    start() { schedule(intervalMs); },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      if (running) await running;
    },
  };
}

function s3Put() {
  // Credentials come from the default provider chain: IRSA / EKS Pod Identity
  // in production. Loaded lazily so local runs without S3 never need the SDK.
  const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
  const s3 = new S3Client({});
  return (bucket, key, body) =>
    s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: 'application/json',
      ServerSideEncryption: 'aws:kms',
    }));
}

module.exports = { createArchiver, s3Put };
