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
    assert.equal(
      (await call("request.cancel", { requestId: "absent" })).error,
      undefined,
    );
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
