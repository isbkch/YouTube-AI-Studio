import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import OpenAI from "openai";
import { performance } from "node:perf_hooks";
import {
  geminiBlock,
  geminiInteractions,
  hash,
  now,
  StudioError,
  type Usage,
} from "../../shared/src/index.ts";
import { ffmpeg } from "../../media/src/index.ts";
import {
  BROLL_INSET_HEIGHT_RATIO,
  type BRollEntry,
  type ProductionPlan,
} from "../../production-plan/src/index.ts";

/** Sizes gpt-image-1 accepts. B-roll boxes are landscape; one size serves all. */
export const BROLL_SOURCE_SIZE = "1536x1024" as const;
export type ImageSize = "1024x1024" | "1536x1024" | "1024x1536";

export interface ImageRequest {
  prompt: string;
  size: ImageSize;
  quality: "low" | "medium" | "high";
  signal?: AbortSignal;
}
export interface ImageResult {
  data: Buffer;
  usage: Usage;
}
/** Trusted adapter boundary for still-image generation (ADR 007). */
export interface ImageProvider {
  readonly name: string;
  readonly model: string;
  generate(request: ImageRequest): Promise<ImageResult>;
}

/** Transport/identity injection shared by the image adapters. */
export interface ImageTransport {
  fetch?: typeof globalThis.fetch;
  /** Overrides WTS_IMAGE_MODEL / the provider default for this instance. */
  model?: string;
}
export class OpenAIImageProvider implements ImageProvider {
  readonly name = "image_generation";
  readonly model: string;
  private client: OpenAI;
  constructor(apiKey: string, transport: ImageTransport = {}) {
    this.model =
      transport.model || process.env.WTS_IMAGE_MODEL || "gpt-image-1";
    if (!apiKey.trim())
      throw new StudioError(
        "CONFIGURATION",
        "Image generation needs OpenAI credentials.",
        "Save an API key in Settings (macOS Keychain) or set OPENAI_API_KEY in .env.",
      );
    this.client = new OpenAI({
      apiKey,
      maxRetries: 2,
      timeout: 300000,
      ...(transport.fetch ? { fetch: transport.fetch } : {}),
    });
  }
  async generate(request: ImageRequest): Promise<ImageResult> {
    const started = performance.now();
    const response = await this.client.images.generate(
      {
        model: this.model,
        prompt: request.prompt.slice(0, 3200),
        size: request.size,
        quality: request.quality,
        output_format: "png",
        n: 1,
      },
      { signal: request.signal },
    );
    const base64 = response.data?.[0]?.b64_json;
    if (!base64)
      throw new StudioError(
        "API",
        "The image response contained no image data.",
        "Retry the render; verified outputs are reused.",
        true,
      );
    return {
      data: Buffer.from(base64, "base64"),
      usage: {
        agent: this.name,
        provider: "openai",
        model: this.model,
        inputTokens: 0,
        outputTokens: 0,
        audioSeconds: 0,
        imageCount: 1,
        costUSD: null,
        elapsedMs: performance.now() - started,
        createdAt: now(),
      },
    };
  }
}

/** B-roll source boxes map onto the aspect ratios the Gemini API accepts. */
const GEMINI_ASPECT: Record<ImageSize, string> = {
  "1024x1024": "1:1",
  "1536x1024": "3:2",
  "1024x1536": "2:3",
};
/**
 * Gemini (Nano Banana) stills through the Interactions API. Shares the Gemini
 * credential with music generation; quality maps low/medium → 1K, high → 2K.
 */
export class GeminiImageProvider implements ImageProvider {
  readonly name = "image_generation";
  readonly model: string;
  private transport: ImageTransport;
  constructor(
    private apiKey: string,
    transport: ImageTransport = {},
  ) {
    this.transport = transport;
    this.model =
      transport.model ||
      process.env.WTS_GEMINI_IMAGE_MODEL ||
      "gemini-3.1-flash-image";
    if (!apiKey.trim())
      throw new StudioError(
        "CONFIGURATION",
        "Gemini image generation needs Gemini credentials.",
        "Save a Gemini API key in Settings (macOS Keychain) or set GEMINI_API_KEY in .env.",
      );
  }
  async generate(request: ImageRequest): Promise<ImageResult> {
    const started = performance.now();
    const { blocks } = await geminiInteractions({
      apiKey: this.apiKey,
      model: this.model,
      signal: request.signal,
      transport: this.transport,
      body: {
        input: [{ type: "text", text: request.prompt.slice(0, 3200) }],
        response_format: {
          type: "image",
          aspect_ratio: GEMINI_ASPECT[request.size],
          image_size: request.quality === "high" ? "2K" : "1K",
        },
      },
    });
    const image = geminiBlock(blocks, "image");
    return {
      data: Buffer.from(image.data, "base64"),
      usage: {
        agent: this.name,
        provider: "gemini",
        model: this.model,
        inputTokens: 0,
        outputTokens: 0,
        audioSeconds: 0,
        imageCount: 1,
        costUSD: null,
        elapsedMs: performance.now() - started,
        createdAt: now(),
      },
    };
  }
}

