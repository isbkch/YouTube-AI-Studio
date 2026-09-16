import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../packages/orchestrator/src/store.ts";
import { Studio, parseTimeRange } from "../packages/orchestrator/src/studio.ts";
import {
  alignScript,
  splitScriptSentences,
  tokenStream,
} from "../packages/orchestrator/src/alignment.ts";
import { buildEditDecision } from "../packages/orchestrator/src/aroll.ts";
import {
  readFCPTranscript,
  discoverFCPTranscripts,
  fcpToTranscriptInput,
} from "../packages/orchestrator/src/fcp.ts";
import {
  migratePlan,
  validatePlan,
  validateSources,
  TEMPLATE_CATALOG,
} from "../packages/production-plan/src/index.ts";
import { fixture } from "./fixtures.ts";
import { hash } from "../packages/shared/src/index.ts";
import type {
  Recording,
  Transcript,
} from "../packages/orchestrator/src/model.ts";

const recording = (id: string, duration: number, name = id): Recording => ({
  id,
  name: `${name}.mp4`,
  path: `recordings/${name}.mp4`,
  duration,
  width: 3840,
  height: 2160,
  codec: "h264",
  frameRate: 23.976,
  hasAudio: true,
  audioCodec: "pcm_s16be",
  bytes: 1000,
  hash: hash(name),
  importedAt: new Date().toISOString(),
  proxyPath: null,
  proxyStatus: "PENDING",
});

const transcriptWithWords = (
  id: string,
  sentences: { start: number; text: string }[],
): Transcript => {
  const segments = sentences.map((s, i) => {
    const words = s.text.split(" ").map((w, j) => {
      const per = 0.36;
      return {
        start: s.start + j * per,
        end: s.start + (j + 1) * per,
        text: w,
      };
    });
    return {
      id: `seg-${i + 1}`,
      start: s.start,
      end: words.at(-1)!.end,
      text: s.text,
      words,
    };
  });
  return {
    schemaVersion: "1.0.0",
    recordingId: id,
    language: "en",
    provider: "apple-final-cut",
    model: "speech-analysis-1",
    segments,
  };
};

test("script sentences split with headings; tokens normalize", () => {
  const sentences = splitScriptSentences(
    "# The Problem\n\nLine one acts as heading\n\nFirst sentence here. Second one follows!\n\nFinal question?",
  );
  assert.equal(sentences.length, 3);
  // Headings attach to the first sentence that follows them.
  assert.equal(sentences[0].heading, "Line one acts as heading");
  assert.equal(sentences[1].heading, null);
  assert.equal(sentences[2].tokens.join(" "), "final question");
});

test("alignment picks the best take per sentence and stays monotonic", () => {
  const good = recording("rec-good", 60, "take-a");
  const retake = recording("rec-retake", 60, "take-b");
  const script = [
    "The first idea lands cleanly.",
    "The second idea was reshot better.",
    "The third idea closes the thought.",
  ].join(" ");
  // Take A: all three sentences, mediocre first.
  const takeA = transcriptWithWords(good.id, [
    { start: 2, text: "The first idea lands clearly." },
    { start: 10, text: "The second idea was reshot poorly." },
    { start: 20, text: "The third idea closes the thought." },
  ]);
  // Take B: perfect second sentence only.
  const takeB = transcriptWithWords(retake.id, [
    { start: 1, text: "The second idea was reshot better." },
    { start: 12, text: "Unrelated filler material." },
  ]);
  const alignment = alignScript({
    script,
    scriptVersion: 1,
    recordings: [good, retake],
    transcripts: [takeA, takeB],
  });
  assert.equal(alignment.stats.matched, 3);
  assert.equal(alignment.sentences[0].match!.recordingId, good.id);
  // The perfect retake wins for sentence two.
  assert.equal(alignment.sentences[1].match!.recordingId, retake.id);
  assert.equal(alignment.sentences[2].match!.recordingId, good.id);
  assert.ok(alignment.sentences[0].match!.score > 0.4);
  assert.ok(alignment.sentences[1].match!.score > 0.9);
});

