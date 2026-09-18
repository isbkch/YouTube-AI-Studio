import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Store } from "../packages/orchestrator/src/store.ts";
import { Studio } from "../packages/orchestrator/src/studio.ts";
import { channelCLI } from "../packages/orchestrator/src/analytics/cli.ts";
import { AnalyticsService } from "../packages/orchestrator/src/analytics/service.ts";
import {
  AnalyticsOAuth,
  type Vault,
} from "../packages/orchestrator/src/analytics/oauth.ts";
import { YouTubeAnalyticsClient } from "../packages/orchestrator/src/analytics/youtube.ts";
import {
  parseCSV,
  previewCSV,
} from "../packages/orchestrator/src/analytics/csv.ts";
import {
  addDays,
  channelSchema,
  outcomeSchema,
  pacificDate,
  reviewSchema,
  strategySchema,
  type Video,
} from "../packages/orchestrator/src/analytics/model.ts";
import {
  MockAIProvider,
  type AIProvider,
} from "../packages/agents/src/index.ts";
import { proposeTopics } from "../packages/agents/src/topics.ts";

const options = {
  channelId: "UC-test-channel",
  channelTitle: "Test channel",
  start: "2026-01-01",
  end: "2026-01-28",
  filters: "All content",
};
const csv =
  '\uFEFFContent,Video title,Views,Watch time (hours),Average view duration,Impressions,Impressions click-through rate (%)\r\nTotal,Total,12,2,1:00,200,6\r\nabcdefghijk,"A question, answered",0,1.5,2:05,100,4.5\r\nlmnopqrstuv,"A ""quoted"" title",12,0,—,,0\r\n';
class MemoryVault implements Vault {
  values = new Map<string, unknown>();
  async read(key: string) {
    return this.values.get(key) ?? null;
  }
  async write(key: string, value: unknown) {
    this.values.set(key, value);
  }
  async delete(key: string) {
    this.values.delete(key);
  }
}
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
async function library(
  t: { after: (fn: () => Promise<void>) => void },
  provider: AIProvider = new MockAIProvider(),
  fetcher: typeof fetch = fetch,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wts-analytics-")),
    store = new Store(root),
    vault = new MemoryVault(),
    oauth = new AnalyticsOAuth(vault, fetcher),
    service = new AnalyticsService(
      store,
      () => provider,
      undefined,
      oauth,
      fetcher,
    );
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, store, service, vault, oauth };
}
async function imported(service: AnalyticsService, root: string) {
  const file = path.join(root, "report.csv");
  await writeFile(file, csv);
  const preview = await service.previewImport(file, options);
  await service.commitImport(preview.token, true, true);
  const snapshot = service.snapshot(options.channelId);
  for (const video of snapshot.videos)
    await service.saveVideo(options.channelId, {
      ...video,
      format: "long-form",
      visibility: "public",
      publicDate: options.start,
    });
  await service.saveStrategy(
    options.channelId,
    strategySchema.parse({
      buyer: "Engineering leaders",
      problem: "Unbounded cloud failure domains",
      expertise: "A tested dependency map",
      offer: "Architecture review",
      cta: "Start a technical conversation",
      subjects: ["Reliability"],
    }),
  );
  return service.snapshot(options.channelId);
}

