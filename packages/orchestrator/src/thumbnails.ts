import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { VideoPackaging } from "../../agents/src/index.ts";
import {
  BROLL_SOURCE_SIZE,
  type ImageProvider,
} from "../../image-engine/src/index.ts";
import { runTool } from "../../media/src/index.ts";
import type { ThumbnailRenderer } from "../../remotion-engine/src/thumbnail.ts";
import {
  errorInfo,
  fileHash,
  hash,
  id,
  now,
  safePath,
  StudioError,
} from "../../shared/src/index.ts";
import type { Project } from "./model.ts";
import type { Store } from "./store.ts";
import {
  thumbnailEditSchema,
  thumbnailRenderSchema,
  thumbnailRegenerateSchema,
  thumbnailSelectSchema,
  thumbnailSetFrameSchema,
  type ThumbnailBackground,
  type ThumbnailPackage,
  type ThumbnailSelection,
  type ThumbnailSlot,
  type ThumbnailSlotId,
  type ThumbnailState,
} from "./thumbnail-model.ts";

export function thumbnailState(
  project: Project,
  doc: VideoPackaging,
): ThumbnailState {
  const packagingVersion = project.packaging.version!;
  const packagingHash = hash(doc);
  const old = project.thumbnails;
  if (
    old?.current.packagingVersion === packagingVersion &&
    old.current.packagingHash === packagingHash
  )
    return structuredClone(old);
  const concepts = doc.thumbnailConcepts
    .filter((c, i, all) => all.findIndex((v) => v.id === c.id) === i)
    .slice(0, 2);
  if (concepts.length !== 2)
    throw new StudioError(
      "INVALID_INPUT",
      "Packaging needs two distinct thumbnail concepts.",
      "Regenerate packaging.",
    );
  return {
    current: {
      packagingVersion,
      packagingHash,
      slots: concepts.map((c, i) => ({
        id: i === 0 ? "A" : "B",
        version: 0,
        conceptId: c.id,
        headline: c.headline,
        direction: c.direction,
        emotionalHook: c.emotionalHook,
        generation: 0,
        status: "CONCEPT",
        stage: null,
        error: null,
        background: null,
        currentRevision: null,
        revisions: [],
      })),
    },
    history: old ? [...old.history, old.current] : [],
    selected: null,
  };
}

export function thumbnailPrompt(project: Project, slot: ThumbnailSlot) {
  return [
    "Create one striking editorial thumbnail background for a technical YouTube video.",
    `Topic: ${project.title}. Concept: ${slot.direction}. Emotional angle: ${slot.emotionalHook}.`,
    `Brand palette: ${project.creator.brand.background}, ${project.creator.brand.foreground}, ${project.creator.brand.accent}.`,
    "Use a single clear technical subject on the right third, with simple lighting and strong separation.",
    "Keep the left 60% quiet and dark for a headline added separately. Keep the subject within the center 75% vertically for a 16:9 center crop.",
    "Depict objects or technical imagery, not a presenter, face or person. No text, words, numbers, labels, logos or watermarks.",
  ].join(" ");
}

