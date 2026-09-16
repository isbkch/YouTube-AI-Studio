import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executable, ffmpeg, runBinary } from "../../media/src/index.ts";
import { StudioError, now, type Usage } from "../../shared/src/index.ts";
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
  ) {}
  async transcribe(request: {
    file: string;
    recording: Recording;
    signal?: AbortSignal;
  }): Promise<ProviderResult<Transcript>> {
    const started = performance.now();
    if (!(await stat(this.modelPath)).isFile())
      throw new StudioError(
        "MISSING_DEPENDENCY",
        `Whisper model not found at ${this.modelPath}.`,
        "Download a ggml model and set WTS_WHISPER_MODEL to its path.",
      );
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