test("Studio CSV preserves quoted cells, zero, unavailable metrics and explicit report boundaries", () => {
  const result = previewCSV(csv, options);
  assert.equal(result.totalsSkipped, 1);
  assert.equal(result.videos[0].title, "A question, answered");
  assert.equal(result.videos[1].title, 'A "quoted" title');
  assert.equal(result.videos[0].format, "unknown");
  const metrics = result.reports[0].metrics;
  assert.deepEqual(
    metrics.find((m) => m.name === "views"),
    { name: "views", value: 0, state: "observed", unit: "count" },
  );
  assert.equal(metrics.find((m) => m.name === "watchMinutes")?.value, 90);
  assert.equal(
    metrics.find((m) => m.name === "averageViewDuration")?.value,
    125,
  );
  assert.equal(
    result.reports[1].metrics.find((m) => m.name === "impressions")?.state,
    "omitted",
  );
  assert.equal(
    metrics.find((m) => m.name === "subscribersGained")?.state,
    "unavailable",
  );
  assert.equal(result.reports[0].coverage, "unknown");
  assert.equal(result.reports[0].start, options.start);
  assert.deepEqual(parseCSV('a,b\n"one\ntwo","three"'), [
    ["a", "b"],
    ["one\ntwo", "three"],
  ]);
});
test("CSV rejects invalid dates, duplicate rows, malformed units and unrecognized mappings", () => {
  assert.throws(() => previewCSV(csv, { ...options, start: "2026-02-30" }));
  assert.throws(() => previewCSV(csv, { ...options, start: "2026-02-01" }));
  assert.throws(
    () => previewCSV(csv + "abcdefghijk,Duplicate,1,1,1,1,1\n", options),
    /Duplicate video/,
  );
  assert.throws(() => parseCSV('a,b\n"unterminated'), /unclosed/);
  assert.throws(
    () => previewCSV(csv.replace("100,4.5", "100,104.5"), options),
    /CTR/,
  );
  assert.throws(
    () => previewCSV(csv, { ...options, mapping: { views: "Absent" } }),
    /missing header/,
  );
  const localized = previewCSV("Identifiant,Vues\nabcdefghijk,0", {
    ...options,
    mapping: { videoId: "Identifiant", views: "Vues" },
  });
  assert.equal(localized.reports[0].metrics[0].value, 0);
});
test("database migration preserves existing projects and rejects a newer schema", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wts-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let store = new Store(root);
  const p = store.create("Existing project");
  store.db.exec(
    "DROP TABLE analytics_records; DROP TABLE analytics_locks; DROP TABLE analytics_channels; PRAGMA user_version=1",
  );
  store.close();
  store = new Store(root);
  assert.equal(store.get(p.id).title, p.title);
  assert.equal(
    (store.db.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version,
    2,
  );
  store.close();
  const db = new DatabaseSync(path.join(root, "studio.sqlite"));
  db.exec("PRAGMA user_version=3");
  db.close();
  assert.throws(() => new Store(root), /newer runtime/);
});
test("imports are previewed, idempotent, isolated from samples and constrained to one real channel", async (t) => {
  const { root, service } = await library(t);
  const file = path.join(root, "source.csv");
  await writeFile(file, csv);
  const preview = await service.previewImport(file, options);
  assert.equal(service.snapshot().channel, null);
  await assert.rejects(
    () => service.commitImport(preview.token, false, true),
    /Confirm/,
  );
  await service.commitImport(preview.token, true, true);
  const second = await service.previewImport(file, options);
  assert.equal(second.duplicate, true);
  assert.equal(second.overlapping, 2);
  await service.commitImport(second.token, true, true);
  assert.equal(service.snapshot().reports.length, 2);
  const sample = await service.sample();
  assert.equal(sample.channel?.mode, "sample");
  assert.equal(service.snapshot().channel?.id, options.channelId);
  await assert.rejects(
    () =>
      service.createProject(
        "sample-channel",
        sample.topics[0].id,
        1,
        sample.topics[0],
      ),
    /Sample topics/,
  );
  const foreign = await service.previewImport(file, {
    ...options,
    channelId: "different-channel",
  });
  await assert.rejects(
    () => service.commitImport(foreign.token, true, true),
    /already contains/,
  );
});
test("public release plus exact complete coverage controls review windows; no-outcome claims require checking", async (t) => {
  const { root, service } = await library(t);
  await imported(service, root);
  let snapshot = service.snapshot();
  assert.equal(snapshot.queue.find((q) => q.days === 28)?.state, "due");
  assert.equal(snapshot.queue.find((q) => q.days === 7)?.state, "waiting");
  const video = snapshot.videos[0];
  await service.saveVideo(video.channelId, { ...video, visibility: "private" });
  assert.ok(!service.snapshot().queue.some((q) => q.videoId === video.id));
  await service.saveVideo(video.channelId, video);
  const review = reviewSchema.parse({
    id: "review-input",
    channelId: video.channelId,
    videoId: video.id,
    days: 28,
    decision: "change-angle",
    lesson: "Buyer questions suggest a narrower architecture example",
    reviewedAt: "",
    noOutcomes: true,
  });
  await assert.rejects(
    () => service.saveReview(video.channelId, review),
    /explicit review/,
  );
  await service.saveReview(video.channelId, {
    ...review,
    outcomesReviewed: true,
  });
  snapshot = service.snapshot();
  assert.equal(
    snapshot.queue.find((q) => q.videoId === video.id && q.days === 28)?.state,
    "reviewed",
  );
  const topic = await service.followUp(
    video.channelId,
    `review-${video.id}-28`,
  );
  assert.equal(topic.status, "saved");
  assert.equal(
    (await service.followUp(video.channelId, `review-${video.id}-28`)).id,
    topic.id,
  );
  await assert.rejects(
    () =>
      service.saveReview(video.channelId, {
        ...review,
        days: 7,
        outcomesReviewed: true,
      }),
    /complete report/,
  );
  await service.saveReview(video.channelId, {
    ...review,
    days: 7,
    outcomesReviewed: true,
    snoozedUntil: addDays(pacificDate(new Date()), 7),
  });
  assert.equal(
    service.snapshot().queue.find((q) => q.videoId === video.id && q.days === 7)
      ?.state,
    "snoozed",
  );
});
test("topic selection creates one IDEA project with persisted provenance and unchanged production gates", async (t) => {
  const { root, service, store } = await library(t);
  await imported(service, root);
  const generated = await service.generate(options.channelId);
  const topic = generated.topics[0];
  await service.decide(options.channelId, topic.id, "saved", "");
  const p = await service.createProject(
    options.channelId,
    topic.id,
    topic.version,
    { ...topic, title: "A concrete buyer question" },
  );
  assert.equal(p.status, "IDEA");
  assert.equal(p.scripts.length, 0);
  assert.equal(p.topicOrigin?.hypothesis, topic.hypothesis);
  const reloaded = new AnalyticsService(store, () => new MockAIProvider());
  const duplicate = await reloaded.createProject(
    options.channelId,
    topic.id,
    1,
    topic,
  );
  assert.equal(duplicate.id, p.id);
  assert.equal(store.list().length, 1);
  const saved = JSON.parse(
    await readFile(path.join(store.dir(p), "project.json"), "utf8"),
  );
  assert.equal(saved.topicOrigin.topicId, topic.id);
  const artifact = JSON.parse(
    await readFile(
      path.join(store.dir(p), "research/topic-brief.json"),
      "utf8",
    ),
  );
  assert.equal(artifact.title, p.title);
  const studio = new Studio(store);
  await assert.rejects(
    () => studio.importMedia(p.id, "/not-read.mov"),
    /script/i,
  );
});
test("API evidence is gated, exclusions apply, outcome sharing is anonymous and opt-in", async (t) => {
  const mock = new MockAIProvider();
  let received: unknown;
  const provider: AIProvider = {
    ...mock,
    name: "openai",
    generateStructured: async (request) => {
      received = request.input;
      return mock.generateStructured(request);
    },
  };
  const { root, service } = await library(t, provider);
  await imported(service, root);
  await assert.rejects(
    () => service.generate(options.channelId),
    /Enable remote/,
  );
  let strategy = service.strategy(options.channelId);
  await service.saveStrategy(options.channelId, {
    ...strategy,
    allowRemoteAnalysis: true,
  });
  const outcome = outcomeSchema.parse({
    id: "outcome-1",
    channelId: options.channelId,
    opportunityId: "private-customer-id",
    videoId: "abcdefghijk",
    date: "2026-01-10",
    kind: "opportunity",
    buyerFit: "qualified",
    attribution: "prospect-named-video",
    note: "secret personal note",
  });
  await service.saveOutcome(options.channelId, outcome);
  await service.generate(options.channelId);
  assert.ok(!JSON.stringify(received).includes("views="));
  assert.ok(!JSON.stringify(received).includes("Creator record:"));
  strategy = service.strategy(options.channelId);
  await service.saveStrategy(options.channelId, {
    ...strategy,
    shareOutcomes: true,
    apiApprovalReference: "Recorded approval test fixture",
  });
  await service.generate(options.channelId);
  assert.match(JSON.stringify(received), /views=0/);
  assert.match(JSON.stringify(received), /Creator record:/);
  assert.ok(!JSON.stringify(received).includes("secret personal note"));
  assert.ok(!JSON.stringify(received).includes("private-customer-id"));
  for (const v of service.snapshot().videos)
    await service.saveVideo(options.channelId, { ...v, excluded: true });
  await service.generate(options.channelId);
  assert.ok(!JSON.stringify(received).includes("views="));
});
test("channel locks refuse a live owner and recover a dead owner", async (t) => {
  const { service, store } = await library(t);
  await service.sample();
  const release = service.data.acquire("sample-channel");
  await assert.rejects(
    () => service.generate("sample-channel"),
    /already running/,
  );
  release();
  store.db
    .prepare("INSERT INTO analytics_locks VALUES(?,?,?)")
    .run("sample-channel", 2147483647, "abandoned");
  await service.generate("sample-channel");
  assert.equal(service.data.list("sample-channel", "recovery").length, 1);
});
test("expiry removes old evidence only, and data deletion retains creator work", async (t) => {
  const { root, service } = await library(t);
  await imported(service, root);
  await service.generate(options.channelId);
  const reports = service.snapshot().reports;
  service.data.put(options.channelId, "report", reports[0].id, {
    ...reports[0],
    fetchedAt: "2020-01-01T00:00:00Z",
  });
  await service.dispatch("analytics.snapshot", {});
  assert.equal(service.snapshot().reports.length, 1);
  assert.equal(service.snapshot().reports[0].id, reports[1].id);
  await service.deleteData(options.channelId);
  const snapshot = service.snapshot();
  assert.equal(snapshot.reports.length, 0);
  assert.equal(snapshot.videos.length, 0);
  assert.ok(snapshot.topics.length);
  assert.ok(snapshot.topics.every((t) => t.evidenceUnavailable));
  assert.equal(snapshot.strategy.buyer, "Engineering leaders");
});
test("OAuth uses PKCE/state, holds credentials until identity confirmation and supports cancellation", async () => {
  const vault = new MemoryVault();
  await vault.write("client", { client_id: "test-client" });
  let tokenBody: URLSearchParams | undefined;
  const oauth = new AnalyticsOAuth(vault, async (url, init) => {
    if (String(url).includes("/token")) {
      tokenBody = init?.body as URLSearchParams;
      return response({
        access_token: "access-secret",
        refresh_token: "refresh-secret",
        expires_in: 3600,
        scope:
          "https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly",
      });
    }
    return response({
      items: [
        { id: "UC-test-channel", snippet: { title: "Confirmed channel" } },
      ],
    });
  });
  const start = await oauth.begin();
  try {
    const auth = new URL(start.url),
      redirect = auth.searchParams.get("redirect_uri")!;
    assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
    assert.ok(!auth.searchParams.get("scope")?.includes("upload"));
    assert.equal(
      (await fetch(redirect + "?state=wrong&code=code")).status,
      400,
    );
    const callback = new URL(redirect);
    callback.search = new URLSearchParams({
      state: auth.searchParams.get("state")!,
      code: "test-code",
    }).toString();
    await fetch(callback);
    const candidate = await oauth.finish(start.sessionId);
    assert.equal(candidate.channels[0].id, "UC-test-channel");
    assert.equal(await vault.read("channel-UC-test-channel"), null);
    assert.equal(
      createHash("sha256")
        .update(tokenBody!.get("code_verifier")!)
        .digest("base64url"),
      auth.searchParams.get("code_challenge"),
    );
    await assert.rejects(
      () => oauth.confirm(start.sessionId, "foreign"),
      /Confirm/,
    );
    await oauth.confirm(start.sessionId, "UC-test-channel");
    assert.equal(await oauth.access("UC-test-channel"), "access-secret");
    await oauth.disconnect("UC-test-channel");
    assert.equal(await vault.read("channel-UC-test-channel"), null);
  } finally {
    oauth.cancel(start.sessionId);
  }
  const next = await oauth.begin();
  const pending = oauth.finish(next.sessionId);
  oauth.cancel(next.sessionId);
  await assert.rejects(() => pending, /cancelled/);
});
test("OAuth refresh failures require reconnecting without exposing credentials", async () => {
  const vault = new MemoryVault();
  await vault.write("channel-c", {
    client: { client_id: "client" },
    accessToken: "expired-secret",
    refreshToken: "refresh-secret",
    expiresAt: 0,
  });
  const oauth = new AnalyticsOAuth(vault, async () =>
    response({ error: "private provider detail" }, 400),
  );
  await assert.rejects(
    () => oauth.access("c"),
    (e) =>
      e instanceof Error &&
      /expired/.test(e.message) &&
      !e.message.includes("secret"),
  );
});
const video: Video = {
  id: "abcdefghijk",
  channelId: "UC-test-channel",
  title: "Example",
  duration: 600,
  publicDate: "2026-01-01",
  publicDateSource: "youtube",
  visibility: "public",
  format: "long-form",
  tags: [],
  excluded: false,
  fetchedAt: new Date().toISOString(),
  projectId: null,
};
test("basic reports preserve lag, missing rows and percentages without treating omissions as zero", async () => {
  const requests: URL[] = [];
  const client = new YouTubeAnalyticsClient("secret", async (url) => {
    requests.push(new URL(String(url)));
    return response({
      columnHeaders: [{ name: "views" }, { name: "averageViewPercentage" }],
      rows: [[0, 42.5]],
    });
  });
  const partial = await client.basic(video, 28, "2026-01-10");
  assert.equal(partial.coverage, "partial");
  assert.equal(requests[0].searchParams.get("endDate"), "2026-01-10");
  assert.equal(partial.metrics[0].value, 0);
  assert.equal(
    partial.metrics.find((m) => m.name === "averageViewPercentage")?.value,
    42.5,
  );
  const pending = await client.basic(video, 7, null);
  assert.equal(pending.coverage, "pending");
  assert.equal(requests.length, 1);
  const empty = new YouTubeAnalyticsClient("secret", async () =>
    response({ columnHeaders: [{ name: "views" }] }),
  );
  const report = await empty.basic(video, 28, "2026-02-01");
  assert.equal(report.metrics[0].state, "omitted");
  assert.equal(report.metrics[0].value, null);
});
test("catalog verifies ownership, paginates and keeps private uploads out of public review dates", async () => {
  const requests: string[] = [];
  const client = new YouTubeAnalyticsClient("secret", async (url) => {
    const u = new URL(String(url));
    requests.push(u.toString());
    if (u.pathname.endsWith("channels"))
      return response({
        items: [
          {
            id: video.channelId,
            snippet: { title: "Mine" },
            contentDetails: { relatedPlaylists: { uploads: "uploads" } },
          },
        ],
      });
    if (u.pathname.endsWith("playlistItems"))
      return response({
        items: [
          {
            contentDetails: {
              videoId: u.searchParams.has("pageToken")
                ? "lmnopqrstuv"
                : video.id,
            },
          },
        ],
        ...(u.searchParams.has("pageToken") ? {} : { nextPageToken: "next" }),
      });
    return response({
      items: [
        {
          id: video.id,
          snippet: {
            channelId: video.channelId,
            title: "Private upload",
            publishedAt: "2026-01-01T12:00:00Z",
          },
          contentDetails: { duration: "PT10M" },
          status: { privacyStatus: "private" },
        },
      ],
    });
  });
  const channel = channelSchema.parse({
    id: video.channelId,
    title: "Mine",
    mode: "youtube",
    connected: true,
    verifiedAt: null,
    lastSync: null,
    catalogLimit: 100,
  });
  const catalog = await client.catalog(channel);
  assert.equal(catalog.complete, true);
  assert.equal(catalog.videos[0].publicDate, null);
  assert.equal(requests.filter((r) => r.includes("playlistItems")).length, 2);
  await assert.rejects(
    () => client.catalog({ ...channel, id: "foreign" }),
    /does not own/,
  );
});
test("topic proposals reject invented evidence references", async () => {
  const mock = new MockAIProvider();
  const provider: AIProvider = {
    ...mock,
    name: "mock",
    generateStructured: async (request) => {
      const result = await mock.generateStructured(request);
      const output = result.output as { topics: { evidenceIds: string[] }[] };
      output.topics[0].evidenceIds = ["invented"];
      return result;
    },
  };
  await assert.rejects(
    () =>
      proposeTopics(provider, {
        strategy: strategySchema.parse({
          buyer: "Buyer",
          problem: "Problem",
          expertise: "Proof",
        }),
        evidence: [],
        existing: [],
      }),
    /unavailable evidence/,
  );
});

