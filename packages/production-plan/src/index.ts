import { z } from "zod";
import { hash, StudioError } from "../../shared/src/index.ts";

const frame = z.number().int().nonnegative();
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/);
const title = z.string().min(1).max(100);
const subtitle = z.string().max(180);
const nodeLabel = z.string().min(1).max(24);
const codeLine = z.string().max(90);

/** The Remotion primitive catalog. Each variant carries its own parameters. */
export const graphicSchema = z.discriminatedUnion("template", [
  z.strictObject({
    engine: z.literal("remotion"),
    template: z.literal("ChapterTitle"),
    templateVersion: z.literal("1.0.0"),
    parameters: z.strictObject({ title, subtitle }),
  }),
  z.strictObject({
    engine: z.literal("remotion"),
    template: z.literal("Callout"),
    templateVersion: z.literal("1.0.0"),
    parameters: z.strictObject({ title, subtitle }),
  }),
  z.strictObject({
    engine: z.literal("remotion"),
    template: z.literal("Quote"),
    templateVersion: z.literal("1.0.0"),
    parameters: z.strictObject({
      quote: z.string().min(1).max(300),
      attribution: z.string().max(80),
    }),
  }),
  z.strictObject({
    engine: z.literal("remotion"),
    template: z.literal("ArchitectureFlow"),
    templateVersion: z.literal("1.0.0"),
    parameters: z.strictObject({
      title,
      subtitle,
      nodes: z.array(nodeLabel).min(2).max(6),
      emphasis: z.number().int().min(-1).max(5),
    }),
  }),
  z.strictObject({
    engine: z.literal("remotion"),
    template: z.literal("ArchitectureDiagram"),
    templateVersion: z.literal("1.0.0"),
    parameters: z.strictObject({
      title,
      subtitle,
      layers: z
        .array(
          z.strictObject({
            name: z.string().min(1).max(28),
            components: z.array(nodeLabel).min(1).max(4),
          }),
        )
        .min(2)
        .max(4),
      failedLayer: z.number().int().min(-1).max(3),
    }),
  }),
  z.strictObject({
    engine: z.literal("remotion"),
    template: z.literal("RequestFlow"),
    templateVersion: z.literal("1.0.0"),
    parameters: z.strictObject({
      title,
      subtitle,
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
      path: z.string().min(1).max(60),
      steps: z.array(nodeLabel).min(2).max(6),
      failureStep: z.number().int().min(-1).max(5),
    }),
  }),
  z.strictObject({
    engine: z.literal("remotion"),
    template: z.literal("CodeReveal"),
    templateVersion: z.literal("1.0.0"),
    parameters: z.strictObject({
      title,
      fileName: z.string().min(1).max(60),
      lines: z.array(codeLine).min(1).max(12),
      highlight: z.number().int().min(-1).max(11),
    }),
  }),
  z.strictObject({
    engine: z.literal("remotion"),
    template: z.literal("Terminal"),
    templateVersion: z.literal("1.0.0"),
    parameters: z.strictObject({
      title,
      lines: z
        .array(
          z.strictObject({
            kind: z.enum(["input", "output", "error"]),
            text: z.string().max(100),
          }),
        )
        .min(2)
        .max(14),
    }),
  }),
  z.strictObject({
    engine: z.literal("remotion"),
    template: z.literal("CodeDiff"),
    templateVersion: z.literal("1.0.0"),
    parameters: z.strictObject({
      title,
      fileName: z.string().min(1).max(60),
      removed: z.array(codeLine).max(8),
      added: z.array(codeLine).min(1).max(8),
    }),
  }),
  z.strictObject({
    engine: z.literal("remotion"),
    template: z.literal("MetricChart"),
    templateVersion: z.literal("1.0.0"),
    parameters: z.strictObject({
      title,
      subtitle,
      unit: z.string().min(1).max(10),
      series: z.array(z.number().min(-1e9).max(1e9)).min(3).max(24),
      threshold: z.number().min(-1e9).max(1e9).nullable(),
      goodDirection: z.enum(["up", "down"]),
      /** Whether the series is spoken in the narration or a labeled hypothesis. */
      basis: z.enum(["narration", "illustrative"]).default("narration"),
    }),
  }),
  z.strictObject({
    engine: z.literal("remotion"),
    template: z.literal("FailureAnimation"),
    templateVersion: z.literal("1.0.0"),
    parameters: z.strictObject({
      title,
      subtitle,
      nodes: z.array(nodeLabel).min(2).max(6),
      failedNode: z.number().int().min(0).max(5),
      recovered: z.boolean(),
    }),
  }),
]);

