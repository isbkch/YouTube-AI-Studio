import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  ffmpeg,
  inspect,
  runBinary,
  verifyOutput,
} from "../packages/media/src/index.ts";
import { Store } from "../packages/orchestrator/src/store.ts";
import {
  Studio,
  sceneIndexForFrame,
} from "../packages/orchestrator/src/studio.ts";
import {
  resolveApp,
  resolveCommand,
} from "../packages/resolve-engine/src/index.ts";

// Live Resolve Studio pass: verifies everything the trusted bridge claims
// against a real scripted session — probe, FCPXML import into a uniquely
// named project, and a headless render whose bytes are then decoded. Skips
// itself when scripting is unavailable so the integration suite stays green
// on machines without Resolve Studio. The bridge never deletes projects, so
// this test cleans up its own through the Resolve API directly.

const cleanupHarness = `
import json, sys
import DaVinciResolveScript as dvr
resolve = dvr.scriptapp("Resolve")
if resolve is None:
    print("WTS_CLEANUP:" + json.dumps({"error": "Resolve is not running"}))
    sys.exit(0)
manager = resolve.GetProjectManager()
outcome = {}
for name in sys.argv[1:]:
    try:
        current = manager.GetCurrentProject()
        if current is not None and current.GetName() == name:
            manager.CloseProject(current)
        outcome[name] = bool(manager.DeleteProject(name))
    except Exception as exc:
        outcome[name] = "error: %s" % exc
print("WTS_CLEANUP:" + json.dumps(outcome))
`;

