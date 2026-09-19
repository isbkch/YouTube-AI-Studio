import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_LEAD_SEC,
  MIN_LEAD_SEC,
  computeAudioLeads,
} from "../packages/orchestrator/src/narration-lead.ts";
import { fixture } from "./fixtures.ts";
import type {
  Recording,
  Transcript,
} from "../packages/orchestrator/src/model.ts";
import { hash, now } from "../packages/shared/src/index.ts";

const recording = (
  id: string,
  duration: number,
  hasAudio = true,
): Recording => ({
  id,
  name: `${id}.mp4`,
  path: `recordings/${id}.mp4`,
  duration,
  width: 1920,
  height: 1080,
  codec: "h264",
  frameRate: 30,
  hasAudio,
  audioCodec: hasAudio ? "aac" : null,
  bytes: 100,
  hash: hash(id),
  importedAt: now(),
  proxyPath: null,
  proxyStatus: "PENDING",
  frames: Math.floor(duration * 30),
  proxyFrames: null,
});

const WORD = 0.36;
/** Word-timed transcript: each sentence spans [start, start + words×WORD]. */
const transcript = (
  recordingId: string,
  sentences: { start: number; text: string }[],
) =>
  ({
    schemaVersion: "1.0.0",
    recordingId,
    language: "en",
    provider: "apple-final-cut",
    model: "speech-analysis-1",
    segments: sentences.map((s, i) => {
      const words = s.text.split(" ").map((w, j) => ({
        start: s.start + j * WORD,
        end: s.start + (j + 1) * WORD,
        text: w,
      }));
      return {
        id: `seg-${i + 1}`,
        start: s.start,
        end: words.at(-1)!.end,
        text: s.text,
        words,
      };
    }),
  }) as Transcript;

const SENTENCE_A = "First thought about the cache."; // exactly 5 words
const SENTENCE_B = "Second thought continues it here."; // exactly 5 words

/**
 * Two-scene plan from one recording: scene A holds sentence A, scene B holds
 * sentence B, with a `gap` of silence between them split by head/tail pads.
 */
function twoScenePlan(gapSeconds: number) {
  const plan = structuredClone(fixture());
  const aStart = 10;
  const aEnd = aStart + 5 * WORD;
  const bStart = aEnd + gapSeconds;
  const bEnd = bStart + 5 * WORD;
  plan.scenes = [
    {
      ...plan.scenes[0],
      id: "scene-a",
      startFrame: 0,
      durationFrames: Math.round((aEnd + 0.3 - aStart) * 30),
      sourceInFrame: Math.round(aStart * 30),
    },
    {
      ...plan.scenes[0],
      id: "scene-b",
      startFrame: Math.round((aEnd + 0.3 - aStart) * 30),
      durationFrames: Math.round((bEnd + 0.3 - bStart) * 30),
      sourceInFrame: Math.round((bStart - 0.14) * 30),
    },
  ];
  plan.durationFrames = plan.scenes.reduce((n, s) => n + s.durationFrames, 0);
  return { plan, ranges: { aStart, aEnd, bStart, bEnd } };
}

test("none never computes leads, whatever the timings", () => {
  const { plan } = twoScenePlan(1.0);
  const none = computeAudioLeads(
    { ...plan, narrationLead: "none" },
    [],
    [recording("recording-1", 60)],
  );
  assert.deepEqual(none.leads, []);
  assert.ok(none.scenes.every((s) => !s.tailLeadSec));
});

test("a lead extends only the outgoing tail; heads never move", () => {
  // A 1.0s gap between the sentences, ~0.3s tail pad inside scene A and
  // ~0.14s head pad inside scene B: the incoming head pad binds.
  const { plan, ranges } = twoScenePlan(1.0);
  const rec = recording("recording-1", 60);
  const transcripts = [
    transcript(rec.id, [
      { start: ranges.aStart, text: SENTENCE_A },
      { start: ranges.bStart, text: SENTENCE_B },
    ]),
  ];
  const flowing = computeAudioLeads(
    { ...plan, narrationLead: "flowing" },
    transcripts,
    [rec],
  );
  assert.equal(flowing.leads.length, 1, "the one boundary earns a lead");
  const lead = flowing.leads[0];
  assert.equal(lead.sceneId, "scene-a");
  assert.equal(lead.nextSceneId, "scene-b");
  const available = Math.min(ranges.bStart - (ranges.aEnd + 0.3), 0.14);
  assert.ok(
    Math.abs(lead.seconds - Math.min(available, MAX_LEAD_SEC)) < 0.011,
    `flowing uses the whole word-safe gap (got ${lead.seconds}s)`,
  );
  // Single-shift transform: only scene A's tail extends. Scene B's mapping
  // is untouched — its head silence is the crossing room.
  const a = flowing.scenes.find((s) => s.sceneId === "scene-a")!;
  const b = flowing.scenes.find((s) => s.sceneId === "scene-b")!;
  assert.equal(a.tailLeadSec, lead.seconds);
  assert.equal(b.tailLeadSec, 0, "the last scene never extends");
  // Subtle crosses half.
  const subtle = computeAudioLeads(
    { ...plan, narrationLead: "subtle" },
    transcripts,
    [rec],
  );
  assert.ok(Math.abs(subtle.leads[0].seconds - lead.seconds / 2) < 0.011);
});

