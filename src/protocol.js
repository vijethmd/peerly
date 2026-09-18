'use strict';

// Bump when the Socket.IO event contract changes incompatibly. Clients send
// their version when joining and are asked to reload when it doesn't match.
const PROTOCOL_VERSION = 2;

// Reactions are an allowlist so the server never relays arbitrary strings
// that every client would render as a large animated glyph.
const REACTIONS = Object.freeze(['💖', '👍', '🎉', '👏', '😂', '😮', '😢', '🤔', '👎', '🔥']);

// How a viewer displays a sender's video; senders scale their encoding to it.
const VIEWS = Object.freeze(['focused', 'normal', 'thumb', 'hidden']);
const VIDEO_SOURCES = Object.freeze(['camera', 'screen']);

module.exports = { PROTOCOL_VERSION, REACTIONS, VIEWS, VIDEO_SOURCES };
