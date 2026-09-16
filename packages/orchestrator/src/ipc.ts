import { createInterface } from "node:readline";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { Studio } from "./studio.ts";
import { Store } from "./store.ts";
import { doctor, openAICredential } from "./doctor.ts";
import { MockAIProvider, OpenAIProvider } from "../../agents/src/index.ts";
import { WhisperCLIProvider } from "../../agents/src/whisper.ts";
import {
  MockImageProvider,
  OpenAIImageProvider,
} from "../../image-engine/src/index.ts";
import {
  errorInfo,
  loadDotEnv,
  safePath,
  StudioError,
  type CreatorProfile,
} from "../../shared/src/index.ts";
import {
  resolveCommand,
  fusionMacros,
} from "../../resolve-engine/src/index.ts";
loadDotEnv();
// stdout is exclusively the IPC transport. Third-party diagnostics go to stderr.
const send = (value: unknown) =>
  process.stdout.write(JSON.stringify(value) + "\n");
console.log = (...args: unknown[]) => console.error(...args);
const store = new Store();
const studio = new Studio(store, undefined, undefined, send);
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
    case "project.recover":
      return studio.recover(project.parse(params).projectId);
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
    case "research.run":
      return studio.research(project.parse(params).projectId, signal);
    case "narrative.run":
      return studio.narrative(project.parse(params).projectId, signal);
    case "script.draft":
      return studio.draftScript(project.parse(params).projectId, signal);
    case "previsualization.run":
      return studio.previsualize(project.parse(params).projectId, signal);
    case "teleprompter.get":
      return studio.teleprompter(project.parse(params).projectId);
    case "packaging.run":
      return studio.packageVideo(project.parse(params).projectId, signal);
    case "packaging.get":
      return studio.packagingDocument(project.parse(params).projectId);
    case "packaging.approve": {
      const p = version.parse(params);
      return studio.approvePackaging(p.projectId, p.version);
    }
    case "publish.run":
      return studio.publish(project.parse(params).projectId, signal);
    case "media.import": {
      const p = project.extend({ path: z.string() }).parse(params);
      return studio.importMedia(p.projectId, p.path, signal);
    }
    case "transcript.load": {
      const p = project
        .extend({ transcript: z.unknown(), recordingId: z.string().optional() })
        .parse(params);
      return studio.loadTranscript(p.projectId, p.transcript, p.recordingId);
    }
    case "transcript.fcp": {
      const p = project.extend({ path: z.string() }).parse(params);
      return studio.importFCPTranscripts(p.projectId, p.path, signal);
    }
    case "transcript.generate":
      return studio.transcribe(project.parse(params).projectId, signal);
    case "alignment.compute":
      return studio.computeAlignment(project.parse(params).projectId);
    case "alignment.get":
      return studio.alignment(project.parse(params).projectId);
    case "aroll.draft":
      return studio.draftAroll(project.parse(params).projectId);
    case "plan.generate":
      return studio.generatePlan(project.parse(params).projectId, signal);
    case "plan.import": {
      const p = project.extend({ plan: z.unknown() }).parse(params);
      return studio.importPlan(p.projectId, p.plan, signal);
    }
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
    case "revision.range": {
      const p = project
        .extend({ range: z.string(), request: z.string() })
        .parse(params);
      return studio.proposeRange(p.projectId, p.range, p.request, signal);
    }
    case "revision.edit": {
      const p = project
        .extend({ request: z.string(), operations: z.unknown() })
        .parse(params);
      return studio.proposeOperations(p.projectId, p.operations, p.request);
    }
    case "visuals.propose":
      return studio.proposeVisualPass(project.parse(params).projectId, signal);
    case "final.render": {
      const p = project
        .extend({
          preset: z.string().max(60).optional(),
          macroId: z.string().max(60).optional(),
        })
        .parse(params);
      return studio.renderFinal(p.projectId, {
        preset: p.preset as "H.264 Master" | undefined,
        macroId: p.macroId,
        signal,
      });
    }
    case "final.macros":
      return fusionMacros();
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
          transcriptionProvider: z
            .enum(["mock", "whisper", "openai"])
            .default("mock"),
          model: z.string().max(100).default("gpt-5.4"),
          apiKey: z.string().max(500).optional(),
          whisperModel: z.string().max(1000).optional(),
        })
        .parse(params);
      let credentialSource: "env" | "keychain" | "session" | "none" = "none";
      const key = p.apiKey || (await openAICredential());
      if (p.apiKey) credentialSource = "session";
      else if (process.env.OPENAI_API_KEY?.trim()) credentialSource = "env";
      else if (key) credentialSource = "keychain";
      if (p.provider === "openai") {
        studio.provider = new OpenAIProvider(key || "", p.model);
        try {
          studio.images = new OpenAIImageProvider(key || "");
        } catch {
          studio.images = null; // Key exists but was rejected; plans fail closed.
        }
      } else {
        studio.provider = new MockAIProvider();
        studio.images = new MockImageProvider();
      }
      studio.transcription =
        p.transcriptionProvider === "whisper"
          ? new WhisperCLIProvider(p.whisperModel)
          : p.transcriptionProvider === "openai"
            ? new OpenAIProvider(key || "", p.model)
            : new MockAIProvider();
      return {
        provider: studio.provider.name,
        transcription: studio.transcription.name,
        credentialSource,
      };
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