test("sync keeps completed video reports on partial failure and retries safely", async (t) => {
  let failFirst = true;
  const fake: typeof fetch = async (url) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith("channels"))
      return response({
        items: [
          {
            id: video.channelId,
            snippet: { title: "Mine" },
            contentDetails: { relatedPlaylists: { uploads: "uploads" } },
          },
        ],
      });
    if (u.pathname.endsWith("playlistItems"))
      return response({
        items: [
          { contentDetails: { videoId: video.id } },
          { contentDetails: { videoId: "lmnopqrstuv" } },
        ],
      });
    if (u.pathname.endsWith("videos"))
      return response({
        items: [video.id, "lmnopqrstuv"].map((id) => ({
          id,
          snippet: {
            channelId: video.channelId,
            title: id,
            publishedAt: "2026-01-01T12:00:00Z",
          },
          contentDetails: { duration: "PT10M" },
          status: { privacyStatus: "public" },
        })),
      });
    if (u.searchParams.get("dimensions") === "day")
      return response({
        columnHeaders: [{ name: "day" }],
        rows: [["2026-06-01"]],
      });
    if (u.searchParams.get("dimensions") === "creatorContentType")
      return response({
        columnHeaders: [{ name: "creatorContentType" }, { name: "views" }],
        rows: [["VIDEO_ON_DEMAND", 100]],
      });
    if (failFirst && u.searchParams.get("filters") === `video==${video.id}`)
      return response({}, 403);
    return response({ columnHeaders: [{ name: "views" }], rows: [[100]] });
  };
  const { service, vault } = await library(t, new MockAIProvider(), fake);
  service.data.saveChannel(
    channelSchema.parse({
      id: video.channelId,
      title: "Mine",
      mode: "youtube",
      connected: true,
      verifiedAt: null,
      lastSync: null,
    }),
  );
  await vault.write(`channel-${video.channelId}`, {
    client: { client_id: "client" },
    accessToken: "token",
    refreshToken: "refresh",
    expiresAt: Date.now() + 3600000,
  });
  const partial = await service.sync(video.channelId, false);
  assert.equal(partial.reports.length, 3);
  assert.match(partial.channel!.status, /Partial/);
  failFirst = false;
  const complete = await service.sync(video.channelId, false);
  assert.equal(complete.reports.length, 6);
  assert.equal(complete.queue.filter((q) => q.state === "due").length, 6);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(() =>
    service.sync(video.channelId, false, abort.signal),
  );
  assert.equal(service.snapshot().reports.length, 6);
});
test("reach pagination preserves source percentages, omissions and replacement identities", async () => {
  let pageCount = 0;
  const client = new YouTubeAnalyticsClient("secret", async (url) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith("reports")) {
      pageCount++;
      return response({
        reports: [
          {
            id: u.searchParams.has("pageToken") ? "new" : "old",
            createTime: u.searchParams.has("pageToken")
              ? "2026-02-02T00:00:00Z"
              : "2026-02-01T00:00:00Z",
            downloadUrl: "https://youtubereporting.googleapis.com/media/report",
          },
        ],
        ...(u.searchParams.has("pageToken") ? {} : { nextPageToken: "next" }),
      });
    }
    return new Response(
      "date,channel_id,video_id,video_thumbnail_impressions,video_thumbnail_impressions_ctr\n2026-01-01,UC-test-channel,abcdefghijk,100,4.5\n2026-01-02,UC-test-channel,abcdefghijk,,",
    );
  });
  const reports = await client.reach(
    channelSchema.parse({
      id: video.channelId,
      title: "Mine",
      mode: "youtube",
      connected: true,
      verifiedAt: null,
      lastSync: null,
      reachJobId: "job",
    }),
  );
  assert.equal(pageCount, 2);
  assert.equal(reports[0].metrics[1].value, 4.5);
  assert.equal(reports[1].metrics[0].value, null);
  assert.equal(reports[1].metrics[0].state, "omitted");
  assert.equal(reports[0].id, reports[2].id);
  assert.notEqual(reports[0].generatedAt, reports[2].generatedAt);
});
test("reach setup finds existing jobs on later pages without creating duplicates", async () => {
  let posts = 0;
  const client = new YouTubeAnalyticsClient("secret", async (url, init) => {
    if (init?.method === "POST") posts++;
    const u = new URL(String(url));
    if (u.pathname.endsWith("reportTypes"))
      return response({ reportTypes: [{ id: "channel_reach_basic_a1" }] });
    return response(
      u.searchParams.has("pageToken")
        ? {
            jobs: [
              {
                id: "owned-job",
                reportTypeId: "channel_reach_basic_a1",
                name: "YouTube AI Studio reach",
              },
            ],
          }
        : { jobs: [], nextPageToken: "next" },
    );
  });
  assert.equal(await client.setupReach(), "owned-job");
  assert.equal(posts, 0);
});

