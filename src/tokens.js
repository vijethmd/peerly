'use strict';

const crypto = require('crypto');

function randomId(bytes = 16) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function sign(secret, ...parts) {
  return crypto.createHmac('sha256', secret).update(parts.join('\u0000')).digest('base64url');
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * Stateless, HMAC-signed credentials. Because verification needs only the
 * secret, a participant can prove who they are to a freshly restarted server
 * (same SESSION_SECRET) and resume their seat without the call dropping.
 */
function createTokenService(secret) {
  return {
    resumeToken(roomId, pid) {
      return sign(secret, 'resume', roomId, pid);
    },
    verifyResumeToken(roomId, pid, token) {
      return safeEqual(token, sign(secret, 'resume', roomId, pid));
    },
    // Proves "pid became host of roomId at time `since`". After a restart the
    // most recent valid proof wins, so the real host gets their role back.
    hostProof(roomId, pid, since) {
      return `${since}.${sign(secret, 'host', roomId, pid, String(since))}`;
    },
    verifyHostProof(roomId, pid, proof) {
      if (typeof proof !== 'string' || proof.length > 128) return 0;
      const dot = proof.indexOf('.');
      if (dot <= 0) return 0;
      const since = Number(proof.slice(0, dot));
      if (!Number.isSafeInteger(since) || since <= 0) return 0;
      return safeEqual(proof.slice(dot + 1), sign(secret, 'host', roomId, pid, String(since))) ? since : 0;
    }
  };
}

module.exports = { randomId, sign, safeEqual, createTokenService };
