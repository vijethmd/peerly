'use strict';

const fs = require('fs');
const path = require('path');
const { PROTOCOL_VERSION, REACTIONS } = require('./protocol');

const MEDIAPIPE_DIR = path.dirname(require.resolve('@mediapipe/tasks-vision'));
const MEDIAPIPE_VERSION = JSON.parse(fs.readFileSync(path.join(MEDIAPIPE_DIR, 'package.json'), 'utf8')).version;
// Versioned path so the (large, immutable) WASM files can be cached forever.
const MEDIAPIPE_BASE = `/vendor/mediapipe/${MEDIAPIPE_VERSION}`;
const SEGMENTER_MODEL_PATH = '/vendor/models/selfie_segmenter_landscape.tflite';

/** Capabilities the browser client adapts to. */
function clientFeatures(config, ai) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    ai: ai.enabled,
    // "ai" when an AI model writes the notes, "auto" for Peerly's own notes.
    notes: ai.enabled ? ai.kind || 'ai' : null,
    // "server": browsers upload speech clips for Whisper; "browser": they transcribe themselves.
    transcriber: config.transcription?.enabled ? 'server' : 'browser',
    maxRoomSize: config.rooms.maxSize,
    reconnectGraceMs: config.rooms.reconnectGraceMs,
    reactions: REACTIONS,
    effects: {
      bundleUrl: `${MEDIAPIPE_BASE}/vision_bundle.mjs`,
      wasmBase: `${MEDIAPIPE_BASE}/wasm`,
      modelUrl: SEGMENTER_MODEL_PATH
    }
  };
}

module.exports = { clientFeatures, MEDIAPIPE_DIR, MEDIAPIPE_BASE, SEGMENTER_MODEL_PATH };
