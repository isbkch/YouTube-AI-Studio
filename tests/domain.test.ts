import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile, readFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../packages/orchestrator/src/store.ts";
import { Studio } from "../packages/orchestrator/src/studio.ts";
import { hash, fileHash } from "../packages/shared/src/index.ts";
import { cachedFile } from "../packages/orchestrator/src/build.ts";
import {
  validateTranscript,
  MockAIProvider,
  DirectorAgent,
} from "../packages/agents/src/index.ts";
import { validateSources } from "../packages/production-plan/src/index.ts";
import { fixture } from "./fixtures.ts";
import {
  makeTimeline,
  segmentArgs,
  toFCPXML,
  toOTIO,
  validateTimeline,
} from "../packages/orchestrator/src/timeline.ts";
import type {
  Asset,
  Job,
  Recording,
} from "../packages/orchestrator/src/model.ts";

const recording: Recording = {
  id: "recording-1",
  name: "source.mp4",
  path: "recordings/source.mp4",
  duration: 3,
  width: 1280,
  height: 720,
  codec: "h264",
  frameRate: 30,
  hasAudio: true,
  audioCodec: "aac",
  bytes: 100,
  hash: hash("source"),
  importedAt: new Date().toISOString(),
  proxyPath: "cache/proxy.mp4",
  proxyStatus: "AVAILABLE",
  frames: 90,
  proxyFrames: 90,
};
const transcript = {
  schemaVersion: "1.0.0" as const,
  recordingId: recording.id,
  language: "en",
  provider: "mock",
  model: "fixture",
  segments: [{ id: "s-1", start: 0, end: 3, text: "A useful explanation." }],
};
async function temporary<T>(fn: (root: string, store: Store) => Promise<T>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wts-domain-"));
  const store = new Store(root);
  try {
    return await fn(root, store);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("saved scripts require exact-version approvals; production cannot bypass gates", async () =>
  temporary(async (_, store) => {
    const studio = new Studio(store);
    const p = store.create("Approval test");
    await assert.rejects(
      studio.importMedia(p.id, "/not/opened.mp4"),
      /script approval/,
    );
    await studio.saveScript(p.id, "First script");
    await assert.rejects(studio.approveScript(p.id, 2), /version changed/);
    await studio.approveScript(p.id, 1);
    await studio.saveScript(p.id, "Changed script");
    assert.equal(store.get(p.id).scriptApproval, null);
    await assert.rejects(studio.approveScript(p.id, 1));
    await studio.approveScript(p.id, 2);
    assert.equal(store.get(p.id).status, "READY_TO_RECORD");
    await assert.rejects(studio.build(p.id));
  }));
test("transcripts reject overlap, out-of-range times, wrong source and duplicate references", () => {
  assert.equal(validateTranscript(transcript, recording).segments.length, 1);
  assert.throws(() =>
    validateTranscript({ ...transcript, recordingId: "wrong" }, recording),
  );
  assert.throws(() =>
    validateTranscript(
      {
        ...transcript,
        segments: [...transcript.segments, ...transcript.segments],
      },
      recording,
    ),
  );
  assert.throws(() =>
    validateTranscript(
      { ...transcript, segments: [{ ...transcript.segments[0], end: 4 }] },
      recording,
    ),
  );
});
test("mock Director validates structured input/output and binds source provenance", async () =>
  temporary(async (_, store) => {
    const p = store.create("Mock director");
    const result = await new DirectorAgent(new MockAIProvider()).plan({
      projectId: p.id,
      script: { version: 1, text: "A useful explanation." },
      recordings: [recording],
      transcripts: [transcript],
      creator: p.creator,
      version: 1,
      targetDuration: 900,
      alignment: null,
    });
    assert.equal(result.output.transcriptHash, hash([transcript]));
    assert.equal(result.output.durationFrames, 90);
    assert.equal(result.usage.costUSD, 0);
  }));
test("mock Director plans multiple recordings in import order with per-clip sources", async () =>
  temporary(async (_, store) => {
    const p = store.create("Multi-clip director");
    const second: Recording = {
      ...recording,
      id: "recording-2",
      name: "take-2.mp4",
      path: "recordings/take-2.mp4",
      duration: 12,
      hash: hash("take-2"),
    };
    const secondTranscript = {
      ...transcript,
      recordingId: second.id,
      segments: [
        { id: "t-2", start: 0, end: 12, text: "The closing thought." },
      ],
    };
    const result = await new DirectorAgent(new MockAIProvider()).plan({
      projectId: p.id,
      script: { version: 1, text: "A useful explanation." },
      recordings: [recording, second],
      transcripts: [transcript, secondTranscript],
      creator: p.creator,
      version: 1,
      targetDuration: 900,
      alignment: null,
    });
    const plan = result.output;
    assert.equal(plan.transcriptHash, hash([transcript, secondTranscript]));
    assert.equal(plan.durationFrames, 90 + 360);
    assert.deepEqual(
      [...new Set(plan.scenes.map((s) => s.camera.recordingId))],
      [recording.id, second.id],
    );
    const firstOfSecond = plan.scenes.find(
      (s) => s.camera.recordingId === second.id,
    )!;
    assert.equal(firstOfSecond.startFrame, 90);
    assert.equal(firstOfSecond.sourceInFrame, 0);
    for (const s of plan.scenes.filter(
      (x) => x.camera.recordingId === second.id,
    ))
      assert.deepEqual(s.transcriptSegmentIds, ["t-2"]);
    for (const s of plan.scenes.filter(
      (x) => x.camera.recordingId === recording.id,
    ))
      assert.deepEqual(s.transcriptSegmentIds, ["s-1"]);
    validateSources(plan, [recording, second], [transcript, secondTranscript]);
  }));
test("source validation allows take selection but rejects bad ranges and mis-scoped transcripts", async () =>
  temporary(async (_, store) => {
    const p = store.create("Source validation");
    const first: Recording = { ...recording, duration: 30 };
    const second: Recording = {
      ...recording,
      id: "recording-2",
      duration: 12,
      hash: hash("take-2"),
    };
    const secondTranscript = {
      ...transcript,
      recordingId: second.id,
      segments: [
        { id: "t-2", start: 0, end: 12, text: "The closing thought." },
      ],
    };
    const base = await new DirectorAgent(new MockAIProvider()).plan({
      projectId: p.id,
      script: { version: 1, text: "A useful explanation." },
      recordings: [first, second],
      transcripts: [transcript, secondTranscript],
      creator: p.creator,
      version: 1,
      targetDuration: 900,
      alignment: null,
    });
    const sources = [first, second];
    validateSources(base.output, sources, [transcript, secondTranscript]);
    // The A-roll editor may drop a take entirely.
    const skipped = structuredClone(base.output);
    skipped.scenes = skipped.scenes.filter(
      (s) => s.camera.recordingId === first.id,
    );
    validateSources(skipped, sources, [transcript, secondTranscript]);
    const unknownRecording = structuredClone(base.output);
    unknownRecording.scenes[0].camera.recordingId = "recording-404";
    assert.throws(
      () =>
        validateSources(unknownRecording, sources, [
          transcript,
          secondTranscript,
        ]),
      /unknown recording/,
    );
    const beyondEnd = structuredClone(base.output);
    beyondEnd.scenes[0].sourceInFrame = 25 * 30;
    beyondEnd.scenes[0].durationFrames = 10 * 30;
    assert.throws(
      () => validateSources(beyondEnd, sources, [transcript, secondTranscript]),
      /source range exceeds/,
    );
    const misScoped = structuredClone(base.output);
    const secondScene = misScoped.scenes.find(
      (s) => s.camera.recordingId === second.id,
    )!;
    secondScene.transcriptSegmentIds = ["s-1"];
    assert.throws(
      () => validateSources(misScoped, sources, [transcript, secondTranscript]),
      /scene's recording/,
    );
  }));
test("source validation rejects replayed frames, unspoken narration and stray segment links", async () =>
  temporary(async (_, store) => {
    store.create("Hard source validation");
    const rec: Recording = { ...recording, duration: 10, proxyFrames: 300 };
    const spoken = {
      ...transcript,
      segments: [
        { id: "s-1", start: 0, end: 2, text: "Alpha beta gamma delta." },
        { id: "s-2", start: 2, end: 4, text: "Epsilon zeta eta theta." },
        { id: "far", start: 8, end: 10, text: "Much later material." },
      ],
    };
    const scene = (
      over: Partial<ReturnType<typeof fixture>["scenes"][number]>,
    ) => structuredClone({ ...fixture().scenes[0], ...over });
    const build = (scenes: ReturnType<typeof scene>[]) => {
      let cursor = 0;
      const timed = scenes.map((s, i) => {
        const withTiming = { ...s, id: `scene-${i + 1}`, startFrame: cursor };
        cursor += withTiming.durationFrames;
        return withTiming;
      });
      return structuredClone({
        ...fixture(),
        durationFrames: cursor,
        scenes: timed,
      });
    };
    // Two scenes from the same recording replaying source frames.
    const replay = build([
      scene({
        sourceInFrame: 0,
        durationFrames: 60,
        narration: "Alpha beta gamma delta.",
      }),
      scene({
        sourceInFrame: 30,
        durationFrames: 60,
        narration: "Epsilon zeta eta theta.",
      }),
    ]);
    assert.throws(
      () => validateSources(replay, [rec], [spoken]),
      /replay the same source frames/,
    );
    // Narration claims speech that is not inside the selected range.
    const unspoken = build([
      scene({
        sourceInFrame: 0,
        durationFrames: 60,
        narration: "Lambda mu nu xi omicron pi rho sigma tau.",
      }),
    ]);
    assert.throws(
      () => validateSources(unspoken, [rec], [spoken]),
      /not spoken inside the selected source range/,
    );
    // Paraphrase inside the range stays valid.
    const paraphrased = build([
      scene({
        sourceInFrame: 0,
        durationFrames: 60,
        narration: "Alpha gamma beta delta similar phrasing.",
      }),
    ]);
    validateSources(paraphrased, [rec], [spoken]);
    // A transcript link pointing outside the selected range.
    const stray = build([
      scene({
        sourceInFrame: 0,
        durationFrames: 60,
        narration: "Alpha beta gamma delta.",
        transcriptSegmentIds: ["far"],
      }),
    ]);
    assert.throws(
      () => validateSources(stray, [rec], [spoken]),
      /lies outside the selected source range/,
    );
    // One frame past the deterministic proxy bound is rejected.
    const overhang = build([
      scene({
        sourceInFrame: 300 - 30,
        durationFrames: 31,
        narration: "Alpha beta gamma delta.",
      }),
    ]);
    assert.throws(
      () => validateSources(overhang, [rec], [spoken]),
      /source range exceeds/,
    );
  }));
test("transcript loading targets each recording once and accepts explicit IDs", async () =>
  temporary(async (_, store) => {
    const studio = new Studio(store);
    const p = store.create("Transcript targeting");
    const second: Recording = {
      ...recording,
      id: "recording-2",
      name: "take-2.mp4",
      path: "recordings/take-2.mp4",
      duration: 3,
      hash: hash("take-2"),
    };
    store.update(p.id, (x) => {
      x.status = "MEDIA_IMPORTED";
      x.recordings = [recording, second];
    });
    const payload = (id: string) => ({
      schemaVersion: "1.0.0",
      language: "en",
      provider: "mock",
      model: "fixture",
      segments: [{ id, start: 0, end: 3, text: "A useful explanation." }],
    });
    await studio.loadTranscript(p.id, payload("a-1"));
    await studio.loadTranscript(p.id, payload("b-1"));
    const saved = store.get(p.id).transcripts;
    assert.deepEqual(
      saved.map((t) => t.recordingId),
      [recording.id, second.id],
    );
    await assert.rejects(
      studio.loadTranscript(p.id, payload("c-1")),
      /already has a transcript/,
    );
    await assert.rejects(
      studio.loadTranscript(p.id, payload("d-1"), "recording-9"),
      /No imported recording matches/,
    );
    assert.equal(store.get(p.id).transcripts.length, 2);
  }));
test("scoped edits preserve history, invalidate approvals, reject stale proposals and support undo", async () =>
  temporary(async (_, store) => {
    const studio = new Studio(store);
    const p = store.create("Revision test");
    const plan = fixture();
    plan.projectId = p.id;
    plan.transcriptHash = hash(transcript);
    const original = structuredClone(plan);
    store.update(p.id, (x) => {
      x.status = "AWAITING_ROUGH_CUT_APPROVAL";
      x.plans = [plan];
      x.recordings = [recording];
      x.transcripts = [transcript];
      x.planApproval = {
        version: 1,
        hash: hash(plan),
        approvedAt: new Date().toISOString(),
        approvedBy: "creator",
      };
    });
    const a = await studio.proposeOperations(
      p.id,
      [
        {
          type: "updateFraming",
          sceneId: "scene-1",
          framing: "close",
          punchIn: 1.2,
        },
      ],
      "Emphasize this explanation",
    );
    const b = await studio.proposeOperations(
      p.id,
      [{ type: "removeGraphic", sceneId: "scene-1" }],
      "Keep it simple",
    );
    await studio.decidePatch(p.id, a.id, true);
    assert.deepEqual(store.get(p.id).plans[0], original);
    assert.equal(store.get(p.id).planApproval, null);
    assert.equal(store.get(p.id).status, "AWAITING_STORYBOARD_APPROVAL");
    await assert.rejects(studio.decidePatch(p.id, b.id, true), /stale/);
    await studio.undo(p.id);
    const current = store.get(p.id);
    assert.equal(current.plans.length, 3);
    assert.equal(current.plans[2].scenes[0].camera.punchIn, 1);
    assert.equal(current.plans[2].version, 3);
    assert.equal(current.revisions[0].status, "APPLIED");
  }));
test("cache verifies bytes, rerenders corruption, and never caches failed work", async () =>
  temporary(async (_, store) => {
    const p = store.create("Cache test"),
      dir = store.dir(p),
      key = hash("instruction");
    let renders = 0;
    const render = async (file: string) => {
      renders++;
      await writeFile(file, "valid media stand-in");
    };
    const a = await cachedFile(dir, key, "assets/generated/test.mp4", render);
    const b = await cachedFile(dir, key, "assets/generated/test.mp4", render);
    assert.equal(a.reused, false);
    assert.equal(b.reused, true);
    assert.equal(renders, 1);
    await writeFile(path.join(dir, a.path), "corrupted");
    await cachedFile(dir, key, a.path, render);
    assert.equal(renders, 2);
    const old = await fileHash(path.join(dir, a.path));
    await assert.rejects(
      cachedFile(dir, hash("new-instruction"), a.path, async () => {
        throw Error("Renderer died");
      }),
    );
    assert.equal(await fileHash(path.join(dir, a.path)), old);
  }));
test("timeline export retains separate narration, presenter, and graphic tracks", () => {
  const p = fixture();
  const t = makeTimeline(p, [recording], new Map());
  // v1 presenter, v2 graphics, v3 B-roll insets (empty), a1 narration.
  assert.equal(t.tracks.length, 4);
  assert.equal(t.tracks[3].clips[0].sourceInFrame, 0);
  assert.ok(
    toFCPXML(t, "/Projects/My & Project").includes(
      "file:///Projects/My%20&amp;%20Project/",
    ),
  );
  const otio = toOTIO(t, "/Projects/My Project");
  assert.equal(otio.tracks.children.length, 4);
  t.tracks[0].clips[0].durationFrames = 200;
  assert.throws(() => validateTimeline(t));
});
test("FCPXML clip timings match the plan exactly and graphics attach at the scene start", () => {
  const plan = fixture();
  plan.scenes = [
    {
      ...plan.scenes[0],
      id: "scene-1",
      startFrame: 0,
      durationFrames: 71,
      sourceInFrame: 2035,
      visual: {
        type: "graphic",
        description: "Graphic",
        graphic: {
          engine: "remotion",
          template: "Callout",
          templateVersion: "1.0.0",
          parameters: { title: "Works is not ready", subtitle: "" },
        },
      },
    },
    {
      ...plan.scenes[0],
      id: "scene-2",
      startFrame: 71,
      durationFrames: 49,
      sourceInFrame: 120,
    },
  ];
  plan.durationFrames = 120;
  const rec: Recording = { ...recording, duration: 100, proxyFrames: 3000 };
  const graphicAsset = {
    assetId: "asset-graphic",
    type: "remotion-render" as const,
    sceneId: "scene-1",
    productionPlanVersion: plan.version,
    generator: "remotion",
    template: "Callout",
    templateVersion: "1.0.0",
    parameters: {},
    inputHash: "k",
    outputHash: hash("graphic"),
    createdAt: new Date().toISOString(),
    path: "assets/graphics/scene-1.mp4",
    jobId: "job-1",
    reused: false,
    sourceAssets: [],
    renderMs: 1,
  };
  const xml = toFCPXML(
    makeTimeline(plan, [rec], new Map([["scene-1", graphicAsset]])),
    "/Projects/P",
  );
  const clips = [...xml.matchAll(/<asset-clip name="scene-\d+"[^>]*>/g)].map(
    (m) => m[0],
  );
  assert.equal(clips.length, 2);
  const attrs = (clip: string) => ({
    offset: /offset="([^"]+)"/.exec(clip)![1],
    start: / start="([^"]+)"/.exec(clip)![1],
    duration: /duration="([^"]+)"/.exec(clip)![1],
  });
  assert.deepEqual(attrs(clips[0]), {
    offset: "0/30s",
    start: "2035/30s",
    duration: "71/30s",
  });
  assert.deepEqual(attrs(clips[1]), {
    offset: "71/30s",
    start: "120/30s",
    duration: "49/30s",
  });
  // Connected graphics and markers are anchored to their parent scene, never
  // to the presenter's source offset.
  const graphic = /<asset-clip lane="1"[^>]*>/.exec(xml)![0];
  assert.match(graphic, /offset="0s"/);
  assert.match(xml, /<marker start="0s"/);
});
test("segment encodes pin exact output frame counts", () => {
  const plain = segmentArgs({
    source: "proxy.mp4",
    graphic: null,
    sourceStart: 2035 / 30,
    duration: 241 / 30,
    punchIn: 1,
    gainDb: 0,
    hasAudio: true,
    output: "segment.mp4",
  });
  const framesAt = plain.indexOf("-frames:v");
  assert.deepEqual(
    [plain[framesAt + 1], plain.indexOf("-t") >= 0],
    ["241", true],
  );
  // -t keeps a half-frame margin so the padded audio never truncates video.
  assert.equal(plain[plain.indexOf("-t") + 1], String(241 / 30 + 1 / 60));
  const overlaid = segmentArgs({
    source: "proxy.mp4",
    graphic: null,
    sourceStart: 0,
    duration: 2,
    punchIn: 1,
    gainDb: 0,
    hasAudio: true,
    output: "segment.mp4",
    overlays: [
      {
        clip: "broll.mp4",
        x: 0,
        y: 0,
        width: 100,
        height: 66,
        startSec: 0,
        endSec: 1,
        fadeInSec: 0,
        fadeOutSec: 0,
      },
    ],
  });
  assert.ok(overlaid.includes("-filter_complex"));
  assert.equal(overlaid[overlaid.indexOf("-frames:v") + 1], "60");
});
test("crashed worker lock is reclaimed and transient state becomes recoverable", async () =>
  temporary(async (_, store) => {
    const p = store.create("Recovery");
    store.update(p.id, (x) => {
      x.status = "TRANSCRIBING";
    });
    store.db
      .prepare("INSERT INTO locks VALUES(?,?,?)")
      .run(p.id, 2147483647, "dead-worker");
    const release = store.acquire(p.id);
    assert.equal(store.get(p.id).status, "MEDIA_IMPORTED");
    release();
  }));
