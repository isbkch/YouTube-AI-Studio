import type { Project } from "./model.ts";
import { DIRECTOR_PROFILES } from "../../shared/src/index.ts";

/**
 * Channel-level style memory: deterministic mining of the creator's own past
 * decisions — applied and rejected plan revisions, visual treatments stripped
 * by hand, the knobs published videos actually shipped with, and pacing
 * repairs the Producer had to make — distilled into steering notes the
 * Director prompt carries into every new plan. The Director never sees raw
 * history, only these conclusions; every note is earned by counted evidence,
 * never invented, and Producer-made decisions (auto-applied visual passes,
 * auto-repairs) are excluded so the channel's taste stays the creator's.
 */
export interface StyleProfile {
  /** Steering notes, strongest signal first; empty when history says nothing. */
  notes: string[];
  evidence: {
    projects: number;
    published: number;
    creatorAppliedPatches: number;
    rejectedPatches: number;
    visualTreatmentsStripped: number;
    tighteningReDirects: number;
    publishedDensity: Record<string, number>;
  };
}

/** Notes are few and short: prompts carry conclusions, not archives. */
const MAX_NOTES = 6;
const MAX_NOTE_LENGTH = 240;
const TIGHTENING_ORDER = { natural: 0, tight: 1, punchy: 2 } as const;

/** A revision row the creator decided (legacy rows without attribution count). */
const creatorDecided = (r: Project["revisions"][number]) =>
  (r.decidedBy ?? "creator") === "creator" &&
  !r.patch.originatingRequest.startsWith("Producer auto-repair");

export function styleProfile(projects: Project[]): StyleProfile {
  const evidence: StyleProfile["evidence"] = {
    projects: projects.length,
    published: 0,
    creatorAppliedPatches: 0,
    rejectedPatches: 0,
    visualTreatmentsStripped: 0,
    tighteningReDirects: 0,
    publishedDensity: {},
  };
  const notes: string[] = [];
  const densityOverrides: string[] = [];
  for (const p of projects) {
    for (const r of p.revisions) {
      if (r.status === "REJECTED") evidence.rejectedPatches++;
      if (r.status !== "APPLIED" || !creatorDecided(r)) continue;
      evidence.creatorAppliedPatches++;
      for (const op of r.patch.operations) {
        if (
          (op.type === "disableScene" && op.disabled) ||
          op.type === "removeGraphic"
        )
          evidence.visualTreatmentsStripped++;
      }
    }
    // Pacing lessons: each tightening step up across consecutive plan
    // versions is one "came in over target" the next first cut can avoid.
    for (let i = 1; i < p.plans.length; i++)
      if (
        TIGHTENING_ORDER[p.plans[i].silenceTightening] >
        TIGHTENING_ORDER[p.plans[i - 1].silenceTightening]
      )
        evidence.tighteningReDirects++;
    if (p.publication) {
      evidence.published++;
      const plan = p.plans.at(-1);
      if (plan) {
        evidence.publishedDensity[plan.visualDensity] =
          (evidence.publishedDensity[plan.visualDensity] ?? 0) + 1;
        // The plan records the density it was generated at; a mismatch with
        // the hired persona's default is an explicit creator override.
        if (
          plan.visualDensity !==
          DIRECTOR_PROFILES[plan.directorPersona].visualDensity
        )
          densityOverrides.push(plan.visualDensity);
      }
    }
  }
  if (evidence.visualTreatmentsStripped >= 2)
    notes.push(
      `The creator's own applied edits stripped visual treatments from ${evidence.visualTreatmentsStripped} scenes across the library — lean presenter-led and reserve graphics for the strongest clarifications.`,
    );
  if (evidence.tighteningReDirects >= 2)
    notes.push(
      `${evidence.tighteningReDirects} past plan versions came in over target and were re-directed tighter — bias the first cut toward brisker pacing.`,
    );
  const overrideModes = [...new Set(densityOverrides)];
  if (
    evidence.published >= 2 &&
    densityOverrides.length === evidence.published &&
    overrideModes.length === 1
  )
    notes.push(
      `Every published video (${evidence.published}) overrode its director's density default to "${overrideModes[0]}" — direct at "${overrideModes[0]}" unless this production says otherwise.`,
    );
  return {
    notes: notes.slice(0, MAX_NOTES).map((n) => n.slice(0, MAX_NOTE_LENGTH)),
    evidence,
  };
}
