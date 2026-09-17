#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { Store, type ProviderSelection } from "./store.ts";
import { Studio, readJSONFile, parseTimeRange } from "./studio.ts";
import { doctor } from "./doctor.ts";
import { inspect } from "../../media/src/index.ts";
import { validatePlan } from "../../production-plan/src/index.ts";
import { applyProviderSelection, resolveCredentials } from "./providers.ts";
import { errorInfo, loadDotEnv, StudioError } from "../../shared/src/index.ts";
import {
  FINAL_RENDER_PRESETS,
  resolveCommand,
} from "../../resolve-engine/src/index.ts";
loadDotEnv();
const { positionals: a, values: v } = parseArgs({
  allowPositionals: true,
  options: {
    provider: { type: "string" },
    transcriber: { type: "string" },
    images: { type: "string" },
    music: { type: "string" },
    model: { type: "string", default: process.env.WTS_MODEL || "gpt-5.4" },
    description: { type: "string", default: "" },
    duration: { type: "string", default: "900" },
    version: { type: "string" },
    recording: { type: "string" },
    preset: { type: "string", default: "H.264 Master" },
    macro: { type: "string" },
    apply: { type: "boolean" },
    help: { type: "boolean" },
  },
});
const help = `WinTheCloud Studio — local production CLI

bun run wts doctor
bun run wts project create "Title" --duration 900 --description "Idea"
bun run wts project list | project inspect <project> | project recover <project>
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
bun run wts media inspect <file> | media import <project> <file>
bun run wts transcript load <project> <transcript.json>
bun run wts transcript fcp <project> <fcpbundle-or-folder>
bun run wts transcribe <project> [--transcriber whisper|openai]
bun run wts align <project>
bun run wts aroll <project>
bun run wts plan <project> [--provider openai]
bun run wts plan import <project> <plan.json>
bun run wts plan validate <project>
bun run wts plan approve <project> --version 1
bun run wts storyboard <project>
bun run wts build <project> | render <project> | jobs <project>
bun run wts revision propose <project> <scene-id> "Creative direction" [--provider openai]
bun run wts revision range <project> 3:42-4:10 "illustrate the failover"
bun run wts revision edit <project> <operations.json>
bun run wts visuals propose <project> [--provider openai]
bun run wts revision apply <project> <patch-id> | revision reject <project> <patch-id>
bun run wts plan undo <project>
bun run wts review approve <project> --version 1
bun run wts final macros | final render <project> [--preset "H.264 Master"] [--macro CinematicGrade]
bun run wts resolve probe | resolve import <absolute.fcpxml> "New project name"

All approvals refer to an exact version. Publishing uploads through the local
YouTube CLI (youtubeuploader; WTS_YOUTUBEUPLOADER_PATH / WTS_YOUTUBE_ARGS) only after packaging approval.
Providers: mock (default, no credits) · whisper (local whisper.cpp) · openai (.env OPENAI_API_KEY or Keychain).
Generated media: --images mock|openai|gemini and --music library|mock|gemini (library is the default; gemini needs GEMINI_API_KEY or the Keychain item). Saved Settings selections apply when no flag is given.
WTS_HOME overrides ~/Movies/WinTheCloud Studio. Quote paths with spaces.
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
  else if (a[0] === "resolve")
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
      await resolveCredentials(),
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
      result = store.create(a[2], v.description, Number(v.duration));
    else if (a[0] === "project" && a[1] === "list") result = store.list();
    else if (a[0] === "project" && a[1] === "recover")
      result = await studio.recover(a[2]);
    else if (a[0] === "project" && a[1] === "inspect")
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
    else if (a[0] === "packaging" && a[1] === "approve")
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
    else if (a[0] === "transcribe")
      result = await studio.transcribe(a[1], abort.signal);
    else if (a[0] === "align") result = await studio.computeAlignment(a[1]);
    else if (a[0] === "aroll") result = await studio.draftAroll(a[1]);
    else if (a[0] === "plan" && a[1] === "validate")
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
    else if (a[0] === "plan")
      result = await studio.generatePlan(a[1], abort.signal);
    else if (a[0] === "storyboard")
      result = store.get(a[1]).plans.at(-1)?.scenes;
    else if (a[0] === "build" || a[0] === "render")
      result = await studio.build(a[1], abort.signal);
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