test("A-roll editor groups takes, drops dead space and reports cut statistics", () => {
  const rec = recording("rec-1", 120);
  const sentences = [
    { start: 5, text: "Opening claim about databases." },
    { start: 30, text: "A slow meandering aside that rambles." },
    { start: 90, text: "The payoff sentence lands." },
  ];
  const alignment = alignScript({
    script: sentences.map((s) => s.text).join(" "),
    scriptVersion: 1,
    recordings: [rec],
    transcripts: [transcriptWithWords(rec.id, sentences)],
  });
  const edit = buildEditDecision(alignment);
  // Three isolated sentences become three scenes; dead space between them is cut.
  assert.equal(edit.scenes.length, 3);
  assert.ok(edit.stats.keptSeconds < 20);
  assert.ok(edit.scenes[0].start >= 4.8 && edit.scenes[0].end <= 8);
  assert.deepEqual(edit.dropped, []);
  const stream = tokenStream(transcriptWithWords(rec.id, sentences));
  assert.ok(
    stream.length >=
      sentences.reduce((n, s) => n + s.text.split(" ").length, 0),
  );
});

test("FCP transcript parsing converts rational word times and maps by duration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wts-fcp-"));
  try {
    const fcp = {
      timeRange: { start: "0/16000s", end: "960000/16000s" },
      phrases: [
        {
          summary: "Hello world.",
          timeRange: { start: "16000/16000s", end: "18000/16000s" },
          words: [
            {
              summary: "Hello",
              timeRange: { start: "16000/16000s", end: "17000/16000s" },
            },
            {
              summary: " world.",
              timeRange: { start: "17000/16000s", end: "18000/16000s" },
            },
          ],
        },
      ],
    };
    const dir = path.join(root, "__.fcpdata.apple.com", "media_metadata", "A1");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "en-US.fcptranscript");
    await writeFile(file, JSON.stringify(fcp));
    const discovered = await discoverFCPTranscripts(root);
    assert.equal(discovered.length, 1);
    const parsed = await readFCPTranscript(discovered[0]);
    assert.equal(parsed.phrases[0].words[0].start, 1);
    const rec = recording("rec-1", 60);
    const input = fcpToTranscriptInput(parsed, rec);
    assert.equal(input.segments[0].words!.length, 2);
    assert.equal(input.segments[0].words![1].text, "world.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("v1 plans migrate to the v2 catalog schema and still validate", () => {
  const v1 = {
    ...fixture(),
    schemaVersion: "1.0.0" as unknown as "2.0.0",
    resolution: { width: 1280, height: 720 },
    durationFrames: 180,
    scenes: [
      {
        ...fixture().scenes[0],
        visual: {
          type: "graphic" as const,
          description: "Old flow",
          graphic: {
            engine: "remotion" as const,
            template: "ArchitectureFlow" as const,
            templateVersion: "1.0.0" as const,
            parameters: {
              title: "Old flow",
              subtitle: "v1",
              nodes: ["A", "B", "C"],
              emphasis: 2,
            },
          },
        },
      },
      {
        ...fixture().scenes[0],
        id: "scene-2",
        startFrame: 90,
        visual: {
          type: "graphic" as const,
          description: "Old callout",
          graphic: {
            engine: "remotion" as const,
            template: "Callout" as const,
            templateVersion: "1.0.0" as const,
            parameters: {
              title: "Old callout",
              subtitle: "v1",
              nodes: [],
              emphasis: -1,
            },
          },
        },
      },
    ],
  };
  const migrated = validatePlan(migratePlan(v1));
  assert.equal(migrated.schemaVersion, "2.0.0");
  const flow = migrated.scenes[0].visual.graphic!;
  assert.deepEqual(flow.parameters, {
    title: "Old flow",
    subtitle: "v1",
    nodes: ["A", "B", "C"],
    emphasis: 2,
  });
  const callout = migrated.scenes[1].visual.graphic!;
  assert.deepEqual(callout.parameters, {
    title: "Old callout",
    subtitle: "v1",
  });
});

test("every catalog template has parameters and guidance for the Director", () => {
  const names = new Set(TEMPLATE_CATALOG.map((c) => c.template));
  assert.equal(names.size, 11);
  for (const entry of TEMPLATE_CATALOG) {
    assert.ok(entry.when.length > 10);
    assert.ok(entry.parameters.length > 5);
  }
});

