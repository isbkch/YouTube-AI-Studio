import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { Store } from "../packages/orchestrator/src/store.ts";
import { Studio } from "../packages/orchestrator/src/studio.ts";
import {
  ffmpeg,
  runTool,
  inspect,
  verifyOutput,
} from "../packages/media/src/index.ts";
import { renderPlaceholder } from "../packages/remotion-engine/src/index.ts";
import {
  atomicJSON,
  defaultCreator,
  fileHash,
  hash,
} from "../packages/shared/src/index.ts";
const repo = fileURLToPath(new URL("..", import.meta.url));
export async function demo(
  root = process.env.WTS_HOME || path.join(repo, ".demo"),
) {
  const fixtures = path.join(root, "fixtures");
  await mkdir(fixtures, { recursive: true });
  const text = await readFile(
    path.join(repo, "examples/redundancy/script.txt"),
    "utf8",
  );
  const paragraphs = text
    .trim()
    .split(/\n\s*\n/)
    .slice(1);
  const version = hash({ text, fixtureVersion: 2 }).slice(0, 12);
  const footage = path.join(fixtures, `synthetic-aroll-${version}.mp4`);
  let exists = false;
  try {
    exists = (await inspect(footage)).duration >= 71.9;
  } catch {
    /* Generate initial fixture. */
  }
  if (!exists) {
    console.log(
      "Generating clearly labelled synthetic A-roll and local system-voice narration…",
    );
    const still = path.join(fixtures, "presenter-placeholder.png");
    await renderPlaceholder(still, defaultCreator.brand);
    const parts: string[] = [];
    for (let i = 0; i < paragraphs.length; i++) {
      const script = path.join(fixtures, `speech-${i}.txt`),
        speech = path.join(fixtures, `speech-${i}.aiff`),
        wav = path.join(fixtures, `speech-${i}.wav`);
      await writeFile(script, paragraphs[i]);
      await runTool("say", ["-r", "190", "-f", script, "-o", speech]);
      const duration = (await inspect(speech)).duration;
      if (duration > 12)
        throw new Error(
          `Demo speech ${i} takes ${duration}s; raise speech rate or shorten fixture.`,
        );
      await ffmpeg([
        "-i",
        speech,
        "-af",
        "apad",
        "-t",
        "12",
        "-ar",
        "48000",
        "-ac",
        "2",
        wav,
      ]);
      parts.push(wav);
    }
    const concat = path.join(fixtures, "narration.concat");
    await writeFile(
      concat,
      parts.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"),
    );
    const narration = path.join(fixtures, "narration.wav");
    await ffmpeg([
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concat,
      "-c",
      "copy",
      narration,
    ]);
    await ffmpeg([
      "-loop",
      "1",
      "-framerate",
      "30",
      "-i",
      still,
      "-i",
      narration,
      "-t",
      "72",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-tune",
      "stillimage",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "160k",
      "-movflags",
      "+faststart",
      footage,
    ]);
  }
  const store = new Store(root);
  let last = "";
  const studio = new Studio(store, undefined, (event) => {
    const e = event as {
      job?: { label: string; status: string; progress: number };
    };
    if (e.job) {
      const msg = `${e.job.status.padEnd(9)} ${e.job.label}`;
      if (msg !== last && e.job.status !== "BLOCKED") {
        console.log(msg);
        last = msg;
      }
    }
  });
  try {
    const p = store.create(
      "Why Redundancy Is Not High Availability",
      "Credit-free demo with synthetic placeholder A-roll and local system narration.",
      72,
    );
    await studio.saveScript(p.id, text);
    await studio.approveScript(p.id, 1);
    await studio.importMedia(p.id, footage);
    const before = await fileHash(
      path.join(store.dir(p), store.get(p.id).recordings[0].path),
    );
    const transcript = {
      schemaVersion: "1.0.0",
      recordingId: store.get(p.id).recordings[0].id,
      language: "en",
      provider: "mock",
      model: "aligned-demo-fixture-v1",
      segments: paragraphs.map((text, i) => ({
        id: `segment-${i + 1}`,
        start: i * 12,
        end: (i + 1) * 12,
        text,
      })),
    };
    await atomicJSON(path.join(repo, "examples/redundancy/transcript.json"), {
      ...transcript,
      recordingId: "demo-recording",
    });
    await studio.loadTranscript(p.id, transcript);
    await studio.generatePlan(p.id);
    const plan = store.get(p.id).plans[0];
    const fixturePlan = {
      ...plan,
      projectId: "demo-project",
      id: "demo-plan",
      createdAt: "2026-09-16T00:00:00.000Z",
      transcriptHash: hash({ ...transcript, recordingId: "demo-recording" }),
      scenes: plan.scenes.map((s) => ({
        ...s,
        camera: { ...s.camera, recordingId: "demo-recording" },
      })),
    };
    await atomicJSON(
      path.join(repo, "examples/redundancy/production-plan.json"),
      fixturePlan,
    );
    await atomicJSON(
      path.join(repo, "examples/redundancy/director-response.json"),
      fixturePlan,
    );
    await studio.approvePlan(p.id, 1);
    await studio.build(p.id);
    const originalAssets = store
      .assets(p.id)
      .filter((a) => a.type === "remotion-render");
    assert.equal(originalAssets.length, 4);
    assert.ok(originalAssets.every((a) => !a.reused));
    const callout = plan.scenes[1];
    const patch = await studio.proposeOperations(
      p.id,
      [
        {
          type: "updateGraphicParameters",
          sceneId: callout.id,
          parameters: {
            ...callout.visual.graphic!.parameters,
            title: "Two copies can still fail together.",
          },
        },
      ],
      "Make the shared failure domain clearer.",
    );
    await studio.decidePatch(p.id, patch.id, true);
    await studio.approvePlan(p.id, 2);
    console.log(
      "Rebuilding one changed callout; other graphics must hit verified cache…",
    );
    await studio.build(p.id);
    const revised = store
      .assets(p.id)
      .filter(
        (a) => a.type === "remotion-render" && a.productionPlanVersion === 2,
      );
    assert.equal(revised.filter((a) => !a.reused).length, 1);
    assert.equal(revised.filter((a) => a.reused).length, 3);
    assert.equal(
      store
        .assets(p.id)
        .filter(
          (a) =>
            a.type === "preview-segment" &&
            a.productionPlanVersion === 2 &&
            !a.reused,
        ).length,
      1,
    );
    assert.equal(
      await fileHash(
        path.join(store.dir(p), store.get(p.id).recordings[0].path),
      ),
      before,
    );
    const current = store.get(p.id),
      latest = current.builds.at(-1)!;
    await verifyOutput(path.join(store.dir(p), latest.previewPath), 72);
    const receipt = {
      projectId: p.id,
      root,
      projectDirectory: store.dir(p),
      preview: path.join(store.dir(p), latest.previewPath),
      resolveExport: path.join(store.dir(p), latest.exportPath),
      duration: 72,
      scenes: plan.scenes.length,
      graphics: 4,
      incrementalRebuild: {
        regeneratedGraphics: 1,
        reusedGraphics: 3,
        regeneratedSegments: 1,
        reusedSegments: 5,
      },
      sourceUnchanged: true,
      scriptGate: "approved by deterministic demo harness",
      roughCutGate: "awaiting human approval",
      provider: "mock",
      apiCostUSD: 0,
    };
    await atomicJSON(path.join(root, "demo-result.json"), receipt);
    console.log(JSON.stringify(receipt, null, 2));
    return receipt;
  } finally {
    store.close();
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await demo();