/** Usage guidance surfaced to the Director; rendering lives in templates/remotion. */
export const TEMPLATE_CATALOG = [
  {
    template: "ChapterTitle",
    when: "Opening a major section or argument shift.",
    parameters: "title (≤100), subtitle.",
  },
  {
    template: "Callout",
    when: "A single sharp claim or definition the viewer must retain.",
    parameters: "title (≤100), subtitle.",
  },
  {
    template: "Quote",
    when: "Verbatim quotation, tweet, or error message being read aloud.",
    parameters: "quote (≤300), attribution.",
  },
  {
    template: "ArchitectureFlow",
    when: "A linear pipeline or request path of 2–6 services.",
    parameters:
      "title, subtitle, nodes[2–6] (≤24 chars), emphasis index or -1.",
  },
  {
    template: "ArchitectureDiagram",
    when: "Layered architecture (client/app/data tiers) with a failing layer.",
    parameters:
      "title, subtitle, layers[2–4]{name, components[1–4]}, failedLayer or -1.",
  },
  {
    template: "RequestFlow",
    when: "One concrete HTTP call travelling through steps, with a failing step.",
    parameters: "title, subtitle, method, path, steps[2–6], failureStep or -1.",
  },
  {
    template: "CodeReveal",
    when: "Show ≤12 lines of real code; highlight one line while it is narrated.",
    parameters: "title, fileName, lines[1–12], highlight index or -1.",
  },
  {
    template: "Terminal",
    when: "A command being run and its output or error.",
    parameters: "title, lines[2–14]{kind: input|output|error, text}.",
  },
  {
    template: "CodeDiff",
    when: "A before/after code change (the fix, the migration).",
    parameters: "title, fileName, removed[≤8], added[1–8].",
  },
  {
    template: "MetricChart",
    when: "A number changing over time (latency, uptime, cost, users).",
    parameters:
      "title, subtitle, unit, series[3–24], threshold|null, goodDirection, basis narration|illustrative. Series values must be spoken in the narration; a chart of hypothetical values must set basis to illustrative and say so in the subtitle.",
  },
  {
    template: "FailureAnimation",
    when: "Cascading failure across 2–6 nodes, optionally with recovery.",
    parameters: "title, subtitle, nodes[2–6], failedNode, recovered.",
  },
] as const;

/**
 * B-roll assets are produced by non-Remotion engines. Each variant is a typed,
 * validated instruction — never executable content (ADR 007). Engines join
 * this union alongside their trusted adapter (gpt-image stills, Blender 3D).
 */
export const brollAssetSchema = z.discriminatedUnion("engine", [
  z.strictObject({
    engine: z.literal("gpt-image"),
    template: z.literal("GeneratedStill"),
    templateVersion: z.literal("1.0.0"),
    parameters: z.strictObject({
      /** What the image must communicate; tied to the narration span it covers. */
      brief: z.string().min(10).max(600),
      style: z.enum([
        "photoreal",
        "technical-illustration",
        "isometric-diagram",
        "cinematic",
        "clean-3d",
        "minimal-lineart",
      ]),
      palette: z.string().max(120).nullable(),
      avoid: z.string().max(200).nullable(),
      quality: z.enum(["low", "medium", "high"]),
      /** Whether the brief legitimately requires text inside the image. */
      expectsText: z.boolean(),
    }),
  }),
  z.strictObject({
    engine: z.literal("blender"),
    template: z.enum([
      "NetworkFlow",
      "ServerRack",
      "OrbitRings",
      "CascadeGrid",
      "DataTunnel",
      "TerrainSweep",
    ]),
    templateVersion: z.literal("1.0.0"),
    parameters: z.discriminatedUnion("template", [
      z.strictObject({
        template: z.literal("NetworkFlow"),
        /** Node graph labels; bounded and schema-checked, never code. */
        nodes: z.array(z.string().min(1).max(40)).min(2).max(8),
        packets: z.number().int().min(1).max(24),
      }),
      z.strictObject({
        template: z.literal("ServerRack"),
        racks: z.number().int().min(2).max(12),
        /** LED blink pulses per second. */
        pulseRate: z.number().min(0.5).max(6),
      }),
      z.strictObject({
        template: z.literal("OrbitRings"),
        rings: z.number().int().min(1).max(7),
        /** Orbit revolutions over the clip. */
        revolutions: z.number().min(0.25).max(3),
      }),
      z.strictObject({
        template: z.literal("CascadeGrid"),
        columns: z.number().int().min(3).max(16),
        rows: z.number().int().min(3).max(16),
        /** Wave phases across the grid over the clip. */
        waves: z.number().min(0.5).max(4),
      }),
      z.strictObject({
        template: z.literal("DataTunnel"),
        segments: z.number().int().min(6).max(60),
        /** Tunnel traversal speed in segments per second. */
        speed: z.number().min(0.5).max(12),
      }),
      z.strictObject({
        template: z.literal("TerrainSweep"),
        ridges: z.number().int().min(2).max(24),
        /** Terrain amplitude as a fraction of frame height. */
        amplitude: z.number().min(0.05).max(0.6),
      }),
    ]),
  }),
]);
export type BRollAsset = z.infer<typeof brollAssetSchema>;
/** Inset height = width × this fraction (landscape 3:2 source), in pixels. */
export const BROLL_INSET_HEIGHT_RATIO = 2 / 3;
/** Style guidance surfaced to the visual-direction pass. */
export const BROLL_CATALOG = [
  {
    engine: "gpt-image",
    template: "GeneratedStill",
    when: "Narration references something a diagram or presenter cannot show: a place, a physical machine, a historical moment, an abstract atmosphere.",
    parameters:
      "brief (10–600 chars, what it must communicate), style, palette|null, avoid|null, quality low|medium|high, expectsText.",
    styles: {
      photoreal:
        "Photographic realism: hardware, datacenter floors, control rooms.",
      "technical-illustration":
        "Clean editorial illustration of a technical concept.",
      "isometric-diagram":
        "Isometric cutaway of a system or facility with no labels.",
      cinematic: "Moody, filmic scene-setting imagery.",
      "clean-3d": "Simple 3D render of an object or structure.",
      "minimal-lineart": "Minimal line drawing, generous negative space.",
    },
    note: "Generated images must not carry text unless expectsText is true; text fidelity in generated imagery is unreliable and checked by visual QA.",
  },
  {
    engine: "blender",
    template:
      "NetworkFlow | ServerRack | OrbitRings | CascadeGrid | DataTunnel | TerrainSweep",
    when: "Narration describes structure, scale, motion or systems a stylized 3D render makes visceral: request paths, capacity, orbits, cascades, depth, terrain.",
    parameters:
      "NetworkFlow: nodes[2–8 labels], packets 1–24. ServerRack: racks 2–12, pulseRate 0.5–6. OrbitRings: rings 1–7, revolutions 0.25–3. CascadeGrid: columns/rows 3–16, waves 0.5–4. DataTunnel: segments 6–60, speed 0.5–12. TerrainSweep: ridges 2–24, amplitude 0.05–0.6.",
    styles: {
      NetworkFlow:
        "Glowing packets traveling a 3D node graph with labeled nodes.",
      ServerRack: "Corridor of server racks with pulsing status LEDs.",
      OrbitRings: "Concentric rings orbiting a focal object.",
      CascadeGrid: "A grid of cubes waving in a cascading phase.",
      DataTunnel: "Camera flight through a tunnel of data slabs.",
      TerrainSweep: "Abstract procedural terrain flyover.",
    },
    note: "3D renders are stylized and deterministic; labels are schema-bounded strings, colors come from the creator brand. Not photorealism — prefer gpt-image for places and physical machines.",
  },
] as const;

