import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  hash,
  inside,
  safePath,
  slugify,
} from "../packages/shared/src/index.ts";
import { transition } from "../packages/orchestrator/src/model.ts";
import { Store } from "../packages/orchestrator/src/store.ts";
import {
  validatePlan,
  applyPatch,
  graphicKey,
} from "../packages/production-plan/src/index.ts";
import { fixture } from "./fixtures.ts";
test("plan rejects gaps, unknown executable actions, duplicate IDs and invalid graphics", () => {
  const p = fixture();
  assert.equal(validatePlan(p).durationFrames, 90);
  assert.throws(() => validatePlan({ ...p, shell: "rm -rf /" }));
  p.scenes[0].startFrame = 1;
  assert.throws(() => validatePlan(p));
  p.scenes[0].startFrame = 0;
  assert.throws(() =>
    validatePlan({ ...p, scenes: [...p.scenes, ...p.scenes] }),
  );
  p.scenes[0].visual.type = "graphic";
  assert.throws(() => validatePlan(p));
});
test("state transitions enforce all human gates", () => {
  assert.equal(
    transition("AWAITING_SCRIPT_APPROVAL", "READY_TO_RECORD"),
    "READY_TO_RECORD",
  );
  assert.throws(() => transition("IDEA", "MEDIA_IMPORTED"));
  assert.throws(() =>
    transition("AWAITING_ROUGH_CUT_APPROVAL", "AWAITING_PUBLISH_APPROVAL"),
  );
  assert.throws(() => transition("READY_TO_RENDER", "PUBLISHED"));
});
test("hashes are canonical and graphic cache ignores plan revision", () => {
  assert.equal(hash({ b: 2, a: 1 }), hash({ a: 1, b: 2 }));
  const p = fixture();
  assert.equal(
    graphicKey(p.scenes[0], p, {}, "template"),
    graphicKey(p.scenes[0], { ...p, version: 9 }, {}, "template"),
  );
  assert.notEqual(
    graphicKey(p.scenes[0], p, {}, "a"),
    graphicKey(p.scenes[0], p, {}, "b"),
  );
});
test("patch is immutable, checks concurrency and scope", () => {
  const p = fixture();
  const patch = {
    id: "patch-1",
    createdAt: new Date().toISOString(),
    originatingRequest: "Punch in",
    rationale: "Emphasis",
    affectedScenes: ["scene-1"],
    previousVersion: 1,
    resultingVersion: 2,
    operations: [
      {
        type: "updateFraming",
        sceneId: "scene-1",
        framing: "close",
        punchIn: 1.1,
      },
    ],
  };
  const result = applyPatch(p, patch);
  assert.equal(result.scenes[0].camera.punchIn, 1.1);
  assert.equal(p.scenes[0].camera.punchIn, 1);
  assert.throws(() => applyPatch(result, patch));
  assert.throws(() => applyPatch(p, { ...patch, affectedScenes: ["other"] }));
});
test("filesystem rejects traversal and symlinks; SQLite persists snapshots and locks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wts-test-"));
  try {
    assert.throws(() => inside(root, "../secret"));
    assert.throws(() => inside(root, "/etc/passwd"));
    await symlink(os.tmpdir(), path.join(root, "link"));
    await assert.rejects(safePath(root, "link/secret"));
    assert.equal(slugify("../../Hello world"), "hello-world");
    const store = new Store(root);
    const p = store.create("A project");
    const release = store.acquire(p.id);
    assert.throws(() => store.acquire(p.id));
    release();
    store.close();
    const reopened = new Store(root);
    assert.equal(reopened.get(p.id).title, "A project");
    reopened.close();
    await mkdir(path.join(root, "nested"));
    assert.equal(
      await safePath(root, "nested/new"),
      path.join(root, "nested/new"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
