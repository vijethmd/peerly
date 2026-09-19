'use strict';

// Meeting notes without an AI service. Picks the most informative things
// people said and pulls out commitments, decisions and open questions with
// plain English language patterns. Runs in-process, so it costs nothing,
// needs no key and nothing leaves the server. It is the default when no AI
// provider is configured and the fallback when one fails.

const LOCAL_MODEL = 'peerly-auto';

const STOPWORDS = new Set(
  `a about above actually after again against ah all almost alright also am an and another any anybody anyone anything
  anyway anyways are aren't around as at back basically be because been before being below between both but by bye can
  can't cannot could couldn't did didn't do does doesn't doing don't done down during each either else er erm even ever
  every everybody everyone everything few fine first for from further get gets getting go goes going gonna good got gotta
  great guess guys had hadn't has hasn't have haven't having he he'd he'll he's hello her here here's hers herself hey hi
  him himself his hmm how how's however i i'd i'll i'm i've if in into is isn't it it's its itself just kind know last
  let let's like literally lot lots made make makes making many may maybe me mean might mine more most much must mustn't
  my myself need needs never new next no nor not nothing now of off oh ok okay on once one only or other others ought our
  ours ourselves out over own perfect please pretty probably quite rather really right said same say says see seem seems
  shall shan't she she'd she'll she's should shouldn't so some somebody someone something sort still stuff such sure take
  than thank thanks that that's the their theirs them themselves then there there's these they they'd they'll they're
  they've thing things think this those though through thus to today tomorrow too totally uh um under until up upon us
  very via wanna want wants was wasn't way we we'd we'll we're we've well were weren't what what's whatever when when's
  where where's whether which while who who's whom whose why why's will with won't would wouldn't yeah yep yes yet you
  you'd you'll you're you've your yours yourself yourselves`.split(/\s+/)
);

