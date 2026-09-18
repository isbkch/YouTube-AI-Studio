import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import {
  GPTTranscriber,
  excerptAudio,
  TRANSCRIPTION_PIPELINE,
} from "../packages/agents/src/gpt-transcription.ts";
import { WhisperCLIProvider } from "../packages/agents/src/whisper.ts";
import {
  validateTranscript,
  type Transcriber,
} from "../packages/agents/src/index.ts";
import {
  hash,
  fileHash,
  id,
  loadDotEnv,
  now,
  inside,
} from "../packages/shared/src/index.ts";
import { resolveCredentials } from "../packages/orchestrator/src/providers.ts";
import type {
  Project,
  Recording,
  Transcript,
} from "../packages/orchestrator/src/model.ts";
import {
  benchmarkReferenceSchema,
  evaluateTranscript,
} from "../packages/orchestrator/src/transcription-benchmark.ts";
import { reviewRetakes } from "../packages/orchestrator/src/retakes.ts";
import { splitScriptSentences } from "../packages/orchestrator/src/alignment.ts";

loadDotEnv();
const {
  positionals: [command],
  values: options,
} = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    project: { type: "string" },
    directory: { type: "string" },
    home: { type: "string" },
    candidate: { type: "string" },
    reference: { type: "string" },
    sample: { type: "string" },
  },
});
if (!options.directory)
  throw new Error(
    "Pass --directory <benchmark-folder>. Commands: prepare --project <id>, run --candidate gpt-transcribe|whisper-small|whisper-large-v3-turbo, certify --reference <json>, evaluate.",
  );
