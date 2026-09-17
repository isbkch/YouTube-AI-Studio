import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Studio } from "../packages/orchestrator/src/studio.ts";
import { Store } from "../packages/orchestrator/src/store.ts";
import { youTubeCLI } from "../packages/orchestrator/src/youtube.ts";
import {
  MockAIProvider,
  PackagingAgent,
  chapterStamp,
  mockPackaging,
  planChapters,
  type AIProvider,
  type PackagingInput,
  type ProviderResult,
  type StructuredRequest,
} from "../packages/agents/src/index.ts";
import { executable, runBinary } from "../packages/media/src/index.ts";
import { fixture } from "./fixtures.ts";
import {
  validatePlan,
  type ProductionPlan,
} from "../packages/production-plan/src/index.ts";

async function temporary<T>(fn: (root: string, store: Store) => Promise<T>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wts-m5-"));
  const store = new Store(root);
  try {
    return await fn(root, store);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

/** Inline provider that replays a crafted output through the real schema. */
function stubProvider(output: () => unknown): AIProvider {
  return {
    name: "stub",
    async generateStructured<T>(
      request: StructuredRequest<T>,
    ): Promise<ProviderResult<T>> {
      return {
        output: request.schema.parse(output()),
        usage: {
          agent: request.name,
          provider: "stub",
          model: "stub-v1",
          inputTokens: 0,
          outputTokens: 0,
          audioSeconds: 0,
          imageCount: 0,
          costUSD: 0,
          elapsedMs: 0,
          createdAt: new Date().toISOString(),
        },
      };
    },
  };
}

function chapteredPlan(projectId: string): ProductionPlan {
  const plan = structuredClone(fixture());
  plan.projectId = projectId;
  const titles = ["The trap", "The failure", "The fix"];
  const spans: [number, number][] = [
    [0, 300],
    [300, 630],
    [630, 900],
  ];
  plan.scenes = spans.map(([start, end], i) => ({
    ...structuredClone(plan.scenes[0]),
    id: `scene-${i + 1}`,
    startFrame: start,
    durationFrames: end - start,
    chapterTitle: titles[i],
  }));
  plan.durationFrames = 900;
  return validatePlan(plan);
}

/** A project forced into READY_TO_RENDER with a finished render on disk. */
async function finishedProject(store: Store) {
  const p = store.create(
    "Not production ready",
    "AI has made generating software almost free, but owning it more expensive than ever",
    900,
  );
  const dir = store.dir(p);
  await mkdir(path.join(dir, "renders"), { recursive: true });
  await writeFile(
    path.join(dir, "renders", "final-v1-test.mp4"),
    "video-bytes",
  );
  const approval = {
    version: 1,
    hash: "a".repeat(64),
    approvedAt: new Date().toISOString(),
    approvedBy: "creator" as const,
  };
  store.update(p.id, (x) => {
    x.scripts = [
      {
        version: 1,
        text: "# Script\n\n## 0:00–0:30 — The trap\n",
        createdAt: new Date().toISOString(),
      },
    ];
    x.scriptApproval = approval;
    x.plans = [chapteredPlan(p.id)];
    x.planApproval = approval;
    x.roughCutApproval = approval;
    x.builds = [
      {
        planVersion: 1,
        previewPath: "renders/rough-cut-v1.mp4",
        timelinePath: "exports/timeline-v1.json",
        exportPath: "exports/final-v1.fcpxml",
        qaPath: "exports/qa-v1.json",
        completedAt: new Date().toISOString(),
      },
    ];
    x.finalRender = "renders/final-v1-test.mp4";
    x.status = "READY_TO_RENDER";
  });
  return store.get(p.id);
}

/** A fake youtubeuploader: records its argv and reports a video URL. */
async function stubCLI(dir: string) {
  const cli = path.join(dir, "youtubeuploader");
  const argsFile = path.join(dir, "argv.txt");
  await writeFile(
    cli,
    [
      "#!/bin/sh",
      'printf \'%s\\n\' "$@" > "$WTS_ARGS_FILE"',
      'echo "Success! Watch it: https://www.youtube.com/watch?v=dQw4w9WgXcQ"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  await chmod(cli, 0o755);
  return { cli, argsFile };
}

const packagingInput = (p: { id: string; title: string }): PackagingInput => ({
  projectId: p.id,
  videoTitle: p.title,
  thesis: "Generated code is cheap; owning it is not.",
  chapters: [
    { seconds: 0, title: "The trap" },
    { seconds: 10, title: "The failure" },
    { seconds: 21, title: "The fix" },
  ],
  finalSeconds: 30,
  sources: [
    { url: "https://sre.google/books/", title: "Site Reliability Engineering" },
  ],
  creator: {
    name: "iLyas",
    channel: "YouTube-AI-Studio",
    format: "Long-form technical YouTube essay",
    targetMinutes: [12, 18],
    subjects: ["cloud architecture"],
    brand: {
      background: "#101b29",
      foreground: "#f2f4ed",
      accent: "#c8ef80",
      fontFamily: "Helvetica Neue",
    },
    preferences: [],
  },
});

test("final render accepts persisted v2 chapter omissions and reports Resolve failures", async () =>
  temporary(async (root, store) => {
    const p = await finishedProject(store);
    const legacy = JSON.parse(JSON.stringify(p.plans[0]));
    legacy.schemaVersion = "2.0.0";
    delete legacy.scenes[1].chapterTitle;
    store.update(p.id, (x) => {
      x.plans = [legacy];
      x.finalRender = null;
    });
    const before = store.get(p.id);
    const app = path.join(root, "Resolve.app");
    const interpreter = path.join(app, "Contents/Applications/ResolvePython");
    await mkdir(path.dirname(interpreter), { recursive: true });
    await writeFile(
      interpreter,
      `#!${process.execPath}
import assert from "node:assert/strict";
assert.equal(process.argv[3], "render");
console.log('WTS_RESULT:' + JSON.stringify({available: false, reason: 'Render preset not found: H.264 Master'}));
`,
      { mode: 0o755 },
    );
    const oldApp = process.env.WTS_RESOLVE_APP;
    process.env.WTS_RESOLVE_APP = app;
    try {
      await assert.rejects(
        new Studio(store).renderFinal(p.id),
        /Render preset not found: H.264 Master/,
      );
      const after = store.get(p.id);
      assert.deepEqual(after.plans, before.plans);
      assert.deepEqual(after.planApproval, before.planApproval);
      assert.deepEqual(after.roughCutApproval, before.roughCutApproval);
      assert.equal(after.finalRender, null);
      assert.equal(after.status, "READY_TO_RENDER");
      assert.equal(store.jobs(p.id).at(-1)!.status, "FAILED");
    } finally {
      if (oldApp === undefined) delete process.env.WTS_RESOLVE_APP;
      else process.env.WTS_RESOLVE_APP = oldApp;
    }
  }));

test("packaging walks a final render to YouTube publication through the local CLI", async () =>
  temporary(async (root, store) => {
    const { cli, argsFile } = await stubCLI(root);
    const before = { ...process.env };
    process.env.WTS_YOUTUBEUPLOADER_PATH = cli;
    process.env.WTS_ARGS_FILE = argsFile;
    try {
      const p = await finishedProject(store);
      const studio = new Studio(store);

      const result = await studio.packageVideo(p.id);
      assert.equal(result.snapshot.status, "AWAITING_PUBLISH_APPROVAL");
      assert.equal(result.snapshot.packaging?.version, 1);
      const title =
        result.packaging.titleCandidates[result.packaging.recommendedTitleIndex]
          .title;
      assert.ok(title.length > 0 && title.length <= 100);
      assert.ok(result.description.includes("CHAPTERS"));
      assert.ok(result.description.includes("0:00 The trap"));
      assert.ok(result.description.includes("0:10 The failure"));
      assert.ok(
        existsSync(
          path.join(root, "projects", p.slug, "packaging", "packaging-v1.json"),
        ),
      );
      assert.ok(result.snapshot.usage.at(-1)!.costUSD === 0);

      await assert.rejects(
        studio.approvePackaging(p.id, 2),
        /Review the current packaging version/,
      );
      const approved = await studio.approvePackaging(p.id, 1);
      assert.equal(approved.publishApproval?.version, 1);

      const published = await studio.publish(p.id);
      assert.equal(published.status, "PUBLISHED");
      assert.equal(published.publication?.videoId, "dQw4w9WgXcQ");
      assert.equal(
        published.publication?.url,
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      );
      const argv = readFile(argsFile, "utf8").then((t) => t.split("\n"));
      assert.ok((await argv).includes("-filename"));
      assert.ok((await argv).includes("-metaJSON"));
      const meta = JSON.parse(
        await readFile(
          path.join(
            root,
            "projects",
            p.slug,
            "packaging",
            "upload-meta-v1.json",
          ),
          "utf8",
        ),
      );
      assert.equal(meta.title, title);
      assert.equal(meta.privacyStatus, "private");
      assert.ok(meta.description.includes("0:00 The trap"));

      await assert.rejects(studio.publish(p.id), /already published/);
    } finally {
      process.env.WTS_YOUTUBEUPLOADER_PATH = before.WTS_YOUTUBEUPLOADER_PATH;
      process.env.WTS_ARGS_FILE = before.WTS_ARGS_FILE;
      if (before.WTS_YOUTUBEUPLOADER_PATH === undefined)
        delete process.env.WTS_YOUTUBEUPLOADER_PATH;
      if (before.WTS_ARGS_FILE === undefined) delete process.env.WTS_ARGS_FILE;
    }
  }));

test("publishing stays gated, one-shot and tamper-evident", async () =>
  temporary(async (root, store) => {
    const { cli } = await stubCLI(root);
    const before = { ...process.env };
    process.env.WTS_YOUTUBEUPLOADER_PATH = cli;
    process.env.WTS_ARGS_FILE = path.join(root, "argv.txt");
    try {
      const p = await finishedProject(store);
      const studio = new Studio(store);

      await assert.rejects(
        studio.approvePackaging(p.id, 1),
        /Review the current packaging version/,
      );
      await assert.rejects(
        studio.publish(p.id),
        /Publishing follows an approved packaging/,
      );
      store.update(p.id, (x) => {
        x.status = "MEDIA_IMPORTED";
        x.finalRender = null;
      });
      await assert.rejects(
        studio.packageVideo(p.id),
        /Packaging needs a completed final render/,
      );

      const ready = await finishedProject(store);
      await studio.packageVideo(ready.id);
      await studio.approvePackaging(ready.id, 1);
      // Re-packaging invalidates the approval.
      await studio.packageVideo(ready.id);
      const repackaged = store.get(ready.id);
      assert.equal(repackaged.publishApproval, null);
      assert.equal(repackaged.packaging?.version, 2);
      await studio.approvePackaging(ready.id, 2);
      // Tampering with the approved document on disk blocks the upload.
      const docPath = path.join(
        root,
        "projects",
        ready.slug,
        "packaging",
        "packaging-v2.json",
      );
      const doc = JSON.parse(await readFile(docPath, "utf8"));
      doc.titleCandidates[doc.recommendedTitleIndex].title = "CLICKBAIT NOW";
      await writeFile(docPath, JSON.stringify(doc, null, 2));
      await assert.rejects(studio.publish(ready.id), /changed after approval/);
      assert.equal(store.get(ready.id).status, "AWAITING_PUBLISH_APPROVAL");

      if (
        !(await youTubeCLI().then(
          () => true,
          () => false,
        ))
      ) {
        delete process.env.WTS_YOUTUBEUPLOADER_PATH;
        await assert.rejects(
          studio.publish(ready.id),
          /youtubeuploader was not found/,
        );
        assert.equal(store.get(ready.id).status, "AWAITING_PUBLISH_APPROVAL");
      }
    } finally {
      process.env.WTS_YOUTUBEUPLOADER_PATH = before.WTS_YOUTUBEUPLOADER_PATH;
      process.env.WTS_ARGS_FILE = before.WTS_ARGS_FILE;
      if (before.WTS_YOUTUBEUPLOADER_PATH === undefined)
        delete process.env.WTS_YOUTUBEUPLOADER_PATH;
      if (before.WTS_ARGS_FILE === undefined) delete process.env.WTS_ARGS_FILE;
    }
  }));

test("the packaging agent validates against the fixed rendered timeline", async () =>
  temporary(async (_, store) => {
    const p = store.create(
      "Validation",
      "An idea about recovery objectives",
      600,
    );
    const input = packagingInput(p);
    const ok = await new PackagingAgent(new MockAIProvider()).package(input);
    assert.equal(ok.usage.provider, "mock");

    const retimed = structuredClone(mockPackaging(input));
    retimed.chapters[1].seconds = 11;
    await assert.rejects(
      new PackagingAgent(stubProvider(() => retimed)).package(input),
      /match the rendered timeline/,
    );

    const misrecommended = structuredClone(mockPackaging(input));
    misrecommended.recommendedTitleIndex = 9;
    await assert.rejects(
      new PackagingAgent(stubProvider(() => misrecommended)).package(input),
      /recommendation must point/,
    );

    const noisyTags = structuredClone(mockPackaging(input));
    noisyTags.metadata.tags = Array.from(
      { length: 20 },
      (_, i) => `tag-${String(i).padStart(24, "x")}`,
    );
    await assert.rejects(
      new PackagingAgent(stubProvider(() => noisyTags)).package(input),
      /Tags total/,
    );

    const thin = structuredClone(mockPackaging(input));
    thin.description.opening = "Short.";
    thin.description.body = [];
    thin.description.sources = [];
    await assert.rejects(
      new PackagingAgent(stubProvider(() => thin)).package(input),
      /between 80 and 5000/,
    );
  }));

test("planChapters and chapterStamp follow YouTube's chapter rules", async () =>
  temporary(async (_, store) => {
    const p = store.create("Chapters", "An idea about chapter markers", 600);
    const plan = chapteredPlan(p.id);
    assert.deepEqual(planChapters(plan), [
      { seconds: 0, title: "The trap" },
      { seconds: 10, title: "The failure" },
      { seconds: 21, title: "The fix" },
    ]);

    // First marker past 0:00 gains an Intro; markers under 10s apart are dropped.
    const late = validatePlan(structuredClone(plan));
    const starts = [360, 660, 810];
    late.scenes = starts.map((start, i) => ({
      ...structuredClone(plan.scenes[i]),
      startFrame: start,
      durationFrames: (i === 2 ? 900 : starts[i + 1]) - start,
    }));
    assert.deepEqual(
      planChapters(late).map((c) => c.seconds),
      [0, 12, 22],
    );
    assert.equal(planChapters(late)[0].title, "Intro");

    assert.equal(chapterStamp(0), "0:00");
    assert.equal(chapterStamp(860), "14:20");
    assert.equal(chapterStamp(3723), "1:02:03");
  }));

test("rough-cut approval starts the autonomous final render with an FFmpeg fallback", async () =>
  temporary(async (root, store) => {
    const p = await finishedProject(store);
    // A real decodable preview: the fallback delivers these verified bytes.
    const preview = path.join(store.dir(p), "renders/rough-cut-v1.mp4");
    const duration = validatePlan(p.plans[0]).durationFrames / 30;
    const ffmpeg = await executable("ffmpeg");
    await runBinary(ffmpeg, [
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=128x80:r=30",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=48000:cl=stereo",
      "-t",
      String(duration),
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-c:a",
      "aac",
      "-y",
      preview,
    ]);
    store.update(p.id, (x) => {
      x.roughCutApproval = null;
      x.finalRender = null;
      x.finalRenderEngine = null;
      x.status = "AWAITING_ROUGH_CUT_APPROVAL";
    });
    // Point Resolve at a path with no scripting interpreter: autonomous
    // finishing must still deliver a verified final through FFmpeg.
    const oldApp = process.env.WTS_RESOLVE_APP;
    process.env.WTS_RESOLVE_APP = path.join(root, "Missing Resolve.app");
    try {
      const studio = new Studio(store);
      const approved = await studio.approveRoughCut(p.id, 1);
      assert.equal(approved.status, "READY_TO_RENDER");
      for (let i = 0; i < 150 && !store.get(p.id).finalRender; i++)
        await new Promise((r) => setTimeout(r, 100));
      const after = store.get(p.id);
      assert.equal(after.finalRender, "renders/final-v1-ffmpeg.mp4");
      assert.equal(after.finalRenderEngine, "ffmpeg");
      assert.ok(existsSync(path.join(store.dir(after), after.finalRender)));
    } finally {
      if (oldApp === undefined) delete process.env.WTS_RESOLVE_APP;
      else process.env.WTS_RESOLVE_APP = oldApp;
    }
  }));
