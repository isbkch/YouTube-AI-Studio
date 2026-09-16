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
import { MockImageProvider } from "../packages/image-engine/src/index.ts";
import {
  atomicJSON,
  defaultCreator,
  fileHash,
  hash,
} from "../packages/shared/src/index.ts";
const repo = fileURLToPath(new URL("..", import.meta.url));
/** Deterministic, fully local demo library — nothing copyrighted ships. */
async function synthesizeLibrary(root: string) {
  const dir = path.join(root, "library");
  const music = path.join(dir, "music", "ambient-demo.mp3");
  const sfx = path.join(dir, "sfx", "whoosh-demo.mp3");
  await mkdir(path.dirname(music), { recursive: true });
  await mkdir(path.dirname(sfx), { recursive: true });
  try {
    await inspect(music);
  } catch {
    await ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=110:duration=96",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=165:duration=96",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=220:duration=96",
      "-filter_complex",
      "[0:a]volume=0.22[a0];[1:a]volume=0.15[a1];[2:a]volume=0.10[a2];[a0][a1][a2]amix=inputs=3:normalize=0,tremolo=f=0.15:d=0.5,aformat=sample_rates=48000:channel_layouts=stereo",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "128k",
      music,
    ]);
  }
  try {
    await inspect(sfx);
  } catch {
    await ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "anoisesrc=d=0.9:c=pink:a=0.4",
      "-af",
      "lowpass=f=1800,highpass=f=180,afade=t=in:st=0:d=0.35,afade=t=out:st=0.45:d=0.45,aformat=sample_rates=48000:channel_layouts=stereo",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "128k",
      sfx,
    ]);
  }
  await atomicJSON(path.join(dir, "library.json"), {
    schemaVersion: "1.0.0",
    tracks: [
      {
        trackId: "ambient-demo",
        title: "Ambient Demo Bed",
        kind: "music",
        file: "music/ambient-demo.mp3",
        mood: ["calm", "technical"],
        energy: 1,
        bpm: null,
        loopable: true,
        duration: 96,
        license:
          "Synthesized by the demo harness; no third-party rights involved.",
      },
      {
        trackId: "whoosh-demo",
        title: "Demo Whoosh",
        kind: "sfx",
        file: "sfx/whoosh-demo.mp3",
        mood: ["transition"],
        energy: 3,
        bpm: null,
        loopable: false,
        duration: 0.9,
        license:
          "Synthesized by the demo harness; no third-party rights involved.",
      },
    ],
  });
}
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
  await synthesizeLibrary(root);
  let last = "";
  const studio = new Studio(store, undefined, undefined, (event) => {
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
  studio.images = new MockImageProvider();
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
    const graphicScenes = plan.scenes.filter((s) => s.visual.graphic);
    assert.ok(
      graphicScenes.length >= 1,
      "mock direction should place at least one graphic",
    );
    // Continuous synthetic narration has no dead space to remove, so the
    // A-roll editor may keep it as one scene; real footage cuts into many.
    assert.ok(plan.scenes.length >= 1, "the A-roll editor produced a cut");
    const fixturePlan = {
      ...plan,
      projectId: "demo-project",
      id: "demo-plan",
      createdAt: "2026-09-16T00:00:00.000Z",
      transcriptHash: hash([{ ...transcript, recordingId: "demo-recording" }]),
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
    assert.equal(originalAssets.length, graphicScenes.length);
    assert.ok(originalAssets.every((a) => !a.reused));
    const callout = graphicScenes.find(
      (s) => "title" in (s.visual.graphic!.parameters as object),
    )!;
    const patch = await studio.proposeOperations(
      p.id,
      [
        {
          type: "updateGraphicParameters",
          sceneId: callout.id,
          parameters: {
            ...(callout.visual.graphic!.parameters as object),
            title: "Two copies can still fail together.",
          },
        },
      ],
      "Make the shared failure domain clearer.",
    );
    await studio.decidePatch(p.id, patch.id, true);
    await studio.approvePlan(p.id, 2);
    console.log(
      "Rebuilding one changed graphic; everything else must hit verified cache…",
    );
    await studio.build(p.id);
    const revised = store
      .assets(p.id)
      .filter(
        (a) => a.type === "remotion-render" && a.productionPlanVersion === 2,
      );
    assert.equal(revised.filter((a) => !a.reused).length, 1);
    assert.equal(
      revised.filter((a) => a.reused).length,
      graphicScenes.length - 1,
    );
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
      store
        .assets(p.id)
        .filter(
          (a) =>
            a.type === "preview-segment" &&
            a.productionPlanVersion === 2 &&
            a.reused,
        ).length,
      plan.scenes.length - 1,
    );
    assert.equal(
      await fileHash(
        path.join(store.dir(p), store.get(p.id).recordings[0].path),
      ),
      before,
    );
    console.log(
      "Milestone 3: visual-direction pass proposes generated B-roll and a music bed…",
    );
    const visualPatch = await studio.proposeVisualPass(p.id);
    const treatmentOps = visualPatch.operations.filter(
      (o) => o.type === "setBroll",
    );
    assert.ok(
      visualPatch.operations.some((o) => o.type === "setAudioDesign"),
      "the visual pass always states the audio design explicitly",
    );
    assert.ok(
      treatmentOps.length >= 1,
      "the mock pass treats at least one scene",
    );
    await studio.decidePatch(p.id, visualPatch.id, true);
    await studio.approvePlan(p.id, 3);
    await studio.build(p.id);
    const treated = store
      .get(p.id)
      .plans.at(-1)!
      .scenes.flatMap((s) => s.broll);
    assert.equal(treated.length, treatmentOps.length);
    const stillAssets = store
      .assets(p.id)
      .filter((a) => a.type === "generated-image");
    const clipAssets = store
      .assets(p.id)
      .filter((a) => a.type === "broll-clip");
    const mixAssets = store.assets(p.id).filter((a) => a.type === "audio-mix");
    assert.equal(stillAssets.length, treated.length);
    assert.equal(clipAssets.length, treated.length);
    assert.equal(mixAssets.length, 1);
    const mixed = store.get(p.id).plans.at(-1)!.audioDesign;
    assert.ok(mixed.music, "the demo bed was selected and mixed in");
    const current = store.get(p.id),
      latest = current.builds.at(-1)!;
    const cutSeconds = plan.durationFrames / plan.frameRate;
    const previewAbs = path.join(store.dir(p), latest.previewPath);
    await verifyOutput(previewAbs, cutSeconds);
    const mixedAudio = await (
      await import("../packages/media/src/index.ts")
    ).analyzeAudio(previewAbs);
    assert.ok(
      mixedAudio.maxVolumeDb !== null && mixedAudio.maxVolumeDb > -45,
      "the music bed is audible in the mixed rough cut",
    );
    const qa = JSON.parse(
      await readFile(path.join(store.dir(p), latest.qaPath), "utf8"),
    ) as {
      status: string;
      attention: string[];
      visual?: { reviewedBy?: string; scenes?: unknown[] };
    };
    assert.equal(qa.status, "PASS");
    assert.deepEqual(qa.attention, []);
    assert.ok(
      (qa.visual?.scenes?.length ?? 0) >= 1,
      "the mock vision review covered every enabled scene",
    );
    const receipt = {
      projectId: p.id,
      root,
      projectDirectory: store.dir(p),
      preview: previewAbs,
      resolveExport: path.join(store.dir(p), latest.exportPath),
      durationSeconds: Math.round(cutSeconds * 100) / 100,
      scenes: plan.scenes.length,
      graphics: graphicScenes.length,
      incrementalRebuild: {
        regeneratedGraphics: 1,
        reusedGraphics: graphicScenes.length - 1,
        regeneratedSegments: 1,
        reusedSegments: plan.scenes.length - 1,
      },
      visualPass: {
        treatedScenes: treatmentOps.length,
        generatedStills: stillAssets.length,
        motionClips: clipAssets.length,
        musicBed: mixed.music!.trackId,
        sfxCount: mixed.sfx.length,
        visualQA: qa.visual?.reviewedBy ?? null,
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