export const brollEntrySchema = z.strictObject({
  id: identifier,
  /** Relative to the scene start; the entry may end before the scene does. */
  startFrame: frame,
  durationFrames: z.number().int().min(12),
  placement: z.enum(["inset", "fullframe"]),
  /** Normalized frame rectangle; required exactly when placement is inset. */
  inset: z
    .strictObject({
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      width: z.number().min(0.2).max(1),
    })
    .nullable(),
  motion: z.enum(["none", "zoom-in", "zoom-out", "pan-left", "pan-right"]),
  asset: brollAssetSchema,
  /** The narration span this entry illustrates, quoted from the scene. */
  narrationHook: z.string().min(3).max(300),
});
export type BRollEntry = z.infer<typeof brollEntrySchema>;
export const sfxEventSchema = z.strictObject({
  id: identifier,
  atFrame: frame,
  trackId: z.string().min(1).max(120),
  gainDb: z.number().min(-24).max(0),
});
/** Shared mixing controls for a music bed, whatever its source. */
const musicControls = {
  gainDb: z.number().min(-42).max(-6),
  duckToDb: z.number().min(-48).max(-6),
  fadeInSec: z.number().min(0).max(5),
  fadeOutSec: z.number().min(0).max(5),
};
/** A bed taken from the creator-managed library; trackId must resolve there. */
export const libraryMusicSchema = z.strictObject({
  source: z.literal("library"),
  trackId: z.string().min(1).max(120),
  ...musicControls,
});
/**
 * A bed synthesized by a configured music-generation engine. The brief is a
 * generation prompt: mood/energy/instrumentation grounded in the video, never
 * artist names or copyrighted works. Requires the music engine at build time.
 */
export const generatedMusicSchema = z.strictObject({
  source: z.literal("generated"),
  brief: z.string().min(10).max(1200),
  ...musicControls,
});
export const musicDesignSchema = z.discriminatedUnion("source", [
  libraryMusicSchema,
  generatedMusicSchema,
]);
export type MusicDesign = z.infer<typeof musicDesignSchema>;
export const audioDesignSchema = z.strictObject({
  music: musicDesignSchema.nullable(),
  sfx: z.array(sfxEventSchema).max(50),
});
export type AudioDesign = z.infer<typeof audioDesignSchema>;

/**
 * The visual-direction pass: a decision about what the video needs, where it
 * belongs, how long it lasts and which narration span it illustrates — emitted
 * as data, then converted into setBroll/setAudioDesign patch operations.
 */
export const visualPassSchema = z.strictObject({
  summary: z.string().max(2000),
  music: audioDesignSchema.shape.music,
  sfx: z.array(sfxEventSchema).max(50),
  treatments: z
    .array(
      z.strictObject({
        sceneId: identifier,
        broll: z.array(brollEntrySchema).max(2),
        rationale: z.string().max(600),
      }),
    )
    .max(200),
});
export type VisualPass = z.infer<typeof visualPassSchema>;

/**
 * How a scene's source was selected, carried from the alignment for review:
 * match confidence, whether the span was bridged without direct evidence, and
 * the alternative takes that were considered.
 */
export const selectionSchema = z.strictObject({
  score: z.number().min(0).max(1),
  bridged: z.boolean(),
  alternates: z
    .array(
      z.strictObject({
        recordingId: identifier,
        start: z.number().nonnegative(),
        end: z.number().positive(),
        score: z.number().min(0).max(1),
      }),
    )
    .max(6)
    .default([]),
});
export type SceneSelection = z.infer<typeof selectionSchema>;
/**
 * Script-level coverage of the plan: which approved sentences made the cut and
 * why any omission is intentional. Plans authored without an alignment
 * (imported or curated) legitimately carry null.
 */
