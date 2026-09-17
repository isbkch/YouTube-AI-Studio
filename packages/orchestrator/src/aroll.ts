import { z } from "zod";
import {
  now,
  StudioError,
  type SilenceTightening,
  type VisualDensity,
} from "../../shared/src/index.ts";
import { tokenize, type Alignment } from "./alignment.ts";
import type { TemplateName } from "../../production-plan/src/index.ts";

/**
 * Deterministic A-roll editor: turns an alignment into structured edit
 * decisions — which take of each sentence to keep, where scene boundaries go,
 * where dead space drops out, and where punch-ins land. No model calls; every
 * decision is inspectable and reversible through the normal plan flow.
 */

export interface EditScene {
  id: string;
  recordingId: string;
  start: number;
  end: number;
  sentences: number[];
  narration: string;
  segmentIds: string[];
  heading: string | null;
  punchIn: number;
  framing: "wide" | "medium" | "close";
  /** How this scene's source was selected, carried through to plan review. */
  selection: {
    score: number;
    bridged: boolean;
    alternates: {
      recordingId: string;
      start: number;
      end: number;
      score: number;
    }[];
  };
  suggestedGraphic: {
    template: TemplateName;
    parameters: Record<string, unknown>;
    reason: string;
  } | null;
}

/** Transcripts used to prove bridged sentences are actually spoken. */
export interface BridgeTranscript {
  recordingId: string;
  segments: {
    start: number;
    end: number;
    text: string;
    /** Word timings when the provider supplied them; drive silence tightening. */
    words?: { start: number; end: number; text: string }[];
  }[];
}

const selectionShape = z.strictObject({
  score: z.number().min(0).max(1),
  bridged: z.boolean(),
  alternates: z
    .array(
      z.strictObject({
        recordingId: z.string(),
        start: z.number().nonnegative(),
        end: z.number().positive(),
        score: z.number().min(0).max(1),
      }),
    )
    .max(6),
});

export const editDecisionSchema = z.strictObject({
  schemaVersion: z.literal("1.2.0"),
  createdAt: z.iso.datetime(),
  scenes: z.array(
    z.strictObject({
      id: z.string(),
      recordingId: z.string(),
      start: z.number().nonnegative(),
      end: z.number().positive(),
      sentences: z.array(z.number().int().nonnegative()),
      narration: z.string(),
      segmentIds: z.array(z.string()),
      heading: z.string().nullable(),
      punchIn: z.number().min(1).max(1.35),
      framing: z.enum(["wide", "medium", "close"]),
      selection: selectionShape,
      suggestedGraphic: z
        .strictObject({
          template: z.string(),
          parameters: z.record(z.string(), z.unknown()),
          reason: z.string(),
        })
        .nullable(),
    }),
  ),
  dropped: z.array(
    z.strictObject({
      index: z.number().int().nonnegative(),
      text: z.string(),
      reason: z.string(),
    }),
  ),
  stats: z.strictObject({
    keptSeconds: z.number().nonnegative(),
    groups: z.number().int().nonnegative(),
    droppedSentences: z.number().int().nonnegative(),
    recordingsUsed: z.array(z.string()),
    suggestedGraphics: z.number().int().nonnegative(),
    tightening: z.strictObject({
      level: z.enum(["natural", "tight", "punchy"]),
      gapsCut: z.number().int().nonnegative(),
      secondsRemoved: z.number().nonnegative(),
      skippedRecordings: z.array(z.string()),
    }),
  }),
});
export type EditDecision = z.infer<typeof editDecisionSchema>;