test("version artifacts reject symlink directory escapes", async () =>
  temporary(async (root, store) => {
    const p = store.create("Path safety");
    const dir = store.dir(p);
    await rm(path.join(dir, "production-plans"), { recursive: true });
    await symlink(root, path.join(dir, "production-plans"));
    await assert.rejects(
      store.artifact(p, "production-plans/plan.json", {}),
      /Symlinks/,
    );
    await assert.rejects(readFile(path.join(root, "plan.json")));
  }));

test("explicit recovery refuses a live owner and restores an orphaned transient stage", async () =>
  temporary(async (_, store) => {
    const p = store.create("Explicit recovery");
    const studio = new Studio(store);
    store.update(p.id, (x) => {
      x.status = "TRANSCRIBING";
    });
    const release = store.acquire(p.id);
    await assert.rejects(studio.recover(p.id), /active operation/);
    release();
    const recovered = await studio.recover(p.id);
    assert.equal(recovered.status, "MEDIA_IMPORTED");
  }));

test("committed demo plan and Director output share valid transcript provenance", async () => {
  const t = JSON.parse(
    await readFile("examples/redundancy/transcript.json", "utf8"),
  );
  const { validatePlan } =
    await import("../packages/production-plan/src/index.ts");
  const plan = validatePlan(
    JSON.parse(
      await readFile("examples/redundancy/production-plan.json", "utf8"),
    ),
  );
  const director = validatePlan(
    JSON.parse(
      await readFile("examples/redundancy/director-response.json", "utf8"),
    ),
  );
  assert.equal(plan.transcriptHash, hash([t]));
  assert.deepEqual(plan, director);
  assert.ok(plan.scenes.length >= 1);
  assert.equal(plan.schemaVersion, "4.3.0");
});

