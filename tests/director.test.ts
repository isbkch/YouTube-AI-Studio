import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DirectorAgent,
  mockPlan,
  type AIProvider,
  type DirectorInput,
  type StructuredRequest,
} from "../packages/agents/src/index.ts";
import {
  validateSources,
  type ProductionPlan,
} from "../packages/production-plan/src/index.ts";
import type {
  Recording,
  Transcript,
} from "../packages/orchestrator/src/model.ts";
import { Store } from "../packages/orchestrator/src/store.ts";
import { Studio } from "../packages/orchestrator/src/studio.ts";
import { alignScript } from "../packages/orchestrator/src/alignment.ts";
import { defaultCreator, hash, now } from "../packages/shared/src/index.ts";

const recording: Recording = {
  id: "recording-1",
  name: "take.mp4",
  path: "recordings/take.mp4",
  duration: 9,
  width: 1920,
  height: 1080,
  codec: "h264",
  frameRate: 30,
  hasAudio: true,
  audioCodec: "aac",
  bytes: 100,
  hash: hash("take"),
  importedAt: now(),
  proxyPath: null,
  proxyStatus: "PENDING",
  frames: 270,
  proxyFrames: null,
};
const transcript: Transcript = {
  schemaVersion: "1.0.0",
  recordingId: recording.id,
  language: "en",
  provider: "mock",
  model: "fixture",
  segments: [
    {
      id: "segment-20",
      start: 0,
      end: 3,
      text: "Careful engineers measure how requests travel through every system component.",
    },
    {
      id: "segment-21",
      start: 3,
      end: 6,
      text: "Database backups require regular restoration drills before an actual incident.",
    },
    {
      id: "segment-22",
      start: 6,
      end: 9,
      text: "Production monitoring reveals unexpected failures while customers continue using applications.",
    },
  ],
};
const input: DirectorInput = {
  projectId: "project-1",
  script: {
    version: 1,
    text: transcript.segments.map((s) => s.text).join(" "),
  },
  recordings: [recording],
  transcripts: [transcript],
  creator: structuredClone(defaultCreator),
  version: 1,
  targetDuration: 9,
  alignment: null,
};
const usage = {
  agent: "production_plan",
  provider: "fixture",
  model: "fixture",
  inputTokens: 10,
  outputTokens: 20,
  audioSeconds: 0,
  imageCount: 0,
  costUSD: null,
  elapsedMs: 1,
  createdAt: now(),
};
function providerFor(edit: (plan: ProductionPlan) => void): AIProvider {
  return {
    name: "mock",
    async generateStructured<T>(request: StructuredRequest<T>) {
      const candidate = structuredClone(request.mockOutput) as ProductionPlan;
      edit(candidate);
      return { output: request.schema.parse(candidate), usage };
    },
  };
}

test("Director resolves stale segment IDs from the selected frames and preserves the raw candidate", async () => {
  const stale = {
    ...transcript,
    segments: [{ id: "old", start: 0, end: 9, text: "Old transcript." }],
  };
  const second: Recording = { ...recording, id: "recording-2" };
  const secondTranscript: Transcript = {
    ...transcript,
    recordingId: second.id,
    segments: [
      {
        id: "segment-20",
        start: 0,
        end: 9,
        text: "Another recording with a locally reused segment identifier.",
      },
    ],
  };
  const source = {
    ...input,
    recordings: [recording, second],
    transcripts: [stale, transcript, secondTranscript],
  };
  // Use only the current transcript for the mock editor; pass transcript history
  // into the real Director to exercise its latest-per-recording source lookup.
  const expected = mockPlan({
    ...source,
    transcripts: [transcript, secondTranscript],
  });
  let raw: ProductionPlan | undefined;
  const provider = providerFor((plan) => {
    plan.scenes = structuredClone(expected.scenes);
    plan.durationFrames = expected.durationFrames;
    plan.scenes[2].transcriptSegmentIds = ["segment-20", "unknown-id"];
  });
  const result = await new DirectorAgent(provider).plan(
    source,
    undefined,
    async (candidate) => {
      raw = candidate.output as ProductionPlan;
    },
  );
  assert.deepEqual(raw!.scenes[2].transcriptSegmentIds, [
    "segment-20",
    "unknown-id",
  ]);
  assert.deepEqual(result.output.scenes[2].transcriptSegmentIds, [
    "segment-22",
  ]);
  assert.deepEqual(result.output.scenes[3].transcriptSegmentIds, [
    "segment-20",
  ]);
  assert.deepEqual(result.output.scenes, expected.scenes);
  validateSources(result.output, source.recordings, source.transcripts);
  assert.throws(() =>
    validateSources(raw!, source.recordings, source.transcripts),
  );
});

test("Director provenance repair still rejects invalid editorial selections", async () => {
  const cases: { edit: (p: ProductionPlan) => void; error: RegExp }[] = [
    {
      edit: (p) => {
        p.scenes[2].narration =
          "Astronauts explore distant galaxies observing planets stars moons nebulae comets.";
      },
      error: /narration is not spoken/,
    },
    {
      edit: (p) => {
        p.scenes[2].sourceInFrame = p.scenes[1].sourceInFrame;
        p.scenes[2].narration = p.scenes[1].narration;
      },
      error: /replay the same source frames/,
    },
    {
      edit: (p) => {
        p.scenes[2].sourceInFrame = 270;
      },
      error: /source range exceeds/,
    },
    {
      edit: (p) => {
        p.scenes[2].camera.recordingId = "unknown";
      },
      error: /unknown recording/,
    },
  ];
  for (const { edit, error } of cases)
    await assert.rejects(
      new DirectorAgent(providerFor(edit)).plan(input),
      error,
    );
});

