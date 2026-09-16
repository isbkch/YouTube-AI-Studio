import { redact, StudioError } from "../../shared/src/index.ts";
import { executable, runBinary } from "../../media/src/index.ts";

/**
 * Publishing rides a local YouTube CLI (youtubeuploader by default) — no
 * network code of our own, no credentials handled by the runtime. Discovery
 * honors WTS_YOUTUBEUPLOADER_PATH; WTS_YOUTUBE_ARGS appends flags such as
 * `-secrets`/`-cache` for OAuth. Publication only ever runs after the
 * creator approved the exact packaging document (studio.publish).
 */

export async function youTubeCLI(): Promise<string> {
  return executable("youtubeuploader");
}

export interface YouTubeUpload {
  /** Absolute path to the rendered video file. */
  video: string;
  /** Absolute path to a JSON file the CLI reads metadata from. */
  metaFile: string;
  /** Optional absolute path to a thumbnail image. */
  thumbnail?: string;
  /** Extra CLI flags (e.g. OAuth secrets/cache) — appended verbatim. */
  extraArgs?: string[];
  signal?: AbortSignal;
}

export async function publishToYouTube(options: YouTubeUpload) {
  const cli = await youTubeCLI();
  const args = ["-filename", options.video, "-metaJSON", options.metaFile];
  if (options.thumbnail) args.push("-thumbnail", options.thumbnail);
  if (options.extraArgs?.length) args.push(...options.extraArgs);
  const { stdout, stderr } = await runBinary(cli, args, {
    signal: options.signal,
  });
  const output = `${stdout}\n${stderr}`;
  const id =
    /(?:youtu\.be\/|[?&]v=|\/shorts\/|"videoId"\s*:\s*"|Video ID:?\s*)([A-Za-z0-9_-]{11})/i.exec(
      redact(output),
    );
  if (!id)
    throw new StudioError(
      "EXTERNAL_TOOL",
      `${cli} finished without reporting a video ID: ${redact(output).slice(-500)}`,
      "The upload may still exist — check the channel in YouTube Studio before retrying.",
      true,
    );
  return {
    cli,
    videoId: id[1],
    url: `https://www.youtube.com/watch?v=${id[1]}`,
    output: redact(output).slice(-2000),
  };
}
