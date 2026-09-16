import { readFile, writeFile } from "node:fs/promises";
import { Store } from "../packages/orchestrator/src/store.ts";
import { fileHash, hash, inside } from "../packages/shared/src/index.ts";
import { inspect } from "../packages/media/src/index.ts";
import { validatePlan } from "../packages/production-plan/src/index.ts";
import assert from "node:assert/strict";
const store = new Store(".demo");
try {
  const p = store
    .list()
    .find((p) => p.title === "Native workflow verification");
  assert.ok(p);
  assert.ok(
    ["AWAITING_ROUGH_CUT_APPROVAL", "READY_TO_RENDER"].includes(p.status),
  );
  assert.equal(p.plans.length, 2);
  assert.equal(p.revisions[0].status, "APPLIED");
  const plan = validatePlan(p.plans.at(-1));
  assert.equal(plan.scenes[1].visual.type, "presenter");
  assert.equal(plan.scenes[2].visual.graphic?.template, "ArchitectureFlow");
  const assets = store
    .assets(p.id)
    .filter((a) => a.productionPlanVersion === 2);
  assert.equal(
    assets.filter((a) => a.type === "remotion-render" && a.reused).length,
    3,
  );
  assert.equal(
    assets.filter((a) => a.type === "preview-segment" && !a.reused).length,
    1,
  );
  const r = p.recordings[0];
  assert.equal(await fileHash(inside(store.dir(p), r.path)), r.hash);
  assert.equal(p.scriptApproval?.hash, hash(p.scripts[0]));
  const build = p.builds.at(-1)!;
  if (p.roughCutApproval)
    assert.equal(
      p.roughCutApproval.hash,
      await fileHash(inside(store.dir(p), build.previewPath)),
    );
  const qa = JSON.parse(
    await readFile(inside(store.dir(p), build.qaPath), "utf8"),
  );
  assert.equal(qa.status, "PASS");
  const media = await inspect(inside(store.dir(p), build.previewPath));
  assert.equal(Math.round(media.duration), 72);
  const receipt = {
    verifiedAt: new Date().toISOString(),
    nativeProjectId: p.id,
    projectDirectory: store.dir(p),
    status: p.status,
    planVersions: p.plans.length,
    preview: inside(store.dir(p), build.previewPath),
    media,
    sourceHashPreserved: true,
    roughCutApproved: p.roughCutApproval !== null,
    revision: {
      operation: "removeGraphic",
      affectedScenes: ["scene-002"],
      reusedGraphics: 3,
      regeneratedPreviewSegments: 1,
    },
    qa,
  };
  await writeFile(
    ".demo/native-verification.json",
    JSON.stringify(receipt, null, 2) + "\n",
  );
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  store.close();
}