// \p{M} keeps vowel signs inside words (Hindi, Kannada, Tamil, ...).
const WORD_RE = /[\p{L}\p{M}\p{N}]+(?:'[\p{L}\p{M}]+)*/gu;
const URL_RE = /\bhttps?:\/\/\S+/gi;

const LEADING_FILLER_RE =
  /^(?:(?:okay|ok|so|um+|uh+|erm|er|well|yeah|yep|yes|right|and|but|also|alright|all right|hmm+|oh|now|anyway|anyways|basically|actually|i mean|you know|like|great|cool|awesome|perfect)\b[\s,.!?-]*)+/i;
const TRAILING_FILLER_RE =
  /(?:[\s,]+(?:right|okay|ok|yeah|then|you know|i guess|i think|or something|and stuff|and so on|as well|too|if that's okay|if that works|if that's alright))+[\s.?!]*$/i;

// Small talk and call logistics, never worth a note when the line is short.
const META_RE =
  /\b(?:can you (?:all )?(?:hear|see) (?:me|us|my screen)|you(?:'re| are) (?:on )?mute|you(?:'re| are) muted|is my (?:mic|microphone|audio|camera|video|screen)|(?:hear|see) me (?:now|okay|ok)|sound check|testing,? testing|testing one two|good (?:morning|afternoon|evening)|how are you|how's it going|nice to (?:see|meet) you|thanks?(?: you)?|thank you|bye|see you|talk (?:to you )?(?:soon|later)|have a good (?:one|day|night|weekend)|share my screen|see my screen|one sec(?:ond)?|give me a (?:sec|second|minute)|be right back|brb|let's get started|get started|let's start|let's begin|let's wrap up|wrap (?:it|this) up|move on)\b/i;

const AGREE_RE =
  /^(?:yes|yeah|yep|yup|sure|ok(?:ay)?|agreed|agree|sounds good|sounds great|sounds fine|works for me|that works|perfect|great|good idea|makes sense|let's do (?:it|that)|deal|fine by me|i agree|exactly|absolutely|definitely|of course|will do|on it|i can do that|i'll do it|i'll do that|no problem|for sure)\b/i;

const UNCERTAIN_RE =
  /\b(?:not sure|don't know|do not know|no idea|good question|we'll see|need to check|have to check|find out|figure (?:it|that) out|tbd|to be decided|let me check|i'll check|let's check|not yet|it depends|depends on|unclear|haven't decided|have not decided)\b/i;

const QUESTION_START_RE =
  /^(?:(?:who|what|when|where|why|how|which|whose|anyone|anybody|any)\b|(?:should|shall|can|could|would|will|do|does|did|is|are|was|were|have|has|had|am)\s+(?:i|we|you|they|he|she|it|there|this|that|these|those|someone|anyone|anybody|everyone|the|our|your|my)\b)/i;

// ASCII, full-width (Chinese, Japanese) and Arabic question marks.
const QUESTION_END_RE = /[?？؟]\s*$/;

const OPEN_STATEMENT_RE =
  /\b(?:open question|still (?:need|have) to (?:decide|figure out|work out|agree on)|we (?:haven't|have not) (?:decided|agreed)|not sure (?:if|whether|how|what|when|who)|need to decide)\b/i;

// "We decided to ..." counts on its own; plans and proposals ("let's ...")
// only count when someone else agrees right after.
const DECISION_RE = [
  /\b(?:we(?:'ve| have)?|so we|and we) (?:all )?(?:decided|agreed|settled on|chose|picked|went with)\b/i,
  /\b(?:it's|that's|this is) (?:decided|settled|agreed|final)\b/i,
  /\b(?:the|our) (?:final )?decision is\b/i
];
const PROPOSAL_RE = [
  /\blet's (?:go with|stick with|go ahead with|use|keep|ship|launch|release|schedule|drop|cancel|postpone|push|delay|switch|hire|buy|book|set|pick|choose|fix|finish|merge|deploy)\b/i,
  /\bwe(?:'ll| will|'re going to| are going to| should) (?:go with|stick with|ship|launch|release|use|switch|keep|drop|cancel|postpone|delay|push)\b/i,
  /\b(?:the plan is|so the plan is|how about we|i (?:propose|suggest) (?:that )?we)\b/i
];

const OWN_COMMIT_RE =
  /\b(?:i'll|i will|i'm going to|i am going to|i'm gonna|i can|i could|i'll try to|let me|i need to|i have to|i should)\s+(.+)/i;
const OWN_COMMIT_SKIP_RE =
  /^(?:be|see|think|guess|say|tell you|mean|hear|know|just say|admit|leave|go|drop off|jump off|share (?:my|the) screen|check if|stop sharing|mute|unmute|try again|look|hand (?:it|this) over)\b/i;
const GROUP_TASK_RE =
  /\b(?:we need to|we have to|we should|we must|we'll need to|we still need to|someone (?:needs to|should|has to|must)|somebody (?:needs to|should)|need someone to|action items?|to-?dos?|follow[- ]up (?:on|with)|next steps? (?:is|are|would be)(?: to)?)\s*[:,-]?\s+(.+)/i;
const REQUEST_RE = /^(?:can|could|would|will) you(?: please)?\s+(.+)/i;
const TASK_CUT_RE = /\s+(?:and then|but|because|so that|so we|since|unless|which|if we|if you|while)\b.*$/i;
// Not something anyone can go and do: "be able to join", "see how it goes".
const TASK_SKIP_RE = /^(?:be|see|hear|know|think|say|tell|mean|guess|remember|believe|feel|wonder|get a chance)\b/i;

const DAYS = 'monday|tuesday|wednesday|thursday|friday|saturday|sunday';
const DUE_RE = new RegExp(
  `(?:\\b(?:by|before|until|till|due|on|for)\\s+)?\\b((?:next |this |coming )?(?:${DAYS})(?: morning| afternoon| evening)?|tomorrow(?: morning| afternoon| evening)?|tonight|today|(?:the )?end of (?:the )?(?:day|week|month|quarter|sprint)|(?:next|this) (?:week|month|quarter|sprint)|eod|eow|asap)\\b`,
  'i'
);

// --------------------------------------------------------------- helpers

const normalizeQuotes = (text) => String(text).replace(/[‘’ʼ]/g, "'");
const wordsOf = (text) => (normalizeQuotes(text).toLowerCase().match(WORD_RE) || []);

function stem(word) {
  if (word.length > 5 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 5 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us')) return word.slice(0, -1);
  return word;
}

const capitalize = (text) => (text ? text[0].toUpperCase() + text.slice(1) : text);
const lowerFirst = (text) => (text && !/^I\b/.test(text) ? text[0].toLowerCase() + text.slice(1) : text);

function tidy(text, { end = '.' } = {}) {
  let t = normalizeQuotes(text).replace(URL_RE, '').replace(/\s+/g, ' ').trim();
  t = t.replace(LEADING_FILLER_RE, '').replace(TRAILING_FILLER_RE, '');
  t = t.replace(/^(?:team|everyone|everybody|guys|folks|all)\b[\s,]+(?=(?:let's|we|i|so|please|quick)\b)/i, '');
  t = t.replace(/\b(?:um+|uh+|erm)\b,?\s*/gi, '').replace(/\s+([,.!?])/g, '$1').trim();
  t = t.replace(/[,;:\s-]+$/, '');
  if (!t) return '';
  t = capitalize(t);
  if (end && !/[.!?…。！？؟]$/.test(t)) t += end === '.' && /[\u3040-\u30ff\u3400-\u9fff]$/.test(t) ? '。' : end;
  return t;
}

function joinList(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function humanDuration(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours} hour${hours === 1 ? '' : 's'}${rest ? ` ${rest} minute${rest === 1 ? '' : 's'}` : ''}`;
}

function formatOffset(ts, startedAt) {
  const total = Math.max(0, Math.floor((ts - startedAt) / 1000));
  const h = Math.floor(total / 3600);
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function firstName(name) {
  return (wordsOf(name)[0] || '').toLowerCase();
}

// ---------------------------------------------------------------- analysis

function splitSentences(text) {
  return normalizeQuotes(text)
    .split(/(?<=[.!?])\s+(?=\S)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function stripLead(text) {
  return normalizeQuotes(text).trim().replace(LEADING_FILLER_RE, '');
}

function isQuestion(text) {
  const t = stripLead(text);
  return QUESTION_END_RE.test(t) || QUESTION_START_RE.test(t);
}

function buildUnits(input, nameWords) {
  const units = [];
  const add = (text, base) => {
    const tokens = wordsOf(text);
    if (!tokens.length) return;
    const content = tokens.filter((w) => w.length > 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w) && !nameWords.has(w));
    units.push({
      ...base,
      text,
      tokens,
      stems: content.map(stem),
      stemSet: new Set(content.map(stem)),
      contentCount: content.length,
      question: isQuestion(text),
      meta: tokens.length <= 10 && META_RE.test(normalizeQuotes(text))
    });
  };
  for (const [index, seg] of (input.transcript || []).entries()) {
    for (const sentence of splitSentences(seg.text)) add(sentence, { source: 'speech', segment: index, name: seg.name, pid: seg.pid, ts: seg.ts });
  }
  for (const msg of input.chat || []) {
    const text = String(msg.text || '').replace(URL_RE, ' ').trim();
    if (text) add(text, { source: 'chat', name: msg.name, pid: null, ts: msg.ts });
  }
  units.sort((a, b) => a.ts - b.ts);
  units.forEach((unit, i) => {
    unit.index = i;
  });
  return units;
}

// Document frequency of each stem, plus the most common way it was written.
function vocabulary(units) {
  const df = new Map();
  const surface = new Map();
  for (const unit of units) {
    for (const s of unit.stemSet) df.set(s, (df.get(s) || 0) + 1);
    for (const w of unit.tokens) {
      const s = stem(w);
      if (!unit.stemSet.has(s)) continue;
      let forms = surface.get(s);
      if (!forms) surface.set(s, (forms = new Map()));
      forms.set(w, (forms.get(w) || 0) + 1);
    }
  }
  const display = (s) => {
    const forms = surface.get(s);
    return forms ? [...forms.entries()].sort((a, b) => b[1] - a[1])[0][0] : s;
  };
  return { df, display };
}

// Words that come up now and then carry the topics; words in nearly every
// line say nothing about any one line, and one-off words are noise.
// p * log(1/p) peaks for words in about a third of the lines.
function stemWeight(vocab, units, s) {
  const df = vocab.df.get(s) || 0;
  if (df <= 1 || units.length < 2) return 0.2;
  const p = Math.min(df / units.length, 0.999);
  return Math.max(0.2, 10 * p * Math.log(1 / p));
}

// Two-word phrases whose words sit next to each other with no filler between.
function phrasesOf(units, vocab, minCount = 2) {
  const counts = new Map();
  for (const unit of units) {
    const seen = new Set();
    for (let i = 0; i + 1 < unit.tokens.length; i++) {
      const [a, b] = [unit.tokens[i], unit.tokens[i + 1]];
      if (STOPWORDS.has(a) || STOPWORDS.has(b) || a.length < 3 || b.length < 3 || /^\d+$/.test(a) || /^\d+$/.test(b)) continue;
      const sa = stem(a);
      const sb = stem(b);
      if (!unit.stemSet.has(sa) || !unit.stemSet.has(sb) || sa === sb) continue;
      const key = `${sa} ${sb}`;
      if (seen.has(key)) continue;
      seen.add(key);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= minCount)
    .map(([key, count]) => {
      const [sa, sb] = key.split(' ');
      return { key, stems: [sa, sb], text: `${vocab.display(sa)} ${vocab.display(sb)}`, score: count * 1.6 };
    });
}

// The most discussed phrases and words, best first, without repeating a word.
function topTerms(units, vocab, limit, phrases = phrasesOf(units, vocab)) {
  const words = [...vocab.df.entries()]
    .filter(([, df]) => df >= 2)
    .map(([s, df]) => ({ stems: [s], text: vocab.display(s), score: df }));
  const ranked = [...phrases, ...words].sort((a, b) => b.score - a.score);
  const used = new Set();
  const out = [];
  for (const term of ranked) {
    if (term.stems.some((s) => used.has(s))) continue;
    term.stems.forEach((s) => used.add(s));
    out.push(term);
    if (out.length >= limit) break;
  }
  return out;
}

function scoreUnits(units, vocab) {
  for (const unit of units) {
    if (unit.meta || !unit.contentCount) {
      unit.score = 0;
      continue;
    }
    let sum = 0;
    for (const s of unit.stemSet) sum += stemWeight(vocab, units, s);
    let score = sum / Math.sqrt(unit.stemSet.size + 1);
    if (unit.contentCount < 3) score *= 0.2;
    else if (unit.contentCount < 5) score *= 0.6;
    if (unit.source === 'chat') score *= 0.7;
    if (unit.question) score *= 0.6;
    unit.score = score;
  }
}

function nextReply(units, unit, withinMs) {
  for (let i = unit.index + 1; i < units.length; i++) {
    const other = units[i];
    if (other.ts - unit.ts > withinMs) return null;
    if (other.name !== unit.name && other.source === unit.source) return other;
  }
  return null;
}

function findDue(text) {
  const match = normalizeQuotes(text).match(DUE_RE);
  if (!match) return null;
  const raw = match[1].toLowerCase().replace(/^the /, '');
  const due = /^(?:eod|eow|asap)$/.test(raw) ? raw.toUpperCase() : capitalize(raw);
  return { due, full: match[0] };
}

function cleanTask(text, due) {
  let t = normalizeQuotes(text);
  if (due) t = t.replace(due.full, ' ');
  t = t.replace(TASK_CUT_RE, '').replace(URL_RE, '');
  t = t.replace(/^(?:to|also|just|quickly|go ahead and|try to|then)\s+/i, '');
  t = tidy(t, { end: '' }).replace(/[.!?]+$/, '');
  return t.split(/\s+/).slice(0, 24).join(' ');
}

function lengthAdjective(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return 'short';
  if (minutes < 60) return `${minutes}-minute`;
  const hours = Math.round(minutes / 60);
  return `${hours}-hour`;
}

function taskContentCount(task) {
  return wordsOf(task).filter((w) => w.length > 2 && !STOPWORDS.has(w)).length;
}

function participantByFirstName(participants, word) {
  const needle = String(word || '').toLowerCase();
  if (needle.length < 2) return null;
  return participants.find((p) => firstName(p.name) === needle) || null;
}

function extractActions(units, participants) {
  const items = [];
  const add = (unit, task, owner) => {
    const due = findDue(task) || findDue(unit.text);
    const cleaned = cleanTask(task, due);
    if (TASK_SKIP_RE.test(cleaned) || taskContentCount(cleaned) < 2) return false;
    items.push({ task: cleaned, owner: owner || null, due: due ? due.due : null, unit });
    return true;
  };
  const namedTask = (text) => {
    // "<Name>, can you ..." or "... <Name> will ..." aimed at someone in the meeting.
    const direct = text.match(/^([\p{L}]+),?\s+(?:can you|could you|would you|will you|please|you'll|you will|you should|you need to)\s+(.+)/iu);
    const candidates = direct ? [direct] : [...text.matchAll(/\b([\p{L}]+)\s+(?:will|is going to|is gonna|should|needs to|has to|can)\s+(.+)/giu)];
    for (const match of candidates) {
      const owner = participantByFirstName(participants, match[1]);
      if (owner) return { owner: owner.name, task: match[2] };
    }
    return null;
  };

  for (const unit of units) {
    if (unit.meta) continue;
    const text = stripLead(unit.text);

    const named = namedTask(text);
    if (named && add(unit, named.task, named.owner)) {
      unit.usedAsRequest = true;
      continue;
    }

    // "Can you ...?" answered with "sure" by someone: that person owns it.
    const request = text.match(REQUEST_RE);
    if (request) {
      const reply = nextReply(units, unit, 30000);
      if (reply && AGREE_RE.test(stripLead(reply.text)) && add(unit, request[1], reply.name)) {
        unit.usedAsRequest = true;
        continue;
      }
    }

    const own = text.match(OWN_COMMIT_RE);
    if (own && !OWN_COMMIT_SKIP_RE.test(own[1]) && !unit.question && add(unit, own[1], unit.name)) continue;

    const group = text.match(GROUP_TASK_RE);
    if (group && !unit.question) add(unit, group[1], null);
  }

  const kept = [];
  for (const item of items) {
    const set = new Set(wordsOf(item.task).map(stem));
    const duplicate = kept.find((k) => jaccard(k.set, set) > 0.6);
    if (duplicate) {
      duplicate.owner ||= item.owner;
      duplicate.due ||= item.due;
      continue;
    }
    kept.push({ ...item, set });
  }
  return kept.slice(0, 8);
}

function extractDecisions(units) {
  const out = [];
  for (const unit of units) {
    if (unit.meta || unit.question) continue;
    const text = normalizeQuotes(unit.text);
    let decided = DECISION_RE.some((re) => re.test(text));
    let agreedBy = null;
    if (!decided && PROPOSAL_RE.some((re) => re.test(text))) {
      const reply = nextReply(units, unit, 45000);
      if (reply && AGREE_RE.test(stripLead(reply.text))) {
        decided = true;
        agreedBy = reply.name;
      }
    }
    if (!decided) continue;
    const line = tidy(unit.text);
    if (taskContentCount(line) < 1) continue;
    const set = unit.stemSet;
    if (out.some((d) => jaccard(d.unit.stemSet, set) > 0.6)) continue;
    out.push({ text: agreedBy ? `${line.replace(/[.!?]$/, '')} (${agreedBy} agreed).` : line, unit });
  }
  return out.slice(0, 6);
}

// "We decided to ship on Friday" -> "ship on Friday", for use mid-sentence.
function decisionCore(text) {
  return text
    .replace(/^(?:so |and )?(?:we(?:'ve| have)? (?:all )?(?:decided|agreed)(?: to| that| on)?|the plan is to|the (?:final )?decision is(?: to)?|it's decided(?: that)?|let's)\s+/i, '')
    .replace(/[.!?]$/, '');
}

function extractQuestions(units) {
  const out = [];
  for (const unit of units) {
    if (unit.meta || unit.usedAsRequest || unit.tokens.length < 4) continue;
    if (unit.question) {
      const reply = nextReply(units, unit, 25000);
      const answered =
        reply && !reply.question && reply.tokens.length >= 3 && !UNCERTAIN_RE.test(normalizeQuotes(reply.text));
      if (answered) continue;
      out.push({ text: tidy(unit.text, { end: '?' }).replace(/[.!]$/, '?'), unit });
    } else if (OPEN_STATEMENT_RE.test(normalizeQuotes(unit.text))) {
      out.push({ text: tidy(unit.text), unit });
    }
  }
  const kept = [];
  for (const q of out) {
    if (kept.some((k) => jaccard(k.unit.stemSet, q.unit.stemSet) > 0.6)) continue;
    kept.push(q);
  }
  return kept.slice(-5);
}

function attributed(unit) {
  const line = tidy(unit.text);
  return unit.name ? `${unit.name}: ${line}` : line;
}

function pickKeyPoints(units, exclude, limit) {
  const candidates = units
    .filter((u) => u.score > 0 && u.contentCount >= 3 && !u.question && !exclude.has(u.index))
    .sort((a, b) => b.score - a.score);
  const picked = [];
  for (const unit of candidates) {
    if (picked.some((p) => jaccard(p.stemSet, unit.stemSet) > 0.5)) continue;
    picked.push(unit);
    if (picked.length >= limit) break;
  }
  return picked.sort((a, b) => a.ts - b.ts);
}

// Consecutive stretches of the meeting that talk about the same things.
function sections(units, vocab, startedAt) {
  const speech = units.filter((u) => u.score > 0);
  if (speech.length < 8) return [];
  const first = speech[0].ts;
  const span = speech[speech.length - 1].ts - first;
  if (span < 3 * 60000) return [];
  const windowMs = Math.max(60000, Math.ceil(span / 10));

  const windows = [];
  for (const unit of speech) {
    const index = Math.floor((unit.ts - first) / windowMs);
    (windows[index] ||= []).push(unit);
  }
  const vector = (list) => {
    const v = new Map();
    for (const u of list) for (const s of u.stemSet) v.set(s, (v.get(s) || 0) + stemWeight(vocab, units, s));
    return v;
  };
  const cosine = (a, b) => {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (const [k, x] of a) {
      na += x * x;
      if (b.has(k)) dot += x * b.get(k);
    }
    for (const x of b.values()) nb += x * x;
    return na && nb ? dot / Math.sqrt(na * nb) : 0;
  };

  const groups = [];
  for (const list of windows.filter(Boolean)) {
    const current = groups[groups.length - 1];
    if (current && (current.units.length < 3 || cosine(vector(current.units), vector(list)) >= 0.12)) current.units.push(...list);
    else groups.push({ units: [...list] });
  }
  while (groups.length > 6) {
    let best = 0;
    let bestSim = -1;
    for (let i = 0; i + 1 < groups.length; i++) {
      const sim = cosine(vector(groups[i].units), vector(groups[i + 1].units));
      if (sim > bestSim) {
        bestSim = sim;
        best = i;
      }
    }
    groups[best].units.push(...groups[best + 1].units);
    groups.splice(best + 1, 1);
  }
  if (groups.length < 2) return [];

  return groups.map((group) => {
    const terms = topTerms(group.units, vocabulary(group.units), 2);
    const title = terms.length ? capitalize(joinList(terms.map((t) => t.text))) : `Part ${groups.indexOf(group) + 1}`;
    const best = [...group.units].sort((a, b) => b.score - a.score)[0];
    return { title, summary: attributed(best), start: formatOffset(group.units[0].ts, startedAt) };
  });
}

function englishLike(units) {
  let total = 0;
  let common = 0;
  for (const unit of units) {
    for (const w of unit.tokens) {
      total += 1;
      if (STOPWORDS.has(w)) common += 1;
    }
  }
  return total > 0 && common / total >= 0.12;
}

function peopleLine(participants, durationMs) {
  const names = participants.map((p) => p.name).filter(Boolean);
  const length = humanDuration(durationMs);
  if (names.length === 0) return `The meeting lasted ${length}.`;
  if (names.length === 1) return `${names[0]} was the only one in this ${lengthAdjective(durationMs)} meeting.`;
  const shown = names.length > 4 ? [...names.slice(0, 3), `${names.length - 3} others`] : names;
  return `${joinList(shown)} met for ${length}.`;
}

function analyze(input) {
  const participants = input.participants || [];
  const nameWords = new Set(participants.flatMap((p) => wordsOf(p.name)));
  const units = buildUnits(input, nameWords);
  const vocab = vocabulary(units);
  scoreUnits(units, vocab);
  return { participants, units, vocab, english: englishLike(units) };
}

/** Meeting notes in the same shape the AI providers return. */
function localReport(input) {
  const { meeting } = input;
  const { participants, units, vocab, english } = analyze(input);
  const endedAt = meeting.endedAt || meeting.now || Date.now();
  const durationMs = Math.max(0, endedAt - meeting.startedAt);
  const intro = peopleLine(participants, durationMs);
  const contentWords = units.reduce((sum, u) => sum + u.contentCount, 0);
  const letters = units.reduce((sum, u) => sum + u.text.replace(/\s+/g, '').length, 0);

  const empty = { title: `Meeting ${meeting.roomId}`, keyPoints: [], topics: [], decisions: [], actionItems: [], openQuestions: [] };
  if (!units.length || (contentWords < 6 && (english || letters < 30))) {
    return { ...empty, summary: `${intro} Only a little was said on the transcript, so there isn't much to summarize.` };
  }

  if (!english) {
    // The patterns below are English. Elsewhere, keep to what works in any
    // language: the longest statements spread across the meeting, and lines
    // that end in a question mark.
    const speech = units.filter((u) => u.source === 'speech' && !u.meta);
    const fifths = [0, 1, 2, 3, 4].map((i) => speech.slice(Math.floor((i * speech.length) / 5), Math.floor(((i + 1) * speech.length) / 5)));
    // Letters, not words: Chinese and Japanese don't put spaces between words.
    const size = (u) => u.text.replace(/\s+/g, '').length;
    const keyPoints = fifths
      .map((part) => [...part].sort((a, b) => size(b) - size(a))[0])
      .filter((u) => u && size(u) >= 12)
      .map(attributed);
    const openQuestions = units.filter((u) => QUESTION_END_RE.test(u.text)).slice(-5).map((u) => tidy(u.text, { end: '?' }));
    return { ...empty, summary: `${intro} ${units.length} lines were transcribed.`, keyPoints, openQuestions };
  }

  const phrases = phrasesOf(units, vocab);
  const terms = topTerms(units, vocab, 3, phrases);
  const actions = extractActions(units, participants);
  const decisions = extractDecisions(units);
  const questions = extractQuestions(units);

  const used = new Set([...actions, ...decisions, ...questions].map((x) => x.unit.index));
  const limit = Math.min(6, Math.max(2, Math.round(Math.sqrt(units.length))));
  const keyPoints = pickKeyPoints(units, used, limit).map(attributed);

  const summary = [intro];
  if (terms.length) summary.push(`Most of the conversation was about ${joinList(terms.map((t) => t.text))}.`);
  if (decisions.length) {
    const first = lowerFirst(decisionCore(decisions[0].text));
    summary.push(decisions.length === 1 ? `The main decision: ${first}.` : `${decisions.length} decisions were made, including: ${first}.`);
  }
  if (actions.length) summary.push(`${actions.length} follow-up${actions.length === 1 ? ' was' : 's were'} noted.`);

  // Short meetings repeat little: fall back to two-word phrases said once.
  const titleTerms = (terms.length ? terms : phrasesOf(units.filter((u) => !u.meta), vocab, 1)).slice(0, 2).map((t) => t.text);
  return {
    title: titleTerms.length ? capitalize(joinList(titleTerms)) : `Meeting ${meeting.roomId}`,
    summary: summary.join(' '),
    keyPoints,
    topics: sections(units, vocab, meeting.startedAt),
    decisions: decisions.map((d) => d.text),
    actionItems: actions.map(({ task, owner, due }) => ({ task, owner, due })),
    openQuestions: questions.map((q) => q.text)
  };
}

/** A quick "catch me up" for someone joining a meeting in progress. */
function localRecap(input) {
  const { meeting } = input;
  const now = meeting.now || Date.now();
  const { participants, units, vocab, english } = analyze(input);
  if (!units.some((u) => u.contentCount > 0)) {
    return { recap: 'Nothing much has been said on the transcript yet.', keyPoints: [], currentTopic: null };
  }
  const speakers = participants.filter((p) => units.some((u) => u.name === p.name)).map((p) => p.name);
  const people = speakers.length ? joinList(speakers.length > 4 ? [...speakers.slice(0, 3), `${speakers.length - 3} others`] : speakers) : 'People';
  const recap = [`${people} ${speakers.length === 1 ? 'has' : 'have'} been talking for ${humanDuration(now - meeting.startedAt)}.`];

  if (!english) {
    const recent = units.filter((u) => !u.meta).slice(-3).map(attributed);
    return { recap: recap[0], keyPoints: recent, currentTopic: null };
  }

  const terms = topTerms(units, vocab, 3);
  if (terms.length) recap.push(`So far it has mostly been about ${joinList(terms.map((t) => t.text))}.`);

  const decisions = extractDecisions(units);
  const actions = extractActions(units, participants);
  const keyPoints = [
    ...decisions.map((d) => `Decided: ${lowerFirst(decisionCore(d.text))}`),
    ...actions.map((a) => `${a.owner ? `${a.owner}: ` : 'To do: '}${lowerFirst(a.task)}${a.due ? ` (${a.due})` : ''}`)
  ];
  const used = new Set([...decisions, ...actions].map((x) => x.unit.index));
  for (const unit of pickKeyPoints(units, used, 6)) {
    if (keyPoints.length >= 6) break;
    keyPoints.push(attributed(unit));
  }

  const recentUnits = units.filter((u) => now - u.ts <= 3 * 60000);
  const recentTerms = recentUnits.length >= 2 ? topTerms(recentUnits, vocabulary(recentUnits), 2) : [];
  const currentTopic = recentTerms.length
    ? `The last few minutes were about ${joinList(recentTerms.map((t) => t.text))}.`
    : null;
  return { recap: recap.join(' '), keyPoints: keyPoints.slice(0, 6), currentTopic };
}

/** Importance of each transcript segment, for trimming long meetings. */
function segmentScores(input) {
  const { units } = analyze({ ...input, chat: [] });
  const actions = new Set(extractActions(units, input.participants || []).map((a) => a.unit.index));
  const decisions = new Set(extractDecisions(units).map((d) => d.unit.index));
  const scores = new Array((input.transcript || []).length).fill(0);
  for (const unit of units) {
    if (unit.segment === undefined) continue;
    // Commitments and decisions are kept before anything else.
    let score = unit.score;
    if (actions.has(unit.index) || decisions.has(unit.index)) score += 1000;
    else if (unit.question) score += 1;
    scores[unit.segment] = Math.max(scores[unit.segment], score);
  }
  return scores;
}

module.exports = { LOCAL_MODEL, localReport, localRecap, segmentScores, tidy, findDue, stem, humanDuration };
