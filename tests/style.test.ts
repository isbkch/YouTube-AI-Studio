import { test } from "node:test";
import assert from "node:assert/strict";
import { styleProfile } from "../packages/orchestrator/src/style.ts";
import type {
  Project,
  ProducerReview,
} from "../packages/orchestrator/src/model.ts";
import { fixture } from "./fixtures.ts";
import type { PlanPatch } from "../packages/production-plan/src/index.ts";
import { now } from "../packages/shared/src/index.ts";

const patch = (operations: Record<string, unknown>[]): PlanPatch => ({
  id: `patch-${Math.random().toString(36).slice(2)}`,
  createdAt: now(),
  originatingRequest: "Range revision (test)",
  rationale: "test",
  affectedScenes: operations.flatMap((o) =>
    "sceneId" in o ? [o.sceneId as string] : [],
  ),
  previousVersion: 1,
  resultingVersion: 2,
  operations: operations as PlanPatch["operations"],
});

const project = (overrides: Partial<Project> = {}): Project =>
  ({
    ...{
      schemaVersion: "1.0.0",
      id: "p1",
      title: "Style",
      slug: "style",
      description: "",
      status: "AWAITING_STORYBOARD_APPROVAL",
      createdAt: now(),
      updatedAt: now(),
      targetDuration: 300,
      autonomy: "supervised",
      producerReviews: [] as ProducerReview[],
      creator: { name: "C" },
      research: { notes: "", sources: [] },
      outline: [],
      preproduction: {
        researchVersion: null,
        narrativeVersion: null,
        scriptDocVersion: null,
        previsualization: null,
      },
      packaging: { version: null },
      scripts: [],
      scriptApproval: null,
      recordings: [],
      transcripts: [],
      plans: [fixture()],
      planApproval: null,
      roughCutApproval: null,
      revisions: [],
      builds: [],
      finalRender: null,
      finalRenderEngine: null,
      resolveMarkers: [],
      publication: null,
      publishApproval: null,
      usage: [],
    },
    ...overrides,
  }) as Project;

test("an empty history says nothing", () => {
  const profile = styleProfile([]);
  assert.deepEqual(profile.notes, []);
  assert.equal(profile.evidence.projects, 0);
});

test("creator-stripped visual treatments steer the Director presenter-led", () => {
  const p = project({
    revisions: [
      {
        patch: patch([
          { type: "disableScene", sceneId: "scene-1", disabled: true },
        ]),
        status: "APPLIED",
        decidedAt: now(),
        decidedBy: "creator",
      },
      {
        patch: patch([{ type: "removeGraphic", sceneId: "scene-1" }]),
        status: "APPLIED",
        decidedAt: now(),
        decidedBy: "creator",
      },
    ],
  });
  const profile = styleProfile([p]);
  assert.equal(profile.evidence.visualTreatmentsStripped, 2);
  assert.equal(profile.notes.length, 1);
  assert.match(profile.notes[0], /stripped visual treatments from 2 scenes/);
});

test("Producer-made decisions never count as the creator's taste", () => {
  const p = project({
    revisions: [
      {
        patch: {
          ...patch([
            { type: "disableScene", sceneId: "scene-1", disabled: true },
          ]),
          originatingRequest: "Producer auto-repair (deterministic-v2)",
        },
        status: "APPLIED",
        decidedAt: now(),
        decidedBy: "producer",
      },
      {
        // A producer-applied visual pass is also not taste evidence.
        patch: {
          ...patch([{ type: "setBroll", sceneId: "scene-1", broll: [] }]),
          originatingRequest: "Visual direction pass (mock/mock)",
        },
        status: "APPLIED",
        decidedAt: now(),
        decidedBy: "producer",
      },
    ],
  });
  const profile = styleProfile([p]);
  assert.equal(profile.evidence.creatorAppliedPatches, 0);
  assert.equal(profile.evidence.visualTreatmentsStripped, 0);
  assert.deepEqual(profile.notes, []);
});

test("tightening re-directs across plan history become a pacing lesson", () => {
  const escalated = project({
    plans: [
      fixture(),
      { ...fixture(), version: 2, silenceTightening: "tight" },
    ],
  });
  const twice = project({
    plans: [
      fixture(),
      { ...fixture(), version: 2, silenceTightening: "tight" },
      { ...fixture(), version: 3, silenceTightening: "punchy" },
    ],
  });
  assert.equal(styleProfile([escalated]).notes.length, 0);
  const profile = styleProfile([twice]);
  assert.equal(profile.evidence.tighteningReDirects, 2);
  assert.match(profile.notes[0], /re-directed tighter/);
});

test("consistent density overrides across published videos become a preference", () => {
  const published = (
    density: "minimal" | "rich",
    persona: "purist" | "showman",
  ) =>
    project({
      publication: {
        videoId: "v",
        url: "https://youtu.be/v",
        publishedAt: now(),
      },
      plans: [
        {
          ...fixture(),
          visualDensity: density,
          directorPersona: persona,
        },
      ],
    });
  // Two published overrides to minimal against purist's own "minimal" is no
  // override at all — no note.
  assert.deepEqual(
    styleProfile([
      published("minimal", "purist"),
      published("minimal", "purist"),
    ]).notes,
    [],
  );
  // Overrides away from each director's default, consistently minimal, do note.
  const profile = styleProfile([
    published("minimal", "showman"),
    published("minimal", "showman"),
  ]);
  assert.equal(profile.evidence.published, 2);
  assert.equal(profile.notes.length, 1);
  assert.match(
    profile.notes[0],
    /overrode its director's density default to "minimal"/,
  );
  // Mixed overrides say nothing.
  assert.deepEqual(
    styleProfile([published("minimal", "showman"), published("rich", "purist")])
      .notes,
    [],
  );
});
