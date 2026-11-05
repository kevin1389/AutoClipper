import type { ClipScoreBreakdown, SelectedClip } from '../types';
import type { ClipSelector, SelectionInput } from './types';
import { buildSentences, finalizeSelection, type Sentence } from './select-utils';
import { emphasisScore } from '../edit/plan';

/**
 * Deterministic, explainable highlight selection.
 *
 * Every clip is chosen because content signals say it is worth watching: an
 * opening hook in the first two seconds, a recognizable comic/surprise/dramatic
 * or informative beat, enough context to stand alone, a payoff at the end and
 * healthy pacing. Word timestamps, lexical emphasis, measured audio peaks and
 * detected visual changes all contribute. No score is random, no clip is chosen
 * from position alone, and a weak transcript is allowed to produce fewer than
 * the target number of clips rather than being padded with filler.
 *
 * It runs when no LLM is configured and as the fallback when an LLM call fails.
 */

type ContentType = 'funny' | 'surprising' | 'dramatic' | 'informative' | 'emotional';

const TYPE_LABEL: Record<ContentType, string> = {
  funny: 'Funny',
  surprising: 'Surprising',
  dramatic: 'Dramatic',
  informative: 'Informative',
  emotional: 'Emotional',
};

const HOOK_PATTERNS: { re: RegExp; label: string; weight: number }[] = [
  { re: /\bhere'?s (the|why|how|what|a)\b/i, label: 'direct “here’s…” hook', weight: 0.85 },
  { re: /\bthe (truth|secret|problem|mistake|reason|trick)\b/i, label: 'promise of a secret or truth', weight: 0.8 },
  { re: /\bnobody (tells|talks|knows|warns|expects)\b/i, label: 'contrarian hook', weight: 0.85 },
  { re: /\bwhat (most people|nobody|if you|would happen)\b/i, label: 'audience-targeting hook', weight: 0.8 },
  { re: /\bhow (i|we|you|to)\b/i, label: 'how-to framing', weight: 0.55 },
  { re: /\bwhy (you|most|it|i|we)\b/i, label: 'explains a cause', weight: 0.55 },
  { re: /\b(biggest|worst|best|hardest|fastest|easiest)\b/i, label: 'superlative claim', weight: 0.55 },
  { re: /\bmistake\b/i, label: 'mistake framing', weight: 0.65 },
  { re: /\blet me (tell|explain|show)\b/i, label: 'storytelling setup', weight: 0.65 },
  { re: /\bthe (key|point|thing) is\b/i, label: 'explicit takeaway', weight: 0.65 },
  { re: /\b(stop|never|imagine|listen|look|wait)\b/i, label: 'direct command hook', weight: 0.55 },
  { re: /\b(this is why|that'?s why|I (learned|realized|discovered))\b/i, label: 'curiosity gap', weight: 0.6 },
  { re: /\b(you (need|have) to|you should|most people)\b/i, label: 'direct advice hook', weight: 0.5 },
  { re: /\b(ask not|not what|but what)\b/i, label: 'rhetorical challenge', weight: 0.7 },
];

const INTRO_PATTERNS: RegExp[] = [
  /^(hey|hi|hello)( guys| everyone| folks| everybody)?\b/i,
  /^(welcome back|welcome to)\b/i,
  /^(in this video|in today'?s video|today (i|we)( want| are| will|'re)?)\b/i,
  /^(let'?s (get|dive|jump|start|talk)|before we (start|begin))\b/i,
  /^(as (i|we) (said|mentioned)|like i (said|mentioned))\b/i,
  /^(okay|ok|so|um|uh|yeah)[, ]+(so|yeah|um|uh)?\b/i,
];

const CONTEXT_DEPENDENT_START = /^(it|that|this|they|them|he|she|those|these|there|which|then|but|and|so|because)\b/i;
const FILLER_START = /^(and|so|but|um|uh|like|you know|well|okay|ok|right|yeah|i mean|then)\b[\s,]*/i;
const FILLER_WORDS = new Set(['um', 'uh', 'erm', 'ah', 'hmm', 'like', 'literally', 'basically', 'actually']);

const LAUGH_RE = /\b(haha+|lol|laugh(?:ed|ing|s|ter)?|hilarious|funny|joke|jokes|comedy|ridiculous|absurd)\b/i;
const SURPRISE_RE = /\b(wait|what\?|really\?|no way|unbelievable|shocked|surprised|surprising|unexpected|turns? out|actually|never expected|didn'?t expect|plot twist)\b/i;
const DRAMA_RE = /\b(scared|terrified|furious|angry|cried|crying|broke down|lost|risk|danger|disaster|worst|fight|conflict|everything|nothing left|painful)\b/i;
const EMOTIONAL_RE = /\b(love|loved|hate|hated|proud|hurt|heartbroken|grateful|overwhelmed|moved|emotional|vulnerable)\b/i;
const INFORMATIVE_RE = /\b(how|because|reason|result|data|research|study|step|strategy|mistake|tip|learn|found|measured|percent|advice|framework|process)\b/i;
const RHETORICAL_RE = /\b(ask not|not what|let us|we (must|shall|will)|the future|freedom|hope|courage|sacrifice|generation|dream|country|america|americans|duty|honor)\b/i;
const ADVICE_RE = /\b(you should|you need to|make sure|the trick|the key|start by|try this|avoid|remember to|here'?s how)\b/i;
const CAUSE_RE = /\b(because|the reason|which means|turns? out|so that|as a result|that'?s why)\b/i;
const PAYOFF_PATTERNS = [
  /\b(turns? out|it turned out|in the end|the result (was|is)|that'?s why|which means|so yeah|and that'?s)\b/i,
  /\b(ended up|we found|i learned|the lesson|what happened next)\b/i,
];
const RESULT_WORDS = /\b(won|worked|failed|changed|saved|lost|made|earned|doubled|tripled|realized|discovered)\b/i;
const DANGLING_END = /\b(and|but|because|so|or|if|when|which|that|to|of|with|for|like|you know|i mean|right)\W*$/i;
const BACKREFERENCE = /\b(as i said|like i mentioned|earlier|previously|that thing|remember when)\b/i;
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'for', 'with', 'is', 'are',
  'was', 'were', 'be', 'been', 'it', 'this', 'that', 'these', 'those', 'i', 'you', 'we', 'they',
  'he', 'she', 'them', 'his', 'her', 'our', 'your', 'my', 'me', 'us', 'at', 'as', 'so', 'if',
  'then', 'than', 'there', 'here', 'not', 'no', 'yes', 'just', 'really', 'very', 'can', 'could',
  'would', 'should', 'will', 'do', 'did', 'does', 'have', 'has', 'had', 'from', 'by', 'about',
]);

const WEIGHTS: Record<keyof Omit<ClipScoreBreakdown, 'total'>, number> = {
  hook: 0.26,
  entertainment: 0.2,
  substance: 0.16,
  context: 0.18,
  payoff: 0.12,
  pacing: 0.08,
};

/** Minimum absolute score, and the fraction of the best clip, worth publishing. */
const MIN_QUALITY = 0.34;
const RELATIVE_QUALITY = 0.68;

function countMatches(text: string, re: RegExp): number {
  const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  return (text.match(global) ?? []).length;
}

function hasMatch(text: string, re: RegExp): boolean {
  return new RegExp(re.source, re.flags.replace('g', '')).test(text);
}

function titleCaseFirst(text: string): string {
  if (!text) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function stripFillers(text: string): string {
  let cleaned = text.trim();
  for (let i = 0; i < 3; i += 1) {
    const next = cleaned.replace(FILLER_START, '').trim();
    if (next === cleaned || next.length < 8) break;
    cleaned = next;
  }
  return cleaned;
}

function truncateAtWord(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > 20 ? lastSpace : maxChars).replace(/[,;:\-]$/, '')}…`;
}

function pickTitle(
  sentences: Sentence[],
  from: number,
  to: number,
  used: Set<string>,
): string {
  const ranked = sentences
    .slice(from, to + 1)
    .map((sentence) => ({ sentence, score: sentence.text.length > 0 ? emphasisScore(sentence.text) : 0 }))
    .sort((a, b) => b.score - a.score);

  for (const { sentence } of ranked) {
    const candidate = titleCaseFirst(
      truncateAtWord(stripFillers(sentence.text.replace(/[.!?]+$/, '')), 72),
    );
    if (candidate.length >= 8 && !used.has(candidate.toLowerCase())) return candidate;
  }
  const fallback = titleCaseFirst(truncateAtWord(stripFillers(sentences[from].text), 72));
  return used.has(fallback.toLowerCase()) ? `${fallback} · ${Math.round(sentences[from].startMs / 1000)}s` : fallback;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 100) / 100));
}

function contentWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9']+/)
      .filter((word) => word.length > 2 && !STOP_WORDS.has(word)),
  );
}

function textSimilarity(a: string, b: string): number {
  const left = contentWords(a);
  const right = contentWords(b);
  if (left.size < 4 || right.size < 4) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

interface Candidate {
  from: number;
  to: number;
  startMs: number;
  endMs: number;
  text: string;
  breakdown: ClipScoreBreakdown;
  evidence: string[];
  contentType: ContentType;
}

function classifyContent(text: string, numbers: number, causalClaims: number, advice: number): {
  type: ContentType;
  scores: Record<ContentType, number>;
  evidence: string[];
} {
  const laughs = countMatches(text, LAUGH_RE);
  const surprises = countMatches(text, SURPRISE_RE);
  const dramatic = countMatches(text, DRAMA_RE);
  const emotional = countMatches(text, EMOTIONAL_RE);
  const informative = countMatches(text, INFORMATIVE_RE);
  const rhetorical = countMatches(text, RHETORICAL_RE);
  const exclamations = countMatches(text, /!/g);
  const questions = countMatches(text, /\?/g);

  const scores: Record<ContentType, number> = {
    funny: clampScore(laughs * 0.3 + exclamations * 0.05),
    surprising: clampScore(surprises * 0.22 + questions * 0.12),
    dramatic: clampScore(dramatic * 0.22 + exclamations * 0.04),
    informative: clampScore(
      numbers * 0.16 + causalClaims * 0.16 + advice * 0.18 + informative * 0.08 + rhetorical * 0.05,
    ),
    emotional: clampScore(emotional * 0.22 + rhetorical * 0.08),
  };

  const ordered = (Object.entries(scores) as [ContentType, number][])
    .sort((a, b) => b[1] - a[1]);
  const [type, score] = ordered[0];
  const evidence: string[] = [];
  if (score >= 0.28) {
    if (type === 'funny') evidence.push('comedic beat');
    if (type === 'surprising') evidence.push('surprising reversal');
    if (type === 'dramatic') evidence.push('dramatic stakes');
    if (type === 'informative') evidence.push('concrete takeaway');
    if (type === 'emotional') evidence.push('emotional beat');
    if (rhetorical >= 2) evidence.push('rhetorical stakes');
  } else {
    return { type: 'informative', scores, evidence: [] };
  }
  return { type, scores, evidence };
}

function openingHook(opening: string, firstTwoSeconds: string): { score: number; evidence: string[] } {
  const evidence: string[] = [];
  let score = 0.12;
  const search = `${opening} ${firstTwoSeconds}`.toLowerCase();

  for (const signal of HOOK_PATTERNS) {
    if (signal.re.test(search)) {
      score += signal.weight;
      evidence.push(signal.label);
    }
  }
  if (hasMatch(opening, /\?/)) {
    score += 0.32;
    evidence.push('opens with a question');
  }
  if (hasMatch(firstTwoSeconds, /\b\d{1,4}(?:[.,]\d+)?%?\b/)) {
    score += 0.18;
    evidence.push('opens with a concrete number');
  }
  if (hasMatch(opening, /\b(you|your)\b/i)) {
    score += 0.12;
    evidence.push('speaks directly to the viewer');
  }
  if (INTRO_PATTERNS.some((pattern) => pattern.test(opening))) {
    score -= 0.42;
    evidence.push('slow introduction');
  }
  if (CONTEXT_DEPENDENT_START.test(opening.trim())) score -= 0.14;
  if (FILLER_START.test(opening.trim())) score -= 0.1;

  return { score: clampScore(score), evidence: [...new Set(evidence)] };
}

export function scoreCandidateWindow(
  input: SelectionInput,
  sentences: Sentence[],
  from: number,
  to: number,
): Candidate | null {
  if (from < 0 || to < from || to >= sentences.length) return null;
  const startMs = sentences[from].startMs;
  const endMs = sentences[to].endMs;
  const durationMs = endMs - startMs;
  if (durationMs < 6_500 || durationMs > 45_000) return null;

  const text = sentences.slice(from, to + 1).map((sentence) => sentence.text).join(' ');
  const lower = text.toLowerCase();
  const opening = sentences[from].text;
  const closing = sentences[to].text;
  const firstTwoSeconds = input.words
    .filter((word) => word.startMs >= startMs && word.startMs < startMs + 2_000)
    .map((word) => word.text)
    .join(' ');
  const words = lower.split(/[^a-z'0-9]+/).filter(Boolean);
  const wordCount = words.length;
  const seconds = durationMs / 1000;
  const wordsPerSecond = wordCount / Math.max(1, seconds);
  const sentenceCount = to - from + 1;
  const numbers = countMatches(lower, /\b\d{1,4}(?:[.,]\d+)?%?\b/g);
  const causalClaims = countMatches(text, CAUSE_RE);
  const advice = countMatches(text, ADVICE_RE);
  const content = classifyContent(text, numbers, causalClaims, advice);
  const evidence = new Set<string>(content.evidence);

  /* ---- hook: can the first two seconds stop a scroll? ---- */
  const hookResult = openingHook(opening, firstTwoSeconds);
  hookResult.evidence.forEach((label) => evidence.add(label));
  const hook = hookResult.score;

  /* ---- entertainment: laughter, surprise, drama, emotion and reactions ---- */
  let entertainment = Math.max(
    content.scores.funny,
    content.scores.surprising,
    content.scores.dramatic,
    content.scores.emotional,
    content.scores.informative * 0.75,
  );
  const exclamations = countMatches(text, /!/g);
  entertainment = Math.min(1, entertainment + exclamations * 0.04);
  if (hasMatch(text, /\b(laugh|crying|screaming|yelling|gasping)\b/i)) {
    entertainment = Math.min(1, entertainment + 0.12);
    evidence.add('audible reaction');
  }

  /* ---- substance: facts, numbers, explanations and useful advice ---- */
  const facts = Math.min(1, numbers * 0.16 + causalClaims * 0.14 + advice * 0.16);
  const substance = Math.max(
    content.scores.informative * 0.85,
    Math.min(1, facts + (wordCount >= 35 ? 0.14 : 0)),
  );
  if (numbers > 0) evidence.add('concrete numbers');
  if (causalClaims > 0) evidence.add('explains a cause or result');
  if (advice > 0) evidence.add('practical advice');

  /* ---- context: can a stranger follow it without the previous minute? ---- */
  let context = 0.52;
  if (INTRO_PATTERNS.some((pattern) => pattern.test(opening))) context -= 0.3;
  if (CONTEXT_DEPENDENT_START.test(opening.trim())) context -= 0.14;
  if (hasMatch(text, BACKREFERENCE)) context -= 0.26;
  if (!sentences[from].terminal) context += 0.03; // a continuing thought is normal at the start
  if (durationMs >= 12_000) context += 0.13;
  if (durationMs >= 20_000) context += 0.05;
  if (durationMs < 9_000) context -= 0.14;
  if (wordCount < 25) context -= 0.08;
  if (sentenceCount >= 2) context += 0.05;
  context = clampScore(context);
  if (context >= 0.76) evidence.add('stands alone without prior context');

  /* ---- payoff: does it end on a point, not a dangling clause? ---- */
  let payoff = 0.26;
  if (sentences[to].terminal) payoff += 0.2;
  for (const pattern of PAYOFF_PATTERNS) {
    if (pattern.test(closing)) {
      payoff += 0.3;
      evidence.add('narrative payoff');
      break;
    }
  }
  if (RESULT_WORDS.test(closing)) payoff += 0.14;
  if (DANGLING_END.test(closing.trim())) payoff -= 0.28;
  if (!sentences[to].terminal) payoff -= 0.24;
  if (/\.\.\.$/.test(closing.trim())) payoff -= 0.16;
  payoff = clampScore(payoff);
  if (payoff >= 0.62) evidence.add('complete, resolved ending');

  /* ---- pacing: speech density, fillers and internal dead air ---- */
  let pacing = 0.44;
  if (wordsPerSecond >= 2.2 && wordsPerSecond <= 4.4) pacing += 0.28;
  else if (wordsPerSecond < 1.1) pacing -= 0.26;
  else if (wordsPerSecond > 5.2) pacing -= 0.1;
  if (durationMs >= 12_000 && durationMs <= 38_000) pacing += 0.08;

  const internalGaps = input.words
    .filter((word) => word.startMs > startMs && word.endMs < endMs)
    .reduce((longest, word, index, list) => {
      const previous = list[index - 1];
      return previous ? Math.max(longest, word.startMs - previous.endMs) : longest;
    }, 0);
  if (internalGaps > 2_000) pacing -= 0.2;
  else if (internalGaps > 1_200) pacing -= 0.08;
  const fillerCount = words.filter((word) => FILLER_WORDS.has(word)).length;
  const fillerRatio = fillerCount / Math.max(1, wordCount);
  if (fillerRatio > 0.1) pacing -= 0.14;
  pacing = clampScore(pacing);
  if (pacing >= 0.72) evidence.add('natural conversational pacing');

  /* ---- measured signals: audio peaks and visual changes ---- */
  const signals = input.signals;
  if (signals) {
    const peaksInside = signals.peaksMs.filter((peak) => peak >= startMs && peak <= endMs).length;
    if (peaksInside > 0) {
      entertainment = Math.min(1, entertainment + Math.min(0.26, peaksInside * 0.1));
      evidence.add(`${peaksInside} audio peak${peaksInside === 1 ? '' : 's'}`);
    }
    const scenesInside = signals.sceneChangesMs.filter((scene) => scene >= startMs && scene <= endMs).length;
    if (scenesInside >= 1) {
      pacing = Math.min(1, pacing + 0.06);
      evidence.add(`${scenesInside} visual change${scenesInside === 1 ? '' : 's'}`);
    }
    const loudness = mean(
      signals.audio.filter((level) => level.tMs >= startMs && level.tMs <= endMs).map((level) => level.rms),
    );
    if (loudness > -22) entertainment = Math.min(1, entertainment + 0.08);
  }

  const total =
    hook * WEIGHTS.hook +
    entertainment * WEIGHTS.entertainment +
    substance * WEIGHTS.substance +
    context * WEIGHTS.context +
    payoff * WEIGHTS.payoff +
    pacing * WEIGHTS.pacing;

  if (hook >= 0.58) evidence.add('strong opening hook');
  if (context >= 0.76) evidence.add('stands alone without prior context');
  if (payoff >= 0.62) evidence.add('complete, resolved ending');
  if (pacing >= 0.72) evidence.add('natural conversational pacing');
  if (evidence.size === 0) evidence.add('self-contained, coherent speech');

  const breakdown: ClipScoreBreakdown = {
    hook: clampScore(hook),
    entertainment: clampScore(entertainment),
    substance: clampScore(substance),
    context: clampScore(context),
    payoff: clampScore(payoff),
    pacing: clampScore(pacing),
    total: clampScore(total),
  };

  return {
    from,
    to,
    startMs,
    endMs,
    text,
    breakdown,
    evidence: [...evidence].slice(0, 8),
    contentType: content.type,
  };
}

function toSelectedClip(
  candidate: Candidate,
  sentences: Sentence[],
  usedTitles: Set<string>,
  fallback: boolean,
): SelectedClip {
  const title = pickTitle(sentences, candidate.from, candidate.to, usedTitles);
  usedTitles.add(title.toLowerCase());
  const strongest = (Object.entries(candidate.breakdown) as [keyof ClipScoreBreakdown, number][])
    .filter(([key]) => key !== 'total')
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([key]) => key)
    .join(', ');
  const typeLabel = TYPE_LABEL[candidate.contentType];
  const why = candidate.evidence.filter((item) => !/^(strong opening hook|complete, resolved ending|stands alone|natural conversational pacing)$/.test(item));
  const reason = fallback
    ? `Best available coherent moment (${Math.round(candidate.breakdown.total * 100)}/100): ${(why.length > 0 ? why : candidate.evidence).slice(0, 3).join('; ')}.`
    : `${typeLabel} moment. ${(why.length > 0 ? why : candidate.evidence).slice(0, 3).join('; ')}. Strongest on ${strongest}.`;

  return {
    title,
    reason: reason.slice(0, 900),
    hook: truncateAtWord(candidate.text, 90),
    startMs: candidate.startMs,
    endMs: candidate.endMs,
    score: candidate.breakdown.total,
    scoreBreakdown: candidate.breakdown,
    evidence: [...new Set([`${typeLabel.toLowerCase()} moment`, ...candidate.evidence])].slice(0, 6),
  };
}

export function selectHighlightsHeuristically(input: SelectionInput): SelectedClip[] {
  const sentences = buildSentences(input.words, input.segments);
  if (sentences.length === 0) return [];

  const durationMs = input.durationMs;
  const targetCount = Math.max(1, Math.min(10, input.targetCount));
  const maxFeasible = Math.max(1, Math.floor(durationMs / 14_000));
  const limit = Math.min(targetCount, maxFeasible);

  const candidates: Candidate[] = [];
  for (let from = 0; from < sentences.length; from += 1) {
    let wordTotal = 0;
    for (let to = from; to < sentences.length; to += 1) {
      wordTotal += sentences[to].wordCount;
      const candidateDuration = sentences[to].endMs - sentences[from].startMs;
      if (candidateDuration > 42_000 || wordTotal > 120) break;
      if (candidateDuration < 7_000) continue;
      if (!sentences[to].terminal && candidateDuration < 18_000) continue;
      const candidate = scoreCandidateWindow(input, sentences, from, to);
      if (candidate) candidates.push(candidate);
      if (sentences[to].terminal && candidateDuration >= 30_000) break;
    }
  }

  if (candidates.length === 0) {
    const startMs = sentences[0].startMs;
    const endMs = Math.min(durationMs, Math.max(sentences[sentences.length - 1].endMs, startMs + 7_000));
    if (durationMs > 120_000) return [];
    return [
      {
        title: titleCaseFirst(truncateAtWord(stripFillers(sentences[0].text), 72)),
        reason: 'Best available coherent moment: the source has continuous speech but no strong standalone highlight.',
        hook: truncateAtWord(sentences[0].text, 90),
        startMs,
        endMs,
        score: 0.2,
        scoreBreakdown: null,
        evidence: [],
      },
    ];
  }

  candidates.sort((a, b) => b.breakdown.total - a.breakdown.total);
  const bestTotal = candidates[0].breakdown.total;
  const floor = Math.max(MIN_QUALITY, bestTotal * RELATIVE_QUALITY);
  const qualified = candidates.filter((candidate) => candidate.breakdown.total >= floor);

  const usedTitles = new Set<string>();
  const chosen: Candidate[] = [];
  const fits = (candidate: Candidate): boolean =>
    chosen.every((existing) => {
      const intersection =
        Math.min(existing.endMs, candidate.endMs) - Math.max(existing.startMs, candidate.startMs);
      if (intersection > 0.2 * Math.min(existing.endMs - existing.startMs, candidate.endMs - candidate.startMs)) {
        return false;
      }
      const gap =
        candidate.startMs >= existing.endMs
          ? candidate.startMs - existing.endMs
          : existing.startMs - candidate.endMs;
      if (gap < 4_000) return false;
      // Reject only near-identical windows. A 45-minute video can legitimately
      // revisit a theme; exact duplicate content is still stopped.
      return textSimilarity(existing.text, candidate.text) <= 0.93;
    });

  for (const candidate of qualified) {
    if (chosen.length >= limit) break;
    if (fits(candidate)) chosen.push(candidate);
  }

  // A weak long recording is allowed to yield zero clips. A short recording
  // gets one clearly labelled fallback so the user still has something usable;
  // this is never expanded to a fake set of five or ten clips.
  if (chosen.length === 0) {
    const best = candidates[0];
    if (durationMs <= 120_000) {
      return [toSelectedClip(best, sentences, usedTitles, true)];
    }
    return [];
  }

  return chosen
    .sort((a, b) => a.startMs - b.startMs)
    .map((candidate) => toSelectedClip(candidate, sentences, usedTitles, false));
}

export function createHeuristicSelector(): ClipSelector {
  return {
    id: 'heuristic',
    label: 'Multi-signal heuristic (transcript + audio + visuals)',
    async select(input: SelectionInput): Promise<SelectedClip[]> {
      return finalizeSelection(selectHighlightsHeuristically(input), {
        durationMs: input.durationMs,
        targetCount: input.targetCount,
      });
    },
  };
}
