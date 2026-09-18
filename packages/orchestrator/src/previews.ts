import { transcriptsForPlan } from "./transcript-history.ts";
import {
  captionKey,
  graphicKey,
  type ProductionPlan,
} from "../../production-plan/src/index.ts";
import { StudioError } from "../../shared/src/index.ts";
import {
  renderCaption,
  renderGraphic,
  templateHash,
} from "../../remotion-engine/src/index.ts";
import {
  blenderClipKey,
  buildBlenderSpec,
  writeBlenderClip,
  type BlenderProvider,
} from "../../blender-engine/src/index.ts";
import { PREVIEW, verifyOutput } from "../../media/src/index.ts";
import { Store } from "./store.ts";
import type { Asset, Project } from "./model.ts";
import { cachedFile, recordAsset } from "./build.ts";
import { computeCaptionEvents } from "./captions.ts";

/**
 * Synthetic owner recorded on preview asset rows. Real jobs own their own
 * rows; storyboard previews deliberately reuse the build's cache keys and
 * output paths, so a later build finds verified bytes and re-renders nothing.
 */
export const PREVIEW_JOB_ID = "storyboard-previews";

export interface PreviewOutcome {
  sceneId: string;
  kind: "graphic" | "blender" | "caption";
  label: string;
  asset: Asset | null;
  reused: boolean;
  /** Why nothing was rendered (e.g. Blender is not installed). */
  skipped: string | null;
}

export interface PreviewResult {
  planVersion: number;
  outcomes: PreviewOutcome[];
}

/**
 * Render the current plan's Remotion graphics and Blender 3D clips at
 * storyboard time so the creator can see, approve or redo them before any
 * build. Pure function of the validated plan, creator brand and engines: no
 * approvals, proxies or job graph are involved. Cache keys are identical to
 * the build's, so these renders are the build's cache entries.
 */