export const scriptCoverageSchema = z.strictObject({
  sentences: z
    .array(
      z.strictObject({
        text: z.string().min(1).max(2000),
        status: z.enum(["included", "omitted"]),
        sceneId: identifier.nullable().default(null),
        reason: z.string().max(500).nullable().default(null),
      }),
    )
    .max(2000),
});
export type ScriptCoverage = z.infer<typeof scriptCoverageSchema>;
export const sceneSchema = z.strictObject({
  id: identifier,
  startFrame: frame,
  durationFrames: z.number().int().min(1),
  sourceInFrame: frame,
  narration: z.string().max(20000),
  transcriptSegmentIds: z.array(identifier),
  camera: z.strictObject({
    recordingId: identifier,
    framing: z.enum(["wide", "medium", "close"]),
    punchIn: z.number().min(1).max(1.35),
  }),
  visual: z.strictObject({
    type: z.enum(["presenter", "graphic"]),
    description: z.string().max(1000),
    graphic: graphicSchema.nullable(),
  }),
  /** Generated-asset overlays; presenter footage keeps playing underneath. */
  broll: z.array(brollEntrySchema).max(2).default([]),
  audio: z.strictObject({ gainDb: z.number().min(-24).max(12) }),
  /**
   * Per-scene music bed level as a linear multiplier on top of the plan-level
   * music gain: effective gainDb = music.gainDb + 20·log10(intensity). 1 is
   * the plan default, 0 silences the bed for the scene. The Director proposes
   * it; the creator may edit it.
   */
  musicIntensity: z.number().min(0).max(1).default(1),
  transition: z.literal("cut"),
  enabled: z.boolean(),
  rationale: z.string().max(1000),
  chapterTitle: z.string().min(1).max(120).nullable(),
  selection: selectionSchema.nullable().default(null),
});
/**
 * How animation-heavy the plan is: "minimal" keeps the presenter on screen and
 * allows only essential graphics, "balanced" is the restrained default, "rich"
 * favors a graphic or generated clip wherever the catalog fits. The Director
 * reads it as steering; revisions inherit it.
 */
export const visualDensitySchema = z.enum(["minimal", "balanced", "rich"]);
export const planSchema = z.strictObject({
  schemaVersion: z.literal("4.3.0"),
  id: identifier,
  projectId: identifier,
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  scriptVersion: z.number().int().positive(),
  transcriptHash: z.string().regex(/^[a-f0-9]{64}$/),
  frameRate: z.union([z.literal(24), z.literal(25), z.literal(30)]),
  resolution: z.strictObject({
    width: z.number().int().min(320).max(3840),
    height: z.number().int().min(180).max(2160),
  }),
  durationFrames: z.number().int().positive().max(324000),
  director: z.strictObject({
    provider: z.string().max(80),
    model: z.string().max(100),
    summary: z.string().max(2000),
  }),
  scenes: z.array(sceneSchema).min(1).max(500),
  /** Density the plan was directed at; drives revisions and the UI display. */
  visualDensity: visualDensitySchema.default("balanced"),
  audioDesign: audioDesignSchema.default({ music: null, sfx: [] }),
  scriptCoverage: scriptCoverageSchema.nullable().default(null),
});
export type ProductionPlan = z.infer<typeof planSchema>;
export type Scene = z.infer<typeof sceneSchema>;
export type Graphic = z.infer<typeof graphicSchema>;
export type TemplateName = Graphic["template"];
export const planJSONSchema = z.toJSONSchema(planSchema, { target: "draft-7" });

/** Upgrade older plan schemas so existing libraries keep opening. */
export function migratePlan(input: unknown): unknown {
  const plan = input as {
    schemaVersion?: unknown;
    scenes?: unknown;
  };
  if (!Array.isArray(plan.scenes)) return input;
  if (plan.schemaVersion === "1.0.0") {
    const scenes = plan.scenes.map((scene) => {
      if (
        typeof scene === "object" &&
        scene !== null &&
        !("chapterTitle" in scene)
      )
        (scene as { chapterTitle?: unknown }).chapterTitle = null;
      if (
        typeof scene !== "object" ||
        scene === null ||
        (scene as { visual?: { graphic?: unknown } }).visual?.graphic == null ||
        typeof (scene as { visual: { graphic: unknown } }).visual.graphic !==
          "object"
      )
        return scene;
      const s = scene as {
        visual: {
          graphic: {
            template: string;
            parameters: Record<string, unknown>;
          } & Record<string, unknown>;
        };
      };
      const p = s.visual.graphic.parameters ?? {};
      if (s.visual.graphic.template === "ArchitectureFlow") {
        s.visual.graphic.parameters = {
          title: p.title ?? "",
          subtitle: p.subtitle ?? "",
          nodes: Array.isArray(p.nodes) ? p.nodes.slice(0, 6) : [],
          emphasis: typeof p.emphasis === "number" ? p.emphasis : -1,
        };
      } else {
        s.visual.graphic.parameters = {
          title: p.title ?? "",
          subtitle: p.subtitle ?? "",
        };
      }
      return s;
    });
    return migratePlan({ ...plan, schemaVersion: "2.0.0", scenes });
  }
  if (plan.schemaVersion === "2.0.0")
    // Older v2 libraries omitted chapterTitle on non-chapter scenes. Normalize
    // a copy so reading an approved plan never rewrites its persisted content.
    // Scene broll and plan audioDesign are filled by schema defaults on parse.
    return migratePlan({
      ...plan,
      schemaVersion: "3.0.0",
      scenes: plan.scenes.map((scene) =>
        typeof scene === "object" &&
        scene !== null &&
        !("chapterTitle" in scene)
          ? { ...scene, chapterTitle: null }
          : scene,
      ),
    });
  if (plan.schemaVersion === "3.0.0")
    // v4 adds review metadata only; per-scene selection and plan
    // scriptCoverage are filled by schema defaults on parse.
    return migratePlan({ ...plan, schemaVersion: "4.0.0" });
  if (plan.schemaVersion === "4.0.0")
    // v4.1 adds per-scene music intensity; filled by the schema default.
    return migratePlan({ ...plan, schemaVersion: "4.1.0" });
  if (plan.schemaVersion === "4.1.0")
    // v4.2 makes the music bed's source explicit; existing beds are library
    // tracks, and generated beds carry a brief instead of a trackId.
    return migratePlan({
      ...plan,
      schemaVersion: "4.2.0",
      audioDesign: {
        sfx: [],
        ...(plan as { audioDesign?: { sfx?: unknown[] } }).audioDesign,
        music:
          (plan as { audioDesign?: { music?: unknown } }).audioDesign?.music ==
          null
            ? null
            : {
                source: "library",
                ...(plan as { audioDesign: { music: object } }).audioDesign
                  .music,
              },
      },
    });
  if (plan.schemaVersion === "4.2.0")
    // v4.3 records the visual density the plan was directed at; filled by the
    // schema default.
    return migratePlan({ ...plan, schemaVersion: "4.3.0" });
  return input;
}