async function cleanupResolveProjects(projects: string[]) {
  if (!projects.length) return;
  try {
    const { stdout } = await runBinary(
      path.join(resolveApp(), "Contents/Applications/ResolvePython"),
      ["-c", cleanupHarness, ...projects],
      { timeoutMs: 60000 },
    );
    const line = stdout.split("\n").find((l) => l.startsWith("WTS_CLEANUP:"));
    console.log(
      "Resolve cleanup:",
      line?.slice("WTS_CLEANUP:".length) ?? "(no result)",
    );
  } catch (err) {
    console.log(
      "Resolve cleanup failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

// Drops review markers through Resolve's own API, standing in for the creator
// marking up the imported timeline during manual review.
const addMarkersHarness = `
import sys
import DaVinciResolveScript as dvr
resolve = dvr.scriptapp("Resolve")
timeline = resolve.GetProjectManager().GetCurrentProject().GetCurrentTimeline()
timeline.AddMarker(int(sys.argv[1]), "Red", "Review", "Check this framing", 1)
items = timeline.GetItemListInTrack("video", 1) or []
if items:
    items[0].AddMarker(10, "Blue", "Clip note", "Trim the breath", 1)
print("WTS_MARKERS:ok")
`;

async function syntheticClip(
  dir: string,
  name: string,
  seconds: number,
  hue: number,
) {
  const file = path.join(dir, name);
  await ffmpeg([
    "-f",
    "lavfi",
    "-i",
    `color=c=0x${hue.toString(16).padStart(6, "0")}:s=640x360:r=30:d=${seconds}`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${400 + (hue % 200)}:duration=${seconds}`,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    file,
  ]);
  return file;
}

test("a real Resolve Studio session imports and renders the exported timeline", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wts-resolve-it-"));
  const store = new Store(root);
  try {
    const probe = await resolveCommand("probe");
    if (!probe.available) {
      console.log(
        "Resolve scripting unavailable; skipping the live pass:",
        probe.reason,
      );
      return;
    }
    assert.ok(probe.version);

    const clips = path.join(root, "clips");
    await mkdir(clips, { recursive: true });
    const clipA = await syntheticClip(clips, "take-a.mp4", 2, 0x204080);
    const clipB = await syntheticClip(clips, "take-b.mp4", 3, 0x804020);
    const studio = new Studio(store);
    const p = store.create(
      "Resolve integration",
      "Live scripted Resolve pass",
      5,
    );
    await studio.saveScript(p.id, "Opening thought. Closing thought.");
    await studio.approveScript(p.id, 1);
    await studio.importMedia(p.id, clipA);
    await studio.importMedia(p.id, clipB);
    const payload = (id: string, text: string, end: number) => ({
      schemaVersion: "1.0.0",
      language: "en",
      provider: "mock",
      model: "fixture",
      segments: [{ id, start: 0, end, text }],
    });
    await studio.loadTranscript(p.id, payload("a-1", "Opening thought.", 2));
    await studio.loadTranscript(p.id, payload("b-1", "Closing thought.", 3));
    await studio.generatePlan(p.id);
    const plan = store.get(p.id).plans.at(-1)!;
    await studio.approvePlan(p.id, plan.version);
    await studio.build(p.id);
    const build = store.get(p.id).builds.at(-1)!;
    const fcpxml = path.join(store.dir(p), build.exportPath);

    const projects: string[] = [];
    try {
      const importName = `WTS Resolve IT ${Date.now()}`;
      const imported = await resolveCommand("import", fcpxml, importName);
      assert.equal(
        imported.available,
        true,
        imported.reason ?? "import failed",
      );
      projects.push(imported.project ?? importName);
      assert.ok(
        (imported.videoTracks ?? 0) >= 1,
        `expected the A-roll video track, got ${imported.videoTracks} video tracks`,
      );
      assert.ok((imported.audioTracks ?? 0) >= 1);
      const frames = (imported.endFrame ?? 0) - (imported.startFrame ?? 0);
      assert.ok(
        Math.abs(frames - plan.durationFrames) <= 2,
        `imported timeline is ${frames} frames, plan expects ${plan.durationFrames}`,
      );

      // Mark up the imported timeline the way a reviewing creator would, then
      // read the markers back mapped onto the plan's scenes.
      await runBinary(
        path.join(resolveApp(), "Contents/Applications/ResolvePython"),
        ["-c", addMarkersHarness, String((imported.startFrame ?? 0) + 45)],
        { timeoutMs: 60000 },
      );
      const marked = await studio.readResolveMarkers(p.id);
      const review = marked.resolveMarkers.at(-1)!;
      assert.equal(review.resolveProject, imported.project ?? "");
      assert.equal(review.planVersion, plan.version);
      assert.ok(
        review.markers.some(
          (m) =>
            m.frame === 45 &&
            m.source === "timeline" &&
            m.sceneIndex === sceneIndexForFrame(plan.scenes, 45),
        ),
        `expected a normalized timeline marker at frame 45, got ${JSON.stringify(review.markers)}`,
      );
      assert.ok(review.markers.some((m) => m.source === "clip"));

      const output = path.join(root, "resolve-final.mp4");
      const renderName = `WTS Resolve IT Final ${Date.now()}`;
      const rendered = await resolveCommand(
        "render",
        fcpxml,
        renderName,
        output,
        "H.264 Master",
      );
      projects.push(rendered.project ?? renderName);
      assert.ok(
        rendered.output,
        `render did not produce output (status ${rendered.renderStatus})`,
      );
      await verifyOutput(rendered.output, plan.durationFrames / plan.frameRate);
      const meta = await inspect(rendered.output);
      assert.equal(meta.width, 1920);
      assert.equal(meta.height, 1080);
      assert.ok(meta.hasAudio);

      // Delivering a render finished in Resolve adopts verified bytes as the
      // final master; the rough-cut preview stands in for the creator's file.
      const approval = {
        version: plan.version,
        hash: "a".repeat(64),
        approvedAt: new Date().toISOString(),
        approvedBy: "creator" as const,
      };
      store.update(p.id, (x) => {
        x.roughCutApproval = approval;
        x.status = "READY_TO_RENDER";
      });
      const delivered = await studio.deliverFinal(
        p.id,
        path.join(store.dir(p), build.previewPath),
      );
      assert.equal(delivered.finalRenderEngine, "resolve-delivered");
      assert.ok(delivered.finalRender);
      assert.ok(
        existsSync(path.join(store.dir(delivered), delivered.finalRender)),
      );
    } finally {
      await cleanupResolveProjects(projects);
    }
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
