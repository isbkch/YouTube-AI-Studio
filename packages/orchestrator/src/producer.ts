import { id, now } from "../../shared/src/index.ts";
import type { ProductionPlan } from "../../production-plan/src/index.ts";
import type { ProducerReview } from "./model.ts";

/**
 * The deterministic Producer (v1): a pure, offline reviewer for the
 * machine-made gates. It re-derives nothing that generation already proved —
 * `validateSources` passed when the plan was created or imported — and instead
 * judges the editorial envelope: how much of the approved script survived,
 * whether the cut honors the target duration, and whether the QA document is
 * spotless. Verdicts are total: zero blockers approves the storyboard gate;
 * any QA warning, flagged scene or non-PASS status escalates the rough cut.
 */
export const PRODUCER_REVIEWER = "deterministic-v1";
/** Above this share of omitted script sentences the storyboard escalates. */
export const MAX_OMISSION_RATIO = 0.25;
/** Duration bounds around the target, mirroring the Director's budget heuristics. */
export const DURATION_FACTORS: readonly [number, number] = [0.4, 1.6];

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
 * Review the rough-cut gate against the persisted QA document. Strict: the
 * verdict approves only a spotless PASS — any warning, flagged scene or still,
 * or non-PASS status escalates with the deviation triaged inline.
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
  return {
    id: id("producer-review"),
    gate: "rough-cut",
    planVersion: plan.version,
    verdict:
      qa.status === "PASS" &&
      qa.warnings.length === 0 &&
      qa.attention.length === 0
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
    },
  };
}
