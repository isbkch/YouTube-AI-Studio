import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hash, now } from "../packages/shared/src/index.ts";
import {
  MAX_OMISSION_RATIO,
  reviewRoughCut,
  reviewStoryboard,
} from "../packages/orchestrator/src/producer.ts";
import { Store } from "../packages/orchestrator/src/store.ts";
import { Studio } from "../packages/orchestrator/src/studio.ts";
import { fixture } from "./fixtures.ts";
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

const coveredPlan = (
  statuses: ("included" | "omitted")[],
  overrides: Record<string, unknown> = {},
) => ({
  ...fixture(),
  scriptCoverage: {
    sentences: statuses.map((status, i) => ({
      text: `Sentence number ${i + 1} about reliability.`,
      status,
      sceneId: status === "included" ? "scene-1" : null,
      reason: status === "omitted" ? "No take matched this sentence." : null,
    })),
  },
  ...overrides,
});

test("storyboard review approves a covered, on-target plan", () => {
  const review = reviewStoryboard(coveredPlan(["included", "included"]), 6);
  assert.equal(review.verdict, "approved");
  assert.equal(review.gate, "storyboard");
  assert.equal(review.reviewer, "deterministic-v1");
  assert.equal(review.evidence.sentences, 2);
  assert.equal(review.evidence.omitted, 0);
  assert.equal(review.evidence.scenes, 1);
  // validateSources honesty is recorded as evidence, not re-derived.
  assert.ok(
    review.findings.some((f) => f.code === "sources.validated"),
    "records the validateSources evidence check",
  );
  assert.ok(!review.findings.some((f) => f.severity === "blocker"));
});

test("omission ratio above 25% blocks; reasoned omissions only warn", () => {
  const ratio = (omitted: number, total: number) =>
    reviewStoryboard(
      coveredPlan(
        Array.from({ length: total }, (_, i) =>
          i < omitted ? "omitted" : "included",
        ),
      ),
      6,
    ).findings;
  // 1 of 3 (33%) crosses the ceiling.
  const blocked = ratio(1, 3);
  assert.ok(
    blocked.some(
      (f) =>
        f.severity === "blocker" &&
        f.code === "coverage.omissionRatio" &&
        f.message.includes("33%"),
    ),
  );
  const escalated = reviewStoryboard(
    coveredPlan(["omitted", "included", "included"]),
    6,
  );
  assert.equal(escalated.verdict, "escalated");
  // At the ceiling exactly (1 of 4 = 25%) the plan stays approvable.
  const atCeiling = reviewStoryboard(
    coveredPlan(["omitted", "included", "included", "included"]),
    6,
  );
  assert.equal(atCeiling.verdict, "approved");
  assert.ok(
    atCeiling.findings.some(
      (f) =>
        f.severity === "warn" &&
        f.code === "coverage.omitted" &&
        f.message.includes("No take matched"),
    ),
    "each omission is a warning carrying its recorded reason",
  );
  assert.equal(MAX_OMISSION_RATIO, 0.25);
});

test("duration outside 0.4×–1.6× target blocks in both directions", () => {
  const plan = coveredPlan(["included"]);
  // fixture runs 3s (90 frames at 30fps).
  const under = reviewStoryboard(plan, 15);
  assert.equal(under.verdict, "escalated");
  assert.ok(
    under.findings.some(
      (f) => f.code === "duration.under" && f.severity === "blocker",
    ),
  );
  const over = reviewStoryboard(plan, 1);
  assert.ok(
    over.findings.some(
      (f) => f.code === "duration.over" && f.severity === "blocker",
    ),
  );
  // 3s against a 4s target is inside 1.6s–6.4s.
  assert.equal(reviewStoryboard(plan, 4).verdict, "approved");
});

test("tightening skips and caption-less styles warn without blocking", () => {
  const plan = coveredPlan(["included"], { captionStyle: "pop" });
  const review = reviewStoryboard(
    plan,
    4,
    {
      level: "tight",
      skippedRecordings: ["rec-1"],
    },
    0,
  );
  assert.equal(review.verdict, "approved");
  assert.ok(
    review.findings.some(
      (f) => f.code === "tightening.skipped" && f.message.includes("rec-1"),
    ),
  );
  assert.ok(review.findings.some((f) => f.code === "captions.none"));
  // A natural (default) cut never reports tightening skips.
  const natural = reviewStoryboard(
    plan,
    4,
    {
      level: "natural",
      skippedRecordings: [],
    },
    3,
  );
  assert.ok(!natural.findings.some((f) => f.code === "tightening.skipped"));
});

