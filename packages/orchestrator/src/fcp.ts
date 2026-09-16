import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { StudioError } from "../../shared/src/index.ts";
import { tokenize } from "./alignment.ts";
import { transcribeOpening } from "../../agents/src/whisper.ts";
import type { Recording } from "./model.ts";

/**
 * Import the word-level speech analysis Final Cut Pro stores next to imported
 * media (`.fcptranscript`). Free, offline, and more accurate than segment ASR.
 */

const parseFCPRational = (value: string): number => {
  const rational = /^(-?\d+)\/(\d+)s$/.exec(value);
  if (rational) return Number(rational[1]) / Number(rational[2]);
  const plain = /^(-?\d+(?:\.\d+)?)s$/.exec(value);
  if (plain) return Number(plain[1]);
  throw new StudioError(
    "INVALID_INPUT",
    `Unrecognised Final Cut time value: ${value}`,
  );
};

export interface FCPPhrase {
  text: string;
  start: number;
  end: number;
  words: { start: number; end: number; text: string }[];
}
export interface FCPTranscript {
  file: string;
  language: string;
  phrases: FCPPhrase[];
  endSeconds: number;
}

export async function readFCPTranscript(file: string): Promise<FCPTranscript> {
  const raw = JSON.parse(await readFile(file, "utf8")) as {
    timeRange?: { end?: string };
    phrases?: {
      summary?: string;
      timeRange?: { start?: string; end?: string };
      words?: {
        summary?: string;
        timeRange?: { start?: string; end?: string };
      }[];
    }[];
  };
  if (!Array.isArray(raw.phrases))
    throw new StudioError(
      "INVALID_INPUT",
      `${path.basename(file)} is not a Final Cut speech-analysis file.`,
    );
  const phrases: FCPPhrase[] = [];
  for (const p of raw.phrases) {
    const text = (p.summary ?? "").trim();
    if (!text || !p.timeRange?.start || !p.timeRange?.end) continue;
    const words = (p.words ?? [])
      .map((w) => ({
        text: (w.summary ?? "").trim(),
        start: w.timeRange?.start ? parseFCPRational(w.timeRange.start) : 0,
        end: w.timeRange?.end ? parseFCPRational(w.timeRange.end) : 0,
      }))
      .filter((w) => w.text && w.end > w.start);
    phrases.push({
      text,
      start: parseFCPRational(p.timeRange.start),
      end: parseFCPRational(p.timeRange.end),
      words,
    });
  }
  if (!phrases.length)
    throw new StudioError(
      "INVALID_INPUT",
      `${path.basename(file)} contains no transcribed phrases.`,
    );
  return {
    file,
    language: path.basename(file, ".fcptranscript"),
    phrases,
    endSeconds: parseFCPRational(raw.timeRange?.end ?? "0/1s"),
  };
}

export async function discoverFCPTranscripts(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, depth: number) => {
    if (depth > 8 || out.length > 400) return;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith("__Sync__") || entry.name.startsWith("__Temp"))
        continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(p, depth + 1);
      else if (entry.name.endsWith(".fcptranscript")) out.push(p);
    }
  };
  await walk(root, 0);
  return out.sort();
}

/** Convert one FCP analysis into the studio transcript shape (pre-validation). */
export function fcpToTranscriptInput(fcp: FCPTranscript, recording: Recording) {
  const segments: {
    id: string;
    start: number;
    end: number;
    text: string;
    words?: { start: number; end: number; text: string }[];
  }[] = [];
  let prevEnd = 0;
  for (const phrase of fcp.phrases) {
    const start = Math.max(prevEnd, Math.min(phrase.start, recording.duration));
    const end = Math.min(
      Math.max(phrase.end, start + 0.02),
      recording.duration,
    );
    if (end - start < 0.02 || end > recording.duration + 0.12) continue;
    const words = phrase.words
      .filter((w) => w.end > start && w.start < end)
      .map((w) => ({
        start: Math.max(w.start, start),
        end: Math.min(w.end, end),
        text: w.text,
      }))
      .filter((w) => w.end > w.start);
    segments.push({
      id: `fcp-${String(segments.length + 1).padStart(3, "0")}`,
      start,
      end,
      text: phrase.text.slice(0, 20000),
      ...(words.length ? { words } : {}),
    });
    prevEnd = end;
  }
  if (!segments.length)
    throw new StudioError(
      "INVALID_INPUT",
      `The Final Cut analysis for ${recording.name} has no usable phrases.`,
    );
  return {
    schemaVersion: "1.0.0" as const,
    recordingId: recording.id,
    language: fcp.language,
    provider: "apple-final-cut",
    model: "speech-analysis-1",
    segments,
  };
}

const overlap = (a: string[], b: string[]) => {
  const setB = new Set(b);
  return a.filter((t) => setB.has(t)).length / Math.max(1, a.length);
};

/**
 * Match analyses to imported recordings. Durations disambiguate most takes;
 * same-length retakes are resolved by fingerprinting the first spoken words
 * with local whisper, so twins never swap transcripts.
 */
export async function mapFCPTranscriptsToRecordings(
  transcripts: FCPTranscript[],
  recordings: Recording[],
  options: {
    projectDir: string;
    fingerprint?: boolean;
    modelPath?: string;
    signal?: AbortSignal;
  },
): Promise<{ mapping: Map<string, FCPTranscript>; fingerprints: string[] }> {
  const candidates: {
    recording: Recording;
    fcp: FCPTranscript;
    score: number;
  }[] = [];
  for (const recording of recordings)
    for (const fcp of transcripts) {
      if (
        fcp.endSeconds > recording.duration + 0.12 ||
        fcp.endSeconds < recording.duration * 0.35
      )
        continue;
      candidates.push({
        recording,
        fcp,
        score: -Math.abs(recording.duration - fcp.endSeconds),
      });
    }
  const ambiguous = recordings
    .filter((r) => candidates.filter((c) => c.recording.id === r.id).length > 1)
    .map((r) => r.id);
  const fingerprints: string[] = [];
  if (options.fingerprint !== false && ambiguous.length) {
    for (const recordingId of ambiguous) {
      const recording = recordings.find((r) => r.id === recordingId)!;
      try {
        const spoken = await transcribeOpening(
          path.join(options.projectDir, recording.path),
          12,
          { modelPath: options.modelPath, signal: options.signal },
        );
        fingerprints.push(recording.name);
        for (const c of candidates.filter(
          (c) => c.recording.id === recordingId,
        )) {
          const expected = tokenize(c.fcp.phrases[0].text);
          c.score += 10 * overlap(spoken, expected);
        }
      } catch {
        /* Fingerprinting is best-effort; duration matching still applies. */
      }
    }
  }
  const mapping = new Map<string, FCPTranscript>();
  const takenFiles = new Set<string>();
  for (const c of [...candidates].sort((a, b) => b.score - a.score)) {
    if (mapping.has(c.recording.id) || takenFiles.has(c.fcp.file)) continue;
    mapping.set(c.recording.id, c.fcp);
    takenFiles.add(c.fcp.file);
  }
  return { mapping, fingerprints };
}