/**
 * Repair director bookkeeping without touching editorial content: scene start
 * frames are recomputed cumulatively and the plan duration becomes their sum.
 * Models (and humans) routinely mis-total long timelines; content checks stay
 * strict afterwards.
 */
export function normalizePlan(input: unknown): unknown {
  const plan = input as {
    scenes?: { durationFrames?: unknown }[];
    durationFrames?: unknown;
  };
  if (!Array.isArray(plan.scenes)) return input;
  let cursor = 0;
  const scenes = plan.scenes.map((scene) => {
    const duration =
      typeof scene.durationFrames === "number" &&
      Number.isFinite(scene.durationFrames)
        ? Math.max(1, Math.round(scene.durationFrames))
        : 1;
    const next = { ...scene, startFrame: cursor, durationFrames: duration };
    cursor += duration;
    return next;
  });
  return { ...plan, scenes, durationFrames: cursor };
}

export function validatePlan(input: unknown): ProductionPlan {
  const plan = planSchema.parse(
    input instanceof Object && "schemaVersion" in input && input.schemaVersion
      ? migratePlan(input)
      : input,
  );
  let cursor = 0;
  const ids = new Set<string>();
  for (const scene of plan.scenes) {
    if (ids.has(scene.id))
      throw new StudioError("INVALID_PLAN", `Duplicate scene ID: ${scene.id}`);
    ids.add(scene.id);
    if (scene.startFrame !== cursor)
      throw new StudioError(
        "INVALID_PLAN",
        `${scene.id}: scenes must cover the timeline contiguously. Expected frame ${cursor}.`,
      );
    if ((scene.visual.type === "graphic") !== (scene.visual.graphic !== null))
      throw new StudioError(
        "INVALID_PLAN",
        `${scene.id}: graphic/type mismatch.`,
      );
    const g = scene.visual.graphic;
    if (g?.template === "ArchitectureFlow" && g.parameters.nodes.length < 2)
      throw new StudioError(
        "INVALID_PLAN",
        `${scene.id}: ArchitectureFlow needs 2–6 nodes.`,
      );
    if (
      g?.template === "ArchitectureFlow" &&
      g.parameters.emphasis >= g.parameters.nodes.length &&
      g.parameters.emphasis !== -1
    )
      throw new StudioError(
        "INVALID_PLAN",
        `${scene.id}: emphasis points outside nodes.`,
      );
    if (
      g?.template === "ArchitectureDiagram" &&
      g.parameters.failedLayer >= g.parameters.layers.length &&
      g.parameters.failedLayer !== -1
    )
      throw new StudioError(
        "INVALID_PLAN",
        `${scene.id}: failedLayer points outside layers.`,
      );
    if (
      g?.template === "RequestFlow" &&
      g.parameters.failureStep >= g.parameters.steps.length &&
      g.parameters.failureStep !== -1
    )
      throw new StudioError(
        "INVALID_PLAN",
        `${scene.id}: failureStep points outside steps.`,
      );
    if (
      g?.template === "CodeReveal" &&
      g.parameters.highlight >= g.parameters.lines.length &&
      g.parameters.highlight !== -1
    )
      throw new StudioError(
        "INVALID_PLAN",
        `${scene.id}: highlight points outside lines.`,
      );
    if (
      g?.template === "FailureAnimation" &&
      g.parameters.failedNode >= g.parameters.nodes.length
    )
      throw new StudioError(
        "INVALID_PLAN",
        `${scene.id}: failedNode points outside nodes.`,
      );
    if (scene.broll.some((b) => b.placement === "fullframe")) {
      // Full-frame B-roll replaces the presenter; it cannot stack on a
      // full-frame graphic or share the scene with another entry.
      if (scene.visual.type === "graphic" || scene.broll.length !== 1)
        throw new StudioError(
          "INVALID_PLAN",
          `${scene.id}: full-frame B-roll must be the scene's only visual.`,
        );
    }
    const brollIds = new Set<string>();
    let brollEnd = 0;
    for (const b of [...scene.broll].sort(
      (x, y) => x.startFrame - y.startFrame,
    )) {
      if (brollIds.has(b.id))
        throw new StudioError(
          "INVALID_PLAN",
          `${scene.id}: duplicate B-roll ID ${b.id}.`,
        );
      brollIds.add(b.id);
      if (b.startFrame + b.durationFrames > scene.durationFrames)
        throw new StudioError(
          "INVALID_PLAN",
          `${scene.id}/${b.id}: B-roll escapes its scene.`,
        );
      if (b.startFrame < brollEnd)
        throw new StudioError(
          "INVALID_PLAN",
          `${scene.id}/${b.id}: B-roll entries overlap.`,
        );
      brollEnd = b.startFrame + b.durationFrames;
      if ((b.placement === "inset") !== (b.inset !== null))
        throw new StudioError(
          "INVALID_PLAN",
          `${scene.id}/${b.id}: insets need a rectangle; full-frame must not have one.`,
        );
      if (b.inset && b.inset.x + b.inset.width > 1.001)
        throw new StudioError(
          "INVALID_PLAN",
          `${scene.id}/${b.id}: inset rectangle escapes the frame.`,
        );
      if (b.inset) {
        const heightRatio =
          (b.inset.width * plan.resolution.width * BROLL_INSET_HEIGHT_RATIO) /
          plan.resolution.height;
        if (b.inset.y + heightRatio > 1.001)
          throw new StudioError(
            "INVALID_PLAN",
            `${scene.id}/${b.id}: inset rectangle escapes the bottom of the frame.`,
          );
      }
    }
    cursor += scene.durationFrames;
  }
  if (cursor !== plan.durationFrames)
    throw new StudioError(
      "INVALID_PLAN",
      "Scene durations must equal plan duration.",
    );
  const sfxIds = new Set<string>();
  for (const s of plan.audioDesign.sfx) {
    if (sfxIds.has(s.id))
      throw new StudioError("INVALID_PLAN", `Duplicate SFX ID: ${s.id}.`);
    sfxIds.add(s.id);
    if (s.atFrame > plan.durationFrames - 12)
      throw new StudioError(
        "INVALID_PLAN",
        `${s.id}: SFX lands too close to the end of the timeline.`,
      );
  }
  if (plan.resolution.width % 2 || plan.resolution.height % 2)
    throw new StudioError("INVALID_PLAN", "H.264 dimensions must be even.");
  return plan;
}

