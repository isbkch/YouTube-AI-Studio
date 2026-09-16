#!/usr/bin/env node
/**
 * Milestone-2 Director pass over the real A-roll: builds a production plan
 * from the alignment + deterministic A-roll draft, then applies curated
 * editorial decisions with real graphic content (actual code, actual numbers
 * from the narration). Emits a plan JSON for `wts plan import`, which runs it
 * through the exact validation an in-app Director plan must pass.
 *
 * Usage: tsx scripts/direct-real.ts <project-id> <output.json>
 */
import { writeFile } from "node:fs/promises";
import { Store } from "../packages/orchestrator/src/store.ts";
import { Studio } from "../packages/orchestrator/src/studio.ts";
import {
  buildEditDecision,
  quantizeEditFrames,
} from "../packages/orchestrator/src/aroll.ts";
import {
  validatePlan,
  type Graphic,
  type Scene,
} from "../packages/production-plan/src/index.ts";
import { hash, id, now } from "../packages/shared/src/index.ts";

const projectId = process.argv[2];
const outputFile = process.argv[3];
if (!projectId || !outputFile) {
  console.error("Usage: tsx scripts/direct-real.ts <project-id> <output.json>");
  process.exit(1);
}

const chapterSubtitles: Record<string, string> = {
  "The Production Readiness Crisis": "Works is not ready.",
  "Friction Used to Force Understanding": "The old friction had a purpose.",
  "The Demo App That Works": "An agent-built SaaS in an afternoon.",
  "Six Operations, One Failure": "Where distributed systems sneak in.",
  "Authentication Is Not Authorization": "The endpoint that looks perfect.",
  "Software You Can Operate": "Answers to questions you didn't know you'd ask.",
  "When Did You Last Restore?": "Backups are not restores.",
  "Judgment Becomes the Scarce Resource":
    "What stays expensive when code is free.",
  "What Senior Means Now": "From implementing to interrogating.",
  "Five Questions Before Production": "Print them. Ask them.",
  "Own What Happens Next": "Engineering begins at responsibility.",
};

const graphic = (
  template: string,
  parameters: Record<string, unknown>,
): Graphic =>
  ({
    engine: "remotion",
    template,
    templateVersion: "1.0.0",
    parameters,
  }) as Graphic;

