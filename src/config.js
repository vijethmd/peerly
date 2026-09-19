'use strict';

const crypto = require('crypto');

const DEFAULT_SEGMENTER_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter_landscape/float16/latest/selfie_segmenter_landscape.tflite';

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

function readers(env) {
  const raw = (name) => {
    const value = env[name];
    if (value === undefined || value === null) return undefined;
    const trimmed = String(value).trim();
    return trimmed === '' ? undefined : trimmed;
  };

  return {
    str(name, fallback) {
      return raw(name) ?? fallback;
    },
    int(name, fallback, min, max) {
      const value = raw(name);
      if (value === undefined) return fallback;
      if (!/^-?\d+$/.test(value)) throw new ConfigError(`${name} must be an integer (got "${value}")`);
      const n = Number(value);
      if (n < min || n > max) throw new ConfigError(`${name} must be between ${min} and ${max} (got ${n})`);
      return n;
    },
    bool(name, fallback) {
      const value = raw(name);
      if (value === undefined) return fallback;
      if (/^(1|true|yes|on)$/i.test(value)) return true;
      if (/^(0|false|no|off)$/i.test(value)) return false;
      throw new ConfigError(`${name} must be true or false (got "${value}")`);
    },
    oneOf(name, fallback, allowed) {
      const value = raw(name);
      if (value === undefined) return fallback;
      if (!allowed.includes(value)) {
        throw new ConfigError(`${name} must be one of ${allowed.join(', ')} (got "${value}")`);
      }
      return value;
    },
    list(name) {
      return (raw(name) || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
  };
}

const AI_PROVIDERS = ['auto', 'local', 'groq', 'openai', 'anthropic'];
const DEFAULT_MODELS = { local: 'peerly-auto', groq: 'openai/gpt-oss-120b', anthropic: 'claude-opus-5' };
const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

/**
 * Meeting notes work out of the box with Peerly's own notes ("local": free,
 * no key, nothing leaves the server). A GROQ_API_KEY (free tier) switches to
 * AI-written notes; ANTHROPIC_API_KEY to Claude; AI_BASE_URL to any other
 * OpenAI-compatible API. AI_PROVIDER picks one explicitly.
 */
function aiConfig(r) {
  const groqKey = r.str('GROQ_API_KEY');
  const genericKey = r.str('AI_API_KEY');
  const hasAnthropicCredentials = Boolean(r.str('ANTHROPIC_API_KEY') || r.str('ANTHROPIC_AUTH_TOKEN'));
  const enabled = r.bool('AI_ENABLED', true);
  const requested = r.oneOf('AI_PROVIDER', 'auto', AI_PROVIDERS);
  const auto = groqKey ? 'groq' : hasAnthropicCredentials ? 'anthropic' : 'local';
  const provider = !enabled ? 'off' : requested === 'auto' ? auto : requested;

  if (provider === 'groq' && !(groqKey || genericKey)) throw new ConfigError('AI_PROVIDER=groq needs GROQ_API_KEY');
  if (provider === 'anthropic' && !hasAnthropicCredentials) throw new ConfigError('AI_PROVIDER=anthropic needs ANTHROPIC_API_KEY');
  if (provider === 'openai' && !r.str('AI_BASE_URL')) throw new ConfigError('AI_PROVIDER=openai needs AI_BASE_URL');
  const model = provider === 'local' ? DEFAULT_MODELS.local : r.str('AI_MODEL', DEFAULT_MODELS[provider]);
  if (provider === 'openai' && !model) throw new ConfigError('AI_PROVIDER=openai needs AI_MODEL');

  return {
    enabled: provider !== 'off',
    provider,
    model: model || null,
    baseUrl: provider === 'groq' ? r.str('AI_BASE_URL', GROQ_BASE_URL) : r.str('AI_BASE_URL') || null,
    apiKey: provider === 'groq' ? groqKey || genericKey : provider === 'openai' ? genericKey || null : null,
    effort: r.oneOf('AI_EFFORT', 'medium', ['low', 'medium', 'high', 'xhigh', 'max']),
    reasoningEffort: r.oneOf('AI_REASONING_EFFORT', 'low', ['low', 'medium', 'high']),
    structuredOutput: r.oneOf('AI_STRUCTURED_OUTPUT', 'auto', ['auto', 'strict', 'json']),
    // Groq's free tier allows 8K tokens per minute for gpt-oss-120b.
    maxRequestTokens: r.int('AI_MAX_REQUEST_TOKENS', provider === 'groq' ? 7500 : 200000, 2000, 2000000),
    maxRequestsPerHour: r.int('AI_MAX_REQUESTS_PER_HOUR', 60, 1, 1000000),
    timeoutMs: r.int('AI_TIMEOUT_MS', 240000, 10000, 1800000),
    localFallback: r.bool('AI_LOCAL_FALLBACK', true)
  };
}

/**
 * TRUST_PROXY is either a hop count (use the Nth address from the right of
 * X-Forwarded-For) or "true" (use the leftmost address). Render rewrites
 * X-Forwarded-For so the first entry is always the real client, so "true" is
 * the default there.
 */
function parseTrustProxy(value, onRender) {
  if (value === undefined) return onRender ? true : 1;
  if (/^(true|all)$/i.test(value)) return true;
  if (/^(false|none)$/i.test(value)) return 0;
  if (!/^\d+$/.test(value) || Number(value) > 10) {
    throw new ConfigError(`TRUST_PROXY must be a hop count (0-10) or "true" (got "${value}")`);
  }
  return Number(value);
}

function deepFreeze(obj) {
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) deepFreeze(value);
  }
  return Object.freeze(obj);
}

