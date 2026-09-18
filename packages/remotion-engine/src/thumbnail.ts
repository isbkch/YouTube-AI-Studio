import { bundle } from "@remotion/bundler";
import { VERSION } from "remotion";
import {
  makeCancelSignal,
  renderStill,
  selectComposition,
} from "@remotion/renderer";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  fileHash,
  hash,
  StudioError,
  type CreatorProfile,
} from "../../shared/src/index.ts";

// A separate entry preserves every existing video-graphics cache identity.
const entry = fileURLToPath(
  new URL("../../../templates/remotion/thumbnail.tsx", import.meta.url),
);
let bundled: Promise<string> | undefined;
export async function thumbnailRendererIdentity() {
  return hash({
    template: await fileHash(entry),
    renderer: await fileHash(fileURLToPath(import.meta.url)),
    remotion: VERSION,
  });
}
export interface ThumbnailRenderInput {
  background: string;
  headline: string;
  brand: CreatorProfile["brand"];
  output: string;
  signal?: AbortSignal;
}
export type ThumbnailRenderer = ((
  input: ThumbnailRenderInput,
) => Promise<void>) & {
  /** Omit to disable composition cache reuse for an injected renderer. */
  identity?: () => Promise<string>;
};
export const renderThumbnail: ThumbnailRenderer = async (input) => {
  input.signal?.throwIfAborted();
  const bytes = await readFile(input.background, { signal: input.signal });
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes
    .subarray(0, 8)
    .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (!jpeg && !png)
    throw new StudioError(
      "INVALID_INPUT",
      "Thumbnail background must be a JPEG or PNG image.",
    );
  const mime = jpeg ? "image/jpeg" : "image/png";
  const serveUrl = await (bundled ??= bundle({
    entryPoint: entry,
    onProgress: () => {},
  }).catch((error) => {
    bundled = undefined;
    throw error;
  }));
  const inputProps = {
    background: `data:${mime};base64,${bytes.toString("base64")}`,
    headline: input.headline,
    brand: input.brand,
  };
  const { cancelSignal, cancel } = makeCancelSignal();
  const abort = () => cancel();
  input.signal?.addEventListener("abort", abort, { once: true });
  try {
    input.signal?.throwIfAborted();
    const composition = await selectComposition({
      serveUrl,
      id: "YTAIStudioThumbnail",
      inputProps,
    });
    // Remotion 4.0.526 launches Chromium with --force-color-profile=srgb.
    await renderStill({
      serveUrl,
      composition,
      inputProps,
      output: input.output,
      imageFormat: "jpeg",
      jpegQuality: 90,
      frame: 0,
      cancelSignal,
      logLevel: "error",
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("THUMBNAIL_HEADLINE_OVERFLOW")
    )
      throw new StudioError(
        "INVALID_INPUT",
        "The headline does not fit in two readable lines.",
        "Shorten the headline and apply it again. Your generated background is saved.",
      );
    throw error;
  } finally {
    input.signal?.removeEventListener("abort", abort);
  }
};
renderThumbnail.identity = thumbnailRendererIdentity;
