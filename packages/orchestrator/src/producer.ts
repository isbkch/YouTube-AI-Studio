import { id, now } from "../../shared/src/index.ts";
import type {
  Operation,
  ProductionPlan,
} from "../../production-plan/src/index.ts";
import type { ProducerReview } from "./model.ts";

/**
 * The deterministic Producer (v2): a pure, offline reviewer and repair
 * planner for the machine-made gates. It re-derives nothing that generation
 * already proved — `validateSources` passed when the plan was created or
 * imported — and instead judges the editorial envelope: how much of the
 * approved script survived, whether the cut honors the target duration, and
 * whether the QA document carries only findings the pipeline understands as
 * benign. Storyboard verdicts are total: zero blockers approves. Rough-cut
 * verdicts approve warnings in the benign set with the evidence recorded;
 * everything else escalates. Mechanical escalations come with a deterministic
 * repair plan (`planStoryboardRepair`/`planRoughCutRepair`) the advance loop
 * may execute within its repair budget; semantic findings (coverage omissions,
 * unknown warnings) never repair and always reach the human.
 */
export const PRODUCER_REVIEWER = "deterministic-v2";
/** Above this share of omitted script sentences the storyboard escalates. */
export const MAX_OMISSION_RATIO = 0.25;
/** Duration bounds around the target, mirroring the Director's budget heuristics. */
export const DURATION_FACTORS: readonly [number, number] = [0.4, 1.6];
/**
 * Repairs the advance loop may execute per invocation. Two is enough for the
 * tightening ladder (natural → tight → punchy) or one disable round plus one
 * gain round, and bounds billed Director regenerations on autonomous projects.
 */
export const MAX_PRODUCER_REPAIRS = 2;
/**
 * Rough-cut warning codes the Producer may approve with recorded evidence.
 * Each is advisory by construction: pacing pauses are the hired director's
 * choice, mock transcripts only exist in mock pipelines, spare unused takes
 * are normal, and the storyboard gate has already bounded duration (QA's
 * 0.5×–1.5× band is stricter than the 0.4×–1.6× gate). Unknown codes are
 * never benign — an unclassifiable warning escalates.
 */
export const BENIGN_WARNING_CODES: ReadonlySet<string> = new Set([
  "audio.silence",
  "transcript.mock",
  "coverage.unusedRecording",
  "duration.offTarget",
]);
/** Scene-gain step (dB) applied by the peaks repair, inside the schema floor. */
const PEAKS_GAIN_STEP_DB = 2;
/** At most this many scenes — and at most a quarter of the cut — may have
 * their visual treatment auto-disabled by one repair; beyond that the flags
 * describe a systemic problem the creator must see. */
const MAX_REPAIR_DISABLED_SCENES = 3;

/** Tightening outcome of the deterministic A-roll decision for this plan. */
export interface TighteningStats {
  level: "natural" | "tight" | "punchy";
  skippedRecordings: string[];
}

/** The structural subset of the persisted QA document the review reads. */
export interface QAReportInput {
  status: string;
  warnings: string[];
  attention: string[];
  metadata?: { duration?: number };
  audio?: { silenceStarts?: unknown[]; maxVolumeDb?: number | null };
}

const truncate = (text: string, at = 120) =>
  text.length > at ? `${text.slice(0, at - 1)}…` : text;

/**
 * Map each QA warning string onto a triage code. The QA document persists
 * warnings as prose; the codes below cover every warning `build.ts` emits so
 * findings stay machine-groupable, with `qa.warning` as the fallback.
 */
function warningCode(warning: string): string {
  if (/silence interval/i.test(warning)) return "audio.silence";
  if (/peaks? exceed/i.test(warning)) return "audio.peaks";
  if (/no narration audio/i.test(warning)) return "audio.silentSource";
  if (/mock transcript/i.test(warning)) return "transcript.mock";
  if (/placeholder/i.test(warning)) return "narration.placeholder";
  if (/target; review pacing/i.test(warning)) return "duration.offTarget";
  if (/unused by this cut/i.test(warning)) return "coverage.unusedRecording";
  if (/black interval/i.test(warning)) return "visual.black";
  if (/frozen interval/i.test(warning)) return "visual.frozen";
  if (/visual QA unavailable/i.test(warning)) return "visual.unavailable";
  return "qa.warning";
}

