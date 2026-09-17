import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../packages/orchestrator/src/store.ts";
import { Studio, parseTimeRange } from "../packages/orchestrator/src/studio.ts";
import {
  ALIGNMENT_ALGORITHM,
  alignScript,
  splitScriptSentences,
  tokenStream,
} from "../packages/orchestrator/src/alignment.ts";
import {
  buildEditDecision,
  quantizeEditFrames,
  suggestGraphic,
} from "../packages/orchestrator/src/aroll.ts";
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
  frames: Math.floor(duration * 23.976),
  proxyFrames: null,
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

test("shooting-script markup never becomes narration or chapter titles", () => {
  const sentences = splitScriptSentences(
    [
      "# Video title",
      "**Target:** 15 minutes",
      "## 0:00–0:50 — Cold open",
      "**A-ROLL**",
      "> First spoken sentence.",
      ">",
      "> **An emphasized sentence.**",
      "> A spoken fragment:",
      "**B-ROLL / SCREEN**",
      "Draw an architecture.",
      "> Unspoken visual direction.",
      "```ts",
      'console.log("not narration");',
      "```",
      "# 0:50–2:00 — The next section",
      "> A final _spoken_ sentence.",
    ].join("\n"),
  );
  assert.deepEqual(
    sentences.map((s) => s.text),
    [
      "First spoken sentence.",
      "An emphasized sentence.",
      "A spoken fragment:",
      "A final spoken sentence.",
    ],
  );
  assert.deepEqual(
    sentences.map((s) => s.heading),
    ["Cold open", null, null, "The next section"],
  );
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

test("alignment refuses short cross-take rescues and records its algorithm identity", () => {
  const takeA = recording("rec-a", 60, "earlier-take");
  const takeB = recording("rec-b", 60, "current-take");
  const script =
    "The opening establishes the demo. Security. The closing thought moves on.";
  // The earlier take discusses security in an unrelated context; the current
  // take never says the word.
  const transcriptA = transcriptWithWords(takeA.id, [
    { start: 30, text: "A viewer asks about security vulnerabilities." },
  ]);
  const transcriptB = transcriptWithWords(takeB.id, [
    { start: 2, text: "The opening establishes the demo." },
    { start: 20, text: "The closing thought moves on." },
  ]);
  const alignment = alignScript({
    script,
    scriptVersion: 1,
    recordings: [takeA, takeB],
    transcripts: [transcriptA, transcriptB],
  });
  assert.equal(alignment.algorithm, ALIGNMENT_ALGORITHM);
  const security = alignment.sentences[1];
  // The one-word beat must not be pulled from the unrelated earlier take.
  assert.equal(security.match, null);
  const edit = buildEditDecision(alignment, [transcriptA, transcriptB]);
  assert.ok(
    edit.dropped.some(
      (d) => d.text === "Security." && /confidence threshold/.test(d.reason),
    ),
  );
});

test("alignment rescues repeated beats only between their script neighbors", () => {
  const rec = recording("rec-1", 60);
  const script =
    "The opening establishes the demo. Eleven documents never finished. Okay. Why?";
  for (const repeatedInGap of [true, false]) {
    const transcript = transcriptWithWords(rec.id, [
      { start: 2, text: "Okay, let us begin." },
      { start: 10, text: "The opening establishes the demo." },
      { start: 30, text: "Eleven documents never finished." },
      ...(repeatedInGap ? [{ start: 32, text: "Okay." }] : []),
      { start: 33, text: "Why?" },
      { start: 45, text: "Okay, that is all." },
    ]);
    const alignment = alignScript({
      script,
      scriptVersion: 1,
      recordings: [rec],
      transcripts: [transcript],
    });
    const beat = alignment.sentences[2];
    if (repeatedInGap) {
      assert.ok(beat.match);
      assert.ok(beat.match.start >= alignment.sentences[1].match!.end);
      assert.ok(beat.match.end <= alignment.sentences[3].match!.start);
    } else assert.equal(beat.match, null);
    const edit = buildEditDecision(alignment, [transcript]);
    assert.ok(edit.stats.keptSeconds < 10);
    assert.equal(edit.dropped.length, repeatedInGap ? 0 : 1);
  }
});

test("A-roll short-scene merging cannot stretch a scene backwards over other speech", () => {
  const rec = recording("rec-1", 60);
  const transcript = transcriptWithWords(rec.id, [
    { start: 2, text: "Okay." },
    { start: 10, text: "The opening establishes the demo." },
    { start: 30, text: "Eleven documents never finished." },
    { start: 33, text: "Why?" },
  ]);
  const alignment = alignScript({
    script:
      "The opening establishes the demo. Eleven documents never finished. Okay. Why?",
    scriptVersion: 1,
    recordings: [rec],
    transcripts: [transcript],
  });
  // A legacy/external alignment selected an earlier unclaimed beat. Keep its
  // range separate; merging it used to swallow the opening and then throw.
  alignment.sentences[2].match = {
    recordingId: rec.id,
    start: 1.86,
    end: 2.66,
    score: 1,
    segmentIds: ["seg-1"],
  };
  const edit = buildEditDecision(alignment, [transcript]);
  assert.equal(edit.dropped.length, 0);
  assert.ok(edit.stats.keptSeconds < 10);
  const ranges = [...edit.scenes].sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i++)
    assert.ok(ranges[i].start >= ranges[i - 1].end);
  for (const row of alignment.sentences) {
    const scene = edit.scenes.find((s) => s.sentences.includes(row.index))!;
    assert.ok(scene.start <= row.match!.start);
    assert.ok(scene.end >= row.match!.end);
  }
});

test("bridging requires transcript proof of the claimed sentence", () => {
  const rec = recording("rec-1", 60);
  const row = (
    index: number,
    text: string,
    match: { recordingId: string; start: number; end: number } | null,
  ) => ({
    id: `sent-${String(index + 1).padStart(3, "0")}`,
    index,
    text,
    heading: null,
    match: match ? { ...match, score: 0.9, segmentIds: [] } : null,
    alternates: [],
  });
  const alignmentFor = (sentences: ReturnType<typeof row>[]) =>
    ({
      schemaVersion: "2.0.0",
      algorithm: ALIGNMENT_ALGORITHM,
      createdAt: new Date().toISOString(),
      scriptVersion: 1,
      transcriptHash: hash("transcripts"),
      sentences,
      stats: {
        sentences: sentences.length,
        matched: sentences.filter((s) => s.match).length,
        unmatched: sentences.filter((s) => !s.match).length,
        averageScore: 0.8,
        perRecording: [
          {
            recordingId: rec.id,
            name: rec.name,
            matchedSentences: 2,
            keptSeconds: 8,
          },
        ],
      },
    }) as Parameters<typeof buildEditDecision>[0];
  const sandwich = [
    row(0, "The first claim is matched.", {
      recordingId: rec.id,
      start: 2,
      end: 4,
    }),
    row(1, "The bridged sentence is spoken here.", null),
    row(2, "The last claim is matched.", {
      recordingId: rec.id,
      start: 10,
      end: 12,
    }),
  ];
  // Gap audio contains the sentence: bridged in, flagged for review.
  const spoken = transcriptWithWords(rec.id, [
    { start: 0, text: "The first claim is matched." },
    { start: 4.5, text: "The bridged sentence is spoken here." },
    { start: 10, text: "The last claim is matched." },
  ]);
  const bridged = buildEditDecision(alignmentFor(sandwich), [spoken]);
  assert.equal(bridged.dropped.length, 0);
  const bridgedScene = bridged.scenes.find((s) =>
    /bridged sentence/i.test(s.narration),
  )!;
  assert.equal(bridgedScene.selection.bridged, true);
  // The gap audio is kept: every matched second survives the cut.
  assert.ok(bridged.stats.keptSeconds > 9);
  // Gap audio does not contain it: an explicit omission, never a false claim.
  const silent = transcriptWithWords(rec.id, [
    { start: 0, text: "The first claim is matched." },
    { start: 5, text: "Completely different filler words entirely." },
    { start: 10, text: "The last claim is matched." },
  ]);
  const omitted = buildEditDecision(alignmentFor(sandwich), [silent]);
  assert.equal(
    omitted.scenes.every((s) => !/bridged sentence/i.test(s.narration)),
    true,
  );
  assert.ok(
    omitted.dropped.some(
      (d) =>
        d.text === "The bridged sentence is spoken here." &&
        /does not contain this sentence/.test(d.reason),
    ),
  );
});

test("graphic suggestions stay grounded in the narration", () => {
  const chart = suggestGraphic(
    "Latency climbed from 120 milliseconds to 340 milliseconds then 900 milliseconds at peak.",
    null,
  )!;
  assert.equal(chart.template, "MetricChart");
  assert.equal(chart.parameters.basis, "narration");
  assert.deepEqual(chart.parameters.series, [120, 340, 900]);
  // Too few spoken numbers: no chart is invented.
  assert.equal(
    suggestGraphic("Latency matters more than uptime percentages.", null)
      ?.template,
    undefined,
  );
  // A database mention without a narrated failure is not a failure-domain diagram.
  assert.equal(
    suggestGraphic("We store everything in the database.", null),
    null,
  );
  assert.ok(
    suggestGraphic("The shared database failed and took everything down.", null)
      ?.template === "ArchitectureDiagram",
  );
});

test("frame quantization keeps take ranges disjoint and inside the proxy bound", () => {
  const rec = { id: "rec-1", duration: 10.05 };
  const editScenes = [
    { id: "s-a", recordingId: "rec-1", start: 0.9999, end: 2.0167 },
    { id: "s-b", recordingId: "rec-1", start: 2.0, end: 3.5 },
    { id: "s-c", recordingId: "rec-1", start: 9.9, end: 10.4 },
  ];
  const quantized = quantizeEditFrames(editScenes, [rec], 30);
  const ranges = editScenes.map((s) => quantized.get(s.id)!);
  const bound = Math.floor(10.05 * 30);
  for (const r of ranges)
    assert.ok(r.sourceInFrame + r.durationFrames <= bound);
  for (let i = 1; i < ranges.length; i++)
    assert.ok(
      ranges[i].sourceInFrame >=
        ranges[i - 1].sourceInFrame + ranges[i - 1].durationFrames,
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
  assert.equal(migrated.schemaVersion, "4.2.0");
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
        sourceInFrame: i * 60,
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

test("range revisions never render creator instructions and split compound requests at the first sentence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wts-honesty-"));
  const store = new Store(root);
  try {
    const studio = new Studio(store);
    const p = store.create("Revision honesty test", "", 60);
    const rec = recording("rec-1", 10);
    const sceneAt = (i: number, segIds: string[]) => ({
      ...fixture().scenes[0],
      id: `scene-${i + 1}`,
      startFrame: i * 60,
      durationFrames: 60,
      sourceInFrame: i * 60,
      narration:
        i === 0 ? "This scene carries real narration already." : "Hello",
      transcriptSegmentIds: segIds,
      camera: { ...fixture().scenes[0].camera, recordingId: rec.id },
    });
    const plan = {
      ...fixture(),
      projectId: p.id,
      durationFrames: 180,
      scenes: [sceneAt(0, ["s-1", "s-2"]), sceneAt(1, []), sceneAt(2, [])],
    };
    const transcript = {
      schemaVersion: "1.0.0" as const,
      recordingId: rec.id,
      language: "en",
      provider: "test",
      model: "test",
      segments: [
        {
          id: "s-1",
          start: 0,
          end: 1,
          text: "This scene carries real narration already.",
        },
        {
          id: "s-2",
          start: 1,
          end: 2,
          text: "And the friction story follows.",
        },
      ],
    };
    store.update(p.id, (x) => {
      x.status = "AWAITING_ROUGH_CUT_APPROVAL";
      x.recordings = [rec];
      x.transcripts = [transcript];
      x.plans = [validatePlan(plan)];
    });
    // The audited instruction: it must never appear as audience-facing copy.
    const audited =
      "This stretch is visually flat. Keep my A-roll for the first sentence, then illustrate the friction story";
    const patch = await studio.proposeRange(p.id, "0-3", audited);
    const renderedCopy = JSON.stringify(
      patch.operations.flatMap((o) =>
        o.type === "replaceVisual" ? [o.visual.graphic?.parameters ?? {}] : [],
      ),
    );
    assert.ok(!renderedCopy.includes("visually flat"));
    assert.ok(!renderedCopy.includes(audited.slice(0, 40)));
    // The first scene splits at its second transcript segment (1s → frame 30).
    const split = patch.operations.find((o) => o.type === "splitScene") as {
      type: "splitScene";
      sceneId: string;
      atFrame: number;
      newSceneId: string;
    };
    assert.deepEqual(
      [split.sceneId, split.atFrame, split.newSceneId],
      ["scene-1", 30, "scene-1-b"],
    );
    // Later scenes illustrate with narration-derived copy, never instructions.
    const laterVisual = patch.operations.find(
      (o) => o.type === "replaceVisual" && o.sceneId === "scene-2",
    ) as {
      type: "replaceVisual";
      visual: { graphic: { parameters: { title: string } } };
    };
    assert.equal(laterVisual.visual.graphic.parameters.title, "Hello");
    await studio.decidePatch(p.id, patch.id, true);
    const applied = validatePlan(store.get(p.id).plans.at(-1)!);
    assert.deepEqual(
      applied.scenes.map((s) => s.id),
      ["scene-1", "scene-1-b", "scene-2", "scene-3"],
    );
    assert.equal(applied.scenes[0].visual.type, "presenter");
    assert.equal(applied.scenes[1].visual.type, "graphic");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