const GROUP_GAP = 2.4; // seconds of dead space that still keeps one scene
const MIN_SCENE = 1.6; // shorter runs merge forward into the next scene
const EMPHASIS_PUNCH = 1.1;
// A bridged sentence must mostly be present in the audio it is bridged over.
const BRIDGE_TOKEN_RATIO = 0.5;
// Scene edges may cut into alignment padding, never into claimed speech.
const SPAN_TOLERANCE = 0.2;
// Silence tightening (see buildEditDecision): interior word gaps wider than
// splitGap cut the scene there, and edges trim to headPad/tailPad around the
// spoken words. Match spans carry 0.14/0.3 s alignment pads and the coverage
// check tolerates eating SPAN_TOLERANCE (0.2 s) into a claim, so headPad may
// trim at most 0.14 s and tailPad must stay >= 0.1 s — tightened edges can
// consume padding but never claimed speech.
const TIGHTENING_LEVELS = {
  tight: { splitGap: 1.0, headPad: 0.1, tailPad: 0.2 },
  punchy: { splitGap: 0.6, headPad: 0.07, tailPad: 0.12 },
} as const;
// A tightening split must leave reviewable scenes on both sides (24 frames
// at 30 fps, the same edge margin the range-revision splitter enforces).
const MIN_TIGHT_HALF = 0.8;

function numbersIn(text: string): number[] {
  return [...text.matchAll(/\b(\d+(?:\.\d+)?)\b/g)]
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n));
}

function tokensPresent(sentence: string, spoken: string): number {
  const want = tokenize(sentence);
  if (!want.length) return 0;
  const pool = new Map<string, number>();
  for (const token of tokenize(spoken))
    pool.set(token, (pool.get(token) ?? 0) + 1);
  let found = 0;
  for (const token of want) {
    const count = pool.get(token) ?? 0;
    if (count > 0) {
      found++;
      pool.set(token, count - 1);
    }
  }
  return found / want.length;
}

/**
 * Deterministic graphic suggestions from narration content. These are drafts:
 * the Director (model or human) refines titles and content before approval.
 * Every audience-facing value is grounded in the narration itself — quoted
 * text, quoted commands, or numbers actually spoken — never invented.
 */
