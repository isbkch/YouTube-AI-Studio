import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DIRECTOR_PROFILES,
  defaultCreator,
  hash,
  now,
} from "../packages/shared/src/index.ts";
import {
  captionKey,
  migratePlan,
  validatePlan,
  type ProductionPlan,
} from "../packages/production-plan/src/index.ts";
import { computeCaptionEvents } from "../packages/orchestrator/src/captions.ts";
import { BUILTIN_SFX, builtinSfxTracks } from "../packages/orchestrator/src/sfx.ts";
import { mockVisualPass } from "../packages/agents/src/index.ts";
import { Studio } from "../packages/orchestrator/src/studio.ts";
import { Store } from "../packages/orchestrator/src/store.ts";
import { fixture } from "./fixtures.ts";
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

const transcriptWithWords = (
  recordingId: string,
  sentences: { start: number; text: string }[],
): Transcript => {
  const segments = sentences.map((s, i) => {
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
  });
  return {
    schemaVersion: "1.0.0",
    recordingId,
    language: "en",
    provider: "apple-final-cut",
    model: "speech-analysis-1",
    segments,
  };
};

test("each director owns a coherent, escalating style bundle", () => {
  assert.deepEqual(DIRECTOR_PROFILES.purist, {
    name: "The Purist",
    tagline: "Let the content speak.",
    visualDensity: "minimal",
    silenceTightening: "natural",
    captionStyle: "none",
    sfxDensity: "sparse",
    audioPolish: "natural",
  });
  assert.equal(DIRECTOR_PROFILES.craftsman.visualDensity, "rich");
  assert.equal(DIRECTOR_PROFILES.craftsman.silenceTightening, "tight");
  assert.equal(DIRECTOR_PROFILES.craftsman.captionStyle, "pop");
  assert.equal(DIRECTOR_PROFILES.craftsman.audioPolish, "polished");
  assert.equal(DIRECTOR_PROFILES.showman.silenceTightening, "punchy");
  assert.equal(DIRECTOR_PROFILES.showman.captionStyle, "karaoke");
  assert.equal(DIRECTOR_PROFILES.showman.audioPolish, "loud");
  assert.equal(defaultCreator.director, "craftsman");
});

test("v4.4 plans migrate to v4.5 keeping legacy behavior", () => {
  const legacy = JSON.parse(
    JSON.stringify({ ...fixture(), schemaVersion: "4.4.0" }),
  );
  const migrated = validatePlan(migratePlan(legacy));
  assert.equal(migrated.schemaVersion, "4.5.0");
  // The defaults preserve what a pre-director plan built: no captions, no
  // narration processing, no persona steering.
  assert.equal(migrated.directorPersona, "purist");
  assert.equal(migrated.captionStyle, "none");
  assert.equal(migrated.audioPolish, "natural");
});

