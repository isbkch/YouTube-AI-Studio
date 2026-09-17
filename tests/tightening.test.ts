import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ALIGNMENT_ALGORITHM,
  alignScript,
} from "../packages/orchestrator/src/alignment.ts";
import {
  buildEditDecision,
  quantizeEditFrames,
} from "../packages/orchestrator/src/aroll.ts";
import { WhisperCLIProvider } from "../packages/agents/src/whisper.ts";
import { Studio } from "../packages/orchestrator/src/studio.ts";
import { Store } from "../packages/orchestrator/src/store.ts";
import {
  migratePlan,
  validatePlan,
} from "../packages/production-plan/src/index.ts";
import { fixture } from "./fixtures.ts";
import { hash, now } from "../packages/shared/src/index.ts";
import type {
  Recording,
  Transcript,
} from "../packages/orchestrator/src/model.ts";

const recording = (id: string, duration: number): Recording => ({
  id,
  name: `${id}.mp4`,
  path: `recordings/${id}.mp4`,
  duration,
  width: 1920,
  height: 1080,
  codec: "h264",
  frameRate: 30,
  hasAudio: true,
  audioCodec: "aac",
  bytes: 100,
  hash: hash(id),
  importedAt: now(),
  proxyPath: null,
  proxyStatus: "PENDING",
  frames: Math.floor(duration * 30),
  proxyFrames: null,
});

const WORD = 0.36; // seconds per word in the fixture below

