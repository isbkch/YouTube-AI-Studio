import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  executable,
  inspect,
  runBinary,
  verifyOutput,
} from "../packages/media/src/index.ts";
import { validateEngines } from "../packages/orchestrator/src/engines.ts";
import {
  MockBlenderProvider,
  RealBlenderProvider,
  blenderBox,
  blenderClipKey,
  buildBlenderSpec,
  writeBlenderClip,
} from "../packages/blender-engine/src/index.ts";
import { fixture } from "./fixtures.ts";
import {
  validatePlan,
  type BRollAsset,
  type BRollEntry,
  type ProductionPlan,
} from "../packages/production-plan/src/index.ts";

const brand = {
  background: "#101b29",
  foreground: "#f2f4ed",
  accent: "#c8ef80",
};
const blenderAsset = (): BRollAsset => ({
  engine: "blender",
  template: "NetworkFlow",
  templateVersion: "1.0.0",
  parameters: {
    template: "NetworkFlow",
    nodes: ["edge", "api", "db"],
    packets: 6,
  },
});
const entry = (over: Partial<BRollEntry> = {}): BRollEntry =>
  ({
    id: "broll-1",
    startFrame: 12,
    durationFrames: 48,
    placement: "inset",
    inset: { x: 0.55, y: 0.5, width: 0.38 },
    motion: "zoom-in",
    asset: blenderAsset(),
    narrationHook: "requests flowing through redundant services",
    ...over,
  }) as BRollEntry;
const withBroll = (
  broll: BRollEntry[],
  plan: ProductionPlan = fixture(),
): ProductionPlan =>
  validatePlan({
    ...plan,
    scenes: plan.scenes.map((s) => ({ ...s, broll })),
  });

test("blender B-roll entries validate against their typed template parameters", () => {
  const plan = withBroll([entry()]);
  assert.equal(plan.scenes[0].broll[0].asset.engine, "blender");
  // Parameter violations fail validation, never reach the bridge.
  assert.throws(() =>
    withBroll([
      entry({
        asset: {
          engine: "blender",
          template: "NetworkFlow",
          templateVersion: "1.0.0",
          parameters: { template: "NetworkFlow", nodes: ["solo"], packets: 6 },
        },
      }),
    ]),
  );
  assert.throws(() =>
    withBroll([
      entry({
        asset: {
          engine: "blender",
          template: "TerrainSweep",
          templateVersion: "1.0.0",
          // TS-assignable (99 is a number) but rejected by the Zod range.
          parameters: { template: "TerrainSweep", ridges: 99, amplitude: 0.2 },
        },
      }),
    ]),
  );
});

test("execution rejects unconfigured blender and accepts an injected provider", () => {
  const plan = withBroll([entry()]);
  assert.throws(
    () => validateEngines(plan, null, null),
    /blender.*is not configured/s,
  );
  assert.doesNotThrow(() =>
    validateEngines(plan, null, new MockBlenderProvider()),
  );
});

test("blender clip identity is stable and ignores narration and plan version", () => {
  const provider = new MockBlenderProvider();
  const a = blenderClipKey(entry(), fixture(), provider, brand);
  const b = blenderClipKey(
    entry({ narrationHook: "a different hook" }),
    { ...fixture(), version: 99 },
    provider,
    brand,
  );
  assert.equal(a, b);
  // Motion is not part of a 3D render's identity: the template animates its
  // own camera. Template and parameters do invalidate pixels.
  assert.equal(
    a,
    blenderClipKey(entry({ motion: "pan-left" }), fixture(), provider, brand),
  );
  assert.notEqual(
    a,
    blenderClipKey(
      entry({
        asset: {
          engine: "blender",
          template: "ServerRack",
          templateVersion: "1.0.0",
          parameters: { template: "ServerRack", racks: 4, pulseRate: 1.5 },
        },
      }),
      fixture(),
      provider,
      brand,
    ),
  );
  assert.notEqual(
    a,
    blenderClipKey(entry(), fixture(), provider, {
      ...brand,
      accent: "#ffffff",
    }),
  );
});

