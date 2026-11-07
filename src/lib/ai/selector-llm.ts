import { z } from 'zod';
import type { ClipScoreBreakdown, ClipScoreDimension, SelectedClip } from '../types';
import type { ClipSelector, SelectionInput } from './types';
import { ProviderError } from './types';
import { buildSentences, finalizeSelection, type Sentence } from './select-utils';
import {
  MIN_QUALITY,
  RELATIVE_QUALITY,
  SCORE_WEIGHTS,
  scoreCandidateWindow,
  textSimilarity,
} from './heuristic';

/**
 * LLM highlight selection through any OpenAI-compatible chat completions
 * endpoint. The model only chooses *which* segment range to clip and how to
 * title it; clip boundaries and durations are validated locally before any
 * rendering happens.
 */

const MAX_TRANSCRIPT_CHARS = 22_000;
const MAX_SEGMENTS = 260;

const responseSchema = z.object({
  clips: z
    .array(
      z.object({
        startSegment: z.number().int().nonnegative(),
        endSegment: z.number().int().nonnegative(),
        title: z.string().min(1).max(140),
        hook: z.string().max(240).optional(),
        reason: z.string().max(400).optional(),
        // Kept permissive and normalised locally; an out-of-range score must not
        // discard an otherwise usable clip.
        scores: z.unknown().optional(),
      }),
    )
    .min(1),
});

const SYSTEM_PROMPT = `You are a short-form video editor selecting moments from a full recording. Read the whole transcript supplied before choosing, not just the opening.

Choose the strongest self-contained moments, strongest first. Aim for the requested count, but return fewer rather than pad with weak or repetitive moments.

Prioritise:
1. a real hook in the first 1-3 seconds that works with no setup
2. funny, surprising, emotional, dramatic or genuinely interesting beats
3. concrete information, useful advice or a clear story
4. moments with enough context to stand alone and a clear payoff

Reject:
- greetings, housekeeping, "in this video" setup and slow introductions
- starts that depend on earlier context ("and then", "that thing", "like I said")
- filler, long pauses, repeated points and clips with no payoff
- overlapping clips or the same moment presented twice

Rules:
- Each clip must be 15-45 seconds.
- Start on a complete thought and end on a complete, resolved thought.
- Do not choose a clip just because it is long or because it fills a slot.
- Titles: 3-9 words, specific, no clickbait hashtags, no quotes, no trailing period.
- "hook" is the strongest phrase in the clip's first 1-3 seconds (max ~15 words).
- "reason" explains in one short sentence why the moment works.
- Give each clip its own scores from 0 to 1 for hook, engagement, clarity, substance, context, payoff and pacing. Use the evidence in the transcript; do not give every clip the same score. Clarity means easy to follow with clean boundaries and little filler. Context means understandable without earlier footage. Payoff means a complete, satisfying end.
- Do not claim or imply that a clip is guaranteed to go viral.

Respond with JSON only: {"clips":[{"startSegment":<int>,"endSegment":<int>,"title":"...","hook":"...","reason":"...","scores":{"hook":0.0,"engagement":0.0,"clarity":0.0,"substance":0.0,"context":0.0,"payoff":0.0,"pacing":0.0}}]}
startSegment/endSegment are the # indexes shown in the transcript.`;

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function buildTranscriptPrompt(input: SelectionInput): string {
  const segments = input.segments.length > 0
    ? input.segments
    : buildSentences(input.words, []).map((sentence) => ({
        text: sentence.text,
        startMs: sentence.startMs,
        endMs: sentence.endMs,
      }));

  const lineAt = (index: number): string => {
    const segment = segments[index];
    return `#${index} [${formatTimestamp(segment.startMs)}-${formatTimestamp(segment.endMs)}] ${segment.text.trim()}`;
  };
  const fullLines = segments.map((_, index) => lineAt(index));
  const fullChars = fullLines.reduce((sum, line) => sum + line.length + 1, 0);
  let lines = fullLines;
  let sampled = false;

  // A long recording must not be silently cut off at its first few minutes. If
  // it does not fit the model budget, sample evenly across the whole timeline,
  // including the first and last segments, and say so in the prompt.
  if (segments.length > MAX_SEGMENTS || fullChars > MAX_TRANSCRIPT_CHARS) {
    sampled = true;
    let count = Math.min(MAX_SEGMENTS, segments.length);
    for (let attempt = 0; attempt < 12 && count > 0; attempt += 1) {
      const indices = new Set<number>();
      for (let index = 0; index < count; index += 1) {
        const sourceIndex = count === 1
          ? 0
          : Math.round((index * (segments.length - 1)) / (count - 1));
        indices.add(sourceIndex);
      }
      lines = [...indices].sort((a, b) => a - b).map((index) => fullLines[index]);
      const chars = lines.reduce((sum, line) => sum + line.length + 1, 0);
      if (chars <= MAX_TRANSCRIPT_CHARS) break;
      count = Math.max(1, Math.floor(count * 0.8));
    }
  }

  const target = Math.max(1, Math.min(10, input.targetCount));
  const samplingNote = sampled ? ' Transcript sampled evenly across the full recording.' : '';
  return `Total duration: ${formatTimestamp(input.durationMs)}. Requested: up to ${target} clips, strongest first.${samplingNote}\nTranscript:\n${lines.join('\n')}`;
}

const SCORE_DIMENSIONS: ClipScoreDimension[] = [
  'hook',
  'engagement',
  'clarity',
  'substance',
  'context',
  'payoff',
  'pacing',
];

