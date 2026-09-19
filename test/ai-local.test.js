'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { localReport, localRecap, segmentScores, tidy, findDue } = require('../src/ai-local');
const { AiService, normalizeReport } = require('../src/ai');
const { clientFeatures } = require('../src/features');
const { loadConfig } = require('../src/config');
const { createLogger } = require('../src/logger');
const { Metrics } = require('../src/metrics');

const START = Date.UTC(2026, 8, 17, 10, 0, 0);

// Recognized speech: lowercase, no punctuation, one line per pause.
const LINES = [
  ['Alice', "okay so let's get started", 0],
  ['Alice', 'the main thing today is the beta launch and the release notes', 20],
  ['Bob', 'I think we can ship the beta on Friday if the release notes are done', 45],
  ['Carol', 'what about the new editor do we need a feature flag for it', 80],
  ['Alice', "good question I'm not sure yet", 95],
  ['Bob', "I'll write the release notes by Thursday", 130],
  ['Alice', 'great so we decided to ship the beta on Friday', 150],
  ['Carol', 'I can book the demo room for next week', 200],
  ['Alice', 'Carol can you also send the invite to the design team', 230],
  ['Carol', 'sure', 236],
  ['Bob', 'we need to update the pricing page before the launch', 300],
  ['Alice', "let's go with the new pricing then", 330],
  ['Bob', 'sounds good', 334],
  ['Carol', 'the release notes should mention the new editor and the pricing change', 380],
  ['Bob', 'the beta feedback form is ready too', 420],
  ['Alice', 'thanks everyone', 600]
];

function meeting(overrides = {}) {
  return {
    meeting: { roomId: 'abc-defg-hij', startedAt: START, endedAt: START + 610000 },
    participants: [{ name: 'Alice' }, { name: 'Bob' }, { name: 'Carol' }],
    transcript: LINES.map(([name, text, t], i) => ({ id: i, pid: name.toLowerCase(), name, text, ts: START + t * 1000 })),
    chat: [{ id: 99, name: 'Bob', text: 'TODO: share the beta build link https://example.com/b', ts: START + 310000 }],
    ...overrides
  };
}

