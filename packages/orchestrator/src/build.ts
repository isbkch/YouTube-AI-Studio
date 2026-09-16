import {
  copyFile,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  atomicJSON,
  fileHash,
  hash,
  id,
  now,
  safePath,
  StudioError,
  type Usage,
} from "../../shared/src/index.ts";
import {
  coverageSummary,
  graphicKey,
  validateAudioDesign,
  validatePlan,
  validateSources,
} from "../../production-plan/src/index.ts";
import { validateEngines } from "./engines.ts";
import {
  PREVIEW,
  analyzeAudio,
  detectAnomalies,
  extractAudio,
  mixAudio,
  proxy,
  sampleFrames,
  verifyOutput,
  inspect,
} from "../../media/src/index.ts";
import {
  VisualQAAgent,
  reviewStill,
  type AIProvider,
  type SceneReviewInput,
  type StillReview,
  type VisualReview,
} from "../../agents/src/index.ts";
import {
  renderGraphic,
  templateHash,
} from "../../remotion-engine/src/index.ts";
import {
  BROLL_SOURCE_SIZE,
  brollBox,
  brollClipKey,
  brollStillKey,
  buildImagePrompt,
  renderMotionClip,
  type ImageProvider,
} from "../../image-engine/src/index.ts";
import { Store } from "./store.ts";
import { transition, type Asset } from "./model.ts";
import { JobGraph, type Task, type TaskContext } from "./jobs.ts";
import { readLibrary, resolveTrack, trackRefs } from "./library.ts";
import {
  makeTimeline,
  toOTIO,
  toFCPXML,
  toChapters,
  renderSegment,
  concatenateSegments,
  type SegmentOverlay,
  type TimelineAudio,
  type TimelineBrollClip,
} from "./timeline.ts";
/** Providers the build may invoke; null engines make plans fail closed. */
export interface BuildContext {
  images: ImageProvider | null;
  /** Structured-output provider for automated visual QA; null skips review. */
  provider: AIProvider | null;
}
const visualQAEnabled = () => process.env.WTS_VISUAL_QA !== "off";
interface Cached {
  path: string;
  outputHash: string;
  renderMs: number;
}
export async function cachedFile(
  dir: string,
  key: string,
  relative: string,
  render: (temp: string) => Promise<void>,
): Promise<Cached & { reused: boolean }> {
  const output = await safePath(dir, relative);
  const manifest = await safePath(dir, `cache/${key}.json`);
  try {
    const c = JSON.parse(await readFile(manifest, "utf8")) as Cached;
    if (
      c.path === relative &&
      (await stat(output)).size > 0 &&
      (await fileHash(output)) === c.outputHash
    )
      return { ...c, reused: true };
  } catch (e) {
    if (e instanceof StudioError) throw e;
  }
  const temp =
    output.replace(/\.(mp4|mp3)$/, "") +
    `.${id("partial")}.` +
    output.split(".").at(-1);
  const started = performance.now();
  try {
    await render(temp);
    const outputHash = await fileHash(temp);
    await rename(temp, output);
    const c = {
      path: relative,
      outputHash,
      renderMs: performance.now() - started,
    };
    await atomicJSON(manifest, c);
    return { ...c, reused: false };
  } finally {
    await rm(temp, { force: true });
  }
}
export async function buildProject(
  store: Store,
  projectId: string,
  signal?: AbortSignal,
  onJob?: (job: import("./model.ts").Job) => void,
  context: BuildContext = { images: null, provider: null },
) {
  let p = store.get(projectId);
  const release = store.acquire(p.id);
  p = store.get(p.id);
  const dir = store.dir(p);
  const graphics = new Map<string, Asset>(),
    segments = new Map<string, Asset>(),
    /** sceneId → brollId → rendered clip asset. */
    brollClips = new Map<string, Map<string, Asset>>(),
    /** sceneId/brollId → generated-still review verdict. */
    stillReviews = new Map<string, StillReview>();
  try {
    const plan = validatePlan(p.plans.at(-1));
    if (
      !p.scriptApproval ||
      p.scriptApproval.version !== plan.scriptVersion ||
      !p.planApproval ||
      p.planApproval.version !== plan.version ||
      p.planApproval.hash !== hash(plan)
    )
      throw new StudioError(
        "CONFLICT",
        "Approve the current script and storyboard before production.",
      );
    if (["GENERATING_ASSETS", "ASSEMBLING"].includes(p.status))
      p = store.update(p.id, (x) => {
        x.status = transition(x.status, "AWAITING_STORYBOARD_APPROVAL");
      });
    if (
      !["AWAITING_STORYBOARD_APPROVAL", "AWAITING_ROUGH_CUT_APPROVAL"].includes(
        p.status,
      )
    )
      throw new StudioError("CONFLICT", `Cannot build from ${p.status}.`);
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
    if (
      p.scriptApproval?.hash !==
      hash(p.scripts.find((s) => s.version === plan.scriptVersion))
    )
      throw new StudioError("CONFLICT", "Approved script content changed.");
    validateSources(plan, p.recordings, p.transcripts);
    // Engine capability gates (ADR 007): unavailable engines fail the build
    // before any pixels are spent, and audio design must resolve in-library.
    validateEngines(plan, context.images);
    const library = await readLibrary(store.root);
    validateAudioDesign(plan, trackRefs(library.tracks));
    const design = plan.audioDesign;
    const musicTrack = design.music
      ? await resolveTrack(
          store.root,
          library.tracks.find((t) => t.trackId === design.music!.trackId)!,
        )
      : null;
    const sfxTracks = [] as {
      event: (typeof design)["sfx"][number];
      resolved: Awaited<ReturnType<typeof resolveTrack>>;
    }[];
    for (const event of design.sfx) {
      sfxTracks.push({
        event,
        resolved: await resolveTrack(
          store.root,
          library.tracks.find((t) => t.trackId === event.trackId)!,
        ),
      });
    }
    const templateSourceHash = await templateHash();
    const tasks: Task[] = [];
    const persistAsset = (
      ctx: TaskContext,
      type: Asset["type"],
      key: string,
      c: Cached & { reused: boolean },
      sceneId: string | null,
      extra: Partial<Asset> = {},
    ): Asset => {
      const a: Asset = {
        assetId: id("asset"),
        type,
        sceneId,
        productionPlanVersion: plan.version,
        generator: type === "remotion-render" ? "remotion" : "ffmpeg",
        template: null,
        templateVersion: null,
        parameters: {},
        inputHash: key,
        outputHash: c.outputHash,
        createdAt: now(),
        path: c.path,
        jobId: ctx.jobId,
        reused: c.reused,
        sourceAssets: [],
        renderMs: c.reused ? 0 : c.renderMs,
        ...extra,
      };
      store.asset(p.id, a);
      ctx.produced(a.assetId);
      ctx.log(`${c.reused ? "Reused verified cache" : "Rendered"}: ${a.path}`);
      return a;
    };
    for (const recording of p.recordings) {
      const key = hash({
        source: recording.hash,
        operation: `proxy-v2-${PREVIEW.width}x${PREVIEW.height}-${PREVIEW.frameRate}fps`,
      });
      tasks.push({
        id: `proxy-${recording.id}`,
        type: "proxy",
        label: `Proxy • ${recording.name}`,
        dependencies: [],
        run: async (ctx) => {
          const source = await safePath(dir, recording.path);
          if ((await fileHash(source)) !== recording.hash)
            throw new StudioError(
              "CONFLICT",
              "An imported source recording changed on disk.",
              "Restore it or import a new recording.",
            );
          const c = await cachedFile(
            dir,
            key,
            `cache/proxy-${key}.mp4`,
            async (temp) => {
              await proxy(source, temp, ctx.signal, ctx.progress);
              await verifyOutput(temp, recording.duration, ctx.signal);
            },
          );
          // The real proxy frame count drives the timeline's declared media
          // duration, so FCPXML and Resolve agree with the actual file.
          const proxyInfo = await inspect(await safePath(dir, c.path));
          persistAsset(ctx, "proxy", key, c, null, {
            sourceAssets: [recording.id],
          });
          recording.proxyPath = c.path;
          recording.proxyStatus = "AVAILABLE";
          recording.proxyFrames = proxyInfo.frames;
          store.update(p.id, (x) => {
            const r = x.recordings.find((r) => r.id === recording.id)!;
            r.proxyPath = c.path;
            r.proxyStatus = "AVAILABLE";
            r.proxyFrames = proxyInfo.frames;
          });
        },
      });
      if (recording.hasAudio)
        tasks.push({
          id: `audio-${recording.id}`,
          type: "audio",
          label: `Extract audio • ${recording.name}`,
          dependencies: [],
          run: async (ctx) => {
            const key = hash({
              source: recording.hash,
              operation: "audio-mp3-16k-v1",
            });
            const c = await cachedFile(
              dir,
              key,
              `cache/audio-${key}.mp3`,
              async (temp) =>
                extractAudio(
                  await safePath(dir, recording.path),
                  temp,
                  ctx.signal,
                ),
            );
            persistAsset(ctx, "audio", key, c, null, {
              sourceAssets: [recording.id],
            });
          },
        });
    }
    for (const scene of plan.scenes) {
      const graphicId = `graphic-${scene.id}`;
      if (scene.enabled && scene.visual.graphic) {
        tasks.push({
          id: graphicId,
          type: "remotion",
          label: `${scene.visual.graphic.template} • ${scene.id}`,
          dependencies: [],
          run: async (ctx) => {
            const key = graphicKey(
              scene,
              plan,
              p.creator.brand,
              templateSourceHash,
            );
            const c = await cachedFile(
              dir,
              key,
              `assets/generated/${key}.mp4`,
              async (temp) => {
                await renderGraphic(
                  scene,
                  plan,
                  p.creator.brand,
                  temp,
                  ctx.signal,
                  ctx.progress,
                );
                await verifyOutput(
                  temp,
                  scene.durationFrames / plan.frameRate,
                  ctx.signal,
                );
              },
            );
            graphics.set(
              scene.id,
              persistAsset(ctx, "remotion-render", key, c, scene.id, {
                template: scene.visual.graphic!.template,
                templateVersion: scene.visual.graphic!.templateVersion,
                parameters: scene.visual.graphic!.parameters,
                sourceAssets: scene.transcriptSegmentIds,
                instruction: scene.visual.description,
              }),
            );
          },
        });
      }
      const sceneBroll = scene.enabled ? scene.broll : [];
      for (const entry of sceneBroll) {
        const stillId = `broll-still-${scene.id}-${entry.id}`;
        const clipTaskId = `broll-clip-${scene.id}-${entry.id}`;
        const stillKey = brollStillKey(entry, context.images!);
        tasks.push({
          id: stillId,
          type: "image",
          label: `GeneratedStill • ${scene.id}/${entry.id}`,
          dependencies: [],
          run: async (ctx) => {
            let usage: Usage | null = null;
            const c = await cachedFile(
              dir,
              stillKey,
              `assets/generated/still-${stillKey}.png`,
              async (temp) => {
                const result = await context.images!.generate({
                  prompt: buildImagePrompt(entry.asset),
                  size: BROLL_SOURCE_SIZE,
                  quality: entry.asset.parameters.quality,
                  signal: ctx.signal,
                });
                usage = result.usage;
                await writeFile(temp, result.data);
              },
            );
            if (usage && !c.reused) {
              const spent = usage;
              store.update(p.id, (x) => x.usage.push(spent));
            }
            persistAsset(ctx, "generated-image", stillKey, c, scene.id, {
              generator: entry.asset.engine,
              template: entry.asset.template,
              templateVersion: entry.asset.templateVersion,
              parameters: entry.asset.parameters,
              instruction: entry.narrationHook,
              provider: context.images!.name,
              model: context.images!.model,
            });
            // Vision gate before compositing: flag, never auto-regenerate.
            if (context.provider && visualQAEnabled() && !c.reused) {
              try {
                const review = await reviewStill(
                  context.provider,
                  {
                    sceneId: scene.id,
                    stillPath: await safePath(dir, c.path),
                    brief: entry.asset.parameters.brief,
                    style: entry.asset.parameters.style,
                    expectsText: entry.asset.parameters.expectsText,
                  },
                  ctx.signal,
                );
                store.update(p.id, (x) => x.usage.push(review.usage));
                stillReviews.set(`${scene.id}/${entry.id}`, review.output);
                if (review.output.verdict !== "pass")
                  ctx.log(
                    `Still review ${review.output.verdict}: ${review.output.findings.map((f) => f.kind).join(", ") || review.output.note}`,
                  );
              } catch (e) {
                ctx.log(
                  `Still review unavailable: ${e instanceof Error ? e.message : String(e)}`,
                );
              }
            }
          },
        });
        tasks.push({
          id: clipTaskId,
          type: "broll",
          label: `B-roll motion • ${scene.id}/${entry.id}`,
          dependencies: [stillId],
          run: async (ctx) => {
            const key = brollClipKey(entry, plan);
            const box = brollBox(entry, plan);
            const c = await cachedFile(
              dir,
              key,
              `assets/generated/broll-${key}.mp4`,
              async (temp) => {
                await renderMotionClip({
                  still: await safePath(
                    dir,
                    `assets/generated/still-${stillKey}.png`,
                  ),
                  output: temp,
                  width: box.width,
                  height: box.height,
                  durationFrames: entry.durationFrames,
                  frameRate: plan.frameRate,
                  motion: entry.motion,
                  signal: ctx.signal,
                  progress: ctx.progress,
                });
                await verifyOutput(
                  temp,
                  entry.durationFrames / plan.frameRate,
                  ctx.signal,
                );
              },
            );
            let perScene = brollClips.get(scene.id);
            if (!perScene) brollClips.set(scene.id, (perScene = new Map()));
            perScene.set(
              entry.id,
              persistAsset(ctx, "broll-clip", key, c, scene.id, {
                generator: "ffmpeg-zoompan",
                template: entry.asset.template,
                templateVersion: entry.asset.templateVersion,
                parameters: {
                  motion: entry.motion,
                  placement: entry.placement,
                  inset: entry.inset,
                },
                sourceAssets: scene.transcriptSegmentIds,
                instruction: entry.narrationHook,
              }),
            );
          },
        });
      }
      tasks.push({
        id: `segment-${scene.id}`,
        type: "preview-segment",
        label: `Preview segment • ${scene.id}`,
        dependencies: [
          `proxy-${scene.camera.recordingId}`,
          ...(scene.enabled && scene.visual.graphic ? [graphicId] : []),
          ...sceneBroll.map((b) => `broll-clip-${scene.id}-${b.id}`),
        ],
        run: async (ctx) => {
          const recording = p.recordings.find(
            (r) => r.id === scene.camera.recordingId,
          )!;
          const graphic = graphics.get(scene.id) ?? null;
          const perScene = brollClips.get(scene.id);
          const fullframe =
            sceneBroll.find((b) => b.placement === "fullframe") ?? null;
          const fullframeClip = fullframe ? perScene!.get(fullframe.id)! : null;
          // Full-frame B-roll replaces the frame exactly like a Remotion graphic.
          const replace = graphic ?? fullframeClip;
          const insets = sceneBroll.filter((b) => b.placement === "inset");
          const overlaySpecs = insets.map((b) => {
            const clip = perScene!.get(b.id)!;
            const duration = b.durationFrames / plan.frameRate;
            const fade = Math.min(0.35, duration / 4);
            const box = brollBox(b, plan);
            return {
              asset: clip,
              x: Math.round(b.inset!.x * plan.resolution.width),
              y: Math.round(b.inset!.y * plan.resolution.height),
              width: box.width,
              height: box.height,
              startSec: b.startFrame / plan.frameRate,
              endSec: b.startFrame / plan.frameRate + duration,
              fadeInSec: fade,
              fadeOutSec: fade,
            };
          });
          const key = hash({
            source: recording.hash,
            sourceInFrame: scene.sourceInFrame,
            durationFrames: scene.durationFrames,
            punchIn: replace ? 1 : scene.camera.punchIn,
            audio: scene.audio,
            graphic: replace?.outputHash || null,
            ...(overlaySpecs.length
              ? {
                  overlays: overlaySpecs.map((o) => ({
                    asset: o.asset.outputHash,
                    x: o.x,
                    y: o.y,
                    width: o.width,
                    height: o.height,
                    startSec: o.startSec,
                    endSec: o.endSec,
                    fades: [o.fadeInSec, o.fadeOutSec],
                  })),
                }
              : {}),
            renderer: `preview-v2-${PREVIEW.frameRate}fps-${PREVIEW.height}p${overlaySpecs.length ? "-overlay" : ""}`,
          });
          const c = await cachedFile(
            dir,
            key,
            `cache/segment-${key}.mp4`,
            async (temp) => {
              const overlays: SegmentOverlay[] = [];
              for (const o of overlaySpecs)
                overlays.push({
                  clip: await safePath(dir, o.asset.path),
                  x: o.x,
                  y: o.y,
                  width: o.width,
                  height: o.height,
                  startSec: o.startSec,
                  endSec: o.endSec,
                  fadeInSec: o.fadeInSec,
                  fadeOutSec: o.fadeOutSec,
                });
              await renderSegment({
                source: await safePath(dir, recording.proxyPath!),
                graphic: replace ? await safePath(dir, replace.path) : null,
                sourceStart: scene.sourceInFrame / plan.frameRate,
                duration: scene.durationFrames / plan.frameRate,
                punchIn: scene.camera.punchIn,
                gainDb: scene.audio.gainDb,
                hasAudio: recording.hasAudio,
                output: temp,
                signal: ctx.signal,
                progress: ctx.progress,
                overlays,
              });
              await verifyOutput(
                temp,
                scene.durationFrames / plan.frameRate,
                ctx.signal,
                scene.durationFrames,
              );
            },
          );
          segments.set(
            scene.id,
            persistAsset(ctx, "preview-segment", key, c, scene.id, {
              sourceAssets: [
                recording.id,
                ...(graphic ? [graphic.assetId] : []),
                ...(fullframeClip ? [fullframeClip.assetId] : []),
                ...insets.map((b) => perScene!.get(b.id)!.assetId),
              ],
            }),
          );
        },
      });
    }
    const signature = hash({
      plan,
      templateSourceHash,
      brand: p.creator.brand,
      preview: "v1",
    }).slice(0, 12);
    const previewPath = `renders/rough-cut-v${plan.version}-${signature}.mp4`,
      timelinePath = `renders/timeline-v${plan.version}-${signature}.json`,
      exportPath = `renders/resolve-v${plan.version}-${signature}.fcpxml`,
      qaPath = `renders/qa-v${plan.version}-${signature}.json`;
    const hasAudioDesign = !!(design.music || design.sfx.length);
    /** Set by the assembly task; the mix task reads it after its dependency. */
    const concatOutput = { key: "", relative: previewPath };
    tasks.push({
      id: "assembly",
      type: "assembly",
      label: "Assemble timeline and Resolve exports",
      dependencies: tasks.map((t) => t.id),
      run: async (ctx) => {
        store.update(p.id, (x) => {
          if (x.status === "GENERATING_ASSETS")
            x.status = transition(x.status, "ASSEMBLING");
        });
        const concatKey = hash({
          segments: plan.scenes.map((s) => segments.get(s.id)!.outputHash),
          operation: "concat-v1",
        });
        concatOutput.key = concatKey;
        concatOutput.relative = hasAudioDesign
          ? `cache/concat-${concatKey}.mp4`
          : previewPath;
        // Copy referenced library tracks into the project so every timeline
        // path stays project-relative (and survives library reorganization).
        const audio: TimelineAudio = { design, music: null, sfx: [] };
        if (musicTrack && design.music) {
          const ext = path.extname(musicTrack.file) || ".m4a";
          const c = await cachedFile(
            dir,
            `library-${musicTrack.hash}`,
            `cache/library-${musicTrack.hash}${ext}`,
            (temp) => copyFile(musicTrack.file, temp),
          );
          audio.music = {
            path: c.path,
            sourceDurationFrames: Math.floor(
              musicTrack.duration * plan.frameRate,
            ),
          };
        }
        for (const s of sfxTracks) {
          const ext = path.extname(s.resolved.file) || ".m4a";
          const c = await cachedFile(
            dir,
            `library-${s.resolved.hash}`,
            `cache/library-${s.resolved.hash}${ext}`,
            (temp) => copyFile(s.resolved.file, temp),
          );
          audio.sfx.push({
            event: s.event,
            path: c.path,
            sourceDurationFrames: Math.floor(
              s.resolved.duration * plan.frameRate,
            ),
          });
        }
        const timelineBroll: Map<string, TimelineBrollClip[]> = new Map();
        for (const [sceneId, perScene] of brollClips)
          timelineBroll.set(
            sceneId,
            [...perScene.entries()].map(([brollId, a]) => ({
              sceneId,
              brollId,
              assetId: a.assetId,
              path: a.path,
            })),
          );
        const timeline = makeTimeline(
          plan,
          p.recordings,
          graphics,
          timelineBroll,
          audio,
        );
        await store.artifact(p, timelinePath, timeline);
        await store.artifact(
          p,
          exportPath.replace(".fcpxml", ".otio"),
          toOTIO(timeline, dir),
        );
        await writeFile(
          await safePath(dir, exportPath),
          toFCPXML(timeline, dir),
        );
        await store.artifact(
          p,
          exportPath.replace(/\.fcpxml$/, ".chapters.txt"),
          {
            text: toChapters(timeline),
            note: "YouTube-ready chapter list; paste into the description.",
          },
        );
        const c = await cachedFile(
          dir,
          concatKey,
          concatOutput.relative,
          async (temp) =>
            concatenateSegments(
              dir,
              plan.scenes.map((s) => segments.get(s.id)!.path),
              temp,
              ctx.signal,
            ),
        );
        ctx.log(
          `${c.reused ? "Reused" : "Assembled"} local rough cut and editable Resolve timelines.`,
        );
      },
    });
    if (hasAudioDesign) {
      tasks.push({
        id: "mix",
        type: "mix",
        label: "Mix music bed and SFX under narration",
        dependencies: ["assembly"],
        run: async (ctx) => {
          const mixKey = hash({
            concat: concatOutput.key,
            music: musicTrack
              ? {
                  hash: musicTrack.hash,
                  ...design.music,
                  durationSeconds: plan.durationFrames / plan.frameRate,
                }
              : null,
            sfx: sfxTracks.map((s) => ({
              hash: s.resolved.hash,
              atFrame: s.event.atFrame,
              gainDb: s.event.gainDb,
            })),
            renderer: "mix-v1-sidechain",
          });
          const c = await cachedFile(dir, mixKey, previewPath, async (temp) => {
            await mixAudio({
              video: await safePath(dir, concatOutput.relative),
              output: temp,
              duration: plan.durationFrames / plan.frameRate,
              music:
                musicTrack && design.music
                  ? {
                      file: musicTrack.file,
                      gainDb: design.music.gainDb,
                      duckToDb: design.music.duckToDb,
                      fadeInSec: design.music.fadeInSec,
                      fadeOutSec: design.music.fadeOutSec,
                      loopable: library.tracks.find(
                        (t) => t.trackId === design.music!.trackId,
                      )!.loopable,
                    }
                  : null,
              sfx: sfxTracks.map((s) => ({
                file: s.resolved.file,
                atSec: s.event.atFrame / plan.frameRate,
                gainDb: s.event.gainDb,
              })),
              signal: ctx.signal,
              progress: ctx.progress,
            });
            await verifyOutput(
              temp,
              plan.durationFrames / plan.frameRate,
              ctx.signal,
            );
          });
          persistAsset(ctx, "audio-mix", mixKey, c, null, {
            generator: "ffmpeg-sidechain",
            parameters: { music: design.music, sfxCount: design.sfx.length },
          });
          ctx.log(
            `${c.reused ? "Reused" : "Mixed"} music/SFX bed into the rough cut.`,
          );
        },
      });
    }
    tasks.push({
      id: "qa",
      type: "qa",
      label: "QA • decode, duration and asset completeness",
      dependencies: [hasAudioDesign ? "mix" : "assembly"],
      run: async (ctx) => {
        const meta = await verifyOutput(
          await safePath(dir, previewPath),
          plan.durationFrames / plan.frameRate,
          ctx.signal,
          plan.durationFrames,
        );
        const audio = await analyzeAudio(
          await safePath(dir, previewPath),
          ctx.signal,
        );
        const warnings: string[] = [];
        if (audio.silenceStarts.length)
          warnings.push(
            `${audio.silenceStarts.length} silence interval(s) of 2 seconds or more: review pacing.`,
          );
        if (audio.maxVolumeDb !== null && audio.maxVolumeDb > -1)
          warnings.push(
            "Audio peaks exceed -1 dBFS: review gain and potential clipping.",
          );
        const silentSources = p.recordings.filter((r) => !r.hasAudio);
        if (silentSources.length)
          warnings.push(
            `${silentSources.length} recording(s) have no narration audio; their preview segments contain silence.`,
          );
        const latestTranscripts = p.recordings.map((r) =>
          p.transcripts.findLast((t) => t.recordingId === r.id),
        );
        if (latestTranscripts.some((t) => t?.provider === "mock"))
          warnings.push(
            "Synthetic or imported mock transcript; factual and spoken-word alignment requires human review.",
          );
        if (
          plan.scenes.some((s) =>
            /\b(TODO|TBD|PLACEHOLDER)\b/.test(s.narration),
          )
        )
          warnings.push(
            "Narration contains a possible unresolved placeholder.",
          );
        const cutSeconds = plan.durationFrames / plan.frameRate;
        if (
          cutSeconds < p.targetDuration * 0.5 ||
          cutSeconds > p.targetDuration * 1.5
        )
          warnings.push(
            `Rough cut runs ${Math.round(cutSeconds)}s against a ${Math.round(p.targetDuration)}s target; review pacing.`,
          );
        const droppedTakes = coverageSummary(plan, p.recordings).filter(
          (c) => c.keptSeconds === 0,
        );
        if (droppedTakes.length && p.recordings.length > 1)
          warnings.push(
            `${droppedTakes.length} imported recording(s) unused by this cut: ${droppedTakes.map((c) => c.name).join(", ")}.`,
          );
        // Automated visual QA: technical anomaly filters plus vision review
        // of sampled mid-scene frames against each scene's intent.
        const attention: string[] = [];
        let visual:
          | {
              anomalies: Awaited<ReturnType<typeof detectAnomalies>>;
              framesDir: string | null;
              reviewedBy: string | null;
              summaries: string[];
              scenes: VisualReview["scenes"];
              stills: ({ sceneId: string; brollId: string } & StillReview)[];
            }
          | undefined;
        try {
          const previewFile = await safePath(dir, previewPath);
          const anomalies = await detectAnomalies(previewFile, ctx.signal);
          if (anomalies.black.length)
            warnings.push(
              `${anomalies.black.length} black interval(s) detected; verify they are intentional.`,
            );
          if (anomalies.frozen.length)
            warnings.push(
              `${anomalies.frozen.length} frozen interval(s) detected; verify motion where expected.`,
            );
          let framesDir: string | null = null;
          const reviewScenes: VisualReview["scenes"] = [];
          const summaries: string[] = [];
          let reviewedBy: string | null = null;
          if (context.provider && visualQAEnabled()) {
            framesDir = qaPath.replace(/\.json$/, "-frames");
            const framesAbs = await safePath(dir, framesDir);
            const batch: SceneReviewInput[] = [];
            const flush = async () => {
              if (!batch.length) return;
              const result = await new VisualQAAgent(context.provider!).review(
                batch,
                ctx.signal,
              );
              store.update(p.id, (x) => x.usage.push(result.usage));
              reviewScenes.push(...result.output.scenes);
              summaries.push(result.output.summary);
              reviewedBy = `${result.usage.provider}/${result.usage.model}`;
              batch.length = 0;
            };
            for (const scene of plan.scenes) {
              if (!scene.enabled) continue;
              const midpoint =
                (scene.startFrame + scene.durationFrames / 2) / plan.frameRate;
              const [frame] = await sampleFrames(
                previewFile,
                [midpoint],
                framesAbs,
                `scene-${scene.id}`,
                ctx.signal,
              );
              if (!frame) continue;
              batch.push({
                sceneId: scene.id,
                framePath: frame,
                intent: {
                  description: scene.visual.description,
                  graphicTemplate: scene.visual.graphic?.template ?? null,
                  broll: scene.broll.map((b) => ({
                    brief: b.asset.parameters.brief,
                    placement: b.placement,
                    motion: b.motion,
                  })),
                  narrationExcerpt: scene.narration.slice(0, 600),
                  chapterTitle: scene.chapterTitle,
                },
              });
              if (batch.length >= 4) await flush();
            }
            await flush();
          }
          const stills = [...stillReviews.entries()].map(([key, review]) => {
            const [sceneId, brollId] = key.split("/");
            return { sceneId, brollId, ...review };
          });
          for (const s of stills)
            if (s.verdict !== "pass") attention.push(s.sceneId);
          for (const s of reviewScenes)
            if (s.verdict !== "pass") attention.push(s.sceneId);
          visual = {
            anomalies,
            framesDir,
            reviewedBy,
            summaries,
            scenes: reviewScenes,
            stills,
          };
        } catch (e) {
          warnings.push(
            `Automated visual QA unavailable: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        await store.artifact(p, qaPath, {
          status: attention.length ? "ATTENTION" : "PASS",
          checkedAt: now(),
          checks: [
            "All expected scene assets present",
            "Timeline ranges validated",
            "Full preview decoded without FFmpeg errors",
            "Duration within 120 ms",
            "Original source content hashes verified",
            "Black/freeze frame filters ran over the assembled cut",
          ],
          metadata: meta,
          audio,
          coverage: coverageSummary(plan, p.recordings),
          warnings,
          visual,
          attention: [...new Set(attention)],
          humanChecks: [
            "Factual accuracy and narration/graphic agreement",
            "Speech pacing, dead air and mix",
            "Visual QA verdicts — confirm flagged scenes and stills",
          ],
          coverageNote:
            "Technical and sampled-frame QA; final editorial judgment stays human.",
        });
        ctx.log(
          `QA ${attention.length ? "flagged" : "passed"}: ${meta.duration.toFixed(2)}s, ${meta.width}×${meta.height}${attention.length ? `, ${new Set(attention).size} scene(s) need attention` : ""}.`,
        );
      },
    });
    store.update(p.id, (x) => {
      if (x.status === "AWAITING_STORYBOARD_APPROVAL")
        x.status = transition(x.status, "GENERATING_ASSETS");
    });
    const graph = new JobGraph(
      tasks,
      p.id,
      (job) => {
        store.job(job);
        onJob?.(job);
      },
      2,
    );
    await graph.run(signal);
    store.update(p.id, (x) => {
      if (x.status === "ASSEMBLING")
        x.status = transition(x.status, "AWAITING_ROUGH_CUT_APPROVAL");
      if (!x.builds.some((b) => b.previewPath === previewPath))
        x.builds.push({
          planVersion: plan.version,
          previewPath,
          timelinePath,
          exportPath,
          qaPath,
          completedAt: now(),
        });
    });
    store.event(p.id, { event: "build.completed", planVersion: plan.version });
    return store.get(p.id);
  } catch (e) {
    store.update(p.id, (x) => {
      if (["GENERATING_ASSETS", "ASSEMBLING"].includes(x.status))
        x.status = transition(x.status, "AWAITING_STORYBOARD_APPROVAL");
    });
    throw e;
  } finally {
    release();
  }
}
