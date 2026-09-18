import { bundle } from "@remotion/bundler";
import {
  renderMedia,
  renderStill,
  selectComposition,
  makeCancelSignal,
} from "@remotion/renderer";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileHash, StudioError } from "../../shared/src/index.ts";
import type { CreatorProfile } from "../../shared/src/index.ts";
import type { ProductionPlan, Scene } from "../../production-plan/src/index.ts";
export const entry = fileURLToPath(
  new URL("../../../templates/remotion/index.tsx", import.meta.url),
);
let bundlePromise: Promise<string> | undefined;
export const templateHash = () => fileHash(entry);
export function getBundle() {
  return (bundlePromise ??= bundle({
    entryPoint: entry,
    onProgress: () => {},
  }).catch((e) => {
    bundlePromise = undefined;
    throw e;
  }));
}
export async function renderGraphic(
  scene: Scene,
  plan: ProductionPlan,
  brand: CreatorProfile["brand"],
  output: string,
  signal?: AbortSignal,
  onProgress?: (fraction: number) => void,
) {
  const graphic = scene.visual.graphic;
  if (!graphic)
    throw new StudioError("INVALID_PLAN", "Graphic instruction is missing.");
  signal?.throwIfAborted();
  const serveUrl = await getBundle();
  const inputProps = {
    ...graphic,
    brand,
    durationFrames: scene.durationFrames,
    width: plan.resolution.width,
    height: plan.resolution.height,
    fps: plan.frameRate,
  };
  const composition = await selectComposition({
    serveUrl,
    id: "YTAIStudioVisual",
    inputProps,
  });
  const { cancelSignal, cancel } = makeCancelSignal();
  const abort = () => cancel();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    await renderMedia({
      serveUrl,
      composition,
      inputProps,
      outputLocation: output,
      codec: "h264",
      crf: 21,
      concurrency: 2,
      overwrite: true,
      cancelSignal,
      onProgress: (p) => onProgress?.(p.progress),
      logLevel: "error",
    });
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
export async function renderPlaceholder(
  output: string,
  brand: CreatorProfile["brand"],
) {
  await mkdir(path.dirname(output), { recursive: true });
  const serveUrl = await getBundle();
  const inputProps = {
    template: "Placeholder",
    brand,
    parameters: { title: "", subtitle: "" },
    durationFrames: 60,
    width: 1280,
    height: 720,
    fps: 30,
  };
  const composition = await selectComposition({
    serveUrl,
    id: "YTAIStudioVisual",
    inputProps,
  });
  await renderStill({
    serveUrl,
    composition,
    inputProps,
    output,
    frame: 30,
    imageFormat: "png",
    logLevel: "error",
  });
}

/** A single computed punch-line caption event, in renderer shape. */
export interface CaptionRenderEvent {
  id: string;
  startFrame: number;
  endFrame: number;
  text: string;
  words: { atFrame: number; text: string }[];
}
/**
 * Render one caption event as a transparent WebM (VP8 + alpha) the build's
 * captions task overlays at the event's frame range. Clip-local time: local
 * frame 0 is the event's startFrame, and word timings shift with it.
 */
export async function renderCaption(
  event: CaptionRenderEvent,
  style: "pop" | "karaoke",
  plan: Pick<ProductionPlan, "resolution" | "frameRate">,
  brand: CreatorProfile["brand"],
  output: string,
  signal?: AbortSignal,
  onProgress?: (fraction: number) => void,
) {
  await mkdir(path.dirname(output), { recursive: true });
  signal?.throwIfAborted();
  const serveUrl = await getBundle();
  const inputProps = {
    style,
    text: event.text,
    words: event.words.map((w) => ({
      atFrame: Math.max(0, w.atFrame - event.startFrame),
      text: w.text,
    })),
    brand,
    durationFrames: Math.max(2, event.endFrame - event.startFrame),
    width: plan.resolution.width,
    height: plan.resolution.height,
    fps: plan.frameRate,
  };
  const composition = await selectComposition({
    serveUrl,
    id: "YTAIStudioCaption",
    inputProps,
  });
  const { cancelSignal, cancel } = makeCancelSignal();
  const abort = () => cancel();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    await renderMedia({
      serveUrl,
      composition,
      inputProps,
      outputLocation: output,
      // VP8 + PNG frames is Remotion's transparent-video path; the overlay
      // pass composites the alpha channel over the assembled cut.
      codec: "vp8",
      imageFormat: "png",
      concurrency: 2,
      overwrite: true,
      cancelSignal,
      onProgress: (p) => onProgress?.(p.progress),
      logLevel: "error",
    });
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
