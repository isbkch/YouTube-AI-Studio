import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  applyPatch,
  patchSchema,
  normalizePlan,
  validateAudioDesign,
  validatePlan,
  validateSources,
  operationSchema,
  type Graphic,
  type Operation,
  type PlanPatch,
  type ProductionPlan,
} from "../../production-plan/src/index.ts";
import {
  DirectorAgent,
  MockAIProvider,
  NarrativeAgent,
  PackagingAgent,
  PrevisualizationAgent,
  ResearchAgent,
  ScriptAgent,
  VisualPassAgent,
  validateTranscript,
  narrativeSchema,
  packagingSchema,
  planChapters,
  recommendedTitle,
  previsualizationSchema,
  renderDescription,
  renderRunSheet,
  renderTeleprompter,
  renderVideoScript,
  researchSchema,
  type AIProvider,
  type Narrative,
  type Previsualization,
  type ResearchNotes,
  type Transcriber,
  type VideoPackaging,
  type VisualPassCapabilities,
} from "../../agents/src/index.ts";
import {
  fileHash,
  hash,
  id,
  now,
  safePath,
  StudioError,
  type CreatorProfile,
} from "../../shared/src/index.ts";
import {
  importRecording,
  extractAudio,
  verifyOutput,
} from "../../media/src/index.ts";
import type { ImageProvider } from "../../image-engine/src/index.ts";
import {
  FINAL_RENDER_PRESETS,
  resolveCommand,
} from "../../resolve-engine/src/index.ts";
import { Store } from "./store.ts";
import {
  transition,
  type Project,
  type Job,
  type Transcript,
} from "./model.ts";
import { buildProject } from "./build.ts";
import { JobGraph } from "./jobs.ts";
import { engineCapabilities, validateEngines } from "./engines.ts";
import { publishToYouTube } from "./youtube.ts";
import { readLibrary, trackRefs } from "./library.ts";
import {
  ALIGNMENT_ALGORITHM,
  alignScript,
  alignmentSchema,
  type Alignment,
} from "./alignment.ts";
import { buildEditDecision, suggestGraphic } from "./aroll.ts";
import {
  discoverFCPTranscripts,
  fcpToTranscriptInput,
  mapFCPTranscriptsToRecordings,
  readFCPTranscript,
} from "./fcp.ts";

export class Studio {
  public transcription: Transcriber;
  /** Still-image generation engine; null fails B-roll plans closed (ADR 007). */
  public images: ImageProvider | null = null;
  constructor(
    public store: Store,
    public provider: AIProvider = new MockAIProvider(),
    transcription?: Transcriber,
    private notify?: (event: unknown) => void,
  ) {
    this.transcription =
      transcription ??
      (("transcribe" in provider &&
      typeof (provider as unknown as Transcriber).transcribe === "function"
        ? (provider as unknown as Transcriber)
        : new MockAIProvider()) as Transcriber);
  }
  snapshot(projectId: string) {
    const p = this.store.get(projectId);
    return {
      ...p,
      directory: this.store.dir(p),
      jobs: this.store.jobs(p.id),
      assets: this.store.assets(p.id),
      events: this.store.events(p.id),
    };
  }
  private async locked<T>(
    projectId: string,
    fn: (p: Project) => Promise<T> | T,
  ) {
    const p = this.store.get(projectId);
    const release = this.store.acquire(p.id);
    try {
      return await fn(this.store.get(p.id));
    } finally {
      release();
    }
  }
  async recover(projectId: string) {
    return this.locked(projectId, (p) => {
      const status = p.status;
      if (
        [
          "TRANSCRIBING",
          "PLANNING",
          "GENERATING_ASSETS",
          "ASSEMBLING",
        ].includes(status)
      ) {
        this.store.update(p.id, (x) => {
          x.status = transition(
            x.status,
            ["TRANSCRIBING", "PLANNING"].includes(status)
              ? "MEDIA_IMPORTED"
              : "AWAITING_STORYBOARD_APPROVAL",
          );
        });
      }
      for (const job of this.store
        .jobs(p.id)
        .filter((j) => ["RUNNING", "QUEUED", "BLOCKED"].includes(j.status))) {
        this.store.job({
          ...job,
          status: "FAILED",
          completedAt: now(),
          error: {
            kind: "EXTERNAL_TOOL",
            message: "Interrupted operation recovered.",
            recovery: "Retry the operation. Verified outputs will be reused.",
            retryable: true,
          },
        });
      }
      this.store.event(p.id, { event: "project.recovered" });
      return this.snapshot(p.id);
    });
  }
  private async operation(
    p: Project,
    type: string,
    label: string,
    fn: (signal: AbortSignal) => Promise<void>,
    signal?: AbortSignal,
  ) {
    const graph = new JobGraph(
      [
        {
          id: id(type),
          type,
          label,
          dependencies: [],
          maxRetries: 0,
          run: (ctx) => fn(ctx.signal),
        },
      ],
      p.id,
      (job) => {
        this.store.job(job);
        this.notify?.({ event: "job", job });
      },
    );
    await graph.run(signal);
  }
  async saveScript(projectId: string, text: string) {
    return this.locked(projectId, async (p) => {
      if (!text.trim() || text.length > 250000)
        throw new StudioError(
          "INVALID_INPUT",
          "Script must contain 1–250,000 characters.",
        );
      if (
        ![
          "IDEA",
          "SCRIPTING",
          "AWAITING_SCRIPT_APPROVAL",
          "READY_TO_RECORD",
        ].includes(p.status)
      )
        throw new StudioError(
          "CONFLICT",
          "The approved script is locked after media import.",
          "Create a new project for a new script; scene-level changes belong in revisions.",
        );
      const script = { version: p.scripts.length + 1, text, createdAt: now() };
      await this.store.artifact(
        p,
        `scripts/script-v${script.version}.json`,
        script,
      );
      return this.store.update(p.id, (x) => {
        if (x.status !== "SCRIPTING")
          x.status = transition(x.status, "SCRIPTING");
        x.scripts.push(script);
        x.scriptApproval = null;
        x.status = transition(x.status, "AWAITING_SCRIPT_APPROVAL");
      });
    });
  }
  async approveScript(projectId: string, version: number) {
    return this.locked(projectId, (p) => {
      const script = p.scripts.at(-1);
      if (!script || script.version !== version)
        throw new StudioError(
          "CONFLICT",
          "Script version changed. Review the current script.",
        );
      return this.store.update(p.id, (x) => {
        x.status = transition(x.status, "READY_TO_RECORD");
        x.scriptApproval = {
          version,
          hash: hash(script),
          approvedAt: now(),
          approvedBy: "creator",
        };
        this.store.event(x.id, { event: "script.approved", version });
      });
    });
  }
  // ---------------------------------------------------------------------
  // Milestone 4 — pre-production agents: idea → research → narrative →
  // script draft → Director pre-visualization → approval → teleprompter.
  // Every stage is an explicit, cancellable operation; script approval
  // remains the single human gate before recording.
  // ---------------------------------------------------------------------

