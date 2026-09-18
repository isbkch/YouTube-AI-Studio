import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { runBinary } from "../../media/src/index.ts";
import { StudioError } from "../../shared/src/index.ts";
import type { SpeechRange } from "../../orchestrator/src/transcription-model.ts";

const range = z.object({
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
});
const analysisSchema = z.object({
  duration: z.number().positive(),
  speech: z.array(range),
  clippedFraction: z.number().min(0).max(1),
  engine: z.string(),
});
const alignmentSchema = z.object({
  duration: z.number().positive(),
  engine: z.string(),
  model: z.string(),
  segments: z.array(
    z.object({
      text: z.string(),
      start: z.number(),
      end: z.number(),
      words: z
        .array(
          z.object({
            word: z.string(),
            start: z.number().optional(),
            end: z.number().optional(),
            score: z.number().optional(),
          }),
        )
        .default([]),
    }),
  ),
});
export type AcousticAnalysis = z.infer<typeof analysisSchema>;
export type AcousticAlignment = z.infer<typeof alignmentSchema>;
export interface AcousticTools {
  analyze(file: string, signal?: AbortSignal): Promise<AcousticAnalysis>;
  align(
    file: string,
    segments: (SpeechRange & { text: string })[],
    language: string,
    signal?: AbortSignal,
  ): Promise<AcousticAlignment>;
}
const root = fileURLToPath(new URL("../../../", import.meta.url));
export const alignmentPython = () =>
  process.env.WTS_ALIGNMENT_PYTHON_PATH ||
  path.join(
    process.env.WTS_ALIGNMENT_ENV ||
      path.join(
        os.homedir(),
        "Library/Caches/YouTube-AI-Studio/transcription-venv",
      ),
    "bin/python",
  );
let setup: Promise<void> | null = null;
export async function ensureAcousticTools(signal?: AbortSignal) {
  try {
    await access(alignmentPython());
  } catch {
    if (process.env.WTS_ALIGNMENT_PYTHON_PATH)
      throw new StudioError(
        "MISSING_DEPENDENCY",
        "Configured alignment Python is missing.",
        "Run bun run transcription:setup, or correct WTS_ALIGNMENT_PYTHON_PATH.",
      );
    setup ??= runBinary(
      "/bin/bash",
      [path.join(root, "scripts/setup-transcription.sh")],
      { timeoutMs: 1_200_000, signal },
    )
      .then(() => undefined)
      .finally(() => {
        setup = null;
      });
    await setup;
  }
  signal?.throwIfAborted();
}
export class LocalAcousticTools implements AcousticTools {
  private async call(request: unknown, signal?: AbortSignal): Promise<unknown> {
    await ensureAcousticTools(signal);
    const dir = await mkdtemp(path.join(os.tmpdir(), "wts-acoustic-"));
    try {
      const input = path.join(dir, "request.json"),
        output = path.join(dir, "response.json");
      await writeFile(input, JSON.stringify(request), { mode: 0o600 });
      await runBinary(
        alignmentPython(),
        [
          path.join(root, "scripts/transcription-audio.py"),
          "--input",
          input,
          "--output",
          output,
        ],
        { signal, timeoutMs: 900000 },
      );
      return JSON.parse(await readFile(output, "utf8"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  async analyze(file: string, signal?: AbortSignal) {
    return analysisSchema.parse(
      await this.call({ action: "analyze", file }, signal),
    );
  }
  async align(
    file: string,
    segments: (SpeechRange & { text: string })[],
    language: string,
    signal?: AbortSignal,
  ) {
    return alignmentSchema.parse(
      await this.call({ action: "align", file, segments, language }, signal),
    );
  }
}
