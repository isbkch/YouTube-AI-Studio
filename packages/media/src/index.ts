import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, copyFile, mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  fileHash,
  id,
  now,
  StudioError,
  redact,
  safePath,
} from "../../shared/src/index.ts";
import type { MediaInfo, Recording } from "../../orchestrator/src/model.ts";

export type Tool =
  | "ffmpeg"
  | "ffprobe"
  | "whisper-cli"
  | "blender"
  | "say"
  | "python3"
  | "node"
  | "bun"
  | "youtubeuploader";

/** The single preview capability every build must conform to. */
export const PREVIEW = {
  width: 1920,
  height: 1080,
  frameRate: 30,
} as const;
export async function executable(name: Tool): Promise<string> {
  const override = process.env[`WTS_${name.toUpperCase()}_PATH`];
  const candidates = override
    ? [override]
    : [
        ...(process.env.PATH || "").split(path.delimiter),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
      ]
        .filter(Boolean)
        .map((p) => path.join(p, name));
  if (name === "blender")
    candidates.push("/Applications/Blender.app/Contents/MacOS/Blender");
  for (const p of candidates) {
    try {
      if (!path.isAbsolute(p)) continue;
      await access(p, constants.X_OK);
      if ((await stat(p)).isFile()) return p;
    } catch {
      /* Try next installed location. */
    }
  }
  throw new StudioError(
    "MISSING_DEPENDENCY",
    `${name} was not found.`,
    `Install ${name}, or set WTS_${name.toUpperCase()}_PATH to its executable path in the launch environment.`,
  );
}
export async function runBinary(
  binary: string,
  args: string[],
  options: {
    signal?: AbortSignal;
    onOutput?: (line: string) => void;
    timeoutMs?: number;
  } = {},
) {
  if (
    !path.isAbsolute(binary) ||
    args.some((a) => typeof a !== "string" || a.includes("\0"))
  )
    throw new StudioError("INVALID_INPUT", "Invalid subprocess invocation.");
  options.signal?.throwIfAborted();
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(binary, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const stop = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
      killTimer.unref();
    };
    const timer = setTimeout(
      () => {
        timedOut = true;
        stop();
      },
      options.timeoutMs ?? 30 * 60 * 1000,
    );
    timer.unref();
    const consume = (kind: "stdout" | "stderr", data: Buffer) => {
      const text = data.toString();
      if (kind === "stdout") stdout = (stdout + text).slice(-2_000_000);
      else stderr = (stderr + text).slice(-32000);
      options.onOutput?.(redact(text));
    };
    child.stdout.on("data", (d: Buffer) => consume("stdout", d));
    child.stderr.on("data", (d: Buffer) => consume("stderr", d));
    options.signal?.addEventListener("abort", stop, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", stop);
    };
    child.on("error", (e) => {
      cleanup();
      reject(
        new StudioError(
          "EXTERNAL_TOOL",
          e.message,
          `Check ${path.basename(binary)} and retry.`,
          true,
        ),
      );
    });
    child.on("close", (code) => {
      cleanup();
      if (options.signal?.aborted)
        reject(
          new StudioError(
            "CANCELLED",
            "Operation cancelled.",
            "Retry to reuse completed outputs.",
            true,
          ),
        );
      else if (code !== 0)
        reject(
          new StudioError(
            "EXTERNAL_TOOL",
            `${path.basename(binary)} ${timedOut ? "timed out" : `exited with ${code}`}: ${redact(stderr.slice(-4000))}`,
            "Check the source media and job log, then retry.",
            true,
          ),
        );
      else resolve({ stdout, stderr });
    });
  });
}
export async function runTool(
  tool: Tool,
  args: string[],
  options: Parameters<typeof runBinary>[2] = {},
) {
  return runBinary(await executable(tool), args, options);
}
export async function inspect(file: string): Promise<MediaInfo> {
  const resolved = await realpath(file);
  const info = await stat(resolved);
  if (!info.isFile())
    throw new StudioError("INVALID_INPUT", "Media must be a regular file.");
  const { stdout } = await runTool(
    "ffprobe",
    [
      "-v",
      "error",
      "-protocol_whitelist",
      "file,pipe",
      "-show_format",
      "-show_streams",
      "-of",
      "json",
      resolved,
    ],
    { timeoutMs: 60000 },
  );
  const parsed = JSON.parse(stdout) as {
    format: { duration: string; size: string };
    streams: {
      codec_type: string;
      codec_name: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      duration?: string;
    }[];
  };
  const video = parsed.streams.find((s) => s.codec_type === "video"),
    audio = parsed.streams.find((s) => s.codec_type === "audio");
  const [n, d] = (video?.avg_frame_rate || "0/1").split("/").map(Number);
  const duration = Number(parsed.format.duration || video?.duration);
  if (!Number.isFinite(duration) || duration <= 0)
    throw new StudioError(
      "INVALID_INPUT",
      "Media has no readable finite duration.",
    );
  return {
    duration,
    width: video?.width || 0,
    height: video?.height || 0,
    codec: video?.codec_name || "audio",
    frameRate: d ? n / d : 0,
    hasAudio: !!audio,
    audioCodec: audio?.codec_name || null,
    bytes: Number(parsed.format.size) || info.size,
  };
}
export async function importRecording(
  projectDir: string,
  file: string,
  signal?: AbortSignal,
): Promise<Recording> {
  const source = await realpath(file);
  const ext = path.extname(source).toLowerCase();
  if (![".mov", ".mp4", ".m4v", ".mkv", ".webm", ".avi", ".mxf"].includes(ext))
    throw new StudioError(
      "INVALID_INPUT",
      "Choose a supported video file: MOV, MP4, M4V, MKV, WebM, AVI or MXF.",
    );
  const metadata = await inspect(source);
  if (!metadata.width)
    throw new StudioError("INVALID_INPUT", "The file has no video stream.");
  signal?.throwIfAborted();
  const recordingId = id("recording");
  const relative = `recordings/${recordingId}${ext}`;
  const dest = await safePath(projectDir, relative);
  await copyFile(source, dest, constants.COPYFILE_EXCL);
  signal?.throwIfAborted();
  return {
    ...metadata,
    id: recordingId,
    name: path.basename(source),
    path: relative,
    hash: await fileHash(dest),
    importedAt: now(),
    proxyPath: null,
    proxyStatus: "PENDING",
  };
}
export async function ffmpeg(
  args: string[],
  signal?: AbortSignal,
  onProgress?: (fraction: number) => void,
  duration?: number,
) {
  return runTool(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      "-progress",
      "pipe:1",
      ...args,
    ],
    {
      signal,
      onOutput: (text) => {
        for (const match of text.matchAll(/out_time_us=(\d+)/g))
          if (duration)
            onProgress?.(Math.min(0.99, Number(match[1]) / 1e6 / duration));
      },
    },
  );
}
export async function proxy(
  input: string,
  output: string,
  signal?: AbortSignal,
  onProgress?: (n: number) => void,
  target: { width: number; height: number; frameRate: number } = PREVIEW,
) {
  if (path.resolve(input) === path.resolve(output))
    throw new StudioError(
      "INVALID_INPUT",
      "Derived output cannot overwrite a source recording.",
    );
  await mkdir(path.dirname(output), { recursive: true });
  const meta = await inspect(input);
  const { width, height, frameRate } = target;
  await ffmpeg(
    [
      "-protocol_whitelist",
      "file,pipe",
      "-i",
      path.resolve(input),
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-vf",
      `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${frameRate}`,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "24",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-movflags",
      "+faststart",
      path.resolve(output),
    ],
    signal,
    onProgress,
    meta.duration,
  );
  return inspect(output);
}
export async function extractAudio(
  input: string,
  output: string,
  signal?: AbortSignal,
  format: "mp3" | "wav" = "mp3",
) {
  if (path.resolve(input) === path.resolve(output))
    throw new StudioError("INVALID_INPUT", "Cannot overwrite original media.");
  const meta = await inspect(input);
  if (!meta.hasAudio)
    throw new StudioError(
      "INVALID_INPUT",
      "Recording has no audio track.",
      "Import a timestamped transcript, or choose an A-roll recording containing audio.",
    );
  await ffmpeg(
    [
      "-protocol_whitelist",
      "file,pipe",
      "-i",
      path.resolve(input),
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      format === "wav" ? "pcm_s16le" : "libmp3lame",
      ...(format === "mp3" ? ["-b:a", "64k"] : []),
      path.resolve(output),
    ],
    signal,
  );
}
export async function verifyOutput(
  file: string,
  expectedDuration: number,
  signal?: AbortSignal,
) {
  const meta = await inspect(file);
  if (Math.abs(meta.duration - expectedDuration) > 0.12)
    throw new StudioError(
      "EXTERNAL_TOOL",
      `Output duration ${meta.duration.toFixed(3)}s differs from expected ${expectedDuration.toFixed(3)}s.`,
      "Retry the affected render.",
      true,
    );
  await runTool(
    "ffmpeg",
    [
      "-hide_banner",
      "-v",
      "error",
      "-xerror",
      "-nostdin",
      "-protocol_whitelist",
      "file,pipe",
      "-i",
      path.resolve(file),
      "-f",
      "null",
      "-",
    ],
    { signal },
  );
  return meta;
}
export async function thumbnail(input: string, output: string, seconds = 0) {
  if (!Number.isFinite(seconds) || seconds < 0)
    throw new StudioError("INVALID_INPUT", "Invalid thumbnail time.");
  await ffmpeg([
    "-ss",
    String(seconds),
    "-protocol_whitelist",
    "file,pipe",
    "-i",
    path.resolve(input),
    "-frames:v",
    "1",
    "-vf",
    "scale=640:-2",
    path.resolve(output),
  ]);
}

