import { test } from "node:test";
import assert from "node:assert/strict";
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
import { fixture } from "./fixtures.ts";
import {
  makeTimeline,
  toFCPXML,
  toOTIO,
  validateTimeline,
} from "../packages/orchestrator/src/timeline.ts";
import type { Recording } from "../packages/orchestrator/src/model.ts";

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
      /Approve/,
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
      recording,
      transcript,
      creator: p.creator,
      version: 1,
    });
    assert.equal(result.output.transcriptHash, hash(transcript));
    assert.equal(result.output.durationFrames, 90);
    assert.equal(result.usage.costUSD, 0);
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
  assert.equal(t.tracks.length, 3);
  assert.equal(t.tracks[2].clips[0].sourceInFrame, 0);
  assert.ok(
    toFCPXML(t, "/Projects/My & Project").includes(
      "file:///Projects/My%20&amp;%20Project/",
    ),
  );
  const otio = toOTIO(t, "/Projects/My Project");
  assert.equal(otio.tracks.children.length, 3);
  t.tracks[0].clips[0].durationFrames = 200;
  assert.throws(() => validateTimeline(t));
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
