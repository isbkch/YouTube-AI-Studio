import path from "node:path";
import { fileHash, safePath, StudioError } from "../../shared/src/index.ts";
import { extractFrames, loudnessEnvelope } from "../../media/src/index.ts";
import { chapterStamp, planChapters } from "../../agents/src/packaging.ts";
import { computeCaptionEvents, type CaptionEvent } from "./captions.ts";
import { transcriptsForPlan } from "./transcript-history.ts";
import type { Store } from "./store.ts";
import type { Project } from "./model.ts";
import type { ThumbnailFrame, ThumbnailFrames } from "./thumbnail-model.ts";

/**
 * Expressive-frame candidates for thumbnail backgrounds: the moments in the
 * finished master where the delivered cut already proved something was
 * happening — punchline caption moments ranked by the vocal energy around
 * them, plus chapter title beats. Deterministic throughout: the caption
 * picker and the loudness envelope are the same signals previews and the
 * build use, so a frame is never a model's guess about the video.
 */

export interface FrameCandidate {
  seconds: number;
  captionText: string | null;
  loudnessDb: number | null;
}

const ENERGY_WINDOW_SEC = 0.75;
const MIN_GAP_SEC = 2;
const DEFAULT_COUNT = 6;

/** Mean momentary loudness around a timestamp; null without envelope data. */
function energyAt(
  envelope: { seconds: number; loudnessDb: number }[],
  seconds: number,
): number | null {
  const window = envelope.filter(
    (p) => Math.abs(p.seconds - seconds) <= ENERGY_WINDOW_SEC,
  );
  if (!window.length) return null;
  return window.reduce((sum, p) => sum + p.loudnessDb, 0) / window.length;
}

/**
 * Rank and space the candidates: punchlines first (energy breaks ties toward
 * takes delivered with real vocal force), chapter beats after, never closer
 * than {@link MIN_GAP_SEC}, never past the end of the master.
 */
export function planFrameCandidates(
  events: CaptionEvent[],
  chapters: { seconds: number }[],
  envelope: { seconds: number; loudnessDb: number }[],
  frameRate: number,
  durationSeconds: number,
  count = DEFAULT_COUNT,
): FrameCandidate[] {
  const clamp = (s: number) => Math.min(durationSeconds, Math.max(0, s));
  const ranked: FrameCandidate[] = [
    ...events
      .map((event) => {
        const midWord = event.words[Math.floor(event.words.length / 2)];
        const seconds = clamp(
          (midWord?.atFrame ??
            Math.floor((event.startFrame + event.endFrame) / 2)) / frameRate,
        );
        return {
          seconds,
          captionText: event.text,
          loudnessDb: energyAt(envelope, seconds),
        };
      })
      .sort(
        (a, b) =>
          (b.loudnessDb ?? -Infinity) - (a.loudnessDb ?? -Infinity) ||
          a.seconds - b.seconds,
      ),
    ...chapters
      .map((chapter) => ({
        seconds: clamp(chapter.seconds),
        captionText: null,
        loudnessDb: null,
      }))
      .sort((a, b) => a.seconds - b.seconds),
  ];
  const kept: FrameCandidate[] = [];
  for (const candidate of ranked) {
    if (kept.length >= count) break;
    if (kept.some((k) => Math.abs(k.seconds - candidate.seconds) < MIN_GAP_SEC))
      continue;
    kept.push(candidate);
  }
  return kept;
}

/**
 * Cut the candidates out of the final render and cache them on the project.
 * Recomputed only when the master's bytes change; every returned frame is
 * hash-verified against the file it was cut from.
 */
export async function extractExpressiveFrames(
  store: Store,
  p: Project,
  signal?: AbortSignal,
): Promise<{ frames: ThumbnailFrames; cached: boolean }> {
  if (!p.finalRender)
    throw new StudioError(
      "CONFLICT",
      "Expressive frames need a completed final render.",
      "Approve the rough cut and finish the final render first.",
    );
  const plan = p.plans.at(-1);
  if (!plan)
    throw new StudioError(
      "CONFLICT",
      "Expressive frames need the production plan that created the final render.",
      "The project has a render but no plan — rebuild from an approved plan.",
    );
  const file = await safePath(store.dir(p), p.finalRender);
  const finalRenderHash = await fileHash(file);
  if (p.thumbnailFrames?.finalRenderHash === finalRenderHash)
    return { frames: p.thumbnailFrames, cached: true };
  // Karaoke mode makes the deterministic caption picker surface every
  // punchline it can see, regardless of the shipped cut's caption style.
  const events = computeCaptionEvents(
    { ...plan, captionStyle: "karaoke" },
    transcriptsForPlan(p, plan),
  ).events;
  let envelope: { seconds: number; loudnessDb: number }[] = [];
  try {
    envelope = await loudnessEnvelope(file, signal);
  } catch {
    // A silent or odd master still yields candidates, just unranked by energy.
  }
  const durationSeconds = plan.durationFrames / plan.frameRate;
  const candidates = planFrameCandidates(
    events,
    planChapters(plan),
    envelope,
    plan.frameRate,
    durationSeconds,
  );
  const dir = path.join("packaging", "thumbnails", "frames");
  const files = await extractFrames(
    file,
    candidates.map((c) => c.seconds),
    await safePath(store.dir(p), dir),
    { prefix: "frame" },
    signal,
  );
  const items: ThumbnailFrame[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const output = files[index];
    const relative = path.join(dir, path.basename(output));
    items.push({
      id: `frame-${index + 1}`,
      seconds: Math.round(candidate.seconds * 100) / 100,
      timecode: chapterStamp(candidate.seconds),
      captionText: candidate.captionText,
      loudnessDb:
        candidate.loudnessDb === null
          ? null
          : Math.round(candidate.loudnessDb * 10) / 10,
      path: relative,
      hash: await fileHash(output),
    });
  }
  const frames: ThumbnailFrames = {
    finalRenderHash,
    planVersion: plan.version,
    items,
  };
  store.update(p.id, (x) => {
    x.thumbnailFrames = frames;
  });
  return { frames, cached: false };
}
