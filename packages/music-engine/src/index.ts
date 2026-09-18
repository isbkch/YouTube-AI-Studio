import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  geminiBlock,
  geminiInteractions,
  hash,
  now,
  StudioError,
  type Usage,
} from "../../shared/src/index.ts";
import { estimateUsageCost } from "../../shared/src/costs.ts";
import { ffmpeg } from "../../media/src/index.ts";

/**
 * Trusted adapter boundary for music-bed generation (ADR 007), mirroring the
 * image engine: providers return audio bytes and usage, never instructions.
 * Beds are short loopable clips; the mix pipeline loops them across the cut.
 */
export interface MusicRequest {
  prompt: string;
  signal?: AbortSignal;
}
export interface MusicResult {
  /** MP3 bytes ready for the audio mix pipeline. */
  data: Buffer;
  usage: Usage;
}
export interface MusicProvider {
  readonly name: string;
  readonly model: string;
  /** Nominal clip length in seconds; actual audio is probed after render. */
  readonly clipSeconds: number;
  generate(request: MusicRequest): Promise<MusicResult>;
}
export const MUSIC_CLIP_SECONDS = 30;

/** Deterministic synthesized pad seeded by the brief; no network, no credits. */
export class MockMusicProvider implements MusicProvider {
  readonly name = "music_generation";
  readonly model = "deterministic-v1";
  readonly clipSeconds = MUSIC_CLIP_SECONDS;
  async generate(request: MusicRequest): Promise<MusicResult> {
    request.signal?.throwIfAborted();
    // A stable triad chosen by the brief: same prompt, same chord, same bytes.
    const seed = hash(request.prompt);
    const root = 98 * Math.pow(2, (parseInt(seed.slice(0, 2), 16) % 12) / 12);
    const third =
      root * Math.pow(2, (parseInt(seed.slice(2, 4), 16) % 2 ? 3 : 4) / 12);
    const fifth = root * Math.pow(2, 7 / 12);
    const chord = (detune: number) =>
      `(0.75+0.25*sin(2*PI*t/${this.clipSeconds}))` +
      `*(0.30*sin(2*PI*${(root * detune).toFixed(3)}*t)` +
      `+0.22*sin(2*PI*${(third * detune).toFixed(3)}*t+0.6)` +
      `+0.18*sin(2*PI*${(fifth * detune).toFixed(3)}*t+1.2)` +
      `+0.08*sin(2*PI*${(root * 2 * detune).toFixed(3)}*t))`;
    // The amplitude LFO period equals the clip length and the right channel is
    // slightly detuned, so the bed loops seamlessly with stereo width.
    const expression = `${chord(1)}|${chord(1.0015)}`;
    const workspace = await mkdtemp(path.join(os.tmpdir(), "wts-music-"));
    const temp = path.join(workspace, "bed.mp3");
    try {
      await ffmpeg(
        [
          "-f",
          "lavfi",
          "-i",
          `aevalsrc=exprs='${expression}':s=44100:d=${this.clipSeconds}:c=stereo`,
          "-t",
          String(this.clipSeconds),
          "-c:a",
          "libmp3lame",
          "-b:a",
          "128k",
          temp,
        ],
        request.signal,
      );
      return {
        data: await readFile(temp),
        usage: {
          agent: this.name,
          provider: "mock",
          model: this.model,
          inputTokens: 0,
          outputTokens: 0,
          audioSeconds: this.clipSeconds,
          imageCount: 0,
          costUSD: 0,
          elapsedMs: 0,
          createdAt: now(),
        },
      };
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }
}

export interface MusicTransport {
  fetch?: typeof globalThis.fetch;
  /** Overrides WTS_GEMINI_MUSIC_MODEL / the provider default. */
  model?: string;
}
/** Lyria clips through the Gemini Interactions API; MP3, ~30 s, loopable. */
export class GeminiMusicProvider implements MusicProvider {
  readonly name = "music_generation";
  readonly model: string;
  readonly clipSeconds = MUSIC_CLIP_SECONDS;
  constructor(
    private apiKey: string,
    private transport: MusicTransport = {},
  ) {
    this.model =
      transport.model ||
      process.env.WTS_GEMINI_MUSIC_MODEL ||
      "lyria-3-clip-preview";
    if (!apiKey.trim())
      throw new StudioError(
        "CONFIGURATION",
        "Gemini music generation needs Gemini credentials.",
        "Save a Gemini API key in Settings (macOS Keychain) or set GEMINI_API_KEY in .env.",
      );
  }
  async generate(request: MusicRequest): Promise<MusicResult> {
    const started = performance.now();
    const { blocks } = await geminiInteractions({
      apiKey: this.apiKey,
      model: this.model,
      signal: request.signal,
      transport: this.transport,
      body: { input: [{ type: "text", text: request.prompt.slice(0, 2000) }] },
    });
    const audio = geminiBlock(blocks, "audio");
    const usage: Usage = {
      agent: this.name,
      provider: "gemini",
      model: this.model,
      inputTokens: 0,
      outputTokens: 0,
      audioSeconds: this.clipSeconds,
      imageCount: 0,
      costUSD: null,
      elapsedMs: performance.now() - started,
      createdAt: now(),
    };
    usage.costUSD = estimateUsageCost(usage);
    return { data: Buffer.from(audio.data, "base64"), usage };
  }
}

/** Trusted prompt assembly: briefs are data; bed wording is checked in. */
export function buildMusicPrompt(music: { brief: string }) {
  return `${music.brief} Instrumental background music only — no vocals, no lyrics, no spoken words. Even, unobtrusive energy that sits under spoken narration, with a seamless loop-friendly beginning and end.`;
}
/** Semantic render identity: provider model and brief, never plan version. */
export function musicBedKey(
  music: { brief: string },
  provider: { model: string },
) {
  return hash({ brief: music.brief, provider: provider.model });
}