export function suggestGraphic(
  narration: string,
  heading: string | null,
): EditScene["suggestedGraphic"] {
  const text = narration.toLowerCase();
  const numbers = numbersIn(narration);
  if (/"([^"]{8,180})"/.test(narration))
    return {
      template: "Quote",
      parameters: {
        quote: narration.match(/"([^"]{8,180})"/)![1],
        attribution: "as spoken",
      },
      reason: "Verbatim quotation being read aloud.",
    };
  const databaseIsh = /\b(database|postgres|sql|queue|cache|shared)\b/.test(
    text,
  );
  const failureIsh =
    /\b(single point|fails?|failure|down|outage|broke|cascade|crash)\b/.test(
      text,
    );
  if (databaseIsh && failureIsh)
    return {
      template: "ArchitectureDiagram",
      parameters: {
        title: heading || "One shared dependency",
        subtitle: "Redundant front ends, one failure domain.",
        layers: [
          { name: "Clients", components: ["Web", "Mobile"] },
          { name: "App tier", components: ["App A", "App B"] },
          { name: "Data", components: ["Database"] },
        ],
        failedLayer: 2,
      },
      reason: "Layered architecture with a narrated failing shared layer.",
    };
  if (
    /\b(outage|down|crash|cascade|fails?|failure|broke|incident)\b/.test(text)
  )
    return {
      template: "FailureAnimation",
      parameters: {
        title: heading || "Cascade",
        subtitle: "Failure propagates through the path.",
        nodes: ["Users", "Gateway", "App", "Database"],
        failedNode: 3,
        recovered: /\brecover|heal|restor|back\b/.test(text),
      },
      reason: "Failure or cascade narrative across services.",
    };
  // Only illustrate a request the narration actually names.
  const call =
    /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[A-Za-z0-9][A-Za-z0-9:_\-./]*)/i.exec(
      narration,
    );
  if (call)
    return {
      template: "RequestFlow",
      parameters: {
        title: heading || "One request",
        subtitle: "The call the narration describes.",
        method: call[1].toUpperCase(),
        path: call[2].slice(0, 60),
        steps: ["Client", "Gateway", "Service", "Database"],
        failureStep: -1,
      },
      reason: "A concrete request named in the narration.",
    };
  if (
    /\b(latency|milliseconds| p99|uptime|downtime|throughput|per second|rps|qps)\b/.test(
      text,
    ) &&
    numbers.length >= 3
  )
    return {
      template: "MetricChart",
      parameters: {
        title: heading || "The number that matters",
        subtitle: "Values read from the narration.",
        unit: /\bms\b|millisecond/.test(text) ? "ms" : "%",
        series: numbers.slice(0, 24),
        threshold: null,
        goodDirection: /\blatency|downtime|error\b/.test(text) ? "down" : "up",
        basis: "narration",
      },
      reason: "Quantities spoken in the narration, charted as spoken.",
    };
  // Only show a terminal for a command the narration actually quotes.
  const command =
    /`([^`]{2,80})`|"((?:npm|npx|node|pnpm|bun|curl|docker|git|python|pip|make)\b[^"]{0,70})"/.exec(
      narration,
    );
  if (command)
    return {
      template: "Terminal",
      parameters: {
        title: heading || "Run it",
        lines: [
          { kind: "input", text: (command[1] ?? command[2]).slice(0, 100) },
          { kind: "output", text: "" },
        ],
      },
      reason: "Command quoted in the narration.",
    };
  return null;
}

/**
 * Quantize edit-scene seconds to plan frames per recording in source order:
 * ranges stay disjoint and inside the deterministic proxy frame count
 * (floor(duration × fps)), so plan validation, conformed media, and Resolve
 * all agree on the same frames.
 */
export function quantizeEditFrames(
  scenes: { id: string; recordingId: string; start: number; end: number }[],
  recordings: { id: string; duration: number }[],
  fps: number,
): Map<string, { sourceInFrame: number; durationFrames: number }> {
  const quantized = new Map<
    string,
    { sourceInFrame: number; durationFrames: number }
  >();
  for (const recording of recordings) {
    const maxFrames = Math.floor(recording.duration * fps);
    const takes = scenes
      .filter((s) => s.recordingId === recording.id)
      .sort((a, b) => a.start - b.start);
    let prevEnd = -1;
    for (const s of takes) {
      let sourceInFrame = Math.round(s.start * fps);
      let durationFrames = Math.max(12, Math.round((s.end - s.start) * fps));
      if (sourceInFrame <= prevEnd)
        sourceInFrame = Math.min(prevEnd + 1, Math.max(0, maxFrames - 12));
      if (sourceInFrame + durationFrames > maxFrames)
        durationFrames = Math.max(
          12,
          Math.min(durationFrames, maxFrames - sourceInFrame),
        );
      if (sourceInFrame + durationFrames > maxFrames) {
        sourceInFrame = Math.max(0, maxFrames - 12);
        durationFrames = Math.min(12, maxFrames - sourceInFrame);
      }
      prevEnd = sourceInFrame + durationFrames;
      quantized.set(s.id, { sourceInFrame, durationFrames });
    }
  }
  return quantized;
}

export function buildEditDecision(
  alignment: Alignment,
  transcripts: BridgeTranscript[] = [],
  density: VisualDensity = "balanced",
  tightening: SilenceTightening = "natural",
): EditDecision {
  const latest = new Map<string, BridgeTranscript>();
  for (const t of transcripts) latest.set(t.recordingId, t);
  const spokenIn = (recordingId: string, start: number, end: number) => {
    const t = latest.get(recordingId);
    if (!t) return "";
    return t.segments
      .filter((s) => s.start < end && s.end > start)
      .map((s) => s.text)
      .join(" ");
  };
  // Unmatched sentences sandwiched between two matches from the same take are
  // often spoken in the audio between them (with a false start or phrasing the
  // aligner scored low). Bridge that audio only when the transcript proves the
  // sentence is really there; otherwise record an explicit omission.
  const BRIDGE_MAX = 15;
  const rows = alignment.sentences.map((s) => ({ ...s, match: s.match }));
  const bridgedIndices = new Set<number>();
  const dropReason = new Map<number, string>();
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].match) continue;
    let a = i - 1;
    while (a >= 0 && !rows[a].match) a--;
    let b = i + 1;
    while (b < rows.length && !rows[b].match) b++;
    const before = a >= 0 ? rows[a].match! : null;
    const after = b < rows.length ? rows[b].match! : null;
    if (
      before &&
      after &&
      before.recordingId === after.recordingId &&
      after.start >= before.end &&
      after.start - before.end <= BRIDGE_MAX
    ) {
      const start = Math.max(0, before.end - 0.1);
      const end = after.start + 0.1;
      const present = tokensPresent(
        rows[i].text,
        spokenIn(before.recordingId, start, end),
      );
      if (present >= BRIDGE_TOKEN_RATIO) {
        rows[i].match = {
          recordingId: before.recordingId,
          start,
          end,
          score: 0,
          segmentIds: [],
        };
        bridgedIndices.add(rows[i].index);
      } else
        dropReason.set(
          rows[i].index,
          "The audio between the adjacent matches does not contain this sentence (rephrased or not spoken there).",
        );
    }
  }
  const matched = rows.filter((s) => s.match);
  // Group consecutive sentences: same recording and gap below threshold.
  const groups: {
    recordingId: string;
    start: number;
    end: number;
    sentences: typeof matched;
  }[] = [];
  for (const sentence of matched) {
    const m = sentence.match!;
    const last = groups.at(-1);
    if (
      last &&
      sentence.heading === null &&
      last.recordingId === m.recordingId &&
      m.start - last.end <= GROUP_GAP &&
      m.start >= last.end - 0.05
    ) {
      last.end = Math.max(last.end, m.end);
      last.sentences.push(sentence);
    } else {
      groups.push({
        recordingId: m.recordingId,
        start: m.start,
        end: m.end,
        sentences: [sentence],
      });
    }
  }
  // Split unwieldy groups at their widest sentence gap: one continuous take
  // still becomes reviewable scenes, cut where the presenter paused.
  const MAX_SCENE = 20;
  const split: typeof groups = [];
  const queue = [...groups];
  while (queue.length) {
    const g = queue.shift()!;
    if (g.end - g.start <= MAX_SCENE || g.sentences.length < 2) {
      split.push(g);
      continue;
    }
    const mid = (g.start + g.end) / 2;
    let bestGap = 0,
      bestAt = -1;
    for (let i = 1; i < g.sentences.length; i++) {
      const boundary = g.sentences[i].match!.start;
      const gap = boundary - g.sentences[i - 1].match!.end;
      if (gap > bestGap) {
        bestGap = gap;
        bestAt = i;
      }
      // Without a real pause, sentence boundaries are still safe cut points.
      if (bestGap === 0 && Math.abs(boundary - mid) < 2)
        bestAt = bestAt < 0 || Math.abs(boundary - mid) <= 2 ? i : bestAt;
    }
    if (bestAt <= 0) {
      split.push(g);
      continue;
    }
    const first = {
      recordingId: g.recordingId,
      start: g.start,
      end: g.sentences[bestAt - 1].match!.end,
      sentences: g.sentences.slice(0, bestAt),
    };
    const rest = {
      recordingId: g.recordingId,
      start: g.sentences[bestAt].match!.start,
      end: g.end,
      sentences: g.sentences.slice(bestAt),
    };
    queue.unshift(rest);
    queue.unshift(first);
  }
  // Merge short runs into the preceding group only when the source continues
  // forwards. A short earlier take must never stretch that group backwards.
  const merged: typeof groups = [];
  for (const g of split) {
    const prev = merged.at(-1);
    if (
      prev &&
      !g.sentences.some((s) => s.heading !== null) &&
      prev.recordingId === g.recordingId &&
      g.end - g.start < MIN_SCENE &&
      g.start >= prev.end - 0.05 &&
      g.start - prev.end <= GROUP_GAP * 1.5
    ) {
      prev.end = Math.max(prev.end, g.end);
      prev.sentences.push(...g.sentences);
    } else merged.push(g);
  }
  // A scene must cover every sentence it claims, whichever way grouping and
  // splitting moved its edges.
  for (const g of merged) {
    g.start = Math.min(g.start, ...g.sentences.map((s) => s.match!.start));
    g.end = Math.max(g.end, ...g.sentences.map((s) => s.match!.end));
  }
  // Silence tightening: with word timings from the transcripts, cut scenes at
  // interior word gaps and trim edges to the spoken words. Recordings without
  // word timings keep their aligned edges — synthetic even-distribution times
  // must never become cut points. "natural" is the identity transform.
  let gapsCut = 0;
  let secondsRemoved = 0;
  const skippedTightening = new Set<string>();
  let result: typeof merged = merged;
  if (tightening !== "natural") {
    const level = TIGHTENING_LEVELS[tightening];
    const wordTimeline = new Map<string, { start: number; end: number }[]>();
    for (const t of latest.values())
      wordTimeline.set(
        t.recordingId,
        t.segments.flatMap((s) => s.words ?? []),
      );
    const wordBounds = (recordingId: string, start: number, end: number) => {
      const words = wordTimeline.get(recordingId) ?? [];
      let first: number | null = null;
      let last: number | null = null;
      for (const w of words) {
        if (w.end < start || w.start > end) continue;
        if (first === null || w.start < first) first = w.start;
        if (last === null || w.end > last) last = w.end;
      }
      return first !== null && last !== null ? { first, last } : null;
    };
    result = [];
    for (const g of merged) {
      const bounds = g.sentences.map((s) =>
        wordBounds(g.recordingId, s.match!.start, s.match!.end),
      );
      if (bounds.some((b) => b === null)) {
        skippedTightening.add(g.recordingId);
        result.push(g);
        continue;
      }
      // Greedy left-to-right: a pause wide enough to cut, with reviewable
      // scenes on both sides, becomes a scene boundary.
      const final = bounds.at(-1)!;
      const parts: {
        first: number;
        last: number;
        sentences: typeof g.sentences;
      }[] = [];
      let cur = {
        first: bounds[0]!.first,
        last: bounds[0]!.last,
        sentences: [g.sentences[0]],
      };
      parts.push(cur);
      for (let i = 1; i < g.sentences.length; i++) {
        const b = bounds[i]!;
        const pads = level.headPad + level.tailPad;
        if (
          b.first - cur.last > level.splitGap &&
          cur.last - cur.first + pads >= MIN_TIGHT_HALF &&
          final.last - b.first + pads >= MIN_TIGHT_HALF
        ) {
          gapsCut++;
          cur = { first: b.first, last: b.last, sentences: [g.sentences[i]] };
          parts.push(cur);
        } else {
          cur.last = Math.max(cur.last, b.last);
          cur.sentences.push(g.sentences[i]);
        }
      }
      for (const part of parts)
        result.push({
          recordingId: g.recordingId,
          start: Math.max(0, part.first - level.headPad),
          end: part.last + level.tailPad,
          sentences: part.sentences,
        });
      secondsRemoved +=
        g.end -
        g.start -
        parts.reduce(
          (t, p) => t + (p.last - p.first) + level.headPad + level.tailPad,
          0,
        );
    }
  }
  // A cut must never present the same source seconds twice, whatever order
  // takes appear in. Work per recording in source order: trim each range to
  // the start of the next, and when one range swallows another, keep the one
  // with more content and record the other's sentences as dropped.
  const collided = new Set<(typeof merged)[number]>();
  const perRecording = new Map<string, typeof merged>();
  for (const g of result) {
    const list = perRecording.get(g.recordingId) ?? [];
    list.push(g);
    perRecording.set(g.recordingId, list);
  }
  for (const ranges of perRecording.values()) {
    ranges.sort((x, y) => x.start - y.start || x.end - y.end);
    for (let i = 0; i + 1 < ranges.length; i++) {
      const x = ranges[i],
        y = ranges[i + 1];
      if (collided.has(x) || collided.has(y)) continue;
      if (y.start >= x.end) continue;
      if (y.start <= x.start + 0.12) {
        collided.add(y.sentences.length > x.sentences.length ? x : y);
        continue;
      }
      x.end = Math.max(x.start + 0.12, y.start);
    }
  }
  for (const g of collided)
    for (const s of g.sentences)
      dropReason.set(
        s.index,
        "Its matched speech overlaps another scene from the same take.",
      );
  const kept = result.filter((g) => !collided.has(g));
  for (const g of kept) {
    const minStart = Math.min(...g.sentences.map((s) => s.match!.start));
    const maxEnd = Math.max(...g.sentences.map((s) => s.match!.end));
    if (g.start - minStart > SPAN_TOLERANCE || maxEnd - g.end > SPAN_TOLERANCE)
      throw new StudioError(
        "INVALID_PLAN",
        `Scene covering sentences ${g.sentences[0].index + 1}–${g.sentences.at(-1)!.index + 1} cannot cover its claimed speech without replaying source frames.`,
        "Re-run alignment; if it persists, revise the script or takes.",
      );
  }
  let run = 0;
  const scenes: EditScene[] = kept.map((g, i) => {
    const narration = g.sentences.map((s) => s.text).join(" ");
    const heading =
      g.sentences.find((s) => s.heading !== null)?.heading ?? null;
    // Alternate a modest punch-in inside long same-take runs to add rhythm.
    run = kept[i - 1]?.recordingId === g.recordingId ? run + 1 : 0;
    const emphasised =
      /\b(not|never|problem|fail|wrong|mistake|truth|actually)\b/i.test(
        narration,
      );
    const punchIn = emphasised || run % 3 === 2 ? EMPHASIS_PUNCH : 1;
    const scores = g.sentences.map((s) => s.match!.score);
    const chosen = new Set(
      g.sentences.map(
        (s) => `${s.match!.recordingId}@${s.match!.start.toFixed(2)}`,
      ),
    );
    const alternates = new Map<
      string,
      { recordingId: string; start: number; end: number; score: number }
    >();
    for (const s of g.sentences)
      for (const alt of s.alternates) {
        const key = `${alt.recordingId}@${alt.start.toFixed(2)}`;
        if (chosen.has(key) || alternates.has(key)) continue;
        alternates.set(key, alt);
      }
    return {
      id: `scene-${String(i + 1).padStart(3, "0")}`,
      recordingId: g.recordingId,
      start: g.start,
      end: g.end,
      sentences: g.sentences.map((s) => s.index),
      narration,
      segmentIds: [...new Set(g.sentences.flatMap((s) => s.match!.segmentIds))],
      heading,
      punchIn,
      framing: punchIn > 1.02 ? "close" : "medium",
      selection: {
        score:
          Math.round(
            (scores.reduce((t, s) => t + s, 0) / scores.length) * 1000,
          ) / 1000,
        bridged: g.sentences.some((s) => bridgedIndices.has(s.index)),
        alternates: [...alternates.values()].slice(0, 6),
      },
      suggestedGraphic: suggestGraphic(narration, heading),
    };
  });
  // Chapters lead their scene; cap graphics so most scenes stay presenter-led.
  // The cap follows the creator's visual density: minimal isolates essentials,
  // rich lets graphics cluster and opens on one.
  const throttle =
    density === "minimal"
      ? { recent: 1, openOnGraphic: false }
      : density === "rich"
        ? { recent: 3, openOnGraphic: true }
        : { recent: 2, openOnGraphic: false };
  const withGraphics = scenes.map((s, i) => {
    if (s.heading)
      return {
        ...s,
        suggestedGraphic: {
          template: "ChapterTitle" as const,
          parameters: { title: s.heading.slice(0, 90), subtitle: "" },
          reason: "Section heading from the script.",
        },
      };
    const recent = scenes
      .slice(Math.max(0, i - 3), i)
      .filter((x) => x.suggestedGraphic).length;
    if (recent >= throttle.recent || (i === 0 && !throttle.openOnGraphic))
      return { ...s, suggestedGraphic: null };
    return s;
  });
  return editDecisionSchema.parse({
    schemaVersion: "1.2.0",
    createdAt: now(),
    scenes: withGraphics,
    dropped: rows
      .filter((s) => !s.match || dropReason.has(s.index))
      .map((s) => ({
        index: s.index,
        text: s.text,
        reason:
          dropReason.get(s.index) ??
          "No take matched this sentence above the confidence threshold.",
      })),
    stats: {
      keptSeconds: withGraphics.reduce((t, s) => t + (s.end - s.start), 0),
      groups: withGraphics.length,
      droppedSentences: rows.filter((s) => !s.match || dropReason.has(s.index))
        .length,
      recordingsUsed: [...new Set(withGraphics.map((s) => s.recordingId))],
      suggestedGraphics: withGraphics.filter((s) => s.suggestedGraphic).length,
      tightening: {
        level: tightening,
        gapsCut,
        secondsRemoved: Math.max(0, Math.round(secondsRemoved * 1000) / 1000),
        skippedRecordings: [...skippedTightening],
      },
    },
  });
}