/** Ordered rules: first match wins. Regexes run against the scene narration. */
const rules: {
  match: RegExp;
  /** Static callouts are skipped on long spans; animated templates hold attention. */
  long?: boolean;
  build: () => Graphic;
  punch?: number;
}[] = [
  {
    match: /database is unavailable/i,
    build: () =>
      graphic("FailureAnimation", {
        title: "The hard part begins after it works",
        subtitle: "What happens when the database is unavailable?",
        nodes: ["Users", "Gateway", "App", "Database"],
        failedNode: 3,
        recovered: false,
      }),
    punch: 1.1,
  },
  {
    match: /ability to generate software can exceed/i,
    build: () =>
      graphic("Callout", {
        title: "We can generate faster than we understand.",
        subtitle: "A fundamentally new engineering problem.",
      }),
    punch: 1.1,
  },
  {
    match: /production readiness is not about whether the happy path/i,
    build: () =>
      graphic("Callout", {
        title: "Production readiness is not the happy path.",
        subtitle: "It is everything surrounding it.",
      }),
    punch: 1.1,
  },
  {
    match: /uploading the file, creating a database record/i,
    build: () =>
      graphic("RequestFlow", {
        title: "One document, six operations",
        subtitle: "Now imagine operation five fails.",
        method: "POST",
        path: "/api/documents",
        steps: [
          "Upload",
          "DB record",
          "Charge credit",
          "Call model",
          "Store output",
          "Update status",
        ],
        failureStep: 4,
      }),
  },
  {
    match: /idempotency/i,
    build: () =>
      graphic("CodeReveal", {
        title: "Idempotency, not hope",
        fileName: "processDocument.ts",
        lines: [
          "export async function processDocument(docId, idemKey) {",
          "  const existing = await jobs.findUnique({ idemKey });",
          "  if (existing) return existing.result; // idempotent",
          "  await jobs.create({ idemKey, status: 'running' }); // claim first",
          "  const result = await model.analyze(docId);",
          "  await jobs.complete({ idemKey, result });",
          "  return result;",
          "}",
        ],
        highlight: 3,
      }),
  },
  {
    match: /did not eliminate complexity/i,
    build: () =>
      graphic("Callout", {
        title: "AI did not eliminate complexity.",
        subtitle: "It removed the friction of creating it.",
      }),
    punch: 1.1,
  },
  {
    match:
      /authorization answers a much more dangerous question|who are you\?/i,
    build: () =>
      graphic("Callout", {
        title: "AuthN: who are you? AuthZ: what may you do?",
        subtitle: "Two different questions. One dangerous gap.",
      }),
  },
  {
    match: /We have a GET|finding the unique document/i,
    build: () =>
      graphic("CodeReveal", {
        title: "The endpoint that looks perfect",
        fileName: "routes/documents.ts",
        lines: [
          'app.get("/api/documents/:id", auth, async (req, res) => {',
          "  const doc = await db.documents.findUnique({",
          "    where: { id: req.params.id },",
          "  });",
          "  res.json(doc);",
          "});",
        ],
        highlight: 2,
      }),
  },
  {
    match: /Change an ID|somebody else's document/i,
    build: () =>
      graphic("CodeDiff", {
        title: "The fix is one constraint",
        fileName: "routes/documents.ts",
        removed: ["    where: { id: req.params.id },"],
        added: [
          "    where: {",
          "      id: req.params.id,",
          "      userId: req.user.id,",
          "    },",
        ],
      }),
  },
  {
    match: /machine wrote the tests/i,
    build: () =>
      graphic("Callout", {
        title: "The machine tested itself.",
        subtitle: "Code, tests, green deploy — still broken.",
      }),
    punch: 1.1,
  },
  {
    match: /47 documents/i,
    build: () =>
      graphic("Terminal", {
        title: "11 of 47 never finished",
        lines: [
          {
            kind: "input",
            text: "kubectl logs worker --since=8h | grep -c ERROR",
          },
          { kind: "output", text: "11" },
          { kind: "input", text: "grep traceId app.log | head -1" },
          { kind: "error", text: "no traceId — cause unknown" },
        ],
      }),
  },
  {
    match: /no correlation ID|no structured logging/i,
    build: () =>
      graphic("Callout", {
        title: "No correlation ID. No traces. No answers.",
        subtitle: "Software that runs vs software you can operate.",
      }),
  },
  {
    match: /restored your database/i,
    build: () =>
      graphic("Callout", {
        title: "When did you last RESTORE your database?",
        subtitle: "Not backed up. Restored.",
      }),
    punch: 1.12,
  },
  {
    match: /RPO and RTO|How much data can we lose/i,
    build: () =>
      graphic("Callout", {
        title: "RPO — how much data can we lose.",
        subtitle: "RTO — how long can we be down.",
      }),
  },
  {
    match: /person who can fix everything/i,
    build: () =>
      graphic("Callout", {
        title: "What if the only person who can restore is away?",
        subtitle: "Bus factor is a production readiness question.",
      }),
  },
  {
    match: /turn specifications into code/i,
    build: () =>
      graphic("Callout", {
        title: "Code generation is nearly free.",
        subtitle: "Judgment is not.",
      }),
    punch: 1.1,
  },
  {
    match: /trust boundaries/i,
    build: () =>
      graphic("Callout", {
        title: "The questions that age well",
        subtitle:
          "Trust boundaries · failure model · consistency · rollback · recovery",
      }),
  },
  {
    match: /can we trust this thing/i,
    build: () =>
      graphic("Callout", {
        title: "Can we trust this thing?",
        subtitle: "The new definition of senior.",
      }),
  },
  {
    match: /Failure\. Security\. Visibility/i,
    build: () =>
      graphic("Callout", {
        title: "Failure · Security · Visibility · Recovery · Ownership",
        subtitle: "Five questions before you ship.",
      }),
    punch: 1.08,
  },
  {
    match: /engineering discipline obsolete/i,
    long: true,
    build: () =>
      graphic("MetricChart", {
        title: "One person, team-scale complexity",
        subtitle: "Hypothetical compounding, not measured data.",
        unit: "x",
        series: [1, 2, 4, 8, 16, 32],
        threshold: null,
        goodDirection: "up",
        basis: "illustrative",
      }),
  },
  {
    match: /Engineering begins when you become responsible/i,
    build: () =>
      graphic("Callout", {
        title: "AI can generate the system.",
        subtitle: "Engineering begins when you become responsible for it.",
      }),
    punch: 1.1,
  },
];

const staticTemplates = new Set(["Callout", "Quote"]);

