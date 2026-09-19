import type { NarrationLead } from "../../shared/src/index.ts";
import type { ProductionPlan } from "../../production-plan/src/index.ts";
import type { Recording, Transcript } from "./model.ts";

/**
 * Narration leads (J/L-style audio crossings), computed deterministically
 * from the approved plan and word-timed transcripts — never the model, never
 * stored on the plan (the plan records only the level, like caption styles).
 *
 * A lead applies to exactly one side of the boundary: the outgoing scene's
 * audio extends past the video cut, landing inside the incoming scene's
 * leading silence. The incoming block's source↔timeline mapping is untouched
 * — its head silence IS the crossing room — so no word can move, drop or
 * double. Two word-timing constraints make every lead word-safe by
 * construction:
 *
 *  - the outgoing extension stops before the next speech in its own
 *    recording (a word already in progress at the cut counts as speech and
 *    keeps the hard cut);
 *  - the extension stops before the incoming scene's first spoken word.
 *
 * "subtle" uses half the available gap, "flowing" all of it, both capped.
 * Boundaries need complete word timings and real audio on both sides;
 * everything else keeps today's exact A/V cut.
 */
export interface AudioLeadDecision {
  level: NarrationLead;
  /** Boundaries that earned a lead, in plan order. */
  leads: { sceneId: string; nextSceneId: string; seconds: number }[];
  /** Per-scene tail extensions (seconds) the assembly applies; heads never move. */
  scenes: { sceneId: string; tailLeadSec: number }[];
  stats: {
    boundaries: number;
    leads: number;
    totalSeconds: number;
    maxSeconds: number;
    /** Recordings unusable for leads (no audio, or incomplete word timings). */
    skippedRecordings: string[];
  };
}

/** Leads never exceed half a second at one boundary. */
export const MAX_LEAD_SEC = 0.5;
/** Below a twentieth of a second a lead is inaudible; keep the cut exact. */
export const MIN_LEAD_SEC = 0.05;
/** "subtle" crosses half the available word gap. */
const SUBTLE_FRACTION = 0.5;

interface TimedWord {
  start: number;
  end: number;
}

/**
 * Word timings for one recording, or null when unusable: every speech
 * segment must carry word timings, or unrepresented speech would be
 * invisible to the word-safety constraints.
 */
function timedWords(transcript: Transcript | undefined): TimedWord[] | null {
  if (!transcript?.segments.length) return null;
  if (transcript.segments.some((s) => s.text.trim() && !s.words?.length))
    return null;
  const words = transcript.segments.flatMap((s) =>
    (s.words ?? []).map((w) => ({ start: w.start, end: w.end })),
  );
  words.sort((a, b) => a.start - b.start);
  return words;
}

export function computeAudioLeads(
  plan: ProductionPlan,
  transcripts: Transcript[],
  recordings: Recording[],
): AudioLeadDecision {
  const decision: AudioLeadDecision = {
    level: plan.narrationLead,
    leads: [],
    scenes: plan.scenes.map((s) => ({ sceneId: s.id, tailLeadSec: 0 })),
    stats: {
      boundaries: 0,
      leads: 0,
      totalSeconds: 0,
      maxSeconds: 0,
      skippedRecordings: [],
    },
  };
  if (plan.narrationLead === "none") return decision;
  const fps = plan.frameRate;
  const latest = new Map(transcripts.map((t) => [t.recordingId, t]));
  const words = new Map<string, TimedWord[] | null>();
  const durations = new Map(recordings.map((r) => [r.id, r.duration]));
  const audible = new Map(recordings.map((r) => [r.id, r.hasAudio]));
  const unusable = (id: string) => {
    if (!decision.stats.skippedRecordings.includes(id))
      decision.stats.skippedRecordings.push(id);
  };
  for (const scene of plan.scenes) {
    const id = scene.camera.recordingId;
    if (words.has(id)) continue;
    const usable = timedWords(latest.get(id));
    words.set(id, usable);
    if (!usable || audible.get(id) !== true) unusable(id);
  }
  const offsets = new Map(plan.scenes.map((s, i) => [s.id, i]));
  for (let i = 0; i + 1 < plan.scenes.length; i++) {
    decision.stats.boundaries++;
    const outgoing = plan.scenes[i];
    const incoming = plan.scenes[i + 1];
    const outWords = words.get(outgoing.camera.recordingId);
    const inWords = words.get(incoming.camera.recordingId);
    if (!outWords || !inWords) continue;
    if (
      audible.get(outgoing.camera.recordingId) !== true ||
      audible.get(incoming.camera.recordingId) !== true
    )
      continue;
    const outRange = {
      start: outgoing.sourceInFrame / fps,
      end: (outgoing.sourceInFrame + outgoing.durationFrames) / fps,
    };
    const inRange = {
      start: incoming.sourceInFrame / fps,
      end: (incoming.sourceInFrame + incoming.durationFrames) / fps,
    };
    // The outgoing extension must stop before the next speech in its own
    // recording — including a word still in progress at the cut, whose
    // start lies inside the range and makes the allowance negative.
    const nextWord = outWords.find((w) => w.end > outRange.end);
    const outAvailable = Math.min(
      nextWord ? nextWord.start - outRange.end : MAX_LEAD_SEC,
      (durations.get(outgoing.camera.recordingId) ?? outRange.end) -
        outRange.end,
    );
    // The extension lands inside the incoming scene's leading silence: it
    // must stop before the incoming scene's first spoken word.
    const firstWord = inWords.find((w) => w.end > inRange.start);
    const inAvailable = firstWord
      ? firstWord.start - inRange.start
      : MAX_LEAD_SEC;
    const available = Math.min(outAvailable, inAvailable, MAX_LEAD_SEC);
    const seconds =
      Math.round(
        (plan.narrationLead === "flowing"
          ? available
          : available * SUBTLE_FRACTION) * 1000,
      ) / 1000;
    if (seconds < MIN_LEAD_SEC) continue;
    decision.leads.push({
      sceneId: outgoing.id,
      nextSceneId: incoming.id,
      seconds,
    });
    decision.scenes[offsets.get(outgoing.id)!].tailLeadSec = seconds;
    decision.stats.leads++;
    decision.stats.totalSeconds += seconds;
    decision.stats.maxSeconds = Math.max(decision.stats.maxSeconds, seconds);
  }
  return decision;
}
