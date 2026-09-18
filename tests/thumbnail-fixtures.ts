import { writeFile } from "node:fs/promises";
import path from "node:path";
import { MockImageProvider } from "../packages/image-engine/src/index.ts";
import { ffmpeg } from "../packages/media/src/index.ts";
import { Studio } from "../packages/orchestrator/src/studio.ts";
import type { Store } from "../packages/orchestrator/src/store.ts";
import type { ThumbnailSlotId } from "../packages/orchestrator/src/thumbnail-model.ts";
import { hash } from "../packages/shared/src/index.ts";
import { fixture } from "./fixtures.ts";

export async function thumbnailProject(store: Store) {
  const p = store.create(
    "Redundancy is not high availability",
    "Two servers can share one point of failure.",
    3,
  );
  const plan = fixture();
  plan.projectId = p.id;
  await writeFile(
    path.join(store.dir(p), "renders/final.mp4"),
    "fixture-video",
  );
  store.update(p.id, (x) => {
    x.plans = [plan];
    x.status = "READY_TO_RENDER";
    x.finalRender = "renders/final.mp4";
  });
  const studio = new Studio(store);
  studio.images = new MockImageProvider();
  // Domain tests exercise real image verification but mock the expensive compositor.
  studio.thumbnailRenderer = async ({ output, headline, signal }) => {
    await ffmpeg(
      [
        "-f",
        "lavfi",
        "-i",
        `color=c=0x${hash(headline).slice(0, 6)}:s=1280x720`,
        "-frames:v",
        "1",
        "-q:v",
        "2",
        output,
      ],
      signal,
    );
  };
  studio.thumbnailRenderer.identity = async () => "test-solid-jpeg-v1";
  await studio.packageVideo(p.id);
  return { p: store.get(p.id), studio };
}
export const slotOf = (studio: Studio, id: string, slot: ThumbnailSlotId) =>
  studio.thumbnailDocument(id)!.state.current.slots.find((s) => s.id === slot)!;
export const renderRequest = (
  studio: Studio,
  id: string,
  slots: ThumbnailSlotId[] = ["A", "B"],
) => ({
  packagingVersion:
    studio.thumbnailDocument(id)!.state.current.packagingVersion,
  slots: slots.map((slot) => ({
    slot,
    expectedRevision: slotOf(studio, id, slot).version,
  })),
});
export const selectRequest = (
  studio: Studio,
  id: string,
  slot: ThumbnailSlotId,
) => ({
  packagingVersion:
    studio.thumbnailDocument(id)!.state.current.packagingVersion,
  slot,
  revision: slotOf(studio, id, slot).currentRevision,
  expectedRevision: slotOf(studio, id, slot).version,
});
