import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { executable, ffmpeg, runBinary } from "../../media/src/index.ts";
import {
  StudioError,
  fileHash,
  now,
  type Usage,
} from "../../shared/src/index.ts";
import type { Recording, Transcript } from "../../orchestrator/src/model.ts";
import {
  validateTranscript,
  type ProviderResult,
  type Transcriber,
} from "./index.ts";
import { tokenize } from "../../orchestrator/src/alignment.ts";

/**
 * Local transcription with whisper.cpp: no network, no API credits. Audio is
 * prepared as 16 kHz mono WAV; segments come back with millisecond offsets.
 */
export const defaultWhisperModel = () =>
  process.env.WTS_WHISPER_MODEL ||
  path.join(os.homedir(), ".whisper-models", "ggml-small.bin");

/** Official ggml model host; every canonical `ggml-*.bin` name resolves here. */
const MODEL_REPO = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
const MODEL_PATHS_API =
  "https://huggingface.co/api/models/ggerganov/whisper.cpp/paths-info/main";
const downloadableModel = (name: string) =>
  /^ggml-[a-z0-9][a-z0-9._-]*\.bin$/.test(name);

async function existingFile(file: string) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

interface ModelExpectations {
  sha256?: string;
  bytes?: number;
}

/** LFS metadata (sha256 + exact size) from the hub; optional defense in depth. */
async function modelExpectations(
  name: string,
  fetcher: typeof globalThis.fetch,
  signal?: AbortSignal,
): Promise<ModelExpectations | null> {
  try {
    const response = await fetcher(MODEL_PATHS_API, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paths: [name] }),
      signal,
    });
    if (!response.ok) return null;
    const [entry] = (await response.json()) as {
      size?: number;
      lfs?: { oid?: string; size?: number };
    }[];
    return entry
      ? { sha256: entry.lfs?.oid, bytes: entry.lfs?.size ?? entry.size }
      : null;
  } catch {
    return null; /* Content-Length still guards against truncation. */
  }
}

async function downloadModel(
  modelPath: string,
  name: string,
  fetcher: typeof globalThis.fetch,
  signal?: AbortSignal,
): Promise<void> {
  const expected = await modelExpectations(name, fetcher, signal);
  const response = await fetcher(`${MODEL_REPO}/${encodeURI(name)}`, {
    signal,
  });
  if (response.status === 404)
    throw new StudioError(
      "MISSING_DEPENDENCY",
      `No whisper.cpp model named ${name} is published.`,
      "Check the model name, or set WTS_WHISPER_MODEL to an existing ggml file.",
    );
  if (!response.ok || !response.body)
    throw new StudioError(
      "EXTERNAL_TOOL",
      `Downloading whisper model ${name} failed (HTTP ${response.status}).`,
      "Check network access to huggingface.co, then retry.",
      true,
    );
  const declared =
    Number(response.headers.get("content-length")) || expected?.bytes;
  await mkdir(path.dirname(modelPath), { recursive: true });
  const partial = `${modelPath}.${randomUUID()}.part`;
  try {
    await pipeline(
      // undici's DOM-side ReadableStream type differs from node:stream/web's.
      Readable.fromWeb(
        response.body as unknown as NodeWebReadableStream<Uint8Array>,
      ),
      createWriteStream(partial),
      { signal },
    );
    const written = (await stat(partial)).size;
    if (declared && written !== declared)
      throw new StudioError(
        "EXTERNAL_TOOL",
        `Incomplete download of ${name}: ${written} of ${declared} bytes.`,
        "Check network stability, then retry.",
        true,
      );
    const sha256 = expected?.sha256 && (await fileHash(partial));
    if (expected?.sha256 && sha256 !== expected.sha256)
      throw new StudioError(
        "EXTERNAL_TOOL",
        `Whisper model ${name} failed its sha256 checksum.`,
        "Discard the partial download and retry; the source may be corrupted.",
        true,
      );
    await rename(partial, modelPath);
  } catch (e) {
    await rm(partial, { force: true });
    if (e instanceof StudioError) throw e;
    throw new StudioError(
      "EXTERNAL_TOOL",
      e instanceof Error
        ? e.message
        : `Downloading whisper model ${name} failed.`,
      "Check network access to huggingface.co, then retry.",
      true,
    );
  }
}

const modelDownloads = new Map<string, Promise<void>>();

/**
 * Make sure the whisper model exists, downloading the canonical ggml file
 * from the whisper.cpp repository on first use. Custom model paths whose
 * names are not published there keep failing with setup guidance.
 */
