import { z } from "zod";
import { hash, StudioError } from "../../shared/src/index.ts";

const frame = z.number().int().nonnegative();
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/);
export const graphicSchema = z.strictObject({
  engine: z.literal("remotion"),
  template: z.enum(["Callout", "ArchitectureFlow", "ChapterTitle"]),
  templateVersion: z.literal("1.0.0"),
  parameters: z.strictObject({
    title: z.string().min(1).max(100),
    subtitle: z.string().max(180),
    nodes: z.array(z.string().min(1).max(24)).max(5),
    emphasis: z.number().int().min(-1).max(4),
  }),
});
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
});
export const planSchema = z.strictObject({
  schemaVersion: z.literal("1.0.0"),
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
export const planJSONSchema = z.toJSONSchema(planSchema, { target: "draft-7" });
export function validatePlan(input: unknown): ProductionPlan {
  const plan = planSchema.parse(input);
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
        `${scene.id}: ArchitectureFlow needs 2–5 nodes.`,
      );
    if (
      g &&
      g.parameters.emphasis >= g.parameters.nodes.length &&
      g.parameters.emphasis !== -1
    )
      throw new StudioError(
        "INVALID_PLAN",
        `${scene.id}: emphasis points outside nodes.`,
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
export function validateSources(
  plan: ProductionPlan,
  recordings: { id: string; duration: number }[],
  transcripts: { recordingId: string; segments: { id: string }[] }[],
) {
  const expectedOrder = recordings.map((r) => r.id);
  const sceneOrder = [...new Set(plan.scenes.map((s) => s.camera.recordingId))];
  if (
    !expectedOrder.length ||
    sceneOrder.length !== expectedOrder.length ||
    sceneOrder.some((id, i) => id !== expectedOrder[i])
  )
    throw new StudioError(
      "INVALID_PLAN",
      "Scenes must cover every imported recording exactly once, in import order, without interleaving recordings.",
    );
  // Later transcripts win, so retried or superseded imports stay valid.
  const latestByRecording = new Map<string, { segments: { id: string }[] }>();
  for (const t of transcripts) latestByRecording.set(t.recordingId, t);
  for (const scene of plan.scenes) {
    const recording = recordings.find(
      (r) => r.id === scene.camera.recordingId,
    )!;
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
    parameters: graphicSchema.shape.parameters,
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
        s.visual = op.visual;
        break;
      case "updateFraming":
        s.camera.framing = op.framing;
        s.camera.punchIn = op.punchIn;
        break;
      case "updateGraphicParameters":
        if (!s.visual.graphic)
          throw new StudioError("INVALID_PLAN", "Scene has no graphic.");
        s.visual.graphic.parameters = op.parameters;
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
        next.scenes.splice(index + 1, 0, {
          ...structuredClone(s),
          id: op.newSceneId,
          startFrame: s.startFrame + op.atFrame,
          sourceInFrame: s.sourceInFrame + op.atFrame,
          durationFrames: s.durationFrames - op.atFrame,
        });
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