const directory = path.resolve(options.directory);
const json = async (file: string, value: unknown) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
};
interface Sample {
  id: string;
  recording: Recording;
  originalStart: number;
  originalEnd: number;
  sourceHash: string;
  audio: string;
}
interface Manifest {
  id: string;
  projectId: string;
  createdAt: string;
  script: string;
  samples: Sample[];
}
const manifestPath = path.join(directory, "manifest.json");
if (command === "prepare") {
  await mkdir(directory, { recursive: true });
  if ((await readdir(directory)).length)
    throw new Error(
      "Use an empty directory to preserve earlier benchmark evidence.",
    );
  const home =
    options.home ||
    process.env.WTS_HOME ||
    path.join(os.homedir(), "Movies/YouTube-AI-Studio");
  const db = new DatabaseSync(path.join(home, "studio.sqlite"), {
    readOnly: true,
  });
  const row = db
    .prepare("SELECT data FROM projects WHERE id = ? OR slug = ?")
    .get(options.project!, options.project!) as { data: string } | undefined;
  db.close();
  if (!row) throw new Error("Project not found.");
  const p = JSON.parse(row.data) as Project;
  const manifest: Manifest = {
    id: id("benchmark"),
    projectId: p.id,
    createdAt: now(),
    script: p.scripts.at(-1)?.text ?? "",
    samples: [],
  };
  const sentences = splitScriptSentences(manifest.script).map((s) => s.text);
  for (const [index, recording] of p.recordings.entries()) {
    const transcript = p.transcripts.findLast(
      (t) => t.recordingId === recording.id,
    );
    const repeated =
      transcript && reviewRetakes(transcript, sentences).groups[0];
    const anchor =
      repeated?.discarded[0].start ??
      recording.duration * (0.25 + (index % 3) * 0.2);
    const duration = Math.min(32, recording.duration);
    const start = Math.max(
      0,
      Math.min(recording.duration - duration, anchor - 5),
    );
    const sampleId = `sample-${index + 1}`;
    const audio = `${sampleId}.wav`;
    await excerptAudio(
      inside(path.join(home, "projects", p.slug), recording.path),
      path.join(directory, audio),
      { start, end: start + duration },
    );
    const sourceHash = await fileHash(path.join(directory, audio));
    manifest.samples.push({
      id: sampleId,
      recording: {
        ...recording,
        duration,
        frames: Math.floor(duration * recording.frameRate),
      },
      originalStart: start,
      originalEnd: start + duration,
      sourceHash,
      audio,
    });
    await json(path.join(directory, "reference-drafts", `${sampleId}.json`), {
      sampleId,
      sourceHash,
      confirmedBy: null,
      confirmedAt: null,
      text: "",
      words: null,
      expectedDiscarded: null,
    });
    console.log(
      `Prepared ${recording.name} ${start.toFixed(2)}–${(start + duration).toFixed(2)}`,
    );
  }
  await json(manifestPath, manifest);
} else {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
  if (command === "run") {
    const name = options.candidate;
    if (
      !["gpt-transcribe", "whisper-small", "whisper-large-v3-turbo"].includes(
        name ?? "",
      )
    )
      throw new Error("Unknown candidate.");
    const provider: Transcriber =
      name === "gpt-transcribe"
        ? new GPTTranscriber((await resolveCredentials()).openAI)
        : new WhisperCLIProvider(
            path.join(
              os.homedir(),
              ".whisper-models",
              `ggml-${name === "whisper-small" ? "small" : "large-v3-turbo"}.bin`,
            ),
          );
    for (const sample of manifest.samples.filter(
      (s) => !options.sample || s.id === options.sample,
    )) {
      const audio = inside(directory, sample.audio);
      if ((await fileHash(audio)) !== sample.sourceHash)
        throw new Error("Benchmark audio changed.");
      const candidatePath = path.join(
        directory,
        "candidates",
        name!,
        `${sample.id}.json`,
      );
      try {
        const previous = JSON.parse(await readFile(candidatePath, "utf8"));
        if (
          name !== "gpt-transcribe" ||
          previous.review?.algorithm === TRANSCRIPTION_PIPELINE
        ) {
          console.log(`Reusing ${name} ${sample.id}`);
          continue;
        }
        await json(
          path.join(
            directory,
            "candidate-history",
            name!,
            `${sample.id}-${id("run")}.json`,
          ),
          previous,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      console.log(`Running ${name} ${sample.id}`);
      let sequence = 0;
      const started = performance.now();
      const result = await provider.transcribe({
        file: audio,
        recording: sample.recording,
        context: { script: manifest.script },
        onProgress: console.log,
        onEvidence: (evidence) =>
          json(
            path.join(
              directory,
              "evidence",
              name!,
              `${sample.id}-${++sequence}-${id("call")}.json`,
            ),
            evidence,
          ),
      });
      await json(candidatePath, {
        sourceHash: sample.sourceHash,
        elapsedSeconds: (performance.now() - started) / 1000,
        ...result,
      });
    }
  } else if (command === "certify") {
    const reference = benchmarkReferenceSchema.parse(
      JSON.parse(await readFile(options.reference!, "utf8")),
    );
    const sample = manifest.samples.find((s) => s.id === reference.sampleId);
    if (!sample || sample.sourceHash !== reference.sourceHash)
      throw new Error("Reference does not match this sample.");
    if (
      reference.words?.some(
        (w, i, all) =>
          w.end <= w.start ||
          w.end > sample.recording.duration ||
          (i > 0 && w.start < all[i - 1].end),
      )
    )
      throw new Error("Reference word times are invalid.");
    if (
      reference.expectedDiscarded?.some(
        (s) => s.end > sample.recording.duration,
      )
    )
      throw new Error("Retake reference exceeds audio duration.");
    // Creator-supplied certification only. The approved script is never a reference transcript.
    await json(
      path.join(
        directory,
        "references",
        `${sample.id}-${hash(reference).slice(0, 12)}.json`,
      ),
      reference,
    );
  } else if (command === "evaluate") {
    const rows: unknown[] = [];
    const files = await readdir(path.join(directory, "references")).catch(
      () => [] as string[],
    );
    for (const sample of manifest.samples) {
      const references = await Promise.all(
        files
          .filter((f) => f.startsWith(`${sample.id}-`) && f.endsWith(".json"))
          .map(async (f) =>
            benchmarkReferenceSchema.parse(
              JSON.parse(
                await readFile(path.join(directory, "references", f), "utf8"),
              ),
            ),
          ),
      );
      const reference = references
        .filter((r) => r.sourceHash === sample.sourceHash)
        .sort((a, b) => a.confirmedAt.localeCompare(b.confirmedAt))
        .at(-1);
      for (const name of [
        "whisper-small",
        "whisper-large-v3-turbo",
        "gpt-transcribe",
      ]) {
        let candidate: {
          output: Transcript;
          sourceHash: string;
          elapsedSeconds: number;
        };
        try {
          candidate = JSON.parse(
            await readFile(
              path.join(directory, "candidates", name, `${sample.id}.json`),
              "utf8",
            ),
          );
        } catch {
          continue;
        }
        if (
          candidate.sourceHash !== sample.sourceHash ||
          (await fileHash(inside(directory, sample.audio))) !==
            sample.sourceHash
        )
          throw new Error("Candidate or audio does not match source.");
        validateTranscript(candidate.output, sample.recording);
        rows.push({
          sampleId: sample.id,
          recording: sample.recording.name,
          candidate: name,
          elapsedSeconds: candidate.elapsedSeconds,
          status: reference
            ? "creator-verified-reference"
            : "awaiting-creator-reference",
          metrics: reference
            ? evaluateTranscript(
                reference,
                candidate.output,
                splitScriptSentences(manifest.script).map((s) => s.text),
              )
            : null,
        });
      }
    }
    const report = { benchmarkId: manifest.id, createdAt: now(), rows };
    await json(path.join(directory, `report-${Date.now()}.json`), report);
    console.log(JSON.stringify(report, null, 2));
  } else throw new Error("Unknown benchmark command.");
}
