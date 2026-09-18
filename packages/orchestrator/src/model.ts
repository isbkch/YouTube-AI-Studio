import type {
  ProductionPlan,
  PlanPatch,
} from "../../production-plan/src/index.ts";
import type { CreatorProfile, Usage } from "../../shared/src/index.ts";
import type { ThumbnailSelection, ThumbnailState } from "./thumbnail-model.ts";
import { StudioError } from "../../shared/src/index.ts";

export const statuses = [
  "IDEA",
  "RESEARCHING",
  "SCRIPTING",
  "AWAITING_SCRIPT_APPROVAL",
  "READY_TO_RECORD",
  "MEDIA_IMPORTED",
  "TRANSCRIBING",
  "PLANNING",
  "AWAITING_STORYBOARD_APPROVAL",
  "GENERATING_ASSETS",
  "ASSEMBLING",
  "AWAITING_ROUGH_CUT_APPROVAL",
  "REVISING",
  "READY_TO_RENDER",
  "AWAITING_PUBLISH_APPROVAL",
  "PUBLISHED",
] as const;
export type ProjectStatus = (typeof statuses)[number];
const edges: Record<ProjectStatus, ProjectStatus[]> = {
  IDEA: ["RESEARCHING", "SCRIPTING"],
  RESEARCHING: ["SCRIPTING"],
  SCRIPTING: ["AWAITING_SCRIPT_APPROVAL"],
  AWAITING_SCRIPT_APPROVAL: ["SCRIPTING", "READY_TO_RECORD"],
  READY_TO_RECORD: ["SCRIPTING", "MEDIA_IMPORTED"],
  MEDIA_IMPORTED: [
    "MEDIA_IMPORTED",
    "TRANSCRIBING",
    "PLANNING",
    "AWAITING_STORYBOARD_APPROVAL",
  ],
  TRANSCRIBING: ["MEDIA_IMPORTED", "PLANNING"],
  PLANNING: ["MEDIA_IMPORTED", "AWAITING_STORYBOARD_APPROVAL"],
  AWAITING_STORYBOARD_APPROVAL: ["GENERATING_ASSETS", "REVISING", "PLANNING"],
  GENERATING_ASSETS: ["ASSEMBLING", "AWAITING_STORYBOARD_APPROVAL"],
  ASSEMBLING: ["AWAITING_ROUGH_CUT_APPROVAL", "AWAITING_STORYBOARD_APPROVAL"],
  AWAITING_ROUGH_CUT_APPROVAL: ["REVISING", "READY_TO_RENDER"],
  REVISING: ["AWAITING_STORYBOARD_APPROVAL"],
  READY_TO_RENDER: ["REVISING", "AWAITING_PUBLISH_APPROVAL"],
  AWAITING_PUBLISH_APPROVAL: ["REVISING", "PUBLISHED"],
  PUBLISHED: [],
};
export function transition(from: ProjectStatus, to: ProjectStatus) {
  if (!edges[from].includes(to))
    throw new StudioError(
      "CONFLICT",
      `Cannot move from ${from} to ${to}.`,
      "Complete the current stage and its approval first.",
    );
  return to;
}
export interface Approval {
  version: number;
  hash: string;
  approvedAt: string;
  /**
   * Who satisfied the gate: the creator by hand, or the deterministic
   * Producer review on autonomous projects. Persisted rows from before the
   * Producer existed carry no field and read as the creator.
   */
  approvedBy: "creator" | "producer";
}
/**
 * The deterministic Producer's review of a machine-made gate. Persisted on
 * the project as the audit trail for every auto-approval and escalation;
 * findings carry the evidence inline so "why did this ship itself?" is always
 * answerable without re-deriving anything.
 */
