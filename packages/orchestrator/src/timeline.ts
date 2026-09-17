import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { ffmpeg, PREVIEW } from "../../media/src/index.ts";
import { StudioError, inside } from "../../shared/src/index.ts";
import type {
  AudioDesign,
  ProductionPlan,
} from "../../production-plan/src/index.ts";
import type { Asset, Recording } from "./model.ts";
const clipSchema = z.strictObject({
  id: z.string(),
  sceneId: z.string(),
  assetId: z.string(),
  path: z.string(),
  startFrame: z.number().int().nonnegative(),
  sourceInFrame: z.number().int().nonnegative(),
  durationFrames: z.number().int().positive(),
  sourceDurationFrames: z.number().int().positive(),
  punchIn: z.number().min(1).max(1.35),
  // Narration gains sit in -24..12; music beds may reach the audio-design floor.
  gainDb: z.number().min(-48).max(12),
  /** Normalized inset rectangle for B-roll overlay clips. */
  inset: z
    .strictObject({
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      width: z.number().min(0.2).max(1),
    })
    .nullable()
    .default(null),
  /** Timeline clip kind; drives FCPXML lane/role decisions. */
  kind: z
    .enum(["presenter", "graphic", "broll-inset", "music", "sfx", "narration"])
    .default("presenter"),
});
export const timelineSchema = z.strictObject({
  schemaVersion: z.literal("1.1.0"),
  name: z.string(),
  planVersion: z.number().int().positive(),
  frameRate: z.number().int().positive(),
  resolution: z.strictObject({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  durationFrames: z.number().int().positive(),
  tracks: z.array(
    z.strictObject({
      id: z.string(),
      kind: z.enum(["video", "audio"]),
      name: z.string(),
      clips: z.array(clipSchema),
    }),
  ),
  markers: z.array(
    z.strictObject({
      frame: z.number().int().nonnegative(),
      durationFrames: z.number().int().positive(),
      label: z.string(),
      sceneId: z.string(),
    }),
  ),
});
export type Timeline = z.infer<typeof timelineSchema>;
export function validateTimeline(input: unknown): Timeline {
  const t = timelineSchema.parse(input);
  const ids = new Set<string>();
  for (const track of t.tracks) {
    let end = 0;
    for (const c of track.clips) {
      if (
        ids.has(c.id) ||
        c.startFrame < end ||
        c.startFrame + c.durationFrames > t.durationFrames ||
        c.sourceInFrame + c.durationFrames > c.sourceDurationFrames
      )
        throw new StudioError("INVALID_PLAN", `Invalid timeline clip ${c.id}.`);
      inside("/project", c.path);
      ids.add(c.id);
      end = c.startFrame + c.durationFrames;
    }
  }
  return t;
}
/** B-roll clips produced by the build, keyed by scene then entry ID. */
export interface TimelineBrollClip {
  sceneId: string;
  brollId: string;
  assetId: string;
  path: string;
}
export interface TimelineAudio {
  design: AudioDesign;
  /** Project-relative copied track and its true frame count. */
  music: { path: string; sourceDurationFrames: number } | null;
  sfx: {
    event: AudioDesign["sfx"][number];
    path: string;
    sourceDurationFrames: number;
  }[];
}
export function makeTimeline(
  plan: ProductionPlan,
  recordings: Recording[],
  graphics: Map<string, Asset>,
  broll: Map<string, TimelineBrollClip[]> = new Map(),
  audio: TimelineAudio = {
    design: { music: null, sfx: [] },
    music: null,
    sfx: [],
  },
): Timeline {
  const video: Timeline["tracks"][number] = {
    id: "v1",
    kind: "video",
    name: "Presenter • source proxy",
    clips: [],
  };
  const overlays: Timeline["tracks"][number] = {
    id: "v2",
    kind: "video",
    name: "WinTheCloud graphics",
    clips: [],
  };
  const insets: Timeline["tracks"][number] = {
    id: "v3",
    kind: "video",
    name: "B-roll insets",
    clips: [],
  };
  const audioTrack: Timeline["tracks"][number] = {
    id: "a1",
    kind: "audio",
    name: "A-roll narration",
    clips: [],
  };
  for (const s of plan.scenes) {
    const r = recordings.find((r) => r.id === s.camera.recordingId);
    if (!r?.proxyPath)
      throw new StudioError(
        "INVALID_PLAN",
        "Timeline needs a conformed proxy.",
      );
    const c = {
      id: `${s.id}-video`,
      sceneId: s.id,
      assetId: r.id,
      path: r.proxyPath,
      startFrame: s.startFrame,
      sourceInFrame: s.sourceInFrame,
      durationFrames: s.durationFrames,
      // The proxy's real frame count once conformed; otherwise the
      // deterministic floor(duration × fps) the proxy encode is capped to.
      sourceDurationFrames:
        r.proxyFrames ?? Math.floor(r.duration * plan.frameRate),
      punchIn: s.camera.punchIn,
      gainDb: s.audio.gainDb,
      inset: null,
      kind: "presenter",
    } as const;
    video.clips.push(c);
    if (r.hasAudio)
      audioTrack.clips.push({
        ...c,
        id: `${s.id}-audio`,
        punchIn: 1,
        kind: "narration",
      });
    const a = graphics.get(s.id);
    if (s.enabled && s.visual.graphic) {
      if (!a)
        throw new StudioError("INVALID_PLAN", `Missing graphic for ${s.id}`);
      overlays.clips.push({
        ...c,
        id: `${s.id}-graphic`,
        assetId: a.assetId,
        path: a.path,
        sourceInFrame: 0,
        sourceDurationFrames: s.durationFrames,
        punchIn: 1,
        kind: "graphic",
      });
    }
    if (!s.enabled) continue;
    for (const entry of [...s.broll].sort(
      (x, y) => x.startFrame - y.startFrame,
    )) {
      const clip = (broll.get(s.id) || []).find((x) => x.brollId === entry.id);
      if (!clip)
        throw new StudioError(
          "INVALID_PLAN",
          `Missing B-roll clip for ${s.id}/${entry.id}`,
        );
      if (entry.placement === "fullframe") {
        // Full-frame B-roll replaces the presenter exactly like a graphic.
        overlays.clips.push({
          ...c,
          id: `${s.id}-${entry.id}-broll`,
          assetId: clip.assetId,
          path: clip.path,
          sourceInFrame: 0,
          sourceDurationFrames: entry.durationFrames,
          punchIn: 1,
          kind: "graphic",
        });
      } else {
        insets.clips.push({
          ...c,
          id: `${s.id}-${entry.id}-inset`,
          assetId: clip.assetId,
          path: clip.path,
          startFrame: s.startFrame + entry.startFrame,
          sourceInFrame: 0,
          durationFrames: entry.durationFrames,
          sourceDurationFrames: entry.durationFrames,
          punchIn: 1,
          inset: entry.inset,
          kind: "broll-inset",
        });
      }
    }
  }
  const tracks: Timeline["tracks"] = [video, overlays, insets, audioTrack];
  if (audio.music && audio.design.music) {
    const m = audio.design.music;
    // Contiguous per-scene music clips carry the per-scene intensity; adjacent
    // scenes with equal intensity merge into one clip. Intensity 0 pins the
    // bed at the clip gain floor rather than dropping the lane.
    const musicClips: Timeline["tracks"][number]["clips"] = [];
    let runStart = 0;
    let runEnd = 0;
    let runGain = Number.NaN;
    const flush = () => {
      if (!Number.isNaN(runGain))
        musicClips.push({
          id: `music-bed-${runStart}`,
          sceneId:
            plan.scenes.find((s) => s.startFrame === runStart)?.id ??
            plan.scenes[0].id,
          assetId: "music",
          path: audio.music!.path,
          startFrame: runStart,
          sourceInFrame: 0,
          durationFrames: runEnd - runStart,
          // A looped bed is as long as the timeline it was mixed into.
          sourceDurationFrames: Math.max(
            audio.music!.sourceDurationFrames,
            plan.durationFrames,
          ),
          punchIn: 1,
          gainDb: runGain,
          inset: null,
          kind: "music",
        });
    };
    for (const s of plan.scenes) {
      const gain = Math.max(
        -48,
        m.gainDb + 20 * Math.log10(Math.max(s.musicIntensity, 1e-4)),
      );
      if (gain === runGain) runEnd = s.startFrame + s.durationFrames;
      else {
        flush();
        runStart = s.startFrame;
        runEnd = s.startFrame + s.durationFrames;
        runGain = gain;
      }
    }
    flush();
    tracks.push({
      id: "a2",
      kind: "audio",
      name: "Music bed",
      clips: musicClips,
    });
  }
  // SFX one-shots never share a lane; pack greedily into ordered lanes.
  const lanes: { end: number; clips: Timeline["tracks"][number]["clips"] }[] =
    [];
  for (const event of audio.sfx) {
    const frames = Math.min(
      event.sourceDurationFrames,
      plan.durationFrames - event.event.atFrame,
    );
    if (frames <= 0) continue;
    let lane = lanes.find((l) => l.end <= event.event.atFrame);
    if (!lane) {
      lane = { end: 0, clips: [] };
      lanes.push(lane);
    }
    lane.end = event.event.atFrame + frames;
    lane.clips.push({
      id: `sfx-${event.event.id}`,
      sceneId:
        plan.scenes.find(
          (s) =>
            s.startFrame <= event.event.atFrame &&
            event.event.atFrame < s.startFrame + s.durationFrames,
        )?.id ?? plan.scenes[0].id,
      assetId: `sfx:${event.event.trackId}`,
      path: event.path,
      startFrame: event.event.atFrame,
      sourceInFrame: 0,
      durationFrames: frames,
      sourceDurationFrames: event.sourceDurationFrames,
      punchIn: 1,
      gainDb: event.event.gainDb,
      inset: null,
      kind: "sfx",
    });
  }
  lanes.forEach((lane, i) =>
    tracks.push({
      id: `a3${i ? `-${i + 1}` : ""}`,
      kind: "audio",
      name: `SFX${i ? ` ${i + 1}` : ""}`,
      clips: lane.clips,
    }),
  );
  return validateTimeline({
    schemaVersion: "1.1.0",
    name: "WinTheCloud rough cut",
    planVersion: plan.version,
    frameRate: plan.frameRate,
    resolution: plan.resolution,
    durationFrames: plan.durationFrames,
    tracks,
    markers: plan.scenes.map((s) => ({
      frame: s.startFrame,
      durationFrames: s.durationFrames,
      label: s.chapterTitle
        ? `Chapter — ${s.chapterTitle}`
        : s.visual.description,
      sceneId: s.id,
    })),
  });
}
const chapterClock = (seconds: number) => {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60),
    sec = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
};
/** YouTube-ready chapter list derived from chapter markers. */
export function toChapters(t: Timeline) {
  validateTimeline(t);
  const chapters = t.markers
    .filter((m) => m.label.startsWith("Chapter — "))
    .map((m) => ({
      seconds: m.frame / t.frameRate,
      title: m.label.replace(/^Chapter — /, ""),
    }));
  if (!chapters.length) return "";
  if (!chapters.some((c) => c.seconds < 1))
    chapters.unshift({ seconds: 0, title: "Intro" });
  return chapters
    .map((c) => `${chapterClock(c.seconds)} ${c.title}`)
    .join("\n");
}
const time = (value: number, rate: number) => ({
  OTIO_SCHEMA: "RationalTime.1",
  value,
  rate,
});
const range = (start: number, duration: number, rate: number) => ({
  OTIO_SCHEMA: "TimeRange.1",
  start_time: time(start, rate),
  duration: time(duration, rate),
});
/** OTIO uses seconds-equivalent rational frame times and file URLs; no application-specific commands. */
export function toOTIO(t: Timeline, projectDir: string) {
  validateTimeline(t);
  return {
    OTIO_SCHEMA: "Timeline.1",
    name: t.name,
    metadata: {
      wts: {
        planVersion: t.planVersion,
        resolution: t.resolution,
        framingNote:
          "Camera punch-in and gain are encoded in the companion FCPXML; OTIO metadata retains these instructions.",
      },
    },
    global_start_time: time(0, t.frameRate),
    tracks: {
      OTIO_SCHEMA: "Stack.1",
      name: "Production",
      metadata: {},
      effects: [],
      markers: t.markers.map((m) => ({
        OTIO_SCHEMA: "Marker.2",
        name: m.label,
        color: "GREEN",
        marked_range: range(m.frame, m.durationFrames, t.frameRate),
        metadata: { sceneId: m.sceneId },
      })),
      children: t.tracks.map((track) => {
        const children: unknown[] = [];
        let cursor = 0;
        for (const c of track.clips) {
          if (c.startFrame > cursor)
            children.push({
              OTIO_SCHEMA: "Gap.1",
              name: "",
              metadata: {},
              effects: [],
              markers: [],
              source_range: range(0, c.startFrame - cursor, t.frameRate),
            });
          children.push({
            OTIO_SCHEMA: "Clip.2",
            name: c.sceneId,
            metadata: {
              wts: { assetId: c.assetId, punchIn: c.punchIn, gainDb: c.gainDb },
            },
            source_range: range(c.sourceInFrame, c.durationFrames, t.frameRate),
            effects: [],
            markers: [],
            media_references: {
              DEFAULT_MEDIA: {
                OTIO_SCHEMA: "ExternalReference.1",
                target_url: pathToFileURL(inside(projectDir, c.path)).href,
                name: path.basename(c.path),
                metadata: {},
                available_range: range(0, c.sourceDurationFrames, t.frameRate),
              },
            },
            active_media_reference_key: "DEFAULT_MEDIA",
          });
          cursor = c.startFrame + c.durationFrames;
        }
        if (cursor < t.durationFrames)
          children.push({
            OTIO_SCHEMA: "Gap.1",
            name: "",
            metadata: {},
            effects: [],
            markers: [],
            source_range: range(0, t.durationFrames - cursor, t.frameRate),
          });
        return {
          OTIO_SCHEMA: "Track.1",
          name: track.name,
          kind: track.kind === "video" ? "Video" : "Audio",
          metadata: {},
          source_range: null,
          effects: [],
          markers: [],
          children,
        };
      }),
    },
  };
}
const xml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
export function toFCPXML(t: Timeline, projectDir: string) {
  validateTimeline(t);
  const fps = t.frameRate;
  const seconds = (n: number) => `${n}/${fps}s`;
  const base = t.tracks.find((x) => x.id === "v1")!;
  const overlays = t.tracks.find((x) => x.id === "v2")!;
  const insets = t.tracks.find((x) => x.id === "v3");
  const narration = t.tracks.find((x) => x.id === "a1")!;
  const music = t.tracks.find((x) => x.id === "a2");
  const sfxLanes = t.tracks.filter((x) => /^a3/.test(x.id));
  const resources = new Map<
    string,
    { id: string; duration: number; audio: boolean }
  >();
  for (const track of t.tracks)
    for (const c of track.clips) {
      const old = resources.get(c.path);
      resources.set(c.path, {
        id: old?.id || `r${resources.size + 2}`,
        duration: Math.max(old?.duration || 0, c.sourceDurationFrames),
        audio: !!old?.audio || track.kind === "audio",
      });
    }
  const assets = [...resources]
    .map(
      ([file, r]) =>
        `<asset id="${r.id}" name="${xml(path.basename(file))}" start="0s" duration="${seconds(r.duration)}" hasVideo="1" format="r1"${r.audio ? ' hasAudio="1" audioSources="1" audioChannels="2" audioRate="48000"' : ""} src="${xml(pathToFileURL(inside(projectDir, file)).href)}"/>`,
    )
    .join("\n");
  const sceneStart = (sceneId: string) =>
    base.clips.find((c) => c.sceneId === sceneId)?.startFrame ?? 0;
  /** Connected inset: rendered at box size; position offsets from frame centre. */
  const insetTransform = (c: Timeline["tracks"][number]["clips"][number]) => {
    const W = t.resolution.width,
      H = t.resolution.height;
    const boxW = (c.inset?.width ?? 1) * W;
    const boxH = boxW * (2 / 3);
    const cx = (c.inset?.x ?? 0) * W + boxW / 2;
    const cy = (c.inset?.y ?? 0) * H + boxH / 2;
    return `<adjust-transform position="${(cx - W / 2).toFixed(1)} ${(H / 2 - cy).toFixed(1)}" scale="1 1" anchor="0 0"/>`;
  };
  const audioChildren = (parentStart: number, parentEnd: number) => {
    const parts: string[] = [];
    for (const c of music?.clips ?? [])
      if (c.startFrame >= parentStart && c.startFrame < parentEnd)
        parts.push(
          `<asset-clip lane="-1" name="Music bed" ref="${resources.get(c.path)!.id}" offset="${seconds(Math.max(0, c.startFrame - parentStart))}" start="0s" duration="${seconds(Math.min(c.durationFrames, t.durationFrames - c.startFrame))}" audioRole="music" srcEnable="audio"><adjust-volume amount="${c.gainDb}dB"/></asset-clip>`,
        );
    sfxLanes.forEach((lane, i) => {
      for (const c of lane.clips)
        if (c.startFrame >= parentStart && c.startFrame < parentEnd)
          parts.push(
            `<asset-clip lane="${-2 - i}" name="${xml(c.id)}" ref="${resources.get(c.path)!.id}" offset="${seconds(c.startFrame - parentStart)}" start="0s" duration="${seconds(c.durationFrames)}" audioRole="effects" srcEnable="audio"><adjust-volume amount="${c.gainDb}dB"/></asset-clip>`,
          );
    });
    return parts.join("");
  };
  const clips = base.clips
    .map((c) => {
      const g = overlays.clips.find((g) => g.sceneId === c.sceneId);
      const sceneInsets = (insets?.clips ?? []).filter(
        (i) => i.sceneId === c.sceneId,
      );
      const hasAudio = narration.clips.some((a) => a.sceneId === c.sceneId);
      const end = c.startFrame + c.durationFrames;
      return `<asset-clip name="${xml(c.sceneId)}" ref="${resources.get(c.path)!.id}" offset="${seconds(c.startFrame)}" start="${seconds(c.sourceInFrame)}" duration="${seconds(c.durationFrames)}"${hasAudio ? ' audioRole="dialogue"' : ' srcEnable="video"'}><adjust-transform position="0 0" scale="${c.punchIn} ${c.punchIn}" anchor="0 0"/>${hasAudio ? `<adjust-volume amount="${c.gainDb}dB"/>` : ""}${g ? `<asset-clip lane="1" name="${xml(g.sceneId + " graphic")}" ref="${resources.get(g.path)!.id}" offset="0s" start="0s" duration="${seconds(g.durationFrames)}" srcEnable="video"/>` : ""}${sceneInsets
        .map(
          (i) =>
            `<asset-clip lane="2" name="${xml(i.id)}" ref="${resources.get(i.path)!.id}" offset="${seconds(i.startFrame - sceneStart(i.sceneId))}" start="0s" duration="${seconds(i.durationFrames)}" srcEnable="video">${insetTransform(i)}</asset-clip>`,
        )
        .join(
          "",
        )}${audioChildren(c.startFrame, end)}<marker start="0s" duration="${seconds(1)}" value="${xml(t.markers.find((m) => m.sceneId === c.sceneId)?.label || c.sceneId)}"/></asset-clip>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n<fcpxml version="1.8"><resources><format id="r1" name="WinTheCloud${t.resolution.height}p${fps}" frameDuration="1/${fps}s" width="${t.resolution.width}" height="${t.resolution.height}" colorSpace="1-1-1 (Rec. 709)"/>${assets}</resources><library><event name="WinTheCloud Studio"><project name="${xml(t.name + " v" + t.planVersion)}"><sequence format="r1" duration="${seconds(t.durationFrames)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k"><spine>${clips}</spine></sequence></project></event></library></fcpxml>\n`;
}
export interface SegmentOverlay {
  /** Rendered B-roll clip (already at box size, plan fps). */
  clip: string;
  /** Pixel rectangle at output resolution. */
  x: number;
  y: number;
  width: number;
  height: number;
  startSec: number;
  endSec: number;
  fadeInSec: number;
  fadeOutSec: number;
}
export interface SegmentRenderOptions {
  source: string;
  graphic: string | null;
  sourceStart: number;
  duration: number;
  punchIn: number;
  gainDb: number;
  hasAudio: boolean;
  output: string;
  signal?: AbortSignal;
  progress?: (f: number) => void;
  target?: { width: number; height: number; frameRate: number };
  overlays?: SegmentOverlay[];
}
/**
 * Pure FFmpeg argument builder for one preview segment. Video is frame-exact:
 * `-frames:v` pins the output count (float `-t` truncation can silently drop
 * the final frame), while `-t` — padded by half a frame — only bounds the
 * padded audio stream.
 */
export function segmentArgs(
  o: Omit<SegmentRenderOptions, "signal" | "progress">,
): string[] {
  const { width, height, frameRate } = o.target ?? PREVIEW;
  const frames = Math.round(o.duration * frameRate);
  const inputs = [
    "-ss",
    String(o.sourceStart),
    "-protocol_whitelist",
    "file,pipe",
    "-i",
    o.source,
  ];
  if (o.graphic)
    inputs.push("-protocol_whitelist", "file,pipe", "-i", o.graphic);
  const visualIndex = o.graphic ? 1 : 0;
  const filters = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1${!o.graphic && o.punchIn !== 1 ? `,scale=ceil(iw*${o.punchIn}/2)*2:ceil(ih*${o.punchIn}/2)*2,crop=${width}:${height}` : ""},fps=${frameRate}`;
  if (!o.hasAudio)
    inputs.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
  const audioIndex = o.hasAudio ? 0 : o.graphic ? 2 : 1;
  const encode = [
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "24",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-video_track_timescale",
    "15360",
    "-movflags",
    "+faststart",
    o.output,
  ];
  const overlays = o.overlays ?? [];
  if (!overlays.length)
    return [
      ...inputs,
      "-map",
      `${visualIndex}:v:0`,
      "-map",
      `${audioIndex}:a:0`,
      "-frames:v",
      String(frames),
      "-t",
      String(o.duration + 0.5 / frameRate),
      "-vf",
      filters,
      "-af",
      `volume=${o.gainDb}dB,apad`,
      ...encode,
    ];
  // Overlay path: build one filter graph so presenter, punch-in, insets and
  // audio stay in a single deterministic encode.
  for (const ov of overlays)
    inputs.push("-protocol_whitelist", "file,pipe", "-i", ov.clip);
  const chains: string[] = [`[${visualIndex}:v]${filters}[base0]`];
  const audioPad = `[${audioIndex}:a]volume=${o.gainDb}dB,apad[aout]`;
  overlays.forEach((ov, i) => {
    const inputIndex = (o.graphic ? 2 : 1) + (o.hasAudio ? 0 : 1) + i;
    const fadeIn =
      ov.fadeInSec > 0
        ? `fade=t=in:st=0:d=${ov.fadeInSec.toFixed(3)}:alpha=1,`
        : "";
    const fadeOut =
      ov.fadeOutSec > 0
        ? `,fade=t=out:st=${Math.max(0, ov.endSec - ov.startSec - ov.fadeOutSec).toFixed(3)}:d=${ov.fadeOutSec.toFixed(3)}:alpha=1`
        : "";
    chains.push(
      `[${inputIndex}:v]scale=${Math.round(ov.width)}:${Math.round(ov.height)},setsar=1,format=yuva420p,${fadeIn}format=yuva420p${fadeOut}[ov${i}]`,
    );
    chains.push(
      `[base${i}][ov${i}]overlay=x=${Math.round(ov.x)}:y=${Math.round(ov.y)}:enable='between(t,${ov.startSec.toFixed(3)},${ov.endSec.toFixed(3)})'[base${i + 1}]`,
    );
  });
  chains.push(audioPad);
  return [
    ...inputs,
    "-filter_complex",
    chains.join(";"),
    "-map",
    `[base${overlays.length}]`,
    "-map",
    "[aout]",
    "-frames:v",
    String(frames),
    "-t",
    String(o.duration + 0.5 / frameRate),
    ...encode,
  ];
}
export async function renderSegment(options: SegmentRenderOptions) {
  const { signal, progress, ...rest } = options;
  await ffmpeg(segmentArgs(rest), signal, progress, rest.duration);
}
export async function concatenateSegments(
  projectDir: string,
  segments: string[],
  output: string,
  signal?: AbortSignal,
) {
  // Concat entries are trusted managed filenames, never model or user command text.
  const list = output + ".concat.txt";
  await writeFile(
    list,
    segments
      .map(
        (file) => `file '${inside(projectDir, file).replace(/'/g, "'\\''")}'`,
      )
      .join("\n") + "\n",
  );
  await ffmpeg(
    [
      "-f",
      "concat",
      "-safe",
      "0",
      "-protocol_whitelist",
      "file,pipe",
      "-i",
      list,
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      output,
    ],
    signal,
  );
}
