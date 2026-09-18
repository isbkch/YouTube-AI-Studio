import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  mockPlan,
  mockVisualPass,
  type DirectorInput,
  type VisualPassCapabilities,
} from "../packages/agents/src/index.ts";
import { buildEditDecision } from "../packages/orchestrator/src/aroll.ts";
import { alignScript } from "../packages/orchestrator/src/alignment.ts";
import { MockBlenderProvider } from "../packages/blender-engine/src/index.ts";
import { Studio } from "../packages/orchestrator/src/studio.ts";
import { Store } from "../packages/orchestrator/src/store.ts";
import {
  PREVIEW_JOB_ID,
  renderStoryboardPreviews,
} from "../packages/orchestrator/src/previews.ts";
import { fixture } from "./fixtures.ts";
import {
  defaultCreator,
  hash,
  now,
  type CreatorProfile,
  type VisualDensity,
} from "../packages/shared/src/index.ts";
import type {
  Recording,
  Transcript,
} from "../packages/orchestrator/src/model.ts";
import {
  validatePlan,
  type BRollEntry,
  type ProductionPlan,
} from "../packages/production-plan/src/index.ts";

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
const transcriptWithWords = (
  recordingId: string,
  sentences: { start: number; text: string }[],
): Transcript => ({
  schemaVersion: "1.0.0",
  recordingId,
  language: "en",
  provider: "mock",
  model: "fixture",
  segments: sentences.map((s, i) => ({
    id: `segment-${i}`,
    start: s.start,
    end: s.start + 2,
    text: s.text,
    words: s.text.split(" ").map((w, j) => ({
      start: s.start + (j * 1.8) / s.text.split(" ").length,
      end: s.start + ((j + 1) * 1.8) / s.text.split(" ").length,
      text: w,
    })),
  })),
});
const creatorWithDensity = (density: VisualDensity): CreatorProfile => ({
  ...structuredClone(defaultCreator),
  visualDensity: density,
});

test("visual density steers the mock Director's demo pattern and is stamped on the plan", () => {
  const rec = recording("rec-demo", 12);
  const tr = transcriptWithWords(rec.id, [
    { start: 0, text: "Careful engineers measure requests." },
    { start: 3, text: "Database backups need restoration drills." },
    { start: 6, text: "Monitoring reveals failures overnight." },
    { start: 9, text: "Redundancy keeps the path alive." },
  ]);
  const base: DirectorInput = {
    projectId: "project-1",
    script: {
      version: 1,
      text: tr.segments.map((s) => s.text).join(" "),
    },
    recordings: [rec],
    transcripts: [tr],
    creator: structuredClone(defaultCreator),
    version: 1,
    targetDuration: 12,
    alignment: null,
  };
  const graphics = (density: VisualDensity) => {
    const plan = mockPlan({ ...base, creator: creatorWithDensity(density) });
    assert.equal(plan.visualDensity, density);
    return plan.scenes.filter((s) => s.visual.graphic !== null).length;
  };
  // One 12 s recording becomes four demo scenes: minimal keeps the presenter,
  // balanced keeps the callout and the architecture flow, rich adds one more.
  assert.deepEqual(
    [graphics("minimal"), graphics("balanced"), graphics("rich")],
    [0, 2, 3],
  );
});

test("visual density steers the A-roll graphic throttle", () => {
  const rec = recording("rec-throttle", 60);
  const requests = Array.from(
    { length: 8 },
    (_, i) =>
      `Call GET /api/resource-${i} to list the records before moving on.`,
  );
  const alignment = alignScript({
    script: requests.join(" "),
    scriptVersion: 1,
    recordings: [rec],
    transcripts: [
      transcriptWithWords(
        rec.id,
        requests.map((text, i) => ({
          start: 2 + i * 4,
          text,
        })),
      ),
    ],
  });
  assert.equal(alignment.stats.matched, 8);
  const suggested = (density: VisualDensity) =>
    buildEditDecision(alignment, [], density).scenes.filter(
      (s) => s.suggestedGraphic,
    ).length;
  const [minimal, balanced, rich] = [
    suggested("minimal"),
    suggested("balanced"),
    suggested("rich"),
  ];
  assert.ok(
    minimal < balanced && balanced < rich,
    `density must thin graphics monotonically, got ${minimal}/${balanced}/${rich}`,
  );
});

test("visual density steers the mock visual pass", () => {
  const capabilities: VisualPassCapabilities = {
    "gpt-image": { model: "gpt-image-1" },
    blender: { engine: "blender", version: "deterministic-v1" },
    musicGeneration: null,
    musicTracks: [],
    sfxTracks: [],
  };
  const plan: ProductionPlan = validatePlan({
    ...fixture(),
    durationFrames: 360,
    scenes: Array.from({ length: 4 }, (_, i) => ({
      ...fixture().scenes[0],
      id: `scene-${i + 1}`,
      startFrame: i * 90,
      narration: `Scene ${i + 1} discusses the server rack and data center rooms.`,
    })),
  });
  const pass = (density: VisualDensity) =>
    mockVisualPass({
      plan,
      capabilities,
      budget: { maxGeneratedStills: 8 },
      creator: creatorWithDensity(density),
    });
  assert.equal(pass("minimal").treatments.length, 0);
  const balanced = pass("balanced");
  assert.equal(balanced.treatments.length, 2);
  assert.equal(balanced.treatments[0].broll[0].asset.engine, "blender");
  const rich = pass("rich");
  assert.equal(rich.treatments.length, 3);
  assert.equal(
    rich.treatments.filter((t) => t.broll[0].asset.engine === "blender").length,
    2,
  );
});

