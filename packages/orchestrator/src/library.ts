import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { fileHash, inside, StudioError } from "../../shared/src/index.ts";
import { inspect } from "../../media/src/index.ts";

/**
 * The creator-managed music/SFX library. Files live under
 * `<library root>/library/`; `library.json` describes them. The manifest is
 * data the agents read and the audio mixer resolves through trusted code —
 * track IDs never reach a shell (ADR 007).
 */
export const libraryTrackSchema = z.strictObject({
  trackId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/),
  title: z.string().min(1).max(200),
  kind: z.enum(["music", "sfx"]),
  /** Relative to the library directory; must stay inside it. */
  file: z.string().min(1).max(300),
  mood: z.array(z.string().max(40)).max(8),
  energy: z.number().int().min(1).max(5),
  bpm: z.number().positive().nullable(),
  loopable: z.boolean(),
  duration: z.number().positive(),
  /** Licensing is the creator's responsibility; QA surfaces empty values. */
  license: z.string().max(300),
});
export const libraryManifestSchema = z.strictObject({
  schemaVersion: z.literal("1.0.0"),
  tracks: z.array(libraryTrackSchema).max(500),
});
export type LibraryManifest = z.infer<typeof libraryManifestSchema>;
export type LibraryTrack = z.infer<typeof libraryTrackSchema>;

export const libraryDir = (root: string) => path.join(root, "library");
export const emptyLibrary = (): LibraryManifest => ({
  schemaVersion: "1.0.0",
  tracks: [],
});

/** A missing manifest is an empty library; a malformed one is an error. */
export async function readLibrary(root: string): Promise<LibraryManifest> {
  let raw: string;
  try {
    raw = await readFile(path.join(libraryDir(root), "library.json"), "utf8");
  } catch {
    return emptyLibrary();
  }
  try {
    return libraryManifestSchema.parse(JSON.parse(raw));
  } catch (e) {
    throw new StudioError(
      "INVALID_INPUT",
      `Library manifest is invalid: ${e instanceof Error ? e.message : String(e)}`,
      "Fix library/library.json, or remove it to start with an empty library.",
    );
  }
}

export interface ResolvedTrack {
  track: LibraryTrack;
  /** Absolute path inside the library directory. */
  file: string;
  hash: string;
  duration: number;
  hasAudio: boolean;
}
/** Resolve and ffprobe-verify one manifest entry. */
export async function resolveTrack(
  root: string,
  track: LibraryTrack,
): Promise<ResolvedTrack> {
  const dir = libraryDir(root);
  let file: string;
  try {
    file = inside(dir, track.file);
  } catch {
    throw new StudioError(
      "INVALID_INPUT",
      `Library track ${track.trackId} escapes the library directory.`,
      "Library files must be relative paths inside the library folder.",
    );
  }
  let meta;
  try {
    meta = await inspect(file);
  } catch {
    throw new StudioError(
      "INVALID_INPUT",
      `Library track ${track.trackId} (${track.file}) is not readable media.`,
      "Restore the file or remove the entry from library/library.json.",
    );
  }
  if (!meta.hasAudio)
    throw new StudioError(
      "INVALID_INPUT",
      `Library track ${track.trackId} has no audio stream.`,
    );
  if (Math.abs(meta.duration - track.duration) > 2)
    throw new StudioError(
      "INVALID_INPUT",
      `Library track ${track.trackId} runs ${meta.duration.toFixed(1)}s but the manifest says ${track.duration}s.`,
      "Update the manifest duration or re-export the file.",
    );
  return {
    track,
    file,
    hash: await fileHash(file),
    duration: meta.duration,
    hasAudio: meta.hasAudio,
  };
}
export async function resolveLibrary(root: string, manifest: LibraryManifest) {
  const resolved: ResolvedTrack[] = [];
  const ids = new Set<string>();
  for (const track of manifest.tracks) {
    if (ids.has(track.trackId))
      throw new StudioError(
        "INVALID_INPUT",
        `Duplicate library track ID ${track.trackId}.`,
      );
    ids.add(track.trackId);
    resolved.push(await resolveTrack(root, track));
  }
  return resolved;
}
/** Minimal shape production-plan's validateAudioDesign consumes. */
export const trackRefs = (tracks: LibraryTrack[]) =>
  tracks.map((t) => ({
    trackId: t.trackId,
    kind: t.kind,
    duration: t.duration,
  }));
