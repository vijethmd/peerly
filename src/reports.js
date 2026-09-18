'use strict';

const { randomId } = require('./tokens');

const MOMENT_WINDOW_MS = 20000;
const PUBLIC_TIMELINE_TYPES = new Set([
  'join',
  'leave',
  'share-start',
  'share-stop',
  'transcription-on',
  'transcription-off',
  'host',
  'ended'
]);

function presentMs(record, now) {
  return record.sessions.reduce((sum, [start, end]) => sum + Math.max(0, (end ?? now) - start), 0);
}

// Short windows where several reactions landed together ("the room lit up").
function reactionMoments(log) {
  const buckets = new Map();
  for (const { ts, emoji } of log) {
    const key = Math.floor(ts / MOMENT_WINDOW_MS);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { ts: key * MOMENT_WINDOW_MS, count: 0, emojis: {} };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    bucket.emojis[emoji] = (bucket.emojis[emoji] || 0) + 1;
  }
  return [...buckets.values()]
    .filter((b) => b.count >= 3)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map((b) => ({ ts: b.ts, count: b.count, emoji: Object.entries(b.emojis).sort((x, y) => y[1] - x[1])[0][0] }))
    .sort((a, b) => a.ts - b.ts);
}

function publicAi(ai) {
  const out = { status: ai.status };
  if (ai.status === 'ready') Object.assign(out, { data: ai.data, model: ai.model, generatedAt: ai.generatedAt });
  if (ai.status === 'failed' || ai.status === 'skipped') Object.assign(out, { error: ai.error, retryable: Boolean(ai.retryable) });
  return out;
}

/**
 * Meeting reports live in memory for REPORT_TTL_HOURS. A report is created
 * (status "recording") when transcription starts so everyone gets a stable
 * link up front, and is finalized when the meeting ends.
 */
class ReportStore {
  constructor({ config, ai, logger, metrics }) {
    this.ttlMs = config.ttlMs;
    this.max = config.max;
    this.ai = ai;
    this.log = logger.child({ component: 'reports' });
    this.metrics = metrics;
    this.reports = new Map();
    this.inflight = new Set();
  }

  get size() {
    return this.reports.size;
  }

  create(roomId, now = Date.now()) {
    this.makeRoom(now);
    const id = randomId(18);
    this.reports.set(id, {
      id,
      roomId,
      status: 'recording',
      createdAt: now,
      updatedAt: now,
      expiresAt: null,
      meeting: { roomId, startedAt: now },
      participants: [],
      transcript: [],
      chat: [],
      reactions: { totals: {}, moments: [] },
      timeline: [],
      ai: { status: this.ai.enabled ? 'waiting' : 'disabled' }
    });
    return id;
  }

  makeRoom(now) {
    this.sweep(now);
    if (this.reports.size < this.max) return;
    for (const [id, report] of this.reports) {
      if (report.status !== 'recording') {
        this.reports.delete(id);
        return;
      }
    }
    this.reports.delete(this.reports.keys().next().value);
  }