/**
 * Reads and validates configuration from environment variables. Throws a
 * ConfigError with a readable message on invalid values so a misconfigured
 * deploy fails fast instead of misbehaving at runtime.
 */
function loadConfig(env = process.env) {
  const r = readers(env);
  const onRender = r.str('RENDER') === 'true';
  // Render doesn't set NODE_ENV for you; treat it as production there.
  const nodeEnv = r.str('NODE_ENV', onRender ? 'production' : 'development');
  const isProduction = nodeEnv === 'production';

  const sessionSecret = r.str('SESSION_SECRET');
  if (sessionSecret && sessionSecret.length < 32) {
    throw new ConfigError('SESSION_SECRET must be at least 32 characters long');
  }

  const stunUrls = r.list('STUN_URLS');
  const turnUrls = r.list('TURN_URL');
  const turnSecret = r.str('TURN_SECRET');
  const turnUsername = r.str('TURN_USERNAME');
  const turnCredential = r.str('TURN_CREDENTIAL');
  if (turnUrls.length && !turnSecret && !(turnUsername && turnCredential)) {
    throw new ConfigError('TURN_URL is set but neither TURN_SECRET nor TURN_USERNAME/TURN_CREDENTIAL are');
  }
  const forceRelay = r.bool('FORCE_RELAY', false);
  if (forceRelay && !turnUrls.length) {
    throw new ConfigError('FORCE_RELAY requires a TURN server (TURN_URL)');
  }

  const ai = aiConfig(r);

  return deepFreeze({
    nodeEnv,
    isProduction,
    port: r.int('PORT', 4800, 0, 65535),
    host: r.str('HOST', '0.0.0.0'),
    logLevel: r.oneOf('LOG_LEVEL', 'info', ['debug', 'info', 'warn', 'error', 'silent']),
    logFormat: r.oneOf('LOG_FORMAT', isProduction ? 'json' : 'pretty', ['json', 'pretty']),
    trustProxy: parseTrustProxy(r.str('TRUST_PROXY'), onRender),
    allowedOrigins: r.list('ALLOWED_ORIGINS'),
    maxConnectionsPerIp: r.int('MAX_CONNECTIONS_PER_IP', 50, 1, 100000),
    shutdownTimeoutMs: r.int('SHUTDOWN_TIMEOUT_MS', 10000, 1000, 120000),
    metricsToken: r.str('METRICS_TOKEN'),
    sessionSecret: sessionSecret || crypto.randomBytes(32).toString('hex'),
    sessionSecretIsEphemeral: !sessionSecret,
    segmenterModelUrl: r.str('SEGMENTER_MODEL_URL', DEFAULT_SEGMENTER_MODEL_URL),
    rooms: {
      maxSize: r.int('MAX_ROOM_SIZE', 8, 2, 16),
      maxRooms: r.int('MAX_ROOMS', 1000, 1, 1000000),
      reconnectGraceMs: r.int('RECONNECT_GRACE_MS', 30000, 1000, 600000),
      unloadGraceMs: r.int('UNLOAD_GRACE_MS', 6000, 0, 60000),
      rebuildWindowMs: r.int('REBUILD_WINDOW_MS', 45000, 1000, 600000),
      knockTimeoutMs: r.int('KNOCK_TIMEOUT_MS', 300000, 10000, 3600000),
      maxWaiting: r.int('MAX_WAITING', 20, 1, 1000),
      chatHistory: r.int('CHAT_HISTORY', 500, 0, 10000),
      transcriptMaxChars: r.int('TRANSCRIPT_MAX_CHARS', 600000, 10000, 5000000)
    },
    ice: {
      stunUrls: stunUrls.length ? stunUrls : ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'],
      turnUrls,
      turnSecret,
      turnUsername,
      turnCredential,
      turnTtlSeconds: r.int('TURN_TTL_SECONDS', 43200, 300, 604800),
      forceRelay
    },
    ai,
    reports: {
      ttlMs: r.int('REPORT_TTL_HOURS', 24, 1, 720) * 60 * 60 * 1000,
      max: r.int('MAX_REPORTS', 500, 1, 100000)
    }
  });
}

module.exports = { loadConfig, ConfigError, DEFAULT_SEGMENTER_MODEL_URL };
