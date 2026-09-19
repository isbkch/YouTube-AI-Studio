import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hash, now } from "../packages/shared/src/index.ts";
import { Store } from "../packages/orchestrator/src/store.ts";
import { Studio } from "../packages/orchestrator/src/studio.ts";
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

const WORD = 0.36;
const transcriptWithWords = (
  recordingId: string,
  sentences: { start: number; text: string }[],
): Transcript => ({
  schemaVersion: "1.0.0",
  recordingId,
  language: "en",
  provider: "apple-final-cut",
  model: "speech-analysis-1",
  segments: sentences.map((s, i) => {
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
  }),
});

const SCRIPT = [
  "First thought about caching here.",
  "Second thought was never recorded on set.",
  "Third thought closes the group.",
].join(" ");
const SENTENCES = SCRIPT.split(". ").map((s, i) => (i < 2 ? `${s}.` : s));
const MISSING = SENTENCES[1];

async function temporary<T>(fn: (root: string, store: Store) => Promise<T>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wts-rerecord-"));
  const store = new Store(root);
  try {
    return await fn(root, store);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

/** Media-less project at MEDIA_IMPORTED: take one omits the middle sentence. */
async function partialTakeProject(store: Store) {
  store.setCreator({ ...store.creator(), director: "purist" });
  const p = store.create("Pickup flow", "Sentence-level re-record", 30);
  const studio = new Studio(store);
  await studio.saveScript(p.id, SCRIPT);
  await studio.approveScript(p.id, 1);
  const rec = recording("rec-main", 60);
  store.update(p.id, (x) => {
    x.status = "MEDIA_IMPORTED";
    x.recordings = [rec];
    x.transcripts = [
      transcriptWithWords(rec.id, [
        { start: 5, text: SENTENCES[0] },
        { start: 9, text: SENTENCES[2] },
      ]),
    ];
  });
  return { p, studio };
}

test("the pickup list names the omitted sentence with delivery context", async () =>
  temporary(async (_root, store) => {
    const { p, studio } = await partialTakeProject(store);
    // Before any plan: raw alignment rows.
    const early = await studio.rerecordList(p.id);
    assert.equal(early.planVersion, null);
    assert.equal(early.omitted.length, 1);
    assert.equal(early.omitted[0].text, MISSING);
    assert.equal(early.omitted[0].before, SENTENCES[0]);
    assert.equal(early.omitted[0].after, SENTENCES[2]);
    // After planning: same sentence, now with the editor's recorded reason.
    await studio.generatePlan(p.id);
    const listed = await studio.rerecordList(p.id);
    assert.equal(listed.planVersion, 1);
    assert.equal(listed.omitted.length, 1);
    assert.equal(listed.omitted[0].text, MISSING);
    assert.ok(listed.omitted[0].reason.length > 0);
    assert.equal(listed.included, 2);
    assert.equal(listed.sentences, 3);
    assert.match(listed.next, /pickup take/);
  }));

test("recording the pickup take closes the omissions on re-plan", async () =>
  temporary(async (_root, store) => {
    const { p, studio } = await partialTakeProject(store);
    await studio.generatePlan(p.id);
    const before = store.get(p.id).plans.at(-1)!;
    assert.ok(
      before.scriptCoverage?.sentences.some(
        (s) => s.status === "omitted" && s.text === MISSING,
      ),
      "the middle sentence is omitted before the pickup",
    );
    // The creator records exactly the pickup list and imports it.
    const pickup = recording("rec-pickup", 20);
    store.update(p.id, (x) => {
      x.recordings.push(pickup);
      x.transcripts.push(
        transcriptWithWords(pickup.id, [{ start: 2, text: MISSING }]),
      );
    });
    await studio.generatePlan(p.id);
    const after = store.get(p.id).plans.at(-1)!;
    assert.equal(
      after.scriptCoverage?.sentences.filter((s) => s.status === "omitted")
        .length,
      0,
      "the pickup take supplies the missing sentence",
    );
    const scene = after.scenes.find((s) =>
      s.narration.includes("never recorded"),
    );
    assert.ok(scene, "the pickup sentence has its own scene");
    assert.equal(
      scene.camera.recordingId,
      pickup.id,
      "the scene is cut from the pickup recording",
    );
    const listed = await studio.rerecordList(p.id);
    assert.deepEqual(listed.omitted, []);
  }));

test("rerecordList gates on the same prerequisites as alignment", async () =>
  temporary(async (_root, store) => {
    const p = store.create("Nothing imported", "No media", 30);
    const studio = new Studio(store);
    await studio.saveScript(p.id, "One sentence to speak.");
    await assert.rejects(studio.rerecordList(p.id), /approved script/);
    await studio.approveScript(p.id, 1);
    await assert.rejects(studio.rerecordList(p.id), /Import A-roll/);
  }));