/** Black/freeze frame detection over the assembled cut; evidence, not verdicts. */
export async function detectAnomalies(file: string, signal?: AbortSignal) {
  const { stderr } = await runTool(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostdin",
      "-i",
      path.resolve(file),
      "-vf",
      "blackdetect=d=0.4:pix_th=0.08,freezedetect=n=-60dB:d=0.5",
      "-an",
      "-f",
      "null",
      "-",
    ],
    { signal },
  );
  return {
    black: [
      ...stderr.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)/g),
    ].map((m) => ({ start: Number(m[1]), end: Number(m[2]) })),
    frozen: [...stderr.matchAll(/freeze_start:([\d.]+)/g)].map((m) => ({
      start: Number(m[1]),
    })),
    note: "Filters report technical evidence; review decides whether it is intentional.",
  };
}

/** Sample downscaled JPEG frames at the given seconds for vision review. */
export async function sampleFrames(
  file: string,
  times: number[],
  outputDir: string,
  prefix = "frame",
  signal?: AbortSignal,
) {
  await mkdir(outputDir, { recursive: true });
  const frames: string[] = [];
  let index = 0;
  for (const seconds of times) {
    signal?.throwIfAborted();
    if (!Number.isFinite(seconds) || seconds < 0) continue;
    const output = path.join(
      outputDir,
      `${prefix}-${String(++index).padStart(4, "0")}.jpg`,
    );
    await ffmpeg([
      "-ss",
      String(seconds),
      "-protocol_whitelist",
      "file,pipe",
      "-i",
      path.resolve(file),
      "-frames:v",
      "1",
      "-vf",
      "scale=768:-2",
      "-q:v",
      "7",
      output,
    ]);
    frames.push(output);
  }
  return frames;
}