  /** Research agent: an evidence brief with sources, from the idea. */
  async research(projectId: string, signal?: AbortSignal) {
    return this.locked(projectId, async (p) => {
      if (!["IDEA", "RESEARCHING"].includes(p.status))
        throw new StudioError(
          "CONFLICT",
          "Research runs before narrative and scripting.",
          "Continue with the current script, or start a new project for a new idea.",
        );
      const idea = p.description.trim();
      if (idea.length < 8)
        throw new StudioError(
          "INVALID_INPUT",
          "Describe the idea first: the project description needs at least 8 characters.",
          "Edit the project description, then run research again.",
        );
      const version = (p.preproduction?.researchVersion ?? 0) + 1;
      await this.operation(
        p,
        "research",
        `Research • evidence brief v${version}`,
        async (signal) => {
          const result = await new ResearchAgent(this.provider).research(
            {
              projectId: p.id,
              idea: p.description,
              creator: p.creator,
              targetDuration: p.targetDuration,
            },
            signal,
          );
          await this.store.artifact(
            p,
            `research/research-v${version}.json`,
            result.output,
          );
          this.store.update(p.id, (x) => {
            x.preproduction ??= emptyPreproduction();
            x.preproduction.researchVersion = version;
            x.research = {
              notes: result.output.summary,
              sources: result.output.sources.map((s) => ({
                url: s.url,
                title: s.title,
                retrievedAt: now(),
              })),
            };
            x.usage.push(result.usage);
            if (x.status === "IDEA")
              x.status = transition(x.status, "RESEARCHING");
          });
          this.store.event(p.id, {
            event: "research.completed",
            version,
            sources: result.output.sources.length,
            model: result.usage.model,
          });
        },
        signal,
      );
      return this.snapshot(p.id);
    });
  }
  /** Narrative agent: the retention architecture the script will follow. */
  async narrative(projectId: string, signal?: AbortSignal) {
    return this.locked(projectId, async (p) => {
      const research = await this.loadPreproductionArtifact(p, "research");
      if (
        ![
          "RESEARCHING",
          "SCRIPTING",
          "AWAITING_SCRIPT_APPROVAL",
          "READY_TO_RECORD",
        ].includes(p.status)
      )
        throw new StudioError(
          "CONFLICT",
          "The narrative pass needs a project that has not locked its script.",
          "Scene-level changes after media import belong in revisions.",
        );
      const version = (p.preproduction?.narrativeVersion ?? 0) + 1;
      await this.operation(
        p,
        "narrative",
        `Narrative • outline v${version}`,
        async (signal) => {
          const result = await new NarrativeAgent(this.provider).narrate(
            {
              projectId: p.id,
              idea: p.description,
              research,
              creator: p.creator,
              targetDuration: p.targetDuration,
            },
            signal,
          );
          await this.store.artifact(
            p,
            `research/narrative-v${version}.json`,
            result.output,
          );
          this.store.update(p.id, (x) => {
            x.preproduction ??= emptyPreproduction();
            x.preproduction.narrativeVersion = version;
            x.outline = result.output.sections.map((s) => s.heading);
            x.usage.push(result.usage);
            if (x.status !== "SCRIPTING")
              x.status = transition(x.status, "SCRIPTING");
          });
          this.store.event(p.id, {
            event: "narrative.completed",
            version,
            sections: result.output.sections.length,
            model: result.usage.model,
          });
        },
        signal,
      );
      return this.snapshot(p.id);
    });
  }
  /** Script agent: a full A-roll/B-roll draft saved as the next script version. */
  async draftScript(projectId: string, signal?: AbortSignal) {
    return this.locked(projectId, async (p) => {
      const research = await this.loadPreproductionArtifact(p, "research");
      const narrative = await this.loadPreproductionArtifact(p, "narrative");
      if (
        !["SCRIPTING", "AWAITING_SCRIPT_APPROVAL", "READY_TO_RECORD"].includes(
          p.status,
        )
      )
        throw new StudioError(
          "CONFLICT",
          "The agent draft needs a project that has not locked its script.",
          "Approve and import first; later changes belong in revisions.",
        );
      const script = { version: p.scripts.length + 1, text: "", createdAt: "" };
      await this.operation(
        p,
        "script-draft",
        `Script Agent • draft v${script.version}`,
        async (signal) => {
          const result = await new ScriptAgent(this.provider).draft(
            {
              projectId: p.id,
              idea: p.description,
              projectTitle: p.title,
              research,
              narrative,
              creator: p.creator,
              targetDuration: p.targetDuration,
              scriptVersion: script.version,
            },
            signal,
          );
          script.text = renderVideoScript(result.output);
          script.createdAt = now();
          await this.store.artifact(
            p,
            `scripts/script-v${script.version}.json`,
            script,
          );
          await this.store.artifact(
            p,
            `scripts/script-doc-v${script.version}.json`,
            result.output,
          );
          this.store.update(p.id, (x) => {
            x.preproduction ??= emptyPreproduction();
            x.preproduction.scriptDocVersion = script.version;
            if (x.status !== "SCRIPTING")
              x.status = transition(x.status, "SCRIPTING");
            x.scripts.push({ ...script });
            x.scriptApproval = null;
            x.status = transition(x.status, "AWAITING_SCRIPT_APPROVAL");
            x.usage.push(result.usage);
          });
          this.store.event(p.id, {
            event: "script.drafted",
            version: script.version,
            sections: result.output.sections.length,
            model: result.usage.model,
          });
        },
        signal,
      );
      return this.snapshot(p.id);
    });
  }
  /**
   * Director pre-visualization: how the eventual edit plans to treat every
   * moment, so the recording session knows when it is on camera. Binds to
   * the current script version; no status change, no gate.
   */
  async previsualize(projectId: string, signal?: AbortSignal) {
    return this.locked(projectId, async (p) => {
      if (!["AWAITING_SCRIPT_APPROVAL", "READY_TO_RECORD"].includes(p.status))
        throw new StudioError(
          "CONFLICT",
          "Pre-visualization directs a saved script.",
          "Save or draft a script version first.",
        );
      const script = p.scripts.at(-1)!;
      const version = (p.preproduction?.previsualization?.version ?? 0) + 1;
      let output: Previsualization | undefined;
      await this.operation(
        p,
        "previsualization",
        `Director • pre-visualization v${version}`,
        async (signal) => {
          const result = await new PrevisualizationAgent(
            this.provider,
          ).previsualize(
            {
              projectId: p.id,
              script: { version: script.version, text: script.text },
              creator: p.creator,
            },
            signal,
          );
          output = result.output;
          await this.store.artifact(
            p,
            `scripts/previsualization-v${version}.json`,
            output,
          );
          this.store.update(p.id, (x) => {
            x.preproduction ??= emptyPreproduction();
            x.preproduction.previsualization = {
              version,
              scriptVersion: script.version,
            };
            x.usage.push(result.usage);
          });
          this.store.event(p.id, {
            event: "previsualization.completed",
            version,
            scriptVersion: script.version,
            shots: output.shots.length,
            model: result.usage.model,
          });
        },
        signal,
      );
      return {
        snapshot: this.snapshot(p.id),
        previsualization: output!,
        runSheet: renderRunSheet(output!),
      };
    });
  }
  /** Reading document for the recording session, from the approved script. */
  async teleprompter(projectId: string) {
    return this.locked(projectId, async (p) => {
      const script = p.scripts.at(-1);
      if (
        !p.scriptApproval ||
        !script ||
        p.scriptApproval.version !== script.version
      )
        throw new StudioError(
          "CONFLICT",
          "Approve the current script before generating the teleprompter.",
          "Approve the script, then generate the teleprompter again.",
        );
      const runSheet = this.currentRunSheet(p);
      const text = renderTeleprompter({
        projectTitle: p.title,
        scriptVersion: script.version,
        scriptText: script.text,
        runSheet,
      });
      await this.store.artifactText(
        p,
        `scripts/teleprompter-v${script.version}.md`,
        text,
      );
      this.store.event(p.id, {
        event: "teleprompter.rendered",
        scriptVersion: script.version,
        withRunSheet: runSheet !== null,
      });
      return { scriptVersion: script.version, runSheet, text };
    });
  }
  private currentRunSheet(p: Project): string | null {
    const ref = p.preproduction?.previsualization;
    const script = p.scripts.at(-1)!;
    if (!ref || ref.scriptVersion !== script.version) return null;
    try {
      const file = path.join(
        this.store.dir(p),
        "scripts",
        `previsualization-v${ref.version}.json`,
      );
      return renderRunSheet(
        previsualizationSchema.parse(JSON.parse(readFileSync(file, "utf8"))),
      );
    } catch {
      return null;
    }
  }
  private async loadPreproductionArtifact(
    p: Project,
    kind: "research",
  ): Promise<ResearchNotes>;
  private async loadPreproductionArtifact(
    p: Project,
    kind: "narrative",
  ): Promise<Narrative>;
  private async loadPreproductionArtifact(
    p: Project,
    kind: "research" | "narrative",
  ): Promise<ResearchNotes | Narrative> {
    const version =
      kind === "research"
        ? p.preproduction?.researchVersion
        : p.preproduction?.narrativeVersion;
    if (!version)
      throw new StudioError(
        "CONFLICT",
        kind === "research"
          ? "Run research before the narrative pass."
          : "Run the narrative pass before drafting a script.",
        kind === "research"
          ? "Run the research agent on this project first."
          : "Run the narrative agent on this project first.",
      );
    try {
      const file = path.join(
        this.store.dir(p),
        "research",
        `${kind}-v${version}.json`,
      );
      const raw = JSON.parse(readFileSync(file, "utf8"));
      return kind === "research"
        ? researchSchema.parse(raw)
        : narrativeSchema.parse(raw);
    } catch {
      throw new StudioError(
        "CONFLICT",
        `The ${kind} artifact v${version} is missing or unreadable.`,
        `Re-run the ${kind} agent on this project.`,
      );
    }
  }
  async importMedia(projectId: string, file: string, signal?: AbortSignal) {
    return this.locked(projectId, async (p) => {
      if (
        !["READY_TO_RECORD", "MEDIA_IMPORTED"].includes(p.status) ||
        !p.scriptApproval
      )
        throw new StudioError(
          "CONFLICT",
          "Import A-roll after script approval and before planning.",
        );
      await this.operation(
        p,
        "import",
        "Inspect and import A-roll",
        async (signal) => {
          const r = await importRecording(this.store.dir(p), file, signal);
          this.store.update(p.id, (x) => {
            x.recordings.push(r);
            x.status = transition(x.status, "MEDIA_IMPORTED");
          });
        },
        signal,
      );
      return this.snapshot(p.id);
    });
  }
  async loadTranscript(
    projectId: string,
    input: unknown,
    recordingId?: string,
  ) {
    return this.locked(projectId, async (p) => {
      if (p.status !== "MEDIA_IMPORTED")
        throw new StudioError(
          "CONFLICT",
          "Load the transcript after importing media and before planning.",
        );
      const raw = z
        .object({
          segments: z.array(z.unknown()),
          recordingId: z.string().optional(),
        })
        .passthrough()
        .parse(input);
      const requested = recordingId ?? raw.recordingId;
      const target = requested
        ? p.recordings.find((r) => r.id === requested)
        : p.recordings.find(
            (r) => !p.transcripts.some((t) => t.recordingId === r.id),
          );
      if (!target)
        throw new StudioError(
          requested ? "INVALID_INPUT" : "CONFLICT",
          requested
            ? "No imported recording matches that transcript."
            : "Every recording already has a transcript.",
          requested
            ? "Import that recording first, or load the transcript without an explicit target."
            : "Generate the storyboard, or transcribe with the active provider.",
        );
      const transcript = validateTranscript(
        { ...raw, recordingId: target.id },
        target,
      );
      await this.store.artifact(
        p,
        `transcripts/transcript-${hash(transcript).slice(0, 16)}.json`,
        transcript,
      );
      return this.store.update(p.id, (x) => {
        x.transcripts.push(transcript);
      });
    });
  }
  async importFCPTranscripts(
    projectId: string,
    root: string,
    signal?: AbortSignal,
  ) {
    return this.locked(projectId, async (p) => {
      if (p.status !== "MEDIA_IMPORTED")
        throw new StudioError(
          "CONFLICT",
          "Import Final Cut transcripts after media import and before planning.",
        );
      const files = await discoverFCPTranscripts(root);
      if (!files.length)
        throw new StudioError(
          "INVALID_INPUT",
          "No .fcptranscript files found under that path.",
          "Open the library in Final Cut once so speech analysis runs, then retry.",
        );
      const fcps = await Promise.all(files.map((f) => readFCPTranscript(f)));
      const { mapping, fingerprints } = await mapFCPTranscriptsToRecordings(
        fcps,
        p.recordings,
        { projectDir: this.store.dir(p), signal },
      );
      const imported: {
        recording: string;
        phrases: number;
        words: number;
      }[] = [];
      for (const recording of p.recordings) {
        const fcp = mapping.get(recording.id);
        if (!fcp) continue;
        if (p.transcripts.some((t) => t.recordingId === recording.id)) continue;
        const transcript = validateTranscript(
          fcpToTranscriptInput(fcp, recording),
          recording,
        );
        await this.store.artifact(
          p,
          `transcripts/transcript-${hash(transcript).slice(0, 16)}.json`,
          transcript,
        );
        this.store.update(p.id, (x) => {
          x.transcripts.push(transcript);
        });
        imported.push({
          recording: recording.name,
          phrases: transcript.segments.length,
          words: transcript.segments.reduce(
            (n, s) => n + (s.words?.length ?? 0),
            0,
          ),
        });
      }
      this.store.event(p.id, {
        event: "transcript.fcpImported",
        files: files.length,
        recordings: imported.length,
      });
      return {
        discovered: files.length,
        fingerprinted: fingerprints,
        imported,
        unmatched: p.recordings
          .filter(
            (r) =>
              !mapping.has(r.id) &&
              !p.transcripts.some((t) => t.recordingId === r.id),
          )
          .map((r) => r.name),
      };
    });
  }
  /** Sentence-level script↔source timing; deterministic, no model calls. */
  async computeAlignment(projectId: string) {
    const p = this.store.get(projectId);
    const script = p.scripts.at(-1);
    if (!script || !p.scriptApproval)
      throw new StudioError(
        "CONFLICT",
        "Alignment requires an approved script.",
      );
    if (!p.recordings.length)
      throw new StudioError("CONFLICT", "Import A-roll before aligning.");
    const transcripts = p.recordings.map((r) =>
      p.transcripts.findLast((t) => t.recordingId === r.id),
    );
    if (transcripts.some((t) => !t))
      throw new StudioError(
        "CONFLICT",
        "Align after every recording has a transcript.",
      );
    const alignment = alignScript({
      script: script.text,
      scriptVersion: script.version,
      recordings: p.recordings,
      transcripts: transcripts as Transcript[],
    });
    await this.store.artifact(
      p,
      `alignment/alignment-v${script.version}.json`,
      alignment,
    );
    this.store.event(p.id, {
      event: "alignment.computed",
      matched: alignment.stats.matched,
      sentences: alignment.stats.sentences,
    });
    return alignment;
  }
  /** Latest stored alignment for the current script version, if present. */
  alignment(projectId: string): Alignment | null {
    const p = this.store.get(projectId);
    const script = p.scripts.at(-1);
    if (!script) return null;
    try {
      const file = path.join(
        this.store.dir(p),
        "alignment",
        `alignment-v${script.version}.json`,
      );
      const stored = alignmentSchema.parse(
        JSON.parse(readFileSync(file, "utf8")),
      );
      // An alignment from a different matching algorithm is not evidence about
      // this code's take selection; recompute instead of reusing it.
      if (stored.algorithm !== ALIGNMENT_ALGORITHM) return null;
      return stored;
    } catch {
      return null;
    }
  }
  async transcribe(projectId: string, signal?: AbortSignal) {
    return this.locked(projectId, async (p) => {
      if (p.status !== "MEDIA_IMPORTED")
        throw new StudioError("CONFLICT", "Transcribe after media import.");
      const pending = p.recordings.filter(
        (r) => !p.transcripts.some((t) => t.recordingId === r.id),
      );
      if (!pending.length)
        throw new StudioError(
          "CONFLICT",
          "Every recording already has a transcript.",
          "Generate the storyboard, or import another recording first.",
        );
      this.store.update(p.id, (x) => {
        x.status = transition(x.status, "TRANSCRIBING");
      });
      try {
        await this.operation(
          p,
          "transcription",
          `Extract and transcribe ${pending.length} recording${pending.length === 1 ? "" : "s"}`,
          async (signal) => {
            for (const r of pending) {
              const format = this.transcription.audioFormat;
              const audio = await safePath(
                this.store.dir(p),
                `cache/transcription-${r.hash}.${format}`,
              );
              await extractAudio(
                await safePath(this.store.dir(p), r.path),
                audio,
                signal,
                format,
              );
              const result = await this.transcription.transcribe({
                file: audio,
                recording: r,
                signal,
              });
              await this.store.artifact(
                p,
                `transcripts/transcript-${hash(result.output).slice(0, 16)}.json`,
                result.output,
              );
              this.store.update(p.id, (x) => {
                x.transcripts.push(result.output);
                x.usage.push(result.usage);
              });
            }
          },
          signal,
        );
      } finally {
        this.store.update(p.id, (x) => {
          x.status = transition(x.status, "MEDIA_IMPORTED");
        });
      }
      return this.snapshot(p.id);
    });
  }
  async generatePlan(projectId: string, signal?: AbortSignal) {
    return this.locked(projectId, async (p) => {
      const transcripts = p.recordings
        .map((r) => p.transcripts.findLast((t) => t.recordingId === r.id))
        .filter((t): t is Transcript => !!t);
      if (
        !["MEDIA_IMPORTED", "AWAITING_STORYBOARD_APPROVAL"].includes(
          p.status,
        ) ||
        !p.recordings.length ||
        transcripts.length !== p.recordings.length ||
        !p.scriptApproval
      )
        throw new StudioError(
          "CONFLICT",
          "Planning requires an approved script and a transcript for every recording.",
          "Import or transcribe a transcript for each recording, then retry.",
        );
      this.store.update(p.id, (x) => {
        x.status = transition(x.status, "PLANNING");
        x.planApproval = null;
        x.roughCutApproval = null;
      });
      try {
        await this.operation(
          p,
          "director",
          "Director • production plan",
          async (signal) => {
            let alignment: Alignment | null = this.alignment(p.id);
            if (!alignment) {
              try {
                alignment = alignScript({
                  script: p.scripts.at(-1)!.text,
                  scriptVersion: p.scripts.at(-1)!.version,
                  recordings: p.recordings,
                  transcripts,
                });
                await this.store.artifact(
                  p,
                  `alignment/alignment-v${p.scripts.at(-1)!.version}.json`,
                  alignment,
                );
              } catch {
                alignment = null; // Planning still works; the Director times scenes itself.
              }
            }
            const result = await new DirectorAgent(this.provider).plan(
              {
                projectId: p.id,
                script: p.scripts.at(-1)!,
                transcripts,
                recordings: p.recordings,
                creator: p.creator,
                version: p.plans.length + 1,
                targetDuration: p.targetDuration,
                alignment,
              },
              signal,
            );
            await this.store.artifact(
              p,
              `production-plans/plan-v${result.output.version}.json`,
              result.output,
            );
            this.store.update(p.id, (x) => {
              x.plans.push(result.output);
              x.usage.push(result.usage);
              x.status = transition(x.status, "AWAITING_STORYBOARD_APPROVAL");
            });
            this.store.event(p.id, {
              event: "director.planned",
              model: result.usage.model,
              summary: result.output.director.summary,
            });
          },
          signal,
        );
      } catch (e) {
        this.store.update(p.id, (x) => {
          if (x.status === "PLANNING")
            x.status = transition(x.status, "MEDIA_IMPORTED");
        });
        throw e;
      }
      return this.snapshot(p.id);
    });
  }
  /**
   * Import an externally authored plan (human or offline AI direction).
   * It passes the exact validation an in-app Director plan must pass.
   */
  async importPlan(projectId: string, input: unknown, signal?: AbortSignal) {
    return this.locked(projectId, async (p) => {
      const transcripts = p.recordings
        .map((r) => p.transcripts.findLast((t) => t.recordingId === r.id))
        .filter((t): t is Transcript => !!t);
      if (
        !["MEDIA_IMPORTED", "AWAITING_STORYBOARD_APPROVAL"].includes(
          p.status,
        ) ||
        !p.recordings.length ||
        transcripts.length !== p.recordings.length ||
        !p.scriptApproval
      )
        throw new StudioError(
          "CONFLICT",
          "Plan import requires an approved script and a transcript for every recording.",
        );
      const plan = validatePlan(normalizePlan(input));
      if (
        plan.projectId !== p.id ||
        plan.version !== p.plans.length + 1 ||
        plan.scriptVersion !== p.scripts.at(-1)!.version ||
        plan.transcriptHash !== hash(transcripts)
      )
        throw new StudioError(
          "INVALID_PLAN",
          "Imported plan does not match this project's contract (id, next version, script or transcripts).",
          "Regenerate the plan against the current project state.",
        );
      validateSources(plan, p.recordings, p.transcripts);
      await this.operation(
        p,
        "plan-import",
        `Import plan v${plan.version}`,
        async () => {
          await this.store.artifact(
            p,
            `production-plans/plan-v${plan.version}.json`,
            plan,
          );
          this.store.update(p.id, (x) => {
            x.plans.push(plan);
            x.planApproval = null;
            x.roughCutApproval = null;
            x.status = transition(x.status, "AWAITING_STORYBOARD_APPROVAL");
          });
          this.store.event(p.id, {
            event: "plan.imported",
            version: plan.version,
            director: plan.director.provider,
          });
        },
        signal,
      );
      return this.snapshot(p.id);
    });
  }
  /** Draft the deterministic A-roll edit for review; the Director refines it. */
  async draftAroll(projectId: string) {
    const p = this.store.get(projectId);
    const alignment = await this.computeAlignment(projectId);
    return buildEditDecision(
      alignment,
      p.recordings.map((r) =>
        p.transcripts.findLast((t) => t.recordingId === r.id)!,
      ),
    );
  }
  async approvePlan(projectId: string, version: number) {
    return this.locked(projectId, async (p) => {
      const plan = validatePlan(p.plans.at(-1));
      if (
        plan.version !== version ||
        p.status !== "AWAITING_STORYBOARD_APPROVAL"
      )
        throw new StudioError(
          "CONFLICT",
          "Review the current storyboard version.",
        );
      return this.store.update(p.id, (x) => {
        x.planApproval = {
          version,
          hash: hash(plan),
          approvedAt: now(),
          approvedBy: "creator",
        };
        this.store.event(x.id, { event: "storyboard.approved", version });
      });
    });
  }
  async build(projectId: string, signal?: AbortSignal) {
    return buildProject(
      this.store,
      projectId,
      signal,
      (job) => this.notify?.({ event: "job", job }),
      { images: this.images, provider: this.provider },
    );
  }
  async propose(
    projectId: string,
    request: string,
    sceneId: string,
    signal?: AbortSignal,
  ) {
    return this.locked(projectId, async (p) => {
      this.revisionAllowed(p);
      if (!request.trim() || request.length > 10000)
        throw new StudioError(
          "INVALID_INPUT",
          "Describe the requested change in 1–10,000 characters.",
        );
      let patch: PlanPatch | undefined;
      await this.operation(
        p,
        "director-revision",
        "Director • revision proposal",
        async (signal) => {
          const result = await new DirectorAgent(this.provider).revise(
            p.plans.at(-1)!,
            request,
            sceneId,
            signal,
          );
          patch = this.validateProposal(p, result.output);
          this.store.update(p.id, (x) => {
            x.revisions.push({
              patch: patch!,
              status: "PROPOSED",
              decidedAt: null,
            });
            x.usage.push(result.usage);
          });
        },
        signal,
      );
      return patch;
    });
  }
  async proposeOperations(
    projectId: string,
    operations: unknown,
    request: string,
  ) {
    return this.locked(projectId, (p) => {
      this.revisionAllowed(p);
      const ops = z.array(operationSchema).min(1).parse(operations);
      const current = p.plans.at(-1)!;
      const patch = this.validateProposal(p, {
        id: id("patch"),
        createdAt: now(),
        originatingRequest: request,
        rationale:
          "Explicit creator edit; only the listed scene instructions will change.",
        affectedScenes: [
          ...new Set(
            ops.flatMap((o) =>
              o.type === "mergeScenes"
                ? [o.sceneId, o.nextSceneId]
                : "sceneId" in o
                  ? [o.sceneId]
                  : [],
            ),
          ),
        ],
        previousVersion: current.version,
        resultingVersion: current.version + 1,
        operations: ops,
      });
      this.store.update(p.id, (x) => {
        x.revisions.push({ patch, status: "PROPOSED", decidedAt: null });
      });
      return patch;
    });
  }
  /**
   * Surgical range revision: "3:42–4:10 is boring, illustrate the failover"
   * becomes a scoped patch over exactly the scenes in that timeline range.
   * Deterministic intent parsing; an OpenAI Director refines when configured.
   */
  async proposeRange(
    projectId: string,
    rangeText: string,
    request: string,
    signal?: AbortSignal,
  ) {
    return this.locked(projectId, async (p) => {
      this.revisionAllowed(p);
      const range = parseTimeRange(rangeText);
      if (!range)
        throw new StudioError(
          "INVALID_INPUT",
          "Use a timeline range like 3:42-4:10 or 222-260 (seconds).",
        );
      const plan = validatePlan(p.plans.at(-1));
      const fps = plan.frameRate;
      const [from, to] = range;
      const overlapping = plan.scenes.filter(
        (s) =>
          s.startFrame / fps < to &&
          (s.startFrame + s.durationFrames) / fps > from,
      );
      if (!overlapping.length)
        throw new StudioError(
          "INVALID_INPUT",
          `No scenes fall inside ${rangeText} on the current timeline.`,
        );
      const intent = parseIntent(request);
      // "Keep my A-roll for the first sentence, then illustrate the rest":
      // split the first scene at its first sentence boundary so the head stays
      // presenter footage and the tail carries the visual; later scenes get
      // visuals outright.
      const compound =
        intent.keepPresenter &&
        intent.illustrate &&
        /first|then|after that/i.test(request);
      const transcriptsByRecording = new Map<string, Transcript>();
      for (const t of p.transcripts)
        transcriptsByRecording.set(t.recordingId, t);
      /** Scene-relative frame where the scene's second transcript segment starts. */
      const firstSentenceSplit = (scene: (typeof plan)["scenes"][number]) => {
        const transcript = transcriptsByRecording.get(scene.camera.recordingId);
        if (!transcript || scene.transcriptSegmentIds.length < 2) return null;
        const byId = new Map(transcript.segments.map((s) => [s.id, s]));
        const segs = scene.transcriptSegmentIds
          .map((id) => byId.get(id))
          .filter((s): s is Transcript["segments"][number] => !!s)
          .sort((a, b) => a.start - b.start);
        if (segs.length < 2) return null;
        const atFrame = Math.round(segs[1].start * fps) - scene.sourceInFrame;
        if (atFrame < 24 || atFrame > scene.durationFrames - 24) return null;
        return atFrame;
      };
      /**
       * Audience-facing copy comes from the narration, never from the creator's
       * revision instruction.
       */
      const narratedTitle = (narration: string): string | null => {
        const first = (narration.split(/(?<=\.)\s/)[0] ?? "").trim();
        const t = first.slice(0, 100).trim();
        return t.length >= 3 ? t : null;
      };
      const illustrateGraphic = (
        scene: (typeof plan)["scenes"][number],
      ): Graphic => {
        const suggestion = suggestGraphic(
          scene.narration,
          scene.chapterTitle ?? null,
        );
        if (suggestion)
          return {
            engine: "remotion",
            template: suggestion.template,
            templateVersion: "1.0.0",
            parameters: suggestion.parameters,
          } as Graphic;
        const title = narratedTitle(scene.narration);
        if (!title)
          throw new StudioError(
            "INVALID_INPUT",
            `No audience-facing copy could be derived from ${scene.id}'s narration; name the graphic content explicitly.`,
          );
        return {
          engine: "remotion",
          template: "Callout",
          templateVersion: "1.0.0",
          parameters: { title, subtitle: "" },
        };
      };
      const operations: import("../../production-plan/src/index.ts").Operation[] =
        [];
      let compoundNote = "";
      for (const scene of overlapping) {
        const keepPresenter =
          intent.keepPresenter && (!compound || scene === overlapping[0]);
        if (intent.chapter && scene === overlapping[0]) {
          operations.push({
            type: "updateChapterTitle",
            sceneId: scene.id,
            chapterTitle: intent.chapter,
          });
          continue;
        }
        if (compound && scene === overlapping[0]) {
          const atFrame = firstSentenceSplit(scene);
          if (atFrame !== null) {
            const tailId = `${scene.id}-b`;
            if (scene.visual.graphic)
              operations.push({
                type: "removeGraphic",
                sceneId: scene.id,
              });
            operations.push({
              type: "splitScene",
              sceneId: scene.id,
              atFrame,
              newSceneId: tailId,
            });
            operations.push({
              type: "replaceVisual",
              sceneId: tailId,
              visual: {
                type: "graphic",
                description: `Range revision: ${request.slice(0, 200)}`,
                graphic: illustrateGraphic(scene),
              },
            });
            compoundNote = ` ${scene.id} was split at its first sentence boundary so the opening stays on camera.`;
            continue;
          }
          compoundNote =
            " No sentence boundary was computable inside the first scene, so the whole first scene stays on camera.";
        }
        if (keepPresenter) {
          if (scene.visual.graphic)
            operations.push({ type: "removeGraphic", sceneId: scene.id });
          continue;
        }
        if (intent.broll && scene.visual.type === "presenter") {
          const hook = (scene.narration.split(/(?<=\.)\s/)[0] || request).slice(
            0,
            300,
          );
          if (hook.trim().length >= 3 && scene.durationFrames >= 60) {
            const startFrame = Math.min(
              24,
              Math.floor(scene.durationFrames * 0.25),
            );
            operations.push({
              type: "setBroll",
              sceneId: scene.id,
              broll: [
                {
                  id: `broll-${scene.id}`,
                  startFrame,
                  durationFrames: Math.max(
                    24,
                    Math.min(
                      Math.floor(scene.durationFrames * 0.6),
                      scene.durationFrames - startFrame,
                    ),
                  ),
                  placement: "inset",
                  inset: { x: 0.55, y: 0.5, width: 0.38 },
                  motion: "zoom-in",
                  asset: {
                    engine: "gpt-image",
                    template: "GeneratedStill",
                    templateVersion: "1.0.0",
                    parameters: {
                      brief: `Illustrate the narration: ${hook}`.slice(0, 600),
                      style: "technical-illustration",
                      palette: null,
                      avoid: "text, watermarks, distorted geometry",
                      quality: "low",
                      expectsText: false,
                    },
                  },
                  narrationHook: hook,
                },
              ],
            });
            continue;
          }
        }
        if (intent.illustrate) {
          if (scene.visual.type === "graphic") continue;
          operations.push({
            type: "replaceVisual",
            sceneId: scene.id,
            visual: {
              type: "graphic",
              description: `Range revision: ${request.slice(0, 200)}`,
              graphic: illustrateGraphic(scene),
            },
          });
          continue;
        }
        if (intent.punch && scene.camera.punchIn < 1.05)
          operations.push({
            type: "updateFraming",
            sceneId: scene.id,
            framing: "close",
            punchIn: 1.12,
          });
      }
      if (!operations.length)
        throw new StudioError(
          "INVALID_INPUT",
          "The request asks for no change in that range. Try “keep my A-roll”, “illustrate …”, “chapter: …” or “punch in”.",
        );
      void signal;
      const current = p.plans.at(-1)!;
      const patch: PlanPatch = {
        id: id("patch"),
        createdAt: now(),
        originatingRequest: `Range ${rangeText}: ${request}`,
        rationale: `Scoped range revision over ${rangeText}; only the listed scene instructions change.${compoundNote}`,
        affectedScenes: [
          ...new Set(
            operations.flatMap((o) =>
              "sceneId" in o ? [o.sceneId as string] : [],
            ),
          ),
        ],
        previousVersion: current.version,
        resultingVersion: current.version + 1,
        operations,
      };
      this.validateProposal(p, patch);
      this.store.update(p.id, (x) => {
        x.revisions.push({ patch, status: "PROPOSED", decidedAt: null });
      });
      return patch;
    });
  }
  /**
   * Visual-direction pass: decide whether the video needs generated B-roll,
   * music or SFX, what each treatment communicates, where it belongs and how
   * long it lasts — then propose it as a patch through the human gate.
   */
  async proposeVisualPass(projectId: string, signal?: AbortSignal) {
    return this.locked(projectId, async (p) => {
      this.revisionAllowed(p);
      const plan = validatePlan(p.plans.at(-1));
      const library = await readLibrary(this.store.root);
      const capabilities = engineCapabilities(this.images, library);
      const visualCapabilities: VisualPassCapabilities = {
        "gpt-image": capabilities["gpt-image"],
        blender: null,
        musicTracks: library.tracks
          .filter((t) => t.kind === "music")
          .map((t) => ({
            trackId: t.trackId,
            title: t.title,
            mood: t.mood,
            energy: t.energy,
            bpm: t.bpm,
            loopable: t.loopable,
            duration: t.duration,
          })),
        sfxTracks: library.tracks
          .filter((t) => t.kind === "sfx")
          .map((t) => ({
            trackId: t.trackId,
            title: t.title,
            duration: t.duration,
          })),
      };
      const budget = {
        maxGeneratedStills: Math.max(
          1,
          Number(process.env.WTS_IMAGE_BUDGET) || 8,
        ),
      };
      let patch: PlanPatch | undefined;
      await this.operation(
        p,
        "visual-pass",
        "Visual direction • B-roll, music and SFX",
        async (signal) => {
          const result = await new VisualPassAgent(this.provider).propose(
            {
              plan,
              capabilities: visualCapabilities,
              budget,
              creator: p.creator,
            },
            signal,
          );
          const pass = result.output;
          const total = pass.treatments.reduce((n, t) => n + t.broll.length, 0);
          if (total > budget.maxGeneratedStills)
            throw new StudioError(
              "INVALID_PLAN",
              `Visual pass proposed ${total} generated stills against a budget of ${budget.maxGeneratedStills}.`,
              "Raise WTS_IMAGE_BUDGET or retry the pass.",
              true,
            );
          const operations: Operation[] = pass.treatments
            .filter((t) => t.broll.length)
            .map((t) => ({
              type: "setBroll" as const,
              sceneId: t.sceneId,
              broll: t.broll,
            }));
          operations.push({
            type: "setAudioDesign",
            audioDesign: { music: pass.music, sfx: pass.sfx },
          });
          const proposal: PlanPatch = {
            id: id("patch"),
            createdAt: now(),
            originatingRequest: `Visual direction pass (${result.usage.provider}/${result.usage.model})`,
            rationale: pass.summary,
            affectedScenes: [
              ...new Set(
                operations.flatMap((o) =>
                  "sceneId" in o ? [o.sceneId as string] : [],
                ),
              ),
            ],
            previousVersion: plan.version,
            resultingVersion: plan.version + 1,
            operations,
          };
          // Fail closed before approval: engines must be configured and the
          // audio design must resolve in the creator's library.
          const next = applyPatch(plan, this.validateProposal(p, proposal));
          validateEngines(next, this.images);
          validateAudioDesign(next, trackRefs(library.tracks));
          this.store.update(p.id, (x) => {
            x.usage.push(result.usage);
          });
          patch = proposal;
        },
        signal,
      );
      this.store.update(p.id, (x) => {
        x.revisions.push({
          patch: patch!,
          status: "PROPOSED",
          decidedAt: null,
        });
      });
      return patch!;
    });
  }
  private revisionAllowed(p: Project) {
    if (
      ![
        "AWAITING_STORYBOARD_APPROVAL",
        "AWAITING_ROUGH_CUT_APPROVAL",
        "READY_TO_RENDER",
        "AWAITING_PUBLISH_APPROVAL",
      ].includes(p.status) ||
      !p.plans.length
    )
      throw new StudioError(
        "CONFLICT",
        "Revisions are available after planning and when production is idle.",
      );
  }
  private validateProposal(p: Project, input: unknown) {
    const patch = patchSchema.parse(input);
    const next = applyPatch(p.plans.at(-1)!, patch);
    validateSources(next, p.recordings, p.transcripts);
    return patch;
  }
  async decidePatch(projectId: string, patchId: string, apply: boolean) {
    return this.locked(projectId, async (p) => {
      this.revisionAllowed(p);
      const proposal = p.revisions.find((r) => r.patch.id === patchId);
      if (!proposal || proposal.status !== "PROPOSED")
        throw new StudioError("CONFLICT", "Proposal is no longer pending.");
      let next: ProductionPlan | undefined;
      if (apply) {
        this.validateProposal(p, proposal.patch);
        next = applyPatch(p.plans.at(-1)!, proposal.patch);
        await this.store.artifact(
          p,
          `production-plans/plan-v${next.version}.json`,
          next,
        );
        await this.store.artifact(
          p,
          `production-plans/${proposal.patch.id}.json`,
          proposal.patch,
        );
      }
      return this.store.update(p.id, (x) => {
        const r = x.revisions.find((r) => r.patch.id === patchId)!;
        r.status = apply ? "APPLIED" : "REJECTED";
        r.decidedAt = now();
        if (next) {
          x.status = transition(x.status, "REVISING");
          x.plans.push(next);
          x.planApproval = null;
          x.roughCutApproval = null;
          x.finalRender = null;
          x.publishApproval = null;
          x.status = transition(x.status, "AWAITING_STORYBOARD_APPROVAL");
        }
        this.store.event(p.id, {
          event: apply ? "patch.applied" : "patch.rejected",
          patchId,
        });
      });
    });
  }
  async undo(projectId: string) {
    return this.locked(projectId, async (p) => {
      this.revisionAllowed(p);
      if (p.plans.length < 2)
        throw new StudioError(
          "CONFLICT",
          "There is no earlier production plan.",
        );
      const previous = p.plans.at(-2)!;
      const next = {
        ...structuredClone(previous),
        version: p.plans.at(-1)!.version + 1,
        createdAt: now(),
      };
      await this.store.artifact(
        p,
        `production-plans/plan-v${next.version}.json`,
        next,
      );
      return this.store.update(p.id, (x) => {
        x.status = transition(x.status, "REVISING");
        x.plans.push(next);
        x.planApproval = null;
        x.roughCutApproval = null;
        x.finalRender = null;
        x.publishApproval = null;
        x.status = transition(x.status, "AWAITING_STORYBOARD_APPROVAL");
        this.store.event(p.id, {
          event: "plan.undo",
          restoredVersion: previous.version,
          newVersion: next.version,
        });
      });
    });
  }
  async approveRoughCut(projectId: string, version: number) {
    return this.locked(projectId, async (p) => {
      const plan = p.plans.at(-1)!;
      if (
        plan.version !== version ||
        !p.builds.some((b) => b.planVersion === version)
      )
        throw new StudioError(
          "CONFLICT",
          "Review the current completed rough cut first.",
        );
      const build = p.builds.findLast((b) => b.planVersion === version)!;
      const previewHash = await fileHash(
        await safePath(this.store.dir(p), build.previewPath),
      );
      return this.store.update(p.id, (x) => {
        x.status = transition(x.status, "READY_TO_RENDER");
        x.roughCutApproval = {
          version,
          hash: previewHash,
          approvedAt: now(),
          approvedBy: "creator",
        };
        this.store.event(x.id, { event: "roughCut.approved", version });
      });
    });
  }
  /**
   * Headless finishing through Resolve: import the current timeline, apply an
   * optional checked-in Fusion macro, and render with a validated preset.
   */
  async renderFinal(
    projectId: string,
    options: {
      preset?: (typeof FINAL_RENDER_PRESETS)[number];
      macroId?: string;
      signal?: AbortSignal;
    } = {},
  ) {
    return this.locked(projectId, async (p) => {
      if (!["READY_TO_RENDER", "AWAITING_PUBLISH_APPROVAL"].includes(p.status))
        throw new StudioError(
          "CONFLICT",
          "Approve the rough cut before finishing.",
        );
      const plan = validatePlan(p.plans.at(-1));
      const build = p.builds.findLast((b) => b.planVersion === plan.version);
      if (!build)
        throw new StudioError("CONFLICT", "Build the current plan first.");
      const preset = options.preset ?? "H.264 Master";
      if (!(FINAL_RENDER_PRESETS as readonly string[]).includes(preset))
        throw new StudioError(
          "INVALID_INPUT",
          `Unknown render preset. Choose one of: ${FINAL_RENDER_PRESETS.join(", ")}.`,
        );
      const dir = this.store.dir(p);
      const slug =
        preset.replace(/[^a-z0-9]+/gi, "") +
        (options.macroId ? `-${options.macroId}` : "");
      const output = await safePath(
        dir,
        `renders/final-v${plan.version}-${slug}.mp4`,
      );
      let produced: string | null = null;
      await this.operation(
        p,
        "final-render",
        `Resolve • final render (${preset}${options.macroId ? ` + ${options.macroId}` : ""})`,
        async (signal) => {
          const result = await resolveCommand(
            "render",
            await safePath(dir, build.exportPath),
            `WTS Final ${p.title.slice(0, 60)} ${plan.version} ${Date.now()}`,
            output,
            preset,
            options.macroId,
            signal ?? options.signal,
          );
          if (!result.available)
            throw new StudioError(
              "EXTERNAL_TOOL",
              result.reason ?? "Resolve is unavailable for final rendering.",
              "Check Resolve and its render queue, then retry.",
              true,
            );
          if (!result.output)
            throw new StudioError(
              "EXTERNAL_TOOL",
              `Resolve render did not produce ${path.basename(output)} (status ${result.renderStatus ?? "unknown"}).`,
              "Check the Resolve render queue, then retry.",
              true,
            );
          await verifyOutput(
            result.output,
            plan.durationFrames / plan.frameRate,
            signal,
          );
          produced = result.output;
        },
        options.signal,
      );
      const relative = produced!
        ? path.relative(dir, produced!)
        : `renders/final-v${plan.version}-${slug}.mp4`;
      return this.store.update(p.id, (x) => {
        x.finalRender = relative;
        this.store.event(p.id, {
          event: "final.rendered",
          planVersion: plan.version,
          preset,
          macro: options.macroId ?? null,
        });
      });
    });
  }
  // ---------------------------------------------------------------------
  // Milestone 5 — packaging and publishing: the final render is packaged
  // (titles, thumbnail concepts, description with chapter timestamps,
  // metadata), the packaging document is approved by the creator, and only
  // then does a local YouTube CLI upload it.
  // ---------------------------------------------------------------------

