'use strict';

const http = require('http');
const { Server } = require('socket.io');
const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { Metrics } = require('./metrics');
const { AiService } = require('./ai');
const { ReportStore } = require('./reports');
const { RoomRegistry } = require('./rooms');
const { createTokenService } = require('./tokens');
const { createSignaling, isOriginAllowed } = require('./signaling');
const { createApp } = require('./app');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Builds a fully wired Peerly server without listening. Tests inject config,
 * a silent logger, or a fake AI service through `options`.
 */
function createPeerly(options = {}) {
  const config = options.config || loadConfig();
  const logger = options.logger || createLogger({ level: config.logLevel, format: config.logFormat });
  const metrics = new Metrics();
  const lifecycle = { shuttingDown: false, closing: null };

  const ai = options.ai || new AiService({ config: config.ai, logger, metrics });
  const reports = new ReportStore({ config: config.reports, ai, logger, metrics });
  const registry = new RoomRegistry(config.rooms);
  const tokens = createTokenService(config.sessionSecret);

  let signaling = null;
  const { app, pruneLimiters } = createApp({
    config,
    logger,
    registry,
    reports,
    ai,
    metrics,
    lifecycle,
    onBeaconLeave: (body) => signaling.beaconLeave(body)
  });

  // The app must be attached before Socket.IO so Socket.IO can route its own
  // requests and hand everything else to Express.
  const httpServer = http.createServer(app);
  httpServer.requestTimeout = 30000;
  httpServer.headersTimeout = 20000;

  const io = new Server(httpServer, {
    maxHttpBufferSize: 64 * 1024,
    pingInterval: 10000,
    pingTimeout: 8000,
    connectTimeout: 20000,
    allowRequest: (req, callback) => callback(null, isOriginAllowed(req, config.allowedOrigins))
  });
  signaling = createSignaling({ io, config, logger, registry, reports, ai, metrics, tokens, lifecycle });

  metrics
    .counter('peerly_joins_total', 'Participants joining or resuming a meeting')
    .counter('peerly_leaves_total', 'Participants leaving a meeting, by reason')
    .counter('peerly_rate_limited_total', 'Socket events dropped by rate limiting')
    .counter('peerly_ai_requests_total', 'AI requests by kind and outcome')
    .gauge('peerly_rooms', 'Active meeting rooms', () => registry.size)
    .gauge('peerly_participants', 'Participants in meetings, including reconnecting ones', () => registry.participantCount())
    .gauge('peerly_sockets', 'Connected realtime clients', () => io.engine.clientsCount)
    .gauge('peerly_reports', 'Meeting reports held in memory', () => reports.size)
    .gauge('process_resident_memory_bytes', 'Resident set size', () => process.memoryUsage().rss)
    .gauge('nodejs_heap_used_bytes', 'V8 heap in use', () => process.memoryUsage().heapUsed)
    .gauge('process_uptime_seconds', 'Process uptime', () => Math.round(process.uptime()));

  const housekeeping = setInterval(() => pruneLimiters(), 5 * 60 * 1000);
  housekeeping.unref();

  function listen(port = config.port, host = config.host) {
    return new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(port, host, () => {
        httpServer.off('error', reject);
        resolve(httpServer.address());
      });
    });
  }

  /**
   * Graceful shutdown: tell clients to reconnect (their calls keep running
   * peer-to-peer and resume on the next instance), then close sockets and
   * the HTTP server, bounded by a timeout.
   */
  function close({ timeoutMs = config.shutdownTimeoutMs, notify = true } = {}) {
    if (lifecycle.closing) return lifecycle.closing;
    lifecycle.shuttingDown = true;
    lifecycle.closing = (async () => {
      clearInterval(housekeeping);
      if (notify) {
        io.emit('server-shutdown', { reconnectInMs: 1500 });
        await delay(300);
      }
      signaling.stop();
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        timer.unref();
        io.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      httpServer.closeAllConnections();
    })();
    return lifecycle.closing;
  }

  return { config, logger, metrics, ai, reports, registry, tokens, io, httpServer, app, lifecycle, listen, close };
}

async function start() {
  let peerly;
  try {
    peerly = createPeerly();
  } catch (err) {
    console.error(err.name === 'ConfigError' ? `Configuration error: ${err.message}` : err);
    process.exit(1);
  }
  const { config, logger } = peerly;

  let exiting = false;
  const shutdown = async (reason, code = 0) => {
    if (exiting) return;
    exiting = true;
    logger.info('shutting down', { reason });
    const force = setTimeout(() => {
      logger.error('forced exit: shutdown took too long');
      process.exit(1);
    }, config.shutdownTimeoutMs + 3000);
    force.unref();
    let exitCode = code;
    try {
      await peerly.close();
    } catch (err) {
      logger.error('error during shutdown', { err });
      exitCode = 1;
    }
    process.exit(exitCode);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled promise rejection', { err: reason instanceof Error ? reason : new Error(String(reason)) });
  });
  process.on('uncaughtException', (err) => {
    logger.error('uncaught exception', { err });
    shutdown('uncaughtException', 1);
  });

  try {
    const address = await peerly.listen();
    logger.info('Peerly is running', {
      url: `http://localhost:${address.port}`,
      env: config.nodeEnv,
      ai: config.ai.enabled ? config.ai.model : 'disabled'
    });
  } catch (err) {
    logger.error('failed to start', { err });
    process.exit(1);
  }

  if (config.sessionSecretIsEphemeral) {
    logger.warn('SESSION_SECRET is not set: calls can’t resume across server restarts. Set it to a random string of 32+ characters.');
  }
  if (!config.ai.enabled) logger.info('AI meeting notes are off. Set ANTHROPIC_API_KEY to turn them on.');
}

module.exports = { createPeerly, start };
