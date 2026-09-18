import {
  LocalAcousticTools,
  type AcousticTools,
} from "../../agents/src/acoustic.ts";
import {
  alignedSegments,
  speechTokens,
} from "../../agents/src/gpt-transcription.ts";
import type { Transcriber } from "../../agents/src/index.ts";
import { validateTranscript } from "../../agents/src/index.ts";
import { extractAudio } from "../../media/src/index.ts";
import {
  hash,
  id,
  now,
  safePath,
  StudioError,
} from "../../shared/src/index.ts";
import type { Project, Recording } from "./model.ts";
import type { Store } from "./store.ts";
import {
  latestTranscripts,
  rememberTranscripts,
} from "./transcript-history.ts";

export function requireTranscriptIdle(p: Project) {
  if (
    ![
      "MEDIA_IMPORTED",
      "AWAITING_STORYBOARD_APPROVAL",
      "AWAITING_ROUGH_CUT_APPROVAL",
      "READY_TO_RENDER",
      "AWAITING_PUBLISH_APPROVAL",
    ].includes(p.status)
  )
    throw new StudioError(
      "CONFLICT",
      "Review transcripts when production is idle and before publication.",
    );
}
export async function transcribeRecording(
  store: Store,
  p: Project,
  recording: Recording,
  transcriber: Transcriber,
  signal?: AbortSignal,
  onProgress?: (message: string) => void,
) {
  const source = latestTranscripts(store.get(p.id)).find(
    (t) => t.recordingId === recording.id,
  );
  const runId = id("transcription-run");
  let evidenceIndex = 0;
  const audio = await safePath(
    store.dir(p),
    `cache/transcription-${recording.hash}.${transcriber.audioFormat}`,
  );
  await extractAudio(
    await safePath(store.dir(p), recording.path),
    audio,
    signal,
    transcriber.audioFormat,
  );
  const result = await transcriber.transcribe({
    file: audio,
    recording,
    signal,
    context: { script: p.scripts.at(-1)?.text ?? "" },
    onProgress,
    onEvidence: async (evidence) => {
      // Paid hypotheses and usage survive a later model/alignment failure.
      await store.artifact(
        p,
        `transcripts/evidence/${runId}-${++evidenceIndex}.json`,
        {
          recordingId: recording.id,
          sourceMediaHash: recording.hash,
          ...evidence,
        },
      );
      store.update(p.id, (x) => {
        x.usage.push(evidence.usage);
      });
    },
  });
  const output = validateTranscript(result.output, recording);
  if (output.revision)
    output.revision.parentHash = source ? hash(source) : null;
  if (result.review) {
    result.review.sourceHash = source ? hash(source) : null;
    result.review.candidateHash = hash(output);
    await store.artifact(
      p,
      `transcripts/reviews/${result.review.id}.json`,
      result.review,
    );
  }
  await store.artifact(
    p,
    `transcripts/transcript-${hash(output).slice(0, 16)}.json`,
    output,
  );
  store.update(p.id, (x) => {
    rememberTranscripts(x);
    x.transcripts.push(output);
    if (result.review) (x.transcriptionReviews ??= []).push(result.review);
    if (!evidenceIndex) x.usage.push(...(result.usages ?? [result.usage]));
    rememberTranscripts(x);
  });
  store.event(p.id, {
    event: "transcript.created",
    recordingId: recording.id,
    hash: hash(output),
    reviewId: result.review?.id ?? null,
  });
}
export async function decideTranscriptIssue(
  store: Store,
  p: Project,
  input: {
    reviewId: string;
    issueId: string;
    action: "accept" | "keep";
    expectedHash: string;
  },
) {
  requireTranscriptIdle(p);
  const report = p.transcriptionReviews?.find((r) => r.id === input.reviewId);
  const issue = report?.issues.find((i) => i.id === input.issueId);
  const transcript = latestTranscripts(p).find(
    (t) => t.recordingId === report?.recordingId,
  );
  if (
    !report ||
    !issue ||
    !transcript ||
    issue.status !== "pending" ||
    report.candidateHash !== input.expectedHash ||
    hash(transcript) !== input.expectedHash
  )
    throw new StudioError(
      "CONFLICT",
      "This transcript review changed. Refresh before deciding.",
    );
  const next = structuredClone(transcript);
  if (input.action === "accept") {
    if (!issue.proposed?.length || !issue.verification)
      throw new StudioError(
        "CONFLICT",
        "No audio-aligned correction is available. Listen and keep the original, or run a new review.",
      );
    const index = next.segments.findIndex((s) => s.id === issue.segmentId);
    if (index < 0)
      throw new StudioError("CONFLICT", "The flagged segment has changed.");
    const replaced = issue.replacementIds ?? [issue.segmentId];
    if (
      next.segments
        .slice(index, index + replaced.length)
        .map((s) => s.id)
        .join("|") !== replaced.join("|")
    )
      throw new StudioError(
        "CONFLICT",
        "The flagged passage changed. Refresh before deciding.",
      );
    next.segments.splice(
      index,
      replaced.length,
      ...structuredClone(issue.proposed),
    );
    next.revision = {
      id: id("transcript"),
      parentHash: hash(transcript),
      reviewId: report.id,
      createdAt: now(),
    };
    validateTranscript(
      next,
      p.recordings.find((r) => r.id === next.recordingId)!,
    );
    await store.artifact(
      p,
      `transcripts/transcript-${hash(next).slice(0, 16)}.json`,
      next,
    );
  }
  const updated = store.update(p.id, (x) => {
    rememberTranscripts(x);
    if (input.action === "accept") x.transcripts.push(next);
    const review = x.transcriptionReviews!.find((r) => r.id === report.id)!;
    const target = review.issues.find((i) => i.id === issue.id)!;
    target.status = input.action === "accept" ? "accepted" : "kept";
    target.decidedAt = now();
    // Other findings still require a decision, but cannot apply an obsolete replacement.
    if (input.action === "accept")
      for (const other of review.issues) {
        if (
          other.id !== issue.id &&
          other.segmentId === issue.segmentId &&
          other.status === "pending"
        ) {
          other.proposed = null;
          other.verification = null;
          other.replacementIds = issue.proposed!.map((s) => s.id);
          other.segmentId = issue.proposed![0].id;
          other.originalText = issue.proposed!.map((s) => s.text).join(" ");
          other.start = Math.min(other.start, issue.proposed![0].start);
          other.end = Math.max(other.end, issue.proposed!.at(-1)!.end);
        }
      }
    review.candidateHash = hash(next);
    review.decisions.push({
      issueId: issue.id,
      action: input.action,
      beforeHash: hash(transcript),
      afterHash: hash(next),
      at: now(),
    });
    review.status = review.issues.some((i) => i.status === "pending")
      ? "needs-review"
      : "ready";
    rememberTranscripts(x);
  });
  const decided = updated.transcriptionReviews!.find(
    (r) => r.id === report.id,
  )!;
  await store.artifact(
    p,
    `transcripts/reviews/${report.id}-${decided.decisions.length}.json`,
    decided,
  );
  store.event(p.id, {
    event: "transcript.decided",
    ...input,
    candidateHash: decided.candidateHash,
  });
  return updated;
}

