import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../packages/orchestrator/src/store.ts";
import { renderThumbnail } from "../packages/remotion-engine/src/thumbnail.ts";
import { verifyThumbnailImage } from "../packages/orchestrator/src/thumbnails.ts";
import { fileHash } from "../packages/shared/src/index.ts";
import { ffmpeg } from "../packages/media/src/index.ts";
import {
  renderRequest,
  selectRequest,
  slotOf,
  thumbnailProject,
} from "./thumbnail-fixtures.ts";

test(
  "real Remotion thumbnails fit exact text, reject overflow, export and resume without another image",
  { timeout: 180000 },
  async () => {
    const retained = process.env.WTS_THUMBNAIL_VERIFY_ROOT;
    const root = retained
      ? path.resolve(retained)
      : await mkdtemp(path.join(os.tmpdir(), "wts-thumbnail-render-"));
    await mkdir(root, { recursive: true });
    const store = new Store(root);
    try {
      const { studio, p } = await thumbnailProject(store);
      studio.thumbnailRenderer = renderThumbnail;
      const packagingVersion = studio.thumbnailDocument(p.id)!.state.current
        .packagingVersion;
      for (const [slot, headline] of [
        ["A", "TWO SERVERS.\nONE FAILURE."],
        ["B", "FIND THE\nSINGLE POINT."],
      ] as const) {
        const before = slotOf(studio, p.id, slot);
        await studio.updateThumbnail(p.id, {
          packagingVersion,
          slot,
          expectedRevision: before.version,
          conceptId: before.conceptId,
          direction: before.direction,
          headline,
        });
      }
      await studio.renderThumbnails(p.id, renderRequest(studio, p.id));
      for (const slot of ["A", "B"] as const)
        await verifyThumbnailImage(
          path.join(store.dir(p), slotOf(studio, p.id, slot).revisions[0].path),
          true,
        );
      const originalA = slotOf(studio, p.id, "A").revisions[0];
      const before = slotOf(studio, p.id, "A");
      studio.images = null;
      await studio.updateThumbnail(p.id, {
        packagingVersion,
        slot: "A",
        expectedRevision: before.version,
        conceptId: before.conceptId,
        direction: before.direction,
        headline: "W".repeat(50),
      });
      await assert.rejects(
        studio.renderThumbnails(p.id, renderRequest(studio, p.id, ["A"])),
        /two readable lines/,
      );
      assert.equal(
        slotOf(studio, p.id, "A").background!.hash,
        originalA.background.hash,
      );
      const failed = slotOf(studio, p.id, "A");
      await studio.updateThumbnail(p.id, {
        packagingVersion,
        slot: "A",
        expectedRevision: failed.version,
        conceptId: failed.conceptId,
        direction: failed.direction,
        headline: originalA.headline,
      });
      await studio.renderThumbnails(p.id, renderRequest(studio, p.id, ["A"]));
      assert.equal(slotOf(studio, p.id, "A").currentRevision, 1);
      assert.equal(store.get(p.id).usage.filter((u) => u.imageCount).length, 2);
      await studio.selectThumbnail(p.id, selectRequest(studio, p.id, "A"));
      const exported = await studio.exportThumbnails(
        p.id,
        packagingVersion,
        root,
      );
      assert.equal(
        await fileHash(path.join(exported.directory, "A.jpg")),
        originalA.outputHash,
      );
      const manifest = JSON.parse(
        await readFile(path.join(exported.directory, "manifest.json"), "utf8"),
      );
      assert.equal(manifest.variants[0].headline, "TWO SERVERS.\nONE FAILURE.");
      if (retained) {
        // A decodable final lets the same disposable fixture exercise the native UI.
        await ffmpeg([
          "-f",
          "lavfi",
          "-i",
          "color=c=0x101b29:s=1920x1080:r=30",
          "-t",
          "3",
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-pix_fmt",
          "yuv420p",
          path.join(store.dir(p), "renders/final.mp4"),
        ]);
        await writeFile(
          path.join(root, "thumbnail-verification.json"),
          JSON.stringify(
            {
              projectId: p.id,
              projectDirectory: store.dir(p),
              exported,
              images: studio
                .thumbnailDocument(p.id)!
                .state.current.slots.map((s) => ({
                  slot: s.id,
                  file: path.join(store.dir(p), s.revisions[0].path),
                  hash: s.revisions[0].outputHash,
                })),
            },
            null,
            2,
          ),
        );
        console.log(`Thumbnail verification library: ${root}`);
      }
    } finally {
      store.close();
      if (!retained) await rm(root, { recursive: true, force: true });
    }
  },
);
