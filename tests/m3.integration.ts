import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  ffmpeg,
  inspect,
  mixAudio,
  verifyOutput,
} from "../packages/media/src/index.ts";
import {
  MockImageProvider,
  buildImagePrompt,
  renderMotionClip,
  brollBox,
} from "../packages/image-engine/src/index.ts";
import { renderSegment } from "../packages/orchestrator/src/timeline.ts";
import { fixture } from "./fixtures.ts";
import type {
  BRollAsset,
  BRollEntry,
} from "../packages/production-plan/src/index.ts";

const still = (brief: string) =>
  ({
    engine: "gpt-image",
    template: "GeneratedStill",
    templateVersion: "1.0.0",
    parameters: {
      brief,
      style: "photoreal",
      palette: null,
      avoid: null,
      quality: "low",
      expectsText: false,
    },
  }) as const;
const entry = (over: Partial<BRollEntry> = {}): BRollEntry =>
  ({
    id: "broll-1",
    startFrame: 12,
    durationFrames: 60,
    placement: "inset",
    inset: { x: 0.55, y: 0.5, width: 0.38 },
    motion: "zoom-in",
    asset: still("A quiet datacenter corridor at blue hour"),
    narrationHook: "the machines hum in the dark",
    ...over,
  }) as BRollEntry;

test("generated stills become motion clips, composite insets and mix under narration", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wts-m3-"));
  try {
    const plan = fixture();
    const provider = new MockImageProvider();
    const e = entry();
    // 1. Still generation through the trusted adapter.
    const generated = await provider.generate({
      prompt: buildImagePrompt(
        e.asset as Extract<BRollAsset, { engine: "gpt-image" }>,
      ),
      size: "1536x1024",
      quality: "low",
    });
    assert.ok(generated.data.byteLength > 1000);
    assert.equal(generated.usage.imageCount, 1);
    const stillPath = path.join(dir, "still.png");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(stillPath, generated.data);
    // 2. Motion clip at the inset box, exact frame count.
    const box = brollBox(e, plan);
    assert.equal(box.width % 2, 0);
    const clip = path.join(dir, "broll.mp4");
    await renderMotionClip({
      still: stillPath,
      output: clip,
      width: box.width,
      height: box.height,
      durationFrames: e.durationFrames,
      frameRate: plan.frameRate,
      motion: "zoom-in",
    });
    await verifyOutput(clip, e.durationFrames / plan.frameRate);
    // 3. Presenter segment with the inset composited over it.
    const presenter = path.join(dir, "presenter.mp4");
    await ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "color=c=navy:s=1280x720:r=30:d=4",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=4",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      presenter,
    ]);
    const segment = path.join(dir, "segment.mp4");
    const fade = Math.min(0.35, e.durationFrames / plan.frameRate / 4);
    await renderSegment({
      source: presenter,
      graphic: null,
      sourceStart: 0,
      duration: 4,
      punchIn: 1,
      gainDb: 0,
      hasAudio: true,
      output: segment,
      overlays: [
        {
          clip,
          x: Math.round(e.inset!.x * 1920),
          y: Math.round(e.inset!.y * 1080),
          width: box.width,
          height: box.height,
          startSec: e.startFrame / plan.frameRate,
          endSec: (e.startFrame + e.durationFrames) / plan.frameRate,
          fadeInSec: fade,
          fadeOutSec: fade,
        },
      ],
    });
    await verifyOutput(segment, 4);
    // 4. Music bed mixed under the narration with sidechain ducking.
    const bed = path.join(dir, "bed.mp3");
    await ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=150:duration=8",
      "-af",
      "volume=0.4,aformat=sample_rates=48000:channel_layouts=stereo",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "128k",
      bed,
    ]);
    const mixed = path.join(dir, "mixed.mp4");
    await mixAudio({
      video: segment,
      output: mixed,
      duration: 4,
      music: {
        file: bed,
        gainDb: -20,
        duckToDb: -32,
        fadeInSec: 0.5,
        fadeOutSec: 1,
        loopable: true,
      },
      sfx: [{ file: bed, atSec: 1.5, gainDb: -12 }],
    });
    const meta = await verifyOutput(mixed, 4);
    assert.ok(meta.hasAudio);
    assert.equal((await inspect(mixed)).codec, "h264");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