  finalize(room, { endedBy = 'everyone-left', now = Date.now() } = {}) {
    const report = this.reports.get(room.reportId);
    if (!report || report.status !== 'recording') return null;

    report.status = 'ready';
    report.updatedAt = now;
    report.expiresAt = now + this.ttlMs;
    report.meeting = {
      roomId: room.id,
      startedAt: room.createdAt,
      endedAt: now,
      durationMs: now - room.createdAt,
      endedBy,
      language: room.transcriptLang,
      transcriptTruncated: room.transcriptTruncated
    };
    report.participants = [...room.attendance.values()]
      .map((r) => ({
        name: r.name,
        firstJoinedAt: r.firstJoinedAt,
        presentMs: presentMs(r, now),
        talkMs: r.talkMs,
        words: r.words,
        messages: r.messages,
        reactions: r.reactions,
        handRaises: r.handRaises,
        wasHost: r.wasHost
      }))
      .sort((a, b) => a.firstJoinedAt - b.firstJoinedAt);
    report.transcript = room.transcript.map(({ id, pid, name, text, ts }) => ({ id, pid, name, text, ts }));
    report.chat = room.chat.filter((m) => !m.to).map(({ id, name, text, ts }) => ({ id, name, text, ts }));
    report.reactions = { totals: { ...room.reactionTotals }, moments: reactionMoments(room.reactionLog) };
    report.timeline = room.timeline
      .filter((e) => PUBLIC_TIMELINE_TYPES.has(e.type))
      .map(({ ts, type, name, reason }) => ({ ts, type, name: name ?? null, reason: reason ?? null }));

    if (!this.ai.enabled) {
      report.ai = { status: 'disabled' };
    } else if (!report.transcript.length) {
      report.ai = { status: 'skipped', error: 'Nothing was transcribed, so there is nothing to summarize.' };
    } else {
      report.ai = { status: 'waiting' };
      this.generate(report.id);
    }
    this.metrics.inc('peerly_reports_finalized_total');
    this.log.info('report finalized', {
      roomId: room.id,
      segments: report.transcript.length,
      participants: report.participants.length,
      ai: report.ai.status
    });
    return report;
  }

  aiInput(report) {
    return {
      meeting: report.meeting,
      participants: report.participants.map((p) => ({ name: p.name, isHost: p.wasHost, words: p.words })),
      transcript: report.transcript,
      chat: report.chat
    };
  }

  async generate(id) {
    const report = this.reports.get(id);
    if (!report || this.inflight.has(id)) return;
    this.inflight.add(id);
    report.ai = { status: 'running', startedAt: Date.now() };
    report.updatedAt = Date.now();

    let result;
    try {
      result = await this.ai.generateReport(this.aiInput(report));
    } catch (err) {
      this.log.error('report generation crashed', { err });
      result = { ok: false, code: 'internal', retryable: true, error: 'Something went wrong while generating notes.' };
    } finally {
      this.inflight.delete(id);
    }

    if (this.reports.get(id) !== report) return; // expired or evicted meanwhile
    const now = Date.now();
    report.ai = result.ok
      ? { status: 'ready', data: result.data, model: result.model, generatedAt: now }
      : { status: 'failed', code: result.code, error: result.error, retryable: Boolean(result.retryable), failedAt: now };
    report.updatedAt = now;
  }

  retry(id, now = Date.now()) {
    const report = this.get(id, now);
    if (!report) return { ok: false, status: 404, error: 'This report doesn’t exist or has expired.' };
    if (report.ai.status !== 'failed' || !report.ai.retryable) {
      return { ok: false, status: 409, error: 'These notes can’t be regenerated right now.' };
    }
    this.generate(id);
    return { ok: true };
  }

  get(id, now = Date.now()) {
    const report = this.reports.get(id);
    if (!report) return null;
    if (report.expiresAt && report.expiresAt <= now) {
      this.reports.delete(id);
      return null;
    }
    return report;
  }

  sweep(now = Date.now()) {
    for (const [id, report] of this.reports) {
      if (report.expiresAt && report.expiresAt <= now) this.reports.delete(id);
    }
  }

  toPublic(report) {
    const base = {
      id: report.id,
      status: report.status,
      createdAt: report.createdAt,
      updatedAt: report.updatedAt,
      expiresAt: report.expiresAt
    };
    if (report.status === 'recording') {
      return {
        ...base,
        meeting: { roomId: report.roomId, startedAt: report.meeting.startedAt },
        ai: { status: report.ai.status }
      };
    }
    return {
      ...base,
      meeting: report.meeting,
      participants: report.participants,
      transcript: report.transcript.map(({ id, name, text, ts }) => ({ id, name, text, ts })),
      chat: report.chat,
      reactions: report.reactions,
      timeline: report.timeline,
      ai: publicAi(report.ai)
    };
  }
}

module.exports = { ReportStore, reactionMoments, presentMs };