/**
 * Audio design references the creator-managed media library, or — for
 * generated beds — a configured music engine. Every reference must resolve
 * before a plan can build (ADR 007 capability rule).
 */
export function validateAudioDesign(
  plan: ProductionPlan,
  tracks: { trackId: string; kind: "music" | "sfx"; duration: number }[],
  options: { musicGeneration?: boolean } = {},
) {
  const byId = new Map(tracks.map((t) => [t.trackId, t]));
  const music = plan.audioDesign.music;
  if (music) {
    if (music.source === "generated") {
      if (!options.musicGeneration)
        throw new StudioError(
          "UNSUPPORTED",
          "The music bed is generated, but no music generation engine is configured.",
          "Choose a Music provider in Settings (or --music), or re-run the visual pass against the library.",
        );
    } else {
      const track = byId.get(music.trackId);
      if (!track || track.kind !== "music")
        throw new StudioError(
          "INVALID_PLAN",
          `Music track ${music.trackId} is not in the library.`,
          "Add the track to the library manifest or remove the music bed.",
        );
      if (music.fadeInSec + music.fadeOutSec >= track.duration)
        throw new StudioError(
          "INVALID_PLAN",
          "Music fades are longer than the track.",
        );
    }
  }
  for (const s of plan.audioDesign.sfx) {
    const track = byId.get(s.trackId);
    if (!track || track.kind !== "sfx")
      throw new StudioError(
        "INVALID_PLAN",
        `SFX track ${s.trackId} is not in the library.`,
        "Add the track to the library manifest or remove the event.",
      );
  }
}

/**
 * Scenes select sub-ranges of recordings: takes may be skipped, reused out of
 * import order, or trimmed. Every referenced range must stay inside its
 * recording, use that recording's own transcript, actually contain the speech
 * the narration claims, and never present the same source frames twice.
 */
export interface SourceTranscript {
  recordingId: string;
  segments: { id: string; start: number; end: number; text: string }[];
}

/** Resolve generated provenance from the selected footage, not model-written
 * IDs. This changes references only; source ranges and narration still have to
 * pass validateSources. Explicitly imported plans keep their strict validation.
 */
export function bindTranscriptSegments(
  plan: ProductionPlan,
  transcripts: SourceTranscript[],
): ProductionPlan {
  const latest = new Map(transcripts.map((t) => [t.recordingId, t]));
  return {
    ...plan,
    scenes: plan.scenes.map((scene) => {
      const transcript = latest.get(scene.camera.recordingId);
      if (!transcript) return scene; // validateSources reports the missing source.
      const start = scene.sourceInFrame / plan.frameRate;
      const end = (scene.sourceInFrame + scene.durationFrames) / plan.frameRate;
      return {
        ...scene,
        transcriptSegmentIds: transcript.segments
          .filter((s) => s.start < end && s.end > start)
          .map((s) => s.id),
      };
    }),
  };
}
// Alignment pads matched spans by a fraction of a second; segments may
// legitimately straddle the selected range by that much.
const SEGMENT_RANGE_TOLERANCE_SEC = 0.5;
const NARRATION_PAD_SEC = 0.35;
// Share of narration words that must be spoken inside the selected range.
// Paraphrase stays valid; claiming absent sentences does not.
const NARRATION_CONTAINMENT = 0.4;
const wordTokens = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((t) => t.length > 0);

