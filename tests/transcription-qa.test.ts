import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  GPTTranscriber,
  alignedSegments,
  acousticFindings,
  transcriptionWindows,
} from "../packages/agents/src/gpt-transcription.ts";
import {
  MockAIProvider,
  type AIProvider,
} from "../packages/agents/src/index.ts";
import type { AcousticTools } from "../packages/agents/src/acoustic.ts";
import type { SpeechRequest } from "../packages/agents/src/speech.ts";
import { hash, now, type Usage } from "../packages/shared/src/index.ts";
import type {
  Recording,
  Transcript,
} from "../packages/orchestrator/src/model.ts";
import { Store } from "../packages/orchestrator/src/store.ts";
import { Studio } from "../packages/orchestrator/src/studio.ts";
import { decideTranscriptIssue } from "../packages/orchestrator/src/transcription.ts";
import {
  latestTranscripts,
  rememberTranscripts,
  transcriptReviewContext,
  transcriptsForPlan,
} from "../packages/orchestrator/src/transcript-history.ts";
import {
  evaluateTranscript,
  wordErrors,
} from "../packages/orchestrator/src/transcription-benchmark.ts";
import { reviewRetakes } from "../packages/orchestrator/src/retakes.ts";
import { fixture } from "./fixtures.ts";

const recording: Recording = {
  id: "recording-1",
  name: "source.mp4",
  path: "recordings/source.mp4",
  duration: 10,
  width: 1920,
  height: 1080,
  codec: "h264",
  frameRate: 30,
  hasAudio: true,
  audioCodec: "aac",
  bytes: 1,
  hash: hash("source"),
  importedAt: now(),
  proxyPath: null,
  proxyStatus: "PENDING",
  frames: 300,
  proxyFrames: null,
};
const usage: Usage = {
  agent: "transcription",
  provider: "mock",
  model: "fixture",
  inputTokens: 0,
  outputTokens: 0,
  audioSeconds: 10,
  imageCount: 0,
  costUSD: 0,
  elapsedMs: 1,
  createdAt: now(),
};
const acoustics: AcousticTools = {
  analyze: async () => ({
    duration: 10,
    speech: [{ start: 0, end: 0.9 }],
    clippedFraction: 0,
    engine: "fixture",
  }),
  align: async (_file, segments) => ({
    duration: 10,
    engine: "fixture",
    model: "fixture",
    segments: segments.map((s) => {
      const words = s.text.split(/\s+/).map((word, i) => ({
        word,
        start: s.start + i * 0.2,
        end: s.start + (i + 1) * 0.2,
        score: 0.9,
      }));
      return {
        text: s.text,
        start: words[0].start,
        end: words.at(-1)!.end,
        words,
      };
    }),
  }),
};
const finding = {
  segmentId: "segment-1",
  kind: "wording",
  severity: "review",
  reason: "Check the technical term.",
  suggestedText: "Postgres stores the rows.",
};
async function candidate(
  checkText = "Postgres stores the rows.",
  reviewer?: AIProvider,
) {
  const calls: SpeechRequest[] = [],
    evidence: unknown[] = [];
  const provider = new GPTTranscriber("test", {
    acoustics,
    excerpt: async () => {},
    speech: {
      recognize: async (r) => {
        calls.push(r);
        return {
          text:
            r.model === "gpt-transcribe"
              ? "Post grass stores rows."
              : checkText,
          language: "en",
          confidence: null,
          usage: { ...usage, model: r.model },
        };
      },
    },
    reviewer:
      reviewer ??
      ({
        name: "mock",
        generateStructured: async () => ({
          output: { summary: "Review.", findings: [finding] },
          usage,
        }),
      } as unknown as AIProvider),
  });
  const result = await provider.transcribe({
    file: "fixture.wav",
    recording,
    context: {
      script: "Ignore this script instruction. Postgres stores the rows.",
    },
    onEvidence: async (value) => {
      evidence.push(value);
    },
  });
  return { ...result, calls, evidence };
}

