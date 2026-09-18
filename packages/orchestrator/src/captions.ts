import type { CaptionStyle } from "../../shared/src/index.ts";
import type { ProductionPlan } from "../../production-plan/src/index.ts";
import type { BridgeTranscript } from "./aroll.ts";

/**
 * Deterministic punch-line captions: picks the lines worth subtitling from
 * word-timed transcripts and maps them onto the output timeline. No model
 * calls — caption text is transcript-exact by construction, which is what
 * keeps subtitles honest (the viewer only ever reads what was spoken).
 *
 * Events are never persisted on the plan. Previews and the build compute them
 * from the same approved plan + transcripts through this module, so patches
 * (splits, merges, timing edits) can never leave stale caption frames behind.
 */

export interface CaptionEvent {
  id: string;
  sceneId: string;
  startFrame: number;
  endFrame: number;
  text: string;
  /** Word reveal timings in output frames; drive the karaoke highlight. */
  words: { atFrame: number; text: string }[];
}

export interface CaptionPlan {
  style: CaptionStyle;
  events: CaptionEvent[];
  /** Recordings without word timings; their scenes get no captions. */
  skippedRecordings: string[];
}

// How long a caption lingers before/after the spoken words it covers.
const HEAD_PAD_SEC = 0.12;
const TAIL_HOLD_SEC = 0.5;
const MIN_DISPLAY_SEC = 0.8;
const MAX_DISPLAY_SEC = 4;
// Sentence assembly: a punctuation terminator or a pause this wide ends a
// sentence. Mirrors the phrase segmentation the whisper regrouper uses.
const SENTENCE_PAUSE_SEC = 1.2;

const MAX_TEXT_CHARS = 64;

/** Per-style selection bar: score threshold, per-scene cap, pacing gap. */
const STYLE_RULES: Record<
  Exclude<CaptionStyle, "none">,
  { minScore: number; perScene: number; minGapSec: number }
> = {
  // One emphasis cue plus brevity (or a weaker cue in the scene-final zinger
  // spot) earns a pop; karaoke lowers the bar and packs beats tighter.
  pop: { minScore: 1.4, perScene: 1, minGapSec: 6 },
  karaoke: { minScore: 1.0, perScene: 2, minGapSec: 2.5 },
};

// A punch line earns its subtitle through emphasis cues. Each pattern that
// hits adds to the score; the scene-final position is the classic zinger
// spot and gets its own bonus.
const EMPHASIS_PATTERNS: RegExp[] = [
  /\b(not|never|no|nothing|nobody|cannot|can't|won't|don't|isn't|doesn't)\b/i,
  /\b\d+([.,]\d+)?%?\b/,
  /\b(best|worst|most|least|first|last|only|biggest|fastest|cheapest)\b/i,
  /\b(problem|fail|failed|wrong|mistake|truth|myth|lie|catch)\b/i,
  /\b(that'?s why|here'?s the thing|the point is|bottom line|in fact|it turns out|turns out)\b/i,
  /"[^"]{8,}"/,
];

interface Sentence {
  text: string;
  start: number;
  end: number;
  words: { start: number; end: number; text: string }[];
}