  /** Packaging agent: one versioned publication proposal for the final render. */
  async packageVideo(projectId: string, signal?: AbortSignal) {
    return this.locked(projectId, async (p) => {
      if (
        !["READY_TO_RENDER", "AWAITING_PUBLISH_APPROVAL"].includes(p.status) ||
        !p.finalRender
      )
        throw new StudioError(
          "CONFLICT",
          "Packaging needs a completed final render.",
          "Approve the rough cut and run the final render first.",
        );
      const plan = validatePlan(p.plans.at(-1));
      const chapters = planChapters(plan);
      const thesis = this.videoThesis(p);
      const version = (p.packaging?.version ?? 0) + 1;
      let output: VideoPackaging | undefined;
      await this.operation(
        p,
        "packaging",
        `Packaging Agent • package v${version}`,
        async (signal) => {
          const result = await new PackagingAgent(this.provider).package(
            {
              projectId: p.id,
              videoTitle: p.title,
              thesis,
              chapters,
              finalSeconds: Math.round(plan.durationFrames / plan.frameRate),
              sources: p.research.sources.map((s) => ({
                url: s.url,
                title: s.title,
              })),
              creator: p.creator,
            },
            signal,
          );
          output = result.output;
          await this.store.artifact(
            p,
            `packaging/packaging-v${version}.json`,
            output,
          );
          this.store.update(p.id, (x) => {
            x.packaging ??= { version: null };
            x.packaging.version = version;
            x.publishApproval = null;
            x.usage.push(result.usage);
            if (x.status === "READY_TO_RENDER")
              x.status = transition(x.status, "AWAITING_PUBLISH_APPROVAL");
          });
          this.store.event(p.id, {
            event: "packaging.completed",
            version,
            title: recommendedTitle(output),
            chapters: output.chapters.length,
            model: result.usage.model,
          });
        },
        signal,
      );
      return {
        snapshot: this.snapshot(p.id),
        packaging: output!,
        description: renderDescription(output!),
      };
    });
  }
  /** The publication gate: approval binds to the exact packaging document. */
  async approvePackaging(projectId: string, version: number) {
    return this.locked(projectId, async (p) => {
      if (
        p.status !== "AWAITING_PUBLISH_APPROVAL" ||
        p.packaging?.version !== version
      )
        throw new StudioError(
          "CONFLICT",
          "Review the current packaging version.",
        );
      const doc = await this.loadPackagingDocument(p, version);
      return this.store.update(p.id, (x) => {
        x.publishApproval = {
          version,
          hash: hash(doc),
          approvedAt: now(),
          approvedBy: "creator",
        };
        this.store.event(x.id, { event: "packaging.approved", version });
      });
    });
  }
  /** Upload the approved package through the local YouTube CLI. One-shot. */
  async publish(projectId: string, signal?: AbortSignal) {
    return this.locked(projectId, async (p) => {
      if (p.publication)
        throw new StudioError(
          "CONFLICT",
          `This video is already published as ${p.publication.videoId}.`,
        );
      if (p.status !== "AWAITING_PUBLISH_APPROVAL" || !p.finalRender)
        throw new StudioError(
          "CONFLICT",
          "Publishing follows an approved packaging of the final render.",
          "Approve the rough cut, render the final, package it, then approve the packaging.",
        );
      if (!p.publishApproval)
        throw new StudioError(
          "CONFLICT",
          "Approve the packaging before publishing.",
          "Review titles, description, chapters and metadata, then approve.",
        );
      const version = p.publishApproval.version;
      const doc = await this.loadPackagingDocument(p, version);
      if (hash(doc) !== p.publishApproval.hash)
        throw new StudioError(
          "CONFLICT",
          "The packaging document changed after approval.",
          "Re-review and approve the current packaging version.",
        );
      const video = await safePath(this.store.dir(p), p.finalRender);
      if (!(await stat(video)).isFile())
        throw new StudioError(
          "CONFLICT",
          "The final render file is missing from the project directory.",
          "Re-run the final render, then publish again.",
        );
      const meta = {
        title: recommendedTitle(doc),
        description: renderDescription(doc),
        tags: doc.metadata.tags,
        categoryId: doc.metadata.categoryId,
        privacyStatus: doc.metadata.visibility,
      };
      const metaFile = await safePath(
        this.store.dir(p),
        `packaging/upload-meta-v${version}.json`,
      );
      await this.store.artifact(
        p,
        `packaging/upload-meta-v${version}.json`,
        meta,
      );
      let result;
      await this.operation(
        p,
        "publish",
        `Publish • YouTube (${meta.privacyStatus})`,
        async (signal) => {
          result = await publishToYouTube({
            video,
            metaFile,
            extraArgs: (process.env.WTS_YOUTUBE_ARGS ?? "")
              .split(/\s+/)
              .filter(Boolean),
            signal,
          });
        },
        signal,
      );
      return this.store.update(p.id, (x) => {
        x.status = transition(x.status, "PUBLISHED");
        x.publication = {
          videoId: result!.videoId,
          url: result!.url,
          publishedAt: now(),
        };
        this.store.event(x.id, {
          event: "video.published",
          videoId: result!.videoId,
          visibility: meta.privacyStatus,
          cli: result!.cli,
          packagingVersion: version,
        });
      });
    });
  }
  /** Latest packaging document and its assembled description, or null. */
  packagingDocument(projectId: string) {
    const p = this.store.get(projectId);
    const version = p.packaging?.version;
    if (!version) return null;
    try {
      const file = path.join(
        this.store.dir(p),
        "packaging",
        `packaging-v${version}.json`,
      );
      const doc = packagingSchema.parse(JSON.parse(readFileSync(file, "utf8")));
      return { version, packaging: doc, description: renderDescription(doc) };
    } catch {
      return null;
    }
  }
  private async loadPackagingDocument(p: Project, version: number) {
    try {
      const file = path.join(
        this.store.dir(p),
        "packaging",
        `packaging-v${version}.json`,
      );
      return packagingSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    } catch {
      throw new StudioError(
        "CONFLICT",
        `Packaging document v${version} is missing or unreadable.`,
        "Re-run the packaging agent.",
      );
    }
  }
  /** The thesis line for packaging: the drafted script's, else the idea. */
  private videoThesis(p: Project): string {
    const script = p.scripts.at(-1);
    if (script && p.preproduction?.scriptDocVersion === script.version) {
      try {
        const file = path.join(
          this.store.dir(p),
          "scripts",
          `script-doc-v${script.version}.json`,
        );
        const doc = JSON.parse(readFileSync(file, "utf8")) as {
          thesis?: string;
        };
        if (doc.thesis?.trim()) return doc.thesis;
      } catch {
        /* Hand-edited scripts fall back to the description. */
      }
    }
    return p.description.trim() || p.title;
  }
  addPreference(text: string) {
    if (!text.trim() || text.length > 1000)
      throw new StudioError(
        "INVALID_INPUT",
        "Preference must be between 1 and 1,000 characters.",
      );
    const p = this.store.creator();
    p.preferences.push({
      id: id("preference"),
      text,
      source: "explicit",
      createdAt: now(),
    });
    this.store.setCreator(p);
    return p;
  }
  setCreator(profile: CreatorProfile) {
    const parsed = z
      .strictObject({
        name: z.string().min(1).max(100),
        channel: z.string().min(1).max(100),
        format: z.string().max(300),
        targetMinutes: z.tuple([z.number().positive(), z.number().positive()]),
        subjects: z.array(z.string().max(100)),
        brand: z.strictObject({
          background: z.string().regex(/^#[a-fA-F0-9]{6}$/),
          foreground: z.string().regex(/^#[a-fA-F0-9]{6}$/),
          accent: z.string().regex(/^#[a-fA-F0-9]{6}$/),
          fontFamily: z.string().min(1).max(100),
        }),
        preferences: z.array(
          z.strictObject({
            id: z.string(),
            text: z.string().max(1000),
            source: z.literal("explicit"),
            createdAt: z.iso.datetime(),
          }),
        ),
      })
      .parse(profile);
    this.store.setCreator(parsed);
    return parsed;
  }
}
export async function readJSONFile(file: string) {
  if ((await stat(file)).size > 10_000_000)
    throw new StudioError("INVALID_INPUT", "JSON input exceeds 10 MB.");
  return JSON.parse(await readFile(file, "utf8")) as unknown;
}
/** Pre-production tracker for projects created before Milestone 4. */
function emptyPreproduction(): Project["preproduction"] {
  return {
    researchVersion: null,
    narrativeVersion: null,
    scriptDocVersion: null,
    previsualization: null,
  };
}
const parseClock = (value: string): number | null => {
  const t = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(t)) return Number(t);
  const mm = /^(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(t);
  if (mm) return Number(mm[1]) * 60 + Number(mm[2]);
  const hh = /^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(t);
  if (hh) return Number(hh[1]) * 3600 + Number(hh[2]) * 60 + Number(hh[3]);
  return null;
};
/** Accepts 3:42-4:10, 3:42–4:10, "3:42 to 4:10" and plain seconds. */
export function parseTimeRange(text: string): [number, number] | null {
  const parts = text.split(/\s*(?:-|–|—|\bto\b)\s*/i);
  if (parts.length !== 2) return null;
  const a = parseClock(parts[0]);
  const b = parseClock(parts[1]);
  if (a === null || b === null || b <= a || b - a > 3600) return null;
  return [a, b];
}
function parseIntent(request: string) {
  const chapterMatch = /chapter\s*[:\-]\s*(.{1,120})/i.exec(request);
  return {
    keepPresenter:
      /\bkeep (my |the )?(a-?roll|presenter|talking head|me|face)\b/i.test(
        request,
      ),
    illustrate:
      /\b(illustrate|visuali[sz]e|diagram|graphic|show|animate|draw|explain with)\b/i.test(
        request,
      ),
    punch: /\b(punch in|zoom in|tighter)\b/i.test(request),
    broll: /\bb-?roll\b|\bgenerated (image|still)\b/i.test(request),
    chapter: chapterMatch ? chapterMatch[1].trim().slice(0, 120) : null,
  };
}
export type ProjectSnapshot = ReturnType<Studio["snapshot"]>;
export type JobUpdate = { event: "job"; job: Job };
