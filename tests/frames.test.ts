import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../packages/orchestrator/src/store.ts";
import { Studio } from "../packages/orchestrator/src/studio.ts";
import { planFrameCandidates } from "../packages/orchestrator/src/frames.ts";
import type { CaptionEvent } from "../packages/orchestrator/src/captions.ts";
import type { Recording } from "../packages/orchestrator/src/model.ts";
import { ffmpeg } from "../packages/media/src/index.ts";
import { fixture } from "./fixtures.ts";

const event = (
  id: string,
  startFrame: number,
  words: [number, string][],
): CaptionEvent => ({
  id,
  sceneId: "scene-1",
  startFrame,
  endFrame: startFrame + 90,
  text: words.map(([, text]) => text).join(" "),
  words: words.map(([atFrame, text]) => ({ atFrame, text })),
});

test("candidates rank punchlines by vocal energy, chapters trail, spacing holds", () => {
  const envelope = [
    { seconds: 30, loudnessDb: -20 },
    { seconds: 100, loudnessDb: -10 },
    { seconds: 100.5, loudnessDb: -8 },
  ];
  const candidates = planFrameCandidates(
    [
      event("c1", 30 * 30, [
        [900, "never"],
        [905, " trust"],
        [910, " defaults"],
      ]),
      event("c2", 100 * 30, [
        [3000, "the"],
        [3010, "trap"],
        [3020, "is"],
        [3015, "here"],
      ]),
      event("c3", 100.5 * 30, [
        [3015, "here"],
        [3020, "again"],
      ]),
    ],
    [{ seconds: 0 }, { seconds: 200 }],
    envelope,
    30,
    240,
  );
  // Punchline at ~100.7s carries the most energy; its ~100.5s neighbour is
  // spaced out; the quieter punchline and the chapter beats follow in order.
  assert.deepEqual(
    candidates.map((c) => Math.round(c.seconds * 100) / 100),
    [100.67, 30.17, 0, 200],
  );
  assert.equal(candidates[0].captionText, "the trap is here");
  assert.equal(
    candidates[2].captionText,
    null,
    "chapter beats carry no caption",
  );
  assert.equal(candidates[2].loudnessDb, null);
  assert.equal(candidates[0].loudnessDb, -9);
  // The count cap and clamping hold; nothing past the master's end.
  const capped = planFrameCandidates(
    [
      event("a", 30 * 30, [
        [900, "x"],
        [905, "y"],
        [910, "z"],
      ]),
      event("b", 60 * 30, [
        [1800, "x"],
        [1805, "y"],
        [1810, "z"],
      ]),
    ],
    [{ seconds: 0 }],
    [],
    30,
    240,
    2,
  );
  assert.equal(capped.length, 2);
  const clamped = planFrameCandidates(
    [
      event("late", 300 * 30, [
        [9000, "x"],
        [9005, "y"],
        [9010, "z"],
      ]),
    ],
    [],
    [],
    30,
    240,
  );
  assert.equal(clamped[0].seconds, 240);
  assert.deepEqual(planFrameCandidates([], [], [], 30, 240), []);
});

test("expressive frames are cut from the master and cached against its bytes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wts-frames-"));
  const store = new Store(root);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const studio = new Studio(store);
  const project = store.create("Frames", "Talking-head idea", 60);
  const dir = store.dir(project);
  await mkdir(path.join(dir, "renders"), { recursive: true });
  const master = path.join(dir, "renders/final.mp4");
  await ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "testsrc=duration=4:size=640x360:rate=30",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=4",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    master,
  ]);
  const plan = structuredClone(fixture());
  plan.projectId = project.id;
  const recording: Recording = {
    id: "recording-1",
    name: "take.mp4",
    path: master,
    hash: "fixture",
    importedAt: new Date().toISOString(),
    proxyPath: null,
    proxyStatus: "NOT_REQUIRED",
    proxyFrames: null,
    duration: 4,
    width: 640,
    height: 360,
    codec: "h264",
    frameRate: 30,
    hasAudio: true,
    audioCodec: "aac",
    bytes: 0,
    frames: 120,
  };
  const transcript = {
    schemaVersion: "1.0.0" as const,
    recordingId: "recording-1",
    language: "en",
    provider: "mock",
    model: "fixture",
    segments: [
      {
        id: "seg-1",
        start: 0.2,
        end: 2.2,
        text: "It turns out indexes never sleep.",
        words: [
          { start: 0.2, end: 0.4, text: "It" },
          { start: 0.4, end: 0.6, text: "turns" },
          { start: 0.6, end: 0.8, text: "out" },
          { start: 0.8, end: 1.1, text: "indexes" },
          { start: 1.1, end: 1.4, text: "never" },
          { start: 1.4, end: 1.8, text: "sleep." },
        ],
      },
    ],
  };
  store.update(project.id, (x) => {
    x.plans = [plan];
    x.finalRender = "renders/final.mp4";
    x.recordings = [recording];
    x.transcripts = [transcript];
  });
  const first = await studio.thumbnailFrames(project.id);
  assert.equal(first.cached, false);
  assert.ok(first.frames.length >= 1, "at least one punchline frame");
  const punchline = first.frames.find((f) => f.captionText !== null);
  assert.ok(punchline, "the caption picker found the spoken punchline");
  assert.match(punchline!.captionText!, /indexes never sleep/);
  assert.ok(punchline!.seconds > 0 && punchline!.seconds < 4);
  for (const frame of first.frames) {
    const info = await stat(path.join(dir, frame.path));
    assert.ok(info.size > 0, `frame ${frame.id} has bytes on disk`);
  }
  // The cache returns identical items without recutting.
  const second = await studio.thumbnailFrames(project.id);
  assert.equal(second.cached, true);
  assert.deepEqual(second.frames, first.frames);
  assert.equal(
    store.get(project.id).thumbnailFrames?.finalRenderHash,
    store.get(project.id).thumbnailFrames?.finalRenderHash,
  );
  // Without a final render there is nothing to cut from.
  const empty = store.create("No render", "Idea", 60);
  await assert.rejects(() => studio.thumbnailFrames(empty.id), /final render/);
});
