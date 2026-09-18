import { createWriteStream } from "node:fs";
import { chmod, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { StudioError, fileHash, redact } from "../../shared/src/index.ts";
import { executable, runBinary } from "../../media/src/index.ts";

/**
 * Publishing rides a local YouTube CLI (youtubeuploader by default) — no
 * network code of our own, no credentials handled by the runtime. Discovery
 * honors WTS_YOUTUBEUPLOADER_PATH, then PATH, then a managed copy that is
 * downloaded from the official GitHub release on first publish; WTS_YOUTUBE_
 * ARGS appends flags such as `-secrets`/`-cache` for OAuth. Publication only
 * ever runs after the creator approved the exact packaging document
 * (studio.publish).
 */

/** Pinned release; its sha256 is read from the GitHub API at download time. */
const UPLOADER_VERSION = "1.25.5";
const UPLOADER_RELEASE = `https://api.github.com/repos/porjo/youtubeuploader/releases/tags/v${UPLOADER_VERSION}`;
const UPLOADER_PLATFORM: Record<string, string> = {
  darwin: "Darwin",
  linux: "Linux",
};
const UPLOADER_ARCH: Record<string, string> = {
  arm64: "arm64",
  x64: "amd64",
};

/** Managed tool cache — owned by the app and safe to re-download. */
export const youTubeCLIDir = (version = UPLOADER_VERSION) =>
  path.join(
    os.homedir(),
    ...(process.platform === "darwin" ? ["Library", "Caches"] : [".cache"]),
    "com.isbkch.YouTube-AI-Studio",
    "tools",
    "youtubeuploader",
    version,
  );

async function isFile(file: string) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** Resolve the CLI without side effects: PATH/env override first, cache second. */
export async function findYouTubeCLI(): Promise<string | null> {
  try {
    return await executable("youtubeuploader");
  } catch {
    const managed = path.join(youTubeCLIDir(), "youtubeuploader");
    return (await isFile(managed)) ? managed : null;
  }
}

export async function youTubeCLI(): Promise<string> {
  const found = await findYouTubeCLI();
  if (!found)
    throw new StudioError(
      "MISSING_DEPENDENCY",
      "youtubeuploader was not found.",
      "Publish once to install it automatically, or brew install youtubeuploader / set WTS_YOUTUBEUPLOADER_PATH.",
    );
  return found;
}

interface ReleaseAsset {
  name?: string;
  browser_download_url?: string;
  digest?: string;
  size?: number;
}

async function installUploader(
  dir: string,
  target: string,
  fetcher: typeof globalThis.fetch,
  signal?: AbortSignal,
): Promise<string> {
  const platform = UPLOADER_PLATFORM[process.platform];
  const arch = UPLOADER_ARCH[process.arch];
  const manual =
    "brew install youtubeuploader or set WTS_YOUTUBEUPLOADER_PATH to an existing executable.";
  if (!platform || !arch)
    throw new StudioError(
      "MISSING_DEPENDENCY",
      `No youtubeuploader release matches ${process.platform}/${process.arch}.`,
      manual,
    );
  const assetName = `youtubeuploader_${UPLOADER_VERSION}_${platform}_${arch}.tar.gz`;
  const release = await fetcher(UPLOADER_RELEASE, {
    signal,
    headers: { accept: "application/vnd.github+json" },
  });
  if (!release.ok)
    throw new StudioError(
      "EXTERNAL_TOOL",
      `Fetching the youtubeuploader v${UPLOADER_VERSION} release failed (HTTP ${release.status}).`,
      `Check network access to github.com and retry, or ${manual}`,
      true,
    );
  const asset = (
    (await release.json()) as { assets?: ReleaseAsset[] }
  ).assets?.find((a) => a.name === assetName);
  if (!asset?.browser_download_url)
    throw new StudioError(
      "MISSING_DEPENDENCY",
      `The youtubeuploader v${UPLOADER_VERSION} release has no ${assetName} asset.`,
      manual,
    );
  const archive = await fetcher(asset.browser_download_url, { signal });
  if (!archive.ok || !archive.body)
    throw new StudioError(
      "EXTERNAL_TOOL",
      `Downloading youtubeuploader failed (HTTP ${archive.status}).`,
      `Check network access to github.com and retry, or ${manual}`,
      true,
    );
  const declared = Number(archive.headers.get("content-length"));
  await mkdir(dir, { recursive: true });
  const stamp = randomUUID();
  const archivePart = path.join(dir, `archive-${stamp}.tar.gz.part`);
  const archiveFile = path.join(dir, `archive-${stamp}.tar.gz`);
  const staging = path.join(dir, `extract-${stamp}`);
  try {
    await pipeline(
      // undici's DOM-side ReadableStream type differs from node:stream/web's.
      Readable.fromWeb(
        archive.body as unknown as NodeWebReadableStream<Uint8Array>,
      ),
      createWriteStream(archivePart),
      { signal },
    );
    const written = (await stat(archivePart)).size;
    if (declared && written !== declared)
      throw new StudioError(
        "EXTERNAL_TOOL",
        `Incomplete youtubeuploader download (${written} of ${declared} bytes).`,
        "Check network stability, then retry the publish.",
        true,
      );
    const expected = asset.digest?.replace(/^sha256:/, "");
    const sha256 = expected && (await fileHash(archivePart));
    if (expected && sha256 !== expected)
      throw new StudioError(
        "EXTERNAL_TOOL",
        "The youtubeuploader download failed its sha256 checksum.",
        "Retry the publish; the download source may be corrupted.",
        true,
      );
    await rename(archivePart, archiveFile);
    await mkdir(staging);
    await runBinary("/usr/bin/tar", ["-xzf", archiveFile, "-C", staging], {
      signal,
    });
    const entries = await readdir(staging, { withFileTypes: true });
    if (!entries.some((e) => e.isFile() && e.name === "youtubeuploader"))
      throw new StudioError(
        "EXTERNAL_TOOL",
        "The downloaded archive contains no youtubeuploader binary.",
        "Retry the publish; if it persists, install the CLI manually.",
        true,
      );
    await chmod(path.join(staging, "youtubeuploader"), 0o755);
    await rename(path.join(staging, "youtubeuploader"), target);
    return target;
  } catch (e) {
    if (e instanceof StudioError) throw e;
    throw new StudioError(
      "EXTERNAL_TOOL",
      e instanceof Error ? e.message : "Installing youtubeuploader failed.",
      `Check network access to github.com and retry, or ${manual}`,
      true,
    );
  } finally {
    await rm(archivePart, { force: true });
    await rm(archiveFile, { force: true });
    await rm(staging, { recursive: true, force: true });
  }
}

const installs = new Map<string, Promise<string>>();

/** Resolve the CLI, downloading the pinned official release when missing. */
export async function ensureYouTubeCLI(
  options: {
    signal?: AbortSignal;
    transport?: { fetch?: typeof globalThis.fetch };
    /** Tests redirect the managed cache and bypass PATH discovery. */
    installDir?: string;
    discover?: () => Promise<string | null>;
  } = {},
): Promise<string> {
  if (!options.installDir) {
    const found = await (options.discover ?? findYouTubeCLI)();
    if (found) return found;
  }
  const dir = options.installDir ?? youTubeCLIDir();
  const target = path.join(dir, "youtubeuploader");
  if (await isFile(target)) return target;
  let install = installs.get(target);
  if (!install) {
    install = installUploader(
      dir,
      target,
      options.transport?.fetch ?? globalThis.fetch,
      options.signal,
    ).finally(() => installs.delete(target));
    installs.set(target, install);
  }
  return install;
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
  /** Called as soon as the CLI reports a created video, before thumbnail upload. */
  onVideoCreated?: (videoId: string) => void;
}

export async function publishToYouTube(options: YouTubeUpload) {
  if (options.extraArgs?.some((arg) => /^--?thumbnail(?:=|$)/i.test(arg)))
    throw new StudioError(
      "INVALID_INPUT",
      "Extra YouTube arguments cannot override the approved thumbnail.",
      "Remove the thumbnail flag from WTS_YOUTUBE_ARGS; select the image in Packaging.",
    );
  const cli = await ensureYouTubeCLI({ signal: options.signal });
  const args = ["-filename", options.video, "-metaJSON", options.metaFile];
  if (options.thumbnail) args.push("-thumbnail", options.thumbnail);
  if (options.extraArgs?.length) args.push(...options.extraArgs);
  const videoId = (output: string) =>
    /(?:youtu\.be\/|[?&]v=|\/shorts\/|"videoId"\s*:\s*"|Video ID:?\s*)([A-Za-z0-9_-]{11})/i.exec(
      redact(output),
    )?.[1];
  let output = "";
  let created: string | undefined;
  let warning: string | null = null;
  let recordingError: string | null = null;
  try {
    await runBinary(cli, args, {
      signal: options.signal,
      onOutput: (chunk) => {
        output = (output + chunk).slice(-32000);
        const found = videoId(output);
        if (found && !created) {
          created = found;
          // Stream callbacks must never throw outside runBinary's promise.
          // Preserve the ID so the caller can still persist the final result.
          try {
            options.onVideoCreated?.(found);
          } catch (error) {
            recordingError = redact(
              error instanceof Error ? error.message : String(error),
            ).slice(-500);
          }
        }
      },
    });
  } catch (error) {
    if (!created) throw error;
    warning = `Video was created, but upload finishing was not confirmed. Check the thumbnail in YouTube Studio. ${redact(error instanceof Error ? error.message : String(error)).slice(-500)}`;
  }
  if (!created)
    throw new StudioError(
      "EXTERNAL_TOOL",
      `${cli} finished without reporting a video ID: ${redact(output).slice(-500)}`,
      "The upload may still exist — check the channel in YouTube Studio before retrying.",
      true,
    );
  if (recordingError)
    warning = `Video ${created} was created, but recording its ID during upload failed: ${recordingError}. Check YouTube Studio before any further upload.${warning ? ` ${warning}` : ""}`;
  return {
    cli,
    videoId: created,
    url: `https://www.youtube.com/watch?v=${created}`,
    warning,
    output: redact(output).slice(-2000),
  };
}
