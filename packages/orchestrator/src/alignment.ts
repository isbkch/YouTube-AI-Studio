import { z } from "zod";
import { hash, now, StudioError } from "../../shared/src/index.ts";
import type { Recording, Transcript } from "./model.ts";
import { crossesRetake, discardedRetakes, reviewRetakes } from "./retakes.ts";

/**
 * Script↔recording alignment: which sentence of the approved script is spoken
 * where (seconds) in which imported recording. Pure TypeScript fuzzy matching
 * over transcript word streams — no model calls, fully inspectable.
 */

export interface TimedToken {
  token: string;
  start: number;
  end: number;
  /** A discarded attempt precedes this token; matching cannot bridge it. */
  breakBefore?: boolean;
}

const normalize = (word: string) =>
  word
    .toLowerCase()
    .replace(/[^a-z0-9']+/g, "")
    .replace(/^'+|'+$/g, "");

export function tokenize(text: string): string[] {
  return text
    .split(/\s+/)
    .map(normalize)
    .filter((t) => t.length > 0 || /\d/.test(t));
}

export interface ScriptSentence {
  index: number;
  text: string;
  tokens: string[];
  /** Markdown-style heading (# …) or short standalone line preceding this sentence. */
  heading: string | null;
}

/** Split a script into sentences; heading lines become chapter markers, not sentences. */
export function splitScriptSentences(script: string): ScriptSentence[] {
  const sentences: ScriptSentence[] = [];
  let heading: string | null = null;
  let index = 0;
  const quotedScript = /^\s*>\s*\S/m.test(script);
  let fenced = false;
  let spokenBlock = true;
  const clean = (text: string) =>
    text
      .replace(/\*\*|__/g, "")
      .replace(/(?<!\w)[*_]([^*_]+)[*_](?!\w)/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .trim();
  for (const rawLine of script.split(/\n/)) {
    let line = rawLine.trim();
    if (!line) continue;
    if (/^```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (/^#{1,6}\s+/.test(line)) {
      heading = clean(line.replace(/^#{1,6}\s+/, ""))
        .replace(
          /^\d{1,3}:\d{2}(?::\d{2})?\s*[–—-]\s*\d{1,3}:\d{2}(?::\d{2})?\s*[–—-]\s*/,
          "",
        )
        .slice(0, 120);
      spokenBlock = true;
      continue;
    }
    const marker =
      /^(a-?roll|b-?roll(?:\s*\/\s*screen)?|on\s+screen|screen\s+recording)$/i.exec(
        clean(line),
      );
    if (marker) {
      spokenBlock = /^(a|on)/i.test(marker[1]);
      continue;
    }
    const quote = /^>+\s?(.*)$/.exec(line);
    if (quotedScript && !quote) continue;
    if (!spokenBlock) continue;
    line = clean(quote ? quote[1] : line);
    if (!line || /^[-*_]{3,}$/.test(line)) continue;
    // Short standalone lines without terminal punctuation act as section labels.
    if (
      !quote &&
      line.length <= 60 &&
      !/[.!?]"?$/.test(line) &&
      !/\s{3,}/.test(line)
    ) {
      heading = line.slice(0, 120);
      continue;
    }
    for (const part of line.split(/(?<=[.!?])\s+/)) {
      const text = part.trim();
      if (!text) continue;
      const tokens = tokenize(text);
      if (!tokens.length) continue;
      sentences.push({ index: index++, text, tokens, heading });
      heading = null;
    }
  }
  return sentences;
}

/** Word stream of a recording; falls back to even distribution over segments. */
export function tokenStream(transcript: Transcript): TimedToken[] {
  const out: TimedToken[] = [];
  for (const segment of transcript.segments) {
    const words = segment.words ?? [];
    if (words.length) {
      for (const w of words) {
        const token = normalize(w.text);
        if (token) out.push({ token, start: w.start, end: w.end });
      }
    } else {
      const tokens = tokenize(segment.text);
      if (!tokens.length) continue;
      const span = (segment.end - segment.start) / tokens.length;
      tokens.forEach((token, i) => {
        const start = segment.start + i * span;
        out.push({ token, start, end: start + span });
      });
    }
  }
  return out;
}

export interface SpanMatch {
  recordingId: string;
  start: number;
  end: number;
  score: number;
  segmentIds: string[];
  /** Token count of the transcript segment the span lands in (context size). */
  contextTokens: number;
}

/** Smith-Waterman local alignment of sentence tokens inside a token stream. */
function bestContiguousSpan(
  tokens: string[],
  stream: TimedToken[],
): { start: number; end: number; score: number } | null {
  const n = tokens.length,
    m = stream.length;
  if (!n || !m) return null;
  const match = 2,
    mismatch = -0.8,
    gap = -1.2;
  let prev = new Float64Array(m + 1);
  let cur = new Float64Array(m + 1);
  let best = 0,
    bestI = -1,
    bestEnd = -1;
  const trace: Int32Array[] = [];
  for (let i = 1; i <= n; i++) {
    trace[i] = new Int32Array(m + 1);
    for (let j = 1; j <= m; j++) {
      const diag =
        prev[j - 1] +
        (tokens[i - 1] === stream[j - 1].token ? match : mismatch);
      const up = prev[j] + gap;
      const left = cur[j - 1] + gap;
      let value = diag,
        from = 1;
      if (up > value) {
        value = up;
        from = 2;
      }
      if (left > value) {
        value = left;
        from = 3;
      }
      if (value <= 0) {
        value = 0;
        from = 0;
      }
      cur[j] = value;
      trace[i][j] = from;
      if (value > best) {
        best = value;
        bestI = i;
        bestEnd = j;
      }
    }
    const swap = prev;
    prev = cur;
    cur = swap;
    cur.fill(0);
  }
  if (bestI < 0 || best <= 0) return null;
  // Traceback from the scoring peak; the span covers only positions the
  // sentence actually matched (diagonal moves), never gap-consumed tokens.
  let i = bestI,
    j = bestEnd,
    spanStart = bestEnd,
    spanEnd = bestEnd - 1;
  while (i > 0 && j > 0) {
    const from = trace[i][j];
    if (from === 0) break;
    if (from === 1) {
      i--;
      j--;
      spanStart = Math.min(spanStart, j);
      spanEnd = Math.max(spanEnd, j + 1);
    } else if (from === 2) i--;
    else j--;
  }
  if (spanEnd <= spanStart) return null;
  return { start: spanStart, end: spanEnd - 1, score: best / (2 * n) };
}

function bestSpan(tokens: string[], stream: TimedToken[]) {
  let best: ReturnType<typeof bestContiguousSpan> = null;
  let from = 0;
  for (let end = 1; end <= stream.length; end++) {
    if (end !== stream.length && !stream[end].breakBefore) continue;
    const span = bestContiguousSpan(tokens, stream.slice(from, end));
    if (span && (!best || span.score > best.score))
      best = {
        start: span.start + from,
        end: span.end + from,
        score: span.score,
      };
    from = end;
  }
  return best;
}

/**
 * Identity of the matching algorithm that produced an alignment. Stored
 * alongside the artifact so a library can detect alignments computed by an
 * older algorithm and recompute instead of silently reusing them.
 */
export const ALIGNMENT_ALGORITHM = "smith-waterman-v5-last-retake";

export const alignmentSchema = z.strictObject({
  schemaVersion: z.literal("2.0.0"),
  algorithm: z.string().min(1),
  createdAt: z.iso.datetime(),
  scriptVersion: z.number().int().positive(),
  transcriptHash: z.string().regex(/^[a-f0-9]{64}$/),
  sentences: z.array(
    z.strictObject({
      id: z.string(),
      index: z.number().int().nonnegative(),
      text: z.string(),
      heading: z.string().nullable(),
      match: z
        .strictObject({
          recordingId: z.string(),
          start: z.number().nonnegative(),
          end: z.number().positive(),
          score: z.number().min(0).max(1),
          segmentIds: z.array(z.string()),
        })
        .nullable(),
      alternates: z.array(
        z.strictObject({
          recordingId: z.string(),
          start: z.number().nonnegative(),
          end: z.number().positive(),
          score: z.number().min(0).max(1),
        }),
      ),
    }),
  ),
  stats: z.strictObject({
    sentences: z.number().int().nonnegative(),
    matched: z.number().int().nonnegative(),
    unmatched: z.number().int().nonnegative(),
    averageScore: z.number(),
    perRecording: z.array(
      z.strictObject({
        recordingId: z.string(),
        name: z.string(),
        matchedSentences: z.number().int().nonnegative(),
        keptSeconds: z.number().nonnegative(),
      }),
    ),
  }),
});
export type Alignment = z.infer<typeof alignmentSchema>;

const MATCH_THRESHOLD = 0.42;
// Very short sentences match spuriously; demand more confidence.
const SHORT_THRESHOLD = 0.55;
const CONTINUITY_BONUS = 0.06;
const SHORT_CONTINUITY_BONUS = 0.15;
// Padding makes back-to-back spans overlap slightly; keep strict take order.
const MONOTONIC_TOLERANCE = 0.65;
const HEAD_PAD = 0.14;
const TAIL_PAD = 0.3;

export interface AlignInput {
  script: string;
  scriptVersion: number;
  recordings: Recording[];
  transcripts: Transcript[];
}

export function alignScript(input: AlignInput): Alignment {
  const sentences = splitScriptSentences(input.script);
  if (!sentences.length)
    throw new StudioError(
      "INVALID_INPUT",
      "The script contains no alignable sentences.",
    );
  const latest = new Map<string, Transcript>();
  for (const t of input.transcripts) latest.set(t.recordingId, t);
  const streams = input.recordings.map((r) => {
    const transcript = latest.get(r.id);
    if (!transcript)
      throw new StudioError(
        "CONFLICT",
        `Recording ${r.name} has no transcript; align after transcribing every recording.`,
      );
    const discarded = discardedRetakes(
      reviewRetakes(
        transcript,
        sentences.map((s) => s.text),
      ),
    );
    const stream: TimedToken[] = [];
    let breakBefore = false;
    for (const token of tokenStream(transcript)) {
      if (crossesRetake(token.start, token.end, discarded)) {
        breakBefore = true;
        continue;
      }
      stream.push({ ...token, breakBefore });
      breakBefore = false;
    }
    return { recording: r, transcript, stream, discarded };
  });
  const lastEnd = new Map<string, number>();
  const used: Alignment["sentences"] = sentences.map((s) => ({
    id: `sent-${String(s.index + 1).padStart(3, "0")}`,
    index: s.index,
    text: s.text,
    heading: s.heading,
    match: null,
    alternates: [],
  }));
  let previousRecording: string | null = null;
  for (const sentence of sentences) {
    const short = sentence.tokens.length <= 2;
    const repeatedInScript = sentences.some(
      (s) =>
        s.index < sentence.index &&
        s.tokens.join(" ") === sentence.tokens.join(" "),
    );
    const candidates: SpanMatch[] = [];
    for (const { recording, transcript, stream: all, discarded } of streams) {
      // Intentional script repetitions need a distinct occurrence. Other
      // sentences retain normal best-take ranking and neighbor-bounded rescue.
      const stream =
        short || !repeatedInScript
          ? all
          : all.filter(
              (t) =>
                t.start - HEAD_PAD >=
                (lastEnd.get(recording.id) ?? 0) - MONOTONIC_TOLERANCE,
            );
      const span = bestSpan(sentence.tokens, stream);
      if (!span) continue;
      const from = span.start;
      const to = span.end;
      let start = stream[from].start - HEAD_PAD;
      let end = stream[to].end + TAIL_PAD;
      start = Math.max(0, start);
      end = Math.min(end, recording.duration);
      // Padding must never put an earlier attempt back into the selected cut.
      for (const cut of discarded) {
        if (cut.end <= stream[from].start) start = Math.max(start, cut.end);
        if (cut.start >= stream[to].end) end = Math.min(end, cut.start);
      }
      if (end <= start) continue;
      const overlapping = transcript.segments
        .filter((seg) => seg.start < end && seg.end > start)
        .sort(
          (a, b) =>
            Math.min(b.end, end) -
            Math.max(b.start, start) -
            (Math.min(a.end, end) - Math.max(a.start, start)),
        );
      candidates.push({
        recordingId: recording.id,
        start,
        end,
        score: Math.min(1, span.score),
        segmentIds: overlapping.map((seg) => seg.id),
        contextTokens: overlapping.length
          ? Math.max(1, tokenize(overlapping[0].text).length)
          : sentence.tokens.length,
      });
    }
    const bonus = short ? SHORT_CONTINUITY_BONUS : CONTINUITY_BONUS;
    // Rhetorical beats belong to the current take; the same-take pool only
    // counts when its candidate is actually plausible.
    const sameTake = candidates.filter(
      (c) =>
        c.recordingId === previousRecording &&
        c.score >= (short ? SHORT_THRESHOLD : MATCH_THRESHOLD),
    );
    const pool: SpanMatch[] =
      short && previousRecording && sameTake.length ? sameTake : candidates;
    // A short sentence may switch takes only when the other take recorded it
    // as a complete beat: the segment it lands in is mostly that sentence,
    // not an unrelated mention inside longer speech.
    const completeBeat = (c: SpanMatch) =>
      !short ||
      !previousRecording ||
      c.recordingId === previousRecording ||
      sentence.tokens.length /
        Math.max(sentence.tokens.length, c.contextTokens) >=
        0.6;
    const ranked = [...pool].sort(
      (a, b) =>
        b.score +
        (b.recordingId === previousRecording ? bonus : 0) -
        (a.score + (a.recordingId === previousRecording ? bonus : 0)),
    );
    const row = used[sentence.index];
    row.alternates = ranked
      .slice(0, 3)
      .map(({ recordingId, start, end, score }) => ({
        recordingId,
        start,
        end,
        score,
      }));
    const viable = ranked.find(
      (c) =>
        c.score >= (short ? SHORT_THRESHOLD : MATCH_THRESHOLD) &&
        completeBeat(c) &&
        c.start >= (lastEnd.get(c.recordingId) ?? 0) - MONOTONIC_TOLERANCE,
    );
    if (viable) {
      row.match = {
        recordingId: viable.recordingId,
        start: viable.start,
        end: viable.end,
        score: viable.score,
        segmentIds: viable.segmentIds,
      };
      lastEnd.set(viable.recordingId, viable.end);
      previousRecording = viable.recordingId;
    }
  }
  // Second pass: slot still-unmatched sentences into gaps between the spans
  // already claimed in each recording, keeping per-recording monotonicity.
  const claimed = new Map<string, { start: number; end: number }[]>();
  for (const row of used)
    if (row.match) {
      const list = claimed.get(row.match.recordingId) ?? [];
      list.push({ start: row.match.start, end: row.match.end });
      claimed.set(row.match.recordingId, list);
    }
  for (const row of used) {
    if (row.match) continue;
    const sentence = sentences[row.index];
    const short = sentence.tokens.length <= 2;
    // Rhetorical beats belong to a take already in use around them; a
    // cross-take rescue of a one-word match is almost always spurious.
    let preferredRecording: string | null = null;
    for (let a = row.index - 1; a >= 0 && preferredRecording === null; a--) {
      const m = used[a].match;
      if (m) preferredRecording = m.recordingId;
    }
    if (preferredRecording === null)
      for (
        let b = row.index + 1;
        b < used.length && preferredRecording === null;
        b++
      ) {
        const m = used[b].match;
        if (m) preferredRecording = m.recordingId;
      }
    const fillIns: SpanMatch[] = [];
    for (const { recording, transcript, stream, discarded } of streams) {
      // A rescue belongs between its script neighbors in this recording.
      // Searching the entire take again can select an earlier repeated beat
      // ("Okay.", "Why?") and move backwards through footage already used.
      const before = used
        .slice(0, row.index)
        .findLast((s) => s.match?.recordingId === recording.id)?.match;
      const after = used
        .slice(row.index + 1)
        .find((s) => s.match?.recordingId === recording.id)?.match;
      const lower = before?.end ?? 0;
      const upper = after?.start ?? recording.duration;
      const available = stream.filter(
        (t) =>
          t.start - HEAD_PAD >= lower - MONOTONIC_TOLERANCE &&
          t.end + TAIL_PAD <= upper + MONOTONIC_TOLERANCE,
      );
      const span = bestSpan(sentence.tokens, available);
      if (!span) continue;
      let start = Math.max(0, available[span.start].start - HEAD_PAD);
      let end = Math.min(
        recording.duration,
        available[span.end].end + TAIL_PAD,
      );
      for (const cut of discarded) {
        if (cut.end <= available[span.start].start)
          start = Math.max(start, cut.end);
        if (cut.start >= available[span.end].end)
          end = Math.min(end, cut.start);
      }
      if (end <= start) continue;
      const overlaps = (claimed.get(recording.id) ?? []).some(
        (c) => start < c.end - 0.4 && end > c.start + 0.4,
      );
      if (overlaps) continue;
      const overlapping = transcript.segments
        .filter((seg) => seg.start < end && seg.end > start)
        .sort(
          (a, b) =>
            Math.min(b.end, end) -
            Math.max(b.start, start) -
            (Math.min(a.end, end) - Math.max(a.start, start)),
        );
      fillIns.push({
        recordingId: recording.id,
        start,
        end,
        score: Math.min(1, span.score),
        segmentIds: overlapping.map((seg) => seg.id),
        contextTokens: overlapping.length
          ? Math.max(1, tokenize(overlapping[0].text).length)
          : sentence.tokens.length,
      });
    }
    fillIns.sort((a, b) => b.score - a.score);
    // Rhetorical beats belong to a take already in use around them; another
    // take may supply one only as a complete beat, not an unrelated mention.
    const rescue = fillIns.find(
      (c) =>
        (!short ||
          (preferredRecording !== null &&
            c.recordingId === preferredRecording) ||
          sentence.tokens.length /
            Math.max(sentence.tokens.length, c.contextTokens) >=
            0.6) &&
        c.score >=
          (sentence.tokens.length <= 2 ? SHORT_THRESHOLD : MATCH_THRESHOLD),
    );
    if (rescue) {
      row.match = {
        recordingId: rescue.recordingId,
        start: rescue.start,
        end: rescue.end,
        score: rescue.score,
        segmentIds: rescue.segmentIds,
      };
      row.alternates = [
        ...fillIns.slice(0, 3).map(({ recordingId, start, end, score }) => ({
          recordingId,
          start,
          end,
          score,
        })),
        ...row.alternates,
      ].slice(0, 3);
      const list = claimed.get(rescue.recordingId) ?? [];
      list.push({ start: rescue.start, end: rescue.end });
      claimed.set(rescue.recordingId, list);
    }
  }
  // Head/tail padding makes dense back-to-back spans overlap; adjacent spans
  // in the same recording meet at their midpoint instead of stacking pads.
  const byRecording = new Map<string, typeof used>();
  for (const row of used)
    if (row.match) {
      const list = byRecording.get(row.match.recordingId) ?? [];
      list.push(row);
      byRecording.set(row.match.recordingId, list);
    }
  for (const rows of byRecording.values()) {
    rows.sort((a, b) => a.match!.start - b.match!.start);
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1].match!;
      const b = rows[i].match!;
      if (b.start < a.end) {
        const mid = (a.end + b.start) / 2;
        a.end = Math.max(a.start + 0.05, mid);
        b.start = Math.min(b.end - 0.05, mid);
      }
    }
  }
  const matchedRows = used.filter((s) => s.match);
  const perRecording = streams.map(({ recording }) => {
    const rows = matchedRows.filter(
      (s) => s.match!.recordingId === recording.id,
    );
    return {
      recordingId: recording.id,
      name: recording.name,
      matchedSentences: rows.length,
      keptSeconds: rows.reduce(
        (sec, s) => sec + (s.match!.end - s.match!.start),
        0,
      ),
    };
  });
  return alignmentSchema.parse({
    schemaVersion: "2.0.0",
    algorithm: ALIGNMENT_ALGORITHM,
    createdAt: now(),
    scriptVersion: input.scriptVersion,
    transcriptHash: hash(input.transcripts),
    sentences: used,
    stats: {
      sentences: used.length,
      matched: matchedRows.length,
      unmatched: used.length - matchedRows.length,
      averageScore: matchedRows.length
        ? matchedRows.reduce((sum, s) => sum + s.match!.score, 0) /
          matchedRows.length
        : 0,
      perRecording,
    },
  });
}
