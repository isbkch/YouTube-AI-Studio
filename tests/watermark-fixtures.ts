import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { ffmpeg } from "../packages/media/src/index.ts";
import { id } from "../packages/shared/src/index.ts";

/** Bright glyphs in the lower-right quarter, independent of render metadata. */
export async function assertWatermarkPixels(
  file: string,
  at: number,
  dir: string,
) {
  const output = path.join(dir, `${id("watermark-pixels")}.gray`);
  try {
    await ffmpeg([
      "-ss",
      String(at),
      "-i",
      file,
      "-frames:v",
      "1",
      "-vf",
      "crop=iw*0.3:ih*0.15:iw*0.7:ih*0.85,format=gray",
      "-f",
      "rawvideo",
      output,
    ]);
    const pixels = await readFile(output);
    const bright = pixels.reduce(
      (count, pixel) => count + Number(pixel > 200),
      0,
    );
    assert.ok(
      bright > pixels.length * 0.005,
      `watermark glyphs must be visible at ${at}s (${bright} bright pixels)`,
    );
  } finally {
    await rm(output, { force: true });
  }
}
