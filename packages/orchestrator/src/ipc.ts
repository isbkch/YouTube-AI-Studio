import { createInterface } from "node:readline";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { Studio } from "./studio.ts";
import { Store } from "./store.ts";
import { doctor } from "./doctor.ts";
import { MockAIProvider, OpenAIProvider } from "../../agents/src/index.ts";
import {
  errorInfo,
  safePath,
  StudioError,
  type CreatorProfile,
} from "../../shared/src/index.ts";
import { resolveCommand } from "../../resolve-engine/src/index.ts";
// stdout is exclusively the IPC transport. Third-party diagnostics go to stderr.
const send = (value: unknown) =>
  process.stdout.write(JSON.stringify(value) + "\n");
console.log = (...args: unknown[]) => console.error(...args);
const store = new Store();
const studio = new Studio(store, undefined, send);
const active = new Map<string, AbortController>();
const envelope = z.strictObject({
  id: z.string().max(100),
  method: z.string().max(100),
  params: z.record(z.string(), z.unknown()).default({}),
});
const project = z.object({ projectId: z.string().min(1) }),
  version = project.extend({ version: z.number().int().positive() });
async function dispatch(
  method: string,
  params: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  switch (method) {
    case "projects.list":
      return store.list();
    case "project.create": {
      const p = z
        .object({
          title: z.string(),
          description: z.string(),
          targetDuration: z.number(),
        })
        .parse(params);
      return store.create(p.title, p.description, p.targetDuration);
    }
    case "project.get":
      return studio.snapshot(project.parse(params).projectId);
    case "script.save": {
      const p = project.extend({ text: z.string() }).parse(params);
      return studio.saveScript(p.projectId, p.text);
    }
    case "script.approve": {
      const p = version.parse(params);
      return studio.approveScript(p.projectId, p.version);
    }
    case "media.import": {
      const p = project.extend({ path: z.string() }).parse(params);
      return studio.importMedia(p.projectId, p.path, signal);
    }
    case "transcript.load": {
      const p = project.extend({ transcript: z.unknown() }).parse(params);
      return studio.loadTranscript(p.projectId, p.transcript);
    }
    case "transcript.generate":
      return studio.transcribe(project.parse(params).projectId, signal);
    case "plan.generate":
      return studio.generatePlan(project.parse(params).projectId, signal);
    case "plan.approve": {
      const p = version.parse(params);
      return studio.approvePlan(p.projectId, p.version);
    }
    case "build":
      return studio.build(project.parse(params).projectId, signal);
    case "revision.propose": {
      const p = project
        .extend({ request: z.string(), sceneId: z.string() })
        .parse(params);
      return studio.propose(p.projectId, p.request, p.sceneId, signal);
    }
    case "revision.edit": {
      const p = project
        .extend({ request: z.string(), operations: z.unknown() })
        .parse(params);
      return studio.proposeOperations(p.projectId, p.operations, p.request);
    }
    case "revision.decide": {
      const p = project
        .extend({ patchId: z.string(), apply: z.boolean() })
        .parse(params);
      return studio.decidePatch(p.projectId, p.patchId, p.apply);
    }
    case "plan.undo":
      return studio.undo(project.parse(params).projectId);
    case "roughCut.approve": {
      const p = version.parse(params);
      return studio.approveRoughCut(p.projectId, p.version);
    }
    case "doctor":
      return doctor(store.root);
    case "creator.get":
      return store.creator();
    case "creator.save":
      return studio.setCreator(params.profile as CreatorProfile);
    case "preference.add":
      return studio.addPreference(
        z.object({ text: z.string() }).parse(params).text,
      );
    case "provider.configure": {
      const p = z
        .object({
          provider: z.enum(["mock", "openai"]),
          model: z.string().max(100).default("gpt-5.4"),
          apiKey: z.string().max(500).optional(),
        })
        .parse(params);
      studio.provider =
        p.provider === "mock"
          ? new MockAIProvider()
          : new OpenAIProvider(p.apiKey || "", p.model);
      return { provider: studio.provider.name };
    }
    case "resolve.probe":
      return resolveCommand("probe");
    case "resolve.import": {
      const p = store.get(project.parse(params).projectId);
      const plan = p.plans.at(-1);
      const build = p.builds.findLast((b) => b.planVersion === plan?.version);
      if (!build)
        throw new StudioError("CONFLICT", "Build the current plan first.");
      return resolveCommand(
        "import",
        await safePath(store.dir(p), build.exportPath),
        `WTS ${p.title.slice(0, 80)} v${build.planVersion} ${Date.now()}`,
      );
    }
    case "qa.get": {
      const p = store.get(project.parse(params).projectId);
      const build = p.builds.at(-1);
      return build
        ? JSON.parse(
            await readFile(await safePath(store.dir(p), build.qaPath), "utf8"),
          )
        : null;
    }
    case "request.cancel": {
      const p = z.object({ requestId: z.string() }).parse(params);
      active.get(p.requestId)?.abort();
      return { cancelled: true };
    }
    default:
      throw new StudioError("UNSUPPORTED", `Unknown IPC method: ${method}`);
  }
}
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (line.length > 2_000_000) {
    send({
      id: null,
      error: errorInfo(
        new StudioError("INVALID_INPUT", "IPC request exceeds 2 MB."),
      ),
    });
    return;
  }
  let request: z.infer<typeof envelope>;
  try {
    request = envelope.parse(JSON.parse(line));
  } catch (e) {
    send({ id: null, error: errorInfo(e) });
    return;
  }
  if (active.has(request.id)) {
    send({
      id: request.id,
      error: errorInfo(new StudioError("CONFLICT", "Duplicate request ID.")),
    });
    return;
  }
  const controller = new AbortController();
  active.set(request.id, controller);
  void dispatch(request.method, request.params, controller.signal)
    .then(
      (result) => send({ id: request.id, result }),
      (error) => send({ id: request.id, error: errorInfo(error) }),
    )
    .finally(() => active.delete(request.id));
});
input.on("close", () => {
  for (const c of active.values()) c.abort();
  setTimeout(() => process.exit(0), 4000).unref();
});
process.on("SIGTERM", () => {
  for (const c of active.values()) c.abort();
  setTimeout(() => process.exit(0), 4000).unref();
  input.close();
});
send({ event: "ready", protocolVersion: 1, root: store.root });
