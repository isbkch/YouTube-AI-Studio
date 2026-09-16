import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  applyPatch,
  patchSchema,
  normalizePlan,
  validatePlan,
  validateSources,
  operationSchema,
  type Graphic,
  type PlanPatch,
  type ProductionPlan,
} from "../../production-plan/src/index.ts";
import {
  DirectorAgent,
  MockAIProvider,
  validateTranscript,
  type AIProvider,
  type Transcriber,
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
import { importRecording, extractAudio } from "../../media/src/index.ts";
import { Store } from "./store.ts";
import {
  transition,
  type Project,
  type Job,
  type Transcript,
} from "./model.ts";
import { buildProject } from "./build.ts";
import { JobGraph } from "./jobs.ts";
import { alignScript, alignmentSchema, type Alignment } from "./alignment.ts";
import { buildEditDecision, suggestGraphic } from "./aroll.ts";
import {
  discoverFCPTranscripts,
  fcpToTranscriptInput,
  mapFCPTranscriptsToRecordings,
  readFCPTranscript,
} from "./fcp.ts";

export class Studio {
  public transcription: Transcriber;
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
      return alignmentSchema.parse(JSON.parse(readFileSync(file, "utf8")));
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
    const alignment = await this.computeAlignment(projectId);
    return buildEditDecision(alignment);
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
    return buildProject(this.store, projectId, signal, (job) =>
      this.notify?.({ event: "job", job }),
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
                : [o.sceneId],
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
      // the first scene stays presenter footage, later scenes get visuals.
      const compound =
        intent.keepPresenter &&
        intent.illustrate &&
        /first|then|after that/i.test(request);
      const operations: import("../../production-plan/src/index.ts").Operation[] =
        [];
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
        if (keepPresenter) {
          if (scene.visual.graphic)
            operations.push({ type: "removeGraphic", sceneId: scene.id });
          continue;
        }
        if (intent.illustrate) {
          if (scene.visual.type === "graphic") continue;
          const suggestion =
            suggestGraphic(scene.narration, scene.chapterTitle ?? null) ??
            intent.fallback;
          operations.push({
            type: "replaceVisual",
            sceneId: scene.id,
            visual: {
              type: "graphic",
              description: `Range revision: ${request.slice(0, 200)}`,
              graphic: {
                engine: "remotion",
                template: suggestion!.template,
                templateVersion: "1.0.0",
                parameters: suggestion!.parameters,
              } as Graphic,
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
        rationale: `Scoped range revision over ${rangeText}; only the listed scene instructions change.`,
        affectedScenes: [
          ...new Set(
            (operations as { type: string; sceneId: string }[]).map(
              (o) => o.sceneId,
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
        this.store.event(p.id, { event: "roughCut.approved", version });
      });
    });
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
    chapter: chapterMatch ? chapterMatch[1].trim().slice(0, 120) : null,
    fallback: {
      template: "Callout" as const,
      parameters: {
        title: request.slice(0, 90) || "Key point",
        subtitle: "",
      },
    },
  };
}
export type ProjectSnapshot = ReturnType<Studio["snapshot"]>;
export type JobUpdate = { event: "job"; job: Job };