test("plans without script coverage record an info note, not a blocker", () => {
  const review = reviewStoryboard(fixture(), 4);
  assert.equal(review.verdict, "approved");
  assert.ok(
    review.findings.some(
      (f) => f.severity === "info" && f.code === "coverage.unavailable",
    ),
  );
  assert.equal(review.evidence.sentences, 0);
});

test("rough-cut review approves only a spotless QA PASS", () => {
  const clean = {
    status: "PASS",
    warnings: [],
    attention: [],
    metadata: { duration: 4.7 },
    audio: { silenceStarts: [], maxVolumeDb: -17.9 },
  };
  const review = reviewRoughCut(fixture(), clean);
  assert.equal(review.verdict, "approved");
  assert.equal(review.gate, "rough-cut");
  assert.equal(review.evidence.qaStatus, "PASS");
  assert.equal(review.evidence.warnings, 0);
  assert.equal(review.evidence.attention, 0);
  assert.equal(review.evidence.durationSeconds, 4.7);
});

test("rough-cut review escalates on any warning, flagged scene, or non-PASS", () => {
  const plan = fixture();
  const flagged = reviewRoughCut(plan, {
    status: "ATTENTION",
    warnings: [],
    attention: ["scene-2", "scene-2"],
  });
  assert.equal(flagged.verdict, "escalated");
  assert.ok(
    flagged.findings.some(
      (f) =>
        f.severity === "blocker" &&
        f.code === "qa.attention" &&
        f.message.includes("scene-2"),
    ),
  );
  const noisy = reviewRoughCut(plan, {
    status: "PASS",
    warnings: [
      "2 silence interval(s) of 2 seconds or more: review pacing.",
      "Synthetic or imported mock transcript; factual and spoken-word alignment requires human review.",
      "Something unclassified happened.",
    ],
    attention: [],
  });
  assert.equal(noisy.verdict, "escalated");
  assert.deepEqual(
    noisy.findings.filter((f) => f.severity === "warn").map((f) => f.code),
    ["audio.silence", "transcript.mock", "qa.warning"],
  );
  assert.equal(noisy.evidence.warnings, 3);
});