/** Technical audio diagnostics; silence can be intentional and is a review warning. */
export async function analyzeAudio(file: string, signal?: AbortSignal) {
  const { stderr } = await runTool(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostdin",
      "-i",
      path.resolve(file),
      "-vn",
      "-af",
      "silencedetect=noise=-45dB:d=2,volumedetect",
      "-f",
      "null",
      "-",
    ],
    { signal },
  );
  const number = (pattern: RegExp) => {
    const match = stderr.match(pattern);
    return match ? Number(match[1]) : null;
  };
  return {
    silenceThresholdDb: -45,
    minimumSilenceSeconds: 2,
    silenceStarts: [...stderr.matchAll(/silence_start: ([\d.]+)/g)].map((m) =>
      Number(m[1]),
    ),
    meanVolumeDb: number(/mean_volume: (-?[\d.]+) dB/),
    maxVolumeDb: number(/max_volume: (-?[\d.]+) dB/),
    note: "Silence and peaks are technical observations, not automatic editorial decisions.",
  };
}

export interface MusicMix {
  file: string;
  gainDb: number;
  duckToDb: number;
  fadeInSec: number;
  fadeOutSec: number;
  loopable: boolean;
}
export interface SfxMix {
  file: string;
  atSec: number;
  gainDb: number;
}
/**
 * Mix the music bed and SFX under the narration already present in the video.
 * Ducking uses sidechain compression keyed on narration; the duckToDb target
 * maps to a compression ratio (an approximation, measured afterwards by QA).
 */