test("mock provider renders a deterministic decodable clip at the plan resolution", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wts-blender-mock-"));
  try {
    const provider = new MockBlenderProvider();
    const spec = buildBlenderSpec(entry(), fixture(), brand);
    // The bridge contract renders only 1920×1080 — even for inset entries,
    // whose boxes are smaller. Insets are conformed afterwards.
    assert.deepEqual([spec.width, spec.height], [1920, 1080]);
    assert.deepEqual([spec.width % 2, spec.height % 2], [0, 0]);
    const first = await provider.renderClip({ spec });
    const clip = path.join(dir, "clip.mp4");
    await writeFile(clip, first.file);
    assert.ok((await stat(clip)).size > 1000);
    assert.equal(first.usage.costUSD, 0);
    // ffmpeg encodes are not byte-stable; verify the decodable contract
    // (duration within tolerance) rather than byte equality.
    await verifyOutput(clip, spec.durationFrames / spec.frameRate);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rendered clips land in their box: full-frame passthrough, inset center-crop", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wts-blender-box-"));
  try {
    const plan = fixture();
    const provider = new MockBlenderProvider();
    const render = await provider.renderClip({
      spec: buildBlenderSpec(entry(), plan, brand),
    });
    // Full-frame: the render already is the box — bytes pass through intact.
    const fullframe = path.join(dir, "full.mp4");
    await writeBlenderClip(render.file, {
      entry: entry({ placement: "fullframe", inset: null }),
      plan,
      output: fullframe,
    });
    assert.deepEqual(await readFile(fullframe), render.file);
    // Inset: conformed to the entry box with even H.264 dimensions.
    const insetEntry = entry();
    const inset = path.join(dir, "inset.mp4");
    await writeBlenderClip(render.file, {
      entry: insetEntry,
      plan,
      output: inset,
    });
    const box = blenderBox(insetEntry, plan);
    const meta = await inspect(inset);
    assert.deepEqual([meta.width, meta.height], [box.width, box.height]);
    await verifyOutput(inset, insetEntry.durationFrames / plan.frameRate);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Exercise the real bridge.py against a stubbed bpy module (no Blender).
const harness = `
import os, runpy, sys, types

class Fake:
    def __init__(self, **kw): self.__dict__.update(kw)
    def __getattr__(self, name):
        val = Fake()
        self.__dict__[name] = val
        return val
    def __call__(self, *a, **k): return Fake()
    def __getitem__(self, k):
        items = self.__dict__.setdefault("_items", {})
        if k not in items: items[k] = Fake()
        return items[k]
    def __contains__(self, k): return False
    def __iter__(self): return iter([])
    def get(self, k, default=None):
        return self.__dict__.setdefault("_items", {}).setdefault(k, Fake())

def fake_render(animation=True):
    scene = bpy.context.scene
    prefix = scene.render.filepath
    os.makedirs(os.path.dirname(prefix), exist_ok=True)
    for f in range(1, scene.frame_end + 1):
        with open("%s%04d.png" % (prefix, f), "wb") as handle:
            handle.write(b"fake-png")

bridge, spec_path = sys.argv[1:3]
bpy = types.ModuleType("bpy")
bpy.context = Fake()
bpy.ops = Fake()
bpy.ops.render.render = fake_render
bpy.data = Fake()
bpy.types = Fake()
sys.modules["bpy"] = bpy
sys.argv = [bridge, "--", spec_path]
runpy.run_path(bridge, run_name="__main__")
`;

async function runBridge(spec: Record<string, unknown>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wts-blender-bridge-"));
  try {
    const framesDir = path.join(root, "frames");
    const specPath = path.join(root, "spec.json");
    await writeFile(specPath, JSON.stringify({ ...spec, framesDir }));
    const python = await executable("python3");
    const { stdout } = await runBinary(python, [
      "-c",
      harness,
      path.resolve("packages/blender-engine/src/bridge.py"),
      specPath,
    ]);
    // Capture before the temp dir is removed in the finally below.
    const frameCount = existsSync(framesDir)
      ? (await readdir(framesDir)).length
      : 0;
    return {
      result: JSON.parse(
        stdout
          .split("\n")
          .find((line) => line.startsWith("WTS_RESULT:"))!
          .slice("WTS_RESULT:".length),
      ),
      frameCount,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const bridgeSpec = () => ({
  template: "OrbitRings",
  parameters: { template: "OrbitRings", rings: 3, revolutions: 1 },
  brand,
  width: 1920,
  height: 1080,
  frameRate: 30,
  durationFrames: 24,
});

test("bridge renders from a validated spec and rejects invalid specs", async () => {
  const good = await runBridge(bridgeSpec());
  assert.equal(good.result.available, true);
  assert.equal(good.result.template, "OrbitRings");
  assert.equal(good.result.frames, 24);
  assert.equal(good.frameCount, 24);
  assert.equal(good.result.framesDir.endsWith("frames"), true);

  const unknown = await runBridge({
    ...bridgeSpec(),
    template: "NotATemplate",
  });
  assert.equal(unknown.result.available, false);
  assert.match(unknown.result.reason, /unknown template/);

  const badColor = await runBridge({
    ...bridgeSpec(),
    brand: { ...brand, accent: "nope" },
  });
  assert.equal(badColor.result.available, false);
  assert.match(badColor.result.reason, /colors must be #rrggbb/);

  const badResolution = await runBridge({
    ...bridgeSpec(),
    width: 1280,
  });
  assert.equal(badResolution.result.available, false);
  assert.match(badResolution.result.reason, /1920x1080/);
});

test("real provider creation fails closed when Blender is unavailable", async () => {
  const oldPath = process.env.WTS_BLENDER_PATH;
  process.env.WTS_BLENDER_PATH = "/nonexistent/blender-binary";
  try {
    const provider = await RealBlenderProvider.create();
    assert.equal(provider, null);
  } finally {
    if (oldPath === undefined) delete process.env.WTS_BLENDER_PATH;
    else process.env.WTS_BLENDER_PATH = oldPath;
  }
});
