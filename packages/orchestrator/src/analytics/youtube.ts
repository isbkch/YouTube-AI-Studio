import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { hash, StudioError } from "../../../shared/src/index.ts";
import {
  addDays,
  missingMetrics,
  pacificDate,
  type Channel,
  type MetricName,
  type Report,
  type Video,
} from "./model.ts";
import { parseCSV } from "./csv.ts";

const dataRoot = "https://www.googleapis.com/youtube/v3/";
const analyticsRoot = "https://youtubeanalytics.googleapis.com/v2/reports";
const reportingRoot = "https://youtubereporting.googleapis.com/v1/";
const apiMetrics: Record<string, MetricName> = {
  views: "views",
  estimatedMinutesWatched: "watchMinutes",
  averageViewDuration: "averageViewDuration",
  averageViewPercentage: "averageViewPercentage",
  subscribersGained: "subscribersGained",
  subscribersLost: "subscribersLost",
};
const queryMetrics = Object.keys(apiMetrics).join(",");
const querySchema = z.object({
  columnHeaders: z.array(z.object({ name: z.string() })).default([]),
  rows: z.array(z.array(z.union([z.string(), z.number()]))).optional(),
});
const catalogSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      snippet: z.object({
        channelId: z.string(),
        title: z.string(),
        publishedAt: z.string(),
      }),
      contentDetails: z.object({ duration: z.string() }),
      status: z.object({
        privacyStatus: z.enum(["public", "private", "unlisted"]),
      }),
      liveStreamingDetails: z.unknown().optional(),
    }),
  ),
});
async function readReportCSV(response: Response): Promise<string> {
  const limit = 5_000_000;
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new StudioError("EXTERNAL_TOOL", "YouTube report exceeds 5 MB.");
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new StudioError("EXTERNAL_TOOL", "YouTube report exceeds 5 MB.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size).toString("utf8");
}
export class YouTubeAnalyticsClient {
  constructor(
    private token: string,
    private fetcher: typeof fetch = fetch,
  ) {}
  async request(
    url: string,
    signal?: AbortSignal,
    body?: unknown,
  ): Promise<Response> {
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted();
      const response = await this.fetcher(url, {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
          : AbortSignal.timeout(30000),
        redirect: "error",
      });
      if (response.ok) return response;
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        await delay(
          Math.min(
            10000,
            Number(response.headers.get("retry-after") ?? 0) * 1000 ||
              500 * 2 ** attempt,
          ),
          undefined,
          { signal },
        );
        continue;
      }
      throw new StudioError(
        response.status === 401 ? "CONFIGURATION" : "EXTERNAL_TOOL",
        `YouTube data request failed (${response.status}).`,
        response.status === 401
          ? "Reconnect the channel."
          : response.status === 403
            ? "Check API access and quota, then retry."
            : "Retry later; completed data remains available.",
        true,
      );
    }
    throw new StudioError("EXTERNAL_TOOL", "YouTube request failed.");
  }
  private async json(url: string, signal?: AbortSignal, body?: unknown) {
    return (await this.request(url, signal, body)).json();
  }
  private async query(
    channelId: string,
    params: Record<string, string>,
    signal?: AbortSignal,
  ) {
    return querySchema.parse(
      await this.json(
        analyticsRoot +
          "?" +
          new URLSearchParams({ ids: `channel==${channelId}`, ...params }),
        signal,
      ),
    );
  }
  async verify(channelId: string, signal?: AbortSignal) {
    const data = z
      .object({
        items: z.array(
          z.object({
            id: z.string(),
            snippet: z.object({ title: z.string() }),
            contentDetails: z.object({
              relatedPlaylists: z.object({ uploads: z.string() }),
            }),
          }),
        ),
      })
      .parse(
        await this.json(
          dataRoot + "channels?part=snippet,contentDetails&mine=true",
          signal,
        ),
      );
    const channel = data.items.find((c) => c.id === channelId);
    if (!channel)
      throw new StudioError(
        "CONFIGURATION",
        "Signed-in account does not own the selected channel.",
      );
    return channel;
  }
  async catalog(channel: Channel, signal?: AbortSignal) {
    const own = await this.verify(channel.id, signal);
    const ids: string[] = [];
    let page = "";
    do {
      const data = z
        .object({
          nextPageToken: z.string().optional(),
          items: z.array(
            z.object({ contentDetails: z.object({ videoId: z.string() }) }),
          ),
        })
        .parse(
          await this.json(
            dataRoot +
              "playlistItems?" +
              new URLSearchParams({
                part: "contentDetails",
                playlistId: own.contentDetails.relatedPlaylists.uploads,
                maxResults: "50",
                ...(page ? { pageToken: page } : {}),
              }),
            signal,
          ),
        );
      ids.push(...data.items.map((i) => i.contentDetails.videoId));
      page = data.nextPageToken ?? "";
    } while (page && ids.length < channel.catalogLimit);
    const videos: Video[] = [];
    for (
      let offset = 0;
      offset < Math.min(ids.length, channel.catalogLimit);
      offset += 50
    ) {
      const data = catalogSchema.parse(
        await this.json(
          dataRoot +
            "videos?" +
            new URLSearchParams({
              part: "snippet,contentDetails,status,liveStreamingDetails",
              id: ids
                .slice(offset, Math.min(offset + 50, channel.catalogLimit))
                .join(","),
            }),
          signal,
        ),
      );
      for (const v of data.items) {
        if (v.snippet.channelId !== channel.id) continue;
        const duration = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(
          v.contentDetails.duration,
        );
        videos.push({
          id: v.id,
          channelId: channel.id,
          title: v.snippet.title,
          duration: duration
            ? Number(duration[1] ?? 0) * 3600 +
              Number(duration[2] ?? 0) * 60 +
              Number(duration[3] ?? 0)
            : null,
          publicDate:
            v.status.privacyStatus === "public"
              ? pacificDate(v.snippet.publishedAt)
              : null,
          publicDateSource:
            v.status.privacyStatus === "public" ? "youtube" : "unknown",
          visibility: v.status.privacyStatus,
          format: v.liveStreamingDetails ? "live" : "unknown",
          tags: [],
          excluded: false,
          fetchedAt: new Date().toISOString(),
          projectId: null,
        });
      }
    }
    return {
      videos,
      complete: !page && ids.length <= channel.catalogLimit,
      title: own.snippet.title,
    };
  }
  async availableThrough(channelId: string, signal?: AbortSignal) {
    const today = pacificDate(new Date());
    const data = await this.query(
      channelId,
      {
        startDate: addDays(today, -365),
        endDate: addDays(today, -1),
        metrics: queryMetrics,
        dimensions: "day",
        sort: "-day",
        maxResults: "1",
      },
      signal,
    );
    const i = data.columnHeaders.findIndex((c) => c.name === "day");
    return i < 0 || !data.rows?.length ? null : String(data.rows[0][i]);
  }
  async classify(
    video: Video,
    through: string,
    signal?: AbortSignal,
  ): Promise<Video["format"]> {
    if (
      video.format === "live" ||
      !video.publicDate ||
      video.publicDate > through
    )
      return video.format;
    const data = await this.query(
      video.channelId,
      {
        startDate: video.publicDate,
        endDate: through,
        metrics: "views",
        dimensions: "creatorContentType",
        filters: `video==${video.id}`,
      },
      signal,
    );
    const i = data.columnHeaders.findIndex(
      (c) => c.name === "creatorContentType",
    );
    const kinds = new Set((data.rows ?? []).map((row) => row[i]));
    return kinds.size !== 1
      ? "unknown"
      : kinds.has("SHORTS")
        ? "short"
        : kinds.has("LIVE_STREAM")
          ? "live"
          : kinds.has("VIDEO_ON_DEMAND")
            ? "long-form"
            : "unknown";
  }
  async basic(
    video: Video,
    days: number,
    through: string | null,
    signal?: AbortSignal,
  ): Promise<Report> {
    const start = video.publicDate!,
      end = addDays(start, days - 1),
      effectiveEnd = through && through < end ? through : end;
    const report: Report = {
      id: `basic-${video.id}-${days}`,
      videoId: video.id,
      channelId: video.channelId,
      source: "youtube",
      family: "basic",
      start,
      end,
      through: through && effectiveEnd >= start ? effectiveEnd : null,
      fetchedAt: new Date().toISOString(),
      timezone: "America/Los_Angeles",
      filters: `video==${video.id}`,
      coverage:
        !through || effectiveEnd < start
          ? "pending"
          : effectiveEnd < end
            ? "partial"
            : "complete",
      metrics: missingMetrics(),
      details: [],
      sourceId: `analytics-${video.id}-${days}`,
      generatedAt: null,
    };
    if (report.coverage === "pending") return report;
    const result = await this.query(
      video.channelId,
      {
        startDate: start,
        endDate: effectiveEnd,
        metrics: queryMetrics,
        filters: `video==${video.id}`,
      },
      signal,
    );
    for (const metric of report.metrics) {
      const header = Object.keys(apiMetrics).find(
          (k) => apiMetrics[k] === metric.name,
        ),
        index = result.columnHeaders.findIndex((c) => c.name === header);
      const value = result.rows?.[0]?.[index];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        metric.value = value;
        metric.state = "observed";
      } else if (header) {
        metric.state = "omitted";
      }
    }
    return report;
  }
  async details(
    video: Video,
    family: "traffic" | "search" | "retention",
    signal?: AbortSignal,
  ): Promise<Report> {
    if (!video.publicDate)
      throw new StudioError(
        "INVALID_INPUT",
        "Confirm public availability before fetching video details.",
      );
    const end = addDays(pacificDate(new Date()), -3);
    if (end < video.publicDate)
      throw new StudioError(
        "CONFLICT",
        "This video is too new for a completed report.",
      );
    const fields: Record<string, string> =
      family === "retention"
        ? { dimensions: "elapsedVideoTimeRatio", metrics: "audienceWatchRatio" }
        : family === "search"
          ? {
              dimensions: "insightTrafficSourceDetail",
              metrics: "views",
              sort: "-views",
              maxResults: "25",
            }
          : { dimensions: "insightTrafficSourceType", metrics: "views" };
    const result = await this.query(
      video.channelId,
      {
        startDate: video.publicDate,
        endDate: end,
        ...fields,
        filters: `video==${video.id}${family === "search" ? ";insightTrafficSourceType==YT_SEARCH" : ""}`,
      },
      signal,
    );
    const dimension = result.columnHeaders.findIndex(
        (c) => c.name === fields.dimensions,
      ),
      metric = result.columnHeaders.findIndex((c) => c.name === fields.metrics);
    return {
      id: `${family}-${video.id}`,
      videoId: video.id,
      channelId: video.channelId,
      source: "youtube",
      family,
      start: video.publicDate,
      end,
      through: null,
      fetchedAt: new Date().toISOString(),
      timezone: "America/Los_Angeles",
      filters: `video==${video.id}`,
      coverage: "unknown",
      metrics: [],
      details: (result.rows ?? [])
        .filter((r) => typeof r[metric] === "number")
        .map((r) => ({
          label: String(r[dimension]),
          value: Number(r[metric]),
        })),
      sourceId: `analytics-${family}-${video.id}`,
      generatedAt: null,
    };
  }
  async setupReach(signal?: AbortSignal): Promise<string | null> {
    const type = "channel_reach_basic_a1";
    const types = z
      .object({
        reportTypes: z.array(z.object({ id: z.string() })).default([]),
      })
      .parse(await this.json(reportingRoot + "reportTypes", signal));
    if (!types.reportTypes.some((t) => t.id === type)) return null;
    let page = "";
    do {
      const jobs = z
        .object({
          jobs: z
            .array(
              z.object({
                id: z.string(),
                reportTypeId: z.string(),
                name: z.string().optional(),
              }),
            )
            .default([]),
          nextPageToken: z.string().optional(),
        })
        .parse(
          await this.json(
            reportingRoot +
              "jobs?" +
              new URLSearchParams(page ? { pageToken: page } : {}),
            signal,
          ),
        );
      const existing = jobs.jobs.find(
        (j) => j.reportTypeId === type && j.name === "YouTube AI Studio reach",
      );
      if (existing) return existing.id;
      page = jobs.nextPageToken ?? "";
    } while (page);
    const created = z.object({ id: z.string() }).parse(
      await this.json(reportingRoot + "jobs", signal, {
        reportTypeId: type,
        name: "YouTube AI Studio reach",
      }),
    );
    return created.id;
  }
  async reach(channel: Channel, signal?: AbortSignal): Promise<Report[]> {
    if (!channel.reachJobId) return [];
    const reports: Report[] = [];
    let page = "";
    do {
      const listing = z
        .object({
          reports: z
            .array(
              z.object({
                id: z.string(),
                downloadUrl: z.url(),
                createTime: z.string(),
              }),
            )
            .default([]),
          nextPageToken: z.string().optional(),
        })
        .parse(
          await this.json(
            reportingRoot +
              `jobs/${encodeURIComponent(channel.reachJobId)}/reports?` +
              new URLSearchParams({
                pageSize: "100",
                ...(page ? { pageToken: page } : {}),
              }),
            signal,
          ),
        );
      for (const entry of listing.reports) {
        const url = new URL(entry.downloadUrl);
        if (
          url.protocol !== "https:" ||
          !["youtubereporting.googleapis.com", "www.googleapis.com"].includes(
            url.hostname,
          )
        )
          throw new StudioError(
            "EXTERNAL_TOOL",
            "Unexpected YouTube report download host.",
          );
        const response = await this.request(entry.downloadUrl, signal);
        const data = await readReportCSV(response);
        const rows = parseCSV(data),
          columns = rows.shift() ?? [];
        const index = (name: string) => columns.indexOf(name);
        if (
          [
            "date",
            "channel_id",
            "video_id",
            "video_thumbnail_impressions",
            "video_thumbnail_impressions_ctr",
          ].some((name) => index(name) < 0)
        )
          throw new StudioError(
            "EXTERNAL_TOOL",
            "Reach report is missing required columns.",
          );
        for (const row of rows) {
          if (row[index("channel_id")] !== channel.id) continue;
          const videoId = row[index("video_id")],
            day = row[index("date")];
          if (!videoId || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
          const impressionsCell =
              row[index("video_thumbnail_impressions")]?.trim(),
            ctrCell = row[index("video_thumbnail_impressions_ctr")]?.trim();
          const impressions = impressionsCell ? Number(impressionsCell) : null,
            ctr = ctrCell ? Number(ctrCell) : null;
          if (
            (impressions !== null &&
              (!Number.isFinite(impressions) || impressions < 0)) ||
            (ctr !== null && (!Number.isFinite(ctr) || ctr < 0 || ctr > 100))
          )
            throw new StudioError(
              "EXTERNAL_TOOL",
              "Invalid reach report units.",
            );
          reports.push({
            id: `reach-${hash({ videoId, day }).slice(0, 32)}`,
            videoId,
            channelId: channel.id,
            source: "youtube",
            family: "reach",
            start: day,
            end: day,
            through: day,
            fetchedAt: new Date().toISOString(),
            timezone: "YouTube Reporting daily interval",
            filters: "",
            coverage: "complete",
            metrics: [
              {
                name: "impressions",
                unit: "count",
                value: impressions,
                state: impressions === null ? "omitted" : "observed",
              },
              {
                name: "ctr",
                unit: "percent",
                value: ctr,
                state: ctr === null ? "omitted" : "observed",
              },
            ],
            details: [],
            sourceId: entry.id,
            generatedAt: entry.createTime,
          });
        }
      }
      page = listing.nextPageToken ?? "";
    } while (page);
    return reports;
  }
}
