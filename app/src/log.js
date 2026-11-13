'use strict';

// Structured JSON logs to stdout. The platform ships stdout; nothing is
// written to the container filesystem (which is read-only).
function log(level, msg, fields = {}) {
  if (process.env.LOG_LEVEL === 'silent') return;
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }) + '\n');
}

module.exports = { log };
