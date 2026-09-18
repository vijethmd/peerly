'use strict';

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const { isRoomId, isId, sanitizeText } = require('./validate');
const { KeyedRateLimiter, rateLimitMiddleware } = require('./rateLimit');
const { buildIceServers } = require('./ice');
const { randomId, safeEqual } = require('./tokens');
const { clientFeatures, MEDIAPIPE_DIR, MEDIAPIPE_BASE, SEGMENTER_MODEL_PATH } = require('./features');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// Self-hosted Geist / Geist Mono (OFL) so the strict CSP needs no font CDN.
const FONT_DIRS = {
  geist: path.join(path.dirname(require.resolve('@fontsource-variable/geist/package.json')), 'files'),
  'geist-mono': path.join(path.dirname(require.resolve('@fontsource-variable/geist-mono/package.json')), 'files')
};
const FONT_FILE_RE = /^geist(-mono)?-(latin|latin-ext|cyrillic|cyrillic-ext|vietnamese)-wght-normal\.woff2$/;
const MAX_MODEL_BYTES = 20 * 1024 * 1024;
const VENDOR_FILES = new Set(['vision_bundle.mjs', 'vision_bundle.mjs.map']);
const HOST_RE = /^[A-Za-z0-9.-]+(?::\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](?::\d{1,5})?$/;

const PERMISSIONS_POLICY = [
  'camera=(self)',
  'microphone=(self)',
  'display-capture=(self)',
  'fullscreen=(self)',
  'picture-in-picture=(self)',
  'autoplay=(self)',
  'screen-wake-lock=(self)',
  'geolocation=()',
  'payment=()',
  'usb=()'
].join(', ');

const ROOM_LETTERS = 'abcdefghijkmnpqrstuvwxyz';
function generateRoomId() {
  const part = (len) => Array.from({ length: len }, () => ROOM_LETTERS[crypto.randomInt(ROOM_LETTERS.length)]).join('');
  return `${part(3)}-${part(4)}-${part(3)}`;
}

// Report links are bearer secrets; keep them out of logs.
const redactPath = (p) => p.replace(/^\/(api\/)?report\/[^/]+/, (match, api) => `/${api || ''}report/:id`);

