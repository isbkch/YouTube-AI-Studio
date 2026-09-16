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
      "title, subtitle, unit, series[3–24], threshold|null, goodDirection.",
  },
  {
    template: "FailureAnimation",
    when: "Cascading failure across 2–6 nodes, optionally with recovery.",
    parameters: "title, subtitle, nodes[2–6], failedNode, recovered.",
  },
] as const;

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
  audio: z.strictObject({ gainDb: z.number().min(-24).max(12) }),
  transition: z.literal("cut"),
  enabled: z.boolean(),
  rationale: z.string().max(1000),
  chapterTitle: z.string().min(1).max(120).nullable(),
});
export const planSchema = z.strictObject({
  schemaVersion: z.literal("2.0.0"),
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
});
export type ProductionPlan = z.infer<typeof planSchema>;
export type Scene = z.infer<typeof sceneSchema>;
export type Graphic = z.infer<typeof graphicSchema>;
export type TemplateName = Graphic["template"];
export const planJSONSchema = z.toJSONSchema(planSchema, { target: "draft-7" });

/** Upgrade MVP v1 plans to the catalog schema so older libraries keep opening. */
export function migratePlan(input: unknown): unknown {
  const plan = input as {
    schemaVersion?: unknown;
    scenes?: unknown;
  };
  if (plan?.schemaVersion !== "1.0.0" || !Array.isArray(plan.scenes))
    return input;
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
  return { ...plan, schemaVersion: "2.0.0", scenes };
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
    cursor += scene.durationFrames;
  }
  if (cursor !== plan.durationFrames)
    throw new StudioError(
      "INVALID_PLAN",
      "Scene durations must equal plan duration.",
    );
  if (plan.resolution.width % 2 || plan.resolution.height % 2)
    throw new StudioError("INVALID_PLAN", "H.264 dimensions must be even.");
  return plan;
}

/**
 * Scenes select sub-ranges of recordings: takes may be skipped, reused out of
 * import order, or trimmed. Every referenced range must stay inside its
 * recording and use that recording's own transcript.
 */
export function validateSources(
  plan: ProductionPlan,
  recordings: { id: string; duration: number }[],
  transcripts: { recordingId: string; segments: { id: string }[] }[],
) {
  // Later transcripts win, so retried or superseded imports stay valid.
  const latestByRecording = new Map<string, { segments: { id: string }[] }>();
  for (const t of transcripts) latestByRecording.set(t.recordingId, t);
  for (const scene of plan.scenes) {
    const recording = recordings.find((r) => r.id === scene.camera.recordingId);
    if (!recording)
      throw new StudioError(
        "INVALID_PLAN",
        `${scene.id}: references an unknown recording.`,
      );
    if (
      scene.sourceInFrame + scene.durationFrames >
      Math.floor(recording.duration * plan.frameRate) + 1
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
    if (
      scene.transcriptSegmentIds.some(
        (id) => !transcript.segments.some((s) => s.id === id),
      )
    )
      throw new StudioError(
        "INVALID_PLAN",
        `${scene.id}: transcript segments must come from this scene's recording.`,
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
]);
export const patchSchema = z.strictObject({
  id: identifier,
  createdAt: z.iso.datetime(),
  originatingRequest: z.string().min(1).max(10000),
  rationale: z.string().min(1).max(2000),
  affectedScenes: z.array(identifier).min(1),
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
      op.type === "mergeScenes" ? [op.sceneId, op.nextSceneId] : [op.sceneId],
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
