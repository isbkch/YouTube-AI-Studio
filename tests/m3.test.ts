import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyPatch,
  migratePlan,
  validateAudioDesign,
  validatePlan,
  type BRollEntry,
  type ProductionPlan,
} from "../packages/production-plan/src/index.ts";
import { fixture } from "./fixtures.ts";
import { validateEngines } from "../packages/orchestrator/src/engines.ts";
import {
  buildImagePrompt,
  brollClipKey,
  brollStillKey,
} from "../packages/image-engine/src/index.ts";
import {
  makeTimeline,
  toFCPXML,
} from "../packages/orchestrator/src/timeline.ts";
import type { Recording, Asset } from "../packages/orchestrator/src/model.ts";
import { hash } from "../packages/shared/src/index.ts";

const recording: Recording = {
  id: "recording-1",
  name: "source.mp4",
  path: "recordings/source.mp4",
  duration: 3,
  width: 1280,
  height: 720,
  codec: "h264",
  frameRate: 30,
  hasAudio: true,
  audioCodec: "aac",
  bytes: 100,
  hash: hash("source"),
  importedAt: new Date().toISOString(),
  proxyPath: "cache/proxy.mp4",
  proxyStatus: "AVAILABLE",
  frames: 90,
  proxyFrames: 90,
};
const still = (brief = "A quiet datacenter corridor at blue hour") =>
  ({
    engine: "gpt-image",
    template: "GeneratedStill",
    templateVersion: "1.0.0",
    parameters: {
      brief,
      style: "photoreal",
      palette: "deep blues, one warm accent",
      avoid: "people",
      quality: "medium",
      expectsText: false,
    },
  }) as const;
const entry = (over: Partial<BRollEntry> = {}): BRollEntry =>
  ({
    id: "broll-1",
    startFrame: 12,
    durationFrames: 48,
    placement: "inset",
    inset: { x: 0.55, y: 0.55, width: 0.38 },
    motion: "zoom-in",
    asset: still(),
    narrationHook: "the machines hum in the dark",
    ...over,
  }) as BRollEntry;
const withBroll = (broll: BRollEntry[], plan = fixture()): ProductionPlan =>
  validatePlan({
    ...plan,
    scenes: plan.scenes.map((s) => ({ ...s, broll })),
  });

test("v2 plans upgrade through v3 to v4 with defaulted broll and audio design", () => {
  const v2 = { ...fixture(), schemaVersion: "2.0.0" as const };
  const upgraded = validatePlan(migratePlan(v2));
  assert.equal(upgraded.schemaVersion, "4.1.0");
  assert.deepEqual(upgraded.scenes[0].broll, []);
  assert.deepEqual(upgraded.audioDesign, { music: null, sfx: [] });
});

test("legacy v2 chapter omissions migrate without changing the saved edit or its hash", () => {
  const plan = fixture();
  const scenes = ["Opening", undefined, null].map((chapterTitle, i) => ({
    ...plan.scenes[0],
    id: `scene-${i + 1}`,
    startFrame: i * 90,
    chapterTitle,
  }));
  const legacy = JSON.parse(
    JSON.stringify({
      ...plan,
      schemaVersion: "2.0.0",
      durationFrames: 270,
      scenes,
    }),
  );
  const saved = structuredClone(legacy);
  const savedHash = hash(legacy);
  const migrated = validatePlan(legacy);
  assert.deepEqual(
    migrated.scenes.map((s) => s.chapterTitle),
    ["Opening", null, null],
  );
  assert.deepEqual(migrated, {
    ...saved,
    schemaVersion: "4.1.0",
    scriptCoverage: null,
    scenes: scenes.map((s) => ({
      ...s,
      chapterTitle: s.chapterTitle ?? null,
      selection: null,
    })),
  });
  assert.deepEqual(legacy, saved);
  assert.equal(hash(legacy), savedHash);
  assert.deepEqual(validatePlan(migrated), migrated);
});

test("chapter migration preserves validation of malformed titles and current plans", () => {
  const plan = fixture();
  for (const chapterTitle of ["", 42, "x".repeat(121)])
    assert.throws(() =>
      validatePlan({
        ...plan,
        schemaVersion: "2.0.0",
        scenes: [{ ...plan.scenes[0], chapterTitle }],
      }),
    );
  assert.throws(() =>
    validatePlan({
      ...plan,
      scenes: [{ ...plan.scenes[0], chapterTitle: undefined }],
    }),
  );
});