test("aligned Director can style scenes but cannot invent footage or narration", async () => {
  const source = {
    ...input,
    alignment: alignScript({
      script: input.script.text,
      scriptVersion: 1,
      recordings: input.recordings,
      transcripts: input.transcripts,
    }),
  };
  const baseline = mockPlan(source);
  const treatment = {
    id: baseline.scenes[0].id,
    visual: {
      type: "presenter",
      description: "Emphasize the opening.",
      graphic: null,
    },
    framing: "close",
    punchIn: 1.12,
    musicIntensity: 0.5,
    rationale: "Opening emphasis.",
    chapterTitle: "Start with evidence",
  };
  const provider: AIProvider = {
    name: "fixture",
    async generateStructured<T>(request: StructuredRequest<T>) {
      assert.equal(request.name, "storyboard_direction");
      assert.throws(() =>
        request.schema.parse({
          summary: "Test",
          scenes: [{ ...treatment, sourceInFrame: 9999 }],
        }),
      );
      assert.throws(() =>
        request.schema.parse({
          summary: "Test",
          scenes: [{ ...treatment, narration: "Invented speech." }],
        }),
      );
      return {
        output: request.schema.parse({
          summary: "Directed verified footage.",
          scenes: [treatment],
        }),
        usage,
      };
    },
  };
  const result = await new DirectorAgent(provider).plan(source);
  const sourceFields = (p: ProductionPlan) =>
    p.scenes.map((s) => ({
      id: s.id,
      start: s.startFrame,
      duration: s.durationFrames,
      sourceIn: s.sourceInFrame,
      recording: s.camera.recordingId,
      narration: s.narration,
      segments: s.transcriptSegmentIds,
    }));
  assert.deepEqual(sourceFields(result.output), sourceFields(baseline));
  assert.equal(result.output.scenes[0].camera.punchIn, 1.12);
  assert.equal(result.output.scenes[0].chapterTitle, "Start with evidence");
  assert.equal(result.output.director.provider, usage.provider);
  assert.ok(
    result.output.scenes
      .slice(1)
      .every((s) => s.visual.graphic === null && s.chapterTitle === null),
  );
  assert.deepEqual(result.output.scriptCoverage, baseline.scriptCoverage);
  validateSources(result.output, source.recordings, source.transcripts);

  for (const treatments of [
    [{ ...treatment, id: "unknown-scene" }],
    [treatment, treatment],
  ]) {
    let saved = false;
    const invalid: AIProvider = {
      name: "fixture",
      async generateStructured<T>(request: StructuredRequest<T>) {
        return {
          output: request.schema.parse({
            summary: "Invalid map",
            scenes: treatments,
          }),
          usage,
        };
      },
    };
    await assert.rejects(
      new DirectorAgent(invalid).plan(source, undefined, async () => {
        saved = true;
      }),
      /unknown or repeated scene/,
    );
    assert.equal(saved, true);
  }
});

test("Director candidates and usage survive rejection without creating or approving a plan", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wts-director-"));
  const store = new Store(root);
  try {
    const p = store.create("Director candidate evidence");
    const studio = new Studio(store);
    await studio.saveScript(p.id, input.script.text);
    await studio.approveScript(p.id, 1);
    store.update(p.id, (x) => {
      x.recordings = [recording];
      x.transcripts = [transcript];
      x.status = "MEDIA_IMPORTED";
    });
    studio.provider = providerFor((plan) => {
      plan.scenes[0].narration =
        "Astronauts explore distant galaxies observing planets stars moons nebulae comets.";
    });
    await assert.rejects(studio.generatePlan(p.id), /narration is not spoken/);
    const failed = store.get(p.id);
    assert.equal(failed.status, "MEDIA_IMPORTED");
    assert.equal(failed.plans.length, 0);
    assert.equal(failed.planApproval, null);
    assert.equal(failed.usage.length, 1);
    const logs = path.join(store.dir(p), "logs");
    const files = await readdir(logs);
    assert.equal(files.length, 1);
    const candidate = JSON.parse(
      await readFile(path.join(logs, files[0]), "utf8"),
    );
    assert.match(candidate.output.scenes[0].narration, /Astronauts/);
    assert.deepEqual(candidate.usage, usage);
    studio.provider = providerFor((plan) => {
      plan.scenes[0].transcriptSegmentIds = ["unknown-id"];
    });
    await studio.generatePlan(p.id);
    const succeeded = store.get(p.id);
    assert.equal(succeeded.status, "AWAITING_STORYBOARD_APPROVAL");
    assert.equal(succeeded.plans.length, 1);
    assert.equal(succeeded.planApproval, null);
    assert.equal(succeeded.usage.length, 2); // One entry per returned candidate.
    assert.equal((await readdir(logs)).length, 2);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
