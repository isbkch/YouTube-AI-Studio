import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { access, constants } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { ffmpeg, executable, runBinary } from "../../media/src/index.ts";
import { hash, now, StudioError, type Usage } from "../../shared/src/index.ts";
import {
  BROLL_INSET_HEIGHT_RATIO,
  type BRollEntry,
  type ProductionPlan,
} from "../../production-plan/src/index.ts";

/** The clip box a B-roll entry renders into; even dimensions for H.264. */
export function blenderBox(entry: BRollEntry, plan: ProductionPlan) {
  const even = (n: number) => Math.max(2, 2 * Math.round(n / 2));
  if (entry.placement === "fullframe")
    return { width: plan.resolution.width, height: plan.resolution.height };
  const width = even(plan.resolution.width * entry.inset!.width);
  return {
    width,
    height: even(width * BROLL_INSET_HEIGHT_RATIO),
  };
}

export type BlenderBrand = {
  background: string;
  foreground: string;
  accent: string;
};

/**
 * The full trusted scene spec handed to the bridge. Built only from
 * schema-validated plan data and creator brand values — never plan prose
 * (ADR 007/008: the bridge evaluates data, never instructions).
 */
export interface BlenderSpec {
  template: Extract<
    Extract<BRollEntry["asset"], { engine: "blender" }>["template"],
    string
  >;
  parameters: Extract<
    Extract<BRollEntry["asset"], { engine: "blender" }>["parameters"],
    { template: string }
  >;
  brand: BlenderBrand;
  width: number;
  height: number;
  frameRate: number;
  durationFrames: number;
  /** Set by the provider: where the bridge writes the PNG frame sequence. */
  framesDir?: string;
}

export function buildBlenderSpec(
  entry: BRollEntry,
  plan: ProductionPlan,
  brand: BlenderBrand,
): BlenderSpec {
  if (entry.asset.engine !== "blender")
    throw new StudioError(
      "INVALID_INPUT",
      `buildBlenderSpec needs a blender asset, got ${entry.asset.engine}.`,
    );
  const box = blenderBox(entry, plan);
  return {
    template: entry.asset.template,
    parameters: entry.asset.parameters,
    brand,
    width: box.width,
    height: box.height,
    frameRate: plan.frameRate,
    durationFrames: entry.durationFrames,
  };
}

export interface BlenderResult {
  file: Buffer;
  usage: Usage;
}

/** Trusted adapter boundary for Blender-rendered B-roll clips (ADR 007). */
export interface BlenderProvider {
  readonly name: string;
  readonly version: string;
  renderClip(options: {
    spec: BlenderSpec;
    signal?: AbortSignal;
    progress?: (fraction: number) => void;
  }): Promise<BlenderResult>;
}

function parseResult(stdout: string): Record<string, unknown> {
  const line = stdout
    .split("\n")
    .find((candidate) => candidate.startsWith("WTS_RESULT:"));
  if (!line)
    throw new StudioError(
      "EXTERNAL_TOOL",
      "Blender did not report a structured result.",
      "Check the job log and the Blender installation, then retry.",
      true,
    );
  return JSON.parse(line.slice("WTS_RESULT:".length));
}

let cachedExecutable: string | null = null;

/** Absolute path to the local Blender binary, or null when not installed. */
export async function blenderBinary(): Promise<string | null> {
  if (cachedExecutable) return cachedExecutable;
  try {
    const binary = await executable("blender");
    await access(binary, constants.X_OK);
    cachedExecutable = binary;
    return binary;
  } catch {
    return null;
  }
}

export async function probeBlender(): Promise<{ version: string } | null> {
  const binary = await blenderBinary();
  if (!binary) return null;
  try {
    const { stdout } = await runBinary(binary, ["--version"], {
      timeoutMs: 30_000,
    });
    const version = stdout.match(/Blender (\d+\.\d+[^\s]*)/)?.[1];
    if (!version) return null;
    return { version };
  } catch {
    return null;
  }
}