test("confirmed future coverage cannot make a review prematurely due", async (t) => {
  const { root, service } = await library(t);
  const file = path.join(root, "future.csv");
  await writeFile(file, csv);
  const start = pacificDate(new Date()),
    end = addDays(start, 27);
  const preview = await service.previewImport(file, { ...options, start, end });
  await assert.rejects(
    () => service.commitImport(preview.token, true, true),
    /completed reporting days/,
  );
  await service.commitImport(preview.token, true, false);
  for (const v of service.snapshot().videos)
    await service.saveVideo(options.channelId, {
      ...v,
      publicDate: start,
      visibility: "public",
      format: "long-form",
    });
  assert.ok(service.snapshot().queue.every((q) => q.state === "waiting"));
});
test("known expired authorization purges cached source data and asks for reconnect", async (t) => {
  const { root, service, vault } = await library(
    t,
    new MockAIProvider(),
    async () => response({}, 401),
  );
  await imported(service, root);
  service.data.saveChannel({
    ...service.data.channel(options.channelId),
    mode: "youtube",
    connected: true,
  });
  await vault.write(`channel-${options.channelId}`, {
    client: { client_id: "client" },
    accessToken: "token",
    refreshToken: "refresh",
    expiresAt: Date.now() + 3600000,
  });
  await assert.rejects(() => service.sync(options.channelId, false), /401/);
  assert.equal(service.snapshot().channel?.connected, false);
  assert.equal(service.snapshot().reports.length, 0);
  assert.equal(await vault.read(`channel-${options.channelId}`), null);
});
test("regeneration records a bounded latest batch while preserving saved decisions", async (t) => {
  const { root, service } = await library(t);
  await imported(service, root);
  let snapshot = await service.generate(options.channelId);
  const saved = snapshot.topics[0];
  await service.decide(options.channelId, saved.id, "saved", "Useful proof");
  const oldBatch = snapshot.latestBatchId;
  snapshot = await service.generate(options.channelId);
  assert.notEqual(snapshot.latestBatchId, oldBatch);
  assert.equal(snapshot.topics.find((t) => t.id === saved.id)?.status, "saved");
  assert.ok(
    snapshot.topics.filter((t) => t.batchId === snapshot.latestBatchId)
      .length <= 5,
  );
});