/** Group a flat word timeline into sentences by punctuation and pauses. */
function sentencesFromWords(
  words: { start: number; end: number; text: string }[],
): Sentence[] {
  const out: Sentence[] = [];
  let current: Sentence | null = null;
  for (const w of words) {
    if (
      current &&
      w.start - current.end > SENTENCE_PAUSE_SEC &&
      current.words.length >= 3
    ) {
      // A long enough pause ends the sentence even without punctuation; the
      // speaker moved on, and a caption hugging the pause reads better.
      out.push(current);
      current = null;
    }
    if (!current) current = { text: "", start: w.start, end: w.end, words: [] };
    current.words.push(w);
    current.text = (current.text ? current.text + " " : "") + w.text;
    current.end = w.end;
    const terminal = /[.!?…]["')\]]?$/.test(w.text);
    if (terminal) {
      out.push(current);
      current = null;
    }
  }
  if (current && current.words.length >= 3) out.push(current);
  return out;
}

function scoreSentence(sentence: Sentence, isSceneFinal: boolean): number {
  const wordCount = sentence.words.length;
  if (wordCount < 3 || wordCount > 14) return 0;
  if (sentence.text.length > MAX_TEXT_CHARS) return 0;
  let score = 0;
  for (const pattern of EMPHASIS_PATTERNS)
    if (pattern.test(sentence.text)) score += 1;
  // Short and punchy beats long and hedged.
  if (wordCount <= 8) score += 0.5;
  if (isSceneFinal) score += 0.25;
  if (/\?$/.test(sentence.text)) score -= 0.1;
  return score;
}

/** Compute the punch-line caption events for an approved plan. */
export function computeCaptionEvents(
  plan: ProductionPlan,
  transcripts: BridgeTranscript[],
): CaptionPlan {
  const result: CaptionPlan = {
    style: plan.captionStyle,
    events: [],
    skippedRecordings: [],
  };
  if (plan.captionStyle === "none") return result;
  const rules = STYLE_RULES[plan.captionStyle];
  const fps = plan.frameRate;
  const seen = new Map<string, BridgeTranscript[]>();
  for (const t of transcripts) {
    const list = seen.get(t.recordingId) ?? [];
    list.push(t);
    seen.set(t.recordingId, list);
  }
  for (const scene of plan.scenes) {
    // Disabled scenes keep their A-roll but no derived visual layers — the
    // same rule graphics and B-roll follow.
    if (!scene.enabled) continue;
    const recordingId = scene.camera.recordingId;
    const transcript = (seen.get(recordingId) ?? []).at(-1);
    if (!transcript) continue;
    const sourceInSec = scene.sourceInFrame / fps;
    const sourceEndSec = (scene.sourceInFrame + scene.durationFrames) / fps;
    // Words inside the selected range (tightened edges hug speech, so words
    // fully inside the range are exactly the spoken content of this scene).
    const inRange = transcript.segments
      .flatMap((s) => s.words ?? [])
      .filter(
        (w) => w.start >= sourceInSec - 0.05 && w.end <= sourceEndSec + 0.05,
      )
      .sort((a, b) => a.start - b.start);
    if (!inRange.length) {
      if (
        transcript.segments.some(
          (s) => s.end > sourceInSec && s.start < sourceEndSec,
        ) &&
        !result.skippedRecordings.includes(recordingId)
      )
        result.skippedRecordings.push(recordingId);
      continue;
    }
    const toOutFrame = (t: number) =>
      scene.startFrame +
      Math.min(
        scene.durationFrames,
        Math.max(0, Math.round((t - sourceInSec) * fps)),
      );
    const sentences = sentencesFromWords(inRange);
    const candidates = sentences
      .map((sentence, i) => ({
        sentence,
        score: scoreSentence(sentence, i === sentences.length - 1),
      }))
      .filter((c) => c.score >= rules.minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, rules.perScene);
    for (const { sentence } of candidates) {
      const startFrame = Math.max(
        scene.startFrame,
        toOutFrame(sentence.start) - Math.round(HEAD_PAD_SEC * fps),
      );
      const endFrame = Math.min(
        scene.startFrame + scene.durationFrames,
        toOutFrame(sentence.end) + Math.round(TAIL_HOLD_SEC * fps),
      );
      if (endFrame - startFrame < Math.round(MIN_DISPLAY_SEC * fps)) continue;
      result.events.push({
        id: `caption-${scene.id}-${result.events.length + 1}`,
        sceneId: scene.id,
        startFrame,
        endFrame: Math.max(
          startFrame + Math.round(MIN_DISPLAY_SEC * fps),
          Math.min(endFrame, startFrame + Math.round(MAX_DISPLAY_SEC * fps)),
        ),
        text: sentence.text,
        words: sentence.words.map((w) => ({
          atFrame: toOutFrame(w.start),
          text: w.text,
        })),
      });
    }
  }
  // Enforce pacing and non-overlap across the whole timeline.
  const minGap = Math.round(rules.minGapSec * fps);
  const kept: CaptionEvent[] = [];
  for (const event of result.events.sort(
    (a, b) => a.startFrame - b.startFrame,
  )) {
    const last = kept.at(-1);
    if (last && event.startFrame < last.endFrame + minGap) continue;
    kept.push(event);
  }
  result.events = kept;
  return result;
}
