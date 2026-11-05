import { z } from 'zod';
import type { SelectedClip } from '../types';
import type { ClipSelector, SelectionInput } from './types';
import { ProviderError } from './types';
import { buildSentences, finalizeSelection } from './select-utils';

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
      }),
    )
    .min(1),
});

const SYSTEM_PROMPT = `You are a short-form video editor. Given a timestamped transcript, choose the 5-10 best moments for vertical clips.

Prioritise, in order:
1. funny or surprising moments
2. strong opening hooks (first 1-2 sentences grab attention alone)
3. useful, concrete information or advice
4. interesting conversation exchanges
5. self-contained stories with a payoff

Rules:
- Each clip must be 15-45 seconds and stand alone without prior context.
- Never overlap clips.
- Prefer moments that start on a new idea and end on a complete thought.
- Titles: 3-9 words, specific, no clickbait hashtags, no quotes, no trailing period.
- "hook" is the strongest opening phrase from the transcript (max ~15 words).
- "reason" explains in one short sentence why it works.

Respond with JSON only: {"clips":[{"startSegment":<int>,"endSegment":<int>,"title":"...","hook":"...","reason":"..."}]}
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

  const lines: string[] = [];
  let chars = 0;
  for (let index = 0; index < Math.min(segments.length, MAX_SEGMENTS); index += 1) {
    const segment = segments[index];
    const line = `#${index} [${formatTimestamp(segment.startMs)}-${formatTimestamp(segment.endMs)}] ${segment.text.trim()}`;
    if (chars + line.length > MAX_TRANSCRIPT_CHARS) break;
    chars += line.length + 1;
    lines.push(line);
  }

  return `Total duration: ${formatTimestamp(input.durationMs)}.\nTranscript:\n${lines.join('\n')}`;
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

      const usedSegments = input.segments.length > 0
        ? input.segments
        : buildSentences(input.words, []).map((sentence) => ({
            text: sentence.text,
            startMs: sentence.startMs,
            endMs: sentence.endMs,
          }));

      const clips: SelectedClip[] = [];
      for (const entry of result.data.clips) {
        const from = Math.min(entry.startSegment, usedSegments.length - 1);
        const to = Math.min(Math.max(entry.endSegment, from), usedSegments.length - 1);
        const first = usedSegments[from];
        const last = usedSegments[to];
        if (!first || !last) continue;
        clips.push({
          title: entry.title.replace(/^["'“”]|["'“”]$/g, '').replace(/\.$/, '').trim(),
          reason: entry.reason?.trim() || 'Chosen by the highlight model.',
          hook: entry.hook?.trim() || first.text.slice(0, 90),
          startMs: first.startMs,
          endMs: last.endMs,
          score: 0.9,
        });
      }

      return finalizeSelection(clips, {
        durationMs: input.durationMs,
        targetCount: input.targetCount,
        minDurationMs: 8_000,
      });
    },
  };
}
