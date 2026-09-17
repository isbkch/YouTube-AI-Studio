import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("private IPC launches, shares domain gates, rejects unknown actions and emits structured errors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wts-ipc-"));
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "packages/orchestrator/src/ipc.ts"],
    {
      env: { ...process.env, WTS_HOME: root },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const pending = new Map<string, (value: Record<string, unknown>) => void>();
  let counter = 0;
  const lines = createInterface({ input: child.stdout });
  let resolveReady: () => void;
  const ready = new Promise<void>((r) => {
    resolveReady = r;
  });
  let errors = "";
  child.stderr.on("data", (d) => {
    errors += d.toString();
  });
  lines.on("line", (line) => {
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (obj.event === "ready") resolveReady();
    if (typeof obj.id === "string") {
      pending.get(obj.id)?.(obj);
      pending.delete(obj.id);
    }
  });
  async function call(method: string, params: Record<string, unknown> = {}) {
    const id = String(++counter);
    const result = new Promise<Record<string, unknown>>((r) =>
      pending.set(id, r),
    );
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    return result;
  }
  const timer = setTimeout(() => child.kill(), 15000);
  try {
    await ready;
    const created = await call("project.create", {
      title: "IPC Project",
      description: "Test",
      targetDuration: 60,
    });
    const p = created.result as { id: string };
    assert.ok(p.id);
    const blocked = await call("media.import", {
      projectId: p.id,
      path: "/never-read.mp4",
    });
    assert.equal((blocked.error as { kind: string }).kind, "CONFLICT");
    await call("script.save", { projectId: p.id, text: "Approved words." });
    await call("script.approve", { projectId: p.id, version: 1 });
    const snap = await call("project.get", { projectId: p.id });
    assert.equal((snap.result as { status: string }).status, "READY_TO_RECORD");
    const unsupported = await call("execute.shell", { command: "echo unsafe" });
    assert.equal((unsupported.error as { kind: string }).kind, "UNSUPPORTED");
    // Milestone 4 — the pre-production agent chain over private IPC.
    const pp = (
      await call("project.create", {
        title: "IPC Preproduction",
        description: "Why multi-region failover still fails at 3 AM",
        targetDuration: 600,
      })
    ).result as { id: string };
    const researched = await call("research.run", { projectId: pp.id });
    assert.equal(
      (researched.result as { status: string }).status,
      "RESEARCHING",
    );
    await call("narrative.run", { projectId: pp.id });
    const drafted = await call("script.draft", { projectId: pp.id });
    assert.equal(
      (drafted.result as { status: string }).status,
      "AWAITING_SCRIPT_APPROVAL",
    );
    const visualized = await call("previsualization.run", { projectId: pp.id });
    assert.ok((visualized.result as { runSheet: string }).runSheet.length > 0);
    await call("script.approve", { projectId: pp.id, version: 1 });
    const prompt = await call("teleprompter.get", { projectId: pp.id });
    assert.match(
      (prompt.result as { text: string }).text,
      /Teleprompter — IPC Preproduction/,
    );
    assert.match(
      (prompt.result as { text: string }).text,
      /## Recording run sheet/,
    );
    assert.equal(
      (await call("request.cancel", { requestId: "absent" })).error,
      undefined,
    );
    // Generated-media providers are chosen per type and persist in the library.
    const initial = await call("provider.settings");
    assert.equal((initial.result as { images: string }).images, "mock");
    assert.equal((initial.result as { music: string }).music, "library");
    const configured = await call("provider.configure", {
      provider: "mock",
      transcriptionProvider: "mock",
      imageProvider: "mock",
      musicProvider: "mock",
      musicModel: "lyria-3-clip-preview",
    });
    const applied = configured.result as {
      images: string;
      music: string;
      musicModel: string;
    };
    assert.equal(applied.images, "mock");
    assert.equal(applied.music, "mock");
    assert.equal(applied.musicModel, "deterministic-v1");
    const stored = (await call("provider.settings")).result as {
      music: string;
      musicModel: string;
    };
    assert.equal(stored.music, "mock");
    assert.equal(stored.musicModel, "lyria-3-clip-preview");
    assert.equal(errors.includes("sk-"), false);
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
    lines.close();
    await rm(root, { recursive: true, force: true });
  }
});