const coverageEvidence = (plan: ProductionPlan) => {
  const sentences = plan.scriptCoverage?.sentences ?? [];
  const omitted = sentences.filter((s) => s.status === "omitted");
  return { sentences, omitted };
};

/**
 * Review the storyboard gate. Blockers: script-coverage omission ratio above
 * 25%, or a duration outside 0.4×–1.6× the target. Everything else — reasoned
 * omissions, tightening skips, a caption style with no events — is a warning
 * the creator can read after the fact. `validateSources` honesty was already
 * enforced when the plan entered the project; it is recorded as an evidence
 * check, not re-derived here.
 */
export function reviewStoryboard(
  plan: ProductionPlan,
  targetDuration: number,
  tighteningStats: TighteningStats | null = null,
  captionEventCount: number | null = null,
): ProducerReview {
  const findings: ProducerReview["findings"] = [];
  const { sentences, omitted } = coverageEvidence(plan);
  const durationSeconds = plan.durationFrames / plan.frameRate;
  findings.push({
    severity: "info",
    code: "sources.validated",
    message:
      "Recording/transcript references and editorial honesty (no replayed frames, narration spoken in range) passed validateSources when this plan entered the project.",
  });
  if (plan.scriptCoverage) {
    const ratio = sentences.length ? omitted.length / sentences.length : 0;
    if (ratio > MAX_OMISSION_RATIO)
      findings.push({
        severity: "blocker",
        code: "coverage.omissionRatio",
        message: `${omitted.length} of ${sentences.length} approved sentences are omitted (${Math.round(ratio * 100)}%), above the ${MAX_OMISSION_RATIO * 100}% ceiling.`,
      });
    for (const s of omitted)
      findings.push({
        severity: "warn",
        code: "coverage.omitted",
        message: `Omitted "${truncate(s.text)}" — ${s.reason ?? "no recorded reason"}.`,
      });
  } else {
    findings.push({
      severity: "info",
      code: "coverage.unavailable",
      message:
        "The plan carries no script coverage (authored without an alignment); sentence omissions were not machine-checkable.",
    });
  }
  const [low, high] = DURATION_FACTORS;
  if (durationSeconds < targetDuration * low)
    findings.push({
      severity: "blocker",
      code: "duration.under",
      message: `The cut runs ${durationSeconds.toFixed(1)}s against a ${Math.round(targetDuration)}s target, under the ${low}× floor.`,
    });
  else if (durationSeconds > targetDuration * high)
    findings.push({
      severity: "blocker",
      code: "duration.over",
      message: `The cut runs ${durationSeconds.toFixed(1)}s against a ${Math.round(targetDuration)}s target, over the ${high}× ceiling.`,
    });
  if (
    tighteningStats &&
    tighteningStats.level !== "natural" &&
    tighteningStats.skippedRecordings.length
  )
    findings.push({
      severity: "warn",
      code: "tightening.skipped",
      message: `Silence tightening (${tighteningStats.level}) skipped ${tighteningStats.skippedRecordings.length} recording(s) without word timings: ${tighteningStats.skippedRecordings.join(", ")}.`,
    });
  if (plan.captionStyle !== "none" && captionEventCount === 0)
    findings.push({
      severity: "warn",
      code: "captions.none",
      message: `Caption style is ${plan.captionStyle} but no punch-line caption events were derived from the word-timed transcripts.`,
    });
  return {
    id: id("producer-review"),
    gate: "storyboard",
    planVersion: plan.version,
    verdict: findings.some((f) => f.severity === "blocker")
      ? "escalated"
      : "approved",
    checkedAt: now(),
    reviewer: PRODUCER_REVIEWER,
    findings,
    evidence: {
      sentences: sentences.length,
      omitted: omitted.length,
      scenes: plan.scenes.length,
      durationSeconds,
    },
  };
}

