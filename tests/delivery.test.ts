import { test } from "node:test";
import assert from "node:assert/strict";
import { hash, now } from "../packages/shared/src/index.ts";
import {
  ALIGNMENT_ALGORITHM,
  alignScript,
} from "../packages/orchestrator/src/alignment.ts";
import type {
  Recording,
  Transcript,
} from "../packages/orchestrator/src/model.ts";

const recording = (id: string, duration: number): Recording => ({
  id,
  name: `${id}.mp4`,
  path: `recordings/${id}.mp4`,
  duration,
  width: 1920,
  height: 1080,
  codec: "h264",
  frameRate: 30,
  hasAudio: true,
  audioCodec: "aac",
  bytes: 100,
  hash: hash(id),
  importedAt: now(),
  proxyPath: null,
  proxyStatus: "PENDING",
  frames: Math.floor(duration * 30),
  proxyFrames: null,
});

const WORD = 0.36;
/** Word-timed transcript builder; `words` may interleave filler tokens. */
const transcript = (recordingId: string, words: string[], spacing = WORD) =>
  ({
    schemaVersion: "1.0.0",
    recordingId,
    language: "en",
    provider: "apple-final-cut",
    model: "speech-analysis-1",
    segments: [
      {
        id: "seg-1",
        start: 2,
        end: 2 + words.length * spacing,
        text: words.join(" "),
        words: words.map((w, j) => ({
          start: 2 + j * spacing,
          end: 2 + (j + 1) * spacing,
          text: w,
        })),
      },
    ],
  }) as Transcript;

const SENTENCE = "Caching matters when memory is tight.";
const align = (recordings: Recording[], transcripts: Transcript[]) =>
  alignScript({
    script: SENTENCE,
    scriptVersion: 1,
    recordings,
    transcripts,
  });

test("a clean delivery outranks a filler-laced take of the same sentence", () => {
  const clean = recording("rec-clean", 30);
  const sloppy = recording("rec-sloppy", 30);
  const alignment = align(
    [clean, sloppy],
    [
      transcript(clean.id, SENTENCE.split(" ")),
      transcript(sloppy.id, [
        "Um",
        "caching",
        "uh",
        "matters",
        "um",
        "when",
        "memory",
        "is",
        "uh",
        "tight",
      ]),
    ],
  );
  assert.equal(alignment.algorithm, ALIGNMENT_ALGORITHM);
  assert.equal(alignment.sentences[0].match?.recordingId, clean.id);
  // The losing take is preserved among the alternates for the creator.
  assert.ok(
    alignment.sentences[0].alternates.some((a) => a.recordingId === sloppy.id),
  );
  const per = new Map(
    alignment.stats.perRecording.map((r) => [
      r.recordingId,
      r.matchedSentences,
    ]),
  );
  assert.equal(per.get(clean.id), 1);
  assert.equal(per.get(sloppy.id), 0);
});

test("an off-pace delivery ranks below a comfortable one", () => {
  const brisk = recording("rec-brisk", 30);
  const dragging = recording("rec-dragging", 60);
  const alignment = align(
    [brisk, dragging],
    [
      transcript(brisk.id, SENTENCE.split(" ")),
      // 1.2s per word ≈ 50 wpm: far below comfortable narration pace.
      transcript(dragging.id, SENTENCE.split(" "), 1.2),
    ],
  );
  assert.equal(alignment.sentences[0].match?.recordingId, brisk.id);
});

test("delivery never unmatches a sentence — a lone sloppy take still wins", () => {
  const only = recording("rec-only", 30);
  const alignment = align(
    [only],
    [
      transcript(only.id, [
        "Um",
        "caching",
        "uh",
        "matters",
        "when",
        "memory",
        "is",
        "uh",
        "tight",
      ]),
    ],
  );
  assert.equal(alignment.sentences[0].match?.recordingId, only.id);
  assert.equal(alignment.stats.matched, 1);
});
