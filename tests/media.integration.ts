import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  ffmpeg,
  inspect,
  proxy,
  extractAudio,
  verifyOutput,
} from "../packages/media/src/index.ts";
import { fileHash, defaultCreator } from "../packages/shared/src/index.ts";
import { renderGraphic } from "../packages/remotion-engine/src/index.ts";
import { fixture } from "./fixtures.ts";

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
    assert.equal((await verifyOutput(output, 3)).width, 1280);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
