import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executable, runBinary } from "../packages/media/src/index.ts";

// Exercise the real Python bridge against the documented Resolve API. A render
// is asynchronous: a queued/partial file is not proof of successful completion.
const harness = `
import os, runpy, sys, time, types
bridge, timeline, output, status = sys.argv[1:]
class Timeline:
    def GetName(self): return "Test timeline"
class Project:
    polls = 0
    started = False
    def GetName(self): return "Test project"
    def SetSetting(self, key, value):
        assert (key, value) in [("timelineFrameRate", "30"), ("timelineResolutionWidth", "1920"), ("timelineResolutionHeight", "1080")], (key, value)
        return True
    def GetMediaPool(self): return self
    def ImportTimelineFromFile(self, file, options):
        assert file == timeline
        return Timeline()
    def SetCurrentTimeline(self, timeline): return True
    def LoadRenderPreset(self, preset): return preset == "H.264 Master"
    def SetRenderSettings(self, settings):
        assert settings["TargetDir"] == os.path.dirname(output)
        return True
    def AddRenderJob(self): return "only-this-job"
    def StartRendering(self, jobs):
        assert jobs == ["only-this-job"]
        self.started = True
        return True
    def IsRenderingInProgress(self):
        assert self.started
        self.polls += 1
        return self.polls < 3
    def GetRenderJobStatus(self, job):
        assert job == "only-this-job" and self.polls == 3
        return {"JobStatus": status, "Error": "Codec failed"}
class Manager:
    def GetCurrentProject(self): return None
    def GetProjectListInCurrentFolder(self): return []
    def CreateProject(self, name): return Project()
class Resolve:
    def GetVersionString(self): return "21.1"
    def GetProductName(self): return "DaVinci Resolve Studio"
    def GetProjectManager(self): return Manager()
sys.modules["DaVinciResolveScript"] = types.SimpleNamespace(scriptapp=lambda name: Resolve())
time.sleep = lambda seconds: None
sys.argv = [bridge, "render", timeline, "Test project", output, "H.264 Master"]
runpy.run_path(bridge, run_name="__main__")
`;

test("Resolve final render waits for its queued job and rejects failed partial output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wts-resolve-"));
  try {
    const timeline = path.join(root, "timeline.fcpxml");
    const output = path.join(root, "final.mp4");
    await writeFile(timeline, "timeline");
    await writeFile(output, "partial-or-complete-output");
    const python = await executable("python3");
    for (const status of ["Complete", "Failed", "Cancelled"]) {
      const { stdout } = await runBinary(python, [
        "-c",
        harness,
        path.resolve("packages/resolve-engine/src/bridge.py"),
        timeline,
        output,
        status,
      ]);
      const result = JSON.parse(
        stdout
          .split("\n")
          .find((line) => line.startsWith("WTS_RESULT:"))!
          .slice("WTS_RESULT:".length),
      );
      if (status === "Complete") {
        assert.equal(result.available, true);
        assert.equal(result.renderJob, "only-this-job");
        assert.equal(result.renderStatus, "Complete");
        assert.equal(result.output, output);
      } else {
        assert.equal(result.available, false);
        assert.match(result.reason, new RegExp(`status ${status}`));
        assert.match(result.reason, /Codec failed/);
        assert.equal(result.output, undefined);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The markers action is read-only against the currently open project: it must
// report timeline markers with their absolute frames and offset clip markers
// by the clip's timeline start, sorted by frame.
const markersHarness = `
import runpy, sys, types
bridge = sys.argv[1]
class Item:
    def GetName(self): return "take-a.mov"
    def GetStart(self): return 60
    def GetMarkers(self):
        return {5: {"color": "Blue", "name": None, "note": "Trim the breath", "duration": 1}}
class Timeline:
    def GetName(self): return "WTS Demo v1"
    def GetStartFrame(self): return 108000
    def GetEndFrame(self): return 108150
    def GetTrackCount(self, kind): assert kind == "video"; return 1
    def GetItemListInTrack(self, kind, index):
        assert (kind, index) == ("video", 1)
        return [Item()]
    def GetMarkers(self):
        return {
            108045: {"color": "Red", "name": "Opening", "note": "Too dark", "duration": 1},
            108005: {"color": "Yellow", "name": None, "note": "Slow", "duration": 1},
        }
class Project:
    def GetName(self): return "WTS Demo"
    def GetCurrentTimeline(self): return Timeline()
class Manager:
    def GetCurrentProject(self): return Project()
class Resolve:
    def GetVersionString(self): return "21.1"
    def GetProductName(self): return "DaVinci Resolve Studio"
    def GetProjectManager(self): return Manager()
sys.modules["DaVinciResolveScript"] = types.SimpleNamespace(scriptapp=lambda name: Resolve())
sys.argv = [bridge, "markers"]
runpy.run_path(bridge, run_name="__main__")
`;

test("the markers action reads the open timeline sorted, offsetting clip markers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wts-resolve-"));
  try {
    const python = await executable("python3");
    const { stdout } = await runBinary(python, [
      "-c",
      markersHarness,
      path.resolve("packages/resolve-engine/src/bridge.py"),
    ]);
    const result = JSON.parse(
      stdout
        .split("\n")
        .find((line) => line.startsWith("WTS_RESULT:"))!
        .slice("WTS_RESULT:".length),
    );
    assert.equal(result.available, true);
    assert.equal(result.project, "WTS Demo");
    assert.equal(result.timelineStartFrame, 108000);
    assert.deepEqual(
      result.markers.map((m: { frame: number; source: string }) => [
        m.frame,
        m.source,
      ]),
      [
        [65, "clip"],
        [108005, "timeline"],
        [108045, "timeline"],
      ],
    );
    assert.equal(result.markers[0].clipName, "take-a.mov");
    assert.equal(result.markers[0].note, "Trim the breath");
    assert.equal(result.markers[1].name, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
