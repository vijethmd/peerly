'use strict';

const crypto = require('crypto');
const { io: ioClient } = require('socket.io-client');
const { createPeerly } = require('../src/server');
const { loadConfig } = require('../src/config');
const { createLogger } = require('../src/logger');
const { PROTOCOL_VERSION } = require('../src/protocol');

const TEST_SECRET = 'test-secret-that-is-definitely-long-enough';
const silentLogger = createLogger({ level: 'silent' });

async function startServer(env = {}, options = {}) {
  const config = loadConfig({
    NODE_ENV: 'test',
    SESSION_SECRET: TEST_SECRET,
    MAX_CONNECTIONS_PER_IP: '1000',
    ...env
  });
  const peerly = createPeerly({ config, logger: silentLogger, ...options });
  const address = await peerly.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${address.port}`;
  return { peerly, url, close: () => peerly.close({ notify: false, timeoutMs: 2000 }) };
}

function connect(url, options = {}) {
  const socket = ioClient(url, { transports: ['websocket'], forceNew: true, reconnection: false, ...options });
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (err) => {
      socket.close();
      reject(err);
    });
  });
}

const emitAck = (socket, event, payload, timeout = 3000) => socket.timeout(timeout).emitWithAck(event, payload);

function waitFor(socket, event, { timeout = 3000, filter = () => true } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timed out waiting for "${event}"`));
    }, timeout);
    function handler(payload) {
      if (!filter(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    }
    socket.on(event, handler);
  });
}

// Resolves true if `event` does NOT arrive within `ms`.
function expectSilence(socket, event, ms = 300) {
  return new Promise((resolve) => {
    const handler = () => {
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(false);
    };
    const timer = setTimeout(() => {
      socket.off(event, handler);
      resolve(true);
    }, ms);
    socket.on(event, handler);
  });
}

const clientId = () => crypto.randomBytes(12).toString('base64url');

async function join(url, { roomId = 'abc-defg-hij', name = 'Alice', ...extra } = {}) {
  const socket = await connect(url);
  const ack = await emitAck(socket, 'join', {
    v: PROTOCOL_VERSION,
    roomId,
    name,
    micOn: true,
    camOn: true,
    clientId: clientId(),
    ...extra
  });
  return { socket, ack };
}

function fakeAi(overrides = {}) {
  return {
    enabled: true,
    model: 'fake-model',
    calls: [],
    async generateReport(input) {
      this.calls.push({ kind: 'report', input });
      return {
        ok: true,
        model: 'fake-model',
        data: {
          title: 'Launch planning',
          summary: 'The team planned the launch.',
          keyPoints: ['Launch is on Friday'],
          topics: [{ title: 'Timeline', summary: 'Agreed on dates.', start: '00:01' }],
          decisions: ['Ship on Friday'],
          actionItems: [{ task: 'Write release notes', owner: 'Bob', due: null }],
          openQuestions: []
        }
      };
    },
    async catchUp(input) {
      this.calls.push({ kind: 'recap', input });
      return { ok: true, model: 'fake-model', partial: false, data: { recap: 'They discussed the launch.', keyPoints: [], currentTopic: null } };
    },
    ...overrides
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { startServer, connect, emitAck, waitFor, expectSilence, join, clientId, fakeAi, sleep, TEST_SECRET, PROTOCOL_VERSION };