test("b-roll entries must stay inside their scene, ordered and unstacked", () => {
  assert.ok(withBroll([entry()]));
  assert.throws(
    () => withBroll([entry({ startFrame: 60 })]),
    /B-roll escapes its scene/,
  );
  assert.throws(
    () => withBroll([entry(), entry({ id: "broll-2", startFrame: 30 })]),
    /B-roll entries overlap/,
  );
  assert.throws(
    () =>
      withBroll([
        entry({ placement: "fullframe", inset: null }),
        entry({ id: "broll-2", startFrame: 70 }),
      ]),
    /full-frame B-roll must be the scene's only visual/,
  );
  assert.throws(
    () => withBroll([entry({ inset: { x: 0.7, y: 0.05, width: 0.38 } })]),
    /escapes the frame/,
  );
  // A 0.9-width inset is 0.64 of the frame height at 16:9 — bottom escapes.
  assert.throws(
    () => withBroll([entry({ inset: { x: 0.02, y: 0.5, width: 0.9 } })]),
    /bottom of the frame/,
  );
  // A graphic scene may still carry an inset; the full-frame rule holds.
  const graphicScene = fixture();
  graphicScene.scenes[0].visual = {
    type: "graphic",
    description: "Flow",
    graphic: {
      engine: "remotion",
      template: "Callout",
      templateVersion: "1.0.0",
      parameters: { title: "Claim", subtitle: "" },
    },
  };
  assert.ok(withBroll([entry()], graphicScene));
});

test("audio design resolves against the creator library only", () => {
  const tracks = [
    { trackId: "ambient-1", kind: "music" as const, duration: 120 },
    { trackId: "whoosh-1", kind: "sfx" as const, duration: 1.2 },
  ];
  const plan = withBroll([]);
  plan.audioDesign = {
    music: {
      trackId: "ambient-1",
      gainDb: -24,
      duckToDb: -18,
      fadeInSec: 1,
      fadeOutSec: 2,
    },
    sfx: [{ id: "sfx-1", atFrame: 45, trackId: "whoosh-1", gainDb: -8 }],
  };
  assert.doesNotThrow(() => validateAudioDesign(plan, tracks));
  plan.audioDesign.music!.trackId = "whoosh-1";
  assert.throws(() => validateAudioDesign(plan, tracks), /not in the library/);
  const late = { ...plan, audioDesign: { ...plan.audioDesign } };
  late.audioDesign.music = {
    trackId: "ambient-1",
    gainDb: -24,
    duckToDb: -18,
    fadeInSec: 1,
    fadeOutSec: 2,
  };
  late.audioDesign.sfx = [
    { id: "sfx-2", atFrame: 85, trackId: "whoosh-1", gainDb: -8 },
  ];
  assert.throws(() => validatePlan(late), /too close to the end/);
});

test("setBroll and setAudioDesign patch operations flow through approval validation", () => {
  const plan = fixture();
  const patched = applyPatch(plan, {
    id: "patch-1",
    createdAt: new Date().toISOString(),
    originatingRequest: "Add an inset for the datacenter line",
    rationale: "Narration names a physical place the presenter cannot show.",
    affectedScenes: ["scene-1"],
    previousVersion: 1,
    resultingVersion: 2,
    operations: [
      {
        type: "setAudioDesign",
        audioDesign: { music: null, sfx: [] },
      },
      { type: "setBroll", sceneId: "scene-1", broll: [entry()] },
    ],
  });
  assert.equal(patched.version, 2);
  assert.deepEqual(
    patched.scenes[0].broll[0].narrationHook,
    "the machines hum in the dark",
  );
  // Splitting a scene trims the straddling entry instead of invalidating it.
  const split = applyPatch(patched, {
    id: "patch-2",
    createdAt: new Date().toISOString(),
    originatingRequest: "Split for pacing",
    rationale: "Two beats.",
    affectedScenes: ["scene-1"],
    previousVersion: 2,
    resultingVersion: 3,
    operations: [
      {
        type: "splitScene",
        sceneId: "scene-1",
        atFrame: 30,
        newSceneId: "scene-1b",
      },
    ],
  });
  const head = split.scenes.find((s) => s.id === "scene-1")!;
  const tail = split.scenes.find((s) => s.id === "scene-1b")!;
  // The entry starts before the cut, so the head keeps it trimmed to the cut.
  assert.equal(head.broll[0].startFrame, 12);
  assert.equal(head.broll[0].durationFrames, 18);
  assert.deepEqual(tail.broll, []);
});

test("image prompts assemble from trusted wording and forbid stray text", () => {
  const prompt = buildImagePrompt(still());
  assert.match(prompt, /photorealistic/);
  assert.match(prompt, /datacenter corridor/);
  assert.match(prompt, /No text, words, letters/);
  const withText = still("A sign reading EXIT above a rack");
  assert.ok(
    !buildImagePrompt({
      ...withText,
      parameters: { ...withText.parameters, expectsText: true },
    }).includes("No text"),
  );
});