/**
 * Review the rough-cut gate against the persisted QA document. The verdict
 * approves a PASS whose warnings are all understood as benign — pacing
 * pauses, mock transcripts, spare takes, advisory duration — and records the
 * accepted codes as evidence. Any blocker (flagged scene/still, non-PASS),
 * any warning outside the benign set (peaks, placeholders, anomalies,
 * unclassifiable prose), or a hot mix escalates with the deviation triaged
 * inline.
 */
export function reviewRoughCut(
  plan: ProductionPlan,
  qa: QAReportInput,
): ProducerReview {
  const findings: ProducerReview["findings"] = [];
  const { sentences, omitted } = coverageEvidence(plan);
  if (qa.status !== "PASS" || qa.attention.length)
    findings.push({
      severity: "blocker",
      code: "qa.attention",
      message: `QA status is ${qa.status}; ${new Set(qa.attention).size} scene(s)/still(s) flagged for attention${qa.attention.length ? `: ${[...new Set(qa.attention)].join(", ")}` : ""}.`,
    });
  for (const warning of qa.warnings)
    findings.push({
      severity: "warn",
      code: warningCode(warning),
      message: warning,
    });
  if (qa.audio?.silenceStarts?.length)
    findings.push({
      severity: "warn",
      code: "audio.silence",
      message: `${qa.audio.silenceStarts.length} silence interval(s) of 2 seconds or more in the mixed cut.`,
    });
  if (typeof qa.audio?.maxVolumeDb === "number" && qa.audio.maxVolumeDb > -1)
    findings.push({
      severity: "warn",
      code: "audio.peaks",
      message: `Audio peaks at ${qa.audio.maxVolumeDb.toFixed(1)} dBFS, above the -1 dBFS ceiling.`,
    });
  const codes = new Set(findings.map((f) => f.code));
  const approvedWith = [...codes].filter((c) => BENIGN_WARNING_CODES.has(c));
  return {
    id: id("producer-review"),
    gate: "rough-cut",
    planVersion: plan.version,
    verdict:
      qa.status === "PASS" &&
      qa.attention.length === 0 &&
      codes.size === approvedWith.length
        ? "approved"
        : "escalated",
    checkedAt: now(),
    reviewer: PRODUCER_REVIEWER,
    findings,
    evidence: {
      sentences: sentences.length,
      omitted: omitted.length,
      scenes: plan.scenes.length,
      durationSeconds:
        qa.metadata?.duration ?? plan.durationFrames / plan.frameRate,
      qaStatus: qa.status,
      warnings: qa.warnings.length,
      attention: qa.attention.length,
      ...(approvedWith.length ? { approvedWithWarnings: approvedWith } : {}),
    },
  };
}

/**
 * A deterministic fix the Producer may execute for an escalated review:
 * re-direct the plan at a different silence-tightening level, or apply a
 * patch of existing plan operations. Null means the escalation is semantic
 * (or already at the mechanical limit) and must reach the creator.
 */
export type ProducerRepair =
  | {
      kind: "regenerate";
      tightening: "natural" | "tight" | "punchy";
      reason: string;
    }
  | {
      kind: "patch";
      operations: Operation[];
      affectedScenes: string[];
      rationale: string;
    };

const TIGHTENING_ORDER = ["natural", "tight", "punchy"] as const;
const stepTightening = (
  level: ProductionPlan["silenceTightening"],
  direction: 1 | -1,
): ProductionPlan["silenceTightening"] | null => {
  const index = TIGHTENING_ORDER.indexOf(level);
  const next = TIGHTENING_ORDER[index + direction];
  return next ?? null;
};

const blockerCodes = (review: ProducerReview) =>
  review.findings.filter((f) => f.severity === "blocker").map((f) => f.code);

