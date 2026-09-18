import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../packages/orchestrator/src/store.ts";
import { Studio } from "../packages/orchestrator/src/studio.ts";
import { publishToYouTube } from "../packages/orchestrator/src/youtube.ts";
import { verifyThumbnailImage } from "../packages/orchestrator/src/thumbnails.ts";
import { fileHash } from "../packages/shared/src/index.ts";
import { renderThumbnail } from "../packages/remotion-engine/src/thumbnail.ts";
import {
  MockImageProvider,
  type ImageRequest,
} from "../packages/image-engine/src/index.ts";
import {
  renderRequest,
  selectRequest,
  slotOf,
  thumbnailProject,
} from "./thumbnail-fixtures.ts";

async function temporary(fn: (store: Store, root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wts-thumbnails-"));
  const store = new Store(root);
  try {
    await fn(store, root);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}
class CountingImages extends MockImageProvider {
  calls = 0;
  failAt = 0;
  override async generate(request: ImageRequest) {
    this.calls++;
    if (this.calls === this.failAt) throw new Error("Provider unavailable");
    return super.generate(request);
  }
}

test("thumbnails render A/B once, retain revisions, recompose headlines offline, export exact bytes and restore", () =>
  temporary(async (store, root) => {
    const { p, studio } = await thumbnailProject(store);
    const images = new CountingImages();
    studio.images = images;
    await studio.renderThumbnails(p.id, renderRequest(studio, p.id));
    assert.equal(images.calls, 2);
    const unchangedA = slotOf(studio, p.id, "A");
    await studio.updateThumbnail(p.id, {
      packagingVersion: 1,
      slot: "A",
      expectedRevision: unchangedA.version,
      conceptId: unchangedA.conceptId,
      headline: unchangedA.headline,
      direction: unchangedA.direction,
    });
    assert.deepEqual(slotOf(studio, p.id, "A"), unchangedA);
    await studio.exportThumbnails(p.id, 1, root);
    assert.equal(store.get(p.id).usage.filter((u) => u.imageCount).length, 2);
    const a = slotOf(studio, p.id, "A").revisions[0];
    const originalB = slotOf(studio, p.id, "B").revisions[0];
    assert.notEqual(a.background.hash, originalB.background.hash);
    assert.ok(
      store.jobs(p.id).some((j) => j.id === a.jobId && j.status === "COMPLETE"),
    );
    await studio.renderThumbnails(p.id, renderRequest(studio, p.id));
    assert.equal(images.calls, 2);
    await studio.selectThumbnail(p.id, selectRequest(studio, p.id, "A"));
    await studio.approvePackaging(p.id, 1);
    const approval = structuredClone(store.get(p.id).publishApproval);
    const b = slotOf(studio, p.id, "B");
    await studio.updateThumbnail(p.id, {
      packagingVersion: 1,
      slot: "B",
      expectedRevision: b.version,
      conceptId: b.conceptId,
      headline: "FIND THE SINGLE POINT.",
      direction: b.direction,
    });
    studio.images = null;
    await studio.renderThumbnails(p.id, renderRequest(studio, p.id, ["B"]));
    const revisedB = slotOf(studio, p.id, "B").revisions.at(-1)!;
    assert.equal(revisedB.revision, 2);
    assert.equal(revisedB.background.hash, originalB.background.hash);
    assert.equal(images.calls, 2);
    assert.deepEqual(store.get(p.id).publishApproval, approval);
    assert.equal(
      slotOf(studio, p.id, "A").revisions[0].outputHash,
      a.outputHash,
    );
    const exported = await studio.exportThumbnails(p.id, 1, root);
    assert.equal(
      await fileHash(path.join(exported.directory, "A.jpg")),
      a.outputHash,
    );
    assert.equal(
      await fileHash(path.join(exported.directory, "B.jpg")),
      revisedB.outputHash,
    );
    assert.equal(
      JSON.parse(
        await readFile(path.join(exported.directory, "manifest.json"), "utf8"),
      ).variants[1].revision,
      2,
    );
    await studio.selectThumbnail(p.id, selectRequest(studio, p.id, "B"));
    assert.equal(store.get(p.id).publishApproval, null);
    const reopened = new Store(root);
    try {
      assert.deepEqual(
        new Studio(reopened).thumbnailDocument(p.id)!.state,
        studio.thumbnailDocument(p.id)!.state,
      );
    } finally {
      reopened.close();
    }
  }));

test("a failed B preserves A and retries only B; incomplete pairs cannot export", () =>
  temporary(async (store, root) => {
    const { p, studio } = await thumbnailProject(store);
    const images = new CountingImages();
    images.failAt = 2;
    studio.images = images;
    await assert.rejects(
      studio.renderThumbnails(p.id, renderRequest(studio, p.id)),
      /Provider unavailable/,
    );
    assert.equal(slotOf(studio, p.id, "A").status, "READY");
    assert.equal(slotOf(studio, p.id, "B").status, "FAILED");
    await studio.selectThumbnail(p.id, selectRequest(studio, p.id, "A"));
    await assert.rejects(
      studio.exportThumbnails(p.id, 1, root),
      /both current variants/,
    );
    const first = slotOf(studio, p.id, "A").revisions[0].outputHash;
    await studio.renderThumbnails(p.id, renderRequest(studio, p.id, ["B"]));
    assert.equal(images.calls, 3);
    assert.equal(slotOf(studio, p.id, "A").revisions[0].outputHash, first);
  }));

test("composition cache follows the actual renderer and bypasses unidentified renderers", () =>
  temporary(async (store) => {
    const { p, studio } = await thumbnailProject(store);
    await studio.renderThumbnails(p.id, renderRequest(studio, p.id, ["A"]));
    const first = slotOf(studio, p.id, "A").revisions[0].inputHash;
    const original = studio.thumbnailRenderer;
    let calls = 0;
    studio.thumbnailRenderer = async (input) => {
      calls++;
      await original(input);
    };
    studio.thumbnailRenderer.identity = async () => "different-renderer-v1";
    await studio.renderThumbnails(p.id, renderRequest(studio, p.id, ["A"]));
    assert.equal(calls, 1);
    assert.notEqual(
      slotOf(studio, p.id, "A").revisions.at(-1)!.inputHash,
      first,
    );
    await studio.renderThumbnails(p.id, renderRequest(studio, p.id, ["A"]));
    assert.equal(calls, 1);
    delete studio.thumbnailRenderer.identity;
    await studio.renderThumbnails(p.id, renderRequest(studio, p.id, ["A"]));
    await studio.renderThumbnails(p.id, renderRequest(studio, p.id, ["A"]));
    assert.equal(calls, 3);
  }));

test("composition failure retains paid background and usage; recovery and retry do not regenerate", () =>
  temporary(async (store) => {
    const { p, studio } = await thumbnailProject(store);
    const images = new CountingImages();
    studio.images = images;
    const renderer = studio.thumbnailRenderer;
    studio.thumbnailRenderer = async () => {
      throw new Error("Headline overflow");
    };
    await assert.rejects(
      studio.renderThumbnails(p.id, renderRequest(studio, p.id, ["A"])),
      /Headline overflow/,
    );
    assert.equal(images.calls, 1);
    assert.ok(slotOf(studio, p.id, "A").background);
    assert.equal(store.get(p.id).usage.filter((u) => u.imageCount).length, 1);
    store.update(p.id, (x) => {
      x.thumbnails!.current.slots[0].status = "RUNNING";
    });
    assert.deepEqual(
      studio.thumbnailDocument(p.id)!.state,
      store.get(p.id).thumbnails,
    );
    assert.equal(slotOf(studio, p.id, "A").status, "RUNNING");
    assert.equal(
      slotOf(studio, p.id, "A").version,
      store.get(p.id).thumbnails!.current.slots[0].version,
    );
    await studio.recover(p.id);
    assert.equal(slotOf(studio, p.id, "A").status, "FAILED");
    assert.deepEqual(
      studio.thumbnailDocument(p.id)!.state,
      store.get(p.id).thumbnails,
    );
    studio.images = null;
    studio.thumbnailRenderer = renderer;
    await studio.renderThumbnails(p.id, renderRequest(studio, p.id, ["A"]));
    assert.equal(slotOf(studio, p.id, "A").status, "READY");
    assert.equal(images.calls, 1);
  }));

test("cancelling after A finishes retains A and never starts B", () =>
  temporary(async (store) => {
    const { p, studio: setup } = await thumbnailProject(store);
    const cancel = new AbortController();
    const images = new CountingImages();
    const studio = new Studio(store, undefined, undefined, (event) => {
      if (
        (event as { event: string }).event === "thumbnails.updated" &&
        store.get(p.id).thumbnails?.current.slots[0].status === "READY"
      )
        cancel.abort();
    });
    studio.images = images;
    studio.thumbnailRenderer = setup.thumbnailRenderer;
    await assert.rejects(
      studio.renderThumbnails(p.id, renderRequest(studio, p.id), cancel.signal),
      /cancelled/i,
    );
    assert.equal(images.calls, 1);
    assert.equal(slotOf(studio, p.id, "A").status, "READY");
    assert.equal(slotOf(studio, p.id, "B").status, "CONCEPT");
  }));

test("regeneration is explicit, stale edits fail, selection remains pinned and repackaging archives it", () =>
  temporary(async (store) => {
    const { p, studio } = await thumbnailProject(store);
    const images = new CountingImages();
    studio.images = images;
    await studio.renderThumbnails(p.id, renderRequest(studio, p.id, ["A"]));
    await studio.selectThumbnail(p.id, selectRequest(studio, p.id, "A"));
    await studio.approvePackaging(p.id, 1);
    const selected = structuredClone(store.get(p.id).thumbnails!.selected);
    const a = slotOf(studio, p.id, "A");
    await studio.regenerateThumbnail(p.id, {
      packagingVersion: 1,
      slot: "A",
      expectedRevision: a.version,
    });
    assert.equal(images.calls, 2);
    assert.deepEqual(store.get(p.id).thumbnails!.selected, selected);
    assert.ok(store.get(p.id).publishApproval);
    const completedRevisions = slotOf(studio, p.id, "A").revisions;
    await assert.rejects(
      studio.updateThumbnail(p.id, {
        packagingVersion: 1,
        slot: "A",
        expectedRevision: a.version,
        conceptId: a.conceptId,
        headline: "STALE",
        direction: a.direction,
      }),
      /changed while/,
    );
    await studio.packageVideo(p.id);
    assert.equal(store.get(p.id).publishApproval, null);
    assert.equal(studio.thumbnailDocument(p.id)!.state.selected, null);
    assert.deepEqual(
      studio.thumbnailDocument(p.id)!.state.history[0].slots[0].revisions,
      completedRevisions,
    );
    await assert.rejects(
      studio.renderThumbnails(p.id, {
        packagingVersion: 1,
        slots: [{ slot: "A", expectedRevision: 0 }],
      }),
      /current packaging/,
    );
  }));

test("approval and publication reject tampered, missing and symlinked images", () =>
  temporary(async (store, root) => {
    const { p, studio } = await thumbnailProject(store);
    await studio.renderThumbnails(p.id, renderRequest(studio, p.id, ["A"]));
    await studio.selectThumbnail(p.id, selectRequest(studio, p.id, "A"));
    const selected = store.get(p.id).thumbnails!.selected!;
    const file = path.join(store.dir(p), selected.path);
    const bytes = await readFile(file);
    await writeFile(file, "tampered");
    await assert.rejects(
      studio.approvePackaging(p.id, 1),
      /changed or is missing/,
    );
    await writeFile(file, bytes);
    await studio.approvePackaging(p.id, 1);
    await writeFile(file, "tampered after approval");
    await assert.rejects(studio.publish(p.id), /changed or is missing/);
    await rm(file);
    await assert.rejects(studio.publish(p.id), /changed or is missing/);
    const external = path.join(root, "external.jpg");
    await writeFile(external, bytes);
    await symlink(external, file);
    await assert.rejects(studio.publish(p.id), /symlink/i);
    assert.equal(store.get(p.id).publication, null);
  }));

async function fakeUploader(
  root: string,
  fail: boolean,
  fn: () => Promise<void>,
) {
  const previous = process.env.WTS_YOUTUBEUPLOADER_PATH;
  const extra = process.env.WTS_YOUTUBE_ARGS;
  const cli = path.join(root, "uploader");
  // A path local to this temporary directory; shell arguments are supplied by the runtime.
  await writeFile(
    cli,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "$(dirname "$0")/args.txt"\necho 'Upload successful! Video ID: dQw4w9WgXcQ'\n${fail ? "echo 'error applying thumbnail' >&2\nexit 1" : "exit 0"}\n`,
    { mode: 0o755 },
  );
  process.env.WTS_YOUTUBEUPLOADER_PATH = cli;
  delete process.env.WTS_YOUTUBE_ARGS;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.WTS_YOUTUBEUPLOADER_PATH;
    else process.env.WTS_YOUTUBEUPLOADER_PATH = previous;
    if (extra === undefined) delete process.env.WTS_YOUTUBE_ARGS;
    else process.env.WTS_YOUTUBE_ARGS = extra;
  }
}

test("upload passes the exact approved image, then freezes selection and preserves export", () =>
  temporary(async (store, root) => {
    const { p, studio } = await thumbnailProject(store);
    await studio.renderThumbnails(p.id, renderRequest(studio, p.id));
    await studio.selectThumbnail(p.id, selectRequest(studio, p.id, "B"));
    await studio.approvePackaging(p.id, 1);
    await fakeUploader(root, false, async () => {
      const published = await studio.publish(p.id);
      const args = (await readFile(path.join(root, "args.txt"), "utf8")).split(
        "\n",
      );
      assert.equal(
        args[args.indexOf("-thumbnail") + 1],
        path.join(store.dir(p), published.publishApproval!.thumbnail!.path),
      );
      assert.equal(published.publication!.thumbnailStatus, "applied");
      assert.equal(published.publication!.warning, null);
      await assert.rejects(studio.publish(p.id), /already published/);
      await assert.rejects(
        studio.selectThumbnail(p.id, selectRequest(studio, p.id, "A")),
        /current packaging/,
      );
      assert.ok((await studio.exportThumbnails(p.id, 1, root)).directory);
    });
  }));

test("video-created/thumbnail-failed is one-shot and reports incomplete finishing", () =>
  temporary(async (store, root) => {
    const { p, studio } = await thumbnailProject(store);
    await studio.renderThumbnails(p.id, renderRequest(studio, p.id, ["A"]));
    await studio.selectThumbnail(p.id, selectRequest(studio, p.id, "A"));
    await studio.approvePackaging(p.id, 1);
    await fakeUploader(root, true, async () => {
      const result = await studio.publish(p.id);
      assert.equal(result.publication!.videoId, "dQw4w9WgXcQ");
      assert.equal(result.publication!.thumbnailStatus, "unconfirmed");
      assert.match(result.publication!.warning!, /not confirmed/);
      await assert.rejects(studio.publish(p.id), /already published/);
    });
  }));

test("a failing video-created callback preserves the video ID without an uncaught stream exception", () =>
  temporary(async (_store, root) => {
    await fakeUploader(root, false, async () => {
      const result = await publishToYouTube({
        video: "fixture.mp4",
        metaFile: "fixture.json",
        onVideoCreated: () => {
          throw new Error("temporary persistence failure");
        },
      });
      assert.equal(result.videoId, "dQw4w9WgXcQ");
      assert.match(result.warning!, /recording its ID during upload failed/);
    });
  }));

test("legacy no-thumbnail approvals work and conflicting thumbnail flags fail before invoking a CLI", () =>
  temporary(async (store, root) => {
    const { p, studio } = await thumbnailProject(store);
    store.update(p.id, (x) => {
      delete x.thumbnails;
    });
    assert.equal(studio.thumbnailDocument(p.id)!.state.current.slots.length, 2);
    await studio.approvePackaging(p.id, 1);
    store.update(p.id, (x) => {
      delete x.publishApproval!.thumbnail;
    });
    await fakeUploader(root, false, async () => {
      await studio.publish(p.id);
      assert.ok(
        !(await readFile(path.join(root, "args.txt"), "utf8"))
          .split("\n")
          .includes("-thumbnail"),
      );
    });
    for (const flag of [
      "-thumbnail",
      "--thumbnail",
      "-thumbnail=/tmp/unapproved.jpg",
      "--thumbnail=/tmp/unapproved.jpg",
    ])
      await assert.rejects(
        publishToYouTube({
          video: "unused",
          metaFile: "unused",
          extraArgs: [flag],
        }),
        /cannot override/,
      );
  }));

test("invalid output is never selectable and incorrect dimensions are rejected", () =>
  temporary(async (store, root) => {
    const { p, studio } = await thumbnailProject(store);
    studio.thumbnailRenderer = async ({ output }) => {
      await writeFile(output, "not an image");
    };
    await assert.rejects(
      studio.renderThumbnails(p.id, renderRequest(studio, p.id, ["A"])),
      /JPEG or PNG/,
    );
    assert.equal(slotOf(studio, p.id, "A").revisions.length, 0);
    await assert.rejects(
      studio.selectThumbnail(p.id, {
        ...selectRequest(studio, p.id, "A"),
        revision: 1,
      }),
      /completed thumbnail/,
    );
    const png = await new MockImageProvider().generate({
      prompt: "square",
      size: "1024x1024",
      quality: "low",
    });
    const file = path.join(root, "square.png");
    await writeFile(file, png.data);
    await assert.rejects(verifyThumbnailImage(file, true), /JPEG or PNG/);
    for (const invalid of [Buffer.alloc(0), Buffer.from([0xff, 1, 2])]) {
      await writeFile(file, invalid);
      await assert.rejects(
        renderThumbnail({
          background: file,
          headline: "EXACT WORDS",
          brand: p.creator.brand,
          output: path.join(root, "never-rendered.jpg"),
        }),
        /background must be a JPEG or PNG/,
      );
    }
  }));