const sampleJob = (projectId: string): Job => ({
  id: "job-1",
  projectId,
  runId: "run-1",
  type: "import",
  label: "Inspect and import A-roll",
  status: "COMPLETE",
  dependencies: [],
  progress: 1,
  logs: [],
  startedAt: "t",
  completedAt: "t",
  error: null,
  retryCount: 0,
  producedAssets: [],
});
const sampleAsset = (projectId: string): Asset => ({
  assetId: "asset-1",
  type: "proxy",
  sceneId: null,
  productionPlanVersion: 1,
  generator: "ffmpeg",
  template: null,
  templateVersion: null,
  parameters: {},
  inputHash: hash("input"),
  outputHash: hash("output"),
  createdAt: "t",
  path: "cache/proxy.mp4",
  jobId: "job-1",
  reused: false,
  sourceAssets: [],
  renderMs: 1,
});
test("deleting a project removes its workspace including imported recording copies", async () =>
  temporary(async (root, store) => {
    const studio = new Studio(store);
    const p = store.create("Delete me");
    const dir = store.dir(p);
    await writeFile(
      path.join(dir, "recordings", "source.mp4"),
      "imported copy",
    );
    await writeFile(path.join(dir, "renders", "rough.mp4"), "derived");
    store.update(p.id, (x) => {
      x.recordings.push(recording);
    });
    store.job(sampleJob(p.id));
    store.asset(p.id, sampleAsset(p.id));
    store.event(p.id, { event: "project.created" });
    const result = await studio.deleteProject(p.id);
    assert.equal(result.title, "Delete me");
    assert.equal(result.recordingsRemoved, 1);
    // The imported copy went away with the workspace; no preservation folder
    // is created (originals live outside the library and are never touched).
    assert.equal(existsSync(dir), false);
    assert.equal(existsSync(path.join(root, "preserved")), false);
    assert.deepEqual(store.list(), []);
    assert.throws(() => store.get(p.id), /does not exist/);
    assert.deepEqual(store.jobs(p.id), []);
    assert.deepEqual(store.assets(p.id), []);
    assert.deepEqual(store.events(p.id), []);
    await assert.rejects(studio.deleteProject(p.id), /does not exist/);
  }));
test("deleting tolerates projects without footage and missing recording files", async () =>
  temporary(async (_, store) => {
    const studio = new Studio(store);
    const empty = await studio.deleteProject(store.create("Empty").id);
    assert.equal(empty.recordingsRemoved, 0);
    const lost = store.create("Lost footage");
    store.update(lost.id, (x) => {
      x.recordings.push({
        ...recording,
        id: "recording-gone",
        name: "gone.mp4",
      });
    });
    const result = await studio.deleteProject(lost.id);
    assert.equal(result.recordingsRemoved, 1);
    assert.equal(existsSync(store.dir(lost)), false);
    assert.deepEqual(store.list(), []);
  }));
test("deleting a project refuses a live owner's lock", async () =>
  temporary(async (_, store) => {
    const studio = new Studio(store);
    const p = store.create("Busy");
    const release = store.acquire(p.id);
    await assert.rejects(studio.deleteProject(p.id), /active operation/);
    release();
    await studio.deleteProject(p.id);
    assert.deepEqual(store.list(), []);
  }));
