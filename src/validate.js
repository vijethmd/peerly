'use strict';

const ROOM_ID_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const LANG_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;

// Control characters (except tab/newline) and bidi overrides/isolates, which
// can be used to visually spoof names ("evil\u202etxt.exe").
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ufeff]/g;

const isRoomId = (value) => typeof value === 'string' && ROOM_ID_RE.test(value);
const isId = (value) => typeof value === 'string' && ID_RE.test(value);
const isLang = (value) => typeof value === 'string' && value.length <= 35 && LANG_RE.test(value);

// Truncate without leaving half of a surrogate pair at the end.
function truncate(text, max) {
  if (text.length <= max) return text;
  let out = text.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

function sanitizeName(raw, max = 30) {
  if (typeof raw !== 'string') return null;
  const name = truncate(raw.replace(UNSAFE_CHARS_RE, '').replace(/\s+/g, ' ').trim(), max).trim();
  return name || null;
}

function sanitizeText(raw, max) {
  if (typeof raw !== 'string') return null;
  const text = raw
    .replace(/\r\n?/g, '\n')
    .replace(UNSAFE_CHARS_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text ? truncate(text, max) : null;
}

// Single-line text (captions, transcript segments).
function sanitizeLine(raw, max) {
  if (typeof raw !== 'string') return null;
  const text = truncate(raw.replace(UNSAFE_CHARS_RE, '').replace(/\s+/g, ' ').trim(), max).trim();
  return text || null;
}

function countWords(text) {
  const matches = text.match(/\S+/g);
  return matches ? matches.length : 0;
}

module.exports = { isRoomId, isId, isLang, sanitizeName, sanitizeText, sanitizeLine, countWords, truncate };