test("plan import validates the full contract and creates an approvable storyboard", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wts-import-"));
  const store = new Store(root);
  try {
    const studio = new Studio(store);
    const p = store.create("Plan import test", "", 60);
    const rec = recording("rec-1", 10);
    await studio.saveScript(p.id, "Hello there.");
    await studio.approveScript(p.id, 1);
    store.update(p.id, (x) => {
      x.status = "MEDIA_IMPORTED";
      x.recordings = [rec];
      x.transcripts = [
        {
          schemaVersion: "1.0.0",
          recordingId: rec.id,
          language: "en",
          provider: "test",
          model: "test",
          segments: [{ id: "s-1", start: 0, end: 10, text: "Hello there." }],
        },
      ];
    });
    const plan = validatePlan({
      ...fixture(),
      projectId: p.id,
      resolution: { width: 1920, height: 1080 },
      scenes: fixture().scenes.map((s) => ({
        ...s,
        camera: { ...s.camera, recordingId: rec.id },
      })),
    });
    plan.transcriptHash = hash(store.get(p.id).transcripts);
    validateSources(
      plan,
      store.get(p.id).recordings,
      store.get(p.id).transcripts,
    );
    await studio.importPlan(p.id, plan);
    assert.equal(store.get(p.id).status, "AWAITING_STORYBOARD_APPROVAL");
    await studio.approvePlan(p.id, 1);
    // A plan for a different project must be rejected.
    const foreign = structuredClone(plan);
    foreign.projectId = "project-other";
    foreign.version = 2;
    await assert.rejects(studio.importPlan(p.id, foreign), /contract/);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("range revisions scope operations to the scenes inside a timeline range", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wts-range-"));
  const store = new Store(root);
  try {
    const studio = new Studio(store);
    const p = store.create("Range revision test", "", 60);
    const rec = recording("rec-1", 10);
    const plan = {
      ...fixture(),
      projectId: p.id,
      resolution: { width: 1920, height: 1080 },
      durationFrames: 180,
      scenes: [0, 1, 2].map((i) => ({
        ...fixture().scenes[0],
        id: `scene-${i + 1}`,
        startFrame: i * 60,
        durationFrames: 60,
        chapterTitle: i === 1 ? "Act two" : null,
        camera: { ...fixture().scenes[0].camera, recordingId: rec.id },
        visual:
          i === 1
            ? {
                type: "graphic" as const,
                description: "Existing",
                graphic: {
                  engine: "remotion" as const,
                  template: "Callout" as const,
                  templateVersion: "1.0.0" as const,
                  parameters: { title: "Existing", subtitle: "" },
                },
              }
            : {
                type: "presenter" as const,
                description: "Presenter",
                graphic: null,
              },
      })),
    };
    const transcript = {
      schemaVersion: "1.0.0" as const,
      recordingId: rec.id,
      language: "en",
      provider: "test",
      model: "test",
      segments: [{ id: "s-1", start: 0, end: 10, text: "Hello." }],
    };
    store.update(p.id, (x) => {
      x.status = "AWAITING_ROUGH_CUT_APPROVAL";
      x.recordings = [rec];
      x.transcripts = [transcript];
      x.plans = [validatePlan(plan)];
    });
    assert.deepEqual(parseTimeRange("3:42-4:10"), [222, 250]);
    assert.deepEqual(parseTimeRange("0:01 to 0:03"), [1, 3]);
    assert.equal(parseTimeRange("nonsense"), null);
    // Scene 2 lives in 2.0–4.0s; "keep my A-roll" must strip its graphic only.
    const patch = await studio.proposeRange(
      p.id,
      "1.5-3.5",
      "Keep my A-roll for this stretch.",
    );
    assert.deepEqual(patch.affectedScenes, ["scene-2"]);
    assert.equal(patch.operations.length, 1);
    await studio.decidePatch(p.id, patch.id, true);
    const revised = store.get(p.id).plans.at(-1)!;
    assert.equal(revised.scenes[1].visual.type, "presenter");
    assert.equal(revised.scenes[0].visual.type, "presenter");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
