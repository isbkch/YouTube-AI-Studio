#!/usr/bin/env node
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { Store, type ProviderSelection } from "./store.ts";
import { Studio, readJSONFile, parseTimeRange } from "./studio.ts";
import { doctor } from "./doctor.ts";
import { inspect } from "../../media/src/index.ts";
import { validatePlan } from "../../production-plan/src/index.ts";
import {
  applyProviderSelection,
  configuredImageProvider,
  resolveCredentials,
} from "./providers.ts";
import { errorInfo, loadDotEnv, StudioError } from "../../shared/src/index.ts";
import {
  FINAL_RENDER_PRESETS,
  resolveCommand,
} from "../../resolve-engine/src/index.ts";
loadDotEnv();
/** Shared `--tightening` parse so `aroll` and `plan` cannot drift. */
const tighteningArg = (
  value: string | undefined,
): "natural" | "tight" | "punchy" | undefined => {
  if (value && !["natural", "tight", "punchy"].includes(value))
    throw new StudioError(
      "INVALID_INPUT",
      "--tightening must be natural, tight or punchy.",
    );
  return value as "natural" | "tight" | "punchy" | undefined;
};
/** Shared `--director` parse: the hired persona drives every knob's default. */
const directorArg = (
  value: string | undefined,
): "purist" | "craftsman" | "showman" | undefined => {
  if (value && !["purist", "craftsman", "showman"].includes(value))
    throw new StudioError(
      "INVALID_INPUT",
      "--director must be purist, craftsman or showman.",
    );
  return value as "purist" | "craftsman" | "showman" | undefined;
};
const { positionals: a, values: v } = parseArgs({
  allowPositionals: true,
  options: {
    file: { type: "string" },
    provider: { type: "string" },
    transcriber: { type: "string" },
    images: { type: "string" },
    music: { type: "string" },
    director: { type: "string" },
    density: { type: "string" },
    tightening: { type: "string" },
    model: { type: "string", default: process.env.WTS_MODEL || "gpt-5.4" },
    description: { type: "string", default: "" },
    duration: { type: "string", default: "900" },
    autonomy: { type: "string" },
    version: { type: "string" },
    revision: { type: "string" },
    headline: { type: "string" },
    direction: { type: "string" },
    concept: { type: "string" },
    recording: { type: "string" },
    preset: { type: "string", default: "H.264 Master" },
    macro: { type: "string" },
    apply: { type: "boolean" },
    yes: { type: "boolean" },
    all: { type: "boolean" },
    "from-reviewed-transcripts": { type: "boolean" },
    help: { type: "boolean" },
  },
});
/** Shared `--autonomy`/positional autonomy parse; supervised is the default. */
const autonomyArg = (
  value: string | undefined,
): "supervised" | "autonomous" => {
  if (value && !["supervised", "autonomous"].includes(value))
    throw new StudioError(
      "INVALID_INPUT",
      "Autonomy must be supervised or autonomous.",
    );
  return (value as "supervised" | "autonomous") ?? "supervised";
};
const help = `YouTube-AI-Studio — local production CLI

bun run wts doctor
bun run wts project create "Title" --duration 900 --description "Idea" [--autonomy supervised|autonomous]
bun run wts project list | project inspect <project> | project recover <project>
bun run wts costs <project>   (estimated API spend: this project and the whole library)
bun run wts project delete <project> --yes   (files you imported from stay untouched)
bun run wts autonomy <project> supervised|autonomous   (who satisfies the machine gates)
bun run wts producer <project>   (autonomous projects: advance machine gates to the next stop; script and publication stay human)
bun run wts producer --all   (one Producer pass over every autonomous project; crashed projects self-recover first)
bun run wts rerecord <project>   (the pickup list: omitted sentences with context — record, import, transcribe, re-plan)
bun run wts research <project> [--provider openai]
bun run wts narrative <project> [--provider openai]
bun run wts script draft <project> [--provider openai]
bun run wts script import <project> <script.txt>
bun run wts script approve <project> --version 1
bun run wts previsualize <project> [--provider openai]
bun run wts teleprompter <project>
bun run wts packaging <project> [--provider openai]
bun run wts packaging approve <project> --version 1
bun run wts publish <project>
bun run wts thumbnails <project> [--images mock|openai|gemini]   (render missing A/B)
bun run wts thumbnails get <project>
bun run wts thumbnails edit <project> A --headline "Headline" [--direction "Visual direction"] [--concept thumb-1]
bun run wts thumbnails regenerate <project> B
bun run wts thumbnails select <project> A --revision 1 | thumbnails select <project> none
bun run wts thumbnails export <project> <absolute-destination-folder>
bun run wts media inspect <file> | media import <project> <file>
bun run wts transcript load <project> <transcript.json>
bun run wts transcript fcp <project> <fcpbundle-or-folder>
bun run wts transcript review <project> --transcriber openai [--recording <id>]
bun run wts transcript decide <project> --file <decision.json>
bun run wts transcribe <project> [--transcriber whisper|openai]
bun run wts align <project>
bun run wts aroll <project> [--director purist|craftsman|showman] [--tightening natural|tight|punchy]
bun run wts plan <project> [--provider openai] [--director purist|craftsman|showman] [--density minimal|balanced|rich] [--tightening natural|tight|punchy]
                         (--director hires the persona that drives density, tightening, captions and audio polish; --density/--tightening override individual knobs)
bun run wts plan import <project> <plan.json>
bun run wts plan validate <project>
bun run wts plan approve <project> --version 1
bun run wts storyboard <project>
bun run wts previews <project>   (render storyboard previews: graphics + 3D clips)
bun run wts build <project> | render <project> | jobs <project>
bun run wts revision propose <project> <scene-id> "Creative direction" [--provider openai]
bun run wts revision range <project> 3:42-4:10 "illustrate the failover"
bun run wts revision edit <project> <operations.json>
bun run wts visuals propose <project> [--provider openai]
bun run wts revision apply <project> <patch-id> | revision reject <project> <patch-id>
bun run wts plan undo <project>
bun run wts review approve <project> --version 1
bun run wts final macros | final render <project> [--preset "H.264 Master"] [--macro CinematicGrade]
bun run wts final deliver <project> <absolute.mp4|mov rendered in Resolve>
bun run wts resolve probe | resolve import <absolute.fcpxml> "New project name" | resolve markers <project>

All approvals refer to an exact version. Publishing uploads through the local
YouTube CLI (youtubeuploader; WTS_YOUTUBEUPLOADER_PATH / WTS_YOUTUBE_ARGS) only after packaging approval.
Providers: mock (default, no credits) · whisper (local whisper.cpp) · openai (.env OPENAI_API_KEY or Keychain).
Generated media: --images mock|openai|gemini and --music library|mock|gemini (library is the default; gemini needs GEMINI_API_KEY or the Keychain item). Saved Settings selections apply when no flag is given.
WTS_HOME overrides ~/Movies/YouTube-AI-Studio. Quote paths with spaces.
`;
const abort = new AbortController();
process.once("SIGINT", () => abort.abort());
let store: Store | undefined;
try {
  if (v.help || !a.length) {
    console.log(help);
  } else if (a[0] === "doctor")
    console.log(JSON.stringify(await doctor(), null, 2));
  else if (a[0] === "media" && a[1] === "inspect")
    console.log(JSON.stringify(await inspect(a[2]), null, 2));
  else if (a[0] === "resolve" && a[1] !== "markers")
    console.log(
      JSON.stringify(
        await resolveCommand(a[1] as "probe" | "import", a[2], a[3]),
        null,
        2,
      ),
    );
  else {
    store = new Store();
    const needsAI =
      [
        "transcribe",
        "plan",
        "revision",
        "visuals",
        "research",
        "narrative",
        "previsualize",
        "packaging",
      ].includes(a[0]) ||
      (a[0] === "script" && a[1] === "draft");
    // Flags win over the persisted Settings selection; without either, the
    // free defaults apply (and images follow the Director provider, as the
    // CLI always did).
    const stored = store.providerSelection();
    const director = (v.provider ??
      stored.director) as ProviderSelection["director"];
    const transcription = (v.transcriber ??
      stored.transcription) as ProviderSelection["transcription"];
    const images = (v.images ??
      (a[0] === "thumbnails" ? stored.images : undefined) ??
      (v.provider && v.provider !== "openai" ? "mock" : undefined) ??
      (stored.images === "mock" && director === "openai"
        ? "openai"
        : stored.images)) as ProviderSelection["images"];
    const music = (v.music ?? stored.music) as ProviderSelection["music"];
    const studio = new Studio(store, undefined, undefined, (event) => {
      const job = (event as { job?: { status: string; label: string } }).job;
      if (job)
        process.stderr.write(JSON.stringify({ event: "job", ...job }) + "\n");
    });
    const credentials = await resolveCredentials();
    applyProviderSelection(
      studio,
      {
        director,
        transcription,
        images,
        music,
        directorModel: v.provider ? v.model! : stored.directorModel,
        imageModel: stored.imageModel,
        musicModel: stored.musicModel,
      },
      credentials,
      // Commands that actually run engines fail loudly when a billed engine
      // lacks its key — exactly like --provider openai always has. Everything
      // else falls back to the free engines.
      {
        lenient: !(
          (needsAI || ["visuals", "build", "render"].includes(a[0])) &&
          (director === "openai" ||
            transcription === "openai" ||
            images !== "mock" ||
            music === "gemini")
        ),
      },
    );
    let result: unknown;
    if (a[0] === "project" && a[1] === "create")
      result = store.create(
        a[2],
        v.description,
        Number(v.duration),
        autonomyArg(v.autonomy),
      );
    else if (a[0] === "project" && a[1] === "list")
      result = studio.listProjects();
    else if (a[0] === "costs") result = studio.costs(a[1]);
    else if (a[0] === "autonomy") {
      const mode = autonomyArg(a[2]);
      await studio.setAutonomy(a[1], mode);
      result = {
        project: a[1],
        autonomy: mode,
        note:
          mode === "autonomous"
            ? "The Producer advances machine gates; script and publication approval stay yours."
            : "Every gate waits for you again.",
      };
    } else if (a[0] === "producer" && v.all) {
      const results = await studio.advanceAll(abort.signal);
      result = {
        advanced: results.length,
        results: results.map((r) => ({
          project: r.id,
          title: r.title,
          stopped: r.stopped,
          acted: r.acted,
          failed: r.failed,
        })),
      };
    } else if (a[0] === "producer") {
      const advance = await studio.advance(a[1], abort.signal);
      result = {
        autonomy: store.get(a[1]).autonomy,
        acted: advance.acted,
        stopped: advance.stopped,
        failed: advance.failed,
        status: advance.snapshot.status,
        reviews: advance.snapshot.producerReviews,
      };
    } else if (a[0] === "project" && a[1] === "recover")
      result = await studio.recover(a[2]);
    else if (a[0] === "rerecord") result = await studio.rerecordList(a[1]);
    else if (a[0] === "project" && a[1] === "delete") {
      if (!v.yes)
        throw new StudioError(
          "INVALID_INPUT",
          "Deleting a project removes its scripts, plans, renders, artifacts and imported recording copies from the library.",
          "The original files you imported from are untouched. Re-run with --yes to delete.",
        );
      result = await studio.deleteProject(a[2]);
    } else if (a[0] === "project" && a[1] === "inspect")
      result = studio.snapshot(a[2]);
    else if (a[0] === "script" && a[1] === "import")
      result = await studio.saveScript(a[2], await readFile(a[3], "utf8"));
    else if (a[0] === "script" && a[1] === "approve")
      result = await studio.approveScript(a[2], Number(v.version));
    else if (a[0] === "script" && a[1] === "draft")
      result = await studio.draftScript(a[2], abort.signal);
    else if (a[0] === "research")
      result = await studio.research(a[1], abort.signal);
    else if (a[0] === "narrative")
      result = await studio.narrative(a[1], abort.signal);
    else if (a[0] === "previsualize")
      result = await studio.previsualize(a[1], abort.signal);
    else if (a[0] === "teleprompter") result = await studio.teleprompter(a[1]);
    else if (a[0] === "thumbnails") {
      const subcommands = ["get", "edit", "regenerate", "select", "export"];
      const action = subcommands.includes(a[1]) ? a[1] : "render";
      const projectId = action === "render" ? a[1] : a[2];
      const doc = studio.thumbnailDocument(projectId);
      if (!doc)
        throw new StudioError(
          "CONFLICT",
          "Generate packaging before thumbnails.",
        );
      const packagingVersion = doc.state.current.packagingVersion;
      const slots = doc.state.current.slots;
      const slot = slots.find((s) => s.id === a[3]);
      if (
        !studio.images &&
        (action === "regenerate" ||
          (action === "render" && slots.some((s) => !s.background)))
      )
        studio.images = configuredImageProvider(
          { images, imageModel: stored.imageModel },
          credentials,
        );
      if (action === "get") result = doc;
      else if (action === "export")
        result = await studio.exportThumbnails(
          projectId,
          packagingVersion,
          a[3],
        );
      else if (action === "render")
        result = await studio.renderThumbnails(
          projectId,
          {
            packagingVersion,
            slots: slots.map((s) => ({
              slot: s.id,
              expectedRevision: s.version,
            })),
          },
          abort.signal,
        );
      else if (action === "select" && a[3] === "none")
        result = await studio.selectThumbnail(projectId, {
          packagingVersion,
          slot: null,
          revision: null,
          expectedRevision: null,
        });
      else {
        if (!slot)
          throw new StudioError("INVALID_INPUT", "Choose thumbnail A or B.");
        const context = {
          packagingVersion,
          slot: slot.id,
          expectedRevision: slot.version,
        };
        if (action === "select")
          result = await studio.selectThumbnail(projectId, {
            ...context,
            revision: Number(v.revision ?? slot.currentRevision),
          });
        else if (action === "regenerate")
          result = await studio.regenerateThumbnail(
            projectId,
            context,
            abort.signal,
          );
        else {
          const concept = doc.state.current.slots.find(
            (s) => s.id === slot.id,
          )!;
          const proposal = studio
            .packagingDocument(projectId)!
            .packaging.thumbnailConcepts.find((c) => c.id === v.concept);
          result = await studio.updateThumbnail(projectId, {
            ...context,
            conceptId: v.concept ?? concept.conceptId,
            headline: v.headline ?? proposal?.headline ?? slot.headline,
            direction: v.direction ?? proposal?.direction ?? slot.direction,
          });
        }
      }
    } else if (a[0] === "packaging" && a[1] === "approve")
      result = await studio.approvePackaging(a[2], Number(v.version));
    else if (a[0] === "packaging")
      result = await studio.packageVideo(a[1], abort.signal);
    else if (a[0] === "publish")
      result = await studio.publish(a[1], abort.signal);
    else if (a[0] === "media" && a[1] === "import")
      result = await studio.importMedia(a[2], a[3], abort.signal);
    else if (a[0] === "transcript" && a[1] === "load")
      result = await studio.loadTranscript(
        a[2],
        await readJSONFile(a[3]),
        v.recording,
      );
    else if (a[0] === "transcript" && a[1] === "fcp")
      result = await studio.importFCPTranscripts(a[2], a[3], abort.signal);
    else if (a[0] === "transcript" && a[1] === "review")
      result = await studio.reviewTranscription(
        a[2],
        v.recording,
        abort.signal,
      );
    else if (a[0] === "transcript" && a[1] === "correct") {
      const input = z
        .object({
          reviewId: z.string(),
          issueId: z.string(),
          expectedHash: z.string(),
          text: z.string().min(1).max(20000),
        })
        .parse(await readJSONFile(v.file!));
      result = await studio.correctTranscriptIssue(a[2], input, abort.signal);
    } else if (a[0] === "transcript" && a[1] === "decide") {
      const input = z
        .object({
          reviewId: z.string(),
          issueId: z.string(),
          action: z.enum(["accept", "keep"]),
          expectedHash: z.string(),
        })
        .parse(await readJSONFile(v.file!));
      result = await studio.decideTranscriptIssue(a[2], input);
    } else if (a[0] === "transcribe")
      result = await studio.transcribe(a[1], abort.signal);
    else if (a[0] === "align") result = await studio.computeAlignment(a[1]);
    else if (a[0] === "aroll") {
      result = await studio.draftAroll(a[1], {
        director: directorArg(v.director),
        tightening: tighteningArg(v.tightening),
      });
    } else if (a[0] === "plan" && a[1] === "validate")
      result = validatePlan(store.get(a[2]).plans.at(-1));
    else if (a[0] === "plan" && a[1] === "approve")
      result = await studio.approvePlan(a[2], Number(v.version));
    else if (a[0] === "plan" && a[1] === "import")
      result = await studio.importPlan(
        a[2],
        await readJSONFile(a[3]),
        abort.signal,
      );
    else if (a[0] === "plan" && a[1] === "undo")
      result = await studio.undo(a[2]);
    else if (a[0] === "plan") {
      if (v.density && !["minimal", "balanced", "rich"].includes(v.density))
        throw new StudioError(
          "INVALID_INPUT",
          "--density must be minimal, balanced or rich.",
        );
      result = await studio.generatePlan(
        a[1],
        {
          director: directorArg(v.director),
          fromReviewedTranscripts: v["from-reviewed-transcripts"],
          density: v.density as "minimal" | "balanced" | "rich" | undefined,
          tightening: tighteningArg(v.tightening),
        },
        abort.signal,
      );
    } else if (a[0] === "storyboard")
      result = store.get(a[1]).plans.at(-1)?.scenes;
    else if (a[0] === "build" || a[0] === "render")
      result = await studio.build(a[1], abort.signal);
    else if (a[0] === "previews")
      result = await studio.renderPreviews(a[1], abort.signal);
    else if (a[0] === "jobs") result = store.jobs(store.get(a[1]).id);
    else if (a[0] === "revision" && a[1] === "propose")
      result = await studio.propose(a[2], a[4], a[3], abort.signal);
    else if (a[0] === "revision" && a[1] === "range") {
      if (!parseTimeRange(a[3] ?? ""))
        throw new StudioError(
          "INVALID_INPUT",
          "Pass a timeline range like 3:42-4:10 or 222-260.",
        );
      result = await studio.proposeRange(a[2], a[3], a[4] ?? "", abort.signal);
    } else if (a[0] === "revision" && a[1] === "edit")
      result = await studio.proposeOperations(
        a[2],
        await readJSONFile(a[3]),
        "Explicit CLI edit",
      );
    else if (a[0] === "visuals" && a[1] === "propose")
      result = await studio.proposeVisualPass(a[2], abort.signal);
    else if (a[0] === "revision" && ["apply", "reject"].includes(a[1]))
      result = await studio.decidePatch(a[2], a[3], a[1] === "apply");
    else if (a[0] === "review" && a[1] === "approve")
      result = await studio.approveRoughCut(a[2], Number(v.version));
    else if (a[0] === "final" && a[1] === "macros") {
      const { fusionMacros } =
        await import("../../resolve-engine/src/index.ts");
      result = { macros: await fusionMacros(), presets: FINAL_RENDER_PRESETS };
    } else if (a[0] === "final" && a[1] === "render")
      result = await studio.renderFinal(a[2], {
        preset: v.preset as "H.264 Master" | undefined,
        macroId: v.macro,
        signal: abort.signal,
      });
    else if (a[0] === "final" && a[1] === "deliver")
      result = await studio.deliverFinal(a[2], a[3], {
        signal: abort.signal,
      });
    else if (a[0] === "resolve" && a[1] === "markers")
      result = await studio.readResolveMarkers(a[2]);
    else
      throw new StudioError(
        "INVALID_INPUT",
        "Unknown command. Run bun run wts --help.",
      );
    console.log(JSON.stringify(result, null, 2));
  }
} catch (e) {
  console.error(JSON.stringify(errorInfo(e), null, 2));
  process.exitCode = 1;
} finally {
  store?.close();
}
