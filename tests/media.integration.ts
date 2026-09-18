import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, readFile, readdir } from "node:fs/promises";
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
import {
  RealBlenderProvider,
  buildBlenderSpec,
} from "../packages/blender-engine/src/index.ts";
import type { BRollEntry } from "../packages/production-plan/src/index.ts";
import {
  renderGraphic,
  renderCaption,
} from "../packages/remotion-engine/src/index.ts";
import { builtinSfxFile } from "../packages/orchestrator/src/sfx.ts";
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

test("punch-line captions render transparent clips at preview resolution", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wts-captions-"));
  try {
    const plan = fixture();
    const words = ["This", "is", "not", "high", "availability."];
    const event = {
      id: "caption-scene-1-1",
      sceneId: plan.scenes[0].id,
      startFrame: 30,
      endFrame: 102,
      text: words.join(" "),
      words: words.map((text, i) => ({ atFrame: 30 + i * 12, text })),
    };
    for (const style of ["pop", "karaoke"] as const) {
      const output = path.join(dir, `caption-${style}.webm`);
      await renderCaption(event, style, plan, defaultCreator.brand, output);
      const meta = await verifyOutput(
        output,
        (event.endFrame - event.startFrame) / plan.frameRate,
      );
      assert.equal(meta.width, PREVIEW.width, `${style} renders full-frame`);
      assert.equal(meta.height, PREVIEW.height);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the built-in SFX bank synthesizes deterministic audio", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wts-sfx-"));
  try {
    for (const track of ["builtin.whoosh", "builtin.pop", "builtin.riser"]) {
      const first = await builtinSfxFile(dir, track);
      const again = await builtinSfxFile(dir, track);
      assert.ok(first.duration > 0.15 && first.duration < 1.2, track);
      assert.equal(await fileHash(first.file), await fileHash(again.file));
      // The mix probes real audio, so the synthesized files must carry a
      // decodable audio stream.
      assert.ok((await inspect(first.file)).hasAudio !== false);
    }
    await assert.rejects(builtinSfxFile(dir, "builtin.nope"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * Grayscale pixels of the caption strip (bottom-center region) at one frame,
 * to prove burned captions actually change the picture at their time — the
 * class of bug where the overlay stream desyncs and nothing appears.
 */
async function captionStripPixels(file: string, atSec: number, dir: string) {
  const out = path.join(
    dir,
    `strip-${path.basename(file)}-${Math.round(atSec * 1000)}.gray`,
  );
  await ffmpeg([
    "-ss",
    String(atSec),
    "-i",
    file,
    "-frames:v",
    "1",
    "-vf",
    "crop=1280:260:320:720,format=gray",
    "-f",
    "rawvideo",
    "-y",
    out,
  ]);
  const buf = await readFile(out);
  await rm(out, { force: true });
  return buf;
}

function meanAbsDiff(a: Buffer, b: Buffer) {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(a[i] - b[i]);
  return sum / n;
}

test("the craftsman build burns captions and engineers the narration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wts-craftsman-"));
  const store = new Store(root);
  try {
    const clips = path.join(root, "clips");
    await mkdir(clips, { recursive: true });
    const clip = await syntheticClip(clips, "take.mp4", 6, 0x207060);
    const studio = new Studio(store);
    const p = store.create("Craftsman build", "Persona integration", 6);
    await studio.saveScript(
      p.id,
      "We just added a second server. This is not high availability.",
    );
    await studio.approveScript(p.id, 1);
    await studio.importMedia(p.id, clip);
    const rec = store.get(p.id).recordings[0];
    const sentence = (start: number, text: string, id: string) => {
      const parts = text.split(" ");
      return {
        id,
        start,
        end: start + parts.length * 0.4,
        text,
        words: parts.map((w, j) => ({
          start: start + j * 0.4,
          end: start + (j + 1) * 0.4,
          text: w,
        })),
      };
    };
    await studio.loadTranscript(p.id, {
      schemaVersion: "1.0.0",
      recordingId: rec.id,
      language: "en",
      provider: "mock",
      model: "fixture",
      segments: [
        sentence(0.2, "We just added a second server.", "s-1"),
        sentence(3.4, "This is not high availability.", "s-2"),
      ],
    });
    await studio.generatePlan(p.id, { director: "craftsman" });
    const plan = store.get(p.id).plans[0];
    assert.equal(plan.captionStyle, "pop");
    assert.equal(plan.audioPolish, "polished");
    const captions = studio.captionEvents(p.id);
    assert.equal(captions.events.length, 1, "one punch line qualifies");
    assert.match(captions.events[0].text, /not high availability/);
    await studio.approvePlan(p.id, 1);
    await studio.build(p.id);
    const latest = store.get(p.id).builds.at(-1)!;
    const preview = path.join(store.dir(p), latest.previewPath);
    const meta = await verifyOutput(
      preview,
      plan.durationFrames / plan.frameRate,
    );
    assert.equal(meta.width, PREVIEW.width);
    const assets = store.assets(p.id);
    assert.ok(
      assets.some((a) => a.type === "caption-render"),
      "caption clips are recorded as assets",
    );
    assert.ok(assets.some((a) => a.type === "caption-burn"));
    assert.ok(
      assets.some((a) => a.type === "audio-mix"),
      "the polished narration runs through the mix task",
    );
    const audio = await inspect(preview);
    assert.ok(audio.hasAudio !== false);
    // Pixel proof: inside the caption window the strip must differ strongly
    // from the pre-burn concat; outside it, only re-encode noise remains.
    // This is the regression guard for overlay desync (PTS-shift) bugs.
    const cacheDir = path.join(store.dir(p), "cache");
    const concatName = (await readdir(cacheDir)).find((f) =>
      f.startsWith("concat-"),
    );
    assert.ok(concatName, "the assembly cached its concat intermediate");
    const concat = path.join(cacheDir, concatName!);
    const event = captions.events[0];
    const midSec = (event.startFrame + event.endFrame) / 2 / plan.frameRate;
    const during = meanAbsDiff(
      await captionStripPixels(concat, midSec, clips),
      await captionStripPixels(preview, midSec, clips),
    );
    const outside = meanAbsDiff(
      await captionStripPixels(concat, 0.25, clips),
      await captionStripPixels(preview, 0.25, clips),
    );
    assert.ok(
      during > 12 && during > outside * 3,
      `the caption must visibly burn in its window (mean Δ ${during.toFixed(1)} inside vs ${outside.toFixed(1)} outside)`,
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("blender EEVEE renders a trusted template clip end-to-end", async () => {
  const provider = await RealBlenderProvider.create();
  if (!provider) {
    console.log("Blender not installed; skipping the real EEVEE render.");
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "wts-blender-eevee-"));
  try {
    const plan = fixture();
    const entry: BRollEntry = {
      id: "broll-blender",
      startFrame: 0,
      durationFrames: 24,
      placement: "fullframe",
      inset: null,
      motion: "none",
      asset: {
        engine: "blender",
        template: "OrbitRings",
        templateVersion: "1.0.0",
        parameters: { template: "OrbitRings", rings: 3, revolutions: 1 },
      },
      narrationHook: "capacity orbiting the request path",
    };
    const spec = buildBlenderSpec(entry, plan, {
      background: defaultCreator.brand.background,
      foreground: defaultCreator.brand.foreground,
      accent: defaultCreator.brand.accent,
    });
    const result = await provider.renderClip({ spec });
    const clip = path.join(root, "clip.mp4");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(clip, result.file);
    await verifyOutput(clip, spec.durationFrames / spec.frameRate);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