export function validateSources(
  plan: ProductionPlan,
  recordings: { id: string; duration: number }[],
  transcripts: SourceTranscript[],
) {
  // Later transcripts win, so retried or superseded imports stay valid.
  const latestByRecording = new Map<string, SourceTranscript>();
  for (const t of transcripts) latestByRecording.set(t.recordingId, t);
  const selected = new Map<
    string,
    { sceneId: string; start: number; end: number }[]
  >();
  for (const scene of plan.scenes) {
    const recording = recordings.find((r) => r.id === scene.camera.recordingId);
    if (!recording)
      throw new StudioError(
        "INVALID_PLAN",
        `${scene.id}: references an unknown recording.`,
      );
    const range = selected.get(recording.id) ?? [];
    range.push({
      sceneId: scene.id,
      start: scene.sourceInFrame,
      end: scene.sourceInFrame + scene.durationFrames,
    });
    selected.set(recording.id, range);
    if (
      scene.sourceInFrame + scene.durationFrames >
      Math.floor(recording.duration * plan.frameRate)
    )
      throw new StudioError(
        "INVALID_PLAN",
        `${scene.id}: source range exceeds its recording.`,
      );
    const transcript = latestByRecording.get(recording.id);
    if (!transcript)
      throw new StudioError(
        "INVALID_PLAN",
        `Recording ${recording.id} has no transcript.`,
      );
    const byId = new Map(transcript.segments.map((s) => [s.id, s]));
    if (scene.transcriptSegmentIds.some((id) => !byId.has(id)))
      throw new StudioError(
        "INVALID_PLAN",
        `${scene.id}: transcript segments must come from this scene's recording.`,
      );
    const startSec = scene.sourceInFrame / plan.frameRate;
    const endSec =
      (scene.sourceInFrame + scene.durationFrames) / plan.frameRate;
    for (const id of scene.transcriptSegmentIds) {
      const seg = byId.get(id)!;
      if (
        seg.end < startSec - SEGMENT_RANGE_TOLERANCE_SEC ||
        seg.start > endSec + SEGMENT_RANGE_TOLERANCE_SEC
      )
        throw new StudioError(
          "INVALID_PLAN",
          `${scene.id}: transcript segment ${id} lies outside the selected source range.`,
        );
    }
    // The narration describes speech, so prove the selected audio contains it.
    const narrationTokens = wordTokens(scene.narration);
    if (narrationTokens.length >= 8) {
      const spoken = new Map<string, number>();
      for (const seg of transcript.segments)
        if (
          seg.start < endSec + NARRATION_PAD_SEC &&
          seg.end > startSec - NARRATION_PAD_SEC
        )
          for (const token of wordTokens(seg.text))
            spoken.set(token, (spoken.get(token) ?? 0) + 1);
      let found = 0;
      for (const token of narrationTokens) {
        const count = spoken.get(token) ?? 0;
        if (count > 0) {
          found++;
          spoken.set(token, count - 1);
        }
      }
      if (found / narrationTokens.length < NARRATION_CONTAINMENT)
        throw new StudioError(
          "INVALID_PLAN",
          `${scene.id}: narration is not spoken inside the selected source range (${Math.round((found / narrationTokens.length) * 100)}% of words found).`,
          "Re-plan the scene, or edit its narration to match the selected take.",
        );
    }
  }
  for (const [recordingId, ranges] of selected) {
    ranges.sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 1; i < ranges.length; i++)
      if (ranges[i].start < ranges[i - 1].end)
        throw new StudioError(
          "INVALID_PLAN",
          `${ranges[i - 1].sceneId} and ${ranges[i].sceneId} replay the same source frames of recording ${recordingId}.`,
          "Trim one of the ranges or pick a different take before building.",
        );
  }
}