test("generatePlan records the hired director and its derived settings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wts-directors-"));
  const store = new Store(root);
  try {
    const p = store.create("Directors e2e");
    const studio = new Studio(store);
    await studio.saveScript(
      p.id,
      "First thought about caching here. Second thought continues it further. Third thought closes the group.",
    );
    await studio.approveScript(p.id, 1);
    const rec = recording("rec-directors", 60);
    store.update(p.id, (x) => {
      x.recordings = [rec];
      x.transcripts = [
        transcriptWithWords(rec.id, [
          { start: 10, text: "First thought about caching here." },
          { start: 14, text: "Second thought continues it further." },
          { start: 16.5, text: "Third thought closes the group." },
        ]),
      ];
      x.status = "MEDIA_IMPORTED";
    });
    const showman = await studio.generatePlan(p.id, { director: "showman" });
    const plan = showman.plans.at(-1)!;
    assert.equal(plan.directorPersona, "showman");
    assert.equal(plan.visualDensity, "rich");
    assert.equal(plan.silenceTightening, "punchy");
    assert.equal(plan.captionStyle, "karaoke");
    assert.equal(plan.audioPolish, "loud");
    // Explicit knobs override the persona's defaults without dropping the
    // persona's other layers.
    const custom = await studio.generatePlan(p.id, {
      director: "showman",
      tightening: "natural",
    });
    const mixed = custom.plans.at(-1)!;
    assert.equal(mixed.silenceTightening, "natural");
    assert.equal(mixed.captionStyle, "karaoke");
    // The purist records no caption or polish layers at all.
    const purist = await studio.generatePlan(p.id, { director: "purist" });
    const plain = purist.plans.at(-1)!;
    assert.equal(plain.directorPersona, "purist");
    assert.equal(plain.captionStyle, "none");
    assert.equal(plain.audioPolish, "natural");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("draftAroll maps the director to a tightening level", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wts-directors-aroll-"));
  const store = new Store(root);
  try {
    const p = store.create("Directors aroll");
    const studio = new Studio(store);
    await studio.saveScript(
      p.id,
      "First thought about caching here. Second thought continues it further. Third thought closes the group.",
    );
    await studio.approveScript(p.id, 1);
    const rec = recording("rec-aroll", 60);
    store.update(p.id, (x) => {
      x.recordings = [rec];
      x.transcripts = [
        transcriptWithWords(rec.id, [
          { start: 10, text: "First thought about caching here." },
          { start: 14, text: "Second thought continues it further." },
          { start: 16.5, text: "Third thought closes the group." },
        ]),
      ];
      x.status = "MEDIA_IMPORTED";
    });
    assert.equal(
      (await studio.draftAroll(p.id, { director: "purist" })).stats.tightening
        .level,
      "natural",
    );
    assert.equal(
      (await studio.draftAroll(p.id, { director: "showman" })).stats.tightening
        .level,
      "punchy",
    );
    // An explicit tightening still wins over the persona default.
    assert.equal(
      (await studio.draftAroll(p.id, { director: "purist", tightening: "tight" }))
        .stats.tightening.level,
      "tight",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** Two-scene plan over a known word timeline for caption unit tests. */
const captionPlan = (
  captionStyle: "pop" | "karaoke",
  options: { secondScene?: boolean; words?: boolean } = {},
): { plan: ProductionPlan; transcript: Transcript } => {
  const rec = recording("rec-captions", 60);
  // Scene 1 covers source [10 s, 20 s): a filler line, then a scene-final
  // zinger that scores above every style bar. Scene 2 (when requested)
  // covers [20 s, 30 s) with the same shape but a punch line timed ≥ 6 s
  // after scene 1's so the pop pacing gap keeps both.
  const scene1 = [
    { start: 10, text: "We measured the outage budget for months." },
    { start: 14.5, text: "Here is the thing nobody tells you." },
  ];
  const scene2 = [
    { start: 21, text: "We measured the outage budget again." },
    { start: 27, text: "That is never how failover works." },
  ];
  const sentences = options.secondScene ? [...scene1, ...scene2] : scene1;
  const withWords = transcriptWithWords(rec.id, sentences);
  const transcript: Transcript = options.words === false
    ? {
        ...withWords,
        segments: withWords.segments.map((s) => ({
          id: s.id,
          start: s.start,
          end: s.end,
          text: s.text,
        })),
      }
    : withWords;
  const base = fixture();
  const scene = (
    i: number,
    startFrame: number,
    sourceInFrame: number,
    narration: string,
  ): typeof base.scenes[number] => ({
    ...base.scenes[0],
    id: `scene-${i + 1}`,
    startFrame,
    durationFrames: 300,
    sourceInFrame,
    camera: { ...base.scenes[0].camera, recordingId: rec.id },
    narration,
    chapterTitle: null,
  });
  const narration1 = scene1.map((s) => s.text).join(" ");
  const narration2 = scene2.map((s) => s.text).join(" ");
  const plan: ProductionPlan = validatePlan({
    ...base,
    captionStyle,
    scenes: options.secondScene
      ? [
          scene(0, 0, 300, narration1),
          scene(1, 300, 600, narration2),
        ]
      : [scene(0, 0, 300, narration1)],
    durationFrames: options.secondScene ? 600 : 300,
  });
  return { plan, transcript };
};

test("caption text is transcript-exact and word timings map through the cut", () => {
  const { plan, transcript } = captionPlan("karaoke");
  const captions = computeCaptionEvents(plan, [transcript]);
  assert.equal(captions.style, "karaoke");
  assert.ok(captions.events.length >= 1, "the emphasis lines qualify");
  const spokenWords = transcript.segments.flatMap((s) => s.words!);
  for (const event of captions.events) {
    for (const word of event.words)
      assert.ok(
        spokenWords.some((w) => w.text === word.text),
        `caption words must be spoken words: ${word.text}`,
      );
    // Output frames follow the source offset: a word at start s sits at
    // round((s − sourceIn 10 s) × 30) into the scene.
    const first = event.words[0];
    const spoken = spokenWords.find((w) => w.text === first.text)!;
    assert.equal(first.atFrame, Math.round((spoken.start - 10) * 30));
    assert.ok(first.atFrame >= 0 && first.atFrame < 300);
    assert.ok(event.endFrame > event.startFrame);
    assert.ok(
      event.endFrame - event.startFrame <= 4 * 30 + 1,
      "captions never linger past four seconds",
    );
  }
});

test("pop captions stay sparse while karaoke allows more beats", () => {
  const popFixture = captionPlan("pop");
  const pop = computeCaptionEvents(popFixture.plan, [popFixture.transcript]);
  const karaokeFixture = captionPlan("karaoke");
  const karaoke = computeCaptionEvents(karaokeFixture.plan, [
    karaokeFixture.transcript,
  ]);
  assert.ok(pop.events.length >= 1);
  assert.equal(
    pop.events.filter((e) => e.sceneId === "scene-1").length,
    1,
    "pop caps at one caption per scene",
  );
  assert.ok(
    karaoke.events.filter((e) => e.sceneId === "scene-1").length
      >= pop.events.filter((e) => e.sceneId === "scene-1").length,
    "karaoke at least matches pop in the same scene",
  );
});

test("recordings without word timings are skipped and reported", () => {
  const { plan, transcript } = captionPlan("pop", { words: false });
  const captions = computeCaptionEvents(plan, [transcript]);
  assert.equal(captions.events.length, 0);
  assert.deepEqual(captions.skippedRecordings, ["rec-captions"]);
});

test("caption pacing gaps hold across scene boundaries", () => {
  const { plan, transcript } = captionPlan("pop", { secondScene: true });
  const captions = computeCaptionEvents(plan, [transcript]);
  assert.equal(
    captions.events.length,
    2,
    "both scene-final punch lines are 7 s apart and must survive",
  );
  for (let i = 1; i < captions.events.length; i++)
    assert.ok(
      captions.events[i].startFrame
        >= captions.events[i - 1].endFrame + 6 * 30 - 2,
      "pop captions keep at least ~6 s between beats",
    );
});

test("caption clip keys follow content, style and brand", () => {
  const { plan, transcript } = captionPlan("pop");
  const event = computeCaptionEvents(plan, [transcript]).events[0];
  const key = captionKey(event, "pop", plan, "brand-a", "templatehash");
  // A pure timeline translation (event and word timings move together) does
  // not change a single pixel of the clip.
  const moved = {
    ...event,
    startFrame: event.startFrame + 30,
    endFrame: event.endFrame + 30,
    words: event.words.map((w) => ({ ...w, atFrame: w.atFrame + 30 })),
  };
  assert.equal(captionKey(moved, "pop", plan, "brand-a", "templatehash"), key);
  assert.notEqual(captionKey(event, "karaoke", plan, "brand-a", "templatehash"), key);
  assert.notEqual(captionKey(event, "pop", plan, "brand-b", "templatehash"), key);
  assert.notEqual(
    captionKey({ ...event, text: event.text + " more" }, "pop", plan, "brand-a", "templatehash"),
    key,
  );
});

test("mock visual pass follows the persona's SFX temperament", () => {
  const chapterPlan = (): ProductionPlan => {
    const base = fixture();
    return validatePlan({
      ...base,
      scenes: [
        {
          ...base.scenes[0],
          id: "scene-1",
          startFrame: 0,
          durationFrames: 150,
          chapterTitle: "The trap",
          camera: { ...base.scenes[0].camera, recordingId: "rec-1" },
        },
        {
          ...base.scenes[0],
          id: "scene-2",
          startFrame: 150,
          durationFrames: 150,
          chapterTitle: "The fix",
          visual: {
            type: "graphic",
            description: "callout",
            graphic: {
              engine: "remotion",
              template: "Callout",
              templateVersion: "1.0.0",
              parameters: { title: "Two copies.", subtitle: "One failure domain." },
            },
          },
          camera: { ...base.scenes[0].camera, recordingId: "rec-1" },
        },
        {
          ...base.scenes[0],
          id: "scene-3",
          startFrame: 300,
          durationFrames: 150,
          camera: { ...base.scenes[0].camera, recordingId: "rec-1" },
        },
      ],
      durationFrames: 450,
    });
  };
  const capabilities = {
    "gpt-image": null,
    blender: null,
    musicGeneration: null,
    musicTracks: [],
    sfxTracks: builtinSfxTracks().map((t) => ({
      trackId: t.trackId,
      title: BUILTIN_SFX.find((b) => b.trackId === t.trackId)!.label,
      duration: t.duration,
    })),
  };
  const input = (persona: "purist" | "craftsman" | "showman") => ({
    plan: { ...chapterPlan(), directorPersona: persona },
    capabilities,
    budget: { maxGeneratedStills: 2 },
    creator: { ...defaultCreator, director: persona },
  });
  const purist = mockVisualPass(input("purist"));
  assert.equal(purist.sfx.length, 0);
  const craftsman = mockVisualPass(input("craftsman"));
  assert.ok(craftsman.sfx.length >= 2, "chapters earn risers");
  assert.ok(
    craftsman.sfx.every((s) => s.trackId.startsWith("builtin.")),
    "only advertised tracks are cited",
  );
  const showman = mockVisualPass(input("showman"));
  assert.ok(showman.sfx.length > craftsman.sfx.length, "the showman accents more");
  assert.ok(
    showman.sfx.some((s) => s.trackId === "builtin.whoosh"),
    "graphic reveals get a whoosh from the showman",
  );
  // Without the bank advertised, nothing may be invented.
  const bare = mockVisualPass({
    ...input("showman"),
    capabilities: { ...capabilities, sfxTracks: [] },
  });
  assert.equal(bare.sfx.length, 0);
});