const store = new Store();
try {
  const studio = new Studio(store);
  const p = store.get(projectId);
  const alignment = await studio.computeAlignment(projectId);
  const transcripts = p.recordings.map((r) =>
    p.transcripts.findLast((t) => t.recordingId === r.id)!,
  );
  const edit = buildEditDecision(alignment, transcripts);
  const fps = 30;
  const quantized = quantizeEditFrames(edit.scenes, p.recordings, fps);
  let cursor = 0;
  const scenes: Scene[] = edit.scenes.map((s, i) => {
    const start = cursor;
    const { sourceInFrame, durationFrames } = quantized.get(s.id)!;
    cursor += durationFrames;
    let graphicForScene: Graphic | null = null;
    let punchIn = s.punchIn;
    if (s.heading) {
      graphicForScene = graphic("ChapterTitle", {
        title: s.heading.slice(0, 90),
        subtitle: chapterSubtitles[s.heading] ?? "",
      });
    } else {
      const rule = rules.find((r) => r.match.test(s.narration));
      const longSpan = durationFrames > 22 * fps;
      if (
        rule &&
        (!longSpan || !staticTemplates.has(rule.build().template) || rule.long)
      ) {
        graphicForScene = rule.build();
        punchIn = Math.max(punchIn, rule.punch ?? 1);
      }
    }
    return {
      id: `scene-${String(i + 1).padStart(3, "0")}`,
      startFrame: start,
      durationFrames,
      sourceInFrame,
      narration: s.narration.slice(0, 20000),
      transcriptSegmentIds: s.segmentIds.slice(0, 50),
      camera: {
        recordingId: s.recordingId,
        framing: punchIn > 1.02 ? "close" : "medium",
        punchIn,
      },
      visual: graphicForScene
        ? {
            type: "graphic" as const,
            description:
              graphicForScene.template === "ChapterTitle"
                ? `Chapter: ${s.heading}`
                : "Curated graphic from narration content.",
            graphic: graphicForScene,
          }
        : {
            type: "presenter" as const,
            description: "Presenter carries the explanation.",
            graphic: null,
          },
      broll: [],
      audio: { gainDb: 0 },
      transition: "cut" as const,
      enabled: true,
      rationale: s.heading
        ? "Section start from the script heading."
        : graphicForScene
          ? "Narration names concrete artifacts; visualise them."
          : "Aligned take; kept in script order.",
      chapterTitle: s.heading ? s.heading.slice(0, 120) : null,
      selection: s.selection,
    };
  });
  const droppedIdx = new Set(edit.dropped.map((d) => d.index));
  const sceneIdBySentence = new Map<number, string>();
  for (const s of edit.scenes)
    for (const idx of s.sentences) sceneIdBySentence.set(idx, s.id);
  const plan = validatePlan({
    schemaVersion: "4.0.0",
    id: id("plan"),
    projectId,
    version: p.plans.length + 1,
    createdAt: now(),
    scriptVersion: p.scripts.at(-1)!.version,
    transcriptHash: hash(transcripts),
    frameRate: fps,
    resolution: { width: 1920, height: 1080 },
    durationFrames: cursor,
    director: {
      provider: "human-director",
      model: "curated-v1",
      summary: `Human-curated direction over the deterministic A-roll edit: ${edit.stats.groups} scenes from ${edit.stats.recordingsUsed.length} take(s), ${edit.stats.droppedSentences} sentence(s) dropped as retakes/dead space, ${scenes.filter((s) => s.visual.graphic && s.visual.graphic!.template !== "ChapterTitle").length} content graphics + ${scenes.filter((s) => s.chapterTitle).length} chapters. Roughly ${Math.round(cursor / fps / 60)} minutes.`,
    },
    scenes,
    scriptCoverage: {
      sentences: alignment.sentences.map((row) =>
        row.match && !droppedIdx.has(row.index)
          ? {
              text: row.text.slice(0, 2000),
              status: "included" as const,
              sceneId: sceneIdBySentence.get(row.index) ?? null,
              reason: null,
            }
          : {
              text: row.text.slice(0, 2000),
              status: "omitted" as const,
              sceneId: null,
              reason:
                edit.dropped.find((d) => d.index === row.index)?.reason ?? null,
            },
      ),
    },
  });
  await writeFile(outputFile, JSON.stringify(plan, null, 2) + "\n");
  console.log(
    JSON.stringify(
      {
        output: outputFile,
        scenes: plan.scenes.length,
        durationSeconds: Math.round(plan.durationFrames / fps),
        graphics: plan.scenes.filter((s) => s.visual.graphic).length,
        chapters: plan.scenes.filter((s) => s.chapterTitle).length,
        droppedSentences: edit.dropped.length,
        perTake: edit.stats.recordingsUsed,
      },
      null,
      2,
    ),
  );
} finally {
  store.close();
}