/** Creator wording is also aligned to the actual audio before it becomes edit evidence. */
export async function correctTranscriptIssue(
  store: Store,
  p: Project,
  input: {
    reviewId: string;
    issueId: string;
    expectedHash: string;
    text: string;
  },
  signal?: AbortSignal,
  acoustics: AcousticTools = new LocalAcousticTools(),
) {
  requireTranscriptIdle(p);
  const report = p.transcriptionReviews?.find((r) => r.id === input.reviewId);
  const issue = report?.issues.find((i) => i.id === input.issueId);
  const transcript = latestTranscripts(p).find(
    (t) => t.recordingId === report?.recordingId,
  );
  if (
    !report ||
    !issue ||
    !transcript ||
    issue.status !== "pending" ||
    hash(transcript) !== input.expectedHash ||
    report.candidateHash !== input.expectedHash
  )
    throw new StudioError(
      "CONFLICT",
      "This transcript review changed. Refresh before editing.",
    );
  if (!input.text.trim() || input.text.length > 20000)
    throw new StudioError(
      "INVALID_INPUT",
      "Enter the words spoken in this passage.",
    );
  const recording = p.recordings.find((r) => r.id === transcript.recordingId)!;
  const index = transcript.segments.findIndex((s) => s.id === issue.segmentId);
  if (index < 0)
    throw new StudioError(
      "CONFLICT",
      "The flagged segment changed. Run another review before editing it.",
    );
  const range = {
    start: Math.max(
      transcript.segments[index - 1]?.end ?? 0,
      issue.start - 0.2,
    ),
    end: Math.min(
      transcript.segments[index + (issue.replacementIds?.length ?? 1)]?.start ??
        recording.duration,
      issue.end + 0.2,
    ),
  };
  const audio = await safePath(
    store.dir(p),
    `cache/transcription-${recording.hash}.wav`,
  );
  await extractAudio(
    await safePath(store.dir(p), recording.path),
    audio,
    signal,
    "wav",
  );
  const aligned = await acoustics.align(
    audio,
    [{ ...range, text: input.text.trim() }],
    transcript.language,
    signal,
  );
  const converted = alignedSegments(
    aligned,
    recording.duration,
    id("creator-segment"),
  );
  if (
    !converted.segments.length ||
    converted.segments.some(
      (s) =>
        !s.words?.length ||
        s.start < range.start ||
        s.end > range.end ||
        (converted.scores.get(s.id) ?? 0) < 0.5,
    ) ||
    speechTokens(converted.segments.map((s) => s.text).join(" ")).join(" ") !==
      speechTokens(input.text).join(" ")
  )
    throw new StudioError(
      "CONFLICT",
      "The edited words could not be reliably aligned to this passage.",
      "Check the wording against playback, or run a new audio review.",
    );
  const updated = store.update(p.id, (x) => {
    const target = x
      .transcriptionReviews!.find((r) => r.id === report.id)!
      .issues.find((i) => i.id === issue.id)!;
    target.proposed = converted.segments;
    target.verification = {
      model: `creator + ${aligned.engine}`,
      text: input.text.trim(),
      agreesWithOriginal: false,
      agreesWithSuggestion: false,
      alignmentCoverage: 1,
    };
  });
  return decideTranscriptIssue(store, updated, { ...input, action: "accept" });
}
