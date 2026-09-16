import { hash } from "../packages/shared/src/index.ts";
import type { ProductionPlan } from "../packages/production-plan/src/index.ts";
export function fixture(): ProductionPlan {
  return {
    schemaVersion: "2.0.0",
    id: "plan-1",
    projectId: "project-1",
    version: 1,
    createdAt: new Date().toISOString(),
    scriptVersion: 1,
    transcriptHash: hash("transcript"),
    frameRate: 30,
    resolution: { width: 1920, height: 1080 },
    durationFrames: 90,
    director: { provider: "mock", model: "fixture", summary: "Simple." },
    scenes: [
      {
        id: "scene-1",
        startFrame: 0,
        durationFrames: 90,
        sourceInFrame: 0,
        narration: "Hello",
        transcriptSegmentIds: [],
        camera: { recordingId: "recording-1", framing: "medium", punchIn: 1 },
        visual: { type: "presenter", description: "Presenter", graphic: null },
        audio: { gainDb: 0 },
        transition: "cut",
        enabled: true,
        rationale: "Give this thought room.",
        chapterTitle: null,
      },
    ],
  };
}
