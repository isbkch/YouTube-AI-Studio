import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { z } from "zod";
import {
  atomicJSON,
  hash,
  id,
  now,
  safePath,
  StudioError,
} from "../../../shared/src/index.ts";
import type { AIProvider } from "../../../agents/src/index.ts";
import {
  proposeTopics,
  type TopicEvidence,
} from "../../../agents/src/topics.ts";
import type { Store } from "../store.ts";
import { AnalyticsStore } from "./store.ts";
import { AnalyticsOAuth, libraryVault } from "./oauth.ts";
import { previewCSV } from "./csv.ts";
import { YouTubeAnalyticsClient } from "./youtube.ts";
import {
  addDays,
  briefSchema,
  channelSchema,
  key,
  missingMetrics,
  outcomeSchema,
  pacificDate,
  reportSchema,
  reviewSchema,
  strategySchema,
  videoSchema,
  windowEnd,
  type Channel,
  type Outcome,
  type Report,
  type Review,
  type Strategy,
  type Topic,
  type Video,
} from "./model.ts";

export class AnalyticsService {
  readonly data: AnalyticsStore;
  readonly oauth: AnalyticsOAuth;
  private imports = new Map<
    string,
    { preview: ReturnType<typeof previewCSV>; csv: string; expires: number }
  >();
  constructor(
    readonly store: Store,
    private provider: () => AIProvider,
    private notify?: (event: unknown) => void,
    oauth?: AnalyticsOAuth,
    private fetcher: typeof fetch = fetch,
  ) {
    this.data = new AnalyticsStore(store.db);
    this.oauth = oauth ?? new AnalyticsOAuth(libraryVault(store.root), fetcher);
  }
  private async locked<T>(
    channelId: string,
    fn: () => Promise<T> | T,
  ): Promise<T> {
    const release = this.data.acquire(channelId);
    try {
      return await fn();
    } finally {
      release();
    }
  }
  private get<T>(channelId: string, kind: string, itemId: string): T {
    const value = this.data.get<T>(channelId, kind, itemId);
    if (!value)
      throw new StudioError(
        "INVALID_INPUT",
        `${kind} record was not found in this channel.`,
      );
    return value;
  }
  private allowChannel(channel: Channel) {
    const other = this.data
      .channels()
      .find(
        (c) =>
          c.id !== channel.id &&
          c.mode !== "sample" &&
          channel.mode !== "sample",
      );
    if (other)
      throw new StudioError(
        "CONFLICT",
        `This library already contains ${other.title}.`,
        "Use a separate library for another channel.",
      );
  }
  strategy(channelId: string): Strategy {
    this.data.channel(channelId);
    return (
      this.data.get<Strategy>(channelId, "strategy", "current") ??
      strategySchema.parse({ subjects: this.store.creator().subjects })
    );
  }
  async saveStrategy(channelId: string, raw: unknown) {
    return this.locked(channelId, () => {
      const s = strategySchema.parse(raw),
        old = this.strategy(channelId);
      if (s.version !== old.version)
        throw new StudioError(
          "CONFLICT",
          "Channel strategy changed. Reload before saving.",
        );
      const next = { ...s, version: old.version + 1 };
      this.data.transaction(() => {
        this.data.put(channelId, "strategy", String(next.version), next);
        this.data.put(channelId, "strategy", "current", next);
      });
      return next;
    });
  }
  private evidence(channelId: string, includeAPI: boolean): TopicEvidence[] {
    const reviews = this.data
      .list<Review>(channelId, "review")
      .filter((r) => r.lesson.trim() && !r.snoozedUntil)
      .map((r) => ({
        id: r.id,
        source: "creator" as const,
        text: `Creator lesson (${r.decision}): ${r.lesson}`,
      }));
    const s = this.strategy(channelId),
      provider = this.provider();
    const latestOutcomes = new Map<string, Outcome>();
    const stages = {
      conversation: 0,
      opportunity: 1,
      customer: 2,
      authority: 0,
    };
    for (const record of this.data.list<Outcome>(channelId, "outcome")) {
      const identity =
          record.opportunityId +
          (record.kind === "authority" ? ":authority" : ":business"),
        previous = latestOutcomes.get(identity);
      if (
        !previous ||
        stages[record.kind] > stages[previous.kind] ||
        (record.kind === previous.kind && record.date >= previous.date)
      )
        latestOutcomes.set(identity, record);
    }
    const outcomes =
      provider.name === "mock" || s.shareOutcomes
        ? [...latestOutcomes.values()].map((o) => ({
            id: o.id,
            source: "creator" as const,
            text: `Creator record: ${o.kind}; buyer fit ${o.buyerFit}; attribution ${o.attribution}; associated video ${o.videoId ?? "unspecified"}. One record per anonymous opportunity.`,
          }))
        : [];
    const eligible = new Set(
      this.data
        .list<Video>(channelId, "video")
        .filter(
          (v) =>
            v.visibility === "public" &&
            v.format === "long-form" &&
            !v.excluded,
        )
        .map((v) => v.id),
    );
    const videos = this.data.list<Video>(channelId, "video");
    const comparable = this.data.list<Report>(channelId, "report").filter(
      (r) =>
        r.family === "basic" &&
        r.coverage === "complete" &&
        eligible.has(r.videoId) &&
        [7, 28, 90].some((days) => {
          const video = videos.find((v) => v.id === r.videoId);
          return (
            video &&
            r.start === video.publicDate &&
            r.end === windowEnd(video, days)
          );
        }),
    );
    const days = [28, 7, 90].find((days) =>
      comparable.some(
        (r) =>
          r.end ===
          windowEnd(
            videos.find((v) => v.id === r.videoId)!,
            days,
          ),
      ),
    );
    // One source per video and one common window; API wins, otherwise the latest import.
    const chosen = new Map<string, Report>();
    for (const r of comparable.filter(
      (r) =>
        days &&
        r.end ===
          windowEnd(
            videos.find((v) => v.id === r.videoId)!,
            days,
          ),
    )) {
      const old = chosen.get(r.videoId);
      if (
        !old ||
        (r.source === "youtube" && old.source !== "youtube") ||
        (r.source === old.source && r.fetchedAt > old.fetchedAt)
      )
        chosen.set(r.videoId, r);
    }
    const reports = includeAPI
      ? [...chosen.values()].slice(-60).map((r) => ({
          id: r.id,
          source:
            r.source === "sample" ? ("sample" as const) : ("youtube" as const),
          text: `Video ${r.videoId} (${videos.find((v) => v.id === r.videoId)?.title}); long-form, duration ${videos.find((v) => v.id === r.videoId)?.duration ?? "unknown"} seconds; first ${days} reporting days; ${r.start} to ${r.end}; ${r.metrics
            .filter((m) => m.state === "observed")
            .map((m) => `${m.name}=${m.value} ${m.unit}`)
            .join("; ")}`,
        }))
      : [];
    return [...reviews, ...outcomes, ...reports].slice(-100);
  }
  private currentEvidenceHash(channelId: string) {
    return hash(this.evidence(channelId, this.analysisAllowed(channelId)));
  }
  private analysisAllowed(channelId: string) {
    const c = this.data.channel(channelId);
    return (
      c.mode === "sample" ||
      this.strategy(channelId).apiApprovalReference.trim().length > 0
    );
  }
  snapshot(channelId?: string) {
    const channels = this.data.channels();
    const c = channelId
      ? this.data.channel(channelId)
      : (channels.find((c) => c.mode !== "sample") ?? channels[0]);
    if (!c)
      return {
        channels,
        channel: null,
        strategy: strategySchema.parse({
          subjects: this.store.creator().subjects,
        }),
        videos: [],
        reports: [],
        topics: [],
        outcomes: [],
        reviews: [],
        queue: [],
        analysisAllowed: false,
        evidenceHash: "",
        notices: [],
      };
    const videos = this.data.list<Video>(c.id, "video"),
      reports = this.data.list<Report>(c.id, "report");
    const projects = this.store.list();
    for (const v of videos) {
      const matches = projects.filter((p) => p.publication?.videoId === v.id);
      if (matches.length === 1) v.projectId = matches[0].id;
    }
    const reviews = this.data.list<Review>(c.id, "review");
    const queue = videos
      .filter(
        (v) =>
          v.publicDate &&
          v.visibility === "public" &&
          v.format === "long-form" &&
          !v.excluded,
      )
      .flatMap((video) =>
        [7, 28, 90].map((days) => {
          const end = windowEnd(video, days)!;
          const review = reviews.find(
            (r) => r.videoId === video.id && r.days === days,
          );
          const complete = reports.some(
            (r) =>
              r.videoId === video.id &&
              r.family === "basic" &&
              r.start === video.publicDate &&
              r.end === end &&
              r.coverage === "complete" &&
              end < pacificDate(new Date()),
          );
          const state =
            review?.snoozedUntil &&
            review.snoozedUntil > pacificDate(new Date())
              ? "snoozed"
              : review && !review.snoozedUntil
                ? "reviewed"
                : complete
                  ? "due"
                  : "waiting";
          const project = projects.find((p) => p.id === video.projectId);
          return {
            id: `review-${video.id}-${days}`,
            videoId: video.id,
            title: video.title,
            days,
            end,
            state,
            hypothesis:
              project?.topicOrigin?.hypothesis ??
              "Record what this video was intended to achieve.",
            review: review ?? null,
          };
        }),
      );
    for (const review of reviews.filter(
      (r) => !r.snoozedUntil && !videos.some((v) => v.id === r.videoId),
    ))
      queue.push({
        id: review.id,
        videoId: review.videoId,
        title: "Video evidence unavailable · retained creator review",
        days: review.days,
        end: "unavailable",
        state: "reviewed",
        hypothesis:
          "Source metrics are unavailable. Your independently recorded lesson remains.",
        review,
      });
    return {
      channels,
      channel: c,
      strategy: this.strategy(c.id),
      videos,
      reports,
      topics: this.data.list<Topic>(c.id, "topic"),
      latestBatchId:
        this.data.list<{ id: string }>(c.id, "batch").at(-1)?.id ??
        (c.mode === "sample" ? "sample" : null),
      outcomes: this.data.list<Outcome>(c.id, "outcome"),
      reviews,
      queue,
      analysisAllowed: this.analysisAllowed(c.id),
      evidenceHash: this.currentEvidenceHash(c.id),
      notices: [
        ...(c.mode === "sample"
          ? ["Sample data is fictional and isolated from your channel."]
          : []),
        ...(!this.analysisAllowed(c.id)
          ? [
              "Topic generation uses your strategy and creator lessons. Automated YouTube analysis awaits a recorded API approval reference.",
            ]
          : []),
        ...(!c.catalogComplete
          ? [
              "Catalog coverage is limited. Use Load older videos or import additional reports.",
            ]
          : []),
      ],
    };
  }
  async confirmConnection(
    sessionId: string,
    channelId: string,
    signal?: AbortSignal,
  ) {
    return this.locked(channelId, async () => {
      const candidate = await this.oauth.finish(sessionId, signal);
      const selected = candidate.channels.find((c) => c.id === channelId);
      if (!selected)
        throw new StudioError(
          "INVALID_INPUT",
          "Select a channel returned by Google.",
        );
      const previous = this.data.channels().find((c) => c.id === channelId);
      const channel = channelSchema.parse({
        ...previous,
        id: channelId,
        title: selected.title,
        mode: "youtube",
        connected: true,
        verifiedAt: now(),
        lastSync: previous?.lastSync ?? null,
        status: "Connected; ready to sync",
      });
      this.allowChannel(channel);
      await this.oauth.confirm(sessionId, channelId);
      this.data.saveChannel(channel);
      try {
        const client = new YouTubeAnalyticsClient(
          await this.oauth.access(channelId, signal),
          this.fetcher,
        );
        channel.reachJobId = await client.setupReach(signal);
        channel.status = channel.reachJobId
          ? "Connected; reach reports may take up to 48 hours"
          : "Connected; reach report is not available for this channel";
      } catch {
        channel.status =
          "Connected; reach setup failed. Use Enable reach reports to retry.";
      }
      this.data.saveChannel(channel);
      return this.snapshot(channelId);
    });
  }
  async setupReach(channelId: string, signal?: AbortSignal) {
    return this.locked(channelId, async () => {
      const c = this.data.channel(channelId);
      const client = new YouTubeAnalyticsClient(
        await this.oauth.access(channelId, signal),
        this.fetcher,
      );
      c.reachJobId = await client.setupReach(signal);
      this.data.saveChannel(c);
      return this.snapshot(channelId);
    });
  }
  private async artifact(channelId: string, name: string, value: unknown) {
    const directory = await safePath(this.store.root, `analytics/${channelId}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await atomicJSON(await safePath(directory, name), value);
  }
  async previewImport(file: string, options: unknown) {
    if ((await stat(file)).size > 5_000_000)
      throw new StudioError("INVALID_INPUT", "CSV exceeds 5 MB.");
    const csv = await readFile(file, "utf8"),
      preview = previewCSV(csv, options);
    for (const [token, value] of this.imports)
      if (value.expires < Date.now()) this.imports.delete(token);
    if (this.imports.size >= 5)
      this.imports.delete(this.imports.keys().next().value!);
    const token = id("import");
    this.imports.set(token, { preview, csv, expires: Date.now() + 15 * 60000 });
    const existing = this.data
      .channels()
      .some((c) => c.id === preview.options.channelId)
      ? this.data.list<Report>(preview.options.channelId, "report")
      : [];
    return {
      token,
      sourceId: preview.sourceId,
      headers: preview.headers,
      mapping: preview.options.mapping,
      rowCount: preview.videos.length,
      totalsSkipped: preview.totalsSkipped,
      warnings: preview.warnings,
      videoTitles: preview.videos.slice(0, 10).map((v) => v.title),
      duplicate: existing.some((r) => r.sourceId === preview.sourceId),
      overlapping: preview.reports.filter((r) =>
        existing.some(
          (old) =>
            old.videoId === r.videoId &&
            old.family === r.family &&
            old.start <= r.end &&
            old.end >= r.start,
        ),
      ).length,
    };
  }
  async commitImport(
    token: string,
    confirmed: boolean,
    coverageConfirmed: boolean,
  ) {
    const input = this.imports.get(token);
    if (!input || input.expires < Date.now())
      throw new StudioError(
        "CONFLICT",
        "Import preview expired. Preview the file again.",
      );
    if (!confirmed)
      throw new StudioError(
        "INVALID_INPUT",
        "Confirm the report's channel identity and interval before importing.",
      );
    const { preview } = input,
      cid = preview.options.channelId;
    if (coverageConfirmed && preview.options.end >= pacificDate(new Date()))
      throw new StudioError(
        "INVALID_INPUT",
        "Only completed reporting days can have confirmed coverage.",
      );
    return this.locked(cid, async () => {
      let channel = this.data.channels().find((c) => c.id === cid);
      if (!channel) {
        channel = channelSchema.parse({
          id: cid,
          title: preview.options.channelTitle,
          mode: "import",
          connected: false,
          verifiedAt: null,
          lastSync: null,
        });
        this.allowChannel(channel);
      }
      if (channel.mode === "sample")
        throw new StudioError(
          "CONFLICT",
          "Import into your channel, not the sample channel.",
        );
      this.data.transaction(() => {
        this.data.saveChannel({
          ...channel,
          lastSync: now(),
          status: "Studio report imported",
        });
        for (const video of preview.videos) {
          const old = this.data.get<Video>(cid, "video", video.id);
          this.data.put(
            cid,
            "video",
            video.id,
            old ? { ...video, ...old, fetchedAt: video.fetchedAt } : video,
          );
        }
        for (const report of preview.reports)
          this.data.put(cid, "report", report.id, {
            ...report,
            coverage: coverageConfirmed ? "complete" : "unknown",
          });
        this.data.put(cid, "import", preview.sourceId, {
          id: preview.sourceId,
          fetchedAt: now(),
          rows: preview.videos.length,
          options: preview.options,
        });
      });
      await this.artifact(cid, `import-${preview.sourceId}.json`, {
        sourceId: preview.sourceId,
        options: preview.options,
        csv: input.csv,
        expiresAt: addDays(pacificDate(new Date()), 30),
      });
      this.imports.delete(token);
      return this.snapshot(cid);
    });
  }
  async saveVideo(channelId: string, raw: unknown) {
    return this.locked(channelId, () => {
      const v = videoSchema.parse(raw);
      if (v.channelId !== channelId)
        throw new StudioError(
          "INVALID_INPUT",
          "Video belongs to a different channel.",
        );
      const old = this.get<Video>(channelId, "video", v.id);
      const next = {
        ...old,
        format: v.format,
        tags: v.tags,
        excluded: v.excluded,
        visibility: v.visibility,
        publicDate: v.publicDate,
        publicDateSource:
          v.publicDate === old.publicDate ? old.publicDateSource : "creator",
        projectId: v.projectId,
      };
      if (v.projectId) {
        const p = this.store.get(v.projectId);
        if (p.publication && p.publication.videoId !== v.id)
          throw new StudioError(
            "CONFLICT",
            "Project was uploaded under another video ID.",
          );
        if (
          this.data
            .list<Video>(channelId, "video")
            .some((other) => other.id !== v.id && other.projectId === p.id)
        )
          throw new StudioError(
            "CONFLICT",
            "Project is already linked to another video.",
          );
      }
      this.data.put(channelId, "video", v.id, next);
      return this.snapshot(channelId);
    });
  }
  async sync(channelId: string, older: boolean, signal?: AbortSignal) {
    return this.locked(channelId, async () => {
      const channel = this.data.channel(channelId);
      if (channel.mode !== "youtube" || !channel.connected)
        throw new StudioError(
          "CONFIGURATION",
          "Connect this channel to refresh YouTube data.",
        );
      if (older)
        channel.catalogLimit = Math.min(500, channel.catalogLimit + 50);
      const runId = id("sync"),
        errors: string[] = [];
      this.data.put(channelId, "sync", runId, {
        id: runId,
        state: "running",
        startedAt: now(),
      });
      const progress = (stage: string, completed: number, total: number) =>
        this.notify?.({
          event: "analytics.progress",
          channelId,
          runId,
          stage,
          completed,
          total,
        });
      try {
        const client = new YouTubeAnalyticsClient(
          await this.oauth.access(channelId, signal),
          this.fetcher,
        );
        progress("Reading channel videos", 0, 0);
        const catalog = await client.catalog(channel, signal);
        signal?.throwIfAborted();
        channel.verifiedAt = now();
        channel.title = catalog.title;
        channel.catalogComplete = catalog.complete;
        this.data.transaction(() => {
          for (const v of catalog.videos) {
            const old = this.data.get<Video>(channelId, "video", v.id);
            this.data.put(channelId, "video", v.id, {
              ...v,
              tags: old?.tags ?? [],
              excluded: old?.excluded ?? false,
              projectId: old?.projectId ?? null,
              format:
                v.format === "unknown" ? (old?.format ?? "unknown") : v.format,
            });
          }
          this.data.saveChannel(channel);
        });
        const through = await client.availableThrough(channelId, signal);
        const videos = this.data
          .list<Video>(channelId, "video")
          .filter(
            (v) =>
              catalog.videos.some((c) => c.id === v.id) &&
              v.visibility === "public" &&
              v.publicDate &&
              !v.excluded,
          );
        let completed = 0;
        for (const video of videos) {
          signal?.throwIfAborted();
          progress("Reading video performance", completed++, videos.length);
          try {
            if (video.format === "unknown" && through) {
              video.format = await client.classify(video, through, signal);
              this.data.put(channelId, "video", video.id, video);
            }
            if (video.format !== "long-form") continue;
            for (const days of [7, 28, 90]) {
              const report = reportSchema.parse(
                await client.basic(video, days, through, signal),
              );
              signal?.throwIfAborted();
              this.data.put(channelId, "report", report.id, report);
            }
          } catch (e) {
            signal?.throwIfAborted();
            if (e instanceof StudioError && e.kind === "CONFIGURATION") throw e;
            errors.push(
              `Video ${video.id}: ${e instanceof StudioError ? e.message : "report unavailable"}`,
            );
          }
        }
        if (channel.reachJobId)
          try {
            progress("Reading reach reports", 0, 0);
            const reach = await client.reach(channel, signal);
            signal?.throwIfAborted();
            this.data.transaction(() => {
              for (const report of reach) {
                const old = this.data.get<Report>(
                  channelId,
                  "report",
                  report.id,
                );
                if (
                  !old ||
                  (report.generatedAt ?? "") > (old.generatedAt ?? "")
                )
                  this.data.put(
                    channelId,
                    "report",
                    report.id,
                    reportSchema.parse(report),
                  );
              }
            });
          } catch {
            signal?.throwIfAborted();
            errors.push(
              "Reach reports are pending or unavailable; basic reports remain usable.",
            );
          }
        channel.lastSync = now();
        channel.status = errors.length
          ? `Partial refresh: ${errors.length} report issue(s)`
          : `Refreshed ${videos.length} public videos`;
        this.data.saveChannel(channel);
        this.data.put(channelId, "sync", runId, {
          id: runId,
          state: errors.length ? "partial" : "complete",
          completedAt: now(),
          errors,
        });
        progress(channel.status, videos.length, videos.length);
        return this.snapshot(channelId);
      } catch (e) {
        if (e instanceof StudioError && e.kind === "CONFIGURATION") {
          await this.oauth.disconnect(channelId);
          this.purgeEvidence(channelId);
          this.data.saveChannel({
            ...channel,
            connected: false,
            verifiedAt: null,
            lastSync: null,
            status: "Authorization unavailable; reconnect to refresh",
          });
          await this.removeArtifacts(channelId);
        }
        this.data.put(channelId, "sync", runId, {
          id: runId,
          state: signal?.aborted ? "cancelled" : "failed",
          completedAt: now(),
        });
        throw e;
      }
    });
  }
  async details(
    channelId: string,
    videoId: string,
    family: "traffic" | "search" | "retention",
    signal?: AbortSignal,
  ) {
    return this.locked(channelId, async () => {
      const video = this.get<Video>(channelId, "video", videoId);
      const client = new YouTubeAnalyticsClient(
        await this.oauth.access(channelId, signal),
        this.fetcher,
      );
      const report = reportSchema.parse(
        await client.details(video, family, signal),
      );
      signal?.throwIfAborted();
      this.data.put(channelId, "report", report.id, report);
      return this.snapshot(channelId);
    });
  }
  async saveOutcome(channelId: string, raw: unknown) {
    return this.locked(channelId, () => {
      this.data.channel(channelId);
      const outcome = outcomeSchema.parse(raw);
      if (outcome.channelId !== channelId)
        throw new StudioError(
          "INVALID_INPUT",
          "Outcome belongs to a different channel.",
        );
      const previous = this.data.get<Outcome>(channelId, "outcome", outcome.id);
      if (outcome.videoId && outcome.videoId !== previous?.videoId)
        this.get(channelId, "video", outcome.videoId);
      if (outcome.topicId) this.get(channelId, "topic", outcome.topicId);
      if (outcome.attribution === "prospect-named-video" && !outcome.videoId)
        throw new StudioError(
          "INVALID_INPUT",
          "Select the video named by the prospect.",
        );
      this.data.put(channelId, "outcome", outcome.id, outcome);
      return this.snapshot(channelId);
    });
  }
  async saveReview(channelId: string, raw: unknown) {
    return this.locked(channelId, () => {
      const review = reviewSchema.parse(raw);
      if (review.channelId !== channelId)
        throw new StudioError(
          "INVALID_INPUT",
          "Review belongs to a different channel.",
        );
      const video = this.get<Video>(channelId, "video", review.videoId),
        end = windowEnd(video, review.days);
      if (
        !end ||
        video.visibility !== "public" ||
        video.format !== "long-form" ||
        video.excluded
      )
        throw new StudioError(
          "INVALID_INPUT",
          "Review needs verified public availability.",
        );
      if (
        review.noOutcomes &&
        (!review.outcomesReviewed ||
          this.data
            .list<Outcome>(channelId, "outcome")
            .some(
              (o) =>
                o.videoId === video.id &&
                o.date >= video.publicDate! &&
                o.date <= end,
            ))
      )
        throw new StudioError(
          "CONFLICT",
          "No-outcomes requires an explicit review and no recorded outcomes in this window.",
        );
      const complete = this.data
        .list<Report>(channelId, "report")
        .some(
          (r) =>
            r.family === "basic" &&
            r.videoId === video.id &&
            r.start === video.publicDate &&
            r.end === end &&
            r.coverage === "complete" &&
            end < pacificDate(new Date()),
        );
      if (review.snoozedUntil && review.snoozedUntil <= pacificDate(new Date()))
        throw new StudioError("INVALID_INPUT", "Choose a future snooze date.");
      if (!complete && !review.snoozedUntil)
        throw new StudioError(
          "CONFLICT",
          "Wait for a complete report window before closing this review.",
        );
      this.data.put(channelId, "review", `review-${video.id}-${review.days}`, {
        ...review,
        id: `review-${video.id}-${review.days}`,
        reviewedAt: now(),
      });
      return this.snapshot(channelId);
    });
  }
  async generate(channelId: string, signal?: AbortSignal) {
    return this.locked(channelId, async () => {
      const strategy = this.strategy(channelId),
        channel = this.data.channel(channelId),
        provider = this.provider();
      if (!strategy.buyer || !strategy.problem || !strategy.expertise)
        throw new StudioError(
          "INVALID_INPUT",
          "Add your target buyer, problem and available proof in Channel Strategy.",
        );
      if (provider.name !== "mock" && !strategy.allowRemoteAnalysis)
        throw new StudioError(
          "CONFIGURATION",
          "Enable remote topic generation in Channel Strategy before sending evidence to your configured provider.",
        );
      if (channel.mode === "sample" && provider.name !== "mock")
        throw new StudioError(
          "CONFIGURATION",
          "Explore sample data with the mock provider.",
        );
      const evidence = this.evidence(
          channelId,
          this.analysisAllowed(channelId),
        ),
        existing = this.data.list<Topic>(channelId, "topic"),
        inputHash = hash(evidence);
      const result = await proposeTopics(
        provider,
        {
          strategy,
          evidence,
          existing: existing.slice(-100).map((t) => ({
            title: t.title,
            status: t.status,
            reason: t.reason,
          })),
        },
        signal,
      );
      signal?.throwIfAborted();
      if (evidence.filter((e) => e.source !== "creator").length < 5)
        for (const brief of result.output.topics) {
          brief.evidenceLabel = "explore";
          brief.counterEvidence = (
            brief.counterEvidence +
            " Fewer than five comparable mature videos are available; treat this as exploration."
          ).slice(0, 2000);
        }
      const batchId = id("topics");
      let proposed = 0;
      this.data.transaction(() => {
        for (const brief of result.output.topics) {
          if (
            existing.some(
              (t) =>
                t.title.toLowerCase() === brief.title.toLowerCase() &&
                t.status !== "proposed",
            )
          )
            continue;
          const topic: Topic = {
            ...brief,
            id: id("topic"),
            channelId,
            batchId,
            version: 1,
            createdAt: now(),
            status: "proposed",
            reason: "",
            projectId: null,
            strategyVersion: strategy.version,
            inputHash,
            provider: provider.name,
            evidenceUnavailable: false,
          };
          this.data.put(channelId, "topic", topic.id, topic);
          proposed++;
        }
        this.data.put(channelId, "batch", batchId, {
          id: batchId,
          createdAt: now(),
          inputHash,
          algorithm: "editorial-topics-v1",
          usage: result.usage,
          provider: provider.name,
          proposed,
        });
      });
      return this.snapshot(channelId);
    });
  }
  async saveTopic(
    channelId: string,
    topicId: string,
    raw: unknown,
    version: number,
  ) {
    return this.locked(channelId, () => {
      const old = this.get<Topic>(channelId, "topic", topicId);
      if (old.version !== version || old.status === "in_production")
        throw new StudioError(
          "CONFLICT",
          "Topic changed or is already in production.",
        );
      const brief = briefSchema.parse(raw);
      const valid = new Set(this.evidence(channelId, true).map((e) => e.id));
      if (brief.evidenceIds.some((e) => !valid.has(e)))
        throw new StudioError(
          "INVALID_INPUT",
          "Brief references unavailable evidence.",
        );
      const next = { ...old, ...brief, version: old.version + 1 };
      this.data.put(
        channelId,
        "topic-version",
        `${old.id}-${old.version}`,
        old,
      );
      this.data.put(channelId, "topic", old.id, next);
      return next;
    });
  }
  async decide(
    channelId: string,
    topicId: string,
    status: "saved" | "dismissed" | "proposed",
    reason: string,
  ) {
    return this.locked(channelId, () => {
      const old = this.get<Topic>(channelId, "topic", topicId);
      if (old.status === "in_production")
        throw new StudioError(
          "CONFLICT",
          "This topic is already in production.",
        );
      this.data.put(channelId, "topic", old.id, {
        ...old,
        status,
        reason: z.string().max(1000).parse(reason),
      });
      return this.snapshot(channelId);
    });
  }
  async createProject(
    channelId: string,
    topicId: string,
    version: number,
    raw: unknown,
  ) {
    return this.locked(channelId, async () => {
      const topic = this.get<Topic>(channelId, "topic", topicId);
      if (this.data.channel(channelId).mode === "sample")
        throw new StudioError(
          "CONFLICT",
          "Sample topics cannot create real projects. Import or connect your channel first.",
        );
      if (topic.projectId) {
        const p = this.store.get(topic.projectId);
        this.store.materializeProject(p);
        await this.store.artifact(p, "research/topic-brief.json", {
          ...topic,
          briefSource: "creator-selected",
          evidenceIds: topic.evidenceIds,
        });
        return p;
      }
      if (topic.version !== version || topic.status === "dismissed")
        throw new StudioError(
          "CONFLICT",
          "Review the current topic version before creating a project.",
        );
      const brief = briefSchema.parse(raw);
      if (hash(brief.evidenceIds) !== hash(topic.evidenceIds))
        throw new StudioError(
          "CONFLICT",
          "Edit the brief without replacing its evidence references.",
        );
      const next = { ...topic, ...brief, version: topic.version + 1 };
      const project = this.store.prepareProject(
        brief.title,
        `${brief.thesis}\n\nBuyer: ${brief.buyer}\nProof to show: ${brief.proof}\nNext step: ${brief.cta}`,
        brief.targetDuration,
      );
      project.topicOrigin = {
        channelId,
        topicId,
        version: next.version,
        hash: hash(next),
        strategyVersion: topic.strategyVersion,
        hypothesis: brief.hypothesis,
        reviewDays: [7, 28, 90],
      };
      const p = this.data.transaction(() => {
        this.store.insertPreparedProject(project);
        this.data.put(channelId, "topic", topic.id, {
          ...next,
          status: "in_production",
          projectId: project.id,
        });
        return project;
      });
      this.store.materializeProject(p);
      await this.store.artifact(p, "research/topic-brief.json", {
        ...next,
        briefSource: "creator-selected",
      });
      return p;
    });
  }
  async followUp(channelId: string, reviewId: string) {
    return this.locked(channelId, () => {
      const review = this.get<Review>(channelId, "review", reviewId),
        video = this.data.get<Video>(channelId, "video", review.videoId),
        s = this.strategy(channelId);
      if (review.snoozedUntil)
        throw new StudioError(
          "CONFLICT",
          "Complete the review before drafting a follow-up.",
        );
      const duplicate = this.data
        .list<Topic>(channelId, "topic")
        .find((t) => t.batchId === reviewId);
      if (duplicate) return duplicate;
      const topic: Topic = {
        id: id("topic"),
        channelId,
        batchId: reviewId,
        version: 1,
        createdAt: now(),
        title: video
          ? `Follow-up: ${video.title}`.slice(0, 200)
          : "Follow-up from a retained creator review",
        buyer: s.buyer || "Define the buyer",
        thesis: review.lesson || "Develop a new angle from this review.",
        proof: s.expertise || "Add the evidence you can demonstrate.",
        cta: s.cta,
        rationale: "Creator chose to follow up on an editorial review.",
        counterEvidence: "A reviewed observation does not establish causation.",
        hypothesis:
          "Record whether the new angle prompts a relevant buyer conversation.",
        kind: "follow-up",
        evidenceLabel: "directional",
        evidenceIds: [review.id],
        targetDuration: 900,
        status: "saved",
        reason: "",
        projectId: null,
        strategyVersion: s.version,
        inputHash: this.currentEvidenceHash(channelId),
        provider: "creator",
        evidenceUnavailable: false,
      };
      this.data.put(channelId, "topic", topic.id, topic);
      return topic;
    });
  }
  async disconnect(channelId: string) {
    return this.locked(channelId, async () => {
      const c = this.data.channel(channelId);
      if (c.mode === "youtube") await this.oauth.disconnect(channelId);
      this.purgeEvidence(channelId);
      this.data.saveChannel({
        ...c,
        connected: false,
        verifiedAt: null,
        lastSync: null,
        status: "Disconnected; YouTube evidence removed",
      });
      await this.removeArtifacts(channelId);
      return this.snapshot(channelId);
    });
  }
  private purgeEvidence(channelId: string) {
    this.data.transaction(() => {
      for (const kind of [
        "video",
        "report",
        "import",
        "sync",
        "batch",
        "topic-version",
      ])
        this.data.remove(channelId, kind);
      for (const topic of this.data.list<Topic>(channelId, "topic"))
        this.data.put(channelId, "topic", topic.id, {
          ...topic,
          rationale:
            "Source analytics were removed. Re-evaluate this brief before production.",
          counterEvidence: "Source evidence is unavailable.",
          evidenceIds: [],
          evidenceUnavailable: true,
        });
    });
  }
  private async removeArtifacts(channelId: string) {
    await rm(await safePath(this.store.root, `analytics/${channelId}`), {
      recursive: true,
      force: true,
    });
    for (const project of this.store
      .list()
      .filter((p) => p.topicOrigin?.channelId === channelId))
      await rm(
        await safePath(this.store.dir(project), "research/topic-brief.json"),
        { force: true },
      );
  }
  async deleteData(channelId: string) {
    return this.locked(channelId, async () => {
      if (this.data.channel(channelId).mode === "youtube")
        await this.oauth.disconnect(channelId);
      this.purgeEvidence(channelId);
      await this.removeArtifacts(channelId);
      this.data.saveChannel({
        ...this.data.channel(channelId),
        connected: false,
        verifiedAt: null,
        lastSync: null,
        status:
          "Analytics deleted; creator strategy and business records retained",
      });
      return this.snapshot(channelId);
    });
  }
  private async pruneExpired() {
    const cutoff = Date.now() - 30 * 86400000;
    for (const channel of this.data.channels()) {
      if (channel.mode === "sample") continue;
      const expiredReports = this.data
        .list<Report>(channel.id, "report")
        .filter((r) => Date.parse(r.fetchedAt) < cutoff);
      const expiredVideos = this.data
        .list<Video>(channel.id, "video")
        .filter((v) => Date.parse(v.fetchedAt) < cutoff);
      const expiredImports = this.data
        .list<{ id: string; fetchedAt: string }>(channel.id, "import")
        .filter((r) => Date.parse(r.fetchedAt) < cutoff);
      if (
        !expiredReports.length &&
        !expiredVideos.length &&
        !expiredImports.length
      )
        continue;
      let release: () => void;
      try {
        release = this.data.acquire(channel.id);
      } catch (e) {
        if (e instanceof StudioError && e.kind === "CONFLICT") continue;
        throw e;
      }
      try {
        const removed = new Set(expiredReports.map((r) => r.id));
        this.data.transaction(() => {
          for (const r of expiredReports)
            this.data.remove(channel.id, "report", r.id);
          for (const v of expiredVideos)
            this.data.remove(channel.id, "video", v.id);
          for (const r of expiredImports)
            this.data.remove(channel.id, "import", r.id);
          for (const topic of this.data.list<Topic>(channel.id, "topic"))
            if (topic.evidenceIds.some((id) => removed.has(id)))
              this.data.put(channel.id, "topic", topic.id, {
                ...topic,
                evidenceIds: topic.evidenceIds.filter((id) => !removed.has(id)),
                evidenceUnavailable: true,
                rationale:
                  "Some source analytics expired. Refresh and re-evaluate this brief.",
                counterEvidence: "Expired source evidence is unavailable.",
              });
          this.data.remove(channel.id, "topic-version");
        });
        for (const r of expiredImports)
          await rm(
            await safePath(
              this.store.root,
              `analytics/${channel.id}/import-${r.id}.json`,
            ),
            { force: true },
          );
        if (expiredReports.length)
          for (const p of this.store
            .list()
            .filter((p) => p.topicOrigin?.channelId === channel.id))
            await rm(
              await safePath(this.store.dir(p), "research/topic-brief.json"),
              { force: true },
            );
      } finally {
        release();
      }
    }
  }
  async sample() {
    const channelId = "sample-channel";
    if (this.data.channels().some((c) => c.id === channelId))
      return this.snapshot(channelId);
    this.data.saveChannel(
      channelSchema.parse({
        id: channelId,
        title: "Example channel · fictional data",
        mode: "sample",
        connected: false,
        verifiedAt: null,
        lastSync: now(),
        catalogComplete: true,
      }),
    );
    const s = strategySchema.parse({
      version: 1,
      buyer: "Engineering leaders responsible for reliability",
      problem: "Shared failure domains undermine redundant systems",
      expertise: "A dependency map and a bounded failure drill",
      offer: "Architecture review",
      cta: "Invite a relevant architecture conversation",
      subjects: ["cloud reliability"],
    });
    this.data.put(channelId, "strategy", "current", s);
    const titles = [
      "The hidden single point of failure",
      "Redundancy is not resilience",
      "Our first failure drill",
    ];
    for (const [i, title] of titles.entries()) {
      const publicDate = addDays(pacificDate(new Date()), -100 - i * 30),
        video: Video = {
          id: `samplevid0${i}x`,
          channelId,
          title,
          duration: 840,
          publicDate,
          publicDateSource: "creator",
          visibility: "public",
          format: "long-form",
          tags: ["reliability"],
          excluded: false,
          fetchedAt: now(),
          projectId: null,
        };
      this.data.put(channelId, "video", video.id, video);
      for (const days of [7, 28, 90]) {
        const metrics = missingMetrics();
        metrics[0] = {
          ...metrics[0],
          value: [3840, 2960, 4120][i],
          state: "observed",
        };
        metrics[3] = {
          ...metrics[3],
          value: [48.2, 45.1, 51][i],
          state: "observed",
        };
        const report: Report = {
          id: `sample-${i}-${days}`,
          videoId: video.id,
          channelId,
          source: "sample",
          family: "basic",
          start: publicDate,
          end: addDays(publicDate, days - 1),
          through: addDays(publicDate, days - 1),
          fetchedAt: now(),
          timezone: "America/Los_Angeles",
          filters: "Fictional example",
          coverage: "complete",
          metrics,
          details: [],
          sourceId: "sample",
          generatedAt: null,
        };
        this.data.put(channelId, "report", report.id, report);
      }
    }
    const outcome: Outcome = {
      id: "sample-outcome",
      channelId,
      opportunityId: "sample-opportunity",
      videoId: "samplevid00x",
      topicId: null,
      date: addDays(pacificDate(new Date()), -10),
      kind: "conversation",
      buyerFit: "qualified",
      attribution: "prospect-named-video",
      note: "Fictional example; no personal data.",
    };
    this.data.put(channelId, "outcome", outcome.id, outcome);
    // Local sample generation never invokes the configured paid provider.
    const { MockAIProvider } = await import("../../../agents/src/index.ts");
    const proposals = await proposeTopics(new MockAIProvider(), {
      strategy: s,
      evidence: [],
      existing: [],
    });
    for (const brief of proposals.output.topics) {
      const topic: Topic = {
        ...brief,
        id: id("sample-topic"),
        channelId,
        batchId: "sample",
        version: 1,
        createdAt: now(),
        status: "proposed",
        reason: "",
        projectId: null,
        strategyVersion: 1,
        inputHash: this.currentEvidenceHash(channelId),
        provider: "mock",
        evidenceUnavailable: false,
      };
      this.data.put(channelId, "topic", topic.id, topic);
    }
    return this.snapshot(channelId);
  }
  /** Shared, schema-checked channel RPC surface used by CLI and native IPC. */
  async dispatch(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    await this.pruneExpired();
    const cid = () => key.parse(params.channelId);
    switch (method) {
      case "analytics.snapshot":
        return this.snapshot(params.channelId ? cid() : undefined);
      case "analytics.sample":
        return this.sample();
      case "analytics.connection.configure":
        return this.oauth.configure(z.string().parse(params.path));
      case "analytics.connection.get":
        return this.oauth.configured();
      case "analytics.connection.begin":
        return this.oauth.begin();
      case "analytics.connection.finish":
        return this.oauth.finish(key.parse(params.sessionId), signal);
      case "analytics.connection.cancel":
        return this.oauth.cancel(key.parse(params.sessionId));
      case "analytics.connection.confirm":
        return this.confirmConnection(
          key.parse(params.sessionId),
          cid(),
          signal,
        );
      case "analytics.connection.disconnect":
        return this.disconnect(cid());
      case "analytics.data.delete":
        if (params.confirm !== true)
          throw new StudioError(
            "INVALID_INPUT",
            "Confirm deletion of local analytics data.",
          );
        return this.deleteData(cid());
      case "analytics.reach.enable":
        return this.setupReach(cid(), signal);
      case "analytics.sync":
        return this.sync(cid(), params.older === true, signal);
      case "analytics.import.preview":
        return this.previewImport(
          z.string().parse(params.path),
          params.options,
        );
      case "analytics.import.commit":
        return this.commitImport(
          key.parse(params.token),
          params.confirm === true,
          params.coverageConfirmed === true,
        );
      case "analytics.video.save":
        return this.saveVideo(cid(), params.video);
      case "analytics.video.details":
        return this.details(
          cid(),
          key.parse(params.videoId),
          z.enum(["traffic", "search", "retention"]).parse(params.family),
          signal,
        );
      case "channel.strategy.save":
        return this.saveStrategy(cid(), params.strategy);
      case "outcomes.save":
        return this.saveOutcome(cid(), params.outcome);
      case "reviews.save":
        return this.saveReview(cid(), params.review);
      case "reviews.followUp":
        return this.followUp(cid(), key.parse(params.reviewId));
      case "topics.generate":
        return this.generate(cid(), signal);
      case "topics.update":
        return this.saveTopic(
          cid(),
          key.parse(params.topicId),
          params.brief,
          z.number().int().parse(params.version),
        );
      case "topics.decide":
        return this.decide(
          cid(),
          key.parse(params.topicId),
          z.enum(["saved", "dismissed", "proposed"]).parse(params.status),
          z
            .string()
            .max(1000)
            .parse(params.reason ?? ""),
        );
      case "topics.createProject":
        return this.createProject(
          cid(),
          key.parse(params.topicId),
          z.number().int().parse(params.version),
          params.brief,
        );
      default:
        throw new StudioError(
          "UNSUPPORTED",
          `Unknown channel operation: ${method}`,
        );
    }
  }
}