test("transient OAuth refresh responses preserve the channel and source evidence", async (t) => {
  for (const status of [429, 500, 503]) {
    const { root, service, vault } = await library(
      t,
      new MockAIProvider(),
      async () => response({}, status),
    );
    await imported(service, root);
    service.data.saveChannel({
      ...service.data.channel(options.channelId),
      mode: "youtube",
      connected: true,
    });
    await vault.write(`channel-${options.channelId}`, {
      client: { client_id: "client" },
      accessToken: "expired",
      refreshToken: "retained-refresh",
      expiresAt: 0,
    });
    await assert.rejects(
      () => service.sync(options.channelId, false),
      (e) => e instanceof Error && /temporarily unavailable/.test(e.message),
    );
    assert.equal(service.snapshot().reports.length, 2);
    assert.equal(service.snapshot().channel?.connected, true);
    assert.ok(await vault.read(`channel-${options.channelId}`));
  }
});

test("topic transaction rollback leaves neither project rows nor orphaned project files", async (t) => {
  const { root, service, store } = await library(t);
  await imported(service, root);
  const topic = (await service.generate(options.channelId)).topics[0];
  store.db.exec(
    "CREATE TRIGGER reject_topic BEFORE UPDATE ON analytics_records WHEN NEW.kind='topic' BEGIN SELECT RAISE(ABORT,'injected topic write failure'); END;",
  );
  await assert.rejects(
    () =>
      service.createProject(options.channelId, topic.id, topic.version, topic),
    /injected/,
  );
  assert.equal(store.list().length, 0);
  assert.deepEqual(await readdir(path.join(root, "projects")), []);
  store.db.exec("DROP TRIGGER reject_topic");
  const materialize = store.materializeProject.bind(store);
  store.materializeProject = () => {
    throw Error("injected file failure");
  };
  await assert.rejects(
    () =>
      service.createProject(options.channelId, topic.id, topic.version, topic),
    /file failure/,
  );
  assert.equal(store.list().length, 1);
  store.materializeProject = materialize;
  const repaired = await service.createProject(
    options.channelId,
    topic.id,
    topic.version,
    topic,
  );
  assert.equal(store.list().length, 1);
  assert.equal(
    JSON.parse(
      await readFile(path.join(store.dir(repaired), "project.json"), "utf8"),
    ).id,
    repaired.id,
  );
});
test("failed import transaction does not leave unmanaged raw CSV artifacts", async (t) => {
  const { root, service, store } = await library(t);
  const file = path.join(root, "import.csv");
  await writeFile(file, csv);
  const preview = await service.previewImport(file, options);
  store.db.exec(
    "CREATE TRIGGER reject_report BEFORE INSERT ON analytics_records WHEN NEW.kind='report' BEGIN SELECT RAISE(ABORT,'injected report write failure'); END;",
  );
  await assert.rejects(
    () => service.commitImport(preview.token, true, true),
    /injected/,
  );
  assert.equal(service.snapshot().channel, null);
  await assert.rejects(() => readdir(path.join(root, "analytics")), {
    code: "ENOENT",
  });
  store.db.exec("DROP TRIGGER reject_report");
  await service.commitImport(preview.token, true, true);
  assert.equal(service.snapshot().reports.length, 2);
});
test("retained creator reviews and outcomes remain usable after video evidence expires", async (t) => {
  const { root, service } = await library(t);
  await imported(service, root);
  const snapshot = service.snapshot(),
    v = snapshot.videos[0];
  const outcome = outcomeSchema.parse({
    id: "outcome-retained",
    channelId: v.channelId,
    videoId: v.id,
    opportunityId: "anonymous",
    date: "2026-01-10",
    kind: "conversation",
    buyerFit: "qualified",
    attribution: "prospect-named-video",
  });
  await service.saveOutcome(v.channelId, outcome);
  const review = reviewSchema.parse({
    id: "input",
    channelId: v.channelId,
    videoId: v.id,
    days: 28,
    decision: "follow-up",
    lesson: "Demonstrate the failure boundary",
    outcomesReviewed: true,
    reviewedAt: "",
  });
  await service.saveReview(v.channelId, review);
  for (const video of snapshot.videos)
    service.data.put(v.channelId, "video", video.id, {
      ...video,
      fetchedAt: "2020-01-01T00:00:00Z",
    });
  await service.dispatch("analytics.snapshot", {});
  const retained = service.snapshot();
  assert.equal(retained.videos.length, 0);
  assert.equal(retained.queue[0].state, "reviewed");
  assert.equal(retained.queue[0].end, "unavailable");
  const followUp = await service.followUp(v.channelId, retained.queue[0].id);
  assert.match(followUp.thesis, /failure boundary/);
  assert.ok(!followUp.title.includes(v.title));
  await service.saveOutcome(v.channelId, { ...outcome, kind: "opportunity" });
  assert.equal(service.snapshot().outcomes[0].kind, "opportunity");
});
test("OAuth setup and missing CSV paths return actionable domain errors", async (t) => {
  const { root, service, oauth } = await library(t);
  await assert.rejects(() => oauth.begin(), /Desktop OAuth client JSON/);
  const file = path.join(root, "wrong-client.json");
  await writeFile(file, JSON.stringify({ web: { client_id: "wrong-type" } }));
  await assert.rejects(
    () => oauth.configure(file),
    /Desktop OAuth client JSON/,
  );
  await assert.rejects(
    () =>
      channelCLI(
        service,
        ["analytics", "import"],
        {},
        new AbortController().signal,
      ),
    /Provide the Studio CSV path/,
  );
});
test("CSV preview rejects videos that would fail later context validation", () => {
  assert.throws(
    () =>
      previewCSV(
        `Content,Video title,Views\nabcdefghijk,${"x".repeat(301)},1`,
        options,
      ),
    /300/,
  );
});
test("all generated prose is checked and repeated evidence cannot imply independent support", async () => {
  const mock = new MockAIProvider(),
    strategy = strategySchema.parse({
      buyer: "Buyer",
      problem: "Problem",
      expertise: "Proof",
    });
  for (const field of [
    "title",
    "buyer",
    "thesis",
    "proof",
    "cta",
    "rationale",
    "counterEvidence",
    "hypothesis",
  ]) {
    const provider: AIProvider = {
      ...mock,
      name: "mock",
      generateStructured: async (request) => {
        const result = await mock.generateStructured(request);
        (result.output as { topics: Record<string, unknown>[] }).topics[0][
          field
        ] = "Guaranteed 500 leads";
        return result;
      },
    };
    await assert.rejects(
      () => proposeTopics(provider, { strategy, evidence: [], existing: [] }),
      /unsupported measurement/,
    );
  }
  const provider: AIProvider = {
    ...mock,
    name: "mock",
    generateStructured: async (request) => {
      const result = await mock.generateStructured(request);
      const topic = (
        result.output as {
          topics: { evidenceIds: string[]; evidenceLabel: string }[];
        }
      ).topics[0];
      topic.evidenceIds = ["r1", "r1"];
      topic.evidenceLabel = "supported";
      return result;
    },
  };
  const result = await proposeTopics(provider, {
    strategy,
    evidence: [{ id: "r1", source: "creator", text: "One lesson" }],
    existing: [],
  });
  assert.deepEqual(result.output.topics[0].evidenceIds, ["r1"]);
  assert.equal(result.output.topics[0].evidenceLabel, "directional");
});
test("reach download is rejected before accumulating more than the CSV byte cap", async () => {
  for (const withLength of [true, false]) {
    let cancelled = false;
    const client = new YouTubeAnalyticsClient("secret", async (url) => {
      if (String(url).includes("/reports?"))
        return response({
          reports: [
            {
              id: "report",
              createTime: "2026-01-01",
              downloadUrl:
                "https://youtubereporting.googleapis.com/media/report",
            },
          ],
        });
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(3_000_000));
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(stream, {
        headers: withLength ? { "Content-Length": "6000000" } : {},
      });
    });
    await assert.rejects(
      () =>
        client.reach(
          channelSchema.parse({
            id: video.channelId,
            title: "Mine",
            mode: "youtube",
            connected: true,
            verifiedAt: null,
            lastSync: null,
            reachJobId: "job",
          }),
        ),
      /exceeds 5 MB/,
    );
    assert.equal(cancelled, true);
  }
});
