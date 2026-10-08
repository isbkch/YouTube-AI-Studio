import path from "node:path";
import { fileURLToPath } from "node:url";
import { fileHash, StudioError } from "../../shared/src/index.ts";
import { ffmpeg, inspect } from "./index.ts";

export const FREE_WATERMARK_TEXT = "Created by YT AI Studio";
const overlay = fileURLToPath(
  new URL("../assets/free-watermark.png", import.meta.url),
);

/** Edition policy lives outside the editable production plan and provider output. */
export async function freeWatermarkIdentity() {
  return {
    renderer: "free-watermark-v1",
    overlayHash: await fileHash(overlay),
    widthRatio: 0.25,
    marginRatio: 0.025,
  };
}

/** Checked-in PNG needs neither system fonts nor FFmpeg's optional drawtext filter. */
export async function applyFreeWatermark(options: {
  video: string;
  output: string;
  signal?: AbortSignal;
  progress?: (fraction: number) => void;
}) {
  if (path.resolve(options.video) === path.resolve(options.output))
    throw new StudioError("INVALID_INPUT", "Cannot overwrite the input cut.");
  const identity = await freeWatermarkIdentity();
  const meta = await inspect(options.video);
  const width = Math.max(1, Math.round(meta.width * identity.widthRatio));
  const marginX = Math.round(meta.width * identity.marginRatio);
  const marginY = Math.round(meta.height * identity.marginRatio);
  await ffmpeg(
    [
      "-i",
      path.resolve(options.video),
      "-i",
      overlay,
      "-filter_complex",
      `[1:v]scale=${width}:-1[mark];[0:v][mark]overlay=x=W-w-${marginX}:y=H-h-${marginY}:eof_action=repeat:format=auto[v]`,
      "-map",
      "[v]",
      "-map",
      "0:a?",
      "-c:v",
      "libx264",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "copy",
      "-movflags",
      "+faststart",
      path.resolve(options.output),
    ],
    options.signal,
    options.progress,
    meta.duration,
  );
}