export async function renderStoryboardPreviews(options: {
  store: Store;
  project: Project;
  plan: ProductionPlan;
  /** 3D engine; null skips blender entries instead of failing the pass. */
  blender: BlenderProvider | null;
  signal?: AbortSignal;
  onOutcome?: (outcome: PreviewOutcome) => void;
}): Promise<PreviewResult> {
  const { store, project: p, plan, blender, signal, onOutcome } = options;
  if (
    plan.frameRate !== PREVIEW.frameRate ||
    plan.resolution.width !== PREVIEW.width ||
    plan.resolution.height !== PREVIEW.height
  )
    throw new StudioError(
      "UNSUPPORTED",
      `The preview pipeline renders ${PREVIEW.width}×${PREVIEW.height} at ${PREVIEW.frameRate} fps.`,
      "Create a plan using the supported preview capability.",
    );
  const dir = store.dir(p);
  const templateSourceHash = await templateHash();
  const outcomes: PreviewOutcome[] = [];
  const emit = (outcome: PreviewOutcome) => {
    outcomes.push(outcome);
    onOutcome?.(outcome);
  };
  for (const scene of plan.scenes) {
    signal?.throwIfAborted();
    if (scene.enabled && scene.visual.graphic) {
      const graphic = scene.visual.graphic;
      const key = graphicKey(scene, plan, p.creator.brand, templateSourceHash);
      const c = await cachedFile(
        dir,
        key,
        `assets/generated/${key}.mp4`,
        async (temp) => {
          await renderGraphic(scene, plan, p.creator.brand, temp, signal);
          await verifyOutput(
            temp,
            scene.durationFrames / plan.frameRate,
            signal,
          );
        },
      );
      const asset = recordAsset(
        store,
        p.id,
        plan.version,
        PREVIEW_JOB_ID,
        "remotion-render",
        key,
        c,
        scene.id,
        {
          template: graphic.template,
          templateVersion: graphic.templateVersion,
          parameters: graphic.parameters,
          sourceAssets: scene.transcriptSegmentIds,
          instruction: scene.visual.description,
        },
      );
      emit({
        sceneId: scene.id,
        kind: "graphic",
        label: `${graphic.template} • ${scene.id}`,
        asset,
        reused: c.reused,
        skipped: null,
      });
    }
    for (const entry of scene.enabled ? scene.broll : []) {
      if (entry.asset.engine !== "blender") continue;
      if (!blender) {
        emit({
          sceneId: scene.id,
          kind: "blender",
          label: `Blender 3D • ${scene.id}/${entry.id}`,
          asset: null,
          reused: false,
          skipped:
            "Blender is not available; the 3D preview was skipped. The build still fails closed on this entry.",
        });
        continue;
      }
      const key = blenderClipKey(entry, plan, blender, p.creator.brand);
      const c = await cachedFile(
        dir,
        key,
        `assets/generated/broll-${key}.mp4`,
        async (temp) => {
          const result = await blender.renderClip({
            spec: buildBlenderSpec(entry, plan, p.creator.brand),
            signal,
          });
          // The bridge renders the plan resolution; insets are conformed
          // into their box here, exactly like the build.
          await writeBlenderClip(result.file, {
            entry,
            plan,
            output: temp,
            signal,
          });
          await verifyOutput(
            temp,
            entry.durationFrames / plan.frameRate,
            signal,
          );
        },
      );
      const asset = recordAsset(
        store,
        p.id,
        plan.version,
        PREVIEW_JOB_ID,
        "broll-clip",
        key,
        c,
        scene.id,
        {
          generator: "blender-eevee",
          template: entry.asset.template,
          templateVersion: entry.asset.templateVersion,
          parameters: {
            ...entry.asset.parameters,
            placement: entry.placement,
            inset: entry.inset,
          },
          sourceAssets: scene.transcriptSegmentIds,
          instruction: entry.narrationHook,
        },
      );
      emit({
        sceneId: scene.id,
        kind: "blender",
        label: `Blender 3D • ${scene.id}/${entry.id}`,
        asset,
        reused: c.reused,
        skipped: null,
      });
    }
  }
  // Punch-line captions: the same deterministic events the build burns,
  // rendered with identical keys so storyboard previews are the build's
  // cache entries and the creator sees the subtitle layer before approving.
  if (plan.captionStyle !== "none") {
    const captions = computeCaptionEvents(plan, transcriptsForPlan(p, plan));
    for (const event of captions.events) {
      signal?.throwIfAborted();
      const key = captionKey(
        event,
        plan.captionStyle,
        plan,
        p.creator.brand,
        templateSourceHash,
      );
      const c = await cachedFile(
        dir,
        key,
        `assets/generated/caption-${key}.webm`,
        async (temp) => {
          await renderCaption(
            event,
            plan.captionStyle as "pop" | "karaoke",
            plan,
            p.creator.brand,
            temp,
            signal,
          );
          await verifyOutput(
            temp,
            (event.endFrame - event.startFrame) / plan.frameRate,
            signal,
          );
        },
      );
      const asset = recordAsset(
        store,
        p.id,
        plan.version,
        PREVIEW_JOB_ID,
        "caption-render",
        key,
        c,
        event.sceneId,
        {
          template: "PunchLineCaption",
          parameters: { style: plan.captionStyle, text: event.text },
          sourceAssets: [event.sceneId],
          instruction: event.text,
        },
      );
      emit({
        sceneId: event.sceneId,
        kind: "caption",
        label: `Caption • ${event.text.slice(0, 48)}`,
        asset,
        reused: c.reused,
        skipped: null,
      });
    }
    // Skips are scene-keyed like every other outcome so consumers can attach
    // the warning to the affected scene(s), not a raw recording id.
    for (const scene of plan.scenes) {
      if (!captions.skippedRecordings.includes(scene.camera.recordingId))
        continue;
      emit({
        sceneId: scene.id,
        kind: "caption",
        label: `Caption • ${scene.id}`,
        asset: null,
        reused: false,
        skipped:
          "No word timings in this recording's transcript; its captions are skipped (silence tightening has the same requirement).",
      });
    }
  }
  return { planVersion: plan.version, outcomes };
}
