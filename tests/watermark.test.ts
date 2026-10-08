import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ffmpeg,
  inspect,
  runTool,
  verifyOutput,
} from "../packages/media/src/index.ts";
import { applyFreeWatermark } from "../packages/media/src/watermark.ts";
import { fileHash } from "../packages/shared/src/index.ts";
import { assertWatermarkPixels } from "./watermark-fixtures.ts";

test("the free watermark persists across the cut without changing audio, frames or the source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wts-watermark-"));
  try {
    const source = path.join(root, "source with spaces.mp4");
    const output = path.join(root, "watermarked.mp4");
    await ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "color=c=navy:s=1920x1080:r=30:d=1",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1",
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
    const original = await fileHash(source);
    await applyFreeWatermark({ video: source, output });
    const meta = await verifyOutput(output, 1, undefined, 30);
    assert.equal(meta.width, 1920);
    assert.equal(meta.height, 1080);
    assert.equal(meta.frameRate, 30);
    assert.equal(meta.hasAudio, true);
    for (const at of [0, 0.5, 0.95])
      await assertWatermarkPixels(output, at, root);
    const audioHash = async (file: string) =>
      (
        await runTool("ffmpeg", [
          "-v",
          "error",
          "-i",
          file,
          "-map",
          "0:a:0",
          "-c",
          "copy",
          "-f",
          "hash",
          "-hash",
          "sha256",
          "-",
        ])
      ).stdout;
    assert.equal(
      await audioHash(output),
      await audioHash(source),
      "audio packets are copied exactly",
    );
    assert.equal(await fileHash(source), original);
    await assert.rejects(
      applyFreeWatermark({ video: source, output: source }),
      /overwrite/,
    );
    assert.equal((await inspect(source)).frames, 30);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
