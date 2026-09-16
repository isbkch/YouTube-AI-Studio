import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import {
  atomicJSON,
  fileHash,
  hash,
  id,
  now,
  safePath,
  StudioError,
} from "../../shared/src/index.ts";
import {
  coverageSummary,
  graphicKey,
  validatePlan,
  validateSources,
} from "../../production-plan/src/index.ts";
import {
  PREVIEW,
  analyzeAudio,
  extractAudio,
  proxy,
  verifyOutput,
} from "../../media/src/index.ts";
import {
  renderGraphic,
  templateHash,
} from "../../remotion-engine/src/index.ts";
import { Store } from "./store.ts";
import { transition, type Asset } from "./model.ts";
import { JobGraph, type Task, type TaskContext } from "./jobs.ts";
import {
  makeTimeline,
  toOTIO,
  toFCPXML,
  toChapters,
  renderSegment,
  concatenateSegments,
} from "./timeline.ts";
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
) {
  let p = store.get(projectId);
  const release = store.acquire(p.id);
  p = store.get(p.id);
  const dir = store.dir(p);
  const graphics = new Map<string, Asset>(),
    segments = new Map<string, Asset>();
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
          persistAsset(ctx, "proxy", key, c, null, {
            sourceAssets: [recording.id],
          });
          recording.proxyPath = c.path;
          recording.proxyStatus = "AVAILABLE";
          store.update(p.id, (x) => {
            const r = x.recordings.find((r) => r.id === recording.id)!;
            r.proxyPath = c.path;
            r.proxyStatus = "AVAILABLE";
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
      tasks.push({
        id: `segment-${scene.id}`,
        type: "preview-segment",
        label: `Preview segment • ${scene.id}`,
        dependencies: [
          `proxy-${scene.camera.recordingId}`,
          ...(scene.enabled && scene.visual.graphic ? [graphicId] : []),
        ],
        run: async (ctx) => {
          const recording = p.recordings.find(
            (r) => r.id === scene.camera.recordingId,
          )!;
          const graphic = graphics.get(scene.id);
          const key = hash({
            source: recording.hash,
            sourceInFrame: scene.sourceInFrame,
            durationFrames: scene.durationFrames,
            punchIn: graphic ? 1 : scene.camera.punchIn,
            audio: scene.audio,
            graphic: graphic?.outputHash || null,
            renderer: `preview-v2-${PREVIEW.frameRate}fps-${PREVIEW.height}p`,
          });
          const c = await cachedFile(
            dir,
            key,
            `cache/segment-${key}.mp4`,
            async (temp) => {
              await renderSegment({
                source: await safePath(dir, recording.proxyPath!),
                graphic: graphic ? await safePath(dir, graphic.path) : null,
                sourceStart: scene.sourceInFrame / plan.frameRate,
                duration: scene.durationFrames / plan.frameRate,
                punchIn: scene.camera.punchIn,
                gainDb: scene.audio.gainDb,
                hasAudio: recording.hasAudio,
                output: temp,
                signal: ctx.signal,
                progress: ctx.progress,
              });
              await verifyOutput(
                temp,
                scene.durationFrames / plan.frameRate,
                ctx.signal,
              );
            },
          );
          segments.set(
            scene.id,
            persistAsset(ctx, "preview-segment", key, c, scene.id, {
              sourceAssets: [
                recording.id,
                ...(graphic ? [graphic.assetId] : []),
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
        const timeline = makeTimeline(plan, p.recordings, graphics);
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
        const key = hash({
          segments: plan.scenes.map((s) => segments.get(s.id)!.outputHash),
          operation: "concat-v1",
        });
        const c = await cachedFile(dir, key, previewPath, async (temp) =>
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
    tasks.push({
      id: "qa",
      type: "qa",
      label: "QA • decode, duration and asset completeness",
      dependencies: ["assembly"],
      run: async (ctx) => {
        const meta = await verifyOutput(
          await safePath(dir, previewPath),
          plan.durationFrames / plan.frameRate,
          ctx.signal,
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
        await store.artifact(p, qaPath, {
          status: "PASS",
          checkedAt: now(),
          checks: [
            "All expected scene assets present",
            "Timeline ranges validated",
            "Full preview decoded without FFmpeg errors",
            "Duration within 120 ms",
            "Original source content hashes verified",
          ],
          metadata: meta,
          audio,
          coverage: coverageSummary(plan, p.recordings),
          warnings,
          humanChecks: [
            "Factual accuracy and narration/graphic agreement",
            "Speech pacing, dead air and mix",
            "Text fit and brand consistency",
          ],
          coverageNote:
            "Technical QA only; not factual or perceptual approval.",
        });
        ctx.log(
          `QA passed: ${meta.duration.toFixed(2)}s, ${meta.width}×${meta.height}.`,
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
