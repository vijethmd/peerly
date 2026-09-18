'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function serializeError(err) {
  return {
    name: err.name,
    message: err.message,
    ...(err.code !== undefined && { code: err.code }),
    ...(err.status !== undefined && { status: err.status }),
    stack: err.stack
  };
}

function normalize(fields) {
  if (!fields) return {};
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = value instanceof Error ? serializeError(value) : value;
  }
  return out;
}

function stringify(entry) {
  try {
    return JSON.stringify(entry);
  } catch {
    return JSON.stringify({ ts: entry.ts, level: entry.level, msg: entry.msg, note: 'unserializable fields' });
  }
}

/**
 * Minimal structured logger: JSON lines in production (machine-parseable by
 * log drains), compact human-readable lines in development.
 */
function createLogger({ level = 'info', format = 'json', bindings = {}, write } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const out = write || ((line) => process.stdout.write(`${line}\n`));

  function log(lvl, msg, fields) {
    if (LEVELS[lvl] < threshold) return;
    const entry = { ts: new Date().toISOString(), level: lvl, msg, ...bindings, ...normalize(fields) };
    if (format === 'pretty') {
      const { ts, level: l, msg: m, ...rest } = entry;
      const extra = Object.keys(rest).length ? ` ${stringify(rest)}` : '';
      out(`${ts.slice(11, 23)} ${l.toUpperCase().padEnd(5)} ${m}${extra}`);
    } else {
      out(stringify(entry));
    }
  }

  return {
    level,
    debug: (msg, fields) => log('debug', msg, fields),
    info: (msg, fields) => log('info', msg, fields),
    warn: (msg, fields) => log('warn', msg, fields),
    error: (msg, fields) => log('error', msg, fields),
    child: (extra) => createLogger({ level, format, bindings: { ...bindings, ...extra }, write: out })
  };
}

module.exports = { createLogger };