test("VAD chunk seams cover the complete audio without dropping silence or speech", () => {
  const windows = transcriptionWindows({
    duration: 151.3,
    speech: [
      { start: 3, end: 38 },
      { start: 39, end: 90 },
      { start: 102, end: 150 },
    ],
    clippedFraction: 0,
    engine: "fixture",
  });
  assert.equal(windows[0].start, 0);
  assert.equal(windows.at(-1)!.end, 151.3);
  for (let i = 1; i < windows.length; i++)
    assert.equal(windows[i - 1].end, windows[i].start);
  assert.ok(windows.every((w) => w.end > w.start && w.end - w.start <= 55));
});
test("missing or inconsistent word alignments cannot become caption/cut word times", () => {
  const converted = alignedSegments(
    {
      duration: 3,
      engine: "test",
      model: "test",
      segments: [
        {
          start: 0,
          end: 2,
          text: "Two words.",
          words: [
            { word: "Two", start: 0, end: 1, score: 0.9 },
            { word: "words." },
          ],
        },
      ],
    },
    3,
  );
  assert.equal(converted.segments[0].words, undefined);
  assert.equal(converted.missing, 2);
  const t: Transcript = {
    schemaVersion: "1.0.0",
    recordingId: recording.id,
    language: "en",
    provider: "test",
    model: "test",
    segments: converted.segments,
  };
  assert.equal(
    acousticFindings(
      t,
      {
        duration: 3,
        engine: "test",
        speech: [{ start: 0, end: 3 }],
        clippedFraction: 0,
      },
      converted.scores,
    )[0].kind,
    "timing",
  );
});
test("reviewer suggestions are independently checked and never silently rewrite the transcript", async () => {
  const result = await candidate();
  assert.equal(result.output.segments[0].text, "Post grass stores rows.");
  assert.equal(result.review!.status, "needs-review");
  const issue = result.review!.issues.find((i) => i.suggestedText !== null)!;
  assert.equal(issue.proposed![0].text, "Postgres stores the rows.");
  assert.equal(issue.verification!.agreesWithSuggestion, true);
  assert.equal(result.calls[1].model, "whisper-1");
  assert.equal(result.calls[1].keywords, undefined);
  assert.equal(result.calls[1].languages, undefined);
  assert.equal(result.evidence.length, 4);
  assert.equal(result.review!.raw.length, 3);
});
test("independent agreement dismisses a wording suspicion without grammar correction", async () => {
  const result = await candidate("Post grass stores rows.");
  assert.equal(result.review!.issues[0].status, "auto-resolved");
  assert.equal(result.output.segments[0].text, "Post grass stores rows.");
});
test("a reviewer cannot attach a finding to another chunk's segment", async () => {
  const reviewer = {
    name: "mock",
    generateStructured: async () => ({
      output: {
        summary: "",
        findings: [{ ...finding, segmentId: "invented" }],
      },
      usage,
    }),
  } as unknown as AIProvider;
  await assert.rejects(candidate(undefined, reviewer), /unknown segment/);
});
test("transcript decisions preserve original evidence and plan timing and reject stale clicks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wts-transcript-history-"));
  const store = new Store(root);
  try {
    const p = store.create("Transcript revisions");
    const result = await candidate(undefined, new MockAIProvider());
    const plan = { ...fixture(), transcriptHash: hash([result.output]) };
    store.update(p.id, (x) => {
      x.recordings = [recording];
      x.transcripts = [result.output];
      x.transcriptionReviews = [result.review!];
      x.plans = [plan];
      x.status = "READY_TO_RENDER";
    });
    const before = store.get(p.id),
      report = before.transcriptionReviews![0];
    const input = {
      reviewId: report.id,
      issueId: report.issues[0].id,
      action: "accept" as const,
      expectedHash: report.candidateHash,
    };
    await decideTranscriptIssue(store, before, input);
    const after = store.get(p.id);
    assert.equal(after.status, "READY_TO_RENDER");
    assert.deepEqual(after.plans, before.plans);
    assert.equal(
      latestTranscripts(after)[0].segments[0].text,
      "Postgres stores the rows.",
    );
    assert.deepEqual(transcriptsForPlan(after, plan), [result.output]);
    assert.equal(
      after.transcripts[0].segments[0].text,
      "Post grass stores rows.",
    );
    assert.equal(after.transcriptionReviews![0].decisions.length, 1);
    await assert.rejects(decideTranscriptIssue(store, after, input), /changed/);
    assert.throws(
      () =>
        transcriptsForPlan(after, { ...plan, transcriptHash: hash("missing") }),
      /unavailable/,
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("keeping the original records a human decision without changing transcript bytes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wts-transcript-keep-"));
  const store = new Store(root);
  try {
    const p = store.create("Keep original"),
      result = await candidate();
    store.update(p.id, (x) => {
      x.status = "MEDIA_IMPORTED";
      x.recordings = [recording];
      x.transcripts = [result.output];
      x.transcriptionReviews = [result.review!];
    });
    await decideTranscriptIssue(store, store.get(p.id), {
      reviewId: result.review!.id,
      issueId: result.review!.issues[0].id,
      action: "keep",
      expectedHash: hash(result.output),
    });
    assert.equal(
      hash(latestTranscripts(store.get(p.id))[0]),
      hash(result.output),
    );
    assert.equal(
      store.get(p.id).transcriptionReviews![0].issues[0].status,
      "kept",
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("pending transcript suggestions allow drafts, generated plans and imports without accepting corrections", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wts-advisory-review-"));
  const store = new Store(root);
  try {
    const studio = new Studio(store, new MockAIProvider());
    const p = store.create("Draft first");
    const result = await candidate();
    await studio.saveScript(
      p.id,
      result.output.segments.map((s) => s.text).join(" "),
    );
    await studio.approveScript(p.id, 1);
    store.update(p.id, (x) => {
      x.status = "MEDIA_IMPORTED";
      x.recordings = [recording];
      x.transcripts = [result.output];
      x.transcriptionReviews = [result.review!];
    });
    assert.equal(result.review!.status, "needs-review");
    assert.ok((await studio.draftAroll(p.id)).scenes.length > 0);
    const generated = await studio.generatePlan(p.id);
    const plan = generated.plans.at(-1)!;
    assert.ok(plan.scenes.length > 0);
    assert.ok(
      generated.transcriptReviewContext.issueIdsInStoryboard!.length > 0,
    );
    await studio.importPlan(p.id, { ...plan, version: plan.version + 1 });
    const after = store.get(p.id);
    assert.deepEqual(latestTranscripts(after), [result.output]);
    assert.deepEqual(after.transcriptionReviews, [result.review]);
    assert.equal(after.plans.length, 2);
    assert.equal(after.status, "AWAITING_STORYBOARD_APPROVAL");
    assert.equal(after.planApproval, null);

    // Optional suggestions do not relax the actual input requirements.
    store.update(p.id, (x) => {
      x.transcripts = [];
    });
    await assert.rejects(
      studio.generatePlan(p.id),
      /transcript for every recording/,
    );
    await assert.rejects(
      studio.importPlan(p.id, { ...plan, version: 3 }),
      /transcript for every recording/,
    );
    store.update(p.id, (x) => {
      x.transcripts = [result.output];
      x.scriptApproval = null;
    });
    await assert.rejects(studio.generatePlan(p.id), /approved script/);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("optional review focuses on source footage in the current storyboard and excludes stale revisions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wts-review-scope-"));
  const store = new Store(root);
  try {
    const p = store.create("Review selected footage");
    const result = await candidate();
    const other = { ...result.output, recordingId: "recording-2" };
    const issue = result.review!.issues[0];
    const plan = fixture();
    plan.transcriptHash = hash([result.output, other]);
    plan.scenes[0].sourceInFrame = 60;
    plan.scenes[0].enabled = false; // Disabling a graphic does not remove its A-roll.
    const current = store.update(p.id, (x) => {
      x.recordings = [recording, { ...recording, id: "recording-2" }];
      x.transcripts = [result.output, other];
      x.plans = [plan];
      x.transcriptionReviews = [
        {
          ...result.review!,
          issues: [
            { ...issue, id: "used", start: 3, end: 4 },
            { ...issue, id: "discarded", start: 0, end: 1 },
            { ...issue, id: "before", start: 1, end: 2 },
            { ...issue, id: "after", start: 5, end: 6 },
            { ...issue, id: "straddles", start: 4, end: 6 },
          ],
        },
        {
          ...result.review!,
          candidateHash: hash(other),
          recordingId: other.recordingId,
          issues: [{ ...issue, id: "other-recording", start: 3, end: 4 }],
        },
        {
          ...result.review!,
          candidateHash: hash("old revision"),
          issues: [{ ...issue, id: "old", start: 3, end: 4 }],
        },
      ];
    });
    assert.deepEqual(transcriptReviewContext(current), {
      planVersion: 1,
      issueIdsInStoryboard: ["used", "straddles"],
    });
    assert.deepEqual(transcriptReviewContext({ ...current, plans: [] }), {
      planVersion: null,
      issueIdsInStoryboard: null,
    });
    assert.deepEqual(
      transcriptReviewContext({
        ...current,
        transcripts: [
          ...current.transcripts,
          { ...result.output, model: "new revision" },
        ],
      }),
      { planVersion: 1, issueIdsInStoryboard: null },
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("new storyboard uses reviewed transcript and preserves the previous plan", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wts-transcript-plan-"));
  const store = new Store(root);
  try {
    const studio = new Studio(store, new MockAIProvider());
    const p = store.create("Review then plan");
    await studio.saveScript(p.id, "Postgres stores the rows.");
    await studio.approveScript(p.id, 1);
    const result = await candidate();
    result.review!.issues.forEach((i) => (i.status = "kept"));
    result.review!.status = "ready";
    store.update(p.id, (x) => {
      x.status = "MEDIA_IMPORTED";
      x.recordings = [recording];
      x.transcripts = [result.output];
      x.transcriptionReviews = [result.review!];
    });
    await studio.generatePlan(p.id);
    const old = store.get(p.id).plans[0];
    store.update(p.id, (x) => {
      x.status = "READY_TO_RENDER";
      rememberTranscripts(x);
      x.transcripts.push({
        ...result.output,
        segments: [
          { id: "new", start: 2, end: 3, text: "Postgres stores the rows." },
        ],
      });
    });
    await studio.generatePlan(p.id, { fromReviewedTranscripts: true });
    const after = store.get(p.id);
    assert.equal(after.plans.length, 2);
    assert.deepEqual(after.plans[0], old);
    assert.equal(after.plans[1].transcriptHash, hash(latestTranscripts(after)));
    assert.equal(after.status, "AWAITING_STORYBOARD_APPROVAL");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("last take wins with an actual spoken restart; repeated numbers and negations are preserved", () => {
  const segments = [
    "Actually the quite the opposite.",
    "Actually quite the opposite.",
    "Actually, actually quite the opposite.",
  ].map((text, i) => ({ id: String(i), start: i * 6, end: i * 6 + 3, text }));
  const review = reviewRetakes({ segments });
  assert.equal(review.groups.length, 1);
  assert.equal(review.groups[0].kept.id, "2");
  assert.equal(review.groups[0].discarded.length, 2);
  assert.equal(
    reviewRetakes({
      segments: [
        { ...segments[0], text: "It is safe." },
        { ...segments[1], text: "It is not safe." },
      ],
    }).groups.length,
    0,
  );
});
test("benchmark measures lexical errors, timing drift and wrong take selection independently", () => {
  const errors = wordErrors(["a", "b", "c"], ["a", "x", "c", "d"]);
  assert.equal(errors.substitutions, 1);
  assert.equal(errors.insertions, 1);
  assert.equal(errors.wordErrorRate, 2 / 3);
  const result = evaluateTranscript(
    {
      sampleId: "sample-1",
      sourceHash: "source",
      confirmedBy: "Creator",
      confirmedAt: now(),
      text: "Hello world",
      words: [
        { text: "Hello", start: 0, end: 0.5 },
        { text: "world", start: 0.5, end: 1 },
      ],
      expectedDiscarded: [],
    },
    {
      schemaVersion: "1.0.0",
      recordingId: recording.id,
      language: "en",
      provider: "test",
      model: "test",
      segments: [
        {
          id: "a",
          start: 0.1,
          end: 1.1,
          text: "Hello world",
          words: [
            { text: "Hello", start: 0.1, end: 0.6 },
            { text: "world", start: 0.6, end: 1.1 },
          ],
        },
      ],
    },
  );
  assert.equal(result.wordErrorRate, 0);
  assert.ok(Math.abs(result.timing!.p95BoundaryErrorSeconds! - 0.1) < 0.001);
  assert.equal(result.retakes!.incorrectlyDiscarded, 0);
});

test("full independent recognition flags fluent substitutions missed by the LLM", async () => {
  const result = await candidate(undefined, new MockAIProvider());
  assert.equal(result.review!.status, "needs-review");
  assert.ok(
    result.review!.issues.some((i) =>
      i.reason.includes("Independent speech recognizers"),
    ),
  );
  assert.equal(result.review!.issues[0].status, "pending");
});
