#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { Store } from "./store.ts";
import { Studio, readJSONFile } from "./studio.ts";
import { doctor, keychainCredential } from "./doctor.ts";
import { inspect } from "../../media/src/index.ts";
import { MockAIProvider, OpenAIProvider } from "../../agents/src/index.ts";
import { validatePlan } from "../../production-plan/src/index.ts";
import { errorInfo, StudioError } from "../../shared/src/index.ts";
import { resolveCommand } from "../../resolve-engine/src/index.ts";
const { positionals: a, values: v } = parseArgs({
  allowPositionals: true,
  options: {
    provider: { type: "string", default: "mock" },
    model: { type: "string", default: process.env.WTS_MODEL || "gpt-5.4" },
    description: { type: "string", default: "" },
    duration: { type: "string", default: "900" },
    version: { type: "string" },
    recording: { type: "string" },
    apply: { type: "boolean" },
    help: { type: "boolean" },
  },
});
const help = `WinTheCloud Studio — local production CLI

pnpm wts doctor
pnpm wts project create "Title" --duration 900 --description "Idea"
pnpm wts project list | project inspect <project> | project recover <project>
pnpm wts script import <project> <script.txt>
pnpm wts script approve <project> --version 1
pnpm wts media inspect <file> | media import <project> <file>
pnpm wts transcript load <project> <transcript.json>
pnpm wts transcribe <project> --provider openai
pnpm wts plan <project> [--provider openai]
pnpm wts plan validate <project>
pnpm wts plan approve <project> --version 1
pnpm wts storyboard <project>
pnpm wts build <project> | render <project> | jobs <project>
pnpm wts revision propose <project> <scene-id> "Creative direction" [--provider openai]
pnpm wts revision edit <project> <operations.json>
pnpm wts revision apply <project> <patch-id> | revision reject <project> <patch-id>
pnpm wts plan undo <project>
pnpm wts review approve <project> --version 1
pnpm wts resolve probe | resolve import <absolute.fcpxml> "New project name"

All approvals refer to an exact version. Publishing is unavailable in MVP.
Default provider: mock (no credits). OpenAI uses the API key saved by the Mac app in Keychain.
WTS_HOME overrides ~/Movies/WinTheCloud Studio. Paths may contain spaces; quote them.
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
    const needsAI = ["transcribe", "plan", "revision"].includes(a[0]);
    const provider =
      v.provider === "openai" && needsAI
        ? new OpenAIProvider(await keychainCredential(), v.model)
        : new MockAIProvider();
    const studio = new Studio(store, provider, (event) => {
      const job = (event as { job?: { status: string; label: string } }).job;
      if (job)
        process.stderr.write(JSON.stringify({ event: "job", ...job }) + "\n");
    });
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
    else if (a[0] === "media" && a[1] === "import")
      result = await studio.importMedia(a[2], a[3], abort.signal);
    else if (a[0] === "transcript" && a[1] === "load")
      result = await studio.loadTranscript(
        a[2],
        await readJSONFile(a[3]),
        v.recording,
      );
    else if (a[0] === "transcribe")
      result = await studio.transcribe(a[1], abort.signal);
    else if (a[0] === "plan" && a[1] === "validate")
      result = validatePlan(store.get(a[2]).plans.at(-1));
    else if (a[0] === "plan" && a[1] === "approve")
      result = await studio.approvePlan(a[2], Number(v.version));
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
    else if (a[0] === "revision" && a[1] === "edit")
      result = await studio.proposeOperations(
        a[2],
        await readJSONFile(a[3]),
        "Explicit CLI edit",
      );
    else if (a[0] === "revision" && ["apply", "reject"].includes(a[1]))
      result = await studio.decidePatch(a[2], a[3], a[1] === "apply");
    else if (a[0] === "review" && a[1] === "approve")
      result = await studio.approveRoughCut(a[2], Number(v.version));
    else
      throw new StudioError(
        "INVALID_INPUT",
        "Unknown command. Run pnpm wts --help.",
      );
    console.log(JSON.stringify(result, null, 2));
  }
} catch (e) {
  console.error(JSON.stringify(errorInfo(e), null, 2));
  process.exitCode = 1;
} finally {
  store?.close();
}