const transcriptWithWords = (
  recordingId: string,
  sentences: { start: number; text: string }[],
): Transcript => {
  const segments = sentences.map((s, i) => {
    const words = s.text.split(" ").map((w, j) => ({
      start: s.start + j * WORD,
      end: s.start + (j + 1) * WORD,
      text: w,
    }));
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
    recordingId,
    language: "en",
    provider: "apple-final-cut",
    model: "speech-analysis-1",
    segments,
  };
};

const transcriptSegmentOnly = (
  recordingId: string,
  sentences: { start: number; text: string }[],
): Transcript => ({
  schemaVersion: "1.0.0",
  recordingId,
  language: "en",
  provider: "whisper.cpp",
  model: "ggml-small.bin",
  segments: sentences.map((s, i) => ({
    id: `seg-${i + 1}`,
    start: s.start,
    end: s.start + s.text.split(" ").length * WORD,
    text: s.text,
  })),
});

// Three sentences of one take: the gap after the first is 1.84 s (inside
// GROUP_GAP 2.4, so natural keeps one scene; above the tight split at 1.0)
// and the gap after the second is 0.7 s (split only at the punchy 0.6 level).
const tighteningFixture = () => {
  const rec = recording("rec-tighten", 120);
  const sentences = [
    { start: 10, text: "First thought about caching here." },
    { start: 14, text: "Second thought continues it further." },
    { start: 16.5, text: "Third thought closes the group." },
  ];
  const transcript = transcriptWithWords(rec.id, sentences);
  const alignment = alignScript({
    script: sentences.map((s) => s.text).join(" "),
    scriptVersion: 1,
    recordings: [rec],
    transcripts: [transcript],
  });
  return { rec, sentences, transcript, alignment };
};

test("silence tightening is the identity transform at natural", () => {
  const { transcript, alignment } = tighteningFixture();
  const plain = buildEditDecision(alignment, [transcript]);
  const natural = buildEditDecision(
    alignment,
    [transcript],
    "balanced",
    "natural",
  );
  assert.deepEqual(natural.scenes, plain.scenes);
  assert.deepEqual(natural.stats.tightening, {
    level: "natural",
    gapsCut: 0,
    secondsRemoved: 0,
    skippedRecordings: [],
  });
  assert.equal(natural.stats.keptSeconds, plain.stats.keptSeconds);
});

test("tighter levels cut interior word gaps monotonically without ever cutting speech", () => {
  const { rec, sentences, transcript, alignment } = tighteningFixture();
  const levels = ["natural", "tight", "punchy"] as const;
  const edits = levels.map((level) =>
    buildEditDecision(alignment, [transcript], "balanced", level),
  );
  // natural: one scene (both gaps under GROUP_GAP); tight: split at 1.84 s;
  // punchy: split at both 1.84 s and 0.7 s.
  assert.deepEqual(
    edits.map((e) => e.scenes.length),
    [1, 2, 3],
  );
  for (let i = 0; i + 1 < edits.length; i++)
    assert.ok(
      edits[i].stats.keptSeconds > edits[i + 1].stats.keptSeconds,
      `${levels[i]} must keep more than ${levels[i + 1]}`,
    );
  assert.deepEqual(
    edits.map((e) => e.stats.tightening.gapsCut),
    [0, 1, 2],
  );
  // Every tightened scene still covers every word it claims.
  for (const edit of edits.slice(1)) {
    for (const scene of edit.scenes) {
      const spoken = sentences.filter((_, i) => scene.sentences.includes(i));
      const first = Math.min(...spoken.map((s) => s.start));
      const last = Math.max(
        ...spoken.map((s) => s.start + s.text.split(" ").length * WORD),
      );
      assert.ok(scene.start <= first, `scene ${scene.id} cuts leading speech`);
      assert.ok(scene.end >= last, `scene ${scene.id} cuts trailing speech`);
    }
    // Quantized source ranges stay disjoint and inside the proxy bound.
    const quantized = quantizeEditFrames(edit.scenes, [rec], 30);
    const ranges = edit.scenes.map((s) => quantized.get(s.id)!);
    for (const r of ranges) assert.ok(r.durationFrames >= 12);
    const sorted = [...ranges].sort(
      (x, y) => x.sourceInFrame - y.sourceInFrame,
    );
    for (let i = 0; i + 1 < sorted.length; i++)
      assert.ok(
        sorted[i].sourceInFrame + sorted[i].durationFrames <=
          sorted[i + 1].sourceInFrame,
        "tightened ranges must never replay source frames",
      );
  }
});

test("recordings without word timings are skipped instead of cut on synthetic times", () => {
  const rec = recording("rec-segments", 120);
  const sentences = [
    { start: 10, text: "First thought about caching here." },
    { start: 14, text: "Second thought continues it further." },
    { start: 16.5, text: "Third thought closes the group." },
  ];
  const transcript = transcriptSegmentOnly(rec.id, sentences);
  const alignment = alignScript({
    script: sentences.map((s) => s.text).join(" "),
    scriptVersion: 1,
    recordings: [rec],
    transcripts: [transcript],
  });
  const plain = buildEditDecision(alignment, [transcript]);
  const tight = buildEditDecision(alignment, [transcript], "balanced", "tight");
  assert.deepEqual(tight.scenes, plain.scenes, "edges must stay untouched");
  assert.deepEqual(tight.stats.tightening.skippedRecordings, [rec.id]);
  assert.equal(tight.stats.tightening.gapsCut, 0);
});

test("tightening a bridged scene hugs its proven words without claiming the gap or its neighbors", () => {
  const rec = recording("rec-bridge", 60);
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
  const alignment = {
    schemaVersion: "2.0.0",
    algorithm: ALIGNMENT_ALGORITHM,
    createdAt: new Date().toISOString(),
    scriptVersion: 1,
    transcriptHash: hash("transcripts"),
    sentences: [
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
    ],
    stats: {
      sentences: 3,
      matched: 2,
      unmatched: 1,
      averageScore: 0.8,
      perRecording: [],
    },
  } as Parameters<typeof buildEditDecision>[0];
  const transcript = transcriptWithWords(rec.id, [
    { start: 0, text: "The first claim is matched." },
    { start: 4.5, text: "The bridged sentence is spoken here." },
    { start: 10, text: "The last claim is matched." },
  ]);
  // The bridged row claims the whole gap [3.9, 10.1]; tightening must trim to
  // the proven words (4.5–6.66) — never absorb the next sentence's first word
  // at 10.0, and never trip the span coverage check with the artificial claim.
  const edit = buildEditDecision(alignment, [transcript], "balanced", "tight");
  const bridgedScene = edit.scenes.find((s) =>
    /bridged sentence/i.test(s.narration),
  )!;
  assert.equal(bridgedScene.selection.bridged, true);
  assert.ok(
    Math.abs(bridgedScene.start - 4.4) < 0.05,
    `hug the first word, got ${bridgedScene.start}`,
  );
  assert.ok(
    bridgedScene.end < 7 && bridgedScene.end > 6.6,
    `hug the last word plus pad, got ${bridgedScene.end}`,
  );
  const sameTake = edit.scenes.filter((s) => s.recordingId === rec.id);
  for (const a of sameTake)
    for (const b of sameTake)
      if (a !== b)
        assert.ok(
          a.end <= b.start || b.end <= a.start,
          `tightened bridged scene overlaps ${b.id}`,
        );
});

test("v4.3 plans migrate to v4.4 recording the natural tightening level", () => {
  const legacy = JSON.parse(
    JSON.stringify({ ...fixture(), schemaVersion: "4.3.0" }),
  );
  const migrated = validatePlan(migratePlan(legacy));
  assert.equal(migrated.schemaVersion, "4.4.0");
  assert.equal(migrated.silenceTightening, "natural");
});

test("generatePlan honors the tightening override and records it on the plan", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wts-tightening-"));
  const store = new Store(root);
  try {
    const p = store.create("Tightening override");
    const studio = new Studio(store);
    await studio.saveScript(
      p.id,
      "First thought about caching here. Second thought continues it further. Third thought closes the group.",
    );
    await studio.approveScript(p.id, 1);
    const rec = recording("rec-plan", 60);
    store.update(p.id, (x) => {
      x.recordings = [rec];
      x.transcripts = [
        transcriptWithWords(rec.id, [
          { start: 10, text: "First thought about caching here." },
          { start: 14, text: "Second thought continues it further." },
          { start: 16.5, text: "Third thought closes the group." },
        ]),
      ];
      x.status = "MEDIA_IMPORTED";
    });
    const natural = await studio.generatePlan(p.id);
    assert.equal(natural.plans.at(-1)!.silenceTightening, "natural");
    const tight = await studio.generatePlan(p.id, { tightening: "tight" });
    const plan = tight.plans.at(-1)!;
    assert.equal(plan.silenceTightening, "tight");
    assert.ok(
      plan.scenes.length > natural.plans.at(-1)!.scenes.length,
      "tightening must have cut the 1.84 s pause into a scene boundary",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("whisper.cpp word output becomes phrase segments with word timings", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wts-whisper-words-"));
  try {
    // A pre-existing model file keeps the provider offline.
    const model = path.join(dir, "ggml-small.bin");
    await writeFile(model, "not-a-real-model");
    const script = path.join(dir, "whisper-cli");
    await writeFile(
      script,
      [
        "#!/bin/sh",
        'prefix=""',
        'prev=""',
        'for arg in "$@"; do',
        '  if [ "$prev" = "-of" ]; then prefix="$arg"; fi',
        '  prev="$arg"',
        "done",
        "cat > \"$prefix.json\" <<'JSON'",
        JSON.stringify({
          transcription: [
            { offsets: { from: 0, to: 110 }, text: "" },
            { offsets: { from: 110, to: 600 }, text: " Silence" },
            { offsets: { from: 600, to: 1170 }, text: " tightening" },
            { offsets: { from: 1170, to: 1500 }, text: " trims." },
            { offsets: { from: 2500, to: 3100 }, text: " Dead" },
            { offsets: { from: 3100, to: 3700 }, text: " air." },
          ],
        }),
        "JSON",
      ].join("\n"),
    );
    await chmod(script, 0o755);
    const provider = new WhisperCLIProvider(model, script);
    const rec = recording("rec-whisper", 30);
    const { output } = await provider.transcribe({
      file: rec.path,
      recording: rec,
    });
    assert.equal(output.provider, "whisper.cpp");
    // The empty leading entry is dropped; sentence punctuation regroups the
    // words into phrase segments that keep their real timings.
    assert.deepEqual(
      output.segments.map((s) => ({
        id: s.id,
        start: s.start,
        end: s.end,
        text: s.text,
        words: s.words?.map((w) => [w.start, w.end, w.text]),
      })),
      [
        {
          id: "segment-1",
          start: 0.11,
          end: 1.5,
          text: "Silence tightening trims.",
          words: [
            [0.11, 0.6, "Silence"],
            [0.6, 1.17, "tightening"],
            [1.17, 1.5, "trims."],
          ],
        },
        {
          id: "segment-2",
          start: 2.5,
          end: 3.7,
          text: "Dead air.",
          words: [
            [2.5, 3.1, "Dead"],
            [3.1, 3.7, "air."],
          ],
        },
      ],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
