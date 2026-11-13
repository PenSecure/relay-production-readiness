'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { SECRET, resetDatabase, startInstance } = require('./helpers');

let a;
let b;

before(async () => {
  a = await startInstance();
  b = await startInstance();
});
after(async () => {
  await a.close();
  await b.close();
});
beforeEach(resetDatabase);

const key = () => crypto.randomUUID();

test('creates an event and signs the payload', async () => {
  const payload = { type: 'order.updated', n: 1 };
  const res = await a.post(payload, { 'Idempotency-Key': key() });
  assert.equal(res.status, 201);
  const body = await res.json();
  const expected = crypto.createHmac('sha256', SECRET).update(JSON.stringify(payload)).digest('hex');
  assert.equal(body.signature, expected);

  const got = await fetch(`${a.base}/events/${body.id}`);
  assert.equal(got.status, 200);
  assert.deepEqual((await got.json()).payload, payload);
});

test('replay on the same instance returns 409 with the original id', async () => {
  const k = key();
  const first = await (await a.post({ x: 1 }, { 'Idempotency-Key': k })).json();
  const replay = await a.post({ x: 1 }, { 'Idempotency-Key': k });
  assert.equal(replay.status, 409);
  assert.deepEqual(await replay.json(), { id: first.id, duplicate: true });
});

// Regression: the in-memory Map returned 500 here (47% of replays in the
// baseline load test with 2 replicas).
test('replay on a different instance (another pod) returns 409, not 500', async () => {
  const k = key();
  const first = await (await a.post({ x: 1 }, { 'Idempotency-Key': k })).json();
  const replay = await b.post({ x: 1 }, { 'Idempotency-Key': k });
  assert.equal(replay.status, 409);
  assert.equal((await replay.json()).id, first.id);
});

test('concurrent requests with one key: exactly one 201, the rest 409, no 500', async () => {
  const k = key();
  const responses = await Promise.all(
    Array.from({ length: 30 }, (_, i) => (i % 2 ? a : b).post({ x: 1 }, { 'Idempotency-Key': k })),
  );
  const statuses = responses.map((r) => r.status).sort();
  assert.equal(statuses.filter((s) => s === 201).length, 1);
  assert.equal(statuses.filter((s) => s === 409).length, 29);
});

test('rejects missing or invalid Idempotency-Key', async () => {
  assert.equal((await a.post({ x: 1 })).status, 400);
  assert.equal((await a.post({ x: 1 }, { 'Idempotency-Key': 'x'.repeat(256) })).status, 400);
  assert.equal((await a.post({ x: 1 }, { 'Idempotency-Key': 'has space' })).status, 400);
});

test('rejects non-JSON, malformed and oversized bodies without leaking internals', async () => {
  const text = await fetch(`${a.base}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'Idempotency-Key': key() },
    body: 'hello',
  });
  assert.equal(text.status, 415);

  const malformed = await a.post('{"oops', { 'Idempotency-Key': key() });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: 'malformed JSON' });

  const big = await a.post({ data: 'x'.repeat(40 * 1024) }, { 'Idempotency-Key': key() });
  assert.equal(big.status, 413);

  // 8KB payloads (the documented maximum) must still be accepted.
  const ok = await a.post({ data: 'x'.repeat(8 * 1024) }, { 'Idempotency-Key': key() });
  assert.equal(ok.status, 201);
});

test('GET /events/:id returns 404 for unknown and non-UUID ids (not 500)', async () => {
  assert.equal((await fetch(`${a.base}/events/${crypto.randomUUID()}`)).status, 404);
  assert.equal((await fetch(`${a.base}/events/not-a-uuid`)).status, 404);
});