/** How much of each recording the plan actually keeps; powers QA and review. */
export function coverageSummary(
  plan: ProductionPlan,
  recordings: { id: string; name?: string; duration: number }[],
) {
  const per = new Map<string, number>();
  for (const s of plan.scenes)
    per.set(
      s.camera.recordingId,
      (per.get(s.camera.recordingId) || 0) + s.durationFrames / plan.frameRate,
    );
  return recordings.map((r) => ({
    recordingId: r.id,
    name: r.name ?? r.id,
    durationSeconds: r.duration,
    keptSeconds: per.get(r.id) || 0,
  }));
}
const opScene = { sceneId: identifier };
export const operationSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("replaceVisual"),
    ...opScene,
    visual: sceneSchema.shape.visual,
  }),
  z.strictObject({
    type: z.literal("updateFraming"),
    ...opScene,
    framing: sceneSchema.shape.camera.shape.framing,
    punchIn: sceneSchema.shape.camera.shape.punchIn,
  }),
  z.strictObject({
    type: z.literal("updateGraphicParameters"),
    ...opScene,
    parameters: z.unknown(),
  }),
  z.strictObject({
    type: z.literal("updateChapterTitle"),
    ...opScene,
    chapterTitle: z.string().min(1).max(120).nullable(),
  }),
  z.strictObject({ type: z.literal("removeGraphic"), ...opScene }),
  z.strictObject({
    type: z.literal("disableScene"),
    ...opScene,
    disabled: z.boolean(),
  }),
  z.strictObject({
    type: z.literal("updateTiming"),
    ...opScene,
    startFrame: frame,
    durationFrames: frame.min(1),
    sourceInFrame: frame,
  }),
  z.strictObject({
    type: z.literal("updateAudio"),
    ...opScene,
    gainDb: sceneSchema.shape.audio.shape.gainDb,
  }),
  z.strictObject({
    type: z.literal("updateMusicIntensity"),
    ...opScene,
    intensity: sceneSchema.shape.musicIntensity,
  }),
  z.strictObject({
    type: z.literal("splitScene"),
    ...opScene,
    atFrame: frame.min(1),
    newSceneId: identifier,
  }),
  z.strictObject({
    type: z.literal("mergeScenes"),
    ...opScene,
    nextSceneId: identifier,
  }),
  z.strictObject({
    type: z.literal("setBroll"),
    ...opScene,
    broll: z.array(brollEntrySchema).max(2),
  }),
  z.strictObject({
    type: z.literal("setAudioDesign"),
    audioDesign: audioDesignSchema,
  }),
]);
export const patchSchema = z.strictObject({
  id: identifier,
  createdAt: z.iso.datetime(),
  originatingRequest: z.string().min(1).max(10000),
  rationale: z.string().min(1).max(2000),
  /** Empty exactly when every operation is plan-level (e.g. setAudioDesign). */
  affectedScenes: z.array(identifier).max(500),
  previousVersion: z.number().int().positive(),
  resultingVersion: z.number().int().positive(),
  operations: z.array(operationSchema).min(1).max(100),
});
export type PlanPatch = z.infer<typeof patchSchema>;
export type Operation = z.infer<typeof operationSchema>;
export function applyPatch(
  previous: ProductionPlan,
  input: unknown,
): ProductionPlan {
  const patch = patchSchema.parse(input);
  if (
    patch.previousVersion !== previous.version ||
    patch.resultingVersion !== previous.version + 1
  )
    throw new StudioError(
      "CONFLICT",
      "Patch is stale; generate a proposal against the current plan.",
    );
  const expected = new Set(
    patch.operations.flatMap((op) =>
      op.type === "mergeScenes"
        ? [op.sceneId, op.nextSceneId]
        : op.type === "setAudioDesign"
          ? []
          : [op.sceneId],
    ),
  );
  if (
    expected.size !== new Set(patch.affectedScenes).size ||
    patch.affectedScenes.some((x) => !expected.has(x))
  )
    throw new StudioError(
      "INVALID_PLAN",
      "Affected scenes must exactly match patch operations.",
    );
  const next = structuredClone(previous);
  next.version = patch.resultingVersion;
  next.createdAt = patch.createdAt;
  for (const op of patch.operations) {
    if (op.type === "setAudioDesign") {
      next.audioDesign = structuredClone(op.audioDesign);
      continue;
    }
    const index = next.scenes.findIndex((s) => s.id === op.sceneId);
    if (index === -1)
      throw new StudioError("INVALID_PLAN", `Unknown scene ${op.sceneId}`);
    const s = next.scenes[index];
    switch (op.type) {
      case "replaceVisual":
        s.visual = structuredClone(op.visual);
        break;
      case "updateFraming":
        s.camera.framing = op.framing;
        s.camera.punchIn = op.punchIn;
        break;
      case "updateGraphicParameters": {
        if (!s.visual.graphic)
          throw new StudioError("INVALID_PLAN", "Scene has no graphic.");
        // Re-validate the whole graphic with the substituted parameters.
        const candidate = graphicSchema.parse({
          ...structuredClone(s.visual.graphic),
          parameters: structuredClone(op.parameters),
        });
        s.visual.graphic = candidate;
        break;
      }
      case "updateChapterTitle":
        s.chapterTitle = op.chapterTitle;
        break;
      case "removeGraphic":
        s.visual = {
          type: "presenter",
          description: "Presenter",
          graphic: null,
        };
        break;
      case "disableScene":
        s.enabled = !op.disabled;
        break;
      case "updateTiming":
        s.startFrame = op.startFrame;
        s.durationFrames = op.durationFrames;
        s.sourceInFrame = op.sourceInFrame;
        break;
      case "updateAudio":
        s.audio.gainDb = op.gainDb;
        break;
      case "updateMusicIntensity":
        s.musicIntensity = op.intensity;
        break;
      case "splitScene": {
        if (
          op.atFrame >= s.durationFrames ||
          next.scenes.some((s) => s.id === op.newSceneId)
        )
          throw new StudioError(
            "INVALID_PLAN",
            "Invalid split frame or duplicate new scene ID.",
          );
        const tail = structuredClone(s);
        tail.id = op.newSceneId;
        tail.startFrame = s.startFrame + op.atFrame;
        tail.sourceInFrame = s.sourceInFrame + op.atFrame;
        tail.durationFrames = s.durationFrames - op.atFrame;
        tail.chapterTitle = null;
        // Each B-roll entry belongs to the half that plays it; entries that
        // straddle the cut are trimmed to their side's remainder.
        tail.broll = s.broll
          .filter(
            (b) =>
              b.startFrame >= op.atFrame &&
              b.startFrame + 12 <= op.atFrame + tail.durationFrames,
          )
          .map((b) => ({ ...b, startFrame: b.startFrame - op.atFrame }));
        s.broll = s.broll
          .filter((b) => b.startFrame + 12 <= op.atFrame)
          .map((b) =>
            b.startFrame + b.durationFrames <= op.atFrame
              ? b
              : { ...b, durationFrames: op.atFrame - b.startFrame },
          );
        next.scenes.splice(index + 1, 0, tail);
        s.durationFrames = op.atFrame;
        break;
      }
      case "mergeScenes": {
        const following = next.scenes[index + 1];
        if (
          !following ||
          following.id !== op.nextSceneId ||
          s.camera.recordingId !== following.camera.recordingId ||
          s.sourceInFrame + s.durationFrames !== following.sourceInFrame
        )
          throw new StudioError(
            "INVALID_PLAN",
            "Merge requires adjacent, contiguous scenes from the same source.",
          );
        if (following.broll.length)
          throw new StudioError(
            "INVALID_PLAN",
            "Remove the second scene's B-roll before merging.",
          );
        s.durationFrames += following.durationFrames;
        s.narration += " " + following.narration;
        s.transcriptSegmentIds = [
          ...new Set([
            ...s.transcriptSegmentIds,
            ...following.transcriptSegmentIds,
          ]),
        ];
        following.chapterTitle = null;
        next.scenes.splice(index + 1, 1);
        break;
      }
      case "setBroll":
        s.broll = structuredClone(op.broll);
        break;
    }
  }
  return validatePlan(next);
}
/** Semantic render identity: editorial metadata and version numbers do not invalidate pixels. */
export function graphicKey(
  scene: Scene,
  plan: ProductionPlan,
  brand: unknown,
  templateSourceHash: string,
) {
  return hash({
    graphic: scene.visual.graphic,
    durationFrames: scene.durationFrames,
    frameRate: plan.frameRate,
    resolution: plan.resolution,
    brand,
    templateSourceHash,
    renderer: "remotion-4.0.525",
  });
}
