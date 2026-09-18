import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runBinary } from "../packages/media/src/index.ts";

// Stub native libraries: this checks initialization order without requiring models.
test("acoustic worker disables ONNX telemetry before loading any ML dependencies", async () => {
  const script = `
import os, runpy, sys, types
os.environ["ORT_DISABLE_TELEMETRY"] = "0"
class Guard:
    def find_spec(self, fullname, path=None, target=None):
        if fullname in ("torch", "whisperx", "silero_vad"):
            assert os.environ.get("ORT_DISABLE_TELEMETRY") == "1", fullname
        return None
sys.meta_path.insert(0, Guard())
import importlib.abc, importlib.util
class Stub(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    def find_spec(self, fullname, path=None, target=None):
        if fullname in ("torch", "whisperx", "silero_vad"):
            return importlib.util.spec_from_loader(fullname, self)
    def create_module(self, spec): return types.ModuleType(spec.name)
    def exec_module(self, module): module.__version__ = "stub"
sys.meta_path.insert(1, Stub())
import importlib.metadata
importlib.metadata.version = lambda name: "stub"
sys.argv = ["scripts/transcription-audio.py", "--probe"]
runpy.run_path(sys.argv[0], run_name="__main__")
`;
  const { stdout } = await promisify(execFile)("python3", ["-c", script]);
  assert.equal(JSON.parse(stdout).device, "cpu");
});

test("native subprocess deaths report the termination signal, not a null exit code", async () => {
  await assert.rejects(
    runBinary(process.execPath, ["-e", "process.kill(process.pid, 'SIGTERM')"]),
    (error: Error) => {
      assert.match(error.message, /terminated by SIGTERM/);
      assert.doesNotMatch(error.message, /exited with null/);
      return true;
    },
  );
});