test("B-roll render identity ignores narration and plan version", () => {
  const plan = fixture();
  const e = entry();
  const provider = { name: "image_generation", model: "gpt-image-1" };
  const a = brollStillKey(e, provider);
  const b = brollClipKey(e, plan);
  assert.equal(
    a,
    brollStillKey(
      { ...e, narrationHook: "different narration entirely" },
      provider,
    ),
  );
  assert.equal(
    b,
    brollClipKey(e, {
      ...plan,
      version: 9,
      createdAt: "2020-01-01T00:00:00.000Z",
    } as ProductionPlan),
  );
  assert.notEqual(b, brollClipKey({ ...e, motion: "pan-left" }, plan));
});

test("execution rejects B-roll engines that are not configured", () => {
  const plan = withBroll([entry()]);
  assert.throws(() => validateEngines(plan, null), /not configured/);
  assert.doesNotThrow(() => validateEngines(withBroll([]), null));
});

test("timeline carries B-roll insets, music and SFX lanes into FCPXML", () => {
  const plan = withBroll([entry()]);
  const clipAsset: Asset = {
    assetId: "asset-broll",
    type: "broll-clip",
    sceneId: "scene-1",
    productionPlanVersion: plan.version,
    generator: "ffmpeg-zoompan",
    template: "GeneratedStill",
    templateVersion: "1.0.0",
    parameters: {},
    inputHash: "k",
    outputHash: hash("clip"),
    createdAt: new Date().toISOString(),
    path: "assets/generated/broll-1.mp4",
    jobId: "job-1",
    reused: false,
    sourceAssets: [],
    renderMs: 1,
  };
  const t = makeTimeline(
    plan,
    [recording],
    new Map(),
    new Map([
      [
        "scene-1",
        [
          {
            sceneId: "scene-1",
            brollId: "broll-1",
            assetId: clipAsset.assetId,
            path: clipAsset.path,
          },
        ],
      ],
    ]),
    {
      design: {
        music: {
          trackId: "ambient-1",
          gainDb: -24,
          duckToDb: -18,
          fadeInSec: 1,
          fadeOutSec: 2,
        },
        sfx: [{ id: "sfx-1", atFrame: 45, trackId: "whoosh-1", gainDb: -8 }],
      },
      music: { path: "cache/library-ambient.mp3", sourceDurationFrames: 3600 },
      sfx: [
        {
          event: { id: "sfx-1", atFrame: 45, trackId: "whoosh-1", gainDb: -8 },
          path: "cache/library-whoosh.mp3",
          sourceDurationFrames: 36,
        },
      ],
    },
  );
  assert.equal(t.tracks.filter((x) => x.kind === "audio").length, 3);
  const xml = toFCPXML(t, "/Projects/Demo");
  assert.match(xml, /lane="2"/);
  assert.match(xml, /audioRole="music"/);
  assert.match(xml, /audioRole="effects"/);
  assert.match(xml, /adjust-transform position="-?\d+(\.\d+)? -?\d+(\.\d+)?"/);
  assert.ok(xml.includes("broll-1-inset"));
});

test("per-scene music intensity becomes contiguous music clips with scaled gains", () => {
  const base = fixture();
  const scenes = [1, 0.5, 0, 1].map((musicIntensity, i) => ({
    ...base.scenes[0],
    id: `scene-${i + 1}`,
    startFrame: i * 90,
    musicIntensity,
  }));
  const plan = validatePlan({ ...base, durationFrames: 360, scenes });
  const t = makeTimeline(plan, [recording], new Map(), new Map(), {
    design: {
      music: {
        trackId: "ambient-1",
        gainDb: -24,
        duckToDb: -18,
        fadeInSec: 1,
        fadeOutSec: 2,
      },
      sfx: [],
    },
    music: { path: "cache/library-ambient.mp3", sourceDurationFrames: 3600 },
    sfx: [],
  });
  const bed = t.tracks.find((x) => x.id === "a2")!;
  assert.deepEqual(
    bed.clips.map((c) => [c.startFrame, c.durationFrames]),
    [
      [0, 90],
      [90, 90],
      [180, 90],
      [270, 90],
    ],
  );
  assert.equal(bed.clips[0].gainDb, -24);
  assert.ok(
    Math.abs(bed.clips[1].gainDb - (-24 + 20 * Math.log10(0.5))) < 1e-9,
  );
  assert.equal(bed.clips[2].gainDb, -48);
  assert.equal(bed.clips[3].gainDb, -24);
  const xml = toFCPXML(t, "/Projects/Demo");
  assert.equal(xml.match(/audioRole="music"/g)!.length, 4);
});
