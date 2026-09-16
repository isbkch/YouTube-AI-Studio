import type {
  ProductionPlan,
  PlanPatch,
} from "../../production-plan/src/index.ts";
import type { CreatorProfile, Usage } from "../../shared/src/index.ts";
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
  approvedBy: "creator";
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
}
export interface Recording extends MediaInfo {
  id: string;
  name: string;
  path: string;
  hash: string;
  importedAt: string;
  proxyPath: string | null;
  proxyStatus: "PENDING" | "AVAILABLE" | "NOT_REQUIRED";
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
    | "audio-mix";
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
  publication: { videoId: string; url: string; publishedAt: string } | null;
  publishApproval: Approval | null;
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