/**
 * Repair plan for an escalated storyboard review. Duration blockers repair by
 * re-directing the plan one tightening step toward the target — a shorter
 * (tighter) cut when over, a longer (looser) cut when under — reusing the
 * plan's own persona, density, captions and polish so only pacing changes.
 * Coverage omissions never repair: missing spoken words are the creator's to
 * re-record, not the Producer's to route around.
 */
export function planStoryboardRepair(
  review: ProducerReview,
  plan: ProductionPlan,
): Extract<ProducerRepair, { kind: "regenerate" }> | null {
  const blockers = blockerCodes(review);
  if (blockers.includes("coverage.omissionRatio")) return null;
  const over = blockers.includes("duration.over");
  const under = blockers.includes("duration.under");
  if (over === under) return null; // Nothing mechanical (or contradictory).
  const next = stepTightening(plan.silenceTightening, over ? 1 : -1);
  if (!next) return null; // Already at the mechanical limit.
  const finding = review.findings.find(
    (f) => f.code === (over ? "duration.over" : "duration.under"),
  );
  return {
    kind: "regenerate",
    tightening: next,
    reason: `${finding?.code ?? "duration"}: ${finding?.message ?? "cut is off target"} Re-directing at ${next} pacing.`,
  };
}

/**
 * Repair plan for an escalated rough-cut review. Visual-attention flags
 * repair by disabling the flagged scenes' visual treatments — the A-roll,
 * audio and duration are untouched, so the cut stays honest while the broken
 * overlay comes out — bounded by {@link MAX_REPAIR_DISABLED_SCENES} and only
 * when every flagged scene actually has a removable treatment. Hot peaks
 * repair by backing every scene's narration gain off
 * {@link PEAKS_GAIN_STEP_DB} dB within the schema floor. Anything else —
 * unremovable flags, too many flags, placeholders, anomalies, unknown
 * warnings — is for the creator.
 */
export function planRoughCutRepair(
  review: ProducerReview,
  plan: ProductionPlan,
  qa: QAReportInput,
): Extract<ProducerRepair, { kind: "patch" }> | null {
  const blockers = blockerCodes(review);
  const operations: Operation[] = [];
  const affectedScenes: string[] = [];
  const reasons: string[] = [];
  if (blockers.includes("qa.attention")) {
    const flagged = [...new Set(qa.attention)];
    const removable = flagged.filter((sceneId) => {
      const scene = plan.scenes.find((s) => s.id === sceneId);
      return (
        !!scene &&
        scene.enabled &&
        (!!scene.visual.graphic || scene.broll.length > 0)
      );
    });
    if (removable.length !== flagged.length) return null; // A flag we cannot remove.
    if (
      flagged.length > MAX_REPAIR_DISABLED_SCENES ||
      flagged.length > Math.ceil(plan.scenes.length / 4)
    )
      return null; // Systemic, not scene-local.
    for (const sceneId of removable) {
      operations.push({ type: "disableScene", sceneId, disabled: true });
      affectedScenes.push(sceneId);
    }
    reasons.push(
      `disabled the visual treatment of ${removable.length} QA-flagged scene(s) (${removable.join(", ")})`,
    );
  }
  const codes = new Set(review.findings.map((f) => f.code));
  if (codes.has("audio.peaks")) {
    const floor = Math.min(...plan.scenes.map((s) => s.audio.gainDb));
    if (floor - PEAKS_GAIN_STEP_DB >= -24) {
      for (const scene of plan.scenes) {
        operations.push({
          type: "updateAudio",
          sceneId: scene.id,
          gainDb: scene.audio.gainDb - PEAKS_GAIN_STEP_DB,
        });
        affectedScenes.push(scene.id);
      }
      reasons.push(
        `backed every scene's narration gain off by ${PEAKS_GAIN_STEP_DB} dB below the -1 dBFS ceiling`,
      );
    }
  }
  if (!operations.length) return null;
  return {
    kind: "patch",
    operations,
    affectedScenes: [...new Set(affectedScenes)],
    rationale: `Producer auto-repair: ${reasons.join("; ")}.`,
  };
}
