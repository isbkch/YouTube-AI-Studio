import { z } from "zod";
import { now } from "../../shared/src/index.ts";
import type { Alignment } from "./alignment.ts";
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
  suggestedGraphic: {
    template: TemplateName;
    parameters: Record<string, unknown>;
    reason: string;
  } | null;
}

export const editDecisionSchema = z.strictObject({
  schemaVersion: z.literal("1.0.0"),
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
  }),
});
export type EditDecision = z.infer<typeof editDecisionSchema>;

const GROUP_GAP = 2.4; // seconds of dead space that still keeps one scene
const MIN_SCENE = 1.6; // shorter runs merge forward into the next scene
const EMPHASIS_PUNCH = 1.1;

function numbersIn(text: string): number[] {
  return [...text.matchAll(/\b(\d+(?:\.\d+)?)\b/g)]
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n));
}

/**
 * Deterministic graphic suggestions from narration content. These are drafts:
 * the Director (model or human) refines titles and content before approval.
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
  if (/\b(database|postgres|sql|queue|cache|single point|shared)\b/.test(text))
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
      reason: "Layered architecture with a shared failing layer.",
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
  if (/\b(request|http|endpoint|api|route|traffic|load balancer)\b/.test(text))
    return {
      template: "RequestFlow",
      parameters: {
        title: heading || "One request",
        subtitle: "Where the request travels.",
        method: "GET",
        path: "/api/health",
        steps: ["Client", "Gateway", "Service", "Database"],
        failureStep: -1,
      },
      reason: "A concrete request travelling through the system.",
    };
  if (
    /\b(latency|milliseconds| p99|uptime|downtime|throughput|per second|rps|qps)\b/.test(
      text,
    ) &&
    numbers.length >= 2
  )
    return {
      template: "MetricChart",
      parameters: {
        title: heading || "The number that matters",
        subtitle: "Measured, not assumed.",
        unit: /\bms\b|millisecond/.test(text) ? "ms" : "%",
        series: numbers.slice(0, 12),
        threshold: null,
        goodDirection: /\blatency|downtime|error\b/.test(text) ? "down" : "up",
      },
      reason: "Quantities changing over time, read from the narration.",
    };
  if (
    /\b(const |function|import |class |def |async|npm|deploy|cli)\b/.test(text)
  )
    return {
      template: "Terminal",
      parameters: {
        title: heading || "Run it",
        lines: [
          { kind: "input", text: "npm run deploy" },
          { kind: "output", text: "deployed — verify it yourself" },
          { kind: "error", text: "error: not production ready" },
        ],
      },
      reason: "Command or code being executed in the narration.",
    };
  return null;
}

export function buildEditDecision(alignment: Alignment): EditDecision {
  // Unmatched sentences sandwiched between two matches from the same take are
  // almost certainly spoken in the audio between them (with a false start or
  // phrasing the aligner scored low). Bridge that audio instead of cutting it.
  const BRIDGE_MAX = 15;
  const rows = alignment.sentences.map((s) => ({ ...s, match: s.match }));
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
      after.start - before.end <= BRIDGE_MAX
    ) {
      rows[i].match = {
        recordingId: before.recordingId,
        start: Math.max(0, before.end - 0.1),
        end: after.start + 0.1,
        score: 0,
        segmentIds: [],
      };
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
  // Merge runs too short to feel like a scene into the following group.
  const merged: typeof groups = [];
  for (const g of split) {
    const prev = merged.at(-1);
    if (
      prev &&
      prev.recordingId === g.recordingId &&
      g.end - g.start < MIN_SCENE &&
      g.start - prev.end <= GROUP_GAP * 1.5
    ) {
      prev.end = Math.max(prev.end, g.end);
      prev.sentences.push(...g.sentences);
    } else merged.push(g);
  }
  // Alignment padding lets adjacent spans overlap by a fraction of a second;
  // a cut must never present the same source seconds twice, so trim each
  // group to the start of the next group from the same recording.
  for (let i = 0; i + 1 < merged.length; i++)
    if (
      merged[i].recordingId === merged[i + 1].recordingId &&
      merged[i + 1].start > merged[i].start &&
      merged[i].end > merged[i + 1].start
    )
      merged[i].end = Math.max(merged[i].start + 0.12, merged[i + 1].start);
  let run = 0;
  const scenes: EditScene[] = merged.map((g, i) => {
    const narration = g.sentences.map((s) => s.text).join(" ");
    const heading =
      g.sentences.find((s) => s.heading !== null)?.heading ?? null;
    // Alternate a modest punch-in inside long same-take runs to add rhythm.
    run = merged[i - 1]?.recordingId === g.recordingId ? run + 1 : 0;
    const emphasised =
      /\b(not|never|problem|fail|wrong|mistake|truth|actually)\b/i.test(
        narration,
      );
    const punchIn = emphasised || run % 3 === 2 ? EMPHASIS_PUNCH : 1;
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
      suggestedGraphic: suggestGraphic(narration, heading),
    };
  });
  // Chapters lead their scene; cap graphics so most scenes stay presenter-led.
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
    if (recent >= 2 || i === 0) return { ...s, suggestedGraphic: null };
    return s;
  });
  return editDecisionSchema.parse({
    schemaVersion: "1.0.0",
    createdAt: now(),
    scenes: withGraphics,
    dropped: rows
      .filter((s) => !s.match)
      .map((s) => ({
        index: s.index,
        text: s.text,
        reason: "No take matched this sentence above the confidence threshold.",
      })),
    stats: {
      keptSeconds: withGraphics.reduce((t, s) => t + (s.end - s.start), 0),
      groups: withGraphics.length,
      droppedSentences: rows.filter((s) => !s.match).length,
      recordingsUsed: [...new Set(withGraphics.map((s) => s.recordingId))],
      suggestedGraphics: withGraphics.filter((s) => s.suggestedGraphic).length,
    },
  });
}
