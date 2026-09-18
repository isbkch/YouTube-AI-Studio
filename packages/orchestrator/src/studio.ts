import { readFileSync } from "node:fs";
import { copyFile, readFile, rm, stat } from "node:fs/promises";
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
  asAudioPolish,
  asCaptionStyle,
  asDirectorPersona,
  asSilenceTightening,
  asVisualDensity,
  DIRECTOR_PROFILES,
  type AudioPolish,
  type CaptionStyle,
  type CreatorProfile,
  type DirectorId,
  type SilenceTightening,
  type VisualDensity,
} from "../../shared/src/index.ts";
import { costSummary } from "../../shared/src/costs.ts";
import {
  importRecording,
  inspect,
  verifyOutput,
} from "../../media/src/index.ts";
import {
  MockImageProvider,
  GeminiImageProvider,
  type ImageProvider,
} from "../../image-engine/src/index.ts";
import {
  renderThumbnail,
  type ThumbnailRenderer,
} from "../../remotion-engine/src/thumbnail.ts";
import {
  Thumbnails,
  thumbnailState,
  verifiedThumbnailSelection,
  interruptedThumbnails,
} from "./thumbnails.ts";
import type { MusicProvider } from "../../music-engine/src/index.ts";
import {
  RealBlenderProvider,
  type BlenderProvider,
} from "../../blender-engine/src/index.ts";
import {
  FINAL_RENDER_PRESETS,
  resolveCommand,
} from "../../resolve-engine/src/index.ts";
import { Store } from "./store.ts";
import {
  transition,
  type ProducerReview,
  type Project,
  type Job,
  type ResolveMarkerReview,
  type Transcript,
} from "./model.ts";
import { buildProject } from "./build.ts";
import { renderStoryboardPreviews } from "./previews.ts";
import { JobGraph } from "./jobs.ts";
import { engineCapabilities, validateEngines } from "./engines.ts";
import { publishToYouTube } from "./youtube.ts";
import { readLibrary, trackRefs } from "./library.ts";
import { builtinSfxTrack, builtinSfxTracks } from "./sfx.ts";
import {
  ALIGNMENT_ALGORITHM,
  alignScript,
  alignmentSchema,
  splitScriptSentences,
  type Alignment,
} from "./alignment.ts";
import {
  latestTranscripts,
  rememberTranscripts,
  requireReviewedTranscripts,
  transcriptsForPlan,
} from "./transcript-history.ts";
import {
  transcribeRecording,
  decideTranscriptIssue,
  correctTranscriptIssue,
  requireTranscriptIdle,
} from "./transcription.ts";
import { reviewRetakes } from "./retakes.ts";
import { buildEditDecision, suggestGraphic } from "./aroll.ts";
import { computeCaptionEvents } from "./captions.ts";
import {
  reviewRoughCut,
  reviewStoryboard,
  type TighteningStats,
} from "./producer.ts";
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
  public thumbnailRenderer: ThumbnailRenderer = renderThumbnail;
  /** Music-bed generation engine; null restricts beds to library tracks. */
  public music: MusicProvider | null = null;
  /** 3D B-roll engine; probed lazily, injectable for tests (ADR 008). */
  public blender: BlenderProvider | null = null;
  private blenderProbed = false;
  /** Projects with a Producer advance currently in flight. */
  private advancing = new Set<string>();
  async blenderEngine(): Promise<BlenderProvider | null> {
    if (this.blender) return this.blender;
    if (!this.blenderProbed) {
      this.blenderProbed = true;
      this.blender = await RealBlenderProvider.create();
    }
    return this.blender;
  }
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
    const sentences = splitScriptSentences(p.scripts.at(-1)?.text ?? "").map(
      (s) => s.text,
    );
    return {
      ...p,
      transcriptHistory: undefined,
      transcripts: latestTranscripts(p).map((t) => ({
        ...t,
        retakeReview: reviewRetakes(t, sentences),
      })),
      directory: this.store.dir(p),
      jobs: this.store.jobs(p.id),
      assets: this.store.assets(p.id),
      events: this.store.events(p.id),
      costs: costSummary(p.usage),
    };
  }
  /** Project documents with their cost summary, for list views. */
  listProjects() {
    return this.store
      .list()
      .map((p) => ({ ...p, costs: costSummary(p.usage) }));
  }
  /**
   * Cost estimate for one project plus library-wide totals. Pure traversal of
   * recorded usage rows priced against the current table — nothing here calls
   * a provider, and unpriced models are reported rather than hidden.
   */
  costs(projectId: string) {
    const projects = this.store.list();
    const productions = projects.map((p) => ({
      id: p.id,
      title: p.title,
      costs: costSummary(p.usage),
    }));
    return {
      project:
        productions.find((s) => s.id === projectId)?.costs ?? costSummary([]),
      productions,
      library: costSummary(projects.flatMap((p) => p.usage)),
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
      if (p.thumbnails)
        this.store.update(p.id, (x) =>
          interruptedThumbnails(x.thumbnails!.current),
        );
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
  /**
   * Delete a project's workspace and database rows. Original footage is never
   * touched: import copies files into the project, so the files the creator
   * imported from live outside the library and stay exactly where they were.
   * Everything inside `projects/<slug>/` — including the imported recording
   * copies, proxies, plans and renders — is removed, and a live owner's lock
   * is never bypassed.
   */
  async deleteProject(projectId: string) {
    return this.locked(projectId, async (p) => {
      const recordingsRemoved = p.recordings.length;
      await rm(this.store.dir(p), { recursive: true, force: true });
      this.store.delete(p.id);
      return {
        id: p.id,
        title: p.title,
        slug: p.slug,
        status: p.status,
        recordingsRemoved,
      };
    });
  }
  private async operation(
    p: Project,
    type: string,
    label: string,
    fn: (signal: AbortSignal, jobId: string) => Promise<void>,
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
          run: (ctx) => fn(ctx.signal, ctx.jobId),
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
      if (
        stored.algorithm !== ALIGNMENT_ALGORITHM ||
        stored.transcriptHash !== hash(latestTranscripts(p))
      )
        return null;
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
              await transcribeRecording(
                this.store,
                p,
                r,
                this.transcription,
                signal,
                (message) =>
                  this.notify?.({
                    event: "transcription.progress",
                    message,
                    recordingId: r.id,
                  }),
              );
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
  async reviewTranscription(
    projectId: string,
    recordingId?: string,
    signal?: AbortSignal,
  ) {
    return this.locked(projectId, async (p) => {
      requireTranscriptIdle(p);
      if (this.transcription.name !== "openai")
        throw new StudioError(
          "CONFLICT",
          "Select GPT Transcribe in Settings before running an audio review.",
        );
      const recordings = p.recordings.filter(
        (r) => !recordingId || r.id === recordingId,
      );
      if (!recordings.length)
        throw new StudioError(
          "INVALID_INPUT",
          "No matching recordings to review.",
        );
      await this.operation(
        p,
        "transcription-review",
        `Transcribe and review ${recordings.length} recording(s)`,
        async (signal) => {
          for (const r of recordings)
            await transcribeRecording(
              this.store,
              p,
              r,
              this.transcription,
              signal,
              (message) =>
                this.notify?.({
                  event: "transcription.progress",
                  message,
                  recordingId: r.id,
                }),
            );
        },
        signal,
      );
      return this.snapshot(p.id);
    });
  }
  async decideTranscriptIssue(
    projectId: string,
    input: Parameters<typeof decideTranscriptIssue>[2],
  ) {
    return this.locked(projectId, async (p) => {
      await decideTranscriptIssue(this.store, p, input);
      return this.snapshot(p.id);
    });
  }
  async correctTranscriptIssue(
    projectId: string,
    input: Parameters<typeof correctTranscriptIssue>[2],
    signal?: AbortSignal,
  ) {
    return this.locked(projectId, async (p) => {
      await this.operation(
        p,
        "transcript-correction",
        "Align creator correction",
        async (signal) => {
          await correctTranscriptIssue(this.store, p, input, signal);
        },
        signal,
      );
      return this.snapshot(p.id);
    });
  }
  async generatePlan(
    projectId: string,
    options: {
      director?: DirectorId;
      density?: VisualDensity;
      tightening?: SilenceTightening;
      captions?: CaptionStyle;
      polish?: AudioPolish;
      fromReviewedTranscripts?: boolean;
    } = {},
    signal?: AbortSignal,
  ) {
    const result = await this.locked(projectId, async (p) => {
      requireReviewedTranscripts(p);
      if (options.fromReviewedTranscripts) requireTranscriptIdle(p);
      // The hired director owns the defaults: its persona resolves the density,
      // tightening, caption style and audio polish this plan is directed at.
      // Explicit options still override individual knobs for advanced calls;
      // the plan records whichever values were used.
      const director = asDirectorPersona(
        options.director ?? p.creator.director,
      );
      const style = DIRECTOR_PROFILES[director];
      const density = asVisualDensity(options.density ?? style.visualDensity);
      const tightening = asSilenceTightening(
        options.tightening ?? style.silenceTightening,
      );
      const captions = asCaptionStyle(options.captions ?? style.captionStyle);
      const polish = asAudioPolish(options.polish ?? style.audioPolish);
      const transcripts = p.recordings
        .map((r) => p.transcripts.findLast((t) => t.recordingId === r.id))
        .filter((t): t is Transcript => !!t);
      if (
        (!["MEDIA_IMPORTED", "AWAITING_STORYBOARD_APPROVAL"].includes(
          p.status,
        ) &&
          !options.fromReviewedTranscripts) ||
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
        rememberTranscripts(x);
        x.status = options.fromReviewedTranscripts
          ? "PLANNING"
          : transition(x.status, "PLANNING");
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
                directed: {
                  director,
                  visualDensity: density,
                  silenceTightening: tightening,
                  captionStyle: captions,
                  audioPolish: polish,
                },
                version: p.plans.length + 1,
                targetDuration: p.targetDuration,
                alignment,
              },
              signal,
              async (candidate) => {
                // Keep returned output and billed usage even when validation
                // rejects it. A retry must not erase the evidence of failure.
                const file = `logs/director-${id("candidate")}.json`;
                await this.store.artifact(p, file, candidate);
                this.store.update(p.id, (x) => {
                  x.usage.push(candidate.usage);
                });
                this.store.event(p.id, {
                  event: "director.candidate",
                  path: file,
                  model: candidate.usage.model,
                });
              },
            );
            await this.store.artifact(
              p,
              `production-plans/plan-v${result.output.version}.json`,
              result.output,
            );
            this.store.update(p.id, (x) => {
              x.plans.push(result.output);
              x.planApproval = null;
              x.roughCutApproval = null;
              x.finalRender = null;
              x.finalRenderEngine = null;
              x.publishApproval = null;
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
          if (x.status === "PLANNING") x.status = p.status;
        });
        throw e;
      }
      return this.snapshot(p.id);
    });
    // An autonomous project hands the fresh storyboard to the Producer once
    // the lock releases.
    this.autoAdvance(projectId);
    return result;
  }
  /**
   * Import an externally authored plan (human or offline AI direction).
   * It passes the exact validation an in-app Director plan must pass.
   */
  async importPlan(projectId: string, input: unknown, signal?: AbortSignal) {
    const result = await this.locked(projectId, async (p) => {
      requireReviewedTranscripts(p);
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
      validateSources(plan, p.recordings, transcripts);
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
            rememberTranscripts(x);
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
    // An imported plan is a storyboard awaiting approval just like a
    // generated one; autonomous projects hand it to the Producer.
    this.autoAdvance(projectId);
    return result;
  }
  /** Draft the deterministic A-roll edit for review; the Director refines it. */
  async draftAroll(
    projectId: string,
    options: { director?: DirectorId; tightening?: SilenceTightening } = {},
  ) {
    const p = this.store.get(projectId);
    requireReviewedTranscripts(p);
    const alignment = await this.computeAlignment(projectId);
    const style =
      DIRECTOR_PROFILES[
        asDirectorPersona(options.director ?? p.creator.director)
      ];
    return buildEditDecision(
      alignment,
      p.recordings.map((r) =>
        p.transcripts.findLast((t) => t.recordingId === r.id)!,
      ),
      style.visualDensity,
      asSilenceTightening(options.tightening ?? style.silenceTightening),
    );
  }
  /**
   * Punch-line captions for the current plan. Derived on demand — never
   * persisted — so the UI, previews and builds always agree with the exact
   * approved plan and transcript bytes.
   */
  captionEvents(projectId: string) {
    const p = this.store.get(projectId);
    const plan = validatePlan(p.plans.at(-1));
    return computeCaptionEvents(plan, transcriptsForPlan(p, plan));
  }
  async approvePlan(
    projectId: string,
    version: number,
    by: "creator" | "producer" = "creator",
  ) {
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
          approvedBy: by,
        };
        this.store.event(x.id, { event: "storyboard.approved", version, by });
      });
    });
  }
  async build(projectId: string, signal?: AbortSignal) {
    const result = await buildProject(
      this.store,
      projectId,
      signal,
      (job) => this.notify?.({ event: "job", job }),
      {
        images: this.images,
        blender: await this.blenderEngine(),
        music: this.music,
        provider: this.provider,
      },
    );
    // A completed build parks the rough cut at its gate; the Producer
    // reviews it for autonomous projects.
    this.autoAdvance(projectId);
    return result;
  }
  /**
   * Render the current plan's graphics and 3D clips at storyboard time so the
   * creator can see, approve or redo them before building. Cache keys match
   * the build's, so a later build reuses these verified outputs. Missing 3D
   * entries are reported as skipped instead of failing the pass; the build
   * still fails closed on them.
   */
  async renderPreviews(projectId: string, signal?: AbortSignal) {
    return this.locked(projectId, async (p) => {
      this.revisionAllowed(p);
      const plan = validatePlan(p.plans.at(-1));
      const blender = await this.blenderEngine();
      await this.operation(
        p,
        "previews",
        "Storyboard • previews",
        async (signal) => {
          const result = await renderStoryboardPreviews({
            store: this.store,
            project: p,
            plan,
            blender,
            signal,
            onOutcome: (o) => {
              this.store.event(p.id, {
                event: "previews.scene",
                sceneId: o.sceneId,
                kind: o.kind,
                label: o.label,
                reused: o.reused,
                skipped: o.skipped,
              });
              this.notify?.({
                event: "previews.scene",
                sceneId: o.sceneId,
                kind: o.kind,
                reused: o.reused,
                skipped: o.skipped,
              });
            },
          });
          this.store.event(p.id, {
            event: "previews.rendered",
            planVersion: result.planVersion,
            rendered: result.outcomes.filter((o) => o.asset).length,
            reused: result.outcomes.filter((o) => o.reused).length,
            skipped: result.outcomes.filter((o) => o.skipped).length,
          });
        },
        signal,
      );
      return this.snapshot(p.id);
    });
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
      for (const t of transcriptsForPlan(p, plan))
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
      const capabilities = engineCapabilities(
        this.images,
        library,
        await this.blenderEngine(),
        this.music,
      );
      const visualCapabilities: VisualPassCapabilities = {
        "gpt-image": capabilities["gpt-image"],
        blender: capabilities.blender,
        musicGeneration: capabilities.musicGeneration,
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
        sfxTracks: [
          ...library.tracks
            .filter((t) => t.kind === "sfx")
            .map((t) => ({
              trackId: t.trackId,
              title: t.title,
              duration: t.duration,
            })),
          // The built-in synthesized bank joins the citable track list so
          // persona-driven passes can propose SFX with an empty library.
          ...builtinSfxTracks().map((t) => ({
            trackId: t.trackId,
            title: builtinSfxTrack(t.trackId)!.label,
            duration: t.duration,
          })),
        ],
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
          // audio design must resolve in the creator's library (or, for
          // generated beds, against a configured music engine).
          const next = applyPatch(plan, this.validateProposal(p, proposal));
          validateEngines(
            next,
            this.images,
            await this.blenderEngine(),
            this.music,
          );
          validateAudioDesign(
            next,
            [...trackRefs(library.tracks), ...builtinSfxTracks()],
            {
              musicGeneration: !!this.music,
            },
          );
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
    validateSources(next, p.recordings, transcriptsForPlan(p, next));
    return patch;
  }
  async decidePatch(
    projectId: string,
    patchId: string,
    apply: boolean,
    by: "creator" | "producer" = "creator",
  ) {
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
        r.decidedBy = by;
        if (next) {
          x.status = transition(x.status, "REVISING");
          x.plans.push(next);
          x.planApproval = null;
          x.roughCutApproval = null;
          x.finalRender = null;
          x.finalRenderEngine = null;
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
        x.finalRenderEngine = null;
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
  async approveRoughCut(
    projectId: string,
    version: number,
    options: { by?: "creator" | "producer"; deferRender?: boolean } = {},
  ) {
    const by = options.by ?? "creator";
    const updated = await this.locked(projectId, async (p) => {
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
          approvedBy: by,
        };
        this.store.event(x.id, { event: "roughCut.approved", version, by });
      });
    });
    // The Producer awaits its own final render (advance continues into
    // packaging only after the render exists); the human path stays
    // fire-and-forget so approval never blocks on Resolve.
    if (options.deferRender) return updated;
    // Rough-cut approval is the last human gate before publication: start the
    // final render autonomously, falling back to FFmpeg when Resolve cannot
    // finish. Failures never roll the approval back. Runs after the project
    // lock releases.
    void this.renderFinal(projectId, { autonomous: true }).catch((err) => {
      this.store.event(projectId, {
        event: "final.autoFailed",
        reason: err instanceof Error ? err.message : String(err),
      });
    });
    return updated;
  }
  /**
   * Headless finishing through Resolve: import the current timeline, apply an
   * optional checked-in Fusion macro, and render with a validated preset.
   * Runs autonomously after rough-cut approval; an autonomous run falls back
   * to the verified rough-cut bytes when Resolve cannot finish.
   */
  async renderFinal(
    projectId: string,
    options: {
      preset?: (typeof FINAL_RENDER_PRESETS)[number];
      macroId?: string;
      /** Allow the FFmpeg fallback when Resolve cannot finish. */
      autonomous?: boolean;
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
      let relative: string | null = null;
      let engine: "resolve" | "ffmpeg" = "resolve";
      await this.operation(
        p,
        "final-render",
        `Resolve • final render (${preset}${options.macroId ? ` + ${options.macroId}` : ""})`,
        async (signal) => {
          const finishWithFFmpeg = async () => {
            // The approved rough cut is already the full-resolution 1080p30
            // H.264 master with the mixed bed; its verified bytes are the
            // fallback deliverable, never a silent re-edit.
            const fallback = await safePath(
              dir,
              `renders/final-v${plan.version}-ffmpeg.mp4`,
            );
            await copyFile(await safePath(dir, build.previewPath), fallback);
            await verifyOutput(
              fallback,
              plan.durationFrames / plan.frameRate,
              signal,
            );
            return fallback;
          };
          let produced: string | null = null;
          // Burned-in punch-line captions and narration processing only exist
          // when there is actually something to burn: a caption-styled plan
          // with no qualifying punch lines cuts like any other. Resolve would
          // re-edit from FCPXML and silently lose real burn-ins, so those
          // plans finish from the verified rough-cut bytes.
          const burnIn =
            computeCaptionEvents(plan, transcriptsForPlan(p, plan)).events
              .length > 0 || plan.audioPolish !== "natural";
          try {
            if (burnIn) {
              engine = "ffmpeg";
              produced = await finishWithFFmpeg();
            } else {
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
                  result.reason ??
                    "Resolve is unavailable for final rendering.",
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
            }
          } catch (err) {
            if (signal?.aborted || options.signal?.aborted) throw err;
            if (!options.autonomous) throw err;
            engine = "ffmpeg";
            produced = await finishWithFFmpeg();
          }
          relative = path.relative(dir, produced!);
        },
        options.signal,
      );
      return this.store.update(p.id, (x) => {
        x.finalRender = relative;
        x.finalRenderEngine = engine;
        this.store.event(p.id, {
          event: "final.rendered",
          planVersion: plan.version,
          preset,
          macro: options.macroId ?? null,
          engine,
        });
      });
    });
  }
  /**
   * Read creator review markers from the currently open Resolve timeline and
   * map them onto the current plan. Markers are creator feedback — they drive
   * revisions through the normal gates and never mutate the timeline or any
   * approval. Read-only on the Resolve side: no project is created, switched
   * or saved.
   */
  async readResolveMarkers(projectId: string) {
    return this.locked(projectId, async (p) => {
      const plan = validatePlan(p.plans.at(-1));
      const report = await resolveCommand("markers");
      if (!report.available)
        throw new StudioError(
          "EXTERNAL_TOOL",
          report.reason ?? "Resolve is unavailable.",
          "Open Resolve with the imported timeline project, then read markers again.",
          true,
        );
      const start = report.timelineStartFrame ?? 0;
      const review: ResolveMarkerReview = {
        id: id("resolve-markers"),
        readAt: now(),
        planVersion: plan.version,
        resolveProject: report.project ?? "",
        timeline: report.timeline ?? null,
        markers: (report.markers ?? []).map((m) => ({
          frame: m.frame - start,
          color: m.color ?? null,
          name: m.name ?? null,
          note: m.note ?? null,
          durationFrames: Math.max(0, Math.round(m.duration ?? 0)),
          source: m.source,
          clipName: m.clipName ?? null,
          sceneIndex: sceneIndexForFrame(plan.scenes, m.frame - start),
        })),
      };
      await this.store.artifact(p, `resolve/markers-${review.id}.json`, review);
      return this.store.update(p.id, (x) => {
        x.resolveMarkers.push(review);
        this.store.event(p.id, {
          event: "resolve.markers",
          planVersion: plan.version,
          resolveProject: review.resolveProject,
          count: review.markers.length,
        });
      });
    });
  }
  /**
   * Adopt a render the creator finished manually in Resolve as the project's
   * final render. The delivered bytes are verified against the approved plan
   * (resolution, frame rate, duration, decodability) and copied into the
   * library; nothing is parsed out of the Resolve project itself. Recorded
   * with `finalRenderEngine: "resolve-delivered"` and invalidated by plan
   * revisions exactly like a pipeline render.
   */
  async deliverFinal(
    projectId: string,
    file: string,
    options: { signal?: AbortSignal } = {},
  ) {
    return this.locked(projectId, async (p) => {
      if (!["READY_TO_RENDER", "AWAITING_PUBLISH_APPROVAL"].includes(p.status))
        throw new StudioError(
          "CONFLICT",
          "Approve the rough cut before delivering a finished render.",
        );
      if (p.publication)
        throw new StudioError(
          "CONFLICT",
          `This video is already published as ${p.publication.videoId}.`,
        );
      const ext = path.extname(file).toLowerCase();
      if (!path.isAbsolute(file) || ![".mp4", ".mov"].includes(ext))
        throw new StudioError(
          "INVALID_INPUT",
          "Deliver an absolute MP4 or MOV rendered from your Resolve project.",
        );
      try {
        await stat(file);
      } catch {
        throw new StudioError(
          "INVALID_INPUT",
          "The delivered render file was not found.",
        );
      }
      const plan = validatePlan(p.plans.at(-1));
      const expected = plan.durationFrames / plan.frameRate;
      const dir = this.store.dir(p);
      let relative: string | null = null;
      let provenance:
        | {
            source: string;
            bytes: number;
            codec: string;
            frameRate: number;
          }
        | undefined;
      await this.operation(
        p,
        "final-deliver",
        "Adopt • Resolve deliver",
        async (signal) => {
          const meta = await inspect(file);
          if (
            meta.width !== plan.resolution.width ||
            meta.height !== plan.resolution.height
          )
            throw new StudioError(
              "INVALID_INPUT",
              `Delivered render is ${meta.width}×${meta.height}; the plan delivers ${plan.resolution.width}×${plan.resolution.height}.`,
            );
          if (Math.abs(meta.frameRate - plan.frameRate) > 0.5)
            throw new StudioError(
              "INVALID_INPUT",
              `Delivered render is ${meta.frameRate.toFixed(2)} fps; the plan delivers ${plan.frameRate}.`,
            );
          if (!meta.hasAudio)
            throw new StudioError(
              "INVALID_INPUT",
              "Delivered render has no audio stream.",
            );
          await verifyOutput(file, expected, signal);
          const hash = (await fileHash(file)).slice(0, 8);
          const target = await safePath(
            dir,
            `renders/final-v${plan.version}-delivered-${hash}${ext}`,
          );
          await copyFile(file, target);
          // Verify the adopted copy, not just the source: the library's bytes
          // are the deliverable from here on.
          await verifyOutput(target, expected, signal);
          relative = path.relative(dir, target);
          provenance = {
            source: path.basename(file),
            bytes: meta.bytes,
            codec: meta.codec,
            frameRate: meta.frameRate,
          };
        },
        options.signal,
      );
      return this.store.update(p.id, (x) => {
        x.finalRender = relative;
        x.finalRenderEngine = "resolve-delivered";
        this.store.event(p.id, {
          event: "final.delivered",
          planVersion: plan.version,
          engine: "resolve-delivered",
          ...provenance,
        });
      });
    });
  }
  // ---------------------------------------------------------------------
  // The Producer — deterministic autonomy for the machine gates. An
  // autonomous project lets a fixed review (packages/orchestrator/src/
  // producer.ts) approve the storyboard and rough cut, drive the build,
  // visual pass, final render and packaging, and stop at the first failed
  // check with triaged findings. The script and publication gates stay
  // permanently human.
  // ---------------------------------------------------------------------

  /** Switch a project between supervised and autonomous gate handling. */
  async setAutonomy(projectId: string, mode: Project["autonomy"]) {
    return this.locked(projectId, (p) =>
      this.store.update(p.id, (x) => {
        x.autonomy = mode;
        this.store.event(x.id, { event: "project.autonomy", mode });
      }),
    );
  }
  /**
   * One idempotent pass over the current state: review and approve the
   * storyboard, auto-apply the once-per-script visual pass, build, review QA
   * to approve the rough cut, await the final render, then package — and stop
   * at the publication gate, which is permanently the creator's. Every stop
   * emits a `producer.stopped` event; step errors emit `producer.failed` and
   * leave the persisted state consistent (approvals are atomic; nothing rolls
   * back). Escalated reviews block re-approval of the same plan version until
   * a new version exists.
   */
  async advance(projectId: string, signal?: AbortSignal) {
    if (this.store.get(projectId).autonomy !== "autonomous")
      throw new StudioError(
        "CONFLICT",
        "The Producer only advances autonomous projects.",
        "Switch the project to autonomous mode, or approve the gates yourself.",
      );
    if (this.advancing.has(projectId))
      throw new StudioError(
        "CONFLICT",
        "The Producer is already running on this project.",
      );
    this.advancing.add(projectId);
    const acted: string[] = [];
    try {
      for (let guard = 0; guard < 16; guard++) {
        const p = this.store.get(projectId);
        const plan = p.plans.at(-1);
        const stop = (reason: string) => {
          this.store.event(projectId, { event: "producer.stopped", reason });
          return {
            snapshot: this.snapshot(projectId),
            acted,
            stopped: reason,
            failed: null as { reason: string } | null,
          };
        };
        const step = async (label: string, fn: () => Promise<unknown>) => {
          await fn();
          acted.push(label);
        };
        try {
          // 1. Storyboard: review the pending plan version.
          if (
            p.status === "AWAITING_STORYBOARD_APPROVAL" &&
            plan &&
            p.planApproval?.version !== plan.version
          ) {
            if (escalatedFor(p, "storyboard", plan.version))
              return stop("storyboard-escalated");
            const evidence = this.storyboardEvidence(p, plan);
            const review = reviewStoryboard(
              plan,
              p.targetDuration,
              evidence.tightening,
              evidence.captions,
            );
            this.store.update(projectId, (x) => {
              x.producerReviews.push(review);
            });
            this.store.event(projectId, {
              event: "producer.reviewed",
              gate: "storyboard",
              verdict: review.verdict,
              planVersion: plan.version,
            });
            if (review.verdict === "escalated")
              return stop("storyboard-escalated");
            await step(`storyboard v${plan.version} approved`, () =>
              this.approvePlan(projectId, plan.version, "producer"),
            );
            continue;
          }
          // 2. Visual pass, once per script lineage: propose through the same
          //    fail-closed validation, apply as the Producer, re-approve above.
          if (
            p.status === "AWAITING_STORYBOARD_APPROVAL" &&
            plan &&
            p.planApproval?.version === plan.version &&
            !visualPassApplied(p)
          ) {
            const patch = await this.proposeVisualPass(projectId, signal);
            await step(`visual pass ${patch.resultingVersion} applied`, () =>
              this.decidePatch(projectId, patch.id, true, "producer"),
            );
            continue;
          }
          // 3. Build the approved plan version once.
          if (
            p.status === "AWAITING_STORYBOARD_APPROVAL" &&
            plan &&
            p.planApproval?.version === plan.version &&
            !p.builds.some((b) => b.planVersion === plan.version)
          ) {
            await step(`build v${plan.version}`, () =>
              this.build(projectId, signal),
            );
            continue;
          }
          // 4. Rough cut: strict QA review, then approval + awaited render.
          if (p.status === "AWAITING_ROUGH_CUT_APPROVAL" && plan) {
            const build = p.builds.findLast(
              (b) => b.planVersion === plan.version,
            );
            if (build) {
              if (escalatedFor(p, "rough-cut", plan.version))
                return stop("rough-cut-escalated");
              const qa = JSON.parse(
                await readFile(
                  await safePath(this.store.dir(p), build.qaPath),
                  "utf8",
                ),
              );
              const review = reviewRoughCut(plan, qa);
              this.store.update(projectId, (x) => {
                x.producerReviews.push(review);
              });
              this.store.event(projectId, {
                event: "producer.reviewed",
                gate: "rough-cut",
                verdict: review.verdict,
                planVersion: plan.version,
              });
              if (review.verdict === "escalated")
                return stop("rough-cut-escalated");
              await step(`rough cut v${plan.version} approved`, () =>
                this.approveRoughCut(projectId, plan.version, {
                  by: "producer",
                  deferRender: true,
                }),
              );
              await step(`final render v${plan.version}`, () =>
                this.renderFinal(projectId, { autonomous: true, signal }),
              );
              continue;
            }
          }
          // 5. Packaging: the last machine step before the human gate.
          if (
            p.finalRender &&
            !p.packaging?.version &&
            ["READY_TO_RENDER", "AWAITING_PUBLISH_APPROVAL"].includes(p.status)
          ) {
            await step("packaging generated", () =>
              this.packageVideo(projectId, signal),
            );
            return stop("publication");
          }
          return stop("idle");
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          this.store.event(projectId, { event: "producer.failed", reason });
          return {
            snapshot: this.snapshot(projectId),
            acted,
            stopped: "failed",
            failed: { reason },
          };
        }
      }
      return {
        snapshot: this.snapshot(projectId),
        acted,
        stopped: "loop-guard",
        failed: null as { reason: string } | null,
      };
    } finally {
      this.advancing.delete(projectId);
    }
  }
  /**
   * Tightening and caption evidence for a storyboard review, derived on
   * demand from the same deterministic inputs previews and builds use —
   * never persisted on the plan.
   */
  private storyboardEvidence(
    p: Project,
    plan: ProductionPlan,
  ): {
    tightening: TighteningStats | null;
    captions: number | null;
  } {
    let tightening: TighteningStats | null = null;
    if (plan.silenceTightening !== "natural") {
      const alignment = this.alignment(p.id);
      if (alignment && alignment.transcriptHash === plan.transcriptHash) {
        try {
          const decision = buildEditDecision(
            alignment,
            p.recordings.map((r) =>
              p.transcripts.findLast((t) => t.recordingId === r.id)!,
            ),
            plan.visualDensity,
            plan.silenceTightening,
          );
          tightening = {
            level: decision.stats.tightening.level,
            skippedRecordings: decision.stats.tightening.skippedRecordings,
          };
        } catch {
          tightening = null; // A plan the editor cannot score gets no warning.
        }
      }
    }
    let captions: number | null = null;
    try {
      captions = computeCaptionEvents(plan, transcriptsForPlan(p, plan)).events
        .length;
    } catch {
      captions = null;
    }
    return { tightening, captions };
  }
  /**
   * Fire-and-forget Producer catch-up for autonomous projects. Called after
   * operations that leave a machine gate pending (plan generation/import,
   * build); the lock has already released. Failures land in
   * `producer.autoFailed` events and never surface to the triggering call.
   */
  private autoAdvance(projectId: string) {
    let autonomous = false;
    try {
      autonomous = this.store.get(projectId).autonomy === "autonomous";
    } catch {
      return; // The project vanished mid-flight; nothing to advance.
    }
    if (!autonomous || this.advancing.has(projectId)) return;
    void this.advance(projectId).catch((err) => {
      this.store.event(projectId, {
        event: "producer.autoFailed",
        reason: err instanceof Error ? err.message : String(err),
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
            x.thumbnails = thumbnailState(x, output!);
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
  thumbnailDocument(projectId: string) {
    const p = this.store.get(projectId);
    const document = this.packagingDocument(projectId);
    if (!document) return null;
    const state = thumbnailState(p, document.packaging);
    let provider: "mock" | "gemini" | "openai" | null = null;
    if (this.images instanceof MockImageProvider) provider = "mock";
    else if (this.images instanceof GeminiImageProvider) provider = "gemini";
    else if (this.images) provider = "openai";
    return {
      projectId: p.id,
      state,
      provider,
      model: this.images?.model ?? null,
    };
  }
  private async withThumbnails<T>(
    projectId: string,
    fn: (service: Thumbnails) => Promise<T> | T,
  ) {
    return this.locked(projectId, async (p) => {
      if (!p.packaging?.version || !p.finalRender)
        throw new StudioError(
          "CONFLICT",
          "Thumbnails need packaging for a completed final render.",
        );
      const doc = await this.loadPackagingDocument(p, p.packaging.version);
      const service = new Thumbnails(
        this.store,
        p,
        doc,
        this.images,
        this.thumbnailRenderer,
        (type, label, work, signal) =>
          this.operation(p, type, label, work, signal),
        () => this.notify?.({ event: "thumbnails.updated", projectId: p.id }),
      );
      return fn(service);
    });
  }
  async renderThumbnails(
    projectId: string,
    request: unknown,
    signal?: AbortSignal,
  ) {
    await this.withThumbnails(projectId, (s) => s.render(request, signal));
    return this.thumbnailDocument(projectId);
  }
  async updateThumbnail(projectId: string, request: unknown) {
    await this.withThumbnails(projectId, (s) => s.update(request));
    return this.thumbnailDocument(projectId);
  }
  async regenerateThumbnail(
    projectId: string,
    request: unknown,
    signal?: AbortSignal,
  ) {
    await this.withThumbnails(projectId, (s) => s.regenerate(request, signal));
    return this.thumbnailDocument(projectId);
  }
  async selectThumbnail(projectId: string, request: unknown) {
    await this.withThumbnails(projectId, (s) => s.select(request));
    return this.thumbnailDocument(projectId);
  }
  async exportThumbnails(
    projectId: string,
    version: number,
    destination: string,
  ) {
    return this.withThumbnails(projectId, (s) =>
      s.export(version, destination),
    );
  }

  /** The publication gate: approval binds to the exact packaging document and selected image. */
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
      const thumbnail = p.thumbnails?.selected ?? null;
      await verifiedThumbnailSelection(this.store, p, doc, thumbnail);
      return this.store.update(p.id, (x) => {
        x.publishApproval = {
          version,
          hash: hash(doc),
          approvedAt: now(),
          approvedBy: "creator",
          thumbnail,
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
      if (version !== p.packaging.version)
        throw new StudioError(
          "CONFLICT",
          "Review and approve the current packaging version.",
        );
      const doc = await this.loadPackagingDocument(p, version);
      if (hash(doc) !== p.publishApproval.hash)
        throw new StudioError(
          "CONFLICT",
          "The packaging document changed after approval.",
          "Re-review and approve the current packaging version.",
        );
      const selected = p.thumbnails?.selected ?? null;
      if (hash(selected) !== hash(p.publishApproval.thumbnail ?? null))
        throw new StudioError(
          "CONFLICT",
          "The selected thumbnail changed after approval.",
          "Review and approve packaging again.",
        );
      const thumbnail = await verifiedThumbnailSelection(
        this.store,
        p,
        doc,
        selected,
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
      let result: Awaited<ReturnType<typeof publishToYouTube>> | undefined;
      await this.operation(
        p,
        "publish",
        `Publish • YouTube (${meta.privacyStatus})`,
        async (signal) => {
          result = await publishToYouTube({
            video,
            metaFile,
            thumbnail: thumbnail ?? undefined,
            onVideoCreated: (videoId) => {
              // The CLI reports the video ID before applying its thumbnail. Persist
              // it immediately so a failure/cancellation can never duplicate upload.
              this.store.update(p.id, (x) => {
                x.status = transition(x.status, "PUBLISHED");
                x.publication = {
                  videoId,
                  url: `https://www.youtube.com/watch?v=${videoId}`,
                  publishedAt: now(),
                  thumbnail: selected,
                  thumbnailStatus: thumbnail ? "unconfirmed" : null,
                  warning:
                    "Video created; upload finishing is not yet confirmed. Check YouTube Studio before continuing.",
                };
              });
            },
            extraArgs: (process.env.WTS_YOUTUBE_ARGS ?? "")
              .split(/\s+/)
              .filter(Boolean),
            signal,
          });
        },
        signal,
      );
      return this.store.update(p.id, (x) => {
        if (x.status !== "PUBLISHED")
          x.status = transition(x.status, "PUBLISHED");
        let thumbnailStatus: "applied" | "unconfirmed" | null = null;
        if (thumbnail)
          thumbnailStatus = result!.warning ? "unconfirmed" : "applied";
        x.publication = {
          videoId: result!.videoId,
          url: result!.url,
          publishedAt: now(),
          thumbnail: selected,
          thumbnailStatus,
          warning: result!.warning,
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
        director: z
          .enum(["purist", "craftsman", "showman"])
          .default("craftsman"),
        visualDensity: z
          .enum(["minimal", "balanced", "rich"])
          .default("balanced"),
        silenceTightening: z
          .enum(["natural", "tight", "punchy"])
          .default("natural"),
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
    // The director owns the knobs: whatever density/tightening the caller
    // supplied, the persisted profile always carries the persona's bundle.
    const director = asDirectorPersona(parsed.director);
    const derived = {
      ...parsed,
      director,
      visualDensity: DIRECTOR_PROFILES[director].visualDensity,
      silenceTightening: DIRECTOR_PROFILES[director].silenceTightening,
    };
    this.store.setCreator(derived);
    return derived;
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
/** Scene whose output range contains `frame`; null outside every scene. */
export function sceneIndexForFrame(
  scenes: { startFrame: number; durationFrames: number }[],
  frame: number,
): number | null {
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    if (frame >= s.startFrame && frame < s.startFrame + s.durationFrames)
      return i;
  }
  return null;
}
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
/**
 * An escalated Producer review blocks re-approval of the same plan version:
 * the gate waits for the creator until a new plan version exists.
 */
function escalatedFor(
  p: Project,
  gate: ProducerReview["gate"],
  version: number,
): boolean {
  return p.producerReviews.some(
    (r) =>
      r.gate === gate && r.planVersion === version && r.verdict === "escalated",
  );
}
/** Whether the visual-direction pass already ran in this project's lineage. */
function visualPassApplied(p: Project): boolean {
  return p.revisions.some(
    (r) =>
      r.status === "APPLIED" &&
      r.patch.originatingRequest.startsWith("Visual direction pass"),
  );
}
export type ProducerAdvanceResult = Awaited<ReturnType<Studio["advance"]>>;
export type ProjectSnapshot = ReturnType<Studio["snapshot"]>;
export type JobUpdate = { event: "job"; job: Job };
