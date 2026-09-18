import OpenAI from "openai";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { now, StudioError, type Usage } from "../../shared/src/index.ts";

export interface SpeechRequest {
  file: string;
  duration: number;
  model: "gpt-transcribe" | "whisper-1" | "gpt-4o-transcribe";
  keywords?: string[];
  languages?: string[];
  signal?: AbortSignal;
}
export interface SpeechRecognition {
  text: string;
  language: string;
  usage: Usage;
  /** Raw provider confidence is evidence, never a calibrated correctness probability. */
  confidence: number | null;
}
export interface SpeechRecognizer {
  recognize(request: SpeechRequest): Promise<SpeechRecognition>;
}
export class OpenAISpeechRecognizer implements SpeechRecognizer {
  private client: OpenAI;
  constructor(
    apiKey: string,
    transport: { fetch?: typeof globalThis.fetch } = {},
  ) {
    if (!apiKey.trim())
      throw new StudioError(
        "CONFIGURATION",
        "OpenAI credentials are not configured.",
      );
    this.client = new OpenAI({
      apiKey,
      maxRetries: 2,
      timeout: 300000,
      ...transport,
    });
  }
  async recognize(r: SpeechRequest): Promise<SpeechRecognition> {
    if ((await stat(r.file)).size > 24_000_000)
      throw new StudioError(
        "UNSUPPORTED",
        "Transcription chunk exceeds 24 MB.",
        "Retry with shorter audio chunks.",
      );
    const started = performance.now();
    const response = await this.client.audio.transcriptions.create(
      {
        model: r.model,
        file: createReadStream(r.file),
        response_format: "json",
        ...(r.model === "gpt-transcribe"
          ? {
              keywords: (r.keywords ?? [])
                .filter((s) => !/[<>\r\n]/.test(s))
                .slice(0, 60),
              languages: r.languages?.length ? r.languages : ["en"],
              prompt:
                "Verbatim camera recording. Preserve every repeated attempt, filler, false start and unfinished phrase. Spell numbers as spoken. Do not rewrite, summarize, repair grammar or add unspoken words.",
            }
          : r.model === "gpt-4o-transcribe"
            ? { include: ["logprobs" as const] }
            : {}),
      },
      { signal: r.signal },
    );
    const probabilities =
      "logprobs" in response ? (response.logprobs ?? []) : [];
    return {
      text: response.text.trim(),
      language: r.languages?.[0] ?? "en",
      confidence: probabilities.length
        ? probabilities.reduce((n, t) => n + (t.logprob ?? 0), 0) /
          probabilities.length
        : null,
      usage: {
        agent:
          r.model === "gpt-transcribe"
            ? "transcription"
            : "transcription-verification",
        provider: "openai",
        model: r.model,
        inputTokens: 0,
        outputTokens: 0,
        audioSeconds: r.duration,
        imageCount: 0,
        costUSD: null,
        elapsedMs: performance.now() - started,
        createdAt: now(),
      },
    };
  }
}
