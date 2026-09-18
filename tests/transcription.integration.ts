import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ffmpeg } from "../packages/media/src/index.ts";
import { hash, now } from "../packages/shared/src/index.ts";
import { Store } from "../packages/orchestrator/src/store.ts";
import { correctTranscriptIssue } from "../packages/orchestrator/src/transcription.ts";
import { latestTranscripts } from "../packages/orchestrator/src/transcript-history.ts";
import type {
  Recording,
  Transcript,
} from "../packages/orchestrator/src/model.ts";
import type { TranscriptionReview } from "../packages/orchestrator/src/transcription-model.ts";
import type { AcousticTools } from "../packages/agents/src/acoustic.ts";

test("manual correction extracts real media, requires acoustic evidence and retains unresolved concerns", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wts-correction-media-"));
  const store = new Store(root);
  try {
    const p = store.create("Manual correction");
    await mkdir(path.join(store.dir(p), "recordings"), { recursive: true });
    await ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=4",
      "-c:a",
      "pcm_s16le",
      path.join(store.dir(p), "recordings/source.wav"),
    ]);
    const recording: Recording = {
      id: "recording-1",
      name: "source.wav",
      path: "recordings/source.wav",
      duration: 4,
      width: 1920,
      height: 1080,
      codec: "h264",
      frameRate: 30,
      hasAudio: true,
      audioCodec: "pcm_s16le",
      bytes: 1,
      hash: hash("source"),
      importedAt: now(),
      proxyPath: null,
      proxyStatus: "PENDING",
      frames: 120,
      proxyFrames: null,
    };
    const transcript: Transcript = {
      schemaVersion: "1.0.0",
      recordingId: recording.id,
      provider: "fixture",
      model: "fixture",
      language: "en",
      segments: [{ id: "s-1", start: 0, end: 1, text: "Post grass." }],
    };
    const issue = {
      id: "wording",
      segmentId: "s-1",
      kind: "wording" as const,
      severity: "review" as const,
      reason: "Recognition disagreement",
      suggestedText: null,
      start: 0,
      end: 1,
      originalText: "Post grass.",
      proposed: null,
      verification: null,
      status: "pending" as const,
      decidedAt: null,
    };
    const report: TranscriptionReview = {
      algorithm: "fixture",
      id: "review",
      recordingId: recording.id,
      createdAt: now(),
      sourceHash: null,
      candidateHash: hash(transcript),
      status: "needs-review",
      summary: "",
      raw: [],
      decisions: [],
      acoustic: {
        engine: "fixture",
        model: "fixture",
        speech: [],
        clippedFraction: 0,
        alignedWords: 0,
        unalignedWords: 2,
      },
      issues: [issue, { ...issue, id: "timing", kind: "timing" }],
    };
    store.update(p.id, (x) => {
      x.status = "MEDIA_IMPORTED";
      x.recordings = [recording];
      x.transcripts = [transcript];
      x.transcriptionReviews = [report];
    });
    const input = {
      reviewId: report.id,
      issueId: issue.id,
      expectedHash: hash(transcript),
      text: "Postgres.",
    };
    const mockedAlignment = (score: number): AcousticTools => ({
      analyze: async () => {
        throw new Error("Not used");
      },
      align: async () => ({
        duration: 4,
        engine: "fixture",
        model: "fixture",
        segments: [
          {
            text: "Postgres.",
            start: 0.2,
            end: 0.8,
            words: [{ word: "Postgres.", start: 0.2, end: 0.8, score }],
          },
        ],
      }),
    });
    await assert.rejects(
      correctTranscriptIssue(
        store,
        store.get(p.id),
        input,
        undefined,
        mockedAlignment(0.2),
      ),
      /could not be reliably aligned/,
    );
    assert.equal(hash(latestTranscripts(store.get(p.id))[0]), hash(transcript));
    await correctTranscriptIssue(
      store,
      store.get(p.id),
      input,
      undefined,
      mockedAlignment(0.9),
    );
    const after = store.get(p.id),
      updated = after.transcriptionReviews![0];
    assert.equal(latestTranscripts(after)[0].segments[0].text, "Postgres.");
    assert.equal(updated.issues[1].status, "pending");
    assert.equal(updated.issues[1].originalText, "Postgres.");
    assert.deepEqual(
      updated.issues[1].replacementIds,
      latestTranscripts(after)[0].segments.map((s) => s.id),
    );
    assert.equal(after.transcripts[0].segments[0].text, "Post grass.");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