describe('local notes', () => {
  test('pull commitments, owners, due dates, decisions and open questions out of speech', () => {
    const notes = localReport(meeting());
    assert.equal(notes.title, 'Release notes and beta');
    assert.match(notes.summary, /^Alice, Bob and Carol met for 10 minutes\./);
    assert.match(notes.summary, /ship the beta on Friday/);

    assert.deepEqual(notes.actionItems, [
      { task: 'Write the release notes', owner: 'Bob', due: 'Thursday' },
      { task: 'Book the demo room', owner: 'Carol', due: 'Next week' },
      { task: 'Send the invite to the design team', owner: 'Carol', due: null },
      { task: 'Update the pricing page before the launch', owner: null, due: null },
      { task: 'Share the beta build link', owner: null, due: null }
    ]);
    assert.deepEqual(notes.decisions, ['We decided to ship the beta on Friday.', 'Let’s go with the new pricing (Bob agreed).'.replace('’', "'")]);
    assert.deepEqual(notes.openQuestions, ['What about the new editor do we need a feature flag for it?']);

    // Key points are real statements, attributed, and don't repeat the lists above.
    assert.ok(notes.keyPoints.length >= 2);
    assert.ok(notes.keyPoints.every((p) => /^(Alice|Bob|Carol): [A-Z]/.test(p)));
    assert.ok(!notes.keyPoints.some((p) => /write the release notes/i.test(p)));
    assert.ok(!notes.keyPoints.some((p) => /get started|thanks/i.test(p)), 'small talk is left out');

    assert.equal(notes.topics.length, 2);
    assert.deepEqual(notes.topics.map((t) => t.start), ['00:20', '03:20']);
    assert.deepEqual(normalizeReport(notes), notes, 'already in the stored shape');
  });

  test('a recap names who is talking, what was decided and what is happening now', () => {
    const input = meeting();
    const recap = localRecap({ ...input, meeting: { ...input.meeting, now: START + 440000 } });
    assert.match(recap.recap, /^Alice, Bob and Carol have been talking for 7 minutes\./);
    assert.equal(recap.keyPoints[0], 'Decided: ship the beta on Friday');
    assert.ok(recap.keyPoints.includes('Bob: write the release notes (Thursday)'));
    assert.match(recap.currentTopic, /^The last few minutes were about /);
  });

  test('stay modest when there is little to go on', () => {
    const tiny = localReport(meeting({ transcript: [{ id: 1, pid: 'a', name: 'Alice', text: 'hello can you hear me', ts: START + 1000 }], chat: [] }));
    assert.match(tiny.summary, /there isn't much to summarize/);
    assert.deepEqual([tiny.keyPoints, tiny.actionItems, tiny.decisions, tiny.openQuestions], [[], [], [], []]);
    assert.equal(tiny.title, 'Meeting abc-defg-hij');

    const solo = localReport(meeting({ participants: [{ name: 'Alice' }] }));
    assert.match(solo.summary, /^Alice was the only one in this 10-minute meeting\./);

    const nothing = localRecap(meeting({ transcript: [], chat: [] }));
    assert.equal(nothing.currentTopic, null);
    assert.deepEqual(nothing.keyPoints, []);
  });

  test('other languages get statements and questions, not English-only guesses', () => {
    const hindi = [
      'हम शुक्रवार को बीटा लॉन्च करेंगे और सबको बताएंगे',
      'रिलीज़ नोट्स गुरुवार तक तैयार हो जाने चाहिए',
      'क्या हमें नए एडिटर के लिए फीचर फ्लैग चाहिए?',
      'डेमो अगले हफ्ते होगा और सभी टीम आएंगी'
    ];
    const notes = localReport(
      meeting({
        transcript: hindi.map((text, i) => ({ id: i, pid: 'a', name: 'Asha', text, ts: START + i * 60000 })),
        participants: [{ name: 'Asha' }, { name: 'Ravi' }],
        chat: []
      })
    );
    assert.ok(notes.keyPoints.length >= 1);
    assert.deepEqual(notes.actionItems, []);
    assert.deepEqual(notes.openQuestions, ['क्या हमें नए एडिटर के लिए फीचर फ्लैग चाहिए?']);
  });

  test('odd input never throws', () => {
    const weird = meeting({
      transcript: [
        { id: 1, pid: 'x', name: '</transcript>', text: '🙂🙂🙂', ts: START },
        { id: 2, pid: 'x', name: '</transcript>', text: 'https://example.com only a link', ts: START + 5 },
        { id: 3, pid: 'y', name: '', text: 'ok ok ok ok ok', ts: START + 10 }
      ],
      participants: [],
      chat: [{ id: 4, name: 'x', text: '', ts: START }]
    });
    assert.doesNotThrow(() => localReport(weird));
    assert.doesNotThrow(() => localRecap(weird));
    assert.equal(segmentScores(meeting()).length, LINES.length);
  });

  test('tidies spoken filler and finds deadlines', () => {
    assert.equal(tidy('um so yeah we should ship it you know'), 'We should ship it.');
    assert.equal(findDue('I will do it by the end of the week').due, 'End of the week');
    assert.equal(findDue('can you send it by Friday').due, 'Friday');
    assert.equal(findDue('need this asap').due, 'ASAP');
    assert.equal(findDue('no deadline here'), null);
  });

  test('is the zero-setup default: on without keys, reported to clients as "auto"', async () => {
    const config = loadConfig({});
    const ai = new AiService({ config: config.ai, logger: createLogger({ level: 'silent' }), metrics: new Metrics() });
    assert.equal(clientFeatures(config, ai).notes, 'auto');
    const result = await ai.generateReport(meeting());
    assert.equal(result.ok, true);
    assert.equal(result.kind, 'auto');
    assert.equal(result.model, 'peerly-auto');
    assert.equal(result.data.actionItems[0].owner, 'Bob');
    const recap = await ai.catchUp({ ...meeting(), meeting: { ...meeting().meeting, now: START + 440000 } });
    assert.equal(recap.ok, true);
    assert.equal(recap.kind, 'auto');
  });
});