function createApp({ config, logger, registry, reports, ai, metrics, lifecycle, onBeaconLeave }) {
  const log = logger.child({ component: 'http' });
  const app = express();
  const limiters = [];

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use((req, res, next) => {
    const started = process.hrtime.bigint();
    const incoming = req.get('x-request-id');
    req.id = incoming && /^[\w-]{1,64}$/.test(incoming) ? incoming : randomId(9);
    res.set('X-Request-Id', req.id);
    res.on('finish', () => {
      metrics.inc('peerly_http_requests_total', { method: req.method, status: `${Math.floor(res.statusCode / 100)}xx` });
      const fields = {
        method: req.method,
        path: redactPath(req.path),
        status: res.statusCode,
        ms: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
        requestId: req.id
      };
      if (res.statusCode >= 500) log.error('request failed', fields);
      else if (res.statusCode === 429) log.warn('request rate limited', { ...fields, ip: req.ip });
      else if (req.path.startsWith('/api/')) log.debug('request', fields);
    });
    next();
  });

  app.get('/healthz', (req, res) => {
    res.set('Cache-Control', 'no-store').json({ ok: true, uptime: Math.round(process.uptime()) });
  });

  app.get('/readyz', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (lifecycle.shuttingDown) return res.status(503).json({ ok: false, status: 'shutting-down' });
    return res.json({ ok: true });
  });

  app.get('/metrics', (req, res) => {
    if (!config.metricsToken) return res.status(404).end();
    if (!safeEqual(req.get('authorization') || '', `Bearer ${config.metricsToken}`)) return res.status(401).end();
    return res.type('text/plain; version=0.0.4').send(metrics.render());
  });

  const socketOrigins = (req) => {
    const host = req.headers.host;
    if (!host || !HOST_RE.test(host)) return "'self'";
    return config.isProduction ? `wss://${host}` : `ws://${host} wss://${host}`;
  };

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          // WebAssembly compilation for on-device background segmentation.
          scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          mediaSrc: ["'self'", 'blob:'],
          fontSrc: ["'self'"],
          connectSrc: ["'self'", socketOrigins],
          workerSrc: ["'self'", 'blob:'],
          manifestSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          ...(config.isProduction ? { upgradeInsecureRequests: [] } : {})
        }
      },
      crossOriginEmbedderPolicy: false,
      strictTransportSecurity: config.isProduction ? { maxAge: 31536000, includeSubDomains: true } : false,
      referrerPolicy: { policy: 'no-referrer' }
    })
  );
  app.use((req, res, next) => {
    res.set('Permissions-Policy', PERMISSIONS_POLICY);
    next();
  });
  app.use(compression());

  // ------------------------------------------------------------------ API
  const perIp = (capacity, perMinute) => {
    const limiter = new KeyedRateLimiter({ capacity, refillPerSecond: perMinute / 60 });
    limiters.push(limiter);
    return rateLimitMiddleware(limiter);
  };

  const api = express.Router();
  api.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
    next();
  });

  api.get('/config', perIp(60, 60), (req, res) => {
    res.json(clientFeatures(config, ai));
  });

  api.get('/new-room', perIp(20, 20), (req, res) => {
    let roomId;
    do {
      roomId = generateRoomId();
    } while (registry.get(roomId));
    res.json({ roomId });
  });

  api.get('/room/:id', perIp(40, 30), (req, res) => {
    if (!isRoomId(req.params.id)) return res.status(400).json({ valid: false });
    const room = registry.get(req.params.id);
    const count = room ? room.participants.size : 0;
    return res.json({
      valid: true,
      count,
      max: config.rooms.maxSize,
      full: count >= config.rooms.maxSize,
      locked: Boolean(room && room.locked)
    });
  });

  api.get('/ice-config', perIp(30, 30), (req, res) => {
    res.json({
      iceServers: buildIceServers(config.ice),
      iceTransportPolicy: config.ice.forceRelay ? 'relay' : 'all'
    });
  });

  api.get('/report/:id', perIp(60, 60), (req, res) => {
    const report = isId(req.params.id) ? reports.get(req.params.id) : null;
    if (!report) return res.status(404).json({ error: 'These meeting notes don’t exist or have expired.' });
    return res.json(reports.toPublic(report));
  });

  api.post('/report/:id/retry', perIp(5, 5), (req, res) => {
    const result = isId(req.params.id)
      ? reports.retry(req.params.id)
      : { ok: false, status: 404, error: 'These meeting notes don’t exist or have expired.' };
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    return res.status(202).json({ ok: true });
  });

  // navigator.sendBeacon() sends text/plain, so accept any content type.
  api.post('/leave', perIp(30, 30), express.json({ limit: '2kb', type: () => true }), (req, res) => {
    onBeaconLeave(req.body && typeof req.body === 'object' ? req.body : {});
    res.status(204).end();
  });

  api.post('/client-errors', perIp(20, 10), express.json({ limit: '16kb' }), (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    log.warn('client error', {
      message: sanitizeText(body.message, 500),
      source: sanitizeText(body.source, 300),
      stack: sanitizeText(body.stack, 4000),
      context: sanitizeText(body.context, 200),
      userAgent: sanitizeText(req.get('user-agent'), 300),
      requestId: req.id
    });
    res.status(204).end();
  });

  api.use((req, res) => res.status(404).json({ error: 'Not found' }));
  app.use('/api', api);

  app.get('/fonts/:family/:file', (req, res, next) => {
    const dir = FONT_DIRS[req.params.family];
    if (!dir || !FONT_FILE_RE.test(req.params.file)) return next();
    res.set('Cache-Control', 'public, max-age=2592000');
    res.type('font/woff2');
    return res.sendFile(path.join(dir, req.params.file));
  });

  // --------------------------------------------------- background effects
  app.get(`${MEDIAPIPE_BASE}/:file`, (req, res, next) => {
    if (!VENDOR_FILES.has(req.params.file)) return next();
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    if (req.params.file.endsWith('.mjs')) res.type('text/javascript');
    return res.sendFile(path.join(MEDIAPIPE_DIR, req.params.file));
  });
  app.use(
    `${MEDIAPIPE_BASE}/wasm`,
    express.static(path.join(MEDIAPIPE_DIR, 'wasm'), { immutable: true, maxAge: '365d', index: false })
  );

  // The segmentation model is fetched once from Google's model storage and
  // served from here, so browsers only ever talk to this origin.
  let modelBuffer = null;
  let modelDownload = null;
  function loadModel() {
    if (modelBuffer) return Promise.resolve(modelBuffer);
    if (!modelDownload) {
      modelDownload = (async () => {
        const response = await fetch(config.segmenterModelUrl, { signal: AbortSignal.timeout(20000) });
        if (!response.ok) throw new Error(`model download failed with HTTP ${response.status}`);
        if (Number(response.headers.get('content-length') || 0) > MAX_MODEL_BYTES) throw new Error('model is too large');
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > MAX_MODEL_BYTES) throw new Error('model is too large');
        modelBuffer = buffer;
        log.info('segmentation model cached', { bytes: buffer.length });
        return buffer;
      })().finally(() => {
        modelDownload = null;
      });
    }
    return modelDownload;
  }

  app.get(SEGMENTER_MODEL_PATH, async (req, res) => {
    try {
      const buffer = await loadModel();
      res.set({ 'Cache-Control': 'public, max-age=604800', 'Content-Type': 'application/octet-stream' });
      res.send(buffer);
    } catch (err) {
      log.warn('segmentation model unavailable', { err });
      res.status(502).json({ error: 'Background effects are temporarily unavailable.' });
    }
  });

  // ---------------------------------------------------------------- pages
  const sendPage = (res, file) => {
    res.set({ 'Cache-Control': 'no-cache', 'X-Robots-Tag': 'noindex, nofollow' });
    res.sendFile(path.join(PUBLIC_DIR, file));
  };

  app.get('/room/:id', (req, res) => {
    if (!isRoomId(req.params.id)) return res.redirect(302, '/?error=invalid-room');
    return sendPage(res, 'room.html');
  });

  app.get('/report/:id', (req, res, next) => {
    if (!isId(req.params.id)) return next();
    return sendPage(res, 'report.html');
  });

  app.use(
    express.static(PUBLIC_DIR, {
      index: 'index.html',
      setHeaders(res, filePath) {
        const cacheable = filePath.includes(`${path.sep}backgrounds${path.sep}`);
        res.set('Cache-Control', cacheable ? 'public, max-age=86400' : 'no-cache');
      }
    })
  );

  const notFound = (req, res) => {
    res.status(404);
    if (req.accepts('html')) {
      res.set('Cache-Control', 'no-cache');
      return res.sendFile(path.join(PUBLIC_DIR, '404.html'));
    }
    return res.json({ error: 'Not found' });
  };
  app.use(notFound);

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status === 404) return notFound(req, res);
    if (status >= 500) log.error('unhandled request error', { err, path: redactPath(req.path), requestId: req.id });
    if (res.headersSent) return res.end();
    return res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.expose ? err.message : 'Bad request' });
  });

  function pruneLimiters(now = Date.now()) {
    for (const limiter of limiters) limiter.prune(now);
  }

  return { app, pruneLimiters };
}

module.exports = { createApp, generateRoomId, redactPath };