export class RealBlenderProvider implements BlenderProvider {
  readonly name = "blender_eevee";
  readonly version: string;
  private binary: string;
  private constructor(binary: string, version: string) {
    this.binary = binary;
    this.version = version;
  }
  /** Fails closed when Blender is not installed; capabilities stay null. */
  static async create(): Promise<RealBlenderProvider | null> {
    const binary = await blenderBinary();
    if (!binary) return null;
    const probe = await probeBlender();
    if (!probe) return null;
    return new RealBlenderProvider(binary, probe.version);
  }
  async renderClip(options: {
    spec: BlenderSpec;
    signal?: AbortSignal;
    progress?: (fraction: number) => void;
  }): Promise<BlenderResult> {
    const o = options;
    o.signal?.throwIfAborted();
    const started = performance.now();
    const workspace = await mkdtemp(path.join(os.tmpdir(), "wts-blender-"));
    const specPath = path.join(workspace, "spec.json");
    const framesDir = path.join(workspace, "frames");
    const clip = path.join(workspace, "clip.mp4");
    const bridge = fileURLToPath(new URL("./bridge.py", import.meta.url));
    try {
      await writeFile(
        specPath,
        JSON.stringify({ ...o.spec, framesDir: path.resolve(framesDir) }),
      );
      const { stdout } = await runBinary(
        this.binary,
        ["--background", "--python", bridge, "--", specPath],
        { signal: o.signal, timeoutMs: 4 * 60 * 60_000 },
      );
      const result = parseResult(stdout);
      if (!result.available)
        throw new StudioError(
          "EXTERNAL_TOOL",
          String(result.reason ?? "Blender render failed."),
          "Check the Blender render parameters, then retry.",
          true,
        );
      // Blender versions disagree on in-process movie encoding; the PNG
      // sequence is encoded here so every clip shares one H.264 identity.
      const seconds = o.spec.durationFrames / o.spec.frameRate;
      await ffmpeg(
        [
          "-framerate",
          String(o.spec.frameRate),
          "-i",
          path.join(framesDir, "frame_%04d.png"),
          "-frames:v",
          String(o.spec.durationFrames),
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-crf",
          "21",
          "-pix_fmt",
          "yuv420p",
          clip,
        ],
        o.signal,
        o.progress,
        seconds,
      );
      return {
        file: await readFile(clip),
        usage: {
          agent: this.name,
          provider: "blender",
          model: `eevee/${this.version}`,
          inputTokens: 0,
          outputTokens: 0,
          audioSeconds: 0,
          imageCount: 0,
          costUSD: 0,
          elapsedMs: performance.now() - started,
          createdAt: now(),
        },
      };
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }
}

/** Deterministic ffmpeg gradient clip seeded by the spec; no Blender needed. */
export class MockBlenderProvider implements BlenderProvider {
  readonly name = "blender_eevee";
  readonly version = "deterministic-v1";
  async renderClip(options: {
    spec: BlenderSpec;
    signal?: AbortSignal;
    progress?: (fraction: number) => void;
  }): Promise<BlenderResult> {
    const o = options;
    o.signal?.throwIfAborted();
    const seed = hash(o.spec);
    const hex = (offset: number) =>
      `#${[0, 1, 2]
        .map(
          (i) =>
            (parseInt(seed.slice(offset + i * 2, offset + i * 2 + 2), 16) +
              64) %
            256,
        )
        .map((n) => n.toString(16).padStart(2, "0"))
        .join("")}`;
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), "wts-blender-mock-"),
    );
    const clip = path.join(workspace, "clip.mp4");
    const seconds = o.spec.durationFrames / o.spec.frameRate;
    try {
      await ffmpeg(
        [
          "-f",
          "lavfi",
          "-i",
          `gradients=s=${o.spec.width}x${o.spec.height}:c0=${hex(0)}:c1=${hex(32)}:x0=0:y0=0:x1=${o.spec.width}:y1=${o.spec.height}:d=${seconds.toFixed(3)}:r=${o.spec.frameRate}`,
          "-frames:v",
          String(o.spec.durationFrames),
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-crf",
          "23",
          "-pix_fmt",
          "yuv420p",
          clip,
        ],
        o.signal,
        o.progress,
        seconds,
      );
      return {
        file: await readFile(clip),
        usage: {
          agent: this.name,
          provider: "mock",
          model: this.version,
          inputTokens: 0,
          outputTokens: 0,
          audioSeconds: 0,
          imageCount: 0,
          costUSD: 0,
          elapsedMs: 0,
          createdAt: now(),
        },
      };
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }
}

export const BLENDER_RENDERER = "blender+eevee-v1";

/** Semantic render identity: narration and plan version never invalidate pixels. */
export function blenderClipKey(
  entry: BRollEntry,
  plan: ProductionPlan,
  provider: { version: string },
  brand: BlenderBrand,
) {
  return hash({
    asset: entry.asset,
    durationFrames: entry.durationFrames,
    placement: entry.placement,
    inset: entry.inset,
    frameRate: plan.frameRate,
    box: blenderBox(entry, plan),
    brand,
    version: provider.version,
    renderer: BLENDER_RENDERER,
  });
}
