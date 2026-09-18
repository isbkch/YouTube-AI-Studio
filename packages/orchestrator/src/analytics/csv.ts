import { hash, StudioError } from "../../../shared/src/index.ts";
import {
  date as dateSchema,
  importOptionsSchema,
  missingMetrics,
  videoSchema,
  reportSchema,
  type ImportOptions,
  type Report,
  type Video,
} from "./model.ts";

/** Bounded RFC 4180 reader. Cells are data, never formulas or instructions. */
export function parseCSV(input: string): string[][] {
  if (Buffer.byteLength(input) > 5_000_000)
    throw new StudioError("INVALID_INPUT", "CSV exceeds 5 MB.");
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false,
    closed = false;
  const s = input.replace(/^\uFEFF/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else cell += c;
      continue;
    }
    if (c === '"' && !cell && !closed) {
      quoted = true;
      continue;
    }
    if (c === "," || c === "\n" || c === "\r") {
      row.push(cell);
      cell = "";
      closed = false;
      if (c !== ",") {
        if (c === "\r" && s[i + 1] === "\n") i++;
        if (row.some((x) => x.trim())) rows.push(row);
        row = [];
      }
      continue;
    }
    if (closed && c.trim())
      throw new StudioError(
        "INVALID_INPUT",
        "Unexpected text after a quoted CSV cell.",
      );
    cell += c;
  }
  if (quoted)
    throw new StudioError(
      "INVALID_INPUT",
      "CSV contains an unclosed quoted cell.",
    );
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  if (rows.length > 10001)
    throw new StudioError(
      "INVALID_INPUT",
      "CSV contains more than 10,000 rows.",
    );
  return rows;
}
const headers: Record<string, string[]> = {
  videoId: ["Video ID", "Content"],
  title: ["Video title", "Title"],
  duration: ["Duration", "Video duration"],
  publicDate: ["Video publish time", "Published date"],
  views: ["Views"],
  watchMinutes: ["Watch time (hours)", "Watch time (minutes)"],
  averageViewDuration: ["Average view duration"],
  averageViewPercentage: ["Average percentage viewed (%)"],
  subscribersGained: ["Subscribers gained"],
  subscribersLost: ["Subscribers lost"],
  impressions: ["Impressions"],
  ctr: ["Impressions click-through rate (%)"],
};
function number(value: string, kind: string, header: string) {
  const t = value.trim();
  if (!t || t === "—" || t === "-") return null;
  let n: number;
  if (kind === "averageViewDuration" || kind === "duration") {
    if (t.includes(":")) {
      const parts = t.split(":");
      if (!parts.every((p) => /^\d+(\.\d+)?$/.test(p)) || parts.length > 3)
        throw new Error("Invalid duration");
      n = parts.reduce((s, p) => s * 60 + Number(p), 0);
    } else n = Number(t);
  } else {
    if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d+)?%?$/.test(t))
      throw new Error("Use English numeric units");
    n = Number(t.replaceAll(",", "").replace("%", ""));
  }
  if (!Number.isFinite(n) || n < 0)
    throw new Error("Invalid nonnegative number");
  if (kind === "ctr" && n > 100) throw new Error("CTR exceeds 100 percent");
  return kind === "watchMinutes" && header.includes("(hours)") ? n * 60 : n;
}
export function previewCSV(csv: string, raw: unknown, clock = new Date()) {
  const options = importOptionsSchema.parse(raw);
  const rows = parseCSV(csv);
  const header = rows.shift();
  if (!header?.length)
    throw new StudioError("INVALID_INPUT", "CSV has no header row.");
  if (new Set(header).size !== header.length)
    throw new StudioError("INVALID_INPUT", "CSV has duplicate column headers.");
  const mapping: Record<string, string> = {};
  for (const [field, aliases] of Object.entries(headers)) {
    const h = options.mapping[field] ?? aliases.find((h) => header.includes(h));
    if (h && header.includes(h)) mapping[field] = h;
  }
  for (const [field, column] of Object.entries(options.mapping))
    if (!headers[field] || !header.includes(column))
      throw new StudioError(
        "INVALID_INPUT",
        `Unknown mapped field or missing header: ${field}.`,
      );
  if (!mapping.videoId)
    throw new StudioError(
      "INVALID_INPUT",
      "Map the Content or Video ID column before importing.",
    );
  const sourceId = hash({
    csv,
    options: { ...options, identityConfirmed: undefined },
  });
  const fetchedAt = clock.toISOString();
  const videos: Video[] = [],
    reports: Report[] = [],
    warnings: string[] = [],
    seen = new Set<string>();
  let totals = 0;
  for (const [index, row] of rows.entries()) {
    if (row.length !== header.length)
      throw new StudioError(
        "INVALID_INPUT",
        `CSV row ${index + 2} has a different number of columns.`,
      );
    const cell = (field: string) =>
      mapping[field] ? row[header.indexOf(mapping[field])].trim() : "";
    const videoId = cell("videoId");
    if (!videoId || /^total$/i.test(videoId)) {
      totals++;
      continue;
    }
    if (!/^[\w-]{11}$/.test(videoId))
      throw new StudioError(
        "INVALID_INPUT",
        `Row ${index + 2} needs an 11-character YouTube video ID.`,
      );
    if (seen.has(videoId))
      throw new StudioError(
        "INVALID_INPUT",
        `Duplicate video ${videoId}; import a content table with one row per video.`,
      );
    seen.add(videoId);
    try {
      const metrics = missingMetrics();
      for (const metric of metrics) {
        if (mapping[metric.name]) {
          metric.value = number(
            cell(metric.name),
            metric.name,
            mapping[metric.name],
          );
          metric.state = metric.value === null ? "omitted" : "observed";
        }
      }
      if (!metrics.some((m) => m.value !== null))
        throw new Error("No supported metrics");
      const date = cell("publicDate");
      const publicDate = dateSchema.safeParse(date).success ? date : null;
      if (date && !publicDate)
        warnings.push(`Publication date for ${videoId} needs confirmation.`);
      videos.push(
        videoSchema.parse({
          id: videoId,
          channelId: options.channelId,
          title: cell("title") || videoId,
          duration: cell("duration")
            ? number(cell("duration"), "duration", "")
            : null,
          publicDate,
          publicDateSource: publicDate ? "creator" : "unknown",
          visibility: "unknown",
          format: "unknown",
          tags: [],
          excluded: false,
          fetchedAt,
          projectId: null,
        }),
      );
      reports.push(
        reportSchema.parse({
          id: `csv-${hash({ sourceId, videoId }).slice(0, 40)}`,
          videoId,
          channelId: options.channelId,
          source: "studio-csv",
          family: "basic",
          start: options.start,
          end: options.end,
          through: options.end,
          fetchedAt,
          timezone: options.timezone,
          filters: options.filters,
          coverage: "unknown",
          metrics,
          details: [],
          sourceId,
          generatedAt: null,
        }),
      );
    } catch (e) {
      throw new StudioError(
        "INVALID_INPUT",
        `CSV row ${index + 2}: ${(e as Error).message}.`,
      );
    }
  }
  if (!videos.length)
    throw new StudioError("INVALID_INPUT", "CSV contains no video rows.");
  if (videos.length >= 500)
    warnings.push(
      "Studio exports can stop at 500 rows; this report may be truncated.",
    );
  warnings.push(
    "Confirm channel identity, visibility and format. This interval is not automatically a first-28-days window.",
  );
  return {
    sourceId,
    options: { ...options, mapping } as ImportOptions,
    headers: header,
    videos,
    reports,
    totalsSkipped: totals,
    warnings,
  };
}
