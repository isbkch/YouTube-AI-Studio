import { z } from "zod";
import type { Transcript } from "./model.ts";
import type { Usage } from "../../shared/src/index.ts";

export const transcriptFindingSchema = z.strictObject({
  segmentId: z.string(),
  kind: z.enum([
    "wording",
    "missing-speech",
    "repetition",
    "incomplete",
    "timing",
    "audio-quality",
  ]),
  severity: z.enum(["info", "review"]),
  reason: z.string().min(1).max(1200),
  suggestedText: z.string().max(20000).nullable(),
});
export const transcriptReviewOutputSchema = z.strictObject({
  summary: z.string().max(2000),
  findings: z.array(transcriptFindingSchema).max(100),
});
export type TranscriptFinding = z.infer<typeof transcriptFindingSchema>;
export type TranscriptSegment = Transcript["segments"][number];
export interface SpeechRange {
  start: number;
  end: number;
}
export interface AcousticEvidence {
  engine: string;
  model: string;
  speech: SpeechRange[];
  clippedFraction: number;
  alignedWords: number;
  unalignedWords: number;
}
export interface TranscriptIssue extends TranscriptFinding {
  id: string;
  start: number;
  end: number;
  originalText: string;
  replacementIds?: string[];
  origin?: "acoustic" | "recognizer" | "llm";
  proposed: TranscriptSegment[] | null;
  verification: {
    model: string;
    text: string;
    agreesWithOriginal: boolean;
    agreesWithSuggestion: boolean;
    alignmentCoverage: number;
  } | null;
  status: "pending" | "accepted" | "kept" | "auto-resolved";
  decidedAt: string | null;
}
export interface TranscriptionReview {
  algorithm: string;
  id: string;
  recordingId: string;
  createdAt: string;
  sourceHash: string | null;
  candidateHash: string;
  status: "ready" | "needs-review";
  summary: string;
  acoustic: AcousticEvidence;
  issues: TranscriptIssue[];
  /** Immutable provider hypotheses, retained separately from edited transcripts. */
  raw: { start: number; end: number; model: string; text: string }[];
  decisions: {
    issueId: string;
    action: "accept" | "keep";
    beforeHash: string;
    afterHash: string;
    at: string;
  }[];
}
export interface TranscriptionResult {
  output: Transcript;
  usage: Usage;
  usages?: Usage[];
  review?: TranscriptionReview;
}
export interface TranscriptSet {
  hash: string;
  createdAt: string;
  transcripts: Transcript[];
}