/** Deterministic gradient still seeded by the brief; no network, no credits. */
export class MockImageProvider implements ImageProvider {
  readonly name = "image_generation";
  readonly model = "deterministic-v1";
  async generate(request: ImageRequest): Promise<ImageResult> {
    request.signal?.throwIfAborted();
    const [width, height] = request.size.split("x").map(Number);
    const seed = hash(request.prompt);
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
    const workspace = await mkdtemp(path.join(os.tmpdir(), "wts-image-"));
    const temp = path.join(workspace, "still.png");
    try {
      await ffmpeg([
        "-f",
        "lavfi",
        "-i",
        `gradients=s=${width}x${height}:c0=${hex(0)}:c1=${hex(32)}:x0=0:y0=0:x1=${width}:y1=${height}:d=1`,
        "-frames:v",
        "1",
        temp,
      ]);
      return {
        data: await readFile(temp),
        usage: {
          agent: this.name,
          provider: "mock",
          model: this.model,
          inputTokens: 0,
          outputTokens: 0,
          audioSeconds: 0,
          imageCount: 1,
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

/** Trusted prompt assembly: briefs are data; style wording is checked in. */
const STYLE_WORDING: Record<string, string> = {
  photoreal: "photorealistic, natural light, shallow depth of field",
  "technical-illustration":
    "clean editorial technical illustration, flat shapes, restrained palette",
  "isometric-diagram": "isometric cutaway diagram, no labels",
  cinematic: "cinematic mood, dramatic lighting, film grain",
  "clean-3d": "simple clean 3D render, soft studio lighting",
  "minimal-lineart": "minimal line art, generous negative space",
};
export function buildImagePrompt(asset: {
  parameters: {
    brief: string;
    style: string;
    palette: string | null;
    avoid: string | null;
    expectsText: boolean;
  };
}) {
  const p = asset.parameters;
  return [
    STYLE_WORDING[p.style] ?? p.style,
    p.brief,
    p.palette ? `Color palette: ${p.palette}.` : null,
    p.avoid ? `Avoid: ${p.avoid}.` : null,
    p.expectsText
      ? null
      : "No text, words, letters, numbers, logos or watermarks anywhere in the image.",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Pixel box a B-roll entry renders into; even dimensions for H.264. */
export function brollBox(entry: BRollEntry, plan: ProductionPlan) {
  const even = (n: number) => Math.max(2, 2 * Math.round(n / 2));
  if (entry.placement === "fullframe")
    return { width: plan.resolution.width, height: plan.resolution.height };
  const width = even(plan.resolution.width * entry.inset!.width);
  // Landscape aspect keeps inset content recognizable; compositing scales anyway.
  return {
    width,
    height: even(width * BROLL_INSET_HEIGHT_RATIO),
  };
}

const RENDERER = "gpt-image-1+ffmpeg-zoompan-v1";
/** Semantic render identity: narration and plan version never invalidate pixels. */
export function brollStillKey(
  entry: BRollEntry,
  provider: { name: string; model: string },
) {
  return hash({
    asset: entry.asset,
    size: BROLL_SOURCE_SIZE,
    provider: provider.model,
  });
}
export function brollClipKey(entry: BRollEntry, plan: ProductionPlan) {
  return hash({
    asset: entry.asset,
    durationFrames: entry.durationFrames,
    motion: entry.motion,
    placement: entry.placement,
    inset: entry.inset,
    frameRate: plan.frameRate,
    box: brollBox(entry, plan),
    renderer: RENDERER,
  });
}

/**
 * Turn a generated still into a motion clip: prescale to 2x so zoompan steps
 * stay subpixel-smooth, then animate across the requested duration.
 */
export async function renderMotionClip(options: {
  still: string;
  output: string;
  width: number;
  height: number;
  durationFrames: number;
  frameRate: number;
  motion: BRollEntry["motion"];
  signal?: AbortSignal;
  progress?: (fraction: number) => void;
}) {
  const o = options;
  const { width, height, frameRate } = o;
  const frames = Math.max(1, o.durationFrames);
  const seconds = frames / frameRate;
  const big = { width: width * 2, height: height * 2 };
  const center = `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`;
  const travel = "(iw-iw/zoom)";
  const expressions: Record<BRollEntry["motion"], string> = {
    none: `z=1:${center}`,
    "zoom-in": `z='min(1+0.1*on/${frames},1.1)':${center}`,
    "zoom-out": `z='max(1.1-0.1*on/${frames},1)':${center}`,
    "pan-left": `z=1.1:x='${travel}*(1-on/${frames})':y='ih/2-(ih/zoom/2)'`,
    "pan-right": `z=1.1:x='${travel}*(on/${frames})':y='ih/2-(ih/zoom/2)'`,
  };
  await ffmpeg(
    [
      "-loop",
      "1",
      "-framerate",
      String(frameRate),
      "-protocol_whitelist",
      "file,pipe",
      "-i",
      path.resolve(o.still),
      "-t",
      String(seconds + 0.05),
      "-vf",
      `scale=${big.width}:${big.height}:force_original_aspect_ratio=increase,crop=${big.width}:${big.height},zoompan=${expressions[o.motion]}:d=1:s=${width}x${height}:fps=${frameRate},setsar=1`,
      "-frames:v",
      String(frames),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "21",
      "-pix_fmt",
      "yuv420p",
      path.resolve(o.output),
    ],
    o.signal,
    o.progress,
    seconds,
  );
}
