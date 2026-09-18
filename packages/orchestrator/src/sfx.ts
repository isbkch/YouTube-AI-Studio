import path from "node:path";
import { mkdir } from "node:fs/promises";
import { hash, StudioError } from "../../shared/src/index.ts";
import { ffmpeg, inspect } from "../../media/src/index.ts";
import { cachedFile } from "./cache.ts";

/**
 * Built-in synthesized SFX bank. Directors above the purist propose sound
 * effects even when the creator's library has none: every track below is
 * synthesized locally by ffmpeg expressions — no downloads, no licensing, no
 * network — and cached per project like any other derived output. Library
 * tracks remain the richer source; the bank guarantees the floor.
 */
export interface BuiltinSfxTrack {
  trackId: string;
  label: string;
  seconds: number;
  /** lavfi input filter for ffmpeg (after `-f lavfi -i`). */
  source: string;
  /** Audio filters applied after the source (envelopes, band limits). */
  filters: string[];
}

export const BUILTIN_SFX: readonly BuiltinSfxTrack[] = [
  {
    trackId: "builtin.whoosh",
    label: "Soft whoosh (transition)",
    seconds: 0.9,
    // Fixed-seed pink noise swells in, peaks mid-way and decays out, band
    // limited so it sits under speech instead of on top of it.
    source: "anoisesrc=color=pink:amplitude=0.55:duration=0.9:seed=7",
    filters: [
      "volume='min(t*5,1)*exp(-max(t-0.4,0)*7)':eval=frame",
      "highpass=f=180",
      "lowpass=f=2400",
    ],
  },
  {
    trackId: "builtin.pop",
    label: "Emphasis pop (punch line)",
    seconds: 0.3,
    // A short decaying sine: the classic emphasis blip under a caption.
    source:
      "aevalsrc=exprs='0.9*sin(2*PI*660*t)*exp(-t*16)|0.9*sin(2*PI*660*t)*exp(-t*16)':s=44100:d=0.3:c=stereo",
    filters: [],
  },
  {
    trackId: "builtin.riser",
    label: "Chapter riser",
    seconds: 0.8,
    // A pitch sweep with a fast attack and a 100 ms release.
    source:
      "aevalsrc=exprs='0.5*sin(2*PI*(280+360*t)*t)*min(t*2.5,1)|0.5*sin(2*PI*(280+360*t)*t)*min(t*2.5,1)':s=44100:d=0.8:c=stereo",
    filters: ["afade=t=out:st=0.7:d=0.1"],
  },
] as const;

/** Track refs in the shape `validateAudioDesign` and the mix resolve. */
export function builtinSfxTracks(): {
  trackId: string;
  kind: "sfx";
  duration: number;
}[] {
  return BUILTIN_SFX.map((t) => ({
    trackId: t.trackId,
    kind: "sfx" as const,
    duration: t.seconds,
  }));
}

export function builtinSfxTrack(trackId: string): BuiltinSfxTrack | undefined {
  return BUILTIN_SFX.find((t) => t.trackId === trackId);
}

/**
 * Synthesize (or reuse) a built-in SFX clip inside the project directory.
 * Same cache discipline as every derived output: unique partial, hash
 * manifest, verified promote.
 */
export async function builtinSfxFile(
  dir: string,
  trackId: string,
  signal?: AbortSignal,
): Promise<{ file: string; duration: number }> {
  const track = builtinSfxTrack(trackId);
  if (!track)
    throw new StudioError(
      "INVALID_PLAN",
      `Unknown built-in SFX track: ${trackId}.`,
    );
  const c = await cachedFile(
    dir,
    // Identity covers the synthesis itself, not just the track name: tweaks
    // to the expression, filters, length or encoding resynthesize instead of
    // reusing stale bytes from existing projects.
    hash({
      builtinSfx: track.trackId,
      source: track.source,
      filters: track.filters,
      seconds: track.seconds,
      codec: "libmp3lame-128k",
      renderer: "builtin-sfx-v1",
    }),
    `assets/builtin-sfx/${track.trackId}.mp3`,
    async (temp) => {
      // ffmpeg does not create intermediate directories; the render callback
      // only runs on cache misses, so the mkdir is paid once.
      await mkdir(path.dirname(temp), { recursive: true });
      await ffmpeg(
        [
          "-f",
          "lavfi",
          "-i",
          track.source,
          ...(track.filters.length ? ["-af", track.filters.join(",")] : []),
          "-t",
          String(track.seconds),
          "-c:a",
          "libmp3lame",
          "-b:a",
          "128k",
          temp,
        ],
        signal,
      );
    },
  );
  const file = path.join(dir, c.path);
  // Trust but verify: the bank's durations feed mix placement decisions.
  const probed = await inspect(file);
  return { file, duration: probed.duration };
}