test("a word still in progress at the cut keeps the hard cut", () => {
  // Sentence A's last word straddles scene A's range end (starts inside,
  // ends after): the extension allowance goes negative and the boundary
  // stays exact rather than crossing active speech.
  const { plan, ranges } = twoScenePlan(0.6);
  const rec = recording("recording-1", 60);
  const straddled = transcript(rec.id, [
    { start: ranges.aStart + WORD, text: SENTENCE_A },
    { start: ranges.bStart, text: SENTENCE_B },
  ]);
  const decision = computeAudioLeads(
    { ...plan, narrationLead: "flowing" },
    [straddled],
    [rec],
  );
  assert.deepEqual(decision.leads, []);
});

test("the outgoing lead stops before the next spoken word, not just the range", () => {
  // Scene A's boundary has 0.9s of apparent room (scene B's words start at
  // 13.0s), but a one-word aside in the same recording starts 0.1s after
  // scene A's range end: the lead must stop short of it.
  const { plan, ranges } = twoScenePlan(1.2);
  const rec = recording("recording-1", 60);
  const transcripts = [
    transcript(rec.id, [
      { start: ranges.aStart, text: SENTENCE_A },
      { start: ranges.aEnd + 0.3 + 0.1, text: "Anyway." },
      { start: ranges.bStart, text: SENTENCE_B },
    ]),
  ];
  const decision = computeAudioLeads(
    { ...plan, narrationLead: "flowing" },
    transcripts,
    [rec],
  );
  assert.equal(decision.leads.length, 1);
  assert.ok(
    decision.leads[0].seconds <= 0.1 + 0.011,
    `the lead stops before the aside (got ${decision.leads[0].seconds}s)`,
  );
});

test("tight gaps, partial word timings and silent recordings keep the hard cut", () => {
  const rec = recording("recording-1", 60);
  // A 0.3s gap is fully consumed by pads: no word-free room to cross.
  const tight = twoScenePlan(0.3);
  const withWords = [
    transcript(rec.id, [
      { start: tight.ranges.aStart, text: SENTENCE_A },
      { start: tight.ranges.bStart, text: SENTENCE_B },
    ]),
  ];
  assert.deepEqual(
    computeAudioLeads({ ...tight.plan, narrationLead: "flowing" }, withWords, [
      rec,
    ]).leads,
    [],
    "a lead shorter than the audible minimum keeps the exact cut",
  );
  assert.ok(MIN_LEAD_SEC >= 0.05);
  // One speech segment without word timings makes the whole recording
  // unsafe: unrepresented speech must stay invisible to no constraint.
  const partial = transcript(rec.id, [
    { start: tight.ranges.aStart, text: SENTENCE_A },
    { start: tight.ranges.bStart, text: SENTENCE_B },
  ]);
  partial.segments[1].words = undefined;
  const generous = twoScenePlan(1.2);
  const partialDecision = computeAudioLeads(
    { ...generous.plan, narrationLead: "flowing" },
    [partial],
    [rec],
  );
  assert.deepEqual(partialDecision.leads, []);
  assert.deepEqual(partialDecision.stats.skippedRecordings, [rec.id]);
  // A recording without audio can never carry or receive a crossing.
  const silent = recording("recording-1", 60, false);
  const worded = transcript(silent.id, [
    { start: 10, text: SENTENCE_A },
    { start: 12, text: SENTENCE_B },
  ]);
  const silentDecision = computeAudioLeads(
    { ...generous.plan, narrationLead: "flowing" },
    [worded],
    [silent],
  );
  assert.deepEqual(silentDecision.leads, []);
  assert.deepEqual(silentDecision.stats.skippedRecordings, ["recording-1"]);
});
