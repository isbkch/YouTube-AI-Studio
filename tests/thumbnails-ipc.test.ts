import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { once } from "node:events";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { Store } from "../packages/orchestrator/src/store.ts";
import { renderRequest, thumbnailProject } from "./thumbnail-fixtures.ts";
import type { ThumbnailState } from "../packages/orchestrator/src/thumbnail-model.ts";
import { ffmpeg } from "../packages/media/src/index.ts";
import { fileHash } from "../packages/shared/src/index.ts";

test(
  "native IPC and CLI share thumbnail state, selection gates, editing and pair export",
  { timeout: 30000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wts-thumbnail-ipc-"));
    const store = new Store(root);
    const { p, studio } = await thumbnailProject(store);
    await studio.renderThumbnails(p.id, renderRequest(studio, p.id));
    // Seed a cached frame set keyed to the master's real bytes, so the IPC
    // child serves `thumbnails.frames` from cache without running ffmpeg.
    const frameDir = path.join(
      store.dir(p),
      "packaging",
      "thumbnails",
      "frames",
    );
    await mkdir(frameDir, { recursive: true });
    const frameFile = path.join(frameDir, "frame-0001.jpg");
    await ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "color=c=0x336699:s=1920x1080",
      "-frames:v",
      "1",
      "-q:v",
      "2",
      frameFile,
    ]);
    const masterHash = await fileHash(
      path.join(store.dir(p), "renders/final.mp4"),
    );
    const frameHash = await fileHash(frameFile);
    store.update(p.id, (x) => {
      x.thumbnailFrames = {
        finalRenderHash: masterHash,
        planVersion: 1,
        items: [
          {
            id: "frame-1",
            seconds: 42,
            timecode: "0:42",
            captionText: "never trust defaults",
            loudnessDb: -14.5,
            path: "packaging/thumbnails/frames/frame-0001.jpg",
            hash: frameHash,
          },
        ],
      };
    });
    store.close();
    const env = { ...process.env, WTS_HOME: root };
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "packages/orchestrator/src/ipc.ts"],
      { env, stdio: ["pipe", "pipe", "pipe"] },
    );
    const done = once(child, "exit");
    const pending = new Map<
      string,
      (value: { result?: unknown; error?: { kind: string } }) => void
    >();
    let sequence = 0;
    let readyResolve: () => void;
    const ready = new Promise<void>((resolve) => {
      readyResolve = resolve;
    });
    const lines = createInterface({ input: child.stdout });
    child.stderr.resume();
    lines.on("line", (line) => {
      const packet = JSON.parse(line);
      if (packet.event === "ready") readyResolve();
      if (packet.id) {
        pending.get(packet.id)?.(packet);
        pending.delete(packet.id);
      }
    });
    const timer = setTimeout(() => child.kill(), 25000);
    const call = (method: string, params: Record<string, unknown> = {}) => {
      const id = String(++sequence);
      const response = new Promise<{
        result?: unknown;
        error?: { kind: string };
      }>((resolve) => pending.set(id, resolve));
      child.stdin.write(
        JSON.stringify({ id, method, params: { projectId: p.id, ...params } }) +
          "\n",
      );
      return response;
    };
    try {
      await ready;
      const document = (await call("thumbnails.get")).result as {
        state: ThumbnailState;
      };
      assert.equal(document.state.current.slots.length, 2);
      const a = document.state.current.slots[0];
      assert.ok(
        !(
          await call("thumbnails.select", {
            packagingVersion: 1,
            slot: "A",
            revision: 1,
            expectedRevision: a.version,
          })
        ).error,
      );
      assert.ok(!(await call("packaging.approve", { version: 1 })).error);
      const exported = (
        await call("thumbnails.export", {
          packagingVersion: 1,
          destination: root,
        })
      ).result as { directory: string };
      assert.equal(
        JSON.parse(
          await readFile(
            path.join(exported.directory, "manifest.json"),
            "utf8",
          ),
        ).variants.length,
        2,
      );
      assert.equal(
        (
          await call("thumbnails.render", {
            packagingVersion: 99,
            slots: [{ slot: "A", expectedRevision: a.version }],
          })
        ).error?.kind,
        "CONFLICT",
      );
      assert.equal(
        (
          await call("thumbnails.regenerate", {
            packagingVersion: 1,
            slot: "A",
            expectedRevision: a.version - 1,
          })
        ).error?.kind,
        "CONFLICT",
      );
      // Expressive frames serve from cache over IPC; setFrame keeps the same
      // optimistic-version and frame-validation gates. (The compose path
      // itself runs the real Remotion renderer and is covered by
      // thumbnails.test.ts with the stubbed renderer.)
      const frames = (await call("thumbnails.frames")).result as {
        cached: boolean;
        frames: { id: string; timecode: string }[];
      };
      assert.equal(frames.cached, true);
      assert.equal(frames.frames[0]?.id, "frame-1");
      assert.equal(frames.frames[0]?.timecode, "0:42");
      const b = document.state.current.slots[1];
      assert.equal(
        (
          await call("thumbnails.setFrame", {
            packagingVersion: 1,
            slot: "B",
            expectedRevision: b.version,
            frameId: "frame-404",
          })
        ).error?.kind,
        "INVALID_INPUT",
      );
      assert.equal(
        (
          await call("thumbnails.setFrame", {
            packagingVersion: 1,
            slot: "B",
            expectedRevision: b.version + 99,
            frameId: "frame-1",
          })
        ).error?.kind,
        "CONFLICT",
      );
      const cli = (...args: string[]) =>
        promisify(execFile)(
          process.execPath,
          ["--import", "tsx", "packages/orchestrator/src/cli.ts", ...args],
          { env },
        );
      const selected = JSON.parse(
        (await cli("thumbnails", "get", p.id)).stdout,
      );
      await assert.rejects(
        cli("thumbnails", "export", p.id),
        /Choose an absolute export folder/,
      );
      assert.equal(selected.state.selected.slot, "A");
      await cli("thumbnails", "select", p.id, "none");
      const snap = (await call("project.get")).result as {
        publishApproval: unknown;
      };
      assert.equal(snap.publishApproval, null);
      await cli(
        "thumbnails",
        "edit",
        p.id,
        "B",
        "--headline",
        "ONE SHARED FAILURE",
      );
      const edited = (await call("thumbnails.get")).result as {
        state: ThumbnailState;
      };
      assert.equal(
        edited.state.current.slots[1].headline,
        "ONE SHARED FAILURE",
      );
      assert.equal(edited.state.current.slots[1].status, "CONCEPT");
    } finally {
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      await done;
      lines.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