test("generatePlan honors the density override and records it on the plan", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wts-density-"));
  const store = new Store(root);
  try {
    const p = store.create("Density override");
    const studio = new Studio(store);
    await studio.saveScript(p.id, "Presenter explains the system.");
    await studio.approveScript(p.id, 1);
    const rec = recording("rec-plan", 12);
    store.update(p.id, (x) => {
      x.recordings = [rec];
      x.transcripts = [
        transcriptWithWords(rec.id, [
          { start: 0, text: "Presenter explains the system." },
          { start: 4, text: "Second sentence for the cut." },
          { start: 8, text: "Third sentence closes the thought." },
        ]),
      ];
      x.status = "MEDIA_IMPORTED";
    });
    await studio.generatePlan(p.id, { density: "rich" });
    assert.equal(store.get(p.id).plans.at(-1)!.visualDensity, "rich");
    await studio.generatePlan(p.id, { density: "minimal" });
    assert.equal(store.get(p.id).plans.at(-1)!.visualDensity, "minimal");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy creator profiles hire the craftsman, who owns the derived knobs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wts-legacy-"));
  const store = new Store(root);
  try {
    const studio = new Studio(store);
    // A profile persisted before the director existed has no director key and
    // no knobs; it reads back as the craftsman with the persona's bundle.
    const legacy = JSON.parse(JSON.stringify(defaultCreator));
    delete legacy.director;
    delete legacy.visualDensity;
    delete legacy.silenceTightening;
    const saved = studio.setCreator(legacy);
    assert.equal(saved.director, "craftsman");
    assert.equal(saved.visualDensity, "rich");
    assert.equal(saved.silenceTightening, "tight");
    const profile = store.creator();
    assert.equal(profile.director, "craftsman");
    assert.equal(profile.visualDensity, "rich");
    assert.equal(profile.silenceTightening, "tight");
    const project = store.create("Legacy director");
    assert.equal(store.get(project.id).creator.director, "craftsman");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const blenderEntry = (): BRollEntry =>
  ({
    id: "broll-1",
    startFrame: 12,
    durationFrames: 48,
    placement: "inset",
    inset: { x: 0.55, y: 0.5, width: 0.38 },
    motion: "zoom-in",
    asset: {
      engine: "blender",
      template: "NetworkFlow",
      templateVersion: "1.0.0",
      parameters: {
        template: "NetworkFlow",
        nodes: ["edge", "api", "db"],
        packets: 6,
      },
    },
    narrationHook: "requests flowing through redundant services",
  }) as BRollEntry;

const previewProject = async (store: Store) => {
  const p = store.create("Storyboard previews");
  const plan = validatePlan({
    ...fixture(),
    projectId: p.id,
    scenes: [{ ...fixture().scenes[0], broll: [blenderEntry()] }],
  });
  store.update(p.id, (x) => {
    x.plans = [plan];
    x.status = "AWAITING_STORYBOARD_APPROVAL";
  });
  return p;
};

test("storyboard previews render 3D entries, record assets and reuse the cache", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wts-previews-"));
  const store = new Store(root);
  try {
    const p = await previewProject(store);
    const studio = new Studio(store);
    studio.blender = new MockBlenderProvider();
    await studio.renderPreviews(p.id);
    let clips = store.assets(p.id).filter((a) => a.type === "broll-clip");
    assert.equal(clips.length, 1);
    assert.equal(clips[0].jobId, PREVIEW_JOB_ID);
    assert.equal(clips[0].productionPlanVersion, 1);
    assert.equal(clips[0].reused, false);
    assert.ok(clips[0].renderMs > 0);
    assert.ok(
      store
        .events(p.id)
        .some(
          (row) => JSON.parse(String(row.data)).event === "previews.rendered",
        ),
    );
    // A second pass hits the same cache key: fresh provenance, zero re-render.
    await studio.renderPreviews(p.id);
    clips = store.assets(p.id).filter((a) => a.type === "broll-clip");
    assert.equal(clips.length, 2);
    assert.equal(clips[1].reused, true);
    assert.equal(clips[1].renderMs, 0);
    assert.equal(clips[0].path, clips[1].path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("storyboard previews skip 3D entries when Blender is unavailable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wts-previews-null-"));
  const store = new Store(root);
  try {
    const created = await previewProject(store);
    const project = store.get(created.id);
    const result = await renderStoryboardPreviews({
      store,
      project,
      plan: project.plans[0],
      blender: null,
    });
    assert.equal(result.outcomes.length, 1);
    assert.match(result.outcomes[0].skipped!, /Blender is not available/);
    assert.equal(result.outcomes[0].asset, null);
    assert.equal(
      store.assets(created.id).filter((a) => a.type === "broll-clip").length,
      0,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
