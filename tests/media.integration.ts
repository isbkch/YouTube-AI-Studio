import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  ffmpeg,
  inspect,
  proxy,
  extractAudio,
  verifyOutput,
  PREVIEW,
} from "../packages/media/src/index.ts";
import { fileHash, defaultCreator } from "../packages/shared/src/index.ts";
import { renderGraphic } from "../packages/remotion-engine/src/index.ts";
import { Store } from "../packages/orchestrator/src/store.ts";
import { Studio } from "../packages/orchestrator/src/studio.ts";
import {
  TEMPLATE_CATALOG,
  type Graphic,
} from "../packages/production-plan/src/index.ts";
import { fixture } from "./fixtures.ts";

async function syntheticClip(
  dir: string,
  name: string,
  seconds: number,
  hue: number,
) {
  const file = path.join(dir, name);
  await ffmpeg([
    "-f",
    "lavfi",
    "-i",
    `color=c=0x${hue.toString(16).padStart(6, "0")}:s=640x360:r=30:d=${seconds}`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${400 + (hue % 200)}:duration=${seconds}`,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    file,
  ]);
  return file;
}

test("real media inspection, proxy, audio extraction and non-destructive source", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wts-media-"));
  try {
    const source = path.join(dir, "source with spaces.mp4");
    await ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "color=c=navy:s=640x360:r=30:d=2",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=2",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      source,
    ]);
    const before = await fileHash(source);
    assert.equal((await inspect(source)).width, 640);
    await proxy(source, path.join(dir, "proxy.mp4"));
    await extractAudio(source, path.join(dir, "audio.mp3"));
    await verifyOutput(path.join(dir, "proxy.mp4"), 2);
    assert.equal(await fileHash(source), before);
    assert.ok((await stat(path.join(dir, "audio.mp3"))).size > 1000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("real Remotion graphic renders decodable frames", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wts-remotion-"));
  try {
    const p = fixture();
    p.scenes[0].visual = {
      type: "graphic",
      description: "Flow",
      graphic: {
        engine: "remotion",
        template: "ArchitectureFlow",
        templateVersion: "1.0.0",
        parameters: {
          title: "Redundancy is not availability.",
          subtitle: "Test the recovery path.",
          nodes: ["Requests", "App A + B", "Database"],
          emphasis: 2,
        },
      },
    };
    const output = path.join(dir, "graphic.mp4");
    await renderGraphic(p.scenes[0], p, defaultCreator.brand, output);
    assert.equal((await verifyOutput(output, 3)).width, PREVIEW.width);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
const CATALOG_PARAMETERS: Record<string, Record<string, unknown>> = {
  ChapterTitle: {
    title: "Availability is a behavior",
    subtitle: "Section one",
  },
  Callout: {
    title: "Two copies, one failure domain",
    subtitle: "Redundancy is not availability",
  },
  Quote: {
    quote: "Everything fails, all the time.",
    attribution: "as spoken",
  },
  ArchitectureFlow: {
    title: "The path",
    subtitle: "",
    nodes: ["Client", "Gateway", "App", "Database"],
    emphasis: 2,
  },
  ArchitectureDiagram: {
    title: "Layers",
    subtitle: "",
    layers: [
      { name: "Clients", components: ["Web", "Mobile"] },
      { name: "App tier", components: ["App A", "App B"] },
      { name: "Data", components: ["Database"] },
    ],
    failedLayer: 2,
  },
  RequestFlow: {
    title: "One request",
    subtitle: "",
    method: "GET",
    path: "/api/health",
    steps: ["Client", "Gateway", "Service", "Database"],
    failureStep: 2,
  },
  CodeReveal: {
    title: "The retry",
    fileName: "retry.ts",
    lines: [
      "export async function get(url) {",
      "  for (let i = 0; i < 3; i++) {",
      "    try { return await fetch(url); }",
      "    catch (e) { await sleep(100); }",
      "  }",
      "}",
    ],
    highlight: 2,
  },
  Terminal: {
    title: "Run it",
    lines: [
      { kind: "input", text: "npm run deploy" },
      { kind: "output", text: "deployed — verify it yourself" },
      { kind: "error", text: "error: not production ready" },
    ],
  },
  CodeDiff: {
    title: "The fix",
    fileName: "config.ts",
    removed: ["timeout: 1000,"],
    added: ["timeout: 10_000,", "retries: 3,"],
  },
  MetricChart: {
    title: "Latency",
    subtitle: "p99 before and after",
    unit: "ms",
    series: [820, 845, 860, 190, 185, 182],
    threshold: 250,
    goodDirection: "down",
  },
  FailureAnimation: {
    title: "Cascade",
    subtitle: "",
    nodes: ["Users", "Gateway", "App", "Database"],
    failedNode: 3,
    recovered: true,
  },
};
test("every catalog template renders decodable frames at preview resolution", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wts-catalog-"));
  try {
    assert.deepEqual(
      new Set(TEMPLATE_CATALOG.map((c) => c.template)),
      new Set(Object.keys(CATALOG_PARAMETERS)),
      "the test parameter table must cover the whole catalog",
    );
    for (const entry of TEMPLATE_CATALOG) {
      const p = fixture();
      p.scenes[0].visual = {
        type: "graphic",
        description: entry.template,
        graphic: {
          engine: "remotion",
          template: entry.template,
          templateVersion: "1.0.0",
          parameters: CATALOG_PARAMETERS[entry.template],
        } as Graphic,
      };
      const output = path.join(dir, `${entry.template}.mp4`);
      await renderGraphic(p.scenes[0], p, defaultCreator.brand, output);
      const meta = await verifyOutput(output, 3);
      assert.equal(meta.width, PREVIEW.width, entry.template);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("two real recordings plan and build one timeline end to end", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wts-multiclip-"));
  const clips = path.join(root, "clips");
  const store = new Store(root);
  try {
    await mkdir(clips, { recursive: true });
    const clipA = await syntheticClip(clips, "take-a.mp4", 2, 0x204080);
    const clipB = await syntheticClip(clips, "take-b.mp4", 3, 0x804020);
    const studio = new Studio(store);
    const p = store.create("Two-clip build", "Multi-clip integration", 5);
    await studio.saveScript(p.id, "Opening thought. Closing thought.");
    await studio.approveScript(p.id, 1);
    await studio.importMedia(p.id, clipA);
    await studio.importMedia(p.id, clipB);
    const imported = store.get(p.id);
    assert.equal(imported.status, "MEDIA_IMPORTED");
    assert.equal(imported.recordings.length, 2);
    const originals = await Promise.all(
      imported.recordings.map((r) => fileHash(path.join(store.dir(p), r.path))),
    );
    const payload = (id: string, text: string, end: number) => ({
      schemaVersion: "1.0.0",
      language: "en",
      provider: "mock",
      model: "fixture",
      segments: [{ id, start: 0, end, text }],
    });
    await studio.loadTranscript(p.id, payload("a-1", "Opening thought.", 2));
    await studio.loadTranscript(p.id, payload("b-1", "Closing thought.", 3));
    const transcripts = store.get(p.id).transcripts;
    assert.deepEqual(
      transcripts.map((t) => t.recordingId),
      imported.recordings.map((r) => r.id),
    );
    await studio.generatePlan(p.id);
    const plan = store.get(p.id).plans[0];
    assert.equal(plan.scenes.length, 2);
    assert.equal(plan.durationFrames, 150);
    assert.equal(plan.scenes[1].camera.recordingId, imported.recordings[1].id);
    await studio.approvePlan(p.id, 1);
    await studio.build(p.id);
    const latest = store.get(p.id).builds.at(-1)!;
    const preview = path.join(store.dir(p), latest.previewPath);
    await verifyOutput(preview, 5);
    const fcpxml = await readFile(
      path.join(store.dir(p), latest.exportPath),
      "utf8",
    );
    assert.equal((fcpxml.match(/<asset /g) || []).length, 2);
    const after = await Promise.all(
      store
        .get(p.id)
        .recordings.map((r) => fileHash(path.join(store.dir(p), r.path))),
    );
    assert.deepEqual(after, originals);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