/** Stills have no duration: validate their own contract instead of video inspect(). */
export async function verifyThumbnailImage(
  file: string,
  final: boolean,
  signal?: AbortSignal,
) {
  const info = await stat(file);
  if (
    !info.isFile() ||
    info.size === 0 ||
    info.size > (final ? 2_000_000 : 30_000_000)
  )
    throw new StudioError(
      "INVALID_INPUT",
      final
        ? "Thumbnail must be a JPEG below 2 MB."
        : "Generated image is empty or too large.",
    );
  const bytes = await readFile(file);
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes
    .subarray(0, 8)
    .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (final ? !jpeg : !jpeg && !png)
    throw new StudioError(
      "INVALID_INPUT",
      "Expected a decoded JPEG or PNG image.",
    );
  const { stdout } = await runTool(
    "ffprobe",
    [
      "-v",
      "error",
      "-protocol_whitelist",
      "file,pipe",
      "-show_entries",
      "stream=width,height,codec_name",
      "-of",
      "json",
      file,
    ],
    { signal, timeoutMs: 60000 },
  );
  const streams = (
    JSON.parse(stdout) as {
      streams: { width: number; height: number; codec_name: string }[];
    }
  ).streams;
  const image = streams[0];
  if (
    streams.length !== 1 ||
    !image ||
    !Number.isInteger(image.width) ||
    !Number.isInteger(image.height) ||
    image.width < 1 ||
    image.height < 1 ||
    image.width > 8192 ||
    image.height > 8192 ||
    (final &&
      (image.width !== 1280 ||
        image.height !== 720 ||
        image.codec_name !== "mjpeg"))
  )
    throw new StudioError(
      "INVALID_INPUT",
      "Thumbnail has invalid image dimensions.",
      "Render the thumbnail again; upload images must be 1280×720.",
    );
  await runTool(
    "ffmpeg",
    [
      "-v",
      "error",
      "-xerror",
      "-nostdin",
      "-protocol_whitelist",
      "file,pipe",
      "-i",
      file,
      "-frames:v",
      "1",
      "-f",
      "null",
      "-",
    ],
    { signal, timeoutMs: 60000 },
  );
}

async function verifiedPath(
  store: Store,
  project: Project,
  relative: string,
  expectedHash: string,
) {
  const file = await safePath(store.dir(project), relative);
  let matches = false;
  try {
    matches = (await fileHash(file)) === expectedHash;
  } catch {
    /* Missing or unreadable bytes need the same recovery as changed bytes. */
  }
  if (!matches)
    throw new StudioError(
      "CONFLICT",
      "Thumbnail image changed or is missing.",
      "Restore the image or render and select a new revision, then approve packaging again.",
    );
  return file;
}

export async function verifiedThumbnailSelection(
  store: Store,
  project: Project,
  doc: VideoPackaging,
  selection: ThumbnailSelection | null,
) {
  if (!selection) return null;
  const current = project.thumbnails?.current;
  const revision = current?.slots
    .find((s) => s.id === selection.slot)
    ?.revisions.find((r) => r.revision === selection.revision);
  if (
    selection.packagingVersion !== project.packaging.version ||
    selection.packagingHash !== hash(doc) ||
    current?.packagingHash !== selection.packagingHash ||
    current.packagingVersion !== selection.packagingVersion ||
    !revision ||
    revision.path !== selection.path ||
    revision.outputHash !== selection.outputHash
  )
    throw new StudioError(
      "CONFLICT",
      "The selected thumbnail does not belong to the current packaging.",
      "Select a current thumbnail and approve packaging again.",
    );
  const file = await verifiedPath(
    store,
    project,
    selection.path,
    selection.outputHash,
  );
  await verifyThumbnailImage(file, true);
  return file;
}