test("setAutonomy switches mode and records the event; rows normalize on read", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wts-producer-mode-"));
  const store = new Store(root);
  try {
    const studio = new Studio(store);
    const p = store.create("Mode switch");
    assert.equal(store.get(p.id).autonomy, "supervised");
    await studio.setAutonomy(p.id, "autonomous");
    assert.equal(store.get(p.id).autonomy, "autonomous");
    assert.ok(
      store
        .events(p.id)
        .some((e) => JSON.parse(e.data as string).event === "project.autonomy"),
    );
    // A pre-Producer row without the new fields reads as a supervised project
    // whose approvals were the creator's.
    const doc = JSON.parse(JSON.stringify(store.get(p.id))) as Record<
      string,
      unknown
    >;
    delete doc.autonomy;
    delete doc.producerReviews;
    doc.planApproval = {
      version: 1,
      hash: "a".repeat(64),
      approvedAt: now(),
    };
    store.db
      .prepare("UPDATE projects SET data=? WHERE id=?")
      .run(JSON.stringify(doc), p.id);
    const reread = store.get(p.id);
    assert.equal(reread.autonomy, "supervised");
    assert.deepEqual(reread.producerReviews, []);
    assert.equal(reread.planApproval?.approvedBy, "creator");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function temporary<T>(fn: (root: string, store: Store) => Promise<T>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wts-producer-"));
  const store = new Store(root);
  try {
    return await fn(root, store);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * Word-timed project parked at MEDIA_IMPORTED, ready to plan. The creator is
 * the purist: a minimal-density plan suggests no Remotion graphics and the
 * mock visual pass proposes no generated B-roll, so a build attempt in this
 * media-less fixture fails fast at the recording proxy instead of rendering.
 */
async function plannableProject(
  store: Store,
  autonomy: "supervised" | "autonomous",
) {
  store.setCreator({ ...store.creator(), director: "purist" });
  const p = store.create(
    "Producer e2e",
    "Deterministic autonomy",
    15,
    autonomy,
  );
  const studio = new Studio(store);
  await studio.saveScript(
    p.id,
    "First thought about caching here. Second thought continues it further. Third thought closes the group.",
  );
  await studio.approveScript(p.id, 1);
  const rec = recording("rec-producer", 60);
  store.update(p.id, (x) => {
    x.status = "MEDIA_IMPORTED";
    x.recordings = [rec];
    x.transcripts = [
      transcriptWithWords(rec.id, [
        { start: 10, text: "First thought about caching here." },
        { start: 14, text: "Second thought continues it further." },
        { start: 16.5, text: "Third thought closes the group." },
      ]),
    ];
  });
  return { p, studio };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const eventNames = (store: Store, projectId: string) =>
  store
    .events(projectId)
    .map((e) => JSON.parse(e.data as string).event as string);
async function untilEvent(
  store: Store,
  projectId: string,
  event: string,
  label: string,
) {
  for (let i = 0; i < 600 && !eventNames(store, projectId).includes(event); i++)
    await sleep(10);
  assert.ok(eventNames(store, projectId).includes(event), label);
  return store.get(projectId);
}

test("the Producer advances an autonomous project and stops cleanly without media", async () =>
  temporary(async (_root, store) => {
    const { p, studio } = await plannableProject(store, "autonomous");
    await studio.generatePlan(p.id);
    // The auto-trigger runs the chain fire-and-forget: storyboard v1 review +
    // approval, visual pass proposal + apply, storyboard v2 approval, then the
    // build fails on the missing recording file.
    const done = await untilEvent(
      store,
      p.id,
      "producer.failed",
      "the media-less build failure is recorded",
    );
    assert.equal(done.planApproval?.version, 2);
    assert.equal(done.planApproval?.approvedBy, "producer");
    assert.equal(done.autonomy, "autonomous");
    const storyboardReviews = done.producerReviews.filter(
      (r) => r.gate === "storyboard",
    );
    assert.deepEqual(
      storyboardReviews.map((r) => [r.planVersion, r.verdict]),
      [
        [1, "approved"],
        [2, "approved"],
      ],
      "both plan versions carry a persisted review",
    );
    const visualPass = done.revisions.find((r) =>
      r.patch.originatingRequest.startsWith("Visual direction pass"),
    );
    assert.equal(visualPass?.status, "APPLIED");
    assert.equal(visualPass?.decidedBy, "producer");
    // The failed build leaves the state consistent, waiting at the storyboard
    // gate for the creator.
    assert.equal(done.status, "AWAITING_STORYBOARD_APPROVAL");
    assert.equal(done.builds.length, 0);
    assert.equal(done.roughCutApproval, null);
    assert.equal(done.publishApproval, null);
    const events = eventNames(store, p.id);
    assert.ok(events.includes("producer.reviewed"));
    assert.ok(events.includes("producer.failed"));
    // Retrying never duplicates plan versions or corrupts state.
    const before = done.plans.length;
    const retry = await studio.advance(p.id);
    assert.equal(retry.stopped, "failed");
    assert.equal(store.get(p.id).plans.length, before);
  }));

test("supervised projects keep every gate and advance refuses them", async () =>
  temporary(async (_root, store) => {
    const { p, studio } = await plannableProject(store, "supervised");
    await studio.generatePlan(p.id);
    await sleep(150);
    const after = store.get(p.id);
    assert.equal(after.planApproval, null, "no auto-approval");
    assert.deepEqual(after.producerReviews, [], "no producer reviews");
    assert.equal(after.revisions.length, 0, "no auto-applied patches");
    await assert.rejects(studio.advance(p.id), /autonomous/);
    // Switching modes lets the same project advance afterwards.
    await studio.setAutonomy(p.id, "autonomous");
    const result = await studio.advance(p.id);
    assert.equal(result.snapshot.planApproval?.approvedBy, "producer");
    assert.ok(result.acted.length > 0);
    assert.ok(eventNames(store, p.id).includes("producer.failed"));
  }));