export interface ProducerReview {
  id: string;
  gate: "storyboard" | "rough-cut";
  planVersion: number;
  verdict: "approved" | "escalated";
  checkedAt: string;
  reviewer: "deterministic-v1";
  findings: {
    severity: "info" | "warn" | "blocker";
    code: string;
    message: string;
  }[];
  evidence: {
    sentences: number;
    omitted: number;
    scenes: number;
    durationSeconds: number;
    qaStatus?: string;
    warnings?: number;
    attention?: number;
  };
}
export interface MediaInfo {
  duration: number;
  width: number;
  height: number;
  codec: string;
  frameRate: number;
  hasAudio: boolean;
  audioCodec: string | null;
  bytes: number;
  /** Video frame count from the container index (estimated when absent). */
  frames: number;
}
export interface Recording extends MediaInfo {
  id: string;
  name: string;
  path: string;
  hash: string;
  importedAt: string;
  proxyPath: string | null;
  proxyStatus: "PENDING" | "AVAILABLE" | "NOT_REQUIRED";
  /**
   * Frame count of the conformed plan-rate proxy once built. The deterministic
   * proxy encode caps at floor(duration × plan frame rate), which is also the
   * bound source ranges are validated against.
   */
  proxyFrames: number | null;
}
export interface Transcript {
  schemaVersion: "1.0.0";
  recordingId: string;
  language: string;
  provider: string;
  model: string;
  segments: {
    id: string;
    start: number;
    end: number;
    text: string;
    words?: { start: number; end: number; text: string }[];
  }[];
}
export interface Asset {
  assetId: string;
  type:
    | "remotion-render"
    | "preview-segment"
    | "proxy"
    | "audio"
    | "generated-image"
    | "broll-clip"
    | "music-bed"
    | "audio-mix"
    | "caption-render"
    | "caption-burn"
    | "builtin-sfx";
  sceneId: string | null;
  productionPlanVersion: number;
  generator: string;
  template: string | null;
  templateVersion: string | null;
  parameters: unknown;
  inputHash: string;
  outputHash: string;
  createdAt: string;
  path: string;
  jobId: string;
  reused: boolean;
  sourceAssets: string[];
  renderMs: number;
  provider?: string;
  model?: string;
  instruction?: string;
}
export interface Project {
  schemaVersion: "1.0.0";
  id: string;
  title: string;
  slug: string;
  description: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
  targetDuration: number;
  /**
   * Who satisfies the machine gates. Supervised (the default, and what rows
   * from before the Producer read as) requires the creator at every gate;
   * autonomous lets the deterministic Producer advance storyboard, build,
   * rough-cut and packaging while the script and publication gates stay human.
   */
  autonomy: "supervised" | "autonomous";
  /** Audit trail of deterministic Producer reviews, oldest first. */
  producerReviews: ProducerReview[];
  creator: CreatorProfile;
  research: {
    notes: string;
    sources: { url: string; title: string; retrievedAt: string }[];
  };
  outline: string[];
  /** Milestone 4 — pre-production agent artifact versions. */
  preproduction: {
    researchVersion: number | null;
    narrativeVersion: number | null;
    scriptDocVersion: number | null;
    previsualization: { version: number; scriptVersion: number } | null;
  };
  /** Milestone 5 — latest Packaging agent document version. */
  packaging: { version: number | null };
  thumbnails?: ThumbnailState | null;
  scripts: { version: number; text: string; createdAt: string }[];
  scriptApproval: Approval | null;
  recordings: Recording[];
  transcripts: Transcript[];
  plans: ProductionPlan[];
  planApproval: Approval | null;
  roughCutApproval: Approval | null;
  revisions: {
    patch: PlanPatch;
    status: "PROPOSED" | "APPLIED" | "REJECTED";
    decidedAt: string | null;
    /** Who decided the patch; rows from before the Producer read as creator. */
    decidedBy?: "creator" | "producer";
  }[];
  builds: {
    planVersion: number;
    previewPath: string;
    timelinePath: string;
    exportPath: string;
    qaPath: string;
    completedAt: string;
  }[];
  finalRender: string | null;
  /** Which engine produced `finalRender`; null when no final render exists. */
  finalRenderEngine: "resolve" | "ffmpeg" | null;
  publication: {
    videoId: string;
    url: string;
    publishedAt: string;
    thumbnail?: ThumbnailSelection | null;
    warning?: string | null;
    thumbnailStatus?: "applied" | "unconfirmed" | null;
  } | null;
  publishApproval:
    (Approval & { thumbnail?: ThumbnailSelection | null }) | null;
  usage: Usage[];
}
export type JobStatus =
  "QUEUED" | "RUNNING" | "BLOCKED" | "COMPLETE" | "FAILED" | "CANCELLED";
export interface Job {
  id: string;
  projectId: string;
  runId: string;
  type: string;
  label: string;
  status: JobStatus;
  dependencies: string[];
  progress: number;
  logs: string[];
  startedAt: string | null;
  completedAt: string | null;
  error: ReturnType<
    typeof import("../../shared/src/index.ts").errorInfo
  > | null;
  retryCount: number;
  producedAssets: string[];
}