function normaliseModelScores(value: unknown): ClipScoreBreakdown | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const scores = {} as Record<ClipScoreDimension, number>;
  let present = 0;
  for (const dimension of SCORE_DIMENSIONS) {
    const numeric = Number(raw[dimension]);
    if (!Number.isFinite(numeric)) continue;
    // Accept either 0-1 or a percentage from providers that ignore the prompt.
    const normalised = numeric > 1 ? numeric / 100 : numeric;
    scores[dimension] = Math.max(0, Math.min(1, normalised));
    present += 1;
  }
  if (present < 5) return null;
  for (const dimension of SCORE_DIMENSIONS) {
    if (!Number.isFinite(scores[dimension])) scores[dimension] = 0.5;
  }
  const total = SCORE_DIMENSIONS.reduce(
    (sum, dimension) => sum + scores[dimension] * SCORE_WEIGHTS[dimension],
    0,
  );
  return {
    ...scores,
    total: Math.round(Math.max(0, Math.min(1, total)) * 100) / 100,
  };
}

function localSentenceRange(
  sentences: Sentence[],
  startMs: number,
  endMs: number,
): { from: number; to: number } | null {
  if (sentences.length === 0) return null;
  let from = sentences.findIndex((sentence) => sentence.endMs > startMs + 80);
  if (from < 0) from = sentences.length - 1;
  let to = from;
  while (to + 1 < sentences.length && sentences[to + 1].startMs < endMs - 80) to += 1;
  while (to > from && sentences[to].endMs - sentences[from].startMs > 45_000) to -= 1;
  return { from, to };
}

export interface LlmSelectorOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export function createLlmSelector(options: LlmSelectorOptions): ClipSelector {
  const { apiKey, baseUrl, model } = options;

  async function callModel(prompt: string, jsonMode: boolean): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: prompt },
          ],
          ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        if (response.status === 400 && jsonMode && /response_format/i.test(body)) {
          return callModel(prompt, false);
        }
        throw new ProviderError(
          'selection_failed',
          `Highlight model returned HTTP ${response.status}: ${body.replace(/\s+/g, ' ').slice(0, 300)}`,
          { retryable: response.status === 429 || response.status >= 500, status: response.status },
        );
      }

      const payload = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const content = payload.choices?.[0]?.message?.content;
      if (!content) {
        throw new ProviderError('selection_empty', 'Highlight model returned an empty response.');
      }
      return content;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      const aborted = error instanceof Error && error.name === 'AbortError';
      throw new ProviderError(
        'selection_network',
        aborted
          ? 'The highlight model request timed out.'
          : 'Could not reach the highlight model. Check LLM_BASE_URL and the server network.',
        { retryable: true },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    id: 'llm',
    label: `${model} (${new URL(baseUrl).host})`,
    async select(input: SelectionInput): Promise<SelectedClip[]> {
      const prompt = buildTranscriptPrompt(input);
      const content = await callModel(prompt, true);

      let parsedJson: unknown;
      try {
        const jsonText = content.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
        parsedJson = JSON.parse(jsonText);
      } catch {
        throw new ProviderError('selection_invalid_json', 'The highlight model did not return valid JSON.');
      }

      const result = responseSchema.safeParse(parsedJson);
      if (!result.success) {
        throw new ProviderError(
          'selection_schema',
          'The highlight model returned clips in an unexpected shape.',
        );
      }

      const sentences = buildSentences(input.words, input.segments);
      const usedSegments = input.segments.length > 0
        ? input.segments
        : sentences.map((sentence) => ({
            text: sentence.text,
            startMs: sentence.startMs,
            endMs: sentence.endMs,
          }));

      const scored: { clip: SelectedClip; text: string }[] = [];
      for (const entry of result.data.clips) {
        const from = Math.min(entry.startSegment, usedSegments.length - 1);
        const to = Math.min(Math.max(entry.endSegment, from), usedSegments.length - 1);
        const first = usedSegments[from];
        const last = usedSegments[to];
        if (!first || !last) continue;

        // Re-score the model's choice against the same local evidence the
        // heuristic uses. A model ranking is useful, but every clip needs its
        // own explainable score rather than a shared constant.
        const range = localSentenceRange(sentences, first.startMs, last.endMs);
        const local = range
          ? scoreCandidateWindow(input, sentences, range.from, range.to)
          : null;
        const breakdown = local?.breakdown ?? normaliseModelScores(entry.scores);
        if (!breakdown) continue;

        const title = entry.title.replace(/^["'“”]|["'“”]$/g, '').replace(/\.$/, '').trim();
        const hook = entry.hook?.trim() || first.text.slice(0, 90);
        const text = local?.text ?? `${title} ${hook}`;
        if (scored.some((existing) => textSimilarity(existing.text, text) >= 0.86)) continue;

        scored.push({
          clip: {
            title,
            reason: entry.reason?.trim() || 'Chosen by the highlight model.',
            hook,
            startMs: first.startMs,
            endMs: last.endMs,
            score: breakdown.total,
            scoreBreakdown: breakdown,
            evidence: local?.evidence ?? ['model-selected moment'],
          },
          text,
        });
      }

      if (scored.length === 0) {
        throw new ProviderError(
          'selection_weak',
          'The highlight model did not return any clip that survives local quality checks.',
        );
      }

      scored.sort((a, b) => b.clip.score - a.clip.score);
      const floor = Math.max(MIN_QUALITY, scored[0].clip.score * RELATIVE_QUALITY);
      const qualified = scored.filter((entry) => entry.clip.score >= floor);
      if (qualified.length === 0) {
        throw new ProviderError(
          'selection_weak',
          'The highlight model returned only weak or repetitive moments; local selection will take over.',
        );
      }

      return finalizeSelection(
        qualified.map((entry) => entry.clip),
        {
          durationMs: input.durationMs,
          targetCount: input.targetCount,
          minDurationMs: 8_000,
        },
      );
    },
  };
}