export async function ensureWhisperModel(
  options: {
    modelPath?: string;
    signal?: AbortSignal;
    transport?: { fetch?: typeof globalThis.fetch };
  } = {},
): Promise<string> {
  const modelPath = options.modelPath ?? defaultWhisperModel();
  if (await existingFile(modelPath)) return modelPath;
  const name = path.basename(modelPath);
  if (!downloadableModel(name))
    throw new StudioError(
      "MISSING_DEPENDENCY",
      `Whisper model not found at ${modelPath}.`,
      "Download a ggml model and set WTS_WHISPER_MODEL to its path.",
    );
  let download = modelDownloads.get(modelPath);
  if (!download) {
    download = downloadModel(
      modelPath,
      name,
      options.transport?.fetch ?? globalThis.fetch,
      options.signal,
    ).finally(() => modelDownloads.delete(modelPath));
    modelDownloads.set(modelPath, download);
  }
  await download;
  return modelPath;
}

interface WhisperJSON {
  transcription?: {
    offsets: { from: number; to: number };
    text: string;
  }[];
}

async function runWhisperJSON(
  modelPath: string,
  wav: string,
  binary: string,
  signal?: AbortSignal,
): Promise<WhisperJSON> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wts-whisper-"));
  try {
    const prefix = path.join(dir, "t");
    await runBinary(
      binary,
      ["-m", modelPath, "-f", wav, "-oj", "-of", prefix, "-np"],
      { signal },
    );
    return JSON.parse(await readFile(`${prefix}.json`, "utf8")) as WhisperJSON;
  } catch (e) {
    if (e instanceof StudioError) throw e;
    throw new StudioError(
      "EXTERNAL_TOOL",
      e instanceof Error ? e.message : "whisper-cli failed.",
      "Check the model file and audio, then retry.",
      true,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function whisperBinary() {
  try {
    return await executable("whisper-cli");
  } catch {
    throw new StudioError(
      "MISSING_DEPENDENCY",
      "whisper-cli was not found.",
      "Install whisper.cpp (brew install whisper-cpp) or set WTS_WHISPER_CLI_PATH.",
    );
  }
}

export class WhisperCLIProvider implements Transcriber {
  readonly name = "whisper";
  readonly audioFormat = "wav" as const;
  constructor(
    public modelPath: string = defaultWhisperModel(),
    private binary?: string,
    private transport: { fetch?: typeof globalThis.fetch } = {},
  ) {}
  async transcribe(request: {
    file: string;
    recording: Recording;
    signal?: AbortSignal;
  }): Promise<ProviderResult<Transcript>> {
    const started = performance.now();
    await ensureWhisperModel({
      modelPath: this.modelPath,
      signal: request.signal,
      transport: this.transport,
    });
    const binary = this.binary ?? (await whisperBinary());
    const json = await runWhisperJSON(
      this.modelPath,
      request.file,
      binary,
      request.signal,
    );
    const segments = (json.transcription || [])
      .map((s, i) => ({
        id: `segment-${i + 1}`,
        start: s.offsets.from / 1000,
        end: Math.min(s.offsets.to / 1000, request.recording.duration),
        text: s.text.trim(),
      }))
      .filter((s) => s.text && s.end > s.start);
    if (!segments.length)
      throw new StudioError(
        "EXTERNAL_TOOL",
        "whisper.cpp returned no speech segments.",
        "Check that the recording contains intelligible speech, or import a transcript.",
        true,
      );
    const transcript = validateTranscript(
      {
        schemaVersion: "1.0.0",
        recordingId: request.recording.id,
        language: "en",
        provider: "whisper.cpp",
        model: path.basename(this.modelPath),
        segments,
      },
      request.recording,
    );
    const usage: Usage = {
      agent: "transcription",
      provider: "whisper.cpp",
      model: path.basename(this.modelPath),
      inputTokens: 0,
      outputTokens: 0,
      audioSeconds: request.recording.duration,
      imageCount: 0,
      costUSD: 0,
      elapsedMs: performance.now() - started,
      createdAt: now(),
    };
    return { output: transcript, usage };
  }
}

/** First spoken words of a media file, for take fingerprinting. Local, free. */
export async function transcribeOpening(
  mediaFile: string,
  seconds = 12,
  options: {
    modelPath?: string;
    binary?: string;
    signal?: AbortSignal;
  } = {},
): Promise<string[]> {
  const modelPath = options.modelPath ?? defaultWhisperModel();
  const dir = await mkdtemp(path.join(os.tmpdir(), "wts-fingerprint-"));
  try {
    const wav = path.join(dir, "opening.wav");
    await ffmpeg(
      [
        "-protocol_whitelist",
        "file,pipe",
        "-t",
        String(seconds),
        "-i",
        path.resolve(mediaFile),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        wav,
      ],
      options.signal,
    );
    const binary = options.binary ?? (await whisperBinary());
    const json = await runWhisperJSON(modelPath, wav, binary, options.signal);
    const text = (json.transcription || [])
      .slice(0, 2)
      .map((s) => s.text)
      .join(" ");
    return tokenize(text).slice(0, 10);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
