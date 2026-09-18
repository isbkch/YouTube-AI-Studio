import { hash, now, StudioError } from "../../shared/src/index.ts";
import type { ProductionPlan } from "../../production-plan/src/index.ts";
import type { Project, Transcript } from "./model.ts";

export function latestTranscripts(
  p: Pick<Project, "recordings" | "transcripts">,
): Transcript[] {
  return p.recordings
    .map((r) => p.transcripts.findLast((t) => t.recordingId === r.id))
    .filter((t): t is Transcript => !!t);
}
/** Called before any replacement. Plans continue to resolve their original bytes. */
export function rememberTranscripts(p: Project) {
  const sets = p.transcriptHistory?.length
    ? [latestTranscripts(p)]
    : [p.transcripts, latestTranscripts(p)];
  p.transcriptHistory ??= [];
  for (const transcripts of sets) {
    const key = hash(transcripts);
    if (!p.transcriptHistory.some((s) => s.hash === key))
      p.transcriptHistory.push({
        hash: key,
        createdAt: now(),
        transcripts: structuredClone(transcripts),
      });
  }
}
export function transcriptsForPlan(
  p: Project,
  plan: ProductionPlan,
): Transcript[] {
  for (const transcripts of [latestTranscripts(p), p.transcripts])
    if (hash(transcripts) === plan.transcriptHash) return transcripts;
  const stored = p.transcriptHistory?.find(
    (s) => s.hash === plan.transcriptHash,
  );
  if (stored && hash(stored.transcripts) === stored.hash)
    return stored.transcripts;
  // Legacy plans with no recorded lineage retain the pre-QA behavior. Once a
  // project has revisions, an unresolvable hash must never silently use new text.
  if (!p.transcriptHistory?.length) return p.transcripts;
  throw new StudioError(
    "CONFLICT",
    "The plan's transcript revision is unavailable.",
    "Restore its transcript history or generate a new storyboard.",
  );
}
export function requireReviewedTranscripts(p: Project) {
  const pending = (p.transcriptionReviews ?? []).filter(
    (r) =>
      r.status === "needs-review" &&
      latestTranscripts(p).some((t) => hash(t) === r.candidateHash),
  );
  if (pending.length)
    throw new StudioError(
      "CONFLICT",
      "Resolve the transcript review queue before generating a new storyboard.",
      "Listen to each flagged passage and accept the correction or keep the original.",
    );
}