export async function mixAudio(options: {
  video: string;
  output: string;
  duration: number;
  music: MusicMix | null;
  sfx: SfxMix[];
  signal?: AbortSignal;
  progress?: (fraction: number) => void;
}) {
  const o = options;
  if (path.resolve(o.video) === path.resolve(o.output))
    throw new StudioError("INVALID_INPUT", "Cannot overwrite the concat cut.");
  const inputs: string[] = ["-i", path.resolve(o.video)];
  let inputCount = 1;
  const chains: string[] = [];
  const mixLabels: string[] = [];
  if (o.music) {
    if (o.music.loopable) inputs.push("-stream_loop", "-1");
    inputs.push("-i", path.resolve(o.music.file));
    const musicIn = inputCount++;
    const fadeOutStart = Math.max(0, o.duration - o.music.fadeOutSec);
    const ratio = Math.min(
      20,
      Math.max(2, Math.round((-6 - o.music.duckToDb) / 1.5)),
    );
    chains.push(
      `[${musicIn}:a]aformat=sample_rates=48000:channel_layouts=stereo,atrim=0:${o.duration.toFixed(3)},asetpts=N/SR/TB,apad,volume=${o.music.gainDb}dB,afade=t=in:st=0:d=${o.music.fadeInSec},afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${o.music.fadeOutSec}[m0]`,
      `[0:a]asplit=2[duckkey][narration]`,
      `[m0][duckkey]sidechaincompress=threshold=0.02:ratio=${ratio}:attack=10:release=350[music]`,
    );
    mixLabels.push("[narration]", "[music]");
  } else {
    chains.push(`[0:a]anull[narration]`);
    mixLabels.push("[narration]");
  }
  o.sfx.forEach((s, i) => {
    inputs.push("-i", path.resolve(s.file));
    const index = inputCount++;
    const ms = Math.round(s.atSec * 1000);
    chains.push(
      `[${index}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${s.gainDb}dB,adelay=${ms}|${ms}[sfx${i}]`,
    );
    mixLabels.push(`[sfx${i}]`);
  });
  chains.push(
    `${mixLabels.join("")}amix=inputs=${mixLabels.length}:duration=longest:normalize=0,alimiter=limit=0.95[aout]`,
  );
  await ffmpeg(
    [
      ...inputs,
      "-filter_complex",
      chains.join(";"),
      "-map",
      "0:v",
      "-map",
      "[aout]",
      "-t",
      String(o.duration),
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-movflags",
      "+faststart",
      path.resolve(o.output),
    ],
    o.signal,
    o.progress,
    o.duration,
  );
}