type Operation = (
  type: string,
  label: string,
  fn: (signal: AbortSignal, jobId: string) => Promise<void>,
  signal?: AbortSignal,
) => Promise<void>;
export class Thumbnails {
  state: ThumbnailState;
  constructor(
    private store: Store,
    private project: Project,
    private doc: VideoPackaging,
    private images: ImageProvider | null,
    private renderer: ThumbnailRenderer,
    private operation: Operation,
    private changed: () => void,
  ) {
    this.state = thumbnailState(project, doc);
  }
  private context(version: number, mutable = true) {
    if (
      version !== this.project.packaging.version ||
      (mutable &&
        (this.project.status !== "AWAITING_PUBLISH_APPROVAL" ||
          this.project.publication))
    )
      throw new StudioError(
        "CONFLICT",
        "Review the current packaging before changing thumbnails.",
        "Reload packaging; published thumbnails are read-only.",
      );
  }
  private slot(id: ThumbnailSlotId, version: number) {
    const slot = this.state.current.slots.find((s) => s.id === id)!;
    if (slot.version !== version)
      throw new StudioError(
        "CONFLICT",
        `Thumbnail ${id} changed while you were editing.`,
        "Reload the thumbnail and retry your edit.",
      );
    return slot;
  }
  private save(clearApproval = false) {
    this.store.update(this.project.id, (p) => {
      p.thumbnails = structuredClone(this.state);
      if (clearApproval) p.publishApproval = null;
    });
    this.changed();
  }
  update(input: unknown) {
    const edit = thumbnailEditSchema.parse(input);
    this.context(edit.packagingVersion);
    const slot = this.slot(edit.slot, edit.expectedRevision);
    const concept = this.doc.thumbnailConcepts.find(
      (c) => c.id === edit.conceptId,
    );
    if (!concept)
      throw new StudioError(
        "INVALID_INPUT",
        "Choose a concept from the current packaging.",
      );
    if (
      slot.conceptId === edit.conceptId &&
      slot.headline === edit.headline &&
      slot.direction === edit.direction
    )
      return this.state;
    // Recomposition may reuse a background only when its creative direction is unchanged.
    if (
      slot.conceptId !== edit.conceptId ||
      slot.direction !== edit.direction
    ) {
      slot.background = null;
      slot.generation++;
    }
    slot.conceptId = edit.conceptId;
    slot.headline = edit.headline;
    slot.direction = edit.direction;
    slot.emotionalHook = concept.emotionalHook;
    slot.status = "CONCEPT";
    slot.error = null;
    slot.stage = null;
    slot.version++;
    this.save();
    return this.state;
  }
  async select(input: unknown) {
    const choice = thumbnailSelectSchema.parse(input);
    this.context(choice.packagingVersion);
    let selected: ThumbnailSelection | null = null;
    if (choice.slot !== null) {
      const slot = this.slot(choice.slot, choice.expectedRevision!);
      const revision = slot.revisions.find(
        (r) => r.revision === choice.revision,
      );
      if (!revision)
        throw new StudioError(
          "INVALID_INPUT",
          "Choose a completed thumbnail revision.",
        );
      selected = {
        packagingVersion: this.state.current.packagingVersion,
        packagingHash: this.state.current.packagingHash,
        slot: slot.id,
        revision: revision.revision,
        path: revision.path,
        outputHash: revision.outputHash,
      };
      await verifiedThumbnailSelection(
        this.store,
        { ...this.project, thumbnails: this.state },
        this.doc,
        selected,
      );
    }
    const changed = hash(selected) !== hash(this.state.selected);
    this.state.selected = selected;
    this.save(changed);
    return this.state;
  }
  /**
   * Set a slot's background to an extracted expressive frame and compose it
   * through the normal pipeline — no image provider involved. The frame's
   * bytes are hash-verified before use; headline-only edits later recompose
   * offline exactly like generated backgrounds.
   */
  async setFrame(input: unknown, signal?: AbortSignal) {
    const request = thumbnailSetFrameSchema.parse(input);
    this.context(request.packagingVersion);
    const slot = this.slot(request.slot, request.expectedRevision);
    const frame = this.project.thumbnailFrames?.items.find(
      (f) => f.id === request.frameId,
    );
    if (!frame)
      throw new StudioError(
        "INVALID_INPUT",
        "Choose a frame from this render's extracted candidates.",
        "Reload the frame list and retry.",
      );
    await verifiedPath(this.store, this.project, frame.path, frame.hash);
    slot.background = {
      path: frame.path,
      hash: frame.hash,
      inputHash: hash({ frame: frame.hash, frameId: frame.id }),
      provider: "video-frame",
      model: "final-render",
      source: "frame",
      frameId: frame.id,
      frameSeconds: frame.seconds,
    };
    slot.version++;
    slot.status = "CONCEPT";
    slot.error = null;
    slot.stage = null;
    this.save();
    return this.render(
      {
        packagingVersion: request.packagingVersion,
        slots: [{ slot: slot.id, expectedRevision: slot.version }],
      },
      signal,
    );
  }
  async regenerate(input: unknown, signal?: AbortSignal) {
    const request = thumbnailRegenerateSchema.parse(input);
    this.context(request.packagingVersion);
    const slot = this.slot(request.slot, request.expectedRevision);
    if (!this.images)
      throw new StudioError(
        "CONFIGURATION",
        "Image generation is unavailable.",
        "Configure the image provider in Settings.",
      );
    slot.generation++;
    slot.background = null;
    slot.version++;
    slot.status = "CONCEPT";
    this.save();
    return this.render(
      {
        packagingVersion: request.packagingVersion,
        slots: [{ slot: slot.id, expectedRevision: slot.version }],
      },
      signal,
    );
  }
  async render(input: unknown, signal?: AbortSignal) {
    const request = thumbnailRenderSchema.parse(input);
    this.context(request.packagingVersion);
    const slots = request.slots.map((s) =>
      this.slot(s.slot, s.expectedRevision),
    );
    const failures: string[] = [];
    for (const [index, slot] of slots.entries()) {
      signal?.throwIfAborted();
      try {
        await this.renderSlot(slot, `${index + 1} of ${slots.length}`, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        failures.push(`${slot.id}: ${errorInfo(error).message}`);
      }
    }
    if (failures.length)
      throw new StudioError(
        "EXTERNAL_TOOL",
        failures.join("\n"),
        "Completed variants are saved. Edit or retry only the failed variant.",
        true,
      );
    return this.state;
  }
  private async renderSlot(
    slot: ThumbnailSlot,
    progress: string,
    signal?: AbortSignal,
  ) {
    const prompt = thumbnailPrompt(this.project, slot);
    const backgroundKey = this.images
      ? hash({
          prompt,
          provider: this.images.name,
          model: this.images.model,
          size: BROLL_SOURCE_SIZE,
          quality: "medium",
          generation: slot.generation,
        })
      : null;
    // A headline-only edit works offline and retains the original provider's background.
    const existing = slot.background;
    if (!existing && !this.images)
      throw new StudioError(
        "CONFIGURATION",
        "Image generation is unavailable.",
        "Configure the image provider in Settings.",
      );
    await this.operation(
      `thumbnail-${slot.id}`,
      `Thumbnail ${slot.id} • ${progress}`,
      async (signal, jobId) => {
        slot.status = "RUNNING";
        slot.stage = "Preparing image";
        slot.error = null;
        slot.version++;
        this.save();
        let partial: string | undefined;
        try {
          const revision = (slot.revisions.at(-1)?.revision ?? 0) + 1;
          const dir = `packaging/thumbnails/p${this.state.current.packagingVersion}/${slot.id}/r${revision}`;
          await mkdir(await safePath(this.store.dir(this.project), dir), {
            recursive: true,
          });
          let background: ThumbnailBackground | null = slot.background;
          if (background) {
            // Never pay to repair corrupt cached bytes silently.
            await verifiedPath(
              this.store,
              this.project,
              background.path,
              background.hash,
            );
          } else {
            slot.stage = "Generating background";
            this.save();
            const result = await this.images!.generate({
              prompt,
              size: BROLL_SOURCE_SIZE,
              quality: "medium",
              signal,
            });
            this.store.update(this.project.id, (p) =>
              p.usage.push(result.usage),
            );
            const relative = `${dir}/background-${id("image")}.png`;
            const output = await safePath(
              this.store.dir(this.project),
              relative,
            );
            partial = `${output}.partial.png`;
            await writeFile(partial, result.data, { mode: 0o600, flag: "wx" });
            await verifyThumbnailImage(partial, false, signal);
            await rename(partial, output);
            partial = undefined;
            background = {
              path: relative,
              hash: await fileHash(output),
              inputHash: backgroundKey!,
              provider: result.usage.provider,
              model: result.usage.model,
            };
            slot.background = background;
            this.save();
          }
          const inputHash = hash({
            background: background.hash,
            headline: slot.headline,
            brand: this.project.creator.brand,
            renderer: this.renderer.identity
              ? await this.renderer.identity()
              : id("uncached-renderer"),
            width: 1280,
            height: 720,
            jpegQuality: 90,
            colorProfile: "srgb",
          });
          const cached = slot.revisions.find((r) => r.inputHash === inputHash);
          if (cached) {
            await verifiedPath(
              this.store,
              this.project,
              cached.path,
              cached.outputHash,
            );
            slot.currentRevision = cached.revision;
          } else {
            slot.stage = "Composing headline";
            this.save();
            const relative = `${dir}/thumbnail-${id("image")}.jpg`;
            const output = await safePath(
              this.store.dir(this.project),
              relative,
            );
            partial = `${output}.partial.jpg`;
            await this.renderer({
              background: await safePath(
                this.store.dir(this.project),
                background.path,
              ),
              headline: slot.headline,
              brand: this.project.creator.brand,
              output: partial,
              signal,
            });
            await verifyThumbnailImage(partial, true, signal);
            signal.throwIfAborted();
            await rename(partial, output);
            partial = undefined;
            const completed = {
              revision,
              conceptId: slot.conceptId,
              headline: slot.headline,
              direction: slot.direction,
              background: { ...background },
              path: relative,
              outputHash: await fileHash(output),
              inputHash,
              createdAt: now(),
              jobId,
            };
            slot.revisions.push(completed);
            slot.currentRevision = revision;
            // SQLite is authoritative; the manifest is a reviewable immutable artifact.
            this.save();
            await this.store.artifact(
              this.project,
              `${dir}/manifest.json`,
              completed,
            );
          }
          slot.status = "READY";
          slot.stage = null;
          slot.version++;
          this.save();
          this.store.event(this.project.id, {
            event: "thumbnail.completed",
            slot: slot.id,
            revision: slot.currentRevision,
            packagingVersion: this.state.current.packagingVersion,
          });
        } catch (error) {
          slot.status = signal.aborted ? "CANCELLED" : "FAILED";
          slot.stage = null;
          slot.error = errorInfo(error).message;
          slot.version++;
          this.save();
          throw error;
        } finally {
          if (partial) await rm(partial, { force: true });
        }
      },
      signal,
    );
  }
  async export(version: number, destination: string) {
    this.context(version, false);
    if (typeof destination !== "string" || !path.isAbsolute(destination))
      throw new StudioError(
        "INVALID_INPUT",
        "Choose an absolute export folder.",
      );
    const sources = await Promise.all(
      this.state.current.slots.map(async (slot) => {
        const revision = slot.revisions.find(
          (r) => r.revision === slot.currentRevision,
        );
        if (
          slot.status !== "READY" ||
          !revision ||
          revision.headline !== slot.headline ||
          revision.direction !== slot.direction ||
          revision.conceptId !== slot.conceptId
        )
          throw new StudioError(
            "CONFLICT",
            "Render both current variants before exporting A/B.",
          );
        const file = await verifiedPath(
          this.store,
          this.project,
          revision.path,
          revision.outputHash,
        );
        await verifyThumbnailImage(file, true);
        return { slot: slot.id, revision, file };
      }),
    );
    // New directory every time: exporting never overwrites another file.
    const folder = await mkdtemp(
      path.join(destination, `${this.project.slug}-thumbnails-`),
    );
    try {
      for (const source of sources) {
        const output = path.join(folder, `${source.slot}.jpg`);
        await copyFile(source.file, output);
        if ((await fileHash(output)) !== source.revision.outputHash)
          throw new StudioError("CONFLICT", "Thumbnail changed during export.");
      }
      await writeFile(
        path.join(folder, "manifest.json"),
        JSON.stringify(
          {
            projectId: this.project.id,
            packagingVersion: version,
            exportedAt: now(),
            variants: sources.map(({ slot, revision }) => ({
              slot,
              file: `${slot}.jpg`,
              ...revision,
            })),
          },
          null,
          2,
        ) + "\n",
        { mode: 0o600 },
      );
    } catch (error) {
      await rm(folder, { recursive: true, force: true });
      throw error;
    }
    return { directory: folder, files: sources.map((s) => `${s.slot}.jpg`) };
  }
}

export function interruptedThumbnails(current: ThumbnailPackage) {
  for (const slot of current.slots)
    if (slot.status === "RUNNING") {
      slot.status = "FAILED";
      slot.stage = null;
      slot.error =
        "Thumbnail rendering was interrupted. Retry to reuse completed work.";
      slot.version++;
    }
}
